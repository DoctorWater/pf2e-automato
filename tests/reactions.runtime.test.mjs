import { test } from "node:test";
import assert from "node:assert/strict";
import { onAttackMessage, useReaction } from "../scripts/reactions.mjs";
import { initCatalog } from "../scripts/rules.mjs";

const MOD = "pf2e-automato";
const DODGE_SOURCE = "Compendium.pf2e.feats-srd.Item.dNH8OHEvx3vI9NBQ";
const reaction = (value) => ({ v: 1, onAttacked: { trigger: "attack-on-self", bonus: { stat: "ac", type: "circumstance", value }, cost: "reaction" } });

function fixture({ sourceOnly = true } = {}) {
  initCatalog([{ bySource: { [DODGE_SOURCE]: reaction(2) }, bySlug: { "nimble-dodge": reaction(2), "other-dodge": reaction(1) } }], {});
  const dodge = { uuid: "Item.dodge", name: "Переведённое название", type: "feat", system: sourceOnly ? {} : { slug: "nimble-dodge" }, _stats: sourceOnly ? { compendiumSource: DODGE_SOURCE } : {} };
  const other = { uuid: "Item.other", name: "Иная реакция", type: "feat", system: { slug: "other-dodge" } };
  let encumbered = false, spent = 0, tracker = 0, hintUpdates = 0, attackUpdates = 0;
  const actor = {
    id: "defender", uuid: "Actor.defender", name: "Защитник", items: [dodge, other],
    hasCondition: (slug) => slug === "encumbered" && encumbered,
    getFlag: () => null, setFlag: async () => { spent++; },
    testUserPermission: () => true
  };
  dodge.toMessage = async () => { tracker++; };
  other.toMessage = async () => { tracker++; };
  const attack = {
    id: "attack", speaker: { actor: "attacker", alias: "Нападающий" },
    rolls: [{ total: 15, options: { degreeOfSuccess: 2 }, dice: [{ faces: 20, total: 10 }] }],
    flags: { pf2e: { context: { type: "attack-roll", target: { actor: actor.uuid }, dc: { slug: "ac", value: 15 } } } },
    update: async (change) => { attackUpdates++; attack.flags[MOD] = { gate: change[`flags.${MOD}.gate`] }; }
  };
  const hints = [];
  globalThis.ChatMessage = { create: async (data) => {
    const hint = { id: `hint${hints.length}`, ...data, update: async (change) => { hintUpdates++; hint.flags[MOD].reaction = change[`flags.${MOD}.reaction`]; } };
    hints.push(hint);
    return hint;
  } };
  globalThis.game = {
    user: { isActiveGM: true }, users: [{ id: "gm", isGM: true }],
    combat: { id: "combat", round: 1, started: true, active: true, scene: "s", combatants: [{ actorId: actor.id, actor }] },
    get combats() { return [this.combat]; },
    settings: { get: (_mod, key) => key === "mode.macro" ? "off" : key === "debug" ? false : key === "catalog" ? {} : "auto" },
    messages: { get: (id) => id === attack.id ? attack : hints.find((h) => h.id === id), contents: hints },
    modules: { get: (id) => id === "pf2e-auto-action-tracker" ? { active: true } : null },
    i18n: { localize: (key) => key, format: (key) => key }
  };
  globalThis.fromUuid = async (uuid) => ({ [actor.uuid]: actor, [dodge.uuid]: dodge, [other.uuid]: other })[uuid] ?? null;
  return { actor, attack, hints, setEncumbered: (v) => { encumbered = v; }, counts: () => ({ spent, tracker, hintUpdates, attackUpdates }) };
}

test("onAttackMessage: encumbered excludes Nimble Dodge by source, but keeps other reactions", async () => {
  const f = fixture();
  await onAttackMessage(f.attack);
  assert.deepEqual(f.hints.map((m) => m.flags[MOD].reaction.item), ["Item.dodge", "Item.other"]);
  f.setEncumbered(true);
  await onAttackMessage(f.attack);
  assert.deepEqual(f.hints.slice(2).map((m) => m.flags[MOD].reaction.item), ["Item.other"]);
});

test("onAttackMessage: Nimble Dodge identified by slug without a source UUID", async () => {
  const f = fixture({ sourceOnly: false });
  f.setEncumbered(true);
  await onAttackMessage(f.attack);
  assert.deepEqual(f.hints.map((m) => m.flags[MOD].reaction.item), ["Item.other"]);
});

test("useReaction: newly encumbered actor cannot use an earlier Nimble Dodge hint", async () => {
  const f = fixture();
  await onAttackMessage(f.attack);
  f.setEncumbered(true);
  const result = await useReaction(f.hints[0].id);
  assert.deepEqual([result.ok, result.reason, result.error], [false, "encumbered", "PF2E_AUTOMATO.reactions.encumbered"]);
  assert.deepEqual(f.counts(), { spent: 0, tracker: 0, hintUpdates: 0, attackUpdates: 0 });
  assert.equal(f.hints[0].flags[MOD].reaction.used, false);
});

test("useReaction: available Nimble Dodge works; encumbered does not block another slug", async () => {
  const normal = fixture();
  await onAttackMessage(normal.attack);
  assert.equal((await useReaction(normal.hints[0].id)).ok, true);
  assert.deepEqual(normal.counts(), { spent: 1, tracker: 1, hintUpdates: 1, attackUpdates: 1 });
  assert.equal(normal.hints[0].flags[MOD].reaction.used, true);
  assert.equal(normal.attack.flags[MOD].gate.degree, 1);

  const encumbered = fixture();
  encumbered.setEncumbered(true);
  await onAttackMessage(encumbered.attack);
  assert.equal(encumbered.hints[0].flags[MOD].reaction.item, "Item.other");
  assert.equal((await useReaction(encumbered.hints[0].id)).ok, true);
  assert.deepEqual(encumbered.counts(), { spent: 1, tracker: 1, hintUpdates: 1, attackUpdates: 1 });
});

const circ = (modifier, type = "circumstance") => ({ type, modifier, enabled: true });

test("Nimble Dodge: +2 does not stack with an existing circumstance AC bonus", async () => {
  const hinted = async (mods) => { const f = fixture(); f.actor.armorClass = { modifiers: mods }; await onAttackMessage(f.attack); return f.hints.map((m) => m.flags[MOD].reaction).find((h) => h.item === "Item.dodge"); };
  assert.equal((await hinted([circ(1)])).bonus, 1);
  assert.equal(await hinted([circ(2)]), undefined);
  assert.equal((await hinted([])).bonus, 2);
  assert.equal((await hinted([circ(-2), circ(2, "item")])).bonus, 2);
});

test("Nimble Dodge: no hint when blinded or the attacker is unseen; use is rejected too", async () => {
  const f = fixture();
  f.actor.hasCondition = (s) => s === "blinded";
  await onAttackMessage(f.attack);
  assert.deepEqual(f.hints.map((m) => m.flags[MOD].reaction.item), ["Item.other"]);
  for (const s of ["invisible", "hidden", "undetected", "unnoticed"]) {
    const g = fixture();
    g.attack.actor = { hasCondition: (c) => c === s };
    await onAttackMessage(g.attack);
    assert.deepEqual(g.hints.map((m) => m.flags[MOD].reaction.item), ["Item.other"], s);
  }
  const u = fixture();
  await onAttackMessage(u.attack);
  u.attack.actor = { hasCondition: (c) => c === "hidden" };
  assert.equal((await useReaction(u.hints[0].id)).reason, "unseen");
});

test("useReaction: removing the ability invalidates its earlier hint without spending resources", async () => {
  const f = fixture();
  await onAttackMessage(f.attack);
  f.setEncumbered(true);
  const resolve = globalThis.fromUuid;
  globalThis.fromUuid = async (uuid) => uuid === "Item.dodge" ? null : resolve(uuid);
  const result = await useReaction(f.hints[0].id);
  assert.deepEqual([result.ok, result.reason], [false, "item-gone"]);
  assert.deepEqual(f.counts(), { spent: 0, tracker: 0, hintUpdates: 0, attackUpdates: 0 });
  assert.equal(f.hints[0].flags[MOD].reaction.used, false);
});
