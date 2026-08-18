// Opponent auto-drafting for practice mode.
//
// Pure logic, deliberately importing no state: it takes a state-shaped object
// and returns a player id, which is what keeps it testable under jsc. The UI
// layer is responsible for actually recording the pick through state.js.
//
// The opponents drafted here are modelled on the real ones. Their behaviour is
// ADP order plus noise, bent by whatever habit js/coaches.js says is reliable
// for that coach, and constrained the way Yahoo constrains a real draft: once
// picks remaining equals unfilled starter slots, you must fill a slot. That
// last rule matters more than it sounds -- without it a practice draft leaves
// far more talent on the board late than a real one does, and rehearsing
// against it would teach the wrong endgame.
//
// This is a rehearsal tool, not a predictor. It is here so the draft-day
// interface is muscle memory, not so the picks come true.

import { FLEX_ELIGIBLE } from './config.js';
import { coachByName, reliableHabits } from './coaches.js';

/** How far down the ADP list an opponent will reach. Higher = more chaotic. */
const REACH = 1.6;
/** A coach at or past a reliable habit round gets this much pull toward it. */
const HABIT_PULL = 0.55;
/** Nobody takes a kicker or defence before this round unless forced to. */
const LATE_ONLY = 10;

/** Deterministic PRNG so a seeded practice draft can be replayed exactly. */
export function makeRng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Effective ADP, with a fallback for players the ADP feed never covered. */
function adpOf(player, maxAdp) {
  return player.adp ?? (maxAdp + (player.ecr ?? 900) / 10);
}

/** Players a slot has already drafted. */
export function rosterOfSlot(state, slot) {
  const byId = new Map(state.pool.map((p) => [p.id, p]));
  return state.picks
    .filter((pk) => pk.teamSlot === slot)
    .map((pk) => byId.get(pk.playerId))
    .filter(Boolean);
}

/** Remaining unfilled starter slots for a roster, FLEX resolved last. */
export function unfilledSlots(roster, settings) {
  const need = { ...settings.roster };
  const leftovers = [];
  for (const p of [...roster].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))) {
    if ((need[p.pos] || 0) > 0) need[p.pos] -= 1;
    else leftovers.push(p);
  }
  for (const p of leftovers) {
    if ((need.FLEX || 0) > 0 && FLEX_ELIGIBLE.includes(p.pos)) need.FLEX -= 1;
  }
  return need;
}

const countNeed = (need) => Object.values(need).reduce((a, b) => a + b, 0);

function fillsNeed(player, need) {
  if ((need[player.pos] || 0) > 0) return true;
  return (need.FLEX || 0) > 0 && FLEX_ELIGIBLE.includes(player.pos);
}

/**
 * Choose a player for one opponent.
 *
 * Returns the chosen player, or null if nothing is available. Never returns a
 * player already drafted, because it only ever sees `available`.
 */
export function mockPickFor(coachName, available, roster, settings, round, rng) {
  if (!available.length) return null;

  const maxAdp = available.reduce((m, p) => Math.max(m, p.adp ?? 0), 0) || 200;
  const need = unfilledSlots(roster, settings);
  const picksLeft = settings.rounds - roster.length;
  const forced = picksLeft <= countNeed(need);

  let pool = available;
  if (forced) {
    // Yahoo restricts you to startable players once you can no longer afford
    // a bench pick. Mirroring that is what makes the endgame realistic.
    const fills = available.filter((p) => fillsNeed(p, need));
    if (fills.length) pool = fills;
  } else if (round < LATE_ONLY) {
    const real = available.filter((p) => p.pos !== 'DST' && p.pos !== 'K');
    if (real.length) pool = real;
  }

  // Rank by ADP, then pull toward this coach's reliable habits. A habit only
  // applies once they have reached the round they usually act on, and only
  // while the position is still unfilled for them.
  const habits = reliableHabits(coachByName(coachName))
    .filter((h) => round >= Math.floor(h.round) && (need[h.pos] || 0) > 0);

  const scored = pool.map((p) => {
    let key = adpOf(p, maxAdp);
    for (const h of habits) {
      if (h.pos === p.pos) key *= 1 - HABIT_PULL;
    }
    return { p, key };
  }).sort((a, b) => a.key - b.key);

  // Exponential reach: usually the top name, occasionally further down. This
  // is what stops every practice draft being identical.
  const depth = Math.min(scored.length - 1, Math.floor(-Math.log(1 - rng()) * REACH));
  return scored[depth].p;
}

/**
 * Run the draft forward until it is the user's turn again (or the draft ends).
 *
 * `record` is injected rather than imported so this stays free of state.js.
 * It is called once per simulated pick and must return truthy on success --
 * a falsy return aborts rather than spinning, since a rejected pick would
 * otherwise loop forever on the same player.
 */
export function runOpponentsUntilMyTurn(state, { record, slotOnClock, mySlot, rng, maxPicks = 200 }) {
  const drafted = [];
  const total = state.settings.teams * state.settings.rounds;

  for (let guard = 0; guard < maxPicks; guard += 1) {
    const pickNo = state.picks.length + 1;
    if (pickNo > total) break;
    const slot = slotOnClock(pickNo, state.settings.teams);
    if (slot === mySlot) break;

    const taken = new Set(state.picks.map((pk) => pk.playerId));
    const available = state.pool.filter((p) => !taken.has(p.id));
    const round = Math.floor((pickNo - 1) / state.settings.teams) + 1;
    const coachName = (state.settings.draftOrder || [])[slot - 1] || `Team ${slot}`;

    const choice = mockPickFor(coachName, available, rosterOfSlot(state, slot),
      state.settings, round, rng);
    if (!choice) break;
    if (!record(choice.id)) break;
    drafted.push({ pickNo, slot, coach: coachName, player: choice });
  }
  return drafted;
}
