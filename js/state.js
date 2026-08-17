// Single owner of all mutable draft state. Autosaves to namespaced
// localStorage on every change so a mid-draft refresh loses nothing.

import { KEYS, DEFAULT_SETTINGS } from './config.js';
import { slotOnClock } from './snake.js';
import { nameKey } from './players.js';

const UNDO_DEPTH = 30;

const listeners = new Set();
let undoStack = [];

export const state = {
  settings: { ...DEFAULT_SETTINGS },
  pool: [],
  valueMode: null,
  poolMeta: { label: null, isSample: false, loadedAt: null },
  warnings: [],
  strategyText: '',   // Part 1 of data/strategy.md, appended to the system prompt
  strategyMeta: null, // { matched, unmatched, loadedAt }
  picks: [],          // [{ pickNo, playerId, teamSlot }]
  lastRec: null,      // last recommendation rendered
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn(state);
}

// --- persistence ------------------------------------------------------------

function save() {
  try {
    localStorage.setItem(KEYS.settings, JSON.stringify(state.settings));
    localStorage.setItem(KEYS.draft, JSON.stringify({
      picks: state.picks,
      poolMeta: state.poolMeta,
      strategyText: state.strategyText,
      strategyMeta: state.strategyMeta,
    }));
    if (state.pool.length) {
      localStorage.setItem(KEYS.pool, JSON.stringify({
        pool: state.pool,
        valueMode: state.valueMode,
        warnings: state.warnings,
      }));
    }
  } catch (err) {
    // Quota exceeded on a very large pool shouldn't take the draft down.
    console.warn('Autosave failed:', err);
  }
}

export function load() {
  try {
    const s = localStorage.getItem(KEYS.settings);
    if (s) state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(s) };

    const p = localStorage.getItem(KEYS.pool);
    if (p) {
      const parsed = JSON.parse(p);
      state.pool = parsed.pool || [];
      state.valueMode = parsed.valueMode || null;
      state.warnings = parsed.warnings || [];
    }

    const d = localStorage.getItem(KEYS.draft);
    if (d) {
      const parsed = JSON.parse(d);
      state.picks = parsed.picks || [];
      state.poolMeta = parsed.poolMeta || state.poolMeta;
      state.strategyText = parsed.strategyText || '';
      state.strategyMeta = parsed.strategyMeta || null;
    }
  } catch (err) {
    console.warn('Could not restore saved state:', err);
  }
  notify();
}

export function getApiKey() {
  return localStorage.getItem(KEYS.apiKey) || '';
}

export function setApiKey(key) {
  if (key) localStorage.setItem(KEYS.apiKey, key);
  else localStorage.removeItem(KEYS.apiKey);
  notify();
}

export function getPassphrase() {
  return localStorage.getItem(KEYS.passphrase) || '';
}

export function setPassphrase(v) {
  if (v) localStorage.setItem(KEYS.passphrase, v);
  else localStorage.removeItem(KEYS.passphrase);
  notify();
}

// --- undo -------------------------------------------------------------------

function snapshot() {
  undoStack.push(JSON.stringify(state.picks));
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();
}

export function canUndo() {
  return undoStack.length > 0;
}

export function undo() {
  if (!undoStack.length) return false;
  state.picks = JSON.parse(undoStack.pop());
  state.lastRec = null;
  save();
  notify();
  return true;
}

// --- mutations --------------------------------------------------------------

export function setSettings(patch) {
  snapshot();
  state.settings = { ...state.settings, ...patch };
  save();
  notify();
}

/**
 * Install a new player pool.
 *
 * Picks reference player ids, which differ between sources, so by default a
 * new pool clears the draft. `preservePicks` re-maps them by name+position
 * instead — the case that matters is realising mid-draft that you loaded a
 * thin CSV and want the full API data without losing the picks already
 * recorded. Anything that cannot be re-matched is reported rather than
 * dropped silently.
 */
export function setPool(pool, valueMode, warnings, meta, opts = {}) {
  const priorPicks = state.picks;
  const priorPool = state.pool;

  state.pool = pool;
  state.valueMode = valueMode;
  state.warnings = warnings || [];
  state.poolMeta = { ...meta, loadedAt: new Date().toISOString() };
  undoStack = [];
  state.lastRec = null;

  let result = { remapped: 0, lost: [] };
  if (opts.preservePicks && priorPicks.length && priorPool.length) {
    const index = new Map();
    for (const p of pool) index.set(`${nameKey(p.name)}|${p.pos}`, p);

    const kept = [];
    for (const pick of priorPicks) {
      const old = priorPool.find((x) => x.id === pick.playerId);
      const match = old && index.get(`${nameKey(old.name)}|${old.pos}`);
      if (match) kept.push({ ...pick, playerId: match.id });
      else if (old) result.lost.push(old.name);
    }
    // Pick numbers must stay contiguous or the snake math desynchronises.
    state.picks = kept.map((pick, i) => ({
      ...pick,
      pickNo: i + 1,
      teamSlot: slotOnClock(i + 1, state.settings.teams),
    }));
    result.remapped = state.picks.length;
  } else {
    state.picks = [];
  }

  save();
  notify();
  return result;
}

/** Store the strategy document's prose half; tags live on the players. */
export function setStrategy(text, meta) {
  state.strategyText = text || '';
  state.strategyMeta = meta || null;
  state.lastRec = null;
  save();
  notify();
}

/**
 * Re-persist the pool after values were recomputed in place (team count
 * changed, ADP merged mid-draft). Unlike setPool this preserves picks —
 * wiping a live draft to recompute a number would be catastrophic.
 */
export function refreshPool(valueMode, warnings) {
  if (valueMode) state.valueMode = valueMode;
  if (warnings) state.warnings = warnings;
  state.lastRec = null;
  save();
  notify();
}

export function currentPickNo() {
  return state.picks.length + 1;
}

export function draftedIds() {
  return new Set(state.picks.map((p) => p.playerId));
}

export function availablePlayers() {
  const taken = draftedIds();
  return state.pool.filter((p) => !taken.has(p.id));
}

export function playerById(id) {
  return state.pool.find((p) => p.id === id) || null;
}

/** Record the next pick. `playerId` must be an undrafted player. */
export function draftPlayer(playerId) {
  const taken = draftedIds();
  if (taken.has(playerId)) return { ok: false, error: 'Player is already drafted.' };
  const player = playerById(playerId);
  if (!player) return { ok: false, error: 'Unknown player.' };

  const pickNo = currentPickNo();
  const total = state.settings.teams * state.settings.rounds;
  if (pickNo > total) return { ok: false, error: 'Draft is already complete.' };

  snapshot();
  state.picks.push({
    pickNo,
    playerId,
    teamSlot: slotOnClock(pickNo, state.settings.teams),
  });
  state.lastRec = null;
  save();
  notify();
  return { ok: true, player, pickNo };
}

export function setLastRec(rec) {
  state.lastRec = rec;
  notify();
}

export function resetDraft() {
  snapshot();
  state.picks = [];
  state.lastRec = null;
  save();
  notify();
}

/** Wipe everything, including the pool and stored key. */
export function hardReset() {
  for (const k of Object.values(KEYS)) localStorage.removeItem(k);
  state.settings = { ...DEFAULT_SETTINGS };
  state.pool = [];
  state.valueMode = null;
  state.poolMeta = { label: null, isSample: false, loadedAt: null };
  state.warnings = [];
  state.picks = [];
  state.lastRec = null;
  undoStack = [];
  notify();
}
