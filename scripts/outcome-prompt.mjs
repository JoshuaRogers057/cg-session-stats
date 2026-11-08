import { debugLog } from "./constants.mjs";
import { guessOutcome } from "./fight-outcome.mjs";

/** The GM's answers, as stored on the fight (`o`) and read by the website. */
export const FIGHT_ANSWER = {
  WON: "won",
  FLED: "fled",
  RETREAT: "retreat",
  TALK: "talk",
  OTHER: "other"
};

/**
 * Asks the GM how a fight ended, but only when the tracker can't tell. When the GM ends a
 * combat, the module looks at who is down, who was taken off the map hurt, and how the party
 * stands. A clear win or a wipe asks nothing. Only a fight that ended some other way gets
 * the question: a negotiation, a retreat or a surrender looks the same in HP, and each one
 * means something different for balance.
 *
 * The question never blocks play. Closing it is a fine answer, and the website keeps its own
 * guess.
 */
export class FightOutcomePrompt {
  #store;

  constructor(store) {
    this.#store = store;
  }

  registerHooks() {
    if (!game.user.isGM) return;
    // Only the GM who ended the combat is asked; a second GM watching sees nothing.
    Hooks.on("deleteCombat", (combat, options, userId) => {
      if (userId !== game.user.id) return;
      // After the store has closed the fight off (its hook was registered first).
      setTimeout(() => this.#ask(combat.id), 0);
    });
  }

  async #ask(combatId) {
    const data = this.#store.data;
    if (!data || !this.#store.isRecording) return;
    // Balance research only uses guild games, so a home game is never asked.
    if (data.meta.cg === 0) return;
    const fights = data.meta.fights ?? [];
    const index = fights.findLastIndex((f) => f.id === combatId);
    if (index < 0 || fights[index].o) return;

    let guess;
    try {
      guess = guessOutcome(data, index, liveHp);
    } catch (err) {
      debugLog("Outcome guess failed", err);
      return;
    }
    debugLog("Fight outcome guess", index, guess);
    if (guess.skip || guess.outcome !== "unclear") return;

    const answer = await this.#dialog(guess.foes);
    if (!answer) return;
    this.#store.setFightOutcome(index, answer);
  }

  #dialog(foes) {
    const t = (k) => game.i18n.localize(`CGSS.Outcome.${k}`);
    const names = foes.slice(0, 3).join(", ") + (foes.length > 3 ? ", …" : "");
    const which = names ? game.i18n.format("CGSS.Outcome.Which", { names: foundry.utils.escapeHTML(names) }) : "";
    return foundry.applications.api.DialogV2.wait({
      window: { title: t("Title"), icon: "fa-solid fa-flag-checkered" },
      classes: ["cgss-outcome"],
      position: { width: 380 },
      content: `<p>${t("Body")}</p>${which ? `<p class="cgss-hint">${which}</p>` : ""}<p class="cgss-hint">${t("Skip")}</p>`,
      buttons: [
        { action: FIGHT_ANSWER.WON, label: t("Won"), icon: "fa-solid fa-trophy" },
        { action: FIGHT_ANSWER.FLED, label: t("Fled"), icon: "fa-solid fa-person-running" },
        { action: FIGHT_ANSWER.RETREAT, label: t("Retreat"), icon: "fa-solid fa-person-walking-arrow-right" },
        { action: FIGHT_ANSWER.TALK, label: t("Talk"), icon: "fa-solid fa-handshake" },
        { action: FIGHT_ANSWER.OTHER, label: t("Other"), icon: "fa-solid fa-circle-question" }
      ],
      rejectClose: false
    }).catch(() => null);
  }
}

/** [hp, max] for a combatant still on the map, or null once its token is gone. */
function liveHp(uuid) {
  try {
    const hp = fromUuidSync(uuid)?.system?.attributes?.hp;
    if (!hp || !Number.isFinite(hp.value)) return null;
    return [hp.value, Number.isFinite(hp.max) ? hp.max : 0];
  } catch {
    return null;
  }
}
