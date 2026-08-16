// Value Over Replacement Player.
//
// Joe Bryant's VBD framing: a player's value is not his raw points but how far
// he outscores the last startable player at his position, given league size and
// roster settings. That's why an elite RB generates more surplus than an elite
// QB despite scoring fewer points.

import { FLEX_SHARE, POSITIONS } from './config.js';

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

function surrogatePoints(pos, rank) {
  const anchor = CURVE_ANCHORS[pos];
  if (!anchor || !rank || rank < 1) return 0;
  const [p1, p24] = anchor;
  const b = (p1 - p24) / LN24;
  return p1 - b * Math.log(rank);
}

/**
 * Annotate every player with `value` (VORP or its surrogate).
 * Returns the mode so callers can label it honestly.
 */
export function computeValues(pool, settings) {
  const levels = replacementLevels(settings);
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
        ? surrogatePoints(p.pos, p.posRank) - surrogatePoints(p.pos, levels[p.pos])
        : p.projPoints - (replacementPoints[p.pos] ?? 0);
      p.vorp = p.value;
    }
    return { mode: 'projections', levels, replacementPoints };
  }

  for (const p of pool) {
    p.value = surrogatePoints(p.pos, p.posRank) - surrogatePoints(p.pos, levels[p.pos]);
    p.vorp = p.value;
  }
  return { mode: 'surrogate', levels, replacementPoints: null };
}

export const VALUE_MODE_LABEL = {
  projections: 'VORP (from projected points)',
  surrogate: 'Rank-based value — no projections loaded',
};
