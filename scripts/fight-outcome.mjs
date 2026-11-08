import { EVENT_TYPE, MANUAL_SOURCE } from "./constants.mjs";

/**
 * The module's own guess at how a fight ended, made the moment the GM ends the combat. It is
 * the same rule the website uses (FightAnalysis.cs on the Champions Guild site), and it only
 * decides one thing: whether to ask the GM. When the rule can't tell, a small dialog asks
 * (see outcome-prompt.mjs); when it can, nobody is bothered.
 *
 * Pure apart from `liveHp`, so it can be tested outside Foundry.
 *
 * @param {object} session      The session data (meta, actors, events).
 * @param {number} index        Index of the fight in meta.fights.
 * @param {(uuid: string) => number[]|null} liveHp  [hp, max] as the combatant stands now, or
 *   null when the token is gone. Foes taken off the map use the HP they were removed at.
 * @returns {{ outcome: "won"|"broke"|"retreat"|"wipe"|"unclear", skip: string|null, foes: string[] }}
 *   `skip` = not a fight worth judging (the website leaves it out too), so never ask about it.
 */
export function guessOutcome(session, index, liveHp) {
  const fight = session.meta.fights[index];
  const actors = session.actors ?? {};
  const events = session.events.filter((e) => e.f === index);
  const isPc = (u) => actors[u]?.t === "pc";

  const hostile = Object.entries(fight.c ?? {})
    .filter(([u, h]) => h && actors[u])
    .map(([u]) => u);
  const pcs = new Set(Object.keys(fight.c ?? {}).filter(isPc));
  for (const e of events) for (const u of [e.a, e.g, e.s, e.by]) if (u && isPc(u)) pcs.add(u);

  const acted = new Set();
  const targeted = new Set();
  const downed = new Set();
  let anyDamage = false;
  let anyAttack = false;
  for (const e of events) {
    if (e.e === EVENT_TYPE.ROLL && e.a) acted.add(e.a);
    if (e.e === EVENT_TYPE.HIT || e.e === EVENT_TYPE.MISS) {
      anyAttack = true;
      if (e.by) acted.add(e.by);
      if (e.g) targeted.add(e.g);
    }
    if (e.e === EVENT_TYPE.HP && e.g) {
      targeted.add(e.g);
      if ((e.dmg ?? 0) > 0) anyDamage = true;
      if (e.s && e.s !== MANUAL_SOURCE) acted.add(e.s);
      if (e.dn && !e.alt) downed.add(e.g);
    }
  }

  /** { hp, max, removed, removedHp } or null when nothing is known. */
  const body = (u) => {
    const removal = events.find((e) => e.e === EVENT_TYPE.REMOVED && e.g === u);
    if (removal) {
      const hp = Array.isArray(removal.hp) ? removal.hp : lastHp(u);
      return { removed: true, hp: hp?.[0] ?? null, max: hp?.[1] ?? 0 };
    }
    const live = liveHp(u) ?? lastHp(u);
    return live ? { removed: false, hp: live[0], max: live[1] ?? 0 } : null;
  };
  // Like the website: HP follows the latest change, max HP the latest change that carried one,
  // else what they joined with.
  const lastHp = (u) => {
    const joined = fight.hp?.[u];
    let hp = null;
    let max = null;
    for (let i = events.length - 1; i >= 0 && (hp === null || max === null); i--) {
      const e = events[i];
      if (e.e !== EVENT_TYPE.HP || e.g !== u || e.alt) continue;
      if (hp === null && Number.isFinite(e.h)) hp = e.h;
      if (max === null && Number.isFinite(e.mx) && e.mx > 0) max = e.mx;
    }
    if (hp === null) return joined ? [joined[0], joined[1]] : null;
    return [hp, max ?? joined?.[1] ?? 0];
  };
  const stateOf = (u) => {
    const b = body(u);
    if (!b) return "unknown";
    const known = Number.isFinite(b.hp);
    if (downed.has(u) || (known && b.hp <= 0)) return "down";
    if (b.removed) return known && b.max > 0 && b.hp >= b.max ? "removedUnhurt" : "removedHurt";
    if (!known || b.max <= 0) return "unknown";
    return b.hp <= b.max / 2 ? "bloodied" : "healthy";
  };

  // Foes taken off unharmed that never did anything and were never touched: added by mistake.
  const states = [];
  const foes = [];
  for (const u of hostile) {
    const state = stateOf(u);
    if (state === "removedUnhurt" && !acted.has(u) && !targeted.has(u)) continue;
    states.push(state);
    foes.push(actors[u]?.n ?? "");
  }

  let skip = null;
  if ((fight.r ?? 0) <= 1 && !anyDamage && !anyAttack) skip = "no fighting";
  else if (pcs.size === 0) skip = "no party";
  else if (states.length === 0) skip = "no enemies";

  const party = [...pcs].map((u) => liveHp(u) ?? lastHp(u)).filter((hp) => hp && Number.isFinite(hp[0]));
  let hp = 0;
  let max = 0;
  for (const p of party) {
    hp += Math.max(0, p[0]);
    max += p[1] ?? 0;
  }
  const endShare = party.length && max > 0 ? hp / max : party.length ? 1 : null;
  const wipe = party.length > 0 && party.every((p) => p[0] <= 0);
  const standing = party.filter((p) => p[0] > 0).length;

  const count = (...names) => states.filter((s) => names.includes(s)).length;
  const beaten = count("down", "removedHurt");
  const healthy = count("healthy", "removedUnhurt");
  const bloodied = count("bloodied");

  let outcome = "unclear";
  if (wipe) outcome = "wipe";
  else if (states.length && beaten === states.length) outcome = "won";
  else if (states.length && beaten * 2 >= states.length && beaten + bloodied === states.length && (party.length === 0 || standing * 2 >= party.length))
    outcome = "broke";
  else if (states.length && healthy * 2 > states.length && endShare !== null && endShare < 0.5) outcome = "retreat";

  return { outcome, skip, foes: [...new Set(foes.filter(Boolean))] };
}
