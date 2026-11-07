import { test } from "node:test";
import assert from "node:assert/strict";
import { recalcWithBonus, ruleOfItem } from "../scripts/reactions.mjs";
import { initCatalog } from "../scripts/rules.mjs";

// Минимальное attack-roll сообщение: итог, нат. d20, степень, СЛ.
const msg = (total, die, degree, dc) => ({
  rolls: [{ total, options: { degreeOfSuccess: degree }, dice: [{ faces: 20, total: die }] }],
  flags: { pf2e: { context: { dc: { value: dc } } } }
});

test("recalcWithBonus: +2 КБ меняет исход на границе", () => {
  assert.deepEqual(recalcWithBonus(msg(15, 10, 2, 15), 2), { before: 2, after: 1, changes: true });
  assert.deepEqual(recalcWithBonus(msg(17, 10, 2, 15), 2), { before: 2, after: 2, changes: false });
});

test("recalcWithBonus: крит -> успех на границе +10", () => {
  assert.deepEqual(recalcWithBonus(msg(25, 12, 3, 15), 2), { before: 3, after: 2, changes: true });
  assert.deepEqual(recalcWithBonus(msg(27, 12, 3, 15), 2), { before: 3, after: 3, changes: false });
});

test("recalcWithBonus: нат.20 и нат.1 сохраняют сдвиг степени", () => {
  // 15 vs КБ 15 нат.20: успех->крит (3); с +2 КБ: провал+1 = успех -> крит теряется
  assert.deepEqual(recalcWithBonus(msg(15, 20, 3, 15), 2), { before: 3, after: 2, changes: true });
  // 25 vs 15 нат.20: клэмп 3 и при +2
  assert.equal(recalcWithBonus(msg(25, 20, 3, 15), 2).after, 3);
  // нат.1: 25 vs 15 -> крит-1=2; при КБ 17 успех-1=1 -> сдвиг -1
  assert.deepEqual(recalcWithBonus(msg(25, 1, 2, 15), 2), { before: 2, after: 1, changes: true });
  // степень уже скорректирована pf2e (3): delta по сырым итогам 2->1, итог 2
  assert.deepEqual(recalcWithBonus(msg(15, 10, 3, 15), 2), { before: 3, after: 2, changes: true });
});

test("recalcWithBonus: без СЛ/итога — без изменений; промах не ухудшается ниже 0", () => {
  assert.equal(recalcWithBonus({ rolls: [], flags: {} }, 2).changes, false);
  assert.deepEqual(recalcWithBonus(msg(5, 3, 0, 15), 2), { before: 0, after: 0, changes: false });
});

test("useReaction: реакция уже потрачена в этом раунде -> отказ, hint не обновляется", async () => {
  const { useReaction } = await import("../scripts/reactions.mjs");
  let updated = 0;
  const hint = { flags: { "pf2e-automato": { reaction: { attack: "a1", actor: "Actor.1", item: "Item.2", bonus: 2, used: false } } }, update: async () => { updated++; } };
  const attack = msg(15, 10, 2, 15);
  const actor = { uuid: "Actor.1", getFlag: () => ({ combat: "c1", round: 3 }) };
  globalThis.game = { combats: [{ id: "c1", round: 3, active: true, scene: "s", combatants: [{ actor }] }], messages: { get: (id) => (id === "h1" ? hint : attack) }, i18n: { localize: (k) => k, format: (k) => k }, modules: { get: () => null } };
  globalThis.fromUuid = async () => actor;
  const res = await useReaction("h1");
  assert.deepEqual([res.ok, res.reason, updated], [false, "spent", 0]);
});

test("ruleOfItem: ищет как resolveRule — slug@type и армейские способности не по общему slug", () => {
  const r = (v) => ({ v: 1, onAttacked: { trigger: "attack-on-self", bonus: { stat: "ac", type: "circumstance", value: v }, cost: "reaction", notify: ["owner"] } });
  initCatalog([{ bySlug: { dodge: r(1), "twin@action": r(2) } }], {});
  const it = (slug, type) => ({ type, name: slug, slug, system: { slug }, _stats: {} });
  assert.equal(ruleOfItem(it("dodge", "feat")).onAttacked.bonus.value, 1);
  assert.equal(ruleOfItem(it("dodge", "campaignFeature")), null);   // армейская способность общий slug не берёт
  assert.equal(ruleOfItem(it("twin", "action")).onAttacked.bonus.value, 2);
  assert.equal(ruleOfItem(it("twin", "feat")), null);
});
