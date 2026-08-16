// Anthropic API client for the recommendation call.
//
// Bring-your-own-key, called directly from the browser. Anthropic enabled CORS
// for the JSON API in Aug 2024 behind an explicitly-named "dangerous" header —
// dangerous because the key is visible to anyone with access to this browser.
// Acceptable for a private single-user tool; not for anything shared.

import { API_URL, API_VERSION } from './config.js';

// Structured output schema. Every object closed (additionalProperties: false)
// with all fields required, so the response shape is guaranteed rather than
// requested. This replaces the older forced-tool-call trick.
export const RECOMMENDATION_SCHEMA = {
  type: 'object',
  properties: {
    primary_pick: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Must be copied verbatim from availablePlayerAllowlist.' },
        position: { type: 'string', enum: ['QB', 'RB', 'WR', 'TE', 'DST', 'K'] },
        reason: { type: 'string', description: 'Two or three sentences. Cite value, tier, scarcity, or ADP.' },
      },
      required: ['name', 'position', 'reason'],
      additionalProperties: false,
    },
    alternatives: {
      type: 'array',
      description: 'Two or three other defensible picks, best first.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          position: { type: 'string', enum: ['QB', 'RB', 'WR', 'TE', 'DST', 'K'] },
          reason: { type: 'string' },
        },
        required: ['name', 'position', 'reason'],
        additionalProperties: false,
      },
    },
    positional_advice: {
      type: 'string',
      description: 'One short paragraph on what to target over the next two turns.',
    },
  },
  required: ['primary_pick', 'alternatives', 'positional_advice'],
  additionalProperties: false,
};

// Static across every call in a draft — the cacheable half of the prefix.
const STRATEGY = `You are a fantasy football draft assistant working a live snake draft. You will receive a JSON evidence packet describing the league, the user's roster, and the top available players. Recommend exactly one pick, plus alternatives.

VALUE OVER REPLACEMENT (VBD)
A player's value is not his raw point total. It is how far he outscores the last startable player at his position given league size and roster settings — the replacement level. This is why elite RBs and elite TEs generate more surplus value than elite QBs despite lower raw scoring: the drop-off below them is steeper. The evidence packet gives you a precomputed \`value\` per player and the replacement level per position. Trust those numbers; do not recompute them from rank.

POSITIONAL SCARCITY
RB and elite TE fall off a cliff quickly and should be prioritized. QB and WR are deep — good starters last well past where raw projections suggest, so reaching for them early burns surplus value. DST and K are fungible and belong in the final two rounds only; never recommend them earlier.

TIER CLIFFS
Players are grouped into tiers of roughly interchangeable value. What matters is how many remain in the current tier at a position. If a tier is about to empty, that position becomes urgent — the next player available there is a meaningful step down. If many remain, you can comfortably wait and take value elsewhere. The packet gives you tier counts per position; use them.

ROSTER CONSTRUCTION, ROUND-SENSITIVE
Early rounds: take the best value available, close to position-agnostic. A common half-PPR baseline is two RBs through the first three rounds and then attacking WR value; Hero-RB (one elite RB, then hammer WR) is a defensible alternative. Middle rounds: balance value against unfilled starter slots. Late rounds: fill required starters, then handcuffs and upside. Weight roster need more heavily as the draft progresses — early is best-available, late is fill-the-holes.

ADP VALUE
ADP is the market price. A player still on the board well past his ADP is falling and represents surplus. A player you would have to take well ahead of his ADP is a reach unless a tier cliff or a positional run justifies it.

POSITION RUNS
When several teams take the same position in quick succession, the remaining supply thins fast. A run at a position you need is a reason to move up your timeline for it. A run at a position you do not need is a reason to let it pass and take the value it pushes down to you.

PICK TIMING
Account for how many picks elapse before the user's next turn. A player who will plainly survive that gap can wait; a player who will not, cannot.

INJURY AND NEWS
Some players carry an \`injury\` field or \`recentNews\` entries. These are the only current information in the packet — the rankings themselves are a static snapshot and do not reflect them. Weigh them: a player whose rank predates a serious injury is overvalued by his own ranking, and a designation like "questionable" or a missed practice is a real risk on a player you would otherwise reach for. Say so explicitly when it changes your recommendation. Absence of an injury field means no news was loaded for that player, NOT that he is confirmed healthy — never state or imply that a player is healthy.

HARD RULES
1. You may only name players that appear in \`availablePlayerAllowlist\`. Copy names verbatim. Never name a player who is not on that list — they are already drafted.
2. Never recommend DST or K before the final two rounds.
3. Give concrete reasons grounded in the numbers you were given — value, tier counts, ADP gaps, replacement levels, and any injury or news fields present. Do not invent statistics, injury news, or projections that are not in the packet.
4. Be concise. Two or three sentences per reason.`;

function leagueContext(evidence) {
  const l = evidence.league;
  const lineup = Object.entries(l.startingLineup).map(([k, v]) => `${v}${k}`).join(', ');
  const levels = Object.entries(l.replacementLevels).map(([k, v]) => `${k}${v}`).join(', ');
  const valueNote = l.valueMode === 'projections'
    ? 'The `value` field is true VORP computed from projected points.'
    : 'The `value` field is a rank-based surrogate for VORP — no projections were loaded. Treat it as an ordering signal, not a point total.';
  return `THIS LEAGUE
${l.teams} teams, ${l.scoring}, ${l.rounds} rounds. The user drafts from slot ${l.yourSlot}.
Starting lineup: ${lineup}, plus ${l.bench} bench.
Replacement levels for this league: ${levels}.
${valueNote}`;
}

export class ClaudeError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

/**
 * Ask Claude for a recommendation. Throws ClaudeError on any failure so the
 * caller can fall through to the deterministic pick.
 */
export async function recommend({
  authMode = 'direct', apiKey, proxyUrl, passphrase,
  model, effort, evidence, signal,
}) {
  const viaProxy = authMode === 'proxy';

  if (viaProxy) {
    if (!proxyUrl) throw new ClaudeError('No Worker URL set.', 'no-proxy');
    if (!passphrase) throw new ClaudeError('No passphrase set.', 'no-key');
  } else if (!apiKey) {
    throw new ClaudeError('No API key set.', 'no-key');
  }

  const url = viaProxy ? proxyUrl : API_URL;
  // In proxy mode the key lives in the Worker; the browser never sees it, and
  // the dangerous-direct-browser-access header is neither needed nor sent.
  const headers = viaProxy
    ? { 'content-type': 'application/json', 'x-app-passphrase': passphrase }
    : {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      };

  const body = {
    model,
    max_tokens: 8000, // thinking counts toward this cap on Opus 5 — leave room
    system: [
      { type: 'text', text: STRATEGY },
      // Stable for the whole draft, so the prefix caches. Volatile per-pick
      // content goes in the user turn, after the breakpoint.
      { type: 'text', text: leagueContext(evidence), cache_control: { type: 'ephemeral' } },
    ],
    output_config: {
      effort,
      format: { type: 'json_schema', schema: RECOMMENDATION_SCHEMA },
    },
    messages: [{
      role: 'user',
      content: `Here is the current board. Recommend my pick.\n\n${JSON.stringify(evidence, null, 1)}`,
    }],
  };

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new ClaudeError('Request cancelled.', 'aborted');
    throw new ClaudeError(
      viaProxy ? `Could not reach the Worker: ${err.message}` : `Network error: ${err.message}`,
      'network'
    );
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const errBody = await res.json();
      if (errBody?.error?.message) detail = errBody.error.message;
    } catch { /* non-JSON error body */ }
    // A 401 from the Worker means the passphrase is wrong, not the API key —
    // saying "API key rejected" would send you debugging the wrong secret.
    const kind = res.status === 401 ? (viaProxy ? 'bad-passphrase' : 'auth')
      : res.status === 403 ? 'forbidden'
      : res.status === 429 ? 'rate-limit' : 'http';
    throw new ClaudeError(detail, kind);
  }

  const data = await res.json();

  // Check stop_reason before reading content — a refusal returns HTTP 200
  // with empty or partial content, and indexing content[0] would throw.
  if (data.stop_reason === 'refusal') {
    throw new ClaudeError('Model declined the request.', 'refusal');
  }
  if (data.stop_reason === 'max_tokens') {
    throw new ClaudeError('Response hit the token cap before finishing.', 'truncated');
  }

  const text = (data.content || []).find((b) => b.type === 'text')?.text;
  if (!text) throw new ClaudeError('Empty response from the API.', 'empty');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ClaudeError('Response was not valid JSON.', 'parse');
  }

  return { rec: parsed, usage: data.usage || null, model: data.model || model };
}

/**
 * Validate shape, then enforce the allowlist. A drafted player named by the
 * model is a hard failure, not something to paper over.
 */
export function validateRecommendation(rec, allowlist) {
  const errors = [];
  const allowed = new Set(allowlist);

  const checkPick = (p, label) => {
    if (!p || typeof p !== 'object') { errors.push(`${label}: missing.`); return; }
    if (typeof p.name !== 'string' || !p.name) errors.push(`${label}: missing name.`);
    else if (!allowed.has(p.name)) errors.push(`${label}: "${p.name}" is not an available player.`);
    if (typeof p.reason !== 'string' || !p.reason) errors.push(`${label}: missing reason.`);
  };

  checkPick(rec?.primary_pick, 'primary_pick');

  if (!Array.isArray(rec?.alternatives)) {
    errors.push('alternatives: not an array.');
  } else {
    rec.alternatives.forEach((a, i) => checkPick(a, `alternatives[${i}]`));
  }

  if (typeof rec?.positional_advice !== 'string') errors.push('positional_advice: missing.');

  return { ok: errors.length === 0, errors };
}

/** Rough spend for one call, in USD. */
export function estimateCost(usage, model) {
  if (!usage) return null;
  const prices = {
    'claude-opus-5': [5, 25],
    'claude-sonnet-5': [3, 15],
    'claude-haiku-4-5': [1, 5],
  }[model] || [5, 25];
  const cachedIn = usage.cache_read_input_tokens || 0;
  const writeIn = usage.cache_creation_input_tokens || 0;
  const freshIn = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  const cost =
    (freshIn * prices[0] + writeIn * prices[0] * 1.25 + cachedIn * prices[0] * 0.1 + out * prices[1]) / 1e6;
  return { cost, cachedIn, freshIn, out };
}
