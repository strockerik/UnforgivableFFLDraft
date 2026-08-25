"""Fetch ESPN's 2026 season projections as an INDEPENDENT check on the pool.

    python3 tools/fetch_espn.py                  # write data/espn-projections.json
    python3 tools/fetch_espn.py --verify         # reconstruct ESPN's own totals and stop

Why this exists: every number the draft assistant uses -- value, tiers, ECR,
ADP -- comes from FantasyPros. The debrief then grades the draft with those
same numbers, so "starting lineup value 459 to second place's 402" is the
engine marking its own homework. A second projection source, scored under the
same league rules and the same VORP method, is the only way to tell a good
draft from a self-consistent one.

This writes RAW STAT LINES, not ESPN's point totals. ESPN's `appliedTotal` is
computed under ESPN's default scoring (1 PPR, 4-point passing TDs), which is
not this league (0.5 PPR, 6-point passing TDs, -1 per interception). Feeding
those totals in would measure the difference between two scoring systems and
call it a difference of opinion. Stats go in, `leaguePoints()` in js/vorp.js
scores them exactly as it scores the FantasyPros lines, and the projection
source becomes the only variable that changed.

Output keys match the shape js/vorp.js expects (pass_yds, rec_rec, ...) under
the same normalized name key players.js uses.

The data is third-party and gitignored, like the FantasyPros pool.
"""

import argparse
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "espn-projections.json")
URL = ("https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026"
       "/segments/0/leaguedefaults/3?view=kona_player_info")

SUFFIXES = {"JR", "SR", "II", "III", "IV", "V"}

# ESPN's stat identifiers, verified against a reconstruction of their own
# appliedTotal before being trusted -- see --verify. Guessing these silently
# produces plausible-looking nonsense, which is the failure this whole script
# exists to catch, so it would be a poor place to assume.
STAT_IDS = {
    "3": "pass_yds", "4": "pass_tds", "20": "pass_ints",
    "24": "rush_yds", "25": "rush_tds",
    "42": "rec_yds", "43": "rec_tds", "53": "rec_rec",
    "72": "fumbles",
}
# Two-point conversions arrive split by how they were scored; the app carries a
# single combined figure.
TWO_PT_IDS = ("19", "26", "44")
# Kick and punt return touchdowns, likewise split. Found by the --verify guard:
# omitting them left Rashid Shaheed 5.4 points short, because a return man earns
# a real share of his total this way.
RET_TD_IDS = ("101", "102")

POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE"}
# Kickers and defences are deliberately excluded. They score from stat families
# this script does not map (sacks, points allowed, field-goal distance), so a
# reconstruction check on them is meaningless -- the Texans D/ST came out 128
# points adrift. They are also the two positions where the comparison would
# prove least: both sit within a point or two of replacement level, so holding
# them at their FantasyPros values changes no team's ranking.


def name_key(name):
    toks = re.sub(r"[^A-Z0-9\s]", "", str(name).upper()).split()
    return "".join(t for t in toks if t not in SUFFIXES)


def _ssl_context():
    try:
        ctx = ssl.create_default_context()
        if ctx.cert_store_stats().get("x509_ca", 0) > 0:
            return ctx
    except Exception:
        pass
    for candidate in ("/etc/ssl/cert.pem", "/private/etc/ssl/cert.pem"):
        if os.path.exists(candidate):
            return ssl.create_default_context(cafile=candidate)
    return ssl.create_default_context()


def fetch(limit):
    filt = {"players": {"limit": limit,
                        "sortDraftRanks": {"sortPriority": 100, "sortAsc": True, "value": "PPR"}}}
    req = urllib.request.Request(URL, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        "Accept": "application/json",
        "x-fantasy-filter": json.dumps(filt),
    })
    try:
        with urllib.request.urlopen(req, timeout=120, context=_ssl_context()) as resp:
            return json.load(resp)["players"]
    except urllib.error.HTTPError as err:
        sys.exit(f"HTTP {err.code} from ESPN: {err.read().decode('utf-8', 'replace')[:200]}")
    except urllib.error.URLError as err:
        sys.exit(f"Could not reach ESPN: {err.reason}")
    except (KeyError, ValueError) as err:
        sys.exit(f"Unexpected ESPN response shape: {err}")


def season_projection(player):
    """The 2026 season-total projection: source 1 (projected), split 0 (season)."""
    for s in player.get("stats", []):
        if (s.get("seasonId") == 2026 and s.get("statSourceId") == 1
                and s.get("statSplitTypeId") == 0):
            return s
    return None


def to_stat_line(raw):
    line = {}
    for espn_id, key in STAT_IDS.items():
        v = raw.get(espn_id)
        if v:
            line[key] = round(float(v), 1)
    two = sum(float(raw.get(i, 0) or 0) for i in TWO_PT_IDS)
    if two:
        line["2pt_tds"] = round(two, 1)
    ret = sum(float(raw.get(i, 0) or 0) for i in RET_TD_IDS)
    if ret:
        line["ret_tds"] = round(ret, 2)
    return line


def espn_default_points(line):
    """Rebuild ESPN's OWN total from the stat line, to prove the ID mapping.

    ESPN default scoring: 1 point per reception, 4-point passing TDs, -2 per
    interception, 1 point per 25 passing yards and per 10 rushing/receiving.
    If this lands on their appliedTotal the IDs are right; if it does not, the
    mapping is wrong and every downstream number would be quiet garbage.
    """
    g = lambda k: float(line.get(k, 0) or 0)
    return (g("pass_yds") / 25 + g("pass_tds") * 4 + g("pass_ints") * -2
            + g("rush_yds") / 10 + g("rush_tds") * 6
            + g("rec_rec") * 1 + g("rec_yds") / 10 + g("rec_tds") * 6
            + g("fumbles") * -2 + g("2pt_tds") * 2 + g("ret_tds") * 6)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=900)
    ap.add_argument("--verify", action="store_true",
                    help="check the stat-ID mapping against ESPN's own totals and exit")
    args = ap.parse_args()

    print(f"Fetching ESPN 2026 projections (limit {args.limit}) ...")
    raw = fetch(args.limit)
    print(f"  {len(raw)} player records")

    out = {}
    checked = worst = 0
    worst_name = None
    for rec in raw:
        p = rec.get("player") or {}
        name = p.get("fullName")
        pos = POS.get(p.get("defaultPositionId"))
        proj = season_projection(p)
        if not name or not pos or not proj:
            continue
        line = to_stat_line(proj.get("stats") or {})
        if not line:
            continue

        # Verify the ID mapping on anyone with a real projection. Restricted to
        # the four positions above, whose points come entirely from the mapped
        # stats -- so any error here is a mapping error and not a missing family.
        applied = proj.get("appliedTotal")
        if applied and applied > 20:
            diff = abs(espn_default_points(line) - applied)
            checked += 1
            if diff > worst:
                worst, worst_name = diff, name

        key = name_key(name)
        if key and key not in out:
            out[key] = {"name": name, "pos": pos, "projStats": line,
                        "espnTotal": round(applied, 1) if applied else None}

    print(f"  reconstructed ESPN's own total for {checked} players; "
          f"worst error {worst:.1f} pts ({worst_name})")
    if worst > 3.0:
        sys.exit("Stat-ID mapping looks wrong -- refusing to write a file that would "
                 "silently corrupt a comparison. Inspect STAT_IDS against the raw payload.")
    print("  mapping verified.")

    if args.verify:
        print("\n--verify: nothing written.")
        return

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"source": URL, "season": 2026, "count": len(out), "players": out}, f, indent=1)
    print(f"\nWrote {len(out)} projections to {os.path.relpath(OUT, ROOT)}")
    from collections import Counter
    for pos, n in Counter(v["pos"] for v in out.values()).most_common():
        print(f"  {pos:4} {n}")


if __name__ == "__main__":
    main()
