// Recommendation panel. Always shows the deterministic pick immediately;
// Claude's answer replaces it only after passing schema + allowlist checks.

import { el, mount } from './dom.js';
import { state, availablePlayers, getApiKey, getPassphrase, draftPlayer } from '../state.js';
import { evaluate, deterministicPick, buildEvidence } from '../engine.js';
import { recommend, validateRecommendation, estimateCost, ClaudeError } from '../claude.js';
import { confirmDraft, draftTarget } from './draft-prompt.js';

let root = null;
let busy = false;
let result = null;     // { rec, source, note, usage, model }
let inflight = null;

function badge(source) {
  const map = {
    claude: ['Claude', 'badge-claude'],
    deterministic: ['Deterministic fallback', 'badge-fallback'],
  };
  const [label, cls] = map[source] || ['—', ''];
  return el('span', { class: `badge ${cls}` }, label);
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
      onclick: () => askClaude(evaluation, available),
    }, busy ? 'Asking Claude…' : 'Ask Claude'),

    result?.note ? el('p', { class: 'warn-inline' }, result.note) : null,

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
      result = { rec, source: 'claude', usage, model, note: null };
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
