import { MODULE_ID, SETTING, HOOK, MANUAL_SOURCE, NOT_TRACKED, ROLL_VERDICT, debugLog } from "./constants.mjs";
import { describeRoll, formatHPChange } from "./report-app.mjs";

// Longer than session-store's amendment retry (2s), so a verdict that needed the retry is in.
const ROLL_GRACE_MS = 4000;

/**
 * Optional pop-ups for unresolved entries (setting "Ask Me About Unresolved Changes", off by
 * default, per GM). When an entry lands in either queue - a roll whose pass/fail the system
 * never reported, or an HP change with nobody to credit - the GM gets a dialog asking for the
 * answer straight away, instead of only seeing it in the report window's queues.
 *
 * - One dialog at a time; entries arriving meanwhile wait their turn.
 * - "Later" (or closing the dialog) leaves the entry in the queue, unasked again: the report
 *   window is still where it can be settled.
 * - Only entries that arrive while the setting is on are asked about, never a backlog.
 * - Entries are followed by the event object itself, not its index: an undone hit removes
 *   events and shifts every index after it (session-store.mjs undoRecentDamage).
 */
export class UnresolvedPrompt {
  #store;
  #attribution;
  #seen = new WeakSet(); // events already asked about, or present before prompting began
  #waiting = []; // events still to ask about, oldest first
  #showing = false;

  constructor(store, attribution) {
    this.#store = store;
    this.#attribution = attribution;
  }

  registerHooks() {
    if (!game.user.isGM) return;
    this.#markExistingSeen();
    Hooks.on(HOOK.QUEUE_CHANGED, () => this.#onQueueChanged());
    Hooks.on(HOOK.SESSION_STARTED, () => {
      this.#waiting = [];
      this.#markExistingSeen();
    });
  }

  get #enabled() {
    return game.settings.get(MODULE_ID, SETTING.PROMPT_UNRESOLVED) === true;
  }

  /** Everything unresolved right now counts as seen, so turning the setting on never floods. */
  #markExistingSeen() {
    for (const event of this.#unresolvedEvents()) this.#seen.add(event);
  }

  #unresolvedEvents() {
    const events = this.#store.data?.events ?? [];
    return [
      ...this.#attribution.rollEntries.map((e) => events[e.index]),
      ...this.#attribution.entries.map((e) => events[e.index])
    ].filter(Boolean);
  }

  #onQueueChanged() {
    if (!this.#enabled || !this.#store.isRecording) {
      this.#markExistingSeen();
      return;
    }
    for (const event of this.#unresolvedEvents()) {
      if (this.#seen.has(event)) continue;
      this.#seen.add(event);
      if (event.pq) {
        // Pass/fail often follows the roll by a moment - Midi's save verdict, or a Monk's
        // TokenBar card judging the roll against its DC - so give it a few seconds to land
        // before asking. Rolls settled meanwhile are never asked about.
        setTimeout(() => {
          if (!event.pq || !this.#enabled || !this.#store.isRecording) return;
          this.#waiting.push(event);
          this.#showNext();
        }, ROLL_GRACE_MS);
      } else {
        this.#waiting.push(event);
      }
    }
    this.#showNext();
  }

  async #showNext() {
    if (this.#showing) return;
    this.#showing = true;
    try {
      while (this.#waiting.length) {
        const event = this.#waiting.shift();
        const index = this.#store.data?.events?.indexOf(event) ?? -1;
        if (index < 0) continue; // undone or otherwise gone
        if (event.pq) await this.#askRoll(event, index);
        else if (event.q) await this.#askHP(event, index);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Unresolved prompt failed`, err);
    } finally {
      this.#showing = false;
    }
  }

  #actorName(uuid) {
    return this.#store.data?.actors?.[uuid]?.n ?? "?";
  }

  async #askRoll(event, index) {
    const t = (key) => game.i18n.localize(`CGSS.Unresolved.${key}`);
    const face = event.d?.[event.k];
    const total = Number.isFinite(event.b) ? face + event.b : null;
    const what = game.i18n.format("CGSS.Unresolved.RollLine", {
      name: foundry.utils.escapeHTML(this.#actorName(event.a)),
      roll: describeRoll(event.c, event.x ?? null)
    });
    const dice = total === null
      ? game.i18n.format("CGSS.Unresolved.DieOnly", { face })
      : game.i18n.format("CGSS.Unresolved.DieAndTotal", { face, total });

    const answer = await foundry.applications.api.DialogV2.wait({
      window: { title: t("RollTitle"), icon: "fa-solid fa-dice-d20" },
      classes: ["cgss-unresolved"],
      content: `<p>${what}</p><p class="cgss-roll-dice">${dice}</p><p class="cgss-hint">${t("LaterHint")}</p>`,
      buttons: [
        { action: ROLL_VERDICT.PASS, label: t("Pass"), icon: "fa-solid fa-check", default: true },
        { action: ROLL_VERDICT.FAIL, label: t("Fail"), icon: "fa-solid fa-xmark" },
        { action: ROLL_VERDICT.IGNORE, label: t("NotApplicable"), icon: "fa-solid fa-ban" },
        { action: "later", label: t("Later"), icon: "fa-solid fa-clock" }
      ],
      rejectClose: false
    });
    if (!answer || answer === "later") return;

    // The event may have moved (an undo shifts indices) or been settled from the report meanwhile.
    const now = this.#store.data?.events?.indexOf(event) ?? -1;
    if (now < 0 || !event.pq) return;
    debugLog("Unresolved roll answered from prompt", { index: now, answer });
    await this.#attribution.resolveRoll(now, answer);
  }

  async #askHP(event, index) {
    const t = (key) => game.i18n.localize(`CGSS.Unresolved.${key}`);
    const change = formatHPChange({ dmg: event.dmg ?? 0, heal: event.heal ?? 0, thp: event.thp ?? 0 });
    const what = game.i18n.format("CGSS.Unresolved.HPLine", {
      name: foundry.utils.escapeHTML(this.#actorName(event.g)),
      change
    });
    const { pcs, npcs } = this.#attribution.candidateSources;
    const option = (o) => `<option value="${foundry.utils.escapeHTML(o.uuid)}">${foundry.utils.escapeHTML(o.name)}</option>`;
    const select = `
      <select name="source" class="cgss-source-select">
        <option value="">${t("Choose")}</option>
        ${pcs.length ? `<optgroup label="${t("Party")}">${pcs.map(option).join("")}</optgroup>` : ""}
        ${npcs.length ? `<optgroup label="${t("NPCs")}">${npcs.map(option).join("")}</optgroup>` : ""}
        <option value="${MANUAL_SOURCE}">${t("Manual")}</option>
        <option value="${NOT_TRACKED}">${t("NotTracked")}</option>
      </select>`;

    const answer = await foundry.applications.api.DialogV2.wait({
      window: { title: t("HPTitle"), icon: "fa-solid fa-heart-pulse" },
      classes: ["cgss-unresolved"],
      content: `<p>${what}</p><label class="cgss-source-label">${t("Who")} ${select}</label>
        <p class="cgss-hint">${t("ManualHint")}</p><p class="cgss-hint">${t("LaterHint")}</p>`,
      buttons: [
        {
          action: "assign",
          label: t("Assign"),
          icon: "fa-solid fa-check",
          default: true,
          callback: (_event, button) => button.form?.elements?.source?.value || null
        },
        { action: "later", label: t("Later"), icon: "fa-solid fa-clock" }
      ],
      rejectClose: false
    });
    if (!answer || answer === "later" || answer === "assign") return;

    const now = this.#store.data?.events?.indexOf(event) ?? -1;
    if (now < 0 || !event.q) return;
    debugLog("Unresolved HP change answered from prompt", { index: now, source: answer });
    await this.#attribution.resolve(now, answer);
  }
}
