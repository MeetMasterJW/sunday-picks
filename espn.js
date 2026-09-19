// Schedule and live scores straight from ESPN's public scoreboard feed.
// Pick weeks run Sunday through Saturday (Eastern), so a Thursday, Friday or
// Saturday game belongs to the Sunday before it. Games before the season's
// first Sunday are left out.

export const SEASON = 2026;
// seasonType 2 = regular season, 3 = playoffs (weeks 1 Wild Card, 2 Divisional, 3 Conference, 5 Super Bowl)
const url = (week, seasonType = 2) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=${seasonType}&week=${week}&dates=${SEASON}`;

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

// Closing line for a game that already kicked off, so upset badges can be filled in later.
// Returns {fav, line} or null.
export async function fetchClosingLine(id) {
  const s = await getJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${id}`, `ESPN summary ${id}`);
  const book = (s.pickcenter || [])[0];
  if (!book) return null;
  const comp = ((s.header || {}).competitions || [])[0] || {};
  const side = Object.fromEntries((comp.competitors || []).map((c) => [c.homeAway, ((c.team || {}).abbreviation) || '']));
  const line = Math.abs(Number(book.spread));
  if ((book.homeTeamOdds || {}).favorite && side.home) return { fav: side.home, line: Number.isFinite(line) ? line : null };
  if ((book.awayTeamOdds || {}).favorite && side.away) return { fav: side.away, line: Number.isFinite(line) ? line : null };
  const fromDetails = homeLine(book.details, side.home, side.away);
  if (fromDetails == null || fromDetails === 0) return null;
  return { fav: fromDetails < 0 ? side.home : side.away, line: Math.abs(fromDetails) };
}

// Box score for one game, trimmed to what the game sheet shows
const TEAM_STATS = ['totalYards', 'netPassingYards', 'rushingYards', 'turnovers', 'firstDowns', 'thirdDownEff', 'totalPenaltiesYards', 'possessionTime'];
const LEADER_STATS = ['passingYards', 'rushingYards', 'receivingYards'];

export async function fetchGameSummary(id) {
  const s = await getJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${id}`, `ESPN summary ${id}`);
  const comp = ((s.header || {}).competitions || [])[0] || {};
  const side = Object.fromEntries((comp.competitors || []).map((c) => [c.homeAway, c]));
  const abbr = (k) => ((side[k] || {}).team || {}).abbreviation;
  const lines = (k) => ((side[k] || {}).linescores || []).map((l) => l.displayValue ?? String(l.value ?? ''));

  const statsBy = {};
  for (const t of (s.boxscore || {}).teams || []) {
    statsBy[t.team.abbreviation] = Object.fromEntries((t.statistics || []).map((x) => [x.name, { label: x.label, v: x.displayValue }]));
  }
  const sa = statsBy[abbr('away')] || {}, sh = statsBy[abbr('home')] || {};
  const stats = TEAM_STATS.filter((k) => sa[k] || sh[k])
    .map((k) => ({ key: k, label: (sa[k] || sh[k]).label, a: (sa[k] || {}).v ?? '–', h: (sh[k] || {}).v ?? '–' }));

  const leadBy = {};
  for (const t of s.leaders || []) {
    leadBy[(t.team || {}).abbreviation] = Object.fromEntries((t.leaders || []).map((c) => {
      const top = (c.leaders || [])[0] || {};
      return [c.name, { label: c.displayName, who: (top.athlete || {}).shortName || (top.athlete || {}).displayName || '', v: top.displayValue || '' }];
    }));
  }
  const la = leadBy[abbr('away')] || {}, lh = leadBy[abbr('home')] || {};
  const leaders = LEADER_STATS.filter((k) => la[k] || lh[k])
    .map((k) => ({ label: (la[k] || lh[k]).label.replace(/ Yards$/, ''), a: la[k] || null, h: lh[k] || null }));

  const plays = (s.scoringPlays || []).map((p) => ({
    q: (p.period || {}).number || 0,
    clock: (p.clock || {}).displayValue || '',
    team: (p.team || {}).abbreviation || '',
    type: (p.scoringType || {}).abbreviation || '',
    text: p.text || '',
    as: p.awayScore,
    hs: p.homeScore,
  }));

  const v = (s.gameInfo || {}).venue;
  const venue = v ? [v.fullName, [v.address?.city, v.address?.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') : '';
  const wp = s.winprobability || [];
  const last = wp[wp.length - 1];
  return { lines: { a: lines('away'), h: lines('home') }, stats, leaders, plays, venue, homeWinProb: last ? numberOrNull(last.homeWinPercentage) : null };
}

// Latest home win probability from ESPN's game detail feed (about 50 KB compressed; call sparingly)
export async function fetchWinProb(id) {
  const wp = (await getJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${id}`, `ESPN summary ${id}`)).winprobability || [];
  const last = wp[wp.length - 1];
  return last ? numberOrNull(last.homeWinPercentage) : null;
}

// One request with a timeout, retried once: a stalled phone connection should fail, not hang forever
async function getJson(target, label) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 15000);
    try {
      const res = await fetch(target, { cache: 'no-store', signal: stop.signal });
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e.name === 'AbortError' ? new Error(`${label}: timed out`) : e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

export async function fetchWeek(week, seasonType = 2) {
  return (await getJson(url(week, seasonType), `ESPN week ${week}`)).events.map(game);
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
