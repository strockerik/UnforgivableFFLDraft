# CLAUDE.md

## Project

Static single-page fantasy football draft assistant. Tracks a live snake draft,
computes value deterministically, and calls Claude for a pick recommendation on
the user's turn. Single-user tool, run locally or from GitHub Pages.

Original research brief: `Fantasy Football Draft Assistant.md`.

## Tech stack and constraints

- **Vanilla HTML/CSS/ES modules. No build step, no bundler, no dependencies.**
- **There is no Node/npm on this machine.** Do not add a toolchain, a
  `package.json`, or anything requiring `npm install`. Python 3 is available.
- Everything must work opened from `file://`, with the documented exception that
  `fetch()` is blocked there (so `players.json` and sample-CSV buttons need an
  http origin; the file pickers work either way).
- Rejected alternatives: Vite + React + TypeScript (needs Node); a Cloudflare
  Worker proxy for the Anthropic key (user chose bring-your-own-key).

## Commands

```sh
python3 -m http.server 8000                    # serve
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/run.mjs   # test
python3 tools/fetch_fantasypros.py --season 2026 --scoring HALF --projections   # refresh data
```

`jsc` ships with macOS and runs ES modules — it's how the pure logic is tested
without a Node install. Keep `tests/run.mjs` runnable under both `jsc` and node
(no imports of DOM/localStorage modules, and use the `slurp()` helper for file
reads).

## Architecture

Data flows one way: **CSV/JSON → canonical pool → values → engine → UI/prompt.**

| Module | Owns |
|---|---|
| `js/csv.js` | Tolerant CSV parsing. Header detection by content, normalized header matching. |
| `js/players.js` | Canonical player objects; rankings/ADP merge by name+pos+team. |
| `js/vorp.js` | Replacement levels and value. |
| `js/snake.js` | Pick math. Pure, no state. |
| `js/state.js` | **Sole owner of mutation.** Autosave, undo, localStorage. |
| `js/engine.js` | Roster analysis, tier cliffs, position runs, evidence packet, fallback pick. |
| `js/claude.js` | API call, schema, validation. No state mutation. |
| `js/ui/*` | Render only. Mutate through `state.js` exports. |

`engine.js` deliberately does **not** import `state.js` — it takes a state-shaped
object as an argument, which is what makes it testable headlessly.

## Important rules

- **The deterministic engine is the source of truth.** Claude explains and
  adjusts recommendations; it never owns availability and never mutates state.
  Every model response is validated against the schema *and* against the
  allowlist of undrafted players. Any failure falls back to the deterministic
  pick with a visible badge. The app must stay fully usable with no API key.
- **Never send the whole board to the model.** The evidence packet is bounded
  (top ~12 per relevant position) and always carries
  `availablePlayerAllowlist`.
- **Never let a parse failure silently drop a player.** Report it in
  `state.warnings` and surface it in the Setup panel.
- **`setPool()` clears the draft.** It's for loading a *new* pool. To recompute
  values on an existing pool (team count changed, ADP merged mid-draft) use
  `refreshPool()`, which preserves picks.
- **Namespace every localStorage key** with the `ffda:` prefix from
  `config.js`. GitHub Pages shares an origin across all of a user's repos.
- **Never present the rank surrogate as real VORP.** `computeValues()` returns
  a mode; the UI must label which is active. True VORP requires projected
  points, which only the `--projections` fetch supplies.
- Replacement level is the first player who would **not** be started
  (`N*starters + flex + 1`) — QB13 in a 12-team league, not QB12.

## Claude API specifics

- Direct browser call needs `anthropic-dangerous-direct-browser-access: true`
  alongside `x-api-key` and `anthropic-version`.
- Structured outputs via `output_config.format` — **not** a forced tool call,
  which is what the original brief specified before structured outputs went GA.
- Default `claude-opus-5`. Thinking is on by default on Opus 5 and counts
  against `max_tokens`, which is why it's set to 8000. **Do not disable
  thinking** to speed things up — lower `output_config.effort` instead.
- The system prompt is split so the stable half carries `cache_control`;
  volatile per-pick content goes in the user turn, after that breakpoint.

## FantasyPros API

Not callable from the browser — no CORS headers, no `OPTIONS` route, so the
preflight triggered by `x-api-key` fails. `tools/fetch_fantasypros.py` fetches
server-side into `data/players.json`. If the response shape changes, the script
writes the raw payload to `data/raw-response.json` rather than guessing; the
field mapping in `normalize()` tries several key names per field.

## Do not touch

- `Fantasy Football Draft Assistant.md` — the user's original research brief.
- `data/sample-*.csv` are intentionally synthetic with obviously-fake names.
  Never replace them with real player data, and never remove the red banner
  that flags them.
