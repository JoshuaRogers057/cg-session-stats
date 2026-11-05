import { MODULE_ID, SETTING, HOOK, UPLOAD_URL, UPLOAD_SCHEMA, debugLog } from "./constants.mjs";
import { buildExportTables } from "./export-tables.mjs";

const RETRY_INTERVAL_MS = 30 * 60 * 1000;
const MAX_QUEUED = 20;

/**
 * Sends every finished session to the Champions Guild for balance research, with nothing
 * for the GM to set up: no sign-in, no account, no address to paste. The receiver is a
 * Google Apps Script web app that files each session as its own spreadsheet (see
 * receiver/README.md).
 *
 * A session ends, its tables are built and queued, and the queue is sent. The queue lives
 * in a world setting, so a session that ended with the internet down - or by auto-end
 * while the GM was logged out - is not lost: it goes out on the next login, or within
 * half an hour while the GM stays connected. The receiver ignores a session it has
 * already filed, so a retry after a reply that never arrived is harmless.
 *
 * The GM is told once, the first time this runs in a world, and can turn it off in the
 * module settings.
 */
export class StatsUploader {
  #store;
  #attribution;
  #sending = false;
  #sendAgain = false;
  #warned = false;

  constructor(store, attribution) {
    this.#store = store;
    this.#attribution = attribution;
  }

  registerHooks() {
    if (!game.user.isGM || !UPLOAD_URL) return;
    Hooks.on(HOOK.SESSION_ENDED, () => this.#onSessionEnded());
    this.#showNoticeOnce();
    this.#send();
    setInterval(() => this.#send(), RETRY_INTERVAL_MS);
  }

  get #enabled() {
    return !!UPLOAD_URL && game.settings.get(MODULE_ID, SETTING.SHARE_STATS);
  }

  async #onSessionEnded() {
    if (!this.#enabled) return;
    const payload = this.#buildPayload();
    if (!payload) return;

    // Replaces any earlier copy of the same session rather than queueing it twice.
    const queue = this.#queue().filter((p) => p.sessionId !== payload.sessionId);
    queue.push(payload);
    await this.#saveQueue(queue.slice(-MAX_QUEUED));
    await this.#send();
  }

  #buildPayload() {
    const meta = this.#store.data?.meta;
    if (!meta) return null;
    // Sessions started before 0.6 have no id; give one so the receiver can still dedupe.
    meta.id ??= foundry.utils.randomID();
    return {
      schema: UPLOAD_SCHEMA,
      sessionId: meta.id,
      world: { id: game.world.id, title: game.world.title },
      tables: buildExportTables(this.#store, this.#attribution)
    };
  }

  #queue() {
    return [...(game.settings.get(MODULE_ID, SETTING.UPLOAD_QUEUE)?.items ?? [])];
  }

  #saveQueue(items) {
    return game.settings.set(MODULE_ID, SETTING.UPLOAD_QUEUE, { items });
  }

  /** Sends the queue oldest first, stopping at the first failure so order is kept. */
  async #send() {
    if (!this.#enabled) return;
    // A session queued while a send is under way (auto-end at login does exactly this) goes
    // out as soon as that send finishes, not half an hour later.
    if (this.#sending) {
      this.#sendAgain = true;
      return;
    }
    this.#sending = true;
    try {
      let queue = this.#queue();
      while (queue.length) {
        const payload = queue[0];
        const outcome = await this.#post(payload);
        if (!outcome) {
          this.#warnOnce();
          return;
        }
        queue = this.#queue().filter((p) => p.sessionId !== payload.sessionId);
        await this.#saveQueue(queue);
        debugLog("Upload finished", payload.sessionId, outcome);

        // Safely filed elsewhere, so starting the next session needn't warn about it. A
        // dropped session was not filed, so it still counts as unexported.
        const meta = this.#store.data?.meta;
        if (outcome === "sent" && meta?.id === payload.sessionId && !this.#store.isRecording) this.#store.markExported();
      }
    } finally {
      this.#sending = false;
      if (this.#sendAgain) {
        this.#sendAgain = false;
        this.#send();
      }
    }
  }

  /** "sent", "dropped" (the receiver will never take it), or false to try again later. */
  async #post(payload) {
    try {
      // text/plain keeps this a "simple" request with no CORS preflight, which Apps Script
      // web apps cannot answer. The body is still JSON.
      const response = await fetch(UPLOAD_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
        redirect: "follow"
      });
      if (!response.ok) {
        debugLog("Upload refused", response.status);
        return false;
      }
      const result = await response.json().catch(() => null);
      if (result?.ok) return "sent";
      // A session the receiver will never accept is dropped, not retried: left at the head
      // of the queue it would hold back every session after it, forever.
      if (result?.drop) {
        console.warn(`${MODULE_ID} | Receiver refused session ${payload.sessionId}: ${result.error}`);
        return "dropped";
      }
      debugLog("Upload rejected", result);
      return false;
    } catch (err) {
      debugLog("Upload failed", err);
      return false;
    }
  }

  /** Once per login: the next attempts are automatic, so saying it again is just noise. */
  #warnOnce() {
    if (this.#warned) return;
    this.#warned = true;
    ui.notifications.warn(game.i18n.localize("CGSS.Share.Failed"));
  }

  async #showNoticeOnce() {
    if (game.settings.get(MODULE_ID, SETTING.SHARE_NOTICE_SHOWN)) return;
    if (!game.settings.get(MODULE_ID, SETTING.SHARE_STATS)) return;
    await game.settings.set(MODULE_ID, SETTING.SHARE_NOTICE_SHOWN, true);

    // A notice, not a choice: turning sharing off lives in the module settings, as it says.
    await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize("CGSS.Share.Title"), icon: "fa-solid fa-chart-column" },
      content: `<p>${game.i18n.localize("CGSS.Share.Body")}</p><p>${game.i18n.localize("CGSS.Share.Detail")}</p>`,
      ok: { icon: "fa-solid fa-check", label: game.i18n.localize("CGSS.Share.Ok") },
      rejectClose: false
    });
  }
}
