/**
 * Resolves an acting/receiving actor to the actor that should actually be credited:
 * a wild-shaped character rolls back to its base character, a summoned creature or
 * familiar rolls up to whichever actor owns the summoning item. Confirmed against the
 * dnd5e 5.3.3 source: `flags.dnd5e.isPolymorphed` + `flags.dnd5e.originalActor` (a world
 * actor id) for wild shape/polymorph, `flags.dnd5e.summon.origin` (a summoning Item uuid)
 * for summons.
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

    break;
  }

  return current ?? actor;
}
