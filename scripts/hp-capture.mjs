import { EVENT_TYPE, HOOK, debugLog } from "./constants.mjs";
import { resolveAttributedActor } from "./actor-resolve.mjs";
import { relayMarkHitDie } from "./socket.mjs";

// How long the raw-update fallback waits for a matching midi-qol.RollComplete to claim an
// actor's HP change before treating it as unattributed. RollComplete fires shortly after
// the update it corresponds to, well within this window in practice.
const DEDUPE_WINDOW_MS = 200;

/**
 * Two independent capture paths, by necessity:
 *
 * - `midi-qol.RollComplete` only fires on the client that ran the workflow (the acting
 *   player's client), carrying full attribution (source actor, per-target effective
 *   damage/heal/temp HP). Runs on every client; forwards through store.recordEvent(),
 *   which relays to the GM.
 * - The raw `updateActor` fallback catches HP changes Midi never wrapped in a workflow
 *   (GM manual application, macros, traps). `updateActor` is core document sync, so it
 *   fires identically and independently on every client, including the GM's - so this
 *   path runs GM-side only, straight into the store, with no relay needed. Running it on
 *   every client would double-relay the same broadcasted update.
 */
export class HPCapture {
  #store;
  #lastKnownHP = new Map(); // actorUuid -> { hp, temp }, GM-side only, reset each session
  #pendingFallback = new Map(); // actorUuid -> timeoutId, GM-side only
  #ignoreNextUpdate = new Set(); // actorUuid, GM-side only (hit-die suppression)

  constructor(store) {
    this.#store = store;
    Hooks.on(HOOK.SESSION_STARTED, () => this.#resetGmState());
  }

  registerHooks() {
    Hooks.on("midi-qol.RollComplete", (workflow) => this.#onRollComplete(workflow));
    Hooks.on("dnd5e.rollHitDieV2", (rolls, { subject }) => this.#onRollHitDie(subject));
    if (game.user.isGM) Hooks.on("updateActor", (actor, changes, options) => this.#onUpdateActorGM(actor, changes, options));
  }

  /** Invoked GM-side via socket relay when any client rolls a hit die. */
  markHitDie(actorUuid) {
    if (actorUuid) this.#ignoreNextUpdate.add(actorUuid);
  }

  #resetGmState() {
    this.#lastKnownHP.clear();
    for (const id of this.#pendingFallback.values()) clearTimeout(id);
    this.#pendingFallback.clear();
    this.#ignoreNextUpdate.clear();
  }

  #onRollHitDie(actor) {
    if (!actor) return;
    if (game.user.isGM) this.markHitDie(actor.uuid);
    else relayMarkHitDie(actor.uuid).catch((err) => console.error("cg-session-stats | Failed to relay hit die marker", err));
  }

  // --- Primary: Midi-QOL workflow damage -----------------------------------

  #onRollComplete(workflow) {
    const damageList = workflow.damageList;
    if (!Array.isArray(damageList) || !damageList.length) return;

    const sourceActor = workflow.actor ? resolveAttributedActor(workflow.actor) : null;
    const sourceToken = workflow.token ?? null;
    const sourceDisposition = sourceToken?.document?.disposition ?? sourceToken?.disposition;
    const isSyntheticOverTime = workflow.item?.getFlag?.("midi-qol", "syntheticItem") === true;

    for (const entry of damageList) {
      const rawTargetActor = this.#resolveEntryActor(entry);
      if (!rawTargetActor) continue;
      const targetActor = resolveAttributedActor(rawTargetActor);

      // The GM's own fallback listener will otherwise pick up this same HP change a
      // moment later; claim it now so it doesn't get double-recorded as unattributed.
      if (game.user.isGM) {
        this.#clearPendingFallback(rawTargetActor.uuid);
        this.#clearPendingFallback(targetActor.uuid);
        this.#syncLastKnown(rawTargetActor);
      }

      const hpDamage = entry.hpDamage ?? 0;
      const tempDelta = entry.tempDamage ?? 0; // >0 = temp consumed (absorbed damage), <0 = temp granted

      let dmg = 0, heal = 0, thp = 0;
      if (hpDamage > 0) dmg = hpDamage + Math.max(tempDelta, 0);
      else if (hpDamage < 0) heal = -hpDamage;
      if (tempDelta < 0) thp = -tempDelta;
      if (dmg === 0 && heal === 0 && thp === 0) continue;

      const targetDisposition = this.#dispositionForEntry(entry, rawTargetActor);
      const sameSide =
        Number.isFinite(sourceDisposition) && Number.isFinite(targetDisposition)
          ? sourceDisposition * targetDisposition > 0
          : sourceActor?.uuid === targetActor.uuid;

      // Over-time damage whose origin didn't resolve falls back (inside Midi) to being
      // parented to the victim itself - indistinguishable from genuine self-damage except
      // for this synthetic-item marker, so treat that specific combination as unresolved
      // rather than silently crediting a phantom "self-damage" source.
      const unresolvedOrigin = isSyntheticOverTime && sourceActor?.uuid === targetActor.uuid;

      this.#store.recordEvent(EVENT_TYPE.HP, {
        targetUuid: targetActor.uuid,
        sourceUuid: unresolvedOrigin ? null : sourceActor?.uuid ?? null,
        needsAttribution: unresolvedOrigin && dmg > 0,
        dmg,
        heal,
        thp,
        // "pvp" here means "same side, including self" - excluded from the dealer's
        // damage-dealt total but still counted as damage taken, per the brief's rule that
        // self-damage follows the same treatment as friendly fire.
        pvp: dmg > 0 && !!sourceActor && sameSide,
        downed: (entry.oldHP ?? null) > 0 && entry.newHP === 0
      });
    }
  }

  #resolveEntryActor(entry) {
    if (entry.actorUuid) {
      const a = fromUuidSync(entry.actorUuid);
      if (a instanceof Actor) return a;
    }
    const doc = entry.targetUuid ? fromUuidSync(entry.targetUuid) : null;
    if (!doc) return null;
    return doc instanceof Actor ? doc : doc.actor ?? null;
  }

  #dispositionForEntry(entry, actor) {
    const doc = entry.targetUuid ? fromUuidSync(entry.targetUuid) : null;
    const tokenDoc = doc?.document ?? doc;
    if (Number.isFinite(tokenDoc?.disposition)) return tokenDoc.disposition;
    return actor?.prototypeToken?.disposition;
  }

  // --- Fallback: raw HP updates Midi never wrapped in a workflow -----------

  #onUpdateActorGM(actor, changes, options) {
    if (options.isRest) return;

    const hpChanged = foundry.utils.hasProperty(changes, "system.attributes.hp.value");
    const tempChanged = foundry.utils.hasProperty(changes, "system.attributes.hp.temp");
    if (!hpChanged && !tempChanged) return;

    const newHP = actor.system.attributes.hp.value;
    const newTemp = actor.system.attributes.hp.temp ?? 0;
    const prev = this.#lastKnownHP.get(actor.uuid);
    this.#lastKnownHP.set(actor.uuid, { hp: newHP, temp: newTemp });

    // First sighting this session seeds the baseline only - no prior value to diff against.
    if (!prev) return;

    if (this.#ignoreNextUpdate.delete(actor.uuid)) return; // hit-die heal, excluded per brief

    const deltaHP = newHP - prev.hp;
    const deltaTemp = newTemp - prev.temp;
    if (deltaHP === 0 && deltaTemp === 0) return;

    const timeoutId = setTimeout(() => {
      this.#pendingFallback.delete(actor.uuid);
      this.#recordFallback(actor, prev, { hp: newHP, temp: newTemp });
    }, DEDUPE_WINDOW_MS);
    this.#pendingFallback.set(actor.uuid, timeoutId);
  }

  #recordFallback(actor, prev, current) {
    const attributed = resolveAttributedActor(actor);
    const deltaHP = current.hp - prev.hp;
    const deltaTemp = current.temp - prev.temp;

    let dmg = 0, heal = 0, thp = 0;
    if (deltaHP < 0) dmg = -deltaHP;
    else if (deltaHP > 0) heal = deltaHP;
    if (deltaTemp > 0) thp = deltaTemp;
    if (dmg === 0 && heal === 0 && thp === 0) return;

    debugLog("Unattributed HP change caught by fallback", { actor: actor.name, dmg, heal, thp });

    this.#store.recordEvent(EVENT_TYPE.HP, {
      targetUuid: attributed.uuid,
      sourceUuid: null,
      needsAttribution: dmg > 0,
      dmg,
      heal,
      thp,
      pvp: false,
      downed: dmg > 0 && prev.hp > 0 && current.hp === 0
    });
  }

  #clearPendingFallback(uuid) {
    if (!uuid) return;
    const timeoutId = this.#pendingFallback.get(uuid);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.#pendingFallback.delete(uuid);
    }
  }

  #syncLastKnown(actor) {
    this.#lastKnownHP.set(actor.uuid, {
      hp: actor.system.attributes.hp.value,
      temp: actor.system.attributes.hp.temp ?? 0
    });
  }
}
