// Practice mode: drives the other nine coaches so a rehearsal draft needs only
// your own picks.
//
// The simulation itself lives in js/mock.js (pure, no state import). This file
// is the bridge: it watches state, and when practice mode is on and the clock
// is not on you, it records opponent picks through state.js until your turn.
//
// Re-entrancy is the hazard here. Every recorded pick calls notify(), which
// re-runs the subscriber that called us, so without a guard the first opponent
// pick would recurse ten deep. Hence `running`.

import { state, draftPlayer } from '../state.js';
import { slotOnClock } from '../snake.js';
import { mySlot } from '../config.js';
import { makeRng, runOpponentsUntilMyTurn } from '../mock.js';
import { toast } from './toast.js';

let running = false;
let rng = makeRng(Date.now() & 0x7fffffff);

/** Fresh randomness, so two practice drafts differ. Seed for a repeatable one. */
export function reseedMock(seed) {
  rng = makeRng(seed || (Date.now() & 0x7fffffff));
}

/** True when practice mode should be doing work right now. */
function shouldRun() {
  if (!state.settings.mockDraft || running) return false;
  if (!state.pool.length) return false;
  const total = state.settings.teams * state.settings.rounds;
  const pickNo = state.picks.length + 1;
  if (pickNo > total) return false;
  return slotOnClock(pickNo, state.settings.teams) !== mySlot(state.settings);
}

/**
 * Advance the draft to the user's next turn. Safe to call at any time; does
 * nothing unless practice mode is on and someone else is on the clock.
 */
export function advanceMock({ announce = true } = {}) {
  if (!shouldRun()) return [];
  running = true;
  let drafted = [];
  try {
    drafted = runOpponentsUntilMyTurn(state, {
      record: (id) => draftPlayer(id).ok,
      slotOnClock,
      mySlot: mySlot(state.settings),
      rng,
    });
  } finally {
    // Must clear even if a pick throws, or practice mode silently dies for the
    // rest of the session.
    running = false;
  }

  if (announce && drafted.length) {
    const names = drafted.map((d) => `${d.coach}: ${d.player.name}`);
    // Keep the toast readable — the roster and board show the full picture.
    const shown = names.slice(0, 4).join(' · ');
    const more = names.length > 4 ? ` · +${names.length - 4} more` : '';
    toast(`Practice — ${drafted.length} pick${drafted.length === 1 ? '' : 's'}: ${shown}${more}`);
  }
  return drafted;
}

/** Hook for main.js to call on every state change. */
export function initMockRunner() {
  return () => { advanceMock(); };
}
