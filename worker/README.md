# Cloudflare Worker proxy

Holds the Anthropic API key server-side so it never enters a browser. Deployed
entirely from the Cloudflare dashboard — **no CLI, no Node, nothing to install.**

Free tier is 100,000 requests/day. A full draft uses about 15.

## Why it's gated

A proxy that only forwards requests is **worse than keeping the key in your own
browser**. The Worker URL is visible in devtools on a public site, and anyone
who copies it can spend your credits from curl indefinitely — no browser
involved, so CORS never enters into it.

The passphrase is the actual security boundary. It works because you type it
into the app once per browser, rather than shipping it in the page source where
it would just be a slower way to publish a secret.

| Layer | Stops | Limit |
|---|---|---|
| Passphrase (`APP_PASSPHRASE`) | Everyone who doesn't have it | The real gate |
| Origin allowlist | Other sites embedding your proxy | Browser-enforced; curl sets any Origin |
| Model allowlist + `max_tokens` cap | Unbounded spend if the passphrase leaks | Caps damage, doesn't prevent it |
| Anthropic console spend limit | Runaway cost from any cause | Backstop — set it regardless |

## Setup

1. **Create the Worker.** [dash.cloudflare.com](https://dash.cloudflare.com) →
   Workers & Pages → Create → Worker. Name it something like
   `ffl-draft-proxy`. Deploy the placeholder.

2. **Paste the code.** Edit code → select all → replace with the contents of
   [`worker.js`](worker.js) → Deploy.

3. **Add the two secrets.** Settings → Variables and Secrets → Add. Use
   **Secret** (encrypted), not plaintext, for both:

   | Name | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your `sk-ant-…` key |
   | `APP_PASSPHRASE` | any long random string — generate with `openssl rand -base64 24` |

4. **Optional plaintext variables**, if the defaults don't fit:

   | Name | Default |
   |---|---|
   | `ALLOWED_ORIGINS` | `https://strockerik.github.io`, `http://localhost:8000`, `http://127.0.0.1:8000` |
   | `ALLOWED_MODELS` | `claude-opus-5,claude-sonnet-5,claude-haiku-4-5` |
   | `MAX_TOKENS_CAP` | `8000` |

5. **Point the app at it.** Open the app → Setup → Claude →
   Connection: **Via Cloudflare Worker**. Paste the Worker URL
   (`https://ffl-draft-proxy.<subdomain>.workers.dev`) and the passphrase.

6. **Set a spend limit** in the [Anthropic console](https://console.anthropic.com/settings/limits).
   Do this even if everything else is right.

## Verify it

Rejects a request with no passphrase:

```sh
curl -i -X POST https://ffl-draft-proxy.<subdomain>.workers.dev \
  -H 'content-type: application/json' \
  -d '{"model":"claude-opus-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
# expect: HTTP 401  {"error":{"message":"Bad or missing passphrase."}}
```

Works with it:

```sh
curl -s -X POST https://ffl-draft-proxy.<subdomain>.workers.dev \
  -H 'content-type: application/json' \
  -H 'x-app-passphrase: YOUR_PASSPHRASE' \
  -d '{"model":"claude-opus-5","max_tokens":16,"messages":[{"role":"user","content":"Say OK."}]}'
# expect: a normal Anthropic response body
```

Rejects a model outside the allowlist:

```sh
curl -s -X POST https://ffl-draft-proxy.<subdomain>.workers.dev \
  -H 'content-type: application/json' -H 'x-app-passphrase: YOUR_PASSPHRASE' \
  -d '{"model":"claude-fable-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
# expect: HTTP 400  "Model not allowed."
```

Then in the app: **Ask Claude** and check for the green "Claude" badge rather
than the amber fallback one.

## Rotating the passphrase

Change `APP_PASSPHRASE` in the dashboard, then update it in the app's Setup
panel on each browser you draft from. Old values stop working immediately.

## If it breaks on draft night

Switch Setup → Claude → Connection back to **Direct** and paste your API key.
Or ignore it entirely — the deterministic engine runs the whole draft without
any Claude call, and a failed request already falls back to it automatically.
The Worker is a convenience, never a dependency.
