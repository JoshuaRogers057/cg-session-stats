/**
 * Session Stats receiver - a Google Apps Script web app.
 *
 * Every Foundry world running Session Stats sends each finished session here. This files
 * it as its own spreadsheet in a "Session Stats" Drive folder, and appends it to one
 * master spreadsheet for analysis across every session and every GM.
 *
 * It runs as its owner, so nobody sending to it needs a Google account. Setup steps are in
 * README.md beside this file.
 */

const FOLDER_NAME = 'Session Stats';
const MASTER_NAME = 'Session Stats - All Sessions';

// Bounds on what one upload may contain. A real session is a few hundred rows at most;
// anything far beyond that is not from the module.
const MAX_BODY_CHARS = 2 * 1024 * 1024;
const MAX_TABLES = 20;
const MAX_ROWS = 5000;
const MAX_COLUMNS = 60;
const MAX_CELL_CHARS = 500;

const SESSIONS_HEADER = [
  'session_id', 'received', 'date', 'session', 'world', 'gm', 'rules_version',
  'duration', 'combats', 'module_version', 'sheet'
];

// Columns put in front of every row copied into the master, so each row says which session
// it came from.
const MASTER_PREFIX = ['session_id', 'date', 'world', 'gm', 'rules_version', 'session'];

// Tables copied into the master spreadsheet, by the module's table key.
const MASTER_TABLES = { perFight: 'Per Fight', combat: 'Session Totals' };

/** Run this once from the editor: it asks for Drive access and creates the folder. */
function setup() {
  const folder = getFolder_();
  const master = getMaster_();
  Logger.log('Folder: ' + folder.getUrl());
  Logger.log('Master spreadsheet: ' + master.getUrl());
}

/** Opening the web app URL in a browser shows this, which is a quick "is it up?" check. */
function doGet() {
  return json_({ ok: true, service: 'session-stats-receiver' });
}

function doPost(e) {
  let payload;
  try {
    const body = e && e.postData && e.postData.contents;
    if (!body) return json_({ ok: false, drop: true, error: 'empty request' });
    if (body.length > MAX_BODY_CHARS) return json_({ ok: false, drop: true, error: 'too large' });
    payload = JSON.parse(body);
  } catch (err) {
    return json_({ ok: false, drop: true, error: 'not JSON' });
  }

  // `drop` tells the module this upload will never be accepted, so it stops retrying it.
  const problem = validate_(payload);
  if (problem) return json_({ ok: false, drop: true, error: problem });

  // One upload at a time, so two GMs ending sessions together can't interleave rows in
  // the master or both file the same session.
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return json_({ ok: false, error: 'busy, try again' });
  }
  try {
    return json_(file_(payload));
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: String((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
}

// --- Filing ---------------------------------------------------------------------------

function file_(payload) {
  const master = getMaster_();
  const sessions = sheetWithHeader_(master, 'Sessions', SESSIONS_HEADER);

  // A retry after a reply that never reached the module: already filed, nothing to do.
  if (alreadyFiled_(sessions, payload.sessionId)) return { ok: true, duplicate: true };

  const info = firstRowAsObject_(payload, 'session');
  const name = [info.date, info.session, payload.world.title]
    .filter(function (part) { return part; })
    .join(' - ')
    .slice(0, 200);

  // The session's own spreadsheet: one tab per table, in the module's order.
  const spreadsheet = SpreadsheetApp.create(name);
  DriveApp.getFileById(spreadsheet.getId()).moveTo(getFolder_());
  const usedNames = {};
  payload.tables.forEach(function (table, i) {
    const tabName = uniqueTabName_(table.title, usedNames);
    const sheet = i === 0 ? spreadsheet.getSheets()[0].setName(tabName) : spreadsheet.insertSheet(tabName);
    writeTable_(sheet, table.header, table.rows);
  });

  // The master: each analysis table's rows with the session's identity in front.
  const prefix = [payload.sessionId, info.date, payload.world.title, info.gm, info.rules_version, info.session];
  Object.keys(MASTER_TABLES).forEach(function (key) {
    const table = findTable_(payload, key);
    if (!table || !table.rows.length) return;
    // A future change to the module's columns gets a tab of its own rather than
    // misaligning everything already filed under the old ones.
    const tabName = MASTER_TABLES[key] + (payload.schema > 1 ? ' v' + payload.schema : '');
    const sheet = sheetWithHeader_(master, tabName, MASTER_PREFIX.concat(table.header));
    appendRows_(sheet, table.rows.map(function (row) { return prefix.concat(row); }));
  });

  appendRows_(sessions, [[
    payload.sessionId, new Date(), info.date, info.session, payload.world.title, info.gm,
    info.rules_version, info.duration, info.combats, info.module_version, spreadsheet.getUrl()
  ]]);

  return { ok: true, url: spreadsheet.getUrl() };
}

function writeTable_(sheet, header, rows) {
  const width = Math.max(1, header.length);
  const values = [header].concat(rows).map(function (row) {
    const out = [];
    for (let i = 0; i < width; i++) out.push(cell_(row[i]));
    return out;
  });
  sheet.getRange(1, 1, values.length, width).setValues(values);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, width).setFontWeight('bold');
  sheet.autoResizeColumns(1, width);
}

function appendRows_(sheet, rows) {
  if (!rows.length) return;
  const width = sheet.getLastColumn();
  const values = rows.map(function (row) {
    const out = [];
    for (let i = 0; i < width; i++) out.push(cell_(row[i]));
    return out;
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, width).setValues(values);
}

/**
 * Numbers stay numbers so the sheet can sum and chart them. Text is capped, and text
 * starting with = + - @ is stored as text: a character named "=IMPORTXML(...)" must not
 * become a live formula in the owner's spreadsheet.
 */
function cell_(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return isFinite(value) ? value : '';
  if (value instanceof Date) return value;
  const text = String(value).slice(0, MAX_CELL_CHARS);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

// --- Validation -----------------------------------------------------------------------

/** Returns what is wrong with an upload, or '' if it looks like the module's. */
function validate_(p) {
  if (!p || typeof p !== 'object') return 'not an object';
  if (typeof p.schema !== 'number' || p.schema < 1) return 'unknown schema';
  if (typeof p.sessionId !== 'string' || !/^[A-Za-z0-9]{8,32}$/.test(p.sessionId)) return 'bad session id';
  if (!p.world || typeof p.world.title !== 'string') return 'missing world';
  if (!Array.isArray(p.tables) || !p.tables.length || p.tables.length > MAX_TABLES) return 'bad tables';

  for (let i = 0; i < p.tables.length; i++) {
    const t = p.tables[i];
    if (!t || typeof t.key !== 'string' || typeof t.title !== 'string') return 'bad table';
    if (!Array.isArray(t.header) || !t.header.length || t.header.length > MAX_COLUMNS) return 'bad header in ' + t.key;
    if (!Array.isArray(t.rows) || t.rows.length > MAX_ROWS) return 'bad rows in ' + t.key;
    for (let r = 0; r < t.rows.length; r++) {
      if (!Array.isArray(t.rows[r]) || t.rows[r].length > MAX_COLUMNS) return 'bad row in ' + t.key;
    }
  }

  const session = findTable_(p, 'session');
  if (!session || session.rows.length !== 1) return 'missing session info';
  return '';
}

// --- Drive and sheet helpers ----------------------------------------------------------

function getFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (err) {
      // Deleted or no longer reachable; make a new one below.
    }
  }
  const folder = DriveApp.createFolder(FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function getMaster_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('MASTER_ID');
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (err) {
      // Deleted or no longer reachable; make a new one below.
    }
  }
  const master = SpreadsheetApp.create(MASTER_NAME);
  DriveApp.getFileById(master.getId()).moveTo(getFolder_());
  master.getSheets()[0].setName('Sessions');
  props.setProperty('MASTER_ID', master.getId());
  return master;
}

/** The named tab, created with its header row if it doesn't exist yet. */
function sheetWithHeader_(spreadsheet, name, header) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function alreadyFiled_(sessions, sessionId) {
  const last = sessions.getLastRow();
  if (last < 2) return false;
  return !!sessions.getRange(2, 1, last - 1, 1).createTextFinder(sessionId).matchEntireCell(true).findNext();
}

function findTable_(payload, key) {
  for (let i = 0; i < payload.tables.length; i++) {
    if (payload.tables[i].key === key) return payload.tables[i];
  }
  return null;
}

/** The first row of a table as { column_name: value }. */
function firstRowAsObject_(payload, key) {
  const table = findTable_(payload, key);
  const out = {};
  if (!table || !table.rows.length) return out;
  table.header.forEach(function (name, i) {
    const value = table.rows[0][i];
    out[name] = value === null || value === undefined ? '' : value;
  });
  return out;
}

/** "PER FIGHT" -> "Per Fight", made safe for a tab name and unique within the sheet. */
function uniqueTabName_(title, used) {
  let base = String(title)
    .toLowerCase()
    .replace(/[\[\]*?:\/\\]/g, ' ')
    .replace(/\b\w/g, function (c) { return c.toUpperCase(); })
    .trim()
    .slice(0, 90) || 'Table';
  let name = base;
  for (let n = 2; used[name]; n++) name = base + ' ' + n;
  used[name] = true;
  return name;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
