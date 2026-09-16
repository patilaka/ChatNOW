import { useState, useEffect } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useStore } from '../store/useStore';

interface Props {
  roomCode: string;
  onInvite: (targetUid: string, targetName: string) => Promise<void>;
  onClose: () => void;
}

export default function InviteToCall({ roomCode, onInvite, onClose }: Props) {
  const { user } = useStore();
  const [roomMembers, setRoomMembers] = useState<{ uid: string; name: string }[]>([]);
  const [callParticipantUids, setCallParticipantUids] = useState<Set<string>>(new Set());
  const [inviting, setInviting] = useState<string | null>(null);

  useEffect(() => {
    if (!roomCode) return;
    const unsubMembers = onSnapshot(
      collection(db, 'rooms', roomCode, 'members'),
      (snap) => {
        const list: { uid: string; name: string }[] = [];
        snap.forEach((d) => {
          const data = d.data();
          list.push({ uid: d.id, name: data.name || 'Unknown' });
        });
        setRoomMembers(list);
      }
    );

    const unsubParticipants = onSnapshot(
      collection(db, 'rooms', roomCode, 'calls', 'current', 'participants'),
      (snap) => {
        const uids = new Set<string>();
        snap.forEach((d) => uids.add(d.id));
        setCallParticipantUids(uids);
      }
    );

    return () => {
      unsubMembers();
      unsubParticipants();
    };
  }, [roomCode]);

  const available = roomMembers.filter(
    (m) => !callParticipantUids.has(m.uid) && m.uid !== user?.uid
  );

  const handleInvite = async (targetUid: string, targetName: string) => {
    setInviting(targetUid);
    await onInvite(targetUid, targetName);
    setTimeout(() => setInviting(null), 1000);
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/60" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6 pointer-events-none">
        <div
          className="bg-[#1C1C1E] border border-[#333] rounded-2xl w-full max-w-xs shadow-2xl pointer-events-auto animate-fade-in"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#333]">
            <h2 className="text-sm font-bold text-white">Invite to Call</h2>
            <button
              onClick={onClose}
              className="text-[#555] hover:text-white p-1 rounded-lg hover:bg-white/5 transition-all"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
              </svg>
            </button>
          </div>
          <div className="max-h-60 overflow-y-auto p-2 space-y-0.5">
            {available.length === 0 ? (
              <p className="text-xs text-[#555] text-center py-6">
                All room members are already in the call
              </p>
            ) : (
              available.map((m) => (
                <div
                  key={m.uid}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors"
                >
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
                    style={{ backgroundColor: `hsl(${hashStr(m.name)}, 55%, 45%)` }}
                  >
                    {(m.name || '?').charAt(0).toUpperCase()}
                  </div>
                  <span className="text-sm text-[#ccc] flex-1 truncate">{m.name || 'Someone'}</span>
                  <button
                    onClick={() => handleInvite(m.uid, m.name)}
                    disabled={inviting === m.uid}
                    className="text-xs font-medium text-[#007AFF] hover:text-white px-3 py-1 rounded-lg hover:bg-[#007AFF]/20 transition-all disabled:opacity-40"
                  >
                    {inviting === m.uid ? 'Sent!' : 'Invite'}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function hashStr(name: string): number {
  const safe = name || '?';
  let hash = 0;
  for (let i = 0; i < safe.length; i++) {
    hash = safe.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}
