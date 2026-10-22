import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game = { user: { isActiveGM: true }, i18n: { localize: (k) => k, format: (k) => k }, users: [], combats: [] };
globalThis.ChatMessage = { create: () => {} };
globalThis.foundry = { utils: { mergeObject: (a, b) => ({ ...a, flags: Object.fromEntries(Object.entries(b.flags).map(([k, v]) => [k, { ...a.flags?.[k], ...v }])) }) } };
const ss = await import("../scripts/builtin/spellshape.mjs");

const toggle = (value, extra = {}) => ({ key: "RollOption", option: "spellshape", toggleable: true, suboptions: [{ value }], ...extra });

test("stripToggle: одна подопция снимается, возвращается значение", () => {
  const rules = [{ key: "ItemAlteration" }, toggle("reach-spell")];
  const r = ss.stripToggle(rules);
  assert.deepEqual(r, { rules: [rules[0]], changed: true, option: "reach-spell" });
  assert.equal(ss.stripToggle(r.rules).changed, false);
});

test("stripToggle: дополнительный выбор, несколько подопций, чужой toggleable — не трогаем", () => {
  const t = toggle("chaotic-spell");
  assert.equal(ss.stripToggle([t, { key: "RollOption", option: "chaotic-spell", toggleable: true }]).changed, false);
  assert.equal(ss.stripToggle([t, { key: "ChoiceSet" }]).changed, false);
  assert.equal(ss.stripToggle([toggle("a", { suboptions: [{ value: "a" }, { value: "b" }] })]).changed, false);
  assert.equal(ss.stripToggle([{ key: "RollOption", option: "other", toggleable: true, suboptions: [{ value: "x" }] }]).changed, false);
});

test("kindOf: сотворение — только с cast-a-spell", () => {
  assert.equal(ss.kindOf({ type: "spell", rollOptions: ["origin:action:slug:cast-a-spell"] }), "cast");
  assert.equal(ss.kindOf({ type: "spell", rollOptions: [] }), null);
  assert.equal(ss.kindOf({ type: "feat" }), "use");
  assert.equal(ss.kindOf({ type: "action" }), "use");
  assert.equal(ss.kindOf({ type: "weapon" }), null);
});

test("effectRules: те же опции, что ставил бы переключатель", () => {
  assert.deepEqual(ss.effectRules("reach-spell").map((r) => r.option), ["spellshape", "spellshape:reach-spell"]);
});

const MOD = "pf2e-automato";
const mkActor = () => {
  const items = [];
  const actor = { name: "A", uuid: "Actor.a", items, createEmbeddedDocuments: async (_t, [d]) => {
    const it = { ...d, type: "effect", update: async (u) => { it.name = u.name; it.flags[MOD].spentBy = u["flags.pf2e-automato.spentBy"]; }, delete: async () => { items.splice(items.indexOf(it), 1); } };
    items.push(it); return [it];
  } };
  return actor;
};
const feat = (actor, option) => ({ parent: actor, name: "Reach", img: "i", uuid: "Item.f", flags: { [MOD]: { spellshape: option } } });
const effects = (a) => a.items.filter((i) => i.type === "effect");

test("onMessage: действие вешает эффект, повтор заменяет, сотворение помечает потраченным, следующее — снимает", async () => {
  const a = mkActor();
  globalThis.fromUuid = async () => feat(a, "reach-spell");
  const use = { actor: a, flags: { pf2e: { origin: { type: "feat", uuid: "Item.f" } } } };
  await ss.onMessage(use);
  assert.equal(effects(a).length, 1);
  assert.deepEqual(effects(a)[0].system.rules.map((r) => r.option), ["spellshape", "spellshape:reach-spell"]);
  await ss.onMessage(use);
  assert.equal(effects(a).length, 1);
  await ss.onMessage({ actor: a, flags: { pf2e: { origin: { type: "spell", rollOptions: [] } } } });
  assert.equal(effects(a).length, 1);   // карточка без сотворения (описание в чат)
  const cast = (id) => ({ id, actor: a, flags: { pf2e: { origin: { type: "spell", rollOptions: ["origin:action:slug:cast-a-spell"] } } } });
  await ss.onMessage(cast("m1"));
  assert.equal(effects(a).length, 1);   // эффект нужен урону/области по этой карточке
  assert.equal(effects(a)[0].flags[MOD].spentBy, "m1");
  assert.match(effects(a)[0].name, /builtin.spellshape.spent/);
  assert.deepEqual(ss.spentOptions(a.items), ["spellshape:reach-spell"]);
  await ss.onMessage(cast("m1"));
  assert.equal(effects(a).length, 1);   // то же сообщение — не снимает
  await ss.onMessage(cast("m2"));
  assert.equal(effects(a).length, 0);
});

test("recentShape: метамагия без сотворения после неё", () => {
  const msg = (type, rollOptions, actor = "Actor.a", uuid = "Item.f") => ({ flags: { pf2e: { origin: { type, rollOptions, actor, uuid } } } });
  const use = msg("feat"), cast = msg("spell", ["origin:action:slug:cast-a-spell"]);
  const opt = (u) => (u === "Item.f" ? "reach-spell" : null);
  assert.equal(ss.recentShape([use], "Actor.a", opt), "spellshape:reach-spell");
  assert.equal(ss.recentShape([use, msg("feat", [], "Actor.a", "Item.x")], "Actor.a", opt), "spellshape:reach-spell");   // чужая черта без флага пропускается
  assert.equal(ss.recentShape([use, cast], "Actor.a", opt), null);   // после метамагии уже сотворяли
  assert.equal(ss.recentShape([use], "Actor.b", opt), null);
  assert.equal(ss.recentShape([use, msg("spell", [])], "Actor.a", opt), "spellshape:reach-spell");   // описание в чат — не сотворение
  assert.equal(ss.recentShape([], "Actor.a", opt), null);
});

test("withToggle: переключатель возвращается как у pf2e и снова снимается", () => {
  const rules = [{ key: "ItemAlteration" }];
  const back = ss.withToggle(rules, "reach-spell", "Reach Spell");
  assert.deepEqual(back[1], { key: "RollOption", option: "spellshape", toggleable: true, mergeable: true, placement: "spellcasting", label: "PF2E.TraitSpellshape", suboptions: [{ label: "Reach Spell", value: "reach-spell" }] });
  assert.equal(ss.withToggle(back, "reach-spell", "x"), null);
  assert.deepEqual(ss.stripToggle(back), { rules, changed: true, option: "reach-spell" });
});

test("restoreItem: при off возвращает переключатель по флагу", async () => {
  const upd = [];
  const item = { type: "feat", name: "Reach", flags: { [MOD]: { spellshape: "reach-spell" } }, system: { rules: [] }, update: async (u) => upd.push(u) };
  await ss.syncItem(item, true);
  assert.equal(upd[0]["system.rules"][0].suboptions[0].value, "reach-spell");
  upd.length = 0;
  await ss.syncItem({ ...item, flags: {} }, true);
  assert.equal(upd.length, 0);
});

test("onMessage: черта без флага (переключатель остался) эффекта не даёт", async () => {
  const a = mkActor();
  globalThis.fromUuid = async () => feat(a, undefined);
  await ss.onMessage({ actor: a, flags: { pf2e: { origin: { type: "feat", uuid: "Item.f" } } } });
  assert.equal(effects(a).length, 0);
});
