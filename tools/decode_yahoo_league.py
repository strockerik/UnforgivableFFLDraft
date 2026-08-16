#!/usr/bin/env python3
"""Decode a Yahoo league_settings.json into app settings and a readable summary.

    python3 tools/decode_yahoo_league.py
    python3 tools/decode_yahoo_league.py --in data/league_settings.json --write

Yahoo encodes scoring as numeric stat IDs. The mapping below is the standard
NFL set. Anything unrecognized is printed as UNKNOWN rather than guessed at,
because a silently mis-decoded rule would quietly skew every valuation.

The reason this matters beyond bookkeeping: default FantasyPros rankings assume
4-point passing touchdowns. A league using 6 shifts QB value substantially, and
nothing downstream can detect that from the rankings file alone.
"""

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Yahoo NFL stat IDs. Grouped for the printed summary.
STATS = {
    4:  ("Passing Yards", "pass_yd"),
    5:  ("Passing TD", "pass_td"),
    6:  ("Interceptions Thrown", "pass_int"),
    9:  ("Rushing Yards", "rush_yd"),
    10: ("Rushing TD", "rush_td"),
    11: ("Receptions", "reception"),
    12: ("Receiving Yards", "rec_yd"),
    13: ("Receiving TD", "rec_td"),
    14: ("Return Yards", "ret_yd"),
    15: ("Return TD", "ret_td"),
    16: ("2-Point Conversion", "two_pt"),
    18: ("Fumbles Lost", "fum_lost"),
    19: ("Field Goal 0-19", "fg_0_19"),
    20: ("Field Goal 20-29", "fg_20_29"),
    21: ("Field Goal 30-39", "fg_30_39"),
    22: ("Field Goal 40-49", "fg_40_49"),
    23: ("Field Goal 50+", "fg_50"),
    24: ("Field Goal Missed", "fg_miss"),
    29: ("PAT Made", "pat_made"),
    30: ("PAT Missed", "pat_miss"),
    32: ("Sack", "def_sack"),
    33: ("Interception", "def_int"),
    34: ("Fumble Recovery", "def_fum_rec"),
    35: ("Touchdown", "def_td"),
    36: ("Safety", "def_safety"),
    37: ("Block Kick", "def_block"),
    49: ("Return TD", "def_ret_td"),
    50: ("Points Allowed 0", "pa_0"),
    51: ("Points Allowed 1-6", "pa_1_6"),
    52: ("Points Allowed 7-13", "pa_7_13"),
    53: ("Points Allowed 14-20", "pa_14_20"),
    54: ("Points Allowed 21-27", "pa_21_27"),
    55: ("Points Allowed 28-34", "pa_28_34"),
    56: ("Points Allowed 35+", "pa_35_plus"),
    57: ("Offensive Fumble Return TD", "off_fum_ret_td"),
    82: ("Extra Point Returned", "xp_returned"),
}

GROUPS = [
    ("Passing", [4, 5, 6]),
    ("Rushing", [9, 10]),
    ("Receiving", [11, 12, 13]),
    ("Misc offense", [14, 15, 16, 18, 57]),
    ("Kicking", [19, 20, 21, 22, 23, 24, 29, 30]),
    ("Defense / ST", [32, 33, 34, 35, 36, 37, 49, 82]),
    ("Points allowed", [50, 51, 52, 53, 54, 55, 56]),
]


def num(v):
    try:
        f = float(v)
        return int(f) if f.is_integer() else round(f, 4)
    except (TypeError, ValueError):
        return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="path", default=os.path.join(ROOT, "data", "league_settings.json"))
    ap.add_argument("--write", action="store_true",
                    help="Write data/league.json for the app to read")
    args = ap.parse_args()

    if not os.path.exists(args.path):
        sys.exit(f"Not found: {args.path}")
    with open(args.path, encoding="utf-8") as f:
        raw = json.load(f)

    scoring = {}
    bonuses = {}
    unknown = []
    for entry in raw.get("stat_modifiers", {}).get("stats", []):
        s = entry.get("stat", {})
        sid = s.get("stat_id")
        if sid not in STATS:
            unknown.append((sid, s.get("value")))
            continue
        _, key = STATS[sid]
        scoring[key] = num(s.get("value"))
        for b in s.get("bonuses") or []:
            bb = b.get("bonus", {})
            bonuses.setdefault(key, []).append(
                {"target": num(bb.get("target")), "points": num(bb.get("points"))})

    print(f"League: {raw.get('name')}   ({raw.get('num_teams')} teams, "
          f"{raw.get('scoring_type')}, season {raw.get('season')})")
    print()
    for label, ids in GROUPS:
        rows = [(STATS[i][0], scoring.get(STATS[i][1]), bonuses.get(STATS[i][1]))
                for i in ids if STATS[i][1] in scoring]
        if not rows:
            continue
        print(f"  {label}")
        for name, val, bon in rows:
            extra = ""
            if bon:
                extra = "   bonus: " + ", ".join(f"+{b['points']} at {b['target']}" for b in bon)
            print(f"    {name:<28} {val!s:>8}{extra}")
        print()

    if unknown:
        print("  UNKNOWN stat ids (not decoded, verify in Yahoo):")
        for sid, val in unknown:
            print(f"    stat_id {sid} = {val}")
        print()

    # The handful of values that actually move draft strategy.
    rec = scoring.get("reception", 0)
    fmt = "PPR" if rec >= 1 else "Half-PPR" if rec >= 0.5 else "Standard"
    pass_td = scoring.get("pass_td", 4)

    print("  What this changes for the draft")
    print(f"    Scoring format          {fmt}  ({rec} per reception)")
    print(f"    Passing TD              {pass_td} points", end="")
    if pass_td >= 6:
        print("   <-- NON-STANDARD. Default rankings assume 4.")
    else:
        print()
    print(f"    Interception            {scoring.get('pass_int')} points", end="")
    if scoring.get("pass_int", -1) <= -2:
        print("   (harsher than typical, discounts volatile QBs)")
    else:
        print()
    if bonuses:
        print("    Yardage bonuses         present — rewards high-ceiling weeks over steady floors")

    out = {
        "name": raw.get("name"),
        "leagueId": raw.get("league_id"),
        "season": raw.get("season"),
        "teams": num(raw.get("num_teams")),
        "scoringFormat": fmt,
        "scoring": scoring,
        "bonuses": bonuses,
        "sourceSeason": raw.get("season"),
    }

    if args.write:
        dest = os.path.join(ROOT, "data", "league.json")
        with open(dest, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=1)
        print(f"\n  wrote {dest}")

    print("\n  NOT in this file — set these by hand in the app:")
    print("    - Roster composition (QB/RB/WR/TE/FLEX/K/DST counts) lives in a")
    print("      separate Yahoo endpoint, not in league settings.")
    print("    - Your draft slot, which you won't know until the draft.")


if __name__ == "__main__":
    main()
