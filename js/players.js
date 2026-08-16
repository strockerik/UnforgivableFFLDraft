// Normalize FantasyPros rankings + ADP exports into one canonical player pool.

import { TEAMS, SUFFIXES } from './config.js';
import { parseTable, num, normHeader } from './csv.js';

// --- header contracts -------------------------------------------------------
// Matched on normalized form, so "AVG." / "AVG" and "BYE WEEK" / "BYEWEEK"
// both land. Alternatives exist because export types vary by year and tier.

const RANK_EXPECTED = ['RK', 'RANK', 'PLAYER NAME', 'PLAYER', 'POS', 'POSITION', 'TEAM'];

// The player column is not consistently named. The premium cheat-sheet export
// uses "PLAYER NAME"; the free overall-rankings export uses "Player"; and the
// per-position exports name the column after the position itself
// ("Running Backs"), which is also the only place the position appears.
const NAME_COLUMNS = [
  'PLAYER NAME', 'PLAYER', 'NAME', 'OVERALL',
  'QUARTERBACKS', 'RUNNING BACKS', 'WIDE RECEIVERS', 'TIGHT ENDS',
  'KICKERS', 'DEFENSES', 'TEAM DEFENSES', 'D/ST', 'FLEX',
];

const POSITION_FROM_NAME_COLUMN = {
  QUARTERBACKS: 'QB', RUNNINGBACKS: 'RB', WIDERECEIVERS: 'WR',
  TIGHTENDS: 'TE', KICKERS: 'K', DEFENSES: 'DST', TEAMDEFENSES: 'DST', DST: 'DST',
};

const ADP_EXPECTED = ['Player Team (Bye)', 'AVG', 'Overall'];
const ADP_KNOWN = ['RANK', 'OVERALL', 'PLAYER TEAM (BYE)', 'AVG', 'AVG.'];

const pick = (rec, ...names) => {
  for (const n of names) {
    const k = normHeader(n);
    if (rec[k] !== undefined && rec[k] !== '') return rec[k];
  }
  return '';
};

// --- name / position helpers ------------------------------------------------

/**
 * "RB1" -> { pos: 'RB', posRank: 1 }; "WR" -> { pos: 'WR', posRank: null }.
 * `fallback` covers per-position exports, which have no position column —
 * the position comes from the name column's header instead.
 */
export function splitPos(raw, fallback = null) {
  const s = String(raw || '').toUpperCase().trim() || String(fallback || '').toUpperCase();
  const m = s.match(/^([A-Z]+)(\d+)?$/);
  if (!m) return { pos: s || null, posRank: null };
  let pos = m[1];
  if (pos === 'D' || pos === 'DEF' || pos === 'DST') pos = 'DST';
  if (pos === 'PK') pos = 'K';
  return { pos, posRank: m[2] ? Number(m[2]) : null };
}

/**
 * Parse the ADP export's single combined cell: "Josh Allen BUF (7)".
 *
 * Parsed right-to-left. Left-to-right splitting breaks on name suffixes —
 * "Patrick Mahomes II KC (10)" would take "II" as the team. Strip the
 * parenthesized bye first, then a trailing token only if it is a real
 * NFL abbreviation.
 */
export function parsePlayerTeamBye(cell) {
  let s = String(cell || '').trim();
  let bye = null;
  let team = null;

  const byeMatch = s.match(/\((\d+)\)\s*$/);
  if (byeMatch) { bye = Number(byeMatch[1]); s = s.slice(0, byeMatch.index).trim(); }

  const parts = s.split(/\s+/);
  if (parts.length > 1) {
    const last = parts[parts.length - 1].toUpperCase();
    if (TEAMS.has(last)) { team = last; parts.pop(); }
  }

  return { name: parts.join(' ').trim(), team, bye };
}

/** Canonical join key: lowercase letters/digits only, suffixes removed. */
export function nameKey(name) {
  const tokens = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !SUFFIXES.has(t));
  return tokens.join('');
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// --- parsing ----------------------------------------------------------------

export function parseRankings(text) {
  const { records, headers, skipped } = parseTable(text, RANK_EXPECTED);
  const players = [];
  const warnings = [];

  // Which column holds the player name, and does that column itself imply the
  // position (per-position exports carry no POS column at all)?
  const nameColumn = NAME_COLUMNS.map(normHeader).find((h) => headers.includes(h));
  if (!nameColumn) {
    throw new Error(
      `No player-name column found. Saw: ${headers.filter(Boolean).slice(0, 10).join(', ')}`
    );
  }
  const impliedPos = POSITION_FROM_NAME_COLUMN[nameColumn] || null;

  const has = (...names) => names.some((n) => headers.includes(normHeader(n)));
  // Report what's absent rather than what's unrecognized — these exports carry
  // a column per expert, so listing unknown headers is pure noise.
  if (!has('TIERS', 'TIER')) {
    warnings.push('No tier column in this export — tier-cliff detection is disabled. ' +
      'The premium cheat-sheet export includes tiers.');
  }
  if (!has('BYE WEEK', 'BYE')) {
    warnings.push('No bye-week column in this export — bye conflicts will not be flagged. ' +
      'Loading an ADP export alongside it supplies byes.');
  }
  if (!has('ADP')) {
    warnings.push('No ADP column in this export — load an ADP export to get market-price signals.');
  }

  for (const r of records) {
    const name = r[nameColumn];
    if (!name) { warnings.push(`Row ${r.__row}: no player name, skipped.`); continue; }

    const { pos, posRank } = splitPos(pick(r, 'POS', 'POSITION'), impliedPos);
    if (!pos) { warnings.push(`Row ${r.__row}: "${name}" has no position, skipped.`); continue; }

    const team = String(pick(r, 'TEAM') || '').toUpperCase() || null;

    players.push({
      id: slug(`${name}-${team || pos}-${pos}`),
      name,
      team,
      pos,
      posRank,
      // A per-position export's "Rank" is positional; its "ECR" is the overall
      // consensus rank. Prefer ECR so cross-position ordering stays meaningful.
      ecr: num(impliedPos ? pick(r, 'ECR', 'RK', 'RANK') : pick(r, 'RK', 'RANK', 'ECR')),
      tier: num(pick(r, 'TIERS', 'TIER')),
      bye: num(pick(r, 'BYE WEEK', 'BYE')),
      sos: num(pick(r, 'SOS SEASON', 'SOS')),
      ecrAvg: num(pick(r, 'AVG.', 'AVG')),
      ecrBest: num(pick(r, 'BEST')),
      ecrWorst: num(pick(r, 'WORST')),
      ecrStdDev: num(pick(r, 'STD.DEV', 'STD DEV')),
      ecrVsAdp: num(pick(r, 'ECR VS. ADP', 'ECR VS ADP')),
      adp: num(pick(r, 'ADP')),
      projPoints: num(pick(r, 'PROJ. PTS', 'PROJ PTS', 'FPTS', 'PROJECTED POINTS', 'POINTS')),
    });
  }

  if (skipped) warnings.push(`Skipped ${skipped} non-data row(s) (title/footer/blank lines).`);
  warnings.unshift(`Parsed ${players.length} players from the "${nameColumn}" column` +
    (impliedPos ? ` (position ${impliedPos} inferred from that column).` : '.'));

  return { players, warnings };
}

export function parseAdp(text) {
  const { records, unknownHeaders, skipped } = parseTable(text, ADP_EXPECTED, []);
  const rows = [];
  const warnings = [];

  for (const r of records) {
    const cell = pick(r, 'PLAYER TEAM (BYE)', 'PLAYER');
    if (!cell) { warnings.push(`ADP row ${r.__row}: no player cell, skipped.`); continue; }
    const { name, team, bye } = parsePlayerTeamBye(cell);
    if (!name) { warnings.push(`ADP row ${r.__row}: could not parse "${cell}".`); continue; }
    rows.push({
      name, team, bye,
      adp: num(pick(r, 'AVG.', 'AVG')),
      adpOverall: num(pick(r, 'OVERALL')),
    });
  }

  // Per-source site columns vary by export, so ADP_KNOWN is intentionally
  // empty above and unknownHeaders stays quiet here.
  void ADP_KNOWN; void unknownHeaders;
  if (skipped) warnings.push(`ADP: skipped ${skipped} non-data row(s).`);

  return { rows, warnings };
}

// --- merge ------------------------------------------------------------------

/**
 * Fold ADP rows into the ranked player pool.
 * Join on name+pos+team, falling back to name+pos, then name alone.
 * Unmatched ADP rows are reported, never silently dropped — losing a player
 * on draft night is worse than a visible warning.
 */
export function mergeAdp(players, adpRows) {
  const warnings = [];
  const byNameTeam = new Map();
  const byName = new Map();

  for (const p of players) {
    const k = nameKey(p.name);
    if (p.team) byNameTeam.set(`${k}|${p.team}`, p);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p);
  }

  let matched = 0;
  for (const row of adpRows) {
    const k = nameKey(row.name);
    let target = row.team ? byNameTeam.get(`${k}|${row.team}`) : null;

    if (!target) {
      const candidates = byName.get(k) || [];
      if (candidates.length === 1) target = candidates[0];
      else if (candidates.length > 1) {
        warnings.push(`ADP "${row.name}" is ambiguous (${candidates.length} matches) — not merged.`);
        continue;
      }
    }

    if (!target) {
      warnings.push(`ADP "${row.name}"${row.team ? ` (${row.team})` : ''} not found in rankings — not merged.`);
      continue;
    }

    if (row.adp != null) target.adp = row.adp;
    if (row.adpOverall != null) target.adpOverall = row.adpOverall;
    if (target.bye == null && row.bye != null) target.bye = row.bye;
    if (!target.team && row.team) target.team = row.team;
    matched++;
  }

  return { matched, warnings };
}

/** De-dupe by id, keep the better (lower) ECR, and sort by ECR. */
export function finalizePool(players) {
  const seen = new Map();
  const warnings = [];

  for (const p of players) {
    const prev = seen.get(p.id);
    if (!prev) { seen.set(p.id, p); continue; }
    warnings.push(`Duplicate entry for "${p.name}" (${p.pos}) — kept the better rank.`);
    if ((p.ecr ?? Infinity) < (prev.ecr ?? Infinity)) seen.set(p.id, p);
  }

  const pool = [...seen.values()].sort(
    (a, b) => (a.ecr ?? Infinity) - (b.ecr ?? Infinity)
  );

  // Backfill positional rank when the export omitted it.
  const counters = {};
  for (const p of pool) {
    counters[p.pos] = (counters[p.pos] || 0) + 1;
    if (p.posRank == null) p.posRank = counters[p.pos];
  }

  return { pool, warnings };
}

/** True when at least one player carries real projected points. */
export function hasProjections(pool) {
  return pool.some((p) => p.projPoints != null);
}
