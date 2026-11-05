import { MODULE_ID, SETTING, debugLog } from "./constants.mjs";

const CHECK_INTERVAL_MS = 60 * 1000;

/**
 * Ends a recording nobody remembered to stop, once no d20 roll has happened for the
 * configured number of hours.
 *
 * The usual way this happens is that the GM closes the browser at the end of the night with
 * the session still running. Nothing can be recorded while the GM is away (every write goes
 * through the GM's client), so the check runs as soon as the GM loads in again as well as on
 * a timer while they're connected.
 *
 * The end is stamped at the last thing that was recorded, not at the moment the check
 * notices. Otherwise "elapsed" in the report and CSV would include the idle hours, or the
 * whole gap until the next login.
 */
export class IdleEnd {
  #store;

  constructor(store) {
    this.#store = store;
  }

  registerHooks() {
    if (!game.user.isGM) return;
    this.#check();
    setInterval(() => this.#check(), CHECK_INTERVAL_MS);
  }

  #check() {
    if (!this.#store.isRecording) return;

    const hours = game.settings.get(MODULE_ID, SETTING.AUTO_END_HOURS);
    if (!hours) return; // 0 turns auto-end off

    const now = Math.floor(Date.now() / 1000);
    const idleSeconds = now - this.#store.lastRollAt;
    if (idleSeconds < hours * 3600) return;

    const at = this.#store.lastEventAt;
    debugLog("Auto-ending idle session", { idleSeconds, endAt: at });
    this.#store.endSession({ at });

    const name = this.#store.data.meta.name;
    const message = game.i18n.format("CGSS.AutoEnd.Notice", { name, hours });
    // Permanent: the GM is most likely to see this on their next login, possibly days later.
    ui.notifications.info(message, { permanent: true });
  }
}
