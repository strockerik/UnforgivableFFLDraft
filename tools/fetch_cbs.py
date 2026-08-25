"""Fetch CBS Sports' season projections as a THIRD source for the blend.

    python3 tools/fetch_cbs.py               # merge into data/players.json
    python3 tools/fetch_cbs.py --dry-run     # fetch and report, write nothing

Why CBS specifically: Fantasy Football Analytics' twelve-season accuracy study
found CBS the most accurate individual source for running backs (54.2 MAE in
recent seasons) and the best overall performer in 2025. It is also genuinely
independent of the other two -- FantasyPros is a consensus of many analysts and
ESPN is a single house projection, so adding CBS widens the panel rather than
double-counting one opinion.

It matters most where ESPN is weakest. The same study put ESPN LAST at
quarterback (86.7 MAE), and this league pays 6 points per passing touchdown,
which makes quarterback valuation unusually consequential. Averaging ESPN alone
with FantasyPros imported that weakness at exactly the position that can least
afford it.

Two public CBS endpoints, no key required:
  stats?stats_type=projections   raw projected stat lines, keyed by player id
  players/list                   id -> name, position, team

Like the ESPN fetcher, this stores RAW STATS, never a point total. The blend has
to happen after this league's scoring is applied or a 6-point passing touchdown
gets averaged with a 4-point one.
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
BASE = "https://api.cbssports.com/fantasy/"
STATS_URL = (BASE + "stats?version=3.0&SPORT=football&period=ytd"
             "&stats_type=projections&response_format=json")
LIST_URL = BASE + "players/list?version=3.0&SPORT=football&response_format=json"

SUFFIXES = {"JR", "SR", "II", "III", "IV", "V"}
WANTED = {"QB", "RB", "WR", "TE"}

# CBS stat keys -> the shape js/vorp.js scores.
STAT_KEYS = {
    "PaYd": "pass_yds", "PaTD": "pass_tds", "PaInt": "pass_ints",
    "RuYd": "rush_yds", "RuTD": "rush_tds",
    "ReYd": "rec_yds", "ReTD": "rec_tds", "Recpt": "rec_rec",
    "FL": "fumbles",
}
RET_TD_KEYS = ("KRTD", "PRTD")
TWO_PT_KEYS = ("2PM",)


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


def get(url, label):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=120, context=_ssl_context()) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as err:
        sys.exit(f"HTTP {err.code} from CBS ({label}): "
                 f"{err.read().decode('utf-8', 'replace')[:200]}")
    except urllib.error.URLError as err:
        sys.exit(f"Could not reach CBS ({label}): {err.reason}")


def num(v):
    try:
        f = float(v)
        return f if f == f else 0.0     # NaN guard
    except (TypeError, ValueError):
        return 0.0


def build():
    stats = get(STATS_URL, "stats")["body"]["player_stats"]
    roster = get(LIST_URL, "players/list")["body"]["players"]
    by_id = {str(p.get("id")): p for p in roster}

    out = {}
    periods = set()
    for pid, st in stats.items():
        meta = by_id.get(str(pid))
        if not meta or meta.get("position") not in WANTED:
            continue
        periods.add(st.get("period"))
        line = {}
        for cbs_key, our_key in STAT_KEYS.items():
            v = num(st.get(cbs_key))
            if v:
                line[our_key] = round(v, 1)
        ret = sum(num(st.get(k)) for k in RET_TD_KEYS)
        if ret:
            line["ret_tds"] = round(ret, 2)
        two = sum(num(st.get(k)) for k in TWO_PT_KEYS)
        if two:
            line["2pt_tds"] = round(two, 1)
        if not line:
            continue

        name = meta.get("fullname") or f"{meta.get('firstname','')} {meta.get('lastname','')}"
        key = name_key(name)
        if key and key not in out:
            out[key] = {"name": name.strip(), "pos": meta["position"], "projStats": line}
    return out, periods


def sanity_check(projections):
    """Refuse a per-game feed masquerading as a season one.

    CBS publishes no total of its own to reconstruct against, so the guard the
    ESPN fetcher uses is unavailable. Scale is checked instead: if the best
    projected passer is under 3,000 yards, this is weekly or partial data and
    blending it would silently drag every quarterback's value toward zero.
    """
    best_pass = max((p["projStats"].get("pass_yds", 0) for p in projections.values()
                     if p["pos"] == "QB"), default=0)
    best_rec = max((p["projStats"].get("rec_yds", 0) for p in projections.values()
                    if p["pos"] == "WR"), default=0)
    print(f"  scale check: best projected passer {best_pass:.0f} yards, "
          f"best receiver {best_rec:.0f} yards")
    if best_pass < 3000 or best_rec < 900:
        sys.exit("These look like per-game or partial projections, not a season. "
                 "Refusing to write -- blending them would quietly deflate every value.")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="fetch and report, write nothing")
    args = ap.parse_args()

    print("Fetching CBS projections ...")
    projections, periods = build()
    print(f"  {len(projections)} skill players at QB/RB/WR/TE")
    print(f"  CBS period(s): {', '.join(sorted(str(p) for p in periods))}")
    sanity_check(projections)

    if not os.path.exists(POOL):
        sys.exit(f"No pool at {os.path.relpath(POOL, ROOT)} — run fetch_fantasypros.py first.")
    with open(POOL, encoding="utf-8") as f:
        payload = json.load(f)
    players = payload.get("players", [])

    matched = 0
    for p in players:
        p.pop("cbsStats", None)     # cleared first, so a stale line cannot outvote a fresh one
        hit = projections.get(name_key(p.get("name", "")))
        if not hit or hit["pos"] != p.get("pos"):
            continue
        p["cbsStats"] = hit["projStats"]
        matched += 1

    top = [p for p in players if (p.get("ecr") or 999) <= 150]
    covered = [p for p in top if p.get("cbsStats")]
    print(f"\n  merged onto {matched} of {len(players)} players "
          f"({len(covered)}/{len(top)} of the top 150 by ECR)")
    gaps = [p["name"] for p in top if not p.get("cbsStats")][:8]
    if gaps:
        print("  top-150 without a CBS line: " + ", ".join(gaps))

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return

    payload["cbsUpdated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    with open(POOL, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=1)
    print(f"\nWrote {os.path.relpath(POOL, ROOT)}. Reload the pool in the app.")


if __name__ == "__main__":
    main()
