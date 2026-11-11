import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game ??= {};
const { linkedNoteChecks } = await import("../scripts/strike-link.mjs");
const { markNoteChecks } = await import("../scripts/damage-gate.mjs");

const mk = (name, slug) => ({ name, system: { slug }, type: "action" });
const items = [mk("Paralysis", "paralysis"), mk("Grab", "grab"), mk("Other", "other")];
const strike = { actor: { items }, system: { attackEffects: { value: ["paralysis", "grab"] } } };
const linked = (i) => (i.name === "Paralysis" ? { rule: { onEvent: [{ challenge: { statistic: "fortitude" } }] } } : null);

test("linkedNoteChecks: только способности из attackEffects, которые модуль ведёт сам, с их статистикой", () => {
  assert.deepEqual(linkedNoteChecks(strike, linked), [{ name: "Paralysis", statistic: "fortitude" }]);
  assert.deepEqual(linkedNoteChecks(strike, () => null), []);   // режим off / уступка: strikeLinked = null — ничего не прячем
  assert.deepEqual(linkedNoteChecks({ actor: { items }, system: {} }, linked), []);
});

const a = (stat) => { const cls = new Set(); return { dataset: { stat }, cls, classList: { add: (c) => cls.add(c) } }; };
const li = (name, anchors) => ({ querySelector: () => ({ textContent: ` ${name} ` }), querySelectorAll: (sel) => anchors.filter((x) => sel.includes(`"${x.dataset.stat}"`)) });

test("markNoteChecks: по названию в strong и статистике; чужие проверки заметки и чужие заметки не трогаются", () => {
  const fort = a("fortitude"), med = a("medicine"), other = a("fortitude");
  const html = { querySelectorAll: () => [li("Paralysis", [fort, med]), li("Grab", [other])] };
  markNoteChecks(html, [{ name: "Paralysis", statistic: "fortitude" }]);
  assert.deepEqual([fort.cls.has("paf-check-text"), med.cls.has("paf-check-text"), other.cls.has("paf-check-text")], [true, false, false]);
});

test("markNoteChecks: без пар (режим off/уступка) класса нет", () => {
  const fort = a("fortitude");
  markNoteChecks({ querySelectorAll: () => [li("Paralysis", [fort])] }, linkedNoteChecks(strike, () => null));
  assert.equal(fort.cls.size, 0);
});
