// Bootstrap and wiring.

import { $, el, mount } from './ui/dom.js';
import { teamNameForSlot } from './config.js';
import { state, subscribe, load, undo, canUndo, availablePlayers } from './state.js';
import { draftPosition } from './snake.js';
import { VALUE_MODE_LABEL } from './vorp.js';
import { initBoard } from './ui/board.js';
import { initRoster } from './ui/roster.js';
import { initRecs } from './ui/recs.js';
import { initSettings, autoLoad } from './ui/settings.js';
import { initCheatsheet } from './ui/cheatsheet.js';
import { initTeams } from './ui/teams.js';

function renderStatusBar() {
  const bar = $('#status-bar');
  if (!bar) return;

  if (!state.pool.length) {
    mount(bar, el('span', { class: 'status-msg' }, 'No player pool loaded — open Setup below.'));
    return;
  }

  const pos = draftPosition(state.picks.length + 1, state.settings);
  const last = state.picks[state.picks.length - 1];
  const lastPlayer = last ? state.pool.find((p) => p.id === last.playerId) : null;

  mount(bar,
    el('div', { class: 'stat' },
      el('span', { class: 'stat-label' }, 'Pick'),
      el('span', { class: 'stat-value' }, pos.complete ? '—' : `${pos.pickNo}`),
    ),
    el('div', { class: 'stat' },
      el('span', { class: 'stat-label' }, 'Round'),
      el('span', { class: 'stat-value' }, pos.complete ? 'done' : `${pos.round}/${state.settings.rounds}`),
    ),
    // These two are the whole reason to glance up mid-draft, so they get
    // hero weight; the rest are reference.
    el('div', { class: 'stat stat-hero' + (pos.isMyPick ? ' stat-mine' : '') },
      el('span', { class: 'stat-label' }, 'On the clock'),
      el('span', { class: 'stat-value' }, pos.complete ? '—' : (pos.isMyPick ? 'YOU' : teamNameForSlot(state.settings, pos.slotOnClock))),
    ),
    el('div', { class: 'stat stat-hero' },
      el('span', { class: 'stat-label' }, 'Until your turn'),
      el('span', { class: 'stat-value' }, pos.picksUntilMyTurn == null ? '—' : String(pos.picksUntilMyTurn)),
    ),
    el('div', { class: 'stat' },
      el('span', { class: 'stat-label' }, 'Available'),
      el('span', { class: 'stat-value' }, String(availablePlayers().length)),
    ),
    el('div', { class: 'bar-actions' },
      lastPlayer ? el('span', { class: 'last-pick' }, `${lastPlayer.name} \u2192 ${teamNameForSlot(state.settings, last.teamSlot)}`) : null,
      el('button', { class: 'btn small', disabled: !canUndo(), onclick: () => undo() }, 'Undo'),
    ),
  );
}

function renderBanner() {
  const banner = $('#banner');
  if (!banner) return;
  const bits = [];
  if (state.poolMeta.isSample) {
    bits.push(el('div', { class: 'banner-sample' },
      'SYNTHETIC SAMPLE DATA — invented players and numbers, for testing only. Load real FantasyPros exports before drafting.'));
  }
  if (state.valueMode === 'surrogate' && state.pool.length) {
    bits.push(el('div', { class: 'banner-note' },
      `${VALUE_MODE_LABEL.surrogate}. Values are a modeled ordering signal derived from positional rank, not projected points.`));
  }
  mount(banner, bits);
  banner.hidden = bits.length === 0;
}

function main() {
  load();

  const rerenderBoard = initBoard($('#board'));
  const rerenderRoster = initRoster($('#roster'));
  const rerenderRecs = initRecs($('#recs'));
  const rerenderSettings = initSettings($('#setup'));
  const rerenderCheat = initCheatsheet($('#cheatsheet'));
  const rerenderTeams = initTeams($('#teams'));

  subscribe(() => {
    renderStatusBar();
    renderBanner();
    rerenderBoard();
    rerenderRoster();
    rerenderRecs();
    rerenderSettings();
    rerenderCheat();
    rerenderTeams();
  });

  renderStatusBar();
  renderBanner();
  autoLoad();

  // Ctrl/Cmd+Z undoes a pick — the fastest recovery when a name is misheard.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    }
  });
}

main();
