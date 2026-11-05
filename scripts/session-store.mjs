import { MODULE_ID, SETTING, EVENT_TYPE, ROLL_CATEGORY, HOOK, debugLog } from "./constants.mjs";
import { relayRecordEvent } from "./socket.mjs";
import { describeActor } from "./actor-info.mjs";
import { resolveAttributedActor } from "./actor-resolve.mjs";

const FLUSH_DEBOUNCE_MS = 3000;

// Grace period for an amendment whose roll is still crossing the network from the client
// that rolled it.
const AMEND_RETRY_MS = 2000;

// Events captured this long before a session starts are carried into it. A GM hits Start
// within moments of play beginning, so this only rescues the first roll or two that beat
// them to it - short enough that earlier test rolls are never swept up.
const BACKFILL_WINDOW_MS = 60000;

// A fight whose turn hasn't moved for this long is treated as abandoned - a GM who moved on
// without ending the combat - so later events stop being credited to it.
const FIGHT_STALE_SECONDS = 30 * 60;

function freshSessionData(name) {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    meta: {
      id: foundry.utils.randomID(), // identifies the session to the upload receiver
      name,
      start: now,
      end: null,
      exported: false,
      combats: [],
      // One entry per combat that ran this session, in order. Events carry `f`, an index
      // into this list. { id, s, e, last, r, c } - combat id; start, end and last turn
      // change in session seconds; rounds; combatants as uuid -> 1 hostile / 0 otherwise.
      fights: [],
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
  #preSession = []; // { at, payload } captured before a session started, GM-side only
  #preSessionAmendments = []; // { at, amendment }, same
  #flush = foundry.utils.debounce(() => this.#writeNow(), FLUSH_DEBOUNCE_MS);

  initialize() {
    // Every client loads the session for reading - players need it to view the report when
    // the world setting allows it. Writing stays GM-only; see recordEvent/#writeNow.
    this.#data = game.settings.get(MODULE_ID, SETTING.SESSION_DATA);
    if (!game.user.isGM) return;

    // A fight is registered by visible activity in this session - starting it, or moving its
    // turn - never merely by existing. A combat left running from last week is never
    // touched again, so it never claims tonight's events.
    Hooks.on("combatStart", (combat) => this.#noteCombat(combat));
    Hooks.on("updateCombat", (combat, changes) => {
      if (combat.started && ("round" in changes || "turn" in changes)) this.#noteCombat(combat);
    });
    Hooks.on("createCombatant", (combatant) => {
      if (combatant.combat?.started) this.#noteCombat(combatant.combat);
    });
    Hooks.on("deleteCombat", (combat) => this.#endFight(combat));
  }

  /**
   * Called on non-GM clients when the GM's flush propagates the world setting. The GM must
   * never take this path: its in-memory copy is ahead of the setting between debounced
   * flushes, so overwriting from the setting would discard events not yet written.
   */
  syncFromSetting(value) {
    if (game.user.isGM) return;
    this.#data = value;
    Hooks.callAll(HOOK.STATE_CHANGED);
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
    const meta = this.#data?.meta;
    if (!meta) return 0;
    return meta.fights ? meta.fights.length : meta.combats.length; // fights: sessions since 0.6
  }

  /** Epoch seconds of the session's most recent d20 roll, or its start if nobody has rolled. */
  get lastRollAt() {
    if (!this.#data) return null;
    const events = this.#data.events;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].e === EVENT_TYPE.ROLL) return this.#data.meta.start + events[i].t;
    }
    return this.#data.meta.start;
  }

  /** Epoch seconds of the session's most recent event of any kind, or its start if none. */
  get lastEventAt() {
    if (!this.#data) return null;
    const latest = this.#data.events.reduce((max, e) => Math.max(max, e.t), 0);
    return this.#data.meta.start + latest;
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
    if (!this.isRecording) return this.#bufferPreSession(payload);

    const { type, ...raw } = payload;
    if (type === EVENT_TYPE.ROLL) this.#ingestRoll(raw);
    else if (type === EVENT_TYPE.HP) this.#ingestHP(raw);
    else if (type === EVENT_TYPE.MISS || type === EVENT_TYPE.HIT) this.#ingestAttacked(type, raw);
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

    // Initiative is rolled before a fight's first round, when it is not yet registered, and
    // per-fight initiative is no use to anyone - so it is left untagged.
    if (raw.category !== ROLL_CATEGORY.INITIATIVE) this.#tagFight(event, resolved.uuid);

    this.#data.events.push(event);
    if (event.pq) Hooks.callAll(HOOK.QUEUE_CHANGED);
  }

  /** An attack that targeted this actor, hit or miss. No source is kept - the stat is about
   *  the defender: how often they are attacked and how often that misses. */
  #ingestAttacked(type, raw) {
    const target = this.#resolveActor(raw.targetUuid);
    if (!target) return debugLog("Dropped attack, target not trackable this session", raw);
    const event = { e: type, t: this.#elapsedNow(), g: target.uuid };
    this.#tagFight(event, target.uuid);
    this.#data.events.push(event);
  }

  #ingestHP(raw) {
    // Target is required - an HP event with no trackable target is meaningless.
    const target = this.#resolveActor(raw.targetUuid);
    if (!target) return debugLog("Dropped HP event, target not trackable this session", raw);

    // Source may be absent entirely (traps, environmental, manual edits) or unresolvable.
    let sourceUuid = null;
    let queued = !!raw.needsAttribution;
    if (raw.sourceUuid) {
      const source = this.#resolveActor(raw.sourceUuid);
      if (source) sourceUuid = source.uuid;
      else queued = true; // named a source we cannot resolve - still needs a home
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
    this.#tagFight(event, target.uuid, sourceUuid);

    this.#data.events.push(event);
    if (event.q) Hooks.callAll(HOOK.QUEUE_CHANGED);
  }

  /**
   * Holds events seen while no session is recording, so the first roll or two of the
   * evening are not lost to a GM who is a few seconds behind the table. Pruned to
   * BACKFILL_WINDOW_MS on every write, which is what keeps earlier test rolls out.
   */
  #bufferPreSession(payload) {
    const now = Date.now();
    this.#preSession.push({ at: now, payload });
    const cutoff = now - BACKFILL_WINDOW_MS;
    while (this.#preSession.length && this.#preSession[0].at < cutoff) this.#preSession.shift();
  }

  /** Same, for amendments - otherwise a backfilled save would lose its pass/fail. */
  #bufferAmendment(amendment) {
    const now = Date.now();
    this.#preSessionAmendments.push({ at: now, amendment });
    const cutoff = now - BACKFILL_WINDOW_MS;
    while (this.#preSessionAmendments.length && this.#preSessionAmendments[0].at < cutoff) {
      this.#preSessionAmendments.shift();
    }
  }

  /** Replays the buffer into a session that has just started, newest window only. */
  #replayBackfill() {
    const cutoff = Date.now() - BACKFILL_WINDOW_MS;
    const events = this.#preSession.filter((e) => e.at >= cutoff);
    const amendments = this.#preSessionAmendments.filter((a) => a.at >= cutoff);
    this.#preSession = [];
    this.#preSessionAmendments = [];

    for (const { payload } of events) this.ingestEvent(payload);
    // After the events, so each amendment finds the roll it belongs to.
    for (const { amendment } of amendments) this.amendRoll(amendment);
    if (events.length) debugLog("Backfilled pre-session events", { events: events.length, amendments: amendments.length });
  }

  /**
   * Applies an amendment, retrying once shortly after if the roll it refers to has not
   * arrived yet: the roll is relayed from whichever client physically rolled it, while the
   * amendment comes from the client running the workflow, so they can land out of order.
   * If it still finds nothing the amendment is dropped and the roll simply stays in the
   * pass/fail queue for the GM - degraded, not wrong.
   */
  queueAmendment(amendment) {
    if (!game.user.isGM) return;
    if (!this.isRecording) return this.#bufferAmendment(amendment);
    if (this.amendRoll(amendment)) return;
    setTimeout(() => {
      if (!this.amendRoll(amendment)) debugLog("Amendment found no matching roll", amendment);
    }, AMEND_RETRY_MS);
  }

  /**
   * Amends the most recent matching roll instead of recording a new one.
   *
   * Several sources describe the same physical roll. dnd5e fires `rollSavingThrow` from
   * inside both death saves and concentration saves, and Midi determines pass/fail only
   * after the roll has already been reported. Recording each source separately would
   * double-count; amending lets a later, better-informed source fill in what the first
   * could not know.
   *
   * Matches on actor plus the exact dice faces, newest first, within a short window.
   * Returns true if an event was amended.
   */
  amendRoll({ actorUuid, faces, pass, tag }, windowSeconds = 20) {
    if (!game.user.isGM || !this.#data) return false;

    const now = this.#elapsedNow();
    const events = this.#data.events;
    const wanted = JSON.stringify(faces);

    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (now - e.t > windowSeconds) break;
      if (e.e !== EVENT_TYPE.ROLL || e.a !== actorUuid) continue;
      if (JSON.stringify(e.d) !== wanted) continue;

      if (tag !== undefined) e.x = tag;
      if (pass !== undefined && pass !== null) {
        e.p = pass;
        delete e.pq; // settled by the system, so it no longer needs the GM
        Hooks.callAll(HOOK.QUEUE_CHANGED);
      }
      this.#flush();
      return true;
    }
    return false;
  }

  /**
   * Registers an actor's display entry so aggregation can find it. Needed when resolving
   * an attribution to an NPC that appeared in a combat but never generated an event of its
   * own: it lives in meta.npcSeen but not in `actors`, and the aggregator looks it up there
   * - so without this the resolved damage would be credited to nobody.
   */
  ensureActorTracked(uuid) {
    if (!game.user.isGM || !this.#data) return false;
    return !!this.#resolveActor(uuid);
  }

  /**
   * Registers an actor's display identity. Every character and NPC is trackable; who
   * actually appears in the report is decided by whether they generated any events, not by
   * a roster chosen up front.
   */
  #resolveActor(uuid) {
    if (!uuid) return null;
    const actor = fromUuidSync(uuid);
    if (!actor) return null;

    // Class, level and CR are snapshotted the first time an actor appears (see
    // actor-info.mjs); only the name follows later changes, so a rename still shows.
    const existing = this.#data.actors[uuid];
    if (existing?.v === 2) existing.n = actor.name;
    else this.#data.actors[uuid] = describeActor(actor);
    return { uuid, actor };
  }

  #elapsedNow() {
    // Clamped: replayed backfill events happened before the session began, and a negative
    // offset would sort them oddly and break the amendment window.
    return Math.max(0, Math.floor(Date.now() / 1000) - this.#data.meta.start);
  }

  /**
   * Registers a combat as a fight of this session (or refreshes it): its round count, the
   * time of its latest turn, and everyone in it. Every combatant is recorded, including
   * those who never act, so a PC who did nothing in a fight still counts as a zero there -
   * leaving them out would inflate the per-fight averages.
   */
  #noteCombat(combat) {
    if (!this.#data || !this.isRecording) return;
    const meta = this.#data.meta;
    if (!meta.combats.includes(combat.id)) meta.combats.push(combat.id);
    meta.fights ??= []; // a session started before 0.6 has no fight list

    const now = this.#elapsedNow();
    let fight = meta.fights.find((f) => f.id === combat.id);
    if (!fight) {
      fight = { id: combat.id, s: now, e: null, last: now, r: 0, c: {} };
      meta.fights.push(fight);
    }
    fight.last = now;
    fight.r = Math.max(fight.r, combat.round ?? 0);

    for (const combatant of combat.combatants) {
      const actor = combatant.actor;
      if (!actor) continue;
      if (actor.type === "npc" && !meta.npcSeen[actor.uuid]) meta.npcSeen[actor.uuid] = actor.name;

      // Same roll-up as everywhere else: a wild-shaped PC is their base character, a summon
      // is its summoner.
      const resolved = this.#resolveActor(resolveAttributedActor(actor).uuid);
      if (!resolved) continue;
      const hostile = combatant.token?.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE ? 1 : 0;
      // Never downgraded: an enemy whose summon is friendly-flagged stays an enemy.
      fight.c[resolved.uuid] = Math.max(fight.c[resolved.uuid] ?? 0, hostile);
    }
    this.#flush();
  }

  #endFight(combat) {
    if (!this.isRecording) return;
    const fight = this.#data.meta.fights?.find((f) => f.id === combat.id && f.e === null);
    if (!fight) return;
    fight.e = this.#elapsedNow();
    fight.r = Math.max(fight.r, combat.round ?? 0);
    this.#flush();
  }

  /**
   * Credits an event to the fight it happened in, as `f`. With one live fight, everything
   * belongs to it - including a PC who never joined the tracker but swung a sword anyway.
   * With several at once (two scenes fighting), the fight that has these actors in it.
   */
  #tagFight(event, ...uuids) {
    const fights = this.#data.meta.fights;
    if (!fights?.length) return;
    const now = this.#elapsedNow();
    const live = [];
    fights.forEach((f, i) => {
      if (f.e === null && now - f.last <= FIGHT_STALE_SECONDS) live.push(i);
    });
    if (!live.length) return;

    let index = live.length === 1 ? live[0] : null;
    if (index === null) index = live.find((i) => uuids.some((u) => u && u in fights[i].c)) ?? null;
    if (index !== null) event.f = index;
  }

  // --- Lifecycle -----------------------------------------------------------

  startSession(name) {
    if (!game.user.isGM) return;
    this.#data = freshSessionData(name);
    this.#replayBackfill();
    this.#writeNow();
    Hooks.callAll(HOOK.SESSION_STARTED);
    Hooks.callAll(HOOK.STATE_CHANGED);
  }

  /**
   * @param {object} [options]
   * @param {number} [options.at]  Epoch seconds to stamp as the end, for a session closed
   *   after the fact (see idle-end.mjs). Defaults to now.
   */
  endSession({ at } = {}) {
    if (!game.user.isGM || !this.#data) return;
    this.#data.meta.end = at ?? Math.floor(Date.now() / 1000);
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
