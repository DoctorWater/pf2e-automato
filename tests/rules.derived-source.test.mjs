// Выведенный источник предметов NPC: `${источник актёра}.Item.${id}` — только для bySource и оверлеев; ограждения тёзок, byName и guardCopy — по собственному источнику.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCatalog, initCatalog, initOverlays, lookupSourceOf, rangeEntry, resolveRule } from "../scripts/rules.mjs";

const labels = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/labels.json", import.meta.url)), "utf8"));
const ACTOR = "Compendium.pf2e.bestiary.Actor.AAAAAAAAAAAAAAAA", KEY = `${ACTOR}.Item.iiiiiiiiiiiiiiii`;
const EFF = "Compendium.pf2e.feat-effects.Item.EEEEEEEEEEEEEEEE";
const self = (n) => ({ v: 1, label: n, onUse: { targets: "self", apply: [{ to: "self", effect: { uuid: EFF } }] } });
const check = (n) => ({ v: 1, label: n, onUse: { targets: "selected", apply: [], check: { statistic: "athletics", vs: { defense: "reflex" }, byDegree: { success: [{ to: "target", condition: { slug: "prone" } }] } } } });
const actor = (src, extra = {}) => ({ type: "npc", _stats: src ? { compendiumSource: src } : {}, ...extra });
const npcItem = (name, a, { id = "iiiiiiiiiiiiiiii", slug, html = "", own, type = "action" } = {}) => {
  const it = { id, type, name, _stats: own ? { compendiumSource: own } : {}, system: { description: { value: html }, traits: { value: [] }, ...(slug && { slug }) }, ...(slug && { slug }) };
  it.actor = it.parent = a;
  return it;
};
const run = (cat, it, overlays = [null, null, null]) => {
  initCatalog([cat], labels); initOverlays(...overlays);
  globalThis.game = { pf2e: { ConditionManager: { conditions: new Map() } } };
  try { return resolveRule({ item: it }); } finally { delete globalThis.game; initOverlays(null, null, null); }
};

test("выведенный ключ находит правило bySource у предмета NPC без собственного источника", () => {
  const cat = { bySource: { [KEY]: self("derived") } };
  const res = run(cat, npcItem("X", actor(ACTOR), { slug: "x" }));
  assert.equal(res?.rule.label, "derived");
  assert.equal(res.sourceUuid, null);          // собственный источник не подменяется
  assert.equal(res.lookupKey, KEY);
});

test("собственный источник важнее выведенного", () => {
  const OWN = "Compendium.pf2e.actionspf2e.Item.OOOOOOOOOOOOOOOO";
  const cat = { bySource: { [KEY]: self("derived"), [OWN]: self("own") } };
  assert.equal(run(cat, npcItem("X", actor(ACTOR), { slug: "x", own: OWN }))?.rule.label, "own");
  assert.equal(lookupSourceOf(npcItem("X", actor(ACTOR), { own: OWN })), OWN);
});

test("актёр без источника — выведенного ключа нет", () => {
  assert.equal(lookupSourceOf(npcItem("X", actor(null))), null);
  assert.equal(run({ bySource: { [KEY]: self("derived") } }, npcItem("X", actor(null), { slug: "x" })), null);
});

test("предмет, добавленный NPC вручную (другой id), правило по bySource не находит", () => {
  assert.equal(run({ bySource: { [KEY]: self("derived") } }, npcItem("X", actor(ACTOR), { id: "zzzzzzzzzzzzzzzz", slug: "x" })), null);
});

test("несвязанный токен: источник актёра берётся из baseActor и flags.core.sourceId", () => {
  const cat = { bySource: { [KEY]: self("derived") } };
  const synthetic = { type: "npc", _stats: {}, baseActor: { _stats: { compendiumSource: ACTOR } } };
  assert.equal(run(cat, npcItem("X", synthetic, { slug: "x" }))?.rule.label, "derived");
  assert.equal(run(cat, npcItem("X", { type: "npc", flags: { core: { sourceId: ACTOR } } }, { slug: "x" }))?.rule.label, "derived");
});

test("защита от тёзок по собственному источнику: ловушка с Shove у актёра с источником правило-проверку не получает", () => {
  const cat = { bySlug: { shove: check("shove") } };
  const trap = "<p>Each creature must attempt a @Check[fortitude|dc:20] save.</p><p><strong>Failure</strong> The creature is pushed.</p>";
  const tr = run(cat, npcItem("Shove", actor(ACTOR), { slug: "shove", html: trap, type: "action" }));
  assert.deepEqual([tr.source, !!tr.rule.onUse.challenge, !!tr.rule.onUse.check], ["markup", true, false]);
  assert.equal(run(cat, npcItem("Shove", actor(ACTOR), { slug: "shove", html: "<p>Push the target.</p>" })), null);   // lacksOwnRoll
});

test("byName срабатывает у NPC с источником актёра (named считается по собственному источнику)", () => {
  initCatalog([{ byName: { "Blade Dance": self("dance") } }], labels);
  const it = npcItem("Blade Dance", actor(ACTOR));
  assert.equal(resolveRule({ item: it })?.rule.label, "dance");
});

test("оверлей ranges по выведенному ключу (и для предмета без правила)", () => {
  const ov = [{ v: 1, bySource: { [KEY]: { ft: 60 } } }, null, null];
  const it = npcItem("X", actor(ACTOR), { slug: "x" });
  initOverlays(...ov);
  try { assert.deepEqual(rangeEntry(it), { ft: 60 }); } finally { initOverlays(null, null, null); }
  const res = run({ bySource: { [KEY]: { v: 1, label: "r", onUse: { targets: "selected", apply: [], check: check("r").onUse.check } } } }, it, ov);
  assert.deepEqual(res.rule.onUse.range, { ft: 60 });
});

test("guardCopy и по выведенному ключу: копия NPC с другим состоянием в тексте правило источника не получает", () => {
  const sick = { v: 1, label: "sick", onUse: { targets: "selected", apply: [], challenge: { statistic: "will", dc: { expr: "markup" }, byDegree: { failure: [{ to: "target", condition: { slug: "sickened" } }] } } } };
  const text = (state) => `<p>@Check[will|dc:20] save.</p><hr /><p><strong>Failure</strong> The target becomes ${state} 1.</p>`;
  const ok = run({ bySource: { [KEY]: sick } }, { ...npcItem("Evil Eye", actor(ACTOR), { html: text("sickened") }), uuid: "Actor.a.Item.ok" });
  assert.equal(ok?.source, "catalog");
  const bad = run({ bySource: { [KEY]: sick } }, { ...npcItem("Evil Eye", actor(ACTOR), { html: text("frightened") }), uuid: "Actor.a.Item.bad" });
  assert.notEqual(bad?.source, "catalog");
  assert.equal(bad?.diverged?.kind, "other");
});

test("оверлей damageByDegree по выведенному ключу", () => {
  const dd = { criticalSuccess: 0, success: 0.5, failure: 1, criticalFailure: 2 };
  const rule = { v: 1, label: "d", onUse: { targets: "selected", apply: [], challenge: { statistic: "reflex", dc: { value: 20 }, basic: false } } };
  const res = run({ bySource: { [KEY]: rule } }, npcItem("X", actor(ACTOR), { slug: "x" }), [null, { [KEY]: dd }, null]);
  assert.deepEqual(res.rule.onUse.challenge.damageByDegree, dd);
});

const RH = new URL("../rules/catalog.rusthenge.json", import.meta.url);
test("rules/catalog.rusthenge.json: buildCatalog без ошибок", { skip: !existsSync(RH) }, () => {
  assert.deepEqual(buildCatalog([JSON.parse(readFileSync(RH, "utf8"))]).errors, []);
});
