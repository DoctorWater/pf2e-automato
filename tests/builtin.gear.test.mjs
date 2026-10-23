// 0.5g5: встроенный gear — временная броня/щит от эффекта. Чистая логика, целостность данных пака, примитив replace.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game = { user: { isActiveGM: true, id: "gm" }, users: [], modules: { get: () => null }, settings: { get: (_m, k) => ({ yieldToAutomations: true })[k] ?? "auto" }, i18n: { localize: (k) => k, format: (k) => k }, pf2e: { ConditionManager: { conditions: new Map() } } };
globalThis.ui = { notifications: { warn() {}, info() {} } };
let registry = new Map();
globalThis.fromUuid = async (u) => registry.get(u) ?? null;
globalThis.fromUuidSync = (u) => registry.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), mergeObject: function merge(a, b) { for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? merge(a[k], v) : v; return a; }, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
globalThis.CONFIG = { PF2E: { Item: { documentClasses: { effect: { validTraits: {} } } } }, Canvas: { polygonBackends: { move: { testCollision: () => false } } } };
globalThis.ChatMessage = { create: async () => {}, getWhisperRecipients: () => [] };

const gear = await import("../scripts/builtin/gear.mjs");
const { sourceDocs } = await import("../tools/build-packs.mjs");
const { GEAR } = await import("../tools/pa-effects.mjs");
const { GEAR_HANDLERS } = await import("../tools/pa-port.mjs");

const armor = () => ({ _id: "A", system: { category: "medium", acBonus: 4, bulk: { value: 1 }, runes: { potency: 0, resilient: 0, property: [] }, traits: { value: [""] } }, flags: {} });
const shield = () => ({ _id: "S", system: { hardness: 3, hp: { value: 12, max: 12 } }, flags: {} });

test("броня: руны и нулевой Объём при надетой настоящей, temporary, состояние возврата на ней", () => {
  const worn = { id: "W", _source: { system: { runes: { potency: 2, resilient: 1, property: ["fortification"] }, bulk: { value: 2 }, equipped: { invested: true } } }, system: { bulk: { value: 99 }, runes: { potency: 0 } } };
  const state = gear.wornState(worn);
  assert.deepEqual(state, { oldArmor: "W", oldBulk: 2, oldInvested: true });   // из _source, а не из подготовленных данных
  const d = gear.armorData(armor(), { effectId: "E", state, runes: worn._source.system.runes, level: 5 });
  assert.equal(d._id, undefined);
  assert.deepEqual(d.system.runes, worn._source.system.runes);
  assert.notEqual(d.system.runes, worn._source.system.runes);   // копия, а не ссылка
  assert.equal(d.system.bulk.value, 0);
  assert.equal(d.system.temporary, true);
  assert.deepEqual(d.flags["pf2e-automato"], { gearOf: "E", oldArmor: "W", oldBulk: 2, oldInvested: true });
  const bare = gear.armorData(armor(), { effectId: "E" });
  assert.equal(bare.system.bulk.value, 1);
  assert.deepEqual(bare.flags["pf2e-automato"], { gearOf: "E" });
});

test("Доспех из земли: с 3 уровня тяжёлая, +5 и bulwark, пустой признак не остаётся", () => {
  const up = { level: 3, acBonus: 5, traits: ["bulwark"], category: "heavy" };
  const lo = gear.armorData(armor(), { effectId: "E", level: 2, upgrade: up });
  assert.deepEqual([lo.system.acBonus, lo.system.category], [4, "medium"]);
  const d = gear.armorData(armor(), { effectId: "E", level: 3, upgrade: up });
  assert.deepEqual([d.system.acBonus, d.system.category, d.system.traits.value], [5, "heavy", ["bulwark"]]);
});

test("щит: +1 Твёрдость и +4 ОЗ за каждые 3 уровня после первого, temporary", () => {
  const scale = { every: 3, hardness: 1, hp: 4 };
  const at = (level) => gear.shieldData(shield(), { effectId: "E", level, scale }).system;
  assert.deepEqual([at(1).hardness, at(3).hardness, at(4).hardness, at(7).hardness, at(10).hardness], [3, 3, 4, 5, 6]);
  assert.deepEqual([at(1).hp, at(4).hp, at(7).hp], [{ value: 12, max: 12 }, { value: 16, max: 16 }, { value: 20, max: 20 }]);
  assert.equal(gear.shieldData(shield(), { effectId: "E", level: 20 }).system.hardness, 3);   // без scale — как есть
  assert.equal(at(1).temporary, true);
  assert.deepEqual(at(1).equipped, { carryType: "held", handsHeld: 1 });   // сразу в руке
});

test("щит исчезает: сломан или не в руке; урон: сумма ОЗ и временных", () => {
  const sh = (carryType, broken = false) => ({ isBroken: broken, system: { equipped: { carryType } } });
  assert.equal(gear.shieldGone(sh("held")), false);
  assert.equal(gear.shieldGone(sh("held", true)), true);
  assert.equal(gear.shieldGone(sh("worn")), true);
  assert.equal(gear.shieldGone(sh("dropped")), true);
  assert.equal(gear.hpTotal({ system: { attributes: { hp: { value: 10, temp: 3 } } } }), 13);
  assert.equal(gear.hpTotal({ system: { attributes: { hp: { value: 10 } } } }), 10);
});

test("признак эффекта, выданный предмет, группа PA", () => {
  const eff = { type: "effect", slug: "effect-hardwood-armor", flags: { "pf2e-automato": { gear: { armor: "u" } } } };
  assert.deepEqual(gear.gearFlag(eff), { armor: "u" });
  assert.equal(gear.gearFlag({ ...eff, type: "feat" }), null);
  assert.equal(gear.gearFlag({ type: "effect", flags: {} }), null);
  assert.equal(gear.grantedBy({ flags: { "pf2e-automato": { gearOf: "E" } } }), "E");
  assert.equal(gear.grantedBy({ flags: {} }), null);
  assert.equal(gear.paSlug(eff), "hardwood-armor");
  assert.equal(gear.paSlug({ slug: "effect-wooden-shield" }, { shield: "u", pa: "hardwood-armor" }), "hardwood-armor");
});

test("данные пака: флаги gear ведут в существующие предметы и эффекты, выданное уходит каскадом granter, схема pf2e 8.6.1", () => {
  const eff = Object.fromEntries(sourceDocs("effects").map((d) => [d._id, d])), eq = Object.fromEntries(sourceDocs("equipment").map((d) => [d._id, d]));
  assert.equal(Object.keys(eq).length, 5);
  for (const [id, g] of Object.entries(GEAR)) {
    assert.deepEqual(eff[id].flags["pf2e-automato"].gear, g, id);
    for (const k of ["armor", "shield"]) if (g[k]) assert.equal(eq[g[k].split(".").pop()]?.type, k, `${id}.${k}`);
    if (g.shieldEffect) assert.ok(GEAR[g.shieldEffect.split(".").pop()]?.shield, id);
  }
  // у GrantItem судьбу выданного предмета задаёт granter (pf2e.mjs GrantItemRuleElement: grantedBy.onDelete = onDeleteActions.granter); grantee — обратная связь
  for (const id of ["iqvdFq5V1b2HSAW4", "aH805tedt3A5Suuc", "Rl0ztZNeVjXQDDGB"]) {
    const grants = eff[id].system.rules.filter((r) => r.key === "GrantItem");
    assert.ok(grants.length && grants.every((r) => r.onDeleteActions?.granter === "cascade" && !r.onDeleteActions.grantee), id);
    // allowDuplicate:false привязал бы имеющуюся черту Shield Block к эффекту, и каскад удалил бы её у персонажа (pf2e.mjs GrantItemRuleElement) — вместо него предикат
    assert.ok(grants.every((r) => r.allowDuplicate == null), id);
    if (GEAR[id]?.shield) assert.ok(grants.every((r) => JSON.stringify(r.predicate) === JSON.stringify([{ not: "feat:shield-block" }])), id);
  }
  assert.equal(eq.TDvicwRah0zBhsYg.system.slug, "stone-armor");
  // специализация plate как у Armor Expertise pf2e: ступень по категории, а не по уровню; + potency
  const res = eq.TDvicwRah0zBhsYg.system.rules.filter((r) => r.key === "Resistance");
  assert.deepEqual(res.map((r) => [r.predicate[0], r.value]), [["armor:category:medium", "1 + @armor.system.runes.potency"], ["armor:category:heavy", "2 + @armor.system.runes.potency"]]);
  assert.equal(eq.gkqzWcFgbib1BFne.system.baseItem, "wooden-shield");
  assert.equal(GEAR.NT4T6gEdEQsoHItQ.upgrade.category, "heavy");
  assert.equal(GEAR.wITJ6L8mcbbgoCHu.shatterOnCrit, true);
  for (const d of [...Object.values(eq), eff.NT4T6gEdEQsoHItQ, eff.iqvdFq5V1b2HSAW4]) assert.deepEqual(d.system._migration, { version: 0.959, previous: null }, d.name);
  for (const d of Object.values(eq)) assert.doesNotMatch(JSON.stringify(d), /pf2e-automations/);
});

test("перенос PA: обработчики группы учтены как встроенный gear", () => {
  for (const h of ["armorInEarth", "hardwoodArmor", "metalCarapace", "deleteMetalCarapaceShield", "blazingArmoryDelete"]) assert.equal(GEAR_HANDLERS[h], "gear", h);
});

test("replace: шаг effect заканчивает прежний эффект того же источника и автора, потом создаёт новый; без replace — пропуск", async () => {
  const { applyEffect } = await import("../scripts/apply.mjs");
  const { validateRule } = await import("../scripts/rules.mjs");
  const EFF = "Compendium.pf2e-automato.effects.Item.NT4T6gEdEQsoHItQ";
  registry = new Map([[EFF, { type: "effect", toObject: () => ({ _id: "src", name: "Eff", type: "effect", system: { traits: { value: [] }, rules: [] }, _stats: {} }) }]]);
  let n = 0;
  const actor = { uuid: "Actor.a", items: [], get itemTypes() { return { effect: this.items.filter((i) => i.type === "effect") }; }, getActiveTokens: () => [],
    async createEmbeddedDocuments(_t, [d]) { const it = { ...d, id: `i${++n}`, async delete() { actor.items.splice(actor.items.indexOf(it), 1); } }; actor.items.push(it); return [it]; } };
  const ctx = { originActor: { uuid: "Actor.o" } };
  const first = (await applyEffect(actor, { uuid: EFF, replace: true }, { key: "k1" }, ctx)).item;
  assert.equal((await applyEffect(actor, { uuid: EFF, replace: true }, { key: "k1" }, ctx)).op, "skipped");   // тот же ключ — повтор клика, не замена
  assert.equal(actor.items.length, 1);
  const second = (await applyEffect(actor, { uuid: EFF, replace: true }, { key: "k2" }, ctx)).item;
  assert.deepEqual(actor.items.map((i) => i.id), [second.id]);
  assert.notEqual(first.id, second.id);
  assert.equal((await applyEffect(actor, { uuid: EFF }, { key: "k3" }, ctx)).op, "skipped");   // без replace дедуп как раньше
  const rule = (effect) => validateRule({ v: 1, onUse: { targets: "self", apply: [{ to: "self", effect }] } });
  assert.deepEqual(rule({ uuid: EFF, replace: true }).rule.onUse.apply[0].effect, { uuid: EFF, replace: true });
  assert.equal(rule({ uuid: EFF, replace: false }).ok, false);
  assert.equal(rule({ uuid: EFF, replace: true, badge: "increment" }).ok, false);
});

test("replace: форма листа туда-обратно", async () => {
  const { ruleToForm, formToRule } = await import("../scripts/sheet.mjs");
  const { validateRule } = await import("../scripts/rules.mjs");
  const r = validateRule({ v: 1, onUse: { targets: "self", apply: [{ to: "self", effect: { uuid: "Compendium.pf2e-automato.effects.Item.NT4T6gEdEQsoHItQ", replace: true } }] } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(validateRule(formToRule(ruleToForm(r.rule))).rule.onUse.apply[0].effect.replace, true);
});

test("наивысшее мастерство: MartialProficiency на каждой броне, значение — максимум из четырёх категорий (кинетик 3 уровня: heavy не обязателен)", () => {
  const eq = sourceDocs("equipment").filter((d) => d.type === "armor");
  assert.equal(eq.length, 3);
  const value = (rules, ranks) => {
    const r = rules.find((x) => x.key === "MartialProficiency");
    assert.equal(r.kind, "defense");
    assert.deepEqual(r.definition, [`item:slug:${r.slug.replace(/^gear-/, "")}`]);
    const expr = r.value.replace(/@actor\.system\.proficiencies\.defenses\.(\w+)\.rank/g, (_m, c) => ranks[c]);
    return new Function("max", `return ${expr}`)(Math.max);
  };
  for (const d of eq) {
    assert.equal(d.system.rules.find((x) => x.key === "MartialProficiency").definition[0], `item:slug:${d.system.slug}`, d.name);
    assert.equal(value(d.system.rules, { unarmored: 1, light: 1, medium: 1, heavy: 0 }), 1, d.name);   // кинетик: категория не превращается в unarmored, ранг остаётся 1
    assert.equal(value(d.system.rules, { unarmored: 2, light: 1, medium: 3, heavy: 2 }), 3, d.name);
  }
});

test("второй импульс брони подряд заканчивает первый (replace по тексту и между разными эффектами)", async () => {
  const { markReplace, REPLACES, deriveFromMarkup } = await import("../scripts/rules.mjs");
  assert.equal(REPLACES.test("If you use this impulse again, any existing one ends."), true);
  assert.equal(REPLACES.test("If you cast this spell again, any previous casting ends."), true);
  assert.equal(REPLACES.test("You can use this again after 1 hour."), false);
  assert.equal(REPLACES.test("You can't use this impulse again until the previous one ends."), false);   // запрет повтора, не замена
  assert.equal(REPLACES.test("You can't cast this again once the previous casting ends."), false);
  const u = { apply: [{ to: "self", effect: { uuid: "E" } }, { to: "self", effect: { uuid: "B", badge: "increment" } }, { to: "self", condition: { slug: "slowed" } }] };
  markReplace(u);
  assert.deepEqual(u.apply.map((a) => !!a.effect?.replace), [true, false, false]);
  const html = "<p>You gain @UUID[Compendium.pf2e.spell-effects.Item.RfCEHpMoEAZvB9IZ]{Effect: Thing} for 1 minute. If you cast this spell again, any previous casting ends.</p>";
  const d = deriveFromMarkup({ type: "spell", slug: "thing", name: "Thing", system: { description: { value: html }, traits: { value: [] } } }, {}, () => null, null);
  if (d?.rule) assert.ok(d.rule.onUse.apply.every((a) => !a.effect || a.effect.replace === true));
});

test("Metal Carapace: урон по контекстному клону ломает панцирь — ОЗ и эффекты берутся у настоящего актёра по uuid", async () => {
  const mk = (hp) => ({ uuid: "Actor.a", system: { attributes: { hp: { value: hp, temp: 0 } } } });
  const real = mk(20), deleted = [];
  real.itemTypes = { effect: [{ flags: { "pf2e-automato": { gear: { shatterOnCrit: true } } }, type: "effect", isOwner: true, delete: async () => deleted.push("shatter") }, { flags: {}, type: "effect", isOwner: true, delete: async () => deleted.push("other") }] };
  registry = new Map([["Actor.a", real]]);
  class A { async applyDamage(o) { real.system.attributes.hp.value -= o.damage; return this; } }   // клон не меняется, меняется настоящий
  globalThis.CONFIG.Actor = { documentClass: A };
  gear.wrapShatter();
  const clone = Object.assign(new A(), { uuid: "Actor.a", system: { attributes: { hp: { value: 20, temp: 0 } } } });
  await clone.applyDamage({ damage: 5, outcome: "success" });
  assert.deepEqual(deleted, []);
  await clone.applyDamage({ damage: 0, outcome: "criticalSuccess" });   // крит без потери ОЗ (сопротивление) ничего не ломает
  assert.deepEqual(deleted, []);
  await clone.applyDamage({ damage: 5, outcome: "criticalSuccess" });
  assert.deepEqual(deleted, ["shatter"]);
});

test("replace: прежний эффект того же источника и автора снимается и с другого актёра", async () => {
  const { applyEffect } = await import("../scripts/apply.mjs");
  const EFF = "Compendium.pf2e.spell-effects.Item.sweet";
  registry = new Map([[EFF, { type: "effect", toObject: () => ({ _id: "src", name: "Sweet Dream", type: "effect", system: { traits: { value: [] }, rules: [] }, _stats: {} }) }]]);
  const mkA = (uuid) => { const a = { uuid, items: [], get itemTypes() { return { effect: this.items.filter((i) => i.type === "effect") }; }, getActiveTokens: () => [],
    async createEmbeddedDocuments(_t, [d]) { const it = { ...d, id: `${uuid}-i${a.items.length}`, async delete() { a.items.splice(a.items.indexOf(it), 1); } }; a.items.push(it); return [it]; } }; return a; };
  const a = mkA("Actor.a"), b = mkA("Actor.b"), c = mkA("Actor.c");
  game.actors = [a, b, c]; game.scenes = { contents: [] };
  try {
    const ctx = { originActor: { uuid: "Actor.o" } };
    await applyEffect(a, { uuid: EFF, replace: true }, { key: "k1" }, ctx);
    await applyEffect(c, { uuid: EFF, replace: true }, { key: "k1c" }, { originActor: { uuid: "Actor.other" } });   // чужой автор — не трогаем
    await applyEffect(b, { uuid: EFF, replace: true }, { key: "k2" }, ctx);
    assert.deepEqual([a.items.length, b.items.length, c.items.length], [0, 1, 1]);
  } finally { delete game.actors; delete game.scenes; }
});
