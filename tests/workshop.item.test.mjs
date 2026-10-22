import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { blankItem, cleanCopy, modelFromSource, buildItem, validate, ruleOf, descHtml, descPreview, withEffectLink, coinsOf, gpOf, rulesOf, facts, bulkText, actText, blockText } from "../scripts/workshop/item.mjs";
import { validateRule, slugOf, sourceOf } from "../scripts/rules.mjs";
import { blankBlock } from "../scripts/workshop/effect.mjs";

const t = (k, d) => (d ? `${k}${JSON.stringify(d)}` : k);
const ctx = { t };
const EFF = { uuid: "Item.abc123", name: "Отвар" };
const M = (type, patch = {}) => ({ ...blankItem(type), name: "Вещь", ...patch });

test("очистка копии: нет _id, источника, slug, babele; остальное сохранено", () => {
  const src = { _id: "X", name: "Healing Potion", type: "consumable", img: "i.webp", folder: "F", sort: 5, ownership: { default: 0 },
    _stats: { compendiumSource: "Compendium.pf2e.equipment-srd.Item.X", coreVersion: "14" },
    flags: { core: { sourceId: "Compendium.pf2e.equipment-srd.Item.X" }, babele: { originalName: "Healing Potion" }, pf2e: { keep: 1 } },
    system: { slug: "healing-potion", level: { value: 3 }, rules: [{ key: "FlatModifier" }] } };
  const c = cleanCopy(src);
  for (const k of ["_id", "folder", "sort", "ownership", "_stats"]) assert.ok(!(k in c), k);
  assert.deepEqual(c.flags, { pf2e: { keep: 1 } });
  assert.equal(c.system.slug, null);
  assert.deepEqual(c.system.rules, [{ key: "FlatModifier" }]);
  assert.equal(src._id, "X");   // оригинал не тронут
  // модуль не узнаёт оригинал ни по slug, ни по источнику
  assert.equal(slugOf(null, { system: c.system, flags: c.flags }), null);
  assert.equal(sourceOf(null, { flags: c.flags, _stats: c._stats }), null);
});

test("модель из source: цена в золотых, черты без редкости, поля по типам", () => {
  const m = modelFromSource({ _id: "A", name: "Dagger", type: "weapon", img: "d.webp", system: { level: { value: 0 }, price: { value: { sp: 2 } }, bulk: { value: 0.1 }, traits: { value: ["agile", "uncommon"], rarity: "uncommon" }, category: "simple", group: "knife", damage: { dice: 1, die: "d4", damageType: "piercing" }, range: null, usage: { value: "held-in-one-hand" }, description: { value: "<p>x</p>" } } });
  assert.equal(m.price, 0.2);
  assert.deepEqual(m.traits, ["agile"]);
  assert.equal(m.rarity, "uncommon");
  assert.deepEqual(m.weapon, { category: "simple", group: "knife", dice: 1, die: "d4", dmgType: "piercing", kind: "melee", range: 30 });
  assert.equal(m.src.system.slug, null);
  const a = modelFromSource({ name: "Strike", type: "action", system: { actionType: { value: "reaction" }, actions: { value: null }, selfEffect: { uuid: "Item.e", name: "E" } } });
  assert.deepEqual(a.act, { type: "reaction", actions: 1 });
  assert.deepEqual(a.effect, { uuid: "Item.e", name: "E" });
});

test("цена: золотые <-> монеты pf2e", () => {
  assert.deepEqual(coinsOf(12), { gp: 12 });
  assert.deepEqual(coinsOf(0.25), { sp: 2, cp: 5 });
  assert.deepEqual(coinsOf(0), {});
  assert.equal(gpOf({ pp: 1, gp: 2, sp: 3, cp: 4 }), 12.34);
  assert.equal(bulkText(0.1, t), "workshop.item.bulkL");
  assert.equal(bulkText(0, t), "—");
  assert.equal(bulkText(2, t), "2");
});

test("расходник: поля pf2e и правило автоматизации во флаге", () => {
  const it = buildItem(M("consumable", { name: " Отвар ", level: "3", price: 12, rarity: "uncommon", category: "elixir", uses: "2", traits: ["magical"], effect: EFF, to: "target", activation: "1" }), ctx);
  assert.equal(it.name, "Отвар");
  assert.equal(it.type, "consumable");
  assert.equal(it.system.level.value, 3);
  assert.deepEqual(it.system.price.value, { gp: 12 });
  assert.equal(it.system.bulk.value, 0.1);
  assert.equal(it.system.traits.rarity, "uncommon");
  assert.deepEqual(it.system.traits.value, ["magical"]);
  assert.equal(it.system.category, "elixir");
  assert.deepEqual(it.system.uses, { value: 2, max: 2, autoDestroy: true });
  assert.match(it.system.description.value, /<strong>workshop\.item\.activate<\/strong> <span class="action-glyph">1<\/span>/);
  assert.match(it.system.description.value, /<p>@UUID\[Item\.abc123\]\{Отвар\}<\/p>$/);
  const r = validateRule(it.flags["pf2e-automato"].rule);
  assert.ok(r.ok, r.errors.join());
  assert.deepEqual(r.rule.onUse.apply, [{ to: "target", effect: { uuid: "Item.abc123" } }]);
  assert.equal(r.rule.onUse.targets, "selected");
  assert.equal(buildItem(M("consumable", { effect: EFF, to: "self" }), ctx).flags["pf2e-automato"].rule.onUse.targets, "self");
  assert.equal(buildItem(M("consumable", { effect: EFF, auto: false }), ctx).flags, undefined);
  assert.equal(buildItem(M("consumable"), ctx).flags, undefined);
});

test("правило расходника валидно и не создаётся без эффекта / не для других типов", () => {
  assert.equal(ruleOf(M("consumable")), null);
  assert.equal(ruleOf(M("equipment", { effect: EFF })), null);
  assert.ok(validateRule(ruleOf(M("consumable", { effect: EFF }))).ok);
});

test("описание: простой текст — абзацы, готовый HTML — как есть, ссылка на эффект не дублируется", () => {
  assert.equal(descHtml(M("equipment", { desc: "а <б>\nвторая" }), t), "<p>а &lt;б&gt;</p><p>вторая</p>");
  assert.equal(descHtml(M("equipment", { desc: "<p>да</p>" }), t), "<p>да</p>");
  const has = descHtml(M("consumable", { desc: "Получает @UUID[Item.abc123]{Отвар}.", effect: EFF }), t);
  assert.equal(has.match(/@UUID/g).length, 1);
  assert.equal(descHtml(M("action", { desc: "x", effect: EFF }), t), "<p>x</p>");   // у действия ссылку рисует pf2e по selfEffect
  assert.equal(withEffectLink("текст", null, EFF), "текст\n@UUID[Item.abc123]{Отвар}");
  assert.equal(withEffectLink("текст\n@UUID[Item.abc123]{Отвар}", EFF, { uuid: "Item.z", name: "Z" }), "текст\n@UUID[Item.z]{Z}");
  assert.equal(withEffectLink("текст\n@UUID[Item.abc123]{Отвар}", EFF, null), "текст");
  assert.equal(withEffectLink("<p>да</p>", null, EFF), "<p>да</p><p>@UUID[Item.abc123]{Отвар}</p>");   // у копии описание — HTML
  assert.equal(withEffectLink("<p>да</p><p>@UUID[Item.abc123]{Отвар}</p>", EFF, null), "<p>да</p>");
  assert.equal(descPreview("<p>A &amp; B @UUID[Item.x]{Имя}</p><p><b>Z</b></p>"), '<p>A &amp; B <span class="ws-ref">Имя</span></p><p>Z</p>');
});

test("снаряжение: кубики эффекта — в system.rules, usage; без predicate (pf2e сам требует надетого)", () => {
  const it = buildItem(M("equipment", { usage: "worn", traits: ["invested", "magical"], blocks: [{ ...blankBlock("bonus"), value: 1 }, { ...blankBlock("resist") }] }), ctx);
  assert.deepEqual(it.system.rules.map((r) => r.key), ["FlatModifier", "Resistance"]);
  assert.ok(it.system.rules.every((r) => !("predicate" in r)));
  assert.equal(it.system.usage.value, "worn");
  assert.equal(it.flags, undefined);
});

test("оружие: база, диапазон, селекторы кубиков сужены до самого оружия", () => {
  const w = { category: "martial", group: "sword", dice: "2", die: "d8", dmgType: "fire", kind: "ranged", range: "60" };
  const it = buildItem(M("weapon", { weapon: w, usage: "held-in-two-hands", blocks: [{ ...blankBlock("dmg") }, { ...blankBlock("bonus"), target: "attack-roll" }, { ...blankBlock("bonus"), target: "ac" }] }), ctx);
  assert.equal(it.system.category, "martial");
  assert.equal(it.system.group, "sword");
  assert.deepEqual(it.system.damage, { dice: 2, die: "d8", damageType: "fire" });
  assert.equal(it.system.range, 60);
  assert.equal(it.system.usage.value, "held-in-two-hands");
  assert.deepEqual(it.system.rules.map((r) => r.selector), ["{item|id}-damage", "{item|id}-attack", "ac"]);
  assert.equal(buildItem(M("weapon"), ctx).system.range, null);
  assert.equal(buildItem(M("weapon"), ctx).system.group, null);
  assert.deepEqual(rulesOf(M("consumable", { blocks: [blankBlock("bonus")] }), ctx), []);
});

test("действие и черта: тип действия, число действий, selfEffect {uuid,name}", () => {
  const a = buildItem(M("action", { act: { type: "action", actions: "2" }, effect: EFF, category: "offensive" }), ctx);
  assert.equal(a.system.actionType.value, "action");
  assert.equal(a.system.actions.value, 2);
  assert.deepEqual(a.system.selfEffect, EFF);
  assert.equal(a.system.category, "offensive");
  assert.ok(!("level" in a.system));
  assert.ok(!("rarity" in (a.system.traits ?? {})));
  const r = buildItem(M("action", { act: { type: "reaction", actions: 2 }, effect: EFF }), ctx);
  assert.equal(r.system.actions.value, null);
  assert.equal(r.system.category, null);
  const p = buildItem(M("feat", { level: 2, act: { type: "passive", actions: 1 }, effect: EFF, category: "skill" }), ctx);
  assert.equal(p.system.selfEffect, null);   // пассивным selfEffect нельзя
  assert.equal(p.system.category, "skill");
  assert.equal(p.system.level.value, 2);
  assert.equal(p.system.traits.rarity, "common");
});

test("копия: из source берётся основа, свои поля мастера перекрывают, правила оригинала и кубики складываются", () => {
  const src = { _id: "Z", name: "Ring", type: "equipment", system: { slug: "ring", level: { value: 5 }, rules: [{ key: "TempHP", value: 5 }], price: { value: { gp: 100 }, per: 1 }, runes: { keep: true } } };
  const m = { ...modelFromSource(src), name: "Моё кольцо", blocks: [{ ...blankBlock("fastheal") }] };
  const it = buildItem(m, ctx);
  assert.equal(it.name, "Моё кольцо");
  assert.ok(!("_id" in it));
  assert.equal(it.system.slug, "моё-кольцо");
  assert.equal(it.system.runes.keep, true);
  assert.equal(it.system.price.per, 1);
  assert.deepEqual(it.system.rules.map((r) => r.key), ["TempHP", "FastHealing"]);
});

test("проверка: понятные ошибки и граничные значения", () => {
  const e = (m) => validate(m, ctx);
  assert.deepEqual(e(M("consumable")), []);
  assert.deepEqual(e(M("action")), []);
  assert.match(e({ ...M("consumable"), name: " " })[0], /err\.name/);
  assert.match(e(M("consumable", { level: -1 }))[0], /err\.level/);
  assert.match(e(M("feat", { level: 0 }))[0], /levelFeat/);
  assert.match(e(M("feat", { level: 31 }))[0], /levelFeat/);
  assert.deepEqual(e(M("feat", { level: 1 })), []);
  assert.match(e(M("equipment", { price: -2 }))[0], /err\.price/);
  assert.match(e(M("consumable", { uses: 0 }))[0], /err\.uses/);
  assert.match(e(M("weapon", { weapon: { ...blankItem().weapon, dice: 0 } }))[0], /err\.dice/);
  assert.match(e(M("weapon", { weapon: { ...blankItem().weapon, kind: "ranged", range: 3 } }))[0], /err\.range/);
  assert.deepEqual(e(M("weapon", { weapon: { ...blankItem().weapon, kind: "ranged", range: 30 } })), []);
  assert.match(e(M("equipment", { blocks: [{ ...blankBlock("bonus"), value: 0 }] }))[0], /err\.block/);
  assert.deepEqual(e(M("consumable", { blocks: [{ ...blankBlock("bonus"), value: 0 }] })), []);   // кубики есть только у снаряжения/оружия
});

test("карточка: цена, масса, активация, урон", () => {
  const f = facts(M("consumable", { price: 12, bulk: 0.1, activation: "2" }), t);
  assert.deepEqual(f.map((x) => x.label), ["workshop.item.fPrice", "workshop.item.fBulk", "workshop.item.activate"]);
  assert.match(f[0].text, /"n":12/);
  assert.equal(facts(M("action"), t).length, 1);
  assert.equal(actText(M("feat"), t), "workshop.item.act.passive");
  assert.equal(actText(M("action", { act: { type: "action", actions: 3 } }), t), "workshop.item.act.n3");
  assert.equal(actText(M("equipment", { activation: "reaction" }), t), "workshop.item.act.reaction");
  assert.equal(facts(M("weapon", { weapon: { ...blankItem().weapon, kind: "ranged" } }), t).length, 4);
});

test("GrantItem в физическом предмете — inMemoryOnly, без onDeleteActions; эффект вместо состояния — ошибка", () => {
  const cond = { ...blankBlock("cond"), slug: "frightened" };
  const c = { t, uuidOf: () => "Compendium.pf2e.conditionitems.Item.F" };
  for (const type of ["equipment", "weapon"]) {
    const [r] = rulesOf(M(type, { blocks: [cond] }), c);
    assert.deepEqual(r, { key: "GrantItem", uuid: "Compendium.pf2e.conditionitems.Item.F", inMemoryOnly: true });
  }
  assert.equal(rulesOf(M("equipment", { blocks: [{ ...cond, valued: true, value: 2 }] }), c)[0].alterations[0].value, 2);
  assert.deepEqual(validate(M("equipment", { blocks: [cond] }), c), []);
  assert.match(validate(M("equipment", { blocks: [{ ...blankBlock("cond"), uuid: "Item.e", name: "E" }] }), c)[0], /condEffect/);
});

test("slug: явный, не совпадает со slug оригинала; roll options не узнают оригинал", () => {
  const src = { name: "Healing Potion", type: "consumable", system: { slug: "healing-potion", uses: { value: 1, max: 1, autoDestroy: false } } };
  const m = { ...modelFromSource(src), name: "Healing Potion" };
  assert.equal(m.baseSlug, "healing-potion");
  const it = buildItem(m, ctx);
  assert.equal(it.system.slug, "healing-potion-custom");
  assert.equal(slugOf({ rollOptions: [`origin:item:slug:${it.system.slug}`] }, null), "healing-potion-custom");
  assert.equal(buildItem({ ...m, name: "Мой Эликсир 2 Elixir" }, ctx).system.slug, "мой-эликсир-2-elixir");
  assert.equal(buildItem({ ...m, name: "Зелье" }, ctx).system.slug, "зелье");   // кириллица сохраняется, как в pf2e
  assert.equal(buildItem(M("consumable", { name: "Fire Oil" }), ctx).system.slug, "fire-oil");
  assert.equal(it.system.uses.autoDestroy, false);   // у копии сохраняется
  assert.equal(buildItem(M("consumable"), ctx).system.uses.autoDestroy, true);
});

test("новый расходник с чертой consumable; метательное ближнее оружие остаётся ближним и не теряет range", () => {
  assert.deepEqual(blankItem("consumable").traits, ["consumable"]);
  assert.deepEqual(blankItem("equipment").traits, []);
  const src = { name: "Dagger", type: "weapon", system: { range: 10, traits: { value: ["thrown-10", "agile"] }, damage: { dice: 1, die: "d4", damageType: "piercing" } } };
  const m = modelFromSource(src);
  assert.equal(m.weapon.kind, "melee");
  assert.equal(buildItem(m, ctx).system.range, 10);
  assert.equal(modelFromSource({ ...src, system: { ...src.system, traits: { value: ["thrown"] } } }).weapon.kind, "ranged");
  assert.equal(buildItem({ ...m, traits: [] }, ctx).system.range, null);
});

test("активация: не дублируется, если в описании копии есть; подпись у действия — «Действия»; текст кубиков оружия", () => {
  assert.doesNotMatch(descHtml(M("equipment", { desc: '<p><strong>Activate</strong> <span class="action-glyph">1</span></p>', activation: "2" }), t), /<strong>workshop/);
  assert.equal(facts(M("action"), t)[0].label, "workshop.item.fActions");
  assert.equal(facts(M("consumable", { activation: "1" }), t).at(-1).label, "workshop.item.activate");
  assert.match(blockText("weapon", blankBlock("dmg"), ctx), /wText\.dmg/);
  assert.match(blockText("weapon", { ...blankBlock("bonus"), target: "attack-roll" }, ctx), /wText\.attack.*\+1/);
  assert.match(blockText("equipment", blankBlock("bonus"), ctx), /text\.bonus/);
});

test("сырой GrantItem в физическом предмете: нужен inMemoryOnly и UUID состояния; GrantItem из raw не правим", () => {
  const raw = (o) => ({ ...blankBlock("raw"), json: JSON.stringify(o) });
  const U = "Compendium.pf2e.conditionitems.Item.F";
  const e = (o) => validate(M("equipment", { blocks: [raw(o)] }), ctx);
  assert.deepEqual(e({ key: "GrantItem", uuid: U, inMemoryOnly: true }), []);
  assert.match(e({ key: "GrantItem", uuid: U })[0], /rawGrant/);
  assert.match(e({ key: "GrantItem", uuid: "Compendium.pf2e.equipment-srd.Item.X", inMemoryOnly: true })[0], /rawGrant/);
  assert.deepEqual(e({ key: "FlatModifier", selector: "ac", value: 1 }), []);
  assert.deepEqual(rulesOf(M("equipment", { blocks: [raw({ key: "GrantItem", uuid: U })] }), ctx), [{ key: "GrantItem", uuid: U }]);
});

test("шаблон кубиков: сводка в .ws-text, в textarea «Заметки» — настоящий text (а не сводка)", () => {
  const html = readFileSync(new URL("../templates/workshop-blocks.hbs", import.meta.url), "utf8");
  assert.match(html, /class="ws-text"[^>]*>\{\{b\.summary\}\}/);
  assert.match(html, /data-f="text"[^>]*>\{\{b\.text\}\}<\/textarea>/);
  assert.ok(!/ws-text[^>]*>\{\{b\.text\}\}/.test(html));
});
