import { EVENT_TYPE, HOOK, debugLog } from "./constants.mjs";
import { resolveAttributedActor } from "./actor-resolve.mjs";
import { relayMarkHitDie } from "./socket.mjs";

/**
 * HP is captured from the actual `updateActor` that changes it, GM-side only.
 *
 * This is deliberately the single source. Midi's `workflow.damageList` describes what it
 * intends to apply, not what happened: it is rebuilt per damage-selector (so an activity
 * with a secondary damage roll leaves only those entries behind), it is empty when nothing
 * was targeted, it contains entries for attacks that missed, and several application
 * routes never populate it at all. Reading it produced phantom damage on misses and lost
 * healing outright.
 *
 * Every Midi-driven application - auto-apply, the GM damage card, the damage tray - instead
 * calls `actor.update()` with `options.midi.sourceActorUuid` naming the attacker or healer,
 * and Midi resolves damage GM-side, so the GM's client always sees both the real HP change
 * and its source. Anything arriving without that (a token HP-bar edit, a trap, a macro
 * using the legacy apply path) genuinely has no source and goes to the attribution queue.
 */
export class HPCapture {
  #store;
  #lastKnownHP = new Map(); // actorUuid -> { hp, temp }, GM-side only, reset each session
  #ignoreNextUpdate = new Set(); // actorUuid, GM-side only (hit-die suppression)

  constructor(store) {
    this.#store = store;
    Hooks.on(HOOK.SESSION_STARTED, () => this.#resetGmState());
  }

  registerHooks() {
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
    this.#ignoreNextUpdate.clear();
  }

  #onRollHitDie(actor) {
    if (!actor) return;
    if (game.user.isGM) this.markHitDie(actor.uuid);
    else relayMarkHitDie(actor.uuid).catch((err) => console.error("cg-session-stats | Failed to relay hit die marker", err));
  }

  /**
   * Captures an actor's HP *before* an update lands. Without this, the first HP change an
   * actor sees in a session has no prior value to diff against and gets silently swallowed
   * as baseline-seeding.
   */
  #seedBaselineGM(actor, changes) {
    if (this.#lastKnownHP.has(actor.uuid)) return;
    if (!touchesHP(changes)) return;
    this.#lastKnownHP.set(actor.uuid, {
      hp: actor.system.attributes.hp.value,
      temp: actor.system.attributes.hp.temp ?? 0
    });
  }

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

    const deltaHP = newHP - prev.hp;
    const deltaTemp = newTemp - prev.temp;
    if (deltaHP === 0 && deltaTemp === 0) return;

    // Losing temp HP is damage absorbed, so it counts as damage taken the same way HP loss
    // does - otherwise a hit soaked entirely by temp vanishes from the stats.
    let dmg = 0, heal = 0, thp = 0;
    if (deltaHP < 0) dmg = -deltaHP;
    else if (deltaHP > 0) heal = deltaHP;
    if (deltaTemp > 0) thp = deltaTemp;
    else if (deltaTemp < 0) dmg += -deltaTemp;
    if (dmg === 0 && heal === 0 && thp === 0) return;

    const target = resolveAttributedActor(actor);
    const source = this.#resolveSource(options);

    debugLog("HP change", {
      target: actor.name,
      source: source?.name ?? "(unattributed)",
      dmg,
      heal,
      thp
    });

    this.#store.recordEvent(EVENT_TYPE.HP, {
      targetUuid: target.uuid,
      sourceUuid: source?.uuid ?? null,
      needsAttribution: !source && (dmg > 0 || heal > 0 || thp > 0),
      dmg,
      heal,
      thp,
      // "pvp" means same side, self included: excluded from the dealer's damage-dealt total
      // but still counted as damage taken, per the brief's friendly-fire rule.
      pvp: dmg > 0 && !!source && sameSide(source, target),
      downed: dmg > 0 && prev.hp > 0 && newHP === 0,
      // Where HP stands afterwards, so the website can follow it through a fight.
      hpAfter: newHP,
      tempAfter: newTemp,
      maxAfter: actor.system.attributes.hp.max,
      // A wild shape or summon credited to its owner: these numbers are the other body's.
      otherBody: target.uuid !== actor.uuid
    });
  }

  /** The attacker or healer Midi named on the update, rolled up to summoner/base actor. */
  #resolveSource(options) {
    const uuid = options?.midi?.sourceActorUuid;
    if (!uuid) return null;
    const actor = fromUuidSync(uuid);
    if (!(actor instanceof Actor)) return null;
    return resolveAttributedActor(actor);
  }
}

function touchesHP(changes) {
  return (
    foundry.utils.hasProperty(changes, "system.attributes.hp.value") ||
    foundry.utils.hasProperty(changes, "system.attributes.hp.temp")
  );
}

/** Disposition lives on tokens; fall back to the prototype for actors with none placed. */
function dispositionOf(actor) {
  const placed = actor?.getActiveTokens?.(false, true) ?? [];
  const fromToken = placed[0]?.disposition ?? placed[0]?.document?.disposition;
  return Number.isFinite(fromToken) ? fromToken : actor?.prototypeToken?.disposition;
}

function sameSide(source, target) {
  if (source.uuid === target.uuid) return true; // self-damage follows the friendly-fire rule
  const a = dispositionOf(source);
  const b = dispositionOf(target);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a * b > 0;
}
