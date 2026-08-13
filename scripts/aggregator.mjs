import { EVENT_TYPE, ROLL_CATEGORY, MANUAL_SOURCE } from "./constants.mjs";

/**
 * Pure functions: raw session events in, table rows out. Nothing here reads game state or
 * mutates anything, so report-app.mjs and csv-export.mjs can both call these directly.
 *
 * Row identity: PCs are keyed by actor UUID (so a mid-session rename doesn't split a row -
 * the latest name is just re-read from data.actors each time). NPCs are keyed by name, so
 * six unlinked goblins - each technically a distinct actor UUID - collapse into one row.
 */

export function buildRollTable(data, category, { showNPCs = false, excludeTags = [] } = {}) {
  const groups = new Map();

  for (const e of data.events) {
    if (e.e !== EVENT_TYPE.ROLL || e.c !== category) continue;
    if (excludeTags.length && excludeTags.includes(e.x)) continue;

    const identity = data.actors[e.a];
    if (!identity || (identity.t === "npc" && !showNPCs)) continue;

    const group = getRollGroup(groups, e.a, identity);
    for (const face of e.d) group.allFaces.push(face);
    const keptFace = e.d[e.k];
    group.keptFaces.push(keptFace);
    if (keptFace === 20) group.nat20++;
    if (keptFace === 1) group.nat1++;
    if (e.p === true) group.passes++;
    else if (e.p === false) group.fails++;
  }

  const rows = [...groups.values()].map((g) => {
    const resolved = g.passes + g.fails;
    return {
      name: g.name,
      isPC: g.isPC,
      rolls: g.keptFaces.length,
      meanKept: mean(g.keptFaces),
      meanAll: mean(g.allFaces),
      nat20: g.nat20,
      nat1: g.nat1,
      passes: g.passes,
      fails: g.fails,
      passRate: resolved ? g.passes / resolved : null
    };
  });

  return sortTable(rows, "meanKept", "desc");
}

export function buildInitiativeTable(data, { showNPCs = false } = {}) {
  const groups = new Map();

  for (const e of data.events) {
    if (e.e !== EVENT_TYPE.ROLL || e.c !== ROLL_CATEGORY.INITIATIVE) continue;

    const identity = data.actors[e.a];
    if (!identity || (identity.t === "npc" && !showNPCs)) continue;

    const group = getRollGroup(groups, e.a, identity);
    const keptFace = e.d[e.k];
    group.keptFaces.push(keptFace);
    if (keptFace === 20) group.nat20++;
    if (keptFace === 1) group.nat1++;
  }

  const rows = [...groups.values()].map((g) => ({
    name: g.name,
    isPC: g.isPC,
    rolls: g.keptFaces.length,
    mean: mean(g.keptFaces),
    nat20: g.nat20,
    nat1: g.nat1
  }));

  return sortTable(rows, "mean", "desc");
}

export function buildCombatTable(data, { showNPCs = false } = {}) {
  const groups = new Map();

  for (const e of data.events) {
    // Attacks avoided belong to whoever was shot at, so they need no source at all.
    if (e.e === EVENT_TYPE.MISS) {
      const identity = data.actors[e.g];
      if (identity && !(identity.t === "npc" && !showNPCs)) {
        getCombatGroup(groups, e.g, identity).avoided += 1;
      }
      continue;
    }

    if (e.e !== EVENT_TYPE.HP) continue;

    // Voided by the GM as a bookkeeping correction: contributes to nothing at all, not
    // even damage taken or the downed count.
    if (e.ig) continue;

    // Damage taken / healing received / downed always attribute to the target, regardless
    // of whether the source ever got resolved - "damage-taken is always accurate."
    const targetIdentity = data.actors[e.g];
    if (targetIdentity && !(targetIdentity.t === "npc" && !showNPCs)) {
      const g = getCombatGroup(groups, e.g, targetIdentity);
      g.dmgTaken += e.dmg ?? 0;
      g.healRecv += e.heal ?? 0;
      if (e.dn) g.downed += 1;
      // One event is one blow against one creature, so an AoE hitting three targets is
      // three separate blows rather than a single large one.
      g.maxTaken = Math.max(g.maxTaken, e.dmg ?? 0);
    }

    // Damage dealt / healing given / temp HP given attribute to the source, when resolved.
    // Manual-adjustment resolutions credit no one; pvp-flagged damage (including self and
    // friendly fire) is excluded from the dealer's total but was already counted above.
    if (e.s && e.s !== MANUAL_SOURCE) {
      const sourceIdentity = data.actors[e.s];
      if (sourceIdentity && !(sourceIdentity.t === "npc" && !showNPCs)) {
        const g = getCombatGroup(groups, e.s, sourceIdentity);
        if (!e.pvp) {
          g.dmgDealt += e.dmg ?? 0;
          // Follows damage-dealt: friendly fire is excluded, so a big hit on an ally
          // doesn't become someone's best blow of the night.
          g.maxDealt = Math.max(g.maxDealt, e.dmg ?? 0);
        }
        g.healGiven += e.heal ?? 0;
        g.thpGiven += e.thp ?? 0;
        // The same `dn` flag that counts as "downed" for the victim counts as a kill for
        // whoever landed it. Friendly fire is excluded, matching damage-dealt: dropping an
        // ally shouldn't read as a kill.
        if (e.dn && !e.pvp) g.kills += 1;
      }
    }
  }

  const rows = [...groups.values()].map((g) => ({
    name: g.name,
    isPC: g.isPC,
    dmgDealt: g.dmgDealt,
    maxDealt: g.maxDealt,
    dmgTaken: g.dmgTaken,
    maxTaken: g.maxTaken,
    healGiven: g.healGiven,
    healRecv: g.healRecv,
    thpGiven: g.thpGiven,
    downed: g.downed,
    kills: g.kills,
    avoided: g.avoided
  }));

  return sortTable(rows, "dmgDealt", "desc");
}

/**
 * Party-wide totals across the roster PCs only, for the Combat tab footer. NPC rows are
 * excluded whether or not they're currently shown - "the party" means the PCs.
 *
 * The two "biggest single blow" columns take the maximum rather than the sum: the party's
 * best hit is its best member's hit, not the sum of everyone's bests.
 */
export function buildPartyTotals(rows) {
  const pcs = rows.filter((r) => r.isPC);
  if (!pcs.length) return null;

  const sum = (key) => pcs.reduce((total, r) => total + (r[key] ?? 0), 0);
  const max = (key) => pcs.reduce((best, r) => Math.max(best, r[key] ?? 0), 0);

  return {
    name: "Party Total",
    dmgDealt: sum("dmgDealt"),
    maxDealt: max("maxDealt"),
    dmgTaken: sum("dmgTaken"),
    maxTaken: max("maxTaken"),
    healGiven: sum("healGiven"),
    healRecv: sum("healRecv"),
    thpGiven: sum("thpGiven"),
    downed: sum("downed"),
    kills: sum("kills"),
    avoided: sum("avoided")
  };
}

export function sortTable(rows, key, dir = "desc") {
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (typeof av === "string") return sign * av.localeCompare(bv);
    return sign * ((av ?? -Infinity) - (bv ?? -Infinity));
  });
}

function getRollGroup(groups, uuid, identity) {
  const key = identity.t === "pc" ? uuid : `npc:${identity.n}`;
  let g = groups.get(key);
  if (!g) {
    g = { name: identity.n, isPC: identity.t === "pc", allFaces: [], keptFaces: [], nat20: 0, nat1: 0, passes: 0, fails: 0 };
    groups.set(key, g);
  }
  return g;
}

function getCombatGroup(groups, uuid, identity) {
  const key = identity.t === "pc" ? uuid : `npc:${identity.n}`;
  let g = groups.get(key);
  if (!g) {
    g = {
      name: identity.n,
      isPC: identity.t === "pc",
      dmgDealt: 0,
      maxDealt: 0,
      dmgTaken: 0,
      maxTaken: 0,
      healGiven: 0,
      healRecv: 0,
      thpGiven: 0,
      downed: 0,
      kills: 0,
      avoided: 0
    };
    groups.set(key, g);
  }
  return g;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
