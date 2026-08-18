"""Yahoo Fantasy Sports OAuth2 — one-time login, then automatic refresh.

Yahoo does not issue a plain API key. You register an app, get a client ID and
secret, approve it once in a browser, and exchange the resulting code for a
refresh token that keeps working indefinitely. Only the refresh token is
persisted; access tokens live one hour and are fetched on demand.

Setup, once:

  1. https://developer.yahoo.com/apps/create/
       Application Type : Confidential Client
       Redirect URI     : anything you control, e.g. https://localhost:8000
       API Permissions  : Fantasy Sports -> Read
  2. python3 tools/credentials.py set ffl-yahoo-id
     python3 tools/credentials.py set ffl-yahoo-secret
  3. python3 tools/yahoo_auth.py login
  4. python3 tools/yahoo_auth.py check

Nothing has to be listening on the redirect URI. Yahoo appends the code to it
and the browser then fails to connect -- that failure is expected and harmless.
The code is in the address bar, and `login` accepts the whole URL pasted in.

Nothing is written to disk in plaintext and no secret is ever passed as a
command-line argument, where it would land in shell history and `ps` output.

Other tools use this by importing it:

    from yahoo_auth import api_get
    data = api_get("league/461.l.83923/draftresults")
"""

import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import credentials  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth"
TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token"
API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2/"

# Yahoo requires the redirect_uri sent at token exchange to match the one
# registered on the app, byte for byte -- including any trailing slash. It is
# not a secret, so it lives in a plain file rather than the Keychain.
APP_CONFIG = os.path.join(ROOT, "data", "yahoo-app.json")
DEFAULT_REDIRECT = "https://localhost/"

# Checking "Fantasy Sports -> Read" on the app is necessary but not sufficient:
# it only makes the scope *available*. If the authorization request omits it,
# Yahoo happily issues a profile-only token, and then every Fantasy endpoint --
# even public ones like game/nfl -- returns 403 "not authorized to perform this
# action", which reads like a permissions problem on the app rather than a
# missing scope on the token.
SCOPE = "fspt-r"

# Yahoo throttles aggressively and returns 999 when it thinks you are a bot.
MIN_INTERVAL_S = 0.6
_last_call = [0.0]


def _ssl_context():
    """Mirrors fetch_fantasypros.py: some python.org builds ship no CA bundle
    and fail every HTTPS call. Fall back to the system bundle rather than
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


class YahooError(Exception):
    pass


def _client():
    cid = credentials.resolve(
        env_vars=("YAHOO_CLIENT_ID",), service="ffl-yahoo-id",
        dotfile=os.path.join(ROOT, ".yhid"), required=False)
    secret = credentials.resolve(
        env_vars=("YAHOO_CLIENT_SECRET",), service="ffl-yahoo-secret",
        dotfile=os.path.join(ROOT, ".yhsecret"), required=False)
    if not cid or not secret:
        sys.exit(
            "Missing Yahoo app credentials. Store them with:\n"
            "  python3 tools/credentials.py set ffl-yahoo-id\n"
            "  python3 tools/credentials.py set ffl-yahoo-secret\n"
            "Create the app first at https://developer.yahoo.com/apps/create/\n"
            "  (Installed Application, redirect URI 'oob', Fantasy Sports -> Read)"
        )
    return cid, secret


def _load_redirect():
    try:
        with open(APP_CONFIG, encoding="utf-8") as f:
            v = json.load(f).get("redirect_uri")
            if v:
                return v
    except (OSError, ValueError):
        pass
    return None


def _save_redirect(uri):
    os.makedirs(os.path.dirname(APP_CONFIG), exist_ok=True)
    with open(APP_CONFIG, "w", encoding="utf-8") as f:
        json.dump({"redirect_uri": uri}, f, indent=2)


def _redirect_uri(required=True):
    uri = os.environ.get("YAHOO_REDIRECT_URI") or _load_redirect()
    if uri or not required:
        return uri
    sys.exit("No redirect URI recorded. Run:  python3 tools/yahoo_auth.py login")


def _extract_code(pasted):
    """Accept either a bare verifier code or the whole redirected URL."""
    pasted = pasted.strip().strip('"').strip("'")
    if "?" in pasted or pasted.lower().startswith("http"):
        qs = urllib.parse.urlparse(pasted).query
        found = urllib.parse.parse_qs(qs).get("code")
        if found:
            return found[0]
        err = urllib.parse.parse_qs(qs).get("error")
        if err:
            sys.exit(f"Yahoo returned an error instead of a code: {err[0]}")
    return pasted


def _post_token(fields):
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(TOKEN_URL, data=body, headers={
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    })
    try:
        with urllib.request.urlopen(req, timeout=45, context=SSL_CTX) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")[:400]
        raise YahooError(f"HTTP {err.code} from Yahoo token endpoint: {detail}") from err
    except urllib.error.URLError as err:
        raise YahooError(f"Could not reach Yahoo: {err.reason}") from err


def login(redirect_cli=None):
    cid, secret = _client()

    redirect = redirect_cli or _redirect_uri(required=False)
    if not redirect:
        print("\nWhat Redirect URI did you register on the Yahoo app?")
        print(f"Press Enter to accept the default [{DEFAULT_REDIRECT}]\n")
        redirect = input("   Redirect URI: ").strip() or DEFAULT_REDIRECT
    print(f"\nUsing redirect URI: {redirect}")
    print("It must match the Yahoo app exactly, including any trailing slash.")

    params = urllib.parse.urlencode({
        "client_id": cid, "redirect_uri": redirect,
        "response_type": "code", "scope": SCOPE, "language": "en-us",
    })
    print("\n1. Open this URL and approve access:\n")
    print(f"   {AUTH_URL}?{params}\n")
    print("2. Your browser will then fail to load the redirect. That is expected —")
    print("   nothing is listening there. Copy the full address bar contents.\n")
    pasted = input("   Paste the URL (or just the code): ").strip()
    if not pasted:
        sys.exit("Nothing entered.")
    code = _extract_code(pasted)

    tok = _post_token({
        "client_id": cid, "client_secret": secret, "redirect_uri": redirect,
        "code": code, "grant_type": "authorization_code",
    })
    refresh = tok.get("refresh_token")
    if not refresh:
        sys.exit(f"Yahoo returned no refresh token. Response keys: {list(tok)}")

    credentials.keychain_set("ffl-yahoo-refresh", refresh)
    _save_redirect(redirect)
    print("\nStored the refresh token in your login keychain as 'ffl-yahoo-refresh'.")
    print("You will not need to repeat this. Verify with:")
    print("  python3 tools/yahoo_auth.py check")


def access_token():
    """Exchange the stored refresh token for a fresh access token."""
    refresh = credentials.keychain_get("ffl-yahoo-refresh") or os.environ.get("YAHOO_REFRESH_TOKEN")
    if not refresh:
        sys.exit("Not logged in yet. Run:  python3 tools/yahoo_auth.py login")
    cid, secret = _client()
    tok = _post_token({
        "client_id": cid, "client_secret": secret, "redirect_uri": _redirect_uri(),
        "refresh_token": refresh, "grant_type": "refresh_token",
    })
    at = tok.get("access_token")
    if not at:
        sys.exit("Refresh failed — the token may have been revoked. Run 'login' again.")
    # Yahoo sometimes rotates the refresh token; persist it when it does.
    new_refresh = tok.get("refresh_token")
    if new_refresh and new_refresh != refresh:
        credentials.keychain_set("ffl-yahoo-refresh", new_refresh)
    return at


_token_cache = {"value": None, "expires": 0.0}


def _cached_token():
    if _token_cache["value"] and time.time() < _token_cache["expires"]:
        return _token_cache["value"]
    at = access_token()
    # Yahoo access tokens last an hour; refresh a little early.
    _token_cache.update(value=at, expires=time.time() + 3000)
    return at


def api_get(path, **params):
    """GET a Fantasy API resource and return parsed JSON.

    `path` is everything after /fantasy/v2/, e.g. "league/461.l.83923/draftresults".
    """
    params.setdefault("format", "json")
    url = API_BASE + path.lstrip("/") + "?" + urllib.parse.urlencode(params)

    wait = MIN_INTERVAL_S - (time.time() - _last_call[0])
    if wait > 0:
        time.sleep(wait)
    _last_call[0] = time.time()

    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {_cached_token()}",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=45, context=SSL_CTX) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")[:400]
        if err.code == 401:
            raise YahooError("401 — token rejected. Run 'yahoo_auth.py login' again.") from err
        if err.code == 403:
            raise YahooError(
                "403 — token carries no usable scope. Yahoo says 'this application "
                "is not authorized', which sounds like the endpoint but means the "
                "app.\n"
                "  Confirm it is the app, not this tool: a valid token should reach\n"
                "  https://api.login.yahoo.com/openid/v1/userinfo, which needs only\n"
                "  basic profile scope. If that 403s too, no scope is attaching.\n"
                "  Ticking 'Fantasy Sports -> Read' on an existing app is unreliable;\n"
                "  recreating the app with the permission set at creation works."
            ) from err
        if err.code == 999:
            raise YahooError("999 — Yahoo rate limited this client. Wait and retry.") from err
        raise YahooError(f"HTTP {err.code} for {path}: {detail}") from err
    except urllib.error.URLError as err:
        raise YahooError(f"Could not reach Yahoo: {err.reason}") from err


def check():
    """Confirm the credentials work and list the leagues they can see."""
    data = api_get("users;use_login=1/games;game_keys=nfl/leagues")
    print("Authenticated. Leagues visible to this token:\n")
    found = 0
    # The Fantasy API's JSON is a deeply nested mix of dicts keyed by numeric
    # strings and lists; walking it generically is more robust than indexing a
    # shape that differs between resources.
    def walk(node):
        nonlocal found
        if isinstance(node, dict):
            if "league_key" in node and "name" in node:
                print(f"  {node.get('season', '????')}  {node['league_key']:20} {node['name']}")
                found += 1
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)
    if not found:
        print("  (none found — the raw payload is below)")
        print(json.dumps(data)[:1200])


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=["login", "check"])
    ap.add_argument("--redirect", help="Redirect URI registered on the Yahoo app")
    args = ap.parse_args()
    try:
        if args.action == "login":
            login(args.redirect)
        else:
            check()
    except YahooError as err:
        sys.exit(f"Yahoo API error: {err}")


if __name__ == "__main__":
    main()
