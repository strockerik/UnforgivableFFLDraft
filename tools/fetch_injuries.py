"""Merge current injury status into data/players.json.

    python3 tools/fetch_injuries.py              # refresh before the draft
    python3 tools/fetch_injuries.py --stats      # report what is cached now
    python3 tools/fetch_injuries.py --dry-run    # show the merge, write nothing

Why this exists: the deterministic engine values players from projected points
and never looks at injuries -- deliberately, because a projection already prices
a known absence and double-counting it would be wrong. That leaves injuries as
the one signal Claude holds and the engine does not, which is the whole basis
for letting the model override the ranking.

For a long time that channel was empty. Every field in the evidence packet came
from the same pool the engine had already scored, so an override was the model
re-doing the engine's arithmetic with worse tools -- and it lost three times out
of three in one practice draft. This script connects the pipe.

Source is Sleeper's public player endpoint: no key, no auth, read-only, and the
same endpoint fetch_player_positions.py already uses. Nothing in the browser
calls it; this runs on the machine and writes the merged pool to disk.

TWO THINGS THIS SCRIPT IS CAREFUL ABOUT
---------------------------------------
1. Staleness. Sleeper keeps `injury_status` set long after it stops meaning
   anything, and a stale flag is worse than no flag -- the model reads it as
   current and downgrades a healthy player. Every record carries how old it is,
   anything past --max-age-days is dropped, and the age travels into the packet
   so the model can discount it.

2. "Questionable" in August is not "questionable" in October. In season it means
   a real game-time decision; in the preseason it is mostly carryover from camp
   and applies to hundreds of players at once. Records are graded into a
   `severity` the prompt knows how to weigh, rather than being flattened into
   one undifferentiated warning.

Re-running is safe and is the point: every injury field is cleared before the
merge, so a player who has healed loses his flag instead of carrying it to the
draft forever.
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
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POOL = os.path.join(ROOT, "data", "players.json")
URL = "https://api.sleeper.app/v1/players/nfl"

SUFFIXES = {"JR", "SR", "II", "III", "IV", "V"}

# How much a status actually matters to a draft pick, which is not the same as
# how alarming it sounds. Anything "high" costs real games; "low" is a flag to
# read, not a reason to move a player down the board.
SEVERITY = {
    "IR": "high",       # injured reserve -- weeks out at minimum
    "PUP": "high",      # physically unable to perform -- misses at least 4 games
    "Out": "high",
    "Sus": "high",      # suspension: same effect on your lineup as an injury
    "DNR": "high",      # did not report
    "NA": "medium",     # not active, reason unstated
    "Doubtful": "medium",
    "Questionable": "low",
}

# Only positions the app drafts.
VALID = {"QB", "RB", "WR", "TE", "K", "DEF"}


def name_key(name):
    """Same normalization players.js uses, so punctuation and suffixes match."""
    toks = re.sub(r"[^A-Z0-9\s]", "", str(name).upper()).split()
    return "".join(t for t in toks if t not in SUFFIXES)


def _ssl_context():
    """Some python.org builds ship no CA bundle; fall back to the system one
    rather than disabling verification."""
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
        with urllib.request.urlopen(req, timeout=180, context=_ssl_context()) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        sys.exit(f"HTTP {err.code} from Sleeper: {err.read().decode('utf-8', 'replace')[:200]}")
    except urllib.error.URLError as err:
        sys.exit(f"Could not reach Sleeper: {err.reason}")


def build_index(raw, max_age_days):
    """name_key -> list of injury records, newest first.

    Keyed by name alone and disambiguated by team at merge time. Keying on
    name+team here would silently miss every player who changed teams between
    Sleeper's snapshot and the FantasyPros export, which in August is a lot of
    them.
    """
    now = time.time()
    index = {}
    dropped_stale = 0
    for rec in raw.values():
        status = rec.get("injury_status")
        if not status or not rec.get("active"):
            continue
        pos = rec.get("position")
        if pos not in VALID:
            continue
        name = rec.get("full_name") or rec.get("last_name")
        key = name_key(name) if name else None
        if not key:
            continue

        # news_updated is epoch milliseconds. Absent means we cannot date the
        # record, and an undateable injury flag is exactly the kind we must not
        # trust -- treat it as stale rather than as fresh.
        updated = rec.get("news_updated")
        if not updated:
            dropped_stale += 1
            continue
        age_days = int((now - (updated / 1000.0)) / 86400)
        if age_days > max_age_days:
            dropped_stale += 1
            continue

        parts = [rec.get("injury_body_part"), rec.get("injury_notes")]
        detail = ", ".join(p for p in parts if p and p != "Undisclosed")
        index.setdefault(key, []).append({
            "status": status,
            "severity": SEVERITY.get(status, "low"),
            "detail": detail,
            "team": rec.get("team"),
            "pos": "DST" if pos == "DEF" else pos,
            "ageDays": age_days,
        })
    for entries in index.values():
        entries.sort(key=lambda e: e["ageDays"])
    return index, dropped_stale


def merge(players, index):
    """Attach injuries to the pool in place. Returns (matched, by_severity)."""
    matched = 0
    by_severity = Counter()
    for p in players:
        # Clear first, unconditionally. Without this a player who has recovered
        # keeps the flag from an earlier run, and a stale "IR" on a healthy
        # starter is the most damaging thing this file could contain.
        p.pop("injury", None)

        entries = index.get(name_key(p.get("name", "")))
        if not entries:
            continue
        # Prefer the record whose team AND position both agree; fall back to
        # position alone, since a player traded after Sleeper's snapshot is a
        # match with a stale team. Never fall back to name alone -- that is how
        # a defensive back's knee ends up attached to a fantasy receiver.
        hit = next((e for e in entries if e["team"] == p.get("team") and e["pos"] == p.get("pos")), None)
        if hit is None:
            hit = next((e for e in entries if e["pos"] == p.get("pos")), None)
        if hit is None:
            continue

        detail = hit["detail"]
        # The age rides inside the human-readable detail so the browser needs no
        # change to surface it: brief() already joins status and detail into one
        # string for the packet. A 40-day-old "Questionable" reads very
        # differently from a 2-day-old one and the model must be able to tell.
        age = "today" if hit["ageDays"] == 0 else f"{hit['ageDays']}d ago"
        p["injury"] = {
            "status": hit["status"],
            "severity": hit["severity"],
            "detail": f"{detail} (reported {age})" if detail else f"reported {age}",
            "ageDays": hit["ageDays"],
        }
        matched += 1
        by_severity[hit["severity"]] += 1
    return matched, by_severity


def report(players):
    hurt = [p for p in players if p.get("injury")]
    if not hurt:
        print("No injuries recorded in the pool.")
        return
    print(f"{len(hurt)} of {len(players)} players carry an injury flag\n")
    order = {"high": 0, "medium": 1, "low": 2}
    hurt.sort(key=lambda p: (order.get(p["injury"].get("severity"), 3),
                             p.get("ecr") if p.get("ecr") is not None else 9999))
    shown = 0
    for p in hurt:
        inj = p["injury"]
        if inj.get("severity") == "low" and shown >= 25:
            continue
        ecr = p.get("ecr")
        print(f"  {inj.get('severity','?'):6} {inj['status']:12} "
              f"{p['name'][:24]:24} {p.get('pos',''):4} ECR {ecr if ecr is not None else '—':>4}  "
              f"{inj.get('detail','')}")
        shown += 1
    if len(hurt) > shown:
        print(f"  ... and {len(hurt) - shown} more low-severity flags")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pool", default=POOL, help="pool file to merge into")
    ap.add_argument("--max-age-days", type=int, default=45,
                    help="drop injury records older than this (default 45)")
    ap.add_argument("--stats", action="store_true",
                    help="report the injuries already in the pool, without fetching")
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch and report, but do not write")
    args = ap.parse_args()

    if not os.path.exists(args.pool):
        sys.exit(f"No pool at {os.path.relpath(args.pool, ROOT)} — "
                 "run tools/fetch_fantasypros.py first.")

    with open(args.pool, encoding="utf-8") as f:
        payload = json.load(f)
    players = payload.get("players", [])
    if not players:
        sys.exit(f"{os.path.relpath(args.pool, ROOT)} contains no players.")

    if args.stats:
        report(players)
        return

    print(f"Fetching {URL} ...")
    raw = fetch()
    index, dropped = build_index(raw, args.max_age_days)
    print(f"  {len(raw)} Sleeper records, {len(index)} active injured at a drafted position")
    if dropped:
        print(f"  {dropped} dropped as stale (older than {args.max_age_days} days or undated)")

    matched, by_severity = merge(players, index)
    print(f"  matched {matched} into the pool of {len(players)}: "
          + ", ".join(f"{n} {sev}" for sev, n in sorted(by_severity.items())) + "\n")
    report(players)

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return

    payload["injuriesUpdated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    with open(args.pool, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=1)
    print(f"\nWrote {os.path.relpath(args.pool, ROOT)}. "
          "Reload the pool in the app to pick it up.")


if __name__ == "__main__":
    main()
