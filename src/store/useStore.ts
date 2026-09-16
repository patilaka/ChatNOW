import { create } from 'zustand';
import type { UserProfile, DecryptedMessage, JoinedRoom, CallParticipant, CallState, CallInvitation } from '../types';

interface AppState {
  user: UserProfile | null;
  setUser: (user: UserProfile | null) => void;
  currentRoom: string | null;
  setCurrentRoom: (code: string | null) => void;
  messages: DecryptedMessage[];
  setMessages: (messages: DecryptedMessage[] | ((prev: DecryptedMessage[]) => DecryptedMessage[])) => void;
  joinedRooms: JoinedRoom[];
  setJoinedRooms: (rooms: JoinedRoom[]) => void;
  addJoinedRoom: (room: JoinedRoom) => void;
  removeJoinedRoom: (code: string) => void;
  callState: CallState | null;
  setCallState: (state: CallState | null) => void;
  callParticipants: CallParticipant[];
  setCallParticipants: (p: CallParticipant[]) => void;
  inCall: boolean;
  setInCall: (v: boolean) => void;
  callInvitations: CallInvitation[];
  setCallInvitations: (v: CallInvitation[]) => void;
  micEnabled: boolean;
  setMicEnabled: (v: boolean) => void;
  mutedUids: string[];
  toggleMuteUid: (uid: string) => void;
  fontSize: number;
  setFontSize: (n: number) => void;
  reducedMotion: boolean;
  setReducedMotion: (v: boolean) => void;
  dataSaver: boolean;
  setDataSaver: (v: boolean) => void;
}

export const useStore = create<AppState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
  currentRoom: null,
  setCurrentRoom: (code) => set({ currentRoom: code }),
  messages: [],
  setMessages: (messages) =>
    set((state) => ({
      messages: typeof messages === 'function' ? messages(state.messages) : messages,
    })),
  joinedRooms: [],
  setJoinedRooms: (rooms) => set({ joinedRooms: rooms }),
  addJoinedRoom: (room) =>
    set((state) => {
      const exists = state.joinedRooms.find((r) => r.code === room.code);
      if (exists) return state;
      return { joinedRooms: [...state.joinedRooms, room] };
    }),
  removeJoinedRoom: (code) =>
    set((state) => ({
      joinedRooms: state.joinedRooms.filter((r) => r.code !== code),
    })),
  callState: null,
  setCallState: (state) => set({ callState: state }),
  callParticipants: [],
  setCallParticipants: (p) => set({ callParticipants: p }),
  inCall: false,
  setInCall: (v) => set({ inCall: v }),
  callInvitations: [],
  setCallInvitations: (v) => set({ callInvitations: v }),
  micEnabled: true,
  setMicEnabled: (v) => set({ micEnabled: v }),
  mutedUids: JSON.parse(localStorage.getItem('chatrix_muted') || '[]'),
  toggleMuteUid: (uid) => set((state) => {
    const muted = state.mutedUids.includes(uid) ? state.mutedUids.filter((u) => u !== uid) : [...state.mutedUids, uid];
    localStorage.setItem('chatrix_muted', JSON.stringify(muted));
    return { mutedUids: muted };
  }),
  fontSize: parseInt(localStorage.getItem('chatrix_fontSize') || '14', 10),
  setFontSize: (n) => { localStorage.setItem('chatrix_fontSize', String(n)); set({ fontSize: n }); },
  reducedMotion: localStorage.getItem('chatrix_reduced') === '1',
  setReducedMotion: (v) => { localStorage.setItem('chatrix_reduced', v ? '1' : '0'); set({ reducedMotion: v }); },
  dataSaver: localStorage.getItem('chatrix_dataSaver') === '1',
  setDataSaver: (v) => { localStorage.setItem('chatrix_dataSaver', v ? '1' : '0'); set({ dataSaver: v }); },
}));
