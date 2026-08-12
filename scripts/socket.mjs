import { MODULE_ID, SOCKET_ACTION, debugLog } from "./constants.mjs";

let socket;

/**
 * @returns {boolean} true if the socket registered successfully. Fails if `"socket": true`
 * is missing from module.json - socketlib.registerModule() then returns undefined instead
 * of throwing, which would otherwise surface as a cryptic "Cannot read properties of
 * undefined" deep in socketlib's own code with no indication of the actual cause.
 */
export function registerSocket() {
  socket = globalThis.socketlib.registerModule(MODULE_ID);
  if (!socket) {
    console.error(
      `${MODULE_ID} | socketlib.registerModule() returned nothing - is "socket": true set in this module's module.json? ` +
        `(A world reload is required after adding it; a browser refresh alone is not enough.)`
    );
    return false;
  }
  socket.register(SOCKET_ACTION.RECORD_EVENT, _gmRecordEvent);
  socket.register(SOCKET_ACTION.RESOLVE_ATTRIBUTION, _gmResolveAttribution);
  socket.register(SOCKET_ACTION.MARK_HIT_DIE, _gmMarkHitDie);
  return true;
}

export function isSocketReady() {
  return !!socket;
}

/**
 * Send a captured event to the GM client for recording. Only the GM client ever writes
 * to storage; every other client relays through here. Called for the GM's own client too,
 * so SessionStore.recordEvent() always goes through the same path.
 */
export async function relayRecordEvent(eventData) {
  if (!socket) return;
  await socket.executeAsGM(SOCKET_ACTION.RECORD_EVENT, eventData);
}

export async function relayResolveAttribution(index, actorUuid) {
  if (!socket) return;
  await socket.executeAsGM(SOCKET_ACTION.RESOLVE_ATTRIBUTION, { index, actorUuid });
}

/**
 * `dnd5e.rollHitDieV2` only fires on the client that invoked the roll (it is not part of
 * core document sync, unlike the `updateActor` it triggers). The GM's own HPCapture needs
 * to know about it regardless of who rolled, so it can suppress the resulting HP update
 * from being treated as an unattributed heal.
 */
export async function relayMarkHitDie(actorUuid) {
  if (!socket) return;
  await socket.executeAsGM(SOCKET_ACTION.MARK_HIT_DIE, actorUuid);
}

// These handlers only ever execute on the GM's client (invoked via executeAsGM), so it's
// safe to reach into the live module API without an isGM guard.
function _gmRecordEvent(eventData) {
  const api = game.modules.get(MODULE_ID).api;
  if (!api?.store) return debugLog("Dropped event, store not ready", eventData);
  api.store.ingestEvent(eventData);
}

function _gmResolveAttribution({ index, actorUuid }) {
  const api = game.modules.get(MODULE_ID).api;
  api?.attribution?.resolve(index, actorUuid);
}

function _gmMarkHitDie(actorUuid) {
  const api = game.modules.get(MODULE_ID).api;
  api?.hpCapture?.markHitDie(actorUuid);
}
