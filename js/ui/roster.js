// Your roster, starter slots, remaining needs, and bye collisions.

import { el, mount } from './dom.js';
import { state } from '../state.js';
import { rosterAnalysis } from '../engine.js';
import { myPicks } from '../snake.js';

let root = null;

function slotRow(label, players, wanted) {
  const filled = players || [];
  const cells = [];
  for (let i = 0; i < wanted; i++) {
    const p = filled[i];
    cells.push(
      el('div', { class: 'slot' + (p ? '' : ' slot-empty') },
        el('span', { class: 'slot-label' }, label),
        p
          ? el('span', { class: 'slot-player' }, p.name, el('span', { class: 'slot-bye' }, p.bye != null ? ` (${p.bye})` : ''))
          : el('span', { class: 'slot-player muted' }, 'open'),
      )
    );
  }
  return cells;
}

function render() {
  if (!root) return;
  const a = rosterAnalysis(state);
  const roster = state.settings.roster;

  const slots = [];
  for (const [pos, count] of Object.entries(roster)) {
    slots.push(...slotRow(pos, a.slots[pos], count));
  }

  const bench = a.bench.length
    ? el('div', { class: 'bench' },
        el('h3', {}, `Bench (${a.bench.length}/${state.settings.bench})`),
        el('ul', { class: 'bench-list' },
          a.bench.map((p) => el('li', {}, `${p.name} `, el('span', { class: `tag pos pos-${p.pos}` }, p.pos)))
        ),
      )
    : null;

  const conflicts = a.byeConflicts.length
    ? el('div', { class: 'warn-inline' },
        el('strong', {}, 'Bye conflicts: '),
        a.byeConflicts.map((c) => `Week ${c.week} — ${c.names.join(', ')}`).join('; '),
      )
    : null;

  const picks = myPicks(state.settings);
  const made = state.picks.filter((p) => p.teamSlot === state.settings.slot).length;
  const upcoming = picks.slice(made, made + 4);

  mount(root,
    el('h2', {}, 'Your roster'),
    el('div', { class: 'slots' }, slots),
    conflicts,
    bench,
    el('div', { class: 'upcoming' },
      el('h3', {}, 'Your next picks'),
      upcoming.length
        ? el('p', {}, upcoming.join(' · '))
        : el('p', { class: 'muted' }, 'Draft complete.'),
    ),
  );
}

export function initRoster(container) {
  root = container;
  render();
  return render;
}
