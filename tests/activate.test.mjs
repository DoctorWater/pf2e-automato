import test from "node:test";
import assert from "node:assert/strict";
import { validateRule } from "../scripts/rules.mjs";
import { ruleToForm, formToRule } from "../scripts/sheet.mjs";

const ARC = "Compendium.pf2e.spells-srd.Item.arc";
const rule = (activate) => ({ v: 1, activate });
const errs = (activate) => validateRule(rule(activate)).errors.map(String);
const ok = (activate) => { const r = validateRule(rule(activate)); assert.ok(r.ok, r.errors.join()); return r.rule.activate; };
const USE = { targets: "self", apply: [{ to: "self", condition: { slug: "prone" } }] };
const CH = { targets: "selected", challenge: { statistic: "fortitude", byDegree: { failure: [{ to: "target", condition: { slug: "sickened", value: 1 } }] } } };

test("activate: ровно одно из spell | choices | onUse, пара spell+onUse; без spell/choices нужна label", () => {
  assert.match(errs([{ id: "a" }])[0], /^activate\.kind/);
  assert.match(errs([{ spell: ARC, choices: [] }])[0], /^activate\.kind/);
  assert.match(errs([{ label: "x", onUse: USE, choices: [{ id: "a", spell: ARC }, { id: "b", spell: ARC }] }])[0], /^activate\.kind/);
  assert.match(errs([{ onUse: USE }])[0], /^activate\.label \(activate\[0\]\.label\)/);
  assert.match(errs([{ label: "  ", onUse: USE }])[0], /^activate\.label/);
  assert.equal(ok([{ label: "Cut Fear", onUse: USE, dc: 27 }])[0].onUse.targets, "self");
  const both = ok([{ spell: ARC, onUse: USE }])[0];   // каст + добавка
  assert.equal(both.spell, ARC); assert.ok(both.onUse);
  assert.equal(ok([{ spell: ARC }])[0].onUse, undefined);
});

test("activate: id записей уникальны, id вариантов уникальны отдельно", () => {
  assert.match(errs([{ id: "a", spell: ARC }, { id: "a", label: "x", onUse: USE }])[0], /cast\.bad \(activate\[1\]\.id\)/);
  const two = ok([{ id: "c", label: "C", choices: [{ id: "a", spell: ARC }, { id: "b", label: "B", onUse: USE }] }, { id: "a", spell: ARC }]);   // тот же "a" в варианте и в другой записи — можно
  assert.deepEqual(two[0].choices.map((v) => v.id), ["a", "b"]);
  assert.match(errs([{ id: "c", label: "C", choices: [{ id: "a", spell: ARC }, { id: "a", spell: ARC }] }])[0], /activate\.choice \(activate\[0\]\.choices\[1\]\.id\)/);
});

test("activate: choices — 2–6 вариантов, каждый spell или onUse, у варианта без spell label, rank только со spell", () => {
  const v = (n) => Array.from({ length: n }, (_, i) => ({ id: `v${i}`, spell: ARC }));
  for (const n of [0, 1, 7]) assert.match(errs([{ id: "c", label: "C", choices: v(n) }])[0], /^activate\.choices \(activate\[0\]\.choices\)/, String(n));
  assert.match(errs([{ label: "C", choices: "x" }])[0], /^activate\.choices/);
  for (const n of [2, 6]) assert.equal(ok([{ id: "c", label: "C", choices: v(n) }])[0].choices.length, n);
  assert.match(errs([{ label: "C", choices: [{ id: "a" }, { id: "b", spell: ARC }] }])[0], /^activate\.choice \(activate\[0\]\.choices\[0\]\.spell\)/);
  assert.match(errs([{ label: "C", choices: [{ id: "a", onUse: USE }, { id: "b", spell: ARC }] }])[0], /choices\[0\]\.label/);
  assert.match(errs([{ label: "C", choices: [{ id: "a", label: "A", onUse: USE, rank: 2 }, { id: "b", spell: ARC }] }])[0], /choices\[0\]\.rank/);
  assert.match(errs([{ label: "C", choices: [{ id: "a", spell: ARC, dc: 0 }, { id: "b", spell: ARC }] }])[0], /choices\[0\]\.dc/);
  const norm = ok([{ label: "C", choices: [{ spell: ARC, rank: { half: "actor" } }, { label: "B", onUse: USE, dc: { against: "class-spell" } }] }])[0].choices;
  assert.deepEqual(norm[0], { id: "arc", spell: ARC, rank: { half: "actor", min: 1 } });   // id по умолчанию — хвост UUID
  assert.deepEqual(norm[1].dc, { against: "class-spell" });
  assert.equal("choices" in norm[0], false);   // вложенного choices в нормализованном варианте нет
});

test("activate: rank — 1–10 или {half, min}", () => {
  assert.deepEqual(ok([{ spell: ARC, rank: { half: "item", min: 3 } }])[0].rank, { half: "item", min: 3 });
  assert.deepEqual(ok([{ spell: ARC, rank: { half: "actor" } }])[0].rank, { half: "actor", min: 1 });
  for (const r of [{ half: "party" }, { half: "actor", min: 0 }, { half: "actor", min: 11 }, { half: "actor", min: 1.5 }, { min: 2 }, { half: "actor", x: 1 }, 0, 11])
    assert.match(errs([{ spell: ARC, rank: r }])[0], /cast\.bad \(activate\[0\]\.rank\)/, JSON.stringify(r));
  assert.match(errs([{ label: "x", onUse: USE, rank: 2 }])[0], /\.rank/);   // ранг без заклинания
});

test("activate: dc записи — число | {level:high} | {against:class-spell}", () => {
  assert.deepEqual(ok([{ spell: ARC, dc: { against: "class-spell" } }])[0].dc, { against: "class-spell" });
  for (const d of [{ against: "item" }, { against: "class-spell", level: "high" }, { level: "low" }, 0, "30"])
    assert.match(errs([{ spell: ARC, dc: d }])[0], /cast\.bad \(activate\[0\]\.dc\)/, JSON.stringify(d));
});

test("activate: onUse — грамматика rule.onUse; пути ошибок с префиксом записи", () => {
  assert.match(errs([{ label: "x", onUse: { targets: "nobody" } }])[0], /activate\[0\]\.onUse\.targets/);
  assert.match(errs([{ spell: ARC, onUse: "x" }])[0], /activate\[0\]\.onUse/);
  assert.match(errs([{ label: "C", choices: [{ id: "a", label: "A", onUse: { targets: "x" } }, { id: "b", spell: ARC }] }])[0], /activate\[0\]\.choices\[0\]\.onUse\.targets/);
});

test("activate: СЛ шага — только value или не задана; against/source/level/from отвергаются", () => {
  const withDc = (dc) => ({ label: "x", onUse: { ...CH, challenge: { ...CH.challenge, ...(dc && { dc }) } } });
  const a = ok([withDc({ value: 30 })])[0].onUse.challenge;
  assert.deepEqual(a.dc, { value: 30 });
  const none = ok([withDc(null)])[0].onUse.challenge;
  assert.equal("dc" in none, false);   // dc не подставляется заглушкой
  assert.ok(none.byDegree.failure.length);
  for (const dc of [{ against: "will" }, { source: "spell" }, { level: "high" }, { from: "cast" }])
    assert.match(errs([withDc(dc)])[0], /^activate\.dcForm \(activate\[0\]\.onUse\.challenge\.dc\)/, JSON.stringify(dc));
  assert.match(errs([{ label: "C", choices: [{ id: "a", label: "A", onUse: withDc({ against: "x" }).onUse }, { id: "b", spell: ARC }] }])[0], /^activate\.dcForm \(activate\[0\]\.choices\[0\]\.onUse\.challenge\.dc\)/);
  // корневой rule.onUse не затронут: там dc обязателен и against допустим
  assert.match(validateRule({ v: 1, onUse: { ...CH, challenge: { ...CH.challenge } } }).errors.map(String)[0], /dc\.none/);
  assert.ok(validateRule({ v: 1, onUse: { ...CH, challenge: { ...CH.challenge, dc: { against: "will" } } } }).ok);
});

test("activate: форма вкладки сохраняет onUse, choices, rank.half, dc.against как есть", () => {
  const act = ok([{ id: "a", spell: ARC, rank: { half: "actor", min: 2 }, dc: { against: "class-spell" }, onUse: USE }, { id: "c", label: "C", choices: [{ id: "x", spell: ARC }, { id: "y", label: "Y", onUse: USE }] }]);
  const back = validateRule(formToRule(ruleToForm({ v: 1, activate: act })));
  assert.ok(back.ok, back.errors.join());
  assert.deepEqual(back.rule.activate, act);
});

test("activate: checkAnswer принимает новые поля (не лишние ключи, круг формы цел)", async () => {
  const { checkAnswer } = await import("../tools/validate.mjs");
  const any = new Proxy({}, { get: () => true });
  const r = { v: 1, activate: [{ id: "h", spell: ARC, rank: { half: "actor", min: 1 }, dc: { against: "class-spell" }, onUse: USE }, { id: "c", label: "C", choices: [{ id: "a", spell: ARC }, { id: "b", label: "B", onUse: USE }] }] };
  const a = checkAnswer({ uuid: "u", rule: r }, { conditions: any, effects: any }, ARC);
  assert.equal(a.kind, "accepted", JSON.stringify(a.errors));
});
