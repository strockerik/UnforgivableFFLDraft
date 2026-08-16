// League defaults, storage keys, and model configuration.

// localStorage on username.github.io is shared per-origin across every repo,
// so every key this app writes must carry the prefix.
export const NS = 'ffda:';
export const KEYS = {
  settings: NS + 'settings',
  draft: NS + 'draft',
  apiKey: NS + 'apikey',
  passphrase: NS + 'passphrase',
  pool: NS + 'pool',
};

// 'direct' — browser calls Anthropic with your key (fine locally).
// 'proxy'  — browser calls your Cloudflare Worker, which holds the key.
export const AUTH_MODES = ['direct', 'proxy'];

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'DST', 'K'];
export const FLEX_ELIGIBLE = ['RB', 'WR', 'TE'];

export const DEFAULT_SETTINGS = {
  teams: 10,
  slot: 5,
  rounds: 15,
  scoring: 'Half-PPR',
  roster: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DST: 1, K: 1 },
  bench: 6,
  model: 'claude-opus-5',
  effort: 'medium',
  authMode: 'direct',
  proxyUrl: '',
};

// How a FLEX slot is historically consumed. Used to push replacement level
// deeper for RB/WR than raw starter counts imply.
export const FLEX_SHARE = { RB: 0.5, WR: 0.4, TE: 0.1 };

// Positional scarcity ordering fed to the prompt and used to break value ties.
export const SCARCITY_RANK = { RB: 1, TE: 2, WR: 3, QB: 4, DST: 5, K: 6 };

export const MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5 — best quality', inPrice: 5, outPrice: 25 },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 — faster', inPrice: 3, outPrice: 15 },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — cheapest', inPrice: 1, outPrice: 5 },
];

export const EFFORTS = ['low', 'medium', 'high'];

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2023-06-01';

// 32 NFL team abbreviations. Required for right-to-left parsing of the
// combined "Player Team (Bye)" cell in ADP exports, where a naive split
// breaks on name suffixes like "Patrick Mahomes II KC (10)".
export const TEAMS = new Set([
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE',
  'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAC', 'JAX', 'KC',
  'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ',
  'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS', 'WSH',
]);

// Name suffixes stripped before building a join key.
export const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);

export function starterSlots(settings) {
  const r = settings.roster;
  return Object.keys(r).reduce((n, k) => n + r[k], 0);
}

export function totalRounds(settings) {
  return settings.rounds;
}
