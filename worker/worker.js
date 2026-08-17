/**
 * Cloudflare Worker — Anthropic API proxy for the draft assistant.
 *
 * Paste this into the Cloudflare dashboard's Worker editor. No CLI, no Node.
 * Setup steps are in worker/README.md.
 *
 * WHAT THIS IS FOR
 * The app can call Anthropic directly with a key in localStorage, which is
 * fine for a private local tool. Once the app is on a public URL, that means
 * pasting your key into every browser you draft from. This Worker holds the
 * key instead.
 *
 * WHY IT IS GATED
 * A proxy that only forwards requests is WORSE than a key in your own browser:
 * the URL is visible in devtools on a public site, and anyone who copies it can
 * spend your credits from curl forever — no browser, so no CORS to stop them.
 * The passphrase check below is what makes this safe. It works precisely
 * because you type the passphrase into the app once per browser rather than
 * shipping it in the page source, where it would just be a slower way to
 * publish a secret.
 *
 * Required secrets (Settings → Variables → Add secret, i.e. encrypted):
 *   ANTHROPIC_API_KEY   your sk-ant-... key
 *   APP_PASSPHRASE      any long random string; you type this into the app
 *   FANTASYPROS_API_KEY optional. Enables GET /fantasypros, which lets the app
 *                       refresh its own player data on open. FantasyPros sends
 *                       no CORS headers, so the page cannot call it directly;
 *                       this route is the only way the browser gets fresh data
 *                       without a manual script run.
 *
 * Optional plaintext variables:
 *   ALLOWED_ORIGINS     comma-separated. Default: the GitHub Pages origin
 *                       plus localhost. Browser-enforced only.
 *   ALLOWED_MODELS      comma-separated. Default: the three the app offers.
 *   MAX_TOKENS_CAP      integer ceiling on max_tokens. Default 8000.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const FP_BASE = 'https://api.fantasypros.com/public/v2/json';

// Only these FantasyPros paths may be requested. Without an allowlist this
// route would be an open proxy for the key — anyone with the passphrase could
// pull any endpoint, and a path is far easier to guess than a model name.
const FP_ALLOWED = new Set([
  'consensus-rankings', 'projections', 'players', 'injuries', 'news',
]);

const DEFAULT_ORIGINS = [
  'https://strockerik.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];
const DEFAULT_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
const DEFAULT_MAX_TOKENS = 8000;
const MAX_BODY_BYTES = 256 * 1024;

const list = (v, fallback) =>
  (typeof v === 'string' && v.trim())
    ? v.split(',').map((s) => s.trim()).filter(Boolean)
    : fallback;

/** Length-independent comparison, so a wrong passphrase can't be discovered
 *  one character at a time by timing the response. */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a ?? ''));
  const y = enc.encode(String(b ?? ''));
  // Compare a fixed number of bytes regardless of input length.
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function corsHeaders(origin, allowed) {
  const ok = origin && allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-app-passphrase',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * Relay one FantasyPros endpoint. The browser cannot call this API itself —
 * no Access-Control-Allow-* headers and no OPTIONS route — so without this
 * the app depends on someone remembering to run a script before draft day.
 */
async function fantasyPros(url, env, cors) {
  if (!env.FANTASYPROS_API_KEY) {
    return json({
      error: { message: 'Worker has no FantasyPros key. Add FANTASYPROS_API_KEY as a secret.' },
    }, 501, cors);
  }

  const endpoint = url.searchParams.get('endpoint');
  if (!FP_ALLOWED.has(endpoint)) {
    return json({
      error: { message: `Unknown endpoint. Permitted: ${[...FP_ALLOWED].join(', ')}` },
    }, 400, cors);
  }

  const season = (url.searchParams.get('season') || '').replace(/[^0-9]/g, '') || '2026';
  const seasonScoped = endpoint === 'consensus-rankings' || endpoint === 'projections';
  const target = new URL(`${FP_BASE}/nfl/${seasonScoped ? season + '/' : ''}${endpoint}`);

  // Copy through only the parameters FantasyPros understands, so a caller
  // cannot smuggle anything into the upstream request.
  for (const k of ['position', 'scoring', 'type', 'week', 'limit']) {
    const v = url.searchParams.get(k);
    if (v) target.searchParams.set(k, v);
  }
  if (endpoint === 'players' || endpoint === 'injuries') target.searchParams.set('season', season);
  // Their CDN will otherwise serve a response cached from before a plan
  // upgrade, which is how a premium key reports tier=free and 10 of 878 rows.
  target.searchParams.set('_cb', String(Date.now()));

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: {
        'x-api-key': env.FANTASYPROS_API_KEY,
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    return json({ error: { message: `FantasyPros unreachable: ${err.message}` } }, 502, cors);
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      ...cors,
    },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowedOrigins = list(env.ALLOWED_ORIGINS, DEFAULT_ORIGINS);
    const cors = corsHeaders(origin, allowedOrigins);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const isFantasyPros = url.pathname.replace(/\/+$/, '').endsWith('/fantasypros');

    if (!env.APP_PASSPHRASE) {
      return json({ error: { message: 'Worker is missing its secrets.' } }, 500, cors);
    }

    // Browser-enforced. Does not stop curl, which is why the passphrase below
    // is the actual gate rather than a second opinion.
    if (origin && !allowedOrigins.includes(origin)) {
      return json({ error: { message: 'Origin not allowed.' } }, 403, cors);
    }

    if (!safeEqual(request.headers.get('x-app-passphrase'), env.APP_PASSPHRASE)) {
      return json({ error: { message: 'Bad or missing passphrase.' } }, 401, cors);
    }

    if (isFantasyPros) return fantasyPros(url, env, cors);

    if (request.method !== 'POST') {
      return json({ error: { message: 'Use POST.' } }, 405, cors);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: { message: 'Worker has no Anthropic key.' } }, 500, cors);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: { message: 'Request too large.' } }, 413, cors);
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: { message: 'Body was not valid JSON.' } }, 400, cors);
    }

    // Constrain what the key can be spent on, so a leaked passphrase caps the
    // damage at "some draft advice" rather than unbounded frontier-model spend.
    const allowedModels = list(env.ALLOWED_MODELS, DEFAULT_MODELS);
    if (!allowedModels.includes(body.model)) {
      return json({
        error: { message: `Model not allowed. Permitted: ${allowedModels.join(', ')}` },
      }, 400, cors);
    }

    const cap = Number(env.MAX_TOKENS_CAP) || DEFAULT_MAX_TOKENS;
    if (typeof body.max_tokens !== 'number' || body.max_tokens > cap) {
      body.max_tokens = cap;
    }
    // Streaming would need a different relay path; the app doesn't use it.
    delete body.stream;

    let upstream;
    try {
      upstream = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return json({ error: { message: `Upstream unreachable: ${err.message}` } }, 502, cors);
    }

    // Pass the response through as-is so the app sees real Anthropic errors
    // and usage numbers. Never echo request headers back — the API key is in
    // them.
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        ...cors,
      },
    });
  },
};
