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
    default: false,
    // Toggling this adds or removes the players' Open Report button immediately.
    onChange: () => Hooks.callAll(HOOK.STATE_CHANGED)
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
