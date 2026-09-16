/**
 * Import chats.txt into Firestore room 2035
 *
 * Parses the GitHub issue export format, sorts messages by date,
 * encrypts with AES-256-GCM using the room code as key, and writes
 * to Firestore via REST API.
 *
 * Usage: node scripts/import-chats.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHATS_FILE = path.join(__dirname, '..', 'chats.txt');
const ROOM_CODE = '2035';

// ─── Encryption (same as src/lib/crypto.ts) ───────────────────

const SALT = new TextEncoder().encode('chatwave-salt-2026');
const ITERATIONS = 100_000;

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function deriveKey(roomCode) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(roomCode), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
}

async function encrypt(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { ciphertext: bufferToBase64(encrypted), iv: bufferToBase64(iv.buffer) };
}

// ─── Date parsing ─────────────────────────────────────────────

const now = new Date('2026-07-12T00:00:00Z');

function parseRelativeDate(text) {
  const lower = text.toLowerCase().trim();
  if (lower === 'last month' || lower === '1mo ago') {
    const d = new Date(now);
    d.setMonth(d.getMonth() - 1);
    return d;
  }
  // "3d ago", "2d ago", "3 days ago", "20h ago", "18 hours ago"
  const m = lower.match(/^(\d+)\s*(mo|month|months|d|day|days|h|hour|hours|min|mins?)\s*ago$/);
  if (m) {
    const num = parseInt(m[1]);
    const unit = m[2];
    const d = new Date(now);
    if (unit.startsWith('mo')) d.setMonth(d.getMonth() - num);
    else if (unit.startsWith('d')) d.setDate(d.getDate() - num);
    else if (unit.startsWith('h')) d.setHours(d.getHours() - num);
    else if (unit.startsWith('mi')) d.setMinutes(d.getMinutes() - num);
    return d;
  }
  return null;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function parseExplicitDate(str) {
  const t = str.trim();
  // "on Jun 10" or "on Jun 10, 2026"
  let m = t.match(/^on\s+(\w+)\s+(\d+)(?:,\s*(\d{4}))?$/i);
  if (m) {
    const month = MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (month === undefined) return null;
    const day = parseInt(m[2]);
    const year = m[3] ? parseInt(m[3]) : 2026;
    return new Date(Date.UTC(year, month, day, 12, 0, 0));
  }
  return null;
}

function parseDateString(str) {
  const d = parseExplicitDate(str) || parseRelativeDate(str);
  return d;
}

// Regex for "commented on <date>", "commented last month", "commented 3 days ago" etc.
const COMMENTED_RE = /^(.+?)\s+commented\s+(on\s+.+|last month|\d+\s*(?:mo|month|months|d|day|days|h|hour|hours|min|mins?)\s*ago)$/i;

// ─── Message parser ───────────────────────────────────────────

function findCommentStarts(lines) {
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(COMMENTED_RE);
    if (m) {
      starts.push({ index: i, username: m[1].trim(), dateStr: m[2].trim(), type: 'comment' });
    }
  }
  return starts;
}

function parseMessageBlock(lines, startIdx, endIdx, overrideDateStr, overrideUsername) {
  let i = startIdx;

  // For "commented on" type, the first line is the header; skip it
  if (overrideDateStr === undefined) {
    i++; // skip the "commented on" line, already processed
  }

  // Skip blank lines
  while (i < endIdx && lines[i].trim() === '') i++;
  if (i >= endIdx) return null;

  // @-username
  let atUsername = '';
  if (lines[i].trim().startsWith('@')) {
    atUsername = lines[i].trim();
    i++;
  }

  // Skip blank lines
  while (i < endIdx && lines[i].trim() === '') i++;
  if (i >= endIdx) return null;

  // Display name
  const displayName = lines[i].trim();
  i++;

  // Skip blank lines
  while (i < endIdx && lines[i].trim() === '') i++;
  if (i >= endIdx) return null;

  // Date line ("on <date>", "<relative>", or "opened on <date>")
  const dateLine = lines[i].trim();
  let date;
  if (overrideDateStr) {
    date = parseDateString(overrideDateStr);
  } else if (dateLine.startsWith('opened on ')) {
    date = parseExplicitDate('on ' + dateLine.slice('opened on '.length));
  } else {
    date = parseDateString(dateLine);
  }
  i++;

  // Skip blank lines
  while (i < endIdx && lines[i].trim() === '') i++;

  // Role (optional: Author/Owner/Collaborator)
  let role = '';
  if (i < endIdx) {
    const l = lines[i].trim();
    if (l === 'Author' || l === 'Owner' || l === 'Collaborator') {
      role = l;
      i++;
    }
  }

  // Collect message body (including blank lines) until endIdx
  const bodyLines = [];
  while (i < endIdx) {
    bodyLines.push(lines[i]);
    i++;
  }

  const text = bodyLines.join('\n').trim();

  if (!text || !date) return null;

  return {
    username: overrideUsername || (atUsername ? atUsername.slice(1) : displayName),
    displayName,
    role,
    text,
    date,
  };
}

function parseChats(text) {
  const lines = text.split('\n');
  const commentStarts = findCommentStarts(lines);

  // Find the opening message (before the first "commented on" line)
  const firstCommentIdx = commentStarts.length > 0 ? commentStarts[0].index : lines.length;

  const messages = [];

  // Parse opening message (if it has @username\n<username>\nopened on <date>)
  // Look for @<username> in the first block before first comment
  let openingFound = false;
  for (let i = 0; i < firstCommentIdx; i++) {
    const trimmed = lines[i].trim();
    if (/^@\S+$/.test(trimmed)) {
      // Check if this is the opening message
      let j = i + 1;
      while (j < firstCommentIdx && lines[j].trim() === '') j++;
      if (j < firstCommentIdx) {
        const displayName = lines[j].trim();
        let k = j + 1;
        while (k < firstCommentIdx && lines[k].trim() === '') k++;
        if (k < firstCommentIdx && lines[k].trim().startsWith('opened on ')) {
          const msg = parseMessageBlock(lines, i, firstCommentIdx);
          if (msg) {
            messages.push(msg);
            openingFound = true;
          }
          break;
        }
      }
    }
  }

  // Parse commented messages
  for (let ci = 0; ci < commentStarts.length; ci++) {
    const start = commentStarts[ci];
    const end = ci + 1 < commentStarts.length ? commentStarts[ci + 1].index : lines.length;
    const msg = parseMessageBlock(lines, start.index, end);
    if (msg) {
      messages.push(msg);
    }
  }

  return messages;
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  console.log('Reading chats.txt...');
  const text = fs.readFileSync(CHATS_FILE, 'utf-8');
  const messages = parseChats(text);
  console.log(`Parsed ${messages.length} messages.`);

  if (messages.length === 0) {
    console.log('No messages found. Exiting.');
    return;
  }

  // Sort by date
  messages.sort((a, b) => a.date.getTime() - b.date.getTime());
  console.log(`Date range: ${messages[0].date.toISOString()} → ${messages[messages.length - 1].date.toISOString()}`);

  // Print summary
  const users = [...new Set(messages.map(m => m.username))];
  console.log(`Unique users: ${users.join(', ')}`);

  // Show sample
  console.log('\nSample messages (first 3):');
  messages.slice(0, 3).forEach((m, idx) => {
    const preview = m.text.replace(/\n/g, '\\n').slice(0, 80);
    console.log(`  [${idx + 1}] ${m.username} (${m.displayName}) @ ${m.date.toISOString()}`);
    console.log(`      ${preview}`);
  });

  // Derive encryption key
  console.log(`\nDeriving encryption key for room ${ROOM_CODE}...`);
  const key = await deriveKey(ROOM_CODE);

  // Prepare Firestore writes via REST API
  const apiKey = process.env.VITE_FIREBASE_API_KEY;
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID;

  if (!apiKey || !projectId) {
    console.log('\nFirebase credentials not found in env.');
    console.log('Set VITE_FIREBASE_API_KEY and VITE_FIREBASE_PROJECT_ID.');
    console.log(`\nSample encrypted output (${messages.length} messages ready):`);
    const samplePayload = JSON.stringify({ text: messages[0].text });
    const { ciphertext, iv } = await encrypt(samplePayload, key);
    console.log(`  ciphertext: ${ciphertext.slice(0, 50)}...`);
    console.log(`  iv: ${iv}`);
    return;
  }

  console.log(`\nUploading ${messages.length} messages to room ${ROOM_CODE}...`);

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/rooms/${ROOM_CODE}/messages`;

  let success = 0;
  let fail = 0;

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    const payload = JSON.stringify({ text: msg.text });
    const { ciphertext, iv } = await encrypt(payload, key);

    const doc = {
      fields: {
        senderUid: { stringValue: msg.username },
        senderName: { stringValue: msg.displayName },
        ciphertext: { stringValue: ciphertext },
        iv: { stringValue: iv },
        timestamp: { timestampValue: msg.date.toISOString() },
      },
    };

    try {
      const res = await fetch(`${url}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      });
      if (res.ok) {
        success++;
      } else {
        const err = await res.text();
        console.error(`  [${idx + 1}/${messages.length}] FAILED: ${msg.username} - ${err.slice(0, 120)}`);
        fail++;
      }
    } catch (e) {
      console.error(`  [${idx + 1}/${messages.length}] ERROR: ${msg.username} - ${e.message}`);
      fail++;
    }

    if ((idx + 1) % 100 === 0 || idx === messages.length) {
      console.log(`  Progress: ${idx + 1}/${messages.length} (${success} success, ${fail} fail)`);
    }
  }

  console.log(`\nDone! ${success} messages uploaded, ${fail} failed.`);
}

main().catch(console.error);
