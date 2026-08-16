// Deterministic draft engine: roster analysis, tier cliffs, position runs,
// the bounded evidence packet sent to Claude, and the fallback pick.
//
// This module is the source of truth. Claude explains and adjusts what the
// engine computes; it never owns availability and never mutates state.

import { FLEX_ELIGIBLE, POSITIONS, SCARCITY_RANK } from './config.js';
import { draftPosition } from './snake.js';
import { replacementLevels } from './vorp.js';

const RUN_WINDOW = 8;      // picks looked back at for a positional run
const RUN_THRESHOLD = 3;   // that many at one position inside the window = run
const CLIFF_THRESHOLD = 2; // that few left in the current tier = cliff

/** Players the user has drafted, in pick order. */
export function myRoster(state) {
  const mine = state.picks.filter((p) => p.teamSlot === state.settings.slot);
  return mine
    .map((p) => ({ ...state.pool.find((x) => x.id === p.playerId), pickNo: p.pickNo }))
    .filter((p) => p && p.id);
}

/**
 * Assign the roster to starter slots (best value first), then FLEX, then bench.
 * Returns filled slots, unfilled starter needs, and bye-week collisions.
 */
export function rosterAnalysis(state) {
  const roster = myRoster(state);
  const need = { ...state.settings.roster };
  const slots = {};
  const bench = [];

  const byValue = [...roster].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const leftovers = [];

  for (const p of byValue) {
    if ((need[p.pos] || 0) > 0) {
      (slots[p.pos] ||= []).push(p);
      need[p.pos]--;
    } else {
      leftovers.push(p);
    }
  }

  for (const p of leftovers) {
    if ((need.FLEX || 0) > 0 && FLEX_ELIGIBLE.includes(p.pos)) {
      (slots.FLEX ||= []).push(p);
      need.FLEX--;
    } else {
      bench.push(p);
    }
  }

  const unfilled = Object.keys(need).filter((k) => need[k] > 0);
  const counts = {};
  for (const p of roster) counts[p.pos] = (counts[p.pos] || 0) + 1;

  // Bye collisions among starters only — bench byes don't hurt you.
  const byes = {};
  for (const list of Object.values(slots)) {
    for (const p of list) if (p.bye != null) (byes[p.bye] ||= []).push(p.name);
  }
  const byeConflicts = Object.entries(byes)
    .filter(([, names]) => names.length > 1)
    .map(([week, names]) => ({ week: Number(week), names }));

  return { roster, slots, bench, need, unfilled, counts, byeConflicts };
}

/** For each position: the shallowest tier still on the board and how thin it is. */
export function tierCliffs(available) {
  const out = {};
  for (const pos of POSITIONS) {
    const inPos = available.filter((p) => p.pos === pos && p.tier != null);
    if (!inPos.length) { out[pos] = null; continue; }
    const tier = Math.min(...inPos.map((p) => p.tier));
    const remaining = inPos.filter((p) => p.tier === tier).length;
    out[pos] = { tier, remaining, isCliff: remaining <= CLIFF_THRESHOLD };
  }
  return out;
}

/** Positions being hammered in the last few picks. */
export function positionRuns(state) {
  const recent = state.picks.slice(-RUN_WINDOW);
  const counts = {};
  for (const pick of recent) {
    const p = state.pool.find((x) => x.id === pick.playerId);
    if (p) counts[p.pos] = (counts[p.pos] || 0) + 1;
  }
  const runs = Object.entries(counts)
    .filter(([, n]) => n >= RUN_THRESHOLD)
    .map(([pos, n]) => ({ pos, count: n }))
    .sort((a, b) => b.count - a.count);
  return { window: recent.length, counts, runs };
}

/**
 * Deterministic score for a candidate.
 * Best-available dominates early; roster need takes over late; DST/K are
 * pushed to the final two rounds where they belong.
 */
export function scoreCandidate(player, ctx) {
  const { analysis, position, settings, cliffs } = ctx;
  const progress = position.round / settings.rounds;
  let score = player.value ?? 0;

  // Filling an actual starter hole matters more as the draft runs out.
  const fillsStarter =
    analysis.unfilled.includes(player.pos) ||
    (analysis.unfilled.includes('FLEX') && FLEX_ELIGIBLE.includes(player.pos));
  if (fillsStarter) score += 120 * progress;

  // Stop stacking a position you've already covered twice over.
  const have = analysis.counts[player.pos] || 0;
  const want = settings.roster[player.pos] || 0;
  if (have >= want + 2) score -= 40 * (have - want - 1);

  // Kickers and defenses in round 3 lose leagues.
  if (player.pos === 'DST' || player.pos === 'K') {
    const lastTwo = position.round >= settings.rounds - 1;
    if (!lastTwo) score -= 1000;
    else if (analysis.unfilled.includes(player.pos)) score += 500;
  }

  // A tier about to empty makes that position urgent.
  const cliff = cliffs[player.pos];
  if (cliff && cliff.isCliff && player.tier === cliff.tier) score += 25;

  // Falling relative to ADP is free value.
  if (player.adp != null && position.pickNo > player.adp + 5) {
    score += Math.min(20, (position.pickNo - player.adp) * 0.5);
  }

  // Break ties toward the scarcer position.
  score -= (SCARCITY_RANK[player.pos] || 9) * 0.01;

  return score;
}

/** Full deterministic evaluation of the board for the pick on the clock. */
export function evaluate(state, available) {
  const settings = state.settings;
  const position = draftPosition(state.picks.length + 1, settings);
  const analysis = rosterAnalysis(state);
  const cliffs = tierCliffs(available);
  const runs = positionRuns(state);
  const ctx = { analysis, position, settings, cliffs };

  const ranked = available
    .map((p) => ({ player: p, score: scoreCandidate(p, ctx) }))
    .sort((a, b) => b.score - a.score);

  return { position, analysis, cliffs, runs, ranked, levels: replacementLevels(settings) };
}

/** The fallback recommendation — used whenever Claude is unavailable or wrong. */
export function deterministicPick(evaluation) {
  const top = evaluation.ranked.slice(0, 4);
  if (!top.length) return null;
  const [best, ...rest] = top;

  const reasons = [];
  const { analysis, position, cliffs } = evaluation;
  reasons.push(`Best available by value at pick ${position.pickNo} (round ${position.round}).`);
  if (analysis.unfilled.includes(best.player.pos)) {
    reasons.push(`Fills your open ${best.player.pos} starter slot.`);
  }
  const cliff = cliffs[best.player.pos];
  if (cliff && cliff.isCliff && best.player.tier === cliff.tier) {
    reasons.push(`Tier ${cliff.tier} at ${best.player.pos} has only ${cliff.remaining} left.`);
  }
  if (best.player.adp != null && position.pickNo > best.player.adp + 5) {
    reasons.push(`Falling — ADP ${best.player.adp}, still here at ${position.pickNo}.`);
  }

  return {
    source: 'deterministic',
    primary_pick: {
      name: best.player.name,
      position: best.player.pos,
      reason: reasons.join(' '),
    },
    alternatives: rest.map((r) => ({
      name: r.player.name,
      position: r.player.pos,
      reason: `Value ${Math.round(r.player.value ?? 0)}${r.player.tier != null ? `, tier ${r.player.tier}` : ''}.`,
    })),
    positional_advice: buildAdvice(evaluation),
  };
}

function buildAdvice(evaluation) {
  const bits = [];
  const { position, analysis, cliffs, runs } = evaluation;

  if (position.picksUntilMyTurn === 0 && position.gapToFollowingPick != null) {
    bits.push(`${position.gapToFollowingPick} picks until your next turn.`);
  }
  if (analysis.unfilled.length) {
    bits.push(`Still need: ${analysis.unfilled.join(', ')}.`);
  } else {
    bits.push('All starter slots filled — take upside.');
  }
  const cliffing = Object.entries(cliffs)
    .filter(([, c]) => c && c.isCliff)
    .map(([pos, c]) => `${pos} tier ${c.tier} (${c.remaining} left)`);
  if (cliffing.length) bits.push(`Tier cliffs: ${cliffing.join('; ')}.`);
  if (runs.runs.length) {
    bits.push(`Run in progress: ${runs.runs.map((r) => `${r.count} ${r.pos}`).join(', ')} in the last ${runs.window} picks.`);
  }
  return bits.join(' ');
}

/**
 * Bounded evidence packet for the model. Deliberately small — the top few
 * per position, not the whole board — plus an explicit allowlist so the
 * model cannot name someone already gone.
 */
export function buildEvidence(state, available, evaluation, perPos = 12) {
  const { position, analysis, cliffs, runs, levels } = evaluation;
  const settings = state.settings;

  const brief = (p) => {
    const b = {
      name: p.name,
      pos: p.pos,
      team: p.team,
      posRank: p.posRank,
      tier: p.tier,
      bye: p.bye,
      value: Math.round(p.value ?? 0),
      ecr: p.ecr,
      adp: p.adp,
      ecrVsAdp: p.ecrVsAdp,
    };
    // Injury and news only ride along when present, so a pool without them
    // costs nothing in the packet.
    if (p.injury && (p.injury.status || p.injury.detail)) {
      b.injury = [p.injury.status, p.injury.detail].filter(Boolean).join(' — ');
    }
    if (Array.isArray(p.news) && p.news.length) {
      b.recentNews = p.news.slice(0, 2).map((n) => n.text);
    }
    return b;
  };

  const topByPos = {};
  const allowlist = [];
  for (const pos of POSITIONS) {
    // DST/K only become relevant at the end; keep them out of the packet
    // until then so the model isn't tempted and the payload stays small.
    if ((pos === 'DST' || pos === 'K') && position.round < settings.rounds - 1) continue;
    const list = available
      .filter((p) => p.pos === pos)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
      .slice(0, perPos);
    if (!list.length) continue;
    topByPos[pos] = list.map(brief);
    for (const p of list) allowlist.push(p.name);
  }

  return {
    league: {
      teams: settings.teams,
      yourSlot: settings.slot,
      scoring: settings.scoring,
      rounds: settings.rounds,
      startingLineup: settings.roster,
      bench: settings.bench,
      replacementLevels: levels,
      valueMode: state.valueMode,
    },
    draft: {
      pickNumber: position.pickNo,
      round: position.round,
      picksUntilYourTurn: position.picksUntilMyTurn,
      picksBetweenThisAndYourNextTurn: position.gapToFollowingPick,
      totalPicksMade: state.picks.length,
    },
    yourRoster: {
      players: analysis.roster.map((p) => ({ name: p.name, pos: p.pos, bye: p.bye })),
      startersFilled: Object.fromEntries(
        Object.entries(analysis.slots).map(([k, v]) => [k, v.map((p) => p.name)])
      ),
      unfilledStarterSlots: analysis.unfilled,
      positionCounts: analysis.counts,
      starterByeConflicts: analysis.byeConflicts,
    },
    board: {
      topAvailableByPosition: topByPos,
      tierCliffs: cliffs,
      recentPositionRuns: runs,
    },
    // Hard constraint: the model may only name someone on this list.
    availablePlayerAllowlist: allowlist,
  };
}
