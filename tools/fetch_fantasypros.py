#!/usr/bin/env python3
"""Fetch FantasyPros rankings (and optionally projections) into data/players.json.

WHY THIS IS A SCRIPT AND NOT A FETCH() IN THE APP
-------------------------------------------------
api.fantasypros.com does not send CORS headers, and it has no OPTIONS route:

    $ curl -i -X OPTIONS https://api.fantasypros.com/public/v2/json/nfl/2026/consensus-rankings \
        -H 'Origin: https://example.github.io' -H 'Access-Control-Request-Method: GET'
    HTTP/2 403
    {"message":"Missing Authentication Token"}      # and no Access-Control-Allow-* header

Sending an `x-api-key` header from a page triggers a CORS preflight, that
preflight fails, and the browser blocks the request before it is ever made.
No amount of client-side code gets around that -- it needs either a proxy you
control or a fetch that isn't a browser. This script is the latter: it runs on
your machine, so there is no CORS, and your FantasyPros key stays on disk
instead of in localStorage.

USAGE
-----
    export FANTASYPROS_API_KEY=...            # or pass --key, or put it in .fpkey
    python3 tools/fetch_fantasypros.py --season 2026 --scoring HALF

    # include projections so the app computes true VORP from points
    python3 tools/fetch_fantasypros.py --season 2026 --scoring HALF --projections

Then open the app and press "Load data/players.json".
Re-run it the morning of your draft -- rankings are a snapshot.

Get a key at https://secure.fantasypros.com/api-keys/request/ (free tier is
fine for personal use; see https://www.fantasypros.com/api-data/).
"""

import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import credentials  # noqa: E402

BASE = "https://api.fantasypros.com/public/v2/json"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SCORING_CHOICES = ["STD", "HALF", "PPR"]
VALID_POS = {"QB", "RB", "WR", "TE", "DST", "K"}

# The premium plan allows 1 request/second, 500/day. This script makes about
# five calls, so the daily budget is irrelevant; the per-second one is not.
MIN_INTERVAL_S = 1.2
_last_call = [0.0]


def _ssl_context():
    """Some Python installs (python.org builds where Install Certificates was
    never run) have no CA bundle and fail every HTTPS call with
    CERTIFICATE_VERIFY_FAILED. Fall back to the system bundle rather than
    disabling verification, which would be the wrong fix."""
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


SSL_CTX = _ssl_context()


def resolve_key(cli_key):
    key = credentials.resolve(
        cli=cli_key,
        env_vars=("FANTASYPROS_API_KEY",),
        service="ffl-fantasypros",
        dotfile=os.path.join(ROOT, ".fpkey"),
        required=False,
    )
    if key:
        return key
    sys.exit(
        "No API key. Store one with:  python3 tools/credentials.py set ffl-fantasypros\n"
        "  (or set FANTASYPROS_API_KEY, pass --key, or write it to .fpkey)\n"
        "Request a key at https://secure.fantasypros.com/api-keys/request/"
    )


class ApiError(Exception):
    pass


def get(path, key, soft=False, **params):
    """Fetch and decode. With soft=True, return None on failure instead of
    exiting -- used for the optional enrichment endpoints, which a free-tier
    plan may not cover and which must never take the whole run down."""
    # Cache-bust every call. The API sits behind CloudFront, which will
    # happily serve a response cached from before a plan upgrade — that is
    # exactly how a premium key kept reporting tier=free and 10 of 878
    # records. Stale data on draft morning is the failure mode to avoid.
    q = {k: v for k, v in params.items() if v is not None}
    q["_cb"] = str(int(time.time() * 1000))
    url = f"{BASE}{path}?{urllib.parse.urlencode(q)}"

    # Respect 1 request/second.
    wait = MIN_INTERVAL_S - (time.monotonic() - _last_call[0])
    if wait > 0:
        time.sleep(wait)
    _last_call[0] = time.monotonic()

    req = urllib.request.Request(url, headers={
        "x-api-key": key,
        "Accept": "application/json",
        "Cache-Control": "no-cache",
    })
    try:
        with urllib.request.urlopen(req, timeout=45, context=SSL_CTX) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:200].replace("\n", " ")
        msg = f"HTTP {e.code}"
        if e.code in (401, 403):
            msg += " — check the key, and that your plan covers this endpoint"
        elif e.code == 404:
            msg += " — endpoint not found at this path"
        elif e.code == 429:
            msg += " — rate limited (1 req/sec, 500/day on premium)"
        detail = f"{msg}. {body}".strip()
    except urllib.error.URLError as e:
        detail = f"could not reach the API: {e.reason}"
    except json.JSONDecodeError:
        detail = "response was not valid JSON"

    if soft:
        raise ApiError(detail)
    sys.exit(f"{detail}\n  url: {url}")


def tier_note(payload, label, count_seen):
    """Detect a truncated response.

    `public_api_limited` is true even on premium, so it says nothing on its
    own — the only reliable signal is getting back fewer records than the
    payload's own `count`. The free tier returns 10 of 878 that way, and
    offset/page/start are all ignored, so there is no pagination to fall back
    on: a short response means a short board.
    """
    if not isinstance(payload, dict):
        return None
    total = payload.get("count")
    if not isinstance(total, int) or count_seen >= total:
        return None
    return (f"{label}: API returned {count_seen} of {total} records — key is on the "
            f"'{payload.get('tier')}' tier, capped at {payload.get('limit')} per response. "
            f"Upgrade at fantasypros.com/api-data/ for the full set.")


def find_player_list(payload):
    """The response wrapper has changed shape before; find the player array
    rather than hardcoding one key."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for k in ("players", "data", "results", "items"):
            v = payload.get(k)
            if isinstance(v, list) and v:
                return v
        # Fall back to the first list-of-dicts anywhere in the top level.
        for v in payload.values():
            if isinstance(v, list) and v and isinstance(v[0], dict):
                return v
    return []


def field(rec, *names, default=None):
    for n in names:
        if n in rec and rec[n] not in (None, "", "-"):
            return rec[n]
    return default


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


def split_pos(raw, fallback=None):
    s = str(raw or fallback or "").upper().strip()
    m = re.match(r"^([A-Z]+)(\d+)?$", s)
    if not m:
        return (fallback or None), None
    pos = m.group(1)
    if pos in ("D", "DEF"):
        pos = "DST"
    if pos == "PK":
        pos = "K"
    return pos, (int(m.group(2)) if m.group(2) else None)


def slug(*parts):
    return re.sub(r"[^a-z0-9]+", "-", "-".join(str(p or "") for p in parts).lower()).strip("-")


def norm_key(name):
    toks = [t for t in re.sub(r"[^A-Z0-9\s]", "", str(name or "").upper()).split()
            if t not in {"JR", "SR", "II", "III", "IV", "V"}]
    return "".join(toks)


def normalize(rec):
    name = field(rec, "player_name", "name", "player")
    if not name:
        return None

    raw_pos = field(rec, "player_position_id", "position_id", "position", "pos")
    pos_rank_raw = field(rec, "pos_rank", "player_position_rank")
    pos, pos_rank = split_pos(pos_rank_raw, fallback=raw_pos)
    if pos not in VALID_POS:
        pos, _ = split_pos(raw_pos)
    if pos not in VALID_POS:
        return None

    team = str(field(rec, "player_team_id", "team_id", "team", default="") or "").upper() or None

    return {
        "id": slug(name, team or pos, pos),
        # FantasyPros' own player_id. News and injuries carry only this, never
        # a name, so it is the join key for both.
        "fpId": field(rec, "player_id", "fpid"),
        "name": str(name).strip(),
        "team": team,
        "pos": pos,
        "posRank": pos_rank,
        "ecr": as_num(field(rec, "rank_ecr", "rank", "ecr")),
        "tier": as_num(field(rec, "tier", "player_tier")),
        "bye": as_num(field(rec, "player_bye_week", "bye_week", "bye")),
        "sos": as_num(field(rec, "player_sos", "sos_season", "sos")),
        "ecrAvg": as_num(field(rec, "rank_ave", "rank_avg", "avg")),
        "ecrBest": as_num(field(rec, "rank_min", "best")),
        "ecrWorst": as_num(field(rec, "rank_max", "worst")),
        "ecrStdDev": as_num(field(rec, "rank_std", "std_dev", "std")),
        # NOT player_owned_avg — that is roster-ownership percentage (99.5 for
        # a stud), which silently produced nonsense ADP. Real ADP comes from
        # the /players endpoint, merged separately below.
        "adp": as_num(field(rec, "adp", "avg_adp")),
        "ecrVsAdp": None,
        "projPoints": as_num(field(rec, "fpts", "proj_pts", "projected_points", "points")),
    }


def index_by_name(players):
    idx = {}
    for p in players:
        idx.setdefault((norm_key(p["name"]), p["pos"]), p)
        idx.setdefault(norm_key(p["name"]), p)
    return idx


def lookup(idx, name, pos=None):
    return idx.get((norm_key(name), pos)) or idx.get(norm_key(name))


def clean_player_name(raw):
    """The injuries feed appends a position to disambiguate ("Travis Hunter
    (CB)"), which defeats a plain name match."""
    return re.sub(r"\s*\(.*?\)\s*$", "", str(raw or "")).strip()


def merge_injuries(players, payload):
    """Attach injury status. This is the one thing a downloaded CSV can never
    tell you, and it moves draft boards on the morning of the draft.

    Matched on NAME, not player_id: the injuries feed uses a different id
    space from consensus-rankings (Travis Hunter is 27887 there and 26034 on
    the rankings board), so id matching silently attaches nothing.
    """
    idx = index_by_name(players)
    by_id = {p["fpId"]: p for p in players if p.get("fpId") is not None}
    matched = 0
    for rec in find_player_list(payload):
        name = clean_player_name(field(rec, "player_name", "name", "player"))
        if not name:
            continue
        pos, _ = split_pos(field(rec, "position_id", "player_position_id", "position"))
        target = lookup(idx, name, pos) or by_id.get(field(rec, "player_id"))
        if not target:
            continue
        status = field(rec, "status", "player_injury_status", "injury_status")
        # injury_type is often empty; comment carries the real substance.
        bits = [field(rec, "injury_type"), field(rec, "comment")]
        prob = field(rec, "probability_of_playing")
        if prob is not None:
            bits.append(f"{prob}% likely to play")
        practices = [field(rec, f"practice_{i}") for i in (1, 2, 3)]
        practices = [x for x in practices if x]
        if practices:
            bits.append("practice: " + "/".join(str(x) for x in practices))
        detail = " — ".join(str(b).strip() for b in bits if b)
        if not status and not detail:
            continue
        target["injury"] = {
            "status": str(status).strip() if status else None,
            "detail": detail[:200] or None,
        }
        matched += 1
    return matched


def merge_news(players, payload, per_player=2, max_chars=200):
    """Attach the most recent note or two per player.

    Deliberately capped: these ride in the prompt's evidence packet, and an
    unbounded news dump would blow the packet's size discipline for signal
    that is mostly noise by the third item.
    """
    by_id = {p["fpId"]: p for p in players if p.get("fpId") is not None}
    matched = 0
    for rec in find_player_list(payload):
        # The news feed carries player_id only — no name field exists on it,
        # so name matching silently attached nothing.
        target = by_id.get(field(rec, "player_id", "fpid"))
        if not target:
            continue
        text = field(rec, "title", "headline", "desc", "note", "text", "body")
        if not text:
            continue
        entry = {
            "text": re.sub(r"\s+", " ", str(text)).strip()[:max_chars],
            "date": field(rec, "published", "updated", "date", "timestamp"),
        }
        notes = target.setdefault("news", [])
        if len(notes) < per_player and entry["text"] not in [n["text"] for n in notes]:
            notes.append(entry)
            matched += 1
    return matched


POINTS_KEY = {"HALF": "points_half", "PPR": "points_ppr", "STD": "points"}

# Projection components the app rebuilds league scoring from. FantasyPros'
# points_half assumes 4-point passing TDs; this league pays 6 with -3 INTs, so
# the published total mis-ranks the whole quarterback board. Kept to an explicit
# list because the payload also carries per-game bonus counters that are zero
# for every player and must not be mistaken for usable data.
STAT_KEYS = ("pass_yds", "pass_tds", "pass_ints", "rush_yds", "rush_tds",
             "rec_rec", "rec_yds", "rec_tds", "fumbles", "2pt_tds", "ret_tds")


def pick_stats(stats):
    out = {}
    for k in STAT_KEYS:
        v = as_num(stats.get(k))
        if v is not None:
            out[k] = v
    return out or None


def merge_adp(players, payload, scoring):
    """ADP lives on /nfl/players as rank_adp (standard) / rank_adp_ppr."""
    idx = {p["fpId"]: p for p in players if p.get("fpId") is not None}
    key = "rank_adp_ppr" if scoring in ("PPR", "HALF") else "rank_adp"
    matched = 0
    for rec in find_player_list(payload):
        target = idx.get(field(rec, "player_id", "fpid"))
        if not target:
            continue
        adp = as_num(field(rec, key, "rank_adp"))
        # 0 means "unranked" in this feed, not "first overall".
        if adp:
            target["adp"] = adp
            matched += 1
    return matched


def merge_projections(players, proj_payload, scoring="HALF"):
    """Attach projected points, which is what turns the app's rank-based
    surrogate into true VORP.

    Matched on FantasyPros' player id first: the projections feed spells names
    differently from the rankings feed (suffixes, punctuation), so name
    matching drops real players. Name is the fallback for records with no id.
    """
    by_id = {p["fpId"]: p for p in players if p.get("fpId") is not None}
    by_key = {}
    for p in players:
        by_key.setdefault((norm_key(p["name"]), p["pos"]), p)

    matched, unmatched = 0, []
    for rec in find_player_list(proj_payload):
        name = field(rec, "player_name", "name", "player")
        stats = rec.get("stats") if isinstance(rec.get("stats"), dict) else {}
        # Take the total for THIS league's scoring. Bare `points` is standard
        # scoring, so using it in a Half-PPR league undervalues every receiver.
        pts = as_num(field(stats, POINTS_KEY.get(scoring, "points"), "points"))
        if pts is None:
            pts = as_num(field(rec, "fpts", "proj_pts", "projected_points", "points"))
        if pts is None:
            continue

        pos, _ = split_pos(field(rec, "position_id", "player_position_id", "position"))
        target = by_id.get(field(rec, "fpid", "player_id"))
        if target is None and name:
            target = by_key.get((norm_key(name), pos))

        if target:
            target["projPoints"] = pts
            target["projStats"] = pick_stats(stats)
            matched += 1
        elif name:
            unmatched.append(name)
    return matched, unmatched


def main():
    ap = argparse.ArgumentParser(description="Fetch FantasyPros data into data/players.json")
    ap.add_argument("--season", default="2026")
    ap.add_argument("--scoring", default="HALF", choices=SCORING_CHOICES)
    ap.add_argument("--type", dest="rank_type", default="Redraft",
                    choices=["Redraft", "Dynasty", "Rookies"])
    ap.add_argument("--week", default="0", help="0 = preseason/season-long")
    ap.add_argument("--projections", action="store_true",
                    help="Also fetch projections so the app computes true VORP")
    ap.add_argument("--news", action="store_true",
                    help="Attach recent player notes (2 per player, capped)")
    ap.add_argument("--injuries", action="store_true",
                    help="Attach injury status and practice designations")
    ap.add_argument("--all", action="store_true",
                    help="Everything: projections + news + injuries. Use this on draft morning.")
    ap.add_argument("--key", default=None)
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "players.json"))
    ap.add_argument("--dump-raw", action="store_true",
                    help="Also write the raw API response, for debugging a shape change")
    args = ap.parse_args()

    key = resolve_key(args.key)

    print(f"Fetching {args.season} consensus rankings ({args.scoring}, {args.rank_type})…")
    payload = get(f"/nfl/{args.season}/consensus-rankings", key,
                  position="ALL", scoring=args.scoring, type=args.rank_type, week=args.week)

    raw = find_player_list(payload)
    if not raw:
        keys = list(payload)[:12] if isinstance(payload, dict) else type(payload).__name__
        dump = os.path.join(ROOT, "data", "raw-response.json")
        os.makedirs(os.path.dirname(dump), exist_ok=True)
        with open(dump, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        sys.exit(f"No player list found in the response. Top-level keys: {keys}\n"
                 f"Wrote the raw response to {dump} — the response shape may have changed.")

    cap = tier_note(payload, "Rankings", len(raw))
    if cap:
        print("\n  " + cap)
        print("  A 10-player board is not usable for a draft. Aborting rather than")
        print("  writing a file that looks fine until you open it.\n")
        sys.exit(1)

    players = [p for p in (normalize(r) for r in raw) if p]
    if not players:
        sys.exit(f"Got {len(raw)} records but could not normalize any. "
                 f"Sample record keys: {sorted(raw[0])[:20]}")

    # De-dupe, keeping the better rank, then sort by ECR.
    best = {}
    for p in players:
        prev = best.get(p["id"])
        if prev is None or (p["ecr"] or 1e9) < (prev["ecr"] or 1e9):
            best[p["id"]] = p
    players = sorted(best.values(), key=lambda p: p["ecr"] if p["ecr"] is not None else 1e9)

    # Backfill positional rank where the API omitted it.
    counters = {}
    for p in players:
        counters[p["pos"]] = counters.get(p["pos"], 0) + 1
        if p["posRank"] is None:
            p["posRank"] = counters[p["pos"]]

    # ECR vs ADP: positive means he is lasting past his market price.
    for p in players:
        if p["adp"] is not None and p["ecr"] is not None:
            p["ecrVsAdp"] = round(p["adp"] - p["ecr"], 1)

    if args.all:
        args.projections = args.news = args.injuries = True

    notes = []
    # Enrichment is best-effort: rankings are the load-bearing part, and a
    # free-tier plan may not cover these endpoints.
    if args.injuries:
        print("Fetching injuries…")
        try:
            n = merge_injuries(players, get("/nfl/injuries", key, soft=True,
                                            season=args.season, week=args.week))
            notes.append(f"Injury status attached for {n} players.")
        except ApiError as e:
            notes.append(f"Injuries unavailable — {e}")
        print(f"  {notes[-1]}")

    if args.news:
        print("Fetching player news…")
        try:
            n = merge_news(players, get("/nfl/news", key, soft=True, limit=500))
            notes.append(f"Attached {n} recent news notes.")
        except ApiError as e:
            notes.append(f"News unavailable — {e}")
        print(f"  {notes[-1]}")

    print("Fetching ADP…")
    try:
        adp_payload = get("/nfl/players", key, soft=True, season=args.season)
        n = merge_adp(players, adp_payload, args.scoring)
        notes.append(f"ADP attached for {n} players.")
        t = tier_note(adp_payload, "ADP", len(find_player_list(adp_payload)))
        if t:
            notes.append(t)
    except ApiError as e:
        notes.append(f"ADP unavailable — {e}")
    print(f"  {notes[-1]}")

    if args.projections:
        print("Fetching projections…")
        proj = get(f"/nfl/{args.season}/projections", key,
                   position="ALL", scoring=args.scoring, week=args.week)
        matched, unmatched = merge_projections(players, proj, args.scoring)
        notes.append(f"Projections merged for {matched} of {len(players)} players.")
        print("  " + notes[-1])
        if unmatched:
            notes.append(f"{len(unmatched)} projection rows did not match a ranked player "
                         f"(e.g. {', '.join(unmatched[:5])}).")

    have_proj = sum(1 for p in players if p["projPoints"] is not None)
    notes.append("True VORP available (projected points present)." if have_proj
                 else "No projected points — the app will use its labeled rank-based surrogate. "
                      "Re-run with --projections for true VORP.")

    out = {
        "source": "FantasyPros API",
        "season": args.season,
        "scoring": args.scoring,
        "type": args.rank_type,
        "fetchedAt": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
        "notes": notes,
        "players": players,
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)

    if args.dump_raw:
        dump = os.path.join(os.path.dirname(args.out), "raw-response.json")
        with open(dump, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        print(f"Raw response → {dump}")

    counts = {}
    for p in players:
        counts[p["pos"]] = counts.get(p["pos"], 0) + 1
    print(f"\nWrote {len(players)} players → {args.out}")
    print("  " + "  ".join(f"{k}:{v}" for k, v in sorted(counts.items())))
    for n in notes:
        print(f"  {n}")
    print("\nNow open the app and press 'Load data/players.json'.")


if __name__ == "__main__":
    main()
