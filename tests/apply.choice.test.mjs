import { test } from "node:test";
import assert from "node:assert/strict";
import { presetChoiceSets } from "../scripts/apply.mjs";

const pick = (slug) => ({ predicate: [{ or: [`parent:origin:item:slug:${slug}`, { not: "parent:origin:item" }] }], value: `Compendium.pf2e.equipment-srd.Item.${slug}` });
const brew = () => [{ key: "ChoiceSet", choices: [pick("bravos-brew-lesser"), pick("bravos-brew-moderate"), pick("bravos-brew-greater")] }, { key: "FlatModifier" }];

test("presetChoiceSets: степень расходника по slug источника, как у Effect: Bravo's Brew", () => {
  const rules = brew();
  assert.equal(presetChoiceSets(rules, { slug: "bravos-brew-moderate" }), 0);
  assert.equal(rules[0].selection, "Compendium.pf2e.equipment-srd.Item.bravos-brew-moderate");
});

test("presetChoiceSets: по UUID источника; уровень; чужой slug и готовый selection не трогаются", () => {
  let r = brew();
  assert.equal(presetChoiceSets(r, { uuids: ["Compendium.pf2e.equipment-srd.Item.bravos-brew-greater"] }), 0);
  assert.match(r[0].selection, /greater$/);
  r = [{ key: "ChoiceSet", choices: [3, 4].map((n) => ({ value: n, predicate: [`parent:origin:item:level:${n}`] })) }];
  assert.equal(presetChoiceSets(r, { level: 4 }), 0);
  assert.equal(r[0].selection, 4);
  r = brew();
  assert.equal(presetChoiceSets(r, { slug: "other" }), 1);   // нерешённый -> окно ГМу
  assert.equal(r[0].selection, undefined);
  r = [{ key: "ChoiceSet", selection: "x", choices: [] }, { key: "ChoiceSet", choices: "config", allowNoSelection: true }];
  assert.equal(presetChoiceSets(r, {}), 0);
  assert.equal(presetChoiceSets(undefined, {}), 0);
});
