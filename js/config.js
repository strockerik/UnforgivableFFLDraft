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

// The scoring rules a generic "Half-PPR" ranking assumes. Anything a league
// does differently has to be corrected for, because the rankings can't know.
export const BASELINE_SCORING = { passTd: 4, passInt: -2, reception: 0.5 };

export const DEFAULT_SETTINGS = {
  teams: 10,
  // Kept in sync with draftOrder.indexOf(myTeamName)+1 by the setup panel.
  // Seeded from team-key order, which is NOT the draft order — reset on draft day.
  slot: 3,
  rounds: 15,
  scoring: 'Half-PPR',
  // Decoded from the Yahoo league export (league "Unforgivable", 10-team).
  // passTd of 6 is the consequential one — see vorp.js.
  scoringRules: { passTd: 6, passInt: -3, reception: 0.5, yardageBonuses: true },
  // Read off the league's own week-4 roster export: QB/RB/RB/WR/WR/WR/TE/
  // W-R-T/K/DEF = 10 starters, 5 bench, 1 IR. Three WR starters (not two)
  // pushes WR replacement much deeper and raises elite WR value accordingly.
  roster: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, DST: 1, K: 1 },
  bench: 5,
  model: 'claude-opus-5',
  effort: 'medium',
  // Draft order, slot 1..N. Seeded with the league's team-key order, which is
  // NOT the draft order — you set the real one on draft day, and `slot` is
  // derived from where your team lands in it.
  draftOrder: [
    'Feel It In My Plums', '40 is a long way', 'Vegan Beer', 'Biz Fuck it',
    'No Email till Brooklyn', 'Dad Bod', 'Harambe McHarambeface',
    'The Juice is Loose', 'Do It Lady!', "Youain't1styourlast",
  ],
  myTeamName: 'Vegan Beer',
  authMode: 'direct',
  // Pre-filled so a new browser only needs the passphrase typed in. The URL
  // is not a secret — it's gated by APP_PASSPHRASE, and a request without the
  // right one gets a 401 having cost nothing. Change it under Setup if you
  // deploy your own.
  proxyUrl: 'https://ffl-draft-proxy.strockerik.workers.dev',
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

/** Display name for a draft slot (1-indexed). Falls back to "Team N". */
export function teamNameForSlot(settings, slot) {
  const name = (settings.draftOrder || [])[slot - 1];
  return name || `Team ${slot}`;
}

/** Which slot the user drafts from, derived from the draft order. */
export function mySlot(settings) {
  const i = (settings.draftOrder || []).indexOf(settings.myTeamName);
  return i >= 0 ? i + 1 : settings.slot;
}

export function starterSlots(settings) {
  const r = settings.roster;
  return Object.keys(r).reduce((n, k) => n + r[k], 0);
}

export function totalRounds(settings) {
  return settings.rounds;
}
