import { useEffect, useCallback, useRef, useState } from 'react';
import {
  doc,
  onSnapshot,
  collection,
  query,
  orderBy,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  addDoc,
  getDoc,
  getDocs,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { swSend } from '../lib/sw';
import { useStore } from '../store/useStore';
import type { CallParticipant, CallInvitation } from '../types';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

function setOpusBitrate(sdp: string, bitrate: number = 64000): string {
  return sdp.replace(/a=fmtp:111 (.*)\r\n/g, (match, params) => {
    if (params.includes('maxaveragebitrate')) return match;
    return `a=fmtp:111 ${params};maxaveragebitrate=${bitrate}\r\n`;
  });
}

export function useVoiceCall(roomCode: string | undefined) {
  const {
    user,
    callState,
    setCallState,
    callParticipants,
    setCallParticipants,
    inCall,
    setInCall,
    micEnabled,
    setMicEnabled,
    setCallInvitations,
  } = useStore();
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteAudioRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const unsubsRef = useRef<Map<string, (() => void)[]>>(new Map());
  const connectingRef = useRef(false);
  const [screenShareUid, setScreenShareUid] = useState<string | null>(null);
  const [remoteScreens, setRemoteScreens] = useState<{ uid: string; stream: MediaStream }[]>([]);
  const [sharingScreen, setSharingScreen] = useState(false);

  const addUnsub = useCallback((uid: string, fn: () => void) => {
    const arr = unsubsRef.current.get(uid) ?? [];
    arr.push(fn);
    unsubsRef.current.set(uid, arr);
  }, []);

  // Listen for call state changes
  useEffect(() => {
    if (!roomCode) return;
    const callRef = doc(db, 'rooms', roomCode, 'calls', 'current');
    const unsub = onSnapshot(callRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.active) {
          setCallState({
            active: data.active,
            initiatorUid: data.initiatorUid,
            initiatorName: data.initiatorName,
            startTime: data.startTime?.toMillis() ?? Date.now(),
            room: `room-${roomCode}`,
            participantCount: data.participantCount ?? 0,
          });
          setScreenShareUid(data.screenShareUid ?? null);
        } else {
          setCallState(null);
          setScreenShareUid(null);
        }
      } else {
        setCallState(null);
        setScreenShareUid(null);
      }
    });
    return unsub;
  }, [roomCode, setCallState]);

  // Prune remote videos when the sharer changes or stops
  useEffect(() => {
    if (!screenShareUid) {
      setRemoteScreens((prev) => {
        for (const s of prev) {
          try { s.stream.getTracks().forEach((t) => t.stop()); } catch {}
        }
        return [];
      });
    } else {
      setRemoteScreens((prev) => {
        const keep = prev.filter((s) => s.uid === screenShareUid);
        const removed = prev.filter((s) => s.uid !== screenShareUid);
        for (const s of removed) {
          try { s.stream.getTracks().forEach((t) => t.stop()); } catch {}
        }
        return keep;
      });
    }
  }, [screenShareUid]);

  // Listen for participants
  useEffect(() => {
    if (!roomCode) return;
    const participantsRef = collection(db, 'rooms', roomCode, 'calls', 'current', 'participants');
    const q = query(participantsRef, orderBy('joinedAt', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      const list: CallParticipant[] = [];
      snap.forEach((d) => {
        const data = d.data();
        list.push({
          uid: d.id,
          name: data.name,
          muted: data.muted ?? false,
          joinedAt: data.joinedAt?.toMillis() ?? Date.now(),
        });
      });
      setCallParticipants(list);
    });
    return unsub;
  }, [roomCode, setCallParticipants]);

  // Listen for invitations to me
  useEffect(() => {
    if (!roomCode || !user) return;
    const invitesRef = collection(db, 'rooms', roomCode, 'calls', 'current', 'invitations');
    const unsub = onSnapshot(query(invitesRef), (snap) => {
      const invites: CallInvitation[] = [];
      snap.forEach((d) => {
        const data = d.data();
        if (data.targetUid === user.uid) {
          invites.push({
            inviterUid: data.inviterUid,
            inviterName: data.inviterName,
            timestamp: data.timestamp?.toMillis() ?? Date.now(),
          });
        }
      });
      setCallInvitations(invites);
    });
    return unsub;
  }, [roomCode, user, setCallInvitations]);

  const cleanupPeer = useCallback((targetUid: string) => {
    const pc = peersRef.current.get(targetUid);
    if (pc) {
      try { pc.close(); } catch {}
      peersRef.current.delete(targetUid);
    }
    const audioEl = remoteAudioRef.current.get(targetUid);
    if (audioEl) {
      try {
        audioEl.pause();
        audioEl.srcObject = null;
        audioEl.remove();
      } catch {}
      remoteAudioRef.current.delete(targetUid);
    }
    const arr = unsubsRef.current.get(targetUid);
    if (arr) {
      for (const fn of arr) {
        try { fn(); } catch {}
      }
      unsubsRef.current.delete(targetUid);
    }
    setRemoteScreens((prev) => {
      const removed = prev.filter((s) => s.uid === targetUid);
      for (const s of removed) {
        try { s.stream.getTracks().forEach((t) => t.stop()); } catch {}
      }
      return prev.filter((s) => s.uid !== targetUid);
    });
  }, []);

  function listenForAnswer(targetUid: string, pairId: string, pc: RTCPeerConnection) {
    if (!roomCode) return;
    const pairRef = doc(db, 'rooms', roomCode, 'calls', 'current', 'p2p', pairId);
    const unsub = onSnapshot(pairRef, (snap) => {
      if (!snap.exists() || pc.signalingState === 'closed') return;
      const data = snap.data();
      if (data.answer && pc.signalingState === 'have-local-offer') {
        try {
          pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.answer)));
        } catch {}
      }
    });
    const arr = unsubsRef.current.get(targetUid) ?? [];
    arr.push(unsub);
    unsubsRef.current.set(targetUid, arr);
  }

  const renegotiate = useCallback(
    async (targetUid: string) => {
      const pc = peersRef.current.get(targetUid);
      if (!pc || !roomCode || !user || pc.signalingState !== 'stable') return;
      const pairId = getPairId(user.uid, targetUid);
      try {
        const offer = await pc.createOffer();
        offer.sdp = setOpusBitrate(offer.sdp!);
        await pc.setLocalDescription(offer);
        const pairRef = doc(db, 'rooms', roomCode, 'calls', 'current', 'p2p', pairId);
        await setDoc(pairRef, { offer: JSON.stringify(pc.localDescription), answer: null }, { merge: true });
        listenForAnswer(targetUid, pairId, pc);
      } catch {}
    },
    [roomCode, user]
  );

  const stopScreenShare = useCallback(async () => {
    const stream = screenStreamRef.current;
    if (stream) {
      for (const pc of peersRef.current.values()) {
        const senders = pc.getSenders().filter((s) => s.track && stream.getTracks().includes(s.track!));
        for (const sender of senders) {
          try {
            if (typeof (sender as any).replaceTrack === 'function') {
              await (sender as any).replaceTrack(null);
            } else {
              pc.removeTrack(sender);
            }
          } catch {}
        }
      }
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      screenStreamRef.current = null;
    }
    setSharingScreen(false);
    if (roomCode) {
      try {
        await updateDoc(doc(db, 'rooms', roomCode, 'calls', 'current'), { screenShareUid: null });
      } catch {}
    }
    for (const [uid, pc] of peersRef.current) {
      if (pc.signalingState === 'stable') {
        await renegotiate(uid).catch(() => {});
      }
    }
  }, [roomCode, renegotiate]);

  const startScreenShare = useCallback(async (): Promise<boolean> => {
    if (!roomCode || !user) return false;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const track = stream.getVideoTracks()[0];
      if (!track) {
        try { stream.getTracks().forEach((t) => t.stop()); } catch {}
        return false;
      }
      screenStreamRef.current = stream;
      track.onended = () => { stopScreenShare(); };
      for (const [, pc] of peersRef.current) {
        try { pc.addTrack(track, stream); } catch {}
      }
      await setDoc(doc(db, 'rooms', roomCode, 'calls', 'current'), { screenShareUid: user.uid }, { merge: true });
      setSharingScreen(true);
      for (const [uid, pc] of peersRef.current) {
        if (pc.signalingState === 'stable') {
          await renegotiate(uid).catch(() => {});
        }
      }
      return true;
    } catch {
      return false;
    }
  }, [roomCode, user, renegotiate, stopScreenShare]);

  // Listen for incoming offers when in call
  useEffect(() => {
    if (!roomCode || !user || !inCall || !localStreamRef.current) return;

    const p2pRef = collection(db, 'rooms', roomCode, 'calls', 'current', 'p2p');
    const unsub = onSnapshot(p2pRef, (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== 'added' && change.type !== 'modified') continue;
        const data = change.doc.data();
        if (!data || !data.offer) continue;

        const uidA = data.uidA;
        const uidB = data.uidB;
        const otherUid = uidA === user.uid ? uidB : uidA;
        if (!otherUid || otherUid === user.uid) continue;

        const existingPc = peersRef.current.get(otherUid);

        // Re-offer (track renegotiation, e.g. screen share): answer if we can
        if (existingPc && data.offer && !data.answer) {
          let offerSdp = '';
          try { offerSdp = JSON.parse(data.offer).sdp ?? data.offer; } catch { offerSdp = data.offer; }
          const currentSdp = (() => {
            try { return (existingPc.currentRemoteDescription as any)?.sdp ?? ''; } catch { return ''; }
          })();
          if (
            existingPc.signalingState === 'stable' &&
            offerSdp !== currentSdp
          ) {
            (async () => {
              try {
                await existingPc.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.offer)));
                const answer = await existingPc.createAnswer();
                answer.sdp = setOpusBitrate(answer.sdp!);
                await existingPc.setLocalDescription(answer);
                const pairRef = doc(db, 'rooms', roomCode, 'calls', 'current', 'p2p', change.doc.id);
                await setDoc(pairRef, { answer: JSON.stringify(existingPc.localDescription) }, { merge: true });
              } catch {}
            })();
          }
          continue;
        }

        if (existingPc) continue;

        // Rule: higher UID waits for offer, lower UID creates offer.
        // If we are the higher UID and there's an offer from the lower UID, answer it.
        if (user.uid > otherUid && data.offer && !data.answer) {
          handleOffer(otherUid, data.offer, change.doc.id);
        }
      }
    });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, user, inCall]);

  const createPeerConnection = useCallback(
    (targetUid: string): RTCPeerConnection | null => {
      if (!roomCode || !user || !localStreamRef.current) return null;
      if (peersRef.current.has(targetUid)) return peersRef.current.get(targetUid)!;

      const stream = localStreamRef.current;
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      stream.getTracks().forEach((track) => {
        try { pc.addTrack(track, stream); } catch {}
      });
      // Also add current screen share track if we are sharing
      if (screenStreamRef.current) {
        for (const t of screenStreamRef.current.getVideoTracks()) {
          try { pc.addTrack(t, screenStreamRef.current!); } catch {}
        }
      }

      pc.onicecandidate = (e) => {
        if (e.candidate && roomCode && user) {
          const pairId = getPairId(user.uid, targetUid);
          addDoc(
            collection(db, 'rooms', roomCode, 'calls', 'current', 'p2p', pairId, 'candidates'),
            {
              from: user.uid,
              to: targetUid,
              candidate: JSON.stringify(e.candidate),
            }
          ).catch(() => {});
        }
      };

      pc.ontrack = (e) => {
        const track = e.track;
        const stream = e.streams[0] ?? new MediaStream([track]);
        if (track.kind === 'video') {
          setRemoteScreens((prev) => {
            const next = prev.filter((s) => s.uid !== targetUid);
            return [...next, { uid: targetUid, stream }];
          });
          track.onended = () => {
            setRemoteScreens((prev) => prev.filter((s) => s.uid !== targetUid));
          };
          track.onmute = () => {};
          return;
        }
        let audioEl = remoteAudioRef.current.get(targetUid);
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.autoplay = true;
          (audioEl as any).playsInline = true;
          audioEl.hidden = true;
          document.body.appendChild(audioEl);
          remoteAudioRef.current.set(targetUid, audioEl);
        }
        audioEl.srcObject = stream;
        audioEl.play().catch(() => {});
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
          cleanupPeer(targetUid);
        }
      };

      peersRef.current.set(targetUid, pc);
      return pc;
    },
    [roomCode, user, cleanupPeer]
  );

  const handleOffer = useCallback(
    async (fromUid: string, offerSdp: string, _pairId?: string) => {
      if (!roomCode || !user || !localStreamRef.current) return;
      if (peersRef.current.has(fromUid)) return;

      const pc = createPeerConnection(fromUid);
      if (!pc) return;

      const pairId = _pairId || getPairId(user.uid, fromUid);

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(offerSdp)));
        const answer = await pc.createAnswer();
        answer.sdp = setOpusBitrate(answer.sdp!);
        await pc.setLocalDescription(answer);

        const pairRef = doc(db, 'rooms', roomCode, 'calls', 'current', 'p2p', pairId);
        await setDoc(pairRef, { answer: JSON.stringify(pc.localDescription) }, { merge: true });

        listenForCandidates(fromUid, pairId, pc);
      } catch {}
    },
    [roomCode, user, createPeerConnection]
  );

  const connectToPeer = useCallback(
    async (targetUid: string) => {
      if (!roomCode || !user || !localStreamRef.current) return;
      if (peersRef.current.has(targetUid) || targetUid === user.uid) return;

      // Lower UID creates offer; if we're higher UID, wait
      if (user.uid > targetUid) return;

      const pc = createPeerConnection(targetUid);
      if (!pc) return;

      const pairId = getPairId(user.uid, targetUid);
      const pairRef = doc(db, 'rooms', roomCode, 'calls', 'current', 'p2p', pairId);

      try {
        const offer = await pc.createOffer();
        offer.sdp = setOpusBitrate(offer.sdp!);
        await pc.setLocalDescription(offer);
        await setDoc(pairRef, {
          uidA: user.uid,
          uidB: targetUid,
          offer: JSON.stringify(pc.localDescription),
          answer: null,
        });

        const unsub = onSnapshot(pairRef, (snap) => {
          if (!snap.exists()) return;
          const data = snap.data();
          if (data.answer && pc.signalingState === 'have-local-offer') {
            try {
              pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.answer)));
            } catch {}
          }
        });
        addUnsub(targetUid, unsub);

        listenForCandidates(targetUid, pairId, pc);
      } catch {}
    },
    [roomCode, user, createPeerConnection, addUnsub]
  );

  function listenForCandidates(fromUid: string, pairId: string, pc: RTCPeerConnection) {
    if (!roomCode) return;
    const candidatesRef = collection(
      db, 'rooms', roomCode!, 'calls', 'current', 'p2p', pairId, 'candidates'
    );
    const unsub = onSnapshot(candidatesRef, (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== 'added') continue;
        const data = change.doc.data();
        if (data.from !== fromUid) continue;
        try {
          pc.addIceCandidate(new RTCIceCandidate(JSON.parse(data.candidate)));
        } catch {}
      }
    });
    addUnsub(fromUid, unsub);
  }

  // Connect to existing participants when joining or when new participants appear
  useEffect(() => {
    if (!inCall || !roomCode || !user) return;
    const existing = callParticipants.filter((p) => p.uid !== user.uid);
    for (const p of existing) {
      if (!peersRef.current.has(p.uid)) {
        connectToPeer(p.uid);
      }
    }
  }, [inCall, roomCode, user, callParticipants, connectToPeer]);

  // Wake lock + persistent in-call notification
  useEffect(() => {
    if (!inCall) return;
    let wakeLock: any = null;
    let released = false;
    const requestLock = async () => {
      if (released || document.hidden) return;
      try {
        if (wakeLock) {
          try { await wakeLock.release(); } catch {}
          wakeLock = null;
        }
        wakeLock = await (navigator as any).wakeLock?.request?.('screen');
      } catch {}
    };
    requestLock();
    swSend({ type: 'CALL_ACTIVE', roomCode });
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        requestLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (wakeLock) {
        try { wakeLock.release().catch(() => {}); } catch {}
        wakeLock = null;
      }
      swSend({ type: 'CALL_IDLE' });
    };
  }, [inCall, roomCode]);

  const joinCall = useCallback(async () => {
    if (!roomCode || !user || connectingRef.current) return;
    connectingRef.current = true;

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            sampleRate: 48000,
            channelCount: 1,
          },
        });
      } catch {
        connectingRef.current = false;
        return;
      }
      localStreamRef.current = stream;

      const callRef = doc(db, 'rooms', roomCode, 'calls', 'current');
      const callSnap = await getDoc(callRef);
      if (!callSnap.exists() || !callSnap.data()?.active) {
        await setDoc(callRef, {
          active: true,
          initiatorUid: user.uid,
          initiatorName: user.name,
          startTime: serverTimestamp(),
          participantCount: 0,
        });
        await new Promise((r) => setTimeout(r, 300));
      }

      await setDoc(
        doc(db, 'rooms', roomCode, 'calls', 'current', 'participants', user.uid),
        {
          name: user.name,
          muted: !micEnabled,
          joinedAt: serverTimestamp(),
        }
      );

      setInCall(true);
    } finally {
      connectingRef.current = false;
    }
  }, [roomCode, user, micEnabled, setInCall]);

  const leaveCall = useCallback(async () => {
    for (const [uid] of peersRef.current.keys()) {
      cleanupPeer(uid);
    }

    if (localStreamRef.current) {
      try { localStreamRef.current.getTracks().forEach((t) => t.stop()); } catch {}
      localStreamRef.current = null;
    }
    if (screenStreamRef.current) {
      try { screenStreamRef.current.getTracks().forEach((t) => t.stop()); } catch {}
      screenStreamRef.current = null;
    }
    setSharingScreen(false);
    setRemoteScreens((prev) => {
      for (const s of prev) {
        try { s.stream.getTracks().forEach((t) => t.stop()); } catch {}
      }
      return [];
    });

    for (const audioEl of remoteAudioRef.current.values()) {
      try {
        audioEl.pause();
        (audioEl as any).srcObject = null;
        audioEl.remove();
      } catch {}
    }
    remoteAudioRef.current.clear();

    setInCall(false);
    setMicEnabled(true);

    if (!roomCode || !user) return;

    await deleteParticipantDoc(roomCode, user.uid);

    try {
      const remainingSnap = await getDocs(
        collection(db, 'rooms', roomCode, 'calls', 'current', 'participants')
      );
      if (remainingSnap.empty) {
        await deleteDoc(doc(db, 'rooms', roomCode, 'calls', 'current')).catch(() => {});
      } else if (remainingSnap.size === 0) {
        await deleteDoc(doc(db, 'rooms', roomCode, 'calls', 'current')).catch(() => {});
      }
    } catch {}
  }, [roomCode, user, cleanupPeer, setInCall, setMicEnabled]);

  const toggleMute = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream || !roomCode || !user) return;
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    const enabled = !track.enabled;
    try { stream.getAudioTracks().forEach((t) => (t.enabled = enabled)); } catch {}
    setMicEnabled(enabled);
    try {
      await setDoc(
        doc(db, 'rooms', roomCode, 'calls', 'current', 'participants', user.uid),
        { muted: !enabled },
        { merge: true }
      );
    } catch {}
  }, [roomCode, user, setMicEnabled]);

  const inviteMember = useCallback(
    async (targetUid: string, targetName: string) => {
      if (!roomCode || !user) return;
      try {
        await addDoc(
          collection(db, 'rooms', roomCode, 'calls', 'current', 'invitations'),
          {
            targetUid,
            targetName,
            inviterUid: user.uid,
            inviterName: user.name,
            timestamp: serverTimestamp(),
          }
        );
      } catch {}
    },
    [roomCode, user]
  );

  const dismissInvitation = useCallback(async () => {
    if (!roomCode || !user) { setCallInvitations([]); return; }
    try {
      const snap = await getDocs(collection(db, 'rooms', roomCode, 'calls', 'current', 'invitations'));
      const batch: Promise<any>[] = [];
      snap.forEach((d) => {
        if (d.data().targetUid === user.uid) batch.push(deleteDoc(d.ref));
      });
      await Promise.all(batch);
    } catch {}
    setCallInvitations([]);
  }, [roomCode, user, setCallInvitations]);

  // Full cleanup on unmount - do not call setState on unmounted component
  useEffect(() => {
    return () => {
      for (const pc of peersRef.current.values()) {
        try { pc.close(); } catch {}
      }
      peersRef.current.clear();
      if (localStreamRef.current) {
        try { localStreamRef.current.getTracks().forEach((t) => t.stop()); } catch {}
        localStreamRef.current = null;
      }
      if (screenStreamRef.current) {
        try { screenStreamRef.current.getTracks().forEach((t) => t.stop()); } catch {}
        screenStreamRef.current = null;
      }
      for (const audioEl of remoteAudioRef.current.values()) {
        try {
          audioEl.pause();
          (audioEl as any).srcObject = null;
          audioEl.remove();
        } catch {}
      }
      remoteAudioRef.current.clear();
      for (const arr of unsubsRef.current.values()) {
        for (const fn of arr) {
          try { fn(); } catch {}
        }
      }
      unsubsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    callState,
    inCall,
    callParticipants,
    joinCall,
    leaveCall,
    toggleMute,
    micEnabled,
    inviteMember,
    dismissInvitation,
    screenShareUid,
    remoteScreens,
    sharingScreen,
    startScreenShare,
    stopScreenShare,
  };
}

function getPairId(uidA: string, uidB: string): string {
  return [uidA, uidB].sort().join('_');
}

async function deleteParticipantDoc(roomCode: string, uid: string) {
  try {
    await deleteDoc(doc(db, 'rooms', roomCode, 'calls', 'current', 'participants', uid));
  } catch {}
}
