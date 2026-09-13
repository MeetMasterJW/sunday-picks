// One-time copy of picks, family names and locks from the claude.ai version into Firestore.
// usage: node scripts/migrate.mjs <export dir containing config/, picks/, locks/>
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, terminate } from 'firebase/firestore';
import { firebaseConfig } from '../config.js';

const dir = process.argv[2];
if (!dir) throw new Error('Pass the export directory, e.g. node scripts/migrate.mjs ./export');

const db = getFirestore(initializeApp(firebaseConfig));

async function docsIn(collection) {
  const folder = path.join(dir, collection);
  const names = await readdir(folder).catch(() => []);
  return Promise.all(names.filter((n) => n.endsWith('.json')).map(async (n) => {
    const raw = JSON.parse(await readFile(path.join(folder, n), 'utf8'));
    return { id: n.slice(0, -5), data: raw.id && raw.data ? raw.data : raw };
  }));
}

let written = 0, skipped = 0;
for (const collection of ['config', 'picks', 'locks']) {
  for (const { id, data } of await docsIn(collection)) {
    const ref = doc(db, collection, id);
    if ((await getDoc(ref)).exists()) {
      console.log(`skip  ${collection}/${id} (already in Firestore)`);
      skipped++;
      continue;
    }
    await setDoc(ref, data);
    console.log(`wrote ${collection}/${id}`);
    written++;
  }
}
console.log(`Done: ${written} written, ${skipped} skipped.`);
await terminate(db);
