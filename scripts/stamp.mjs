// Stamp index.html's module imports with a hash of the modules themselves, so a browser
// can never pair a new page with an older cached copy of espn.js or config.js.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const files = ['espn.js', 'config.js'];
const hash = createHash('sha1');
for (const f of files) hash.update(await readFile(f));
const v = hash.digest('hex').slice(0, 8);

let html = await readFile('index.html', 'utf8');
const before = html;
html = html.replace(/(\.\/(?:espn|config)\.js)(\?v=[^']*)?'/g, (_m, path) => `${path}?v=${v}'`);
await writeFile('index.html', html);
console.log(before === html ? `already stamped v=${v}` : `stamped v=${v}`);
