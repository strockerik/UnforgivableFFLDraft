// Every team's roster as it fills, not just yours.
//
// Knowing what the other nine already have is what makes the board readable:
// a team with three RBs and no QB tells you what they'll reach for next, and
// which positions will still be there when the snake comes back around.

import { el, mount } from './dom.js';
import { POSITIONS, teamNameForSlot } from '../config.js';
import { state } from '../state.js';
import { roundOf } from '../snake.js';

let root = null;

/** Picks grouped by draft slot, in pick order. */
export function picksByTeam(st) {
  const out = {};
  for (let s = 1; s <= st.settings.teams; s++) out[s] = [];
  for (const pick of st.picks) {
    const p = st.pool.find((x) => x.id === pick.playerId);
    if (p && out[pick.teamSlot]) out[pick.teamSlot].push({ ...p, pickNo: pick.pickNo });
  }
  return out;
}

/** Which starting slots a team still hasn't filled — drives "what they need". */
export function teamNeeds(players, roster) {
  const need = { ...roster };
  const leftovers = [];
  for (const p of [...players].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))) {
    if ((need[p.pos] || 0) > 0) need[p.pos]--;
    else leftovers.push(p);
  }
  for (const p of leftovers) {
    if ((need.FLEX || 0) > 0 && ['RB', 'WR', 'TE'].includes(p.pos)) need.FLEX--;
  }
  return Object.keys(need).filter((k) => need[k] > 0);
}

function teamCard(slot, players, isMine, onClock) {
  const counts = {};
  for (const p of players) counts[p.pos] = (counts[p.pos] || 0) + 1;
  const needs = teamNeeds(players, state.settings.roster);

  return el('div', { class: 'team-card' + (isMine ? ' team-mine' : '') + (onClock ? ' team-onclock' : '') },
    el('div', { class: 'team-head' },
      el('span', { class: 'team-slot' }, String(slot)),
      el('span', { class: 'team-name' }, teamNameForSlot(state.settings, slot)),
      isMine ? el('span', { class: 'tag you' }, 'YOU') : null,
      onClock ? el('span', { class: 'tag onclock' }, 'ON CLOCK') : null,
      el('span', { class: 'team-count' }, `${players.length}`),
    ),
    el('div', { class: 'team-pos-line' },
      POSITIONS.filter((p) => counts[p]).map((p) =>
        el('span', { class: `tag pos pos-${p}` }, `${p}${counts[p] > 1 ? '×' + counts[p] : ''}`)),
      players.length === 0 ? el('span', { class: 'muted' }, 'no picks yet') : null,
    ),
    players.length
      ? el('ol', { class: 'team-list' },
          players.map((p) => el('li', {},
            el('span', { class: 'team-pick-no' }, `${p.pickNo}`),
            el('span', { class: 'team-pick-name' }, p.name),
            el('span', { class: `tag pos pos-${p.pos}` }, p.pos),
          )))
      : null,
    needs.length
      ? el('div', { class: 'team-needs' }, 'needs: ', needs.join(', '))
      : el('div', { class: 'team-needs done' }, 'starters full'),
  );
}

function render() {
  if (!root) return;
  if (!state.pool.length) {
    mount(root, el('p', { class: 'empty' }, 'Load a player pool to see rosters fill.'));
    return;
  }

  const byTeam = picksByTeam(state);
  const pickNo = state.picks.length + 1;
  const total = state.settings.teams * state.settings.rounds;
  const onClockSlot = pickNo > total ? null
    : (roundOf(pickNo, state.settings.teams) % 2 === 1
        ? ((pickNo - 1) % state.settings.teams) + 1
        : state.settings.teams - (((pickNo - 1) % state.settings.teams) + 1) + 1);

  const mine = state.settings.slot;
  const cards = [];
  for (let s = 1; s <= state.settings.teams; s++) {
    cards.push(teamCard(s, byTeam[s], s === mine, s === onClockSlot));
  }

  mount(root,
    el('div', { class: 'cs-head' },
      el('h2', {}, 'League rosters'),
      el('span', { class: 'muted' }, `${state.picks.length} of ${total} picks made`),
    ),
    el('div', { class: 'team-grid' }, cards),
  );
}

export function initTeams(container) {
  root = container;
  render();
  return render;
}
