import { ROLL_CATEGORY } from "./constants.mjs";
import { buildRollTable, buildInitiativeTable, buildCombatTable } from "./aggregator.mjs";

function csvEscape(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(values) {
  return values.map(csvEscape).join(",") + "\r\n";
}

const formatMean = (v) => v.toFixed(1);
const formatPassRate = (v) => (v === null || v === undefined ? "" : v.toFixed(2));

// Every table is already sorted meaningfully (mean/damage descending); the CSV format wants
// PCs before NPCs within each block, so partition without disturbing that order.
const pcsFirst = (rows) => [...rows.filter((r) => r.isPC), ...rows.filter((r) => !r.isPC)];

export function buildSessionCSV(store, attribution) {
  const data = store.data;
  if (!data) return "";

  let csv = "";

  csv += "=== SESSION INFO ===\r\n";
  csv += csvRow(["session", "date", "duration", "combats", "events_logged", "unresolved_attributions"]);
  const durationMinutes = Math.round(store.elapsedSeconds / 60);
  const dateStr = new Date(data.meta.start * 1000).toISOString().slice(0, 10);
  csv += csvRow([data.meta.name, dateStr, durationMinutes, store.combatCount, store.eventCount, attribution.count]);
  csv += "\r\n";

  const rollBlock = (title, category) => {
    csv += `=== ${title} ===\r\n`;
    csv += csvRow(["character", "rolls", "mean_kept", "mean_all", "nat20", "nat1", "passes", "fails", "pass_rate"]);
    for (const r of pcsFirst(buildRollTable(data, category, { showNPCs: true }))) {
      csv += csvRow([r.name, r.rolls, formatMean(r.meanKept), formatMean(r.meanAll), r.nat20, r.nat1, r.passes, r.fails, formatPassRate(r.passRate)]);
    }
    csv += "\r\n";
  };

  rollBlock("ATTACK ROLLS", ROLL_CATEGORY.ATTACK);
  rollBlock("SAVING THROWS", ROLL_CATEGORY.SAVE); // death saves & concentration included, undifferentiated
  rollBlock("ABILITY CHECKS", ROLL_CATEGORY.CHECK);

  csv += "=== INITIATIVE ===\r\n";
  csv += csvRow(["character", "rolls", "mean", "nat20", "nat1"]);
  for (const r of pcsFirst(buildInitiativeTable(data, { showNPCs: true }))) {
    csv += csvRow([r.name, r.rolls, formatMean(r.mean), r.nat20, r.nat1]);
  }
  csv += "\r\n";

  csv += "=== COMBAT TOTALS ===\r\n";
  // kills / attacks_avoided are appended after the columns the brief specified, so the
  // original column order stays stable for anything already parsing this export.
  csv += csvRow([
    "character", "dmg_dealt", "dmg_taken", "heal_given", "heal_recv", "temp_hp_given", "downed",
    "kills", "attacks_avoided"
  ]);
  for (const r of pcsFirst(buildCombatTable(data, { showNPCs: true }))) {
    csv += csvRow([r.name, r.dmgDealt, r.dmgTaken, r.healGiven, r.healRecv, r.thpGiven, r.downed, r.kills, r.avoided]);
  }

  return csv;
}

/** Builds the CSV, triggers a browser download, and marks the session exported. */
export async function exportSessionCSV(store, attribution) {
  const csv = buildSessionCSV(store, attribution);
  if (!csv) return false;

  const filename = `${(store.data.meta.name || "session").replace(/[^\w-]+/g, "_")}.csv`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  store.markExported();
  return true;
}
