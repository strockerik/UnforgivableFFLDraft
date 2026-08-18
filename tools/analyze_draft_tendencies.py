"""Turn data/draft-history.json into per-manager drafting profiles.

    python3 tools/analyze_draft_tendencies.py
    python3 tools/analyze_draft_tendencies.py --write   # -> data/tendencies.json

What this measures, and what it deliberately does not:

MEASURED   When each manager first takes each position, how consistent that is
           across seasons, their early-round RB/WR lean, and how early the
           league as a whole drains each position.

This league drafts live and in person -- there is no autodraft -- so every pick
is a deliberate human decision and a late-round habit is as real as an early
one. That is unusual and it is what makes this data worth mining at all.

RECENCY  Ten seasons is enough history that people have changed. Patterns are
         established from 2022 onward and merely CONFIRMED against 2016-21;
         where the two eras disagree the report says "drifted" and the recent
         number wins. Averaging a decade would smear two different drafters
         together and quietly mislead.

Reach-versus-market is also absent: it needs the ADP of that season, and only
the current year's ADP is on hand. Everything here is measured against what the
league itself did, which needs no external baseline.
"""

import argparse
import json
import os
import statistics
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HISTORY = os.path.join(ROOT, "data", "draft-history.json")
OUT = os.path.join(ROOT, "data", "tendencies.json")

POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"]
# Picks inside this many rounds describe a manager's opening plan.
EARLY_ROUNDS = 6
# Seasons treated as "current behaviour". Older seasons are used to CONFIRM a
# pattern, never to establish one: people's drafting changes, and a habit from
# 2016 that stopped in 2020 is worse than no signal at all.
RECENT_FROM = 2022
# A pattern counts as reliable if its range across seasons is at most this.
RELIABLE_SPREAD = 2
# How far the two eras may disagree before we call it drift rather than
# confirmation, in rounds.
DRIFT_TOLERANCE = 1.0


def load():
    with open(HISTORY, encoding="utf-8") as f:
        return json.load(f)["seasons"]


def by_manager(seasons):
    """-> {manager: {season: [picks sorted by round]}}"""
    out = defaultdict(lambda: defaultdict(list))
    for season, data in seasons.items():
        for pk in data["picks"]:
            if pk.get("manager"):
                out[pk["manager"]][int(season)].append(pk)
    for mgr in out:
        for s in out[mgr]:
            out[mgr][s].sort(key=lambda p: p["round"])
    return out


def first_round_of(picks, pos):
    for p in picks:
        if p["pos"] == pos:
            return p["round"]
    return None


def spread(vals):
    """Range as a crude consistency measure; stdev needs more seasons than we have."""
    return max(vals) - min(vals) if len(vals) > 1 else 0


def _firsts(mgr_seasons, seasons):
    out = {pos: [] for pos in POSITIONS}
    for s in seasons:
        for pos in POSITIONS:
            r = first_round_of(mgr_seasons[s], pos)
            if r is not None:
                out[pos].append(r)
    return out


def _stat(vals):
    return {
        "mean": round(statistics.mean(vals), 1),
        "earliest": min(vals),
        "latest": max(vals),
        "spread": spread(vals),
        "seasons": len(vals),
    }


def profile(mgr_seasons):
    """One manager's profile, split into recent and prior eras.

    `recent` is what the app should act on. `prior` exists to answer one
    question: has this person always done this, or is it a recent habit? A
    pattern present in both eras is a decade-long trait; one that appears only
    recently is still usable but weaker; one that has drifted between eras is
    a warning that the mean is describing two different drafters.
    """
    all_seasons = sorted(mgr_seasons)
    recent = [s for s in all_seasons if s >= RECENT_FROM]
    prior = [s for s in all_seasons if s < RECENT_FROM]

    prof = {"seasons": all_seasons, "recentSeasons": recent,
            "first": {}, "prior": {}, "allTime": {}, "earlyMix": {}, "verdict": {}}

    fr, fp, fa = _firsts(mgr_seasons, recent), _firsts(mgr_seasons, prior), _firsts(mgr_seasons, all_seasons)
    for pos in POSITIONS:
        if fr[pos]:
            prof["first"][pos] = _stat(fr[pos])
        if fp[pos]:
            prof["prior"][pos] = _stat(fp[pos])
        if fa[pos]:
            prof["allTime"][pos] = _stat(fa[pos])

        r, p = prof["first"].get(pos), prof["prior"].get(pos)
        if not r:
            continue
        reliable = r["spread"] <= RELIABLE_SPREAD
        if not reliable:
            prof["verdict"][pos] = "noisy"
        elif not p:
            prof["verdict"][pos] = "recent-only"
        elif abs(r["mean"] - p["mean"]) <= DRIFT_TOLERANCE:
            # Same behaviour in both eras, and tight in the recent one.
            prof["verdict"][pos] = "confirmed" if p["spread"] <= RELIABLE_SPREAD + 1 else "steady-mean"
        else:
            prof["verdict"][pos] = "drifted"

    early_counts = defaultdict(int)
    total_early = 0
    for s in recent or all_seasons:
        for p in mgr_seasons[s]:
            if p["round"] <= EARLY_ROUNDS:
                early_counts[p["pos"]] += 1
                total_early += 1
    for pos in POSITIONS:
        if total_early:
            prof["earlyMix"][pos] = round(100 * early_counts[pos] / total_early)
    return prof


def league_drain(seasons):
    """How many of each position are gone by the end of each round, averaged."""
    per_round = defaultdict(lambda: defaultdict(list))
    for _season, data in seasons.items():
        rounds = data["rounds"]
        running = defaultdict(int)
        by_round = defaultdict(lambda: defaultdict(int))
        for pk in data["picks"]:
            by_round[pk["round"]][pk["pos"]] += 1
        for r in range(1, rounds + 1):
            for pos in POSITIONS:
                running[pos] += by_round[r][pos]
                per_round[r][pos].append(running[pos])
    return {r: {pos: round(statistics.mean(v), 1) for pos, v in d.items()}
            for r, d in per_round.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--me", default="erik", help="your manager name, for contrast")
    args = ap.parse_args()

    seasons = load()
    mgrs = by_manager(seasons)
    profiles = {m: profile(s) for m, s in mgrs.items()}

    n_seasons = len(seasons)
    print(f"{len(profiles)} managers, {n_seasons} seasons "
          f"({', '.join(sorted(seasons))}), {sum(len(d['picks']) for d in seasons.values())} picks\n")

    # --- league-wide positional timing -------------------------------------
    drain = league_drain(seasons)
    print("LEAGUE POSITIONAL TIMING — average number drafted by end of round")
    print(f"  {'rd':>3}  " + "".join(f"{p:>7}" for p in POSITIONS))
    for r in sorted(drain):
        if r > 10:
            break
        print(f"  {r:>3}  " + "".join(f"{drain[r].get(p, 0):>7}" for p in POSITIONS))

    print("\n  First off the board, by position (mean round of the league's first pick):")
    for pos in POSITIONS:
        firsts = []
        for _s, data in seasons.items():
            hit = [p["round"] for p in data["picks"] if p["pos"] == pos]
            if hit:
                firsts.append(min(hit))
        if firsts:
            print(f"    {pos:4} round {statistics.mean(firsts):.1f}")

    # --- does the older data confirm or contradict? -------------------------
    print("\n\nRECENT (2022-25) vs PRIOR (2016-21) — does the older data confirm?")
    print("  confirmed  = tight recently AND the prior era agrees within 1 round")
    print("  drifted    = tight recently but they used to do something else")
    print("  noisy      = no usable pattern even recently\n")
    tally = Counter()
    rows = []
    for mgr, p in profiles.items():
        for pos, verdict in p["verdict"].items():
            tally[verdict] += 1
            if verdict in ("confirmed", "drifted"):
                r, pr = p["first"][pos], p["prior"].get(pos)
                rows.append((verdict, mgr, pos, r["mean"], pr["mean"] if pr else None,
                             r["spread"]))
    for verdict, n in tally.most_common():
        print(f"    {verdict:12} {n}")

    print("\n  CONFIRMED — a decade-long trait, safe to plan around:")
    for v, mgr, pos, rm, pm, sp in sorted(rows, key=lambda x: (x[0] != 'confirmed', x[3])):
        if v == "confirmed":
            print(f"    {mgr[:24]:<25} {pos:4} round {rm:>4.1f}   (2016-21: {pm:>4.1f}, "
                  f"recent range {sp})")

    drifted = [r for r in rows if r[0] == "drifted"]
    if drifted:
        print("\n  DRIFTED — trust the recent number, ignore the old one:")
        for _v, mgr, pos, rm, pm, _sp in sorted(drifted, key=lambda x: x[3]):
            arrow = "earlier" if rm < pm else "later"
            print(f"    {mgr[:24]:<25} {pos:4} round {pm:>4.1f} -> {rm:>4.1f}  ({arrow} now)")

    # --- per-manager --------------------------------------------------------
    print("\n\nPER-MANAGER PROFILES (recent era; ± is the range across those seasons)")
    hdr = f"  {'manager':<26}{'QB':>12}{'TE':>12}{'K':>12}{'DST':>12}   early RB/WR"
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))
    for mgr in sorted(profiles, key=lambda m: profiles[m]["first"].get("QB", {}).get("mean", 99)):
        p = profiles[mgr]
        cells = ""
        for pos in ("QB", "TE", "K", "DST"):
            f = p["first"].get(pos)
            cells += f"{f['mean']:>8.1f}±{f['spread']:<3}" if f else f"{'—':>12}"
        rb = p["earlyMix"].get("RB", 0)
        wr = p["earlyMix"].get("WR", 0)
        star = " *" if mgr == args.me else ""
        print(f"  {mgr[:25]:<26}{cells}   {rb:>2}% / {wr:>2}%{star}")

    # --- the actionable summary --------------------------------------------
    print("\n\nWHAT THIS MEANS FOR YOUR DRAFT")
    qb_means = [p["first"]["QB"]["mean"] for p in profiles.values() if "QB" in p["first"]]
    te_means = [p["first"]["TE"]["mean"] for p in profiles.values() if "TE" in p["first"]]
    early_qb = sorted(((p["first"]["QB"]["mean"], m) for m, p in profiles.items()
                       if "QB" in p["first"]))[:3]
    early_te = sorted(((p["first"]["TE"]["mean"], m) for m, p in profiles.items()
                       if "TE" in p["first"]))[:3]
    print(f"  League mean first QB: round {statistics.mean(qb_means):.1f}   "
          f"first TE: round {statistics.mean(te_means):.1f}")
    print("  Earliest QB drafters:  " + ", ".join(f"{m} (r{v:.1f})" for v, m in early_qb))
    print("  Earliest TE drafters:  " + ", ".join(f"{m} (r{v:.1f})" for v, m in early_te))

    kd = [(p["first"].get("K", {}).get("earliest", 99), m) for m, p in profiles.items()]
    reachers = [(v, m) for v, m in kd if v <= 12]
    if reachers:
        print("  Managers who have taken a K before round 13: "
              + ", ".join(f"{m} (r{v})" for v, m in sorted(reachers)))

    if args.write:
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump({"profiles": profiles, "leagueDrain": drain,
                       "seasons": sorted(seasons)}, f, indent=1)
        print(f"\nWrote {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
