// W3: оверлеи ranges.json и damage-degrees.json — нижний слой каскада resolveRule (plan §1.2): флаг и каталог их перекрывают.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

globalThis.game = { user: { isActiveGM: true, id: "gm" }, settings: { get: () => undefined }, i18n: { localize: (k) => k, format: (k) => k } };
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.foundry = { utils: { getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };

const rules = await import("../scripts/rules.mjs");
const { itemRange, tableRange } = await import("../scripts/range.mjs");

const SRC = "Compendium.pf2e.feats-srd.Item.W3W3W3W3W3W3W3W3";
const CH = { statistic: "will", dc: { source: "spell" }, basic: false, rollerRole: "target", byDegree: { failure: [{ to: "target", note: "x" }] } };
const UP = { v: 1, onUse: { targets: "selected", challenge: CH } };
const doc = (flags = {}, extra = {}) => ({ type: "feat", slug: "w3-feat", name: "W3", system: {}, _stats: { compendiumSource: SRC }, flags, actor: { level: 1 }, ...extra });
const DEG = { criticalSuccess: 0, success: 0.5, failure: 1, criticalFailure: 1 };

beforeEach(() => {
  rules.initCatalog([{ v: 1, bySource: { [SRC]: UP } }], null);
  rules.initOverlays({ v: 1, bySource: { [SRC]: { ft: 60 } } }, { [SRC]: DEG });
});

test("оверлей вливается в правило каталога, не мутируя его", () => {
  const r = rules.resolveRule(doc()).rule;
  assert.deepEqual(r.onUse.range, { ft: 60 });
  assert.deepEqual(r.onUse.challenge.damageByDegree, DEG);
  assert.equal(rules.resolveRule(doc()).rule.onUse.challenge.damageByDegree, DEG);
  const again = rules.resolveRule(doc({ x: 1 })).rule;
  assert.notEqual(again, r);
  rules.initOverlays(null, null);
  const bare = rules.resolveRule(doc()).rule;
  assert.equal(bare.onUse.range, undefined);
  assert.equal(bare.onUse.challenge.damageByDegree, undefined);   // исходный объект каталога не загрязнён
});

test("флаг предмета перекрывает оверлей: свои range и damageByDegree главнее", () => {
  const own = { ft: 15 }, ownDeg = { criticalSuccess: 0, success: 0, failure: 1, criticalFailure: 2 };
  const flag = { v: 1, onUse: { targets: "selected", range: own, challenge: { ...CH, damageByDegree: ownDeg } } };
  const res = rules.resolveRule(doc({ "pf2e-automato": { rule: flag } }));
  assert.equal(res.source, "flag");
  assert.deepEqual(res.rule.onUse.range, own);
  assert.deepEqual(res.rule.onUse.challenge.damageByDegree, ownDeg);
  assert.equal(itemRange(doc({ "pf2e-automato": { rule: flag } })), 15);
});

test("флаг без своей дальности — поля оверлея подставляются ниже флага", () => {
  const flag = { v: 1, onUse: { targets: "selected", challenge: CH } };
  const res = rules.resolveRule(doc({ "pf2e-automato": { rule: flag } }));
  assert.deepEqual(res.rule.onUse.range, { ft: 60 });
});

test("правило каталога с range главнее оверлея; basic-испытание damageByDegree не получает", () => {
  rules.initCatalog([{ v: 1, bySource: { [SRC]: { v: 1, onUse: { targets: "selected", range: { ft: 30 }, challenge: { ...CH, basic: true } } } } }], null);
  const r = rules.resolveRule(doc()).rule;
  assert.deepEqual(r.onUse.range, { ft: 30 });
  assert.equal(r.onUse.challenge.damageByDegree, undefined);
});

test("itemRange: дальность предмета из каскада; уровневый рост; area не проверяется как дальность цели", () => {
  assert.equal(itemRange(doc()), 60);
  rules.initOverlays({ v: 1, bySource: { [SRC]: { ft: 30, grow: { add: 10, every: 2 } } } }, null);
  assert.equal(itemRange(doc({}, { actor: { level: 5 } })), 50);
  rules.initOverlays({ v: 1, bySource: { [SRC]: { ft: 30, area: true } } }, null);
  assert.equal(itemRange(doc()), null);
  assert.deepEqual(rules.rangeEntry(doc()), { ft: 30, area: true });
  assert.equal(tableRange(rules.rangeEntry(doc()), 1), null);
});

test("предмет без правила: дальность берётся прямо из оверлея (по slug тоже)", () => {
  rules.initCatalog([], null);
  rules.initOverlays({ v: 1, bySlug: { "w3-feat": { ft: 20 } } }, null);
  assert.equal(itemRange(doc({}, { _stats: {} })), 20);
});

test("валидатор onUse.range", () => {
  const v = (range) => rules.validateRule({ v: 1, onUse: { targets: "selected", range, challenge: CH } });
  assert.equal(v({ ft: 30, grow: { add: 5, every: 2 } }).ok, true);
  assert.deepEqual(v({ ft: 30, area: true }).rule.onUse.range, { ft: 30, area: true });
  for (const bad of [{ ft: 0 }, { ft: "30" }, 30, { ft: 30, area: 1 }, { ft: 30, grow: { add: 5 } }]) assert.equal(v(bad).ok, false, JSON.stringify(bad));
});
