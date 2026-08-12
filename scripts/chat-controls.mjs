import { HOOK, debugLog } from "./constants.mjs";
import { openStartSessionDialog } from "./roster-dialog.mjs";
import { exportSessionCSV } from "./csv-export.mjs";
import { openReport } from "./report-app.mjs";

export function registerChatControls(store, attribution) {
  // GM-only: the session lifecycle is theirs, and players launch the report from the
  // Journal tab instead (see journal-controls.mjs). Nothing is injected for players at all.
  if (!game.user.isGM) return;

  Hooks.on("renderChatLog", (app, html) => injectControls(html, store, attribution));
  Hooks.on(HOOK.STATE_CHANGED, () => refreshControls(store, attribution));
  Hooks.on(HOOK.QUEUE_CHANGED, () => refreshControls(store, attribution));

  // Core renders the chat sidebar as part of its own startup sequence, before module
  // "ready" hooks run - by the time this fires, renderChatLog's first (and possibly only)
  // firing has already been missed. Inject directly into whatever's already in the DOM now,
  // and keep the hook above for any later re-render (popout, tab switch, etc).
  if (ui.chat?.element) injectControls(ui.chat.element, store, attribution);
  else debugLog("chat-controls: ui.chat not yet rendered at ready-time, relying on renderChatLog hook");
}

function injectControls(html, store, attribution) {
  if (html.querySelector(".cgss-controls")) return refreshControls(store, attribution);

  // V13's chat input is the ChatLog "input" part: <form class="chat-form">. There is no
  // #chat-form id (that was the pre-V13 markup).
  const form = html.querySelector("form.chat-form");
  if (!form) debugLog("chat-controls: form.chat-form not found, appending to chat log root instead", html);
  const bar = document.createElement("div");
  bar.className = "cgss-controls";
  bar.innerHTML = `
    <button type="button" data-cgss-action="start"><i class="fa-solid fa-circle-play"></i> Start Session</button>
    <button type="button" data-cgss-action="end"><i class="fa-solid fa-circle-stop"></i> End Session</button>
    <button type="button" data-cgss-action="report">
      <i class="fa-solid fa-chart-column"></i> Open Report
      <span class="cgss-badge" hidden></span>
    </button>
  `;
  if (form) form.insertAdjacentElement("afterend", bar);
  else html.appendChild(bar);

  bar.querySelector('[data-cgss-action="start"]').addEventListener("click", () => onStart(store, attribution));
  bar.querySelector('[data-cgss-action="end"]').addEventListener("click", () => store.endSession());
  bar.querySelector('[data-cgss-action="report"]').addEventListener("click", () => openReport(store, attribution));

  refreshControls(store, attribution);
}

function refreshControls(store, attribution) {
  const bar = document.querySelector(".cgss-controls");
  if (!bar) return;

  const recording = store.isRecording;
  const hasData = !!store.data;

  bar.querySelector('[data-cgss-action="start"]').hidden = recording;
  bar.querySelector('[data-cgss-action="end"]').hidden = !recording;
  bar.querySelector('[data-cgss-action="report"]').hidden = !hasData;

  const badge = bar.querySelector(".cgss-badge");
  const count = attribution.count + attribution.rollCount;
  badge.hidden = count === 0;
  badge.textContent = String(count);
}

async function onStart(store, attribution) {
  if (store.hasUnexportedData) {
    const choice = await confirmUnexportedData();
    if (!choice || choice === "cancel") return;
    if (choice === "export") await exportSessionCSV(store, attribution);
    else if (choice === "discard") store.discardSession();
  }
  await openStartSessionDialog(store);
}

/** Guards Start Session against clobbering a prior session's unexported data. */
function confirmUnexportedData() {
  return new Promise((resolve) => {
    const app = new foundry.applications.api.DialogV2({
      window: { title: game.i18n.localize("CGSS.Guard.Title"), icon: "fa-solid fa-triangle-exclamation" },
      content: `<p>${game.i18n.localize("CGSS.Guard.Body")}</p>`,
      buttons: [
        { action: "export", icon: "fa-solid fa-file-csv", label: game.i18n.localize("CGSS.Guard.Export"), default: true },
        { action: "discard", icon: "fa-solid fa-trash", label: game.i18n.localize("CGSS.Guard.Discard") },
        { action: "cancel", icon: "fa-solid fa-xmark", label: game.i18n.localize("CGSS.Guard.Cancel") }
      ],
      submit: (result) => resolve(result)
    });
    app.addEventListener("close", () => resolve(null), { once: true });
    app.render({ force: true });
  });
}

