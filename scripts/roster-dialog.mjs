function defaultSessionName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `Session ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function eligibleActors() {
  return game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner);
}

function rosterRowsHTML(actors, checkedUuids) {
  return actors
    .map(
      (a) => `
      <label class="cgss-roster-row">
        <input type="checkbox" data-uuid="${a.uuid}" ${checkedUuids.has(a.uuid) ? "checked" : ""}>
        <span>${a.name}</span>
      </label>`
    )
    .join("");
}

/** Opens the Start Session roster picker. Resolves once the GM confirms or cancels. */
export async function openStartSessionDialog(store) {
  const actors = eligibleActors();
  const allUuids = new Set(actors.map((a) => a.uuid));
  const rows = rosterRowsHTML(actors, allUuids);

  const content = `
    <p>${game.i18n.localize("CGSS.Roster.StartPrompt")}</p>
    <div class="form-group">
      <label>${game.i18n.localize("CGSS.Roster.SessionName")}</label>
      <input type="text" name="sessionName" value="${defaultSessionName()}">
    </div>
    <div class="cgss-roster-list">
      ${rows || `<p>${game.i18n.localize("CGSS.Roster.None")}</p>`}
    </div>`;

  return foundry.applications.api.DialogV2.prompt({
    content,
    window: { title: game.i18n.localize("CGSS.Roster.StartTitle"), icon: "fa-solid fa-users" },
    position: { width: 420 },
    ok: {
      label: game.i18n.localize("CGSS.Roster.Confirm"),
      callback: (event, button) => {
        const form = button.form;
        const roster = [...form.querySelectorAll("input[type=checkbox]")]
          .filter((cb) => cb.checked)
          .map((cb) => cb.dataset.uuid);
        const name = form.querySelector("input[name=sessionName]")?.value?.trim() || defaultSessionName();
        store.startSession(name, roster);
      }
    },
    rejectClose: false
  });
}

/** Opens the mid-session roster editor for late arrivals / drop-outs. */
export async function openEditRosterDialog(store) {
  const data = store.data;
  if (!data) return;

  const actors = eligibleActors();
  const rosterSet = new Set(data.meta.roster);
  const rows = rosterRowsHTML(actors, rosterSet);

  const content = `<div class="cgss-roster-list">${rows}</div>`;

  return foundry.applications.api.DialogV2.prompt({
    content,
    window: { title: game.i18n.localize("CGSS.Roster.EditTitle"), icon: "fa-solid fa-users" },
    position: { width: 420 },
    ok: {
      label: game.i18n.localize("CGSS.Roster.Confirm"),
      callback: (event, button) => {
        const form = button.form;
        const checked = new Set(
          [...form.querySelectorAll("input[type=checkbox]")].filter((cb) => cb.checked).map((cb) => cb.dataset.uuid)
        );
        const add = [...checked].filter((uuid) => !rosterSet.has(uuid));
        const remove = [...rosterSet].filter((uuid) => !checked.has(uuid));
        if (add.length || remove.length) store.editRoster(add, remove);
      }
    },
    rejectClose: false
  });
}
