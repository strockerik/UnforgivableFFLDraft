// Setup drawer: league config, data loading, API key, model + effort.

import { el, mount } from './dom.js';
import { MODELS, EFFORTS, POSITIONS, modelSupportsEffort } from '../config.js';
import {
  state, setSettings, setPool, refreshPool, getApiKey, setApiKey,
  getPassphrase, setPassphrase, setStrategy, resetDraft, hardReset,
} from '../state.js';
import { readFileText } from '../csv.js';
import { parseRankings, parseAdp, mergeAdp, finalizePool } from '../players.js';
import { parseStrategyDoc, applyTags } from '../strategy.js';
import { fetchPool } from '../fantasypros.js';
import { computeValues, VALUE_MODE_LABEL, replacementLevels } from '../vorp.js';
import { myPicks } from '../snake.js';
import { advanceMock, reseedMock, startMock, stopMock, isMockRunning } from './mock-runner.js';
import { COACHES, coachByName, habitSummary } from '../coaches.js';
import { toCsv, toCoachingReport, exportFilename } from '../export.js';

/**
 * Save text as a file. Uses a blob URL rather than a data: URI because the
 * debrief can run past the length some browsers accept in an href.
 */
function downloadText(text, filename, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Clipboard write, with a fallback. navigator.clipboard is unavailable on
 * insecure origins, which includes opening the page from file:// -- exactly
 * the situation where someone is least able to debug why nothing happened.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

let root = null;
let status = null;
let refreshing = false;

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
function ingestJson(text, sourceLabel) {
  try {
    const data = JSON.parse(text);
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
      : sourceLabel;
    // Swapping pools mid-draft is the realistic case — you notice the thin
    // CSV is loaded after picks are already in. Offer to carry them over.
    let preserve = false;
    if (state.picks.length) {
      preserve = confirm(
        `${state.picks.length} pick(s) are already recorded.\n\n` +
        'OK — keep them, re-matching players by name.\n' +
        'Cancel — start the draft over with the new pool.');
    }
    const moved = setPool(pool, mode, [...notes, ...warnings],
      { label, isSample: false }, { preservePicks: preserve });
    if (preserve && moved.lost.length) {
      notes.push(`${moved.lost.length} recorded pick(s) had no match in the new pool and were dropped: ${moved.lost.slice(0, 6).join(', ')}`);
    }

    // A pool reload drops the tags that were attached to the old pool, so
    // re-apply the strategy document if one is loaded.
    if (state.strategyText || (state.strategyMeta && state.strategyMeta.tagCount)) {
      setStatus(`Loaded ${pool.length} players from ${label}. Re-applying strategy tags…`, 'ok');
      loadStrategyFile();
      return;
    }
    setStatus(`Loaded ${pool.length} players from ${label}. ${VALUE_MODE_LABEL[mode]}.`, 'ok');
  } catch (err) {
    setStatus(`Could not read ${sourceLabel}: ${err.message}`, 'error');
  }
}

async function loadJson() {
  try {
    const res = await fetch(`data/players.json?_=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ingestJson(await res.text(), 'data/players.json');
  } catch (err) {
    setStatus(
      `Could not fetch data/players.json (${err.message}). ` +
      'Generate it with:  python3 tools/fetch_fantasypros.py --season 2026 --scoring HALF --all   ' +
      '— then either run locally (python3 -m http.server 8000) or use the upload button, ' +
      'since the licensed data is not published to the site.',
      'error'
    );
  }
}

/**
 * Load (or reload) the strategy document.
 *
 * Deliberately does NOT go through setPool, which clears the draft. Tags are
 * applied to the existing pool in place so this is safe to run mid-draft —
 * the document is expected to be revised repeatedly before draft day.
 */
function ingestStrategy(text, label) {
  const { strategyText, tags, warnings } = parseStrategyDoc(text);
  if (!strategyText && !tags.length) {
    setStatus(`No usable content in ${label}.`, 'error');
    return;
  }

  let matched = 0, unmatched = [];
  if (state.pool.length && tags.length) {
    ({ matched, unmatched } = applyTags(state.pool, tags));
    refreshPool(state.valueMode, state.warnings);
  }

  setStrategy(strategyText, {
    label,
    tagCount: tags.length,
    matched,
    unmatched: unmatched.map((t) => `${t.name} (${t.pos}${t.team ? ' ' + t.team : ''})`),
    warnings,
    loadedAt: new Date().toISOString(),
  });

  const poolNote = state.pool.length
    ? `${matched} of ${tags.length} tags attached`
    : `${tags.length} tags parsed — load a player pool to attach them`;
  setStatus(`Strategy loaded from ${label}. ${poolNote}.`,
    unmatched.length || warnings.length ? 'info' : 'ok');
}

async function loadStrategyFile() {
  try {
    const res = await fetch(`data/strategy.md?_=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ingestStrategy(await res.text(), 'data/strategy.md');
  } catch (err) {
    setStatus(
      `Could not load data/strategy.md (${err.message}). Save your document there, ` +
      'or use the file picker. Note fetch() needs an http:// origin — run python3 -m http.server 8000.',
      'error');
  }
}

/**
 * Pull a fresh board from FantasyPros via the Worker.
 *
 * Never destructive: if the fetch fails, the cached pool stays exactly as it
 * was. Losing the board on draft morning because a network call failed would
 * be far worse than showing yesterday's numbers.
 */
export async function refreshFromFantasyPros(manual = false) {
  if (refreshing) return;
  const { proxyUrl, scoring } = state.settings;
  const passphrase = getPassphrase();

  if (!proxyUrl || !passphrase) {
    if (manual) {
      setStatus('Set the Worker URL and passphrase under Setup → Claude first — ' +
        'the FantasyPros relay uses the same Worker.', 'error');
    }
    return;
  }

  refreshing = true;
  setStatus('Fetching from FantasyPros…');
  try {
    const scoringCode = scoring === 'PPR' ? 'PPR' : scoring === 'Standard' ? 'STD' : 'HALF';
    const data = await fetchPool({ proxyUrl, passphrase, season: '2026', scoring: scoringCode });

    const { pool, warnings } = finalizePool(data.players);
    const { mode } = computeValues(pool, state.settings);

    let preserve = false;
    if (state.picks.length) {
      preserve = confirm(
        `${state.picks.length} pick(s) are recorded.\n\n` +
        'OK — keep them, re-matching players by name.\n' +
        'Cancel — start over with the refreshed board.');
    }
    const moved = setPool(pool, mode, [...data.notes, ...warnings], {
      label: `FantasyPros ${data.season} ${data.scoring} — ${data.fetchedAt.slice(11, 16)} today`,
      isSample: false,
      coverage: data.coverage,
      fetchedAt: data.fetchedAt,
    }, { preservePicks: preserve });

    if (state.strategyText || state.strategyMeta) loadStrategyFile();
    setStatus(`Refreshed: ${pool.length} players`
      + (moved.lost.length ? `, ${moved.lost.length} recorded pick(s) unmatched` : '')
      + `. ${VALUE_MODE_LABEL[mode]}.`, 'ok');
  } catch (err) {
    setStatus(`Could not refresh (${err.message}). `
      + (state.pool.length
        ? 'Keeping the board already loaded — nothing was lost.'
        : 'No board is loaded; try an offline fallback below.'), 'error');
  } finally {
    refreshing = false;
    render();
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

/**
 * Pad or trim the draft order to the team count, so changing "Teams" from 10
 * to 12 gives you two more rows to name instead of silently hiding slots.
 */
function normalizedOrder(s) {
  const out = [...(s.draftOrder || [])].slice(0, s.teams);
  while (out.length < s.teams) out.push(`Team ${out.length + 1}`);
  return out;
}

/** Reorder the board. Slot follows by index, not by name — duplicate names
 *  are perfectly possible on draft day and would misroute a name lookup. */
function moveTeam(index, dir) {
  const s = state.settings;
  const next = normalizedOrder(s);
  const j = index + dir;
  if (j < 0 || j >= next.length) return;
  [next[index], next[j]] = [next[j], next[index]];

  let slot = s.slot;
  if (s.slot === index + 1) slot = j + 1;
  else if (s.slot === j + 1) slot = index + 1;

  setSettings({ draftOrder: next, slot, myTeamName: next[slot - 1] || s.myTeamName });
}

function render() {
  if (!root) return;
  const focusSnap = captureFocus();
  const s = state.settings;
  const levels = replacementLevels(s);
  const picks = myPicks(s);
  const order = normalizedOrder(s);

  const rosterFields = Object.keys(s.roster).map((pos) =>
    field(pos, numberInput(s.roster[pos], 0, 5, (v) => setSettings({ roster: { ...s.roster, [pos]: v } })))
  );

  mount(root,
    el('section', { class: 'setup-group' },
      el('h3', {}, '1. Player data'),
      el('p', { class: 'field-hint' },
        'Pulled from the FantasyPros API through your Cloudflare Worker, and refreshed ',
        'automatically when the app opens if the cached copy is more than ',
        String(s.autoRefreshHours), ' hours old. FantasyPros blocks direct browser calls, ',
        'so the Worker relays it.'),
      el('div', { class: 'row' },
        el('button', {
          class: 'btn primary-outline',
          disabled: refreshing,
          onclick: () => refreshFromFantasyPros(true),
        }, refreshing ? 'Refreshing…' : 'Refresh from FantasyPros now'),
        field('Auto-refresh after', el('select', {
          onchange: (e) => setSettings({ autoRefreshHours: Number(e.target.value) }),
        }, [0, 1, 6, 24].map((h) =>
          el('option', { value: h, selected: s.autoRefreshHours === h },
            h === 0 ? 'every open' : `${h}h`))), 'How stale the cache may get'),
      ),
      state.poolMeta.label
        ? el('p', { class: 'computed' },
            el('strong', {}, `${state.pool.length} players `), '· ', state.poolMeta.label,
            state.poolMeta.coverage
              ? ` · tier ${state.poolMeta.coverage.tier} · adp ${state.poolMeta.coverage.adp} · proj ${state.poolMeta.coverage.proj}`
              : '')
        : el('p', { class: 'field-hint' }, 'No player data loaded yet.'),
      status ? el('p', { class: `status status-${status.kind}` }, status.msg) : null,
      state.warnings.length
        ? el('details', { class: 'warnings' },
            el('summary', {}, `${state.warnings.length} note(s)`),
            el('ul', {}, state.warnings.map((w) => el('li', {}, w))))
        : null,
      el('details', { class: 'warnings' },
        el('summary', {}, 'Offline fallbacks'),
        el('div', { class: 'row' },
          el('button', { class: 'btn', onclick: loadJson }, 'Load data/players.json'),
          el('button', { class: 'btn', onclick: loadSample }, 'Load synthetic sample data'),
        ),
        el('p', { class: 'field-hint' },
          'Only needed if the Worker is unreachable. players.json comes from ',
          'tools/fetch_fantasypros.py; the sample data is invented and marked as such.')),
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
      el('h3', {}, '3. Strategy document'),
      el('p', { class: 'field-hint' },
        'Prose guidance goes into the cached system prompt; player tags attach to the board. ',
        'Reload any time — it is safe mid-draft and replaces the previous version rather than adding to it.'),
      field('Guaranteed upside picks', el('select', {
        onchange: (e) => setSettings({ sleeperQuota: Number(e.target.value) }),
      }, [0, 1, 2, 3].map((n) => el('option', {
        value: String(n), selected: (s.sleeperQuota ?? 1) === n,
      }, n === 0 ? 'None — pure value' : `${n} sleeper${n > 1 ? 's' : ''}`))),
        'Guarantees this many players tagged "sleeper" in your strategy document. '
        + 'Only ever applied after your starting lineup is full, and it gives up at '
        + 'most ~25 points of value to land one — on a bench that is a good trade, '
        + 'since a replacement-level backup is worth close to nothing anyway.'),
      (() => {
        // Surface whether the quota can actually be met, rather than failing
        // silently on a document with no sleeper tags.
        const q = s.sleeperQuota ?? 1;
        if (!q) return null;
        const tagged = state.pool.filter((p) => (p.tags || []).includes('sleeper')).length;
        const held = state.pool.filter((p) => (p.tags || []).includes('sleeper')
          && state.picks.some((pk) => pk.playerId === p.id
            && pk.teamSlot === state.settings.slot)).length;
        if (!state.pool.length) return null;
        return tagged
          ? el('p', { class: 'field-hint' },
              `${tagged} player(s) on the board carry a "sleeper" tag — ${held} on your roster.`)
          : el('p', { class: 'field-hint warn-inline' },
              'No player on the board carries a "sleeper" tag, so this quota cannot be met. '
              + 'Add them to the JSON block in your strategy document.');
      })(),
      el('div', { class: 'row' },
        el('button', { class: 'btn primary-outline', onclick: loadStrategyFile }, 'Reload data/strategy.md'),
        field('or pick a file', el('input', {
          type: 'file', accept: '.md,.txt,text/markdown,text/plain',
          onchange: async (e) => {
            const f = e.target.files[0];
            if (!f) return;
            ingestStrategy(await readFileText(f), f.name);
          },
        })),
        state.strategyText
          ? el('button', {
              class: 'btn',
              onclick: () => {
                if (!confirm('Remove the strategy document and clear its tags?')) return;
                if (state.pool.length) {
                  applyTags(state.pool, []);
                  refreshPool(state.valueMode, state.warnings);
                }
                setStrategy('', null);
                setStatus('Strategy document cleared.', 'ok');
              },
            }, 'Clear')
          : null,
      ),
      state.strategyMeta
        ? el('p', { class: 'computed' },
            el('strong', {}, 'Loaded: '),
            `${state.strategyMeta.label} — ${state.strategyMeta.matched}/${state.strategyMeta.tagCount} tags attached, `,
            `${Math.round((state.strategyText || '').split(/\s+/).length)} words of guidance `,
            `(${(state.strategyMeta.loadedAt || '').slice(11, 16)})`)
        : el('p', { class: 'field-hint' }, 'No strategy document loaded.'),
      state.strategyMeta && state.strategyMeta.unmatched && state.strategyMeta.unmatched.length
        ? el('details', { class: 'warnings' },
            el('summary', {}, `${state.strategyMeta.unmatched.length} tag(s) matched no player — check the spelling`),
            el('ul', {}, state.strategyMeta.unmatched.map((u) => el('li', {}, u))))
        : null,
      state.strategyMeta && state.strategyMeta.warnings && state.strategyMeta.warnings.length
        ? el('details', { class: 'warnings' },
            el('summary', {}, `${state.strategyMeta.warnings.length} parse note(s)`),
            el('ul', {}, state.strategyMeta.warnings.map((w) => el('li', {}, w))))
        : null,
    ),

    el('section', { class: 'setup-group' },
      el('h3', {}, '4. Draft order — by coach'),
      el('p', { class: 'field-hint' },
        'Use ↑↓ to put the coaches in the order drawn on draft day, and click ',
        '"set" on your own row — your slot follows it, so you never enter it twice. ',
        'These are coaches, not team names, because team names change every year ',
        'and the tendency history follows the person.'),
      el('p', { class: 'field-hint' },
        'Known coaches: ',
        el('strong', {}, COACHES.map((c) => c.name).join(', ')),
        '. Spelling must match for the opponent model to apply — a name it does ',
        'not recognise simply gets no tendency data, which the recommendation ',
        'will say.'),
      el('ol', { class: 'order-list' },
        order.map((name, i) => el('li', {
          // Identity is the slot index, not the name. Two teams can end up
          // sharing a name on draft day (a default left in place, two "TBD"
          // rows) and name matching would silently move your slot.
          class: 'order-row' + (i + 1 === s.slot ? ' order-mine' : ''),
        },
          el('span', { class: 'order-slot' }, String(i + 1)),
          el('input', {
            class: 'order-name',
            type: 'text',
            name: `team-${i}`,
            value: name,
            placeholder: `Team ${i + 1}`,
            onchange: (e) => {
              const next = [...order];
              next[i] = e.target.value.trim() || `Team ${i + 1}`;
              setSettings({
                draftOrder: next,
                // Only your own row renames your team.
                myTeamName: i + 1 === s.slot ? next[i] : s.myTeamName,
              });
            },
          }),
          el('button', {
            class: 'btn small', title: 'Move up', disabled: i === 0,
            onclick: () => moveTeam(i, -1),
          }, '↑'),
          el('button', {
            class: 'btn small', title: 'Move down', disabled: i === order.length - 1,
            onclick: () => moveTeam(i, 1),
          }, '↓'),
          el('button', {
            class: 'btn small' + (i + 1 === s.slot ? ' primary' : ''),
            title: 'This is my team',
            onclick: () => setSettings({ draftOrder: order, myTeamName: name, slot: i + 1 }),
          }, i + 1 === s.slot ? 'you' : 'set'),
          // Whether the opponent model recognises this name. A typo here is
          // otherwise invisible: the draft still works, it just quietly loses
          // ten seasons of tendency data for that seat.
          coachByName(name)
            ? el('span', { class: 'order-note good-ink', title: habitSummary(coachByName(name)) },
                '✓ history')
            : el('span', { class: 'order-note warn-ink', title: 'No tendency history for this name.' },
                'no history'),
        ))),
      el('p', { class: 'computed' },
        el('strong', {}, 'You pick from slot '), String(s.slot),
        ` (${order[s.slot - 1] || '—'}) — picks ${myPicks(s).slice(0, 5).join(', ')}…`),
      state.picks.length
        ? el('p', { class: 'warn-inline' },
            `${state.picks.length} pick(s) already recorded. Reordering now reassigns them ` +
            'to whichever team ends up in each slot — set the order before you start.')
        : null,
    ),

    el('section', { class: 'setup-group' },
      el('h3', {}, '5. Claude'),
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
          disabled: !modelSupportsEffort(s.model),
          onchange: (e) => setSettings({ effort: e.target.value }),
        }, EFFORTS.map((x) => el('option', { value: x, selected: s.effort === x }, x))),
        modelSupportsEffort(s.model)
          ? 'Lower = faster on the clock'
          : 'This model does not accept an effort setting, so it is not sent.'),
      ),
    ),

    el('section', { class: 'setup-group' },
      el('h3', {}, '6. Practice draft'),
      field('Practice mode', el('select', {
        onchange: (e) => {
          const on = e.target.value === 'on';
          if (!on) stopMock();
          setSettings({ mockDraft: on });
        },
      }, [
        el('option', { value: 'off', selected: !s.mockDraft }, 'Off — you record every pick'),
        el('option', { value: 'on', selected: !!s.mockDraft }, 'On — the other 9 coaches draft themselves'),
      ]), 'Arms practice mode. Nothing is drafted until you press Start, so you can '
        + 'set the draft order and look at the board first. The other coaches pick by '
        + 'ADP bent toward their real habits, and are forced to fill starters late '
        + 'exactly as Yahoo forces them.'),
      s.mockDraft
        ? el('div', { class: 'row' },
            isMockRunning()
              ? el('button', { class: 'btn', onclick: () => { stopMock(); render(); } }, 'Pause')
              : el('button', {
                  class: 'btn primary',
                  onclick: () => {
                    if (state.picks.length && !confirm(
                      `This draft already has ${state.picks.length} pick(s).\n\n`
                      + 'Starting will auto-draft for the other nine coaches from here. '
                      + 'Use "Restart" instead if you want a clean draft.\n\nStart anyway?')) return;
                    startMock();
                    render();
                  },
                }, state.picks.length ? 'Start from here' : 'Start practice draft'),
            el('button', {
              class: 'btn',
              onclick: () => {
                if (state.picks.length && !confirm('Clear all picks and start a fresh practice draft?')) return;
                reseedMock();
                resetDraft();
                startMock();
                render();
              },
            }, 'Restart'),
            isMockRunning()
              ? el('button', { class: 'btn small', onclick: () => advanceMock() }, 'Advance to my turn')
              : null,
          )
        : null,
      s.mockDraft
        ? el('p', { class: isMockRunning() ? 'hint warn-inline' : 'hint' },
            isMockRunning()
              ? 'Running — the other nine coaches are drafting themselves. Turn practice '
                + 'mode OFF before your real draft, or the app will draft over your '
                + 'league-mates\u2019 actual picks.'
              : 'Armed but not running. Press Start when you are ready.')
        : null,
    ),

    el('section', { class: 'setup-group' },
      el('h3', {}, '7. Export draft'),
      el('p', { class: 'field-hint' },
        state.picks.length
          ? `${state.picks.length} pick(s) recorded${s.mockDraft ? ' (practice draft)' : ''}.`
          : 'Nothing to export yet — the draft has no picks.'),
      el('div', { class: 'row' },
        el('button', {
          class: 'btn', disabled: !state.picks.length,
          onclick: () => downloadText(toCsv(state),
            exportFilename(state, { isMock: !!s.mockDraft, ext: 'csv' }), 'text/csv'),
        }, 'Download CSV'),
        el('button', {
          class: 'btn', disabled: !state.picks.length,
          onclick: () => downloadText(toCoachingReport(state, { isMock: !!s.mockDraft }),
            exportFilename(state, { isMock: !!s.mockDraft }), 'text/markdown'),
        }, 'Download debrief'),
        el('button', {
          class: 'btn primary', disabled: !state.picks.length,
          onclick: async () => {
            const text = toCoachingReport(state, { isMock: !!s.mockDraft });
            const ok = await copyText(text);
            setStatus(ok
              ? `Debrief copied (${text.length.toLocaleString()} chars) — paste it to Claude for coaching.`
              : 'Could not reach the clipboard. Use "Download debrief" instead.',
              ok ? 'ok' : 'error');
          },
        }, 'Copy debrief for Claude'),
      ),
      el('p', { class: 'field-hint' },
        'The debrief is markdown: your roster, every pick with the players you ',
        'passed over, and whether each of them was still there at your next turn. ',
        'Paste it into Claude and ask it to grade the draft.'),
    ),

    el('section', { class: 'setup-group danger' },
      el('h3', {}, '8. Reset'),
      field('Confirm every pick', el('select', {
        onchange: (e) => setSettings({ confirmEveryPick: e.target.value === 'yes' }),
      }, [
        el('option', { value: 'yes', selected: s.confirmEveryPick !== false }, 'Yes — ask before recording'),
        el('option', { value: 'no', selected: s.confirmEveryPick === false }, 'No — record instantly, undo via toast'),
      ]), 'Off is faster on the clock; the undo toast catches mistakes either way.'),
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
  const s = state.settings;
  const fetchedAt = state.poolMeta && state.poolMeta.fetchedAt;
  const ageHours = fetchedAt ? (Date.now() - Date.parse(fetchedAt)) / 3.6e6 : Infinity;
  const stale = !state.pool.length || ageHours >= (s.autoRefreshHours ?? 6);

  // The API is the source of truth; the local file is a fallback for when the
  // Worker is unreachable.
  if (stale && s.proxyUrl && getPassphrase()) {
    await refreshFromFantasyPros(false);
  }

  if (location.protocol === 'file:') return; // fetch() is blocked on file://
  if (!state.pool.length) {
    try {
      const res = await fetch('data/players.json', { method: 'HEAD' });
      if (res.ok) await loadJson();
    } catch { /* no local copy either — the panel explains the options */ }
  }

  if (!state.strategyText) {
    try {
      const res = await fetch('data/strategy.md', { method: 'HEAD' });
      if (res.ok) await loadStrategyFile();
    } catch { /* optional */ }
  }
}
