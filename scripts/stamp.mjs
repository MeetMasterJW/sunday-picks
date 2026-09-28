// Stamp each import with a hash of what it loads, so a browser can never pair a new page
// with an older cached copy. Two links in the chain: app.js carries the hash of the modules
// it imports, and index.html carries the hash of app.js (stamped first) and styles.css.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

async function hashOf(files) {
  const hash = createHash('sha1');
  for (const f of files) hash.update(await readFile(f));
  return hash.digest('hex').slice(0, 8);
}
async function stamp(file, re, v) {
  const before = await readFile(file, 'utf8');
  const after = before.replace(re, (_m, path, _old, quote) => `${path}?v=${v}${quote}`);
  await writeFile(file, after);
  console.log(`${file}: ${before === after ? 'already stamped' : 'stamped'} v=${v}`);
}

await stamp('app.js', /(\.\/(?:espn|config|scoring)\.js)(\?v=[^']*)?(')/g, await hashOf(['espn.js', 'config.js', 'scoring.js']));
await stamp('index.html', /((?:app\.js|styles\.css))(\?v=[^"]*)?(")/g, await hashOf(['app.js', 'styles.css']));
