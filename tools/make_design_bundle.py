#!/usr/bin/env python3
"""Bundle the presentation layer into one file to hand to a design pass.

    python3 tools/make_design_bundle.py

Writes design-bundle.md — a brief plus every file that affects how the app
looks, and nothing that doesn't. Re-run it after changes; it is generated, not
maintained.

Why a bundle rather than a file list: the markup is produced in JavaScript by
an `el()` helper, not written as HTML, so a designer needs to see the
generators to know which classes exist and how the DOM nests. Handing over
styles.css alone invites a redesign against markup that isn't there.
"""

import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Ordered by how much they matter to the look, not alphabetically.
FILES = [
    ("index.html", "The whole page skeleton. Panels are filled in by JS at runtime."),
    ("styles.css", "Every style in the app. This is the main thing to rewrite."),
    ("js/ui/dom.js", "The el() helper. Read this first — it explains how all markup is built."),
    ("js/ui/board.js", "HIGHEST PRIORITY. The available-player table: sortable header, "
                       "dense rows, tags. This is what is on screen during a live draft."),
    ("js/ui/recs.js", "The recommendation panel — the second thing looked at on the clock."),
    ("js/ui/roster.js", "Your roster: starter slots, bench, bye conflicts."),
    ("js/ui/teams.js", "All ten teams' rosters as they fill."),
    ("js/ui/cheatsheet.js", "Printable fallback. There is a @media print block in styles.css "
                            "that must keep working."),
    ("js/ui/draft-prompt.js", "Shared confirm dialog. Tiny."),
    ("js/ui/settings.js", "LOWEST PRIORITY. The setup drawer — used before the draft, "
                          "not during it. Long; skim it for class names."),
]

BRIEF = """# Design pass — Fantasy Football Draft Assistant

## What this is

A single-page draft assistant used live during a fantasy football draft. The
user records all ten teams' picks as they happen, and the app shows what is
still available, what it is worth, and what to take next.

**It is used under a 60-second pick clock.** Legibility while scanning quickly
matters more than elegance. The user is reading a dense table, finding a name,
and clicking, in a few seconds, repeatedly, for about two hours.

## Hard constraints — please do not break these

1. **No build step, no bundler, no Node.** Plain ES modules loaded directly by
   the browser. Do not introduce Tailwind, PostCSS, Sass, or any tooling.
2. **No external requests.** No Google Fonts, no CDN, no remote images. The app
   must work opened from `file://` with no network. Use system font stacks and
   inline SVG or emoji only.
3. **The markup is generated in JavaScript**, via `el(tag, attrs, ...children)`
   in `js/ui/dom.js`. There is no HTML to edit for the panels. So:
   **hand back CSS, plus an explicit list of any class renames or structural
   changes you need**, and those will be applied to the JS. Do not return HTML
   files.
4. **Keep the theme tokens.** Colours are CSS custom properties on `:root`,
   with a `prefers-color-scheme: dark` override. Both themes must stay
   readable. Do not hardcode colours in component rules.
5. **Keep the print stylesheet working.** `@media print` hides everything
   except the cheat sheet, which gets printed as a paper fallback for draft
   night. It must still fit a page and stay readable in greyscale.
6. **Position colours are semantic**, not decorative: QB/RB/WR/TE/DST/K each
   have a fixed colour used consistently across the board, roster and team
   panels. They can change, but they must stay mutually distinguishable —
   including for the ~8% of men with red-green colour blindness.

## What is worth your attention, in order

1. **The player table** (`.player-list`, `.player`, `.cell-*`, `.col-head`).
   Nine columns of mostly numbers in a narrow column. Currently a CSS grid with
   a sticky sortable header. Density, alignment and scan-ability are everything
   here. Numeric columns use `font-variant-numeric: tabular-nums`.
2. **The status bar** (`.topbar`, `.stat`). Pick number, round, who is on the
   clock, picks until your turn. Must be readable at a glance from a distance.
3. **The recommendation panel** (`.rec-*`, `.badge`). One primary pick plus
   alternatives and a rationale. The green/amber badge distinguishes a real
   model response from a deterministic fallback and that distinction must stay
   obvious.
4. **Tags and badges** (`.tag`, `.strat-*`, `.inj`, `.value-gap`). There are a
   lot of small coloured chips. They are currently close to noisy; a clearer
   hierarchy would help a great deal.
5. **The league-rosters grid** (`.team-*`). Ten cards showing what every team
   has taken.
6. The setup drawer is used before the draft and matters least.

## Things that are deliberate, not accidental

- The available-player list is capped at 200 rows for rendering speed.
- `·` is shown for a missing numeric value rather than a blank, so an empty
  cell is distinguishable from a zero.
- Every column header has a `title` tooltip explaining the metric. Keep them.
- The board re-renders wholesale on every pick, so avoid CSS that depends on
  transition state surviving a re-render.
"""


def main():
    parts = [BRIEF, "\n---\n"]

    try:
        rev = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT,
                             capture_output=True, text=True).stdout.strip()
    except Exception:
        rev = "unknown"
    parts.append(f"\n_Generated from commit `{rev}`._\n")

    # Class inventory: what the JS actually asks the CSS for.
    classes = set()
    for rel, _ in FILES:
        if not rel.endswith(".js"):
            continue
        with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
            for line in f:
                if "class:" in line:
                    seg = line.split("class:", 1)[1]
                    for tok in seg.replace("'", " ").replace('"', " ").replace("`", " ").split():
                        tok = tok.strip("`+,{}()[]")
                        if tok and tok.replace("-", "").isalnum() and not tok[0].isdigit():
                            classes.add(tok)
    parts.append("\n## Classes referenced from JavaScript\n\n"
                 "If you rename any of these, say so explicitly — they live in the JS.\n\n```\n"
                 + "  ".join(sorted(classes)) + "\n```\n")

    total = 0
    for rel, note in FILES:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            print(f"  missing, skipped: {rel}")
            continue
        with open(path, encoding="utf-8") as f:
            body = f.read()
        total += len(body)
        lang = "html" if rel.endswith(".html") else "css" if rel.endswith(".css") else "javascript"
        parts.append(f"\n---\n\n## `{rel}`\n\n{note}\n\n```{lang}\n{body}\n```\n")

    out = os.path.join(ROOT, "design-bundle.md")
    with open(out, "w", encoding="utf-8") as f:
        f.write("".join(parts))

    print(f"Wrote {out}")
    print(f"  {len(FILES)} files, {total:,} bytes of source, "
          f"{os.path.getsize(out):,} bytes total")
    print("\nHand that single file to the design pass.")


if __name__ == "__main__":
    main()
