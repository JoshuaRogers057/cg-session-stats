# Session Stats receiver

A Google Apps Script web app that collects every finished session from every Foundry world running Session Stats. It is free, runs under your own Google account, and needs nothing from the GMs.

For each session it:

- creates a spreadsheet named `date - session - world` in a **Session Stats** folder in your Drive, with one tab per table (Session Info, Party, Fights, Per Fight, Combat Totals, the roll tables, Initiative)
- appends the session's **Per Fight** and **Combat Totals** rows to one master spreadsheet, **Session Stats - All Sessions**, each row prefixed with the session's id, date, world, GM and rules version
- logs the session on the master's **Sessions** tab, with a link to its spreadsheet

A session that arrives twice (the module retrying after a lost reply) is filed once.

This folder is not part of the module: the release zip only packages the module's own files.

## One-time setup

1. Sign in to the Google account that should own the data, and go to [script.google.com](https://script.google.com). Click **New project** and name it something like *Session Stats Receiver*.
2. Replace everything in `Code.gs` with the contents of [Code.gs](Code.gs) from this folder, and save.
3. In the toolbar's function dropdown, pick **setup**, then click **Run**. Google asks you to authorize the script. Because it's your own unpublished script, it shows "Google hasn't verified this app": click **Advanced**, then **Go to Session Stats Receiver**, then **Allow**. The execution log then shows links to the new folder and master spreadsheet.
4. Click **Deploy → New deployment**. Click the gear next to *Select type* and pick **Web app**. Set **Execute as** to **Me** and **Who has access** to **Anyone**, then click **Deploy**.
5. Copy the **Web app URL**. It ends in `/exec`. Open it in a browser: you should see `{"ok":true,"service":"session-stats-receiver"}`.
6. Put that URL in `UPLOAD_URL` in [scripts/constants.mjs](../scripts/constants.mjs) and release a new version of the module. Until then, the module sends nothing and shows no sharing notice.

## Changing the script later

Always update the **existing** deployment: **Deploy → Manage deployments**, click the pencil, set **Version** to **New version**, then **Deploy**. That keeps the same URL.

A *new* deployment gets a new URL, and every copy of the module already installed would keep sending to the old one.

## Notes

- "Anyone" access means anyone who finds the URL can send to it. It's in the module's public source, so that's expected. The script only accepts uploads shaped like the module's, caps their size, and stores text that starts with `=`, `+`, `-` or `@` as plain text, so nothing sent can run as a formula in your sheets.
- The folder is private to you by default. Share it from Drive if you want others to browse the results.
- If you delete the folder or the master spreadsheet, the next upload creates a fresh one.
