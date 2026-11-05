import { MODULE_ID, SETTING, HOOK } from "./constants.mjs";

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING.SESSION_DATA, {
    scope: "world",
    config: false,
    type: Object,
    default: null,
    // Fires on every client when the GM flushes. Players have no other route to the data.
    onChange: (value) => game.modules.get(MODULE_ID)?.api?.store?.syncFromSetting(value)
  });

  game.settings.register(MODULE_ID, SETTING.ALLOW_PLAYER_REPORT, {
    name: "CGSS.Settings.AllowPlayerReport.Name",
    hint: "CGSS.Settings.AllowPlayerReport.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    // On out of the box: the stats are the table's as much as the GM's. A GM who would rather
    // keep them private turns it off here. Worlds that already saved a value keep it.
    default: true,
    // Toggling this adds or removes the players' Open Report button immediately.
    onChange: () => Hooks.callAll(HOOK.STATE_CHANGED)
  });

  game.settings.register(MODULE_ID, SETTING.START_PROMPT_PLAYERS, {
    name: "CGSS.Settings.StartPrompt.Name",
    hint: "CGSS.Settings.StartPrompt.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 0, max: 10, step: 1 },
    default: 2
  });

  game.settings.register(MODULE_ID, SETTING.AUTO_END_HOURS, {
    name: "CGSS.Settings.AutoEnd.Name",
    hint: "CGSS.Settings.AutoEnd.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 0, max: 12, step: 1 },
    default: 3
  });

  game.settings.register(MODULE_ID, SETTING.SHARE_STATS, {
    name: "CGSS.Settings.ShareStats.Name",
    hint: "CGSS.Settings.ShareStats.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    // Turning sharing off also drops anything still waiting to be sent: "off" should mean
    // nothing more leaves this world, including sessions that ended while it was on.
    onChange: (value) => {
      if (!value && game.user.isGM) game.settings.set(MODULE_ID, SETTING.UPLOAD_QUEUE, { items: [] });
    }
  });

  // Hidden bookkeeping for the upload (see upload.mjs).
  game.settings.register(MODULE_ID, SETTING.SHARE_NOTICE_SHOWN, {
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });

  // { items: payload[] } - wrapped in an object like sessionData, the shape Object settings
  // are known to store faithfully.
  game.settings.register(MODULE_ID, SETTING.UPLOAD_QUEUE, {
    scope: "world",
    config: false,
    type: Object,
    default: { items: [] }
  });

  game.settings.register(MODULE_ID, SETTING.DEBUG, {
    name: "CGSS.Settings.Debug.Name",
    hint: "CGSS.Settings.Debug.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
}
