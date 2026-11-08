import { EVENT_TYPE } from "./constants.mjs";
import { resolveAttributedActor } from "./actor-resolve.mjs";
import { hpSnapshot } from "./actor-info.mjs";

/**
 * What the Champions Guild website needs to judge a fight after the fact (0.7), captured the
 * moment it happens because the evidence often disappears straight after:
 *
 * - Removals. GMs delete dead monsters to clear the map, and with an unlinked token goes its
 *   whole actor. The removal is recorded with the HP it left at and the round.
 * - PC deaths: a third failed death save, or the Dead condition.
 * - Stat blocks edited mid-fight (max HP, AC, CR, abilities, bonuses, an item's attack,
 *   damage or save): the sign a GM adjusted a fight on the fly.
 *
 * Every report goes through SessionStore.recordEvent, which keeps only what concerns a
 * combatant of a running fight. Removals and deaths are watched on the GM's client, which
 * sees every document change; stat edits on whichever client made the edit, since only that
 * client sees the values from before it.
 */
export class FightCapture {
  #store;
  #before = new Map(); // actor uuid -> stat values before an update, on the editing client

  constructor(store) {
    this.#store = store;
  }

  registerHooks() {
    // Edits: the "pre" hook runs only on the client making the change, which is the only
    // place the old values still exist; the matching "update" hook runs there too.
    Hooks.on("preUpdateActor", (actor, changes) => this.#rememberActor(actor, changes));
    Hooks.on("updateActor", (actor, changes, options) => this.#compareActor(actor, changes, options));
    Hooks.on("updateItem", (item, changes, options, userId) => this.#onItemUpdated(item, changes, options, userId));

    if (!game.user.isGM) return;

    // Removals. A deleted token takes its combatant with it, so the token hook is the last
    // moment an unlinked actor and its HP exist. Taking a combatant off the tracker without
    // deleting the token comes through preDeleteCombatant. Both "pre" hooks only run for the
    // GM's own deletions; deleteCombatant (seen by every client) covers anyone else's, using
    // the last HP the store saw. The store keeps one removal per combatant per fight.
    Hooks.on("preDeleteToken", (token) => this.#removed(token.actor, token.combatant?.combat ?? null));
    Hooks.on("preDeleteCombatant", (combatant) => this.#removed(combatant.actor, combatant.combat));
    Hooks.on("deleteCombatant", (combatant) => this.#removedLater(combatant));

    // Deaths.
    Hooks.on("updateActor", (actor, changes) => this.#checkDeathSaves(actor, changes));
    Hooks.on("createActiveEffect", (effect) => this.#checkDeadCondition(effect));
  }

  // --- Removals ---------------------------------------------------------------

  #removed(actor, combat) {
    if (!actor) return;
    const attributed = resolveAttributedActor(actor);
    if (attributed.uuid !== actor.uuid) return; // a summon or wild shape: not its own combatant
    this.#store.recordEvent(EVENT_TYPE.REMOVED, {
      actorUuid: actor.uuid,
      hp: hpSnapshot(actor),
      round: combat?.round ?? null
    });
  }

  #removedLater(combatant) {
    const uuid = combatant.token?.actor?.uuid ?? combatant.actor?.uuid;
    // Only the uuid is trusted here: with the token already gone, combatant.actor can fall
    // back to the base actor, whose HP is not this combatant's.
    if (!uuid) return;
    this.#store.recordEvent(EVENT_TYPE.REMOVED, { actorUuid: uuid, hp: null, round: combatant.combat?.round ?? null });
  }

  // --- Deaths -----------------------------------------------------------------

  #checkDeathSaves(actor, changes) {
    if (actor.type !== "character") return;
    if (!foundry.utils.hasProperty(changes, "system.attributes.death.failure")) return;
    const failures = actor.system?.attributes?.death?.failure ?? 0;
    if (failures >= 3) this.#store.recordEvent(EVENT_TYPE.DEATH, { actorUuid: resolveAttributedActor(actor).uuid, how: "saves" });
  }

  #checkDeadCondition(effect) {
    const actor = effect.parent;
    if (!(actor instanceof Actor) || actor.type !== "character") return;
    if (!effect.statuses?.has?.(CONFIG.specialStatusEffects?.DEFEATED ?? "dead")) return;
    this.#store.recordEvent(EVENT_TYPE.DEATH, { actorUuid: resolveAttributedActor(actor).uuid, how: "status" });
  }

  // --- Stat edits --------------------------------------------------------------

  #rememberActor(actor, changes) {
    if (!this.#store.isRecording || !touchesStats(changes)) return;
    this.#before.set(actor.uuid, statValues(actor));
  }

  #compareActor(actor, changes, options) {
    const before = this.#before.get(actor.uuid);
    if (!before) return;
    this.#before.delete(actor.uuid);
    if (options?.isRest) return; // a rest restoring things is not an edit

    const attributed = resolveAttributedActor(actor);
    if (attributed.uuid !== actor.uuid) return;
    const after = statValues(actor);
    const auto = !!options?.midi;
    const report = (key, extra) =>
      this.#store.recordEvent(EVENT_TYPE.STAT, { actorUuid: actor.uuid, key, auto, ...extra });

    for (const key of ["hp.max", "hp.tempmax", "ac", "cr"]) {
      if (before[key] !== after[key]) report(key, { from: before[key], to: after[key] });
    }
    // Ability scores and global bonuses move attack bonuses and DCs; which ones changed is
    // enough to flag the edit.
    const flat = Object.keys(foundry.utils.flattenObject(changes));
    for (const [key, prefix] of [["abilities", "system.abilities."], ["bonuses", "system.bonuses."]]) {
      const paths = flat.filter((p) => p.startsWith(prefix)).map((p) => p.slice("system.".length));
      if (paths.length) report(key, { paths });
    }
  }

  #onItemUpdated(item, changes, options, userId) {
    // Only on the client that made the change, so it is reported once.
    if (userId !== game.user.id || !this.#store.isRecording) return;
    const actor = item.parent;
    if (!(actor instanceof Actor)) return;
    if (resolveAttributedActor(actor).uuid !== actor.uuid) return;

    // An item's attack, damage, save DC or armour: what changes how hard a monster hits or
    // how hard it is to hit. Quantities, uses, equipping and preparing are normal play.
    const paths = Object.keys(foundry.utils.flattenObject(changes))
      .filter((p) => ITEM_STAT_PATH.test(p))
      .map((p) => p.replace(/^system\./, ""));
    if (!paths.length) return;
    this.#store.recordEvent(EVENT_TYPE.STAT, {
      actorUuid: actor.uuid,
      key: "item",
      itemName: item.name,
      paths,
      auto: !!options?.midi
    });
  }
}

const ITEM_STAT_PATH = /^system\.(activities\..*\.(attack|damage|save|healing)|damage|attack|save|armor|magicalBonus)\b/;

function touchesStats(changes) {
  const flat = Object.keys(foundry.utils.flattenObject(changes));
  return flat.some((p) =>
    p.startsWith("system.attributes.hp.max") ||
    p.startsWith("system.attributes.hp.tempmax") ||
    p.startsWith("system.attributes.ac.") ||
    p.startsWith("system.details.cr") ||
    p.startsWith("system.abilities.") ||
    p.startsWith("system.bonuses.")
  );
}

function statValues(actor) {
  const a = actor.system?.attributes ?? {};
  return {
    "hp.max": a.hp?.max ?? null,
    "hp.tempmax": a.hp?.tempmax ?? null,
    ac: a.ac?.value ?? null,
    cr: actor.system?.details?.cr ?? null
  };
}
