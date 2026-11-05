import { MODULE_ID, ROLL_CATEGORY } from "./constants.mjs";
import {
  buildRollTable,
  buildInitiativeTable,
  buildCombatTable,
  buildRoster,
  buildFightSummaries
} from "./aggregator.mjs";

/**
 * The session as a list of tables - { key, title, header, rows } - shared by the CSV export
 * (one stacked block per table) and the upload (one spreadsheet tab per table), so the two
 * can never disagree about a column.
 *
 * Every stat row carries its character's identity columns (player, level, class, CR...)
 * itself rather than leaving them to be looked up in the Party table. That is deliberate:
 * a row that stands on its own can be filtered or pivoted across hundreds of sessions
 * without joining anything.
 *
 * The blocks that existed before 0.6 keep their original columns first, in their original
 * order, with new ones appended, so anything already reading the CSV keeps working.
 */
export function buildExportTables(store, attribution) {
  const data = store.data;
  if (!data) return [];

  const roster = byKey(buildRoster(data));
  const fightSummaries = buildFightSummaries(data);

  return [
    sessionTable(store, attribution),
    partyTable(roster),
    fightsTable(fightSummaries),
    perFightTable(data, fightSummaries),
    combatTotalsTable(data, roster),
    rollTable("attacks", "ATTACK ROLLS", data, ROLL_CATEGORY.ATTACK, roster),
    // Death saves and concentration are included, undifferentiated, as before.
    rollTable("saves", "SAVING THROWS", data, ROLL_CATEGORY.SAVE, roster),
    rollTable("checks", "ABILITY CHECKS", data, ROLL_CATEGORY.CHECK, roster),
    initiativeTable(data, roster)
  ];
}

// --- Identity columns --------------------------------------------------------

const IDENTITY_HEADER = ["type", "player", "level", "primary_class", "subclass", "classes", "cr", "count", "ac"];

function identityCells(entry) {
  if (!entry) return IDENTITY_HEADER.map(() => "");
  return [
    entry.isPC ? "PC" : "NPC",
    entry.player,
    entry.level ?? "",
    entry.primaryClass,
    entry.subclass,
    entry.classes,
    entry.crLabel,
    entry.count,
    entry.acLabel
  ];
}

// --- Tables -------------------------------------------------------------------

function sessionTable(store, attribution) {
  const data = store.data;
  const meta = data.meta;
  return {
    key: "session",
    title: "SESSION INFO",
    header: [
      "session", "date", "duration", "combats", "events_logged", "unresolved_attributions",
      "session_id", "world", "gm", "rules_version", "dnd5e_version", "module_version", "start_time"
    ],
    rows: [[
      meta.name,
      new Date(meta.start * 1000).toISOString().slice(0, 10),
      Math.round(store.elapsedSeconds / 60),
      store.combatCount,
      store.eventCount,
      attribution.count,
      meta.id ?? "",
      game.world.title,
      game.user.name,
      rulesVersion(),
      game.system.version,
      game.modules.get(MODULE_ID)?.version ?? "",
      new Date(meta.start * 1000).toISOString()
    ]]
  };
}

function partyTable(roster) {
  return {
    key: "party",
    title: "PARTY",
    header: ["character", ...IDENTITY_HEADER],
    rows: pcsFirst([...roster.values()]).map((r) => [r.name, ...identityCells(r)])
  };
}

function fightsTable(summaries) {
  return {
    key: "fights",
    title: "FIGHTS",
    header: ["fight", "rounds", "minutes", "party_size", "avg_party_level", "foes", "foe_cr_total", "foe_xp_total", "foe_list"],
    rows: summaries.map((f) => [
      f.number, f.rounds, f.minutes, f.partySize, round(f.avgPartyLevel, 1), f.foes, f.foeCR, f.foeXP, f.foeList
    ])
  };
}

/**
 * One row per character per fight - the table built for analysis across sessions. Each row
 * repeats its fight's context (rounds, party size and level, the enemy side) so damage can
 * be compared fight against comparable fight.
 */
function perFightTable(data, summaries) {
  const rows = [];
  for (const fight of summaries) {
    const roster = byKey(buildRoster(data, { fight: fight.index }));
    const stats = pcsFirst(buildCombatTable(data, { showNPCs: true, fight: fight.index }));
    for (const r of stats) {
      rows.push([
        fight.number, r.name, ...identityCells(roster.get(r.key)),
        fight.rounds, r.dmgDealt, round(r.dpr, 1), r.maxDealt, r.dmgTaken, r.maxTaken,
        r.healGiven, r.healRecv, r.thpGiven, r.attacked, r.avoided, r.downed, r.kills,
        fight.partySize, round(fight.avgPartyLevel, 1), fight.foes, fight.foeCR, fight.foeXP
      ]);
    }
  }
  return {
    key: "perFight",
    title: "PER FIGHT",
    header: [
      "fight", "character", ...IDENTITY_HEADER,
      "rounds", "dmg_dealt", "dmg_per_round", "max_dealt", "dmg_taken", "max_taken",
      "heal_given", "heal_recv", "temp_hp_given", "attacks_received", "attacks_avoided", "downed", "kills",
      "party_size", "avg_party_level", "foes", "foe_cr_total", "foe_xp_total"
    ],
    rows
  };
}

function combatTotalsTable(data, roster) {
  return {
    key: "combat",
    title: "COMBAT TOTALS",
    header: [
      "character", "dmg_dealt", "dmg_taken", "heal_given", "heal_recv", "temp_hp_given", "downed",
      "kills", "attacks_avoided", "max_dealt", "max_taken",
      "attacks_received", "rounds", "dmg_per_round", ...IDENTITY_HEADER
    ],
    rows: pcsFirst(buildCombatTable(data, { showNPCs: true })).map((r) => [
      r.name, r.dmgDealt, r.dmgTaken, r.healGiven, r.healRecv, r.thpGiven, r.downed,
      r.kills, r.avoided, r.maxDealt, r.maxTaken,
      r.attacked, r.rounds, round(r.dpr, 1), ...identityCells(roster.get(r.key))
    ])
  };
}

function rollTable(key, title, data, category, roster) {
  return {
    key,
    title,
    header: ["character", "rolls", "mean_kept", "mean_all", "nat20", "nat1", "passes", "fails", "pass_rate", ...IDENTITY_HEADER],
    rows: pcsFirst(buildRollTable(data, category, { showNPCs: true })).map((r) => [
      r.name, r.rolls, round(r.meanKept, 1), round(r.meanAll, 1), r.nat20, r.nat1, r.passes, r.fails,
      round(r.passRate, 2), ...identityCells(roster.get(r.key))
    ])
  };
}

function initiativeTable(data, roster) {
  return {
    key: "initiative",
    title: "INITIATIVE",
    header: ["character", "rolls", "mean", "nat20", "nat1", ...IDENTITY_HEADER],
    rows: pcsFirst(buildInitiativeTable(data, { showNPCs: true })).map((r) => [
      r.name, r.rolls, round(r.mean, 1), r.nat20, r.nat1, ...identityCells(roster.get(r.key))
    ])
  };
}

// --- Helpers ------------------------------------------------------------------

// Tables arrive sorted meaningfully (damage or mean descending); PCs go first without
// disturbing that order.
const pcsFirst = (rows) => [...rows.filter((r) => r.isPC), ...rows.filter((r) => !r.isPC)];

const byKey = (rows) => new Map(rows.map((r) => [r.key, r]));

/** A number rounded for display, or "" for a value that doesn't exist. */
function round(value, places) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return Number(value.toFixed(places));
}

/** "modern" (2024 rules) or "legacy" (2014). Matters when comparing classes across tables. */
function rulesVersion() {
  try {
    return game.settings.get("dnd5e", "rulesVersion") ?? "";
  } catch {
    return "";
  }
}
