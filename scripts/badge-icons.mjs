// Badge emblems come from game-icons.net (CC BY 3.0) — silhouettes made for games, which
// suit awards better than UI line icons. This inlines them so the page fetches nothing at runtime.
import { readFile, writeFile } from 'node:fs/promises';

const ICONS = {
  postseason: 'delapouite/podium-winner',
  champion: 'delapouite/trophy-cup',
  longgame: 'lorc/sands-of-time',
  wire: 'delapouite/checkered-flag',
  bullseye: 'lorc/archery-target',
  perfectsun: 'lorc/sunbeams',
  grain: 'delapouite/school-of-fish',
  icecold: 'lorc/frozen-orb',
  ring: 'delapouite/ring',
  chalk: 'delapouite/sheep',
  rockbottom: 'lorc/anchor',
  loyalist: 'delapouite/shaking-hands',
  jinx: 'lorc/voodoo-doll',
  photo: 'lorc/stopwatch',
  heart: 'lorc/broken-heart',
  champ: 'lorc/trophy',
  b2b: 'lorc/laurels',
  perfect: 'delapouite/check-mark',
  landslide: 'lorc/earth-crack',
  sharp: 'lorc/target-arrows',
  upset: 'delapouite/sitting-dog',
  dogpile: 'lorc/paw',
  lone: 'lorc/wolf-head',
  slayer: 'lorc/broadsword',
  streak: 'lorc/small-fire',
  wizard: 'lorc/pointy-hat',
  soclose: 'delapouite/dart',
  ironman: 'lorc/anvil',
  comeback: 'lorc/sunrise',
  dynasty: 'lorc/crown',
  immaculate: 'lorc/diamond-hard',
  untouchable: 'lorc/edged-shield',
  spoon: 'lorc/spoon',
};

async function emblem(path) {
  const res = await fetch(`https://raw.githubusercontent.com/game-icons/icons/master/${path}.svg`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const svg = await res.text();
  const art = [...svg.matchAll(/<path[^>]*\/>/g)]
    .map((m) => m[0])
    .filter((p) => !/d="M0 0h512v512H0z"/.test(p))   // drop the black backing square
    .map((p) => p.replace(/\s*fill="[^"]*"/g, '').replace(/\s+/g, ' '))
    .join('');
  if (!art) throw new Error(`${path}: no artwork found`);
  return art;
}

let html = await readFile('index.html', 'utf8');
for (const [key, path] of Object.entries(ICONS)) {
  const art = await emblem(path);
  const re = new RegExp(`(\\b${key}:\\{[^}]*?icon:')(.*?)(')`);
  if (!re.test(html)) throw new Error(`badge ${key} not found in index.html`);
  html = html.replace(re, (_m, before, _old, after) => `${before}${art}${after}`);
  console.log(`${key} → ${path}`);
}
await writeFile('index.html', html);
