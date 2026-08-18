// Draft exports.
//
// Two formats, for two different jobs:
//
//   CSV      the pick list, for a spreadsheet or your own records.
//   REPORT   a self-contained markdown debrief written to be pasted straight
//            into Claude for coaching.
//
// The report is the interesting one. A bare list of picks cannot be coached
// from -- "you took Gibbs at 7" says nothing without what else was on the
// board. So each of your picks carries the alternatives you passed over AND
// whether they survived to your next turn, which is the only way to tell a
// reach from a necessary reach after the fact.
//
// Pure: takes a state-shaped object, returns a string. No imports from
// state.js, so it stays testable headlessly.

import { FLEX_ELIGIBLE } from './config.js';
import { slotOnClock, myPicks } from './snake.js';

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const n1 = (v) => (v == null ? '—' : (Math.round(v * 10) / 10).toString());
const int = (v) => (v == null ? '—' : String(Math.round(v)));

/** Replay the draft, yielding the board state before each pick. */
function replay(state) {
  const byId = new Map(state.pool.map((p) => [p.id, p]));
  const taken = new Set();
  const rows = [];
  for (const pk of state.picks) {
    const player = byId.get(pk.playerId);
    rows.push({
      pickNo: pk.pickNo,
      round: Math.floor((pk.pickNo - 1) / state.settings.teams) + 1,
      slot: pk.teamSlot,
      coach: (state.settings.draftOrder || [])[pk.teamSlot - 1] || `Team ${pk.teamSlot}`,
      player,
      // Snapshot of who was still on the board when this pick was made.
      availableBefore: new Set(taken),
    });
    if (player) taken.add(player.id);
  }
  return rows;
}

/** Every pick, one row. */
export function toCsv(state) {
  const head = ['pick', 'round', 'slot', 'coach', 'player', 'pos', 'team', 'bye',
    'value', 'ecr', 'adp', 'tier'];
  const lines = [head.join(',')];
  for (const r of replay(state)) {
    const p = r.player || {};
    lines.push([r.pickNo, r.round, r.slot, r.coach, p.name, p.pos, p.team, p.bye,
      p.value == null ? '' : Math.round(p.value), p.ecr, p.adp, p.tier].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

/** Best legal starting lineup for a roster, plus what is still unfilled. */
function lineupOf(roster, settings) {
  const need = { ...settings.roster };
  const starters = [];
  const bench = [];
  for (const p of [...roster].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))) {
    if ((need[p.pos] || 0) > 0) { need[p.pos] -= 1; starters.push(p); } else bench.push(p);
  }
  const flexed = [];
  for (const p of bench) {
    if ((need.FLEX || 0) > 0 && FLEX_ELIGIBLE.includes(p.pos)) {
      need.FLEX -= 1; starters.push(p); flexed.push(p);
    }
  }
  const unfilled = Object.entries(need).filter(([, v]) => v > 0).map(([k, v]) => `${k}×${v}`);
  const total = starters.reduce((t, p) => t + (p.value ?? 0), 0);
  return {
    starters, flexed,
    bench: bench.filter((p) => !flexed.includes(p)),
    unfilled, total,
  };
}

/**
 * Markdown debrief, written for a model to coach from.
 *
 * `isMock` is stated up front and prominently: coaching advice built on a
 * simulated opponent field is worth less than advice built on a real one, and
 * the reader has no other way to tell the two apart.
 */
export function toCoachingReport(state, { isMock = false, title = null } = {}) {
  const s = state.settings;
  const rows = replay(state);
  const byId = new Map(state.pool.map((p) => [p.id, p]));
  const mySlotNo = (s.draftOrder || []).indexOf(s.myTeamName) + 1 || s.slot;
  const mine = rows.filter((r) => r.slot === mySlotNo);
  const myPickNos = myPicks(s);

  const out = [];
  const L = (x = '') => out.push(x);

  L(`# ${title || (isMock ? 'Practice draft debrief' : 'Draft results')}`);
  L();
  if (isMock) {
    L('> **This was a PRACTICE draft.** The other nine coaches were simulated —');
    L('> ADP order plus noise, bent toward their real tendencies. Their picks are');
    L('> plausible, not real. Judge my decisions, but do not read anything into');
    L('> what the opponents did.');
  } else {
    L('> Real draft. Every opponent pick below was made by an actual person.');
  }
  L();
  L(`- League: ${s.teams} teams, ${s.rounds} rounds, ${s.scoring}`);
  L(`- Scoring quirks: passing TD ${s.scoringRules?.passTd ?? 4} pts, `
    + `INT ${s.scoringRules?.passInt ?? -2}, ${s.scoringRules?.reception ?? 0.5}/reception`);
  L(`- Starters: ${Object.entries(s.roster).map(([k, v]) => `${k}${v}`).join(' ')} `
    + `(+${s.bench} bench)`);
  L(`- I drafted from slot **${mySlotNo}** as **${s.myTeamName}**`);
  L(`- Picks made: ${state.picks.length} of ${s.teams * s.rounds}`);
  L(`- Value model: ${state.valueMode === 'projections'
    ? 'true VORP from projected points' : 'rank-based surrogate (no projections loaded)'}`);
  L();

  // --- my roster ---------------------------------------------------------
  const myRoster = mine.map((r) => r.player).filter(Boolean);
  const lineup = lineupOf(myRoster, s);
  L('## My roster');
  L();
  L('| slot | player | pos | bye | value | ECR | ADP |');
  L('|---|---|---|---|---|---|---|');
  for (const p of lineup.starters) {
    // A second TE in the starters is the FLEX, not a lineup error — say which.
    const slotLabel = lineup.flexed.includes(p) ? 'FLEX' : p.pos;
    L(`| ${slotLabel} | ${p.name} | ${p.pos} | ${p.bye ?? '—'} | ${int(p.value)} | ${p.ecr ?? '—'} | ${n1(p.adp)} |`);
  }
  for (const p of lineup.bench) {
    L(`| bench | ${p.name} | ${p.pos} | ${p.bye ?? '—'} | ${int(p.value)} | ${p.ecr ?? '—'} | ${n1(p.adp)} |`);
  }
  L();
  L(`**Starting lineup value: ${int(lineup.total)}**`
    + (lineup.unfilled.length ? `  — UNFILLED: ${lineup.unfilled.join(', ')}` : ''));

  // Bye-week stacking is the classic silent draft mistake.
  const byeCount = {};
  for (const p of lineup.starters) if (p.bye) byeCount[p.bye] = (byeCount[p.bye] || 0) + 1;
  const stacked = Object.entries(byeCount).filter(([, c]) => c >= 3)
    .map(([w, c]) => `week ${w}: ${c} starters`);
  if (stacked.length) L(`\n**Bye-week stacking:** ${stacked.join(', ')}`);
  L();

  // --- pick-by-pick ------------------------------------------------------
  L('## My picks, with what I passed over');
  L();
  L('`survived?` = was that player still undrafted when my next turn came around.');
  L('A "yes" means I could have waited and taken him later.');
  L();

  for (let i = 0; i < mine.length; i += 1) {
    const r = mine[i];
    if (!r.player) continue;
    const nextMine = myPickNos.find((p) => p > r.pickNo);
    const takenBefore = r.availableBefore;
    const availableThen = state.pool.filter((p) => !takenBefore.has(p.id));

    // Who was actually taken between this pick and my next one.
    const gone = new Set(
      state.picks.filter((pk) => pk.pickNo > r.pickNo && (nextMine == null || pk.pickNo < nextMine))
        .map((pk) => pk.playerId));

    const better = availableThen
      .filter((p) => p.id !== r.player.id && (p.value ?? 0) > (r.player.value ?? 0))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
      .slice(0, 4);

    L(`### Pick ${r.pickNo} (round ${r.round}) — ${r.player.name}, ${r.player.pos}`);
    L();
    L(`Value ${int(r.player.value)} · ECR ${r.player.ecr ?? '—'} · ADP ${n1(r.player.adp)}`
      + (r.player.adp != null ? ` · taken ${r.player.adp > r.pickNo
        ? `${n1(r.player.adp - r.pickNo)} picks EARLIER than ADP`
        : `${n1(r.pickNo - r.player.adp)} picks LATER than ADP`}` : ''));
    if (r.player.tags?.length) L(`Strategy tags: ${r.player.tags.join(', ')}`);
    L();
    if (!better.length) {
      L('Highest-value player on the board. No one available was rated above him.');
    } else {
      L('| passed over | pos | value | gap | survived? |');
      L('|---|---|---|---|---|');
      for (const p of better) {
        const survived = nextMine == null ? 'draft ended' : (gone.has(p.id) ? 'no — taken' : '**yes**');
        L(`| ${p.name} | ${p.pos} | ${int(p.value)} | +${int((p.value ?? 0) - (r.player.value ?? 0))} | ${survived} |`);
      }
    }
    L();
  }

  // --- the league --------------------------------------------------------
  L('## Every team');
  L();
  for (let slot = 1; slot <= s.teams; slot += 1) {
    const roster = rows.filter((r) => r.slot === slot).map((r) => r.player).filter(Boolean);
    if (!roster.length) continue;
    const lu = lineupOf(roster, s);
    const coach = (s.draftOrder || [])[slot - 1] || `Team ${slot}`;
    L(`**${slot}. ${coach}**${slot === mySlotNo ? ' (me)' : ''} — starters ${int(lu.total)}`
      + (lu.unfilled.length ? ` · unfilled ${lu.unfilled.join(', ')}` : ''));
    L(`: ${roster.map((p) => `${p.name} (${p.pos})`).join(', ')}`);
    L();
  }

  L('## What I want from you');
  L();
  L('Grade this draft. Specifically:');
  L('1. Which individual picks were mistakes, and what should I have taken instead?');
  L('2. Where did I reach — took someone who would plainly have survived to my next turn?');
  L('3. Is the roster construction sound: starters filled, bye weeks survivable, '
    + 'positions balanced against a 10-team league that starts 3 WRs?');
  L('4. What is the single habit I should change before the real draft?');
  L();
  L('Be blunt. I would rather hear it now than on draft day.');

  return out.join('\n');
}

/** Suggested filename, stable and sortable. */
export function exportFilename(state, { isMock = false, ext = 'md' } = {}) {
  const d = new Date().toISOString().slice(0, 10);
  return `${isMock ? 'practice' : 'draft'}-${d}-${state.picks.length}picks.${ext}`;
}
