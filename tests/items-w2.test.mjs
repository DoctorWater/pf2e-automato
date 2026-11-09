import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.game ??= {};
const { reasonOf, countTorches, TORCH_EFFECT } = await import("../scripts/builtin/impulse-gate.mjs");
const { prolongable } = await import("../scripts/apply.mjs");
const { validateRule } = await import("../scripts/rules.mjs");
const json = (f) => JSON.parse(readFileSync(new URL(`../rules/${f}`, import.meta.url), "utf8"));
const TORCH = "Compendium.pf2e.feats-srd.Item.MRT8BGiIiVYfVcXh", PHASE_FX = "Compendium.pf2e.spell-effects.Item.61Hl31nyzt63vvX9";

test("Вечный факел: лимит по Телосложению, считаются только действующие факелы этого автора", () => {
  const fx = (o = {}) => ({ _stats: { compendiumSource: TORCH_EFFECT }, isExpired: false, system: { context: { origin: { actor: "A" } } }, ...o });
  assert.equal(countTorches([fx(), fx(), fx({ isExpired: true }), fx({ system: { context: { origin: { actor: "B" } } } }), { _stats: {} }], "A"), 2);
  const c = (torches, conMod) => ({ traits: [], slug: "eternal-torch", torches, conMod });
  assert.equal(reasonOf(c(1, 2)), null);
  assert.equal(reasonOf(c(2, 2)), "torches");
  assert.equal(reasonOf(c(0, 0)), "torches");   // модификатор 0 — ни одного
  assert.equal(reasonOf({ ...c(5, 1), slug: "other" }), null);
});

test("каталог: факел бросается на выбранную цель; Сокрытие фамильяра снимается после первого урона и ставится только фамильяру", () => {
  const t = json("catalog.model.json").bySource[TORCH];
  assert.equal(t.onUse.targets, "selected");
  assert.ok(t.onUse.apply.every((s) => s.to === "target"));
  const cat = json("catalog.json").bySource;
  const pf = cat["Compendium.pf2e.spells-srd.Item.rMOI8JFJ0nT2mrCF"];
  assert.deepEqual(pf.onUse.apply.find((s) => s.effect).when, ["target:type:familiar"]);
  assert.ok(pf.onUse.apply.some((s) => s.note && s.when));
  assert.equal(cat[PHASE_FX], undefined);   // ручной onEvent damage-taken заменён onDamaged.triggerOnly
  assert.deepEqual(pf.onDamaged, { who: "familiar", triggerOnly: true });
  for (const r of [t, pf]) assert.deepEqual(validateRule(r).errors ?? [], []);
});

test("Вымысел: label служебный, английский", () => {
  const c = json("catalog.json");
  assert.ok(!JSON.stringify(c).includes('"label":"Вымысел"'));
  assert.equal(c.bySlug.figment.label, "Figment");
});

test("WF11: prolongable сообщает число негативных состояний эффекта", () => {
  const eff = { id: "e", system: { duration: { value: 3, unit: "rounds" } }, flags: {}, isExpired: false };
  const cond = (slug) => ({ slug, name: slug, grantedBy: { id: "e" }, system: { value: {} } });
  const [x] = prolongable({ itemTypes: { effect: [eff], condition: [cond("frightened"), cond("clumsy"), cond("quickened")] } });
  assert.equal(x.count, 2);
});
