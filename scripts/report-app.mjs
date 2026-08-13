import { MODULE_ID, MODULE_TITLE, ROLL_CATEGORY, ROLL_TAG, HOOK, MANUAL_SOURCE, NOT_TRACKED } from "./constants.mjs";
import { buildRollTable, buildInitiativeTable, buildCombatTable, buildPartyTotals, sortTable } from "./aggregator.mjs";
import { openEditRosterDialog } from "./roster-dialog.mjs";
import { exportSessionCSV } from "./csv-export.mjs";

const ROLL_COLUMNS = [
  { key: "name", label: "Character" },
  { key: "rolls", label: "Rolls" },
  { key: "meanKept", label: "Mean (kept)" },
  { key: "meanAll", label: "Mean (all)" },
  { key: "nat20", label: "Nat 20s" },
  { key: "nat1", label: "Nat 1s" },
  { key: "passes", label: "Passes" },
  { key: "fails", label: "Fails" },
  { key: "passRate", label: "Pass Rate" }
];

const INITIATIVE_COLUMNS = [
  { key: "name", label: "Character" },
  { key: "rolls", label: "Rolls" },
  { key: "mean", label: "Mean" },
  { key: "nat20", label: "Nat 20s" },
  { key: "nat1", label: "Nat 1s" }
];

const COMBAT_COLUMNS = [
  { key: "name", label: "Character" },
  { key: "dmgDealt", label: "Dmg Dealt" },
  { key: "maxDealt", label: "Max Dealt" },
  { key: "dmgTaken", label: "Dmg Taken" },
  { key: "maxTaken", label: "Max Taken" },
  { key: "healGiven", label: "Heal Given" },
  { key: "healRecv", label: "Heal Received" },
  { key: "thpGiven", label: "Temp HP Given" },
  { key: "downed", label: "Downed" },
  { key: "kills", label: "Kills" },
  { key: "avoided", label: "Attacks Avoided" }
];

const TAB_DEFS = [
  { id: "attacks", label: "Attacks", kind: "roll", category: ROLL_CATEGORY.ATTACK, columns: ROLL_COLUMNS, defaultSort: "meanKept" },
  { id: "saves", label: "Saves", kind: "roll", category: ROLL_CATEGORY.SAVE, columns: ROLL_COLUMNS, defaultSort: "meanKept", hasSpecialSavesToggle: true },
  { id: "checks", label: "Checks", kind: "roll", category: ROLL_CATEGORY.CHECK, columns: ROLL_COLUMNS, defaultSort: "meanKept" },
  { id: "initiative", label: "Initiative", kind: "initiative", columns: INITIATIVE_COLUMNS, defaultSort: "mean" },
  { id: "combat", label: "Combat", kind: "combat", columns: COMBAT_COLUMNS, defaultSort: "dmgDealt" }
];

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** A queue entry can carry several kinds of change at once, so describe each present one. */
function formatHPChange({ dmg, heal, thp }) {
  const parts = [];
  if (dmg) parts.push(`${dmg} damage`);
  if (heal) parts.push(`${heal} healing`);
  if (thp) parts.push(`${thp} temp HP`);
  return parts.join(", ") || "-";
}

function describeRoll(category, tag) {
  if (tag === ROLL_TAG.DEATH_SAVE) return "Death Save";
  if (tag === ROLL_TAG.CONCENTRATION) return "Concentration";
  if (category === ROLL_CATEGORY.ATTACK) return "Attack";
  if (category === ROLL_CATEGORY.SAVE) return "Saving Throw";
  return "Ability Check";
}

function formatCell(key, value) {
  if (value === null || value === undefined) return "";
  if (key === "meanKept" || key === "meanAll" || key === "mean") return value.toFixed(1);
  if (key === "passRate") return value.toFixed(2);
  return String(value);
}

const { ApplicationV2 } = foundry.applications.api;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class ReportApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "cgss-report",
    classes: ["cgss-report"],
    tag: "div",
    window: { title: MODULE_TITLE, icon: "fa-solid fa-chart-column", resizable: true },
    position: { width: 820, height: 640 }
  };

  static PARTS = {
    top: { template: `modules/${MODULE_ID}/templates/report-top.hbs` },
    main: { template: `modules/${MODULE_ID}/templates/report-main.hbs` }
  };

  #store;
  #attribution;
  #activeTab = "attacks";
  #showNPCs = false;
  #excludeSpecialSaves = false;
  #tables = {};
  #hasComputed = false;
  #sortState = {};
  #hookIds = [];
  #tickInterval = null;

  constructor(store, attribution, options = {}) {
    super(options);
    this.#store = store;
    this.#attribution = attribution;
  }

  async _prepareContext(options) {
    if (!this.#hasComputed) this.#recompute();
    const data = this.#store.data;
    const tab = TAB_DEFS.find((t) => t.id === this.#activeTab) ?? TAB_DEFS[0];
    const rawRows = this.#tables[tab.id] ?? [];

    const toDisplayRow = (r) => ({
      isPC: r.isPC,
      dangerNat1: (r.nat1 ?? 0) >= 3,
      cells: Object.fromEntries(tab.columns.map((c) => [c.key, formatCell(c.key, r[c.key])]))
    });

    // PCs and NPCs are kept apart rather than interleaved by score. Filtering preserves the
    // active sort order within each group, so column sorting still works as expected.
    const pcRows = rawRows.filter((r) => r.isPC).map(toDisplayRow);
    const npcRows = rawRows.filter((r) => !r.isPC).map(toDisplayRow);

    const rows = [...pcRows];
    if (npcRows.length) {
      rows.push({ divider: true, label: "NPCs" });
      rows.push(...npcRows);
    }

    // Party totals are Combat-tab only; summing roll means across characters would be
    // meaningless, and a mean-of-means is not the party's true mean.
    let totals = null;
    if (tab.kind === "combat") {
      const partyTotals = buildPartyTotals(rawRows);
      if (partyTotals) {
        totals = {
          cells: Object.fromEntries(tab.columns.map((c) => [c.key, formatCell(c.key, partyTotals[c.key])]))
        };
      }
    }

    return {
      hasSession: !!data,
      session: data
        ? {
            name: data.meta.name,
            elapsedLabel: formatDuration(this.#store.elapsedSeconds),
            combats: this.#store.combatCount,
            events: this.#store.eventCount,
            recording: this.#store.isRecording
          }
        : null,
      canExport: !!data && !this.#store.isRecording,
      // Unresolved entries are GM-only: they are the things not yet assigned, and the
      // controls that settle them would be meaningless (and unauthorised) for a player.
      isGM: game.user.isGM,
      queue: game.user.isGM ? this.#queueContext() : [],
      // Passed through rather than written into the template, so the sentinels cannot
      // drift from the values attribution.mjs compares against.
      manualSource: MANUAL_SOURCE,
      notTracked: NOT_TRACKED,
      rollQueue: game.user.isGM ? this.#rollQueueContext() : [],
      activeTab: tab.id,
      tabs: TAB_DEFS.map((t) => ({ id: t.id, label: t.label, active: t.id === tab.id })),
      showNPCs: this.#showNPCs,
      excludeSpecialSaves: this.#excludeSpecialSaves,
      showSpecialSavesToggle: !!tab.hasSpecialSavesToggle,
      columns: tab.columns,
      rows,
      totals
    };
  }

  #recompute() {
    const data = this.#store.data;
    this.#tables = {};
    this.#hasComputed = true;
    if (!data) return;

    for (const tab of TAB_DEFS) {
      let rows;
      if (tab.kind === "roll") {
        const excludeTags = tab.hasSpecialSavesToggle && this.#excludeSpecialSaves ? [ROLL_TAG.DEATH_SAVE, ROLL_TAG.CONCENTRATION] : [];
        rows = buildRollTable(data, tab.category, { showNPCs: this.#showNPCs, excludeTags });
      } else if (tab.kind === "initiative") {
        rows = buildInitiativeTable(data, { showNPCs: this.#showNPCs });
      } else {
        rows = buildCombatTable(data, { showNPCs: this.#showNPCs });
      }

      const sort = this.#sortState[tab.id];
      this.#tables[tab.id] = sort ? sortTable(rows, sort.key, sort.dir) : rows;
    }
  }

  #queueContext() {
    const data = this.#store.data;
    if (!data) return [];
    const candidates = this.#attribution.candidateSources;
    return this.#attribution.entries.map((e) => ({
      index: e.index,
      timeLabel: formatDuration(e.t),
      targetName: data.actors[e.targetUuid]?.n ?? "?",
      changeLabel: formatHPChange(e),
      candidates
    }));
  }

  #rollQueueContext() {
    const data = this.#store.data;
    if (!data) return [];
    return this.#attribution.rollEntries.map((e) => ({
      index: e.index,
      timeLabel: formatDuration(e.t),
      actorName: data.actors[e.actorUuid]?.n ?? "?",
      categoryLabel: describeRoll(e.category, e.tag),
      face: e.face
    }));
  }

  #applySort(key) {
    const current = this.#sortState[this.#activeTab];
    const dir = current?.key === key && current.dir === "desc" ? "asc" : "desc";
    this.#sortState[this.#activeTab] = { key, dir };
    this.#tables[this.#activeTab] = sortTable(this.#tables[this.#activeTab] ?? [], key, dir);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const parts = options.parts ?? ["top", "main"];
    if (parts.includes("top")) this.#bindTop();
    if (parts.includes("main")) this.#bindMain();
  }

  #bindTop() {
    const root = this.element;
    root.querySelector('[data-cgss-action="editRoster"]')?.addEventListener("click", () => openEditRosterDialog(this.#store));
    root.querySelector('[data-cgss-action="endSession"]')?.addEventListener("click", () => this.#confirmEndSession());
    root.querySelector('[data-cgss-action="exportCsv"]')?.addEventListener("click", () => exportSessionCSV(this.#store, this.#attribution));
    root.querySelectorAll("select[data-attribution-index]").forEach((sel) => {
      sel.addEventListener("change", () => {
        const index = Number(sel.dataset.attributionIndex);
        if (sel.value) this.#attribution.resolve(index, sel.value);
      });
    });
    root.querySelectorAll('[data-cgss-action="resolveRoll"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        this.#attribution.resolveRoll(Number(btn.dataset.index), btn.dataset.verdict);
      });
    });
  }

  /**
   * Ending is one-way - there is no resume - so it asks first, and states what is being
   * stopped rather than a bare "are you sure". DialogV2.confirm defaults to No.
   */
  async #confirmEndSession() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("CGSS.EndSession.Title"), icon: "fa-solid fa-circle-stop" },
      content: `<p>${game.i18n.format("CGSS.EndSession.Body", {
        elapsed: formatDuration(this.#store.elapsedSeconds),
        events: this.#store.eventCount
      })}</p>`,
      yes: { label: game.i18n.localize("CGSS.EndSession.Confirm"), icon: "fa-solid fa-circle-stop" },
      rejectClose: false
    });
    if (confirmed) this.#store.endSession();
  }

  #bindMain() {
    const root = this.element;
    root.querySelectorAll('[data-cgss-action="changeTab"]').forEach((el) => {
      el.addEventListener("click", () => {
        this.#activeTab = el.dataset.tab;
        this.render({ parts: ["main"] });
      });
    });
    root.querySelectorAll('[data-cgss-action="sortColumn"]').forEach((el) => {
      el.addEventListener("click", () => {
        this.#applySort(el.dataset.key);
        this.render({ parts: ["main"] });
      });
    });
    root.querySelector('[data-cgss-action="toggleNPCs"]')?.addEventListener("change", (ev) => {
      this.#showNPCs = ev.target.checked;
      this.#recompute();
      this.render({ parts: ["main"] });
    });
    root.querySelector('[data-cgss-action="toggleSpecialSaves"]')?.addEventListener("change", (ev) => {
      this.#excludeSpecialSaves = ev.target.checked;
      this.#recompute();
      this.render({ parts: ["main"] });
    });
    root.querySelector('[data-cgss-action="refresh"]')?.addEventListener("click", () => {
      this.#recompute();
      this.render({ parts: ["main"] });
    });
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);

    const refreshTop = () => this.rendered && this.render({ parts: ["top"] });
    // Only the header and queues follow live updates. The stat tables deliberately do not,
    // so the GM is never re-sorted mid-read; they refresh on open or via the control.
    for (const hook of [HOOK.QUEUE_CHANGED, HOOK.STATE_CHANGED]) {
      this.#hookIds.push([hook, Hooks.on(hook, refreshTop)]);
    }
    this.#tickInterval = setInterval(() => {
      if (this.rendered && this.#store.isRecording) refreshTop();
    }, 15000);
  }

  async _onClose(options) {
    await super._onClose(options);
    for (const [hook, id] of this.#hookIds) Hooks.off(hook, id);
    this.#hookIds = [];
    if (this.#tickInterval) clearInterval(this.#tickInterval);
  }
}

let reportApp = null;

/**
 * Opens the single shared report window. Lives here rather than beside either launch
 * button so the chat controls and the journal-tab button address the same instance
 * instead of stacking duplicates.
 */
export function openReport(store, attribution) {
  if (!reportApp) reportApp = new ReportApp(store, attribution);
  if (reportApp.rendered) reportApp.bringToFront();
  else reportApp.render({ force: true });
}
