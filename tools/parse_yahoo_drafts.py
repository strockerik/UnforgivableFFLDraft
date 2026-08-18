"""Parse saved Yahoo draft-results pages into data/draft-history.json.

Yahoo revoked Fantasy API access (see CLAUDE.md), but the web UI still shows
full draft results to league members. Save each season's "Draft Results" and
"Managers" page from the browser into data/Yahoo/, then run this.

    python3 tools/parse_yahoo_drafts.py
    python3 tools/parse_yahoo_drafts.py --write

Page structure, as of the 2022-2025 saves:
  Draft Results  one <table> per team, in draft-slot order. Header row is the
                 team name; each body row is round / (overall pick) / player,
                 with the Yahoo player id in the anchor href.
  Managers       a single table mapping team name -> manager name.

Teams get renamed between seasons; managers mostly do not. Joining on the
manager is what makes a multi-season tendency profile possible at all, so the
Managers pages are not optional.

Positions are NOT in the draft pages. They are inferred by matching against
data/players.json, which only covers currently-relevant players -- a 2022 pick
who has since retired will not match. Unmatched picks are reported and marked
pos=null rather than guessed at, because a wrong position would silently skew
every tendency this feeds.

Emails appear on the Managers page. They are deliberately not extracted.
"""

import argparse
import glob
import html
import json
import os
import re
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE_DIR = os.path.join(ROOT, "data", "Yahoo")
POOL = os.path.join(ROOT, "data", "players.json")
OUT = os.path.join(ROOT, "data", "draft-history.json")

SUFFIXES = {"JR", "SR", "II", "III", "IV", "V"}

# Players drafted in 2022-2025 who have since left the current FantasyPros
# pool, so no automatic position lookup is possible. Curated by hand rather
# than inferred: a wrong position here would skew a manager's positional
# profile permanently, and these are all well-known enough to be unambiguous.
# Anything genuinely uncertain belongs as None, not a guess.
RETIRED_POSITIONS = {
    "Adam Thielen": "WR", "Allen Lazard": "WR", "Allen Robinson": "WR",
    "Amari Cooper": "WR", "Chase Claypool": "WR", "Hunter Renfrow": "WR",
    "Julio Jones": "WR", "Kadarius Toney": "WR", "Michael Thomas": "WR",
    "Mike Williams": "WR", "Robert Woods": "WR", "Ricky Pearsall": "WR",
    "Chase Edmonds": "RB", "Cordarrelle Patterson": "RB", "Dalvin Cook": "RB",
    "Damien Harris": "RB", "Ezekiel Elliott": "RB", "James Robinson": "RB",
    "Jamaal Williams": "RB", "Leonard Fournette": "RB", "Melvin Gordon III": "RB",
    "Nyheim Miller-Hines": "RB", "Rashaad Penny": "RB",
    "Derek Carr": "QB", "Jimmy Garoppolo": "QB", "Matt Ryan": "QB",
    "Russell Wilson": "QB", "Tom Brady": "QB",
    "Irv Smith Jr.": "TE", "Jimmy Graham": "TE",
    # Sleeper lists him without the "V", which name_key strips as a suffix.
    "Will Fuller V": "WR",
    "Dustin Hopkins": "K", "Greg Zuerlein": "K", "Justin Tucker": "K",
    "Matt Gay": "K", "Quinn Nordin": "K", "Younghoe Koo": "K",
}


def name_key(name):
    """Match players.js nameKey(): upper, strip punctuation and suffixes."""
    toks = re.sub(r"[^A-Z0-9\s]", "", str(name).upper()).split()
    return "".join(t for t in toks if t not in SUFFIXES)


def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s)).strip()


def tables(src):
    """Yield the inner HTML of each <table>."""
    for m in re.finditer(r"<table[^>]*>", src):
        start = m.end()
        end = src.find("</table>", start)
        if end != -1:
            yield src[start:end]


def rows_of(tbl):
    for r in re.findall(r"<tr[^>]*>(.*?)</tr>", tbl, re.S):
        yield re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", r, re.S)


def parse_draft_page(path):
    """-> (teams_in_slot_order, picks). Slot order is table order on the page."""
    with open(path, encoding="utf-8", errors="replace") as f:
        src = f.read()

    teams, picks = [], []
    for tbl in tables(src):
        rs = list(rows_of(tbl))
        if len(rs) < 2:
            continue
        header = [strip_tags(c) for c in rs[0]]
        # A team's draft table has a single-cell header holding the team name.
        if len(header) != 1 or not header[0]:
            continue
        team = html.unescape(header[0])
        slot = len(teams) + 1
        teams.append(team)

        for cells in rs[1:]:
            if len(cells) < 3:
                continue
            rnd = strip_tags(cells[0]).rstrip(".")
            pick = strip_tags(cells[1]).strip("()")
            if not rnd.isdigit() or not pick.isdigit():
                continue
            anchor = cells[2]
            pid = None
            m = re.search(r"/nfl/players/(\d+)", anchor)
            if m:
                pid = m.group(1)
            picks.append({
                "round": int(rnd),
                "pick": int(pick),
                "slot": slot,
                "team": team,
                "player": html.unescape(strip_tags(anchor)),
                "yahooId": pid,
            })
    return teams, picks


def clean_manager(name):
    """Yahoo appends the commissioner title to whoever holds it, and the title
    moved between people over ten seasons. Left alone it splits one person into
    two identities ('erik' / 'erik Commissioner') and halves their sample."""
    return re.sub(r"\s+Commissioner$", "", str(name).strip(), flags=re.I).strip()


def parse_managers_page(path):
    """-> {team name: manager name}. Emails are ignored on purpose."""
    with open(path, encoding="utf-8", errors="replace") as f:
        src = f.read()
    out = {}
    for tbl in tables(src):
        rs = list(rows_of(tbl))
        if not rs:
            continue
        header = [strip_tags(c).lower() for c in rs[0]]
        if "team name" not in header or "manager" not in header:
            continue
        ti, mi = header.index("team name"), header.index("manager")
        for cells in rs[1:]:
            if len(cells) <= max(ti, mi):
                continue
            team = html.unescape(strip_tags(cells[ti]))
            mgr = clean_manager(html.unescape(strip_tags(cells[mi])))
            if team and mgr:
                out[team] = mgr
    return out


def load_positions():
    """name_key -> pos, from the current FantasyPros pool."""
    try:
        with open(POOL, encoding="utf-8") as f:
            pool = json.load(f)["players"]
    except (OSError, ValueError, KeyError):
        return {}, {}
    by_key = {}
    dst_nick = {}
    for p in pool:
        by_key[name_key(p["name"])] = p["pos"]
        if p["pos"] == "DST":
            # Draft pages name defences by nickname only ("Commanders").
            dst_nick[name_key(p["name"].split()[-1])] = "DST"
    # Ten seasons of history reach well past the current pool. The Sleeper
    # cache covers retired players; the hand-curated map stays as a fallback
    # for anyone it misses.
    cache = os.path.join(ROOT, "data", "player-positions.json")
    try:
        with open(cache, encoding="utf-8") as f:
            for key, pos in json.load(f)["positions"].items():
                by_key.setdefault(key, pos)
    except (OSError, ValueError, KeyError):
        print("  (no data/player-positions.json — run tools/fetch_player_positions.py "
              "for pre-2022 coverage)")
    for name, pos in RETIRED_POSITIONS.items():
        by_key.setdefault(name_key(name), pos)
    return by_key, dst_nick


def manager_resolver(managers_by_season):
    """team name -> manager, tolerant of mid-season renames.

    The draft page records a team's name on draft day; the Managers page
    records it whenever the page was saved. Six of ten teams renamed during
    2024 alone, so a same-season name join silently loses most of that draft.
    Falling back to other seasons recovers them, but only when the name maps
    to exactly one manager league-wide -- an ambiguous name is left unresolved
    rather than attributed to the wrong person.
    """
    everywhere = defaultdict(set)
    for mgrs in managers_by_season.values():
        for team, mgr in mgrs.items():
            everywhere[team].add(mgr)

    def resolve(team, season):
        same = managers_by_season.get(season, {}).get(team)
        if same:
            return same, "same-season"
        hits = everywhere.get(team, set())
        if len(hits) == 1:
            return next(iter(hits)), "other-season"
        return None, "ambiguous" if hits else "unknown"

    return resolve


def season_of(path):
    m = re.search(r"(20\d\d)", os.path.basename(path))
    return int(m.group(1)) if m else None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true", help=f"write {os.path.relpath(OUT, ROOT)}")
    ap.add_argument("--dir", default=PAGE_DIR)
    args = ap.parse_args()

    draft_pages = sorted(glob.glob(os.path.join(args.dir, "*Draft Results*.html")))
    mgr_pages = sorted(glob.glob(os.path.join(args.dir, "*Managers*.html")))
    if not draft_pages:
        sys.exit(f"No '*Draft Results*.html' found in {args.dir}")

    managers_by_season = {}
    for p in mgr_pages:
        s = season_of(p)
        if s:
            managers_by_season[s] = parse_managers_page(p)

    by_key, dst_nick = load_positions()
    resolve = manager_resolver(managers_by_season)
    seasons, unmatched = {}, defaultdict(list)

    for path in draft_pages:
        s = season_of(path)
        teams, picks = parse_draft_page(path)
        renamed = set()
        for pk in picks:
            k = name_key(pk["player"])
            pos = by_key.get(k) or dst_nick.get(k)
            pk["pos"] = pos
            mgr, how = resolve(pk["team"], s)
            pk["manager"] = mgr
            if how == "other-season":
                renamed.add(pk["team"])
            if pos is None:
                unmatched[s].append(pk["player"])
        seasons[s] = {"teams": teams, "picks": picks,
                      "managers": managers_by_season.get(s, {}),
                      "rounds": max((p["round"] for p in picks), default=0)}
        named = sum(1 for p in picks if p["manager"])
        note = f", {len(renamed)} teams renamed since draft day" if renamed else ""
        print(f"  {s}: {len(teams)} teams, {len(picks)} picks, "
              f"{len(picks) - len(unmatched[s])}/{len(picks)} positions matched, "
              f"{named}/{len(picks)} manager-attributed{note}")

    print()
    total = sum(len(v["picks"]) for v in seasons.values())
    miss = sum(len(v) for v in unmatched.values())
    print(f"  {total} picks across {len(seasons)} seasons; {miss} without a position "
          f"({100 * miss / total:.0f}%)")

    if miss:
        print("\n  Unmatched (not in the current FantasyPros pool — mostly retired):")
        for s in sorted(unmatched):
            if unmatched[s]:
                sample = ", ".join(sorted(set(unmatched[s]))[:8])
                print(f"    {s}: {len(unmatched[s])} — {sample}"
                      + (" ..." if len(set(unmatched[s])) > 8 else ""))

    # Managers are the join key across seasons; show how stable they are.
    print("\n  Manager continuity:")
    appear = defaultdict(set)
    for s, v in seasons.items():
        for mgr in v["managers"].values():
            appear[mgr].add(s)
    for mgr, yrs in sorted(appear.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        print(f"    {mgr:22} {' '.join(str(y) for y in sorted(yrs))}")

    if args.write:
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump({"seasons": seasons,
                       "generatedFrom": [os.path.basename(p) for p in draft_pages]},
                      f, indent=1)
        print(f"\nWrote {os.path.relpath(OUT, ROOT)}")
    else:
        print("\n(dry run — pass --write to save)")


if __name__ == "__main__":
    main()
