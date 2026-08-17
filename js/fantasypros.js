// Fetch and merge FantasyPros data through the Cloudflare Worker.
//
// FantasyPros sends no CORS headers, so the page cannot call the API itself.
// The Worker relays it — which is what lets the app refresh its own board on
// open instead of depending on someone having run a script beforehand.
//
// The same normalisation lives in tools/fetch_fantasypros.py for offline use.
// Both were written against real responses; the field names here are what the
// API actually returns, not what its documentation implies.

const VALID_POS = new Set(['QB', 'RB', 'WR', 'TE', 'DST', 'K']);
const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);
const POINTS_KEY = { HALF: 'points_half', PPR: 'points_ppr', STD: 'points' };
const MAX_NEWS_PER_PLAYER = 2;

function nameKey(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9\s]/g, '')
    .split(/\s+/).filter(Boolean).filter((t) => !SUFFIXES.has(t)).join('');
}

/** The injuries feed appends a position to disambiguate: "Travis Hunter (CB)". */
const cleanName = (raw) => String(raw || '').replace(/\s*\(.*?\)\s*$/, '').trim();

const num = (v) => {
  if (v == null || v === '' || v === '-') return null;
  const n = Number(String(v).replace(/[, +]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function splitPos(raw, fallback) {
  const s = String(raw || fallback || '').toUpperCase().trim();
  const m = s.match(/^([A-Z]+)(\d+)?$/);
  if (!m) return { pos: fallback || null, posRank: null };
  let pos = m[1];
  if (pos === 'D' || pos === 'DEF') pos = 'DST';
  if (pos === 'PK') pos = 'K';
  return { pos, posRank: m[2] ? Number(m[2]) : null };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

function listOf(payload) {
  if (Array.isArray(payload)) return payload;
  for (const k of ['players', 'items', 'injuries', 'data']) {
    if (Array.isArray(payload?.[k])) return payload[k];
  }
  return [];
}

async function call(cfg, endpoint, params = {}) {
  const url = new URL(cfg.proxyUrl.replace(/\/+$/, '') + '/fantasypros');
  url.searchParams.set('endpoint', endpoint);
  url.searchParams.set('season', cfg.season);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);

  const res = await fetch(url, { headers: { 'x-app-passphrase': cfg.passphrase } });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json())?.error?.message || detail; } catch { /* non-JSON */ }
    throw new Error(`${endpoint}: ${detail}`);
  }
  return res.json();
}

/**
 * A short response is the free tier truncating silently — it reports the true
 * count while returning ten rows, and offset/page are ignored, so there is no
 * pagination to fall back on.
 */
function truncationNote(payload, label) {
  const total = payload?.count;
  const got = listOf(payload).length;
  if (typeof total !== 'number' || got >= total) return null;
  return `${label}: got ${got} of ${total} — key is on the '${payload?.tier}' tier, `
    + `capped at ${payload?.limit} per response.`;
}

/** Fetch everything and merge into the canonical player shape. */
export async function fetchPool({ proxyUrl, passphrase, season = '2026', scoring = 'HALF' }) {
  if (!proxyUrl) throw new Error('No Worker URL configured.');
  if (!passphrase) throw new Error('No passphrase configured.');
  const cfg = { proxyUrl, passphrase, season, scoring };
  const notes = [];

  const rankings = await call(cfg, 'consensus-rankings',
    { position: 'ALL', scoring, type: 'Redraft', week: '0' });

  const short = truncationNote(rankings, 'Rankings');
  if (short) throw new Error(`${short} A partial board is not usable for a draft.`);

  const players = [];
  for (const r of listOf(rankings)) {
    const name = r.player_name || r.name;
    if (!name) continue;
    const { pos, posRank } = splitPos(r.pos_rank, r.player_position_id);
    if (!VALID_POS.has(pos)) continue;
    const team = String(r.player_team_id || r.team_id || '').toUpperCase() || null;
    players.push({
      id: slug(`${name}-${team || pos}-${pos}`),
      fpId: r.player_id ?? null,
      name: String(name).trim(),
      team, pos, posRank,
      ecr: num(r.rank_ecr),
      tier: num(r.tier),
      bye: num(r.player_bye_week),
      ecrAvg: num(r.rank_ave),
      ecrBest: num(r.rank_min),
      ecrWorst: num(r.rank_max),
      ecrStdDev: num(r.rank_std),
      // NOT player_owned_avg — that is ownership percentage, not draft position.
      adp: null,
      ecrVsAdp: null,
      projPoints: null,
    });
  }
  if (!players.length) throw new Error('Rankings returned no usable players.');

  const byId = new Map(players.filter((p) => p.fpId != null).map((p) => [p.fpId, p]));
  const byNamePos = new Map(players.map((p) => [`${nameKey(p.name)}|${p.pos}`, p]));

  // Everything below is enrichment: a failure degrades the board, it does not
  // invalidate it, so none of it is allowed to abort the refresh.
  const soft = async (label, fn) => {
    try { notes.push(await fn()); } catch (err) { notes.push(`${label} unavailable — ${err.message}`); }
  };

  await soft('ADP', async () => {
    const payload = await call(cfg, 'players');
    const key = scoring === 'STD' ? 'rank_adp' : 'rank_adp_ppr';
    let n = 0;
    for (const r of listOf(payload)) {
      const t = byId.get(r.player_id);
      const adp = num(r[key] ?? r.rank_adp);
      if (t && adp) { t.adp = adp; n++; }
    }
    return `ADP for ${n} players.`;
  });

  await soft('Projections', async () => {
    const payload = await call(cfg, 'projections', { position: 'ALL', scoring, week: '0' });
    let n = 0;
    for (const r of listOf(payload)) {
      const stats = r.stats || {};
      const pts = num(stats[POINTS_KEY[scoring] || 'points'] ?? stats.points);
      if (pts == null) continue;
      const { pos } = splitPos(r.position_id);
      const t = byId.get(r.fpid ?? r.player_id) || byNamePos.get(`${nameKey(r.name)}|${pos}`);
      if (t) { t.projPoints = pts; n++; }
    }
    return `Projections for ${n} players.`;
  });

  await soft('Injuries', async () => {
    const payload = await call(cfg, 'injuries', { week: '0' });
    let n = 0;
    for (const r of listOf(payload)) {
      // The injuries feed uses a different player_id space from rankings, so
      // this joins on name.
      const { pos } = splitPos(r.position_id);
      const t = byNamePos.get(`${nameKey(cleanName(r.name))}|${pos}`);
      if (!t) continue;
      const bits = [r.injury_type, r.comment].filter(Boolean);
      if (r.probability_of_playing != null) bits.push(`${r.probability_of_playing}% likely to play`);
      const practices = [r.practice_1, r.practice_2, r.practice_3].filter(Boolean);
      if (practices.length) bits.push(`practice: ${practices.join('/')}`);
      if (!r.status && !bits.length) continue;
      t.injury = { status: r.status || null, detail: bits.join(' — ').slice(0, 200) || null };
      n++;
    }
    return `Injury status for ${n} players.`;
  });

  await soft('News', async () => {
    const payload = await call(cfg, 'news', { limit: '250' });
    let n = 0;
    for (const r of listOf(payload)) {
      // News carries player_id only — there is no name field on it at all.
      const t = byId.get(r.player_id);
      const text = r.title || r.desc;
      if (!t || !text) continue;
      t.news = t.news || [];
      if (t.news.length < MAX_NEWS_PER_PLAYER) {
        t.news.push({ text: String(text).replace(/\s+/g, ' ').trim().slice(0, 200), date: r.created || null });
        n++;
      }
    }
    return `${n} recent news notes.`;
  });

  for (const p of players) {
    if (p.adp != null && p.ecr != null) p.ecrVsAdp = Math.round((p.adp - p.ecr) * 10) / 10;
  }
  players.sort((a, b) => (a.ecr ?? 1e9) - (b.ecr ?? 1e9));

  const have = (f) => players.filter((p) => p[f] != null).length;
  notes.push(have('projPoints')
    ? 'True VORP available (projected points present).'
    : 'No projected points — values fall back to the rank-based model.');

  return {
    players,
    notes,
    fetchedAt: new Date().toISOString(),
    season,
    scoring,
    coverage: {
      tier: have('tier'), bye: have('bye'), adp: have('adp'), proj: have('projPoints'),
    },
  };
}
