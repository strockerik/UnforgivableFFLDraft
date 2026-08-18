"""Cache a name -> position map covering retired players, for draft history.

    python3 tools/fetch_player_positions.py            # refresh the cache
    python3 tools/fetch_player_positions.py --stats

Why this exists: the draft-history pages name players but never their position,
and data/players.json only holds players relevant to the CURRENT season. Ten
years of history reaches back to Arian Foster and Adam Vinatieri, so roughly a
third of all historical picks have no position available locally.

Source is Sleeper's public player endpoint -- no key, no auth, read-only, and
it retains retired players. It is fetched once and cached to
data/player-positions.json; nothing in the browser app touches it, and the
draft assistant itself never calls Sleeper.

Names are stored under the same normalized key players.js uses, so a suffix or
punctuation difference does not cause a miss.
"""

import argparse
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "player-positions.json")
URL = "https://api.sleeper.app/v1/players/nfl"

VALID = {"QB", "RB", "WR", "TE", "K", "DEF"}
SUFFIXES = {"JR", "SR", "II", "III", "IV", "V"}


def name_key(name):
    toks = re.sub(r"[^A-Z0-9\s]", "", str(name).upper()).split()
    return "".join(t for t in toks if t not in SUFFIXES)


def _ssl_context():
    """Same fallback as the other tools here: some python.org builds ship no
    CA bundle. Use the system one rather than disabling verification."""
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
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=120, context=_ssl_context()) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        sys.exit(f"HTTP {err.code} from Sleeper: {err.read().decode('utf-8', 'replace')[:200]}")
    except urllib.error.URLError as err:
        sys.exit(f"Could not reach Sleeper: {err.reason}")


def build(raw):
    out = {}
    collisions = 0
    for rec in raw.values():
        pos = rec.get("position")
        name = rec.get("full_name") or rec.get("last_name")
        if not name or pos not in VALID:
            continue
        if pos == "DEF":
            pos = "DST"
        key = name_key(name)
        if not key:
            continue
        # Two players can share a normalized name across eras. Prefer whoever
        # is still active, otherwise keep the first -- and count it, because a
        # silent collision is exactly the kind of thing that skews a profile.
        if key in out and out[key] != pos:
            collisions += 1
            if not rec.get("active"):
                continue
        out[key] = pos
    return out, collisions


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stats", action="store_true", help="report the cache without refetching")
    args = ap.parse_args()

    if args.stats:
        if not os.path.exists(OUT):
            sys.exit(f"No cache at {os.path.relpath(OUT, ROOT)} — run without --stats first.")
        with open(OUT, encoding="utf-8") as f:
            data = json.load(f)["positions"]
        print(f"{len(data)} players cached")
        for pos, n in Counter(data.values()).most_common():
            print(f"  {pos:4} {n}")
        return

    raw = fetch()
    positions, collisions = build(raw)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"positions": positions, "source": URL, "count": len(positions)}, f)
    print(f"Cached {len(positions)} name->position entries to {os.path.relpath(OUT, ROOT)}")
    if collisions:
        print(f"  {collisions} normalized-name collisions resolved in favour of the active player")
    for pos, n in Counter(positions.values()).most_common():
        print(f"  {pos:4} {n}")


if __name__ == "__main__":
    main()
