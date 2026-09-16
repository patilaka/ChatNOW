import Dexie, { type Table } from 'dexie';
import type { UserProfile, JoinedRoom, ScheduledMsg, SearchIndexEntry } from '../types';

class ChatrixDB extends Dexie {
  userProfile!: Table<UserProfile, string>;
  joinedRooms!: Table<JoinedRoom, string>;
  scheduled!: Table<ScheduledMsg, string>;
  searchIndex!: Table<SearchIndexEntry, string>;

  constructor() {
    super('ChatrixDB');
    this.version(2).stores({
      userProfile: 'uid',
      joinedRooms: 'code',
    });
    this.version(3).stores({
      userProfile: 'uid',
      joinedRooms: 'code',
      scheduled: 'id, roomCode, sendAtMs',
      searchIndex: 'msgId, roomCode, seq',
    }).upgrade(() => {});
  }
}

export const localDB = new ChatrixDB();
