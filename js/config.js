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
// Verified against FantasyPros' own projections, not assumed: rebuilding
// `points_half` from the published stat components matches exactly at -1 per
// interception and is off by exactly `pass_ints` at -2. The earlier -2 made
// scoringDelta understate this league's -3 INT penalty by half.
export const BASELINE_SCORING = { passTd: 4, passInt: -1, reception: 0.5 };

export const DEFAULT_SETTINGS = {
  // Bumped whenever a LEAGUE FACT below changes (roster, bench, scoring,
  // teams, rounds). state.js re-applies those to any saved settings carrying
  // an older version. Without this a browser that saved settings before the
  // Yahoo export was decoded keeps drafting against the wrong replacement
  // levels forever, and nothing surfaces the mistake.
  settingsVersion: 2,
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
  // Draft order, slot 1..N — by COACH, not team name. Team names change every
  // year and half the league renames mid-season; the people are the constant,
  // and four seasons of tendency history join on them (see js/coaches.js).
  // Seeded with the 2025 draft order, which is NOT this year's — set the real
  // one on draft day, and `slot` is derived from where you land in it.
  draftOrder: [
    'Danny', 'Rob K.', 'Drew', 'Joel', 'Mark',
    'Robert E.', 'Erik', 'Brandon', 'Alex', 'Josh',
  ],
  myTeamName: 'Erik',
  // Design review argued for instant-record + undo instead of a modal on
  // every pick. Erik asked for the confirmation explicitly, so it stays the
  // default — but the faster path is one toggle away, and the undo toast
  // exists either way.
  confirmEveryPick: true,
  // Practice mode. When on, the other nine coaches draft themselves so a
  // rehearsal needs only your own picks. Off by default and never persisted
  // as on by accident — recording a real draft with this enabled would have
  // the app drafting over your league-mates' actual picks.
  mockDraft: false,
  // How many high-upside "sleeper" players (tagged in data/strategy.md) to
  // guarantee on the roster. Applied only AFTER the starting lineup is full,
  // and it will give up at most ~25 points of expected value to land one.
  // On a bench that is a good trade: a replacement-level backup contributes
  // almost nothing, while a lottery ticket has option value that expected
  // points cannot express. Set to 0 to disable.
  sleeperQuota: 1,
  // How hard to avoid stacking starters on one bye week. 0 disables it, 1 is
  // the calibrated default, higher is more averse. Deliberately gentle: a
  // third starter on a bye costs 12 points of score, which breaks a tie
  // between similar players and never overrides a real talent gap. Three great
  // players sharing a bye beat two great and one average spread across two.
  byeAversion: 1,
  // Multiplier on the bye-insurance credit for a first backup at a single-slot
  // position. 0 disables it. Exists so the tuning is measurable rather than
  // buried in a constant -- see the A/B in the commit that introduced it.
  byeCoverCredit: 1,
  // Hide kickers and defences from the ALL view until the last two rounds.
  // They are fungible and belong at the end, so before then they are just
  // noise between the players you are actually choosing among. Clicking the K
  // or DST chip still shows them, and they reappear on their own in round 14.
  hideLateFillers: true,
  // Refresh the board from FantasyPros when the app opens, if the cached copy
  // is older than this. Rankings move daily in preseason and hourly on draft
  // morning; a stale board is the quiet failure.
  autoRefreshHours: 6,
  // Proxy by default: the Anthropic key lives as a Worker secret, so a fresh
  // browser on draft morning needs only the passphrase typed in. Defaulting to
  // 'direct' would strand a new device that has no key stored. Saved settings
  // still win, so this only affects a first run.
  authMode: 'proxy',
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

// `supportsEffort` gates output_config.effort. Haiku 4.5 rejects it outright —
// "This model does not support the effort parameter" — which sent every request
// to the deterministic fallback. Sending a parameter a model cannot accept is
// not a graceful degradation, it is a broken call.
export const MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5 — best quality', inPrice: 5, outPrice: 25, supportsEffort: true },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 — faster', inPrice: 3, outPrice: 15, supportsEffort: true },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — cheapest', inPrice: 1, outPrice: 5, supportsEffort: false },
];

/** Whether a model accepts output_config.effort. Unknown models are assumed to. */
export const modelSupportsEffort = (id) =>
  MODELS.find((m) => m.id === id)?.supportsEffort !== false;

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

/** Display name (coach) for a draft slot (1-indexed). Falls back to "Team N". */
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
