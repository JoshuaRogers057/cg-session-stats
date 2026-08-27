import { MODULE_ID, SETTING, debugLog } from "./constants.mjs";
import { startSessionFlow } from "./chat-controls.mjs";

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
 * Asks at most once per login. Declining, or starting a session by any route, keeps it
 * quiet for the rest of that session - a reminder that reappears is worse than no reminder.
 */
export class SessionPrompt {
  #store;
  #attribution;
  #asked = false;

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
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("CGSS.StartPrompt.Title"), icon: "fa-solid fa-circle-play" },
      content: `<p>${game.i18n.format("CGSS.StartPrompt.Body", { players })}</p>`,
      yes: { label: game.i18n.localize("CGSS.StartPrompt.Yes"), icon: "fa-solid fa-circle-play" },
      no: { label: game.i18n.localize("CGSS.StartPrompt.No") },
      rejectClose: false
    });
    if (confirmed) startSessionFlow(this.#store, this.#attribution);
  }
}
