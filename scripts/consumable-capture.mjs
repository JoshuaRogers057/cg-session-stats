import { EVENT_TYPE } from "./constants.mjs";
import { resolveAttributedActor } from "./actor-resolve.mjs";

// How long a drop in a consumable's count waits for the use that explains it. dnd5e takes the
// item (or its quantity) first and reports the use afterwards.
const PAIR_WINDOW_MS = 2000;

/**
 * Consumables used during the session (0.7), so the website can suggest what each character
 * used when the DM closes out the quest. The website matches names against the character's
 * Brought list there; nothing here needs to know about it.
 *
 * - USE: a consumable's activity was used (a potion drunk, a scroll read). `ok` when that use
 *   took the item or a charge of it.
 * - DROP: its count went down, or it was deleted, with no use to explain it: given to another
 *   character, dropped or deleted. The website treats these as "maybe used".
 *
 * Ammunition is ignored. Everything runs on the client that used or changed the item (the
 * only one that sees it) and is relayed to the GM by the store.
 */
export class ConsumableCapture {
  #store;
  #pending = new Map(); // item id -> { timer, raw } for a drop waiting for its use
  #recentUses = new Map(); // item id -> time of its last use, for drops that come after it

  constructor(store) {
    this.#store = store;
  }

  registerHooks() {
    Hooks.on("dnd5e.postUseActivity", (activity) => this.#onUse(activity?.item));
    Hooks.on("preUpdateItem", (item, changes) => this.#onUpdate(item, changes));
    Hooks.on("preDeleteItem", (item) => this.#onDelete(item));
  }

  #onUse(item) {
    if (!tracked(item) || !this.#store.isRecording) return;
    const pending = this.#pending.get(item.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(item.id);
    }
    this.#recentUses.set(item.id, Date.now());
    this.#store.recordEvent(EVENT_TYPE.USE, {
      ...describe(item),
      count: pending?.raw.count ?? 1,
      consumed: !!pending
    });
  }

  #onUpdate(item, changes) {
    if (!tracked(item) || !this.#store.isRecording) return;
    const next = foundry.utils.getProperty(changes, "system.quantity");
    const now = item.system?.quantity;
    if (!Number.isFinite(next) || !Number.isFinite(now) || next >= now) return;
    this.#candidateDrop(item, now - next);
  }

  #onDelete(item) {
    if (!tracked(item) || !this.#store.isRecording) return;
    this.#candidateDrop(item, Math.max(1, item.system?.quantity ?? 1));
  }

  #candidateDrop(item, count) {
    // A use just reported for this item already explains it.
    if (Date.now() - (this.#recentUses.get(item.id) ?? 0) < PAIR_WINDOW_MS) return;
    const raw = { ...describe(item), count };
    const timer = setTimeout(() => {
      this.#pending.delete(item.id);
      this.#store.recordEvent(EVENT_TYPE.DROP, raw);
    }, PAIR_WINDOW_MS);
    this.#pending.set(item.id, { timer, raw });
  }
}

function tracked(item) {
  if (!item || item.type !== "consumable") return false;
  if (!(item.parent instanceof Actor)) return false;
  return item.system?.type?.value !== "ammo";
}

function describe(item) {
  return {
    actorUuid: resolveAttributedActor(item.parent).uuid,
    itemName: item.name,
    subtype: item.system?.type?.value ?? ""
  };
}
