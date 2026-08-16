// Setup drawer: league config, data loading, API key, model + effort.

import { el, mount } from './dom.js';
import { MODELS, EFFORTS, POSITIONS } from '../config.js';
import {
  state, setSettings, setPool, refreshPool, getApiKey, setApiKey,
  getPassphrase, setPassphrase, resetDraft, hardReset,
} from '../state.js';
import { readFileText } from '../csv.js';
import { parseRankings, parseAdp, mergeAdp, finalizePool } from '../players.js';
import { computeValues, VALUE_MODE_LABEL, replacementLevels } from '../vorp.js';
import { myPicks } from '../snake.js';

let root = null;
let status = null;

function setStatus(msg, kind = 'info') {
  status = { msg, kind };
  render();
}

async function ingest(rankingsText, adpText, meta) {
  try {
    const warnings = [];
    const { players, warnings: rw } = parseRankings(rankingsText);
    warnings.push(...rw);
    if (!players.length) throw new Error('No players parsed from the rankings file.');

    if (adpText) {
      const { rows, warnings: aw } = parseAdp(adpText);
      warnings.push(...aw);
      const { matched, warnings: mw } = mergeAdp(players, rows);
      warnings.push(...mw);
      warnings.unshift(`Merged ADP for ${matched} of ${rows.length} rows.`);
    }

    const { pool, warnings: fw } = finalizePool(players);
    warnings.push(...fw);

    const { mode } = computeValues(pool, state.settings);
    setPool(pool, mode, warnings, meta);
    setStatus(`Loaded ${pool.length} players. ${VALUE_MODE_LABEL[mode]}.`, 'ok');
  } catch (err) {
    setStatus(`Could not load: ${err.message}`, 'error');
  }
}

/**
 * Load data/players.json, written by tools/fetch_fantasypros.py.
 * The FantasyPros API sends no CORS headers and has no OPTIONS route, so the
 * page cannot call it directly — the script fetches server-side and leaves
 * this file behind.
 */
async function loadJson() {
  try {
    const res = await fetch('data/players.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const players = Array.isArray(data) ? data : data.players;
    if (!Array.isArray(players) || !players.length) throw new Error('No players array in the file.');

    const usable = players.filter((p) => p && p.name && p.pos);
    if (!usable.length) throw new Error('Players in the file are missing name/pos fields.');

    const { pool, warnings } = finalizePool(usable);
    const notes = [...(data.notes || [])];
    if (usable.length !== players.length) {
      notes.push(`${players.length - usable.length} record(s) lacked a name or position and were dropped.`);
    }
    const { mode } = computeValues(pool, state.settings);
    const label = data.season
      ? `FantasyPros ${data.season} ${data.scoring || ''} — fetched ${(data.fetchedAt || '').slice(0, 16).replace('T', ' ')}`
      : 'data/players.json';
    setPool(pool, mode, [...notes, ...warnings], { label, isSample: false });
    setStatus(`Loaded ${pool.length} players from ${label}. ${VALUE_MODE_LABEL[mode]}.`, 'ok');
  } catch (err) {
    setStatus(
      `Could not load data/players.json (${err.message}). ` +
      'Generate it with:  python3 tools/fetch_fantasypros.py --season 2026 --scoring HALF --projections   ' +
      '— and note fetch() needs an http:// origin, so run python3 -m http.server 8000.',
      'error'
    );
  }
}

async function loadSample() {
  try {
    const [r, a] = await Promise.all([
      fetch('data/sample-rankings.csv').then((x) => { if (!x.ok) throw new Error(`HTTP ${x.status}`); return x.text(); }),
      fetch('data/sample-adp.csv').then((x) => (x.ok ? x.text() : null)).catch(() => null),
    ]);
    await ingest(r, a, { label: 'Synthetic sample data', isSample: true });
  } catch (err) {
    setStatus(
      `Could not fetch the sample files (${err.message}). ` +
      'Browsers block fetch() on file:// URLs — run `python3 -m http.server 8000` and open http://localhost:8000, ' +
      'or use the file pickers above.',
      'error'
    );
  }
}

function field(label, control, hint) {
  // Stable name so focus survives the re-render this panel gets on every pick.
  if (!control.name) control.name = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return el('label', { class: 'field' },
    el('span', { class: 'field-label' }, label),
    control,
    hint ? el('span', { class: 'field-hint' }, hint) : null,
  );
}

function numberInput(value, min, max, onchange) {
  return el('input', {
    type: 'number', value, min, max,
    onchange: (e) => onchange(Number(e.target.value)),
  });
}

/** Remember which control had focus, and where the caret was, across a render. */
function captureFocus() {
  const a = document.activeElement;
  if (!a || !root.contains(a) || !a.name) return null;
  return {
    name: a.name,
    start: a.selectionStart ?? null,
    end: a.selectionEnd ?? null,
  };
}

function restoreFocus(snap) {
  if (!snap) return;
  const next = root.querySelector(`[name="${CSS.escape(snap.name)}"]`);
  if (!next) return;
  next.focus();
  // File inputs and selects throw on setSelectionRange.
  if (snap.start != null && typeof next.setSelectionRange === 'function') {
    try { next.setSelectionRange(snap.start, snap.end); } catch { /* unsupported type */ }
  }
}

function render() {
  if (!root) return;
  const focusSnap = captureFocus();
  const s = state.settings;
  const levels = replacementLevels(s);
  const picks = myPicks(s);

  const rosterFields = Object.keys(s.roster).map((pos) =>
    field(pos, numberInput(s.roster[pos], 0, 5, (v) => setSettings({ roster: { ...s.roster, [pos]: v } })))
  );

  mount(root,
    el('section', { class: 'setup-group' },
      el('h3', {}, '1. Player data'),
      el('div', { class: 'row' },
        field('Rankings CSV', el('input', {
          type: 'file', accept: '.csv,text/csv',
          onchange: async (e) => {
            const f = e.target.files[0];
            if (!f) return;
            setStatus('Parsing…');
            await ingest(await readFileText(f), null, { label: f.name, isSample: false });
          },
        }), 'FantasyPros consensus rankings export'),
        field('ADP CSV (optional)', el('input', {
          type: 'file', accept: '.csv,text/csv',
          onchange: async (e) => {
            const f = e.target.files[0];
            if (!f || !state.pool.length) {
              setStatus('Load the rankings file first, then add ADP.', 'error');
              return;
            }
            const text = await readFileText(f);
            const { rows, warnings } = parseAdp(text);
            const { matched, warnings: mw } = mergeAdp(state.pool, rows);
            const { mode } = computeValues(state.pool, state.settings);
            refreshPool(mode, [...state.warnings, ...warnings, ...mw,
              `Merged ADP for ${matched} of ${rows.length} rows.`]);
            setStatus(`Merged ADP for ${matched} of ${rows.length} rows.`, 'ok');
          },
        }), 'Merged on name + team'),
      ),
      el('div', { class: 'row' },
        el('button', { class: 'btn primary-outline', onclick: loadJson }, 'Load data/players.json'),
        el('button', { class: 'btn', onclick: loadSample }, 'Load synthetic sample data'),
      ),
      el('p', { class: 'field-hint' },
        'players.json comes from tools/fetch_fantasypros.py — the FantasyPros API blocks browser calls (no CORS), ',
        'so that script fetches it on your machine and writes the file here.'),
      state.poolMeta.isSample
        ? el('p', { class: 'warn-inline' },
            'Sample data is SYNTHETIC — invented names and numbers for testing the app. Do not draft from it.')
        : null,
      status ? el('p', { class: `status status-${status.kind}` }, status.msg) : null,
      state.warnings.length
        ? el('details', { class: 'warnings' },
            el('summary', {}, `${state.warnings.length} parse note(s)`),
            el('ul', {}, state.warnings.map((w) => el('li', {}, w))),
          )
        : null,
    ),

    el('section', { class: 'setup-group' },
      el('h3', {}, '2. League'),
      el('div', { class: 'row' },
        field('Teams', numberInput(s.teams, 4, 16, (v) => { setSettings({ teams: v }); recompute(); })),
        field('Your slot', numberInput(s.slot, 1, s.teams, (v) => setSettings({ slot: v }))),
        field('Rounds', numberInput(s.rounds, 1, 25, (v) => setSettings({ rounds: v }))),
        field('Bench', numberInput(s.bench, 0, 12, (v) => setSettings({ bench: v }))),
      ),
      el('div', { class: 'row' }, rosterFields),
      field('Scoring', el('select', {
        onchange: (e) => setSettings({ scoring: e.target.value }),
      }, ['Half-PPR', 'PPR', 'Standard'].map((x) =>
        el('option', { value: x, selected: s.scoring === x }, x)))),
      el('p', { class: 'computed' },
        el('strong', {}, 'Replacement levels: '),
        POSITIONS.map((p) => `${p}${levels[p]}`).join(' · '),
      ),
      el('p', { class: 'computed' },
        el('strong', {}, 'Your picks: '),
        picks.join(', '),
      ),
    ),

    el('section', { class: 'setup-group' },
      el('h3', {}, '3. Claude'),
      field('Connection', el('select', {
        onchange: (e) => setSettings({ authMode: e.target.value }),
      }, [
        el('option', { value: 'direct', selected: s.authMode === 'direct' },
          'Direct — key in this browser'),
        el('option', { value: 'proxy', selected: s.authMode === 'proxy' },
          'Via Cloudflare Worker — key stays server-side'),
      ]), s.authMode === 'proxy'
        ? 'The Worker holds your Anthropic key. This browser only stores the passphrase.'
        : 'Simplest for local use. The key is readable by anyone with access to this browser.'),

      s.authMode === 'proxy'
        ? el('div', {},
            field('Worker URL', el('input', {
              type: 'url',
              placeholder: 'https://ffl-draft-proxy.<subdomain>.workers.dev',
              value: s.proxyUrl,
              onchange: (e) => setSettings({ proxyUrl: e.target.value.trim() }),
            }), 'From the Cloudflare dashboard, after you deploy worker/worker.js'),
            field('Passphrase', el('input', {
              type: 'password',
              placeholder: 'the APP_PASSPHRASE secret',
              value: getPassphrase(),
              onchange: (e) => setPassphrase(e.target.value.trim()),
            }), 'Must match the APP_PASSPHRASE secret set on the Worker.'),
          )
        : field('API key', el('input', {
            type: 'password',
            placeholder: 'sk-ant-…',
            value: getApiKey(),
            onchange: (e) => setApiKey(e.target.value.trim()),
          }), 'Stored in this browser only, under a ffda: prefix.'),
      el('div', { class: 'row' },
        field('Model', el('select', {
          onchange: (e) => setSettings({ model: e.target.value }),
        }, MODELS.map((m) => el('option', { value: m.id, selected: s.model === m.id }, m.label)))),
        field('Effort', el('select', {
          onchange: (e) => setSettings({ effort: e.target.value }),
        }, EFFORTS.map((x) => el('option', { value: x, selected: s.effort === x }, x))),
        'Lower = faster on the clock'),
      ),
    ),

    el('section', { class: 'setup-group danger' },
      el('h3', {}, '4. Reset'),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => { if (confirm('Clear all picks? The player pool stays loaded.')) resetDraft(); } }, 'Reset draft'),
        el('button', { class: 'btn', onclick: () => { if (confirm('Erase everything, including the pool and API key?')) hardReset(); } }, 'Erase everything'),
      ),
    ),
  );

  restoreFocus(focusSnap);
}

// Team count changes move replacement levels, which move every value.
// Recompute in place — never through setPool, which clears the draft.
function recompute() {
  if (!state.pool.length) return;
  const { mode } = computeValues(state.pool, state.settings);
  refreshPool(mode, state.warnings);
}

export function initSettings(container) {
  root = container;
  render();
  return render;
}

/** Called once at startup: pick up data/players.json if it's already there. */
export async function autoLoad() {
  if (state.pool.length) return;          // restored from localStorage already
  if (location.protocol === 'file:') return; // fetch() is blocked on file://
  try {
    const res = await fetch('data/players.json', { method: 'HEAD' });
    if (res.ok) await loadJson();
  } catch { /* no players.json yet — the setup panel explains how to make one */ }
}
