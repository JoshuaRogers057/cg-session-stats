function defaultSessionName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `Session ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Asks only for a name. There is deliberately no roster to pick: every character is
 * tracked, and who appears in the report is decided by who actually rolled. Choosing up
 * front meant a late arrival was silently excluded all evening, which is the harder
 * mistake to notice and the harder one to undo.
 */
export async function openStartSessionDialog(store) {
  const content = `
    <div class="form-group">
      <label>${game.i18n.localize("CGSS.Session.Name")}</label>
      <input type="text" name="sessionName" value="${foundry.utils.escapeHTML(defaultSessionName())}" autofocus>
    </div>
    <div class="form-group">
      <label class="checkbox">
        <input type="checkbox" name="guildGame" checked>
        ${game.i18n.localize("CGSS.Session.Guild")}
      </label>
    </div>
    <p class="cgss-hint">${game.i18n.localize("CGSS.Session.GuildHint")}</p>
    <p class="cgss-hint">${game.i18n.localize("CGSS.Session.Hint")}</p>`;

  return foundry.applications.api.DialogV2.prompt({
    content,
    window: { title: game.i18n.localize("CGSS.Session.StartTitle"), icon: "fa-solid fa-circle-play" },
    position: { width: 420 },
    ok: {
      label: game.i18n.localize("CGSS.Session.Confirm"),
      icon: "fa-solid fa-circle-play",
      callback: (event, button) => {
        const name = button.form.querySelector("input[name=sessionName]")?.value?.trim() || defaultSessionName();
        // Ticked unless the GM unticks it: almost every session is a guild game.
        const guild = button.form.querySelector("input[name=guildGame]")?.checked !== false;
        store.startSession(name, { guild });
      }
    },
    rejectClose: false
  });
}
