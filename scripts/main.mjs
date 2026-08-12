import { MODULE_ID, MODULE_TITLE } from "./constants.mjs";
import { registerSettings } from "./settings.mjs";
import { registerSocket, isSocketReady } from "./socket.mjs";
import { SessionStore } from "./session-store.mjs";
import { AttributionQueue } from "./attribution.mjs";
import { RollCapture } from "./roll-capture.mjs";
import { HPCapture } from "./hp-capture.mjs";
import { registerChatControls } from "./chat-controls.mjs";
import { registerJournalControls } from "./journal-controls.mjs";

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("socketlib.ready", () => {
  registerSocket();
});

Hooks.once("ready", () => {
  if (!checkDependencies()) return;
  initializeModule();
});

function checkDependencies() {
  if (game.system.id !== "dnd5e") {
    console.error(`${MODULE_ID} | Refusing to initialize: requires the dnd5e system, found "${game.system.id}"`);
    return false;
  }

  const midi = game.modules.get("midi-qol");
  if (!midi?.active) {
    const message = `${MODULE_TITLE} requires Midi-QOL to be installed and enabled. Session stats will not be recorded.`;
    console.error(`${MODULE_ID} | ${message}`);
    if (game.user.isGM) ui.notifications.error(message);
    return false;
  }

  if (!globalThis.socketlib) {
    const message = `${MODULE_TITLE} requires socketlib to be installed and enabled. Session stats will not be recorded.`;
    console.error(`${MODULE_ID} | ${message}`);
    if (game.user.isGM) ui.notifications.error(message);
    return false;
  }

  // socketlib is active, but its per-module socket may still have failed to register (e.g.
  // a missing "socket": true in this module's manifest) - see socket.mjs for the console
  // error explaining why. Catch that here rather than limping along with player events
  // silently never reaching the GM.
  if (!isSocketReady()) {
    const message = `${MODULE_TITLE} failed to set up its network channel. Session stats will not be recorded. Check the console for details.`;
    console.error(`${MODULE_ID} | ${message}`);
    if (game.user.isGM) ui.notifications.error(message);
    return false;
  }

  return true;
}

function initializeModule() {
  const store = new SessionStore();
  const attribution = new AttributionQueue(store);
  const rollCapture = new RollCapture(store);
  const hpCapture = new HPCapture(store);

  store.initialize();
  rollCapture.registerHooks();
  hpCapture.registerHooks();

  // GM launches the report from the chat controls; players from the Journal tab. Each
  // registrar self-gates, so both are called unconditionally.
  registerChatControls(store, attribution);
  registerJournalControls(store, attribution);

  const mod = game.modules.get(MODULE_ID);
  mod.api = { store, attribution, hpCapture };

  console.log(`${MODULE_ID} | Initialized`);
}
