import { MODULE_ID, SETTING, EVENT_TYPE, ROLL_CATEGORY, HOOK, debugLog } from "./constants.mjs";
import { relayRecordEvent } from "./socket.mjs";

const FLUSH_DEBOUNCE_MS = 3000;

function freshSessionData(name, roster) {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    meta: {
      name,
      start: now,
      end: null,
      exported: false,
      roster: [...roster],
      combats: [],
      npcSeen: {} // uuid -> name, for actors that appeared in a combat this session
    },
    actors: {}, // uuid -> { n: name, t: "pc"|"npc" }
    events: []
  };
}

/**
 * Owns the session's in-memory state and its debounced persistence to a world setting.
 * Only ever mutated on the GM's client - recordEvent() is the single entry point every
 * client (GM included) calls; it decides locally whether to write directly or relay to
 * the GM over the socket, so capture code never has to know who the GM is.
 */
export class SessionStore {
  #data = null;
  #flush = foundry.utils.debounce(() => this.#writeNow(), FLUSH_DEBOUNCE_MS);

  initialize() {
    if (!game.user.isGM) return;
    this.#data = game.settings.get(MODULE_ID, SETTING.SESSION_DATA);
    Hooks.on("combatStart", (combat) => this.#noteCombat(combat));
    Hooks.on("createCombatant", (combatant) => {
      if (combatant.combat?.started) this.#noteCombat(combatant.combat);
    });
  }

  get data() {
    return this.#data;
  }

  get isRecording() {
    return !!this.#data && this.#data.meta.end === null;
  }

  get hasUnexportedData() {
    return !!this.#data && !this.#data.meta.exported;
  }

  get elapsedSeconds() {
    if (!this.#data) return 0;
    const end = this.#data.meta.end ?? Math.floor(Date.now() / 1000);
    return end - this.#data.meta.start;
  }

  get eventCount() {
    return this.#data?.events.length ?? 0;
  }

  get combatCount() {
    return this.#data?.meta.combats.length ?? 0;
  }

  /**
   * Called by capture modules on every client for every recorded roll or HP change.
   * `raw` shape depends on `type`; see roll-capture.mjs / hp-capture.mjs for producers.
   */
  recordEvent(type, raw) {
    const payload = { type, ...raw };
    if (game.user.isGM) this.ingestEvent(payload);
    else relayRecordEvent(payload).catch((err) => console.error(`${MODULE_ID} | Failed to relay event`, err, payload));
  }

  /** GM-only. Invoked directly for the GM's own captures, and via socket relay for everyone else's. */
  ingestEvent(payload) {
    if (!game.user.isGM) return;
    if (!this.isRecording) return debugLog("Dropped event, not recording", payload);

    const { type, ...raw } = payload;
    if (type === EVENT_TYPE.ROLL) this.#ingestRoll(raw);
    else if (type === EVENT_TYPE.HP) this.#ingestHP(raw);
    else return debugLog("Dropped event, unknown type", payload);

    this.#flush();
  }

  #ingestRoll(raw) {
    const resolved = this.#resolveActor(raw.actorUuid);
    if (!resolved) return debugLog("Dropped roll, actor not trackable this session", raw);

    const event = {
      e: EVENT_TYPE.ROLL,
      t: this.#elapsedNow(),
      a: resolved.uuid,
      c: raw.category,
      d: raw.faces,
      k: raw.keptIndex,
      p: raw.pass ?? null,
      ...(raw.tag ? { x: raw.tag } : {})
    };

    // dnd5e sets no target DC on ability/skill/tool checks, so the system never reports
    // pass/fail for them and they would silently contribute nothing to the pass-rate
    // column. Flag them for the GM to settle. Initiative is exempt - it has no target
    // number at all, so pass/fail is meaningless rather than merely unknown.
    if (event.p === null && raw.category !== ROLL_CATEGORY.INITIATIVE) event.pq = 1;

    this.#data.events.push(event);
    if (event.pq) Hooks.callAll(HOOK.QUEUE_CHANGED);
  }

  #ingestHP(raw) {
    // Target is required - an HP event with no trackable target is meaningless.
    const target = this.#resolveActor(raw.targetUuid);
    if (!target) return debugLog("Dropped HP event, target not trackable this session", raw);

    // Source may be absent (traps, environmental), a non-roster PC (treated as unresolved),
    // or a resolvable roster/NPC actor.
    let sourceUuid = null;
    let queued = !!raw.needsAttribution;
    if (raw.sourceUuid) {
      const source = this.#resolveActor(raw.sourceUuid);
      if (source) sourceUuid = source.uuid;
      else queued = true; // non-roster PC or otherwise untrackable source - still needs a home
    }
    // Any sourceless HP change is attributable, healing and temp HP included - a manual
    // heal is exactly as much "who did that?" as a manual point of damage.
    if (!raw.sourceUuid && (raw.dmg > 0 || raw.heal > 0 || raw.thp > 0)) queued = true;

    const event = {
      e: EVENT_TYPE.HP,
      t: this.#elapsedNow(),
      g: target.uuid,
      dmg: raw.dmg ?? 0,
      heal: raw.heal ?? 0,
      thp: raw.thp ?? 0
    };
    if (sourceUuid) event.s = sourceUuid;
    if (raw.pvp) event.pvp = 1;
    if (raw.downed) event.dn = 1;
    if (queued && !sourceUuid) event.q = 1;

    this.#data.events.push(event);
    if (event.q) Hooks.callAll(HOOK.QUEUE_CHANGED);
  }

  /**
   * Has an HP event already been recorded against this target in the last `windowSeconds`?
   * Used by the raw-update fallback in hp-capture.mjs to avoid double-recording a change
   * Midi already accounted for. Deliberately matches on target and recency only, not on
   * amounts: the Midi path folds temp-HP absorption into its damage figure while a raw HP
   * diff cannot see it, so the two legitimately disagree on magnitude for the same hit.
   */
  hasRecentHPEvent(targetUuid, windowSeconds = 6) {
    if (!this.#data) return false;
    const now = this.#elapsedNow();
    const events = this.#data.events;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (now - e.t > windowSeconds) break;
      if (e.e === EVENT_TYPE.HP && e.g === targetUuid) return true;
    }
    return false;
  }

  /** Resolves an actor for tracking purposes: PCs must be on the roster, NPCs are always eligible. */
  #resolveActor(uuid) {
    if (!uuid) return null;
    const actor = fromUuidSync(uuid);
    if (!actor) return null;

    const isPC = actor.type === "character";
    if (isPC && !this.#data.meta.roster.includes(uuid)) return null;

    this.#data.actors[uuid] = { n: actor.name, t: isPC ? "pc" : "npc" };
    return { uuid, actor };
  }

  #elapsedNow() {
    return Math.floor(Date.now() / 1000) - this.#data.meta.start;
  }

  #noteCombat(combat) {
    if (!this.#data || !this.isRecording) return;
    if (!this.#data.meta.combats.includes(combat.id)) {
      this.#data.meta.combats.push(combat.id);
    }
    for (const combatant of combat.combatants) {
      const actor = combatant.actor;
      if (actor?.type !== "npc") continue;
      const uuid = actor.uuid;
      if (!this.#data.meta.npcSeen[uuid]) {
        this.#data.meta.npcSeen[uuid] = actor.name;
        this.#flush();
      }
    }
  }

  // --- Lifecycle -----------------------------------------------------------

  startSession(name, roster) {
    if (!game.user.isGM) return;
    this.#data = freshSessionData(name, roster);
    this.#writeNow();
    Hooks.callAll(HOOK.SESSION_STARTED);
    Hooks.callAll(HOOK.STATE_CHANGED);
  }

  endSession() {
    if (!game.user.isGM || !this.#data) return;
    this.#data.meta.end = Math.floor(Date.now() / 1000);
    this.#writeNow();
    Hooks.callAll(HOOK.SESSION_ENDED);
    Hooks.callAll(HOOK.STATE_CHANGED);
  }

  discardSession() {
    if (!game.user.isGM) return;
    this.#data = null;
    this.#writeNow();
    Hooks.callAll(HOOK.STATE_CHANGED);
  }

  markExported() {
    if (!game.user.isGM || !this.#data) return;
    this.#data.meta.exported = true;
    this.#writeNow();
    Hooks.callAll(HOOK.STATE_CHANGED);
  }

  editRoster(addUuids = [], removeUuids = []) {
    if (!game.user.isGM || !this.#data) return;
    const roster = new Set(this.#data.meta.roster);
    for (const uuid of addUuids) roster.add(uuid);
    for (const uuid of removeUuids) roster.delete(uuid);
    this.#data.meta.roster = [...roster];
    this.#writeNow();
    Hooks.callAll(HOOK.STATE_CHANGED);
  }

  /** Public hook for other GM-only mutations (e.g. attribution resolution) to persist. */
  persist() {
    if (!game.user.isGM) return;
    this.#writeNow();
  }

  async #writeNow() {
    if (!game.user.isGM) return;
    await game.settings.set(MODULE_ID, SETTING.SESSION_DATA, this.#data);
  }
}
