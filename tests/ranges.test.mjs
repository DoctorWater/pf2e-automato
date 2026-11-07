import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rangeOf, buildRanges } from "../tools/ranges.mjs";
import { tableRange, lookupRange, itemRange } from "../scripts/range.mjs";

const d = (t) => `<p>${t}</p>`;

test("rangeOf: цель в N футах, от автора, путь, range of", () => {
  assert.deepEqual(rangeOf(d("Choose a creature within 30 feet and Demoralize it.")), { ft: 30 });
  assert.deepEqual(rangeOf(d("Choose an enemy within 20 feet of you.")), { ft: 20 });
  assert.deepEqual(rangeOf(d("It Flies from you up to 30 feet in a path you choose.")), { ft: 30 });
  assert.deepEqual(rangeOf(d("This impulse has a range of 30 feet.<hr>Level (+4) The range increases by 15 feet.")), { ft: 30, grow: { every: 4, add: 15 } });
});

test("rangeOf: место области помечено area", () => {
  assert.equal(rangeOf(d("a @Template[burst|distance:10] within 30 feet. Each creature takes damage.")).area, true);
  assert.equal(rangeOf(d("Shadow launches a ball to a range of 40 feet and explodes in a burst.")).area, true);   // область в хвосте предложения
  assert.ok(!rangeOf(d("Another lizard within 30 feet completes its Shocking Burst.")).area);   // название предмета с большой буквы — не область
  assert.equal(rangeOf(d("and the bottom must be within 60 feet of you.")).area, true);
  assert.equal(rangeOf(d("Choose a creature within 60 feet of you.")).area, undefined);
});

test("rangeOf: не дальность применения", () => {
  assert.equal(rangeOf(d("When an unholy creature ends its turn within 10 feet of you, it takes damage.")), null);
  assert.equal(rangeOf(d("Each ally within 10 feet of you at the start of your move gains a bonus.")), null);
  assert.equal(rangeOf(d("Trigger An ally within 30 feet fails a save.")), null);
  assert.equal(rangeOf(d("one creature within 30 feet of both invoked runes")), null);
  assert.equal(rangeOf(d("A creature within 60 feet would drop to 0 Hit Points.")), null);
});

test("rangeOf: несколько разных расстояний — исключение", () => {
  assert.match(rangeOf(d("Choose a creature within 30 feet. Pull it, then an ally within 60 feet heals.")).skip, /30\/60/);
});

test("buildRanges: slug только при согласии всех документов, passive отброшены", () => {
  const mk = (uuid, slug, text, actionType = "action") => ({ uuid, slug, type: "feat", actionType, descEn: d(text) });
  const r = buildRanges([
    mk("u1", "demoralize-x", "Choose a creature within 30 feet."),
    mk("u2", "demoralize-x", "Choose a creature within 30 feet."),
    mk("u3", "shared", "Target a creature within 30 feet."),
    mk("u4", "shared", "Something else entirely."),
    mk("u5", "pass", "A creature within 30 feet.", "passive"),
    mk("u6", "vitality-manipulating-stance", "range of 30 feet")
  ]);
  assert.deepEqual(r.bySlug, { "demoralize-x": { ft: 30 } });
  assert.deepEqual(Object.keys(r.bySource).sort(), ["u1", "u2", "u3"]);
  assert.ok(r.exceptions.shared && r.exceptions["vitality-manipulating-stance"]);
  assert.equal(r.bySource.u5, undefined);
});

test("tableRange / lookupRange: рост по уровню, область не проверяется", () => {
  const e = { ft: 30, grow: { every: 4, add: 15 } };
  assert.equal(tableRange(e, 1), 30);
  assert.equal(tableRange(e, 5), 45);
  assert.equal(tableRange(e, 9), 60);
  assert.equal(tableRange({ ft: 60, area: true }, 1), null);
  assert.equal(tableRange(undefined, 1), null);
  const t = { bySource: { s: { ft: 10 } }, bySlug: { g: { ft: 20 } } };
  assert.equal(lookupRange(t, "s", "g").ft, 10);
  assert.equal(lookupRange(t, "x", "g").ft, 20);
  assert.equal(lookupRange(t, "x", "y"), null);
});

test("itemRange: заклинания как раньше, прочее без таблицы — null", () => {
  assert.equal(itemRange({ type: "spell", range: { max: 30 }, isMelee: false }), 30);
  assert.equal(itemRange({ type: "feat", slug: "x" }), null);
  assert.equal(itemRange({ type: "weapon" }), null);
});

test("rules/ranges.json: группа Дракончика и импульсов", () => {
  const t = JSON.parse(readFileSync(new URL("../rules/ranges.json", import.meta.url), "utf8"));
  const feat = (u) => t.bySource[`Compendium.pf2e.feats-srd.Item.${u}`];
  assert.deepEqual(feat("1SbwsBbuCkkpgeYN"), { ft: 30 });   // Летающее пламя
  assert.deepEqual(feat("MRT8BGiIiVYfVcXh"), { ft: 120 });   // Вечный факел
  assert.deepEqual(feat("XqtJVBwnxBsSo9Py"), { ft: 60, area: true });   // Пылающая колонна: основание в 60 фт
  assert.deepEqual(t.bySource["Compendium.pf2e.actionspf2e.Item.nTBrvt2b9wngyr0i"], { ft: 30, grow: { every: 4, add: 15 } });   // Базовый кинез
  assert.equal(t.bySlug["flying-flame"].ft, 30);
});
