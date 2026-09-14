// Schedule and live scores straight from ESPN's public scoreboard feed.
// Pick weeks run Sunday through Saturday (Eastern), so a Thursday, Friday or
// Saturday game belongs to the Sunday before it. Games before the season's
// first Sunday are left out.

export const SEASON = 2026;
const url = (week) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}&dates=${SEASON}`;

function team(c) {
  const t = c.team;
  return {
    ab: t.abbreviation,
    name: t.shortDisplayName || t.name,
    loc: t.location || '',
    c: '#' + (t.color || '555555'),
    c2: '#' + (t.alternateColor || 'ffffff'),
    logo: t.logo || '',
    rec: ((c.records || []).find((r) => r.type === 'total') || {}).summary || '',
  };
}

function game(e) {
  const comp = e.competitions[0];
  const side = Object.fromEntries(comp.competitors.map((x) => [x.homeAway, x]));
  const st = e.status.type;
  // Sportsbook line is only published before kickoff; used for display and win chances, never for scoring
  const odds = (comp.odds || [])[0] || {};
  let w = null;
  if (st.completed) w = (comp.competitors.find((x) => x.winner) || { team: { abbreviation: 'TIE' } }).team.abbreviation;
  return {
    id: e.id,
    t: e.date,
    tbd: (st.detail || '').includes('TBD'),
    a: team(side.away),
    h: team(side.home),
    st: st.state,
    d: st.state === 'in' ? st.shortDetail || '' : '',
    w,
    as: Number(side.away.score || 0),
    hs: Number(side.home.score || 0),
    spread: odds.details || '',
    ou: odds.overUnder ?? null,
    hl: homeLine(odds.details, side.home.team.abbreviation, side.away.team.abbreviation),
    ml: { h: moneyline(odds, 'home'), a: moneyline(odds, 'away') },
    period: Number(e.status.period || 0),
    clock: Number(e.status.clock || 0),
    liveProb: numberOrNull(((comp.situation || {}).lastPlay || {}).probability?.homeWinPercentage),
  };
}

function numberOrNull(v) {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? null : n;
}

// "KC -2.5" -> home team's line (negative when the home team is favored)
function homeLine(details, home, away) {
  if (!details) return null;
  if (/^(EVEN|PK|PICK)/i.test(details)) return 0;
  const m = details.match(/^([A-Z]{2,4})\s*([+-]?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Math.abs(parseFloat(m[2]));
  return m[1] === home ? -n : m[1] === away ? n : null;
}

// American moneyline for one side ("-130", "+110", "EVEN"), closing line first
function moneyline(odds, sideKey) {
  const s = (odds.moneyline || {})[sideKey] || {};
  const raw = (s.close || {}).odds ?? (s.open || {}).odds;
  if (raw == null) return null;
  if (/^even$/i.test(String(raw))) return 100;
  const n = parseInt(String(raw).replace('+', ''), 10);
  return Number.isFinite(n) ? n : null;
}

// Latest home win probability from ESPN's game detail feed (large payload; call sparingly)
export async function fetchWinProb(id) {
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${id}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`ESPN summary ${id}: HTTP ${res.status}`);
  const wp = (await res.json()).winprobability || [];
  const last = wp[wp.length - 1];
  return last ? numberOrNull(last.homeWinPercentage) : null;
}

export async function fetchWeek(week) {
  const res = await fetch(url(week), { cache: 'no-store' });
  if (!res.ok) throw new Error(`ESPN week ${week}: HTTP ${res.status}`);
  return (await res.json()).events.map(game);
}

// Eastern calendar day as a whole-day number, so weekday maths ignores time zones
const etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
function dayNumber(iso) {
  const s = etDay.format(new Date(iso));
  return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
}
const weekday = (day) => new Date(day * 864e5).getUTCDay(); // 0 = Sunday

// nfl: {nflWeek: games[]} -> {pickWeek: {week, games}}
export function groupIntoPickWeeks(nfl) {
  const sundays = [];
  for (let w = 1; w <= 18; w++) {
    const days = (nfl[w] || []).map((g) => dayNumber(g.t));
    if (!days.length) { sundays.push(Infinity); continue; }
    const suns = days.filter((d) => weekday(d) === 0);
    const start = Math.min(...days);
    sundays.push(suns.length ? Math.min(...suns) : start + ((7 - weekday(start)) % 7));
  }
  const weeks = {};
  for (let w = 1; w <= 18; w++) weeks[w] = { week: w, games: [] };
  for (const games of Object.values(nfl)) {
    for (const g of games) {
      const d = dayNumber(g.t);
      let k = 0;
      sundays.forEach((s, i) => { if (s <= d) k = i + 1; });
      if (k) weeks[k].games.push(g);
    }
  }
  for (const wk of Object.values(weeks)) wk.games.sort((x, y) => x.t.localeCompare(y.t) || x.id.localeCompare(y.id));
  return weeks;
}
