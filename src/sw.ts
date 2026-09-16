/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core';
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('install', () => self.skipWaiting());

// ─── IndexedDB persistence ─────────────────────────────────────

const DB_NAME = 'ChatrixSW';
const STORE_NAME = 'state';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => resolve(undefined);
    tx.oncomplete = () => db.close();
  });
}

async function dbPut(key: string, value: any): Promise<void> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => resolve();
  });
}

// ─── State ─────────────────────────────────────────────────────

let firebaseApp: any = null;
let firestoreDb: any = null;
let userUid: string | null = null;
let roomCodes: string[] = [];
let roomUnsubs: Map<string, () => void> = new Map();
let activeRoom: string | null = null;
const notifiedIds = new Set<string>();

// ─── Messages from the page ────────────────────────────────────

self.addEventListener('message', (event) => {
  if (!event.data) return;
  const { type } = event.data;

  switch (type) {
    case 'FIREBASE_CONFIG':
      dbPut('fbConfig', event.data.config);
      initFirebase(event.data.config);
      break;
    case 'USER_UID':
      userUid = event.data.uid;
      dbPut('userUid', event.data.uid);
      break;
    case 'WATCH_ROOMS':
      roomCodes = event.data.rooms;
      dbPut('roomCodes', event.data.rooms);
      if (firestoreDb) watchRooms(event.data.rooms);
      break;
    case 'ACTIVE_ROOM':
      activeRoom = event.data.code;
      break;
    case 'SHOW_NOTIFICATION':
      // Called from the page when it detects a new message while backgrounded
      showNotif(event.data.roomCode, event.data.senderName,
        event.data.replyToUid, event.data.mentionedUids);
      break;
    case 'CALL_ACTIVE':
      showCallNotification(event.data.roomCode, event.data.senderName);
      break;
    case 'CALL_IDLE':
      closeCallNotification();
      break;
  }
});

// ─── Recovery on every SW start ────────────────────────────────

(async function restore() {
  const [config, uid, rooms] = await Promise.all([
    dbGet<any>('fbConfig'),
    dbGet<string>('userUid'),
    dbGet<string[]>('roomCodes'),
  ]);
  if (config) await initFirebase(config);
  if (uid) userUid = uid;
  if (rooms && firestoreDb) watchRooms(rooms);
})();

// ─── Firebase ──────────────────────────────────────────────────

async function initFirebase(config: any) {
  if (firebaseApp) return;
  try {
    const { initializeApp } = await import('firebase/app');
    const { getFirestore } = await import('firebase/firestore');
    firebaseApp = initializeApp(config);
    firestoreDb = getFirestore(firebaseApp);
    // Re-watch if we have room codes after init
    if (roomCodes.length > 0) watchRooms(roomCodes);
  } catch {}
}

// ─── Room watchers ─────────────────────────────────────────────

async function watchRooms(rooms: string[]) {
  if (!firestoreDb) return;

  for (const [code, unsub] of roomUnsubs) {
    if (!rooms.includes(code)) { unsub(); roomUnsubs.delete(code); }
  }

  const { collection, query, orderBy, limit, onSnapshot } = await import('firebase/firestore');

  for (const code of rooms) {
    if (roomUnsubs.has(code)) continue;

    const q = query(
      collection(firestoreDb, 'rooms', code, 'messages'),
      orderBy('timestamp', 'desc'),
      limit(5)
    );

    const unsub = onSnapshot(q, (snap: any) => {
      snap.docChanges().forEach((change: any) => {
        if (change.type !== 'added') return;
        const id = change.doc.id;
        if (notifiedIds.has(id)) return;
        notifiedIds.add(id);
        if (notifiedIds.size > 500) {
          const first = notifiedIds.values().next().value as string | undefined;
          if (first) notifiedIds.delete(first);
        }
        const d = change.doc.data();
        showNotif(code, d.senderName, d.replyToUid, d.mentionedUids);
      });
    });
    roomUnsubs.set(code, unsub);
  }
}

// ─── Notification dispatch ─────────────────────────────────────

function vibrateForRoom(roomCode: string) {
  let seed = 0;
  for (const ch of roomCode) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const patterns = [
    [80, 40, 80],
    [120, 50],
    [40, 40, 40, 40, 120],
  ];
  return patterns[seed % patterns.length];
}

function showNotif(
  roomCode: string,
  senderName?: string,
  replyToUid?: string,
  mentionedUids?: string[],
) {
  if (!userUid) return;
  if (!senderName) return;
  if (roomCode === activeRoom) return;

  const name = senderName || 'Someone';
  let title = `Chatrix`;
  let body = `${name} sent a message in #${roomCode}`;

  if (replyToUid === userUid) {
    title = `📬 Reply from ${name}`;
    body = `${name} replied to you in #${roomCode}`;
  } else if (mentionedUids?.includes(userUid)) {
    title = `📢 ${name} mentioned you`;
    body = `${name} mentioned you in #${roomCode}`;
  }

  self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { roomCode, type: 'new_message' },
    tag: `chatrix-${roomCode}`,
    vibrate: vibrateForRoom(roomCode),
    actions: [
      { action: 'reply', title: '💬 Reply' },
      { action: 'open', title: 'Open' },
    ],
  } as any);
}

let callNotifRoom: string | null = null;

function showCallNotification(roomCode: string, senderName?: string) {
  if (roomCode === activeRoom) return;
  callNotifRoom = roomCode;
  self.registration.showNotification('🔊 Call in progress', {
    body: `${senderName || 'Someone'} is in a voice call in #${roomCode}`,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { roomCode, type: 'call_active' },
    tag: `chatrix-call-${roomCode}`,
    renotify: false,
    silent: true,
    actions: [{ action: 'open', title: 'Return to call' }],
  } as any);
}

function closeCallNotification() {
  if (!callNotifRoom) return;
  self.registration.getNotifications({ tag: `chatrix-call-${callNotifRoom}` })
    .then((notifs) => notifs.forEach((n) => n.close()))
    .catch(() => {});
  callNotifRoom = null;
}

// ─── FCM push (fallback) ───────────────────────────────────────

self.addEventListener('push', (event) => {
  let data: any;
  try { data = event.data?.json(); } catch { return; }
  if (!data) return;

  const payload = data.data || data;
  const roomCode = payload.roomCode;
  const nData = data.notification || {};
  const title = nData.title || data.title || 'Chatrix';
  const body = nData.body || data.body || 'New message';

  event.waitUntil(
    self.registration.showNotification(title, {
      body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
      data: { roomCode, type: payload.type || 'new_message' },
      tag: roomCode ? `chatrix-${roomCode}` : 'chatrix',
    })
  );
});

// ─── Notification click ────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const roomCode = event.notification.data?.roomCode;
  const url = roomCode
    ? `/chat/${roomCode}${event.action === 'reply' ? '?reply=1' : ''}`
    : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        const clientUrl = new URL(client.url);
        const targetUrl = new URL(url, self.location.origin);
        if (clientUrl.pathname === targetUrl.pathname && 'focus' in client) {
          client.postMessage({ type: 'FOCUS_INPUT' });
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
