#!/usr/bin/env python3
"""Merge every FantasyPros CSV in a folder into one data/players.json.

Point it at the folder you download exports into and it works out what each
file is -- overall rankings, a per-position file, or an ADP export -- and folds
them together. Download as many or as few as you like; each one fills in
whatever the others were missing.

    python3 tools/build_pool.py
    python3 tools/build_pool.py --dir "Fantasy Ranking" --out data/players.json

Why this exists: the free Draft Overall Rankings export has no tier, bye, or
ADP columns, while the per-position exports have all three but only cover one
position. Merging them gets you a complete board without a premium export.

Field precedence:
  ecr    overall-rankings file only (a true cross-position rank)
  adp    ADP export only, or an overall-rankings file's ADP column
  tier   any file
  bye    any file
  sos    any file

WHY PER-POSITION FILES DO NOT CONTRIBUTE ecr/adp
------------------------------------------------
A specialty export like "Sleeper RB Rankings" has Rank / ECR / ADP columns
whose frame of reference is the list itself, not the overall board. In the
2026 sleeper file Zach Charbonnet is Rank 1, ECR 46, ADP 42 -- while the
overall export has him 141st. Merging those as overall values produced
"ADP 42 vs ECR 141", i.e. a player apparently falling 99 picks: the single
strongest buy signal the app can show, entirely fabricated.

There is no reliable way to tell a positional rank from an overall one by
inspection, so these files contribute only the fields that mean the same
thing everywhere -- tier, bye, team, SOS. If such a file is the *only*
source for a position, its ranks are used and the note says so.
"""

import argparse
import csv
import json
import os
import re
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TEAMS = {
    "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET",
    "GB", "HOU", "IND", "JAC", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN",
    "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS", "WSH",
}
SUFFIXES = {"JR", "SR", "II", "III", "IV", "V"}
VALID_POS = {"QB", "RB", "WR", "TE", "DST", "K"}

NAME_COLUMNS = [
    "PLAYERNAME", "PLAYER", "NAME", "OVERALL",
    "QUARTERBACKS", "RUNNINGBACKS", "WIDERECEIVERS", "TIGHTENDS",
    "KICKERS", "DEFENSES", "TEAMDEFENSES", "DST", "FLEX",
]
POSITION_FROM_NAME_COLUMN = {
    "QUARTERBACKS": "QB", "RUNNINGBACKS": "RB", "WIDERECEIVERS": "WR",
    "TIGHTENDS": "TE", "KICKERS": "K", "DEFENSES": "DST",
    "TEAMDEFENSES": "DST", "DST": "DST",
}
HEADER_TOKENS = {"RK", "RANK", "PLAYER", "PLAYERNAME", "POS", "POSITION", "TEAM",
                 "TIER", "TIERS", "BYE", "BYEWEEK", "ECR", "ADP", "PLAYERTEAMBYE",
                 "OVERALL", *POSITION_FROM_NAME_COLUMN}


def norm(s):
    return re.sub(r"[^A-Z0-9]", "", str(s).upper())


def as_num(v):
    if v is None:
        return None
    s = str(v).replace(",", "").replace("+", "").strip()
    if s in ("", "-", "--") or s.lower() in ("n/a", "na", "null"):
        return None
    try:
        f = float(s)
        return int(f) if f.is_integer() else f
    except ValueError:
        return None


def name_key(name):
    toks = [t for t in re.sub(r"[^A-Z0-9\s]", "", str(name or "").upper()).split()
            if t not in SUFFIXES]
    return "".join(toks)


def slug(*parts):
    return re.sub(r"[^a-z0-9]+", "-", "-".join(str(p or "") for p in parts).lower()).strip("-")


def split_pos(raw, fallback=None):
    s = str(raw or "").upper().strip() or str(fallback or "").upper()
    m = re.match(r"^([A-Z]+)(\d+)?$", s)
    if not m:
        return (s or None), None
    pos = m.group(1)
    if pos in ("D", "DEF"):
        pos = "DST"
    if pos == "PK":
        pos = "K"
    return pos, (int(m.group(2)) if m.group(2) else None)


def parse_player_team_bye(cell):
    """'Josh Allen BUF (7)' -> ('Josh Allen', 'BUF', 7).

    Parsed right-to-left so name suffixes survive: splitting left-to-right
    reads the 'II' in 'Patrick Mahomes II KC (10)' as the team.
    """
    s = str(cell or "").strip()
    bye = None
    team = None
    m = re.search(r"\((\d+)\)\s*$", s)
    if m:
        bye = int(m.group(1))
        s = s[:m.start()].strip()
    parts = s.split()
    if len(parts) > 1 and parts[-1].upper() in TEAMS:
        team = parts.pop().upper()
    return " ".join(parts).strip(), team, bye


def read_table(path):
    """Return (headers_normalized, list_of_dicts). Skips title rows above the
    header and footer/blank rows below the data."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = [[c.strip() for c in r] for r in csv.reader(f)]
    rows = [r for r in rows if any(c for c in r)]
    if not rows:
        return [], []

    h_idx = -1
    for i, row in enumerate(rows[:25]):
        if sum(1 for c in row if norm(c) in HEADER_TOKENS) >= 2:
            h_idx = i
            break
    if h_idx == -1:
        return [], []

    headers = [norm(c) for c in rows[h_idx]]
    width = len(headers)
    out = []
    for row in rows[h_idx + 1:]:
        if len([c for c in row if c]) < 2:
            continue
        if re.match(r"^(adp\s+sources|source|note|updated|generated|data\s+from)\b",
                    row[0] or "", re.I):
            continue
        if len(row) < max(2, width // 2):
            continue
        out.append({h: (row[j] if j < len(row) else "") for j, h in enumerate(headers) if h})
    return headers, out


def pick(rec, *names):
    for n in names:
        v = rec.get(norm(n))
        if v not in (None, "", "-"):
            return v
    return None


def parse_rankings_file(path):
    headers, records = read_table(path)
    if not records:
        return [], "unreadable"

    name_col = next((c for c in NAME_COLUMNS if c in headers), None)
    if not name_col:
        return [], "no player column"
    implied = POSITION_FROM_NAME_COLUMN.get(name_col)

    players = []
    for r in records:
        name = r.get(name_col)
        if not name:
            continue
        pos, pos_rank = split_pos(pick(r, "POS", "POSITION"), implied)
        if pos not in VALID_POS:
            continue
        team = (pick(r, "TEAM") or "").upper() or None
        # In a per-position file, "Rank" is positional and "ECR" is overall.
        ecr = as_num(pick(r, "ECR", "RK", "RANK")) if implied else \
            as_num(pick(r, "RK", "RANK", "ECR"))
        players.append({
            "name": name.strip(), "team": team, "pos": pos, "posRank": pos_rank,
            "ecr": ecr,
            "tier": as_num(pick(r, "TIERS", "TIER")),
            "bye": as_num(pick(r, "BYE WEEK", "BYE")),
            "sos": as_num(pick(r, "SOS SEASON", "SOS")),
            "adp": as_num(pick(r, "ADP")),
            "ecrAvg": as_num(pick(r, "AVG.", "AVG")),
            "ecrBest": as_num(pick(r, "BEST")),
            "ecrWorst": as_num(pick(r, "WORST")),
            "ecrStdDev": as_num(pick(r, "STD.DEV", "STD DEV")),
            "projPoints": as_num(pick(r, "PROJ. PTS", "PROJ PTS", "FPTS",
                                      "PROJECTED POINTS", "POINTS")),
        })
    kind = f"{implied} rankings" if implied else "overall rankings"
    return players, kind


def parse_adp_file(path):
    _, records = read_table(path)
    rows = []
    for r in records:
        cell = pick(r, "PLAYER TEAM (BYE)", "PLAYER")
        if not cell:
            continue
        name, team, bye = parse_player_team_bye(cell)
        if not name:
            continue
        rows.append({"name": name, "team": team, "bye": bye,
                     "adp": as_num(pick(r, "AVG.", "AVG")),
                     "adpOverall": as_num(pick(r, "OVERALL"))})
    return rows, "ADP"


def classify(path):
    headers, _ = read_table(path)
    if not headers:
        return "skip"
    if "PLAYERTEAMBYE" in headers:
        return "adp"
    if any(c in headers for c in NAME_COLUMNS):
        return "rankings"
    return "skip"


def main():
    ap = argparse.ArgumentParser(description="Merge FantasyPros CSVs into data/players.json")
    ap.add_argument("--dir", default=os.path.join(ROOT, "Fantasy Ranking"),
                    help='folder of downloaded CSVs (default: "Fantasy Ranking")')
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "players.json"))
    ap.add_argument("--season", default="2026")
    ap.add_argument("--scoring", default="HALF")
    args = ap.parse_args()

    if not os.path.isdir(args.dir):
        sys.exit(f"No such folder: {args.dir}")

    files = sorted(f for f in os.listdir(args.dir) if f.lower().endswith(".csv"))
    if not files:
        sys.exit(f"No .csv files in {args.dir}")

    merged = {}           # (nameKey, pos) -> player
    sources = defaultdict(list)
    notes = []
    overall_seen = False

    # Rankings first so ADP has something to attach to.
    parsed = []
    for fn in files:
        path = os.path.join(args.dir, fn)
        kind = classify(path)
        if kind == "skip":
            notes.append(f"{fn}: unrecognized layout, skipped.")
            continue
        parsed.append((fn, path, kind))

    for fn, path, kind in [p for p in parsed if p[2] == "rankings"]:
        players, label = parse_rankings_file(path)
        if not players:
            notes.append(f"{fn}: {label}, skipped.")
            continue
        is_overall = label == "overall rankings"
        overall_seen = overall_seen or is_overall
        print(f"  {fn}  ->  {len(players)} players ({label})")
        sources[label].append(fn)

        # Fields whose meaning is the same in any export.
        PORTABLE = ("tier", "bye", "sos")
        # Fields that only mean "overall" in an overall-rankings export.
        OVERALL_ONLY = ("ecr", "adp", "posRank", "ecrAvg", "ecrBest",
                        "ecrWorst", "ecrStdDev", "projPoints")

        for p in players:
            key = (name_key(p["name"]), p["pos"])
            cur = merged.get(key)
            if cur is None:
                seed = dict(p, _fromOverall=is_overall)
                if not is_overall:
                    # Provisional: a later overall file overwrites these, and
                    # if none arrives the notes flag them as positional.
                    seed["_provisionalRanks"] = True
                merged[key] = seed
                continue

            for fld in PORTABLE:
                if cur.get(fld) is None and p.get(fld) is not None:
                    cur[fld] = p[fld]
            if not cur.get("team") and p.get("team"):
                cur["team"] = p["team"]

            if is_overall:
                # Authoritative: replace anything a specialty file guessed at.
                for fld in OVERALL_ONLY:
                    if p.get(fld) is not None:
                        cur[fld] = p[fld]
                cur["_fromOverall"] = True
                cur.pop("_provisionalRanks", None)
            elif cur.get("_provisionalRanks"):
                # Still no overall source; fill blanks only.
                for fld in OVERALL_ONLY:
                    if cur.get(fld) is None and p.get(fld) is not None:
                        cur[fld] = p[fld]

    if not merged:
        sys.exit("No players parsed from any file.")

    # ADP last, folded onto the merged pool.
    by_name_team = {}
    by_name = defaultdict(list)
    for (nk, pos), p in merged.items():
        if p.get("team"):
            by_name_team[(nk, p["team"])] = p
        by_name[nk].append(p)

    for fn, path, kind in [p for p in parsed if p[2] == "adp"]:
        rows, label = parse_adp_file(path)
        matched = unmatched = 0
        for row in rows:
            nk = name_key(row["name"])
            target = by_name_team.get((nk, row["team"])) if row["team"] else None
            if target is None:
                cands = by_name.get(nk, [])
                target = cands[0] if len(cands) == 1 else None
            if target is None:
                unmatched += 1
                continue
            if row["adp"] is not None:
                target["adp"] = row["adp"]
            if target.get("bye") is None and row["bye"] is not None:
                target["bye"] = row["bye"]
            matched += 1
        print(f"  {fn}  ->  {matched} ADP rows merged"
              + (f", {unmatched} unmatched" if unmatched else ""))
        sources[label].append(fn)
        notes.append(f"{fn}: merged ADP for {matched} players"
                     + (f"; {unmatched} rows had no ranked match." if unmatched else "."))

    players = list(merged.values())
    provisional = [p["name"] for p in players if p.get("_provisionalRanks")]
    if provisional:
        notes.append(
            f"{len(provisional)} player(s) appear only in a per-position or specialty export, so "
            "their rank/ADP are that list's own numbers, not overall-board values "
            f"(e.g. {', '.join(provisional[:4])}). Add the Draft Overall Rankings export to fix them.")
    for p in players:
        p.pop("_fromOverall", None)
        p.pop("_provisionalRanks", None)
        p["id"] = slug(p["name"], p["team"] or p["pos"], p["pos"])
        p["ecrVsAdp"] = (round(p["adp"] - p["ecr"], 1)
                         if p.get("adp") is not None and p.get("ecr") is not None else None)

    players.sort(key=lambda p: p["ecr"] if p["ecr"] is not None else 1e9)

    counters = defaultdict(int)
    for p in players:
        counters[p["pos"]] += 1
        if p["posRank"] is None:
            p["posRank"] = counters[p["pos"]]

    # Tell the user what the board is still missing, since that changes what
    # the app can do (tier cliffs, bye conflicts, ADP value signals).
    have = lambda f: sum(1 for p in players if p.get(f) is not None)
    if not overall_seen:
        notes.append("No overall-rankings file found — cross-position ordering comes from "
                     "per-position ECR, which is less reliable. Add the Draft Overall Rankings export.")
    for fld, msg in (("tier", "tier-cliff detection"),
                     ("bye", "bye-conflict warnings"),
                     ("adp", "ADP value signals")):
        n = have(fld)
        if n == 0:
            notes.append(f"No {fld} data in any file — {msg} disabled.")
        elif n < len(players) * 0.6:
            notes.append(f"Only {n}/{len(players)} players have {fld} — {msg} will be partial.")
    notes.append("True VORP available (projected points present)." if have("projPoints")
                 else "No projected points — the app uses its labeled rank-based surrogate.")

    out = {
        "source": f"Merged from {len(parsed)} CSV file(s) in {os.path.basename(args.dir)}",
        "season": args.season,
        "scoring": args.scoring,
        "fetchedAt": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
        "notes": notes,
        "players": players,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)

    counts = defaultdict(int)
    for p in players:
        counts[p["pos"]] += 1
    print(f"\nWrote {len(players)} players -> {args.out}")
    print("  " + "  ".join(f"{k}:{v}" for k, v in sorted(counts.items())))
    print(f"  coverage: tier {have('tier')}  bye {have('bye')}  adp {have('adp')}"
          f"  proj {have('projPoints')}   (of {len(players)})")
    for n in notes:
        print(f"  - {n}")
    print("\nOpen the app and press 'Load data/players.json'.")


if __name__ == "__main__":
    main()
