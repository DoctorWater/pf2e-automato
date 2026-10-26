import test from "node:test";
import assert from "node:assert/strict";
import { triageItem, makeContext, objectOnly } from "../tools/triage.mjs";
import { normItem } from "../tools/extract.mjs";

const labels = {};
const ctx = makeContext({ refs: { conditions: {}, effects: {} }, labels });
const base = { uuid: "Compendium.pf2e.x.Item.1", pack: "x", type: "spell", slug: "s", name: "S", nameRu: null, level: 1, rank: 1, traits: [], category: null, actionType: null, cost: "2", frequency: null, range: null, area: null, defense: null, duration: null, target: null, selfEffect: null, ruleKeys: [], source: null, embedded: null, dupTop: null };
const html = "<p>@Check[will|dc:20] The target is dazzled for 1 minute.</p>";

test("extract: ritual берётся из system.ritual", () => {
  const doc = (system) => ({ type: "spell", name: "R", system });
  assert.equal(normItem(doc({ ritual: { primary: { check: "Arcana" } } }), { pack: "x", uuid: "u" }).rec.ritual, true);
  assert.equal(normItem(doc({}), { pack: "x", uuid: "u" }).rec.ritual, false);
});

test("triage: ритуал -> skip: ritual, принятое правило важнее", () => {
  const r = triageItem({ ...base, ritual: true }, html, ctx);
  assert.deepEqual([r.status, r.reason], ["skip", "ritual"]);
  assert.notEqual(triageItem({ ...base, ritual: true }, html, { ...ctx, accepted: new Set([base.uuid]) }).reason, "ritual");
  assert.notEqual(triageItem({ ...base, ritual: false }, html, ctx).reason, "ritual");
});

test("triage: цель только объект/стена -> skip: object-target", () => {
  const o = (target) => triageItem({ ...base, target }, html, ctx);
  assert.equal(o("1 unattended object of light Bulk or less").reason, "object-target");
  assert.equal(o("a wall or other solid, immobile surface").reason, "object-target");
  assert.notEqual(o("1 creature or object").reason, "object-target");
  assert.notEqual(o("1 spell effect or unattended magic item").reason, "object-target");
  assert.equal(objectOnly({ ...base, target: "1 object", embedded: {} }), false);
  assert.notEqual(triageItem({ ...base, target: "1 object" }, html, { ...ctx, accepted: new Set([base.uuid]) }).reason, "object-target");
});

test("triage: ссылки на справочные паки не мешают selfEffect, на состояния — мешают", () => {
  const eff = "Compendium.pf2e.feat-effects.Item.Z";
  const act = { ...base, type: "action", actionType: "action", cost: "1", selfEffect: eff };
  const ref = "@UUID[Compendium.pf2e.actionspf2e.Item.abcdefghijklmnop]{Stride}";
  assert.equal(triageItem(act, `<p>You gain @UUID[${eff}]{E}, then ${ref}. See @UUID[Compendium.pf2e.feats-srd.Item.x1]{F}.</p>`, ctx).status, "pf2e");
  assert.notEqual(triageItem(act, `<p>You gain @UUID[${eff}]{E} and @UUID[Compendium.pf2e.conditionitems.Item.pronepronepronep]{Prone}.</p>`, ctx).status, "pf2e");
});

test("triage: objectOnly не трогает документы с defense или ссылкой на *-effects", () => {
  const rope = { ...base, target: "1 rope" };
  assert.equal(objectOnly(rope, html), true);
  assert.equal(objectOnly({ ...rope, defense: { save: "reflex", basic: false } }, html), false);
  assert.equal(objectOnly(rope, "<p>@UUID[Compendium.pf2e.spell-effects.Item.abc]{Effect}</p>"), false);
});

test("triage: Raise a Shield / Take Cover — механика, selfEffect не закрывает документ", () => {
  const eff = "Compendium.pf2e.feat-effects.Item.Z";
  const act = { ...base, type: "action", actionType: "action", cost: "1", selfEffect: eff };
  const raise = "@UUID[Compendium.pf2e.actionspf2e.Item.xjGwis0uaC2305pm]{Raise a Shield}";
  assert.notEqual(triageItem(act, `<p>You ${raise} and become anchored, gaining @UUID[${eff}]{E}.</p>`, ctx).status, "pf2e");
  assert.notEqual(triageItem(act, `<p>You @UUID[Compendium.pf2e.actionspf2e.Item.ust1jJSCZQUhBZIz]{Take Cover}, gaining @UUID[${eff}]{E}.</p>`, ctx).status, "pf2e");
});
