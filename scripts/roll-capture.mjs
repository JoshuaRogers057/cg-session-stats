import { EVENT_TYPE, ROLL_CATEGORY, ROLL_TAG } from "./constants.mjs";
import { resolveAttributedActor } from "./actor-resolve.mjs";
import { relayAmendRoll } from "./socket.mjs";

/**
 * Listens for the d20 roll hooks confirmed against the installed dnd5e 5.3.3 / midi-qol
 * 13.0.64 source. Notably: ability checks and saving throws have no "V2" hook in this
 * build (only skill/tool do), and initiative has no dependable roll hook at all - it is
 * captured from the flagged chat message instead (see registerHooks).
 *
 * Death saves and concentration saves are NOT recorded separately. dnd5e implements both
 * by calling Actor5e#rollSavingThrow internally, so `dnd5e.rollSavingThrow` has already
 * fired for them by the time their own hooks run; recording both would count one roll
 * twice. Their hooks amend the existing record with a tag instead.
 */
export class RollCapture {
  constructor(store) {
    this.store = store;
  }

  registerHooks() {
    Hooks.on("midi-qol.AttackRollComplete", (workflow) => this.#onAttack(workflow));

    Hooks.on("dnd5e.rollSavingThrow", (rolls, data) => this.#onD20(rolls, data.subject, ROLL_CATEGORY.SAVE));
    Hooks.on("dnd5e.rollAbilityCheck", (rolls, data) => this.#onD20(rolls, data.subject, ROLL_CATEGORY.CHECK));
    Hooks.on("dnd5e.rollSkillV2", (rolls, data) => this.#onD20(rolls, data.subject, ROLL_CATEGORY.CHECK));
    Hooks.on("dnd5e.rollToolCheckV2", (rolls, data) => this.#onD20(rolls, data.subject, ROLL_CATEGORY.CHECK));

    // Tag-only: the roll itself was already captured by dnd5e.rollSavingThrow above.
    Hooks.on("dnd5e.postRollDeathSave", (rolls, data) => this.#tag(rolls, data.subject, ROLL_TAG.DEATH_SAVE));
    Hooks.on("dnd5e.rollConcentrationV2", (rolls, data) => this.#tag(rolls, data.subject, ROLL_TAG.CONCENTRATION));

    // Midi decides pass/fail itself and only afterwards; see #onSavesChecked.
    Hooks.on("midi-qol.postCheckSaves", (workflow) => this.#onSavesChecked(workflow));

    // Initiative has no usable dnd5e roll hook. Rolling from the combat tracker
    // (rollAll / rollNPC / a single combatant) goes Combat5e#rollInitiative -> core
    // Combat#rollInitiative -> Combatant5e#getInitiativeRoll, which never enters
    // Actor5e#rollInitiative and therefore never fires dnd5e.preRollInitiative - that hook
    // only covers the character-sheet path. Both paths do converge on core creating one
    // chat message flagged "core.initiativeRoll" with the evaluated roll attached, so that
    // message is the single capture point covering every path exactly once.
    // Chat messages sync to the GM, so this is GM-only; running it on every client would
    // relay the same roll several times.
    if (game.user.isGM) Hooks.on("createChatMessage", (message) => this.#onInitiativeMessage(message));
  }

  #onAttack(workflow) {
    const actor = workflow.actor;
    const roll = workflow.attackRoll;
    if (!actor || !roll) return;
    const faces = extractD20Faces(roll);
    if (!faces) return; // fixed/no-d20 attack roll

    // Midi keeps hits in two sets - hitTargetsEC holds those that connected only under the
    // optional "challenge mode armor" rule - and treats the union as hit (its own
    // processDamageRoll does exactly this). Anything targeted but in neither set missed.
    const targets = [...(workflow.targets ?? [])];
    const hitUuids = new Set(
      [...(workflow.hitTargets ?? []), ...(workflow.hitTargetsEC ?? [])].map(tokenUuid).filter(Boolean)
    );

    let pass = null;
    if (hitUuids.size > 0) pass = true;
    else if (targets.length > 0) pass = false;

    this.#push(actor, ROLL_CATEGORY.ATTACK, faces, pass);

    // Hits as well as misses, so the defender's side has a denominator: "avoided 6" means
    // little without knowing whether they were attacked 8 times or 40.
    for (const token of targets) {
      const uuid = tokenUuid(token);
      if (!uuid) continue;
      const targetActor = token?.actor;
      if (!targetActor) continue;
      const type = hitUuids.has(uuid) ? EVENT_TYPE.HIT : EVENT_TYPE.MISS;
      this.store.recordEvent(type, { targetUuid: resolveAttributedActor(targetActor).uuid });
    }
  }

  #onD20(rolls, subject, category, tag) {
    const actor = subject?.actor ?? subject;
    const roll = rolls?.[0];
    if (!actor || !roll) return;
    const faces = extractD20Faces(roll);
    if (!faces) return;

    // Only meaningful when a DC actually reached the roll. Midi frequently withholds it
    // from the roller (see #onSavesChecked), in which case pass/fail arrives by amendment.
    const hasTarget = Number.isFinite(roll.options?.target);
    const pass = hasTarget ? roll.isSuccess ?? null : null;

    this.#push(actor, category, faces, pass, tag);
  }

  /** Marks an already-recorded roll as a death save or concentration save. */
  #tag(rolls, subject, tag) {
    const actor = subject?.actor ?? subject;
    const roll = rolls?.[0];
    if (!actor || !roll) return;
    const faces = extractD20Faces(roll);
    if (!faces) return;

    this.#amend({ actorUuid: resolveAttributedActor(actor).uuid, faces: faces.faces, tag });
  }

  /**
   * Supplies pass/fail for Midi-driven saves.
   *
   * Midi only forwards the DC to the roll when it is allowed to show it: `showTargetDC`
   * depends on dnd5e's `challengeVisibility` setting, so an NPC forcing a save on a
   * player-owned target hides the DC from the player rolling it. `roll.options.target`
   * then never gets set and dnd5e's `isSuccess` reports false for a pass and a fail alike.
   * Midi does not rely on that field either - it compares the total against its own DC -
   * so its verdict is read here instead and amended onto the roll already recorded.
   */
  #onSavesChecked(workflow) {
    const details = workflow?.targetSaveDetails;
    if (!details) return;

    const savedUuids = new Set([...(workflow.saves ?? [])].map(tokenUuid).filter(Boolean));

    for (const [uuid, detail] of Object.entries(details)) {
      const roll = detail?.saveRoll;
      if (!roll) continue;
      const faces = extractD20Faces(roll);
      if (!faces) continue;

      const actor = fromUuidSync(detail.actorUuid ?? "") ?? fromUuidSync(uuid)?.actor;
      if (!actor) continue;

      this.#amend({
        actorUuid: resolveAttributedActor(actor).uuid,
        faces: faces.faces,
        pass: savedUuids.has(uuid)
      });
    }
  }

  #onInitiativeMessage(message) {
    if (message.getFlag("core", "initiativeRoll") !== true) return;
    const roll = message.rolls?.[0];
    if (!roll) return;

    // Resolves the token's actor first, so unlinked NPC combatants credit the token actor
    // rather than collapsing onto the base actor.
    const actor = message.constructor.getSpeakerActor(message.speaker);
    if (!actor) return;

    const faces = extractD20Faces(roll);
    if (!faces) return; // fixed-score initiative produces a BasicRoll with no d20 term
    this.#push(actor, ROLL_CATEGORY.INITIATIVE, faces, null);
  }

  #push(actor, category, faces, pass, tag) {
    const attributed = resolveAttributedActor(actor);
    this.store.recordEvent(EVENT_TYPE.ROLL, {
      actorUuid: attributed.uuid,
      category,
      faces: faces.faces,
      keptIndex: faces.keptIndex,
      pass,
      ...(tag ? { tag } : {})
    });
  }

  #amend(amendment) {
    if (game.user.isGM) this.store.queueAmendment(amendment);
    else relayAmendRoll(amendment).catch((err) => console.error("cg-session-stats | Failed to relay amendment", err));
  }
}

/** Token sets on the workflow are rebuilt from UUIDs, so compare by UUID not identity. */
function tokenUuid(token) {
  return token?.document?.uuid ?? token?.uuid ?? null;
}

function extractD20Faces(roll) {
  const die = roll.d20 ?? roll.dice?.[0];
  if (!die?.results?.length) return null;
  const faces = die.results.map((r) => r.result);
  let keptIndex = die.results.findIndex((r) => r.active);
  if (keptIndex === -1) keptIndex = 0;
  return { faces, keptIndex };
}
