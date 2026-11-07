// RustySpirit: WF11 (choose conditions + extendEffect.chosen), Kinetic Aura (overflow/unconscious), Scorching Column, Slashing Gust (ruleFor по источнику).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.game = { user: { isActiveGM: true, id: "gm" }, settings: { get: () => undefined }, i18n: { localize: (k) => k, format: (k) => k }, pf2e: { ConditionManager: { conditions: new Map() } } };
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o) } };
const { validateRule, buildCatalog, initCatalog } = await import("../scripts/rules.mjs");
const { prolongable } = await import("../scripts/apply.mjs");
const { ruleFor } = await import("../scripts/actions.mjs");
const { isOverflowUse, isAura } = await import("../scripts/builtin/kinetic-aura.mjs");

const read = (n) => JSON.parse(readFileSync(new URL(`../rules/${n}`, import.meta.url), "utf8"));
const catalog = read("catalog.json");
initCatalog([read("catalog.model.json"), catalog, read("catalog.campaign.json")], read("labels.json"));
const WF11 = catalog.bySource["Compendium.pf2e.familiar-abilities.Item.mu9OL8v4rmr9311e"];
const COLUMN = catalog.bySource["Compendium.pf2e.feats-srd.Item.XqtJVBwnxBsSo9Py"];
const GUST = catalog.bySource["Compendium.pf2e.spells-srd.Item.1Yoipc5jNcMehtEW"];
const ev = (apply) => ({ v: 1, onEvent: [{ on: "spell-cast", side: "familiar", apply }] });
const pick = { choose: { from: "creatures", range: 15 } }, conds = { choose: { from: "conditions" } }, ext = { to: "chosen", extendEffect: { chosen: true, rounds: 1 } };

test("записи P1, P3, P4 проходят validateRule и buildCatalog", () => {
  for (const r of [WF11, COLUMN, GUST]) { const v = validateRule(r); assert.equal(v.ok, true, JSON.stringify(v.errors)); }
  assert.deepEqual(buildCatalog([catalog]).errors, []);
});

test("валидатор: conditions только после выбора существа и без range/where/of/withSelf; шаг не считается выбором существа", () => {
  assert.equal(validateRule(ev([pick, conds, ext])).ok, true);
  assert.equal(validateRule(ev([conds, ext])).ok, false);
  assert.equal(validateRule(ev([{ choose: { from: "options", options: ["a"] } }, conds])).ok, false);
  for (const x of [{ range: 15 }, { where: ["x"] }, { of: "target" }, { withSelf: true }]) assert.equal(validateRule(ev([pick, { choose: { from: "conditions", ...x } }, ext])).ok, false, JSON.stringify(x));
  assert.equal(validateRule(ev([pick, conds, { to: "chosen", note: "x" }, { to: "chosen", damage: { formula: "1", damageType: "fire" } }])).ok, true);
  const v = validateRule({ v: 1, onUse: { apply: [pick, conds] } });   // в onUse нет передачи следующего шага
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.key === "apply.condEvent"), JSON.stringify(v.errors));
});

test("валидатор: extendEffect.chosen — только to:chosen, после choose conditions, ровно одно из slug/cast/chosen", () => {
  assert.deepEqual(validateRule(ev([pick, conds, ext])).rule.onEvent[0].apply[2], { to: "chosen", extendEffect: { chosen: true, rounds: 1 } });
  assert.equal(validateRule(ev([pick, ext])).ok, false);   // нет шага conditions
  assert.equal(validateRule(ev([pick, conds, { to: "self", extendEffect: { chosen: true, rounds: 1 } }])).ok, false);
  assert.equal(validateRule(ev([pick, conds, { to: "chosen", extendEffect: { chosen: true, slug: "a", rounds: 1 } }])).ok, false);
  assert.equal(validateRule(ev([pick, conds, { to: "chosen", extendEffect: { chosen: true, cast: true, rounds: 1 } }])).ok, false);
  assert.equal(validateRule(ev([pick, conds, { to: "chosen", extendEffect: { chosen: true } }])).ok, false);
});

const effect = (id, { name = id, unit = "rounds", value = 3, expired = false, flags, sustained = false } = {}) => ({ id, name, isExpired: expired, flags, system: { duration: { unit, value, sustained } } });
const cond = (slug, of, value) => ({ slug, name: slug, grantedBy: of ? { id: of } : null, system: { value: { value } } });
const actor = (effects, conditions) => ({ itemTypes: { effect: effects, condition: conditions } });

test("prolongable: срок конечный, не истёк, не продлён, состояние негативное; обёртка шока на срок не берётся", () => {
  const a = actor(
    [effect("fr"), effect("inf", { unit: "unlimited", value: -1 }), effect("old", { expired: true }), effect("done", { flags: { "pf2e-automato": { prolonged: true } } }), effect("qk"), effect("stun", { name: "Stunned", flags: { "pf2e-automato": { stunWrap: true } } }), effect("stun2", { name: "Stunned 1" }), effect("plain"), effect("sus", { unit: "minutes", value: 1, sustained: true }), effect("bound", { flags: { "pf2e-automato": { meta: { sustainOf: "anchor-1" } } } })],
    [cond("frightened", "fr", 2), cond("sickened", "inf"), cond("slowed", "old"), cond("slowed", "done"), cond("quickened", "qk"), cond("stunned", "stun"), cond("stunned", "stun2", 1), cond("frightened", null, 1), cond("sickened", "sus", 1), cond("stupefied", "bound", 1)]
  );
  assert.deepEqual(prolongable(a).map((x) => x.effect.id), ["fr", "stun2"]);
  assert.equal(prolongable(a)[0].names, "frightened 2");
  assert.deepEqual(prolongable(null), []);
});

test("Kinetic Aura: overflow гасит при использовании (действие/self-effect), не при броске; потеря сознания — отдельный хук", () => {
  assert.equal(isOverflowUse({ type: undefined, traits: ["impulse", "overflow"] }), true);
  assert.equal(isOverflowUse({ type: "self-effect", traits: ["overflow"] }), true);
  assert.equal(isOverflowUse({ type: "damage-roll", traits: ["overflow"] }), false);
  assert.equal(isOverflowUse({ type: undefined, traits: ["impulse"] }), false);
  assert.equal(isAura({ type: "effect", slug: "effect-kinetic-aura" }), true);
  assert.equal(isAura({ type: "effect", slug: "effect-rage" }), false);
});

test("P3: колонна — зона до конца следующего хода, урон при входе в скобках; P4: Slashing Gust — продолжительное кровотечение на крит", () => {
  assert.deepEqual(COLUMN.onUse.zone.duration, { until: "next-turn-end", rounds: 2, sustainMax: 10 });   // до конца следующего хода автора, Поддержание до 1 минуты (пак C)
  assert.equal(COLUMN.onUse.zone.triggers[0].apply[0].damage.formula, "(2*floor((@actor.level-1)/3)+1)");
  assert.deepEqual(GUST.onUse.check.byDegree.criticalSuccess[0].persistent, { formula: "(@item.rank)d4", damageType: "bleed" });
});

test("ruleFor: записи bySource атак заклинанием достижимы по источнику (Blood Feast, Slashing Gust); поиск по slug цел", () => {
  const spell = (src, extra = {}) => ({ type: "spell", system: {}, _stats: { compendiumSource: src }, ...extra });
  const BF = "Compendium.pf2e.spells-srd.Item.ES6FkwXXqYr4ujQH", SG = "Compendium.pf2e.spells-srd.Item.1Yoipc5jNcMehtEW";
  assert.equal(ruleFor(["blood-feast"]), null);   // по slug без источника записи нет
  assert.equal(ruleFor(["blood-feast"], undefined, { item: spell(BF) })?.rule.label, "Blood Feast");
  assert.equal(ruleFor(["slashing-gust"], undefined, { origin: { type: "spell", sourceId: SG } })?.rule.label, "Slashing Gust");
  assert.equal(ruleFor(["tangle-vine"]).rule.onUse.check.roll, "system");
  assert.equal(ruleFor(["tangle-vine"], undefined, { item: spell("Compendium.pf2e.spells-srd.Item.nope") }).rule.onUse.check.roll, "system");   // чужой источник не мешает slug
  // запись по источнику без onUse.check не перекрывает slug-правило с проверкой
  const noCheck = { v: 1, label: "NoCheck", onUse: { targets: "selected" } };
  const rf = ruleFor(["ray-of-frost"], (s) => (s.item ? { rule: noCheck } : { rule: { onUse: { check: {} } } }), { item: spell("x") });
  assert.equal(rf.slug, "ray-of-frost");
  assert.notEqual(rf.rule, noCheck);
});

test("ruleFor: флаг предмета главнее каталога", () => {
  const flagRule = { ...structuredClone(GUST), label: "Flagged" };
  const it = { type: "spell", system: {}, flags: { "pf2e-automato": { rule: flagRule } }, _stats: { compendiumSource: "Compendium.pf2e.spells-srd.Item.1Yoipc5jNcMehtEW" } };
  assert.equal(ruleFor(["tangle-vine"], undefined, { item: it }).rule.label, "Flagged");
});

test("picksFromOps: выбор эффекта хранится отдельно и не затирает существо", async () => {
  const { picksFromOps } = await import("../scripts/apply.mjs");
  globalThis.fromUuid = async (u) => (u.startsWith("Actor") ? { uuid: u } : { uuid: u, isEffect: true });
  const p = await picksFromOps([{ op: "chose", key: "a", value: "Actor.z", actor: "Actor.z" }, { op: "chose", key: "b", value: "Actor.z.Item.e", effect: "Actor.z.Item.e" }]);
  assert.equal(p.actor.uuid, "Actor.z");
  assert.equal(p.effect.uuid, "Actor.z.Item.e");
  delete globalThis.fromUuid;
});
