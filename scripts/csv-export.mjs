import { buildExportTables } from "./export-tables.mjs";

function csvEscape(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(values) {
  return values.map(csvEscape).join(",") + "\r\n";
}

/** One stacked file: a `=== TITLE ===` line, a header row and the rows, per table. */
export function buildSessionCSV(store, attribution) {
  const tables = buildExportTables(store, attribution);
  return tables
    .map((table) => `=== ${table.title} ===\r\n` + csvRow(table.header) + table.rows.map(csvRow).join(""))
    .join("\r\n");
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
