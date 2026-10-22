import { test } from "node:test";
import assert from "node:assert/strict";
globalThis.game = { user: { isActiveGM: true }, settings: { get: () => "auto" }, i18n: { localize: (k) => k, format: (k) => k } };
const sb = await import("../scripts/builtin/shield-block.mjs");

const spell = { raised: true, hardness: 5, itemId: "eff" };
test("поднятый щит: сломанный/опущенный/уничтоженный не считаются", () => {
  assert.equal(sb.raisedShield(spell).hardness, 5);
  assert.equal(sb.raisedShield({ ...spell, raised: false }), null);
  assert.equal(sb.raisedShield({ ...spell, broken: true }), null);
  assert.equal(sb.raisedShield({ ...spell, destroyed: true }), null);
  assert.equal(sb.raisedShield(undefined), null);
});
test("цели: toolbelt > контекст pf2e > выбранные автором, без дублей", () => {
  const m = { flags: { "pf2e-toolbelt": { targetHelper: { targets: ["a", "b", "a"] } }, pf2e: { context: { target: { token: "c" } } } } };
  assert.deepEqual(sb.damageTargets(m, ["d"]), ["a", "b"]);
  assert.deepEqual(sb.damageTargets({ flags: { pf2e: { context: { target: { token: "c" } } } } }, ["d"]), ["c"]);
  assert.deepEqual(sb.damageTargets({ flags: {} }, ["d"]), ["d"]);
});
test("уже применено: toolbelt applied или наша метка", () => {
  assert.equal(sb.alreadyApplied({ flags: { "pf2e-toolbelt": { targetHelper: { applied: { t1: { 0: true } } } } } }, "t1"), true);
  assert.equal(sb.alreadyApplied({ flags: { "pf2e-toolbelt": { targetHelper: { applied: { t1: { 0: false } } } } } }, "t1"), false);
  assert.equal(sb.alreadyApplied({ flags: { "pf2e-automato": { shieldBlock: { done: { t1: true } } } } }, "t1"), true);
  assert.equal(sb.alreadyApplied({ flags: {} }, "t1"), false);
});
const items = new Map([
  ["eff", { id: "eff", type: "effect", slug: "spell-effect-shield" }], ["fire", { id: "fire", type: "effect", slug: "spell-effect-fire-shield" }],
  ["glass", { id: "glass", type: "effect", slug: "spell-effect-glass-shield" }], ["amp", { id: "amp", type: "effect", slug: "spell-effect-shield-amped" }], ["sh", { id: "sh", type: "shield" }]
]);
test("эффект щита: только Щит снимается; Amped ломает слои; Огненный/Стеклянный/предмет — ничего", () => {
  assert.deepEqual(sb.spellShieldEffect({ itemId: "eff" }, items), { id: "eff", slug: "spell-effect-shield", layers: 0 });
  for (const id of ["fire", "glass", "sh"]) assert.equal(sb.spellShieldEffect({ itemId: id }, items), null);
  assert.equal(sb.spellShieldEffect({ itemId: null }, items), null);
  assert.equal(sb.spellShieldEffect({ itemId: "amp" }, items, {}).layers, 1);
  assert.equal(sb.spellShieldEffect({ itemId: "amp" }, items, { "shield-block-layers:2": true }).layers, 2);
  assert.equal(sb.spellShieldEffect({ itemId: "amp" }, items, { "shield-block-layers:2": true, "shield-block-layers:3": true }).layers, 3);
  assert.equal(sb.ampedLeft(3, 1), 2);
  assert.equal(sb.ampedLeft(2, 3) <= 0, true);
});
const dmgMsg = (ctx, kinds = ["damage"]) => ({ flags: { pf2e: { context: ctx } }, rolls: [{ kinds: new Set(kinds) }] });
test("подсказка только для урона атаки", () => {
  assert.equal(sb.isAttackDamage(dmgMsg({ type: "damage-roll", sourceType: "attack" })), true);
  assert.equal(sb.isAttackDamage(dmgMsg({ type: "damage-roll", sourceType: "save" })), false);
  assert.equal(sb.isAttackDamage(dmgMsg({ type: "damage-roll", sourceType: "attack" }, ["healing"])), false);
  assert.equal(sb.isAttackDamage(dmgMsg({ type: "attack-roll", sourceType: "attack" })), false);
});
test("проверка подсказки: ГМ-автор, тег, токен того же актёра, карточка урона", () => {
  const hint = (o = {}) => ({ flags: { "pf2e-automato": { builtin: "shield-block", shieldBlock: { actor: "A" } } }, author: { isGM: true }, ...o });
  const dmg = dmgMsg({ type: "damage-roll" }), tok = { actor: { uuid: "A" } };
  assert.equal(sb.checkHint(hint(), dmg, tok), null);
  assert.equal(sb.checkHint(hint({ author: { isGM: false } }), dmg, tok), "no-hint");
  assert.equal(sb.checkHint({ ...hint(), flags: { "pf2e-automato": { shieldBlock: { actor: "A" } } } }, dmg, tok), "no-hint");
  assert.equal(sb.checkHint(hint(), dmg, { actor: { uuid: "B" } }), "gone");
  assert.equal(sb.checkHint(hint(), dmgMsg({ type: "attack-roll" }), tok), "gone");
  assert.equal(sb.checkHint(hint(), null, tok), "gone");
});
test("блок состоялся только при запросе, поднятом щите, твёрдости и уроне", () => {
  assert.equal(sb.blockHappened({ request: true, damage: 8, shield: spell }), true);
  assert.equal(sb.blockHappened({ request: true, damage: { total: 8 }, shield: spell }), true);
  assert.equal(sb.blockHappened({ request: false, damage: 8, shield: spell }), false);
  assert.equal(sb.blockHappened({ request: true, damage: -3, shield: spell }), false);
  assert.equal(sb.blockHappened({ request: true, damage: 8, shield: { ...spell, raised: false } }), false);
  assert.equal(sb.blockHappened({ request: true, damage: 8, shield: { ...spell, hardness: 0 } }), false);
});
test("уже применено: метка штатной кнопки pf2e и метка нашего блока — одна и та же", () => {
  assert.equal(sb.alreadyApplied({ flags: { "pf2e-automato": { shieldBlock: { done: { t2: true } } } } }, "t2"), true);
  assert.equal(sb.alreadyApplied({ flags: { "pf2e-automato": { shieldBlock: { done: { t2: true } } } } }, "t1"), false);
});
