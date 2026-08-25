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
 * Exact league points from projected stat components.
 *
 * FantasyPros' `points_half` is computed at FOUR-point passing TDs and −2
 * interceptions. This league pays six and −3, so using their figure quietly
 * mis-ranks every quarterback relative to every other quarterback — the
 * high-TD, low-interception arms are worth more here than the published total
 * says, and the interception-prone ones less. Rebuilding from components is
 * the only way to apply the league's own rules.
 *
 * Returns null when the components are absent, so callers fall back to the
 * published total rather than inventing a number. Kickers and defences always
 * fall back: their components (`fg`, `xpt`, `def_*`) cannot reconstruct custom
 * scoring, and their scoring here is conventional anyway.
 *
 * NOT modelled: the league's per-game yardage bonuses. FantasyPros ships
 * `rec_yds_100` / `pass_yds_300` counters but they are zero for everyone —
 * Puka Nacua projects 1,539 receiving yards with `rec_yds_100: 0` — so there
 * is nothing to read. Leaving them out costs every player roughly equally.
 */
export function leaguePoints(stats, rules) {
  if (!stats || typeof stats !== 'object') return null;
  const n = (k) => {
    const v = Number(stats[k]);
    return Number.isFinite(v) ? v : 0;
  };
  // Require at least one scoring component, or a defence's empty stat object
  // would silently score zero and outrank real players.
  const KEYS = ['pass_yds', 'pass_tds', 'rush_yds', 'rush_tds', 'rec_rec', 'rec_yds', 'rec_tds'];
  if (!KEYS.some((k) => stats[k] != null)) return null;

  const passTd = rules?.passTd ?? BASELINE_SCORING.passTd;
  const passInt = rules?.passInt ?? BASELINE_SCORING.passInt;
  const rec = rules?.reception ?? BASELINE_SCORING.reception;

  return n('pass_yds') / 25 + n('pass_tds') * passTd + n('pass_ints') * passInt
    + n('rush_yds') / 10 + n('rush_tds') * 6
    + n('rec_rec') * rec + n('rec_yds') / 10 + n('rec_tds') * 6
    + n('fumbles') * -2 + n('2pt_tds') * 2 + n('ret_tds') * 6;
}

/**
 * Draft Sharks' projection, converted from standard scoring into this league's.
 *
 * The other three sources publish raw stat lines, so leaguePoints() scores them
 * exactly. Draft Sharks publishes only a total, and does not state its scoring.
 * Measured against 159 matched players, their number ran position-dependently
 * low -- RB 0.919, WR 0.825, TE 0.752 of ours -- and the positions furthest off
 * were the most reception-dependent, which is a scoring difference rather than a
 * forecasting one. Adding back half a point per reception collapsed the gap to
 * 1.015 / 1.036 / 0.988. They publish standard, non-PPR.
 *
 * Receptions come from whichever of the other three have the player, which does
 * couple this source to them slightly. It is the cheapest possible coupling:
 * receptions are the least-disputed statistic in the pool, and what stays
 * independent is Draft Sharks' view of yardage and touchdowns, which is the
 * bulk of the number.
 *
 * Returns null for quarterbacks, and for any league not using this reception
 * value. The same correction OVERSHOOTS quarterbacks (1.136), so their passing
 * scoring is not the 4-point/-2 that would explain it and cannot be read from
 * outside; this league pays 6 per passing touchdown, which is the worst place
 * to blend in a number whose basis is a guess. The other three still cover QB.
 */
function receptionAdjustment(player, rules) {
  const recs = [player.projStats, player.espnStats, player.cbsStats]
    .map((s) => (s && s.rec_rec != null ? Number(s.rec_rec) : null))
    .filter((v) => Number.isFinite(v));
  if (!recs.length) return null;
  const perReception = rules?.reception ?? BASELINE_SCORING.reception;
  return (recs.reduce((a, b) => a + b, 0) / recs.length) * perReception;
}

const DS_ELIGIBLE = (pos) => pos === 'RB' || pos === 'WR' || pos === 'TE';

export function draftSharksPoints(player, rules) {
  const ds = player.dsProjection;
  if (!ds || ds.standardPoints == null || !DS_ELIGIBLE(player.pos)) return null;
  const adj = receptionAdjustment(player, rules);
  return adj == null ? null : ds.standardPoints + adj;
}

/**
 * Draft Sharks' floor and ceiling, converted the same way as their projection.
 *
 * No other source here publishes a range, and the range is a different claim
 * from the point estimate: two players can project identically while one is a
 * safe floor and the other a lottery ticket. The app has been guessing at that
 * distinction with a hand-tagged `sleeper` list; this is the measured version.
 *
 * The bands are standard-scoring too, so they need the same reception
 * correction — applying it to the projection but not the band would compress
 * every receiver's range toward the bottom and make the safest players look
 * like the most volatile.
 */
export function draftSharksBand(player, rules) {
  const ds = player.dsProjection;
  if (!ds || !DS_ELIGIBLE(player.pos)) return null;
  if (ds.floor == null && ds.ceiling == null) return null;
  const adj = receptionAdjustment(player, rules);
  if (adj == null) return null;
  const mid = ds.standardPoints == null ? null : ds.standardPoints + adj;
  const floor = ds.floor == null ? null : ds.floor + adj;
  const ceiling = ds.ceiling == null ? null : ds.ceiling + adj;
  return {
    floor: floor == null ? null : Math.round(floor),
    ceiling: ceiling == null ? null : Math.round(ceiling),
    // Signed distances from the projection: how much is there to gain, and how
    // much to lose. Kept separate because they answer different questions --
    // upside decides a bench flier, downside decides a starter.
    upside: (ceiling != null && mid != null) ? Math.round(ceiling - mid) : null,
    downside: (floor != null && mid != null) ? Math.round(mid - floor) : null,
    injuryRisk: ds.injuryRisk || null,
  };
}

/**
 * Annotate every player with `value` (VORP or its surrogate).
 * Returns the mode so callers can label it honestly.
 */
export function computeValues(pool, settings) {
  const levels = replacementLevels(settings);
  const rules = settings.scoringRules;

  // Re-score every player under THIS league's rules before anything reads
  // projPoints. Done here rather than in the fetch layer because this is where
  // settings live — so changing the scoring or team count and calling
  // refreshPool() recomputes correctly instead of keeping a stale total.
  // projPointsGeneric preserves the published figure so the difference stays
  // auditable rather than silently replacing what the source said.
  // Average the two projection sources rather than trusting one.
  //
  // Every number in this app used to come from FantasyPros, and the debrief
  // then graded the draft with those same numbers. Re-scored against ESPN's
  // independent projections, Erik's "winning" practice roster fell from 1st
  // (460) to 3rd (374) while the league total barely moved -- the loss was
  // concentrated on his roster specifically. That is the optimizer's curse: a
  // roster built by maximizing one source's estimates is selected for that
  // source's optimism, so any independent ruler marks it back down. It is not
  // a bug, it is what maximizing on noisy estimates does, and it recurs every
  // draft.
  //
  // Averaging defuses it -- you cannot be selected for one source's optimism
  // while scoring on two. Twelve seasons of projection data from Fantasy
  // Football Analytics found aggregate projections beat individual sources in
  // 69% of head-to-head comparisons, and that simple and accuracy-weighted
  // averages performed near-identically, which is why this is a flat 50/50 and
  // not a tuned weighting.
  //
  // The blend happens HERE, after league scoring, not in the fetch layer.
  // Averaging the sources' published totals would average a 4-point passing
  // touchdown with a 6-point one and call the result a forecast.
  const blendOn = settings.blendSources !== false;
  let blended = 0;
  for (const p of pool) {
    // Equal weight, one vote each. The twelve-season study found simple and
    // accuracy-weighted averages performed near-identically, so weighting the
    // sources would add fitting risk for no measured gain.
    const sources = [
      ['fp', leaguePoints(p.projStats, rules)],
      ['espn', leaguePoints(p.espnStats, rules)],
      ['cbs', leaguePoints(p.cbsStats, rules)],
      ['ds', draftSharksPoints(p, rules)],
    ].filter(([, v]) => v != null);
    if (!sources.length) continue;
    if (p.projPointsGeneric == null) p.projPointsGeneric = p.projPoints;

    const r1 = (v) => Math.round(v * 10) / 10;
    p.projPointsFp = sources.find(([k]) => k === 'fp')?.[1];
    p.projPointsEspn = sources.find(([k]) => k === 'espn')?.[1];
    p.projPointsCbs = sources.find(([k]) => k === 'cbs')?.[1];
    p.projPointsDs = sources.find(([k]) => k === 'ds')?.[1];
    for (const k of ['projPointsFp', 'projPointsEspn', 'projPointsCbs', 'projPointsDs']) {
      p[k] = p[k] == null ? null : r1(p[k]);
    }

    // Blending off falls back to FantasyPros, which is what the app used for
    // its whole life -- so the switch genuinely restores the old behaviour
    // rather than approximating it.
    const used = blendOn ? sources : sources.filter(([k]) => k === 'fp');
    const pts = (used.length ? used : sources).map(([, v]) => v);
    p.projPoints = r1(pts.reduce((t, v) => t + v, 0) / pts.length);
    p.sourceCount = blendOn ? sources.length : 1;
    if (blendOn && sources.length > 1) blended += 1;

    // Spread between the most and least optimistic source, in league points.
    // Distinct from ecrSpread, which is disagreement about RANK among one
    // panel; this is disagreement about POINTS between independent models.
    const all = sources.map(([, v]) => v);
    p.sourceGap = all.length > 1
      ? Math.round(Math.max(...all) - Math.min(...all)) : null;

    // Outcome range, where a source publishes one. Distinct from sourceGap:
    // that measures how much the FORECASTERS disagree, this measures how wide
    // one forecaster thinks the PLAYER's own outcomes are.
    p.band = draftSharksBand(p, rules);
  }

  const usingProjections = pool.some((p) => p.projPoints != null);

  // Replacement-level projected points, when projections are loaded.
  let replacementPoints = null;
  if (usingProjections) {
    const byPos = {};
    for (const p of pool) {
      if (p.projPoints == null) continue;
      (byPos[p.pos] ||= []).push(p);
    }
    for (const pos of Object.keys(byPos)) byPos[pos].sort((a, b) => b.projPoints - a.projPoints);

    replacementPoints = {};
    for (const pos of POSITIONS) {
      const list = byPos[pos] || [];
      const idx = Math.min(levels[pos], list.length) - 1;
      replacementPoints[pos] = idx >= 0 && list[idx] ? list[idx].projPoints : 0;
    }
  }

  // Both numbers are kept on every player, because they answer different
  // questions and their disagreement is the interesting part:
  //
  //   valueModel — where the EXPERT CONSENSUS puts him, converted to points
  //                by the rank-decay curve. Reflects the market's opinion.
  //   valueProj  — what the PROJECTIONS say he'll actually score, minus
  //                replacement. Reflects a statistical forecast.
  //
  // A large gap means the market and the forecast disagree about a player,
  // which is exactly where value (or a trap) tends to sit.
  for (const p of pool) {
    p.valueModel = surrogatePoints(p.pos, p.posRank, rules)
      - surrogatePoints(p.pos, levels[p.pos], rules);
    p.valueProj = (replacementPoints && p.projPoints != null)
      ? p.projPoints - (replacementPoints[p.pos] ?? 0)
      : null;
    p.valueGap = p.valueProj != null ? Math.round(p.valueProj - p.valueModel) : null;

    // Projections win for ranking when present — a forecast beats a curve
    // fitted to rank — but the model number stays visible either way.
    p.value = p.valueProj ?? p.valueModel;
    p.vorp = p.value;
  }

  return {
    mode: usingProjections ? 'projections' : 'surrogate',
    levels,
    replacementPoints,
    hasBoth: usingProjections,
    // How many players were actually averaged, so the UI can say which value
    // model is live rather than leaving the user to guess. CLAUDE.md requires
    // the active mode be labelled; a blend that looks identical to a single
    // source on screen would break that.
    blended,
  };
}

export const VALUE_MODE_LABEL = {
  projections: 'VORP from projected points, shown alongside the rank-based model',
  surrogate: 'Rank-based value — no projections loaded',
};

/**
 * Honest one-line description of what `value` currently means.
 *
 * The sources are listed ALPHABETICALLY and said to be equal-weight, because
 * any other order gets read as a ranking. Listing them in the order they were
 * added implied a precedence that does not exist -- the blend is a mean, so
 * reordering the inputs changes the output by nothing (measured: 6e-14, which
 * is floating-point dust). No source outranks another.
 */
export const BLEND_SOURCES = ['CBS', 'Draft Sharks', 'ESPN', 'FantasyPros'];

export function valueModeLabel(mode, blended = 0) {
  if (mode !== 'projections') return VALUE_MODE_LABEL.surrogate;
  return blended > 0
    ? `VORP from the equal-weight mean of ${BLEND_SOURCES.length} projection sources `
      + `— ${BLEND_SOURCES.join(', ')} (listed alphabetically; none outranks another). `
      + `${blended} players averaged across 2 or more.`
    : VALUE_MODE_LABEL.projections;
}

/**
 * Players where the forecast and the market disagree most, either way.
 *
 * Restricted to the draftable range on purpose. Unfiltered, the list is
 * entirely third-string QBs projected for ~10 points: the rank curve assigns
 * them a position on a scale that assumes they play, the projection knows
 * they won't, and the resulting 200-point gaps are arithmetic noise rather
 * than a signal about anyone you might draft.
 */
export function biggestDisagreements(pool, n = 8, { maxEcr = 200 } = {}) {
  return pool
    .filter((p) => p.valueGap != null && p.ecr != null && p.ecr <= maxEcr)
    .sort((a, b) => Math.abs(b.valueGap) - Math.abs(a.valueGap))
    .slice(0, n);
}
