// Available-player board: sortable columns, typeahead search, one-tap draft.

import { el, mount } from './dom.js';
import { POSITIONS } from '../config.js';
import { state, availablePlayers, draftPlayer, setSettings } from '../state.js';
import { roundOf } from '../snake.js';
import { confirmDraft, draftTarget } from './draft-prompt.js';
import { toast } from './toast.js';

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
// Ordered by decision weight, not by convention. VALUE is what the engine
// ranks on, so it sits beside the name rather than nine columns away; ECR,
// ADP and PROJ are reference metrics and get pushed right.
const COLUMNS = [
  { key: 'pos', label: 'POS', better: 'asc', left: true,
    tip: 'Position and rank within it. RB3 is the third-best remaining running back by consensus.' },
  { key: 'value', label: 'VALUE', better: 'desc', strong: true,
    tip: 'Value over replacement (VORP): projected points minus the last startable player at that position in YOUR league. The only number that compares across positions, and what the engine ranks on.' },
  { key: 'tier', label: 'TIER', better: 'asc',
    tip: 'Consensus tier. Players within a tier are roughly interchangeable, so what matters is how many are left in one — when a tier is nearly empty, that position becomes urgent.' },
  { key: 'bye', label: 'BYE', better: 'asc',
    tip: 'Bye week. Two starters sharing a bye leaves a hole in your lineup that week.' },
  { key: 'ecr', label: 'ECR', better: 'asc',
    tip: 'Expert Consensus Rank — overall ranking across 100+ FantasyPros experts. Lower is better.' },
  { key: 'adp', label: 'ADP', better: 'asc',
    tip: 'Average Draft Position — where the market actually drafts him. Someone still available well past his ADP is falling to you.' },
  { key: 'projPoints', label: 'PROJ', better: 'desc',
    tip: 'Projected season fantasy points: the equal-weight mean of every source that has this player — CBS, Draft Sharks, ESPN, FantasyPros (alphabetical; none outranks another). Each is converted to THIS league\'s scoring first — 6-point passing TDs, −3 interceptions, 0.5 per reception — so no site\'s own scoring leaks in. Averaging independent forecasts beats trusting any one. A raw number: it does not account for position scarcity, which is what VALUE adds.' },
  { key: 'ecrSpread', label: 'RISK', better: 'asc',
    tip: 'How far apart the most and least optimistic expert rank him. Low means the field agrees and the projection is trustworthy; high means it is a guess dressed as a number. Hover a value to see the range, and how far apart the FantasyPros and ESPN point forecasts are. Shown as n/a for K and DST, whose spread only reflects that most experts decline to rank them.' },
];

// 8. One loud signal per row. Risk tags outrank praise: a drafter needs
// warnings to pop, not compliments.
const TAG_PRIORITY = [
  'injury-risk', 'bust', 'committee-risk', 'rookie-uncertainty',
  'volume-king', 'breakout', 'sleeper', 'schedule-boost', 'handcuff',
];
const MAX_TAGS_SHOWN = 2;

/**
 * A strategy tag, carrying how many analysts agreed when that is known.
 *
 * A bust call from seven of eight lists and one from two of eight are very
 * different pieces of information, and they used to render identically. The
 * COUNT is the signal and it is printed, not encoded in shading — a heavier
 * border is a secondary cue only, so this survives greyscale printing and
 * colourblind viewing exactly like the position chips do.
 */
function tagChip(tag, player) {
  const n = player.tagSources;
  const of = player.tagSourcesOf;
  const strong = n != null && of != null && n / of >= 0.5;
  if (tag !== 'bust' || n == null) {
    return el('span', { class: `tag strat strat-${tag}` }, tag);
  }
  return el('span', {
    class: `tag strat strat-${tag}` + (strong ? ' strat-strong' : ''),
    title: `${n} of ${of} analyst bust lists flagged him`
      + `${strong ? ' — majority view' : ' — minority view'}`,
  }, tag, el('span', { class: 'tag-count' }, `${n}/${of}`));
}

/**
 * Current injury status, from tools/fetch_injuries.py.
 *
 * Shown on the row rather than only in Claude's answer, because the engine
 * does not read injuries at all: a player on PUP still carries a full season
 * projection and can sit at the top of the board looking perfectly healthy.
 * Alec Pierce was drafted in round 8 of a practice draft two days after ankle
 * surgery put him on PUP, and nothing on screen said a word about it.
 *
 * Only high and medium severity render. August "Questionable" covers hundreds
 * of players and would paint the whole board without informing anything.
 */
function injuryChip(player) {
  const inj = player.injury;
  if (!inj || !inj.status) return null;
  if (inj.severity !== 'high' && inj.severity !== 'medium') return null;
  return el('span', {
    class: `tag injury injury-${inj.severity}`,
    title: [inj.status, inj.detail].filter(Boolean).join(' — ')
      + (inj.severity === 'high' ? ' — expect missed games' : ''),
  }, inj.status);
}

function rankedTags(tags) {
  return [...tags].sort((a, b) => {
    const ai = TAG_PRIORITY.indexOf(a), bi = TAG_PRIORITY.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

/**
 * Rounds from the end at which kickers and defences stop being noise. Matches
 * the engine's own gate, so the board and the recommendation agree about when
 * they become draftable.
 */
const FILLER_ROUNDS_FROM_END = 2;

function fillersHidden() {
  if (!state.settings.hideLateFillers) return false;
  const round = roundOf(state.picks.length + 1, state.settings.teams);
  return round < state.settings.rounds - FILLER_ROUNDS_FROM_END + 1;
}

function matches(p) {
  // Hidden only in the ALL view — asking for K or DST explicitly always shows
  // them, so this never blocks you from drafting one early if you mean to.
  if (filter === 'ALL' && fillersHidden() && (p.pos === 'K' || p.pos === 'DST')) return false;
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
      class: `col-head cell-${c.key}` + (sortKey === c.key ? ' sorted' : '') +
        (c.left ? ' col-left' : '') + (c.strong ? ' col-strong' : ''),
      title: c.tip,
      onclick: () => setSort(c.key, c.better),
    }, c.label, arrow(c.key))),
  );
}

function playerRow(p, onDraft, opts = {}) {
  // Injury collapses to a glyph; only a real absence gets colour. Full status
  // stays in the tooltip.
  const severe = p.injury && p.injury.status && INJ_SEVERITY.test(p.injury.status);
  const inj = p.injury && p.injury.status
    ? el('span', {
        class: 'inj-dot' + (severe ? ' inj-bad' : ''),
        title: [p.injury.status, p.injury.detail].filter(Boolean).join(' — '),
      }, severe ? '\u2716' : '\u25CF')
    : null;

  const allTags = Array.isArray(p.tags) ? rankedTags(p.tags) : [];
  const shownTags = allTags.slice(0, MAX_TAGS_SHOWN);
  const hiddenTags = allTags.slice(MAX_TAGS_SHOWN);
  const tagTitle = [p.tagNote, hiddenTags.length ? `also: ${hiddenTags.join(', ')}` : null]
    .filter(Boolean).join(' — ');

  return el('li', {
    class: 'player' + (opts.tierBreak ? ' tier-break' : '') + (opts.isTop ? ' top-match' : ''),
    // Whole row is the target; the "+" stays as the visual affordance.
    onclick: (e) => { if (!e.target.closest('.inj-dot,.tag')) onDraft(p); },
  },
    // stopPropagation is load-bearing: the whole row is also a draft target,
    // so without it a click on "+" runs onDraft twice and you get two
    // confirmation dialogs for one pick.
    el('button', {
      class: 'draft-btn',
      title: `Draft ${p.name}`,
      onclick: (e) => { e.stopPropagation(); onDraft(p); },
    }, '+'),
    el('div', { class: 'player-main' },
      el('div', { class: 'player-name' }, p.name, inj),
      el('div', { class: 'player-sub' },
        el('span', { class: 'player-meta' }, p.team || '—'),
        injuryChip(p),
        shownTags.length
          ? el('span', { class: 'player-tags', title: tagTitle },
              shownTags.map((t) => tagChip(t, p)),
              hiddenTags.length ? el('span', { class: 'tag strat-more' }, `+${hiddenTags.length}`) : null)
          : null,
      ),
      p.tagNote ? el('div', { class: 'player-tagnote' }, p.tagNote) : null,
    ),
    el('span', { class: 'cell cell-pos col-left' },
      el('span', { class: `tag pos pos-${p.pos}` }, p.pos + (p.posRank ?? ''))),
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
          }, (p.valueGap > 0 ? '\u25B2' : '\u25BC') + Math.abs(p.valueGap))
        : null,
    ),
    el('span', { class: 'cell cell-tier' }, p.tier == null ? '\u00B7' : `T${p.tier}`),
    el('span', { class: 'cell cell-bye' }, fmt(p.bye)),
    el('span', { class: 'cell cell-ecr' }, fmt(p.ecr)),
    el('span', { class: 'cell cell-adp' },
      fmt(p.adp, p.adp != null && !Number.isInteger(p.adp) ? 1 : 0)),
    el('span', { class: 'cell cell-projPoints' }, fmt(p.projPoints)),
    // RISK had a column header and a sort handler but no cell, so it rendered
    // blank for all 865 players. Backfilling ecrSpread onto cached pools fixed
    // the data and left the hole, which is why it still looked broken after.
    //
    // K and DST print "n/a" rather than nothing: their spread is null on
    // purpose (it measures only that most experts decline to rank them), and
    // an empty cell is indistinguishable from the bug that was just here.
    el('span', {
      class: 'cell cell-ecrSpread'
        + (p.ecrSpread != null && p.ecrSpread >= 40 ? ' risk-high' : ''),
      title: [
        p.ecrSpread == null
          ? 'Expert-rank spread is not measured for this position.'
          : `Experts rank him between ${p.ecrBest} and ${p.ecrWorst} overall`,
        p.sourceGap != null
          ? `Sources differ by ${p.sourceGap} projected points`
          : null,
        p.band?.ceiling != null && p.band?.floor != null
          ? `Draft Sharks range ${p.band.floor}–${p.band.ceiling}`
            + (p.band.upside != null ? ` (+${p.band.upside} upside)` : '')
          : null,
        p.band?.injuryRisk ? `Durability risk ${p.band.injuryRisk}` : null,
      ].filter(Boolean).join(' · '),
    }, p.pos === 'K' || p.pos === 'DST' ? 'n/a' : fmt(p.ecrSpread)),
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

  // Remaining count per position — the "is RB about to run dry" signal.
  //
  // The number shown is players still ABOVE REPLACEMENT, not the raw pool.
  // Raw counts actively mislead: at one point there were 189 tight ends on
  // the board and exactly 11 of them were startable, which reads as depth
  // when it is a cliff. The raw figure stays in the tooltip.
  const counts = {};
  const startable = {};
  for (const p of available) {
    counts[p.pos] = (counts[p.pos] || 0) + 1;
    if ((p.value ?? 0) > 0) startable[p.pos] = (startable[p.pos] || 0) + 1;
  }
  const totalStartable = Object.values(startable).reduce((a, b) => a + b, 0);

  const filters = el('div', { class: 'filters' },
    // Without this caption the chips read as a broken filter: "ALL 29" sitting
    // next to a header saying "787 left" looks like the board lost players.
    el('span', { class: 'filter-caption', title: 'Chip numbers count players still projected above replacement level, not the raw pool. A position at 0 has nobody startable left.' },
      'startable left:'),
    ['ALL', ...POSITIONS].map((pos) => {
      const above = pos === 'ALL' ? totalStartable : (startable[pos] || 0);
      const raw = pos === 'ALL' ? available.length : (counts[pos] || 0);
      return el('button', {
        class: 'chip' + (filter === pos ? ' active' : '')
          + (pos !== 'ALL' && above > 0 && above <= 3 ? ' chip-thin' : ''),
        title: pos === 'ALL'
          ? `${above} players above replacement, ${raw} on the board`
          : `${above} ${pos} above replacement — ${raw} on the board in total. `
            + 'The count shown is the startable one; the rest are replacement level.',
        onclick: () => { filter = pos; render(); },
      }, pos, el('span', { class: 'chip-count' }, String(above)));
    }),
    // K and DST are fungible and belong in the last two rounds, so before then
    // they are noise between the players you are actually choosing among.
    // Reappears on its own in round 14; the K/DST chips always override it.
    el('button', {
      class: 'chip chip-toggle' + (state.settings.hideLateFillers ? ' active' : ''),
      title: state.settings.hideLateFillers
        ? 'Kickers and defences are hidden from ALL until the last two rounds. Click to show them; the K and DST chips show them regardless.'
        : 'Kickers and defences are shown in ALL. Click to hide them until the last two rounds.',
      onclick: () => setSettings({ hideLateFillers: !state.settings.hideLateFillers }),
    }, state.settings.hideLateFillers ? 'K/DST hidden' : 'K/DST shown'));

  // Tier separators only mean something while the list is in a tier-ordered
  // sequence. Under an alphabetical or bye sort the boundaries are noise.
  const tierOrdered = ['value', 'ecr', 'tier', 'adp', 'projPoints'].includes(sortKey);

  const list = shown.length
    ? el('ul', { class: 'player-list' }, headerRow(), shown.map((p, i) => playerRow(p, handleDraft, {
        tierBreak: tierOrdered && i > 0 && p.tier != null
          && shown[i - 1].tier != null && p.tier !== shown[i - 1].tier,
        // Show what Enter will take, so the shortcut is trustworthy.
        isTop: i === 0 && !!query,
      })))
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
  // confirmDraft() honours the confirmEveryPick setting itself.
  if (!confirmDraft(player)) return;
  const res = draftPlayer(player.id);
  if (!res.ok) { alert(res.error); return; }
  query = '';
  render();
  toast(`${player.name} → ${who}`);
  announce(`${player.name} drafted to ${who}`);
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
