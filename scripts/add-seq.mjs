/**
 * Add sequential `seq` field to all messages in room 2035
 * so client can order by `seq` instead of random tiebreaker.
 *
 * Usage: node scripts/add-seq.mjs
 */

const ROOM_CODE = '2035';

async function main() {
  const apiKey = process.env.VITE_FIREBASE_API_KEY;
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    console.error('Set VITE_FIREBASE_API_KEY and VITE_FIREBASE_PROJECT_ID in .env');
    process.exit(1);
  }

  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/rooms/${ROOM_CODE}/messages`;

  // Fetch all messages
  console.log('Fetching all messages...');
  let allDocs = [];
  let nextPageToken = null;
  do {
    const url = nextPageToken ? `${base}?key=${apiKey}&pageSize=300&pageToken=${nextPageToken}` : `${base}?key=${apiKey}&pageSize=300`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.documents) {
      allDocs = allDocs.concat(data.documents);
    }
    nextPageToken = data.nextPageToken || null;
    console.log(`  Fetched ${allDocs.length} documents so far...`);
  } while (nextPageToken);

  console.log(`Total documents: ${allDocs.length}`);

  if (allDocs.length === 0) {
    console.log('No documents found.');
    return;
  }

  // Sort by timestamp ascending, then document name (ID) as tiebreaker
  allDocs.sort((a, b) => {
    const tA = a.fields.timestamp?.timestampValue || '';
    const tB = b.fields.timestamp?.timestampValue || '';
    const cmp = tA.localeCompare(tB);
    if (cmp !== 0) return cmp;
    // Tiebreak by doc name (the last segment of the resource name)
    const idA = a.name.split('/').pop();
    const idB = b.name.split('/').pop();
    return idA.localeCompare(idB);
  });

  console.log(`Date range: ${allDocs[0].fields.timestamp.timestampValue} → ${allDocs[allDocs.length - 1].fields.timestamp.timestampValue}`);

  // Assign seq and update
  let success = 0;
  let fail = 0;
  for (let idx = 0; idx < allDocs.length; idx++) {
    const doc = allDocs[idx];
    const docName = doc.name;
    const url = `https://firestore.googleapis.com/v1/${docName}?key=${apiKey}&updateMask.fieldPaths=seq`;

    const patch = {
      fields: {
        seq: { integerValue: idx },
      },
    };

    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        success++;
      } else {
        const err = await res.text();
        console.error(`  [${idx + 1}] FAILED: ${docName.split('/').pop()} - ${err.slice(0, 120)}`);
        fail++;
      }
    } catch (e) {
      console.error(`  [${idx + 1}] ERROR: ${docName.split('/').pop()} - ${e.message}`);
      fail++;
    }

    if ((idx + 1) % 100 === 0 || idx === allDocs.length) {
      console.log(`  Progress: ${idx + 1}/${allDocs.length} (${success} success, ${fail} fail)`);
    }
  }

  console.log(`\nDone! ${success} updated, ${fail} failed.`);
}

main().catch(console.error);
