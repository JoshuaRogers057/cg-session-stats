/**
 * Who a character is, captured once per session: class and level for PCs, CR for NPCs,
 * armor class for both, and the player who owns a PC. This is what lets the stats be
 * compared across sessions ("level 5 rogues", "CR 2 fights").
 *
 * Taken when the actor first shows up in a session, not refreshed afterwards, so a
 * character who levels up at the end of the night is credited at the level they played.
 *
 * Paths confirmed against dnd5e 5.3: `system.details.level` (total character level),
 * `actor.classes` (class items keyed by identifier, each with `system.levels` and a
 * `subclass` getter), `system.details.cr` and `system.details.xp.value` for NPCs.
 */
export function describeActor(actor) {
  const isPC = actor.type === "character";
  const info = { n: actor.name, t: isPC ? "pc" : "npc", v: 2 }; // v:2 marks a full snapshot

  const ac = actor.system?.attributes?.ac?.value;
  if (Number.isFinite(ac)) info.ac = ac;

  if (isPC) {
    const level = actor.system?.details?.level;
    if (Number.isFinite(level)) info.lv = level;

    // Most levels first, so the first entry is the character's primary class.
    info.cls = Object.values(actor.classes ?? {})
      .map((item) => ({ n: item.name, l: item.system?.levels ?? 0, s: item.subclass?.name ?? null }))
      .sort((a, b) => b.l - a.l);

    const player = playerName(actor);
    if (player) info.pl = player;
  } else {
    const cr = actor.system?.details?.cr;
    if (Number.isFinite(cr)) info.cr = cr;
    const xp = actor.system?.details?.xp?.value;
    if (Number.isFinite(xp)) info.xp = xp;
    // A monster with legendary actions counts as an elite (two bodies) in the Adventure
    // Builder; a lair means its XP may be the higher in-lair figure.
    const legendary = actor.system?.resources?.legact?.max;
    if (Number.isFinite(legendary) && legendary > 0) info.leg = legendary;
    if (actor.system?.resources?.lair?.value) info.lair = 1;
  }

  return info;
}

/**
 * [hp, max, temp] right now. The website rebuilds every combatant's HP through a fight from
 * this snapshot plus each HP change, so it can tell how close a fight came.
 */
export function hpSnapshot(actor) {
  const hp = actor?.system?.attributes?.hp;
  if (!hp) return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return [n(hp.value), n(hp.max), n(hp.temp)];
}

/**
 * The player behind a PC: whoever has it as their assigned character, or failing that the
 * first non-GM owner. Null for a character only the GM controls.
 */
function playerName(actor) {
  const players = game.users.filter((u) => !u.isGM);
  const assigned = players.find((u) => u.character?.id === actor.id);
  if (assigned) return assigned.name;
  const owner = players.find((u) => actor.testUserPermission(u, "OWNER"));
  return owner?.name ?? null;
}

/** 0.125 -> "1/8", 2 -> "2". Empty for an unknown CR. */
export function formatCR(cr) {
  if (!Number.isFinite(cr)) return "";
  const fractions = { 0.125: "1/8", 0.25: "1/4", 0.5: "1/2" };
  return fractions[cr] ?? String(cr);
}
