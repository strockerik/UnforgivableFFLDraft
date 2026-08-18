"""Credential resolution for the tools in this folder.

Lookup order, first hit wins:

  1. an explicit --flag value
  2. an environment variable
  3. the macOS Keychain          <- encrypted at rest, gated by your login
  4. a gitignored dotfile        <- plaintext on disk
  5. an interactive prompt (hidden input)

The Keychain sits above the dotfile deliberately. A gitignored plaintext file
is a normal, workable choice for a single-user tool, but it is readable by any
process running as you, it rides along in any folder-level backup or upload,
and it survives in Time Machine snapshots after you delete it. The Keychain
costs one command to populate and removes all three of those.

Store a secret once:

    python3 tools/credentials.py set ffl-anthropic
    python3 tools/credentials.py set ffl-cloudflare

Check what's stored (prints only whether it exists, never the value):

    python3 tools/credentials.py check ffl-anthropic
"""

import getpass
import os
import subprocess
import sys

# Keychain service names used by the tools here.
SERVICES = {
    "ffl-anthropic": "Anthropic API key (sk-ant-...)",
    "ffl-cloudflare": "Cloudflare API token",
    "ffl-fantasypros": "FantasyPros API key",
    "ffl-passphrase": "Worker APP_PASSPHRASE",
    "ffl-yahoo-id": "Yahoo app Client ID (Consumer Key)",
    "ffl-yahoo-secret": "Yahoo app Client Secret (Consumer Secret)",
    "ffl-yahoo-refresh": "Yahoo OAuth2 refresh token (written by yahoo_auth.py login)",
}


def keychain_get(service):
    """Read a generic password from the macOS Keychain. Returns None if absent
    or if we're not on macOS."""
    if sys.platform != "darwin":
        return None
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-a", os.environ.get("USER", ""),
             "-s", service, "-w"],
            capture_output=True, text=True, timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    val = out.stdout.strip()
    return val or None


def keychain_set(service, value):
    if sys.platform != "darwin":
        raise RuntimeError("Keychain storage is macOS-only.")
    # -U updates in place if the item already exists.
    res = subprocess.run(
        ["security", "add-generic-password", "-a", os.environ.get("USER", ""),
         "-s", service, "-w", value, "-U",
         "-D", "application password", "-j", "Fantasy draft assistant"],
        capture_output=True, text=True, timeout=15,
    )
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip() or "keychain write failed")


def read_dotfile(path):
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            v = f.read().strip()
            return v or None
    return None


def resolve(cli=None, env_vars=(), service=None, dotfile=None, prompt=None, required=True):
    """Return the first credential found, or None / exit."""
    if cli and cli.strip():
        return cli.strip()

    for name in env_vars:
        v = os.environ.get(name)
        if v and v.strip():
            return v.strip()

    if service:
        v = keychain_get(service)
        if v:
            return v

    v = read_dotfile(dotfile)
    if v:
        return v

    if prompt:
        v = getpass.getpass(prompt).strip()
        if v:
            return v

    if not required:
        return None

    hints = []
    if env_vars:
        hints.append(f"export {env_vars[0]}=...")
    if service:
        hints.append(f"python3 tools/credentials.py set {service}")
    if dotfile:
        hints.append(f"write it to {os.path.basename(dotfile)}")
    sys.exit("No credential found. Try one of:\n  " + "\n  ".join(hints))


def _main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("set", "check"):
        print(__doc__)
        print("Known services:")
        for k, v in SERVICES.items():
            print(f"  {k:18} {v}")
        sys.exit(1)

    action, service = sys.argv[1], sys.argv[2]
    if action == "check":
        print(f"{service}: {'stored' if keychain_get(service) else 'not stored'}")
        return

    label = SERVICES.get(service, service)
    value = getpass.getpass(f"Value for {label} (hidden): ").strip()
    if not value:
        sys.exit("Nothing entered.")
    keychain_set(service, value)
    print(f"Stored in your login keychain as '{service}'.")
    print("The tools will find it automatically. Nothing was written to disk in plaintext.")


if __name__ == "__main__":
    _main()
