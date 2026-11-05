import { EVENT_TYPE, ROLL_CATEGORY, MANUAL_SOURCE } from "./constants.mjs";
import { formatCR } from "./actor-info.mjs";

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
      key: g.key,
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
    key: g.key,
    name: g.name,
    isPC: g.isPC,
    rolls: g.keptFaces.length,
    mean: mean(g.keptFaces),
    nat20: g.nat20,
    nat1: g.nat1
  }));

  return sortTable(rows, "mean", "desc");
}

/**
 * @param {object} [options]
 * @param {number|null} [options.fight]  Index into meta.fights to limit the table to one
 *   fight; null for the whole session.
 */
export function buildCombatTable(data, { showNPCs = false, fight = null } = {}) {
  const groups = new Map();
  const fights = data.meta.fights ?? [];
  const visible = (identity) => identity && !(identity.t === "npc" && !showNPCs);

  // Everyone who was in a fight gets a row, even with nothing to show for it. A PC who
  // spent the fight unconscious is a real zero, and dropping them would inflate averages.
  const scope = fight === null ? fights.map((_, i) => i) : [fight];
  for (const i of scope) {
    for (const uuid of Object.keys(fights[i]?.c ?? {})) {
      const identity = data.actors[uuid];
      if (visible(identity)) getCombatGroup(groups, uuid, identity).fights.add(i);
    }
  }

  // Marks a group as present in the event's fight, for its rounds-fought total.
  const touch = (g, e) => {
    if (e.f !== undefined) g.fights.add(e.f);
    return g;
  };

  for (const e of data.events) {
    if (fight !== null && e.f !== fight) continue;

    // Attacks received and avoided belong to whoever was shot at, so need no source.
    if (e.e === EVENT_TYPE.MISS || e.e === EVENT_TYPE.HIT) {
      const identity = data.actors[e.g];
      if (visible(identity)) {
        const g = touch(getCombatGroup(groups, e.g, identity), e);
        g.attacked += 1;
        if (e.e === EVENT_TYPE.MISS) g.avoided += 1;
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
    if (visible(targetIdentity)) {
      const g = touch(getCombatGroup(groups, e.g, targetIdentity), e);
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
      if (visible(sourceIdentity)) {
        const g = touch(getCombatGroup(groups, e.s, sourceIdentity), e);
        if (!e.pvp) {
          g.dmgDealt += e.dmg ?? 0;
          // Damage per round only counts damage inside fights, over rounds of those fights.
          if (e.f !== undefined) g.fightDmg += e.dmg ?? 0;
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

  const rows = [...groups.values()].map((g) => {
    const rounds = [...g.fights].reduce((total, i) => total + (fights[i]?.r ?? 0), 0);
    return {
      key: g.key,
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
      attacked: g.attacked,
      avoided: g.avoided,
      fightDmg: g.fightDmg,
      rounds,
      dpr: rounds ? g.fightDmg / rounds : null
    };
  });

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
    attacked: sum("attacked"),
    avoided: sum("avoided"),
    // The party's output per round is each member's per-round output added together.
    dpr: pcs.some((r) => r.dpr !== null) ? sum("dpr") : null
  };
}

/**
 * Everyone who took part: one row per PC, and one per NPC name with how many of that name
 * there were, so fifteen zombies are "Zombie, 15". Rows carry the same `key` as the stat
 * tables, so any stat row can be joined to its class, level or CR.
 *
 * @param {object} [options]
 * @param {number|null} [options.fight]  Only those present in this fight: its combatants,
 *   plus anyone involved in one of its events.
 */
export function buildRoster(data, { showNPCs = true, fight = null } = {}) {
  let present = null;
  if (fight !== null) {
    present = new Set(Object.keys(data.meta.fights?.[fight]?.c ?? {}));
    for (const e of data.events) {
      if (e.f !== fight) continue;
      for (const uuid of [e.a, e.g, e.s]) if (uuid) present.add(uuid);
    }
  }

  const entries = new Map();
  const add = (uuid, identity) => {
    if (present && !present.has(uuid)) return;
    if (identity.t === "npc" && !showNPCs) return;
    const key = identity.t === "pc" ? uuid : `npc:${identity.n}`;
    let r = entries.get(key);
    if (!r) {
      r = { key, name: identity.n, isPC: identity.t === "pc", uuids: new Set(), crs: [], acs: [], identity };
      entries.set(key, r);
    }
    r.uuids.add(uuid);
    if (Number.isFinite(identity.cr)) r.crs.push(identity.cr);
    if (Number.isFinite(identity.ac)) r.acs.push(identity.ac);
  };

  for (const [uuid, identity] of Object.entries(data.actors)) add(uuid, identity);
  // Sessions from before 0.6 only remember idle combatants by name; still worth counting.
  for (const [uuid, name] of Object.entries(data.meta.npcSeen ?? {})) {
    if (!data.actors[uuid]) add(uuid, { n: name, t: "npc" });
  }

  const rows = [...entries.values()].map((r) => {
    const classes = r.isPC ? r.identity.cls ?? [] : [];
    return {
      key: r.key,
      name: r.name,
      isPC: r.isPC,
      player: r.isPC ? r.identity.pl ?? "" : "",
      level: r.isPC ? r.identity.lv ?? null : null,
      primaryClass: classes[0]?.n ?? "",
      subclass: classes[0]?.s ?? "",
      classes: classes.map((c) => `${c.n} ${c.l}`).join(" / "),
      cr: r.crs.length ? Math.min(...r.crs) : null,
      crLabel: rangeLabel(r.crs, formatCR),
      xp: r.isPC ? null : r.identity.xp ?? null,
      count: r.uuids.size,
      ac: r.acs.length ? Math.min(...r.acs) : null,
      acLabel: rangeLabel(r.acs, String)
    };
  });

  return sortTable(rows, "name", "asc");
}

/**
 * One summary per fight: how long it ran, who was in it, and what the party was up
 * against. The enemy side is what makes fights comparable - "the rogue did the most
 * damage" means little if all of the rogue's fights were easy.
 */
export function buildFightSummaries(data) {
  const fights = data.meta.fights ?? [];
  return fights.map((f, index) => {
    const pcs = buildRoster(data, { fight: index }).filter((r) => r.isPC);
    const levels = pcs.map((r) => r.level).filter(Number.isFinite);

    const foes = Object.entries(f.c ?? {})
      .filter(([, hostile]) => hostile)
      .map(([uuid]) => data.actors[uuid])
      .filter(Boolean);
    const foeCounts = new Map();
    for (const foe of foes) foeCounts.set(foe.n, (foeCounts.get(foe.n) ?? 0) + 1);

    const end = f.e ?? f.last;
    return {
      index,
      number: index + 1,
      rounds: f.r,
      minutes: Math.round(Math.max(0, end - f.s) / 60),
      partySize: pcs.length,
      avgPartyLevel: levels.length ? mean(levels) : null,
      foes: foes.length,
      foeCR: foes.reduce((total, foe) => total + (foe.cr ?? 0), 0),
      foeXP: foes.reduce((total, foe) => total + (foe.xp ?? 0), 0),
      foeList: [...foeCounts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ")
    };
  });
}

/** "2" when every value agrees, "1–3" when they differ, "" when there are none. */
function rangeLabel(values, format) {
  if (!values.length) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? format(lo) : `${format(lo)}–${format(hi)}`;
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
    g = { key, name: identity.n, isPC: identity.t === "pc", allFaces: [], keptFaces: [], nat20: 0, nat1: 0, passes: 0, fails: 0 };
    groups.set(key, g);
  }
  return g;
}

function getCombatGroup(groups, uuid, identity) {
  const key = identity.t === "pc" ? uuid : `npc:${identity.n}`;
  let g = groups.get(key);
  if (!g) {
    g = {
      key,
      name: identity.n,
      isPC: identity.t === "pc",
      fights: new Set(), // indexes of the fights this row took part in
      fightDmg: 0,
      attacked: 0,
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
