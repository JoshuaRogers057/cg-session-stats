import { MODULE_ID, SETTING, HOOK } from "./constants.mjs";
import { openReport } from "./report-app.mjs";

/**
 * The players' route to the report. The GM launches it from the chat controls; players get
 * a button at the top of the Journal sidebar tab instead, keeping their chat box clear.
 *
 * Unlike the chat sidebar, the journal directory carries no `pointer-events: none` (core
 * scopes that rule to `#sidebar-content.active-chat`), so nothing special is needed to make
 * the button clickable here.
 */
export function registerJournalControls(store, attribution) {
  if (game.user.isGM) return;

  Hooks.on("renderJournalDirectory", (app, html) => syncButton(html, store, attribution));
  // Fires when the GM starts or ends a session, or toggles the player-report setting.
  Hooks.on(HOOK.STATE_CHANGED, () => syncButton(ui.journal?.element, store, attribution));

  // The sidebar may already have rendered before this module's "ready" hook ran.
  if (ui.journal?.element) syncButton(ui.journal.element, store, attribution);
}

function playersMayView() {
  return game.settings.get(MODULE_ID, SETTING.ALLOW_PLAYER_REPORT) === true;
}

function syncButton(html, store, attribution) {
  if (!html) return;
  const existing = html.querySelector(".cgss-journal-controls");

  // Nothing to open before a session exists, and nothing to show if the GM has not opted
  // players in - so the button appears and disappears as those conditions change.
  if (!playersMayView() || !store.data) {
    existing?.remove();
    return;
  }
  if (existing) return;

  const bar = document.createElement("div");
  bar.className = "cgss-journal-controls action-buttons flexcol";
  bar.innerHTML = `
    <button type="button" data-cgss-action="report">
      <i class="fa-solid fa-chart-column"></i> Session Report
    </button>`;
  bar.querySelector("button").addEventListener("click", () => openReport(store, attribution));

  const header = html.querySelector(".directory-header");
  if (header) header.prepend(bar);
  else html.prepend(bar);
}
