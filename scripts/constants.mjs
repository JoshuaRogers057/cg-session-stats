export const MODULE_ID = "cg-session-stats";
export const MODULE_TITLE = "Session Stats - Champions Guild";

export const EVENT_TYPE = {
  ROLL: 1,
  HP: 2,
  MISS: 3 // an attack targeted this actor and failed to connect
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
  DEBUG: "debug"
};

export const SOCKET_ACTION = {
  RECORD_EVENT: "recordEvent",
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
