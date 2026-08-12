export const MODULE_ID = "cg-session-stats";
export const MODULE_TITLE = "Champions Guild Session Stats";

export const EVENT_TYPE = {
  ROLL: 1,
  HP: 2
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
  RESOLVE_ATTRIBUTION: "resolveAttribution",
  MARK_HIT_DIE: "markHitDie"
};

export const HOOK = {
  SESSION_STARTED: "cg-session-stats.sessionStarted",
  SESSION_ENDED: "cg-session-stats.sessionEnded",
  QUEUE_CHANGED: "cg-session-stats.queueChanged",
  STATE_CHANGED: "cg-session-stats.stateChanged"
};

export const MANUAL_SOURCE = "manual";

export function debugLog(...args) {
  if (game.settings.get(MODULE_ID, SETTING.DEBUG)) console.log(`${MODULE_ID} |`, ...args);
}
