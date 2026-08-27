import { MODULE_ID, SETTING, debugLog } from "./constants.mjs";
import { startSessionFlow } from "./chat-controls.mjs";

const SNOOZE_MS = 60 * 60 * 1000;

/**
 * Offers to start a session when play visibly begins, so forgetting the button costs
 * nothing.
 *
 * The hard part is not noticing play - it is staying silent during prep. GMs routinely
 * test rolls minutes before the game, which is why "any roll starts a session" and any
 * idle-gap heuristic both fail. The distinguishing signal is not that a roll happened but
 * *who* rolled: a GM's own rolls never trigger this, however many they make. Players
 * rolling initiative are covered by exactly the same rule, so combat needs no separate
 * trigger.
 *
 * Three answers, because "no" means two different things. "Not now" drops it for this
 * login; "Pause 1 hour" is the softer one, for a GM testing with players already on who
 * does want reminding when the real session starts. Either way it never asks twice in a
 * row - a reminder that reappears is worse than no reminder.
 */
export class SessionPrompt {
  #store;
  #attribution;
  #asked = false;
  #snoozedUntil = 0;

  constructor(store, attribution) {
    this.#store = store;
    this.#attribution = attribution;
  }

  registerHooks() {
    if (!game.user.isGM) return;
    // Chat messages sync to the GM, so a player's roll is visible here without a relay.
    Hooks.on("createChatMessage", (message) => this.#onChatMessage(message));
  }

  #onChatMessage(message) {
    if (!message.rolls?.length) return;
    // Strictly a player's own roll: `isGM === false` rather than falsy, so a message with
    // no resolvable author never counts.
    if (message.author?.isGM !== false) return;
    this.#consider();
  }

  #consider() {
    if (this.#asked || this.#store.isRecording) return;
    if (Date.now() < this.#snoozedUntil) return;

    const threshold = game.settings.get(MODULE_ID, SETTING.START_PROMPT_PLAYERS);
    if (!threshold) return; // 0 disables the reminder entirely

    const players = game.users.filter((u) => u.active && !u.isGM).length;
    if (players < threshold) return;

    // Latched before the dialog opens, and synchronously - a whole party rolling
    // initiative at once arrives as a burst of messages, and every one after the first
    // must find this already set or they would each raise their own prompt.
    this.#asked = true;
    debugLog("Session start prompt", { players });
    this.#prompt(players);
  }

  async #prompt(players) {
    const choice = await new Promise((resolve) => {
      const dialog = new foundry.applications.api.DialogV2({
        window: { title: game.i18n.localize("CGSS.StartPrompt.Title"), icon: "fa-solid fa-circle-play" },
        content: `<p>${game.i18n.format("CGSS.StartPrompt.Body", { players })}</p>`,
        buttons: [
          { action: "start", icon: "fa-solid fa-circle-play", label: game.i18n.localize("CGSS.StartPrompt.Yes"), default: true },
          { action: "snooze", icon: "fa-solid fa-clock", label: game.i18n.localize("CGSS.StartPrompt.Snooze") },
          { action: "no", icon: "fa-solid fa-xmark", label: game.i18n.localize("CGSS.StartPrompt.No") }
        ],
        submit: (result) => resolve(result)
      });
      dialog.addEventListener("close", () => resolve(null), { once: true });
      dialog.render({ force: true });
    });

    if (choice === "start") startSessionFlow(this.#store, this.#attribution);
    else if (choice === "snooze") {
      // Eligible again afterwards, so a GM testing before the game is still reminded when
      // it actually starts.
      this.#snoozedUntil = Date.now() + SNOOZE_MS;
      this.#asked = false;
    }
    // "no" and dismissing both leave #asked set: quiet until reload.
  }
}
