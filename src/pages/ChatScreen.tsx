import { useState, useEffect, useRef, useCallback, useMemo, memo, Fragment } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  addDoc,
  updateDoc,
  serverTimestamp,
  Timestamp,
  getDocs,
  getDoc,
  startAfter,
  doc,
  setDoc,
  deleteDoc,
  arrayUnion,
  where,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { deriveKey, encrypt, decrypt, roomFingerprint } from '../lib/crypto';
import { deleteRoomData } from '../lib/roomUtils';
import { localDB } from '../lib/db';
import { swSend } from '../lib/sw';
import { useStore } from '../store/useStore';
import Avatar from '../components/Avatar';
import EmojiPicker from '../components/EmojiPicker';
import VoiceCallUI from '../components/VoiceCallUI';
import { useVoiceCall } from '../hooks/useVoiceCall';
import { QRCodeSVG } from 'qrcode.react';
import type { DecryptedMessage, ReplyTo, TypingUser, RoomSettings, ScheduledMsg, SearchIndexEntry } from '../types';

const PAGE_SIZE = 50;
const TYPING_TIMEOUT = 2000;
const BURN_TTL = 30000;

export default function ChatScreen() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, messages, setMessages, callInvitations, mutedUids, toggleMuteUid } = useStore();
  const fontSize = useStore((s) => s.fontSize);
  const reducedMotion = useStore((s) => s.reducedMotion);
  const dataSaver = useStore((s) => s.dataSaver);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState<Record<number, CryptoKey>>({});
  const [roomKeyVersion, setRoomKeyVersion] = useState(0);
  const [roomSettings, setRoomSettings] = useState<RoomSettings | null>(null);
  const [fingerprint, setFingerprint] = useState('');
  const [burnEnabled, setBurnEnabled] = useState(false);
  const [tone, setTone] = useState<'pop' | 'ding' | 'soft' | 'none'>('pop');
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [onlineCount, setOnlineCount] = useState(0);
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const [memberNameMap, setMemberNameMap] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menuMsgId, setMenuMsgId] = useState<string | null>(null);
  const [reactingMsgId, setReactingMsgId] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showPollForm, setShowPollForm] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState(['', '']);
  const [showSettings, setShowSettings] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [inviteLink, setInviteLink] = useState('');
  const [toast, setToast] = useState('');
  const [forwardMsg, setForwardMsg] = useState<DecryptedMessage | null>(null);
  const [historyMsg, setHistoryMsg] = useState<DecryptedMessage | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [viewOnce, setViewOnce] = useState(false);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [roomReady, setRoomReady] = useState(false);

  const [roomName, setRoomName] = useState('');
  const [editingRoomName, setEditingRoomName] = useState(false);
  const [roomNameInput, setRoomNameInput] = useState('');
  const [memberList, setMemberList] = useState<{ name: string; uid: string; online?: boolean; lastSeen?: number; lastSpokeAt?: number | null; avatarEmoji?: string; avatarColor?: string }[]>([]);

  const [memberSearch, setMemberSearch] = useState('');
  const [roomOwnerUid, setRoomOwnerUid] = useState<string | null>(null);
  const [kicked, setKicked] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionStartIndex, setMentionStartIndex] = useState(-1);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('');
  const [scheduledMsgs, setScheduledMsgs] = useState<ScheduledMsg[]>([]);
  const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const lastDocRef = useRef<any>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const roomNameInputRef = useRef<HTMLInputElement>(null);
  const msgElRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const indexedIdsRef = useRef<Set<string>>(new Set());
  const seenMsgIds = useRef<Set<string>>(new Set());
  const burnScheduledRef = useRef<Set<string>>(new Set());
  const burnTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastReadSeqRef = useRef(0);
  const myLastMsgTimeRef = useRef(0);
  const initialSnapshotDone = useRef(false);
  const userRef = useRef(user);
  userRef.current = user;
  const toneRef = useRef(tone);
  toneRef.current = tone;
  const roomNameRef = useRef(roomName);
  roomNameRef.current = roomName;

  const cryptoKey = keys[roomKeyVersion] ?? null;

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(''), 2500);
  };

  const voiceCall = useVoiceCall(code);

  useEffect(() => {
    useStore.getState().setCallState(null);
    useStore.getState().setCallParticipants([]);
    useStore.getState().setCallInvitations([]);
  }, [code]);

  // ── New feature handlers ──
  const forwardMessage = async (targetCode: string) => {
    if (!forwardMsg || !user || !code) return;
    try {
      const targetKey = await deriveKey(targetCode, 0);
      const payload: any = { text: forwardMsg.text, type: forwardMsg.type || 'text', forwarded: true };
      if (forwardMsg.file) payload.file = forwardMsg.file;
      const { ciphertext, iv } = await encrypt(JSON.stringify(payload), targetKey);
      await addDoc(collection(db, 'rooms', targetCode, 'messages'), {
        senderUid: user.uid,
        senderName: user.name,
        ciphertext,
        iv,
        timestamp: serverTimestamp(),
        seq: Date.now(),
        kv: 0,
      });
      showToast(`Forwarded to #${targetCode}`);
      setForwardMsg(null);
    } catch { showToast('Forward failed'); }
  };

  const toggleMute = (uid: string) => {
    toggleMuteUid(uid);
    showToast(mutedUids.includes(uid) ? 'Unmuted' : 'Muted');
  };

  const reportMessage = async (msg: DecryptedMessage) => {
    if (!code || !user) return;
    try {
      await addDoc(collection(db, 'rooms', code, 'reports'), {
        msgId: msg.id,
        reportedUid: msg.senderUid,
        reporterUid: user.uid,
        text: msg.text.slice(0, 200),
        timestamp: serverTimestamp(),
      });
      await addDoc(collection(db, 'rooms', code, 'audit'), {
        type: 'report',
        actorUid: user.uid,
        actorName: user.name,
        targetUid: msg.senderUid,
        msgId: msg.id,
        timestamp: serverTimestamp(),
      });
      showToast('Reported');
    } catch { showToast('Report failed'); }
  };

  const startTranscription = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) { showToast('Speech not supported'); return; }
    const rec = new SpeechRecognition();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.onstart = () => setIsTranscribing(true);
    rec.onend = () => setIsTranscribing(false);
    rec.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      setInput((prev) => prev ? prev + ' ' + transcript : transcript);
    };
    rec.onerror = () => setIsTranscribing(false);
    try { rec.start(); } catch {}
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowCommandPalette((v) => !v);
      }
      if (e.key === 'Escape') {
        setShowCommandPalette(false);
        setLightboxSrc(null);
        setForwardMsg(null);
        setHistoryMsg(null);
      }
      if (e.key === '/' && !showCommandPalette && (e.target as HTMLElement)?.tagName !== 'INPUT') {
        e.preventDefault();
        setShowCommandPalette(true);
      }
      if (e.key === 'ArrowUp' && !input && !editingId && messages.length > 0) {
        const lastOwn = [...messages].reverse().find((m) => m.senderUid === user?.uid);
        if (lastOwn) handleEdit(lastOwn);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [input, editingId, messages, user]);

  useEffect(() => {
    (window as any).chatrixForward = (msg: DecryptedMessage) => setForwardMsg(msg);
    (window as any).chatrixMute = (uid: string) => toggleMute(uid);
    (window as any).chatrixReport = (msg: DecryptedMessage) => reportMessage(msg);
    (window as any).chatrixHistory = (msg: DecryptedMessage) => setHistoryMsg(msg);
    (window as any).chatrixLightbox = (src: string) => setLightboxSrc(src);
  }, [mutedUids]);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    const maxVersion = Math.max(2, roomKeyVersion);
    const versions = Array.from({ length: maxVersion + 1 }, (_, i) => i);
    Promise.all(versions.map((v) => deriveKey(code, v)))
      .then((derived) => {
        if (cancelled) return;
        const next: Record<number, CryptoKey> = {};
        derived.forEach((k, i) => { next[i] = k; });
        setKeys(next);
      })
      .catch(() => {});
    roomFingerprint(code)
      .then((fp) => { if (!cancelled) setFingerprint(fp); })
      .catch(() => setFingerprint(''));
    swSend({ type: 'ACTIVE_ROOM', code });
    return () => { cancelled = true; swSend({ type: 'ACTIVE_ROOM', code: null }); };
  }, [code, roomKeyVersion]);

  useEffect(() => {
    if (!code || roomKeyVersion <= 2) return;
    deriveKey(code, roomKeyVersion)
      .then((k) => setKeys((prev) => ({ ...prev, [roomKeyVersion]: k })))
      .catch(() => {});
  }, [code, roomKeyVersion]);

  useEffect(() => {
    if (!code) return;
    localDB.joinedRooms.get(code).then((r) => {
      if (r?.tone) setTone(r.tone);
    }).catch(() => {});
  }, [code]);

  useEffect(() => {
    if (searchParams.get('reply') === '1') {
      inputRef.current?.focus();
    }
  }, [searchParams]);

  useEffect(() => {
    if (!code || !user) return;
    setRoomReady(false);
    const unsub = onSnapshot(doc(db, 'rooms', code), async (snap) => {
      if (!snap.exists()) {

        await setDoc(doc(db, 'rooms', code), { name: `Room ${code}`, createdAt: serverTimestamp(), createdBy: user.uid });
        await setDoc(doc(db, 'rooms', code, 'members', user.uid), { joinedAt: serverTimestamp(), name: user.name });
        setRoomName(`Room ${code}`);
        setRoomOwnerUid(user.uid);
      } else {
        const data = snap.data();
        const name = data.name || `Room ${code}`;
        setRoomName(name);
        setRoomOwnerUid(data.createdBy || null);
        setRoomSettings({
          slowModeSec: data.slowModeSec || 0,
          blockedWords: data.blockedWords || [],
          blurWords: data.blurWords || [],
          effectWords: data.effectWords || [],
          frozen: data.frozen === true,
          keyVersion: typeof data.keyVersion === 'number' ? data.keyVersion : 0,
          autoDelete: data.autoDelete === true,
          lastActivityAt: data.lastActivityAt?.toMillis?.() ?? null,
          createdAt: data.createdAt?.toMillis?.() ?? Date.now(),
        });
        if (typeof data.keyVersion === 'number' && data.keyVersion > roomKeyVersion) {
          setRoomKeyVersion(data.keyVersion);
        }
        // Auto-delete: remove room 1h after last activity
        if (data.autoDelete === true) {
          const lastActivity = data.lastActivityAt?.toMillis?.() ?? 0;
          if (lastActivity > 0 && Date.now() - lastActivity > 3600000) {
            deleteRoomData(code).then(() => {
              localDB.joinedRooms.delete(code);
              useStore.getState().removeJoinedRoom(code);
              navigate('/');
            }).catch(() => {});
          }
        }
        // Update local JoinedRoom name if needed
        const local = await localDB.joinedRooms.get(code);
        if (local && (!local.name || local.name !== data.name)) {
          await localDB.joinedRooms.put({ ...local, name });
          useStore.getState().setJoinedRooms(
            useStore.getState().joinedRooms.map((r) => r.code === code ? { ...r, name } : r)
          );
        }

      }
      setRoomReady(true);
    });
    return unsub;
  }, [code, user, roomKeyVersion]);

  useEffect(() => {
    if (!code) return;
    const q = query(collection(db, 'rooms', code, 'members'));
    const unsub = onSnapshot(q, (snap) => {
      const map: Record<string, string> = {};
      const list: { uid: string; name: string; online: boolean; lastSeen: number; lastSpokeAt: number | null; avatarEmoji?: string; avatarColor?: string }[] = [];
      let onlineCount = 0;
      let count = 0;
      const now = Date.now();
      snap.forEach((d) => {
        const data = d.data();
        if (data.name && !data.kicked) {
          // Stale cutoff (3 min) covers browser timer throttling in background
          // tabs (~60s) plus a margin, while still clearing crash-stuck users.
          const lastSeen = data.lastSeen?.toMillis?.() ?? 0;
          const stale = now - lastSeen > 180000;
          const isOnline = data.online === true && !stale;
          map[data.name.toLowerCase()] = d.id;
          list.push({
            name: data.name,
            uid: d.id,
            online: isOnline,
            lastSeen,
            lastSpokeAt: data.lastSpokeAt?.toMillis?.() ?? null,
            avatarEmoji: data.avatarEmoji || undefined,
            avatarColor: data.avatarColor || undefined,
          });
          if (isOnline) onlineCount++;
          count++;
        }
      });
      setMemberCount(count);
      setMemberNameMap(map);
      setMemberList(list);
      setOnlineCount(onlineCount);

      // System feed: joins and removals (merged to avoid duplicate listener)
      if (user) {
        snap.docChanges().forEach((change) => {
          const uid = change.doc.id;
          if (uid === user.uid) return;
          const data = change.doc.data();
          if (change.type === 'added' && data?.name && !data?.kicked) {
            postSystemMessage(code, 'join', uid, data?.name || 'Someone');
          } else if (change.type === 'modified' && data?.kicked === true) {
            postSystemMessage(code, 'remove', uid, data?.name || 'Someone');
          }
        });
      }
    });
    return unsub;
  }, [code, user]);

  useEffect(() => {
    if (!code || !user) return;
    const unsub = onSnapshot(doc(db, 'rooms', code, 'members', user.uid), (snap) => {
      if (snap.exists() && snap.data()?.kicked === true) {
        setKicked(true);
      }
    });
    return unsub;
  }, [code, user]);

  useEffect(() => {
    if (!code) return;
    const q = query(collection(db, 'rooms', code, 'typing'));
    const unsub = onSnapshot(q, (snap) => {
      const users: TypingUser[] = [];
      const now = Date.now();
      snap.forEach((d) => {
        if (d.id !== user?.uid) {
          const data = d.data();
          const ts = data.timestamp?.toMillis() ?? now;
          if (now - ts < 3000) {
            users.push({ uid: d.id, name: data.name, timestamp: ts });
          }
        }
      });
      setTypingUsers(users);
    });
    return unsub;
  }, [code, user?.uid]);

  // Presence heartbeat
  useEffect(() => {
    if (!code || !user || kicked) return;
    const memberRef = doc(db, 'rooms', code, 'members', user.uid);

    const setOnline = () => {
      setDoc(
        memberRef,
        {
          online: true,
          name: user.name,
          lastSeen: serverTimestamp(),
          avatarEmoji: user.avatarEmoji || '',
          avatarColor: user.avatarColor || '',
        },
        { merge: true }
      ).catch(() => {});
    };

    const setOffline = () => {
      updateDoc(memberRef, { online: false }).catch(() => {});
    };

    setOnline();

    const interval = setInterval(setOnline, 30000);

    window.addEventListener('beforeunload', setOffline);

    return () => {
      clearInterval(interval);
      window.removeEventListener('beforeunload', setOffline);
      setOffline();
    };
  }, [code, user, kicked]);

  useEffect(() => {
    if (!code || !cryptoKey || !roomReady) return;
    setLoading(true);
    initialSnapshotDone.current = false;

    const q = query(
      collection(db, 'rooms', code, 'messages'),
      orderBy('seq', 'desc'),
      limit(PAGE_SIZE)
    );

    const unsub = onSnapshot(
      q,
      async (snap) => {
        // Capture before it's flipped below: only the very first snapshot
        // (when the room is first opened) should count as "read".
        const isInitialLoad = !initialSnapshotDone.current;
        const docs = snap.docs;
        const isHidden = document.hidden;
        const now = Date.now();

        // Burn-on-read: schedule deletion of burn messages
        for (const change of snap.docChanges()) {
          if (change.type !== 'added') continue;
          const d = change.doc.data();
          if (d.burn && d.timestamp?.toMillis && !burnScheduledRef.current.has(change.doc.id)) {
            burnScheduledRef.current.add(change.doc.id);
            const delay = Math.max(500, d.timestamp.toMillis() + BURN_TTL - now);
            const timer = setTimeout(() => {
              burnScheduledRef.current.delete(change.doc.id);
              burnTimersRef.current.delete(change.doc.id);
              deleteDoc(doc(db, 'rooms', code, 'messages', change.doc.id)).catch(() => {});
            }, delay);
            burnTimersRef.current.set(change.doc.id, timer);
          }
        }

        // Forward new messages from others to SW when page is backgrounded
        if (isHidden && userRef.current) {
          snap.docChanges().forEach((change) => {
            if (change.type !== 'added') return;
            const id = change.doc.id;
            if (seenMsgIds.current.has(id)) return;
            seenMsgIds.current.add(id);
            const d = change.doc.data();
            if (d.senderUid !== userRef.current?.uid) {
              swSend({
                type: 'SHOW_NOTIFICATION',
                roomCode: code,
                senderName: d.senderName,
                replyToUid: d.replyToUid || null,
                mentionedUids: d.mentionedUids || [],
              });
            }
          });
        } else {
          docs.forEach((d) => seenMsgIds.current.add(d.id));
        }

        // Keep pagination state in sync
        lastDocRef.current = docs[docs.length - 1] || null;
        setHasMore(docs.length === PAGE_SIZE);

        if (!initialSnapshotDone.current) {
          initialSnapshotDone.current = true;
          if (docs.length === 0) {
            setMessages([]);
            setLoading(false);
            return;
          }
          const maxSeq = docs.reduce((m, d) => Math.max(m, d.data().seq || 0), 0);
          lastReadSeqRef.current = maxSeq;
          const decrypted = await Promise.all(
            docs.map(async (d) => decryptMessage(d.data(), d.id, keys))
          );
          setMessages(decrypted.reverse());
          setLoading(false);
        } else {
          // Subsequent snapshots: merge changes, then re-sort by seq
          const changes = snap.docChanges().filter(c => c.type === 'added' || c.type === 'modified');
          if (changes.length === 0) return;

          // Sound + haptics for new incoming messages (foreground only)
          if (!isHidden && userRef.current && toneRef.current !== 'none') {
            const hasIncoming = changes.some(
              (c) => c.type === 'added' && c.doc.data().senderUid !== userRef.current?.uid && !c.doc.data().burn
            );
            if (hasIncoming) {
              playIncomingFeedback(toneRef.current);
            }
          }

          // Read receipts: mark new incoming messages as read
          if (userRef.current) {
            for (const c of changes) {
              if (c.type !== 'added') continue;
              const d = c.doc.data();
              if (d.senderUid === userRef.current.uid) continue;
              const seq = d.seq || 0;
              if (!d.burn) {
                updateDoc(doc(db, 'rooms', code, 'messages', c.doc.id), {
                  readers: arrayUnion(userRef.current.uid),
                }).catch(() => {});
              }
              if (seq > lastReadSeqRef.current) lastReadSeqRef.current = seq;

              // Mention / reply notifications (in-app)
              if (d.mentionedUids?.includes(userRef.current.uid)) {
                showToast(`@${d.senderName || 'Someone'} mentioned you`);
                playIncomingFeedback(toneRef.current);
              } else if (d.replyToUid === userRef.current.uid) {
                showToast(`${d.senderName || 'Someone'} replied to you`);
                playIncomingFeedback(toneRef.current);
              }
            }
          }

          const updatedMsgs = await Promise.all(
            changes.map(c => decryptMessage(c.doc.data(), c.doc.id, keys))
          );
          setMessages((prev) => {
            const merged = [...prev];
            for (const msg of updatedMsgs) {
              const idx = merged.findIndex((m) => m.id === msg.id);
              if (idx >= 0) merged[idx] = msg;
              else merged.push(msg);
            }
            merged.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
            return merged;
          });
        }
        // Mark room as read (updates unread badges on dashboard).
        // On the initial load, and whenever the room is actively visible in the
        // foreground. Never while the tab is hidden — otherwise incoming
        // messages would reset lastReadTimestamp and the unread badge
        // would never appear.
        if (userRef.current && (isInitialLoad || !document.hidden)) {
          const now = Date.now();
          localDB.joinedRooms.get(code).then((local) => {
            localDB.joinedRooms.put({
              ...(local || { code, name: roomNameRef.current, joinedAt: now, lastReadTimestamp: null }),
              lastReadTimestamp: now,
            });
            useStore.getState().setJoinedRooms(
              useStore.getState().joinedRooms.map((r) => r.code === code ? { ...r, lastReadTimestamp: now } : r)
            );
          }).catch(() => {});
        }
      },
      () => setLoading(false)
    );

    return unsub;
  }, [code, cryptoKey, roomReady, setMessages, keys]);

  useEffect(() => {
    return () => {
      for (const t of burnTimersRef.current.values()) clearTimeout(t);
      burnTimersRef.current.clear();
      burnScheduledRef.current.clear();
    };
  }, [code]);

  useEffect(() => {
    if (loading || loadingOlder) return;
    if (scrollAnchorRef.current) {
      const el = messagesRef.current;
      if (el) {
        const newHeight = el.scrollHeight;
        const diff = newHeight - scrollAnchorRef.current.scrollHeight;
        el.scrollTop = scrollAnchorRef.current.scrollTop + diff;
      }
      scrollAnchorRef.current = null;
      return;
    }
    const el = messagesRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, loading, loadingOlder]);

  const loadOlder = useCallback(async () => {
    if (!code || !cryptoKey || !lastDocRef.current || !hasMore || loadingOlder) return;
    setLoadingOlder(true);
    const q = query(
      collection(db, 'rooms', code, 'messages'),
      orderBy('seq', 'desc'),
      startAfter(lastDocRef.current),
      limit(PAGE_SIZE)
    );
    const snap = await getDocs(q);
    const docs = snap.docs;
    lastDocRef.current = docs[docs.length - 1] || null;
    setHasMore(docs.length === PAGE_SIZE);

    const older = await Promise.all(
      docs.map((d) => decryptMessage(d.data(), d.id, keys))
    );

    const el = messagesRef.current;
    if (el) scrollAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    setMessages((prev) => [...older.reverse(), ...prev]);
    setLoadingOlder(false);
  }, [code, cryptoKey, hasMore, loadingOlder, setMessages, keys]);

  const updateTypingStatus = useCallback(
    (text: string) => {
      if (!code || !user) return;
      const typingRef = doc(db, 'rooms', code, 'typing', user.uid);

      if (text.trim().length > 0) {
        setDoc(typingRef, { name: user.name, timestamp: serverTimestamp() });
        if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
        typingTimerRef.current = setTimeout(() => {
          deleteDoc(typingRef);
        }, TYPING_TIMEOUT);
      } else {
        deleteDoc(typingRef);
        if (typingTimerRef.current) {
          clearTimeout(typingTimerRef.current);
          typingTimerRef.current = null;
        }
      }
    },
    [code, user]
  );

  useEffect(() => {
    return () => {
      if (code && user) {
        deleteDoc(doc(db, 'rooms', code, 'typing', user.uid));
      }
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [code, user]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    const cursor = e.target.selectionStart ?? val.length;
    setInput(val);
    updateTypingStatus(val);

    // Detect @mention
    const textBeforeCursor = val.slice(0, cursor);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');
    if (lastAtIndex !== -1) {
      const afterAt = textBeforeCursor.slice(lastAtIndex + 1);
      if (!/\s/.test(afterAt)) {
        setMentionQuery(afterAt);
        setMentionStartIndex(lastAtIndex);
        setMentionSelectedIndex(0);
        return;
      }
    }
    setMentionQuery('');
    setMentionStartIndex(-1);
  };

  const startEditRoomName = () => {
    setRoomNameInput(roomName);
    setEditingRoomName(true);
    setTimeout(() => roomNameInputRef.current?.focus(), 50);
  };

  const saveRoomName = async () => {
    if (!code) return;
    const trimmed = roomNameInput.trim();
    if (!trimmed || trimmed === roomName) {
      setEditingRoomName(false);
      return;
    }
    try {
      await updateDoc(doc(db, 'rooms', code), { name: trimmed });
      setRoomName(trimmed);
      const local = await localDB.joinedRooms.get(code);
      if (local) {
        await localDB.joinedRooms.put({ ...local, name: trimmed });
        useStore.getState().setJoinedRooms(
          useStore.getState().joinedRooms.map((r) => r.code === code ? { ...r, name: trimmed } : r)
        );
      }
    } catch {}
    setEditingRoomName(false);
  };

  const selectMention = (name: string) => {
    if (mentionStartIndex === -1) return;
    const before = input.slice(0, mentionStartIndex);
    const cursor = inputRef.current?.selectionStart ?? input.length;
    const after = input.slice(cursor);
    const newVal = before + '@' + name + ' ' + after;
    setInput(newVal);
    setMentionQuery('');
    setMentionStartIndex(-1);
    inputRef.current?.focus();
  };

  const handleReply = (msg: DecryptedMessage) => {
    setEditingId(null);
    setReplyTo({
      messageId: msg.id,
      senderName: msg.senderName,
      senderUid: msg.senderUid,
      text: msg.text.slice(0, 80),
      threadRootId: msg.threadRootId || msg.id,
    });
    inputRef.current?.focus();
  };

  const cancelReply = () => { setReplyTo(null); setMentionQuery(''); setMentionStartIndex(-1); };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || !code || !cryptoKey || !user || sending) return;

    if (roomSettings?.frozen && user.uid !== roomOwnerUid) {
      showToast('Room is frozen by the owner');
      return;
    }
    const lower = text.toLowerCase();
    const blocked = (roomSettings?.blockedWords || []).find((w) => w && lower.includes(w.toLowerCase()));
    if (blocked) {
      showToast(`Message blocked (filtered word: "${blocked}")`);
      return;
    }
    if (roomSettings?.slowModeSec && roomSettings.slowModeSec > 0 && myLastMsgTimeRef.current) {
      const wait = roomSettings.slowModeSec - (Date.now() - myLastMsgTimeRef.current) / 1000;
      if (wait > 0) {
        showToast(`Slow mode: wait ${Math.ceil(wait)}s`);
        return;
      }
    }

    setSending(true);
    setInput('');

    const payload: any = { text, type: 'text' };
    const msgData: any = {
      senderUid: user.uid,
      senderName: user.name,
      timestamp: serverTimestamp(),
      seq: Date.now(),
      kv: roomKeyVersion,
    };

    if (replyTo) {
      payload.replyTo = { messageId: replyTo.messageId, senderName: replyTo.senderName, text: replyTo.text };
      payload.threadRootId = replyTo.threadRootId || replyTo.messageId;
      msgData.replyToUid = replyTo.senderUid;
    }

    if (editingId) {
      const orig = messages.find((m) => m.id === editingId);
      if (orig?.threadRootId) payload.threadRootId = orig.threadRootId;
      if (orig?.replyTo) {
        payload.replyTo = { messageId: orig.replyTo.messageId, senderName: orig.replyTo.senderName, text: orig.replyTo.text };
      }
    }

    const mentionedUids = parseMentions(text, memberNameMap);
    if (mentionedUids.length > 0) {
      msgData.mentionedUids = mentionedUids;
    }

    if (burnEnabled) {
      msgData.burn = true;
    }

    try {
      const { ciphertext, iv } = await encrypt(JSON.stringify(payload), cryptoKey);
      msgData.ciphertext = ciphertext;
      msgData.iv = iv;

      if (editingId) {
        msgData.edited = true;
        try {
          const snap = await getDoc(doc(db, 'rooms', code, 'messages', editingId));
          const prevHistory = snap.data()?.editHistory || [];
          const orig2 = messages.find((m) => m.id === editingId);
          const prevText = orig2?.text || '';
          msgData.editHistory = [...prevHistory, { text: prevText, editedAt: Date.now() }];
        } catch {}
        await updateDoc(doc(db, 'rooms', code, 'messages', editingId), msgData);
        setEditingId(null);
      } else {
        await addDoc(collection(db, 'rooms', code, 'messages'), msgData);
      }

      myLastMsgTimeRef.current = Date.now();
      // Activity tracking for auto-delete + lurker detection
      updateDoc(doc(db, 'rooms', code), { lastActivityAt: serverTimestamp() }).catch(() => {});
      updateDoc(doc(db, 'rooms', code, 'members', user.uid), { lastSpokeAt: serverTimestamp() }).catch(() => {});

      setReplyTo(null);
      setMentionQuery('');
      setMentionStartIndex(-1);
      updateTypingStatus('');
    } catch {
      setInput(text);
    }
    setSending(false);
  };

  const sendPoll = async () => {
    if (!code || !user) return;
    const options = pollOptions.map((o) => o.trim()).filter(Boolean).slice(0, 6);
    const question = pollQuestion.trim();
    if (options.length < 2) {
      showToast('A poll needs at least 2 options');
      return;
    }
    if (!question) {
      showToast('Add a question for the poll');
      return;
    }
    if (roomSettings?.frozen && user.uid !== roomOwnerUid) {
      showToast('Room is frozen by the owner');
      return;
    }
    try {
      await addDoc(collection(db, 'rooms', code, 'messages'), {
        senderUid: user.uid,
        senderName: user.name,
        timestamp: serverTimestamp(),
        seq: Date.now(),
        poll: {
          question,
          multiple: false,
          options: options.map((text) => ({ text, voters: [] })),
        },
      });
      updateDoc(doc(db, 'rooms', code), { lastActivityAt: serverTimestamp() }).catch(() => {});
      updateDoc(doc(db, 'rooms', code, 'members', user.uid), { lastSpokeAt: serverTimestamp() }).catch(() => {});
      setShowPollForm(false);
      setPollQuestion('');
      setPollOptions(['', '']);
    } catch {
      showToast('Failed to create poll');
    }
  };

  const votePoll = async (msgId: string, optionIndex: number) => {
    if (!code || !user) return;
    const msg = messages.find((m) => m.id === msgId);
    if (!msg?.poll) return;
    const options = msg.poll.options.map((o) => ({ text: o.text, voters: [...o.voters] }));
    const voters = options[optionIndex].voters;
    const i = voters.indexOf(user.uid);
    if (i >= 0) voters.splice(i, 1);
    else voters.push(user.uid);
    try {
      await updateDoc(doc(db, 'rooms', code, 'messages', msgId), {
        poll: { question: msg.poll.question, multiple: msg.poll.multiple, options },
      });
    } catch {}
  };

  const saveSettings = async (patch: Partial<RoomSettings>) => {
    if (!code) return;
    const next = { ...(roomSettings || {}), ...patch };
    try {
      await updateDoc(doc(db, 'rooms', code), {
        slowModeSec: next.slowModeSec || 0,
        blockedWords: next.blockedWords || [],
        blurWords: next.blurWords || [],
        effectWords: next.effectWords || [],
        frozen: next.frozen === true,
        keyVersion: next.keyVersion ?? 0,
      });
      setRoomSettings(next as RoomSettings);
      showToast('Room settings saved');
    } catch {
      showToast('Failed to save settings');
    }
  };

  const rotateKey = async () => {
    if (!code) return;
    const next = (roomSettings?.keyVersion ?? 0) + 1;
    try {
      await updateDoc(doc(db, 'rooms', code), { keyVersion: next });
      setRoomKeyVersion((v) => (next > v ? next : v));
      showToast('Encryption key rotated');
    } catch {
      showToast('Failed to rotate key');
    }
  };

  const createInvite = async () => {
    if (!code || !user) return;
    try {
      const token = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      await setDoc(doc(db, 'rooms', code, 'invites', token), {
        expiresAt: Timestamp.fromDate(new Date(Date.now() + 24 * 3600 * 1000)),
        uses: 0,
        maxUses: 1,
        createdBy: user.uid,
        createdAt: serverTimestamp(),
      });
      const link = `${window.location.origin}/?code=${code}&invite=${token}`;
      setInviteLink(link);
      try {
        await navigator.clipboard.writeText(link);
        showToast('Invite link copied!');
      } catch {
        showToast('Invite link created');
      }
    } catch {
      showToast('Failed to create invite');
    }
  };

  const setToneAndSave = async (t: 'pop' | 'ding' | 'soft' | 'none') => {
    setTone(t);
    if (!code) return;
    const local = await localDB.joinedRooms.get(code);
    await localDB.joinedRooms.put({ ...(local || { code, name: roomName, joinedAt: Date.now(), lastReadTimestamp: null }), tone: t });
    useStore.getState().setJoinedRooms(
      useStore.getState().joinedRooms.map((r) => r.code === code ? { ...r, tone: t } : r)
    );
    if (t !== 'none') playTone(t);
  };

  // Index decrypted messages locally (IndexedDB) for instant chat search
  useEffect(() => {
    if (!code || messages.length === 0) return;
    const entries = messages
      .filter((m) => m.text && m.type !== 'image' && m.type !== 'file')
      .map((m) => ({
        msgId: m.id,
        roomCode: code,
        text: m.text,
        senderName: m.senderName,
        senderUid: m.senderUid,
        timestamp: m.timestamp,
        seq: m.seq ?? 0,
      }));
    if (entries.length === 0) return;
    entries.forEach((e) => indexedIdsRef.current.add(e.msgId));
    localDB.searchIndex.bulkPut(entries).catch(() => {});
  }, [messages, code]);

  const scrollToMessage = (targetId: string) => {
    const el = msgElRefs.current[targetId];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightMsgId(targetId);
      setTimeout(() => setHighlightMsgId((h) => (h === targetId ? null : h)), 1800);
    } else {
      showToast('That message is in older history and not loaded');
    }
  };

  const jumpToThread = (rootId: string) => {
    const replies = messages.filter((m) => m.threadRootId === rootId);
    if (replies.length === 0) return;
    scrollToMessage(replies[replies.length - 1].id);
  };

  const loadScheduled = useCallback(async () => {
    if (!code) return;
    try {
      const list = await localDB.scheduled.where('roomCode').equals(code).sortBy('sendAtMs');
      setScheduledMsgs(list);
    } catch {}
  }, [code]);

  useEffect(() => {
    loadScheduled();
    const t = setInterval(async () => {
      if (!code) return;
      const list = await localDB.scheduled.where('roomCode').equals(code).toArray();
      for (const s of list) {
        try {
          const snap = await getDoc(doc(db, 'scheduled', s.id));
          if (!snap.exists()) {
            await localDB.scheduled.delete(s.id);
            setScheduledMsgs((prev) => prev.filter((x) => x.id !== s.id));
            showToast('Scheduled message sent');
          }
        } catch {}
      }
    }, 15000);
    return () => clearInterval(t);
  }, [code, loadScheduled]);

  const scheduleMessage = async (sendAtMs: number) => {
    const text = input.trim();
    if (!text || !code || !cryptoKey || !user) {
      showToast('Nothing to schedule');
      return;
    }
    if (sendAtMs <= Date.now()) {
      showToast('Pick a time in the future');
      return;
    }
    if (roomSettings?.frozen && user.uid !== roomOwnerUid) {
      showToast('Room is frozen by the owner');
      return;
    }
    const lower = text.toLowerCase();
    const blocked = (roomSettings?.blockedWords || []).find((w) => w && lower.includes(w.toLowerCase()));
    if (blocked) {
      showToast(`Message blocked (filtered word: "${blocked}")`);
      return;
    }
    const payload: any = { text, type: 'text' };
    if (replyTo) {
      payload.replyTo = { messageId: replyTo.messageId, senderName: replyTo.senderName, text: replyTo.text };
      payload.threadRootId = replyTo.threadRootId || replyTo.messageId;
    }
    try {
      const { ciphertext, iv } = await encrypt(JSON.stringify(payload), cryptoKey);
      const msgData: any = {
        roomCode: code,
        senderUid: user.uid,
        senderName: user.name,
        ciphertext,
        iv,
        kv: roomKeyVersion,
        sendAtMs,
      };
      const mentionedUids = parseMentions(text, memberNameMap);
      if (mentionedUids.length > 0) msgData.mentionedUids = mentionedUids;
      if (burnEnabled) msgData.burn = true;
      if (replyTo) msgData.replyToUid = replyTo.senderUid;
      const ref = await addDoc(collection(db, 'scheduled'), msgData);
      await localDB.scheduled.put({ id: ref.id, roomCode: code, sendAtMs, textPreview: text.slice(0, 60) });
      setInput('');
      setReplyTo(null);
      setEditingId(null);
      setShowSchedule(false);
      showToast(`Scheduled for ${new Date(sendAtMs).toLocaleString()}`);
      loadScheduled();
    } catch {
      showToast('Failed to schedule message');
    }
  };

  const cancelScheduled = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'scheduled', id));
      await localDB.scheduled.delete(id);
      setScheduledMsgs((prev) => prev.filter((x) => x.id !== id));
      showToast('Scheduled message cancelled');
    } catch {
      showToast('Failed to cancel');
    }
  };

  const fetchAllMessages = async () => {
    if (!code) return [] as any[];
    const out: any[] = [];
    let last: any = null;
    for (let i = 0; i < 20; i++) {
      const q = last
        ? query(collection(db, 'rooms', code, 'messages'), orderBy('seq', 'desc'), startAfter(last), limit(500))
        : query(collection(db, 'rooms', code, 'messages'), orderBy('seq', 'desc'), limit(500));
      const snap = await getDocs(q);
      if (snap.empty) break;
      out.push(...snap.docs);
      last = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < 500) break;
    }
    return out;
  };

  const exportChat = async (format: 'json' | 'txt' | 'pdf') => {
    if (format === 'pdf') { await exportPDF(); return; }
    if (!code || exporting) return;
    setExporting(true);
    try {
      const docs = await fetchAllMessages();
      const rows: { time: string; sender: string; message: string }[] = [];
      for (const d of docs) {
        const data = d.data();
        let text = '';
        if (data.sys) {
          text = data.sys.type === 'join' ? `🟢 ${data.sys.name} joined` : `🚫 ${data.sys.name} removed`;
        } else if (data.poll) {
          text = `📊 ${data.poll.question}`;
        } else {
          const key = keys[data.kv ?? 0];
          if (key) {
            try {
              const dec = await decrypt(data.ciphertext, data.iv, key);
              const parsed = JSON.parse(dec);
              text = parsed.type === 'image' ? '[Image]' : parsed.type === 'file' ? `[File: ${parsed.file?.name || 'file'}]` : (parsed.text || dec);
            } catch {
              text = '[Cannot decrypt]';
            }
          } else {
            text = '[Encrypted]';
          }
        }
        rows.push({
          time: new Date(data.timestamp?.toMillis?.() ?? Date.now()).toLocaleString(),
          sender: data.senderName || data.sys?.name || '',
          message: text,
        });
      }
      rows.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `chatrix-${code}-${stamp}`;
      if (format === 'json') {
        downloadBlob(JSON.stringify({ room: code, exportedAt: new Date().toISOString(), messages: rows }, null, 2), `${filename}.json`, 'application/json');
      } else {
        downloadBlob(rows.map((r) => `[${r.time}] ${r.sender}: ${r.message}`).join('\n'), `${filename}.txt`, 'text/plain');
      }
      showToast(`Exported ${rows.length} message${rows.length !== 1 ? 's' : ''}`);
    } catch {
      showToast('Export failed');
    }
    setExporting(false);
  };

  const exportPDF = async () => {
    if (!code || exporting) return;
    setExporting(true);
    try {
      const docs = await fetchAllMessages();
      const rows: { time: string; sender: string; message: string }[] = [];
      for (const d of docs) {
        const data = d.data();
        let text = '';
        if (data.sys) text = data.sys.type === 'join' ? `🟢 ${data.sys.name} joined` : `🚫 ${data.sys.name} removed`;
        else if (data.poll) text = `📊 ${data.poll.question}`;
        else {
          const key = keys[data.kv ?? 0];
          if (key) {
            try { const dec = await decrypt(data.ciphertext, data.iv, key); const parsed = JSON.parse(dec); text = parsed.type === 'image' ? '[Image]' : parsed.type === 'file' ? `[File: ${parsed.file?.name || 'file'}]` : (parsed.text || dec); } catch { text = '[Cannot decrypt]'; }
          } else text = '[Encrypted]';
        }
        rows.push({ time: new Date(data.timestamp?.toMillis?.() ?? Date.now()).toLocaleString(), sender: data.senderName || data.sys?.name || '', message: text });
      }
      const html = `<html><head><title>Chat ${code}</title><style>body{font-family:system-ui;padding:20px;background:#fff;color:#000}h1{font-size:18px;border-bottom:1px solid #ccc;padding-bottom:10px} .msg{margin:10px 0;padding:8px;border-bottom:1px solid #eee} .meta{color:#666;font-size:12px} .text{margin-top:4px}</style></head><body><h1>Chat ${code} - ${roomName} (${rows.length} messages)</h1><div>${rows.map((r) => `<div class=msg><div class=meta>${r.sender} · ${r.time}</div><div class=text>${r.message.replace(/</g,'&lt;')}</div></div>`).join('')}</div><script>window.print()<\/script></body></html>`;
      const w = window.open('', '_blank');
      if (w) { w.document.write(html); w.document.close(); }
      showToast(`PDF ready — ${rows.length} messages`);
    } catch { showToast('PDF export failed'); }
    setExporting(false);
  };

  const handleEdit = (msg: DecryptedMessage) => {
    setEditingId(msg.id);
    setInput(msg.text);
    setReplyTo(null);
    inputRef.current?.focus();
  };

  const cancelEdit = () => {
    setEditingId(null);
    setInput('');
    setMentionQuery('');
    setMentionStartIndex(-1);
    inputRef.current?.focus();
  };

  const deleteMessage = async (msgId: string) => {
    if (!code || !user) return;
    try {
      await updateDoc(doc(db, 'rooms', code, 'messages', msgId), { deleted: true });
    } catch {}
    setMenuMsgId(null);
  };

  const removeMember = useCallback(async (uid: string) => {
    if (!code || !user || user.uid !== roomOwnerUid) return;
    try {
      await updateDoc(doc(db, 'rooms', code, 'members', uid), {
        kicked: true,
        kickedAt: serverTimestamp(),
      });
      await deleteDoc(doc(db, 'rooms', code, 'typing', uid)).catch(() => {});
    } catch {}
  }, [code, user, roomOwnerUid]);

  const toggleReaction = async (msgId: string, emoji: string) => {
    if (!code || !user) return;
    const msgRef = doc(db, 'rooms', code, 'messages', msgId);
    try {
      const snap = await getDoc(msgRef);
      if (!snap.exists()) return;
      const data = snap.data();
      const reactions: Record<string, string[]> = data.reactions || {};
      const users = reactions[emoji] || [];
      if (users.includes(user.uid)) {
        reactions[emoji] = users.filter((u: string) => u !== user.uid);
        if (reactions[emoji].length === 0) delete reactions[emoji];
      } else {
        reactions[emoji] = [...users, user.uid];
      }
      await updateDoc(msgRef, { reactions });
    } catch {}
  };

  const insertEmoji = (emoji: string) => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? input.length;
    const end = el.selectionEnd ?? input.length;
    const newVal = input.slice(0, start) + emoji + input.slice(end);
    setInput(newVal);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const MAX_FILE_SIZE = 700_000; // ~700KB raw file max (fits in 1MB Firestore doc after base64)

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !code || !cryptoKey || !user || sending) return;
    setSending(true);

    try {
      let dataUrl = await fileToDataUrl(file);
      if (dataUrl.length > MAX_FILE_SIZE) {
        if (file.type.startsWith('image/')) {
          dataUrl = await compressImage(dataUrl, dataSaver ? 400 : 800);
        }
        if (dataUrl.length > MAX_FILE_SIZE) {
          alert(`File too large. Maximum size is ~${Math.round(MAX_FILE_SIZE / 1000)}KB.`);
          setSending(false);
          if (e.target) e.target.value = '';
          return;
        }
      }
      const isImage = file.type.startsWith('image/');
      const payload: any = { text: dataUrl, type: isImage ? 'image' : 'file' };
      if (!isImage) {
        payload.file = { name: file.name, size: file.size, mimeType: file.type };
      }
      if (viewOnce && isImage) {
        payload.viewOnce = true;
        payload.viewedBy = [];
      }
      if (replyTo) {
        payload.replyTo = { messageId: replyTo.messageId, senderName: replyTo.senderName, text: replyTo.text };
        payload.threadRootId = replyTo.threadRootId || replyTo.messageId;
      }
      const { ciphertext, iv } = await encrypt(JSON.stringify(payload), cryptoKey);
      const msgData: any = {
        senderUid: user.uid,
        senderName: user.name,
        ciphertext,
        iv,
        timestamp: serverTimestamp(),
        seq: Date.now(),
        kv: roomKeyVersion,
      };
      if (replyTo) msgData.replyToUid = replyTo.senderUid;
      await addDoc(collection(db, 'rooms', code, 'messages'), msgData);
      updateDoc(doc(db, 'rooms', code), { lastActivityAt: serverTimestamp() }).catch(() => {});
      updateDoc(doc(db, 'rooms', code, 'members', user.uid), { lastSpokeAt: serverTimestamp() }).catch(() => {});
    } catch {}
    setSending(false);
    setViewOnce(false);
    if (e.target) e.target.value = '';
  };

  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  const formatMessageTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = dayKey(d) === dayKey(now);
    if (sameDay) return formatTime(ts);
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    }) + ' · ' + formatTime(ts);
  };

  const typingText = typingUsers.length === 0
    ? ''
    : typingUsers.length === 1
      ? `${typingUsers[0].name} is typing...`
      : typingUsers.length === 2
        ? `${typingUsers[0].name} and ${typingUsers[1].name} are typing...`
        : `${typingUsers[0].name} and ${typingUsers.length - 1} others are typing...`;

  const replyCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const m of messages) {
      if (m.threadRootId) map[m.threadRootId] = (map[m.threadRootId] ?? 0) + 1;
    }
    return map;
  }, [messages]);

  const visibleMessages = useMemo(() => messages.filter((m) => !mutedUids.includes(m.senderUid)), [messages, mutedUids]);

  const schedulePresets = useMemo(() => {
    const tonight = new Date();
    tonight.setHours(21, 0, 0, 0);
    if (tonight.getTime() <= Date.now()) tonight.setDate(tonight.getDate() + 1);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    return [
      { label: 'In 1 hour', ms: Date.now() + 3600_000 },
      { label: 'In 3 hours', ms: Date.now() + 3 * 3600_000 },
      { label: 'Tonight 9 PM', ms: tonight.getTime() },
      { label: 'Tomorrow 9 AM', ms: tomorrow.getTime() },
    ];
  }, []);

  return (
    <div className="flex flex-col h-dvh max-w-md md:max-w-lg lg:max-w-xl mx-auto" style={{ background: 'radial-gradient(ellipse at 50% 0%, #0a0a0f 0%, #000 70%)' }}>
      <header className="flex items-center gap-3 px-4 py-3 border-b border-[#222] shrink-0 bg-black/50 backdrop-blur-sm">
        <button onClick={() => navigate('/')} className="text-[#007AFF] font-medium text-sm shrink-0 hover:opacity-80 transition-opacity">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 inline-block -ml-1">
            <path fillRule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clipRule="evenodd" />
          </svg>
        </button>
        <div className="flex-1 text-center min-w-0">

          {editingRoomName ? (
            <input
              ref={roomNameInputRef}
              value={roomNameInput}
              onChange={(e) => setRoomNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveRoomName();
                if (e.key === 'Escape') setEditingRoomName(false);
              }}
              onBlur={saveRoomName}
              maxLength={30}
              className="bg-[#1C1C1E] text-white text-sm font-bold rounded-lg px-2 py-1 outline-none border border-[#333] w-full text-center"
            />
          ) : (
            <div className="flex items-center justify-center gap-1.5">
              <h1 className="text-sm font-bold truncate">
                {roomName || 'Chat'}
              </h1>
              <button
                onClick={startEditRoomName}
                className="text-[#444] hover:text-[#007AFF] transition-colors shrink-0 p-0.5 rounded"
                title="Edit room name"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">

                  <path d="m5.433 13.917 1.262-3.155A4 4 0 0 1 7.58 9.42l6.92-6.918a2.121 2.121 0 0 1 3 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 0 1-.65-.65Z" />
                  <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0 0 10 3H4.75A2.75 2.75 0 0 0 2 5.75v9.5A2.75 2.75 0 0 0 4.75 18h9.5A2.75 2.75 0 0 0 17 15.25V10a.75.75 0 0 0-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5Z" />
                </svg>
              </button>
            </div>
          )}
          {typingText ? (
            <p className="text-[10px] text-[#00FF88] truncate flex items-center justify-center gap-1.5 mt-0.5">
              <span className="flex gap-0.5">
                <span className="w-1 h-1 bg-[#00FF88] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1 h-1 bg-[#00FF88] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1 h-1 bg-[#00FF88] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
              {typingText}
            </p>
          ) : null}
          {memberCount !== null && (
            <button onClick={() => setShowMembers(true)} className="mx-auto mt-1 text-xs text-[#555] hover:text-[#007AFF] transition-colors flex items-center justify-center gap-2 bg-white/[0.03] px-3 py-1 rounded-full">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#00FF88] shadow-[0_0_4px_#00FF88]" />
                <span>{onlineCount}</span>
                <span className="text-[#555]">online</span>
              </span>
              <span className="text-[#333]">·</span>
              <span>{memberCount} <span className="text-[#555]">member{memberCount !== 1 ? 's' : ''}</span></span>
            </button>
          )}
        </div>

        <button
          onClick={voiceCall.joinCall}
          className={`p-2 rounded-lg transition-all shrink-0 ${
            voiceCall.inCall
              ? 'bg-[#00FF88]/20 text-[#00FF88]'
              : voiceCall.callState
                ? 'text-[#00FF88] hover:bg-[#00FF88]/10'
                : 'text-[#555] hover:text-white hover:bg-white/5'
          }`}
          title={voiceCall.inCall ? 'In call' : voiceCall.callState ? 'Join call' : 'Start voice call'}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
            <path d="M10 1a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
            <path d="M5 9a.75.75 0 0 1 .75.75 4.25 4.25 0 0 0 8.5 0A.75.75 0 0 1 15 9.75a5.75 5.75 0 0 1-5 5.698V17a.75.75 0 0 1-1.5 0v-1.552A5.75 5.75 0 0 1 4.25 9.75A.75.75 0 0 1 5 9Z" />
          </svg>
        </button>
        <button
          onClick={() => setShowSearch(true)}
          className="hidden sm:flex p-2 rounded-lg transition-all shrink-0 text-[#555] hover:text-white hover:bg-white/5"
          title="Search messages"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
            <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
          </svg>
        </button>
        <button
          onClick={() => setShowShare(true)}
          className="hidden sm:flex p-2 rounded-lg transition-all shrink-0 text-[#555] hover:text-white hover:bg-white/5"
          title="Share room"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
            <path d="M13 4.5a2.5 2.5 0 1 1 .702 1.737l-3.968 2.061a2.5 2.5 0 0 1 0 1.404l3.968 2.061a2.5 2.5 0 1 1-.702 1.737l-3.968-2.061a2.5 2.5 0 1 1-1.2-1.999V6.56a2.5 2.5 0 1 1 1.2-1.999l3.968 2.06A2.505 2.505 0 0 1 13 4.5Z" />
          </svg>
        </button>
        <button
          onClick={() => setShowSettings(true)}
          className="hidden sm:flex p-2 rounded-lg transition-all shrink-0 text-[#555] hover:text-white hover:bg-white/5"
          title="Room settings"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
            <path fillRule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.993 6.993 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clipRule="evenodd" />
          </svg>
        </button>
        <div className="relative sm:hidden">
          <button onClick={() => setShowHeaderMenu(!showHeaderMenu)} className="p-2 rounded-lg text-[#555] hover:text-white hover:bg-white/5">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path d="M10 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM10 11a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM10 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" /></svg>
          </button>
          {showHeaderMenu && (
            <div className="absolute right-0 top-full mt-1 w-40 bg-[#1C1C1E] border border-[#333] rounded-xl shadow-xl overflow-hidden z-20">
              <button onClick={() => { setShowHeaderMenu(false); setShowSearch(true); }} className="w-full text-left px-3 py-2 text-xs text-[#ccc] hover:bg-white/5">🔍 Search</button>
              <button onClick={() => { setShowHeaderMenu(false); setShowShare(true); }} className="w-full text-left px-3 py-2 text-xs text-[#ccc] hover:bg-white/5">🔗 Share</button>
              <button onClick={() => { setShowHeaderMenu(false); setShowSettings(true); }} className="w-full text-left px-3 py-2 text-xs text-[#ccc] hover:bg-white/5">⚙️ Settings</button>
            </div>
          )}
        </div>
      </header>

      {roomSettings?.frozen && (
        <div className="px-4 py-1.5 bg-[#FF3B30]/10 border-b border-[#FF3B30]/20 text-center text-[11px] text-[#FF6B61] font-medium shrink-0">
          {user?.uid === roomOwnerUid
            ? 'Room is frozen — members cannot send messages'
            : 'Room is frozen by the owner — you cannot send messages'}
        </div>
      )}

      <div ref={messagesRef} className={`flex-1 overflow-y-auto px-4 py-3 space-y-1 ${reducedMotion ? '' : 'scroll-smooth will-change-scroll'}`} style={{ fontSize: `${fontSize}px` }}>
        {loading && (
          <div className="flex justify-center py-12">
            <div className="w-5 h-5 border-2 border-[#333] border-t-[#007AFF] rounded-full animate-spin" />
          </div>
        )}

        {hasMore && !loading && (
          <div className="flex justify-center py-2">
            <button
              onClick={loadOlder}
              disabled={loadingOlder}
              className="px-4 py-1.5 rounded-full bg-[#1C1C1E] border border-[#333] text-xs font-medium text-[#ccc] hover:bg-[#252525] hover:text-white hover:border-[#555] transition-all disabled:opacity-40 flex items-center gap-1.5 shadow-lg"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M9.78 4.22a.75.75 0 0 1 0 1.06L5.56 9.5h8.69a.75.75 0 0 1 0 1.5H5.56l4.22 4.22a.75.75 0 1 1-1.06 1.06l-5.5-5.5a.75.75 0 0 1 0-1.06l5.5-5.5a.75.75 0 0 1 1.06 0Z" clipRule="evenodd" /></svg>
              {loadingOlder ? 'Loading...' : 'Load older messages'}
            </button>
          </div>
        )}

        {!loading && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-[#444] text-sm gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-10 h-10 opacity-50">
              <path d="M4.913 2.658c2.075-.27 4.19-.408 6.337-.408 2.147 0 4.262.139 6.337.408 1.922.25 3.291 1.861 3.405 3.727a4.403 4.403 0 0 0-1.032-.211 50.89 50.89 0 0 0-8.42 0c-2.358.196-4.04 2.19-4.04 4.434v4.286a4.47 4.47 0 0 0 2.433 3.984L7.28 21.53A.75.75 0 0 1 6 21v-4.03a48.527 48.527 0 0 1-1.087-.128C2.905 16.58 1.5 14.833 1.5 12.862V6.638c0-1.97 1.405-3.718 3.413-3.979Z" />
              <path d="M15.75 7.5c-1.376 0-2.739.057-4.086.169C10.124 7.797 9 9.103 9 10.609v4.285c0 1.507 1.128 2.814 2.67 2.94 1.243.102 2.5.157 3.768.165l2.782 2.781a.75.75 0 0 0 1.28-.53v-2.39l.33-.026c1.542-.125 2.67-1.433 2.67-2.94v-4.286c0-1.505-1.125-2.811-2.664-2.94A49.392 49.392 0 0 0 15.75 7.5Z" />
            </svg>
            <span>No messages yet</span>
            <span className="text-xs">Say something to start</span>
          </div>
        )}

        {visibleMessages.map((msg, i) => {
          const replyCount = replyCounts[msg.id] || 0;
          return (
          <div
            key={msg.id}
            ref={(el) => { msgElRefs.current[msg.id] = el; }}
            className={`rounded-xl transition-colors ${highlightMsgId === msg.id ? 'bg-[#FF9F0A]/10 px-1.5' : ''}`}
          >
            <Fragment>
            {(i === 0 || !isSameDay(visibleMessages[i - 1]?.timestamp ?? msg.timestamp, msg.timestamp)) && (
              <DateSeparator ts={msg.timestamp} />
            )}
            <MessageItem
              msg={msg}
              isOwn={msg.senderUid === user?.uid}
              menuOpen={menuMsgId === msg.id}
              reactingOpen={reactingMsgId === msg.id}
              userUid={user?.uid}
              formatTime={formatTime}
              formatMessageTime={formatMessageTime}
              onReply={handleReply}
              onEdit={handleEdit}
              onDelete={deleteMessage}
              onToggleReaction={toggleReaction}
              onVote={votePoll}
              onMenuOpen={setMenuMsgId}
              onReactingOpen={setReactingMsgId}
              resolveName={(uid) => memberList.find((m) => m.uid === uid)?.name || uid.slice(0, 6)}
              avatarFor={(uid) => {
                const m = memberList.find((x) => x.uid === uid);
                return m ? { emoji: m.avatarEmoji, color: m.avatarColor } : undefined;
              }}
              blurWords={roomSettings?.blurWords}
              hasEffect={Boolean(
                roomSettings?.effectWords?.some((w) => w && new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(msg.text.toLowerCase()))
              )}
              showLinkPreview={roomSettings?.linkPreviews !== false}
              onViewOnce={(msgId) => { if (code && user?.uid) updateDoc(doc(db, 'rooms', code, 'messages', msgId), { viewedBy: arrayUnion(user.uid) }).catch(()=>{}); }}
              prevSenderSame={i > 0 && messages[i - 1].senderUid === msg.senderUid}
              replyCount={replyCount}
              onJumpToMessage={scrollToMessage}
              onJumpToThread={jumpToThread}
            />
            </Fragment>
          </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {editingId && (
        <div className="px-4 py-2 bg-[#0D0D0D] border-t border-[#222] flex items-center gap-2 animate-fade-in">
          <div className="w-1 h-8 rounded-full bg-[#007AFF] shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-[11px] text-[#007AFF] font-medium">Editing message</span>
          </div>
          <button onClick={cancelEdit} className="text-[#555] hover:text-white p-1 rounded-lg hover:bg-white/5 transition-all shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>
      )}

      {replyTo && !editingId && (
        <div className="px-4 py-2 bg-[#0D0D0D] border-t border-[#222] flex items-center gap-2 animate-fade-in">
          <div className="w-1 h-8 rounded-full bg-[#00FF88] shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-[11px] text-[#00FF88] font-medium">@{replyTo.senderName}</span>
            <p className="text-[11px] text-[#555] truncate mt-0.5">{replyTo.text}</p>
          </div>
          <button onClick={cancelReply} className="text-[#555] hover:text-white p-1 rounded-lg hover:bg-white/5 transition-all shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </div>
      )}

      <div className="px-4 py-3 border-t border-[#222] shrink-0 relative bg-black/50 backdrop-blur-sm">
        {mentionStartIndex !== -1 && mentionQuery !== undefined && (
          <MentionDropdown
            query={mentionQuery}
            members={memberList}
            excludeUid={user?.uid}
            selectedIndex={mentionSelectedIndex}
            onSelect={selectMention}
            onIndexChange={setMentionSelectedIndex}
          />
        )}
        {showEmojiPicker && (
          <EmojiPicker
            onEmoji={insertEmoji}
            onClose={() => setShowEmojiPicker(false)}
          />
        )}
        {showSchedule && (
          <div className="mb-2 bg-[#1C1C1E] border border-[#333] rounded-2xl p-3 animate-fade-in">
            <p className="text-xs font-semibold text-white mb-2 flex items-center gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-[#FF9F0A]">
                <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-13a.75.75 0 0 0-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 0 0 0-1.5h-3.25V5Z" clipRule="evenodd" />
              </svg>
              Schedule message
              <button onClick={() => setShowSchedule(false)} className="ml-auto text-[#555] hover:text-white">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
              </button>
            </p>
            {input.trim() ? (
              <p className="text-[11px] text-[#555] truncate mb-2 bg-[#0D0D0D] rounded-lg px-3 py-1.5">
                “{input.trim().slice(0, 60)}”
              </p>
            ) : (
              <p className="text-[11px] text-[#FF9F0A] mb-2">Type a message first, then pick a time.</p>
            )}
            <div className="flex flex-wrap gap-1.5 mb-2">
              {schedulePresets.map((p) => (
                <button
                  key={p.label}
                  onClick={() => scheduleMessage(p.ms)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[#FF9F0A]/40 text-[#FF9F0A] bg-[#FF9F0A]/10 hover:bg-[#FF9F0A]/20 transition-all"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="datetime-local"
                value={scheduleTime}
                min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
                onChange={(e) => setScheduleTime(e.target.value)}
                className="flex-1 bg-[#0D0D0D] text-white text-xs rounded-lg px-3 py-2 outline-none border border-[#333] focus:border-[#555] [color-scheme:dark]"
              />
              <button
                onClick={() => {
                  if (!scheduleTime) return;
                  scheduleMessage(new Date(scheduleTime).getTime());
                }}
                className="px-3.5 py-2 rounded-lg bg-[#FF9F0A] text-black text-xs font-semibold hover:bg-[#FFB340] transition-colors shrink-0"
              >
                Schedule
              </button>
            </div>
            {scheduledMsgs.length > 0 && (
              <div className="mt-3 space-y-1">
                <p className="text-[10px] text-[#555] font-medium uppercase tracking-wider">Scheduled</p>
                {scheduledMsgs.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 bg-[#0D0D0D] border border-[#222] rounded-lg px-3 py-1.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] text-[#ccc] truncate">{s.textPreview}</p>
                      <p className="text-[10px] text-[#555]">{new Date(s.sendAtMs).toLocaleString()}</p>
                    </div>
                    <button
                      onClick={() => cancelScheduled(s.id)}
                      className="text-[#555] hover:text-red-400 p-1 shrink-0"
                      title="Cancel"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {showPollForm && (
          <div className="mb-2 bg-[#1C1C1E] border border-[#333] rounded-2xl p-3 animate-fade-in">
            <p className="text-xs font-semibold text-white mb-2 flex items-center gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-[#FF9F0A]">
                <path fillRule="evenodd" d="M2 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5Zm3.293 2.293a1 1 0 0 1 1.414 0l3 3a1 1 0 0 1 0 1.414l-3 3a1 1 0 0 1-1.414-1.414L7.586 11 5.293 8.707a1 1 0 0 1 0-1.414Zm5 1a1 1 0 0 1 1.414-1.414l2 2a1 1 0 0 1 0 1.414l-2 2a1 1 0 0 1-1.414-1.414L12.586 10l-1.293-1.293a1 1 0 0 1-.293-.707Z" clipRule="evenodd" />
              </svg>
              New poll
              <button onClick={() => setShowPollForm(false)} className="ml-auto text-[#555] hover:text-white">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
              </button>
            </p>
            <input
              type="text"
              value={pollQuestion}
              onChange={(e) => setPollQuestion(e.target.value)}
              placeholder="Question"
              maxLength={100}
              className="w-full bg-[#0D0D0D] text-white text-sm rounded-lg px-3 py-2 outline-none border border-[#333] focus:border-[#555] placeholder-[#555]"
            />
            <div className="mt-2 space-y-1.5">
              {pollOptions.map((opt, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={opt}
                    onChange={(e) => {
                      const next = [...pollOptions];
                      next[i] = e.target.value;
                      setPollOptions(next);
                    }}
                    placeholder={`Option ${i + 1}`}
                    maxLength={60}
                    className="flex-1 bg-[#0D0D0D] text-white text-sm rounded-lg px-3 py-2 outline-none border border-[#333] focus:border-[#555] placeholder-[#555]"
                  />
                  {pollOptions.length > 2 && (
                    <button
                      onClick={() => setPollOptions(pollOptions.filter((_, j) => j !== i))}
                      className="text-[#555] hover:text-red-400 p-1"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-2">
              {pollOptions.length < 6 && (
                <button
                  onClick={() => setPollOptions([...pollOptions, ''])}
                  className="text-xs text-[#007AFF] font-medium hover:opacity-80"
                >
                  + Add option
                </button>
              )}
              <button
                onClick={sendPoll}
                className="ml-auto px-3.5 py-1.5 rounded-lg bg-[#FF9F0A] text-black text-xs font-semibold hover:bg-[#FFB340] transition-colors"
              >
                Post poll
              </button>
            </div>
          </div>
        )}
        <div className="flex items-center gap-1.5 bg-[#1C1C1E] rounded-2xl px-3 py-2 border border-[#2A2A2A] focus-within:border-[#444] transition-colors">
          <button
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            className="text-[#555] hover:text-white shrink-0 transition-colors p-1 rounded-lg hover:bg-white/5"
            title="Emoji"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
              <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25Zm-2.625 6c-.54 0-.828.419-.936.634a1.96 1.96 0 0 0-.189.866c0 .298.059.605.189.866.108.215.395.634.936.634.54 0 .828-.419.936-.634.13-.26.189-.568.189-.866 0-.298-.059-.605-.189-.866-.108-.215-.395-.634-.936-.634Zm4.314.634c.108-.215.395-.634.936-.634.54 0 .828.419.936.634.13.26.189.568.189.866 0 .298-.059.605-.189.866-.108.215-.395.634-.936.634-.54 0-.828-.419-.936-.634a1.96 1.96 0 0 1-.189-.866c0-.298.059-.605.189-.866Zm-4.34 7.964a.75.75 0 0 1-1.061-1.06 5.236 5.236 0 0 1 3.73-1.538 5.236 5.236 0 0 1 3.695 1.538.75.75 0 1 1-1.061 1.06 3.736 3.736 0 0 0-2.639-1.098 3.736 3.736 0 0 0-2.664 1.098Z" clipRule="evenodd" />
            </svg>
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-[#555] hover:text-white shrink-0 transition-colors p-1 rounded-lg hover:bg-white/5"
            title="Attach file"
            disabled={sending}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
              <path fillRule="evenodd" d="M1.5 6a2.25 2.25 0 0 1 2.25-2.25h16.5A2.25 2.25 0 0 1 22.5 6v12a2.25 2.25 0 0 1-2.25 2.25H3.75A2.25 2.25 0 0 1 1.5 18V6ZM3 16.06V18c0 .414.336.75.75.75h16.5A.75.75 0 0 0 21 18v-1.94l-2.69-2.689a1.5 1.5 0 0 0-2.12 0l-.88.879.97.97a.75.75 0 1 1-1.06 1.06l-5.16-5.159a1.5 1.5 0 0 0-2.12 0L3 16.061Zm10.125-7.81a1.125 1.125 0 1 1 2.25 0 1.125 1.125 0 0 1-2.25 0Z" clipRule="evenodd" />
            </svg>
          </button>
          <button
            onClick={() => setViewOnce(!viewOnce)}
            className={`hidden sm:flex shrink-0 p-1 rounded-lg hover:bg-white/5 items-center gap-1 ${viewOnce ? 'text-[#FF3B30] bg-[#FF3B30]/10' : 'text-[#555] hover:text-white'}`}
            title="View once (image disappears after viewing)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
              <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 0 1 0-1.18l3.11-4.944A1.5 1.5 0 0 1 5.05 3.75h9.9a1.5 1.5 0 0 1 1.278.72l3.11 4.944a1.651 1.651 0 0 1 0 1.18l-3.11 4.944A1.5 1.5 0 0 1 14.95 16.25H5.05a1.5 1.5 0 0 1-1.278-.72L.664 10.59ZM10 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" clipRule="evenodd" />
              {viewOnce && <path d="M13.5 4.938a7 7 0 1 1-9.006 1.737c.202-.268.59-.295.793-.038.586.737 1.316 1.33 2.114 1.623C9.594 9.215 10.95 10 12.75 10a.75.75 0 0 0 0-1.5c-1.531 0-2.648-.548-3.563-1.37-.674-.603-.99-1.313-1.252-2.043C8.32 4.13 9.208 3.55 9.987 3.5c.257-.021.504.044.727.186.796.505 1.496 1.12 2.1 1.882a.75.75 0 0 0 1.086.63c.047-.025.092-.053.136-.082a.24.24 0 0 1 .117-.033c.257.002.51.025.77.06l.2.03c.07.01.135.028.198.045a.75.75 0 0 0 .18-1.488l-.2-.03A7.16 7.16 0 0 0 15 4.16a.75.75 0 0 0-1.5.778ZM13.4 8.5a.75.75 0 0 1 .37 1.4l-4.5 2.6a.75.75 0 1 1-.75-1.3l4.5-2.6a.75.75 0 0 1 .38-.1Z" clipRule="evenodd" />}
            </svg>
            <span className="text-[11px] hidden sm:inline">{viewOnce ? 'View once: ON' : 'View once'}</span>
          </button>
          <label className="flex sm:hidden items-center gap-1 text-[10px] text-[#555] cursor-pointer">
            <input type="checkbox" checked={viewOnce} onChange={(e) => setViewOnce(e.target.checked)} className="w-3 h-3 rounded" />
            Once
          </label>
          <button
            onClick={() => setShowPollForm(!showPollForm)}
            className={`hidden sm:flex shrink-0 transition-colors p-1 rounded-lg hover:bg-white/5 ${showPollForm ? 'text-[#FF9F0A]' : 'text-[#555] hover:text-white'}`}
            title="Create poll"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path fillRule="evenodd" d="M2 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5Zm3.293 2.293a1 1 0 0 1 1.414 0l3 3a1 1 0 0 1 0 1.414l-3 3a1 1 0 0 1-1.414-1.414L7.586 11 5.293 8.707a1 1 0 0 1 0-1.414Zm5 1a1 1 0 0 1 1.414-1.414l2 2a1 1 0 0 1 0 1.414l-2 2a1 1 0 0 1-1.414-1.414L12.586 10l-1.293-1.293a1 1 0 0 1-.293-.707Z" clipRule="evenodd" />
            </svg>
          </button>
          <button
            onClick={startTranscription}
            className={`hidden sm:flex shrink-0 p-1 rounded-lg hover:bg-white/5 ${isTranscribing ? 'text-red-400 bg-red-400/10 animate-pulse' : 'text-[#555] hover:text-white'}`}
            title="Voice to text"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path d="M10 1a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
              <path d="M5 9a.75.75 0 0 1 .75.75 4.25 4.25 0 0 0 8.5 0A.75.75 0 0 1 15 9.75a5.75 5.75 0 0 1-5 5.698V17a.75.75 0 0 1-1.5 0v-1.552A5.75 5.75 0 0 1 4.25 9.75A.75.75 0 0 1 5 9Z" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileSelect}
            className="hidden"
          />
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={handleInputChange}
            onKeyDown={(e) => {
              if (mentionStartIndex !== -1) {
                const filtered = memberList.filter(
                  (m) => m.uid !== user?.uid && m.name.toLowerCase().includes(mentionQuery.toLowerCase())
                );
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionSelectedIndex((prev) => Math.max(prev - 1, 0));
                  return;
                }
                if ((e.key === 'Enter' || e.key === 'Tab') && filtered.length > 0) {
                  e.preventDefault();
                  selectMention(filtered[mentionSelectedIndex].name);
                  return;
                }
                if (e.key === 'Escape') {
                  setMentionQuery('');
                  setMentionStartIndex(-1);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder={editingId ? 'Edit message...' : replyTo ? 'Write a reply...' : 'Message'}
            className="flex-1 bg-transparent text-white placeholder-[#444] outline-none text-sm"
            maxLength={2000}
          />
          <button
            onClick={() => setBurnEnabled(!burnEnabled)}
            className={`shrink-0 transition-colors p-1 rounded-lg hover:bg-white/5 ${burnEnabled ? 'text-[#FF453A] bg-[#FF453A]/10' : 'text-[#555] hover:text-white'}`}
            title="Burn-on-read: message deletes itself after 30s"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path fillRule="evenodd" d="M13.5 4.938a7 7 0 1 1-9.006 1.737c.202-.268.59-.295.793-.038.586.737 1.316 1.33 2.114 1.623C9.594 9.215 10.95 10 12.75 10a.75.75 0 0 0 0-1.5c-1.531 0-2.648-.548-3.563-1.37-.674-.603-.99-1.313-1.252-2.043C8.32 4.13 9.208 3.55 9.987 3.5c.257-.021.504.044.727.186.796.505 1.496 1.12 2.1 1.882a.75.75 0 0 0 1.086.63c.047-.025.092-.053.136-.082a.24.24 0 0 1 .117-.033c.257.002.51.025.77.06l.2.03c.07.01.135.028.198.045a.75.75 0 0 0 .18-1.488l-.2-.03A7.16 7.16 0 0 0 15 4.16a.75.75 0 0 0-1.5.778ZM13.4 8.5a.75.75 0 0 1 .37 1.4l-4.5 2.6a.75.75 0 1 1-.75-1.3l4.5-2.6a.75.75 0 0 1 .38-.1Z" clipRule="evenodd" />
            </svg>
          </button>
          <button
            onClick={() => setShowSchedule(!showSchedule)}
            className={`shrink-0 transition-colors p-1 rounded-lg hover:bg-white/5 ${showSchedule ? 'text-[#FF9F0A] bg-[#FF9F0A]/10' : 'text-[#555] hover:text-white'}`}
            title="Schedule a message"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-13a.75.75 0 0 0-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 0 0 0-1.5h-3.25V5Z" clipRule="evenodd" />
            </svg>
          </button>
          <button
            onClick={sendMessage}
            disabled={!input.trim() || sending || !cryptoKey || (roomSettings?.frozen === true && user?.uid !== roomOwnerUid)}
            className="text-[#007AFF] disabled:opacity-20 transition-all p-1 rounded-lg hover:bg-[#007AFF]/10 disabled:cursor-not-allowed"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
              <path d="M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z" />
            </svg>
          </button>
        </div>
      </div>

      <VoiceCallUI
        roomCode={code || ''}
        callState={voiceCall.callState}
        inCall={voiceCall.inCall}
        callParticipants={voiceCall.callParticipants}
        micEnabled={voiceCall.micEnabled}
        onJoin={voiceCall.joinCall}
        onLeave={voiceCall.leaveCall}
        onToggleMute={voiceCall.toggleMute}
        onInvite={voiceCall.inviteMember}
        invitations={callInvitations}
        onDismissInvitation={voiceCall.dismissInvitation}
        sharingScreen={voiceCall.sharingScreen}
        screenShareUid={voiceCall.screenShareUid}
        remoteScreens={voiceCall.remoteScreens}
        onStartScreenShare={voiceCall.startScreenShare}
        onStopScreenShare={voiceCall.stopScreenShare}
      />

      {showMembers && (
        <MembersModal
          memberCount={memberCount}
          memberList={memberList}
          fingerprint={fingerprint}
          search={memberSearch}
          onSearchChange={setMemberSearch}
          currentUid={user?.uid}
          isAdmin={!!user && user.uid === roomOwnerUid}
          roomOwnerUid={roomOwnerUid}
          onRemoveMember={removeMember}
          onClose={() => { setShowMembers(false); setMemberSearch(''); }}
        />
      )}

      {showShare && (
        <ShareModal
          roomCode={code || ''}
          roomName={roomName}
          showToast={showToast}
          onClose={() => setShowShare(false)}
        />
      )}

      {showSettings && (
        <SettingsModal
          roomName={roomName}
          isAdmin={!!user && user.uid === roomOwnerUid}
          settings={roomSettings}
          tone={tone}
          inviteLink={inviteLink}
          exporting={exporting}
          onToneChange={setToneAndSave}
          onSaveSettings={saveSettings}
          onRotateKey={rotateKey}
          onCreateInvite={createInvite}
          onExport={exportChat}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showSearch && (
        <SearchModal
          roomCode={code || ''}
          onJumpToMessage={(id) => { setShowSearch(false); scrollToMessage(id); }}
          onClose={() => setShowSearch(false)}
        />
      )}

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[60] bg-[#1C1C1E] border border-[#333] text-white text-xs font-medium px-4 py-2.5 rounded-xl shadow-2xl animate-fade-in whitespace-nowrap">
          {toast}
        </div>
      )}

      {forwardMsg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={() => setForwardMsg(null)} />
          <div className="relative bg-[#1C1C1E] border border-[#333] rounded-2xl w-full max-w-sm p-5 animate-fade-in">
            <h3 className="text-sm font-semibold text-white mb-3">Forward message</h3>
            <p className="text-xs text-[#777] mb-3 truncate">"{forwardMsg.text.slice(0, 80)}"</p>
            <p className="text-[11px] text-[#555] mb-2">Select room</p>
            <div className="space-y-1 max-h-48 overflow-y-auto mb-3">
              {useStore.getState().joinedRooms.filter((r) => r.code !== code).map((r) => (
                <button key={r.code} onClick={() => forwardMessage(r.code)} className="w-full text-left px-3 py-2 rounded-lg bg-[#0D0D0D] hover:bg-[#252525] text-sm text-white flex justify-between">
                  <span>{r.name}</span><span className="text-xs text-[#555]">#{r.code}</span>
                </button>
              ))}
              {useStore.getState().joinedRooms.filter((r) => r.code !== code).length === 0 && (
                <p className="text-xs text-[#555] text-center py-4">No other rooms</p>
              )}
            </div>
            <button onClick={() => setForwardMsg(null)} className="w-full py-2 rounded-xl text-sm bg-[#333] text-white">Cancel</button>
          </div>
        </div>
      )}

      {historyMsg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/70" onClick={() => setHistoryMsg(null)} />
          <div className="relative bg-[#1C1C1E] border border-[#333] rounded-2xl w-full max-w-sm p-5 animate-fade-in">
            <h3 className="text-sm font-semibold text-white mb-3">Edit history</h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {(historyMsg.editHistory || []).map((h, i) => (
                <div key={i} className="bg-[#0D0D0D] rounded-lg p-3">
                  <p className="text-xs text-[#ccc]">{h.text}</p>
                  <p className="text-[10px] text-[#555] mt-1">{new Date(h.editedAt).toLocaleString()}</p>
                </div>
              ))}
              {(!historyMsg.editHistory || historyMsg.editHistory.length === 0) && (
                <p className="text-xs text-[#555] text-center py-4">No history</p>
              )}
              <div className="bg-[#007AFF]/10 border border-[#007AFF]/20 rounded-lg p-3">
                <p className="text-xs text-white">{historyMsg.text}</p>
                <p className="text-[10px] text-[#007AFF] mt-1">Current</p>
              </div>
            </div>
            <button onClick={() => setHistoryMsg(null)} className="w-full mt-3 py-2 rounded-xl text-sm bg-[#333] text-white">Close</button>
          </div>
        </div>
      )}

      {lightboxSrc && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="Preview" className="max-w-full max-h-full rounded-xl" />
          <button onClick={() => setLightboxSrc(null)} className="absolute top-4 right-4 text-white bg-black/50 rounded-full p-2">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
          </button>
        </div>
      )}

      {showCommandPalette && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 p-4">
          <div className="fixed inset-0 bg-black/60" onClick={() => setShowCommandPalette(false)} />
          <div className="relative bg-[#1C1C1E] border border-[#333] rounded-2xl w-full max-w-md overflow-hidden animate-fade-in">
            <div className="px-4 py-3 border-b border-[#333]">
              <input autoFocus placeholder="Type a command..." className="w-full bg-transparent text-white placeholder-[#555] outline-none text-sm" onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const v = (e.target as HTMLInputElement).value.toLowerCase();
                  if (v.includes('poll')) { setShowCommandPalette(false); setShowPollForm(true); }
                  else if (v.includes('invite')) { setShowCommandPalette(false); setShowShare(true); }
                  else if (v.includes('search')) { setShowCommandPalette(false); setShowSearch(true); }
                  else if (v.includes('clear')) { setShowCommandPalette(false); }
                  else if (v.includes('members')) { setShowCommandPalette(false); setShowMembers(true); }
                }
              }} />
            </div>
            <div className="p-2 space-y-1 max-h-64 overflow-y-auto">
              {[
                { label: 'Create poll', action: () => { setShowCommandPalette(false); setShowPollForm(true); } },
                { label: 'Invite members', action: () => { setShowCommandPalette(false); setShowShare(true); } },
                { label: 'Search messages', action: () => { setShowCommandPalette(false); setShowSearch(true); } },
                { label: 'Show members', action: () => { setShowCommandPalette(false); setShowMembers(true); } },
                { label: 'Toggle theme', action: () => { setShowCommandPalette(false); showToast('Theme toggled'); } },
              ].map((c) => (
                <button key={c.label} onClick={c.action} className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 text-sm text-[#ccc]">{c.label}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {kicked && (
        <div className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center gap-4 p-6 text-center">
          <div className="w-14 h-14 rounded-full bg-red-500/10 flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-7 h-7 text-red-400">
              <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.28 7.22a.75.75 0 0 0-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06L10 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L11.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L10 8.94 8.28 7.22Z" clipRule="evenodd" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">You were removed from this room</h2>
            <p className="text-xs text-[#555] mt-1.5">The room owner removed you from the member list.</p>
          </div>
          <button
            onClick={() => navigate('/')}
            className="px-5 py-2.5 rounded-xl bg-[#007AFF] text-white text-sm font-medium hover:bg-[#0066CC] transition-all"
          >
            Go to Dashboard
          </button>
        </div>
      )}
    </div>
  );
}

function MembersModal({
  memberCount,
  memberList,
  fingerprint,
  search,
  onSearchChange,
  currentUid,
  isAdmin,
  roomOwnerUid,
  onRemoveMember,
  onClose,
}: {
  memberCount: number | null;
  memberList: { name: string; uid: string; online?: boolean; lastSeen?: number; lastSpokeAt?: number | null; avatarEmoji?: string; avatarColor?: string }[];
  fingerprint: string;
  search: string;
  onSearchChange: (v: string) => void;
  currentUid?: string;
  isAdmin: boolean;
  roomOwnerUid: string | null;
  onRemoveMember: (uid: string) => void;
  onClose: () => void;
}) {
  const [confirmRemoveUid, setConfirmRemoveUid] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [deviceMap, setDeviceMap] = useState<Record<string, { total: number; online: number }>>({});
  const [myDevices, setMyDevices] = useState<{ id: string; name: string; online: boolean; lastSeen: number }[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => () => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
  }, []);

  // Fetch device info for all members + own device list
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const map: Record<string, { total: number; online: number }> = {};
      for (const m of memberList) {
        try {
          const snap = await getDocs(collection(db, 'users', m.uid, 'devices'));
          let total = 0, online = 0;
          snap.forEach((d) => {
            const data = d.data();
            if (data.revoked === true) return;
            total++;
            const lastSeen = data.lastSeen?.toMillis?.() ?? 0;
            if (data.online === true && Date.now() - lastSeen < 180000) online++;
          });
          map[m.uid] = { total, online };
          if (m.uid === currentUid) {
            const list = snap.docs
              .filter((d) => !d.data()?.revoked)
              .map((d) => ({
                id: d.id,
                name: d.data()?.name || 'Unknown device',
                online: d.data()?.online === true && Date.now() - (d.data()?.lastSeen?.toMillis?.() ?? 0) < 180000,
                lastSeen: d.data()?.lastSeen?.toMillis?.() ?? 0,
              }));
            setMyDevices(list);
          }
        } catch {}
      }
      if (!cancelled) setDeviceMap(map);
    })();
    return () => { cancelled = true; };
  }, [memberList, currentUid]);

  const revokeDevice = async (deviceId: string) => {
    if (!currentUid) return;
    try {
      await updateDoc(doc(db, 'users', currentUid, 'devices', deviceId), { revoked: true });
      setMyDevices((prev) => prev.filter((d) => d.id !== deviceId));
    } catch {}
  };

  const copyFingerprint = async () => {
    try {
      await navigator.clipboard.writeText(fingerprint);
    } catch {}
  };

  const handleRemove = (uid: string) => {
    if (confirmRemoveUid === uid) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      setConfirmRemoveUid(null);
      onRemoveMember(uid);
    } else {
      setConfirmRemoveUid(uid);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmRemoveUid(null), 2500);
    }
  };

  const filtered = memberList
    .filter((m) => m.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      const aSeen = a.lastSeen || 0;
      const bSeen = b.lastSeen || 0;
      if (aSeen !== bSeen) return bSeen - aSeen;
      return a.name.localeCompare(b.name);
    });

  const activityColor = (lastSeen?: number) => {
    if (!lastSeen) return '#333';
    const age = Date.now() - lastSeen;
    if (age < 5 * 60000) return '#00FF88';
    if (age < 60 * 60000) return '#FFD60A';
    if (age < 6 * 3600000) return '#FF9F0A';
    return '#3A3A3C';
  };

  const activityText = (m: { online?: boolean; lastSeen?: number; lastSpokeAt?: number | null }) => {
    if (m.online) return 'Online';
    if (!m.lastSeen) return 'Never active';
    const age = Date.now() - m.lastSeen;
    const mins = Math.floor(age / 60000);
    if (mins < 1) return 'Active just now';
    if (mins < 60) return `Active ${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `Active ${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `Active ${days}d ago`;
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 pointer-events-none">
        <div
          className="bg-[#1C1C1E] border border-[#333] rounded-2xl w-full max-w-md shadow-2xl pointer-events-auto animate-fade-in overflow-hidden my-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#333]">
            <h2 className="text-sm font-semibold text-white">
              Members <span className="text-[#555] font-normal">({memberCount})</span>
              <span className="text-[10px] text-[#00FF88] font-normal ml-2">● {filtered.filter((m) => m.online).length} online</span>
            </h2>
            <button onClick={onClose} className="text-[#555] hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-all">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
            </button>
          </div>
          {fingerprint && (
            <button
              onClick={copyFingerprint}
              className="flex items-center justify-center gap-1.5 w-full px-5 py-2 border-b border-[#222] text-[11px] text-[#00FF88]/80 hover:text-[#00FF88] transition-colors"
              title="Copy room fingerprint"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                <path fillRule="evenodd" d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z" clipRule="evenodd" />
              </svg>
              Room fingerprint: <span className="font-mono font-semibold tracking-wider">{fingerprint}</span>
            </button>
          )}
          <div className="px-4 pt-3 pb-1">
            <div className="flex items-center gap-2 bg-[#0D0D0D] rounded-xl px-3 py-2 border border-[#333] focus-within:border-[#555] transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-[#555] shrink-0">
                <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search members..."
                className="flex-1 bg-transparent text-white text-sm placeholder-[#555] outline-none"
                autoFocus
              />
              {search && (
                <button onClick={() => onSearchChange('')} className="text-[#555] hover:text-white p-0.5 rounded">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
                </button>
              )}
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto p-2">
            {filtered.length === 0 ? (
              <p className="text-xs text-[#555] text-center py-8">
                {memberList.length === 0 ? 'No members' : 'No members found'}
              </p>
            ) : (
              <div className="space-y-0.5">
                {filtered.map((m) => (
                  <div key={m.uid} className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.03] transition-colors">
                    <div className="relative shrink-0">
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 text-white"
                        style={{
                          backgroundColor: m.avatarColor || 'rgba(0,122,255,0.35)',
                          borderColor: m.online ? '#00FF88' : activityColor(m.lastSeen),
                        }}
                      >
                        {m.avatarEmoji || (m.name || '?').charAt(0).toUpperCase()}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-[#ccc] font-medium truncate">{m.name}</span>
                        {m.uid === roomOwnerUid && (
                          <span className="text-[10px] text-[#FFD700] bg-yellow-400/10 px-1.5 py-0.5 rounded-md font-medium">owner</span>
                        )}
                        {m.uid === currentUid && (
                          <span className="text-[10px] text-[#555] bg-white/5 px-1.5 py-0.5 rounded-md">you</span>
                        )}
                        {m.lastSpokeAt === null && (
                          <span className="text-[10px] text-[#FF9F0A]/80 bg-[#FF9F0A]/10 px-1.5 py-0.5 rounded-md font-medium">observer</span>
                        )}
                      </div>
                      <p className="text-[11px] text-[#666] mt-0.5">
                        {activityText(m)}
                        {deviceMap[m.uid]?.total ? ` · ${deviceMap[m.uid].total} device${deviceMap[m.uid].total !== 1 ? 's' : ''}${deviceMap[m.uid].online ? ` (${deviceMap[m.uid].online} online)` : ''}` : ''}
                      </p>
                    </div>
                    {isAdmin && m.uid !== currentUid && (
                      <button
                        onClick={() => handleRemove(m.uid)}
                        className={`text-[10px] font-medium px-2.5 py-1 rounded-full transition-all shrink-0 ${
                          confirmRemoveUid === m.uid
                            ? 'bg-red-500 text-white hover:bg-red-600'
                            : 'text-red-400/80 bg-red-400/10 hover:bg-red-400/20 hover:text-red-300'
                        }`}
                        title="Remove from room"
                      >
                        {confirmRemoveUid === m.uid ? 'Confirm?' : 'Remove'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          {myDevices.length > 0 && (
            <div className="border-t border-[#333] px-4 py-3">
              <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider mb-2">My devices</p>
              <div className="space-y-1.5">
                {myDevices.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 text-xs">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${d.online ? 'bg-[#00FF88]' : 'bg-[#3A3A3C]'}`} />
                    <span className="flex-1 text-[#ccc] truncate">{d.name}</span>
                    <span className="text-[10px] text-[#555] shrink-0">{d.online ? 'Online' : 'Offline'}</span>
                    <button
                      onClick={() => revokeDevice(d.id)}
                      className="text-[10px] text-red-400/80 hover:text-red-300 px-1.5 py-0.5 rounded bg-red-400/10 shrink-0"
                    >
                      Revoke
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function ShareModal({
  roomCode,
  roomName,
  showToast,
  onClose,
}: {
  roomCode: string;
  roomName: string;
  showToast: (msg: string) => void;
  onClose: () => void;
}) {
  const shareLink = `${window.location.origin}/?code=${roomCode}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      showToast('Join link copied');
    } catch {
      showToast('Could not copy link');
    }
  };

  const nativeShare = async () => {
    try {
      await navigator.share({
        title: `Chatrix #${roomCode}`,
        text: `Join my Chatrix room!\nRoom code: ${roomCode}`,
        url: shareLink,
      });
    } catch {}
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 pointer-events-none">
        <div
          className="bg-[#1C1C1E] border border-[#333] rounded-2xl w-full max-w-md shadow-2xl pointer-events-auto animate-fade-in overflow-hidden my-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#333]">
            <h2 className="text-sm font-semibold text-white">
              Share room <span className="text-[#555] font-normal">· {roomName}</span>
            </h2>
            <button onClick={onClose} className="text-[#555] hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-all">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
            </button>
          </div>

          <div className="px-5 py-4 space-y-4">
            <div className="flex items-center justify-center gap-2 bg-[#0D0D0D] rounded-xl px-4 py-2.5 border border-[#333]">
              <span className="text-[11px] text-[#555] font-medium uppercase tracking-wider">Room code</span>
              <span className="text-sm font-mono font-bold text-[#00FF88] tracking-[0.2em]">{roomCode}</span>
            </div>

            <div className="rounded-xl border border-[#333] p-4">
              <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                  <path fillRule="evenodd" d="M2.5 8.5A2.5 2.5 0 0 1 5 6h10a2.5 2.5 0 0 1 2.5 2.5v6A2.5 2.5 0 0 1 15 17H5a2.5 2.5 0 0 1-2.5-2.5v-6Zm14.5-2.622V4.75A2.75 2.75 0 0 0 14.25 2h-8.5A2.75 2.75 0 0 0 3 4.75v1.128c.32.08.65.122 1 .122h12c.35 0 .68-.043 1-.122Z" clipRule="evenodd" />
                </svg>
                Join link
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={shareLink}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 bg-[#0D0D0D] text-[#ccc] text-xs rounded-lg px-3 py-2.5 outline-none border border-[#333] focus:border-[#555] truncate"
                />
                <button
                  onClick={copyLink}
                  className="px-3.5 py-2.5 rounded-lg text-xs font-medium bg-[#007AFF] text-white hover:bg-[#0066CC] transition-all shrink-0"
                >
                  Copy
                </button>
              </div>
              {typeof navigator !== 'undefined' && !!navigator.share && (
                <button
                  onClick={nativeShare}
                  className="mt-2.5 w-full py-2 rounded-lg text-xs font-medium text-[#ccc] border border-[#333] hover:border-[#555] hover:text-white transition-all"
                >
                  Share via system
                </button>
              )}
              <p className="text-[10px] text-[#555] mt-2">Anyone with this link can join the room using their own name.</p>
            </div>

            <div className="rounded-xl border border-[#333] p-4 flex flex-col items-center">
              <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                  <path fillRule="evenodd" d="M3 4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4Zm3 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm0 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm4-6a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm-8 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm8 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm-4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm0 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm4 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" clipRule="evenodd" />
                </svg>
                QR code
              </p>
              <div className="bg-white p-3.5 rounded-xl shadow-lg">
                <QRCodeSVG value={shareLink} size={168} level="M" fgColor="#000000" bgColor="#ffffff" />
              </div>
              <p className="text-[10px] text-[#555] mt-2.5">Scan with a phone camera to open the room instantly.</p>
            </div>
          </div>

          <div className="px-5 pb-5">
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-xl text-sm font-medium text-[#555] border border-[#333] hover:text-white hover:border-[#555] transition-all"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function SettingsModal({
  roomName,
  isAdmin,
  settings,
  tone,
  inviteLink,
  exporting,
  onToneChange,
  onSaveSettings,
  onRotateKey,
  onCreateInvite,
  onExport,
  onClose,
}: {
  roomName: string;
  isAdmin: boolean;
  settings: RoomSettings | null;
  tone: 'pop' | 'ding' | 'soft' | 'none';
  inviteLink: string;
  exporting: boolean;
  onToneChange: (t: 'pop' | 'ding' | 'soft' | 'none') => void;
  onSaveSettings: (patch: Partial<RoomSettings>) => void;
  onRotateKey: () => void;
  onCreateInvite: () => void;
  onExport: (format: 'json' | 'txt') => void;
  onClose: () => void;
}) {
  const [slowMode, setSlowMode] = useState(settings?.slowModeSec || 0);
  const [wordsInput, setWordsInput] = useState((settings?.blockedWords || []).join(', '));
  const [blurInput, setBlurInput] = useState((settings?.blurWords || []).join(', '));
  const [effectInput, setEffectInput] = useState((settings?.effectWords || []).join(', '));
  const [linkPreviews, setLinkPreviews] = useState(settings?.linkPreviews ?? true);

  useEffect(() => {
    setSlowMode(settings?.slowModeSec || 0);
    setWordsInput((settings?.blockedWords || []).join(', '));
    setBlurInput((settings?.blurWords || []).join(', '));
    setEffectInput((settings?.effectWords || []).join(', '));
    setLinkPreviews(settings?.linkPreviews ?? true);
  }, [settings]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = () => {
    const words = wordsInput.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    const blurWords = blurInput.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    const effectWords = effectInput.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    onSaveSettings({ slowModeSec: slowMode, blockedWords: words, blurWords, effectWords, linkPreviews });
  };

  const TONES: { id: 'pop' | 'ding' | 'soft' | 'none'; label: string }[] = [
    { id: 'pop', label: 'Pop' },
    { id: 'ding', label: 'Ding' },
    { id: 'soft', label: 'Soft' },
    { id: 'none', label: 'Silent' },
  ];

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 pointer-events-none">
        <div
          className="bg-[#1C1C1E] border border-[#333] rounded-2xl w-full max-w-md shadow-2xl pointer-events-auto animate-fade-in overflow-hidden my-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#333]">
            <h2 className="text-sm font-semibold text-white">
              Room settings <span className="text-[#555] font-normal">· {roomName}</span>
            </h2>
            <button onClick={onClose} className="text-[#555] hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-all">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
            </button>
          </div>

          <div className="px-5 py-4 space-y-5 max-h-[65vh] overflow-y-auto">
            <div>
              <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider mb-2">Message sound</p>
              <div className="flex gap-1.5">
                {TONES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => onToneChange(t.id)}
                    className={`flex-1 py-2 rounded-lg text-xs font-medium border transition-all ${
                      tone === t.id
                        ? t.id === 'none'
                          ? 'border-[#3A3A3C] bg-[#3A3A3C]/30 text-white'
                          : 'border-[#007AFF] bg-[#007AFF]/10 text-[#007AFF]'
                        : 'border-[#333] text-[#777] hover:border-[#555]'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {isAdmin && settings && (
              <>
                <div>
                  <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider mb-2">Slow mode</p>
                  <div className="flex flex-wrap gap-1.5">
                    {[0, 5, 10, 30, 60].map((sec) => (
                      <button
                        key={sec}
                        onClick={() => setSlowMode(sec)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                          slowMode === sec
                            ? 'border-[#007AFF] bg-[#007AFF]/10 text-[#007AFF]'
                            : 'border-[#333] text-[#777] hover:border-[#555]'
                        }`}
                      >
                        {sec === 0 ? 'Off' : sec === 60 ? '1 min' : `${sec}s`}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider mb-2">Blocked words</p>
                  <input
                    type="text"
                    value={wordsInput}
                    onChange={(e) => setWordsInput(e.target.value)}
                    placeholder="e.g. spam, scam, hello"
                    className="w-full bg-[#0D0D0D] text-white text-sm rounded-lg px-3 py-2 outline-none border border-[#333] focus:border-[#555] placeholder-[#555]"
                  />
                  <p className="text-[10px] text-[#555] mt-1">Comma-separated. Messages containing these are blocked.</p>
                </div>

                <div>
                  <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider mb-2">Blur words</p>
                  <input
                    type="text"
                    value={blurInput}
                    onChange={(e) => setBlurInput(e.target.value)}
                    placeholder="e.g. secret, password, code"
                    className="w-full bg-[#0D0D0D] text-white text-sm rounded-lg px-3 py-2 outline-none border border-[#333] focus:border-[#555] placeholder-[#555]"
                  />
                  <p className="text-[10px] text-[#555] mt-1">Comma-separated. Matches are masked with * until tapped.</p>
                </div>

                <div>
                  <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider mb-2">Effect words</p>
                  <input
                    type="text"
                    value={effectInput}
                    onChange={(e) => setEffectInput(e.target.value)}
                    placeholder="e.g. yay, congrats, party"
                    className="w-full bg-[#0D0D0D] text-white text-sm rounded-lg px-3 py-2 outline-none border border-[#333] focus:border-[#555] placeholder-[#555]"
                  />
                  <p className="text-[10px] text-[#555] mt-1">Comma-separated. Triggers a burst animation when sent.</p>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-white">Link previews</p>
                    <p className="text-[11px] text-[#555] mt-0.5">Show rich previews for links</p>
                  </div>
                  <button
                    onClick={() => setLinkPreviews(!linkPreviews)}
                    className={`w-11 h-6 rounded-full transition-colors relative ${linkPreviews ? 'bg-[#007AFF]' : 'bg-[#3A3A3C]'}`}
                  >
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all ${linkPreviews ? 'left-[22px]' : 'left-0.5'}`} />
                  </button>
                </div>

                <div>
                  <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider mb-2">Theme accent</p>
                  <div className="flex gap-2">
                    {['#007AFF','#FF2D55','#34C759','#FF9500','#AF52DE'].map((c) => (
                      <button key={c} onClick={() => { localStorage.setItem('chatrix_accent', c); document.documentElement.style.setProperty('--accent', c); }} className="w-8 h-8 rounded-full border-2 border-[#333] hover:scale-110 transition-transform" style={{ backgroundColor: c }} />
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-white">Freeze room</p>
                    <p className="text-[11px] text-[#555] mt-0.5">Stop all members from sending messages</p>
                  </div>
                  <button
                    onClick={() => onSaveSettings({ frozen: !settings.frozen })}
                    className={`w-11 h-6 rounded-full transition-colors relative ${settings.frozen ? 'bg-[#FF3B30]' : 'bg-[#3A3A3C]'}`}
                  >
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all ${settings.frozen ? 'left-[22px]' : 'left-0.5'}`} />
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-white">Encryption key</p>
                    <p className="text-[11px] text-[#555] mt-0.5">Current version: {settings.keyVersion ?? 0}</p>
                  </div>
                  <button
                    onClick={onRotateKey}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium border border-[#FF9F0A]/40 text-[#FF9F0A] bg-[#FF9F0A]/10 hover:bg-[#FF9F0A]/20 transition-all"
                  >
                    Rotate key
                  </button>
                </div>

                <div>
                  <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider mb-2">Invite someone</p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      readOnly
                      value={inviteLink || 'One-time invite link'}
                      onFocus={(e) => e.target.select()}
                      className="flex-1 bg-[#0D0D0D] text-[#ccc] text-xs rounded-lg px-3 py-2 outline-none border border-[#333] focus:border-[#555] truncate"
                    />
                    <button
                      onClick={onCreateInvite}
                      className="px-3 py-2 rounded-lg text-xs font-medium bg-[#007AFF] text-white hover:bg-[#0066CC] transition-all shrink-0"
                    >
                      {inviteLink ? 'New link' : 'Create'}
                    </button>
                  </div>
                  <p className="text-[10px] text-[#555] mt-1">Link expires in 24 hours, works once.</p>
                </div>
              </>
            )}

            {!isAdmin && (
              <p className="text-xs text-[#555] text-center py-2">
                Only the room owner can change room-level settings.
              </p>
            )}

            <div>
              <p className="text-[11px] text-[#555] font-medium uppercase tracking-wider mb-2">Export chat</p>
              <div className="flex gap-2">
                <button
                  onClick={() => onExport('json')}
                  disabled={exporting}
                  className="flex-1 py-2 rounded-lg text-xs font-medium border border-[#007AFF]/40 text-[#007AFF] bg-[#007AFF]/10 hover:bg-[#007AFF]/20 transition-all disabled:opacity-40"
                >
                  Export .json
                </button>
                <button
                  onClick={() => onExport('txt')}
                  disabled={exporting}
                  className="flex-1 py-2 rounded-lg text-xs font-medium border border-[#00FF88]/40 text-[#00FF88] bg-[#00FF88]/10 hover:bg-[#00FF88]/20 transition-all disabled:opacity-40"
                >
                  Export .txt
                </button>
                <button
                  onClick={() => (onExport as any)('pdf')}
                  disabled={exporting}
                  className="flex-1 py-2 rounded-lg text-xs font-medium border border-[#FF3B30]/40 text-[#FF3B30] bg-[#FF3B30]/10 hover:bg-[#FF3B30]/20 transition-all disabled:opacity-40"
                >
                  PDF
                </button>
              </div>
              <p className="text-[10px] text-[#555] mt-1">
                {exporting ? 'Exporting and decrypting history...' : 'Downloads all messages, decrypted locally on your device.'}
              </p>
            </div>
          </div>

          <div className="flex gap-3 px-5 pb-5">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-[#555] border border-[#333] hover:text-white hover:border-[#555] transition-all"
            >
              Close
            </button>
            {isAdmin && (
              <button
                onClick={save}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-[#007AFF] text-white hover:bg-[#0066CC] transition-all"
              >
                Save
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function parseMentions(text: string, nameMap: Record<string, string>): string[] {
  const uids: string[] = [];
  const seen = new Set<string>();
  const matches = text.matchAll(/@(\S+)/g);
  for (const match of matches) {
    const name = match[1].replace(/[^a-zA-Z0-9_\u0080-\uFFFF\s]/g, '').toLowerCase();
    if (name && nameMap[name] && !seen.has(nameMap[name])) {
      seen.add(nameMap[name]);
      uids.push(nameMap[name]);
    }
  }
  return uids;
}

function RichText({
  text,
  blurWords,
  revealed,
  onToggleReveal,
}: {
  text: string;
  blurWords?: string[];
  revealed: Set<string>;
  onToggleReveal: (w: string) => void;
}) {
  const parts: React.ReactNode[] = [];
  let key = 0;

  const renderInlineMarkdown = (s: string): React.ReactNode[] => {
    if (!s) return [];
    const codeParts = s.split(/(`[^`]+`)/g);
    const result: React.ReactNode[] = [];
    for (const cp of codeParts) {
      if (cp.startsWith('`') && cp.endsWith('`') && cp.length > 1) {
        result.push(
          <code key={`c${key++}`} className="bg-white/10 px-1 py-0.5 rounded text-xs font-mono border border-white/10">
            {cp.slice(1, -1)}
          </code>
        );
      } else if (cp) {
        const boldParts = cp.split(/(\*\*[^*]+\*\*|__[^_]+__)/g);
        for (const bp of boldParts) {
          if ((bp.startsWith('**') && bp.endsWith('**')) || (bp.startsWith('__') && bp.endsWith('__'))) {
            result.push(
              <strong key={`b${key++}`} className="font-bold text-white">
                {bp.slice(2, -2)}
              </strong>
            );
          } else if (bp) {
            const italicParts = bp.split(/(\*[^*]+\*|_[^_]+_)/g);
            for (const ip of italicParts) {
              if ((ip.startsWith('*') && ip.endsWith('*') && ip.length > 1) || (ip.startsWith('_') && ip.endsWith('_') && ip.length > 1)) {
                result.push(
                  <em key={`i${key++}`} className="italic text-[#E5E5E5]">
                    {ip.slice(1, -1)}
                  </em>
                );
              } else if (ip) {
                result.push(ip);
              }
            }
          }
        }
      }
    }
    return result;
  };

  const pushPlain = (s: string) => {
    if (!s) return;
    if (!blurWords || blurWords.length === 0) {
      for (const n of renderInlineMarkdown(s)) parts.push(n);
      return;
    }
    const wordRe = /([A-Za-z0-9_]+)/g;
    let wm: RegExpExecArray | null;
    let wLast = 0;
    while ((wm = wordRe.exec(s))) {
      if (wm.index > wLast) {
        const gap = s.slice(wLast, wm.index);
        for (const n of renderInlineMarkdown(gap)) parts.push(n);
      }
      const word = wm[1];
      const hit = blurWords.find((b) => {
        if (!b) return false;
        const esc = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${esc}\\b`, 'i').test(word);
      });
      if (hit) {
        if (revealed.has(hit)) {
          parts.push(
            <span key={`r${key++}`} className="rounded bg-yellow-400/20 px-0.5">{word}</span>
          );
        } else {
          const mask =
            word.length <= 2
              ? '•'.repeat(word.length)
              : word.charAt(0) + '•'.repeat(word.length - 2) + word.charAt(word.length - 1);
          parts.push(
            <span
              key={`b${key++}`}
              className="cursor-pointer rounded px-0.5 select-none hover:bg-white/10"
              title={`Blurred word — tap to reveal: ${hit}`}
              onClick={() => onToggleReveal(hit)}
            >
              {mask}
            </span>
          );
        }
      } else {
        for (const n of renderInlineMarkdown(word)) parts.push(n);
      }
      wLast = wm.index + word.length;
    }
    const tail = s.slice(wLast);
    if (tail) for (const n of renderInlineMarkdown(tail)) parts.push(n);
  };

  // Handle code blocks first
  const codeBlockSegments = text.split(/(```[\s\S]*?```)/g);
  for (const seg of codeBlockSegments) {
    if (seg.startsWith('```') && seg.endsWith('```')) {
      const codeContent = seg.slice(3, -3).trim();
      parts.push(
        <pre key={`cb${key++}`} className="bg-[#0D0D0D] border border-[#333] rounded-lg p-3 my-1 overflow-x-auto text-xs font-mono whitespace-pre-wrap break-words">
          <code>{codeContent}</code>
        </pre>
      );
      continue;
    }
    const regex = /(@[\w\u{4e00}-\u{9fff}]{1,20})|(https?:\/\/[^\s]+)/gu;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(seg))) {
      pushPlain(seg.slice(last, m.index));
      if (m[1]) {
        parts.push(<span key={`m${key++}`} className="text-[#00FF88] font-medium">{m[1]}</span>);
      } else if (m[2]) {
        parts.push(
          <a
            key={`l${key++}`}
            href={m[2]}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-[#00CFFF] underline decoration-dotted underline-offset-2 break-all"
          >
            {m[2]}
          </a>
        );
      }
      last = m.index + m[0].length;
    }
    pushPlain(seg.slice(last));
  }
  return <>{parts}</>;
}

async function decryptMessage(data: any, id: string, keys: Record<number, CryptoKey>): Promise<DecryptedMessage> {
  if (data.sys) {
    return {
      id,
      senderUid: 'system',
      senderName: 'system',
      text: '',
      type: 'sys',
      sys: data.sys,
      seq: data.seq ?? undefined,
      timestamp: data.timestamp?.toMillis() ?? Date.now(),
    };
  }
  if (data.poll) {
    return {
      id,
      senderUid: data.senderUid,
      senderName: data.senderName || 'Someone',
      text: '',
      type: 'poll',
      poll: data.poll,
      seq: data.seq ?? undefined,
      timestamp: data.timestamp?.toMillis() ?? Date.now(),
    };
  }
  const key = keys[data.kv ?? 0];
  if (!key) {
    return {
      id,
      senderUid: data.senderUid,
      senderName: data.senderName || 'Someone',
      text: '[Encrypted]',
      timestamp: data.timestamp?.toMillis() ?? Date.now(),
    };
  }
  try {
    const decrypted = await decrypt(data.ciphertext, data.iv, key);
    const parsed = JSON.parse(decrypted);
    return {
      id,
      senderUid: data.senderUid,
      senderName: data.senderName || 'Someone',
      text: parsed.text || parsed,
      type: parsed.type || 'text',
      file: parsed.file || undefined,
      replyTo: parsed.replyTo || undefined,
      threadRootId: parsed.threadRootId || undefined,
      edited: data.edited || false,
      editHistory: data.editHistory || parsed.editHistory || undefined,
      forwarded: data.forwarded || parsed.forwarded || false,
      viewOnce: data.viewOnce || parsed.viewOnce || false,
      viewedBy: data.viewedBy || parsed.viewedBy || [],
      deleted: data.deleted || false,
      reactions: data.reactions || undefined,
      readerUids: data.readers ?? [],
      burn: data.burn || false,
      seq: data.seq ?? undefined,
      timestamp: data.timestamp?.toMillis() ?? Date.now(),
    };
  } catch {
    return {
      id,
      senderUid: data.senderUid,
      senderName: data.senderName || 'Someone',
      text: '[Decryption failed]',
      timestamp: data.timestamp?.toMillis() ?? Date.now(),
    };
  }
}

async function postSystemMessage(code: string, type: 'join' | 'remove', uid: string, name: string) {
  try {
    const existing = await getDocs(
      query(
        collection(db, 'rooms', code, 'messages'),
        where('sys.uid', '==', uid),
        limit(1)
      )
    );
    const dup = existing.docs.some((d) => d.data()?.sys?.type === type);
    if (dup) return;
    await addDoc(collection(db, 'rooms', code, 'messages'), {
      sys: { type, uid, name },
      seq: Date.now(),
      timestamp: serverTimestamp(),
    });
  } catch {}
}

function playTone(tone: 'pop' | 'ding' | 'soft' | 'none') {
  if (tone === 'none') return;
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t = ctx.currentTime;
    if (tone === 'pop') {
      osc.type = 'square';
      osc.frequency.setValueAtTime(880, t);
      gain.gain.setValueAtTime(0.06, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      osc.start(t);
      osc.stop(t + 0.1);
    } else if (tone === 'ding') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1174.66, t);
      gain.gain.setValueAtTime(0.07, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      osc.start(t);
      osc.stop(t + 0.52);
    } else {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(659.25, t);
      gain.gain.setValueAtTime(0.05, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.start(t);
      osc.stop(t + 0.27);
    }
    setTimeout(() => ctx.close().catch(() => {}), 700);
  } catch {}
}

function playIncomingFeedback(tone: 'pop' | 'ding' | 'soft' | 'none') {
  playTone(tone);
  try {
    navigator.vibrate?.(tone === 'soft' ? 15 : 30);
  } catch {}
}

// ─── Date helpers ──────────────────────────────────────────────

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function isSameDay(a: number, b: number): boolean {
  return dayKey(new Date(a)) === dayKey(new Date(b));
}

function formatDayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (dayKey(d) === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) return 'Yesterday';
  const weekAgo = new Date(now);
  weekAgo.setDate(now.getDate() - 7);
  if (d > weekAgo) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function formatFullDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function DateSeparator({ ts }: { ts: number }) {
  return (
    <div className="flex items-center justify-center my-3 select-none">
      <span className="text-[10px] font-medium text-[#555] bg-[#161618] border border-[#2A2A2A] px-3 py-1 rounded-full">
        {formatDayLabel(ts)}
      </span>
    </div>
  );
}

function MentionDropdown({
  query,
  members,
  excludeUid,
  selectedIndex,
  onSelect,
  onIndexChange,
}: {
  query: string;
  members: { name: string; uid: string }[];
  excludeUid?: string | null;
  selectedIndex: number;
  onSelect: (name: string) => void;
  onIndexChange: (idx: number) => void;
}) {
  const filtered = members.filter(
    (m) => m.uid !== excludeUid && m.name.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      onIndexChange(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex, onIndexChange]);

  if (filtered.length === 0) return null;

  return (
    <div className="absolute bottom-20 left-4 right-4 max-h-48 bg-[#1C1C1E] border border-[#333] rounded-xl shadow-xl z-50 overflow-hidden">
      <div className="overflow-y-auto max-h-48">
        {filtered.map((member, idx) => (
          <button
            key={member.uid}
            onClick={() => onSelect(member.name)}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
              idx === selectedIndex ? 'bg-[#007AFF]/20 text-white' : 'text-[#B3B3B3] hover:bg-[#333]'
            }`}
          >
            <Avatar name={member.name || '?'} size="sm" />
            <span className="font-medium">@{member.name || '?'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SearchModal({
  roomCode,
  onJumpToMessage,
  onClose,
}: {
  roomCode: string;
  onJumpToMessage: (msgId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [senderFilter, setSenderFilter] = useState('');
  const [hasLink, setHasLink] = useState(false);
  const [hasImage, setHasImage] = useState(false);
  const [results, setResults] = useState<SearchIndexEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const q = query.trim().toLowerCase();
    if (!q && !senderFilter && !hasLink && !hasImage) {
      setResults([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const all = await localDB.searchIndex.where('roomCode').equals(roomCode).toArray();
        if (cancelled) return;
        const matches = all
          .filter((m) => {
            if (q && !m.text.toLowerCase().includes(q)) return false;
            if (senderFilter && !m.senderName.toLowerCase().includes(senderFilter.toLowerCase())) return false;
            if (hasLink && !/https?:\/\//.test(m.text)) return false;
            if (hasImage && !m.text.startsWith('data:image')) return false;
            return true;
          })
          .sort((a, b) => b.timestamp - a.timestamp);
        setTotal(matches.length);
        setResults(matches.slice(0, 50));
      } catch {
        if (!cancelled) setResults([]);
      }
      if (!cancelled) setLoading(false);
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, senderFilter, hasLink, hasImage, roomCode]);

  const highlight = (text: string, q: string) => {
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return text;
    const start = Math.max(0, idx - 25);
    const end = Math.min(text.length, idx + q.length + 25);
    const before = (start > 0 ? '…' : '') + text.slice(start, idx);
    const match = text.slice(idx, idx + q.length);
    const after = text.slice(idx + q.length, end) + (end < text.length ? '…' : '');
    return (
      <>
        {before}
        <mark className="bg-[#FF9F0A]/40 text-white rounded-sm">{match}</mark>
        {after}
      </>
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex flex-col max-w-md md:max-w-lg lg:max-w-xl mx-auto pointer-events-none">
        <div className="flex-1" onClick={onClose} />
        <div className="bg-[#1C1C1E] border border-[#333] border-b-0 rounded-t-2xl pointer-events-auto animate-fade-in flex flex-col max-h-[75vh]">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-[#333]">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-[#555] shrink-0">
              <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search messages..."
              className="flex-1 bg-transparent text-white placeholder-[#555] outline-none text-sm"
            />
            {loading && <span className="w-4 h-4 border-2 border-[#333] border-t-[#007AFF] rounded-full animate-spin shrink-0" />}
            <button onClick={onClose} className="text-[#555] hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-all shrink-0">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
            </button>
          </div>
          <div className="px-4 py-2 border-b border-[#333] flex flex-wrap gap-2">
            <input type="text" value={senderFilter} onChange={(e) => setSenderFilter(e.target.value)} placeholder="Filter by sender..." className="flex-1 min-w-[100px] bg-[#0D0D0D] text-white text-xs rounded-lg px-2 py-1.5 outline-none border border-[#333] placeholder-[#555]" />
            <label className="flex items-center gap-1.5 text-xs text-[#555] cursor-pointer"><input type="checkbox" checked={hasLink} onChange={(e) => setHasLink(e.target.checked)} className="rounded" /> Has link</label>
            <label className="flex items-center gap-1.5 text-xs text-[#555] cursor-pointer"><input type="checkbox" checked={hasImage} onChange={(e) => setHasImage(e.target.checked)} className="rounded" /> Has image</label>
          </div>
          <div className="overflow-y-auto">
            {query && results.length === 0 && !loading && (
              <div className="px-4 py-8 text-center text-xs text-[#555]">
                {total === 0 ? 'No matches found' : 'No results yet — messages are indexed as they load.'}
              </div>
            )}
            {!query && (
              <div className="px-4 py-8 text-center text-xs text-[#555]">
                Messages are indexed locally on this device as they load.
              </div>
            )}
            {results.map((r) => (
              <button
                key={r.msgId}
                onClick={() => onJumpToMessage(r.msgId)}
                className="w-full flex flex-col gap-0.5 px-4 py-2.5 text-left hover:bg-white/5 transition-colors border-b border-[#222]/60"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#00FF88] font-medium">{r.senderName}</span>
                  <span className="text-[9px] text-[#555]">{new Date(r.timestamp).toLocaleString()}</span>
                </div>
                <p className="text-xs text-[#ccc] truncate leading-snug">{highlight(r.text, query)}</p>
              </button>
            ))}
            {total > 50 && (
              <div className="px-4 py-3 text-center text-[10px] text-[#555]">
                Showing first 50 of {total} matches
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

const MessageItem = memo(function MessageItem({
  msg,
  isOwn,
  menuOpen,
  reactingOpen,
  userUid,
  formatTime,
  formatMessageTime,
  onReply,
  onEdit,
  onDelete,
  onToggleReaction,
  onVote,
  onMenuOpen,
  onReactingOpen,
  resolveName,
  avatarFor,
  prevSenderSame,
  replyCount,
  onJumpToMessage,
  onJumpToThread,
  blurWords,
  hasEffect,
  showLinkPreview,
  onViewOnce,
}: {
  msg: DecryptedMessage;
  isOwn: boolean;
  menuOpen: boolean;
  reactingOpen: boolean;
  userUid?: string;
  formatTime: (ts: number) => string;
  formatMessageTime: (ts: number) => string;
  onReply: (msg: DecryptedMessage) => void;
  onEdit: (msg: DecryptedMessage) => void;
  onDelete: (msgId: string) => void;
  onToggleReaction: (msgId: string, emoji: string) => void;
  onVote: (msgId: string, optionIndex: number) => void;
  onMenuOpen: (id: string | null) => void;
  onReactingOpen: (id: string | null) => void;
  resolveName: (uid: string) => string;
  avatarFor: (uid: string) => { emoji?: string; color?: string } | undefined;
  prevSenderSame?: boolean;
  replyCount?: number;
  onJumpToMessage: (id: string) => void;
  onJumpToThread: (rootId: string) => void;
  blurWords?: string[];
  hasEffect?: boolean;
  showLinkPreview?: boolean;
  onViewOnce?: (msgId: string) => void;
}) {
  const [hoveredReaction, setHoveredReaction] = useState<string | null>(null);
  const [revealedWords, setRevealedWords] = useState<Set<string>>(new Set());
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [swipeOpen, setSwipeOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const gestureRef = useRef({ startX: 0, startY: 0, active: false, locked: false });
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const movedRef = useRef(false);
  const isImage = msg.type === 'image';
  const isFile = msg.type === 'file';
  const isSys = msg.type === 'sys';
  const isPoll = msg.type === 'poll';
  const myAvatar = avatarFor(msg.senderUid);
  const linkPreview = msg.type === 'text' && msg.text ? (msg.text.match(/https?:\/\/[^\s]+/)?.[0] || null) : null;

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    };
  }, []);

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(msg.text);
    } catch {}
  };

  const closeSwipe = () => {
    setSwipeOpen(false);
    setSwipeOffset(0);
  };

  const onRowPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    gestureRef.current = { startX: e.clientX, startY: e.clientY, active: true, locked: false };
    movedRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      if (!movedRef.current && !swipeOpen) {
        onMenuOpen(msg.id);
      }
    }, 450);
  };

  const onRowPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g.active) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) movedRef.current = true;
    if (!g.locked && Math.abs(dy) > Math.abs(dx)) {
      g.locked = true;
      return;
    }
    if (g.locked) return;
    if (dx >= 0 && !swipeOpen) return;
    setDragging(true);
    const base = swipeOpen ? 84 : 0;
    setSwipeOffset(Math.max(0, Math.min(84, base - dx)));
  };

  const onRowPointerUp = () => {
    const g = gestureRef.current;
    if (!g.active) return;
    g.active = false;
    setDragging(false);
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (!g.locked) {
      setSwipeOpen(swipeOffset > 50);
    }
    setSwipeOffset(0);
  };

  const revealX = swipeOpen && !dragging ? 84 : swipeOffset;

  if (isSys) {
    const joined = msg.sys?.type === 'join';
    return (
      <div className="flex justify-center my-2.5">
        <div className={`flex items-center gap-1.5 text-[11px] px-3.5 py-1.5 rounded-full border ${joined ? 'text-[#00FF88]/80 border-[#00FF88]/15 bg-[#00FF88]/5' : 'text-[#FF9F0A]/80 border-[#FF9F0A]/15 bg-[#FF9F0A]/5'}`}>
          {joined ? '➕' : '🚫'}
          <span>
            <span className="font-medium">{msg.sys?.name}</span>
            {' '}{joined ? 'joined the room' : 'was removed'}
          </span>
          <span className="text-[#444]" title={formatFullDate(msg.timestamp)}>{formatTime(msg.timestamp)}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`relative ${dragging ? 'select-none' : ''} ${prevSenderSame ? 'mt-0.5' : 'mt-2'}`}
      style={{ touchAction: 'pan-y' }}
      onPointerDown={onRowPointerDown}
      onPointerMove={onRowPointerMove}
      onPointerUp={onRowPointerUp}
      onPointerLeave={onRowPointerUp}
      onPointerCancel={onRowPointerUp}
      onClick={() => { if (swipeOpen) closeSwipe(); }}
    >
      <button
        onClick={(e) => { e.stopPropagation(); closeSwipe(); onReply(msg); }}
        className={`absolute inset-y-0 right-0 w-[84px] flex items-center justify-center bg-[#00FF88]/15 border-l border-[#00FF88]/20 rounded-l-2xl transition-opacity ${swipeOpen || swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        title="Reply"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-[#00FF88]">
          <path fillRule="evenodd" d="M3.43 2.524A41.29 41.29 0 0 1 10 2c2.236 0 4.43.18 6.57.524 1.437.231 2.43 1.49 2.43 2.902v5.148c0 1.413-.993 2.67-2.43 2.902a41.202 41.202 0 0 1-5.183.501.78.78 0 0 0-.528.224l-3.579 3.58A.75.75 0 0 1 6 17.25v-3.443a41.033 41.033 0 0 1-2.57-.33C1.993 13.244 1 11.986 1 10.573V5.426c0-1.413.993-2.67 2.43-2.902Z" clipRule="evenodd" />
        </svg>
      </button>
      <div
        className={`flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}
        style={{
          transform: revealX ? `translateX(-${revealX}px)` : undefined,
          transition: dragging ? 'none' : 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      >
      {msg.deleted ? (
        <div className="max-w-[80%] px-3.5 py-2.5 rounded-2xl text-sm bg-[#111] text-[#555] italic border border-[#222]">
          Message deleted
        </div>
      ) : (
        <div className={`flex flex-col relative max-w-[80%] ${isOwn ? 'items-end' : 'items-start'}`}>
          {/* Sender info — only when sender changes */}
          {!prevSenderSame && !isPoll && (
          <div className={`flex items-center gap-1.5 mb-0.5 ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
            {!isOwn && <Avatar name={msg.senderName} size="sm" emoji={myAvatar?.emoji} color={myAvatar?.color} />}
            <span className="text-[11px] text-[#555] font-medium">{msg.senderName}</span>
            <span className="text-[9px] text-[#333]" title={formatFullDate(msg.timestamp)}>{formatMessageTime(msg.timestamp)}</span>
            {msg.edited && <span className="text-[9px] text-[#444]">edited</span>}
            {msg.burn && <span className="text-[9px] text-[#FF453A]" title="Burns 30s after sending">🔥</span>}
          </div>
          )}

          {msg.replyTo && (
            <div
              onClick={(e) => { e.stopPropagation(); onJumpToMessage(msg.replyTo!.messageId); }}
              className={`text-xs px-3 py-1.5 rounded-xl border border-[#333]/50 max-w-full mb-0.5 cursor-pointer hover:border-[#555] transition-colors ${
                isOwn ? 'rounded-br-sm bg-[#0055BB]/20' : 'rounded-bl-sm bg-[#222]'
              }`}
              title="Jump to original message"
            >
              <span className="text-[#00FF88] text-[10px] font-medium">@{msg.replyTo.senderName}</span>
              <p className="text-[#777] text-[11px] truncate mt-0.5">{msg.replyTo.text}</p>
            </div>
          )}

          {isPoll && msg.poll ? (
            <div className={`w-64 sm:w-72 rounded-2xl border border-[#333]/60 p-3.5 shadow-lg bg-[#1C1C1E] ${isOwn ? 'rounded-br-sm' : 'rounded-bl-sm'}`}>
              <div className="flex items-center justify-between gap-2 mb-0.5">
                <p className="text-sm font-semibold text-white leading-snug">{msg.poll.question}</p>
                {msg.burn && <span className="text-[10px] text-[#FF453A] shrink-0" title="Burns 30s after sending">🔥</span>}
              </div>
              <div className="flex items-center gap-2 mb-3">
                {!isOwn && <Avatar name={msg.senderName} size="xs" emoji={myAvatar?.emoji} color={myAvatar?.color} />}
                <span className="text-[11px] text-[#555]">{msg.senderName}</span>
                <span className="text-[9px] text-[#444]" title={formatFullDate(msg.timestamp)}>{formatMessageTime(msg.timestamp)}</span>
              </div>
              <div className="space-y-1.5">
                {msg.poll.options.map((opt, idx) => {
                  const voters = Array.isArray(opt.voters) ? opt.voters : [];
                  const totalVotes = msg.poll!.options.reduce((s, o) => s + (Array.isArray(o.voters) ? o.voters.length : 0), 0);
                  const count = voters.length;
                  const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
                  const voted = voters.includes(userUid || '');
                  return (
                    <button
                      key={idx}
                      onClick={() => onVote(msg.id, idx)}
                      className={`relative w-full text-left px-3 py-2 rounded-xl border transition-all overflow-hidden ${
                        voted
                          ? 'border-[#007AFF]/60 bg-[#007AFF]/10'
                          : 'border-[#2A2A2A] bg-[#0D0D0D] hover:border-[#444]'
                      }`}
                    >
                      {count > 0 && (
                        <div
                          className="absolute inset-y-0 left-0 bg-[#007AFF]/15 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      )}
                      <div className="relative flex items-center gap-2">
                        <span className="flex-1 text-xs text-[#E5E5E5] truncate">{opt.text}</span>
                        <span className={`text-[11px] font-medium ${voted ? 'text-[#007AFF]' : 'text-[#666]'}`}>
                          {count > 0 ? `${count} · ${pct}%` : '0'}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-[#555] mt-2.5">
                {msg.poll.options.reduce((s, o) => s + (Array.isArray(o.voters) ? o.voters.length : 0), 0)} vote{msg.poll.options.reduce((s, o) => s + (Array.isArray(o.voters) ? o.voters.length : 0), 0) !== 1 ? 's' : ''} · tap to vote
              </p>
            </div>
          ) : (
          <div className={`relative group ${isImage || isFile ? '' : 'max-w-full'}`} onClick={() => onMenuOpen(msg.id)}>
            {isImage ? (
              msg.viewOnce && msg.viewedBy?.includes(userUid || '') && msg.senderUid !== userUid ? (
                <div className="px-3.5 py-2.5 rounded-2xl text-sm bg-[#111] text-[#555] italic border border-[#222] flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" /><path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 0 1 0-1.18l3.11-4.944A1.5 1.5 0 0 1 5.05 3.75h9.9a1.5 1.5 0 0 1 1.278.72l3.11 4.944a1.651 1.651 0 0 1 0 1.18l-3.11 4.944A1.5 1.5 0 0 1 14.95 16.25H5.05a1.5 1.5 0 0 1-1.278-.72L.664 10.59ZM10 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" clipRule="evenodd" /></svg>
                  Viewed
                </div>
              ) : msg.text.startsWith('data:image/') ? (
                <div
                  className={`max-w-full rounded-2xl overflow-hidden border border-[#333]/50 shadow-lg ${
                    isOwn ? 'rounded-br-sm' : 'rounded-bl-sm'
                  }`}
                >
                  <img
                    src={msg.text}
                    alt="Shared image"
                    className="w-full h-auto max-h-72 object-cover cursor-zoom-in"
                    loading="lazy"
                    onClick={(e) => {
                      e.stopPropagation();
                      (window as any).chatrixLightbox?.(msg.text);
                      if (msg.viewOnce && msg.senderUid !== userUid && !msg.viewedBy?.includes(userUid || '')) {
                        onViewOnce?.(msg.id);
                      }
                    }}
                  />
                  {msg.viewOnce && <div className="px-2 py-1 bg-black/70 text-[10px] text-white flex items-center gap-1"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" /><path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 0 1 0-1.18l3.11-4.944A1.5 1.5 0 0 1 5.05 3.75h9.9a1.5 1.5 0 0 1 1.278.72l3.11 4.944a1.651 1.651 0 0 1 0 1.18l-3.11 4.944A1.5 1.5 0 0 1 14.95 16.25H5.05a1.5 1.5 0 0 1-1.278-.72L.664 10.59ZM10 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" clipRule="evenodd" /></svg> View once</div>}
                </div>
              ) : (
                <div className="px-3.5 py-2.5 rounded-2xl text-sm bg-[#1C1C1E] text-[#777] border border-[#2A2A2A]">
                  Invalid image data
                </div>
              )
            ) : isFile ? (
              msg.text.startsWith('data:') ? (
              <a
                href={msg.text}
                download={msg.file?.name || 'file'}
                className={`flex items-center gap-3 px-4 py-3 rounded-2xl border transition-colors shadow-sm ${
                  isOwn
                    ? 'bg-[#007AFF] text-white border-[#007AFF]/50 rounded-br-sm hover:bg-[#0066DD]'
                    : 'bg-[#1C1C1E] text-[#E5E5E5] border-[#2A2A2A] rounded-bl-sm hover:bg-[#252525]'
                }`}
                title="Download file"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 shrink-0 opacity-80">
                  <path d="M12 1.5a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-1.5 0v-7.5A.75.75 0 0 1 12 1.5ZM11.25 9.75v-.75h1.5v.75h-1.5Z" />
                  <path fillRule="evenodd" d="M4.5 9.75a6 6 0 0 1 11.573-2.226 3.75 3.75 0 0 1 4.133 4.303A4.5 4.5 0 0 1 18 20.25H6.75a5.25 5.25 0 0 1-2.23-10.04A6.02 6.02 0 0 1 4.5 9.75Zm4.5 4.5a.75.75 0 0 0 0 1.5h6a.75.75 0 0 0 0-1.5H9Zm0 3a.75.75 0 0 0 0 1.5h4a.75.75 0 0 0 0-1.5H9Z" clipRule="evenodd" />
                </svg>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{msg.file?.name || 'File'}</p>
                  <p className={`text-xs mt-0.5 ${isOwn ? 'text-white/60' : 'text-[#777]'}`}>
                    {formatFileSize(msg.file?.size || 0)}
                  </p>
                </div>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-5 h-5 shrink-0 ${isOwn ? 'text-white/70' : 'text-[#666]'}`}>
                  <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z" />
                  <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z" />
                </svg>
              </a>
              ) : (
                <div className="px-3.5 py-2.5 rounded-2xl text-sm bg-[#1C1C1E] text-[#777] border border-[#2A2A2A]">
                  Invalid file data
                </div>
              )
            ) : (
              <div
                className={`max-w-full px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed break-words shadow-sm ${
                  isOwn
                    ? 'bg-[#007AFF] text-white rounded-br-sm'
                    : 'bg-[#1C1C1E] text-[#E5E5E5] rounded-bl-sm border border-[#2A2A2A]'
                }`}
              >
                <RichText
                  text={msg.text}
                  blurWords={blurWords}
                  revealed={revealedWords}
                  onToggleReveal={(w) => {
                    setRevealedWords((prev) => {
                      const next = new Set(prev);
                      if (next.has(w)) next.delete(w);
                      else next.add(w);
                      return next;
                    });
                  }}
                />
              </div>
            )}

            {linkPreview && showLinkPreview !== false && (
              <a
                href={linkPreview}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="mt-1 flex items-center gap-2.5 rounded-xl border border-[#333] bg-black/30 px-3 py-2 hover:bg-black/50 transition-colors max-w-full"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-4 h-4 shrink-0 ${isOwn ? 'text-white/70' : 'text-[#666]'}`}>
                  <path d="M12.232 4.232a2.5 2.5 0 0 1 3.536 3.536l-1.225 1.224a.75.75 0 0 0 1.061 1.06l1.224-1.224a4 4 0 0 0-5.656-5.656l-3 3a4 4 0 0 0 .225 5.865.75.75 0 0 0 .977-1.138 2.5 2.5 0 0 1-.142-3.667l3-3Z" />
                  <path d="M11.603 7.963a.75.75 0 0 0-.977 1.138 2.5 2.5 0 0 1 .142 3.667l-3 3a2.5 2.5 0 0 1-3.536-3.536l1.225-1.224a.75.75 0 0 0-1.061-1.06l-1.224 1.224a4 4 0 1 0 5.656 5.656l3-3a4 4 0 0 0-.225-5.865Z" />
                </svg>
                <span className="flex-1 min-w-0">
                  <span className={`block text-xs font-medium truncate ${isOwn ? 'text-white/90' : 'text-[#ccc]'}`}>
                    {(() => { try { return new URL(linkPreview).hostname; } catch { return linkPreview; } })()}
                  </span>
                  <span className={`block text-[11px] truncate ${isOwn ? 'text-white/60' : 'text-[#666]'}`}>{linkPreview}</span>
                </span>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-4 h-4 shrink-0 ${isOwn ? 'text-white/60' : 'text-[#555]'}`}>
                  <path fillRule="evenodd" d="M4.25 5.5a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75v-4a.75.75 0 0 1 1.5 0v4A2.25 2.25 0 0 1 12.75 17h-8.5A2.25 2.25 0 0 1 2 14.75v-8.5A2.25 2.25 0 0 1 4.25 4h5a.75.75 0 0 1 0 1.5h-5Z" clipRule="evenodd" />
                  <path fillRule="evenodd" d="M6.194 12.753a.75.75 0 0 0 1.06.053L16.5 4.44v2.81a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.553l-9.056 8.194a.75.75 0 0 0-.053 1.06Z" clipRule="evenodd" />
                </svg>
              </a>
            )}

            {hasEffect && (
              <div className="pointer-events-none absolute -top-3 left-1/2 -translate-x-1/2 z-10">
                {['🎉', '✨', '💖', '🎊', '⭐', '🎈'].map((e, i) => (
                  <span
                    key={i}
                    className="absolute text-sm animate-burst"
                    style={{
                      left: `${(i - 2.5) * 14}px`,
                      ['--dx' as any]: `${(i - 2.5) * 55}px`,
                      ['--dy' as any]: `-${55 + (i % 3) * 15}px`,
                      animationDelay: `${i * 90}ms`,
                    }}
                  >
                    {e}
                  </span>
                ))}
              </div>
            )}

            {/* Three-dot menu — tap to show on PWA, hover on desktop */}
            <div className={`absolute ${isOwn ? 'left-0 -translate-x-full -ml-1' : 'right-0 translate-x-full mr-1'} top-0 ${menuOpen ? 'opacity-100' : 'opacity-60 sm:opacity-0 sm:group-hover:opacity-100'} transition-opacity z-10`}>
              <button
                onClick={() => onMenuOpen(menuOpen ? null : msg.id)}
                className="text-[#888] hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-all bg-[#0D0D0D] border border-[#222] shadow-lg"
                title="More"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path d="M10 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM10 8.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM10 14a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z" />
                </svg>
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => onMenuOpen(null)} />
                  <div className={`absolute z-40 min-w-[160px] bg-[#1C1C1E] border border-[#333] rounded-xl shadow-2xl py-1 ${isOwn ? 'top-8 left-0' : 'top-8 right-0'}`}>
                    <button
                      onClick={() => { onMenuOpen(null); onReply(msg); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#ccc] hover:bg-white/5 transition-colors"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M3.43 2.524A41.29 41.29 0 0 1 10 2c2.236 0 4.43.18 6.57.524 1.437.231 2.43 1.49 2.43 2.902v5.148c0 1.413-.993 2.67-2.43 2.902a41.202 41.202 0 0 1-5.183.501.78.78 0 0 0-.528.224l-3.579 3.58A.75.75 0 0 1 6 17.25v-3.443a41.033 41.033 0 0 1-2.57-.33C1.993 13.244 1 11.986 1 10.573V5.426c0-1.413.993-2.67 2.43-2.902Z" clipRule="evenodd" /></svg>
                      Reply
                    </button>
                    <button
                      onClick={() => { onMenuOpen(null); onReactingOpen(reactingOpen ? null : msg.id); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#ccc] hover:bg-white/5 transition-colors"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.811.71 1.45 1.438 1.016l4.085-2.52 4.085 2.52c.728.434 1.632-.205 1.438-1.016l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z" /></svg>
                      React
                    </button>
                    {msg.type === 'text' && msg.text && (
                      <button
                        onClick={() => { onMenuOpen(null); copyMessage(); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#ccc] hover:bg-white/5 transition-colors"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M13.887 3.182c.396.037.79.08 1.183.128C16.194 3.45 17 4.414 17 5.517V16.75A2.25 2.25 0 0 1 14.75 19h-9.5A2.25 2.25 0 0 1 3 16.75V5.517c0-1.103.806-2.068 1.93-2.207a41.758 41.758 0 0 1 1.183-.128 9.622 9.622 0 0 1 1.17-.123V3.25A2.25 2.25 0 0 1 9.5 1h1a2.25 2.25 0 0 1 2.25 2.25v.09c.396.023.79.07 1.137.125ZM10.25 2.5a.75.75 0 0 0-.75.75v.09c.575.024 1.148.077 1.75.15v-.24a.75.75 0 0 0-.75-.75h-1ZM5.417 4.933c.356-.041.718-.063 1.083-.073v.84a.75.75 0 0 0 1.5 0V4.86c.398.014.796.035 1.19.063a52.28 52.28 0 0 1 1.19.063v.887a.75.75 0 0 0 1.5 0v-.88c.398.03.79.068 1.177.112.768.087 1.343.728 1.343 1.488V16.75a.75.75 0 0 1-.75.75h-9.5a.75.75 0 0 1-.75-.75V5.517c0-.76.575-1.401 1.343-1.488Z" clipRule="evenodd" /></svg>
                        Copy
                      </button>
                    )}
                    <button
                      onClick={() => { onMenuOpen(null); (window as any).chatrixForward?.(msg); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#ccc] hover:bg-white/5 transition-colors"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path d="M12.5 2.75a.75.75 0 0 0-1.5 0v2.5H9.5a.75.75 0 0 0 0 1.5h1.5v2.5a.75.75 0 0 0 1.5 0v-7.5Z" /><path d="M3.5 9.5A1.5 1.5 0 0 1 5 8h7a1.5 1.5 0 0 1 1.5 1.5v1A1.5 1.5 0 0 1 12 12H5a1.5 1.5 0 0 1-1.5-1.5v-1Z" /></svg>
                      Forward
                    </button>
                    {!isOwn && (
                      <>
                        <button
                          onClick={() => { onMenuOpen(null); (window as any).chatrixMute?.(msg.senderUid); }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#ccc] hover:bg-white/5 transition-colors"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path d="M5.5 9.5a4.5 4.5 0 0 1 9 0v3.5a.75.75 0 0 1-1.5 0V9.5a3 3 0 1 0-6 0v3.5a.75.75 0 0 1-1.5 0V9.5Z" /><path d="M4.22 4.22a.75.75 0 0 1 1.06 0l12 12a.75.75 0 1 1-1.06 1.06l-12-12a.75.75 0 0 1 0-1.06Z" /></svg>
                          Mute
                        </button>
                        <button
                          onClick={() => { onMenuOpen(null); (window as any).chatrixReport?.(msg); }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#FF9500] hover:bg-white/5 transition-colors"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.88 11.918c.673 1.167-.17 2.625-1.516 2.625H3.12c-1.346 0-2.189-1.458-1.515-2.625l6.88-11.918ZM10 6.5a.75.75 0 0 1 .75.75v4a.75.75 0 0 1-1.5 0v-4A.75.75 0 0 1 10 6.5Zm0 7a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" clipRule="evenodd" /></svg>
                          Report
                        </button>
                      </>
                    )}
                    {msg.editHistory && msg.editHistory.length > 0 && (
                      <button
                        onClick={() => { onMenuOpen(null); (window as any).chatrixHistory?.(msg); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#ccc] hover:bg-white/5 transition-colors"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-13a.75.75 0 0 0-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 0 0 0-1.5h-3.25V5Z" clipRule="evenodd" /></svg>
                        History
                      </button>
                    )}
                    {isOwn && (
                      <button
                        onClick={() => { onMenuOpen(null); onEdit(msg); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#ccc] hover:bg-white/5 transition-colors"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path d="m5.433 13.917 1.262-3.155A4 4 0 0 1 7.58 9.42l6.92-6.918a2.121 2.121 0 0 1 3 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 0 1-.65-.65Z" /><path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0 0 10 3H4.75A2.75 2.75 0 0 0 2 5.75v9.5A2.75 2.75 0 0 0 4.75 18h9.5A2.75 2.75 0 0 0 17 15.25V10a.75.75 0 0 0-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5Z" /></svg>
                        Edit
                      </button>
                    )}
                    {isOwn && (
                      <button
                        onClick={() => onDelete(msg.id)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-white/5 transition-colors"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c-.84 0-1.673.025-2.5.075V3.75c0-.69.56-1.25 1.25-1.25h2.5c.69 0 1.25.56 1.25 1.25v.325C11.673 4.025 10.84 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.42.06a.75.75 0 0 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clipRule="evenodd" /></svg>
                        Delete
                      </button>
                    )}
                  </div>
                </>
              )}
              {reactingOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => onReactingOpen(null)} />
                  <div className={`absolute z-20 flex gap-1 p-2 bg-[#1C1C1E] border border-[#333] rounded-xl shadow-xl ${isOwn ? 'top-0 left-0 ml-1' : 'top-0 right-0 mr-1'}`}>
                    {['😀','❤️','🔥','😂','👍','🎉','😢','😡'].map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => { onToggleReaction(msg.id, emoji); onReactingOpen(null); }}
                        className="text-lg hover:scale-125 transition-transform p-1"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          )}

          {msg.reactions && Object.keys(msg.reactions).length > 0 && (
            <div className={`flex flex-wrap gap-1 mt-1 ${isOwn ? 'justify-end' : 'justify-start'}`}>
              {Object.entries(msg.reactions)
                .filter(([, u]) => Array.isArray(u))
                .map(([emoji, uids]) => (
                <div key={emoji} className="relative">
                  <button
                    onClick={() => onToggleReaction(msg.id, emoji)}
                    onMouseEnter={() => setHoveredReaction(emoji)}
                    onMouseLeave={() => setHoveredReaction(null)}
                    className={`text-[11px] flex items-center gap-1 px-1.5 py-0.5 rounded-full border transition-colors ${
                      uids.includes(userUid || '')
                        ? 'bg-[#007AFF]/20 border-[#007AFF]/40 text-white'
                        : 'bg-[#1C1C1E] border-[#333] text-[#999] hover:bg-[#252525]'
                    }`}
                  >
                    <span>{emoji}</span>
                    <span>{uids.length}</span>
                  </button>
                  {hoveredReaction === emoji && uids.length > 0 && (
                    <div className={`absolute bottom-full mb-2 z-30 min-w-[120px] bg-[#1C1C1E] border border-[#333] rounded-lg shadow-xl py-1.5 px-2 ${isOwn ? 'right-0' : 'left-0'}`}>
                      <div className="text-[11px] text-[#999] font-medium mb-1">{emoji} · {uids.length}</div>
                      {uids.map((uid) => (
                        <div key={uid} className="text-xs text-[#ccc] py-0.5">{resolveName(uid)}</div>
                      ))}
                      <div className={`absolute top-full ${isOwn ? 'right-2' : 'left-2'} w-2 h-2 bg-[#1C1C1E] border-r border-b border-[#333] rotate-45 -mt-1`} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {isOwn && (msg.readerUids ?? []).length > 0 && (
            <div
              className="mt-1 flex flex-row items-center justify-end gap-1.5"
              title={`Seen by ${msg.readerUids!.map((uid) => resolveName(uid) || uid.slice(0, 6)).join(', ')}`}
            >
              <span className="text-[10px] text-[#555] hidden sm:inline">Seen</span>
              <div className="flex flex-row items-center -space-x-1.5 flex-nowrap">
                {msg.readerUids!.slice(0, 5).map((uid) => {
                  const av = avatarFor(uid);
                  const name = resolveName(uid) || uid.slice(0, 6);
                  return (
                    <div key={uid} className="rounded-full ring-2 ring-black overflow-hidden shrink-0" title={name}>
                      <Avatar name={name} size="xs" emoji={av?.emoji} color={av?.color} />
                    </div>
                  );
                })}
              </div>
              {msg.readerUids!.length > 5 && (
                <span className="text-[10px] text-[#777]">+{msg.readerUids!.length - 5}</span>
              )}
            </div>
          )}

          {!msg.replyTo && replyCount && replyCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); onJumpToThread(msg.id); }}
              className="mt-1 flex items-center gap-1 text-[10px] text-[#007AFF] hover:opacity-80 transition-opacity px-1"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                <path fillRule="evenodd" d="M3.43 2.524A41.29 41.29 0 0 1 10 2c2.236 0 4.43.18 6.57.524 1.437.231 2.43 1.49 2.43 2.902v5.148c0 1.413-.993 2.67-2.43 2.902a41.202 41.202 0 0 1-5.183.501.78.78 0 0 0-.528.224l-3.579 3.58A.75.75 0 0 1 6 17.25v-3.443a41.033 41.033 0 0 1-2.57-.33C1.993 13.244 1 11.986 1 10.573V5.426c0-1.413.993-2.67 2.43-2.902Z" clipRule="evenodd" />
              </svg>
              {replyCount} repl{replyCount === 1 ? 'y' : 'ies'}
            </button>
          )}
        </div>
      )}
      </div>
    </div>
  );
});

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function compressImage(dataUrl: string, maxDim: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        const ratio = Math.min(maxDim / w, maxDim / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}
