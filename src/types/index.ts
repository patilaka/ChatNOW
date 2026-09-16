export interface UserProfile {
  uid: string;
  name: string;
  createdAt: number;
  avatarEmoji?: string;
  avatarColor?: string;
}

export interface JoinedRoom {
  code: string;

  name: string;

  joinedAt: number;
  lastReadTimestamp: number | null;
  tone?: 'pop' | 'ding' | 'soft' | 'none';
  archived?: boolean;
  pinned?: boolean;
  dnd?: boolean;
  themeAccent?: string;
}

export interface ReplyTo {
  messageId: string;
  senderName: string;
  senderUid: string;
  text: string;
  threadRootId?: string;
}

export interface FileInfo {
  name: string;
  size: number;
  mimeType: string;
}

export interface EncryptedPayload {
  text: string;
  type?: 'text' | 'image' | 'file';
  replyTo?: { messageId: string; senderName: string; text: string };
  file?: FileInfo;
}

export interface DecryptedMessage {
  id: string;
  senderUid: string;
  senderName: string;
  text: string;
  type?: 'text' | 'image' | 'file' | 'poll' | 'sys';
  file?: FileInfo;
  replyTo?: ReplyTo;
  edited?: boolean;
  editHistory?: { text: string; editedAt: number }[];
  deleted?: boolean;
  forwarded?: boolean;
  viewOnce?: boolean;
  viewedBy?: string[];
  reactions?: Record<string, string[]>;
  poll?: PollData;
  sys?: SysData;
  readerUids?: string[];
  threadRootId?: string;
  replies?: number;
  burn?: boolean;
  seq?: number;
  timestamp: number;
}

export interface ScheduledMsg {
  id: string;
  roomCode: string;
  sendAtMs: number;
  textPreview: string;
}

export interface SearchIndexEntry {
  msgId: string;
  roomCode: string;
  text: string;
  senderName: string;
  senderUid: string;
  timestamp: number;
  seq: number;
}

export interface FirestoreUser {
  name: string;
  createdAt: object;
  lastSeen: object;
}

export interface FirestoreRoom {
  name: string;
  createdAt: object;
  createdBy?: string;
}

export interface FirestoreMessage {
  senderUid: string;
  senderName: string;
  ciphertext: string;
  iv: string;
  timestamp: object;
  replyToUid?: string;
  mentionedUids?: string[];
  edited?: boolean;
  deleted?: boolean;
  reactions?: Record<string, string[]>;
}

export interface FirestoreToken {
  token: string;
  platform: string;
  createdAt: object;
  lastUsed: object;
}

export interface FirestoreMember {
  joinedAt: object;
  name: string;
}

export interface TypingUser {
  uid: string;
  name: string;
  timestamp: number;
}

export interface CallParticipant {
  uid: string;
  name: string;
  muted: boolean;
  joinedAt: number;
}

export interface CallState {
  active: boolean;
  initiatorUid: string;
  initiatorName: string;
  startTime: number;
  room: string;
  participantCount: number;
}

export interface CallInvitation {
  inviterUid: string;
  inviterName: string;
  timestamp: number;
}

export interface PollOption {
  text: string;
  voters: string[];
}

export interface PollData {
  question: string;
  options: PollOption[];
  multiple: boolean;
}

export interface SysData {
  type: 'join' | 'remove' | 'kick';
  uid: string;
  name: string;
  timestamp: number;
}

export interface RoomSettings {
  slowModeSec: number;
  blockedWords: string[];
  frozen: boolean;
  keyVersion: number;
  autoDelete: boolean;
  lastActivityAt: number | null;
  createdAt: number;
  blurWords: string[];
  effectWords: string[];
  linkPreviews?: boolean;
  themeAccent?: string;
  themeWallpaper?: string;
}

export interface DeviceInfo {
  name: string;
  lastSeen: number;
  online: boolean;
  revoked: boolean;
  createdAt: number;
}

export interface InviteInfo {
  token: string;
  expiresAt: number;
  uses: number;
  maxUses: number;
  createdBy: string;
}
