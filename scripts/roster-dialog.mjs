function defaultSessionName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `Session ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Non-GM users currently connected who own this actor. */
function onlineOwners(actor) {
  return game.users.filter((u) => u.active && !u.isGM && actor.testUserPermission(u, "OWNER"));
}

/**
 * Every player-owned character, annotated with who's currently online and sorted so those
 * come first. Worlds can carry dozens of retired or spare PCs, so the dialog leans on this
 * ordering plus the search box rather than making the GM scroll a flat list.
 */
function eligibleActors() {
  return game.actors
    .filter((a) => a.type === "character" && a.hasPlayerOwner)
    .map((actor) => {
      const owners = onlineOwners(actor);
      return { actor, owners, isOnline: owners.length > 0 };
    })
    .sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return a.actor.name.localeCompare(b.actor.name, game.i18n.lang);
    });
}

function escapeHTML(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function rosterRowsHTML(entries, checkedUuids) {
  return entries
    .map(({ actor, owners, isOnline }) => {
      // Searching by player name as well as character name - "who is Dave playing?" is at
      // least as common as remembering the character's name.
      const haystack = [actor.name, ...owners.map((o) => o.name)].join(" ").toLowerCase();
      const ownerLabel = owners.length ? `${owners.map((o) => o.name).join(", ")} online` : "";
      return `
      <label class="cgss-roster-row" data-search="${escapeHTML(haystack)}">
        <input type="checkbox" data-uuid="${actor.uuid}" ${checkedUuids.has(actor.uuid) ? "checked" : ""}>
        <span class="cgss-roster-name">${escapeHTML(actor.name)}</span>
        ${isOnline ? `<span class="cgss-online" title="${escapeHTML(ownerLabel)}">${escapeHTML(owners.map((o) => o.name).join(", "))}</span>` : ""}
      </label>`;
    })
    .join("");
}

function toolbarHTML(total) {
  return `
    <div class="cgss-roster-toolbar">
      <input type="search" class="cgss-roster-search" placeholder="Search character or player...">
      <button type="button" data-cgss-action="selectAll">All</button>
      <button type="button" data-cgss-action="selectNone">None</button>
    </div>
    <p class="cgss-roster-count"><span class="cgss-selected-count">0</span> of ${total} selected</p>`;
}

/** Wires search, bulk select, and the live count once the dialog exists in the DOM. */
function wireRosterControls(event, dialog) {
  const root = dialog.element;
  const search = root.querySelector(".cgss-roster-search");
  const rows = [...root.querySelectorAll(".cgss-roster-row")];
  const counter = root.querySelector(".cgss-selected-count");

  const updateCount = () => {
    if (counter) counter.textContent = String(rows.filter((r) => r.querySelector("input").checked).length);
  };

  search?.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    for (const row of rows) row.hidden = !!query && !row.dataset.search.includes(query);
  });
  // Enter in the search box would otherwise submit the dialog mid-filter.
  search?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") ev.preventDefault();
  });

  // Bulk actions deliberately apply to the filtered rows only, so "search Bob, click All"
  // is a fast way to add just that player's characters.
  const setVisible = (checked) => {
    for (const row of rows) {
      if (!row.hidden) row.querySelector("input").checked = checked;
    }
    updateCount();
  };
  root.querySelector('[data-cgss-action="selectAll"]')?.addEventListener("click", () => setVisible(true));
  root.querySelector('[data-cgss-action="selectNone"]')?.addEventListener("click", () => setVisible(false));
  root.addEventListener("change", (ev) => {
    if (ev.target.matches?.("input[type=checkbox]")) updateCount();
  });

  updateCount();
  search?.focus();
}

function readCheckedUuids(form) {
  return [...form.querySelectorAll("input[type=checkbox]")].filter((cb) => cb.checked).map((cb) => cb.dataset.uuid);
}

/** Opens the Start Session roster picker. Resolves once the GM confirms or cancels. */
export async function openStartSessionDialog(store) {
  const entries = eligibleActors();
  if (!entries.length) {
    ui.notifications.warn(game.i18n.localize("CGSS.Roster.None"));
    return;
  }

  // Default to whoever is actually connected - that is the roster the GM wants far more
  // often than "every player-owned character in the world".
  const defaultChecked = new Set(entries.filter((e) => e.isOnline).map((e) => e.actor.uuid));

  const content = `
    <p>${game.i18n.localize("CGSS.Roster.StartPrompt")}</p>
    <div class="form-group">
      <label>${game.i18n.localize("CGSS.Roster.SessionName")}</label>
      <input type="text" name="sessionName" value="${escapeHTML(defaultSessionName())}">
    </div>
    ${toolbarHTML(entries.length)}
    <div class="cgss-roster-list">${rosterRowsHTML(entries, defaultChecked)}</div>`;

  return foundry.applications.api.DialogV2.prompt({
    content,
    window: { title: game.i18n.localize("CGSS.Roster.StartTitle"), icon: "fa-solid fa-users" },
    position: { width: 460 },
    render: wireRosterControls,
    ok: {
      label: game.i18n.localize("CGSS.Roster.Confirm"),
      callback: (event, button) => {
        const form = button.form;
        const roster = readCheckedUuids(form);
        const name = form.querySelector("input[name=sessionName]")?.value?.trim() || defaultSessionName();
        store.startSession(name, roster);
      }
    },
    rejectClose: false
  });
}

/** Opens the mid-session roster editor for late arrivals and drop-outs. */
export async function openEditRosterDialog(store) {
  const data = store.data;
  if (!data) return;

  const entries = eligibleActors();
  const rosterSet = new Set(data.meta.roster);

  const content = `
    ${toolbarHTML(entries.length)}
    <div class="cgss-roster-list">${rosterRowsHTML(entries, rosterSet)}</div>`;

  return foundry.applications.api.DialogV2.prompt({
    content,
    window: { title: game.i18n.localize("CGSS.Roster.EditTitle"), icon: "fa-solid fa-users" },
    position: { width: 460 },
    render: wireRosterControls,
    ok: {
      label: game.i18n.localize("CGSS.Roster.Confirm"),
      callback: (event, button) => {
        const checked = new Set(readCheckedUuids(button.form));
        const add = [...checked].filter((uuid) => !rosterSet.has(uuid));
        const remove = [...rosterSet].filter((uuid) => !checked.has(uuid));
        if (add.length || remove.length) store.editRoster(add, remove);
      }
    },
    rejectClose: false
  });
}
