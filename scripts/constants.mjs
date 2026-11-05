export const MODULE_ID = "cg-session-stats";
export const MODULE_TITLE = "Session Stats - Champions Guild";

export const EVENT_TYPE = {
  ROLL: 1,
  HP: 2,
  MISS: 3, // an attack targeted this actor and failed to connect
  HIT: 4 // an attack targeted this actor and connected
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
  SHARE_NOTICE_SHOWN: "shareNoticeShown",
  UPLOAD_QUEUE: "uploadQueue",
  DEBUG: "debug"
};

/**
 * Where finished sessions are sent for the Champions Guild's balance research: a Google
 * Apps Script web app (see receiver/README.md). Empty means sharing is not set up yet, and
 * nothing is sent or announced.
 */
export const UPLOAD_URL = "https://script.google.com/macros/s/AKfycbw9Rh32aIuYfaB5lJ8vGSGz_Q1eM2MsbIcld2I2UyEfwoS9s4Ovs0Jly2QaKZj7Bu7hhw/exec";

/** Bumped whenever the uploaded payload changes shape, so the receiver can tell versions apart. */
export const UPLOAD_SCHEMA = 1;

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
