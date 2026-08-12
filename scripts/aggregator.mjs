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
    if (e.e !== EVENT_TYPE.HP) continue;

    // Damage taken / healing received / downed always attribute to the target, regardless
    // of whether the source ever got resolved - "damage-taken is always accurate."
    const targetIdentity = data.actors[e.g];
    if (targetIdentity && !(targetIdentity.t === "npc" && !showNPCs)) {
      const g = getCombatGroup(groups, e.g, targetIdentity);
      g.dmgTaken += e.dmg ?? 0;
      g.healRecv += e.heal ?? 0;
      if (e.dn) g.downed += 1;
    }

    // Damage dealt / healing given / temp HP given attribute to the source, when resolved.
    // Manual-adjustment resolutions credit no one; pvp-flagged damage (including self and
    // friendly fire) is excluded from the dealer's total but was already counted above.
    if (e.s && e.s !== MANUAL_SOURCE) {
      const sourceIdentity = data.actors[e.s];
      if (sourceIdentity && !(sourceIdentity.t === "npc" && !showNPCs)) {
        const g = getCombatGroup(groups, e.s, sourceIdentity);
        if (!e.pvp) g.dmgDealt += e.dmg ?? 0;
        g.healGiven += e.heal ?? 0;
        g.thpGiven += e.thp ?? 0;
      }
    }
  }

  const rows = [...groups.values()].map((g) => ({
    name: g.name,
    isPC: g.isPC,
    dmgDealt: g.dmgDealt,
    dmgTaken: g.dmgTaken,
    healGiven: g.healGiven,
    healRecv: g.healRecv,
    thpGiven: g.thpGiven,
    downed: g.downed
  }));

  return sortTable(rows, "dmgDealt", "desc");
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
      dmgTaken: 0,
      healGiven: 0,
      healRecv: 0,
      thpGiven: 0,
      downed: 0
    };
    groups.set(key, g);
  }
  return g;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
