import { EVENT_TYPE, MANUAL_SOURCE, NOT_TRACKED, ROLL_VERDICT, HOOK } from "./constants.mjs";

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

  /**
   * Roster PCs and NPCs seen in combat this session, grouped for the resolve dropdown.
   *
   * NPCs are collapsed by name to mirror how the report aggregates them: six unlinked
   * goblins are one "Goblin" row, so six dropdown entries would just be six ways to pick
   * the same row. Any one of their UUIDs lands in that row, so the first is kept.
   * PCs stay individual - they are their own rows even if two share a name.
   */
  get candidateSources() {
    const data = this.store.data;
    if (!data) return { pcs: [], npcs: [] };

    const pcs = data.meta.roster.map((uuid) => ({
      uuid,
      name: data.actors[uuid]?.n ?? fromUuidSync(uuid)?.name ?? uuid
    }));

    const byName = new Map();
    for (const [uuid, name] of Object.entries(data.meta.npcSeen)) {
      if (!byName.has(name)) byName.set(name, { uuid, name });
    }
    const npcs = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

    return { pcs, npcs };
  }

  /**
   * actorUuid may be a real actor UUID or the MANUAL_SOURCE sentinel. GM-only, and
   * deliberately not relayed: the GM is the only legitimate resolver, so a non-GM caller
   * (the module API is reachable from any console) simply does nothing.
   */
  async resolve(index, actorUuid) {
    if (!game.user.isGM) return;

    const event = this.store.data?.events?.[index];
    if (!event || event.e !== EVENT_TYPE.HP || !event.q) return;

    delete event.q;
    // "Not tracked" voids the event rather than sourcing it: the GM is correcting an HP
    // value, so it should count as neither damage taken nor healing received. Kept in the
    // log (flagged) instead of deleted, so the event record stays a faithful history.
    if (actorUuid === NOT_TRACKED) event.ig = 1;
    else if (actorUuid === MANUAL_SOURCE) event.s = MANUAL_SOURCE;
    else {
      // An NPC picked from the dropdown may only exist in meta.npcSeen so far; register it
      // before crediting, or aggregation finds no identity for it and credits nobody.
      this.store.ensureActorTracked(actorUuid);
      event.s = actorUuid;
    }

    this.store.persist();
    Hooks.callAll(HOOK.QUEUE_CHANGED);
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
    if (!game.user.isGM) return;

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
