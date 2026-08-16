// Value Over Replacement Player.
//
// Joe Bryant's VBD framing: a player's value is not his raw points but how far
// he outscores the last startable player at his position, given league size and
// roster settings. That's why an elite RB generates more surplus than an elite
// QB despite scoring fewer points.

import { FLEX_SHARE, POSITIONS, BASELINE_SCORING } from './config.js';

/**
 * Replacement index per position, computed from league settings — never
 * hardcoded, since it moves with team count and roster shape.
 *
 *   N * starters[pos]  +  N * flexSlots * flexShare[pos]  +  1
 *
 * The trailing +1 matters: replacement level is the first player who would
 * NOT be started, not the last one who would. In a 12-team league with one
 * starting QB, QB12 is the last starter and QB13 is the replacement — which
 * is the number the brief cites.
 *
 * For a 10-team league with 1QB/2RB/2WR/1TE/1FLEX this gives
 * QB11 / RB26 / WR25 / TE12.
 */
export function replacementLevels(settings) {
  const { teams, roster } = settings;
  const flexSlots = roster.FLEX || 0;
  const out = {};
  for (const pos of POSITIONS) {
    const starters = roster[pos] || 0;
    const flex = flexSlots * (FLEX_SHARE[pos] || 0);
    out[pos] = Math.max(1, Math.round(teams * (starters + flex)) + 1);
  }
  return out;
}

// --- surrogate scoring curve ------------------------------------------------
// Used only when the loaded export carries no projected points. Half-PPR
// season totals decay roughly logarithmically in positional rank, so
// points(rank) = a - b*ln(rank), anchored at rank 1 and rank 24.
//
// This is a MODEL, not data. The UI must say so wherever it surfaces value.
const CURVE_ANCHORS = {
  QB: [380, 230], RB: [320, 155], WR: [300, 175],
  TE: [230, 85], DST: [140, 85], K: [150, 115],
};
const LN24 = Math.log(24);

// Approximate season volumes at positional rank 1 and rank 24, used only to
// convert a scoring-rule difference into a points difference. Coarse on
// purpose — the goal is to move QBs the right direction by roughly the right
// amount, not to project anyone's stat line.
const VOLUME = {
  QB: { passTd: [32, 18], passInt: [10, 12], reception: [0, 0] },
  RB: { passTd: [0, 0], passInt: [0, 0], reception: [60, 28] },
  WR: { passTd: [0, 0], passInt: [0, 0], reception: [100, 68] },
  TE: { passTd: [0, 0], passInt: [0, 0], reception: [85, 34] },
  DST: { passTd: [0, 0], passInt: [0, 0], reception: [0, 0] },
  K: { passTd: [0, 0], passInt: [0, 0], reception: [0, 0] },
};

/**
 * How far this league's scoring moves a position's curve away from the
 * generic Half-PPR baseline the published rankings assume.
 *
 * This is why it matters: a 6-point passing touchdown is worth ~+64 points a
 * season to an elite QB over the 4-point default. Rankings built on the
 * default therefore understate QB value in this league, and no amount of
 * reading the rankings file can reveal that — the information isn't in it.
 */
function scoringDelta(pos, rules) {
  if (!rules) return [0, 0];
  const v = VOLUME[pos];
  if (!v) return [0, 0];
  const d = (key, baseline) => {
    const diff = (rules[key] ?? baseline) - baseline;
    return [diff * v[key][0], diff * v[key][1]];
  };
  const [td1, td24] = d('passTd', BASELINE_SCORING.passTd);
  const [int1, int24] = d('passInt', BASELINE_SCORING.passInt);
  const [rec1, rec24] = d('reception', BASELINE_SCORING.reception);
  return [td1 + int1 + rec1, td24 + int24 + rec24];
}

function surrogatePoints(pos, rank, rules) {
  const anchor = CURVE_ANCHORS[pos];
  if (!anchor || !rank || rank < 1) return 0;
  const [d1, d24] = scoringDelta(pos, rules);
  const p1 = anchor[0] + d1;
  const p24 = anchor[1] + d24;
  const b = (p1 - p24) / LN24;
  return p1 - b * Math.log(rank);
}

/** Positions whose value this league's scoring shifts, for the UI to explain. */
export function scoringAdjustments(rules) {
  const out = [];
  for (const pos of POSITIONS) {
    const [d1] = scoringDelta(pos, rules);
    if (Math.abs(d1) >= 5) {
      out.push({ pos, deltaAtRank1: Math.round(d1) });
    }
  }
  return out.sort((a, b) => Math.abs(b.deltaAtRank1) - Math.abs(a.deltaAtRank1));
}

/**
 * Annotate every player with `value` (VORP or its surrogate).
 * Returns the mode so callers can label it honestly.
 */
export function computeValues(pool, settings) {
  const levels = replacementLevels(settings);
  const rules = settings.scoringRules;
  const usingProjections = pool.some((p) => p.projPoints != null);

  if (usingProjections) {
    // Real VORP: replacement points = the projection of the player sitting at
    // the replacement index within his own position.
    const byPos = {};
    for (const p of pool) {
      if (p.projPoints == null) continue;
      (byPos[p.pos] ||= []).push(p);
    }
    for (const pos of Object.keys(byPos)) byPos[pos].sort((a, b) => b.projPoints - a.projPoints);

    const replacementPoints = {};
    for (const pos of POSITIONS) {
      const list = byPos[pos] || [];
      const idx = Math.min(levels[pos], list.length) - 1;
      replacementPoints[pos] = idx >= 0 && list[idx] ? list[idx].projPoints : 0;
    }

    for (const p of pool) {
      p.value = p.projPoints == null
        ? surrogatePoints(p.pos, p.posRank, rules) - surrogatePoints(p.pos, levels[p.pos], rules)
        : p.projPoints - (replacementPoints[p.pos] ?? 0);
      p.vorp = p.value;
    }
    return { mode: 'projections', levels, replacementPoints };
  }

  for (const p of pool) {
    p.value = surrogatePoints(p.pos, p.posRank, rules) - surrogatePoints(p.pos, levels[p.pos], rules);
    p.vorp = p.value;
  }
  return { mode: 'surrogate', levels, replacementPoints: null };
}

export const VALUE_MODE_LABEL = {
  projections: 'VORP (from projected points)',
  surrogate: 'Rank-based value — no projections loaded',
};
