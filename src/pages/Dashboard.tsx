import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  serverTimestamp,
  onSnapshot,
  where,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { localDB } from '../lib/db';
import { deriveKey, decrypt, encrypt, derivePasswordKey } from '../lib/crypto';
import { deleteRoomData } from '../lib/roomUtils';
import { useStore } from '../store/useStore';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import { swSend } from '../lib/sw';

import Avatar, { getInitials } from '../components/Avatar';

import type { JoinedRoom, UserProfile } from '../types';

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

function sanitizeRoomName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 50) || 'room';
}

export default function Dashboard() {
  const [roomName, setRoomName] = useState('');
  const joinInputs = useRef<(HTMLInputElement | null)[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createType, setCreateType] = useState<'permanent' | 'auto'>('permanent');
  const [_confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, setUser, joinedRooms, setJoinedRooms, addJoinedRoom, removeJoinedRoom } = useStore();
  const { showPrompt, install } = useInstallPrompt();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setShowCreateModal(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [searchParams]);

  useEffect(() => {
    localDB.joinedRooms.toArray().then((rooms) => {
      setJoinedRooms(rooms);
      const codes = rooms.map((r) => r.code);
      swSend({ type: 'WATCH_ROOMS', rooms: codes });
      // Purge locally any room whose auto-delete timer expired (checked against Firestore below)
      cleanupExpiredRooms(rooms);
    });
  }, [setJoinedRooms]);

  // Join via invite link: /?code=1234&invite=token
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const invite = params.get('invite');
    if (code && user) {
      if (invite) {
        joinWithInvite(code, invite);
      } else {
        joinRoomByCode(code);
      }
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [user]);

  const cleanupExpiredRooms = async (rooms: { code: string; name: string; joinedAt: number; lastReadTimestamp: number | null }[]) => {
    for (const room of rooms) {
      try {
        const snap = await getDoc(doc(db, 'rooms', room.code));
        if (!snap.exists()) {
          await localDB.joinedRooms.delete(room.code);
          useStore.getState().removeJoinedRoom(room.code);
          continue;
        }
        const data = snap.data();
        if (data.autoDelete === true) {
          const last = data.lastActivityAt?.toMillis?.() ?? null;
          if (last === null || Date.now() - last > 3600000) {
            await deleteRoomData(room.code);
            await localDB.joinedRooms.delete(room.code);
            useStore.getState().removeJoinedRoom(room.code);
          }
        }
      } catch {}
    }
    swSend({ type: 'WATCH_ROOMS', rooms: useStore.getState().joinedRooms.map((r) => r.code) });
  };

  const joinWithInvite = async (code: string, token: string) => {
    try {
      const snap = await getDoc(doc(db, 'rooms', code, 'invites', token));
      if (!snap.exists()) {
        setError('Invite link is invalid or already used');
        return;
      }
      const inviteData = snap.data();
      const expiresAt = inviteData.expiresAt?.toMillis?.() ?? 0;
      if (expiresAt < Date.now() || (inviteData.uses ?? 0) >= (inviteData.maxUses ?? 1)) {
        setError('Invite link has expired');
        return;
      }
      await setDoc(
        doc(db, 'rooms', code, 'invites', token),
        { uses: (inviteData.uses ?? 0) + 1 },
        { merge: true }
      );
    } catch {
      setError('Could not validate invite');
      return;
    }
    joinRoomByCode(code);
  };

  const joinRoomByCode = async (code: string) => {
    const name = sanitizeRoomName(code);
    if (!name || !user) return;
    setLoading('join');
    setError('');
    try {
      const snap = await getDoc(doc(db, 'rooms', name));
      if (!snap.exists()) {
        setError('Room not found');
        setLoading('');
        return;
      }
      const roomData = snap.data();
      if (roomData.autoDelete === true) {
        const last = roomData.lastActivityAt?.toMillis?.() ?? null;
        if (last === null || Date.now() - last > 3600000) {
          deleteRoomData(name);
          setError('This room expired and was deleted');
          setLoading('');
          return;
        }
      }
      const roomName = roomData?.name || `Room ${name}`;
      await setDoc(doc(db, 'rooms', name, 'members', user.uid), { joinedAt: serverTimestamp(), name: user.name });
      const room: JoinedRoom = {
        code: name,
        name: roomName,
        joinedAt: Date.now(),
        lastReadTimestamp: Date.now(),
      };
      await localDB.joinedRooms.put(room);
      addJoinedRoom(room);
      const allRooms = [...useStore.getState().joinedRooms.map((r) => r.code), name];
      swSend({ type: 'WATCH_ROOMS', rooms: allRooms });
      navigate(`/chat/${name}`);
    } catch {
      setError('Failed to join room');
    }
    setLoading('');
  };

  useEffect(() => {
    if (user && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, [user]);

  useEffect(() => {
    if (!user || Notification.permission !== 'granted') return;
    let cancelled = false;
    (async () => {
      try {
        const { getMessaging, getToken } = await import('firebase/messaging');
        const messaging = getMessaging();
        const token = await getToken(messaging, { vapidKey: VAPID_KEY });
        if (token && !cancelled) {
          await setDoc(doc(db, 'users', user.uid, 'tokens', token), {
            token,
            platform: 'web',
            createdAt: serverTimestamp(),
            lastUsed: serverTimestamp(),
          });
        }
      } catch {
        // FCM not configured or unavailable — silently skip
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  const joinRoom = async () => {
    const name = sanitizeRoomName(roomName);
    if (!name) return;
    await joinRoomByCode(name);
  };

  const openCreateModal = () => {
    setCreateName('');
    setCreateType('permanent');
    setShowCreateModal(true);
    setTimeout(() => createInputRef.current?.focus(), 50);
  };

  const createRoom = async (roomName: string) => {
    setShowCreateModal(false);
    setLoading('create');
    setError('');
    let newCode: string | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = String(Math.floor(Math.random() * 9000) + 1000);
      const snap = await getDoc(doc(db, 'rooms', candidate));
      if (!snap.exists()) {
        newCode = candidate;
        break;
      }
    }
    if (!newCode) {
      setError('Could not generate unique code. Try again.');
      setLoading('');
      return;
    }
    const finalName = roomName.trim() || `Room ${newCode}`;
    try {
      await setDoc(doc(db, 'rooms', newCode), {
        name: finalName,
        createdAt: serverTimestamp(),
        createdBy: user?.uid,
        displayName: roomName.trim(),
        autoDelete: createType === 'auto',
        lastActivityAt: serverTimestamp(),
      });
      if (user) {
        await setDoc(doc(db, 'rooms', newCode, 'members', user.uid), { joinedAt: serverTimestamp(), name: user.name });
      }
      const room: JoinedRoom = {
        code: newCode,
        name: finalName,
        joinedAt: Date.now(),
        lastReadTimestamp: Date.now(),
      };
      await localDB.joinedRooms.put(room);
      addJoinedRoom(room);
      navigate(`/chat/${newCode}`);
    } catch {
      setError('Failed to create room');
    }
    setLoading('');
  };

  const startEditName = () => {
    if (!user) return;
    setNameInput(user.name);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  const saveName = async () => {
    if (!user) return;
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === user.name) {
      setEditingName(false);
      return;
    }
    const updated = { ...user, name: trimmed };
    setUser(updated);
    await localDB.userProfile.put(updated);
    try {
      await updateDoc(doc(db, 'users', user.uid), { name: trimmed });
    } catch {}
    setEditingName(false);
  };

  const saveAvatar = async (emoji: string, color: string) => {
    if (!user) return;
    const updated = { ...user, avatarEmoji: emoji || undefined, avatarColor: color || undefined };
    setUser(updated);
    await localDB.userProfile.put(updated);
    try {
      await updateDoc(doc(db, 'users', user.uid), { avatarEmoji: emoji || '', avatarColor: color || '' });
    } catch {}
  };

  const downloadFile = (filename: string, content: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const buildBackup = async (
    format: 'json' | 'txt' | 'md',
    includeScheduled: boolean,
    includeProfile: boolean,
    password: string
  ) => {
    if (!user) return;
    const payload: any = {
      app: 'chatrix',
      version: 2,
      exportedAt: new Date().toISOString(),
      rooms: useStore.getState().joinedRooms,
    };
    if (includeScheduled) {
      payload.scheduled = await localDB.scheduled.toArray();
    }
    if (includeProfile) {
      const profile = await localDB.userProfile.get(user.uid);
      if (profile) payload.profile = profile;
    }

    let finalContent: string;
    let ext: string;
    let mime: string;
    const json = JSON.stringify(payload, null, 2);
    const date = new Date().toISOString().slice(0, 10);

    if (password) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await derivePasswordKey(password, salt);
      const { ciphertext, iv } = await encrypt(json, key);
      const b64 = (b: ArrayBuffer) => {
        const bytes = new Uint8Array(b);
        let bin = '';
        for (const x of bytes) bin += String.fromCharCode(x);
        return btoa(bin);
      };
      finalContent = JSON.stringify({
        app: 'chatrix',
        encrypted: true,
        version: 2,
        exportedAt: new Date().toISOString(),
        salt: b64(salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength)),
        iv,
        ciphertext,
      }, null, 2);
      ext = 'json';
      mime = 'application/json';
    } else if (format === 'txt') {
      const lines: string[] = [
        '==========================================',
        ' CHATRIX BACKUP  (text export)',
        ` Exported: ${new Date().toISOString()}`,
        ` Rooms: ${payload.rooms.length}`,
        '==========================================',
        '',
      ];
      payload.rooms.forEach((r: any, i: number) => {
        lines.push(`ROOM ${i + 1}`);
        lines.push(`  Code: ${r.code}`);
        lines.push(`  Name: ${r.name || `Room ${r.code}`}`);
        lines.push(`  Joined: ${new Date(r.joinedAt || Date.now()).toISOString()}`);
        lines.push(`  Last read: ${r.lastReadTimestamp ? new Date(r.lastReadTimestamp).toISOString() : 'never'}`);
        lines.push('');
      });
      if (payload.scheduled) {
        lines.push(`Scheduled messages: ${payload.scheduled.length}`);
        payload.scheduled.forEach((s: any) => {
          lines.push(`  ${new Date(s.sendAtMs).toISOString()}  ${s.roomCode}  ${(s.textPreview || '').slice(0, 60)}`);
        });
        lines.push('');
      }
      if (payload.profile) {
        lines.push(`Profile: ${payload.profile.name}`);
        lines.push('');
      }
      lines.push('------------------------------------------');
      lines.push('To restore, open the Chatrix app and use Restore with this file.');
      lines.push('');
      lines.push('-----BEGIN CHATRIX BACKUP-----');
      lines.push(json);
      lines.push('-----END CHATRIX BACKUP-----');
      finalContent = lines.join('\n');
      ext = 'txt';
      mime = 'text/plain';
    } else if (format === 'md') {
      const md: string[] = [
        '# Chatrix Backup',
        '',
        `Generated by Chatrix on **${new Date().toISOString()}**.`,
        '',
        `## Rooms (${payload.rooms.length})`,
        '',
        '| Code | Name | Joined | Last read |',
        '| --- | --- | --- | --- |',
      ];
      payload.rooms.forEach((r: any) => {
        md.push(`| ${r.code} | ${r.name || `Room ${r.code}`} | ${new Date(r.joinedAt || Date.now()).toISOString()} | ${r.lastReadTimestamp ? new Date(r.lastReadTimestamp).toISOString() : 'never'} |`);
      });
      if (payload.scheduled) {
        md.push('', `## Scheduled messages (${payload.scheduled.length})`, '');
        payload.scheduled.forEach((s: any) => {
          md.push(`- \`${new Date(s.sendAtMs).toISOString()}\` in \`${s.roomCode}\` — ${(s.textPreview || '').slice(0, 80)}`);
        });
      }
      if (payload.profile) {
        md.push('', '## Profile', '', `- **Name:** ${payload.profile.name}`, `- **Avatar:** ${payload.profile.avatarEmoji || 'none'} (${payload.profile.avatarColor || 'default'})`);
      }
      md.push(
        '',
        '## Restore',
        '',
        'Open the Chatrix app, go to the dashboard and use **Restore** with this file.',
        'The machine-readable payload below is embedded for restore:',
        '',
        '```json',
        '-----BEGIN CHATRIX BACKUP-----',
        json,
        '-----END CHATRIX BACKUP-----',
        '```',
      );
      finalContent = md.join('\n');
      ext = 'md';
      mime = 'text/markdown';
    } else {
      finalContent = json;
      ext = 'json';
      mime = 'application/json';
    }

    downloadFile(`chatrix-backup-${date}.${ext}`, finalContent, mime);
  };

  const parseBackup = async (file: File): Promise<any> => {
    const text = await file.text();
    let payload: any;
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      payload = JSON.parse(trimmed);
    } else {
      const m = trimmed.match(/-----BEGIN CHATRIX BACKUP-----([\s\S]*?)-----END CHATRIX BACKUP-----/);
      if (!m) throw new Error('no-payload');
      payload = JSON.parse(m[1]);
    }
    if (payload.encrypted === true) {
      const password = window.prompt('This backup is encrypted. Enter the backup password:');
      if (password === null) throw new Error('cancelled');
      const key = await derivePasswordKey(password, Uint8Array.from(atob(payload.salt), (c) => c.charCodeAt(0)));
      let plain: string;
      try {
        plain = await decrypt(payload.ciphertext, payload.iv, key);
      } catch {
        throw new Error('wrong-password');
      }
      payload = JSON.parse(plain);
    }
    if (payload.app !== 'chatrix' || !Array.isArray(payload.rooms)) {
      throw new Error('invalid');
    }
    return payload;
  };

  const handleRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file || !user) return;
    try {
      const parsed = await parseBackup(file);
      let restored = 0;
      for (const r of parsed.rooms) {
        if (!r.code || typeof r.code !== 'string') continue;
        await setDoc(doc(db, 'rooms', r.code), { name: r.name || `Room ${r.code}`, createdAt: serverTimestamp(), createdBy: user.uid }, { merge: true });
        await setDoc(doc(db, 'rooms', r.code, 'members', user.uid), { joinedAt: serverTimestamp(), name: user.name }, { merge: true });
        const room: JoinedRoom = {
          code: r.code,
          name: r.name || `Room ${r.code}`,
          joinedAt: r.joinedAt || Date.now(),
          lastReadTimestamp: r.lastReadTimestamp ?? null,
        };
        await localDB.joinedRooms.put(room);
        addJoinedRoom(room);
        restored++;
      }
      if (Array.isArray(parsed.scheduled) && parsed.scheduled.length > 0) {
        await localDB.scheduled.bulkPut(
          parsed.scheduled
            .filter((s: any) => s && s.id && s.roomCode)
            .map((s: any) => ({
              id: s.id,
              roomCode: s.roomCode,
              sendAtMs: s.sendAtMs || Date.now(),
              textPreview: s.textPreview || '',
            }))
        );
      }
      if (parsed.profile && parsed.profile.uid === user.uid) {
        const current = useStore.getState().user;
        const updated = {
          ...(current || parsed.profile),
          name: parsed.profile.name || current?.name,
          avatarEmoji: parsed.profile.avatarEmoji,
          avatarColor: parsed.profile.avatarColor,
        } as UserProfile;
        await localDB.userProfile.put(updated);
        setUser(updated);
      }
      const allRooms = [...useStore.getState().joinedRooms.map((x) => x.code), ...parsed.rooms.map((r: any) => r.code)];
      swSend({ type: 'WATCH_ROOMS', rooms: Array.from(new Set(allRooms)) });
      setError(restored > 0 ? `Restored ${restored} room${restored !== 1 ? 's' : ''}` : 'No rooms found in backup');
    } catch (err: any) {
      if (err?.message === 'wrong-password') setError('Wrong backup password');
      else if (err?.message === 'cancelled') setError('');
      else if (err?.message === 'no-payload') setError('No backup payload found in file');
      else setError('Could not read backup file');
    }
  };

  const getLastMessage = useCallback(async (roomCode: string) => {
    try {
      const q = query(
        collection(db, 'rooms', roomCode, 'messages'),
        orderBy('timestamp', 'desc'),
        limit(1)
      );
      const snap = await getDocs(q);
      if (snap.empty) return null;
      const data = snap.docs[0].data();
      if (data.poll) return { text: '[Poll]', timestamp: data.timestamp?.toMillis() ?? Date.now(), senderUid: data.senderUid, senderName: data.senderName || data.senderUid?.slice(0, 6) };
      if (data.sys) return { text: data.sys?.type ? `[System]` : (data.text || '').slice(0, 40), timestamp: data.timestamp?.toMillis() ?? Date.now(), senderUid: data.senderUid, senderName: data.senderName || data.senderUid?.slice(0, 6) };
      if (!data.ciphertext || !data.iv) return null;
      const key = await deriveKey(roomCode, data.kv ?? 0);
      const decrypted = await decrypt(data.ciphertext, data.iv, key);
      const parsed = JSON.parse(decrypted);
      const isImage = parsed.type === 'image' || parsed.type === 'gif';
      return {
        text: isImage ? 'Image' : (parsed.text || decrypted).slice(0, 40),
        timestamp: data.timestamp?.toMillis() ?? Date.now(),
        senderUid: data.senderUid,
        senderName: data.senderName || data.senderUid?.slice(0, 6),
      };
    } catch {
      return null;
    }
  }, []);

  return (
    <div className="flex flex-col items-center min-h-dvh px-4 py-8 max-w-md md:max-w-lg lg:max-w-xl mx-auto">
      {user && (
        <div className="flex items-center gap-3 mb-6 self-start w-full animate-fade-in group">
          <button onClick={() => setShowAvatarPicker(true)} className="relative shrink-0" title="Customize avatar">
            <Avatar name={user.name} size="lg" emoji={user.avatarEmoji} color={user.avatarColor} />
            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-[#00FF88] rounded-full border-2 border-black" />
            <div className="absolute inset-0 rounded-full bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-white">
                <path d="m5.433 13.917 1.262-3.155A4 4 0 0 1 7.58 9.42l6.92-6.918a2.121 2.121 0 0 1 3 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 0 1-.65-.65Z" />
                <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0 0 10 3H4.75A2.75 2.75 0 0 0 2 5.75v9.5A2.75 2.75 0 0 0 4.75 18h9.5A2.75 2.75 0 0 0 17 15.25V10a.75.75 0 0 0-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5Z" />
              </svg>
            </div>
          </button>
          <div className="flex-1 min-w-0">
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  ref={nameInputRef}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveName();
                    if (e.key === 'Escape') setEditingName(false);
                  }}
                  onBlur={saveName}
                  maxLength={30}
                  className="bg-[#1C1C1E] text-white text-sm font-semibold rounded-lg px-2 py-1.5 outline-none border border-[#333] w-full"
                />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold">{user.name}</p>
                <button onClick={startEditName} className="text-[#555] hover:text-[#007AFF] transition-colors opacity-0 group-hover:opacity-100">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="m5.433 13.917 1.262-3.155A4 4 0 0 1 7.58 9.42l6.92-6.918a2.121 2.121 0 0 1 3 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 0 1-.65-.65Z" />
                    <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0 0 10 3H4.75A2.75 2.75 0 0 0 2 5.75v9.5A2.75 2.75 0 0 0 4.75 18h9.5A2.75 2.75 0 0 0 17 15.25V10a.75.75 0 0 0-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5Z" />
                  </svg>
                </button>
              </div>
            )}
            <p className="text-xs text-[#555]">Chatrix</p>
          </div>
          <button
            onClick={() => setShowBackup(true)}
            className="text-[#444] hover:text-[#007AFF] p-1.5 rounded-lg hover:bg-white/5 transition-all shrink-0"
            title="Backup (download)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
              <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
            </svg>
          </button>
          <button
            onClick={() => restoreInputRef.current?.click()}
            className="text-[#444] hover:text-[#007AFF] p-1.5 rounded-lg hover:bg-white/5 transition-all shrink-0"
            title="Restore (upload backup)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M9.25 13.25a.75.75 0 0 0 1.5 0V4.636l2.955 3.129a.75.75 0 0 0 1.09-1.03l-4.25-4.5a.75.75 0 0 0-1.09 0l-4.25 4.5a.75.75 0 1 0 1.09 1.03l2.955-3.13v8.615Z" />
              <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
            </svg>
          </button>
          <input
            ref={restoreInputRef}
            type="file"
            accept=".json,.txt,.md,application/json,text/plain,text/markdown"
            className="hidden"
            onChange={handleRestoreFile}
          />
        </div>
      )}

      {showBackup && user && (
        <BackupModal
          onDownload={async (format, includeScheduled, includeProfile, password) => {
            await buildBackup(format, includeScheduled, includeProfile, password);
            setShowBackup(false);
          }}
          onClose={() => setShowBackup(false)}
        />
      )}

      {showAvatarPicker && user && (
        <AvatarPickerModal
          current={{ emoji: user.avatarEmoji, color: user.avatarColor }}
          onSave={(emoji, color) => { saveAvatar(emoji, color); setShowAvatarPicker(false); }}
          onClear={() => { saveAvatar('', ''); setShowAvatarPicker(false); }}
          onClose={() => setShowAvatarPicker(false)}
        />
      )}

      <div className="w-full text-center mb-8 animate-fade-in">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#007AFF] to-[#5856D6] flex items-center justify-center mx-auto mb-4 shadow-lg shadow-[#007AFF]/20">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7 text-white">
            <path d="M4.913 2.658c2.075-.27 4.19-.408 6.337-.408 2.147 0 4.262.139 6.337.408 1.922.25 3.291 1.861 3.405 3.727a4.403 4.403 0 0 0-1.032-.211 50.89 50.89 0 0 0-8.42 0c-2.358.196-4.04 2.19-4.04 4.434v4.286a4.47 4.47 0 0 0 2.433 3.984L7.28 21.53A.75.75 0 0 1 6 21v-4.03a48.527 48.527 0 0 1-1.087-.128C2.905 16.58 1.5 14.833 1.5 12.862V6.638c0-1.97 1.405-3.718 3.413-3.979Z" />
            <path d="M15.75 7.5c-1.376 0-2.739.057-4.086.169C10.124 7.797 9 9.103 9 10.609v4.285c0 1.507 1.128 2.814 2.67 2.94 1.243.102 2.5.157 3.768.165l2.782 2.781a.75.75 0 0 0 1.28-.53v-2.39l.33-.026c1.542-.125 2.67-1.433 2.67-2.94v-4.286c0-1.505-1.125-2.811-2.664-2.94A49.392 49.392 0 0 0 15.75 7.5Z" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Chatrix</h1>
        <p className="text-xs text-[#555] mt-1">Anonymous &middot; Encrypted</p>
      </div>

      <div className="w-full animate-slide-up">
        <p className="text-xs text-[#555] text-center mb-3">Enter room code</p>
        <div className="flex items-center justify-center gap-3">
          {[0, 1, 2, 3].map((i) => (
            <input
              key={i}
              ref={(el) => { joinInputs.current[i] = el; }}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={1}
              value={roomName[i] || ''}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '').slice(0, 1);
                const chars = roomName.split('');
                chars[i] = val;
                const joined = chars.join('').slice(0, 4);
                setRoomName(joined);
                if (val && i < 3) joinInputs.current[i + 1]?.focus();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Backspace' && !roomName[i] && i > 0) {
                  joinInputs.current[i - 1]?.focus();
                }
                if (e.key === 'Enter' && roomName.length === 4) joinRoom();
              }}
              onFocus={(e) => e.target.select()}
              className="w-14 h-14 bg-[#0D0D0D] border-2 border-[#333] rounded-xl text-white text-xl font-bold text-center outline-none focus:border-[#007AFF] transition-colors [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          ))}
        </div>

        {error && (
          <p className="mt-3 text-sm text-red-400 text-center">{error}</p>
        )}

        <div className="flex gap-3 w-full mt-6">
          <button
            onClick={joinRoom}
            disabled={roomName.length !== 4 || loading === 'join'}
            className="flex-1 py-3 rounded-xl font-semibold bg-[#007AFF] text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#0066CC] active:scale-[0.98] transition-all"
          >
            {loading === 'join' ? (
              <span className="flex items-center justify-center gap-2">
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Joining
              </span>
            ) : 'Join'}
          </button>
          <button

            onClick={openCreateModal}
            disabled={loading === 'create'}

            className="flex-1 py-3 rounded-xl font-semibold border border-[#333] text-[#B3B3B3] disabled:opacity-30 disabled:cursor-not-allowed hover:border-[#555] hover:text-white active:scale-[0.98] transition-all"
          >
            {loading === 'create' ? (
              <span className="flex items-center justify-center gap-2">
                <div className="w-4 h-4 border-2 border-[#555] border-t-white rounded-full animate-spin" />
                Creating
              </span>
            ) : 'Create'}
          </button>
        </div>
      </div>

      {showPrompt && (
        <button
          onClick={install}
          className="mt-6 text-xs text-[#555] hover:text-[#007AFF] transition-colors"
        >
          Install App
        </button>
      )}

      {showCreateModal && (
        <>
          <div className="fixed inset-0 z-50 bg-black/60" onClick={() => setShowCreateModal(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
            <div
              className="bg-[#1C1C1E] border border-[#333] rounded-2xl w-full max-w-sm shadow-2xl pointer-events-auto animate-fade-in"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-5 pt-5 pb-2">
                <h2 className="text-lg font-bold text-white">Create Room</h2>
                <p className="text-xs text-[#555] mt-1">Give your room a name</p>
              </div>
              <div className="px-5 py-4">
                <input
                  ref={createInputRef}
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') createRoom(createName);
                    if (e.key === 'Escape') setShowCreateModal(false);
                  }}
                  placeholder="e.g. Family Chat"
                  maxLength={30}
                  className="w-full bg-[#0D0D0D] text-white text-sm rounded-xl px-4 py-3 outline-none border border-[#333] focus:border-[#555] transition-colors placeholder-[#555]"
                />
                <div className="mt-4 space-y-2">
                  <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider">Room type</p>
                  <button
                    onClick={() => setCreateType('permanent')}
                    className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${
                      createType === 'permanent'
                        ? 'border-[#007AFF] bg-[#007AFF]/10'
                        : 'border-[#333] bg-[#0D0D0D] hover:border-[#555]'
                    }`}
                  >
                    <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${createType === 'permanent' ? 'border-[#007AFF]' : 'border-[#555]'}`}>
                      {createType === 'permanent' && <div className="w-2 h-2 rounded-full bg-[#007AFF]" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white">Permanent</p>
                      <p className="text-[11px] text-[#555] mt-0.5">Room stays forever until removed</p>
                    </div>
                  </button>
                  <button
                    onClick={() => setCreateType('auto')}
                    className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${
                      createType === 'auto'
                        ? 'border-[#FF3B30] bg-[#FF3B30]/10'
                        : 'border-[#333] bg-[#0D0D0D] hover:border-[#555]'
                    }`}
                  >
                    <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${createType === 'auto' ? 'border-[#FF3B30]' : 'border-[#555]'}`}>
                      {createType === 'auto' && <div className="w-2 h-2 rounded-full bg-[#FF3B30]" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white">Auto-delete</p>
                      <p className="text-[11px] text-[#555] mt-0.5">Room is deleted 1 hour after the last message</p>
                    </div>
                  </button>
                </div>
              </div>
              <div className="flex gap-3 px-5 pb-5">
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium text-[#555] border border-[#333] hover:text-white hover:border-[#555] transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={() => createRoom(createName)}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-[#007AFF] text-white hover:bg-[#0066CC] transition-all"
                >
                  {createName.trim() ? 'Create' : 'Skip →'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {joinedRooms.length > 0 && (
        <div className="w-full mt-10 animate-fade-in">
          <div className="flex items-center gap-2 mb-3 px-1">
            <div className="h-3 w-0.5 rounded-full bg-[#007AFF]" />
            <h2 className="text-[11px] font-semibold text-[#555] uppercase tracking-[0.15em]">
              Your Rooms
            </h2>
            <span className="text-[10px] text-[#333] font-mono ml-auto">
              {joinedRooms.filter((r) => !r.archived).length}
            </span>
          </div>
          <div className="space-y-1">
            {[...joinedRooms].filter((r) => !r.archived).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)).map((room) => (
              <RoomItem
                key={room.code}
                room={room}
                onEnter={() => navigate(`/chat/${room.code}`)}
                onTogglePin={async () => {
                  const updated = { ...room, pinned: !room.pinned };
                  await localDB.joinedRooms.put(updated);
                  setJoinedRooms(joinedRooms.map((r) => r.code === room.code ? updated : r));
                }}
                onArchive={async () => {
                  const updated = { ...room, archived: true };
                  await localDB.joinedRooms.put(updated);
                  setJoinedRooms(joinedRooms.map((r) => r.code === room.code ? updated : r));
                }}
                onToggleDnd={async () => {
                  const updated = { ...room, dnd: !room.dnd };
                  await localDB.joinedRooms.put(updated);
                  setJoinedRooms(joinedRooms.map((r) => r.code === room.code ? updated : r));
                }}
                onDelete={() => {
                  if (_confirmDelete === room.code) {
                    localDB.joinedRooms.delete(room.code);
                    removeJoinedRoom(room.code);
                    const remaining = useStore.getState().joinedRooms.map((r) => r.code);
                    swSend({ type: 'WATCH_ROOMS', rooms: remaining });
                    setConfirmDelete(null);
                  } else {
                    setConfirmDelete(room.code);
                    setTimeout(() => setConfirmDelete((c) => c === room.code ? null : c), 3000);
                  }
                }}
                confirmDelete={_confirmDelete === room.code}
                getLastMessage={getLastMessage}
              />
            ))}
          </div>
          {joinedRooms.some((r) => r.archived) && (
            <div className="mt-6">
              <h3 className="text-[10px] text-[#555] uppercase tracking-wider mb-2 px-1">Archived · {joinedRooms.filter((r) => r.archived).length}</h3>
              <div className="space-y-1 opacity-60">
                {joinedRooms.filter((r) => r.archived).map((room) => (
                  <div key={room.code} className="flex items-center gap-2">
                    <div className="flex-1">
                      <RoomItem room={room} onEnter={() => navigate(`/chat/${room.code}`)} onDelete={() => { localDB.joinedRooms.delete(room.code); removeJoinedRoom(room.code); }} getLastMessage={getLastMessage} />
                    </div>
                    <button onClick={async () => { const u = { ...room, archived: false }; await localDB.joinedRooms.put(u); setJoinedRooms(joinedRooms.map((r) => r.code === room.code ? u : r)); }} className="text-[11px] text-[#007AFF] px-2 py-1 rounded-lg bg-[#007AFF]/10">Unarchive</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AvatarPickerModal({
  current,
  onSave,
  onClear,
  onClose,
}: {
  current: { emoji?: string; color?: string };
  onSave: (emoji: string, color: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [emoji, setEmoji] = useState(current.emoji || '');
  const [color, setColor] = useState(current.color || '');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const EMOJIS = ['🦊','🐼','🐸','🦁','🐯','🐨','🐙','🦄','🐳','🦋','🐝','🦉','🐢','🐹','🦖','🐲','👽','🤖','👻','😎','🤠','🥷','🧙','🐱'];
  const COLORS = ['#007AFF','#5856D6','#AF52DE','#FF2D55','#FF3B30','#FF9500','#FFCC00','#34C759','#00FF88','#30B0C7','#8E8E93','#A2845E'];

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
        <div
          className="bg-[#1C1C1E] border border-[#333] rounded-2xl w-full max-w-sm shadow-2xl pointer-events-auto animate-fade-in"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#333]">
            <h2 className="text-sm font-semibold text-white">Customize avatar</h2>
            <button onClick={onClose} className="text-[#555] hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-all">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
            </button>
          </div>
          <div className="px-5 py-4">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-14 h-14 rounded-full flex items-center justify-center text-xl border-2 border-[#333]" style={{ backgroundColor: color || '#333' }}>
                {emoji || <span className="text-[#777] text-sm font-bold">{'?'}</span>}
              </div>
              <p className="text-xs text-[#555]">Pick an emoji and a color — shown to others in chat.</p>
            </div>
            <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider mb-2">Emoji</p>
            <div className="grid grid-cols-8 gap-1.5 mb-4">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => setEmoji(e)}
                  className={`text-lg p-1 rounded-lg transition-all ${emoji === e ? 'bg-[#007AFF]/20 ring-1 ring-[#007AFF]' : 'hover:bg-white/5'}`}
                >
                  {e}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider mb-2">Color</p>
            <div className="flex flex-wrap gap-2 mb-5">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`w-7 h-7 rounded-full transition-all ${color === c ? 'ring-2 ring-white scale-110' : 'hover:scale-110'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={onClear}
                className="px-3 py-2 rounded-xl text-xs font-medium text-[#555] border border-[#333] hover:text-white hover:border-[#555] transition-all"
              >
                Reset
              </button>
              <button
                onClick={() => onSave(emoji, color)}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-[#007AFF] text-white hover:bg-[#0066CC] transition-all"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function BackupModal({
  onDownload,
  onClose,
}: {
  onDownload: (format: 'json' | 'txt' | 'md', includeScheduled: boolean, includeProfile: boolean, password: string) => void;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<'json' | 'txt' | 'md'>('json');
  const [includeScheduled, setIncludeScheduled] = useState(true);
  const [includeProfile, setIncludeProfile] = useState(true);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [scheduledCount, setScheduledCount] = useState(0);
  const [roomCount, setRoomCount] = useState(0);

  useEffect(() => {
    localDB.scheduled.count().then(setScheduledCount).catch(() => {});
    localDB.joinedRooms.count().then(setRoomCount).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const FORMATS: { id: 'json' | 'txt' | 'md'; label: string; desc: string }[] = [
    { id: 'json', label: 'JSON', desc: 'Exact machine-readable backup' },
    { id: 'txt', label: 'TXT', desc: 'Readable text + restore payload' },
    { id: 'md', label: 'README', desc: 'Markdown doc + restore payload' },
  ];

  const canDownload = !usePassword || password.length >= 4;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 pointer-events-none">
        <div
          className="bg-[#1C1C1E] border border-[#333] rounded-2xl w-full max-w-md shadow-2xl pointer-events-auto animate-fade-in overflow-hidden my-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#333]">
            <h2 className="text-sm font-semibold text-white">Backup data</h2>
            <button onClick={onClose} className="text-[#555] hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-all">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
            </button>
          </div>

          <div className="px-5 py-4 space-y-5 max-h-[70vh] overflow-y-auto">
            <div>
              <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider mb-2">Format</p>
              <div className="space-y-1.5">
                {FORMATS.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setFormat(f.id)}
                    disabled={usePassword && f.id !== 'json'}
                    className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition-all ${
                      format === f.id && !(usePassword && f.id !== 'json')
                        ? 'border-[#007AFF] bg-[#007AFF]/10'
                        : 'border-[#333] bg-[#0D0D0D] hover:border-[#555] disabled:opacity-30'
                    }`}
                  >
                    <span>
                      <span className="block text-sm font-medium text-white">{f.label}</span>
                      <span className="block text-[11px] text-[#555] mt-0.5">{f.desc}</span>
                    </span>
                    <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${format === f.id && !(usePassword && f.id !== 'json') ? 'border-[#007AFF]' : 'border-[#444]'}`}>
                      {format === f.id && !(usePassword && f.id !== 'json') && <span className="w-2 h-2 rounded-full bg-[#007AFF]" />}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider mb-2">Include</p>
              <div className="space-y-2">
                <label className="flex items-center justify-between cursor-pointer">
                  <span>
                    <span className="block text-sm text-white">Scheduled messages</span>
                    <span className="block text-[11px] text-[#555] mt-0.5">{scheduledCount} pending message{scheduledCount !== 1 ? 's' : ''}</span>
                  </span>
                  <button
                    onClick={() => setIncludeScheduled((v) => !v)}
                    className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${includeScheduled ? 'bg-[#34C759]' : 'bg-[#3A3A3C]'}`}
                  >
                    <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${includeScheduled ? 'left-[22px]' : 'left-0.5'}`} />
                  </button>
                </label>
                <label className="flex items-center justify-between cursor-pointer">
                  <span>
                    <span className="block text-sm text-white">Profile &amp; avatar</span>
                    <span className="block text-[11px] text-[#555] mt-0.5">Name and custom avatar</span>
                  </span>
                  <button
                    onClick={() => setIncludeProfile((v) => !v)}
                    className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${includeProfile ? 'bg-[#34C759]' : 'bg-[#3A3A3C]'}`}
                  >
                    <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${includeProfile ? 'left-[22px]' : 'left-0.5'}`} />
                  </button>
                </label>
              </div>
            </div>

            <div>
              <label className="flex items-center justify-between cursor-pointer mb-2">
                <span className="block text-sm text-white">Password protect</span>
                <button
                  onClick={() => setUsePassword((v) => !v)}
                  className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${usePassword ? 'bg-[#FF9500]' : 'bg-[#3A3A3C]'}`}
                >
                  <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${usePassword ? 'left-[22px]' : 'left-0.5'}`} />
                </button>
              </label>
              {usePassword && (
                <>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Backup password (min 4 chars)"
                    className="w-full bg-[#0D0D0D] text-white text-sm rounded-lg px-3 py-2 outline-none border border-[#333] focus:border-[#555] placeholder-[#555]"
                  />
                  <p className="text-[10px] text-[#555] mt-1">Encrypted with AES-256. Encrypted backups are always .json.</p>
                </>
              )}
            </div>
          </div>

          <div className="px-5 py-4 border-t border-[#333]">
            <button
              onClick={() => onDownload(format, includeScheduled, includeProfile, password)}
              disabled={!canDownload}
              className="w-full py-2.5 rounded-xl text-sm font-medium bg-[#007AFF] text-white hover:bg-[#0066CC] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              Download backup
            </button>
            <p className="text-[10px] text-[#555] text-center mt-2">{roomCount} room{roomCount !== 1 ? 's' : ''} will be included</p>
          </div>
        </div>
      </div>
    </>
  );
}

function RoomItem({
  room,
  onEnter,
  onDelete,
  onTogglePin,
  onArchive,
  onToggleDnd,
  confirmDelete: confirmDeleteProp,
  getLastMessage,
}: {
  room: JoinedRoom;
  onEnter: () => void;
  onDelete: () => void;
  onTogglePin?: () => void;
  onArchive?: () => void;
  onToggleDnd?: () => void;
  confirmDelete?: boolean;
  getLastMessage: (code: string) => Promise<{ text: string; timestamp: number; senderUid: string; senderName: string } | null>;
}) {
  const [preview, setPreview] = useState<{ text: string; timestamp: number; senderUid: string; senderName: string } | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [unread, setUnread] = useState(0);

  const [roomName, setRoomName] = useState(room.name || '');

  const { user } = useStore();

  const pressTimerRef = useRef<number | null>(null);
  const longPressedRef = useRef(false);

  useEffect(() => {
    if (!room.lastReadTimestamp) { setUnread(0); return; }
    const q = query(
      collection(db, 'rooms', room.code, 'messages'),
      where('timestamp', '>', new Date(room.lastReadTimestamp)),
      limit(200)
    );
    const unsub = onSnapshot(q, (snap) => setUnread(snap.size));
    return unsub;
  }, [room.code, room.lastReadTimestamp]);

  const startPress = () => {
    longPressedRef.current = false;
    pressTimerRef.current = window.setTimeout(() => {
      longPressedRef.current = true;
      setShowDelete(true);
    }, 500);
  };

  const cancelPress = () => {
    if (pressTimerRef.current !== null) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    // Instant preview (before the listener's first emit), then kept live below.
    getLastMessage(room.code).then((msg) => {
      if (msg && !cancelled) setPreview(msg);
    });
    // Real-time last-message preview: subscribe so the dashboard reflects new
    // messages instantly instead of only after reopening the room.
    const q = query(
      collection(db, 'rooms', room.code, 'messages'),
      orderBy('seq', 'desc'),
      limit(1)
    );
    const unsub = onSnapshot(q, async (snap) => {
      if (cancelled) return;
      if (snap.empty) { setPreview(null); return; }
      const d = snap.docs[0].data();
      if (d.sys) {
        setPreview({ text: `[${d.sys.type === 'join' ? 'Joined' : 'Left'}]`, timestamp: d.timestamp?.toMillis?.() ?? Date.now(), senderUid: d.senderUid || '', senderName: d.sys.name || '' });
        return;
      }
      if (d.poll) {
        setPreview({ text: '[Poll]', timestamp: d.timestamp?.toMillis?.() ?? Date.now(), senderUid: d.senderUid || '', senderName: d.senderName || '' });
        return;
      }
      if (!d.ciphertext || !d.iv) { setPreview(null); return; }
      try {
        const key = await deriveKey(room.code, d.kv ?? 0);
        const dec = await decrypt(d.ciphertext, d.iv, key);
        const parsed = JSON.parse(dec);
        const isImage = parsed.type === 'image' || parsed.type === 'gif';
        setPreview({
          text: (isImage ? 'Image' : (parsed.text || dec)).slice(0, 40),
          timestamp: d.timestamp?.toMillis?.() ?? Date.now(),
          senderUid: d.senderUid,
          senderName: d.senderName || d.senderUid?.slice(0, 6),
        });
      } catch {
        setPreview({ text: '[Encrypted]', timestamp: d.timestamp?.toMillis?.() ?? Date.now(), senderUid: d.senderUid, senderName: d.senderName || '' });
      }
    });
    // Fetch room name from Firestore (for rooms that may not have name stored locally)
    getDoc(doc(db, 'rooms', room.code)).then((snap) => {
      if (snap.exists() && !cancelled) {
        const data = snap.data();
        if (data.name) setRoomName(data.name);
      }
    });
    return () => { cancelled = true; unsub(); };
  }, [room.code]);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'rooms', room.code), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.name) setRoomName(data.name);
      }
    });
    return unsub;
  }, [room.code]);

  useEffect(() => {
    const q = query(collection(db, 'rooms', room.code, 'members'));
    const unsub = onSnapshot(q, (snap) => {
      let count = 0;
      snap.forEach((d) => {
        if (!d.data().kicked) count++;
      });
      setMemberCount(count);
    });
    return unsub;
  }, [room.code]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    const dayDiff = Math.floor(diff / 86400000);
    if (dayDiff === 1) return 'Yesterday';
    if (dayDiff < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };


  function hashColor(name: string) {
    const safe = name || '?';
    let hash = 0;
    for (let i = 0; i < safe.length; i++) hash = safe.charCodeAt(i) + ((hash << 5) - hash);
    const h = Math.abs(hash) % 360;
    return `linear-gradient(135deg, hsl(${h}, 55%, 45%), hsl(${(h + 40) % 360}, 50%, 35%))`;
  }

  return (
    <button
      onClick={() => {
        if (longPressedRef.current) {
          longPressedRef.current = false;
          return;
        }
        if (showDelete) {
          setShowDelete(false);
          return;
        }
        onEnter();
      }}
      onPointerDown={startPress}
      onPointerUp={cancelPress}
      onPointerLeave={cancelPress}
      onPointerCancel={cancelPress}
      onContextMenu={(e) => e.preventDefault()}
      className="w-full flex items-center gap-3 p-3 rounded-2xl border border-[#222] bg-[#0D0D0D] text-left hover:bg-[#141414] hover:border-[#333] transition-all active:scale-[0.98] group select-none touch-manipulation"
    >
      <div
        className="w-11 h-11 rounded-xl flex items-center justify-center font-bold text-white text-sm shrink-0 shadow-lg"

        style={{ background: hashColor(roomName) }}
      >
        {roomName ? getInitials(roomName) : '?'}

      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-white truncate flex items-center gap-1.5">

            <span>{roomName}</span>

            {memberCount !== null && (
              <span className="text-[10px] font-normal text-[#555] flex items-center gap-0.5">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                  <path d="M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM1.49 15.326a.78.78 0 0 1-.358-.442 3 3 0 0 1 4.308-3.516 6.484 6.484 0 0 0-1.905 3.959c-.023.222-.014.442.025.654a4.97 4.97 0 0 1-2.07-.655ZM16.44 15.98a4.97 4.97 0 0 0 2.07-.654.78.78 0 0 0 .357-.442 3 3 0 0 0-4.308-3.517 6.484 6.484 0 0 1 1.907 3.96 2.32 2.32 0 0 1-.026.654ZM18 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM5.304 16.19a.844.844 0 0 1-.277-.71 5 5 0 0 1 9.947 0 .843.843 0 0 1-.277.71A6.975 6.975 0 0 1 10 18a6.974 6.974 0 0 1-4.696-1.81Z" />
                </svg>
                {memberCount}
              </span>
            )}
          </p>
          {preview && (
            <span className="text-[10px] text-[#555] shrink-0 font-medium" title={new Date(preview.timestamp).toLocaleString()}>
              {formatTime(preview.timestamp)}
            </span>
          )}
        </div>
        <p className="text-xs text-[#666] truncate mt-0.5 flex items-center gap-1">
          {preview ? (
            <>
              <span className={`${preview.senderUid === user?.uid ? 'text-[#007AFF]' : 'text-[#00FF88]'} font-medium`}>
                {preview.senderUid === user?.uid ? 'You' : (preview.senderName || 'Someone')}
              </span>
              <span className="text-[#444]">&middot;</span>
              <span>{preview.text === 'Image' ? '📷 Image' : preview.text}</span>
            </>
          ) : (
            <span className="text-[#555] italic">No messages yet</span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1">
        {unread > 0 && !room.dnd && (
          <span className="min-w-5 h-5 px-1.5 rounded-full bg-[#007AFF] text-white text-[10px] font-bold flex items-center justify-center shrink-0">
            {unread >= 200 ? '200+' : unread}
          </span>
        )}
        {room.dnd && <span className="text-[11px]">🔕</span>}
        {room.pinned && <span className="text-[11px]">📌</span>}
        {onTogglePin && (
          <button onClick={(e) => { e.stopPropagation(); onTogglePin(); }} className={`p-1 rounded-lg hover:bg-white/5 ${room.pinned ? 'text-[#FFD700]' : 'text-[#333] hover:text-white'} opacity-0 group-hover:opacity-100 transition-all`} title={room.pinned ? 'Unpin' : 'Pin'}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path d="M9.038 2.356a.75.75 0 0 0-.924 0L2.12 6.21a.75.75 0 0 0-.07 1.268l2.18 1.733-.869 3.52a.75.75 0 0 0 1.07.865L10 14.219l5.57 2.373a.75.75 0 0 0 1.07-.865l-.869-3.52 2.18-1.733a.75.75 0 0 0-.07-1.268L10.962 2.356a.75.75 0 0 0-.924 0Z" /></svg>
          </button>
        )}
        {onToggleDnd && (
          <button onClick={(e) => { e.stopPropagation(); onToggleDnd(); }} className={`p-1 rounded-lg hover:bg-white/5 ${room.dnd ? 'text-[#FF9500]' : 'text-[#333] hover:text-white'} opacity-0 group-hover:opacity-100 transition-all`} title={room.dnd ? 'Unmute' : 'Mute'}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path d="M10 3a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 3ZM5.06 8.464a.75.75 0 0 1 1.06 0l.708.707a.75.75 0 0 1-1.06 1.06l-.708-.707a.75.75 0 0 1 0-1.06Zm8.485 0a.75.75 0 0 1 0 1.06l-.707.708a.75.75 0 1 1-1.06-1.06l.707-.708a.75.75 0 0 1 1.06 0ZM10 6a4 4 0 0 1 4 4v2.379l1.13 1.129a.75.75 0 1 1-1.06 1.06L8.94 9.44 10 8.38V10a2 2 0 0 0 2 2h.25a.75.75 0 0 1 0 1.5H10a3.5 3.5 0 0 1-3.5-3.5V10a4 4 0 0 1 4-4Z" /><path d="M4.22 4.22a.75.75 0 0 1 1.06 0l12 12a.75.75 0 1 1-1.06 1.06l-12-12a.75.75 0 0 1 0-1.06Z" /></svg>
          </button>
        )}
        {onArchive && !room.archived && (
          <button onClick={(e) => { e.stopPropagation(); onArchive(); }} className="p-1 rounded-lg hover:bg-white/5 text-[#333] hover:text-white opacity-0 group-hover:opacity-100 transition-all" title="Archive">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path d="M3.5 3A1.5 1.5 0 0 0 2 4.5v11A1.5 1.5 0 0 0 3.5 17h13a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 16.5 3h-13ZM4 5.5V4.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 .5.5v1H4Zm13 2v7a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-7h14Z" /></svg>
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className={`p-1 rounded-lg transition-all ${confirmDeleteProp ? 'text-white bg-red-500 hover:bg-red-600 opacity-100' : 'text-[#333] hover:text-red-400 hover:bg-red-400/5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100'}`}
          title={confirmDeleteProp ? 'Confirm delete?' : 'Remove room'}
        >
          {confirmDeleteProp ? (
            <span className="text-[10px] font-bold px-1">Confirm?</span>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c-.84 0-1.673.025-2.5.075V3.75c0-.69.56-1.25 1.25-1.25h2.5c.69 0 1.25.56 1.25 1.25v.325C11.673 4.025 10.84 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.42.06a.75.75 0 0 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clipRule="evenodd" />
            </svg>
          )}
        </button>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-[#333] group-hover:text-[#555] transition-colors shrink-0">
          <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
        </svg>
      </div>
    </button>
  );
}
