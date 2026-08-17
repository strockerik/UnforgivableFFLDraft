// Available-player board: sortable columns, typeahead search, one-tap draft.

import { el, mount } from './dom.js';
import { POSITIONS } from '../config.js';
import { state, availablePlayers, draftPlayer } from '../state.js';
import { confirmDraft, draftTarget } from './draft-prompt.js';

let filter = 'ALL';
let query = '';
let root = null;

// Default view is what the engine actually ranks on.
let sortKey = 'value';
let sortDir = 'desc';

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '');

/**
 * Column definitions. `better` records which direction is useful, so the
 * first click sorts the helpful way rather than making you click twice —
 * lower is better for a rank, higher is better for points.
 */
const COLUMNS = [
  { key: 'pos', label: 'POS', better: 'asc', left: true,
    tip: 'Position and rank within it. RB3 is the third-best remaining running back by consensus.' },
  { key: 'ecr', label: 'ECR', better: 'asc',
    tip: 'Expert Consensus Rank — overall ranking across 100+ FantasyPros experts. Lower is better.' },
  { key: 'tier', label: 'TIER', better: 'asc',
    tip: 'Consensus tier. Players within a tier are roughly interchangeable, so what matters is how many are left in one — when a tier is nearly empty, that position becomes urgent.' },
  { key: 'bye', label: 'BYE', better: 'asc',
    tip: 'Bye week. Two starters sharing a bye leaves a hole in your lineup that week.' },
  { key: 'adp', label: 'ADP', better: 'asc',
    tip: 'Average Draft Position — where the market actually drafts him. Someone still available well past his ADP is falling to you.' },
  { key: 'projPoints', label: 'PROJ', better: 'desc',
    tip: 'Projected season fantasy points from FantasyPros. A raw total — it does not account for position scarcity, which is what VALUE adds.' },
  { key: 'value', label: 'VALUE', better: 'desc',
    tip: 'Value over replacement (VORP): projected points minus the last startable player at that position in YOUR league. The only number that compares across positions, and what the engine ranks on.' },
];

function matches(p) {
  if (filter !== 'ALL' && p.pos !== filter) return false;
  if (!query) return true;
  const q = norm(query);
  return norm(p.name).includes(q) || norm(p.team || '').includes(q) || norm(p.pos).includes(q);
}

function sortValue(p, key) {
  // Sort POS as position then positional rank, so RB2 follows RB1 rather
  // than RB10 sorting between them.
  if (key === 'pos') return `${p.pos}${String(p.posRank ?? 9999).padStart(5, '0')}`;
  if (key === 'name') return norm(p.name);
  return p[key];
}

function sortPlayers(list) {
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    // Missing values always sink, whichever direction is active — an
    // unranked player must never top the board just because a column is empty.
    const aMiss = av == null || av === '';
    const bMiss = bv == null || bv === '';
    if (aMiss && bMiss) return (a.ecr ?? 9999) - (b.ecr ?? 9999);
    if (aMiss) return 1;
    if (bMiss) return -1;
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av).localeCompare(String(bv)) * dir;
    }
    return (av - bv) * dir;
  });
}

function setSort(key, better) {
  if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  else { sortKey = key; sortDir = better; }
  render();
}

const INJ_SEVERITY = /^(out|ir|injured reserve|doubtful|pup|suspended)/i;
const fmt = (v, dp = 0) => (v == null ? '·' : typeof v === 'number' ? v.toFixed(dp) : String(v));
const arrow = (k) => (sortKey === k ? el('span', { class: 'arrow' }, sortDir === 'asc' ? '▲' : '▼') : null);

function headerRow() {
  return el('li', { class: 'player player-head' },
    el('span', {}, ''),
    el('button', {
      class: 'col-head col-name' + (sortKey === 'name' ? ' sorted' : ''),
      title: 'Player name, team, and any tags from your strategy document. Hover a tag for its note.',
      onclick: () => setSort('name', 'asc'),
    }, 'PLAYER', arrow('name')),
    ...COLUMNS.map((c) => el('button', {
      class: `col-head cell-${c.key}` + (sortKey === c.key ? ' sorted' : '') + (c.left ? ' col-left' : ''),
      title: c.tip,
      onclick: () => setSort(c.key, c.better),
    }, c.label, arrow(c.key))),
  );
}

function playerRow(p, onDraft) {
  const inj = p.injury && p.injury.status
    ? el('span', {
        class: 'tag inj' + (INJ_SEVERITY.test(p.injury.status) ? ' inj-bad' : ''),
        title: [p.injury.status, p.injury.detail].filter(Boolean).join(' — '),
      }, p.injury.status)
    : null;

  return el('li', { class: 'player' },
    el('button', { class: 'draft-btn', title: `Draft ${p.name}`, onclick: () => onDraft(p) }, '+'),
    el('div', { class: 'player-main' },
      el('div', { class: 'player-name' }, p.name, inj),
      el('div', { class: 'player-meta' }, p.team || '—'),
      Array.isArray(p.tags) && p.tags.length
        ? el('div', { class: 'player-tags', title: p.tagNote || '' },
            p.tags.map((t) => el('span', { class: `tag strat strat-${t}` }, t)))
        : null,
      p.tagNote ? el('div', { class: 'player-tagnote' }, p.tagNote) : null,
    ),
    el('span', { class: 'cell cell-pos col-left' },
      el('span', { class: `tag pos pos-${p.pos}` }, p.pos + (p.posRank ?? ''))),
    el('span', { class: 'cell cell-ecr' }, fmt(p.ecr)),
    el('span', { class: 'cell cell-tier' }, p.tier == null ? '·' : `T${p.tier}`),
    el('span', { class: 'cell cell-bye' }, fmt(p.bye)),
    el('span', { class: 'cell cell-adp' },
      fmt(p.adp, p.adp != null && !Number.isInteger(p.adp) ? 1 : 0)),
    el('span', { class: 'cell cell-projPoints' }, fmt(p.projPoints)),
    el('span', {
      class: 'cell cell-value strong',
      title: p.valueProj != null
        ? `Projections: ${Math.round(p.valueProj)} · Rank model: ${Math.round(p.valueModel)}`
        : 'Rank-based value over replacement — no projections loaded',
    },
      fmt(p.value),
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
  const shown = sortPlayers(available.filter(matches)).slice(0, 200);

  const search = el('input', {
    class: 'search', type: 'search', placeholder: 'Search players…',
    value: query, autocomplete: 'off',
    oninput: (e) => { query = e.target.value; render(); },
    onkeydown: (e) => {
      // Enter drafts the top match — the fast path when a name is called out
      // and you have seconds to record it.
      if (e.key === 'Enter' && shown.length) { e.preventDefault(); handleDraft(shown[0]); }
    },
  });

  const filters = el('div', { class: 'filters' },
    ['ALL', ...POSITIONS].map((pos) =>
      el('button', {
        class: 'chip' + (filter === pos ? ' active' : ''),
        onclick: () => { filter = pos; render(); },
      }, pos)));

  const list = shown.length
    ? el('ul', { class: 'player-list' }, headerRow(), shown.map((p) => playerRow(p, handleDraft)))
    : el('p', { class: 'empty' },
        state.pool.length ? 'No players match that search.' : 'No player pool loaded — open Setup and load one.');

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
  const { who } = draftTarget();
  if (!confirmDraft(player)) return;
  const res = draftPlayer(player.id);
  if (!res.ok) { alert(res.error); return; }
  query = '';
  render();
  announce(`${player.name} → ${who}`);
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
