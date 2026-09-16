import { collection, deleteDoc, doc, getDocs, writeBatch } from 'firebase/firestore';
import { db } from './firebase';

export async function deleteRoomData(code: string) {
  try {
    const snap = await getDocs(collection(db, 'rooms', code, 'messages'));
    let batch = writeBatch(db);
    let count = 0;
    const flush = async () => {
      if (count > 0) { await batch.commit().catch(() => {}); batch = writeBatch(db); count = 0; }
    };
    for (const d of snap.docs) {
      batch.delete(d.ref);
      count++;
      if (count >= 400) await flush();
    }
    await flush();
    const members = await getDocs(collection(db, 'rooms', code, 'members'));
    batch = writeBatch(db); count = 0;
    for (const d of members.docs) {
      batch.delete(d.ref);
      count++;
      if (count >= 400) await flush();
    }
    await flush();
    const typing = await getDocs(collection(db, 'rooms', code, 'typing'));
    batch = writeBatch(db); count = 0;
    for (const d of typing.docs) {
      batch.delete(d.ref);
      count++;
      if (count >= 400) await flush();
    }
    await flush();
    await deleteDoc(doc(db, 'rooms', code, 'calls', 'current')).catch(() => {});
    await deleteDoc(doc(db, 'rooms', code)).catch(() => {});
  } catch {}
}
