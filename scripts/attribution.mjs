import { EVENT_TYPE, MANUAL_SOURCE, ROLL_VERDICT, HOOK } from "./constants.mjs";
import { relayResolveAttribution, relayResolveRoll } from "./socket.mjs";

/**
 * A thin view over SessionStore's events, not a separate list: an HP event is "in the
 * queue" purely by carrying the `q` flag. Resolving just sets its source actor - the
 * aggregator picks it up on its next pass, so there's no separate dealt-total bookkeeping.
 */
export class AttributionQueue {
  constructor(store) {
    this.store = store;
  }

  /**
   * { index, t, targetUuid, dmg, heal, thp }[] - index is the raw index into
   * store.data.events. A single entry can carry more than one kind of change (a manual
   * edit can raise HP and temp HP at once), so all three are reported rather than one
   * collapsed "amount".
   */
  get entries() {
    const events = this.store.data?.events ?? [];
    const out = [];
    events.forEach((e, index) => {
      if (e.e === EVENT_TYPE.HP && e.q) {
        out.push({ index, t: e.t, targetUuid: e.g, dmg: e.dmg ?? 0, heal: e.heal ?? 0, thp: e.thp ?? 0 });
      }
    });
    return out;
  }

  get count() {
    return this.entries.length;
  }

  /** Roster PCs + NPCs seen in combat this session, for the resolve dropdown. */
  get candidateSources() {
    const data = this.store.data;
    if (!data) return [];
    const out = [];
    for (const uuid of data.meta.roster) {
      const name = data.actors[uuid]?.n ?? fromUuidSync(uuid)?.name ?? uuid;
      out.push({ uuid, name });
    }
    for (const [uuid, name] of Object.entries(data.meta.npcSeen)) {
      out.push({ uuid, name });
    }
    return out;
  }

  /** actorUuid may be a real actor UUID or the MANUAL_SOURCE sentinel. GM-only. */
  async resolve(index, actorUuid) {
    if (!game.user.isGM) return this.#relayResolve(index, actorUuid);

    const event = this.store.data?.events?.[index];
    if (!event || event.e !== EVENT_TYPE.HP || !event.q) return;

    delete event.q;
    event.s = actorUuid === MANUAL_SOURCE ? MANUAL_SOURCE : actorUuid;
    this.store.persist();
    Hooks.callAll(HOOK.QUEUE_CHANGED);
  }

  async #relayResolve(index, actorUuid) {
    await relayResolveAttribution(index, actorUuid);
  }

  // --- Unresolved pass/fail ------------------------------------------------

  /**
   * Rolls the system never reported a pass/fail for, flagged with `pq` at ingest.
   * { index, t, actorUuid, category, tag, face }[]
   */
  get rollEntries() {
    const events = this.store.data?.events ?? [];
    const out = [];
    events.forEach((e, index) => {
      if (e.e === EVENT_TYPE.ROLL && e.pq) {
        out.push({ index, t: e.t, actorUuid: e.a, category: e.c, tag: e.x ?? null, face: e.d[e.k] });
      }
    });
    return out;
  }

  get rollCount() {
    return this.rollEntries.length;
  }

  /** verdict is one of ROLL_VERDICT. IGNORE leaves the roll counted but pass/fail-less. */
  async resolveRoll(index, verdict) {
    if (!game.user.isGM) return relayResolveRoll(index, verdict);

    const event = this.store.data?.events?.[index];
    if (!event || event.e !== EVENT_TYPE.ROLL || !event.pq) return;

    delete event.pq;
    if (verdict === ROLL_VERDICT.PASS) event.p = true;
    else if (verdict === ROLL_VERDICT.FAIL) event.p = false;
    else event.p = null; // explicitly dismissed - stays out of passes and fails alike

    this.store.persist();
    Hooks.callAll(HOOK.QUEUE_CHANGED);
  }
}
