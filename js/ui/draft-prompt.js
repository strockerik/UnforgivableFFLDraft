// Shared confirmation for recording a pick.
//
// Both entry points — the board's "+" button and the recommendation panel's
// "Draft X" button — must ask the same question and name the same team.
// Previously the board recorded silently while the panel always claimed the
// player was going "to your roster", which was wrong for the nine picks per
// round that belong to somebody else.

import { teamNameForSlot } from '../config.js';
import { state } from '../state.js';
import { slotOnClock } from '../snake.js';

/** Who the next pick belongs to. */
export function draftTarget() {
  const pickNo = state.picks.length + 1;
  const slot = slotOnClock(pickNo, state.settings.teams);
  const isMine = slot === state.settings.slot;
  return {
    pickNo,
    slot,
    isMine,
    who: isMine ? 'your roster' : teamNameForSlot(state.settings, slot),
  };
}

/**
 * Confirm before recording. Returns false only if the user cancels.
 *
 * The `confirmEveryPick` check lives HERE rather than at each call site. It
 * used to be applied by the board and not by the recommendation panel, so
 * switching the setting off silenced one path and not the other. Keeping the
 * decision in one place is the only way the two stay honest.
 */
export function confirmDraft(player) {
  if (!state.settings.confirmEveryPick) return true;
  const { pickNo, isMine, who } = draftTarget();
  const heading = isMine
    ? `Pick ${pickNo} — YOUR PICK`
    : `Pick ${pickNo} — ${who}`;
  return confirm(`${heading}\n\nDraft ${player.name} (${player.pos}${player.team ? ', ' + player.team : ''}) to ${who}?`);
}
