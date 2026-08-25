# Draft morning — 2026-08-30

Run top to bottom. **The order of the first two commands matters**: the
FantasyPros fetch rewrites `data/players.json` wholesale and wipes the injury
fields, so injuries must be merged *after* it, never before.

## 1. Refresh the data (~5 minutes)

```sh
cd "~/Desktop/myStuff/Apps/Fantasy Football Draft"

python3 tools/fetch_fantasypros.py --season 2026 --scoring HALF --projections
python3 tools/fetch_espn.py              # 2nd projection source
python3 tools/fetch_cbs.py               # 3rd projection source
python3 tools/fetch_draftsharks.py       # 4th (RB/WR/TE only — see its docstring)
python3 tools/fetch_injuries.py          # MUST run last — see above
```

The FantasyPros fetch rewrites the pool from scratch, so both of the others
have to follow it. Each prints the next command as a reminder.

Sanity-check what you got:

```sh
python3 tools/fetch_injuries.py --stats
```

Expect a few hundred players and a "high" list you recognise. If the high list
is empty on draft morning, something failed — a real preseason always has
players on PUP and IR.

## 2. Load it into the app

Serve and open:

```sh
python3 -m http.server 8000
```

Then in the app: **Load `data/players.json`** (the button — `fetch()` is blocked
on `file://`, so this needs the http origin).

Confirm in Setup:

- Value mode names **FantasyPros, ESPN, CBS and Draft Sharks** with a player
  count in the hundreds. "VORP from projected points" alone means the extra
  merges didn't run; the rank surrogate means `--projections` didn't come
  through.
- **QB1 RB2 WR3 TE1 FLEX1 DST1 K1, 5 bench** — 10 teams, 15 rounds.
- Scoring shows **6-point passing TDs, −1 INT, 0.5 PPR**.
- No parse warnings sitting unread at the bottom of the panel.

## 3. Set the real draft order, once the draw happens

Setup → section 4. **Move the Erik row with the ↑↓ arrows.** Do not use "set" —
it renumbers the slot without moving you in the order, and the opponent model
then attributes every coach's habits to the wrong seat.

Check the header afterwards: it should show your true slot and the correct
picks-until-your-turn.

## 4. Model and budget

- **Use Opus 5.** Haiku is wired and works, but this is the one day of the year
  the difference is worth paying for.
- Confirm the Anthropic spend cap is set and the passphrase works — press
  **Ask Claude** once on a dummy board before the room fills up. A key problem
  discovered on the clock is a bad time to discover it.
- The app is fully usable with no key at all. If Claude fails, every pick falls
  back to the deterministic engine with a visible badge, and the engine is the
  source of truth anyway.

## 5. What to trust while drafting

- **The engine's ranking is the default.** It owns value, attrition, roster
  needs, caps and byes.
- **Claude adds injuries, and explanation.** That is now a real channel, not an
  empty one.
- **If the override banner appears**, read it. It names the engine's pick and
  the point gap. Override the engine for an injury or a genuine news item;
  don't override it for a rearrangement of numbers already on screen.
- Watch for a **red PUP/IR/OUT chip** on the board — the engine does not read
  injuries, so an injured player can sit at the top of the board looking fine.

## Strategy document

`data/strategy.md` does **not** need a rebuild. The bust list is a 2026
consensus across eight sources and the tags are current.

Optional, if you want to spend the time:

- The **sleeper/breakout list** was never researched to the same eight-source
  depth as the busts (five sources gathered). Worth an hour if you want the
  upside quota drawing from a stronger pool.
- Anything you hear in the last few days — a holdout, a depth-chart move — can
  be added as a tag. The format and the "HOW TO READ THE BUST TAGS" section at
  the top of the file explain themselves.

Re-loading strategy.md is a separate button from the pool; both must be loaded.

## Known gaps, so nothing surprises you

- **No live news during the draft.** The injury data is a snapshot from when you
  ran the script that morning. If something breaks in the room, you are the
  channel — say it out loud to yourself and adjust; the app will not know.
- **Opponent model is timing-only.** It predicts *when* positions disappear, not
  who specifically gets taken.
- **Mock-draft opponents are simulated.** Practice results are for judging your
  own decisions, not for reading anything into the field.
