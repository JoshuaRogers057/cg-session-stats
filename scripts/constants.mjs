export const MODULE_ID = "cg-session-stats";
export const MODULE_TITLE = "Session Stats - Champions Guild";

export const EVENT_TYPE = {
  ROLL: 1,
  HP: 2,
  MISS: 3, // an attack targeted this actor and failed to connect
  HIT: 4, // an attack targeted this actor and connected
  // Added in 0.7 for the Champions Guild balance research (the website rebuilds each fight
  // from these). The report tables ignore them.
  REMOVED: 5, // a combatant left a live fight (deleted token or removed from the tracker)
  DEATH: 6, // a PC died: third failed death save, or the Dead condition
  STAT: 7, // a combatant's stat block was edited mid-fight (max HP, AC, CR, abilities, items)
  USE: 8, // a consumable was used (potion drunk, scroll read)
  DROP: 9 // a consumable's count went down, or it was deleted, outside a use
};

export const ROLL_CATEGORY = {
  ATTACK: 0,
  SAVE: 1,
  CHECK: 2,
  INITIATIVE: 3
};

export const ROLL_TAG = {
  DEATH_SAVE: 1,
  CONCENTRATION: 2
};

export const SETTING = {
  SESSION_DATA: "sessionData",
  ALLOW_PLAYER_REPORT: "allowPlayerReport",
  START_PROMPT_PLAYERS: "startPromptPlayers",
  AUTO_END_HOURS: "autoEndHours",
  SHARE_STATS: "shareStats",
  // Renamed in 0.7 so every GM sees the notice once more: more is shared than before.
  SHARE_NOTICE_SHOWN: "shareNoticeShownV2",
  UPLOAD_QUEUE: "uploadQueue",
  DEBUG: "debug"
};

/**
 * Where finished sessions are sent for the Champions Guild's balance research: the Champions
 * Guild website, which keeps each session and builds its tables (admins only). Empty means
 * sharing is off, and nothing is sent or announced.
 */
export const UPLOAD_URL = "https://championsguildrpg.com/api/session-stats/sessions";

/**
 * The website's upload key. It is built in so GMs have nothing to set up, which also means it
 * is not secret: the website limits uploads per address, checks each one looks like a real
 * session, and only counts sessions it can match to a guild quest. If it is ever replaced on
 * the website (/admin/session-stats), this has to change in a module update.
 */
export const UPLOAD_KEY = "cgss_e8a077ee870590becd368204db2ea6c0d05ecab0c5a72be3";

/**
 * Bumped whenever the uploaded payload changes shape. 1 = report tables for Google Sheets
 * (0.6); 2 = the raw session for the website (0.7).
 */
export const UPLOAD_SCHEMA = 2;

export const SOCKET_ACTION = {
  RECORD_EVENT: "recordEvent",
  AMEND_ROLL: "amendRoll",
  MARK_HIT_DIE: "markHitDie"
};

/** Verdicts for resolving a roll whose pass/fail the system never reported. */
export const ROLL_VERDICT = {
  PASS: "pass",
  FAIL: "fail",
  IGNORE: "ignore"
};

export const HOOK = {
  SESSION_STARTED: "cg-session-stats.sessionStarted",
  SESSION_ENDED: "cg-session-stats.sessionEnded",
  QUEUE_CHANGED: "cg-session-stats.queueChanged",
  STATE_CHANGED: "cg-session-stats.stateChanged"
};

/** Real damage or healing with nobody to credit - still counts for the recipient. */
export const MANUAL_SOURCE = "manual";

/** A bookkeeping correction that never happened in fiction - excluded from every stat. */
export const NOT_TRACKED = "not-tracked";

export function debugLog(...args) {
  if (game.settings.get(MODULE_ID, SETTING.DEBUG)) console.log(`${MODULE_ID} |`, ...args);
}
