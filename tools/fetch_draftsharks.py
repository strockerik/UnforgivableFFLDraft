"""Fetch Draft Sharks projections as a fourth source, plus floor/ceiling bands.

    python3 tools/fetch_draftsharks.py             # merge into data/players.json
    python3 tools/fetch_draftsharks.py --dry-run   # fetch and report, write nothing

Draft Sharks is an independent projection house, not an aggregator, so it adds a
genuinely new opinion rather than re-sampling analysts FantasyPros already
consensuses. It also publishes two things no other source here does: an explicit
floor and ceiling for every player, and an injury-risk percentage.

WHAT MAKES THIS ONE DIFFERENT, AND MORE FRAGILE
-----------------------------------------------
The other three sources publish raw stat lines, so js/vorp.js can score them
under this league's exact rules. Draft Sharks publishes only a POINT TOTAL, and
the scoring behind it is not stated on the page.

That was determined empirically rather than assumed. Comparing 159 matched
players against the blended pool, the ratio of their number to ours came out
position-dependent -- QB 0.941, RB 0.919, WR 0.825, TE 0.752 -- and the
positions furthest off were the most reception-dependent, which is the signature
of a scoring difference rather than a forecasting one. Adding back half a point
per reception collapsed it: RB 1.015, WR 1.036, TE 0.988. Draft Sharks is
publishing STANDARD (non-PPR) scoring.

So RB, WR and TE are converted by adding 0.5 x their consensus receptions, in
js/vorp.js where the stat lines live.

QUARTERBACKS ARE DELIBERATELY EXCLUDED. The same correction overshoots them
(1.136), so whatever passing-touchdown and interception values Draft Sharks uses
are not the 4 and -2 that would explain the gap, and there is no way to read
their scoring from outside. This league pays 6 per passing touchdown, which
makes quarterback valuation unusually sensitive -- exactly the wrong place to
blend in a number whose basis is a guess. Three sources still cover QB.

The reception correction does couple this source slightly to the others, since
the reception count comes from their consensus. That is a real caveat and worth
stating: what stays independent is Draft Sharks' view of yardage and touchdowns,
which is the bulk of the signal. Receptions are the least-disputed statistic in
the pool, so borrowing them to convert scoring costs little.

Source is the AJAX endpoint the rankings page itself calls; the page renders
only 25 rows, the endpoint returns 250.
"""

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POOL = os.path.join(ROOT, "data", "players.json")
URL = "https://www.draftsharks.com/rankings/load-table"
REFERER = "https://www.draftsharks.com/rankings"

SUFFIXES = {"JR", "SR", "II", "III", "IV", "V"}
# Quarterbacks excluded on purpose -- see the module docstring.
WANTED = {"RB", "WR", "TE"}

# Column offsets in the rendered row, verified against the table's own headers:
# RK, Player, Games, ADP, Bye, SOS, InjuryRisk, Floor, Consensus, DS Proj,
# Ceiling, 3D Value.
COL_INJURY_RISK, COL_FLOOR, COL_PROJ, COL_CEILING = 6, 7, 9, 10


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


def fetch():
    req = urllib.request.Request(URL, headers={
        "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"),
        "Accept": "text/html,application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": REFERER,
    })
    try:
        with urllib.request.urlopen(req, timeout=90, context=_ssl_context()) as resp:
            return resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        sys.exit(f"HTTP {err.code} from Draft Sharks: "
                 f"{err.read().decode('utf-8', 'replace')[:200]}")
    except urllib.error.URLError as err:
        sys.exit(f"Could not reach Draft Sharks: {err.reason}")


def cell_text(html):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()


def to_num(s):
    s = re.sub(r"[^0-9.\-]", "", s or "")
    try:
        return float(s)
    except ValueError:
        return None


def parse(html):
    out = {}
    skipped_pos = 0
    blocks = re.findall(r"<tbody[^>]*data-player-row(.*?)</tbody>", html, re.S)
    for b in blocks:
        name = re.search(r'data-player-name="([^"]*)"', b)
        name = name.group(1) if name else None
        pos = re.search(r'data-fantasy-position="([^"]*)"', b)
        pos = pos.group(1) if pos else None
        if not name or not pos:
            continue
        if pos not in WANTED:
            skipped_pos += 1
            continue
        cells = [cell_text(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", b, re.S)]
        if len(cells) <= COL_CEILING:
            continue
        proj = to_num(cells[COL_PROJ])
        if proj is None:
            continue
        key = name_key(name)
        if not key or key in out:
            continue
        out[key] = {
            "name": name,
            "pos": pos,
            # Named for what it IS, not what we want it to be. js/vorp.js
            # converts it; storing it as "points" would invite someone to blend
            # a non-PPR total straight into a half-PPR league.
            "standardPoints": proj,
            "floor": to_num(cells[COL_FLOOR]),
            "ceiling": to_num(cells[COL_CEILING]),
            "injuryRisk": cells[COL_INJURY_RISK] or None,
        }
    return out, len(blocks), skipped_pos


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="fetch and report, write nothing")
    args = ap.parse_args()

    print(f"Fetching {URL} ...")
    html = fetch()
    ds, total_rows, skipped = parse(html)
    print(f"  {total_rows} rows returned; {len(ds)} usable at RB/WR/TE")
    print(f"  {skipped} skipped by position (QB excluded by design, plus IDP and K/DST)")

    if len(ds) < 80:
        sys.exit("Far fewer players than expected — the table markup has probably "
                 "changed. Refusing to write a partial source into the blend.")

    if not os.path.exists(POOL):
        sys.exit(f"No pool at {os.path.relpath(POOL, ROOT)} — run fetch_fantasypros.py first.")
    with open(POOL, encoding="utf-8") as f:
        payload = json.load(f)
    players = payload.get("players", [])

    matched = 0
    for p in players:
        p.pop("dsProjection", None)      # cleared first, like every other merge
        hit = ds.get(name_key(p.get("name", "")))
        if not hit or hit["pos"] != p.get("pos"):
            continue
        p["dsProjection"] = {
            "standardPoints": hit["standardPoints"],
            "floor": hit["floor"],
            "ceiling": hit["ceiling"],
            "injuryRisk": hit["injuryRisk"],
        }
        matched += 1

    top = [p for p in players if (p.get("ecr") or 999) <= 120
           and p.get("pos") in WANTED]
    covered = [p for p in top if p.get("dsProjection")]
    print(f"\n  merged onto {matched} players "
          f"({len(covered)}/{len(top)} of the top-120 RB/WR/TE)")

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return

    payload["draftSharksUpdated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    with open(POOL, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=1)
    print(f"\nWrote {os.path.relpath(POOL, ROOT)}. Reload the pool in the app.")


if __name__ == "__main__":
    main()
