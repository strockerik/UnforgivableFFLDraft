// Headless tests for the pure logic modules (no DOM, no network).
//
// Run with JavaScriptCore, which ships with macOS:
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/run.mjs
// or with node, if you install it:
//   node tests/run.mjs

import { parseRows, findHeaderRow, normHeader, parseTable, num } from '../js/csv.js';
import { splitPos, parsePlayerTeamBye, nameKey, parseRankings, parseAdp, mergeAdp, finalizePool } from '../js/players.js';
import { replacementLevels, computeValues } from '../js/vorp.js';
import { pickNumber, myPicks, slotOnClock, roundOf, draftPosition } from '../js/snake.js';
import { evaluate, deterministicPick, buildEvidence, rosterAnalysis, tierCliffs } from '../js/engine.js';
import { validateRecommendation } from '../js/claude.js';
import { DEFAULT_SETTINGS } from '../js/config.js';

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
  const l = replacementLevels(settings);
  eq(l.QB, 11); eq(l.RB, 26); eq(l.WR, 25); eq(l.TE, 12);
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

test('reproduces the water-diamond result: elite RB out-values elite QB', () => {
  const top = (pos) => pool.filter((p) => p.pos === pos).sort((a, b) => b.value - a.value)[0].value;
  ok(top('RB') > top('WR'), 'RB1 should out-value WR1');
  ok(top('WR') > top('QB'), 'WR1 should out-value QB1');
  ok(top('QB') > top('K'), 'QB1 should out-value K1');
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
  const st = mkState([
    { pickNo: 5, playerId: rb1.id, teamSlot: 5 },
    { pickNo: 16, playerId: wr1.id, teamSlot: 5 },
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

  for (let i = 1; i <= total; i++) {
    const available = avail(st);
    const ev = evaluate(st, available);
    const rec = deterministicPick(ev);
    if (!rec) throw new Error(`no recommendation at pick ${i}`);
    const chosen = available.find((p) => p.name === rec.primary_pick.name);
    if (!chosen) throw new Error(`pick ${i} named "${rec.primary_pick.name}", not on the board`);
    if (seen.has(chosen.id)) throw new Error(`pick ${i} duplicated ${chosen.name}`);
    if (['DST', 'K'].includes(chosen.pos) && ev.position.round < s.rounds - 1) dstKBeforeEnd++;
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
    if (ev.position.isMyPick) {
      const e = buildEvidence(st, available, ev);
      ok(e.availablePlayerAllowlist.length > 0, `empty allowlist at pick ${i}`);
      const takenNames = new Set(st.picks.map((p) =>
        pool.find((x) => x.id === p.playerId).name));
      const leaked = e.availablePlayerAllowlist.filter((n) => takenNames.has(n));
      eq(leaked, [], `pick ${i} leaked drafted players: `);
    }
    const chosen = deterministicPick(ev).primary_pick.name;
    const player = available.find((p) => p.name === chosen);
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
  primary_pick: { name: 'RB Sample 01', position: 'RB', reason: 'Top value.' },
  alternatives: [{ name: 'WR Sample 02', position: 'WR', reason: 'Also fine.' }],
  positional_advice: 'Take RB early.',
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
out(`\n${passed} passed, ${failed} failed`);
if (failed > 0 && typeof quit === 'function') quit(1);
if (failed > 0 && typeof process !== 'undefined') process.exit(1);
