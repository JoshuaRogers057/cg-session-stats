import { EVENT_TYPE, HOOK, debugLog } from "./constants.mjs";
import { resolveAttributedActor } from "./actor-resolve.mjs";
import { relayMarkHitDie } from "./socket.mjs";

// How long the raw-update fallback defers before treating an HP change as unattributed.
// This is a settling delay, not a correctness guarantee - it gives the Midi-derived event
// (which may be arriving over the socket from another client) time to reach the store
// before hasRecentHPEvent() is consulted. The store check is what actually prevents
// double-recording; see #recordFallback.
const DEDUPE_WINDOW_MS = 1500;

// How long a Midi "expected post-application HP" marker stays valid. Only needs to cover
// the gap between midi-qol.RollComplete and the fire-and-forget actor.update landing.
const MIDI_EXPECTATION_TTL_MS = 10000;

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
  #midiExpected = new Map(); // actorUuid -> { hp, temp, at }, GM-side only

  constructor(store) {
    this.#store = store;
    Hooks.on(HOOK.SESSION_STARTED, () => this.#resetGmState());
  }

  registerHooks() {
    Hooks.on("midi-qol.RollComplete", (workflow) => this.#onRollComplete(workflow));
    Hooks.on("dnd5e.rollHitDieV2", (rolls, { subject }) => this.#onRollHitDie(subject));
    if (game.user.isGM) {
      Hooks.on("preUpdateActor", (actor, changes) => this.#seedBaselineGM(actor, changes));
      Hooks.on("updateActor", (actor, changes, options) => this.#onUpdateActorGM(actor, changes, options));
    }
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
    this.#midiExpected.clear();
  }

  /**
   * Captures an actor's HP *before* an update lands. Without this, the first HP change an
   * actor sees in a session has no prior value to diff against and gets silently swallowed
   * as baseline-seeding - which meant the first manual adjustment to any given token never
   * reached the attribution queue.
   */
  #seedBaselineGM(actor, changes) {
    if (this.#lastKnownHP.has(actor.uuid)) return;
    if (!touchesHP(changes)) return;
    this.#lastKnownHP.set(actor.uuid, {
      hp: actor.system.attributes.hp.value,
      temp: actor.system.attributes.hp.temp ?? 0
    });
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

      // Dedup against the GM's own fallback listener, which sees the same HP change as a
      // raw update. Ordering varies (Midi's actor.update is fire-and-forget unless
      // waitForDamageApplication is on), so both directions are covered: cancel a fallback
      // already pending, and record the exact HP this target is expected to land on so an
      // update arriving later can be matched and skipped.
      if (game.user.isGM) {
        this.#clearPendingFallback(rawTargetActor.uuid);
        this.#clearPendingFallback(targetActor.uuid);
        this.#midiExpected.set(rawTargetActor.uuid, {
          hp: entry.newHP,
          temp: entry.newTempHP ?? 0,
          at: Date.now()
        });
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
    if (!touchesHP(changes)) return;

    const newHP = actor.system.attributes.hp.value;
    const newTemp = actor.system.attributes.hp.temp ?? 0;
    const prev = this.#lastKnownHP.get(actor.uuid);
    // The baseline has to track reality even for changes deliberately not recorded below,
    // or the next genuine change diffs against a stale value and reports a nonsense amount
    // (e.g. a long rest healing 50 would make the following 10 damage look like +40 heal).
    this.#lastKnownHP.set(actor.uuid, { hp: newHP, temp: newTemp });

    if (options.isRest) return; // rest HP restoration excluded entirely, per brief
    if (!prev) return; // no pre-update baseline; #seedBaselineGM normally guarantees one
    if (this.#ignoreNextUpdate.delete(actor.uuid)) return; // hit-die heal, excluded per brief
    if (this.#consumeMidiExpectation(actor.uuid, newHP, newTemp)) return; // Midi already recorded it

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

    // Last-resort dedup for the cross-client case: when a *player* runs the workflow,
    // midi-qol.RollComplete fires only on their client, so this client has neither a
    // pending fallback to cancel nor an expected-HP marker to match - all it can do is
    // check whether the relayed event has already been recorded. Deliberately narrow,
    // since matching on recency alone would also swallow a genuine manual adjustment made
    // moments after a hit on the same token.
    if (this.#store.hasRecentHPEvent(attributed.uuid, 3)) {
      return debugLog("Fallback suppressed, Midi already recorded this change", { actor: actor.name, dmg, heal, thp });
    }

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

  /**
   * Midi states exactly what HP each target should end up on, so an update landing on
   * precisely those values is the one Midi already reported. Matching the values rather
   * than just the timing means a genuine manual adjustment moments after a Midi hit on the
   * same token is still recognised as separate and reaches the attribution queue.
   */
  #consumeMidiExpectation(uuid, hp, temp) {
    const expected = this.#midiExpected.get(uuid);
    if (!expected) return false;
    if (Date.now() - expected.at > MIDI_EXPECTATION_TTL_MS) {
      this.#midiExpected.delete(uuid);
      return false;
    }
    if (expected.hp !== hp || expected.temp !== temp) return false;
    this.#midiExpected.delete(uuid);
    return true;
  }
}

function touchesHP(changes) {
  return (
    foundry.utils.hasProperty(changes, "system.attributes.hp.value") ||
    foundry.utils.hasProperty(changes, "system.attributes.hp.temp")
  );
}
