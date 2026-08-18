"""Rank managers by how well their DRAFTED roster actually scored.

    python3 tools/rank_draft_performance.py
    python3 tools/rank_draft_performance.py --recent 2022
    python3 tools/rank_draft_performance.py --refresh      # refetch season stats

Method: for each season, take the fifteen players a manager drafted, score each
player's real season under THIS league's rules, then sum the best legal starting
lineup (QB/RB2/WR3/TE/FLEX/K/DST). Seasons are z-scored against each other
before averaging, because a 2016 point total is not comparable to a 2024 one.

What this deliberately holds fixed:

  NO WAIVERS, NO TRADES, NO START/SIT. Every drafted player is credited with his
  full season, whatever happened after draft day. That is the question being
  asked -- who drafted well -- not who managed well. A manager who drafted an
  injured bust and replaced him in week 2 gets no credit here.

  SEASON TOTALS, NOT WEEKLY LINEUPS. Points earned in weeks 1-4 by a player who
  then tore an ACL still count in full. Ranking by season total is the standard
  way to grade a draft and it is what "held all season" means, but it flatters
  drafters whose players got hurt late and punishes nobody for a bye week.

  CURRENT SCORING APPLIED TO EVERY SEASON. Six-point passing TDs and -3 INTs are
  applied to 2016 as well as 2025. The league's rules may have changed; applying
  one ruleset to all ten seasons is what makes the comparison fair, not what
  makes it historically exact.

  PER-GAME YARDAGE BONUSES ARE OMITTED. The league awards +2 at 100/150 rushing
  and receiving and 300/400 passing, but those are per-GAME thresholds and only
  season totals are available. Including them would require weekly data; leaving
  them out costs every manager roughly equally.

Stats come from Sleeper's public endpoint (no auth, read-only) and are cached
under data/season-stats/. The browser app never touches any of this.
"""

import argparse
import json
import os
import re
import ssl
import statistics
import sys
import urllib.error
import urllib.request
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HISTORY = os.path.join(ROOT, "data", "draft-history.json")
CACHE_DIR = os.path.join(ROOT, "data", "season-stats")
PLAYERS_CACHE = os.path.join(CACHE_DIR, "players.json")

SUFFIXES = {"JR", "SR", "II", "III", "IV", "V"}

# Yahoo's display name differs from Sleeper's legal name. Left unmapped these
# score as zero, which silently penalises whoever drafted them.
ALIASES = {
    "HOLLYWOODBROWN": "MARQUISEBROWN",
    "WILLFULLER": "WILLIAMFULLER",
}

# This league's rules, from data/league_settings.json.
SCORING = {
    "pass_yd": 1 / 25, "pass_td": 6, "pass_int": -3, "pass_2pt": 2,
    "rush_yd": 1 / 10, "rush_td": 6, "rush_2pt": 2,
    "rec": 0.5, "rec_yd": 1 / 10, "rec_td": 6, "rec_2pt": 2,
    "fum_lost": -2,
}
# Starting lineup: 10 slots. FLEX takes RB/WR/TE.
LINEUP = {"QB": 1, "RB": 2, "WR": 3, "TE": 1, "K": 1, "DST": 1}
FLEX = 1
FLEX_OK = {"RB", "WR", "TE"}


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


def fetch_json(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120, context=_ssl_context()) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        sys.exit(f"HTTP {err.code} fetching {url}")
    except urllib.error.URLError as err:
        sys.exit(f"Could not reach Sleeper: {err.reason}")


def cached(path, url, refresh=False):
    if not refresh and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    data = fetch_json(url)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)
    return data


def player_index(players):
    """name_key -> sleeper id, plus DST nickname -> id."""
    by_name, by_dst = {}, {}
    for pid, rec in players.items():
        if rec.get("position") == "DEF":
            nick = rec.get("last_name")
            if nick:
                by_dst[name_key(nick)] = pid
            continue
        full = rec.get("full_name")
        if full:
            by_name.setdefault(name_key(full), pid)
    return by_name, by_dst


def score(stat, pos):
    """Season fantasy points under this league's rules."""
    if not stat:
        return 0.0
    # Kickers and defences are scored by Sleeper's half-PPR total: the league's
    # rules for them are conventional and the raw components (distance-banded
    # field goals, points-allowed tiers) are not reliably present per season.
    if pos in ("K", "DST"):
        return float(stat.get("pts_half_ppr") or stat.get("pts_std") or 0.0)
    total = 0.0
    for key, weight in SCORING.items():
        v = stat.get(key)
        if v:
            total += float(v) * weight
    return total


def best_lineup(scored):
    """scored: [(pos, points)] -> total of the best legal starting lineup."""
    pool = defaultdict(list)
    for pos, pts in scored:
        pool[pos].append(pts)
    for pos in pool:
        pool[pos].sort(reverse=True)

    total, used = 0.0, defaultdict(int)
    for pos, n in LINEUP.items():
        picks = pool[pos][:n]
        total += sum(picks)
        used[pos] = len(picks)
    # FLEX takes the best remaining RB/WR/TE.
    bench = []
    for pos in FLEX_OK:
        bench.extend(pool[pos][used[pos]:])
    bench.sort(reverse=True)
    total += sum(bench[:FLEX])
    return total


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="refetch cached stats")
    ap.add_argument("--recent", type=int, default=2022,
                    help="also report a ranking restricted to this season onward")
    args = ap.parse_args()

    with open(HISTORY, encoding="utf-8") as f:
        seasons = json.load(f)["seasons"]

    players = cached(PLAYERS_CACHE, "https://api.sleeper.app/v1/players/nfl", args.refresh)
    by_name, by_dst = player_index(players)

    totals = defaultdict(dict)     # manager -> season -> lineup points
    misses = defaultdict(int)
    matched = missed = 0

    for season in sorted(seasons):
        stats = cached(os.path.join(CACHE_DIR, f"{season}.json"),
                       f"https://api.sleeper.app/v1/stats/nfl/regular/{season}", args.refresh)
        per_mgr = defaultdict(list)
        for pk in seasons[season]["picks"]:
            mgr, pos = pk.get("manager"), pk.get("pos")
            if not mgr or not pos:
                continue
            key = name_key(pk["player"])
            key = ALIASES.get(key, key)
            pid = by_dst.get(key) if pos == "DST" else by_name.get(key)
            if pid is None:
                missed += 1
                misses[pk["player"]] += 1
                per_mgr[mgr].append((pos, 0.0))
                continue
            matched += 1
            per_mgr[mgr].append((pos, score(stats.get(pid), pos)))
        for mgr, scored in per_mgr.items():
            totals[mgr][int(season)] = best_lineup(scored)

    print(f"{matched} drafted players matched to real season stats, {missed} unmatched "
          f"({100 * missed / max(1, matched + missed):.1f}%)")
    if misses:
        top = sorted(misses.items(), key=lambda kv: -kv[1])[:6]
        print("  unmatched (scored as 0): " + ", ".join(f"{n} x{c}" for n, c in top))

    def ranking(season_filter, label):
        # Z-score within each season, then average: raw point totals are not
        # comparable across ten years of rule and usage changes.
        z = defaultdict(list)
        seasons_used = sorted({s for m in totals for s in totals[m] if season_filter(s)})
        for s in seasons_used:
            vals = {m: totals[m][s] for m in totals if s in totals[m]}
            mu = statistics.mean(vals.values())
            sd = statistics.pstdev(vals.values()) or 1.0
            for m, v in vals.items():
                z[m].append((v - mu) / sd)
        board = sorted(((statistics.mean(v), m) for m, v in z.items()), reverse=True)
        n = len(seasons_used)

        print(f"\n{label}  ({n} seasons: {seasons_used[0]}-{seasons_used[-1]})")
        print(f"  {'#':>2}  {'manager':<26}{'z-score':>9}{'± err':>7}{'avg pts':>9}"
              f"{'best':>7}{'worst':>7}")
        print("  " + "-" * 68)
        for i, (zs, m) in enumerate(board, 1):
            pts = [totals[m][s] for s in seasons_used if s in totals[m]]
            se = (statistics.pstdev(z[m]) / (len(z[m]) ** 0.5)) if len(z[m]) > 1 else float("nan")
            best = max((totals[m][s], s) for s in seasons_used if s in totals[m])
            worst = min((totals[m][s], s) for s in seasons_used if s in totals[m])
            print(f"  {i:>2}  {m[:25]:<26}{zs:>+9.2f}{se:>7.2f}{statistics.mean(pts):>9.0f}"
                  f"{best[1]:>7}{worst[1]:>7}")

        # A ten-team z-score has a per-season spread near 1.0, so the standard
        # error on a mean over n seasons is roughly 1/sqrt(n). Anything inside
        # that band is a coin flip dressed up as a ranking.
        band = 1.0 / (n ** 0.5)
        print(f"\n  Noise band: a mean z within about ±{band:.2f} of zero is "
              f"indistinguishable from average over {n} seasons.")
        clear_good = [m for zs, m in board if zs > band]
        clear_bad = [m for zs, m in board if zs < -band]
        print(f"    clearly above average: {', '.join(clear_good) or 'nobody'}")
        print(f"    clearly below average: {', '.join(clear_bad) or 'nobody'}")
        print(f"    statistically a wash:  "
              f"{len(board) - len(clear_good) - len(clear_bad)} of {len(board)}")
        return board

    all_board = ranking(lambda s: True, "ALL SEASONS")
    recent_board = ranking(lambda s: s >= args.recent, f"RECENT ({args.recent}+)")

    # --- consistency --------------------------------------------------------
    # Same z-scores, but now the spread rather than the average: who turns in
    # the same draft every year, and whose results swing.
    seasons_all = sorted({s for m in totals for s in totals[m]})
    z = defaultdict(dict)
    for s in seasons_all:
        vals = {m: totals[m][s] for m in totals if s in totals[m]}
        mu = statistics.mean(vals.values())
        sd = statistics.pstdev(vals.values()) or 1.0
        for m, v in vals.items():
            z[m][s] = (v - mu) / sd

    print("\n\nCONSISTENCY — spread of season-by-season results (10 seasons)")
    print("  Low sd = same draft every year. High sd = boom or bust.")
    print(f"  {'manager':<26}{'sd':>7}{'mean z':>9}{'range':>8}{'top-3 yrs':>11}{'bot-3 yrs':>11}")
    print("  " + "-" * 72)
    rows = []
    for m, byseason in z.items():
        vals = list(byseason.values())
        ranks = {}
        for s in seasons_all:
            order = sorted(z, key=lambda x: -z[x].get(s, -99))
            ranks[s] = order.index(m) + 1
        rows.append((statistics.pstdev(vals), m, statistics.mean(vals),
                     max(vals) - min(vals),
                     sum(1 for r in ranks.values() if r <= 3),
                     sum(1 for r in ranks.values() if r >= 8)))
    for sd, m, mz, rng, top3, bot3 in sorted(rows):
        print(f"  {m[:25]:<26}{sd:>7.2f}{mz:>+9.2f}{rng:>8.2f}{top3:>11}{bot3:>11}")

    steadiest = min(rows)[1]
    swingiest = max(rows)[1]
    print(f"\n  Most consistent: {steadiest}     Most volatile: {swingiest}")

    # Movement between the two windows is the interesting part.
    pos_all = {m: i for i, (_, m) in enumerate(all_board, 1)}
    pos_rec = {m: i for i, (_, m) in enumerate(recent_board, 1)}
    print("\nMOVEMENT (all-time rank -> recent rank)")
    for m in sorted(pos_all, key=lambda x: pos_rec[x]):
        d = pos_all[m] - pos_rec[m]
        arrow = f"up {d}" if d > 0 else (f"down {-d}" if d < 0 else "same")
        print(f"  {m[:25]:<26} {pos_all[m]:>2} -> {pos_rec[m]:<2}  {arrow}")


if __name__ == "__main__":
    main()
