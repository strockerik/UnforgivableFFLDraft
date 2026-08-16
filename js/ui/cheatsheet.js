// Printable emergency cheat sheet — the fallback when the laptop dies,
// the wifi drops, or the API is down. Paper always works.

import { el, mount } from './dom.js';
import { POSITIONS } from '../config.js';
import { state, availablePlayers } from '../state.js';
import { replacementLevels } from '../vorp.js';
import { myPicks } from '../snake.js';

let root = null;

function column(pos, players, replacementIdx) {
  const rows = players.slice(0, 30).map((p, i) =>
    el('li', { class: i + 1 === replacementIdx ? 'replacement-line' : '' },
      el('span', { class: 'cs-rank' }, `${p.pos}${p.posRank ?? i + 1}`),
      el('span', { class: 'cs-name' }, p.name),
      el('span', { class: 'cs-meta' },
        p.tier != null ? `T${p.tier}` : '',
        p.bye != null ? ` B${p.bye}` : '',
      ),
    )
  );
  return el('div', { class: 'cs-col' },
    el('h3', {}, pos),
    el('ol', { class: 'cs-list' }, rows),
  );
}

function render() {
  if (!root) return;
  if (!state.pool.length) {
    mount(root, el('p', { class: 'empty' }, 'Load a player pool to generate the cheat sheet.'));
    return;
  }

  const available = availablePlayers();
  const levels = replacementLevels(state.settings);
  const cols = POSITIONS.map((pos) =>
    column(pos, available.filter((p) => p.pos === pos), levels[pos])
  );

  mount(root,
    el('div', { class: 'cs-head' },
      el('h2', {}, 'Emergency cheat sheet'),
      el('button', { class: 'btn small', onclick: () => window.print() }, 'Print'),
    ),
    el('p', { class: 'muted cs-sub' },
      `${state.settings.teams}-team ${state.settings.scoring}, slot ${state.settings.slot}. `,
      `Your picks: ${myPicks(state.settings).join(', ')}. `,
      'The dashed line marks replacement level — below it, the position is fungible.',
      state.poolMeta.isSample ? ' — SYNTHETIC SAMPLE DATA, NOT REAL RANKINGS.' : '',
    ),
    el('div', { class: 'cs-grid' }, cols),
  );
}

export function initCheatsheet(container) {
  root = container;
  render();
  return render;
}
