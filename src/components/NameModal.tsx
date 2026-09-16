import { useState } from 'react';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { localDB } from '../lib/db';
import { useStore } from '../store/useStore';
import type { UserProfile } from '../types';

export default function NameModal() {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const setUser = useStore((s) => s.setUser);

  const trimmed = name.trim();
  const canSubmit = trimmed.length >= 2 && !loading;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    const uid = crypto.randomUUID();
    const profile: UserProfile = { uid, name: trimmed, createdAt: Date.now() };

    // IndexedDB is instant — always works, unblocks the user immediately
    await localDB.userProfile.put(profile);
    setUser(profile);

    // Firestore write is best-effort; never block the user on it
    try {
      await setDoc(doc(db, 'users', uid), {
        name: trimmed,
        createdAt: serverTimestamp(),
        lastSeen: serverTimestamp(),
      });
    } catch {
      // Firestore unavailable — app works fine without it
    }

    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div className="w-full max-w-sm mx-4 p-6 rounded-2xl border border-[#333] bg-[#0D0D0D]">
        <h1 className="text-2xl font-bold text-center mb-2">Welcome!</h1>
        <p className="text-sm text-[#B3B3B3] text-center mb-6">
          Choose your display name
        </p>
        <input
          autoFocus
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="Display name"
          maxLength={30}
          className="w-full px-4 py-3 rounded-xl bg-[#1C1C1E] border border-[#2C2C2E] text-white placeholder-gray-500 outline-none focus:border-[#007AFF] transition-colors"
        />
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full mt-4 py-3 rounded-xl font-semibold bg-[#007AFF] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#0066CC] transition-colors"
        >
          {loading ? 'Setting up...' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
