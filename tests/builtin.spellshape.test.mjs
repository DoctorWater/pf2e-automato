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
  assert.equal(ss.recentShape([use, msg("feat", [], "Actor.a", "Item.x")], "Actor.a", opt), null);   // другая способность после метамагии: срок вышел
  assert.equal(ss.recentShape([use, msg("feat", [], "Actor.b", "Item.x")], "Actor.a", opt), "spellshape:reach-spell");   // чужая способность другого актёра не в счёт
  const roll = (type, origin) => ({ actor: { uuid: "Actor.a" }, flags: { pf2e: { context: { type }, ...(origin && { origin }) } } });
  assert.equal(ss.recentShape([use, roll("attack-roll")], "Actor.a", opt), null);   // Удар между метамагией и сотворением
  const act = roll("skill-check"); act.flags.pf2e.context.options = ["action:grapple"];
  assert.equal(ss.recentShape([use, act], "Actor.a", opt), null);   // проверка как действие
  assert.equal(ss.recentShape([use, roll("skill-check")], "Actor.a", opt), "spellshape:reach-spell");   // запрос ГМа / тайная проверка — не действие
  assert.equal(ss.recentShape([use, roll("saving-throw")], "Actor.a", opt), "spellshape:reach-spell");   // спасбросок и урон — не действия
  assert.equal(ss.recentShape([use, roll("damage-roll")], "Actor.a", opt), "spellshape:reach-spell");
  assert.equal(ss.recentShape([use, roll("spell-attack-roll", { type: "spell", actor: "Actor.a" })], "Actor.a", opt), "spellshape:reach-spell");   // бросок заклинания — не другое действие
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

const npcFeat = (slug, { type = "action", rules = [], flag, actor = "npc" } = {}) => ({ type, slug, system: { rules }, parent: { type: actor }, flags: flag ? { [MOD]: { spellshape: flag } } : {} });

test("optionOf: Reach Spell NPC без переключателя — по slug; флаг приоритетен; прочее — null", () => {
  assert.equal(ss.optionOf(npcFeat("reach-spell")), "reach-spell");
  assert.equal(ss.optionOf(npcFeat("reach-spell", { type: "feat" })), "reach-spell");
  assert.equal(ss.optionOf(npcFeat("widen-spell", { flag: "widen-spell" })), "widen-spell");   // флаг миграции
  assert.equal(ss.optionOf(npcFeat("quickened-casting")), null);
  assert.equal(ss.optionOf(npcFeat("widen-spell")), null);
  assert.equal(ss.optionOf(npcFeat("reach-spell", { actor: "character" })), null);   // у персонажа — флаг миграции
  assert.equal(ss.optionOf(npcFeat("reach-spell", { rules: [toggle("reach-spell")] })), null);   // переключатель остался (миграция не сняла) — не двоим
  assert.equal(ss.optionOf(npcFeat("reach-spell", { type: "spell" })), null);
});

test("optionOf: перевод без system.slug — по babele.originalName (slugOf)", () => {
  const it = { ...npcFeat(undefined), name: "Дальнее заклинание", flags: { babele: { originalName: "Reach Spell" } } };
  assert.equal(ss.optionOf(it), "reach-spell");
});

test("breaksShape: действие или бросок актёра — да; заклинание, спасбросок, урон, чат — нет", () => {
  const m = (pf) => ({ flags: { pf2e: pf } });
  assert.equal(ss.breaksShape(m({ origin: { type: "feat" } })), true);
  assert.equal(ss.breaksShape(m({ origin: { type: "action" } })), true);
  assert.equal(ss.breaksShape(m({ context: { type: "attack-roll" }, origin: { type: "weapon" } })), true);
  assert.equal(ss.breaksShape(m({ context: { type: "attack-roll" } })), true);
  assert.equal(ss.breaksShape(m({ origin: { type: "spell" } })), false);
  assert.equal(ss.breaksShape(m({ context: { type: "spell-attack-roll" }, origin: { type: "spell" } })), false);
  assert.equal(ss.breaksShape(m({ context: { type: "saving-throw" } })), false);
  assert.equal(ss.breaksShape(m({ context: { type: "damage-roll" } })), false);
  assert.equal(ss.breaksShape({ flags: {} }), false);
  // проверки: только запрошенные как действие
  assert.equal(ss.breaksShape(m({ context: { type: "skill-check", options: ["action:grapple", "check:statistic:athletics"] } })), true);
  assert.equal(ss.breaksShape(m({ context: { type: "skill-check", options: ["check:statistic:athletics"], traits: [{ name: "attack" }] } })), true);
  assert.equal(ss.breaksShape(m({ context: { type: "perception-check", options: ["action:seek"] } })), true);
  assert.equal(ss.breaksShape(m({ context: { type: "perception-check", options: ["check:statistic:perception"], traits: [] } })), false, "тайная Внимательность");
  assert.equal(ss.breaksShape(m({ context: { type: "skill-check", options: [] } })), false, "запрос ГМа без action-опций");
  assert.equal(ss.breaksShape(m({ context: { type: "skill-check" } })), false);
  // self-effect: действие без броска
  assert.equal(ss.breaksShape(m({ context: { type: "self-effect" }, origin: { type: "action" } })), true, "Raise a Shield");
  assert.equal(ss.breaksShape(m({ context: { type: "self-effect" }, origin: { type: "feat" } })), true);
  assert.equal(ss.breaksShape(m({ context: { type: "self-effect" }, origin: { type: "equipment" } })), false);
});

test("onMessage: Удар после метамагии снимает непотраченный эффект; потраченный остаётся; сотворение после Удара — без эффекта", async () => {
  const a = mkActor();
  globalThis.fromUuid = async () => feat(a, "reach-spell");
  await ss.onMessage({ actor: a, flags: { pf2e: { origin: { type: "feat", uuid: "Item.f" } } } });
  assert.equal(effects(a).length, 1);
  await ss.onMessage({ actor: a, flags: { pf2e: { context: { type: "attack-roll" }, origin: { type: "weapon", actor: "Actor.a" } } } });
  assert.equal(effects(a).length, 0);   // Reach Spell -> Удар -> сотворение: +30 фт нет
  await ss.onMessage({ actor: a, flags: { pf2e: { origin: { type: "feat", uuid: "Item.f" } } } });
  await ss.onMessage({ id: "m1", actor: a, flags: { pf2e: { origin: { type: "spell", rollOptions: ["origin:action:slug:cast-a-spell"] } } } });
  await ss.onMessage({ actor: a, flags: { pf2e: { context: { type: "attack-roll" } } } });
  assert.equal(effects(a).length, 1);   // потраченный нужен уже брошенному сотворению
});

test("onMessage: NPC Reach Spell без флага и переключателя вешает эффект", async () => {
  const a = mkActor();
  a.type = "npc";
  globalThis.fromUuid = async () => ({ ...npcFeat("reach-spell"), parent: a, name: "Reach Spell", img: "i", uuid: "Item.f" });
  await ss.onMessage({ actor: a, flags: { pf2e: { origin: { type: "action", uuid: "Item.f" } } } });
  assert.deepEqual(effects(a)[0]?.system.rules.map((r) => r.option), ["spellshape", "spellshape:reach-spell"]);
});

import { existsSync, readFileSync } from "node:fs";
const ITEMS = new URL("../tools/out/items.json", import.meta.url);
test("корпус: все NPC Reach Spell (21 уник. / 30 док.) без переключателя дают reach-spell, с переключателем — тоже (флага нет)", { skip: !existsSync(ITEMS) }, () => {
  const all = JSON.parse(readFileSync(ITEMS, "utf8")).items.filter((i) => i.embedded && (i.type === "action" || i.type === "feat"));
  const reach = all.filter((i) => i.slug === "reach-spell");
  assert.ok(reach.length >= 21);
  // ruleKeys несёт RollOption только у переключателя; без правил optionOf обязан дать опцию, с правилом-переключателем (isShape) — null до миграции
  for (const i of reach.filter((i) => !i.ruleKeys.includes("RollOption"))) assert.equal(ss.optionOf({ type: i.type, slug: i.slug, system: { rules: [] }, parent: { type: "npc" }, flags: {} }), "reach-spell");
  assert.equal(all.filter((i) => i.slug !== "reach-spell" && ss.optionOf({ type: i.type, slug: i.slug, system: { rules: [] }, parent: { type: "npc" }, flags: {} })).length, 0);
});
