// How a week is ranked. Pure functions over plain rows, so the standings, the win-chance
// simulation and the tests all run the same rules.

export const PLACE_POINTS = [3, 2, 1];

// tbAt used to be a client clock reading; it's now the server's, stored as a Firestore
// Timestamp. This reads either one (plus the moment-long gap before a fresh write echoes
// back from the server) into a single comparable number, latest sorting last.
export function tbMillis(v) {
  if (v == null) return Infinity;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? Infinity : t; }
  if (typeof v.toMillis === 'function') return v.toMillis();
  return Infinity;
}

// Negative when guess x beats guess y: any guess beats none, then the closer one, then the
// one that didn't go over.
export function guessOff(x, y, actual) {
  if ((x === null) !== (y === null)) return x === null ? 1 : -1;
  if (x === null) return 0;
  const d = Math.abs(x - actual) - Math.abs(y - actual);
  if (d) return d;
  const ox = x > actual, oy = y > actual;
  return ox !== oy ? (ox ? 1 : -1) : 0;
}

// Negative when a goes ahead of b among people tied on correct picks: the guess on the
// week's last game, then the Monday guess once that game has a total, then whoever saved
// their first guess first. 0 means still tied; callers settle that by roster order.
export function compareTiebreak(a, b, actual, actual2) {
  const first = guessOff(a.tb, b.tb, actual);
  if (first) return first;
  if (actual2 != null) {
    const second = guessOff(a.tb2, b.tb2, actual2);
    if (second) return second;
  }
  if (a.tbAt !== b.tbAt) return a.tbAt < b.tbAt ? -1 : 1;
  return 0;
}

// Sorts rows ({right, wrong, idx, tb, tb2, tbAt}) into the week's order and marks each
// with place, pts and tied. A week still in play has no points and ranks fewer misses first.
export function rankRows(rows, { complete, actual, actual2 }) {
  const tiebreak = (a, b) => actual === null ? 0 : (compareTiebreak(a, b, actual, actual2) || a.idx - b.idx);
  rows.sort((a, b) => b.right - a.right || (complete ? tiebreak(a, b) : a.wrong - b.wrong || a.idx - b.idx));
  rows.forEach((r, i) => {
    r.place = i + 1;
    r.pts = complete ? (PLACE_POINTS[i] || 0) : 0;
    r.tied = rows.some(x => x !== r && x.right === r.right);
  });
  return rows;
}
