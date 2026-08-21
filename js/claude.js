// Anthropic API client for the recommendation call.
//
// Bring-your-own-key, called directly from the browser. Anthropic enabled CORS
// for the JSON API in Aug 2024 behind an explicitly-named "dangerous" header —
// dangerous because the key is visible to anyone with access to this browser.
// Acceptable for a private single-user tool; not for anything shared.

import { API_URL, API_VERSION, modelSupportsEffort } from './config.js';

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
    // These three exist so the recommendation shows its work. Without them the
    // opponent model, the league's market quirks and the user's own strategy
    // document all feed the answer invisibly, and there is no way to tell a
    // well-reasoned pick from a lucky one -- or to notice when the model has
    // quietly ignored the strategy document entirely.
    timing_note: {
      type: 'string',
      description: 'One or two sentences: given who picks before the user\'s next turn and how '
        + 'this league drafts versus ADP, what will not survive the wait and what will. '
        + 'Name the coaches whose habits drive it. If nothing is at risk, say the user can wait.',
    },
    strategy_note: {
      type: 'string',
      description: 'One or two sentences on how this pick sits with the user\'s own strategy '
        + 'document and any tags on the player. If the document is silent on this situation, '
        + 'say so plainly rather than inventing agreement. If the pick CONTRADICTS the document, '
        + 'say that explicitly and why it is still right.',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'high = clear value gap or hard scarcity; medium = close call between named '
        + 'alternatives; low = coin flip, or key information is missing or stale.',
    },
  },
  required: ['primary_pick', 'alternatives', 'positional_advice',
    'timing_note', 'strategy_note', 'confidence'],
  additionalProperties: false,
};

// Static across every call in a draft — the cacheable half of the prefix.
const STRATEGY = `You are a fantasy football draft assistant working a live snake draft. You will receive a JSON evidence packet describing the league, the user's roster, and the top available players. Recommend exactly one pick, plus alternatives.

VALUE OVER REPLACEMENT (VBD)
A player's value is not his raw point total. It is how far he outscores the last startable player at his position given league size and roster settings — the replacement level. This is why elite RBs and elite TEs generate more surplus value than elite QBs despite lower raw scoring: the drop-off below them is steeper. The evidence packet gives you a precomputed \`value\` per player and the replacement level per position. Trust those numbers; do not recompute them from rank.

POSITIONAL SCARCITY
RB and elite TE fall off a cliff quickly and should be prioritized. QB and WR are deep — good starters last well past where raw projections suggest, so reaching for them early burns surplus value. DST and K are fungible and belong in the final two rounds only; never recommend them earlier.

TIER CLIFFS AND POSITIONAL URGENCY
Do not reason about urgency from tier counts. A tier is a grouping convention, and the boundaries are frequently jumbled -- at one live pick the worst player in WR tier 1 graded BELOW the best in tier 2, so the position read as "no cliff" at the exact moment three elite receivers were about to disappear.
The real question is what waiting costs. \`attritionBeforeYourNextPick\` answers it per position by simulating the picks that will actually happen before the user is next on the clock: \`bestNow\`, \`bestSurviving\`, and \`costOfWaiting\` between them. A position whose best player survives costs nothing to postpone however thin its tier looks. A position losing 45 points is urgent even with no tier boundary in sight.
Compare that cost against the value you would give up by taking the lesser player now, and cite both numbers when they drive the pick. Remember this is a serpentine draft: at the turn the window can be ZERO picks, in which case nothing can be sniped and the right move is simply the best player available. Tier counts remain in the packet as context for how thin a position is, not as a reason to act.

ROSTER CONSTRUCTION, ROUND-SENSITIVE
Early rounds: take the best value available, close to position-agnostic. A common half-PPR baseline is two RBs through the first three rounds and then attacking WR value; Hero-RB (one elite RB, then hammer WR) is a defensible alternative. Middle rounds: balance value against unfilled starter slots. Late rounds: fill required starters, then handcuffs and upside. Weight roster need more heavily as the draft progresses — early is best-available, late is fill-the-holes.

ADP VALUE
ADP is the market price. A player still on the board well past his ADP is falling and represents surplus. A player you would have to take well ahead of his ADP is a reach unless a tier cliff or a positional run justifies it.

POSITION RUNS
When several teams take the same position in quick succession, the remaining supply thins fast. A run at a position you need is a reason to move up your timeline for it. A run at a position you do not need is a reason to let it pass and take the value it pushes down to you.

PICK TIMING
Account for how many picks elapse before the user's next turn. A player who will plainly survive that gap can wait; a player who will not, cannot.

THE USER'S ORDER OF OPERATIONS
This is his stated core strategy. Follow it unless the board makes it clearly wrong, and say so explicitly when you deviate.
1. Fill the eight skill starters first — QB, RB, RB, WR, WR, WR, TE, FLEX. Best available by value, but every pick should be moving toward a filled starting lineup.
2. Then build the bench with high-value players. "High value" means genuinely above replacement, and it means DEPTH WHERE IT MATTERS, not more of what he already has. Two rules follow from that:
   - A bench player at or below replacement value is a wasted pick. If the best available skill player grades negative, that is the moment to consider a handcuff, an upside swing, or the scarcer position — not another body at a position already stacked.
   - Bench slots should be weighted toward RB. In a league starting RB2 plus a FLEX, RB is the position where an injury forces a replacement-level start, and the RB pool is thinnest. A fourth TE or a sixth WR cannot enter the lineup in any week that a missing RB would.
3. Kicker and defence in the last two rounds only. Never earlier, whatever their computed value says — that number is not comparable to a skill player's because both positions are streamed week to week.

UPSIDE QUOTA
The user wants at least one genuine lottery ticket on his bench. Players carrying a "sleeper" tag from his strategy document qualify. Once his starting lineup is full, prefer a tagged sleeper over an interchangeable replacement-level body, and say in the timing note that you are doing so. The reasoning is that VORP measures EXPECTED points, which is the wrong statistic for a bench slot — a replacement-level backup contributes nearly nothing in any week, so a high-variance player with a small chance of becoming a starter is worth more than his projection suggests. This never applies to a starting slot, never to a kicker or defence, and never justifies a materially worse roster: it is worth giving up roughly 25 points of value for, not 60. If he already holds a sleeper, stop applying it.

BYE WEEKS
The packet lists each roster player's bye and any collisions among starters. Two starters sharing a bye is normal and not worth acting on — eight skill starters across a dozen bye weeks makes it unavoidable. Three is worth breaking a tie over, and four is a week already lost. Treat this as a tie-breaker ONLY: the user would rather have three great players sharing a bye than two great players and one average one spread across two weeks, and that ordering is deliberate. Never recommend a materially worse player to avoid a collision; do mention the collision when you are choosing between similar players.

BYE INSURANCE AT SINGLE-SLOT POSITIONS
The user starts one QB and one TE. If he holds only one of either and that starter has a bye, the slot is a guaranteed zero that week and no receiver can fill it, however many points the receiver projects. Once the starting lineup is full, prefer the first backup at such a position over a replacement-level body at a position already stacked — provided the backup's bye DIFFERS from the starter's, since a shared bye covers nothing. This applies to TE. It does NOT apply to QB: the strategy document says an elite QB needs no second, and a one-week quarterback hole is the easiest in fantasy to stream. Never take a backup over a genuine starter.

ROSTER CAPS — HARD LIMITS
Never recommend a player who would exceed these: QB 2, TE 2, DST 1, K 1. There is deliberately NO cap on RB or WR — those are where depth belongs, because both are FLEX-eligible and both suffer injuries that force a start.
A third QB or third TE cannot enter the lineup in any week of the season, so his value is exactly zero no matter what number the board shows. If the evidence packet still lists one as the highest-value player available, that means every remaining option is poor — recommend the best RB or WR instead and say plainly that the alternatives are all below replacement. The deterministic engine enforces these caps, so recommending past them guarantees your pick is overridden.

COMPARING ACROSS POSITIONS
Value is measured against each position's OWN replacement level, and those levels sit at very different point totals in this league — the replacement RB projects far more raw points than the replacement TE. Two players showing the same value therefore do NOT score the same in a FLEX slot. When the choice is for a FLEX or a bench spot, prefer the player with the higher raw projection; when it is for a dedicated positional slot, use value.

THIS LEAGUE'S MARKET
Ten seasons of this league's own drafts (all live, in person) show where it systematically departs from national ADP. These are league-wide facts, not one opponent's habit, and they hold every year:
- QUARTERBACKS GO EARLY HERE, in a narrow window. By the end of round 3 this league has taken 3 QBs where national ADP predicts 1; by round 5 it is 5.5 versus 2. Then it stops — ten teams need ten starters and by round 9 everyone has one. National ADP implies a startable QB survives to round 7-8; in this league that is false. The QB window effectively closes in rounds 5-6. This compounds with the league's 6-point passing TDs, which already raise QB value above what the rankings assume.
- RUNNING BACKS LAST LONGER HERE. At the end of round 2 the market expects 12 RBs gone; this league averages 8.8. Expect roughly three more RBs on the board than an ADP-sorted list predicts through the early rounds.
- KICKERS AND DEFENCES GO EARLY HERE. By end of round 12 this league has taken 3.5 Ks and 6.8 DSTs against a market expectation of 1 and 3 — roughly ten picks spent on fungible positions while real players remain. Never follow them. Waiting until the final two rounds for K and DST is a standing edge in this league, not a preference.
Use these to adjust TIMING against ADP. They do not change any player's value.

KNOWN OPPONENTS
\`opponentsBeforeYourNextPick\` lists the coaches actually on the clock before the user picks again, with habits drawn from four seasons of this league's drafts. Every one of those drafts was live and in person — there is no autodraft here — so a habit marked "never varies" is a real, repeated human pattern, not noise. \`positionsLikelyGoneBeforeYourNextPick\` counts how many of those coaches have a reliable habit of taking each position by this round.
\`picksBeforeYourNextTurn\` is the exact number of picks that will be made before the user is back on the clock, and \`opponentsBeforeYourNextPick\` is the COMPLETE list of them — never assume an extra unlisted pick. N picks remove exactly N players, no more: two upcoming picks by one coach with both a WR and an RB habit means two players total, not one of each. At a turn this number is often as small as 1 or 2.
When the user picks twice in quick succession, the question is not which player is likeliest to be taken — it is which LOSS costs more. Compare each candidate against the best player at his position who would still be there next turn. A quarterback whose replacement is 48 points worse should be protected ahead of a receiver whose replacement is 10 points worse, even when the receiver is far likelier to go. Say this explicitly in the timing note when it applies.
A habit is what a coach LIKES, not a forecast. Each entry carries \`alreadyDrafted\` — what he has taken this year by position and what he still needs — and that OVERRIDES the habit whenever the two disagree. A coach with a decade-long receiver habit who already holds three receivers and still needs a QB, an RB and a TE is not about to take a fourth receiver; his habit is a want he has already satisfied. Read the habit as "what he reaches for when the slot is open", then check whether the slot is still open. Say which one you are relying on.
Use this for TIMING ONLY. It changes whether the user can afford to wait on a position, never which player is better. Concretely: if the user wants a position that two upcoming coaches reliably take by this round, taking it now is justified; if nobody upcoming has ever wanted it early, it can wait a round and the user should bank the better player instead. Never promote a lower-value player over a higher-value one on the strength of an opponent habit, and never claim a specific player will be taken by a specific coach — the habits are positional, not player-level. An empty list means no history for these names; fall back to ADP and runs.

EXPERT DISAGREEMENT
Each player may carry \`expertRankSpread\` — the gap between the most and least optimistic expert ranking him. This is NOT the same signal as a bust tag. A bust tag says analysts agree he is overpriced; a wide spread says they cannot agree at all, and the two flag different players. Median spread among draftable skill players is about 60; past roughly 100 the projection deserves real scepticism.
Use it to break ties and to size risk, never as a value adjustment. Between two similar players, prefer the tighter spread early when you are buying a floor, and consider the wider one late on a bench slot where variance is what you actually want. Say which way it cuts when it affects the pick. It is absent for kickers and defences by design, because their spread only reflects that most experts do not rank them.

TWO VALUATIONS
When projections are loaded, each player carries \`valueFromProjections\` (a statistical forecast of points above replacement) and \`valueFromConsensusRank\` (where 100+ experts rank him, converted to points), plus \`projectionVsConsensusGap\` between them. They answer different questions and neither is authoritative. A large positive gap means the forecast likes him more than the market does — potential value, or a projection that has not caught up to news. A large negative gap means the market likes him more than the forecast does — potential trap, or expert knowledge the model lacks. Call out a large gap when it bears on the pick, and say which way it cuts. When only \`value\` is present, no projections were loaded and it is the rank-based number alone.

INJURY AND NEWS
Some players carry an \`injury\` field or \`recentNews\` entries. These are the only current information in the packet — the rankings themselves are a static snapshot and do not reflect them. Weigh them: a player whose rank predates a serious injury is overvalued by his own ranking, and a designation like "questionable" or a missed practice is a real risk on a player you would otherwise reach for. Say so explicitly when it changes your recommendation. Absence of an injury field means no news was loaded for that player, NOT that he is confirmed healthy — never state or imply that a player is healthy.

HARD RULES
1. You may only name players that appear in \`availablePlayerAllowlist\`. Copy names verbatim. Never name a player who is not on that list — they are already drafted.
2. Never recommend DST or K before the final two rounds.
3. Give concrete reasons grounded in the numbers you were given — value, tier counts, ADP gaps, replacement levels, and any injury or news fields present. Do not invent statistics, injury news, or projections that are not in the packet.
4. Be concise. Two or three sentences per reason.`;

function userStrategyBlock(text) {
  return `THE USER'S OWN STRATEGY DOCUMENT
What follows was written for this specific league and reflects how the user wants to draft. Treat it as strong guidance about approach and preference.

Two limits on it. First, it is prose written ahead of the draft; the evidence packet is live. Where the document's general advice conflicts with the computed value, tier counts, or availability in the packet, the packet wins — say so briefly rather than silently picking one. Second, any player claim in it is dated commentary, not fact; the \`tags\` and \`tagNote\` fields already carry that per-player context onto the board, so do not name a player purely because this document mentions him.

--- BEGIN USER STRATEGY ---
${text}
--- END USER STRATEGY ---`;
}

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
  model, effort, evidence, strategyText, signal,
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
      // The user's own strategy document, when loaded. Static for the whole
      // draft, so it sits inside the cached prefix and costs ~10% per call
      // after the first.
      ...(strategyText ? [{ type: 'text', text: userStrategyBlock(strategyText) }] : []),
      // Stable for the whole draft, so the prefix caches. Volatile per-pick
      // content goes in the user turn, after the breakpoint.
      { type: 'text', text: leagueContext(evidence), cache_control: { type: 'ephemeral' } },
    ],
    output_config: {
      // Omitted entirely for models that reject it rather than ignore it.
      ...(modelSupportsEffort(model) ? { effort } : {}),
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
/**
 * Prose the model emitted to satisfy the schema rather than to say anything.
 *
 * Seen in a live draft: the model wrote nested JSON inside `primary_pick.reason`
 * — the field ended with `.',` — and then filled timing_note, strategy_note and
 * every alternative's reason with the literal string "placeholder". All of it
 * is schema-valid, so name-and-presence checks pass it straight through and the
 * panel renders "placeholder" four times on a live clock.
 */
const FILLER = /^\s*(placeholder|n\/?a|tbd|todo|none|\.\.\.|-+)\s*$/i;
const MIN_PROSE = 20;

function unwritten(s) {
  if (typeof s !== 'string') return true;
  const t = s.trim();
  return !t || FILLER.test(t) || t.length < MIN_PROSE;
}

/**
 * Validate a recommendation.
 *
 * Returns hard `errors` and soft `warnings`. The split matters: a model naming
 * a drafted player is unusable and must fall back, but a good primary pick
 * whose secondary prose came back as filler is still worth showing — throwing
 * away a correct pick because the timing note was junk would cost more than it
 * saves.
 */
export function validateRecommendation(rec, allowlist) {
  const errors = [];
  const warnings = [];
  const allowed = new Set(allowlist);

  const checkPick = (p, label) => {
    if (!p || typeof p !== 'object') { errors.push(`${label}: missing.`); return; }
    if (typeof p.name !== 'string' || !p.name) errors.push(`${label}: missing name.`);
    else if (!allowed.has(p.name)) errors.push(`${label}: "${p.name}" is not an available player.`);
    if (typeof p.reason !== 'string' || !p.reason) errors.push(`${label}: missing reason.`);
  };

  checkPick(rec?.primary_pick, 'primary_pick');
  // Filler in the PRIMARY reason is a hard failure — that is the one sentence
  // the whole recommendation rests on.
  if (rec?.primary_pick && unwritten(rec.primary_pick.reason)) {
    errors.push('primary_pick: reason is placeholder text, not a reason.');
  }

  if (!Array.isArray(rec?.alternatives)) {
    errors.push('alternatives: not an array.');
  } else {
    rec.alternatives.forEach((a, i) => checkPick(a, `alternatives[${i}]`));
  }

  if (typeof rec?.positional_advice !== 'string') errors.push('positional_advice: missing.');

  // Soft: the pick may still be right even when the surrounding prose is not
  // written. Name the fields so the UI can suppress them instead of rendering
  // the word "placeholder" at someone on a sixty-second clock.
  const soft = [];
  if (Array.isArray(rec?.alternatives)) {
    rec.alternatives.forEach((a, i) => {
      if (a && unwritten(a.reason)) soft.push(`alternatives[${i}].reason`);
    });
  }
  for (const f of ['positional_advice', 'timing_note', 'strategy_note']) {
    if (f in (rec || {}) && unwritten(rec[f])) soft.push(f);
  }
  if (soft.length) {
    warnings.push(`${soft.length} field(s) came back as placeholder text: ${soft.join(', ')}.`);
  }

  return { ok: errors.length === 0, errors, warnings, unwrittenFields: soft };
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
