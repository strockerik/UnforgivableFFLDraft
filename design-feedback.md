# Design feedback — Fantasy Football Draft Assistant

Prioritized by impact on the core task: **find a name and click it in a few seconds, 150+ times, under a 60s clock.**

Constraints respected: no build step, no external requests, CSS custom properties + `prefers-color-scheme`, print stylesheet, semantic position colors, JS-generated markup. Items are tagged **[CSS-only]** (apply directly) or **[JS/structural]** (needs component + class changes — details noted).

---

## Highest leverage

### 1. Replace the pre-pick `confirm()` with instant-record + Undo — **[JS/structural]**
The biggest speed problem. A native `confirm()` on every pick is a blocking modal you must read and dismiss ~150 times under a clock — slow, jarring, and it steals keyboard focus. Fast tools don't ask permission; they make mistakes cheap to reverse.
- Draft immediately on `+` / Enter. Show a persistent, prominent **"Undo last pick"** in the topbar plus a toast: `Drafted Josh Allen → Team 4 · Undo`.
- Keep a real confirm ONLY for destructive Setup actions (Reset draft / Erase everything).
- Needs: `undoLastPick()` in `state.js`; a toast/undo affordance; remove `confirmDraft()` from both draft paths in `board.js` and `recs.js`.

### 2. The most important number is in the worst place — **[JS/structural]**
VALUE is what the engine ranks on, but it's the last of nine columns — the eye travels the full row width past six reference metrics to reach it. Reorder so the row reads:
`+ | Name/POS | VALUE | TIER | BYE | … | ECR | ADP | PROJ`
Decision-drivers next to the name; reference metrics pushed right.
- Needs: reorder the `COLUMNS` array in `board.js` and the matching `grid-template-columns` on `.player` / `.player-head`.

### 3. Make the status bar genuinely glanceable — **[CSS + small JS flag]**
`.stat-value` at 1.05rem is body-sized, not "readable across a room." The two stats that matter on the clock — **who's on the clock** and **picks until your turn** — should be hero-sized (~2–2.5rem); everything else secondary. Right now all five stats have equal weight, so none read fast.
- Needs: a `.stat-hero` class on those two stats (JS), then size in CSS.

---

## Table density & scanability (priority #1)

### 4. Header text is too small — **[CSS-only]**
`.col-head` at 0.62rem/800 uppercase is a squint. Bump to ~0.72rem, weight 700 (800 fills in at that size and hurts legibility). Same for `.stat-label` (0.68rem).

### 5. Reference numbers are muted into near-invisibility — **[CSS-only]**
ECR/TIER/BYE/ADP use `--muted` at 0.82rem — fine for a label, bad for a number you scan fast. Numbers should be `--text`; mute the *column header*, not the *value*. Reserve dimming for the missing-value `·` only.

### 6. Add tier separators — **[JS/structural]**
Tiers drive urgency ("only 2 left before the cliff"), but a tier is currently just a `T3` label you read row-by-row. When sorted by value/ECR, draw a subtle 1px rule between tier groups so cliffs read as *gaps*, not text. High signal, zero noise, static border (survives the wholesale re-render).
- Needs: `board.js` inserts a divider row (or a `data-tier-break` class on the first row of each tier) when the tier changes between adjacent rows.

### 7. Zebra striping or a stronger row rule — **[CSS-only]**
Nine numeric columns with only a hover highlight makes horizontal tracking error-prone. A 2–3% alternating row tint (derived from `--panel-2`, not hardcoded) keeps the eye on the right line. Hover stays as the active cue.

---

## Tag noise (priority #4 — noisy, agreed)

### 8. One loud signal per row, max — **[JS/structural]**
A single row can show POS chip + injury tag + N strategy tags + a tagnote line + a value-gap arrow — five competing colored things. Establish a hierarchy:
- **POS chip** — structural, always; keep as-is.
- **Injury** — collapse to a single colored dot/glyph; only `inj-bad` gets real color. Full status in the `title`.
- **Strategy tags** — cap at the 1–2 highest-priority per row; the rest live in the tagnote/tooltip. Desaturate "positive" tags (sleeper/breakout) to a quiet outline; reserve *fill* color for risk tags — a drafter needs warnings to pop, not praise.
- **value-gap arrow** — good; keep.
- Needs: a cap/priority on `p.tags` in `playerRow()`.

### 9. Strategy tag colors already don't identify — **[CSS-only]**
Three tags share one green, two share one red — so the *label* carries meaning, not the color. That's good for color blindness, but it means the color is decorative noise. Lean into it: fewer fills, let the labels do the work.

---

## Both themes must stay readable (constraint #4)

### 10. Light-theme `--warn`/`--good`/`--bad` used as TEXT will fail contrast — **[CSS-only]**
`.badge-fallback` and `.warn-inline` render amber (`#f2b544`) text on a pale amber background on white — well under 4.5:1. Same risk for green `--good` badge text. Dark mode is fine; light mode is the problem, and it's a daytime activity.
- Define text-safe variants for light mode (e.g. `--warn-ink` / `--good-ink` / `--bad-ink`), use those for text, keep the bright values for fills/borders.
- This ties to constraint #3: the **Claude-vs-fallback badge distinction must stay obvious**, and it currently leans entirely on the color that's weakest exactly where drafts happen. Add a non-color cue — a small glyph, or solid vs. dashed border — so "fallback" reads for a red-green colorblind user in light mode too.

---

## Smaller items

- **Column-drop at 1100px hides BYE** — but bye conflicts are a real decision input. Drop ECR (redundant with ADP for scanning) before BYE. **[CSS-only]**
- **Whole-row click target** — the `+` works for mouse, but making the whole row clickable (with `+` as the visual affordance) cuts aim time. **[JS/structural]**
- **Trust the Enter key** — Enter-drafts-top-match is great but invisible. Faintly highlight the top match row so users trust what Enter will do. **[JS + CSS]**
- **Per-position remaining counts** near the filter chips — the "is RB about to run dry" signal drafters want. **[JS/structural]**
- **Setup drawer** — no changes needed; the priority ranking is correct.

---

## Please keep (don't lose these in a rewrite)

- The `·`-for-missing convention.
- The `title` tooltips on every column header.
- `tabular-nums` on all numeric cells.
- Semantic-not-decorative position colors (the POS+rank *text* is the real identifier, which is why the print/greyscale cheat sheet survives).
- The wholesale-re-render-safe styling rule (no transition-dependent CSS).
