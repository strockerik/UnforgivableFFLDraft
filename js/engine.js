// Deterministic draft engine: roster analysis, tier cliffs, position runs,
// the bounded evidence packet sent to Claude, and the fallback pick.
//
// This module is the source of truth. Claude explains and adjusts what the
// engine computes; it never owns availability and never mutates state.

import { FLEX_ELIGIBLE, POSITIONS, SCARCITY_RANK } from './config.js';
import { draftPosition, slotOnClock } from './snake.js';
import { coachesUntilMyTurn, positionsAtRisk, habitSummary } from './coaches.js';
import { replacementLevels } from './vorp.js';
// The opponent behaviour model. Named for practice mode, where it was first
// used, but it is the league's ADP-plus-habits model and belongs here too —
// projecting the next N picks is the same problem as simulating them. No cycle:
// mock.js imports only config.js and coaches.js.
import { mockPickFor, rosterOfSlot } from './mock.js';

const RUN_WINDOW = 8;      // picks looked back at for a positional run
const RUN_THRESHOLD = 3;   // that many at one position inside the window = run
const CLIFF_THRESHOLD = 2; // that few left in the current tier = cliff
// Ceiling on the tier-cliff bonus. The bonus itself is the measured drop to
// the next tier; this only stops an outlier gap from overwhelming everything.
const CLIFF_BONUS_CAP = 25;

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

/**
 * What a set of drafted players covers, and what it still needs.
 *
 * Pure — takes players and the roster shape, touches no state — so it works
 * for any team, not just the user's. That is the point: a coach's historical
 * habit is a prior about what he LIKES, and it has to be read against what he
 * has already filled. Danny opens WR in round 1 every year, but once he holds
 * three receivers and needs a QB, an RB and a TE, "Danny takes receivers" is a
 * statement about a want he has already satisfied.
 */
export function positionNeeds(players, roster) {
  const need = { ...roster };
  const leftovers = [];
  for (const p of [...players].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))) {
    if ((need[p.pos] || 0) > 0) need[p.pos] -= 1;
    else leftovers.push(p);
  }
  for (const p of leftovers) {
    if ((need.FLEX || 0) > 0 && FLEX_ELIGIBLE.includes(p.pos)) need.FLEX -= 1;
  }
  const counts = {};
  for (const p of players) counts[p.pos] = (counts[p.pos] || 0) + 1;
  return { counts, unfilled: Object.keys(need).filter((k) => need[k] > 0) };
}

/**
 * For each position: the shallowest tier still on the board, how thin it is,
 * and what waiting past it actually costs.
 *
 * `dropToNextTier` is the measured cost: the worst player still in the current
 * tier minus the best in the tier below. That number is the whole point of a
 * cliff, and it varies enormously — at one live pick the RB and QB cliffs were
 * each worth 4 points while the TE cliff was worth 24. Treating them alike is
 * what let a 59-value back outrank a 72-value receiver.
 */
export function tierCliffs(available) {
  const out = {};
  for (const pos of POSITIONS) {
    const inPos = available.filter((p) => p.pos === pos && p.tier != null);
    if (!inPos.length) { out[pos] = null; continue; }
    const tier = Math.min(...inPos.map((p) => p.tier));
    const current = inPos.filter((p) => p.tier === tier)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    // The next tier that actually has players in it — tier numbers can skip.
    const below = inPos.filter((p) => p.tier > tier);
    let dropToNextTier = null;
    if (below.length) {
      const nextTier = Math.min(...below.map((p) => p.tier));
      const best = Math.max(...below.filter((p) => p.tier === nextTier)
        .map((p) => p.value ?? 0));
      const worstHere = current[current.length - 1]?.value ?? 0;
      dropToNextTier = Math.max(0, worstHere - best);
    }

    out[pos] = { tier, remaining: current.length,
      isCliff: current.length <= CLIFF_THRESHOLD, dropToNextTier };
  }
  return out;
}

/** How deep into the ADP board the projection looks. See projectBoard. */
const PROJECTION_DEPTH = 90;

/**
 * The most likely board when you are next on the clock.
 *
 * Reuses the opponent simulator rather than inventing a second model:
 * mockPickFor already encodes ADP, each coach's reliable habits, their unfilled
 * roster needs, the K/DST gate and the Yahoo endgame constraint. Passing an rng
 * that always returns 0 selects depth 0 — the modal pick — so the same function
 * yields a deterministic projection instead of a sample.
 *
 * Only the top of the board is simulated. Nobody drafts the 400th-ranked player
 * with a second-round pick, and restricting to PROJECTION_DEPTH by ADP took
 * this from 1.4 ms to 0.2 ms with an identical result — worth having, because
 * this runs inside evaluate() on every render.
 *
 * Returns an empty set when the window is empty, which is the correct answer at
 * the turn: from slot 1, picks 20 and 21 are back to back and nothing can be
 * taken in between, so nothing is urgent.
 */
export function projectBoard(state, available, fromPick, toPick, pickFor = mockPickFor) {
  const gone = new Set();
  if (!(toPick > fromPick) || !available.length) return gone;

  const { teams, draftOrder = [] } = state.settings;
  let board = [...available]
    .sort((a, b) => (a.adp ?? Infinity) - (b.adp ?? Infinity))
    .slice(0, PROJECTION_DEPTH);
  // Each simulated coach keeps drafting onto his own roster as the projection
  // runs, so his needs evolve the way they would in the real draft.
  const rosters = {};

  for (let p = fromPick; p < toPick; p += 1) {
    const slot = slotOnClock(p, teams);
    const roster = (rosters[slot] ||= rosterOfSlot(state, slot).slice());
    const round = Math.floor((p - 1) / teams) + 1;
    const choice = pickFor(draftOrder[slot - 1], board, roster, state.settings, round, () => 0);
    if (!choice) break;
    gone.add(choice.id);
    roster.push(choice);
    board = board.filter((x) => x.id !== choice.id);
  }
  return gone;
}

/**
 * Per position, the value of the best player expected to SURVIVE to your next
 * pick. Subtracting this from a candidate's value gives what taking him now
 * actually buys — which is the question a tier boundary only gestures at.
 *
 * A position with nobody left projects null rather than 0: "everyone is gone"
 * and "the best left is worth zero" are different claims, and treating the
 * first as the second would manufacture enormous urgency out of an empty pool.
 */
export function attritionCost(available, gone) {
  const out = {};
  for (const pos of POSITIONS) {
    const alive = available
      .filter((p) => p.pos === pos && !gone.has(p.id))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    out[pos] = alive.length ? (alive[0].value ?? 0) : null;
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
/**
 * What a SURPLUS player at each position is worth, as a fraction of his VORP,
 * once that position's starting slots are already covered.
 *
 * These are judgements about how often a bench player actually enters the
 * lineup, not measurements. RB is highest: backs get hurt most, carry the
 * heaviest workloads, and are FLEX-eligible. QB is lowest because this league
 * starts one and a streamed replacement costs almost nothing.
 */
const DEPTH_FACTOR = { RB: 0.9, WR: 0.7, TE: 0.3, QB: 0.15, DST: 0.1, K: 0.1 };

/**
 * Flat penalty for a spare body at a single-slot position, in VORP points.
 * Needed because the multiplier above cannot discipline a negative value.
 */
const SURPLUS_PENALTY = { QB: 30, TE: 18, DST: 40, K: 40 };

/**
 * Hard ceiling on how many of a position the roster will ever hold.
 *
 * The depth discount above is a weighting, and weightings lose. Late in a
 * draft every remaining skill player grades below replacement, so a backup
 * quarterback at -29 outscores a bench receiver at -30 and the engine takes
 * him — repeatedly. No sensible tuning survives that, because the comparison
 * is between two players who are both nearly worthless.
 *
 * You start one QB and one TE. A second is insurance for a bye or an injury;
 * a third can never enter the lineup in any week, so it is strictly a wasted
 * pick. This is a roster-construction rule, not a valuation, and it belongs
 * as a constraint rather than a number to be outbid.
 */
const POSITION_CAPS = { QB: 2, TE: 2, K: 1, DST: 1 };

/**
 * Penalty in VORP points for adding another STARTER on a bye week that already
 * has some, indexed by how many would then share it.
 *
 * Deliberately small. Eight skill starters across roughly a dozen bye weeks
 * means two sharing is ordinary and unavoidable, so that costs nothing. Three
 * is worth breaking a tie over; four is a week you have already lost.
 *
 * Calibration follows Erik's stated preference exactly: three great players on
 * one bye beat two great and one average spread across two. A 12-point nudge
 * flips a coin-toss between similar players and never overrides a real talent
 * gap, which in the middle rounds runs 20-40 points. If this ever starts
 * costing starting-lineup value, it is too high -- the measured cost at these
 * numbers is under 2 points a draft.
 */
const BYE_PENALTY = { 2: 0, 3: 12, 4: 30 };

/**
 * Credit in VORP points for the FIRST backup at a single-slot position whose
 * starter has an uncovered bye week.
 *
 * The flex baseline scores a surplus player on raw points, which answers "who
 * scores more in a FLEX slot" and is blind to whether a slot can be filled at
 * all. With one tight end and no backup, his bye week is a guaranteed zero at
 * that slot — and an eighth receiver cannot fill it, however many points he
 * projects. Mark Andrews at 137 raw points reads worse than a seventh receiver
 * at 145 and is worth far more, because only one of them can start in week 10.
 *
 * Bounded like the rest: enough to lift a backup over a replacement-level body
 * at a position already stacked, never enough to take one over a real starter.
 * Paid once — the second backup covers nothing new, and POSITION_CAPS stops
 * the third.
 *
 * Position-specific, because the two single-slot positions are not alike. A
 * tight end reaches the board through the flex-baseline comparison, which
 * strips the surplus penalty, so he needs the full credit to clear a
 * replacement-level receiver.
 *
 * Quarterback gets nothing, deliberately. The strategy document says "if you
 * land a Tier 1/2 QB, you do not need a second", and a one-week bye is the
 * easiest hole in fantasy to stream. At a token credit of 5 the board put
 * Brock Purdy at -18.0 against Mark Andrews at -18.6 — a coin flip decided by
 * rounding, on a choice the document already answers. The self-regulating part
 * still works: if the user had punted QB instead of taking Allen, a mid-tier
 * QB2 would carry real VORP and clear the -30 surplus penalty on merit rather
 * than on a subsidy.
 */
const BYE_COVER_CREDIT = { TE: 20 };

/** Strategy-document tag that marks a high-variance, high-upside player. */
export const UPSIDE_TAG = 'sleeper';

/**
 * Positions where a lottery ticket can actually pay off.
 *
 * The whole argument for the upside quota is option value: a bench player who
 * might become startable is worth more than his projection says. That argument
 * only holds where he can enter the lineup. With QB and TE capped at two and
 * one starter each, a bench quarterback plays in the week his starter is out
 * and otherwise never -- so a QB sleeper is a lottery ticket for a raffle you
 * are not entered in.
 *
 * This bit: the quota was satisfied by Jared Goff, a backup QB, while Matthew
 * Golden (a tagged WR sleeper) sat on the board unclaimed. Both count as
 * "sleeper"; only one of them can win you a week.
 */
const UPSIDE_POSITIONS = ['RB', 'WR'];

/**
 * How much value the engine will give up to land one upside player, in VORP
 * points, once the starting lineup is already filled.
 *
 * The justification is not sentiment. VORP measures EXPECTED points, and on a
 * bench that is the wrong statistic: a replacement-level backup contributes
 * almost nothing in any week he is not started, so his expected value and his
 * realistic value are both near zero. A high-variance player with a small
 * chance of becoming a starter carries option value that an expectation cannot
 * express. Paying ~25 points of expectation for that is a good trade on a
 * bench slot and a terrible one on a starting slot, which is exactly why this
 * only applies after the starters are filled.
 */
const UPSIDE_BONUS = 25;

/**
 * Bye week -> how many SKILL starters already sit on it.
 *
 * Kicker and defence slots are excluded: both are streamed week to week, so a
 * bye there is a non-event and counting it would make the penalty fire on
 * collisions that cost nothing.
 */
export function skillStarterByes(analysis) {
  const out = {};
  for (const [slot, list] of Object.entries(analysis.slots)) {
    if (slot === 'K' || slot === 'DST') continue;
    for (const p of list) if (p.bye != null) out[p.bye] = (out[p.bye] || 0) + 1;
  }
  return out;
}

export function scoreCandidate(player, ctx) {
  const { analysis, position, settings, cliffs, flexBaseline } = ctx;
  const progress = position.round / settings.rounds;
  const picksLeft = settings.rounds - position.round + 1;

  const fillsOwnSlot = analysis.unfilled.includes(player.pos);
  const fillsFlex = !fillsOwnSlot
    && analysis.unfilled.includes('FLEX') && FLEX_ELIGIBLE.includes(player.pos);
  const fillsStarter = fillsOwnSlot || fillsFlex;

  // VORP measures a player against HIS OWN position's replacement, which is
  // the right question for a dedicated slot and the wrong one for a FLEX or a
  // bench spot. Replacement points differ sharply between positions here —
  // RB26 projects 175, WR35 152, TE12 134 — so two players can share a VORP of
  // 12 while one outscores the other by 17 points in the same flex slot.
  // For anything competing on raw output, measure against a single baseline.
  // Only for positions that can actually occupy the flex. A quarterback
  // measured against a flex baseline scores ~130 here — QBs project far more
  // raw points than any flex-eligible player — and the engine drafts three of
  // them. He can never fill that slot, so the comparison is meaningless.
  const flexComparable = (flexBaseline != null && player.projPoints != null
    && FLEX_ELIGIBLE.includes(player.pos))
    ? player.projPoints - flexBaseline
    : null;

  let score = (fillsOwnSlot || flexComparable == null)
    ? (player.value ?? 0)
    : flexComparable;

  // Filling an actual starter hole matters more as the draft runs out.
  if (fillsStarter) score += 120 * progress;

  // Endgame: once you have exactly as many picks left as unfilled starter
  // slots, every remaining pick must fill one. Without this the engine keeps
  // taking the highest-value player — which is usually a WR who slots into
  // FLEX — and finishes the draft with an empty TE slot it can no longer fill.
  if (picksLeft <= analysis.unfilled.length && !fillsStarter) score -= 5000;

  // --- depth discount ----------------------------------------------------
  // VORP answers "how much better than replacement is this player", which is
  // the right question for a STARTER and the wrong one for a backup. Once a
  // position is covered, another body is only worth what he is likely to
  // contribute from the bench, and that differs enormously by position:
  // a third RB starts the week either starter is hurt or in a FLEX; a second
  // QB in a one-QB league starts almost never and is streamable besides.
  //
  // Without this the engine happily took a TE2 worth 9 over a WR worth 11,
  // and a QB2 in round 13, because raw VORP says a bench tight end above
  // replacement outranks a receiver barely above it.
  const have = analysis.counts[player.pos] || 0;
  const want = settings.roster[player.pos] || 0;
  // When the flex baseline is in play, marginal value is ALREADY measured
  // correctly: the player is scored on raw points against the best man who
  // would not start anywhere. Stacking a discount on top double-counts, and
  // it double-counts unevenly — a sixth receiver was landing at -70 while a
  // far worse running back scored -35, purely because the receiver collected
  // two extra penalties the back did not. Only apply the heuristics when the
  // principled comparison was unavailable.
  const usedFlexBaseline = !fillsOwnSlot && flexComparable != null;

  if (!fillsStarter && have >= want && !usedFlexBaseline) {
    // Applied to positive value only. Scaling a negative number toward zero
    // would make a bad player at a discounted position look BETTER, which is
    // exactly backwards.
    if (score > 0) score *= DEPTH_FACTOR[player.pos] ?? 0.5;
    // A surplus body at a single-slot position is close to dead weight
    // regardless of his rating, so it needs a penalty that survives a
    // negative value too.
    if (want <= 1) score -= SURPLUS_PENALTY[player.pos] ?? 0;
  }
  // And stop stacking a position covered several times over.
  if (have >= want + 2 && !usedFlexBaseline) score -= 40 * (have - want - 1);

  // Hard cap. Large enough that no valuation can outbid it, but below the
  // endgame penalty so filling a mandatory starter slot still wins if the cap
  // and the endgame ever disagree.
  const cap = POSITION_CAPS[player.pos];
  if (cap != null && have >= cap && !fillsOwnSlot) score -= 2000;

  // Bye-week collision. Charged only to a player who would actually START:
  // a bench bye costs nothing, and K/DST byes are streamed around, so neither
  // is counted on either side of the comparison.
  if (fillsStarter && player.bye != null) {
    const aversion = settings.byeAversion ?? 1;
    if (aversion > 0) {
      const sharing = skillStarterByes(analysis)[player.bye] || 0;
      if (sharing >= 1) {
        const would = Math.min(sharing + 1, 4);
        score -= (BYE_PENALTY[would] ?? 0) * aversion;
      }
    }
  }

  // Bye insurance for a single-slot starter who has none. Kickers and defences
  // are excluded: you stream those, so their bye is a non-event.
  if (!fillsStarter && want <= 1 && have === want && player.bye != null
      && player.pos !== 'K' && player.pos !== 'DST') {
    const starter = (analysis.slots[player.pos] || [])[0];
    // A backup sharing the starter's bye covers nothing — both are out
    // together, which is the one case where this credit would be a lie.
    if (starter && starter.bye != null && starter.bye !== player.bye) {
      score += (BYE_COVER_CREDIT[player.pos] ?? 0) * (settings.byeCoverCredit ?? 1);
    }
  }

  // Upside quota. Only once the starting lineup is full, never at a kicker or
  // defence, and never enough to outrank a genuinely better player by more
  // than UPSIDE_BONUS — it buys a lottery ticket, it does not buy a bad roster.
  if (ctx.wantsUpside
      && !fillsStarter
      && UPSIDE_POSITIONS.includes(player.pos)
      && Array.isArray(player.tags) && player.tags.includes(UPSIDE_TAG)) {
    score += UPSIDE_BONUS;
  }

  // Kickers and defenses in round 3 lose leagues. Gate them on picks
  // remaining rather than round number: they are fungible and always
  // available, so you take them only when the picks left are exactly the ones
  // they need. Gating on round instead let them outbid an unfilled TE in the
  // second-to-last round and end the draft with an empty starter slot.
  if (player.pos === 'DST' || player.pos === 'K') {
    const lateSlotsOpen = analysis.unfilled.filter((p) => p === 'DST' || p === 'K').length;
    if (!analysis.unfilled.includes(player.pos)) score -= 1000;
    else if (picksLeft > lateSlotsOpen) score -= 1000;
    else score += 500;
  }

  // Positional urgency: what taking him NOW buys over waiting.
  //
  // Uncapped on purpose. This is a value difference in the same units as VORP,
  // and the two-pick lookahead works out exactly -- taking A (100, urgency 40)
  // over B (110, urgency 0) yields 100 + 110 = 210 against 110 + 60 = 170, an
  // edge of precisely 40. A player projected to survive scores zero here,
  // because his position's survivor value is at least his own.
  //
  // Falls back to the measured tier cliff only when there is no projection at
  // all: without ADP the simulation has nothing to order picks by, and a stale
  // structural signal beats none. An empty window is NOT that case -- at the
  // turn nothing can be sniped, and zero urgency is the right answer.
  const survivor = ctx.survivingValue?.[player.pos];
  if (ctx.survivingValue) {
    if (survivor != null) score += Math.max(0, (player.value ?? 0) - survivor);
  } else {
    const cliff = cliffs[player.pos];
    if (cliff && cliff.isCliff && player.tier === cliff.tier) {
      score += Math.min(cliff.dropToNextTier ?? 0, CLIFF_BONUS_CAP);
    }
  }

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
  const levels = replacementLevels(settings);

  // What the board most likely looks like when you are next on the clock.
  // Computed once here and passed through ctx -- never per candidate.
  // The window is the picks OTHER teams make before you choose again — never
  // your own. When you are on the clock those run from the next pick up to
  // your following one; when someone else is, the pick on the clock is theirs
  // and counts. Getting this wrong by one is easy and invisible: at the
  // serpentine turn it projected your own back-to-back pick as an opponent's
  // and manufactured urgency where nothing could be sniped.
  const windowStart = position.isMyPick ? position.pickNo + 1 : position.pickNo;
  const windowEnd = position.isMyPick
    ? (position.gapToFollowingPick != null
        ? position.pickNo + position.gapToFollowingPick
        : null)
    : position.nextPick;
  const projectedGone = windowEnd != null
    ? projectBoard(state, available, windowStart, windowEnd)
    : new Set();
  const survivingValue = projectedGone.size ? attritionCost(available, projectedGone) : null;

  // Upside quota: how many tagged sleepers the user wants, minus how many are
  // already rostered. Zero disables it entirely.
  const quota = settings.sleeperQuota ?? 0;
  const haveUpside = analysis.roster.filter(
    (p) => UPSIDE_POSITIONS.includes(p.pos)
      && Array.isArray(p.tags) && p.tags.includes(UPSIDE_TAG)).length;
  const ctx = { analysis, position, settings, cliffs,
    flexBaseline: flexReplacementPoints(state.pool, levels),
    survivingValue,
    wantsUpside: haveUpside < quota };

  const ranked = available
    .map((p) => ({ player: p, score: scoreCandidate(p, ctx) }))
    .sort((a, b) => b.score - a.score);

  return { position, analysis, cliffs, runs, ranked, levels, survivingValue,
    projectedGone, wantsUpside: ctx.wantsUpside };
}

/**
 * Projected points of the best player who would not start anywhere — the true
 * baseline for a FLEX slot, since every flex-eligible position competes for it.
 *
 * Taken from the full pool, not the available list: replacement level is a
 * property of the league's roster rules, and it must not drift as players come
 * off the board. Returns null without projections, in which case the caller
 * falls back to VORP and the cross-position distortion simply remains — better
 * than inventing a baseline out of ranks.
 */
export function flexReplacementPoints(pool, levels) {
  if (!Array.isArray(pool) || !pool.length) return null;
  let best = null;
  for (const pos of FLEX_ELIGIBLE) {
    const idx = levels[pos];
    if (!idx) continue;
    const ranked = pool
      .filter((p) => p.pos === pos && p.projPoints != null)
      .sort((a, b) => b.projPoints - a.projPoints);
    const at = ranked[idx - 1];
    if (at && (best == null || at.projPoints > best)) best = at.projPoints;
  }
  return best;
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
      // Best-to-worst expert rank gap. A wide spread means the projection is
      // a guess dressed as a number, which is a different claim from "the
      // analysts think he is overpriced" — the bust tags measure that.
      expertRankSpread: p.ecrSpread,
    };
    // When projections are loaded, send both valuations plus their gap. The
    // gap is where a statistical forecast and the expert market disagree, and
    // saying so lets the model reason about it instead of guessing.
    if (p.valueProj != null) {
      b.valueFromProjections = Math.round(p.valueProj);
      b.valueFromConsensusRank = Math.round(p.valueModel);
      b.projectionVsConsensusGap = p.valueGap;
    }
    // Strategy-document tags travel with the player, so they vanish from the
    // packet the moment he is drafted.
    if (Array.isArray(p.tags) && p.tags.length) {
      b.tags = p.tags;
      if (p.tagNote) b.tagNote = p.tagNote;
      if (p.tagConfidence) b.tagConfidence = p.tagConfidence;
      // The count matters more than the label: a 7-of-8 bust call and a
      // 2-of-8 one are different claims about how much risk analysts see.
      if (p.tagSources != null) b.tagSources = `${p.tagSources} of ${p.tagSourcesOf} analyst lists`;
    }
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

    // A position already at its cap is not an option, so do not offer it. The
    // prompt forbids exceeding the caps and the engine scores such a player at
    // -2000, but a third tight end still got recommended because the packet
    // listed him among the top TEs and he had the highest value there. Telling
    // a model not to pick something you keep showing it is a weaker guarantee
    // than not showing it -- the same reasoning as the drafted-player allowlist.
    const cap = POSITION_CAPS[pos];
    if (cap != null && (analysis.counts[pos] || 0) >= cap) continue;
    const list = available
      .filter((p) => p.pos === pos)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
      .slice(0, perPos);
    if (!list.length) continue;
    topByPos[pos] = list.map(brief);
    for (const p of list) allowlist.push(p.name);
  }

  // Who is actually on the clock before you pick again, and what four seasons
  // of live drafting say they do. This informs TIMING only — whether a player
  // survives the wait — and must never reorder the value board itself.
  const windowStart = position.isMyPick ? position.pickNo + 1 : position.pickNo;
  const windowEnd = position.isMyPick
    ? position.pickNo + (position.gapToFollowingPick ?? 0)
    : (position.nextPick ?? position.pickNo);
  const upcoming = coachesUntilMyTurn(
    settings.draftOrder || [], (p) => slotOnClock(p, settings.teams), windowStart, windowEnd
  );
  const atRisk = positionsAtRisk(upcoming, position.round);

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
    // Opponent model. Empty when no history exists for these names, which is
    // the correct behaviour on a draft order of strangers.
    //
    // The count and the exhaustive flag are stated explicitly because a list
    // alone gets misread: given two upcoming picks by one coach with a WR and
    // an RB habit, the model concluded that "2 WRs and 2 RBs" would disappear
    // and worried about a nonexistent "third pick". Two picks remove exactly
    // two players, and at a turn the list is often shorter than it feels.
    picksBeforeYourNextTurn: upcoming.length,
    upsideQuota: {
      wanted: settings.sleeperQuota ?? 0,
      held: analysis.roster.filter((p) => UPSIDE_POSITIONS.includes(p.pos)
        && Array.isArray(p.tags) && p.tags.includes(UPSIDE_TAG)).map((p) => p.name),
      countsOnlyAt: UPSIDE_POSITIONS,
      stillWanted: evaluation.wantsUpside === true,
    },
    // What THIS engine concluded, stated outright.
    //
    // Everything else in the packet is raw inputs, and for a long time that was
    // all the model got -- it re-derived a ranking from the numbers every time.
    // Usually it landed on the same answer. When it did not, nothing anywhere
    // said so. At pick 17 of a live practice draft the engine ranked Derrick
    // Henry first (138) and the model recommended Josh Allen (95) in prose that
    // had already worked out the correct answer: "waiting on RB costs 34
    // points, making elite RB your next priority, not QB." It then recommended
    // the QB. Henry was taken by hand and Allen survived the round, which is
    // exactly what the packet's own attrition numbers predicted.
    //
    // A source of truth that never states its conclusion cannot be departed
    // from knowingly, only ignored by accident. So the score is shipped, the
    // prompt requires a named reason to deviate, and recs.js flags any
    // disagreement on screen. The model is still free to override -- it sees
    // injury news and bust consensus that no score captures -- but the
    // override is now a visible act rather than a silent one.
    engineRanking: (evaluation.ranked || []).slice(0, 6).map(({ player, score }, i) => ({
      rank: i + 1,
      name: player.name,
      pos: player.pos,
      score: Math.round(score),
      value: Math.round(player.value ?? 0),
      // The gap is the point: rank 1 over rank 2 by 27 is a different claim
      // from rank 1 over rank 2 by 2, and only the second is a close call.
      pointsBehindTop: i === 0 ? 0
        : Math.round((evaluation.ranked[0].score ?? 0) - (score ?? 0)),
    })),
    // What each position costs you if you wait. This is the measured answer to
    // "can this position wait", where a tier count is only a proxy for it.
    attritionBeforeYourNextPick: evaluation.survivingValue
      ? Object.fromEntries(POSITIONS.map((pos) => {
          const best = available.filter((p) => p.pos === pos)
            .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];
          const survives = evaluation.survivingValue[pos];
          if (!best) return [pos, null];
          return [pos, {
            bestNow: Math.round(best.value ?? 0),
            bestSurviving: survives == null ? null : Math.round(survives),
            costOfWaiting: survives == null ? null : Math.round((best.value ?? 0) - survives),
          }];
        }).filter(([, v]) => v)) 
      : null,
    opponentsListIsExhaustive: true,
    opponentsBeforeYourNextPick: upcoming
      .filter((u) => u.coach)
      .map((u) => ({
        // What he has ALREADY drafted this year. Without it the habit is read
        // as a prediction rather than a preference, and the panel ends up
        // warning about a receiver run from a coach who is three receivers
        // deep and short a quarterback, a back and a tight end.
        alreadyDrafted: (() => {
          const byId = new Map(state.pool.map((p) => [p.id, p]));
          const his = state.picks
            .filter((pk) => pk.teamSlot === u.slot)
            .map((pk) => byId.get(pk.playerId))
            .filter(Boolean);
          const { counts, unfilled } = positionNeeds(his, settings.roster);
          return {
            byPosition: counts,
            stillNeeds: unfilled,
            picksMade: his.length,
          };
        })(),
        pick: u.pickNo,
        coach: u.name,
        reliableHabits: habitSummary(u.coach),
        earlyRoundMix: u.coach.earlyMix,
      })),
    positionsLikelyGoneBeforeYourNextPick: atRisk,
    // Hard constraint: the model may only name someone on this list.
    availablePlayerAllowlist: allowlist,
  };
}
