// Recommendation panel. Always shows the deterministic pick immediately;
// Claude's answer replaces it only after passing schema + allowlist checks.

import { el, mount } from './dom.js';
import { state, availablePlayers, getApiKey, getPassphrase, draftPlayer } from '../state.js';
import { evaluate, deterministicPick, buildEvidence } from '../engine.js';
import { recommend, secondOpinion, validateRecommendation, estimateCost,
  ClaudeError } from '../claude.js';
import { confirmDraft, draftTarget } from './draft-prompt.js';

let root = null;
let busy = false;
let result = null;     // { rec, source, note, usage, model }
let inflight = null;
let opinion = null;      // { text, searches, paused, model } from the last search
let opinionPickNo = null; // the pick it was researched FOR
let opinionOpen = true;
let searching = false;

/**
 * Render the model's prose without a markdown library.
 *
 * The second opinion comes back as free text with the shape the model chose --
 * usually a short lead paragraph and a bullet per player. Dumping that into
 * one <p> per blank line produced a wall that is hard to scan on a draft
 * clock, which is the opposite of what a second opinion is for.
 *
 * Deliberately handles only what the model actually emits: bullets, bold
 * runs, and a bare "Name — finding" line. Anything unrecognized falls through
 * as a paragraph rather than being mangled, so an unexpected format degrades
 * to plain text instead of disappearing.
 */
function inline(text) {
  // **bold** only; everything else stays literal so stray markdown characters
  // never eat content.
  return String(text).split(/\*\*(.+?)\*\*/g).map((part, i) =>
    (i % 2 ? el('strong', {}, part) : part));
}

function prose(text) {
  const out = [];
  let list = null;
  const flush = () => { if (list) { out.push(list); list = null; } };
  for (const raw of String(text).split(/\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const bullet = line.match(/^[-*\u2022]\s+(.*)$/);
    if (bullet) {
      if (!list) list = el('ul', { class: 'opinion-list' });
      list.append(el('li', {}, ...inline(bullet[1])));
      continue;
    }
    flush();
    const head = line.match(/^#{1,6}\s+(.*)$/);
    if (head) out.push(el('h4', { class: 'opinion-head' }, ...inline(head[1])));
    else out.push(el('p', { class: 'opinion-text' }, ...inline(line)));
  }
  flush();
  return out;
}

/**
 * Web-search cross-check, on its own button.
 *
 * Kept off the Ask Claude path on purpose: search adds many seconds and the
 * draft clock is 60. This is for a pick Erik wants to think about, not for
 * every pick. It returns prose and changes nothing — the engine's ranking and
 * Claude's recommendation are both untouched by whatever it finds.
 */
async function askSecondOpinion(evaluation) {
  if (searching) return;
  const top = (evaluation.ranked || []).slice(0, 5).map(({ player: p }) => ({
    name: p.name, pos: p.pos, team: p.team, value: Math.round(p.value ?? 0),
    injury: p.injury ? [p.injury.status, p.injury.detail].filter(Boolean).join(' — ') : null,
    tags: p.tags,
  }));
  if (!top.length) return;
  searching = true; opinion = null; opinionOpen = true;
  opinionPickNo = evaluation.position.pickNo;
  render();
  try {
    opinion = await secondOpinion({
      authMode: state.settings.authMode,
      apiKey: getApiKey(),
      proxyUrl: state.settings.proxyUrl,
      passphrase: getPassphrase(),
      model: state.settings.model,
      candidates: top,
      round: evaluation.position.round,
    });
  } catch (err) {
    opinion = { text: null, error: err instanceof ClaudeError ? err.message : String(err) };
  } finally {
    searching = false; render();
  }
}

function opinionPanel() {
  if (searching) {
    return el('div', { class: 'second-opinion' },
      el('p', { class: 'muted' }, 'Searching the web — this takes a few seconds…'));
  }
  if (!opinion) return null;
  if (opinion.error) {
    return el('div', { class: 'second-opinion' },
      el('p', { class: 'warn-inline' }, `Second opinion failed: ${opinion.error}`));
  }
  // Collapsible, and it remembers its own state across re-renders — the panel
  // re-renders on every board change, and a <details> that silently reopened
  // each time would be worse than not collapsing at all.
  return el('details', {
    class: 'second-opinion',
    open: opinionOpen,
    ontoggle: (e) => { opinionOpen = e.target.open; },
  },
    el('summary', { class: 'opinion-summary' },
      el('span', { class: 'opinion-title' }, 'Second opinion'),
      el('span', { class: 'muted small' },
        `${opinion.searches} search${opinion.searches === 1 ? '' : 'es'} · `
        + 'informational only'),
    ),
    el('div', { class: 'opinion-body' },
      ...prose(opinion.text),
      opinion.paused
        ? el('p', { class: 'warn-inline' },
            'The search stopped early, so this may be partial — press again for more.')
        : null),
  );
}

function badge(source) {
  const map = {
    claude: ['Claude', 'badge-claude'],
    deterministic: ['Deterministic fallback', 'badge-fallback'],
  };
  const [label, cls] = map[source] || ['—', ''];
  return el('span', { class: `badge ${cls}` }, label);
}

/**
 * Flag a Claude pick that is not the engine's top-ranked player.
 *
 * Overriding the engine is legitimate — Claude reads injury news and bust
 * consensus that no score captures. Overriding it *invisibly* is not: a live
 * practice draft took Josh Allen at 95 over Derrick Henry at 138 and nothing
 * on screen distinguished that from the engine's own answer. The user only
 * caught it by noticing Allen survived the round.
 *
 * Both numbers are already here, so the check costs nothing and cannot be
 * skipped by a model that forgets to mention it.
 */
function overrideNote(rec, source, evaluation) {
  if (source !== 'claude' || !rec?.primary_pick) return null;
  const top = evaluation.ranked?.[0];
  if (!top || top.player.name === rec.primary_pick.name) return null;
  const chosen = evaluation.ranked.find((r) => r.player.name === rec.primary_pick.name);
  const gap = chosen ? Math.round(top.score - chosen.score) : null;
  return el('p', { class: 'warn-inline' },
    `Claude overrode the engine: it ranks ${top.player.name} (${top.player.pos}) first`
    + (gap != null ? `, ${gap} points ahead of ${rec.primary_pick.name}` : '')
    + '. Read the reasoning before accepting — take the engine\'s pick if the '
    + 'override is not justified by something the numbers cannot see.');
}

function pickCard(pick, evaluation, primary) {
  const player = evaluation.ranked.find((r) => r.player.name === pick.name)?.player;
  return el('div', { class: 'rec-card' + (primary ? ' rec-primary' : '') },
    el('div', { class: 'rec-head' },
      el('span', { class: 'rec-name' }, pick.name),
      el('span', { class: `tag pos pos-${pick.position}` }, pick.position),
      player?.tier != null ? el('span', { class: 'tag tier' }, `T${player.tier}`) : null,
      player?.bye != null ? el('span', { class: 'tag' }, `Bye ${player.bye}`) : null,
    ),
    el('p', { class: 'rec-reason' }, pick.reason),
    player
      ? el('button', {
          class: 'btn small',
          onclick: () => {
            if (!confirmDraft(player)) return;
            const res = draftPlayer(player.id);
            if (!res.ok) alert(res.error);
            else { result = null; render(); }
          },
        }, `Draft ${pick.name} \u2192 ${draftTarget().who}`)
      : el('span', { class: 'warn-inline' }, 'Not found on the board — do not draft.'),
  );
}

function boardSignals(evaluation) {
  const cliffs = Object.entries(evaluation.cliffs)
    .filter(([, c]) => c && c.isCliff)
    .map(([pos, c]) => el('li', {}, el('strong', {}, pos), ` tier ${c.tier} — only ${c.remaining} left`));
  const runs = evaluation.runs.runs.map((r) =>
    el('li', {}, el('strong', {}, r.pos), ` run — ${r.count} of the last ${evaluation.runs.window} picks`));

  if (!cliffs.length && !runs.length) return null;
  return el('div', { class: 'signals' },
    el('h3', {}, 'Board signals'),
    el('ul', {}, [...cliffs, ...runs]),
  );
}

function render() {
  if (!root) return;

  const available = availablePlayers();
  if (!state.pool.length) {
    mount(root, el('h2', {}, 'Recommendation'),
      el('p', { class: 'empty' }, 'Load a player pool first.'));
    return;
  }

  const evaluation = evaluate(state, available);
  const pos = evaluation.position;

  // A second opinion is about ONE pick: it names players and quotes news for
  // the board as it stood. Once a pick is made the board has moved and that
  // advice is stale, so it is dropped rather than left on screen looking
  // current. Keyed on pick number, so it clears no matter where the pick came
  // from -- this panel, the board, the mock runner, or an undo.
  if (opinion && opinionPickNo !== pos.pickNo) { opinion = null; opinionPickNo = null; }

  if (pos.complete) {
    mount(root, el('h2', {}, 'Recommendation'),
      el('p', { class: 'empty' }, 'Draft complete. Nice work.'));
    return;
  }

  const shown = result?.rec || deterministicPick(evaluation);
  const source = result?.source || 'deterministic';

  const cost = result?.usage ? estimateCost(result.usage, result.model) : null;

  mount(root,
    el('div', { class: 'rec-top' },
      el('h2', {}, 'Recommendation'),
      badge(source),
    ),

    pos.isMyPick
      ? el('p', { class: 'on-clock' }, `You are on the clock — pick ${pos.pickNo}, round ${pos.round}.`)
      : el('p', { class: 'muted' },
          `Team ${pos.slotOnClock} is on the clock. ` +
          (pos.picksUntilMyTurn != null ? `${pos.picksUntilMyTurn} pick(s) until your turn.` : '')),

    el('button', {
      class: 'btn primary',
      disabled: busy,
      onclick: () => confirmThenAsk(evaluation, available),
    }, busy ? 'Asking Claude…' : (isCurrent() ? 'Ask Claude again' : 'Ask Claude')),

    // Separate button, and deliberately not the primary one: the fast path is
    // Ask Claude, and this is the slow path you take when you have time.
    pos.isMyPick
      ? el('button', {
          class: 'btn subtle',
          disabled: searching,
          title: 'Search the web for rankings and news that disagree with the board. '
            + 'Takes several seconds — use it when you are not against the clock.',
          onclick: () => askSecondOpinion(evaluation),
        }, searching ? 'Searching…' : 'Second opinion (web search)')
      : null,

    result?.note ? el('p', { class: 'warn-inline' }, result.note) : null,
    overrideNote(result?.rec, source, evaluation),
    opinionPanel(),

    shown ? pickCard(shown.primary_pick, evaluation, true) : null,
    shown?.alternatives?.length
      ? el('div', { class: 'alts' },
          el('h3', {}, 'Alternatives'),
          shown.alternatives.map((a) => pickCard(a, evaluation, false)),
        )
      : null,
    // Why this pick, from the three inputs that would otherwise be invisible:
    // who drafts before your next turn, and your own strategy document. Shown
    // above the general advice because on the clock they are the actionable
    // half — "Rob K. takes a TE around now" changes what you do in ten seconds.
    shown?.timing_note
      ? el('div', { class: 'advice' },
          el('h3', {}, 'Timing', shown.confidence
            ? el('span', { class: `conf conf-${shown.confidence}` }, shown.confidence)
            : null),
          el('p', {}, shown.timing_note))
      : null,
    shown?.strategy_note
      ? el('div', { class: 'advice' },
          el('h3', {}, 'Against your strategy doc'), el('p', {}, shown.strategy_note))
      : null,
    shown?.positional_advice
      ? el('div', { class: 'advice' }, el('h3', {}, 'Next two turns'), el('p', {}, shown.positional_advice))
      : null,

    boardSignals(evaluation),

    cost
      ? el('p', { class: 'cost' },
          `~$${cost.cost.toFixed(4)} · ${cost.freshIn} fresh in / ${cost.cachedIn} cached in / ${cost.out} out`)
      : null,
  );
}

/**
 * True when a real Claude answer is already on screen for THIS pick.
 *
 * `result` is cleared by the rerender callback on any state change — a pick,
 * an undo, a settings edit — so its mere presence means nothing has moved
 * since the answer came back. A deterministic fallback does not count: if the
 * API failed, retrying is exactly what you want, not something to talk you out of.
 */
function isCurrent() {
  return !busy && result?.source === 'claude' && !!result.rec && !result.degraded;
}

/**
 * Guard against re-asking by reflex. Each call costs real money and roughly
 * ten seconds of a sixty-second clock, and the second answer is usually the
 * first answer again — nothing has changed to make it differ.
 */
function confirmThenAsk(evaluation, available) {
  if (isCurrent()) {
    const pick = result.rec?.primary_pick;
    const spent = estimateCost(result.usage, result.model);
    const lines = [
      'Claude has already answered for this pick.',
      pick ? `\nCurrent recommendation: ${pick.name} (${pick.position}).` : '',
      '\nNothing has changed since, so the answer will almost certainly be the same.',
      spent ? ` Asking again costs about $${spent.cost.toFixed(3)} and a few seconds.` : '',
      '\n\nAsk again anyway?',
    ].filter(Boolean).join('');
    if (!confirm(lines)) return;
  }
  askClaude(evaluation, available);
}

async function askClaude(evaluation, available) {
  if (busy) return;
  const { authMode, proxyUrl } = state.settings;
  const viaProxy = authMode === 'proxy';
  const apiKey = getApiKey();
  const passphrase = getPassphrase();
  const evidence = buildEvidence(state, available, evaluation);

  const missing = viaProxy
    ? (!proxyUrl ? 'No Worker URL set' : !passphrase ? 'No passphrase set' : null)
    : (!apiKey ? 'No API key set' : null);

  if (missing) {
    result = {
      rec: deterministicPick(evaluation),
      source: 'deterministic',
      note: `${missing} — showing the deterministic pick. Fix it under Setup → Claude.`,
    };
    render();
    return;
  }

  busy = true;
  render();

  inflight = new AbortController();
  try {
    const { rec, usage, model } = await recommend({
      authMode,
      apiKey,
      proxyUrl,
      passphrase,
      model: state.settings.model,
      effort: state.settings.effort,
      evidence,
      strategyText: state.strategyText,
      signal: inflight.signal,
    });

    const check = validateRecommendation(rec, evidence.availablePlayerAllowlist);
    if (!check.ok) {
      // A model naming a drafted player is a hard failure — fall back rather
      // than render something that could cost a pick.
      result = {
        rec: deterministicPick(evaluation),
        source: 'deterministic',
        note: `Claude's answer failed validation (${check.errors[0]}) — showing the deterministic pick.`,
      };
    } else {
      // A sound pick can arrive with filler in the surrounding prose. Keep the
      // pick, say so, and blank the unwritten fields — rendering the literal
      // word "placeholder" at someone on a sixty-second clock is worse than
      // showing nothing there.
      for (const f of check.unwrittenFields || []) {
        const m = f.match(/^alternatives\[(\d+)\]\.reason$/);
        if (m) rec.alternatives[Number(m[1])].reason = '';
        else rec[f] = '';
      }
      result = {
        rec, source: 'claude', usage, model,
        note: check.warnings?.length
          ? `${check.warnings[0]} The pick itself is sound — "Ask Claude again" to retry the rest.`
          : null,
        degraded: !!check.warnings?.length,
      };
    }
  } catch (err) {
    const msg = err instanceof ClaudeError
      ? { 'no-key': 'No credential set.', 'no-proxy': 'No Worker URL set.',
          auth: 'API key rejected.', 'bad-passphrase': 'Worker rejected the passphrase.',
          forbidden: 'Worker refused this origin or model.',
          'rate-limit': 'Rate limited.', network: 'Network unreachable.',
          refusal: 'Model declined.', truncated: 'Response truncated.',
        }[err.kind] || err.message
      : err.message;
    result = {
      rec: deterministicPick(evaluation),
      source: 'deterministic',
      note: `${msg} Showing the deterministic pick — the draft is unaffected.`,
    };
  } finally {
    busy = false;
    inflight = null;
    render();
  }
}

export function initRecs(container) {
  root = container;
  render();
  return () => { result = null; render(); };
}
