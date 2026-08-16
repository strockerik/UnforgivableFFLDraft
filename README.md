# Fantasy Football Draft Assistant

A static, single-page draft assistant. Tracks a live snake draft pick by pick,
computes value deterministically (VORP, tier cliffs, positional scarcity, snake
pick math), and asks Claude for a recommendation on your turn.

No build step, no backend, no dependencies. Runs from disk or GitHub Pages.

## Run it

```sh
cd "Fantasy Football Draft"
python3 -m http.server 8000
# open http://localhost:8000
```

You can also open `index.html` straight from disk, but `fetch()` is blocked on
`file://` URLs, so the "Load data/players.json" and "Load synthetic sample
data" buttons won't work — use the file pickers instead. Everything else does.

## Loading player data

Three ways in, in order of preference.

### 1. FantasyPros API (best — gives you real VORP)

```sh
export FANTASYPROS_API_KEY=...     # https://secure.fantasypros.com/api-keys/request/
python3 tools/fetch_fantasypros.py --season 2026 --scoring HALF --all
```

Writes `data/players.json`; the app picks it up automatically on load.

**The app cannot call this API directly**, and that is not a fixable
client-side problem: `api.fantasypros.com` sends no `Access-Control-Allow-*`
headers and has no `OPTIONS` route, so the CORS preflight triggered by the
`x-api-key` header fails and the browser blocks the request. The script does
the fetch on your machine instead — no CORS, and your FantasyPros key stays on
disk rather than in `localStorage`.

`--all` is projections + news + injuries. Individually:

| Flag | Adds | Why it matters |
|---|---|---|
| `--projections` | projected points | true VORP instead of the rank surrogate |
| `--injuries` | status + practice designations | the one thing a CSV snapshot can never know |
| `--news` | 2 recent notes per player, capped | late-breaking context on draft morning |

Injuries and news flow into the board (as a tag) and into the evidence packet,
and the system prompt tells Claude to weigh them against a ranking that
predates them. The caps are deliberate — the packet stays bounded.

These three are best-effort: if your plan doesn't cover an endpoint, the run
still succeeds with rankings and says what it skipped.

### What the API does *not* have

No editorial content. The draft kit's guides, primers, and round-by-round
writeups are website content, not API resources — there is no endpoint for
them. The strategy layer they'd give you is already built into the app's system
prompt (VBD with your league's replacement levels, positional scarcity, tier
cliffs, round-sensitive construction, ADP value, run detection), applied to
your live board rather than read as prose.

### 2. CSV exports — download as many as you like

Drop every export you download into `Fantasy Ranking/` and merge them in one go:

```sh
python3 tools/build_pool.py
```

It works out what each file is (overall rankings, per-position, ADP) and folds
them together, then writes `data/players.json`. Each file fills in what the
others were missing — the free overall export has no tiers or byes, the
per-position exports have both but cover one position.

**It will not merge a specialty file's rank or ADP as if they were overall
values.** A "Sleeper RB" export ranks Zach Charbonnet 1st with ADP 42, while
the overall export has him 141st; merging those naively produced "ADP 42 vs
ECR 141" — a player apparently falling 99 picks, which is the strongest buy
signal the app can show and was entirely fabricated. Specialty files
contribute only tier, bye, team, and SOS, and the run report tells you which
signals ended up unavailable.

Or use the file pickers under **Setup → Player data** for a single file.

The parser handles the export variants, which differ more than you'd expect:

| Export | Player column | Position from | Carries |
|---|---|---|---|
| Draft Overall Rankings (free) | `Player` | `Position` column | rank, team only |
| Consensus cheat sheet (premium) | `PLAYER NAME` | `POS` (e.g. `RB1`) | tier, bye, SOS, ADP, expert spread |
| Per-position (e.g. Sleeper RB) | `Running Backs` | the column header itself | tier, bye, ECR, ADP |
| ADP | `Player Team (Bye)` combined | — | ADP per source |

It also absorbs title rows above the header, footer notes below it, per-expert
columns, trailing blank rows, `AVG.`/`STD.DEV` punctuation, and name suffixes
in the combined ADP cell (`Patrick Mahomes II KC (10)` — the case that breaks
naive left-to-right splitting).

**The free Draft Overall Rankings export has no tier, bye, or ADP columns**, so
tier-cliff detection and bye-conflict warnings stay dark when it's the only
file loaded. The app tells you this in the parse-notes panel rather than
quietly degrading. Load an ADP export alongside it to recover byes and market
prices, or use the premium cheat-sheet export for tiers.

Anything it can't match is reported, never silently dropped.

### 3. Synthetic sample data

`data/sample-*.csv` are **invented** players and numbers for exercising the app
before you have real exports. The app shows a red banner while they're loaded.
Don't draft from them.

## Setting up the draft

Under **Setup → League**: team count, your slot, rounds, roster, scoring. The
panel shows the computed replacement levels and every pick number you own, so
you can sanity-check them before the draft starts.

## Claude

Paste an API key under **Setup → Claude**. It's stored in this browser's
`localStorage` under a `ffda:` prefix and sent directly to Anthropic with the
`anthropic-dangerous-direct-browser-access` header.

**Anyone with access to this browser can read that key.** That's an acceptable
trade for a private single-user tool. If this ever gets shared or hosted
somewhere others use, move the call behind a proxy you control.

Model and effort are configurable. Lower effort is faster on the clock; Opus 5
at `medium` is a good default. Cost per pick is displayed after each call —
a full draft runs a few cents.

**The deterministic engine is the source of truth.** Claude explains and
adjusts; it never decides what's available. Every response is checked against
the schema and against an allowlist of undrafted players, and any failure —
bad key, no network, rate limit, malformed answer, or a drafted player named —
falls back to the deterministic pick with a visible badge. You can run the
entire draft with no API key at all.

## During the draft

- Type a name and press **Enter** to draft the top match — the fast path when
  picks are being called out.
- **Cmd/Ctrl+Z** or the Undo button rolls back a misheard pick (30 deep).
- State autosaves on every change; refreshing mid-draft loses nothing.
- **Emergency cheat sheet** at the bottom prints a positional board with the
  replacement line marked. Print it before you start.

## Draft-morning checklist

1. Re-run the fetch script (or re-download the CSVs) — rankings are a snapshot,
   and injury news moves them.
2. Confirm team count, your slot, and roster settings match the real league.
3. Check that your pick numbers in the Setup panel match the draft room.
4. Run a few practice picks, then **Reset draft**.
5. Confirm the Claude call works — one **Ask Claude** and check for the green
   badge, not the amber fallback one.
6. Print the cheat sheet.

## Tests

```sh
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/run.mjs
```

62 tests over the pure logic — CSV quirks, name/suffix parsing, ADP merging,
replacement levels, snake math, tier cliffs, evidence-packet bounds and
allowlist integrity, response validation, your real FantasyPros exports, and a
full simulated 150-pick draft.
`jsc` ships with macOS; `node tests/run.mjs` works too if you have Node.

## Deploying to GitHub Pages

Push the folder and enable Pages. Nothing to build.

Note that `localStorage` is shared per-origin across every repo on
`username.github.io`, which is why every key here is prefixed `ffda:`.

Think before pushing `data/players.json` — FantasyPros data is licensed, and
the free API tier is for personal, non-production use.

## Layout

```
index.html            single page
styles.css
js/
  config.js           league defaults, storage keys, model list
  csv.js              tolerant CSV parsing
  players.js          normalize + merge rankings and ADP
  vorp.js             replacement levels and value
  snake.js            pick math
  state.js            state, autosave, undo
  engine.js           roster analysis, cliffs, runs, evidence packet, fallback
  claude.js           API client, schema, validation
  main.js             bootstrap
  ui/                 board, roster, recommendations, setup, cheat sheet
tools/
  fetch_fantasypros.py   API → data/players.json
tests/run.mjs
data/                 sample CSVs; players.json once you generate it
```
