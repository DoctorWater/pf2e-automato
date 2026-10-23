// resolveRule: поиск по slug с типом, «чужой» тёзка, selfEffect и голова испытания из разметки копии NPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initCatalog, resolveRule, isSelfEffectOnly, slugCollides, slugTypeKey } from "../scripts/rules.mjs";

const labels = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/labels.json", import.meta.url)), "utf8"));
const EFF = "Compendium.pf2e.feat-effects.Item.EEEEEEEEEEEEEEEE";
const self = (n, eff = EFF) => ({ v: 1, label: n, onUse: { targets: "self", apply: [{ to: "self", effect: { uuid: eff } }] } });
const check = (n) => ({ v: 1, label: n, onUse: { targets: "selected", apply: [], check: { statistic: "athletics", vs: { defense: "reflex" }, byDegree: { success: [{ to: "target", condition: { slug: "prone" } }] } } } });
const markupChallenge = (n) => ({ v: 1, label: n, onUse: { targets: "selected", apply: [], challenge: { statistic: "reflex", dc: { expr: "markup" }, basic: true, byDegree: { failure: [{ to: "target", effect: { uuid: EFF } }] } } } });
const item = (slug, type, html = "", extra = {}) => ({ type, name: slug, slug, _stats: {}, system: { description: { value: html }, traits: { value: [] }, ...extra } });
const run = (cat, it) => { initCatalog([cat], labels); globalThis.game = { pf2e: { ConditionManager: { conditions: new Map() } } }; try { return resolveRule({ item: it }); } finally { delete globalThis.game; } };

test("resolveRule: ключ slug@type — только для документов этого типа; общий slug-ключ армейские способности не берут", () => {
  const cat = { bySlug: { [slugTypeKey("twin", "action")]: self("typed"), plain: self("plain") } };
  assert.equal(run(cat, item("twin", "action"))?.rule.label, "typed");
  assert.equal(run(cat, item("twin", "feat")), null);                     // тёзка другого типа правила не получает
  assert.equal(run(cat, item("plain", "feat"))?.rule.label, "plain");
  assert.equal(run(cat, item("plain", "campaignFeature")), null);         // армейская способность делит slug с обычным действием
  assert.equal(run({ bySlug: { [slugTypeKey("plain", "campaignFeature")]: self("army") } }, item("plain", "campaignFeature"))?.rule.label, "army");
});

test("resolveRule: правило «ровно selfEffect документа» по slug пропускается — pf2e применяет его сам", () => {
  const cat = { bySlug: { st: self("st") } };
  assert.equal(run(cat, item("st", "action"))?.rule.label, "st");                                                         // у копии NPC selfEffect нет — правило нужно
  assert.equal(run(cat, item("st", "action", "", { selfEffect: { uuid: EFF } })), null);                                  // у PC-документа есть — не дублируем
  assert.equal(run(cat, item("st", "action", "", { selfEffect: { uuid: "Compendium.pf2e.feat-effects.Item.OTHER" } }))?.rule.label, "st");
  assert.equal(isSelfEffectOnly(self("x"), EFF), true);
  assert.equal(isSelfEffectOnly(check("x"), EFF), false);
  assert.equal(isSelfEffectOnly(self("x"), undefined), false);
});

test("resolveRule: ручное правило-проверка не годится способности NPC со спасброском или делегирующей [[/act slug]] (тёзка без источника)", () => {
  const cat = { bySlug: { shove: check("shove"), disarm: check("disarm") } };
  const trap = "<p>Each creature must attempt a @Check[fortitude|dc:20] save.</p><p><strong>Failure</strong> The creature is pushed.</p>";
  const tr = run(cat, item("shove", "action", trap));
  assert.deepEqual([tr.source, !!tr.rule.onUse.challenge, !!tr.rule.onUse.check], ["markup", true, false]);   // ловушка: правило выводится из её же разметки (спасбросок)
  assert.equal(run(cat, item("shove", "action", "<p>Push the target.</p>")), null);                                      // тёзка без источника и без броска в тексте (0.5b): правило не её
  assert.equal(run(cat, item("shove", "action", "<p>Make an @Check[athletics|dc:20] check to push.</p>"))?.rule.label, "shove");   // бросок нужной статистики в тексте — правило на месте
  assert.equal(run(cat, item("disarm", "action", "<p>attempts to [[/act disarm options=sly-disarm]] the creature</p>")), null);
  // с источником тёзкой не считается (PC-копия действия)
  const withSrc = { ...item("shove", "action", trap), _stats: { compendiumSource: "Compendium.pf2e.actionspf2e.Item.x" } };
  assert.equal(run(cat, withSrc)?.rule.label, "shove");
  assert.equal(slugCollides(check("x"), null, "x", ""), false);
  assert.equal(slugCollides(self("x"), { onUse: { challenge: {} } }), false);                                              // не проверка автора
});

test("resolveRule: dc {expr:markup} — голова испытания (статистика, СЛ, базовое, опции) из спасброска в тексте копии, степени из каталога", () => {
  const cat = { bySlug: { swarm: markupChallenge("swarm") } };
  const html = (stat, dc, basic = "|basic") => `<p>takes damage (@Check[${stat}|dc:${dc}${basic}|options:area-effect] save)</p>`;
  const a = run(cat, item("swarm", "action", html("fortitude", 31)))?.rule.onUse.challenge;
  assert.deepEqual([a.statistic, a.dc, a.basic, a.options], ["fortitude", { value: 31 }, true, ["area-effect"]]);
  assert.deepEqual(a.byDegree, { failure: [{ to: "target", effect: { uuid: EFF } }] });
  const b = run(cat, item("swarm", "action", html("reflex", 20, "")))?.rule.onUse.challenge;
  assert.deepEqual([b.statistic, b.dc, b.basic], ["reflex", { value: 20 }, false]);
  // в тексте спасброска нет — это не та способность (пассив-тёзка): правила нет (0.5b; @Check без числа даёт голову с dc markup)
  assert.equal(run(cat, item("swarm", "action", "<p>no save</p>")), null);
  // правило с числом в каталоге разметкой не подменяется
  const fixed = { bySlug: { swarm: { ...markupChallenge("swarm"), onUse: { ...markupChallenge("swarm").onUse, challenge: { ...markupChallenge("swarm").onUse.challenge, dc: { value: 99 } } } } } };
  assert.equal(run(fixed, item("swarm", "action", html("fortitude", 31)))?.rule.onUse.challenge.dc.value, 99);
});
