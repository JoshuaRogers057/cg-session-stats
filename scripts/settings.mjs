import { MODULE_ID, SETTING } from "./constants.mjs";

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING.SESSION_DATA, {
    scope: "world",
    config: false,
    type: Object,
    default: null
  });

  game.settings.register(MODULE_ID, SETTING.ALLOW_PLAYER_REPORT, {
    name: "CGSS.Settings.AllowPlayerReport.Name",
    hint: "CGSS.Settings.AllowPlayerReport.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
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
