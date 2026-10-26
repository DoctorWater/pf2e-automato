// Обход укрытия эффектами пака (plan-cover-bypass.md): документы пака, исключение валидатора, строки промпта.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sourceDocs } from "../tools/build-packs.mjs";
import { COVER_FORMS, COVER_FIXES, COVER_TABLE } from "../tools/cover-bypass.mjs";
import { checkAnswer } from "../tools/validate.mjs";
import { readModuleDocs } from "../tools/pa-effects.mjs";

const docs = new Map(sourceDocs().map((d) => [`Compendium.pf2e-automato.effects.Item.${d._id}`, d]));
const refs = { conditions: {}, effects: {} };
const step = (uuid) => ({ v: 1, label: "Aim", onUse: { targets: "self", apply: [{ to: "self", effect: { uuid } }] } });

test("пак: пять проводников — по одному носителю removeAfterRoll с уникальным slug, все EphemeralEffect ведут на поправки пака", () => {
  const slugs = new Set();
  for (const [form, uuid] of Object.entries(COVER_FORMS)) {
    const rules = docs.get(uuid)?.system.rules ?? assert.fail(form);
    const carriers = rules.filter((r) => r.key === "FlatModifier");
    assert.equal(carriers.length, 1, form);
    assert.deepEqual([carriers[0].type, carriers[0].value, carriers[0].removeAfterRoll, carriers[0].selector], ["untyped", 0, "if-enabled", ["strike-attack-roll", "spell-attack-roll"]]);
    assert.match(carriers[0].slug, /^af-cover-bypass-/);
    slugs.add(carriers[0].slug);
    const eph = rules.filter((r) => r.key === "EphemeralEffect");
    assert.ok(eph.length >= 1 && eph.length + 1 === rules.length, form);
    for (const e of eph) assert.ok(Object.values(COVER_FIXES).includes(e.uuid), form);
  }
  assert.equal(slugs.size, 5);
});

test("пак: поправки E0/E1/E2 — AdjustModifier ac на slug cover и укрытие (русский перевод)", () => {
  const want = { E0: { suppress: true }, E1: { mode: "downgrade", value: 1 }, E2: { mode: "downgrade", value: 2 } };
  for (const [k, uuid] of Object.entries(COVER_FIXES)) {
    const rules = docs.get(uuid).system.rules;
    assert.deepEqual(rules.map((r) => r.slug).sort(), ["cover", "укрытие"], k);
    for (const r of rules) assert.deepEqual({ ...r, slug: 0 }, { key: "AdjustModifier", selector: "ac", slug: 0, ...want[k] });
  }
});

// Какой попытке какой уровень укрытия: предикаты EphemeralEffect каждой формы, проверенные на всех уровнях рядом с таблицей из tools/cover-bypass.mjs.
test("пак: форма × уровень укрытия -> поправка", () => {
  const LEVELS = ["lesser", "standard", "greater", "greater-prone"];
  const fixKey = Object.fromEntries(Object.entries(COVER_FIXES).map(([k, u]) => [u, k]));
  const want = {
    all: { lesser: "E0", standard: "E0", greater: "E0", "greater-prone": "E0" }, L: { lesser: "E0" }, LS: { lesser: "E0", standard: "E0" },
    LSG: { lesser: "E0", standard: "E0", greater: "E2", "greater-prone": "E2" }, step: { lesser: "E0", standard: "E1", greater: "E2", "greater-prone": "E2" }
  };
  assert.deepEqual(COVER_TABLE, want);
  const holds = (p, lv) => [p].flat().every((x) => typeof x === "string" ? x === `target:cover-level:${lv}` : x.or.includes(`target:cover-level:${lv}`));
  for (const [form, uuid] of Object.entries(COVER_FORMS)) {
    const got = {};
    for (const lv of LEVELS) {
      const hit = docs.get(uuid).system.rules.filter((r) => r.key === "EphemeralEffect" && (r.predicate ?? []).every((p) => holds(p, lv)));
      assert.ok(hit.length <= 1, `${form}/${lv}`);
      if (hit.length) got[lv] = fixKey[hit[0].uuid];
    }
    assert.deepEqual(got, want[form], form);
  }
});

test("импорт PA: записи module:true и их файлы сохраняются", () => {
  const { entries, files } = readModuleDocs();
  for (const id of ["pAfGrabNoImmob01", ...Object.values(COVER_FORMS), ...Object.values(COVER_FIXES)].map((u) => u.split(".").pop())) {
    assert.ok(entries[id], id);
    assert.ok(Object.keys(files).some((f) => f.endsWith(`_${id}.json`)), id);
  }
});

test("валидатор: форма обхода укрытия только to:self", () => {
  const r = checkAnswer({ uuid: "u", rule: { v: 1, label: "Aim", onUse: { targets: "self", apply: [{ to: "target", effect: { uuid: COVER_FORMS.all } }] } } }, refs, "<p>Your Strike ignores cover.</p>");
  assert.notEqual(r.kind, "accepted");
  assert.match(r.errors.join(), /"to": "self"/);
});

test("валидатор: шаг с uuid формы обхода принят без ссылки в тексте и вне refs; чужой uuid модуля — по-прежнему ошибка", () => {
  for (const uuid of Object.values(COVER_FORMS)) assert.equal(checkAnswer({ uuid: "u", rule: step(uuid) }, refs, "<p>Your Strike ignores cover.</p>").kind, "accepted", uuid);
  const bad = checkAnswer({ uuid: "u", rule: step("Compendium.pf2e-automato.effects.Item.pAfCoverFixE0001") }, refs, "<p>text</p>");
  assert.notEqual(bad.kind, "accepted");
  assert.match(bad.errors.join(), /not found/);
});

test("промпт: пять форм и их uuid перечислены", () => {
  const p = readFileSync(new URL("../tools/prompts/draft-rule.md", import.meta.url), "utf8");
  for (const u of Object.values(COVER_FORMS)) assert.ok(p.includes(u), u);
});
