import { EVENT_TYPE, MANUAL_SOURCE, HOOK } from "./constants.mjs";
import { relayResolveAttribution } from "./socket.mjs";

/**
 * A thin view over SessionStore's events, not a separate list: an HP event is "in the
 * queue" purely by carrying the `q` flag. Resolving just sets its source actor - the
 * aggregator picks it up on its next pass, so there's no separate dealt-total bookkeeping.
 */
export class AttributionQueue {
  constructor(store) {
    this.store = store;
  }

  /** { index, t, targetUuid, amount }[] - index is the raw index into store.data.events. */
  get entries() {
    const events = this.store.data?.events ?? [];
    const out = [];
    events.forEach((e, index) => {
      if (e.e === EVENT_TYPE.HP && e.q) out.push({ index, t: e.t, targetUuid: e.g, amount: e.dmg });
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
}
