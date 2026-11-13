/**
 * Resolves an acting/receiving actor to the actor that should actually be credited:
 * a wild-shaped character rolls back to its base character, a summoned creature or
 * familiar rolls up to whichever actor owns the summoning item. Confirmed against the
 * dnd5e 5.3.3 source: `flags.dnd5e.isPolymorphed` + `flags.dnd5e.originalActor` (a world
 * actor id) for wild shape/polymorph, `flags.dnd5e.summon.origin` (a summoning Item uuid)
 * for summons.
 *
 * Plenty of companions never go through dnd5e's summoning at all - a familiar, homunculus
 * or steel defender the GM made as its own NPC and handed to the player. Those carry no
 * flag, so the last rule falls back on ownership: an NPC that belongs to exactly one player
 * is credited to that player's character (see playerCharacterOf).
 */
export function resolveAttributedActor(actor) {
  let current = actor;
  const seen = new Set();

  for (let depth = 0; depth < 4 && current && !seen.has(current.uuid); depth++) {
    seen.add(current.uuid);

    if (current.getFlag("dnd5e", "isPolymorphed")) {
      const originalId = current.getFlag("dnd5e", "originalActor");
      const base = originalId ? game.actors.get(originalId) : null;
      if (base) {
        current = base;
        continue;
      }
    }

    const summonOrigin = current.getFlag("dnd5e", "summon")?.origin;
    if (summonOrigin) {
      const originItem = fromUuidSync(summonOrigin);
      const summoner = originItem?.actor ?? null;
      if (summoner) {
        current = summoner;
        continue;
      }
    }

    const owner = playerCharacterOf(current);
    if (owner) {
      current = owner;
      continue;
    }

    break;
  }

  return current ?? actor;
}

/**
 * The character behind a player-owned NPC, or null.
 *
 * Only an NPC owned by exactly one player, given by name in its ownership: an NPC every
 * player owns (default ownership) or several players share is a party resource, not anyone's
 * companion, and is left as itself. The character is that player's assigned character, or
 * failing that the only character they own; a player with several characters and none
 * assigned is ambiguous, so the NPC is left alone rather than guessed at.
 *
 * Characters themselves are never rolled up, however they are owned.
 */
function playerCharacterOf(actor) {
  if (actor.type !== "npc") return null;
  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const ownership = actor.ownership ?? {};
  if ((ownership.default ?? 0) >= OWNER) return null;

  const owners = game.users.filter((u) => !u.isGM && ownership[u.id] >= OWNER);
  if (owners.length !== 1) return null;
  const player = owners[0];

  if (player.character?.type === "character") return player.character;
  const characters = game.actors.filter((a) => a.type === "character" && (a.ownership?.[player.id] ?? 0) >= OWNER);
  return characters.length === 1 ? characters[0] : null;
}
