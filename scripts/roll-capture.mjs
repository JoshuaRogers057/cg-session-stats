import { EVENT_TYPE, ROLL_CATEGORY, ROLL_TAG } from "./constants.mjs";
import { resolveAttributedActor } from "./actor-resolve.mjs";

/**
 * Listens for the d20 roll hooks confirmed against the installed dnd5e 5.3.3 / midi-qol
 * 13.0.64 source. Notably: ability checks and saving throws have no "V2" hook in this
 * build (only skill/tool do), and initiative never passes a rolls array - the D20Roll has
 * to be captured from `dnd5e.preRollInitiative` before dnd5e discards its cached copy.
 */
export class RollCapture {
  constructor(store) {
    this.store = store;
  }

  registerHooks() {
    Hooks.on("midi-qol.AttackRollComplete", (workflow) => this.#onAttack(workflow));
    Hooks.on("dnd5e.rollSavingThrow", (rolls, data) => this.#onD20(rolls, data.subject, ROLL_CATEGORY.SAVE));
    Hooks.on("dnd5e.rollConcentrationV2", (rolls, data) =>
      this.#onD20(rolls, data.subject, ROLL_CATEGORY.SAVE, ROLL_TAG.CONCENTRATION)
    );
    Hooks.on("dnd5e.postRollDeathSave", (rolls, data) =>
      this.#onD20(rolls, data.subject, ROLL_CATEGORY.SAVE, ROLL_TAG.DEATH_SAVE)
    );
    Hooks.on("dnd5e.rollAbilityCheck", (rolls, data) => this.#onD20(rolls, data.subject, ROLL_CATEGORY.CHECK));
    Hooks.on("dnd5e.rollSkillV2", (rolls, data) => this.#onD20(rolls, data.subject, ROLL_CATEGORY.CHECK));
    Hooks.on("dnd5e.rollToolCheckV2", (rolls, data) => this.#onD20(rolls, data.subject, ROLL_CATEGORY.CHECK));
    Hooks.on("dnd5e.preRollInitiative", (actor, roll) => this.#onInitiative(actor, roll));
  }

  #onAttack(workflow) {
    const actor = workflow.actor;
    const roll = workflow.attackRoll;
    if (!actor || !roll) return;
    const faces = extractD20Faces(roll);
    if (!faces) return; // fixed/no-d20 attack roll

    let pass = null;
    if (workflow.hitTargets?.size > 0) pass = true;
    else if (workflow.targets?.size > 0) pass = false;

    this.#push(actor, ROLL_CATEGORY.ATTACK, faces, pass);
  }

  #onD20(rolls, subject, category, tag) {
    const actor = subject?.actor ?? subject;
    const roll = rolls?.[0];
    if (!actor || !roll) return;
    const faces = extractD20Faces(roll);
    if (!faces) return;

    const hasTarget = Number.isFinite(roll.options?.target);
    const pass = hasTarget ? roll.isSuccess ?? null : null;

    this.#push(actor, category, faces, pass, tag);
  }

  #onInitiative(actor, roll) {
    if (!actor || !roll) return;
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
}

function extractD20Faces(roll) {
  const die = roll.d20 ?? roll.dice?.[0];
  if (!die?.results?.length) return null;
  const faces = die.results.map((r) => r.result);
  let keptIndex = die.results.findIndex((r) => r.active);
  if (keptIndex === -1) keptIndex = 0;
  return { faces, keptIndex };
}
