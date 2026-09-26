// Badge artwork comes from Tabler Icons (MIT). This pulls the ones we use and inlines
// their paths into index.html, so the page has no runtime dependency on another site.
import { readFile, writeFile } from 'node:fs/promises';

const VERSION = '3.19.0';
const ICONS = {
  champ: 'trophy', b2b: 'chevrons-up', perfect: 'circle-check', sharp: 'target-arrow',
  upset: 'dog', dogpile: 'paw', lone: 'moon-stars', slayer: 'sword', streak: 'flame',
  wizard: 'wand', soclose: 'ruler-measure', ironman: 'calendar-check', comeback: 'trending-up',
  dynasty: 'crown', immaculate: 'diamond', untouchable: 'shield-check', spoon: 'soup',
};

async function paths(name) {
  const res = await fetch(`https://unpkg.com/@tabler/icons@${VERSION}/icons/outline/${name}.svg`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const svg = await res.text();
  return [...svg.matchAll(/<path[^>]*\/>/g)]
    .map((m) => m[0].replace(/\s+/g, ' ').trim())
    .filter((p) => !p.includes('stroke="none"'))     // drop Tabler's invisible bounding path
    .join('');
}

let html = await readFile('index.html', 'utf8');
for (const [key, name] of Object.entries(ICONS)) {
  const art = await paths(name);
  const re = new RegExp(`(\\b${key}:\\{[^}]*?icon:')(.*?)(')`);
  if (!re.test(html)) throw new Error(`badge ${key} not found in index.html`);
  html = html.replace(re, (_m, before, _old, after) => `${before}${art}${after}`);
  console.log(`${key} → ${name}`);
}
await writeFile('index.html', html);
