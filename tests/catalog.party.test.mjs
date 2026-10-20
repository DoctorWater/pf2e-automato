import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateRule, buildCatalog, initCatalog, resolveRule } from "../scripts/rules.mjs";

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));
const builtin = read("../rules/catalog.json"), campaign = read("../rules/catalog.campaign.json"), labels = read("../rules/labels.json");
const inv = read("../party-inventory.json");

const PARTY_NEW = {
  daze: "Compendium.pf2e.spells-srd.Item.4gBIw4IDrSfFHik4",
  "phantom-pain": "Compendium.pf2e.spells-srd.Item.R8bqnYiThB6MYTxD"
};

test("party: новые записи проходят validateRule и есть у героев в инвентаре", () => {
  for (const [slug, uuid] of Object.entries(PARTY_NEW)) {
    for (const [f, k] of [["bySource", uuid], ["bySlug", slug]]) {
      const v = validateRule(campaign[f][k]);
      assert.ok(v.ok, `${f}.${k}: ${v.errors}`);
    }
    assert.ok(inv.items.some((i) => i.compendiumSource === uuid && i.slug === slug), `${slug} нет в инвентаре`);
  }
  assert.deepEqual(buildCatalog([builtin, campaign]).errors, []);
});

test("party: resolveRule по данным инвентаря — каталог перекрывает разметку", () => {
  initCatalog([builtin, campaign], labels);
  globalThis.game = { pf2e: { ConditionManager: { conditions: new Map() } } };
  try {
    const R = (i) => resolveRule({ item: {
      type: i.type, name: i.name, slug: i.slug, _stats: { compendiumSource: i.compendiumSource },
      system: { description: { value: i.description }, defense: i.defense, area: i.area, target: i.target, selfEffect: i.selfEffect, category: i.category, traits: { value: i.traits } }
    } });
    const src = Object.fromEntries(inv.items.map((i) => { const r = R(i); return [i.name, r && `${r.source}${r.source === "markup" ? ":" + r.confidence : ""}`]; }));

    // перекрытие: разметка Ступора даёт challenge без byDegree, каталог — stunned 1 при крит. провале
    const daze = R(inv.items.find((i) => i.slug === "daze"));
    assert.equal(daze.source, "catalog");
    assert.equal(daze.rule.onUse.challenge.byDegree.criticalFailure[0].condition.value, 1);
    const pain = R(inv.items.find((i) => i.slug === "phantom-pain"));
    assert.equal(pain.source, "catalog");
    assert.equal(pain.rule.onUse.challenge.byDegree.criticalFailure[0].condition.value, 2);

    // K8-правила не сломаны
    for (const n of ["Боевая медицина", "Щит", "Дымовая шашка (малая)", "Ловкое уклонение", "Проворное уклонение"]) assert.equal(src[n], "catalog", n);
    // вывод из разметки: именно этот набор, остальные предметы правил не получают
    const markup = Object.entries(src).filter(([, v]) => v?.startsWith("markup")).map(([k, v]) => `${k}=${v}`).sort();
    assert.deepEqual(markup, ["Наследие крови [Аберрация]=markup:low", "Черный порох [Рожок]=markup:high"].sort());   // Запрещающая защита и Наставление — каталог (pa-port)
    assert.equal(Object.values(src).filter((v) => v === "catalog").length, 18);   // +4 встроенных обработчика (Двойной финт, Грязный приём, Обманка, Двойной взмах); +7 pa-port (Вымысел, Наставление, Запрещающая защита, Рунное оружие, Умиротворение, Кристалл усиления, Устрашающий удар)
  } finally { delete globalThis.game; initCatalog([builtin], labels); }
});
