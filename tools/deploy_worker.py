#!/usr/bin/env python3
"""Deploy worker/worker.js to Cloudflare and set its secrets — no wrangler, no Node.

Talks to the Cloudflare REST API directly with stdlib urllib, because there is
no Node on this machine to run wrangler.

    # 1. Make a token: https://dash.cloudflare.com/profile/api-tokens
    #    "Create Token" -> "Edit Cloudflare Workers" template is fine, or a
    #    custom token with Account > Workers Scripts > Edit.
    # 2. Put it somewhere this script can find it:
    export CLOUDFLARE_API_TOKEN=...        # or write it to .cfkey (gitignored)

    # 3. Deploy. Prompts for the two secrets without echoing them.
    python3 tools/deploy_worker.py

    # Re-deploy after editing worker.js, keeping the existing secrets:
    python3 tools/deploy_worker.py --skip-secrets

Nothing secret is written to disk, passed on the command line, or printed.
"""

import argparse
import getpass
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import credentials  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://api.cloudflare.com/client/v4"
WORKER_FILE = os.path.join(ROOT, "worker", "worker.js")
COMPAT_DATE = "2026-01-01"

del mimetypes  # not needed; parts are typed explicitly below


def resolve_token(cli):
    tok = credentials.resolve(
        cli=cli,
        env_vars=("CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"),
        service="ffl-cloudflare",
        dotfile=os.path.join(ROOT, ".cfkey"),
        required=False,
    )
    if tok:
        return tok
    sys.exit(
        "No Cloudflare API token.\n"
        "  Create one at https://dash.cloudflare.com/profile/api-tokens\n"
        "  (template 'Edit Cloudflare Workers', or Account > Workers Scripts > Edit)\n"
        "  then store it with:  python3 tools/credentials.py set ffl-cloudflare\n"
        "  (or export CLOUDFLARE_API_TOKEN=... , or write it to .cfkey)"
    )


def call(method, path, token, body=None, content_type="application/json", raw=False):
    url = f"{API}{path}"
    data = body if raw else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode())
            errs = "; ".join(
                f"{x.get('code')}: {x.get('message')}" for x in payload.get("errors", [])
            ) or json.dumps(payload)[:300]
        except Exception:
            errs = f"HTTP {e.code}"
        hint = ""
        if e.code in (401, 403):
            if path == "/accounts":
                # The "Edit Cloudflare Workers" template often omits account
                # listing, which is a permissions quirk rather than a real
                # blocker — the ID is visible in the dashboard.
                hint = ("\n  This token can't list accounts, which is normal for the Workers"
                        "\n  template. Pass the ID directly instead:"
                        "\n    python3 tools/deploy_worker.py --account <ACCOUNT_ID>"
                        "\n  Find it at dash.cloudflare.com -> Workers & Pages -> right sidebar"
                        "\n  'Account ID', or in the dashboard URL after dash.cloudflare.com/")
            else:
                hint = "\n  The token is missing the Workers Scripts:Edit permission, or is wrong."
        sys.exit(f"Cloudflare API error on {method} {path}\n  {errs}{hint}")
    except urllib.error.URLError as e:
        sys.exit(f"Could not reach Cloudflare: {e.reason}")


ACCOUNT_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def validate_account(value):
    """Fail fast on a placeholder or malformed ID. Cloudflare's own error for
    this is 7003 'perhaps your object identifier is invalid?', which does not
    make it obvious that the literal word YOUR_ACCOUNT_ID was sent."""
    v = value.strip()
    if not ACCOUNT_ID_RE.match(v):
        looks_placeholder = ("your" in v.lower() or "<" in v or v.upper() == v and "_" in v)
        sys.exit(
            f"That doesn't look like a Cloudflare account ID: {v!r}\n"
            + ("  It looks like the placeholder text rather than a real value.\n"
               if looks_placeholder else "")
            + "  An account ID is 32 lowercase hex characters, e.g. 9a7b1c2d3e4f5061728394a5b6c7d8e9\n"
            "  Find it at dash.cloudflare.com -> Workers & Pages -> right sidebar 'Account ID',\n"
            "  or in the dashboard URL right after dash.cloudflare.com/"
        )
    return v


def resolve_account(token, cli):
    if cli:
        return validate_account(cli)
    env = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if env:
        return validate_account(env)
    res = call("GET", "/accounts", token)
    accounts = res.get("result") or []
    if not accounts:
        sys.exit("Token has no accounts. Check its permissions.")
    if len(accounts) > 1:
        print("Multiple accounts on this token:")
        for a in accounts:
            print(f"  {a['id']}  {a['name']}")
        sys.exit("Pick one with --account <id>")
    print(f"  account: {accounts[0]['name']}")
    return accounts[0]["id"]


def multipart(fields, files):
    """Encode a multipart/form-data body. `files` is [(name, filename, ctype, bytes)]."""
    boundary = f"----ffl{uuid.uuid4().hex}"
    out = bytearray()
    for name, value in fields.items():
        out += f"--{boundary}\r\n".encode()
        out += f'Content-Disposition: form-data; name="{name}"\r\n'.encode()
        out += b"Content-Type: application/json\r\n\r\n"
        out += value.encode() + b"\r\n"
    for name, filename, ctype, payload in files:
        out += f"--{boundary}\r\n".encode()
        out += (f'Content-Disposition: form-data; name="{name}"; '
                f'filename="{filename}"\r\n').encode()
        out += f"Content-Type: {ctype}\r\n\r\n".encode()
        out += payload + b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def upload(token, account, name, source):
    metadata = {
        "main_module": "worker.js",
        "compatibility_date": COMPAT_DATE,
        # Preserve secrets already set on the script, so re-deploying code
        # doesn't silently wipe ANTHROPIC_API_KEY and strand the Worker.
        "keep_bindings": ["secret_text", "plain_text"],
    }
    body, ctype = multipart(
        {"metadata": json.dumps(metadata)},
        [("worker.js", "worker.js", "application/javascript+module", source)],
    )
    call("PUT", f"/accounts/{account}/workers/scripts/{name}", token,
         body=body, content_type=ctype, raw=True)


def put_secret(token, account, name, key, value):
    call("PUT", f"/accounts/{account}/workers/scripts/{name}/secrets", token,
         {"name": key, "text": value, "type": "secret_text"})


def enable_subdomain(token, account, name):
    call("POST", f"/accounts/{account}/workers/scripts/{name}/subdomain", token,
         {"enabled": True})
    res = call("GET", f"/accounts/{account}/workers/subdomain", token)
    return (res.get("result") or {}).get("subdomain")


def smoke_test(url):
    """The gate is the whole point, so prove it rejects an unauthenticated call
    before trusting it with a key."""
    payload = json.dumps({
        "model": "claude-opus-5", "max_tokens": 16,
        "messages": [{"role": "user", "content": "hi"}],
    }).encode()
    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    # Without a browser-ish UA, Cloudflare's edge blocks the request with
    # 403 / error 1010 before it ever reaches the Worker, which reads as a
    # failed security check when nothing is actually wrong.
    req.add_header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                                 "AppleWebKit/537.36 (KHTML, like Gecko) "
                                 "Chrome/131.0.0.0 Safari/537.36")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode()[:200]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]
    except urllib.error.URLError as e:
        return None, str(e.reason)


def main():
    ap = argparse.ArgumentParser(description="Deploy the Cloudflare Worker proxy")
    ap.add_argument("--name", default="ffl-draft-proxy")
    ap.add_argument("--token", default=None)
    ap.add_argument("--account", default=None)
    ap.add_argument("--skip-secrets", action="store_true",
                    help="Deploy code only; leave existing secrets alone")
    args = ap.parse_args()

    if not os.path.exists(WORKER_FILE):
        sys.exit(f"Missing {WORKER_FILE}")
    with open(WORKER_FILE, "rb") as f:
        source = f.read()

    token = resolve_token(args.token)
    print("Resolving account…")
    account = resolve_account(token, args.account)

    print(f"Uploading {args.name} ({len(source)} bytes)…")
    upload(token, account, args.name, source)

    if not args.skip_secrets:
        print("\nSecrets (input is hidden, never logged or written to disk):")
        api_key = credentials.resolve(
            env_vars=("ANTHROPIC_API_KEY",), service="ffl-anthropic",
            prompt="  ANTHROPIC_API_KEY: ", required=False) or ""
        if not api_key.strip():
            sys.exit("An Anthropic API key is required.")
        passphrase = credentials.resolve(
            env_vars=("APP_PASSPHRASE",), service="ffl-passphrase",
            prompt="  APP_PASSPHRASE (make it long/random): ", required=False) or ""
        if len(passphrase.strip()) < 12:
            sys.exit("Use a passphrase of at least 12 characters — this is the only real gate.")
        put_secret(token, account, args.name, "ANTHROPIC_API_KEY", api_key.strip())
        put_secret(token, account, args.name, "APP_PASSPHRASE", passphrase.strip())
        print("  both secrets set")

    print("\nEnabling workers.dev route…")
    sub = enable_subdomain(token, account, args.name)
    url = f"https://{args.name}.{sub}.workers.dev" if sub else None

    if not url:
        print("\nDeployed, but could not read your workers.dev subdomain.")
        print("Find the URL in the dashboard under Workers & Pages.")
        return

    print(f"\nDeployed: {url}")

    print("\nVerifying the passphrase gate rejects an unauthenticated call…")
    status, body = smoke_test(url)
    if status == 401:
        print(f"  PASS — HTTP 401 {body.strip()[:80]}")
    elif status is None and "CERTIFICATE_VERIFY_FAILED" in body:
        # Common on Anaconda/self-built Pythons that lack a CA bundle. It says
        # nothing about the Worker, so don't let it look like one.
        print("  INCONCLUSIVE — this Python can't verify TLS certificates, so the test")
        print("  never left the machine. Nothing to do with the Worker. Verify with curl:")
        print(f"    curl -s -o /dev/null -w '%{{http_code}}\\n' -X POST {url} \\")
        print("      -H 'content-type: application/json' -A 'Mozilla/5.0' \\")
        print('      -d \'{"model":"claude-opus-5","max_tokens":16,'
              '"messages":[{"role":"user","content":"hi"}]}\'')
        print("  Expect 401.")
    elif status is None:
        print(f"  could not reach it yet ({body}). Propagation can take ~30s; retry the curl by hand.")
    elif status == 403 and "1010" in body:
        # Cloudflare's edge rejected this client, so the Worker never ran.
        # Inconclusive, not a failure — say so rather than crying wolf.
        print("  INCONCLUSIVE — Cloudflare's edge blocked this test client (error 1010),")
        print("  so the request never reached your Worker. Verify by hand:")
        print(f"    curl -s -o /dev/null -w '%{{http_code}}\\n' -X POST {url} \\")
        print("      -H 'content-type: application/json' \\")
        print("      -A 'Mozilla/5.0' \\")
        print('      -d \'{"model":"claude-opus-5","max_tokens":16,'
              '"messages":[{"role":"user","content":"hi"}]}\'')
        print("  Expect 401. Anything else, do not use the Worker.")
    else:
        print(f"  UNEXPECTED HTTP {status}: {body}")
        print("  Do NOT use this until an unauthenticated POST returns 401.")

    print("\nNext: in the app, Setup -> Claude -> Connection = 'Via Cloudflare Worker'")
    print(f"      Worker URL:  {url}")
    print("      Passphrase:  the APP_PASSPHRASE you just entered")
    print("\nThen set a spend cap: https://console.anthropic.com/settings/limits")


if __name__ == "__main__":
    main()
