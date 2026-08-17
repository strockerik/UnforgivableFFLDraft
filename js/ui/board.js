// Available-player board: typeahead search, position filter, one-tap draft.

import { el, mount } from './dom.js';
import { POSITIONS, teamNameForSlot } from '../config.js';
import { state, availablePlayers, draftPlayer } from '../state.js';
import { slotOnClock } from '../snake.js';

let filter = 'ALL';
let query = '';
let root = null;

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '');

function matches(p) {
  if (filter !== 'ALL' && p.pos !== filter) return false;
  if (!query) return true;
  const q = norm(query);
  return norm(p.name).includes(q) || norm(p.team || '').includes(q) || norm(p.pos).includes(q);
}

const INJ_SEVERITY = /^(out|ir|injured reserve|doubtful|pup|suspended)/i;

function playerRow(p, onDraft) {
  const cliffTag = p.tier != null ? el('span', { class: 'tag tier' }, `T${p.tier}`) : null;
  const adpDelta = p.adp != null ? Math.round(p.adp) : null;
  const inj = p.injury && p.injury.status
    ? el('span', {
        class: 'tag inj' + (INJ_SEVERITY.test(p.injury.status) ? ' inj-bad' : ''),
        title: [p.injury.status, p.injury.detail].filter(Boolean).join(' — '),
      }, p.injury.status)
    : null;

  return el('li', { class: 'player' },
    el('button', {
      class: 'draft-btn',
      title: `Draft ${p.name}`,
      onclick: () => onDraft(p),
    }, '+'),
    el('div', { class: 'player-main' },
      el('div', { class: 'player-name' },
        p.name,
        el('span', { class: `tag pos pos-${p.pos}` }, p.pos + (p.posRank ?? '')),
        inj,
      ),
      Array.isArray(p.tags) && p.tags.length
        ? el('div', { class: 'player-tags', title: p.tagNote || '' },
            p.tags.map((t) => el('span', { class: `tag strat strat-${t}` }, t)),
            p.tagConfidence ? el('span', { class: 'tag strat-conf' }, p.tagConfidence) : null)
        : null,
      p.tagNote ? el('div', { class: 'player-tagnote' }, p.tagNote) : null,
      el('div', { class: 'player-meta' },
        p.team || '—',
        p.bye != null ? ` · Bye ${p.bye}` : '',
        cliffTag ? ' · ' : '', cliffTag,
        adpDelta != null ? ` · ADP ${adpDelta}` : '',
      ),
    ),
    el('div', { class: 'player-value', title: p.valueProj != null
        ? `Projections: ${Math.round(p.valueProj)} · Rank model: ${Math.round(p.valueModel)}`
        : 'Rank-based value over replacement' },
      String(Math.round(p.value ?? 0)),
      p.valueGap != null && Math.abs(p.valueGap) >= 15
        ? el('span', {
            class: 'value-gap ' + (p.valueGap > 0 ? 'gap-up' : 'gap-down'),
            title: p.valueGap > 0
              ? 'Projections like him more than his consensus rank does'
              : 'Consensus rank likes him more than the projections do',
          }, (p.valueGap > 0 ? '▲' : '▼') + Math.abs(p.valueGap))
        : null,
    ),
  );
}

function render() {
  if (!root) return;
  const available = availablePlayers();
  const shown = available.filter(matches).slice(0, 200);

  const search = el('input', {
    class: 'search',
    type: 'search',
    placeholder: 'Search players…',
    value: query,
    autocomplete: 'off',
    oninput: (e) => { query = e.target.value; render(); },
    onkeydown: (e) => {
      // Enter drafts the single top match — the fast path when a name is
      // called out and you have seconds to record it.
      if (e.key === 'Enter' && shown.length) {
        e.preventDefault();
        handleDraft(shown[0]);
      }
    },
  });

  const filters = el('div', { class: 'filters' },
    ['ALL', ...POSITIONS].map((pos) =>
      el('button', {
        class: 'chip' + (filter === pos ? ' active' : ''),
        onclick: () => { filter = pos; render(); },
      }, pos)
    )
  );

  const list = shown.length
    ? el('ul', { class: 'player-list' }, shown.map((p) => playerRow(p, handleDraft)))
    : el('p', { class: 'empty' },
        state.pool.length ? 'No players match that search.' : 'No player pool loaded — open Setup and load a CSV.');

  mount(root,
    el('div', { class: 'board-head' },
      el('h2', {}, 'Available'),
      el('span', { class: 'count' }, `${available.length} left`),
    ),
    search,
    filters,
    list,
    shown.length === 200 ? el('p', { class: 'empty' }, 'Showing the top 200 — search to narrow.') : null,
  );

  // Keep focus in the search box so consecutive picks can be typed quickly.
  if (document.activeElement === document.body && query) {
    search.focus();
    search.setSelectionRange(query.length, query.length);
  }
}

function handleDraft(player) {
  const pickNo = state.picks.length + 1;
  const slot = slotOnClock(pickNo, state.settings.teams);
  const isMine = slot === state.settings.slot;
  const who = isMine ? 'YOU' : teamNameForSlot(state.settings, slot);

  if (isMine && !confirm(`Pick ${pickNo} is YOURS.\n\nDraft ${player.name} (${player.pos}) to ${who}?`)) return;

  const res = draftPlayer(player.id);
  if (!res.ok) { alert(res.error); return; }
  query = '';
  render();
  announce(`Pick ${pickNo} → ${player.name} (${who})`);
}

function announce(msg) {
  const live = document.getElementById('live-region');
  if (live) live.textContent = msg;
}

export function initBoard(container) {
  root = container;
  render();
  return render;
}
