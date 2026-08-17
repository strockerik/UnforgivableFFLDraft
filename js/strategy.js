// Parse and apply the hand-authored strategy document (data/strategy.md).
//
// The document has two halves that are treated very differently:
//
//   PART 1 — durable strategy prose. Goes into the cached system prompt, so it
//            shapes every recommendation and costs ~10% after the first call.
//   PART 2 — a JSON block of per-player tags. Merged onto player records as
//            DATA, not prompt text. That matters: a tag attached to a player
//            disappears from consideration the moment he is drafted, because
//            the allowlist is built from available players. The same claim
//            written into the prompt would keep suggesting someone already
//            off the board.

const ALLOWED_TAGS = new Set([
  'sleeper', 'bust', 'breakout', 'injury-risk', 'handcuff',
  'committee-risk', 'volume-king', 'schedule-boost', 'rookie-uncertainty',
]);

const MAX_NOTE = 200;

/** Same normalization the player merge uses, so joins behave identically. */
const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);
export function nameKey(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !SUFFIXES.has(t))
    .join('');
}

/**
 * Split the document into prose and tag data.
 * Returns { strategyText, tags, warnings }.
 */
export function parseStrategyDoc(text) {
  const warnings = [];
  if (!text || !text.trim()) return { strategyText: '', tags: [], warnings: ['Empty document.'] };

  const fence = text.match(/```json\s*([\s\S]*?)```/);
  const strategyText = (fence ? text.slice(0, fence.index) : text).trim();

  let tags = [];
  if (!fence) {
    warnings.push('No ```json block found — strategy prose loaded, but no player tags.');
  } else {
    let parsed;
    try {
      parsed = JSON.parse(fence[1]);
    } catch (err) {
      warnings.push(`Player-tag JSON is invalid (${err.message}) — prose loaded, tags skipped.`);
      return { strategyText, tags: [], warnings };
    }
    const list = Array.isArray(parsed) ? parsed : parsed.players;
    if (!Array.isArray(list)) {
      warnings.push('JSON block has no players array — tags skipped.');
    } else {
      for (const t of list) {
        if (!t || !t.name || !t.pos) {
          warnings.push(`Tag entry missing name or pos — skipped: ${JSON.stringify(t).slice(0, 60)}`);
          continue;
        }
        const clean = (t.tags || []).filter((x) => ALLOWED_TAGS.has(x));
        const dropped = (t.tags || []).filter((x) => !ALLOWED_TAGS.has(x));
        if (dropped.length) warnings.push(`${t.name}: unrecognized tag(s) ignored — ${dropped.join(', ')}`);
        tags.push({
          name: String(t.name).trim(),
          pos: String(t.pos).toUpperCase(),
          team: t.team ? String(t.team).toUpperCase() : null,
          tags: clean,
          confidence: t.confidence || null,
          note: t.note ? String(t.note).slice(0, MAX_NOTE) : null,
          asOf: t.asOf || null,
        });
      }
    }
  }

  return { strategyText, tags, warnings };
}

/**
 * Attach tags to pool players. Joins on name+team, then name+pos, then a
 * unique name. Every unmatched entry is reported — a tag that silently fails
 * to attach is worse than no tag, because you believe it is working.
 */
export function applyTags(pool, tags) {
  const byNameTeam = new Map();
  const byNamePos = new Map();
  const byName = new Map();
  for (const p of pool) {
    const k = nameKey(p.name);
    if (p.team) byNameTeam.set(`${k}|${p.team}`, p);
    byNamePos.set(`${k}|${p.pos}`, p);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p);
    // A reload should replace tags, not accumulate them.
    delete p.tags;
    delete p.tagNote;
    delete p.tagConfidence;
  }

  let matched = 0;
  const unmatched = [];
  for (const t of tags) {
    const k = nameKey(t.name);
    let target = (t.team && byNameTeam.get(`${k}|${t.team}`)) || byNamePos.get(`${k}|${t.pos}`);
    if (!target) {
      const cands = byName.get(k) || [];
      if (cands.length === 1) target = cands[0];
    }
    if (!target) { unmatched.push(t); continue; }
    target.tags = t.tags;
    target.tagNote = t.note;
    target.tagConfidence = t.confidence;
    matched++;
  }

  return { matched, unmatched };
}
