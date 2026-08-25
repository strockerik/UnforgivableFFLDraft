// Headless tests for the pure logic modules (no DOM, no network).
//
// Run with JavaScriptCore, which ships with macOS:
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/run.mjs
// or with node, if you install it:
//   node tests/run.mjs

import { parseRows, findHeaderRow, normHeader, parseTable, num } from '../js/csv.js';
import { splitPos, parsePlayerTeamBye, nameKey, parseRankings, parseAdp, mergeAdp,
         finalizePool, backfillDerived } from '../js/players.js';
import { replacementLevels, computeValues, biggestDisagreements, leaguePoints } from '../js/vorp.js';
import { pickNumber, myPicks, slotOnClock, roundOf, draftPosition } from '../js/snake.js';
import { evaluate, deterministicPick, buildEvidence, rosterAnalysis, tierCliffs,
         scoreCandidate, flexReplacementPoints, positionNeeds,
         projectBoard, attritionCost } from '../js/engine.js';
import { validateRecommendation, recommend, RECOMMENDATION_SCHEMA } from '../js/claude.js';
import { parseStrategyDoc, applyTags } from '../js/strategy.js';
import { DEFAULT_SETTINGS, BASELINE_SCORING } from '../js/config.js';
import { coachByName, reliableHabits, habitSummary, coachesUntilMyTurn,
         positionsAtRisk, TEAM_TO_COACH } from '../js/coaches.js';
import { makeRng, mockPickFor, unfilledSlots, runOpponentsUntilMyTurn } from '../js/mock.js';
import { toCsv, toCoachingReport, exportFilename } from '../js/export.js';

// --- tiny harness -----------------------------------------------------------
let passed = 0, failed = 0;
const out = (s) => (typeof print === 'function' ? print(s) : console.log(s));

function test(name, fn) {
  try { fn(); passed++; out(`  ok   ${name}`); }
  catch (e) { failed++; out(`  FAIL ${name}\n         ${e.message}`); }
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}expected ${b}, got ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected truthy'); }
function group(name) { out(`\n${name}`); }

// File reading differs between jsc and node.
function slurp(path) {
  if (typeof readFile === 'function') return readFile(path);
  // eslint-disable-next-line no-undef
  return require('fs').readFileSync(path, 'utf-8');
}

// ============================================================================
group('csv.js');

test('parses quoted fields, embedded commas and doubled quotes', () => {
  const rows = parseRows('a,"b,c","say ""hi"""\n1,2,3\n');
  eq(rows[0], ['a', 'b,c', 'say "hi"']);
  eq(rows[1], ['1', '2', '3']);
});

test('strips a UTF-8 BOM from the first cell', () => {
  eq(parseRows('﻿RK,POS\n1,RB1\n')[0], ['RK', 'POS']);
});

test('normalizes header punctuation', () => {
  eq(normHeader('STD.DEV'), 'STDDEV');
  eq(normHeader('BYE WEEK'), 'BYEWEEK');
  eq(normHeader('ECR VS. ADP'), 'ECRVSADP');
  eq(normHeader('Player Team (Bye)'), 'PLAYERTEAMBYE');
});

test('finds the header row beneath title/metadata rows', () => {
  const rows = parseRows('"Some title"\n\nRK,PLAYER NAME,POS,TEAM\n1,X,RB1,SF\n');
  eq(findHeaderRow(rows.filter(r => r.some(c => c !== '')), ['RK', 'PLAYER NAME', 'POS', 'TEAM']), 1);
});

test('skips the footer note line', () => {
  const text = 'RK,PLAYER NAME,POS,TEAM\n1,X,RB1,SF\n\nADP Sources: RTSports, BB10\n';
  const { records } = parseTable(text, ['RK', 'PLAYER NAME', 'POS', 'TEAM']);
  eq(records.length, 1);
});

test('num() tolerates dashes, N/A, plus signs and thousands separators', () => {
  eq(num('-'), null); eq(num('N/A'), null); eq(num(''), null);
  eq(num('+3'), 3); eq(num('1,024'), 1024); eq(num('2.5'), 2.5);
});

// ============================================================================
group('players.js');

test('splits an embedded positional rank out of POS', () => {
  eq(splitPos('RB1'), { pos: 'RB', posRank: 1 });
  eq(splitPos('WR12'), { pos: 'WR', posRank: 12 });
  eq(splitPos('QB'), { pos: 'QB', posRank: null });
});

test('normalizes defense and kicker position spellings', () => {
  eq(splitPos('DEF').pos, 'DST');
  eq(splitPos('D').pos, 'DST');
  eq(splitPos('PK').pos, 'K');
});

test('parses the combined ADP cell', () => {
  eq(parsePlayerTeamBye('Josh Allen BUF (7)'), { name: 'Josh Allen', team: 'BUF', bye: 7 });
});

test('parses a combined ADP cell whose name carries a suffix', () => {
  // The case that defeats left-to-right splitting: "II" is not the team.
  eq(parsePlayerTeamBye('Patrick Mahomes II KC (10)'), { name: 'Patrick Mahomes II', team: 'KC', bye: 10 });
  eq(parsePlayerTeamBye('Marvin Harrison Jr. ARI (11)'), { name: 'Marvin Harrison Jr.', team: 'ARI', bye: 11 });
});

test('does not mistake a non-team trailing token for a team', () => {
  eq(parsePlayerTeamBye('Some Player Zzz (9)'), { name: 'Some Player Zzz', team: null, bye: 9 });
});

test('builds a join key insensitive to punctuation and suffixes', () => {
  eq(nameKey('Marvin Harrison Jr.'), nameKey('Marvin Harrison'));
  eq(nameKey("Ja'Marr Chase"), 'JAMARRCHASE');
  eq(nameKey('Patrick Mahomes II'), 'PATRICKMAHOMES');
});

// ============================================================================
group('players.js — real sample files');

const rankingsText = slurp('data/sample-rankings.csv');
const adpText = slurp('data/sample-adp.csv');
const { players, warnings: rankWarnings } = parseRankings(rankingsText);

test('parses every row of the sample rankings export', () => {
  eq(players.length, 206, `parsed ${players.length}: `);
});

test('reports the skipped title/footer rows rather than failing', () => {
  ok(rankWarnings.some((w) => /Skipped \d+ non-data row/.test(w)), 'expected a skipped-rows note');
});

test('carries tier, bye and spread-of-opinion columns through', () => {
  const p = players[0];
  eq(p.name, 'RB Sample 01');
  eq(p.pos, 'RB'); eq(p.posRank, 1); eq(p.ecr, 1); eq(p.tier, 1);
  ok(p.bye != null, 'bye missing'); ok(p.ecrStdDev != null, 'std dev missing');
});

const { rows: adpRows } = parseAdp(adpText);

test('parses every row of the sample ADP export', () => {
  eq(adpRows.length, 206, `parsed ${adpRows.length}: `);
});

test('merges ADP onto every ranked player, suffixes included', () => {
  const { matched, warnings } = mergeAdp(players, adpRows);
  eq(matched, 206, `matched ${matched}: `);
  eq(warnings.length, 0, `unexpected merge warnings: ${warnings.join(' | ')} `);
  ok(players.find((p) => p.name === 'QB Sample 03 II').adp != null, 'suffixed QB did not receive ADP');
  ok(players.find((p) => p.name === 'WR Sample 11 Jr.').adp != null, 'suffixed WR did not receive ADP');
});

const { pool } = finalizePool(players);

test('finalizes a deduped pool sorted by ECR', () => {
  eq(pool.length, 206);
  eq(pool[0].ecr, 1);
  ok(pool.every((p, i) => i === 0 || p.ecr >= pool[i - 1].ecr), 'pool is not ECR-sorted');
});

// ============================================================================
group('players.js — real FantasyPros exports');

// These are the user's actual downloads. The free "Draft Overall Rankings"
// export differs from the premium cheat-sheet contract the brief described:
// columns are "Player"/"Position" (not "PLAYER NAME"/"POS"), positions carry
// no embedded rank, and there is no tier, bye, or ADP column at all.
let realOverall = null, realSleeper = null;
try {
  realOverall = slurp('Fantasy Ranking/FantasyPros_2026_0814_Draft_Overall_Rankings.csv');
  realSleeper = slurp('Fantasy Ranking/FantasyPros_2026_0814_Sleeper_RB_Rankings.csv');
} catch { /* files not present — skip this group */ }

if (realOverall) {
  const { players: op, warnings: ow } = parseRankings(realOverall);

  test('parses the free Draft Overall Rankings export', () => {
    eq(op.length, 368, `parsed ${op.length}: `);
  });

  test('reads the "Player" and "Position" column names', () => {
    eq(op[0].name, 'Bijan Robinson');   // trailing spaces in the file, trimmed
    eq(op[0].pos, 'RB');
    eq(op[0].team, 'ATL');
    eq(op[0].ecr, 1);
  });

  test('handles apostrophes and hyphens in real names', () => {
    ok(op.some((p) => p.name === "Ja'Marr Chase"), "Ja'Marr Chase missing");
    ok(op.some((p) => p.name === 'Jaxon Smith-Njigba'), 'Jaxon Smith-Njigba missing');
  });

  test('backfills positional rank when the export omits it', () => {
    const { pool: rp } = finalizePool(op.map((p) => ({ ...p })));
    const rbs = rp.filter((p) => p.pos === 'RB');
    eq(rbs[0].posRank, 1);
    eq(rbs[1].posRank, 2);
  });

  test('warns about the columns this export is missing', () => {
    ok(ow.some((w) => /No tier column/.test(w)), 'expected a missing-tier warning');
    ok(ow.some((w) => /No bye-week column/.test(w)), 'expected a missing-bye warning');
    ok(ow.some((w) => /No ADP column/.test(w)), 'expected a missing-ADP warning');
  });

  test('ignores the per-expert columns without flooding the warnings', () => {
    ok(ow.length < 8, `too many warnings (${ow.length}): ${ow.slice(0, 3).join(' | ')}`);
  });

  test('drops the trailing blank rows rather than emitting empty players', () => {
    ok(op.every((p) => p.name && p.pos), 'an empty row became a player');
  });
}

if (realSleeper) {
  const { players: sp } = parseRankings(realSleeper);

  test('parses a per-position export whose player column is "Running Backs"', () => {
    eq(sp.length, 26, `parsed ${sp.length}: `);   // 26 data rows + 2 trailing blanks
    eq(sp.every((p) => p.pos === 'RB'), true, 'position not inferred from the column header');
  });

  test('prefers overall ECR over the positional Rank column', () => {
    const zach = sp.find((p) => p.name === 'Zach Charbonnet');
    eq(zach.ecr, 46);     // ECR column, not the "1" in the Rank column
    eq(zach.adp, 42);
    eq(zach.bye, 11);
    eq(zach.team, 'SEA');
  });
}

// ============================================================================
group('vorp.js');

const settings = { ...DEFAULT_SETTINGS };

test('derives replacement levels from league settings', () => {
  // Replacement is the first UNSTARTABLE player, hence 11 not 10 at QB.
  // WR is 35 because this league starts three, not two.
  const l = replacementLevels(settings);
  eq(l.QB, 11); eq(l.RB, 26); eq(l.WR, 35); eq(l.TE, 12);
});

test('puts the 12-team replacement quarterback at QB13, as the brief cites', () => {
  eq(replacementLevels({ ...settings, teams: 12 }).QB, 13);
  eq(replacementLevels({ ...settings, teams: 12 }).RB, 31);
});

test('a second flex slot pushes RB replacement deeper', () => {
  const l = replacementLevels({ ...settings, roster: { ...settings.roster, FLEX: 2 } });
  eq(l.RB, 31);
});

const { mode } = computeValues(pool, settings);

test('falls back to the labeled surrogate when no projections are present', () => {
  eq(mode, 'surrogate');
});

test('reproduces the water-diamond result under generic scoring', () => {
  // Baseline rules = what a published Half-PPR ranking assumes.
  const p2 = pool.map((p) => ({ ...p }));
  computeValues(p2, { ...settings, scoringRules: { ...BASELINE_SCORING } });
  const top = (pos) => p2.filter((p) => p.pos === pos).sort((a, b) => b.value - a.value)[0].value;
  ok(top('RB') > top('WR'), 'RB1 should out-value WR1');
  ok(top('WR') > top('QB'), 'WR1 should out-value QB1');
  ok(top('QB') > top('K'), 'QB1 should out-value K1');
});

test('6-point passing TDs lift QB value above the generic baseline', () => {
  const qbTop = (rules) => {
    const c = pool.map((p) => ({ ...p }));
    computeValues(c, { ...settings, scoringRules: rules });
    return c.filter((p) => p.pos === 'QB').sort((a, b) => b.value - a.value)[0].value;
  };
  const base = qbTop({ ...BASELINE_SCORING });
  const league = qbTop({ passTd: 6, passInt: -3, reception: 0.5 });
  ok(league > base + 10, `expected a clear QB lift, got ${Math.round(base)} -> ${Math.round(league)}`);
});

test('scoring rules leave positions they do not touch alone', () => {
  const rbTop = (rules) => {
    const c = pool.map((p) => ({ ...p }));
    computeValues(c, { ...settings, scoringRules: rules });
    return c.filter((p) => p.pos === 'RB').sort((a, b) => b.value - a.value)[0].value;
  };
  eq(Math.round(rbTop({ ...BASELINE_SCORING })), Math.round(rbTop({ passTd: 6, passInt: -3, reception: 0.5 })));
});

test('a third WR starter pushes WR replacement deeper and raises elite WR value', () => {
  const wrTop = (roster) => {
    const c = pool.map((p) => ({ ...p }));
    computeValues(c, { ...settings, roster });
    return c.filter((p) => p.pos === 'WR').sort((a, b) => b.value - a.value)[0].value;
  };
  const two = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DST: 1, K: 1 };
  const three = { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, DST: 1, K: 1 };
  eq(replacementLevels({ ...settings, roster: two }).WR, 25);
  eq(replacementLevels({ ...settings, roster: three }).WR, 35);
  ok(wrTop(three) > wrTop(two), 'three WR starters should raise elite WR value');
});

test('the replacement-level player has value at or near zero', () => {
  const rbs = pool.filter((p) => p.pos === 'RB').sort((a, b) => a.posRank - b.posRank);
  const rep = replacementLevels(settings).RB;      // RB26
  ok(Math.abs(rbs[rep - 1].value) < 1, `RB${rep} value should be ~0, got ${rbs[rep - 1].value}`);
});

test('computes true VORP when projections are supplied', () => {
  const withProj = pool.slice(0, 40).map((p) => ({ ...p, projPoints: 300 - p.ecr }));
  const res = computeValues(withProj, settings);
  eq(res.mode, 'projections');
});

test('keeps BOTH valuations when projections are loaded', () => {
  const withProj = pool.slice(0, 60).map((p) => ({ ...p, projPoints: 300 - p.ecr }));
  const res = computeValues(withProj, settings);
  eq(res.hasBoth, true);
  const p = withProj[0];
  ok(p.valueModel != null, 'rank-based value missing');
  ok(p.valueProj != null, 'projection-based value missing');
  eq(p.value, p.valueProj, 'projections should drive the primary value: ');
  eq(p.valueGap, Math.round(p.valueProj - p.valueModel));
});

test('leaves the projection value null when no projections are loaded', () => {
  const c = pool.map((p) => ({ ...p }));
  const res = computeValues(c, settings);
  eq(res.hasBoth, false);
  ok(c[0].valueModel != null, 'rank-based value missing');
  eq(c[0].valueProj, null);
  eq(c[0].valueGap, null);
  eq(c[0].value, c[0].valueModel, 'primary value should fall back to the model: ');
});

test('surfaces the biggest projection-vs-consensus disagreements', () => {
  const withProj = pool.slice(0, 60).map((p, i) => ({
    ...p, projPoints: 300 - p.ecr + (i === 7 ? 250 : 0),   // one big outlier
  }));
  computeValues(withProj, settings);
  const top = biggestDisagreements(withProj, 3);
  ok(top.length === 3, 'expected three');
  eq(top[0].name, withProj[7].name, 'the outlier should rank first: ');
  ok(Math.abs(top[0].valueGap) > Math.abs(top[1].valueGap), 'not sorted by gap size');
});

// ============================================================================
group('snake.js');

test('computes snake pick numbers for a 10-team league from slot 5', () => {
  // The brief's worked example: 5th in odd rounds, 6th in even rounds.
  eq(myPicks({ ...settings, slot: 5, teams: 10, rounds: 6 }), [5, 16, 25, 36, 45, 56]);
});

test('handles the turn at both ends of the snake', () => {
  eq(myPicks({ ...settings, slot: 1, teams: 10, rounds: 4 }), [1, 20, 21, 40]);
  eq(myPicks({ ...settings, slot: 10, teams: 10, rounds: 4 }), [10, 11, 30, 31]);
});

test('slotOnClock inverts pickNumber for every pick in a draft', () => {
  for (let r = 1; r <= 15; r++) {
    for (let s = 1; s <= 10; s++) {
      const n = pickNumber(r, s, 10);
      eq(slotOnClock(n, 10), s, `round ${r} slot ${s} -> pick ${n}: `);
      eq(roundOf(n, 10), r, `pick ${n} round: `);
    }
  }
});

test('reports the gap to the turn after this one', () => {
  const pos = draftPosition(5, { ...settings, slot: 5, teams: 10 });
  ok(pos.isMyPick, 'pick 5 should belong to slot 5');
  eq(pos.picksUntilMyTurn, 0);
  eq(pos.gapToFollowingPick, 11); // 5 -> 16
});

// ============================================================================
group('engine.js');

function mkState(picks = [], s = settings) {
  return { settings: s, pool, picks, valueMode: 'surrogate' };
}
const avail = (st) => {
  const taken = new Set(st.picks.map((p) => p.playerId));
  return pool.filter((p) => !taken.has(p.id));
};

/**
 * A plausible opponent: best available by value, but leaving DST and K until
 * the last two rounds like any human would. Modelling them as pure
 * best-by-value drafted all 28 kickers and defenses by round 12, which is not
 * a harder test — it's an impossible board that no real draft produces.
 */
const opponentPick = (available, round, rounds) => {
  const late = round >= rounds - 1;
  const eligible = late ? available : available.filter((p) => !['DST', 'K'].includes(p.pos));
  const from = eligible.length ? eligible : available;
  return [...from].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];
};

test('recommends a skill player, never a DST or K, in round 1', () => {
  const st = mkState();
  const ev = evaluate(st, avail(st));
  const rec = deterministicPick(ev);
  ok(!['DST', 'K'].includes(rec.primary_pick.position), `got ${rec.primary_pick.position} in round 1`);
});

test('suppresses DST and K until the final two rounds, then surfaces them', () => {
  // Fill 139 picks so we land in round 14 of 15.
  const picks = pool.filter((p) => !['DST', 'K'].includes(p.pos)).slice(0, 130)
    .map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: slotOnClock(i + 1, 10) }));
  const st = mkState(picks);
  const ev = evaluate(st, avail(st));
  eq(ev.position.round, 14);
  const top = ev.ranked[0].player;
  ok(['DST', 'K'].includes(top.pos), `expected DST/K to surface in round 14, got ${top.pos}`);
});

test('assigns starters to slots and reports what is still open', () => {
  const rb1 = pool.find((p) => p.pos === 'RB');
  const wr1 = pool.find((p) => p.pos === 'WR');
  // Derive the slot rather than hardcoding it — the default moved once
  // already when the real draft order arrived.
  const st = mkState([
    { pickNo: 5, playerId: rb1.id, teamSlot: settings.slot },
    { pickNo: 16, playerId: wr1.id, teamSlot: settings.slot },
  ]);
  const a = rosterAnalysis(st);
  eq(a.roster.length, 2);
  eq(a.counts.RB, 1);
  ok(a.unfilled.includes('QB'), 'QB should still be open');
  ok(a.unfilled.includes('TE'), 'TE should still be open');
});

test('ignores picks made by other teams when building your roster', () => {
  const st = mkState([{ pickNo: 1, playerId: pool[0].id, teamSlot: 1 }]);
  eq(rosterAnalysis(st).roster.length, 0);
});

test('flags a tier cliff when a tier is nearly exhausted', () => {
  const rbTier1 = pool.filter((p) => p.pos === 'RB' && p.tier === 1);
  const picks = rbTier1.slice(0, rbTier1.length - 1)
    .map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: slotOnClock(i + 1, 10) }));
  const st = mkState(picks);
  const cliffs = tierCliffs(avail(st));
  eq(cliffs.RB.tier, 1);
  eq(cliffs.RB.remaining, 1);
  ok(cliffs.RB.isCliff, 'one player left in tier should be a cliff');
});

test('detects a positional run inside the lookback window', () => {
  const rbs = pool.filter((p) => p.pos === 'RB').slice(0, 4);
  const picks = rbs.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: slotOnClock(i + 1, 10) }));
  const st = mkState(picks);
  const ev = evaluate(st, avail(st));
  ok(ev.runs.runs.some((r) => r.pos === 'RB' && r.count === 4), 'expected a 4-deep RB run');
});

// ============================================================================
group('engine.js — evidence packet');

const st0 = mkState();
const ev0 = evaluate(st0, avail(st0));
const evidence = buildEvidence(st0, avail(st0), ev0);

test('bounds the packet instead of dumping the whole board', () => {
  const total = Object.values(evidence.board.topAvailableByPosition)
    .reduce((n, list) => n + list.length, 0);
  ok(total <= 48, `packet carried ${total} players`);
  ok(total > 0, 'packet was empty');
});

test('omits DST and K from the packet in the early rounds', () => {
  ok(!evidence.board.topAvailableByPosition.DST, 'DST leaked into a round-1 packet');
  ok(!evidence.board.topAvailableByPosition.K, 'K leaked into a round-1 packet');
});

test('allowlist exactly matches the players offered in the packet', () => {
  const fromBoard = Object.values(evidence.board.topAvailableByPosition).flat().map((p) => p.name);
  eq([...evidence.availablePlayerAllowlist].sort(), fromBoard.sort());
});

test('allowlist never contains a drafted player', () => {
  const taken = pool.slice(0, 20);
  const picks = taken.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: slotOnClock(i + 1, 10) }));
  const st = mkState(picks);
  const ev = evaluate(st, avail(st));
  const e = buildEvidence(st, avail(st), ev);
  const takenNames = new Set(taken.map((p) => p.name));
  const leaked = e.availablePlayerAllowlist.filter((n) => takenNames.has(n));
  eq(leaked, [], `drafted players leaked into the allowlist: `);
});

test('passes injury and news through to the packet when present', () => {
  const enriched = pool.map((p, i) => (i < 3
    ? { ...p, injury: { status: 'Questionable', detail: 'limited practice Wed' },
        news: [{ text: 'Expected to play' }, { text: 'Second note' }, { text: 'Third note' }] }
    : p));
  const st = { settings, pool: enriched, picks: [], valueMode: 'surrogate' };
  const ev = evaluate(st, enriched);
  const e = buildEvidence(st, enriched, ev);
  const withInj = Object.values(e.board.topAvailableByPosition).flat()
    .filter((p) => p.injury);
  ok(withInj.length > 0, 'no injury field reached the packet');
  eq(withInj[0].injury, 'Questionable — limited practice Wed');
  eq(withInj[0].recentNews.length, 2, 'news should be capped at 2 per player: ');
});

test('omits injury and news keys entirely when the pool has none', () => {
  const first = Object.values(evidence.board.topAvailableByPosition).flat()[0];
  eq('injury' in first, false);
  eq('recentNews' in first, false);
});

test('carries the replacement levels and value mode the model needs', () => {
  eq(evidence.league.replacementLevels.RB, replacementLevels(settings).RB);
  eq(evidence.league.valueMode, 'surrogate');
});

// ============================================================================
group('full 15-round mock draft (10 teams)');

// Drive every one of the 150 picks through the real engine, taking whatever
// the deterministic recommender says. This is the crash test: any bad index,
// empty-board case, or illegal roster state shows up here.
const mock = (() => {
  const s = { ...settings, teams: 10, rounds: 15, slot: 5 };
  const st = mkState([], s);
  const total = s.teams * s.rounds;
  const seen = new Set();
  let dstKBeforeEnd = 0;

  // Only your picks come from the engine. The other nine teams take best
  // available by raw value, which is what actually happens in a room and what
  // the app models: you record their picks, whatever they are.
  //
  // Running the needs-aware policy for all 150 picks is not a harder test, it
  // is a different and wrong one — every simulated team then chases YOUR
  // roster holes, which drained all 24 sample TEs by pick 120 and made an
  // unfillable TE slot look like an engine bug.
  for (let i = 1; i <= total; i++) {
    const available = avail(st);
    const ev = evaluate(st, available);
    const mine = ev.position.isMyPick;

    let chosen;
    if (mine) {
      const rec = deterministicPick(ev);
      if (!rec) throw new Error(`no recommendation at pick ${i}`);
      chosen = available.find((p) => p.name === rec.primary_pick.name);
      if (!chosen) throw new Error(`pick ${i} named "${rec.primary_pick.name}", not on the board`);
      if (['DST', 'K'].includes(chosen.pos) && ev.position.round < s.rounds - 1) dstKBeforeEnd++;
    } else {
      chosen = opponentPick(available, ev.position.round, s.rounds);
    }

    if (seen.has(chosen.id)) throw new Error(`pick ${i} duplicated ${chosen.name}`);
    seen.add(chosen.id);
    st.picks.push({ pickNo: i, playerId: chosen.id, teamSlot: slotOnClock(i, s.teams) });
  }
  return { st, s, total, seen, dstKBeforeEnd };
})();

test('completes all 150 picks without an error or a duplicate', () => {
  eq(mock.st.picks.length, mock.total);
  eq(mock.seen.size, mock.total);
});

test('never takes a DST or K before the final two rounds', () => {
  eq(mock.dstKBeforeEnd, 0);
});

test('your 15 picks land on exactly the precomputed snake slots', () => {
  const mine = mock.st.picks.filter((p) => p.teamSlot === mock.s.slot).map((p) => p.pickNo);
  eq(mine, myPicks(mock.s));
});

test('fills every starting slot by the end of the draft', () => {
  const a = rosterAnalysis(mock.st);
  eq(a.unfilled, [], `still open: `);
  eq(a.roster.length, 15);
});

test('never ends the draft with an unfilled starter slot', () => {
  // A regression guard: with 3 WR starters the engine used to spend its last
  // picks on FLEX-eligible WRs and finish with an empty TE.
  const s = { ...settings, teams: 10, rounds: 15, slot: 5 };
  const st = mkState([], s);
  for (let i = 1; i <= s.teams * s.rounds; i++) {
    const available = avail(st);
    const ev = evaluate(st, available);
    const player = ev.position.isMyPick
      ? available.find((p) => p.name === deterministicPick(ev).primary_pick.name)
      : opponentPick(available, ev.position.round, s.rounds);
    st.picks.push({ pickNo: i, playerId: player.id, teamSlot: slotOnClock(i, s.teams) });
  }
  eq(rosterAnalysis(st).unfilled, [], 'left open: ');
});

test('does not over-stack a single position', () => {
  const a = rosterAnalysis(mock.st);
  eq(a.counts.K > 2, false, `drafted ${a.counts.K} kickers: `);
  eq(a.counts.DST > 2, false, `drafted ${a.counts.DST} defenses: `);
});

test('builds a valid evidence packet at every one of your turns', () => {
  const s = { ...settings, teams: 10, rounds: 15, slot: 5 };
  const st = mkState([], s);
  for (let i = 1; i <= s.teams * s.rounds; i++) {
    const available = avail(st);
    const ev = evaluate(st, available);
    let player;
    if (ev.position.isMyPick) {
      const e = buildEvidence(st, available, ev);
      ok(e.availablePlayerAllowlist.length > 0, `empty allowlist at pick ${i}`);
      const takenNames = new Set(st.picks.map((p) =>
        pool.find((x) => x.id === p.playerId).name));
      const leaked = e.availablePlayerAllowlist.filter((n) => takenNames.has(n));
      eq(leaked, [], `pick ${i} leaked drafted players: `);
      player = available.find((p) => p.name === deterministicPick(ev).primary_pick.name);
    } else {
      player = opponentPick(available, ev.position.round, s.rounds);
    }
    st.picks.push({ pickNo: i, playerId: player.id, teamSlot: slotOnClock(i, s.teams) });
  }
});

test('handles a near-empty board without crashing', () => {
  const s = { ...settings, teams: 2, rounds: 2, slot: 1 };
  const tiny = pool.slice(0, 5);
  const st = { settings: s, pool: tiny, picks: [], valueMode: 'surrogate' };
  for (let i = 1; i <= 4; i++) {
    const taken = new Set(st.picks.map((p) => p.playerId));
    const available = tiny.filter((p) => !taken.has(p.id));
    const ev = evaluate(st, available);
    const rec = deterministicPick(ev);
    ok(rec, `no recommendation with ${available.length} left`);
    const player = available.find((p) => p.name === rec.primary_pick.name);
    st.picks.push({ pickNo: i, playerId: player.id, teamSlot: slotOnClock(i, s.teams) });
  }
  eq(st.picks.length, 4);
});

// ============================================================================
group('claude.js — response validation');

const allow = ['RB Sample 01', 'WR Sample 02'];
const good = {
  primary_pick: { name: 'RB Sample 01', position: 'RB',
    reason: 'Highest value on the board and the last back in his tier.' },
  alternatives: [{ name: 'WR Sample 02', position: 'WR',
    reason: 'Comparable value with a safer target share and no injury flag.' }],
  positional_advice: 'Take the back now and attack receiver value at the turn.',
};

test('accepts a well-formed recommendation', () => {
  eq(validateRecommendation(good, allow).ok, true);
});

test('rejects a recommendation naming a player who is already drafted', () => {
  const bad = { ...good, primary_pick: { ...good.primary_pick, name: 'Someone Drafted' } };
  const res = validateRecommendation(bad, allow);
  eq(res.ok, false);
  ok(res.errors[0].includes('not an available player'), res.errors[0]);
});

test('rejects a drafted player hiding in the alternatives', () => {
  const bad = { ...good, alternatives: [{ name: 'Ghost Player', position: 'WR', reason: 'x' }] };
  eq(validateRecommendation(bad, allow).ok, false);
});

test('rejects structurally malformed responses', () => {
  eq(validateRecommendation({}, allow).ok, false);
  eq(validateRecommendation({ ...good, alternatives: 'nope' }, allow).ok, false);
  eq(validateRecommendation({ ...good, positional_advice: 42 }, allow).ok, false);
});

// ============================================================================
group('pool swap');

test('re-matches recorded picks into a new pool by name and position', () => {
  // The real case: picks recorded off a thin CSV, then the full API file is
  // loaded. Ids differ between sources, so the join has to be on name.
  const oldPool = pool.slice(0, 40).map((p) => ({ ...p, id: 'old-' + p.id }));
  const newPool = pool.map((p) => ({ ...p, id: 'new-' + p.id }));
  const picks = oldPool.slice(0, 5).map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: i + 1 }));

  const index = new Map(newPool.map((p) => [`${nameKey(p.name)}|${p.pos}`, p]));
  const kept = [];
  const lost = [];
  for (const pick of picks) {
    const old = oldPool.find((x) => x.id === pick.playerId);
    const match = index.get(`${nameKey(old.name)}|${old.pos}`);
    if (match) kept.push(match); else lost.push(old.name);
  }
  eq(kept.length, 5, 'all five should re-match: ');
  eq(lost, []);
  eq(kept.every((p) => p.id.startsWith('new-')), true, 'should point at the new pool');
});

test('reports a pick that has no counterpart rather than dropping it', () => {
  const oldPool = [{ id: 'a', name: 'Ghost Of Drafts Past', pos: 'RB', team: 'ZZZ' }];
  const index = new Map(pool.map((p) => [`${nameKey(p.name)}|${p.pos}`, p]));
  const match = index.get(`${nameKey(oldPool[0].name)}|${oldPool[0].pos}`);
  eq(match, undefined, 'should not match anything');
});

// ============================================================================
group('strategy.js');

const STRAT_DOC = `### PART 1 — STRATEGY

## Draft philosophy for this league
Six-point passing touchdowns make an elite QB a top-3 asset here.

### PART 2 — PLAYER TAGS

\`\`\`json
{
  "generated": "2026-08-16",
  "players": [
    { "name": "RB Sample 01", "pos": "RB", "team": "PIT", "tags": ["volume-king"],
      "confidence": "high", "note": "Every-down back." },
    { "name": "WR Sample 11 Jr.", "pos": "WR", "tags": ["sleeper", "not-a-real-tag"],
      "confidence": "medium", "note": "Suffix name, and one bogus tag." },
    { "name": "Nobody At All", "pos": "TE", "team": "ZZZ", "tags": ["bust"],
      "confidence": "low", "note": "Should not match anything." }
  ]
}
\`\`\`
`;

test('splits prose from the player-tag JSON block', () => {
  const { strategyText, tags } = parseStrategyDoc(STRAT_DOC);
  ok(strategyText.includes('Six-point passing touchdowns'), 'prose missing');
  eq(strategyText.includes('json'), false, 'the JSON block leaked into the prose: ');
  eq(tags.length, 3);
});

test('drops unrecognized tags but keeps the entry', () => {
  const { tags, warnings } = parseStrategyDoc(STRAT_DOC);
  const wr = tags.find((t) => t.name.startsWith('WR Sample 11'));
  eq(wr.tags, ['sleeper']);
  ok(warnings.some((w) => w.includes('not-a-real-tag')), 'no warning for the bogus tag');
});

test('survives a malformed JSON block without losing the prose', () => {
  const broken = STRAT_DOC.replace('"generated"', '"generated" oops');
  const { strategyText, tags, warnings } = parseStrategyDoc(broken);
  ok(strategyText.includes('Six-point'), 'prose should still load');
  eq(tags, []);
  ok(warnings.some((w) => /invalid/i.test(w)), 'expected an invalid-JSON warning');
});

test('attaches tags to the pool and reports what did not match', () => {
  const p2 = pool.map((p) => ({ ...p }));
  const { tags } = parseStrategyDoc(STRAT_DOC);
  const { matched, unmatched } = applyTags(p2, tags);
  eq(matched, 2, 'expected the two real players to match: ');
  eq(unmatched.length, 1);
  eq(unmatched[0].name, 'Nobody At All');
  const rb = p2.find((p) => p.name === 'RB Sample 01');
  eq(rb.tags, ['volume-king']);
  eq(rb.tagNote, 'Every-down back.');
});

test('matches a suffixed name the same way the player merge does', () => {
  const p2 = pool.map((p) => ({ ...p }));
  applyTags(p2, parseStrategyDoc(STRAT_DOC).tags);
  const wr = p2.find((p) => p.name === 'WR Sample 11 Jr.');
  eq(wr.tags, ['sleeper']);
});

test('reloading replaces tags rather than accumulating them', () => {
  // The document gets revised repeatedly before draft day, so a reload must
  // not leave stale tags behind on players dropped from the new version.
  const p2 = pool.map((p) => ({ ...p }));
  applyTags(p2, parseStrategyDoc(STRAT_DOC).tags);
  ok(p2.find((p) => p.name === 'RB Sample 01').tags, 'first load did not attach');

  applyTags(p2, [{ name: 'WR Sample 11 Jr.', pos: 'WR', tags: ['bust'], note: 'changed my mind' }]);
  eq(p2.find((p) => p.name === 'RB Sample 01').tags, undefined, 'stale tag survived a reload: ');
  eq(p2.find((p) => p.name === 'WR Sample 11 Jr.').tags, ['bust']);
});

test('an empty tag list clears every tag', () => {
  const p2 = pool.map((p) => ({ ...p }));
  applyTags(p2, parseStrategyDoc(STRAT_DOC).tags);
  applyTags(p2, []);
  eq(p2.filter((p) => p.tags).length, 0);
});

test('carries tags into the evidence packet, and drops them when drafted', () => {
  const p2 = pool.map((p) => ({ ...p }));
  applyTags(p2, parseStrategyDoc(STRAT_DOC).tags);
  const st = { settings, pool: p2, picks: [], valueMode: 'surrogate' };
  const ev = evaluate(st, p2);
  const e = buildEvidence(st, p2, ev);
  const tagged = Object.values(e.board.topAvailableByPosition).flat().filter((x) => x.tags);
  ok(tagged.length > 0, 'no tagged player reached the packet');
  ok(tagged[0].tagNote, 'tagNote missing from the packet');

  // Draft the tagged player; he must vanish from the packet entirely.
  const rb = p2.find((p) => p.name === 'RB Sample 01');
  const st2 = { ...st, picks: [{ pickNo: 1, playerId: rb.id, teamSlot: 1 }] };
  const avail2 = p2.filter((p) => p.id !== rb.id);
  const e2 = buildEvidence(st2, avail2, evaluate(st2, avail2));
  eq(e2.availablePlayerAllowlist.includes('RB Sample 01'), false);
});

// ============================================================================
group('claude.js — direct vs proxy transport');

// Capture what recommend() would put on the wire, without a network.
function captureRequest(opts) {
  const realFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = (url, init) => {
    captured = { url, init };
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(good) }],
        usage: { input_tokens: 10, output_tokens: 5 },
        model: opts.model,
      }),
    });
  };
  const done = recommend({ evidence, ...opts });
  return done.then((r) => { globalThis.fetch = realFetch; return { captured, result: r }; },
                   (e) => { globalThis.fetch = realFetch; throw e; });
}

const directOpts = { authMode: 'direct', apiKey: 'sk-ant-test', model: 'claude-opus-5', effort: 'low' };
const proxyOpts = {
  authMode: 'proxy', proxyUrl: 'https://example.workers.dev', passphrase: 'hunter2',
  model: 'claude-opus-5', effort: 'low',
};

await captureRequest(directOpts).then(({ captured }) => {
  test('direct mode sends the key and the browser-access header', () => {
    eq(captured.url, 'https://api.anthropic.com/v1/messages');
    eq(captured.init.headers['x-api-key'], 'sk-ant-test');
    eq(captured.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  });
});

await captureRequest(proxyOpts).then(({ captured }) => {
  test('proxy mode targets the Worker, not Anthropic', () => {
    eq(captured.url, 'https://example.workers.dev');
  });

  test('proxy mode never puts an API key or the dangerous header on the wire', () => {
    const h = captured.init.headers;
    eq('x-api-key' in h, false, 'x-api-key leaked to the proxy: ');
    eq('anthropic-dangerous-direct-browser-access' in h, false, 'dangerous header leaked: ');
    eq(h['x-app-passphrase'], 'hunter2');
    eq(JSON.stringify(captured.init).includes('sk-ant'), false, 'a key string leaked: ');
  });

  test('proxy mode still sends the full request body the Worker relays', () => {
    const body = JSON.parse(captured.init.body);
    eq(body.model, 'claude-opus-5');
    eq(body.output_config.format.type, 'json_schema');
    ok(Array.isArray(body.system) && body.system.length === 2, 'system prompt missing');
    eq(body.system[1].cache_control.type, 'ephemeral');
  });
});

async function expectKind(opts, kind, label) {
  try {
    await recommend({ evidence, ...opts });
    test(label, () => { throw new Error('expected a ClaudeError'); });
  } catch (e) {
    test(label, () => eq(e.kind, kind));
  }
}
await expectKind({ authMode: 'proxy', passphrase: 'x', model: 'claude-opus-5' },
  'no-proxy', 'proxy mode without a Worker URL fails before any request');
await expectKind({ authMode: 'proxy', proxyUrl: 'https://x.dev', model: 'claude-opus-5' },
  'no-key', 'proxy mode without a passphrase fails before any request');
await expectKind({ authMode: 'direct', model: 'claude-opus-5' },
  'no-key', 'direct mode without an API key fails before any request');

test('a tag record carries its analyst source count through the parser', () => {
  // Regression: parseStrategyDoc rebuilds each record field by field, so a new
  // field is silently dropped unless it is added there too. The count reached
  // the document and the board code and still rendered "bust undefined/undefined".
  const doc = parseStrategyDoc([
    'Prose.', '', '```json',
    JSON.stringify({ players: [
      { name: 'Someone Real', pos: 'RB', team: 'SF', tags: ['bust'],
        confidence: 'high', note: 'n', sources: 7, sourcesOf: 8 },
    ] }),
    '```',
  ].join('\n'));
  eq(doc.tags[0].sources, 7, 'sources: ');
  eq(doc.tags[0].sourcesOf, 8, 'sourcesOf: ');
});

test('a non-numeric source count is dropped rather than rendered as NaN', () => {
  const doc = parseStrategyDoc([
    'Prose.', '', '```json',
    JSON.stringify({ players: [
      { name: 'A', pos: 'RB', tags: ['bust'], sources: 'lots', sourcesOf: 8 },
      { name: 'B', pos: 'WR', tags: ['bust'] },
    ] }),
    '```',
  ].join('\n'));
  eq(doc.tags[0].sources, null, 'garbage becomes null, not NaN: ');
  eq(doc.tags[1].sources, null, 'absent stays null: ');
});

test('source counts attach to players and clear on reload', () => {
  const p = [{ id: 'x', name: 'Someone Real', pos: 'RB', team: 'SF', value: 10 }];
  const tags = [{ name: 'Someone Real', pos: 'RB', team: 'SF', tags: ['bust'],
                  confidence: 'high', note: 'n', sources: 7, sourcesOf: 8 }];
  applyTags(p, tags);
  eq(p[0].tagSources, 7);
  eq(p[0].tagSourcesOf, 8);
  // Reloading a document that no longer flags him must not leave a stale count.
  applyTags(p, [{ name: 'Someone Real', pos: 'RB', team: 'SF', tags: ['breakout'] }]);
  eq(p[0].tags, ['breakout']);
  eq(p[0].tagSources, undefined, 'stale count must be cleared: ');
});

test('the real strategy document gives every bust tag a source count', () => {
  // A bust chip with no count renders bare, which is the thing we set out to
  // fix — so this asserts against the actual shipped document.
  const doc = parseStrategyDoc(slurp('data/strategy.md'));
  const busts = doc.tags.filter((t) => t.tags.includes('bust'));
  ok(busts.length >= 16, `expected 16+ bust tags, found ${busts.length}`);
  const bare = busts.filter((t) => t.sources == null).map((t) => t.name);
  eq(bare, [], 'every bust tag needs a count: ');
  const overOne = busts.filter((t) => t.sources > t.sourcesOf).map((t) => t.name);
  eq(overOne, [], 'no count may exceed the number of sources surveyed: ');
});

test('Josh Allen carries no bust tag despite appearing on two lists', () => {
  // The rejection filter is the load-bearing part of the bust research: both
  // lists argue "QB is deep, wait", which is calibrated to 4-point passing TDs.
  // This league pays 6, where he is QB1 by ~48 points.
  const doc = parseStrategyDoc(slurp('data/strategy.md'));
  const allen = doc.tags.find((t) => t.name === 'Josh Allen');
  ok(allen, 'Josh Allen should still be tagged');
  ok(!allen.tags.includes('bust'), `expected no bust tag, got ${JSON.stringify(allen.tags)}`);
});

// ============================================================================
group('opponent model (js/coaches.js)');

test('reliableHabits keeps tight patterns and drops noisy ones', () => {
  const alex = coachByName('Alex');
  const habits = reliableHabits(alex);
  const positions = habits.map((h) => h.pos);
  // RB spread 0 and WR spread 0 across four seasons — the whole point.
  ok(positions.includes('RB'), 'Alex RB (spread 0) should survive');
  ok(positions.includes('WR'), 'Alex WR (spread 0) should survive');
  // QB spread 4 is too noisy to act on.
  ok(!positions.includes('QB'), 'Alex QB (spread 4) should be filtered out');
});

test('a coach with no tight pattern reports none rather than inventing one', () => {
  const mark = coachByName('Mark');
  ok(!reliableHabits(mark).some((h) => h.pos === 'QB'),
    "Mark's QB spread is 7 — must not be presented as a habit");
});

test('habitSummary flags a never-varying drafter', () => {
  ok(habitSummary(coachByName('Alex')).includes('never varies'),
    'Alex opened RB in every one of the last four seasons');
});

test('a drifted habit reports the recent number and says it moved', () => {
  // Josh took his first QB in round 6 for 2016-21 and round 4.5 since. The
  // decade average would describe neither era, so the recent number must win.
  const josh = habitSummary(coachByName('Josh'));
  ok(josh.includes('r4.5'), `expected the recent mean, got: ${josh}`);
  ok(!josh.includes('r6.0'), 'must not present the stale mean as current');
  ok(/moved up from 6\.0/.test(josh), `expected drift to be surfaced, got: ${josh}`);
});

test('a decade-long trait is distinguished from a recent one', () => {
  ok(habitSummary(coachByName('Erik')).includes('10yr'),
    'Erik has opened RB then WR for ten years');
});

test('noisy positions never reach the model, however extreme the mean', () => {
  // Robert E. has a TE spread of 8 rounds — an average of 6.0 built from
  // rounds 2 and 10 predicts nothing and must not be surfaced.
  const robert = coachByName('Robert E.');
  ok(!reliableHabits(robert).some((h) => h.pos === 'TE'), 'TE spread 8 must be dropped');
  eq(habitSummary(robert), 'no reliable pattern');
});

test('coachesUntilMyTurn walks the snake in order', () => {
  const order = ['A', 'B', 'C', 'D'];
  const clock = (p) => slotOnClock(p, 4);
  // Picks 2..4 in round 1 are slots 2,3,4.
  const got = coachesUntilMyTurn(order, clock, 2, 5).map((u) => u.name);
  eq(got, ['B', 'C', 'D'], 'round 1 forward: ');
  // Round 2 reverses: pick 5 is slot 4, 6 is slot 3.
  eq(coachesUntilMyTurn(order, clock, 5, 7).map((u) => u.name), ['D', 'C'], 'round 2 reversed: ');
});

test('positionsAtRisk only counts coaches who have reached their habit round', () => {
  const upcoming = [{ coach: coachByName('Alex') }];   // RB r1.0, WR r2.0
  const r1 = positionsAtRisk(upcoming, 1).map((x) => x.pos);
  ok(r1.includes('RB'), 'RB is at risk in round 1');
  const r8 = positionsAtRisk(upcoming, 8).map((x) => x.pos);
  ok(r8.includes('RB') && r8.includes('WR'), 'both are live by round 8');
});

test('unknown coach names produce no opponent model rather than throwing', () => {
  const order = ['Stranger', 'Nobody'];
  const upcoming = coachesUntilMyTurn(order, (p) => slotOnClock(p, 2), 1, 3);
  eq(upcoming.filter((u) => u.coach).length, 0, 'no history for strangers: ');
  eq(positionsAtRisk(upcoming, 5), [], 'and nothing at risk: ');
});

test('evidence packet carries the opponent model without touching the allowlist', () => {
  const st = mkState();
  const ev = buildEvidence(st, avail(st), evaluate(st, avail(st)));
  ok(Array.isArray(ev.opponentsBeforeYourNextPick), 'section present');
  ok(ev.opponentsBeforeYourNextPick.length > 0, 'slot 7 has coaches ahead of it');
  ok(ev.opponentsBeforeYourNextPick.every((o) => o.coach && o.reliableHabits),
    'each entry names a coach and a habit summary');
  // The opponent model must never leak into the availability contract.
  ok(ev.availablePlayerAllowlist.length > 0, 'allowlist still populated');
  ok(!JSON.stringify(ev.availablePlayerAllowlist).includes('reliableHabits'),
    'allowlist unpolluted');
});

test('a position at its cap is not offered in the evidence packet', () => {
  // Live failure: with Pitts and Goedert already rostered, the packet still
  // listed the top TEs and the model recommended a third. Forbidding it in the
  // prompt while continuing to show it is a weaker guarantee than not showing
  // it -- the same reasoning as excluding drafted players from the allowlist.
  const settings = { ...DEFAULT_SETTINGS };
  const roster = [
    { id: 't1', name: 'TE1', pos: 'TE', value: 30, tier: 2, adp: 40 },
    { id: 't2', name: 'TE2', pos: 'TE', value: 10, tier: 5, adp: 90 },
    { id: 'q1', name: 'QB1', pos: 'QB', value: 60, tier: 2, adp: 30 },
    { id: 'r1', name: 'RB1', pos: 'RB', value: 90, tier: 1, adp: 5 },
  ];
  const board = [
    ...roster,
    { id: 't3', name: 'TE3', pos: 'TE', value: 8, tier: 6, adp: 120 },
    { id: 'r2', name: 'RB2', pos: 'RB', value: 40, tier: 3, adp: 50 },
    { id: 'w1', name: 'WR1', pos: 'WR', value: 35, tier: 3, adp: 55 },
  ];
  const st = { settings, pool: board, valueMode: 'projections',
    picks: roster.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  const avail = board.filter((p) => !roster.some((r) => r.id === p.id));
  const packet = buildEvidence(st, avail, evaluate(st, avail));

  ok(!('TE' in packet.board.topAvailableByPosition), 'TE is capped at 2 and must not be offered');
  ok(!packet.availablePlayerAllowlist.includes('TE3'), 'nor reachable through the allowlist');
  ok('RB' in packet.board.topAvailableByPosition, 'uncapped positions still appear');
  ok(packet.availablePlayerAllowlist.includes('RB2'), 'and stay in the allowlist');
});

test('an uncapped roster still sees every position', () => {
  const settings = { ...DEFAULT_SETTINGS };
  const roster = [{ id: 'r1', name: 'RB1', pos: 'RB', value: 90, tier: 1, adp: 5 }];
  const board = [roster[0],
    { id: 't1', name: 'TE1', pos: 'TE', value: 30, tier: 2, adp: 40 },
    { id: 'q1', name: 'QB1', pos: 'QB', value: 60, tier: 2, adp: 30 },
    { id: 'w1', name: 'WR1', pos: 'WR', value: 35, tier: 3, adp: 55 }];
  const st = { settings, pool: board, valueMode: 'projections',
    picks: [{ pickNo: 1, playerId: 'r1', teamSlot: settings.slot }] };
  const avail = board.filter((p) => p.id !== 'r1');
  const packet = buildEvidence(st, avail, evaluate(st, avail));
  for (const pos of ['QB', 'TE', 'WR']) {
    ok(pos in packet.board.topAvailableByPosition, `${pos} should be offered`);
  }
});

test('legacy saved settings migrate team names to coach names', () => {
  const legacy = {
    draftOrder: ['Vegan Beer', 'Dad Bod', 'The Juice is Loose'],
    myTeamName: 'Vegan Beer',
  };
  const migrated = {
    ...legacy,
    draftOrder: legacy.draftOrder.map((n) => TEAM_TO_COACH[n] || n),
    myTeamName: TEAM_TO_COACH[legacy.myTeamName] || legacy.myTeamName,
  };
  eq(migrated.draftOrder, ['Erik', 'Rob K.', 'Josh'], 'order: ');
  eq(migrated.myTeamName, 'Erik', 'my name: ');
  // Idempotent — running it again changes nothing.
  eq(migrated.draftOrder.map((n) => TEAM_TO_COACH[n] || n), ['Erik', 'Rob K.', 'Josh'],
    'second pass: ');
});

test('tierCliffs measures what waiting past the tier actually costs', () => {
  const avail = [
    { pos: 'RB', tier: 2, value: 59 },              // last of tier 2
    { pos: 'RB', tier: 3, value: 55 }, { pos: 'RB', tier: 3, value: 50 },
    { pos: 'TE', tier: 2, value: 62 }, { pos: 'TE', tier: 2, value: 58 },
    { pos: 'TE', tier: 4, value: 35 },              // tier numbers may skip
  ];
  const c = tierCliffs(avail);
  eq(c.RB.dropToNextTier, 4, 'RB: 59 - 55 = ');
  eq(c.TE.dropToNextTier, 23, 'TE: worst of tier 2 (58) - best of tier 4 (35) = ');
  ok(c.RB.isCliff && c.TE.isCliff, 'both tiers are thin');
});

test('a shallow cliff no longer outranks a clearly better player', () => {
  // The live failure: a 59-value RB whose "cliff" was worth 4 points beat a
  // 72-value WR, because every cliff paid a flat +25.
  const settings = { ...DEFAULT_SETTINGS };
  const st = { settings, pool: [], valueMode: 'projections', picks: [] };
  const avail = [
    { pos: 'RB', tier: 2, value: 59 }, { pos: 'RB', tier: 3, value: 55 },
    { pos: 'WR', tier: 2, value: 72 }, { pos: 'WR', tier: 2, value: 62 },
    { pos: 'WR', tier: 2, value: 59 },
  ];
  const ctx = { analysis: rosterAnalysis(st), position: draftPosition(19, settings),
    settings, cliffs: tierCliffs(avail), flexBaseline: 175, wantsUpside: false };
  const rb = scoreCandidate({ pos: 'RB', tier: 2, value: 59, projPoints: 200 }, ctx);
  const wr = scoreCandidate({ pos: 'WR', tier: 2, value: 72, projPoints: 224 }, ctx);
  ok(wr > rb, `a 13-point value edge must beat a 4-point cliff (wr ${wr.toFixed(1)} vs rb ${rb.toFixed(1)})`);
});

test('a deep cliff still earns its urgency', () => {
  // The other half: a genuine 24-point TE cliff SHOULD outrank a modestly
  // better receiver, because the replacement TE is far worse than the
  // replacement WR.
  const settings = { ...DEFAULT_SETTINGS };
  const st = { settings, pool: [], valueMode: 'projections', picks: [] };
  const avail = [
    { pos: 'TE', tier: 2, value: 62 }, { pos: 'TE', tier: 4, value: 35 },
    { pos: 'WR', tier: 2, value: 72 }, { pos: 'WR', tier: 2, value: 66 },
    { pos: 'WR', tier: 2, value: 64 },
  ];
  const ctx = { analysis: rosterAnalysis(st), position: draftPosition(19, settings),
    settings, cliffs: tierCliffs(avail), flexBaseline: 175, wantsUpside: false };
  const te = scoreCandidate({ pos: 'TE', tier: 2, value: 62, projPoints: 200 }, ctx);
  const wr = scoreCandidate({ pos: 'WR', tier: 2, value: 72, projPoints: 224 }, ctx);
  ok(te > wr, `a 27-point cliff should beat a 10-point value edge (te ${te.toFixed(1)} vs wr ${wr.toFixed(1)})`);
});

test('the cliff bonus is capped and never negative', () => {
  const avail = [
    { pos: 'RB', tier: 1, value: 300 }, { pos: 'RB', tier: 2, value: 10 },
    { pos: 'WR', tier: 1, value: 20 }, { pos: 'WR', tier: 2, value: 60 },
  ];
  const c = tierCliffs(avail);
  ok(c.RB.dropToNextTier === 290, 'raw drop is reported honestly');
  // An inverted "drop" — the next tier grades higher — must clamp to zero
  // rather than subtract from the score.
  eq(c.WR.dropToNextTier, 0, 'inverted drop clamps: ');
});

test('a position with no tier below reports no drop', () => {
  const c = tierCliffs([{ pos: 'K', tier: 8, value: 5 }]);
  eq(c.K.dropToNextTier, null, 'nothing below to fall to: ');
});

// ============================================================================
group('engine.js — attrition-based urgency');

test('the projection window is exactly the opponents picks, never your own', () => {
  // The serpentine turn is the trap: from slot 1, picks 20 and 21 are back to
  // back, so ZERO players come off the board in between. An off-by-one here
  // projects your own pick as an opponent's and invents urgency.
  const settings = { ...DEFAULT_SETTINGS, teams: 10, slot: 1 };
  const mine = myPicks(settings);
  eq(mine.slice(0, 3), [1, 20, 21], 'slot 1 picks: ');
  eq(mine[1] - mine[0] - 1, 18, 'picks between 1 and 20: ');
  eq(mine[2] - mine[1] - 1, 0, 'picks between 20 and 21: ');
});

test('projectBoard removes exactly one player per intervening pick', () => {
  const pool5 = Array.from({ length: 40 }, (_, i) => ({
    id: 'p' + i, name: 'P' + i, pos: i % 2 ? 'WR' : 'RB',
    value: 100 - i, adp: i + 1, tier: 1 + Math.floor(i / 8), projPoints: 200 - i,
  }));
  const settings = { ...DEFAULT_SETTINGS, teams: 10, slot: 5 };
  const st = { settings, pool: pool5, picks: [], valueMode: 'projections' };
  eq(projectBoard(st, pool5, 6, 16).size, 10, 'ten intervening picks: ');
  eq(projectBoard(st, pool5, 21, 21).size, 0, 'empty window at the turn: ');
  eq(projectBoard(st, pool5, 21, 20).size, 0, 'inverted window is empty, not negative: ');
});

test('attritionCost reports the best SURVIVOR, and null when a position empties', () => {
  const avail = [
    { id: 'a', pos: 'RB', value: 100 }, { id: 'b', pos: 'RB', value: 60 },
    { id: 'c', pos: 'WR', value: 90 },
  ];
  const cost = attritionCost(avail, new Set(['a']));
  eq(cost.RB, 60, 'best surviving RB: ');
  eq(cost.WR, 90, 'untouched WR: ');
  // Everyone gone is not the same as "the best left is worth zero" — treating
  // it as zero would manufacture enormous urgency out of an empty pool.
  eq(attritionCost(avail, new Set(['a', 'b'])).RB, null, 'emptied position: ');
});

test('a player projected to survive carries no urgency', () => {
  const settings = { ...DEFAULT_SETTINGS };
  const st = { settings, pool: [], valueMode: 'projections', picks: [] };
  const base = { analysis: rosterAnalysis(st), position: draftPosition(19, settings),
    settings, cliffs: {}, flexBaseline: 175, wantsUpside: false };
  const p = { pos: 'WR', value: 80, projPoints: 200, tier: 1 };
  // survivingValue at his own value or better -> nothing is lost by waiting.
  const safe = scoreCandidate(p, { ...base, survivingValue: { WR: 80 } });
  const doomed = scoreCandidate(p, { ...base, survivingValue: { WR: 40 } });
  ok(doomed > safe, `a player about to vanish must outrank one who will not (${doomed.toFixed(1)} vs ${safe.toFixed(1)})`);
  ok(Math.abs((doomed - safe) - 40) < 0.01, 'and by exactly the drop he represents');
});

test('urgency is uncapped, because it is commensurate with value', () => {
  // Two-pick lookahead: A(100, urgency 40) then B(110) = 210, versus B(110)
  // then A-position survivor(60) = 170. The 40-point edge must survive intact
  // or the comparison stops being arithmetic.
  const settings = { ...DEFAULT_SETTINGS };
  const st = { settings, pool: [], valueMode: 'projections', picks: [] };
  const ctx = { analysis: rosterAnalysis(st), position: draftPosition(19, settings),
    settings, cliffs: {}, flexBaseline: 175, wantsUpside: false,
    survivingValue: { RB: 60, WR: 110 } };
  const a = scoreCandidate({ pos: 'RB', value: 100, projPoints: 240, tier: 1 }, ctx);
  const b = scoreCandidate({ pos: 'WR', value: 110, projPoints: 250, tier: 1 }, ctx);
  ok(a > b, `A should win by the urgency margin (${a.toFixed(1)} vs ${b.toFixed(1)})`);
});

test('jumbled tier boundaries no longer hide an urgent position', () => {
  // The live failure: WR tier 1 ran down to 72 while tier 2's best was 84, so
  // dropToNextTier clamped to 0 and WR read as "no cliff" while three elite
  // receivers were about to disappear.
  const avail = [
    { id: 'w1', pos: 'WR', tier: 1, value: 129 }, { id: 'w2', pos: 'WR', tier: 1, value: 117 },
    { id: 'w3', pos: 'WR', tier: 1, value: 109 }, { id: 'w4', pos: 'WR', tier: 1, value: 72 },
    { id: 'w5', pos: 'WR', tier: 2, value: 84 },
  ];
  eq(tierCliffs(avail).WR.dropToNextTier, 0, 'the tier signal really is zero here: ');
  // Attrition sees it correctly once the top three are projected gone.
  eq(attritionCost(avail, new Set(['w1', 'w2', 'w3'])).WR, 84, 'best surviving: ');
});

test('with no projection the tier-cliff fallback still applies', () => {
  const settings = { ...DEFAULT_SETTINGS };
  const st = { settings, pool: [], valueMode: 'projections', picks: [] };
  const cliffs = tierCliffs([
    { pos: 'TE', tier: 2, value: 62 }, { pos: 'TE', tier: 4, value: 35 },
  ]);
  const ctx = { analysis: rosterAnalysis(st), position: draftPosition(19, settings),
    settings, cliffs, flexBaseline: 175, wantsUpside: false, survivingValue: null };
  const withCliff = scoreCandidate({ pos: 'TE', tier: 2, value: 62, projPoints: 200 }, ctx);
  const noCliff = scoreCandidate({ pos: 'TE', tier: 9, value: 62, projPoints: 200 }, ctx);
  ok(withCliff > noCliff, 'the measured cliff still fires when ADP is absent');
});

// ============================================================================
group('engine.js — roster construction caps');

test('flexReplacementPoints uses the best non-starting flex-eligible player', () => {
  const levels = { RB: 26, WR: 35, TE: 12 };
  const fake = [
    ...Array.from({ length: 30 }, (_, i) => ({ pos: 'RB', projPoints: 300 - i * 5 })),
    ...Array.from({ length: 40 }, (_, i) => ({ pos: 'WR', projPoints: 280 - i * 4 })),
    ...Array.from({ length: 15 }, (_, i) => ({ pos: 'TE', projPoints: 200 - i * 5 })),
  ];
  // RB26 = 300 - 25*5 = 175; WR35 = 280 - 34*4 = 144; TE12 = 200 - 11*5 = 145.
  eq(flexReplacementPoints(fake, levels), 175, 'should take the highest: ');
});

test('flexReplacementPoints returns null without projections', () => {
  eq(flexReplacementPoints([{ pos: 'RB', projPoints: null }], { RB: 1 }), null);
  eq(flexReplacementPoints([], { RB: 1 }), null);
});

test('a surplus QB scores below a bench receiver', () => {
  // The bug this guards: VORP said a backup QB (+4) beat a bench WR, because
  // QB replacement projects 304 points and WR replacement 152. He can never
  // occupy the FLEX, so that comparison is meaningless.
  const settings = { ...DEFAULT_SETTINGS };
  const filled = [
    { id: 'a', name: 'QB1', pos: 'QB', value: 60, projPoints: 360 },
    { id: 'b', name: 'RB1', pos: 'RB', value: 90, projPoints: 265 },
    { id: 'c', name: 'RB2', pos: 'RB', value: 60, projPoints: 235 },
    { id: 'd', name: 'WR1', pos: 'WR', value: 50, projPoints: 202 },
    { id: 'e', name: 'WR2', pos: 'WR', value: 40, projPoints: 192 },
    { id: 'f', name: 'WR3', pos: 'WR', value: 30, projPoints: 182 },
    { id: 'g', name: 'TE1', pos: 'TE', value: 30, projPoints: 164 },
    { id: 'h', name: 'FLEXRB', pos: 'RB', value: 25, projPoints: 200 },
  ];
  const st = { settings, pool: filled, valueMode: 'projections',
    picks: filled.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  const analysis = rosterAnalysis(st);
  const ctx = { analysis, position: draftPosition(99, settings), settings,
    cliffs: {}, flexBaseline: 175 };
  const qb2 = scoreCandidate({ name: 'QB2', pos: 'QB', value: 4, projPoints: 307 }, ctx);
  const wr = scoreCandidate({ name: 'WR6', pos: 'WR', value: 11, projPoints: 163 }, ctx);
  ok(wr > qb2, `bench WR (${wr.toFixed(1)}) must beat a backup QB (${qb2.toFixed(1)})`);
});

test('position caps are hard, not a weighting', () => {
  const settings = { ...DEFAULT_SETTINGS };
  // Two QBs and two TEs already rostered, starters otherwise full.
  const roster = [
    { id: 'q1', pos: 'QB', value: 60 }, { id: 'q2', pos: 'QB', value: 10 },
    { id: 't1', pos: 'TE', value: 30 }, { id: 't2', pos: 'TE', value: 12 },
    { id: 'r1', pos: 'RB', value: 90 }, { id: 'r2', pos: 'RB', value: 60 },
    { id: 'w1', pos: 'WR', value: 50 }, { id: 'w2', pos: 'WR', value: 40 },
    { id: 'w3', pos: 'WR', value: 30 }, { id: 'f1', pos: 'RB', value: 25 },
  ];
  const st = { settings, pool: roster, valueMode: 'projections',
    picks: roster.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  const ctx = { analysis: rosterAnalysis(st), position: draftPosition(99, settings),
    settings, cliffs: {}, flexBaseline: 175 };
  // Even an outstanding third QB/TE must lose to a mediocre receiver.
  const qb3 = scoreCandidate({ pos: 'QB', value: 80, projPoints: 400 }, ctx);
  const te3 = scoreCandidate({ pos: 'TE', value: 80, projPoints: 240 }, ctx);
  const wr = scoreCandidate({ pos: 'WR', value: -5, projPoints: 150 }, ctx);
  ok(wr > qb3, `a 3rd QB must be unreachable (wr ${wr.toFixed(0)} vs qb ${qb3.toFixed(0)})`);
  ok(wr > te3, `a 3rd TE must be unreachable (wr ${wr.toFixed(0)} vs te ${te3.toFixed(0)})`);
});

test('the flex baseline is not double-penalised by depth heuristics', () => {
  // Regression: a sixth WR scored -70 while a far worse RB scored -35, because
  // the receiver collected the stacking penalty AND the surplus discount on
  // top of a flex-baseline comparison that had already priced him correctly.
  // Among surplus flex-eligible players, ordering must track raw points.
  const settings = { ...DEFAULT_SETTINGS };
  const roster = [
    { id: 'q', pos: 'QB', value: 60 }, { id: 'r1', pos: 'RB', value: 90 },
    { id: 'r2', pos: 'RB', value: 60 }, { id: 'w1', pos: 'WR', value: 50 },
    { id: 'w2', pos: 'WR', value: 45 }, { id: 'w3', pos: 'WR', value: 40 },
    { id: 'w4', pos: 'WR', value: 20 }, { id: 'w5', pos: 'WR', value: 15 },
    { id: 't1', pos: 'TE', value: 30 },
  ];
  const st = { settings, pool: roster, valueMode: 'projections',
    picks: roster.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  const ctx = { analysis: rosterAnalysis(st), position: draftPosition(99, settings),
    settings, cliffs: {}, flexBaseline: 175 };
  // Sixth WR projecting MORE points than a spare RB must score higher.
  const wr6 = scoreCandidate({ pos: 'WR', value: -7, projPoints: 145 }, ctx);
  const rb3 = scoreCandidate({ pos: 'RB', value: -36, projPoints: 140 }, ctx);
  ok(wr6 > rb3, `WR6 at 145 pts (${wr6.toFixed(1)}) must beat RB at 140 pts (${rb3.toFixed(1)})`);
});

test('the upside quota lifts a sleeper only once starters are full', () => {
  const settings = { ...DEFAULT_SETTINGS, sleeperQuota: 1 };
  const sleeper = { pos: 'RB', value: -36, projPoints: 140, tags: ['sleeper'] };
  const plain = { pos: 'RB', value: -20, projPoints: 155 };

  // Starters NOT full: the sleeper must not jump a better player.
  const empty = { settings, pool: [], valueMode: 'projections', picks: [] };
  const early = { analysis: rosterAnalysis(empty), position: draftPosition(5, settings),
    settings, cliffs: {}, flexBaseline: 175, wantsUpside: true };
  ok(scoreCandidate(plain, early) > scoreCandidate(sleeper, early),
    'upside must not outrank value while a starting slot is open');

  // Starters full: now the bonus applies.
  const roster = [
    { id: 'q', pos: 'QB', value: 60 }, { id: 'r1', pos: 'RB', value: 90 },
    { id: 'r2', pos: 'RB', value: 60 }, { id: 'w1', pos: 'WR', value: 50 },
    { id: 'w2', pos: 'WR', value: 45 }, { id: 'w3', pos: 'WR', value: 40 },
    { id: 't1', pos: 'TE', value: 30 }, { id: 'f1', pos: 'RB', value: 25 },
  ];
  const full = { settings, pool: roster, valueMode: 'projections',
    picks: roster.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  const late = { analysis: rosterAnalysis(full), position: draftPosition(99, settings),
    settings, cliffs: {}, flexBaseline: 175, wantsUpside: true };
  ok(scoreCandidate(sleeper, late) > scoreCandidate(plain, late),
    'on a full bench the lottery ticket should win');

  // Quota already met -> no bonus, value wins again.
  const met = { ...late, wantsUpside: false };
  ok(scoreCandidate(plain, met) > scoreCandidate(sleeper, met),
    'once the quota is met the bonus must stop applying');
});

test('only an RB or WR sleeper satisfies the upside quota', () => {
  // A backup quarterback is a lottery ticket for a raffle you are not entered
  // in: with QB capped at two and one starter, he plays the week his starter
  // is out and otherwise never. Jared Goff satisfied the quota in a live draft
  // while a tagged WR sleeper sat unclaimed.
  const settings = { ...DEFAULT_SETTINGS, sleeperQuota: 1 };
  const withQb = [
    { id: 'q1', name: 'QB1', pos: 'QB', value: 60 },
    { id: 'q2', name: 'QB2', pos: 'QB', value: -3, tags: ['sleeper'] },
    { id: 'r1', name: 'RB1', pos: 'RB', value: 90 }, { id: 'r2', name: 'RB2', pos: 'RB', value: 60 },
    { id: 'w1', name: 'WR1', pos: 'WR', value: 50 }, { id: 'w2', name: 'WR2', pos: 'WR', value: 45 },
    { id: 'w3', name: 'WR3', pos: 'WR', value: 40 }, { id: 't1', name: 'TE1', pos: 'TE', value: 30 },
    { id: 'f1', name: 'FLEX', pos: 'RB', value: 25 },
  ];
  const st = { settings, pool: withQb, valueMode: 'projections',
    picks: withQb.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  const ev = evaluate(st, []);
  ok(ev.wantsUpside, 'a QB sleeper must NOT satisfy the quota');

  // Swap him for a receiver carrying the same tag.
  const withWr = withQb.map((p) => (p.id === 'q2'
    ? { id: 'w4', name: 'WR4', pos: 'WR', value: -3, tags: ['sleeper'] } : p));
  const st2 = { settings, pool: withWr, valueMode: 'projections',
    picks: withWr.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  ok(!evaluate(st2, []).wantsUpside, 'a WR sleeper must satisfy it');
});

test('the upside bonus never lifts a tagged QB or TE', () => {
  const settings = { ...DEFAULT_SETTINGS, sleeperQuota: 1 };
  const roster = [
    { id: 'q', pos: 'QB', value: 60 }, { id: 'r1', pos: 'RB', value: 90 },
    { id: 'r2', pos: 'RB', value: 60 }, { id: 'w1', pos: 'WR', value: 50 },
    { id: 'w2', pos: 'WR', value: 45 }, { id: 'w3', pos: 'WR', value: 40 },
    { id: 't1', pos: 'TE', value: 30 }, { id: 'f1', pos: 'RB', value: 25 },
  ];
  const st = { settings, pool: roster, valueMode: 'projections',
    picks: roster.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  const ctx = { analysis: rosterAnalysis(st), position: draftPosition(120, settings),
    settings, cliffs: {}, flexBaseline: 175, wantsUpside: true, survivingValue: null };
  const plainWr = scoreCandidate({ pos: 'WR', value: -12, projPoints: 140 }, ctx);
  const sleeperWr = scoreCandidate({ pos: 'WR', value: -12, projPoints: 140, tags: ['sleeper'] }, ctx);
  const sleeperQb = scoreCandidate({ pos: 'QB', value: -3, projPoints: 300, tags: ['sleeper'] }, ctx);
  const plainQb = scoreCandidate({ pos: 'QB', value: -3, projPoints: 300 }, ctx);
  ok(sleeperWr > plainWr, 'a tagged receiver gets the bonus');
  eq(Math.round(sleeperQb), Math.round(plainQb), 'a tagged QB gets nothing: ');
});

test('the packet reports the quota so it cannot fire silently', () => {
  const settings = { ...DEFAULT_SETTINGS, sleeperQuota: 1 };
  const roster = [
    { id: 'r1', name: 'RB1', pos: 'RB', value: 90, tier: 1, adp: 5 },
    { id: 'w1', name: 'WR1', pos: 'WR', value: 50, tier: 2, adp: 20, tags: ['sleeper'] },
  ];
  const st = { settings, pool: roster, valueMode: 'projections',
    picks: roster.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  const q = buildEvidence(st, [], evaluate(st, [])).upsideQuota;
  eq(q.wanted, 1);
  eq(q.held, ['WR1'], 'names who satisfied it: ');
  eq(q.countsOnlyAt, ['RB', 'WR']);
  eq(q.stillWanted, false, 'and says it is met: ');
});

// The engine's conclusion was absent from the packet for the whole life of the
// app, and the model quietly disagreed with it at pick 17 of a live practice
// draft -- recommending a QB in prose that had already concluded RB was the
// priority. Nothing on screen or in the payload marked the disagreement.
test('the packet states the engine ranking, in order, with the gaps', () => {
  const settings = { ...DEFAULT_SETTINGS };
  const avail = [
    { id: 'h', name: 'Henry', pos: 'RB', value: 89, tier: 2, adp: 16 },
    { id: 'l', name: 'London', pos: 'WR', value: 84, tier: 2, adp: 19 },
    { id: 'a', name: 'Allen', pos: 'QB', value: 71, tier: 3, adp: 23 },
  ];
  const st = { settings, pool: avail, picks: [], valueMode: 'projections' };
  const ev = evaluate(st, avail);
  const rank = buildEvidence(st, avail, ev).engineRanking;
  ok(Array.isArray(rank) && rank.length, 'the packet must carry a ranking');
  eq(rank[0].rank, 1);
  eq(rank[0].name, ev.ranked[0].player.name, 'rank 1 must be the engine top pick: ');
  eq(rank[0].pointsBehindTop, 0, 'the leader trails himself by nothing: ');
  // The gap is what separates a close call from a blowout, so it must be real.
  for (let i = 1; i < rank.length; i += 1) {
    ok(rank[i].pointsBehindTop >= rank[i - 1].pointsBehindTop,
      'gaps must grow monotonically down the ranking');
    eq(rank[i].pointsBehindTop, Math.round(ev.ranked[0].score - ev.ranked[i].score),
      'gap is measured against the leader: ');
  }
  ok(rank[rank.length - 1].pointsBehindTop > 0,
    'a trailing candidate must show a positive deficit');
});

// The exact board that failed: Erik held Bijan, six picks stood between him and
// his next turn, QB attrition was 0 and RB attrition was 34. The engine wanted
// the running back. Guarding it directly, because this is the shape of error
// that survived 169 tests.
test('a zero-attrition QB never outranks a high-attrition RB of greater value', () => {
  const settings = { ...DEFAULT_SETTINGS };
  const bijan = { id: 'b', name: 'Bijan', pos: 'RB', value: 120, tier: 1, adp: 4 };
  const avail = [
    { id: 'h', name: 'Henry', pos: 'RB', value: 89, tier: 2, adp: 16 },
    { id: 'a', name: 'Allen', pos: 'QB', value: 71, tier: 3, adp: 23 },
  ];
  const st = { settings, pool: [bijan, ...avail], valueMode: 'projections',
    picks: [{ pickNo: 1, playerId: 'b', teamSlot: settings.slot }] };
  const ev = evaluate(st, avail);
  eq(ev.ranked[0].player.name, 'Henry',
    'the more valuable RB must lead the QB he outgrades by 18: ');
  const rank = buildEvidence(st, avail, ev).engineRanking;
  eq(rank[0].name, 'Henry', 'and the packet must say so out loud: ');
});

// Round 12 of a live draft offered two Green Bay receivers: Jayden Reed at -7
// untagged, Matthew Golden at -19 with a sleeper tag. The quota was already
// filled by a tagged RB, so the tag was worth nothing and the engine ranked
// Reed 16 points ahead. It read as the tag overriding value, and the tag is
// worth 25 -- more than the 12-point gap -- so the suspicion was reasonable.
// A spent quota must stay spent.
test('a tag stops being worth anything once the quota is filled', () => {
  const settings = { ...DEFAULT_SETTINGS, sleeperQuota: 1 };
  // The lineup must be FULL, or a receiver fills an empty WR slot and the
  // starter bonus -- not the tag -- decides the comparison.
  const roster = [
    { id: 'q', pos: 'QB', value: 40 }, { id: 'r1', pos: 'RB', value: 90 },
    { id: 'r2', pos: 'RB', value: 60 }, { id: 'w1', pos: 'WR', value: 50 },
    { id: 'w2', pos: 'WR', value: 45 }, { id: 'w3', pos: 'WR', value: 40 },
    { id: 't1', pos: 'TE', value: 30 }, { id: 'f1', pos: 'RB', value: 25 },
    { id: 'jcm', name: 'Croskey-Merritt', pos: 'RB', value: 10, tags: ['sleeper'] },
  ];
  const st = { settings, pool: roster, valueMode: 'projections',
    picks: roster.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  const ctx = { analysis: rosterAnalysis(st), position: draftPosition(117, settings),
    settings, cliffs: {}, flexBaseline: 175,
    wantsUpside: evaluate(st, []).wantsUpside };
  eq(ctx.wantsUpside, false, 'one tagged RB fills a quota of one: ');
  const reed = { pos: 'WR', value: -7, projPoints: 145 };
  const golden = { pos: 'WR', value: -19, projPoints: 134, tags: ['sleeper'] };
  ok(scoreCandidate(reed, ctx) > scoreCandidate(golden, ctx),
    'the better receiver must win once the tag has nothing left to buy');
  // And the bonus must be the whole difference when the quota IS open, so a
  // regression in the gate shows up here rather than silently reordering.
  const open = { ...ctx, wantsUpside: true };
  ok(scoreCandidate(golden, open) > scoreCandidate(golden, ctx),
    'an open quota must still pay the tagged player');
});

// Injuries are the only signal Claude holds that the engine does not, so they
// have to arrive intact. Alec Pierce was drafted in round 8 of a practice draft
// two days after ankle surgery put him on PUP, because the channel was empty.
test('injury status and its severity both reach the packet', () => {
  const settings = { ...DEFAULT_SETTINGS };
  const avail = [
    { id: 'p', name: 'Pierce', pos: 'WR', value: 12, adp: 92,
      injury: { status: 'PUP', severity: 'high', detail: 'Ankle, Surgery (reported 2d ago)' } },
    { id: 'h', name: 'Healthy', pos: 'WR', value: 11, adp: 93 },
  ];
  const st = { settings, pool: avail, picks: [], valueMode: 'projections' };
  const wr = buildEvidence(st, avail, evaluate(st, avail)).board.topAvailableByPosition.WR;
  const hurt = wr.find((p) => p.name === 'Pierce');
  ok(hurt.injury.includes('PUP'), 'the status must be in the packet');
  ok(hurt.injury.includes('2d ago'), 'and its age, so a stale flag can be discounted');
  eq(hurt.injurySeverity, 'high', 'graded severity travels separately from the label: ');
  // A healthy player must carry no injury key at all -- an empty string or a
  // null would invite the model to speculate about a report that does not exist.
  eq(wr.find((p) => p.name === 'Healthy').injury, undefined,
    'a healthy player must have no injury field: ');
});

// The engine must keep ignoring injuries. If it starts pricing them, the
// projection double-counts (a projection already discounts a known absence)
// AND the override loses the only information that justifies it.
test('the engine still scores injured and healthy players identically', () => {
  const settings = { ...DEFAULT_SETTINGS };
  const ctx = { analysis: rosterAnalysis({ settings, pool: [], picks: [] }),
    position: draftPosition(80, settings), settings, cliffs: {}, flexBaseline: 175 };
  const base = { pos: 'WR', value: 12, projPoints: 150 };
  eq(scoreCandidate({ ...base, injury: { status: 'IR', severity: 'high' } }, ctx),
    scoreCandidate(base, ctx),
    'injury must not move the deterministic score: ');
});

// Single-source valuation is subject to the optimizer's curse: a roster built
// by maximizing one source's numbers is selected for that source's optimism.
// Measured on a practice draft, Erik's starters fell 460 -> 374 when re-scored
// against ESPN while the league total barely moved.
test('projections from two sources are averaged, not concatenated', () => {
  const S = { ...DEFAULT_SETTINGS };
  // 300 receiving yards apart: FantasyPros 30 pts, ESPN 60 pts, blend 45.
  const pool = [{ id: 'a', name: 'Split', pos: 'WR', posRank: 1, ecr: 1,
    projStats: { rec_rec: 0, rec_yds: 300, rec_tds: 0 },
    espnStats: { rec_rec: 0, rec_yds: 600, rec_tds: 0 } }];
  const r = computeValues(pool, S);
  eq(pool[0].projPointsFp, 30, 'FantasyPros line scored under league rules: ');
  eq(pool[0].projPointsEspn, 60, 'ESPN line scored under the SAME rules: ');
  eq(pool[0].projPoints, 45, 'and averaged 50/50: ');
  eq(pool[0].sourceGap, 30, 'with the disagreement recorded: ');
  eq(r.blended, 1);
});

test('blending is skippable and a lone source still works', () => {
  const S = { ...DEFAULT_SETTINGS };
  const one = [{ id: 'a', pos: 'WR', posRank: 1,
    projStats: { rec_rec: 0, rec_yds: 300, rec_tds: 0 },
    espnStats: { rec_rec: 0, rec_yds: 600, rec_tds: 0 } }];
  eq(computeValues(one, { ...S, blendSources: false }).blended, 0);
  eq(one[0].projPoints, 30, 'blend off falls back to FantasyPros alone: ');
  eq(one[0].sourceGap, 30, 'but the disagreement is still measured: ');
  // A player ESPN never projected must not be dropped or zeroed.
  const solo = [{ id: 'b', pos: 'WR', posRank: 1,
    projStats: { rec_rec: 0, rec_yds: 300, rec_tds: 0 } }];
  computeValues(solo, S);
  eq(solo[0].projPoints, 30, 'a FantasyPros-only player keeps his projection: ');
  eq(solo[0].sourceGap, null, 'and has no disagreement to report: ');
});

// The blend must happen AFTER league scoring. Averaging the sources' published
// totals would average a 4-point passing TD with a 6-point one.
test('the blend applies this league scoring to BOTH sources', () => {
  const S = { ...DEFAULT_SETTINGS };
  const qb = [{ id: 'q', pos: 'QB', posRank: 1,
    projStats: { pass_yds: 0, pass_tds: 10, pass_ints: 0 },
    espnStats: { pass_yds: 0, pass_tds: 20, pass_ints: 0 } }];
  computeValues(qb, S);
  // 6-point TDs: 60 and 120, averaging 90. At 4-point they would be 40/80 -> 60.
  eq(qb[0].projPointsFp, 60, "FantasyPros TDs paid at this league's 6: ");
  eq(qb[0].projPointsEspn, 120, 'ESPN TDs paid at the same 6, not their default 4: ');
  eq(qb[0].projPoints, 90);
});

test('the upside bonus is bounded and never reaches a kicker', () => {
  const settings = { ...DEFAULT_SETTINGS, sleeperQuota: 1 };
  const roster = [
    { id: 'q', pos: 'QB', value: 60 }, { id: 'r1', pos: 'RB', value: 90 },
    { id: 'r2', pos: 'RB', value: 60 }, { id: 'w1', pos: 'WR', value: 50 },
    { id: 'w2', pos: 'WR', value: 45 }, { id: 'w3', pos: 'WR', value: 40 },
    { id: 't1', pos: 'TE', value: 30 }, { id: 'f1', pos: 'RB', value: 25 },
  ];
  const st = { settings, pool: roster, valueMode: 'projections',
    picks: roster.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  const ctx = { analysis: rosterAnalysis(st), position: draftPosition(99, settings),
    settings, cliffs: {}, flexBaseline: 175, wantsUpside: true };
  // A far better player must still win — the bonus buys a ticket, not a bad roster.
  const great = { pos: 'RB', value: 40, projPoints: 220 };
  const sleeper = { pos: 'RB', value: -36, projPoints: 140, tags: ['sleeper'] };
  ok(scoreCandidate(great, ctx) > scoreCandidate(sleeper, ctx),
    'a clearly better player must not be displaced by the upside bonus');
  // A tagged kicker must stay suppressed (Harrison Mevis carries the tag).
  const k = { pos: 'K', value: 5, projPoints: 136, tags: ['sleeper'] };
  ok(scoreCandidate(k, ctx) < -500, 'a tagged kicker must remain gated to the last rounds');
});

test('the first TE backup is credited when the starter bye is uncovered', () => {
  // The flex baseline scores a surplus TE on raw points and is blind to
  // whether the slot can be filled at all. An eighth receiver cannot start in
  // the week your only tight end is out.
  const settings = { ...DEFAULT_SETTINGS };
  const roster = [
    { id: 'q', pos: 'QB', value: 60, bye: 7 }, { id: 'r1', pos: 'RB', value: 90, bye: 5 },
    { id: 'r2', pos: 'RB', value: 60, bye: 6 }, { id: 'w1', pos: 'WR', value: 50, bye: 3 },
    { id: 'w2', pos: 'WR', value: 45, bye: 4 }, { id: 'w3', pos: 'WR', value: 40, bye: 8 },
    { id: 't1', pos: 'TE', value: 30, bye: 10 }, { id: 'f1', pos: 'RB', value: 25, bye: 9 },
  ];
  const st = { settings, pool: roster, valueMode: 'projections',
    picks: roster.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  const ctx = { analysis: rosterAnalysis(st), position: draftPosition(119, settings),
    settings, cliffs: {}, flexBaseline: 175, wantsUpside: false };
  const te = { pos: 'TE', value: 0, projPoints: 137, bye: 13 };
  const wr = { pos: 'WR', value: -7, projPoints: 145, bye: 11 };
  ok(scoreCandidate(te, ctx) > scoreCandidate(wr, ctx),
    'a TE2 covering the bye must beat a replacement-level 8th receiver');
});

test('a backup sharing the starter bye is credited nothing', () => {
  const settings = { ...DEFAULT_SETTINGS };
  const roster = [
    { id: 'q', pos: 'QB', value: 60, bye: 7 }, { id: 'r1', pos: 'RB', value: 90, bye: 5 },
    { id: 'r2', pos: 'RB', value: 60, bye: 6 }, { id: 'w1', pos: 'WR', value: 50, bye: 3 },
    { id: 'w2', pos: 'WR', value: 45, bye: 4 }, { id: 'w3', pos: 'WR', value: 40, bye: 8 },
    { id: 't1', pos: 'TE', value: 30, bye: 10 }, { id: 'f1', pos: 'RB', value: 25, bye: 9 },
  ];
  const st = { settings, pool: roster, valueMode: 'projections',
    picks: roster.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  const ctx = { analysis: rosterAnalysis(st), position: draftPosition(119, settings),
    settings, cliffs: {}, flexBaseline: 175, wantsUpside: false };
  const covers = scoreCandidate({ pos: 'TE', value: 0, projPoints: 137, bye: 13 }, ctx);
  const shares = scoreCandidate({ pos: 'TE', value: 0, projPoints: 137, bye: 10 }, ctx);
  ok(covers > shares, `same-bye backup covers nothing (${shares.toFixed(1)} vs ${covers.toFixed(1)})`);
});

test('a backup QB is not credited, per the strategy document', () => {
  // "If you land a Tier 1/2 QB, you do not need a second." A one-week bye is
  // the easiest hole in fantasy to stream.
  const settings = { ...DEFAULT_SETTINGS };
  const roster = [
    { id: 'q', pos: 'QB', value: 69, bye: 7 }, { id: 'r1', pos: 'RB', value: 90, bye: 5 },
    { id: 'r2', pos: 'RB', value: 60, bye: 6 }, { id: 'w1', pos: 'WR', value: 50, bye: 3 },
    { id: 'w2', pos: 'WR', value: 45, bye: 4 }, { id: 'w3', pos: 'WR', value: 40, bye: 8 },
    { id: 't1', pos: 'TE', value: 30, bye: 10 }, { id: 'f1', pos: 'RB', value: 25, bye: 9 },
  ];
  const st = { settings, pool: roster, valueMode: 'projections',
    picks: roster.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  const ctx = { analysis: rosterAnalysis(st), position: draftPosition(119, settings),
    settings, cliffs: {}, flexBaseline: 175, wantsUpside: false };
  const qb2 = scoreCandidate({ pos: 'QB', value: 0, projPoints: 334, bye: 8 }, ctx);
  const te2 = scoreCandidate({ pos: 'TE', value: 0, projPoints: 137, bye: 13 }, ctx);
  ok(te2 > qb2, `the TE2 must win the bench slot (te ${te2.toFixed(1)} vs qb ${qb2.toFixed(1)})`);
});

test('byeCoverCredit 0 disables the credit', () => {
  const settings = { ...DEFAULT_SETTINGS, byeCoverCredit: 0 };
  const roster = [
    { id: 'q', pos: 'QB', value: 60, bye: 7 }, { id: 'r1', pos: 'RB', value: 90, bye: 5 },
    { id: 'r2', pos: 'RB', value: 60, bye: 6 }, { id: 'w1', pos: 'WR', value: 50, bye: 3 },
    { id: 'w2', pos: 'WR', value: 45, bye: 4 }, { id: 'w3', pos: 'WR', value: 40, bye: 8 },
    { id: 't1', pos: 'TE', value: 30, bye: 10 }, { id: 'f1', pos: 'RB', value: 25, bye: 9 },
  ];
  const st = { settings, pool: roster, valueMode: 'projections',
    picks: roster.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  const ctx = { analysis: rosterAnalysis(st), position: draftPosition(119, settings),
    settings, cliffs: {}, flexBaseline: 175, wantsUpside: false };
  const te = scoreCandidate({ pos: 'TE', value: 0, projPoints: 137, bye: 13 }, ctx);
  const wr = scoreCandidate({ pos: 'WR', value: -7, projPoints: 145, bye: 11 }, ctx);
  ok(wr > te, 'with the credit off the raw-points comparison wins again');
});

test('a cap never blocks filling a mandatory starter slot', () => {
  // K and DST are capped at 1, but the endgame must still be able to fill an
  // empty K slot in the final round.
  const settings = { ...DEFAULT_SETTINGS };
  const st = { settings, pool: [], valueMode: 'projections', picks: [] };
  const ctx = { analysis: rosterAnalysis(st), position: draftPosition(150, settings),
    settings, cliffs: {}, flexBaseline: 175 };
  const k = scoreCandidate({ pos: 'K', value: 1, projPoints: 133 }, ctx);
  ok(k > -1000, `an unfilled K slot must remain fillable, scored ${k.toFixed(0)}`);
});

// ============================================================================
group('vorp.js — league scoring from projection components');

test('leaguePoints reproduces the published half-PPR total under baseline rules', () => {
  // Puka Nacua, straight from the API: 1539/10 + 9*6 + 117*0.5 + 85/10
  // + 1.39*6 - 0.98*2 = 281.3, matching its own points_half exactly.
  const stats = { rec_rec: 117, rec_yds: 1539, rec_tds: 9, rush_yds: 85,
                  rush_tds: 1.39, fumbles: 0.98, '2pt_tds': 0, ret_tds: 0 };
  const pts = leaguePoints(stats, BASELINE_SCORING);
  ok(Math.abs(pts - 281.3) < 0.1, `expected ~281.3, got ${pts.toFixed(2)}`);
});

test('the baseline scores an interception at -1, as FantasyPros does', () => {
  // Verified empirically: rebuilding points_half matches at -1 and is off by
  // exactly pass_ints at -2. Getting this wrong halved the -3 adjustment.
  eq(BASELINE_SCORING.passInt, -1);
  const stats = { pass_yds: 4000, pass_tds: 30, pass_ints: 10 };
  const base = leaguePoints(stats, BASELINE_SCORING);
  const league = leaguePoints(stats, { passTd: 6, passInt: -3, reception: 0.5 });
  // +2/TD on 30 TDs = +60; -2/INT on 10 INTs = -20. Net +40.
  ok(Math.abs((league - base) - 40) < 0.01, `expected +40, got ${(league - base).toFixed(2)}`);
});

test('six-point passing TDs move QBs and leave receivers untouched', () => {
  const qb = { pass_yds: 4000, pass_tds: 30, pass_ints: 10, rush_yds: 300, rush_tds: 4 };
  const wr = { rec_rec: 100, rec_yds: 1300, rec_tds: 8 };
  const rules = { passTd: 6, passInt: -3, reception: 0.5 };
  ok(leaguePoints(qb, rules) > leaguePoints(qb, BASELINE_SCORING), 'QB must gain');
  eq(leaguePoints(wr, rules), leaguePoints(wr, BASELINE_SCORING), 'WR must not move: ');
});

test('missing or unusable components fall back rather than scoring zero', () => {
  eq(leaguePoints(null, BASELINE_SCORING), null, 'null stats: ');
  eq(leaguePoints({}, BASELINE_SCORING), null, 'empty stats: ');
  // A defence's stat object has no scoring components we can use; returning 0
  // would rank every DST above real players.
  eq(leaguePoints({ def_sack: 40, def_int: 12 }, BASELINE_SCORING), null, 'DST stats: ');
  eq(leaguePoints({ fg: 30, fga: 34, xpt: 40 }, BASELINE_SCORING), null, 'K stats: ');
});

test('computeValues re-scores from components and keeps the published figure', () => {
  const pool = [
    { id: 'q', name: 'Q', pos: 'QB', posRank: 1, projPoints: 300,
      projStats: { pass_yds: 4000, pass_tds: 30, pass_ints: 10 } },
    { id: 'w', name: 'W', pos: 'WR', posRank: 1, projPoints: 200,
      projStats: { rec_rec: 100, rec_yds: 1300, rec_tds: 8 } },
  ];
  computeValues(pool, DEFAULT_SETTINGS);
  const qb = pool[0];
  ok(qb.projPointsGeneric === 300, 'published figure preserved');
  ok(qb.projPoints !== 300, 'projPoints re-scored under league rules');
  ok(qb.projPoints > 300, `6-pt TDs should raise him, got ${qb.projPoints}`);
});

test('a player with no components keeps the published projection', () => {
  const pool = [{ id: 'x', name: 'X', pos: 'RB', posRank: 1, projPoints: 210, projStats: null }];
  computeValues(pool, DEFAULT_SETTINGS);
  eq(pool[0].projPoints, 210, 'untouched: ');
});

test('a pool cached before a derived field existed heals on reload', () => {
  // The RISK column rendered blank for exactly this reason: load() restores the
  // cached pool verbatim and never re-runs finalizePool, so ecrSpread was
  // absent on a pool that had ecrBest and ecrWorst sitting right there.
  const stale = [
    { id: 'a', name: 'A', pos: 'WR', ecrBest: 3, ecrWorst: 40 },
    { id: 'b', name: 'B', pos: 'K', ecrBest: 107, ecrWorst: 314 },
    { id: 'c', name: 'C', pos: 'RB', ecrBest: null, ecrWorst: 90 },
  ];
  ok(stale.every((p) => p.ecrSpread === undefined), 'fixture starts without it');
  backfillDerived(stale);
  eq(stale[0].ecrSpread, 37, 'skill player: ');
  eq(stale[1].ecrSpread, null, 'kicker stays null: ');
  eq(stale[2].ecrSpread, null, 'missing bound stays null: ');
  // Idempotent — running it again must not disturb anything.
  backfillDerived(stale);
  eq(stale[0].ecrSpread, 37, 'second pass: ');
});

test('finalizePool computes expert spread and blanks it for K and DST', () => {
  const { pool } = finalizePool([
    { id: 'a', name: 'A', pos: 'WR', ecr: 1, ecrBest: 3, ecrWorst: 40 },
    { id: 'b', name: 'B', pos: 'K', ecr: 2, ecrBest: 107, ecrWorst: 314 },
    { id: 'c', name: 'C', pos: 'DST', ecr: 3, ecrBest: 120, ecrWorst: 311 },
    { id: 'd', name: 'D', pos: 'RB', ecr: 4, ecrBest: null, ecrWorst: 90 },
  ]);
  const by = Object.fromEntries(pool.map((p) => [p.name, p]));
  eq(by.A.ecrSpread, 37, 'skill player: ');
  eq(by.B.ecrSpread, null, 'kicker spread is absent data, not uncertainty: ');
  eq(by.C.ecrSpread, null, 'defence: ');
  eq(by.D.ecrSpread, null, 'missing bound: ');
});

// ============================================================================
group('engine.js — bye-week collisions');

function byeState(starters, extra = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...extra };
  const roster = starters.map((p, i) => ({ id: 'b' + i, ...p }));
  const st = { settings, pool: roster, valueMode: 'projections',
    picks: roster.map((p, i) => ({ pickNo: i + 1, playerId: p.id, teamSlot: settings.slot })) };
  const analysis = rosterAnalysis(st);
  return { analysis, position: draftPosition(40, settings), settings, cliffs: {}, flexBaseline: 175 };
}

test('a second starter on a bye week is free', () => {
  // Eight starters across a dozen bye weeks — two sharing is unavoidable.
  const ctx = byeState([{ pos: 'RB', value: 90, bye: 7 }]);
  const same = scoreCandidate({ pos: 'WR', value: 40, projPoints: 190, bye: 7 }, ctx);
  const diff = scoreCandidate({ pos: 'WR', value: 40, projPoints: 190, bye: 9 }, ctx);
  eq(Math.round(same), Math.round(diff), 'second on a bye must cost nothing: ');
});

test('a third starter on the same bye is penalised', () => {
  const ctx = byeState([
    { pos: 'RB', value: 90, bye: 7 }, { pos: 'RB', value: 60, bye: 7 },
  ]);
  const same = scoreCandidate({ pos: 'WR', value: 40, projPoints: 190, bye: 7 }, ctx);
  const diff = scoreCandidate({ pos: 'WR', value: 40, projPoints: 190, bye: 9 }, ctx);
  ok(diff > same, `third on a bye should be worse (${same.toFixed(1)} vs ${diff.toFixed(1)})`);
});

test('the penalty never outweighs a real talent gap', () => {
  // Erik's stated preference: three great players sharing a bye beat two great
  // and one average spread across two weeks. This is the test that keeps it so.
  const ctx = byeState([
    { pos: 'RB', value: 90, bye: 7 }, { pos: 'RB', value: 60, bye: 7 },
  ]);
  const great = scoreCandidate({ pos: 'WR', value: 45, projPoints: 195, bye: 7 }, ctx);
  const average = scoreCandidate({ pos: 'WR', value: 25, projPoints: 175, bye: 11 }, ctx);
  ok(great > average,
    `a 20-point better player on a stacked bye must still win (${great.toFixed(1)} vs ${average.toFixed(1)})`);
});

test('a bench player on a stacked bye is never penalised', () => {
  // Starters full, so the candidate is bench depth — his bye is irrelevant.
  const ctx = byeState([
    { pos: 'QB', value: 60, bye: 7 }, { pos: 'RB', value: 90, bye: 7 },
    { pos: 'RB', value: 60, bye: 7 }, { pos: 'WR', value: 50, bye: 7 },
    { pos: 'WR', value: 45, bye: 3 }, { pos: 'WR', value: 40, bye: 4 },
    { pos: 'TE', value: 30, bye: 5 }, { pos: 'RB', value: 25, bye: 6 },
  ]);
  const same = scoreCandidate({ pos: 'WR', value: 10, projPoints: 160, bye: 7 }, ctx);
  const diff = scoreCandidate({ pos: 'WR', value: 10, projPoints: 160, bye: 9 }, ctx);
  eq(Math.round(same), Math.round(diff), 'bench byes are free: ');
});

test('kicker and defence byes do not count toward a collision', () => {
  const ctx = byeState([
    { pos: 'K', value: 5, bye: 7 }, { pos: 'DST', value: 11, bye: 7 },
    { pos: 'RB', value: 90, bye: 7 },
  ]);
  // Only one SKILL starter is on week 7, so a second skill starter is free.
  const same = scoreCandidate({ pos: 'WR', value: 40, projPoints: 190, bye: 7 }, ctx);
  const diff = scoreCandidate({ pos: 'WR', value: 40, projPoints: 190, bye: 9 }, ctx);
  eq(Math.round(same), Math.round(diff), 'streamed positions must not trigger it: ');
});

test('byeAversion 0 disables the penalty entirely', () => {
  const ctx = byeState([
    { pos: 'RB', value: 90, bye: 7 }, { pos: 'RB', value: 60, bye: 7 },
  ], { byeAversion: 0 });
  const same = scoreCandidate({ pos: 'WR', value: 40, projPoints: 190, bye: 7 }, ctx);
  const diff = scoreCandidate({ pos: 'WR', value: 40, projPoints: 190, bye: 9 }, ctx);
  eq(Math.round(same), Math.round(diff));
});

test('a player with no bye recorded is not penalised', () => {
  const ctx = byeState([{ pos: 'RB', value: 90, bye: 7 }, { pos: 'RB', value: 60, bye: 7 }]);
  const noBye = scoreCandidate({ pos: 'WR', value: 40, projPoints: 190, bye: null }, ctx);
  const clean = scoreCandidate({ pos: 'WR', value: 40, projPoints: 190, bye: 9 }, ctx);
  eq(Math.round(noBye), Math.round(clean), 'missing data must not be treated as a collision: ');
});

// ============================================================================
group('mock draft (js/mock.js)');

test('an opponent never picks an unavailable player', () => {
  const st = mkState();
  const rng = makeRng(7);
  const taken = new Set();
  for (let i = 0; i < 40; i += 1) {
    const avail = pool.filter((p) => !taken.has(p.id));
    const choice = mockPickFor('Alex', avail, [], st.settings, 1 + Math.floor(i / 10), rng);
    ok(choice && !taken.has(choice.id), 'picked an already-drafted player');
    taken.add(choice.id);
  }
});

test('opponents avoid K and DST until the late rounds', () => {
  const st = mkState();
  const rng = makeRng(3);
  for (let i = 0; i < 60; i += 1) {
    const choice = mockPickFor('Drew', pool, [], st.settings, 4, rng);
    ok(choice.pos !== 'K' && choice.pos !== 'DST', `took a ${choice.pos} in round 4`);
  }
});

test('a coach is pulled toward a reliable habit', () => {
  // Alex opens RB every year. Over many samples he should take RB in round 1
  // far more often than a coach with no RB habit at all.
  const st = mkState();
  const count = (name) => {
    const rng = makeRng(11);
    let rb = 0;
    for (let i = 0; i < 200; i += 1) {
      if (mockPickFor(name, pool, [], st.settings, 1, rng).pos === 'RB') rb += 1;
    }
    return rb;
  };
  ok(count('Alex') > count('Robert E.'),
    `Alex ${count('Alex')} vs Robert E. ${count('Robert E.')} — habit had no effect`);
});

test('the endgame forces a startable player, as Yahoo does', () => {
  const st = mkState();
  // Fourteen picks in, no TE yet: with one pick left and a TE slot open, the
  // only legal choice is a TE.
  const roster = [];
  const byPos = (p) => pool.filter((x) => x.pos === p);
  roster.push(...byPos('QB').slice(0, 1), ...byPos('RB').slice(0, 4),
    ...byPos('WR').slice(0, 5), ...byPos('K').slice(0, 1),
    ...byPos('DST').slice(0, 1), ...byPos('RB').slice(4, 6));
  eq(roster.length, 14, 'fixture roster size: ');
  const need = unfilledSlots(roster, st.settings);
  ok((need.TE || 0) > 0, 'fixture should leave TE unfilled');
  const rng = makeRng(5);
  for (let i = 0; i < 25; i += 1) {
    const choice = mockPickFor('Danny', pool, roster, st.settings, 15, rng);
    eq(choice.pos, 'TE', `forced pick ${i} should be a TE: `);
  }
});

test('unfilledSlots resolves FLEX last, not greedily', () => {
  const st = mkState();
  const wrs = pool.filter((p) => p.pos === 'WR').slice(0, 4);
  const need = unfilledSlots(wrs, st.settings);
  // Roster is WR3 + FLEX = 4 WRs, so both should be consumed and no WR left owing.
  eq(need.WR, 0, 'WR starters: ');
  eq(need.FLEX, 0, 'FLEX taken by the 4th WR: ');
  ok((need.RB || 0) > 0, 'RB should still be owed');
});

test('runOpponentsUntilMyTurn stops on your pick and never overruns', () => {
  const settings = { ...DEFAULT_SETTINGS, teams: 10, slot: 3, rounds: 15 };
  const st = { settings, pool, picks: [], valueMode: 'projections' };
  const drafted = runOpponentsUntilMyTurn(st, {
    record: (id) => {
      st.picks.push({ pickNo: st.picks.length + 1, playerId: id,
        teamSlot: slotOnClock(st.picks.length + 1, settings.teams) });
      return true;
    },
    slotOnClock, mySlot: 3, rng: makeRng(2),
  });
  eq(drafted.length, 2, 'slot 3 should have exactly 2 picks ahead of it: ');
  eq(st.picks.length, 2, 'recorded: ');
  eq(slotOnClock(st.picks.length + 1, 10), 3, 'clock should now be on you: ');
});

test('a rejected pick aborts rather than spinning forever', () => {
  const settings = { ...DEFAULT_SETTINGS, teams: 10, slot: 5, rounds: 15 };
  const st = { settings, pool, picks: [], valueMode: 'projections' };
  const drafted = runOpponentsUntilMyTurn(st, {
    record: () => false,          // every write refused
    slotOnClock, mySlot: 5, rng: makeRng(1),
  });
  eq(drafted.length, 0, 'should give up immediately: ');
});

// ============================================================================
group('claude.js — recommendation surfaces its reasoning');

test('schema requires the timing, strategy and confidence fields', () => {
  const props = RECOMMENDATION_SCHEMA.properties;
  for (const f of ['timing_note', 'strategy_note', 'confidence']) {
    ok(props[f], `${f} missing from schema`);
    ok(RECOMMENDATION_SCHEMA.required.includes(f), `${f} not required`);
  }
  eq(props.confidence.enum, ['high', 'medium', 'low']);
});

test('unwritten prose warns but does not discard a good pick', () => {
  // Seen live: the model wrote nested JSON into primary_pick.reason and filled
  // timing_note, strategy_note and every alternative reason with the literal
  // string "placeholder". Throwing away a correct pick because the timing note
  // was filler would cost more than it saves -- warn and suppress instead.
  const rec = {
    primary_pick: { name: 'A', position: 'RB',
      reason: 'Clear best available with a two-tier gap behind him.' },
    alternatives: [{ name: 'A', position: 'RB', reason: 'placeholder' }],
    positional_advice: 'placeholder',
    timing_note: '', strategy_note: 'n/a', confidence: 'low',
  };
  const res = validateRecommendation(rec, ['A']);
  ok(res.ok, 'a sound primary pick must survive filler elsewhere');
  ok(res.warnings.length > 0, 'but it must warn');
  eq(res.unwrittenFields.sort(),
    ['alternatives[0].reason', 'positional_advice', 'strategy_note', 'timing_note']);
  ok(!validateRecommendation(rec, ['B']).ok, 'a drafted player must still fail');
});

test('filler in the PRIMARY reason is a hard failure', () => {
  // That one sentence is what the whole recommendation rests on.
  const rec = {
    primary_pick: { name: 'A', position: 'RB', reason: 'placeholder' },
    alternatives: [], positional_advice: 'x',
    timing_note: 'x', strategy_note: 'x', confidence: 'low',
  };
  const res = validateRecommendation(rec, ['A']);
  eq(res.ok, false);
  ok(res.errors.some((e) => /placeholder/.test(e)), res.errors.join(' | '));
});

test('positionNeeds reads a coach roster against the league shape', () => {
  // Danny holding WR x3 with a decade-long receiver habit is not about to take
  // a fourth: the habit is a want he has already satisfied.
  const danny = [
    { pos: 'WR', value: 90 }, { pos: 'WR', value: 60 }, { pos: 'WR', value: 40 },
  ];
  const { counts, unfilled } = positionNeeds(danny, DEFAULT_SETTINGS.roster);
  eq(counts.WR, 3);
  ok(!unfilled.includes('WR'), `WR should be filled, got ${unfilled.join(',')}`);
  for (const p of ['QB', 'RB', 'TE', 'DST', 'K']) {
    ok(unfilled.includes(p), `${p} should still be needed`);
  }
});

// ============================================================================
group('export (js/export.js)');

// A complete 150-pick draft through the mock engine, slot 3 is "me". Full
// length matters: a short draft never fills a FLEX or a bench, so it cannot
// exercise the parts of the debrief that describe roster construction.
const EXP_PICKS = 150;
const expSettings = { ...DEFAULT_SETTINGS, teams: 10, rounds: 15, slot: 3,
  myTeamName: DEFAULT_SETTINGS.draftOrder[2] };
const expState = { settings: expSettings, pool, picks: [], valueMode: 'projections' };
{
  const rng = makeRng(42);
  const rosterFor = (slot) => {
    const byId = new Map(pool.map((p) => [p.id, p]));
    return expState.picks.filter((pk) => pk.teamSlot === slot)
      .map((pk) => byId.get(pk.playerId)).filter(Boolean);
  };
  for (let i = 1; i <= EXP_PICKS; i += 1) {
    const slot = slotOnClock(i, 10);
    const taken = new Set(expState.picks.map((p) => p.playerId));
    const avail = pool.filter((p) => !taken.has(p.id));
    const choice = mockPickFor(expSettings.draftOrder[slot - 1], avail, rosterFor(slot),
      expSettings, Math.floor((i - 1) / 10) + 1, rng);
    expState.picks.push({ pickNo: i, playerId: choice.id, teamSlot: slot });
  }
}

test('CSV has a header and one row per pick', () => {
  const lines = toCsv(expState).trim().split('\n');
  eq(lines.length, EXP_PICKS + 1, `header + ${EXP_PICKS} picks: `);
  eq(lines[0].split(',')[0], 'pick');
  eq(lines[1].split(',').length, 12, 'column count: ');
});

test('a full mock draft leaves every team with a legal starting lineup', () => {
  // The endgame constraint is the thing most likely to regress silently, and
  // rehearsing against a field that ends with holes teaches the wrong habits.
  const byId = new Map(pool.map((p) => [p.id, p]));
  for (let slot = 1; slot <= 10; slot += 1) {
    const roster = expState.picks.filter((pk) => pk.teamSlot === slot)
      .map((pk) => byId.get(pk.playerId)).filter(Boolean);
    const need = unfilledSlots(roster, expSettings);
    const short = Object.entries(need).filter(([, v]) => v > 0);
    eq(short, [], `slot ${slot} finished short: `);
  }
});

test('CSV quotes a coach name containing a comma', () => {
  const tricky = { ...expState, settings: { ...expSettings, draftOrder: ['A, Jr.', ...expSettings.draftOrder.slice(1)] } };
  const line = toCsv(tricky).split('\n')[1];
  ok(line.includes('"A, Jr."'), `expected a quoted field, got: ${line}`);
});

test('debrief states plainly whether the draft was simulated', () => {
  ok(toCoachingReport(expState, { isMock: true }).includes('PRACTICE draft'),
    'a practice debrief must say so — coaching off simulated opponents is worth less');
  ok(toCoachingReport(expState, { isMock: false }).includes('Real draft'));
});

test('debrief reports only my picks in the pick-by-pick section', () => {
  const rep = toCoachingReport(expState, { isMock: true });
  const headers = rep.match(/^### Pick (\d+)/gm) || [];
  const nums = headers.map((h) => Number(h.match(/\d+/)[0]));
  ok(nums.length > 0, 'no picks reported');
  for (const n of nums) {
    eq(slotOnClock(n, 10), 3, `pick ${n} is not mine: `);
  }
});

test('debrief distinguishes the FLEX starter from a positional starter', () => {
  const rep = toCoachingReport(expState, { isMock: true });
  ok(/\| FLEX \|/.test(rep) || !/## My roster/.test(rep),
    'a filled FLEX slot should be labelled, not shown as a duplicate position');
});

test('debrief survives a pool that never loaded projections', () => {
  const bare = { ...expState, valueMode: 'surrogate' };
  const rep = toCoachingReport(bare, { isMock: false });
  ok(rep.includes('rank-based surrogate'),
    'must disclose that values are not real VORP, or the coaching is built on sand');
});

test('exporting an empty draft produces headers, not a crash', () => {
  const empty = { settings: expSettings, pool, picks: [], valueMode: 'projections' };
  eq(toCsv(empty).trim().split('\n').length, 1, 'header only: ');
  ok(toCoachingReport(empty, { isMock: false }).includes('Picks made: 0'));
});

test('stale saved settings get league facts re-applied, preferences preserved', () => {
  // The real bug: a browser that saved settings before the Yahoo export was
  // decoded kept WR2/bench6 forever, moving WR replacement from WR35 to WR25
  // and making every startable receiver look worthless.
  const stale = {
    roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DST: 1, K: 1 },
    bench: 6, teams: 10, rounds: 15,
    slot: 2, model: 'claude-haiku-4-5', effort: 'low', confirmEveryPick: false,
  };
  const merged = { ...DEFAULT_SETTINGS, ...stale };
  ok(merged.roster.WR === 2, 'fixture should start stale');
  ok(merged.settingsVersion === DEFAULT_SETTINGS.settingsVersion,
    'spread pulls in the current version, so migration must key on the SAVED value');
  // Simulate what load() does: the saved blob has no settingsVersion.
  const saved = { ...stale };
  const needsMigration = saved.settingsVersion !== DEFAULT_SETTINGS.settingsVersion;
  ok(needsMigration, 'a version-less saved blob must be treated as stale');
});

test('replacement level moves with the WR starter count', () => {
  const two = replacementLevels({ ...DEFAULT_SETTINGS, roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DST: 1, K: 1 } });
  const three = replacementLevels(DEFAULT_SETTINGS);
  eq(three.WR, 35, 'three WR starters: ');
  ok(three.WR > two.WR, `WR3 must push replacement deeper than WR2 (${three.WR} vs ${two.WR})`);
});

test('debrief never suggests a kicker over a skill player', () => {
  // K/DST VORP is not comparable to a skill position's — they are streamable,
  // so "you passed a kicker worth 21" is bad advice, not a finding.
  const rep = toCoachingReport(expState, { isMock: true });
  const sections = rep.split('### Pick ').slice(1);
  for (const sec of sections) {
    const header = sec.split('\n')[0];
    if (/, (K|DST)$/.test(header)) continue;        // a K/DST pick may list them
    const rows = sec.split('\n').filter((l) => /^\| .* \| (K|DST) \|/.test(l));
    eq(rows, [], `skill pick "${header}" listed a K/DST alternative: `);
  }
});

test('filename encodes mode and pick count', () => {
  ok(new RegExp(`^practice-\\d{4}-\\d{2}-\\d{2}-${EXP_PICKS}picks\\.md$`)
    .test(exportFilename(expState, { isMock: true })));
  ok(/^draft-.*\.csv$/.test(exportFilename(expState, { isMock: false, ext: 'csv' })));
});

// ============================================================================
out(`\n${passed} passed, ${failed} failed`);
if (failed > 0 && typeof quit === 'function') quit(1);
if (failed > 0 && typeof process !== 'undefined') process.exit(1);
