import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { ruleToForm, formToRule, blankRow } from "../scripts/sheet.mjs";
import { validateRule } from "../scripts/rules.mjs";
import * as au from "../scripts/workshop/automation.mjs";
import * as af from "../scripts/workshop/affliction-edit.mjs";

const t = (k, d) => (d ? `${k}${JSON.stringify(d)}` : k);
const env = { t, damageLabel: (s) => s, conditionLabel: (s) => s };
const json = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));

const stage = (o = {}) => ({ duration: { value: 1, unit: "rounds" }, damage: [], persistent: null, conditions: [], mods: null, text: "", ...o });
const def = (o = {}) => ({ name: "Dragon Bile", kind: "poison", save: { statistic: "fortitude", dc: 37 }, maxDuration: { value: 6, unit: "rounds" }, onset: null, virulent: false,
  stages: [stage({ damage: [{ formula: "6d6", damageType: "poison" }], conditions: [{ slug: "sickened", value: 2 }] }), stage({ conditions: [{ slug: "sickened", value: 3 }] }), stage({ text: "dead" })], ...o });
const rule = (d = def()) => ({ v: 1, onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { value: 20 }, basic: false, rollerRole: "target", byDegree: {
  failure: [{ to: "target", affliction: { stage: 1, def: d } }], criticalFailure: [{ to: "target", affliction: { stage: 2, def: d } }] } }, apply: [] } });
const form = (d) => ruleToForm(validateRule(rule(d)).rule);
const rows = (f) => af.stepRows(f).filter(([, r]) => r.kind === "affliction").map(([, r]) => r);
const defOf = (r) => af.afflOf(r).def;
const rt = (f) => validateRule(formToRule(f));
// порядок ключей byDegree форма нормализует сама (по степеням): сравниваем значения, ключи — по алфавиту
const canon = (o) => JSON.stringify(o, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

test("правка поля определения уходит во все шаги с тем же недугом, стадия у каждого своя", () => {
  const f = form(), [a, b] = rows(f);
  af.afflSet(f, a, "save.dc", "40");
  assert.equal(defOf(a).save.dc, 40);
  assert.deepEqual(defOf(b), defOf(a));
  assert.deepEqual([af.afflOf(a).stage, af.afflOf(b).stage], [1, 2]);
  af.afflSet(f, b, "stage", "3");
  assert.deepEqual([af.afflOf(a).stage, af.afflOf(b).stage], [1, 3]);
  assert.equal(rt(f).ok, true);
});

test("переименование едет во все шаги; правка по новому имени продолжает синхронизировать", () => {
  const f = form(), [a, b] = rows(f);
  af.afflSet(f, a, "name", "Dragon Bile II");
  assert.equal(defOf(b).name, "Dragon Bile II");
  af.afflSet(f, b, "virulent", true);
  assert.equal(defOf(a).virulent, true);
  assert.deepEqual(af.sharedPaths(f, a), ["ch.deg.failure.0", "ch.deg.criticalFailure.0"]);
});

test("другой недуг в правиле не трогается; шаги в событиях и триггерах зоны тоже синхронизируются", () => {
  const f = form(), [a] = rows(f), other = { ...blankRow(), kind: "affliction", text: JSON.stringify({ stage: 1, def: { ...af.blankDef(), name: "Other" } }) }, inEv = blankRow();
  f.apply.push(other);
  Object.assign(inEv, { kind: "affliction", text: a.text });
  f.ev.push({ on: "attack-roll", side: "self", apply: [inEv], ch: { deg: {} } });
  assert.equal(defOf(inEv).name, "Dragon Bile");
  af.afflSet(f, a, "save.dc", "50");
  assert.equal(defOf(other).save.dc, undefined);
  assert.equal(defOf(inEv).save.dc, 50);
  assert.equal(af.sharedPaths(f, a).length, 3);
  assert.match(af.stepLabel("ev.0.apply.0", t), /inEvent/);
});

test("срок: пусто — срока нет; единица хранится отдельно от значения и не сбрасывается перенабором", () => {
  const f = form(), [a] = rows(f), un = (k) => af.afflView(f, a, env, 0)[k].unit;
  af.afflSet(f, a, "maxDuration.unit", "hours");
  af.afflSet(f, a, "maxDuration.value", "");        // стёрли «6»
  assert.equal(defOf(a).maxDuration, null);
  assert.equal(un("maxDuration"), "hours");           // селект по-прежнему «часы»
  af.afflSet(f, a, "maxDuration.value", "8");         // набрали «8»
  assert.deepEqual(defOf(a).maxDuration, { value: 8, unit: "hours" });
  af.afflSet(f, a, "onset.unit", "minutes");          // единица без значения: срока ещё нет
  assert.equal(defOf(a).onset, null);
  assert.equal(un("onset"), "minutes");
  af.afflSet(f, a, "onset.value", "2");
  assert.deepEqual(defOf(a).onset, { value: 2, unit: "minutes" });
  af.afflSet(f, a, "s.0.duration.unit", "days");
  af.afflSet(f, a, "s.0.duration.value", "");
  af.afflSet(f, a, "s.0.duration.value", "3");
  assert.deepEqual(defOf(a).stages[0].duration, { value: 3, unit: "days" });
  assert.equal(rt(f).ok, true);
});

test("группа сессионная: переименование через совпадающее или пустое имя не сливает разные недуги", () => {
  const f = form(), [a, b] = rows(f), other = { ...blankRow(), kind: "affliction", text: JSON.stringify({ stage: 1, def: { ...af.blankDef(), name: "Other", save: { statistic: "will", dc: 11 } } }) };
  f.apply.push(other);
  const before = JSON.stringify(defOf(other));
  for (const n of ["Other", "", "Dragon Bile III"]) af.afflSet(f, a, "name", n);
  assert.equal(JSON.stringify(defOf(other)), before);   // чужой недуг цел
  assert.equal(defOf(b).name, "Dragon Bile III");                                    // группа переименована целиком
  af.afflSet(f, other, "name", "Dragon Bile III");                                   // совпавшее имя группу не меняет
  af.afflSet(f, other, "save.dc", "99");
  assert.equal(defOf(a).save.dc, 37);
  assert.equal(af.sharedPaths(f, a).length, 2);
});

test("«Отделить»: шаг получает независимую копию, остальные остаются общими", () => {
  const f = form(), [a, b] = rows(f);
  af.afflOp(f, b, "split");
  af.afflSet(f, b, "save.dc", "12");
  assert.equal(defOf(a).save.dc, 37);
  assert.deepEqual(af.sharedPaths(f, a), ["ch.deg.failure.0"]);
  af.afflSet(f, a, "name", "A2");
  assert.equal(defOf(b).name, "Dragon Bile");
});

test("шаги неактивных разделов не обходятся: ни в группе, ни в подписях, ни для afflInit", () => {
  const f = form();
  f.ck.deg.failure.push({ ...rows(f)[0] });   // проверка выключена (идёт спасбросок)
  f.targets = "selected";
  f.zone.trig.push({ on: "enter", per: "", apply: [{ ...rows(f)[0] }], ch: { on: false, deg: {} } });   // зона выключена
  assert.equal(af.sharedPaths(f, rows(f)[0]).length, 2);
  assert.equal(rows(f).length, 2);
  f.zone.on = true; f.targets = "area";
  assert.equal(rows(f).length, 3);
  f.ck.on = true; f.ch.on = false;
  assert.equal(af.stepRows(f).some(([p]) => p.startsWith("ch.")), false);
});

test("недуг допускает «Дополнительно» только по валидатору: who/unlessEffect остаются осмысленными, остальное запрещено", () => {
  const f = form(), r = rows(f)[0];
  const st = Object.fromEntries(au.refineState(r).map((s) => [s.key, s.locked]));
  assert.deepEqual([st.ally, st.enemy, st.unless], [false, false, false]);
  assert.deepEqual([st.escape, st.repeat, st.mark, st.choice], [true, true, true, true]);
  au.refineSet(r, "ally", true);
  assert.equal(rt(f).rule.onUse.challenge.byDegree.failure[0].who, "ally");
});

test("плашка шага-недуга короткая: без сырой сводки стадий", () => {
  const f = form(), p = au.plate(f.ch.deg.failure[0], { ...env, uuidName: () => null });
  assert.match(p.name, /afflPlate/);
  assert.equal(p.note, "");
});

test("добавить/удалить стадию: номера пересчитываются, начальная стадия не выходит за число стадий", () => {
  const f = form(), [a, b] = rows(f);
  assert.equal(af.afflOp(f, a, "stageAdd"), 3);
  assert.equal(defOf(b).stages.length, 4);
  af.afflSet(f, b, "stage", "4");
  assert.equal(af.afflOp(f, a, "stageRm:3"), 2);
  assert.equal(af.afflOf(b).stage, 3);   // была 4 — подтянулась
  assert.equal(af.afflOf(a).stage, 1);
  af.afflOp(f, a, "stageRm:0");
  assert.equal(defOf(b).stages.length, 2);
  assert.equal(defOf(b).stages[0].conditions[0].value, 3);   // бывшая вторая стала первой
  assert.equal(af.afflOf(b).stage, 2);
  af.afflOp(f, a, "stageRm:0");
  assert.equal(af.afflOp(f, a, "stageRm:0"), undefined);   // последняя не удаляется
  assert.equal(defOf(a).stages.length, 1);
  assert.equal(af.afflOf(b).stage, 1);
  assert.equal(rt(f).ok, true);
  for (let i = 0; i < 20; i++) af.afflOp(f, a, "stageAdd");
  assert.equal(defOf(a).stages.length, af.MAX_STAGES);
  assert.equal(rt(f).ok, true);
});

test("урон: до 4, правка, удаление; продолжительный — вкл/выкл, СЛ необязательна", () => {
  const f = form(), [a] = rows(f);
  for (let i = 0; i < 6; i++) af.afflOp(f, a, "dmgAdd:1");
  assert.equal(defOf(a).stages[1].damage.length, af.DMG_MAX);
  af.afflSet(f, a, "s.1.damage.2.formula", "2d8+1");
  af.afflSet(f, a, "s.1.damage.2.damageType", "fire");
  af.afflOp(f, a, "dmgRm:1:0");
  assert.deepEqual(defOf(a).stages[1].damage.at(-1), { formula: "1d6", damageType: "poison" });
  assert.deepEqual(defOf(a).stages[1].damage[1], { formula: "2d8+1", damageType: "fire" });
  af.afflOp(f, a, "persOn:0");
  af.afflSet(f, a, "s.0.persistent.dc", "20");
  assert.equal(defOf(a).stages[0].persistent.dc, 20);
  af.afflSet(f, a, "s.0.persistent.dc", "");
  assert.equal("dc" in defOf(a).stages[0].persistent, false);
  assert.equal(rt(f).ok, true);
  af.afflOp(f, a, "persOff:0");
  assert.equal(defOf(a).stages[0].persistent, null);
});

test("состояния: без повторов, до 6; значимому — значение 1; −/+ в пределах 1..10; убрать", () => {
  const f = form(), [a] = rows(f), valued = (s) => s !== "blinded";
  af.afflSet(f, a, "s.2.cond.add", "frightened", { valued });
  af.afflSet(f, a, "s.2.cond.add", "frightened", { valued });
  af.afflSet(f, a, "s.2.cond.add", "blinded", { valued });
  assert.deepEqual(defOf(a).stages[2].conditions, [{ slug: "frightened", value: 1 }, { slug: "blinded" }]);
  af.afflOp(f, a, "condStep:2:0:-1");
  assert.equal(defOf(a).stages[2].conditions[0].value, 1);
  for (let i = 0; i < 15; i++) af.afflOp(f, a, "condStep:2:0:1");
  assert.equal(defOf(a).stages[2].conditions[0].value, af.COND_VALUE_MAX);
  for (const s of ["clumsy", "slowed", "stunned", "dazzled", "fatigued"]) af.afflSet(f, a, "s.2.cond.add", s);
  assert.equal(defOf(a).stages[2].conditions.length, af.COND_MAX);
  assert.equal(rt(f).ok, true);
  af.afflOp(f, a, "condRm:2:1");
  assert.equal(defOf(a).stages[2].conditions.some((c) => c.slug === "blinded"), false);
});

test("штрафы стадии: тот же редактор свойств; пустой список — null", () => {
  const f = form(), [a, b] = rows(f);
  af.afflOp(f, a, "modAdd:0:bonus");
  assert.equal(defOf(b).stages[0].mods.length, 1);
  af.afflSet(f, a, "s.0.mods.0.value", "-2");
  af.afflSet(f, a, "s.0.mods.0.target", "ac");
  assert.deepEqual(defOf(b).stages[0].mods, [{ bonus: { target: "ac", type: "status", value: -2 } }]);
  assert.equal(rt(f).ok, true);
  af.afflOp(f, a, "modRm:0:0");
  assert.equal(defOf(a).stages[0].mods, null);
  assert.equal(rt(f).ok, true);
});

test("новый шаг-недуг: пустое определение с одной стадией; в правиле с недугом берётся его определение", () => {
  const f = ruleToForm(null), r = blankRow();
  f.kind = "onUse";
  af.afflInit(r, f);
  assert.equal(r.kind, "affliction");
  assert.equal(r.to, "target");
  assert.deepEqual(af.afflOf(r), { stage: 1, def: af.blankDef() });
  f.apply.push(r);
  const x = af.afflView(f, r, env);
  assert.equal(x.n, 1);
  assert.equal(x.canRm, false);
  assert.equal(rt(f).ok, false);   // название пустое — валидатор не пропустит
  af.afflSet(f, r, "name", "Дым");
  assert.equal(rt(f).ok, true, JSON.stringify(rt(f).errors));
  const g = form(), second = blankRow();
  af.afflInit(second, g);
  assert.equal(defOf(second).name, "Dragon Bile");
  assert.equal(af.afflOf(second).stage, 1);
  g.apply.push(second);
  assert.equal(af.sharedPaths(g, second).length, 3);
});

test("сводка стадии, подписи шагов, раскрытая стадия", () => {
  const d = def();
  assert.equal(af.stageLine(d.stages[0], env), `workshop.au.dur{"value":1,"unit":"workshop.unitShort.rounds"} · 6d6 poison · sickened 2`);
  assert.equal(af.stageLine(stage({ duration: null }), env), "—");
  assert.equal(af.stepLabel("ch.deg.failure.0", t), "sheet.degree.failure");
  assert.match(af.stepLabel("ev.1.ch.deg.criticalFailure.0", t), /criticalFailure.*inEvent.*"n":2/);
  assert.match(af.stepLabel("apply.0", t), /immediate/);
  const f = form(), v = af.afflView(f, rows(f)[1], env);
  assert.equal(v.stage, 2);
  assert.deepEqual(v.stages.map((s) => s.open), [false, true, false]);   // раскрыта стадия шага
  assert.equal(af.afflView(f, rows(f)[1], env, 0).stages[0].open, true);
});

/* ---------- круговой проход по каталогу и черновикам ---------- */

function rulesWithAffliction() {
  const dir = (d) => readdirSync(new URL(`../${d}/`, import.meta.url)).map((n) => `${d}/${n}`).filter((n) => n.endsWith(".json"));
  const files = dir("rules").filter((n) => /catalog.*\.json$/.test(n)).concat(dir("rules/drafts-accepted"));
  const found = [];
  const walk = (o, file) => {
    if (Array.isArray(o)) return o.forEach((x) => walk(x, file));
    if (!o || typeof o !== "object") return;
    if (o.v === 1 && (o.onUse || o.onEvent || o.cast) && JSON.stringify(o).includes('"affliction"')) { found.push({ file, rule: o }); return; }
    for (const v of Object.values(o)) walk(v, file);
  };
  for (const file of files) walk(json(file), file);
  return found;
}

test("каталог и черновики: форма -> правило без потерь, в том числе после «пустых» правок каждого поля редактора", () => {
  const all = rulesWithAffliction();
  assert.ok(all.length > 300, `правил с недугом: ${all.length}`);
  const bad = [];
  for (const { file, rule: raw } of all) {
    const v = validateRule(raw);
    if (!v.ok) { bad.push(`${file}: исходное правило не проходит валидатор`); continue; }
    const want = canon(v.rule), f = ruleToForm(v.rule);
    if (canon(rt(f).rule) !== want) bad.push(`${file}: форма теряет данные`);
    // каждое поле редактора перезаписывается тем же значением, что показывает: правило не должно измениться
    for (const row of rows(f)) {
      const d = defOf(row), x = af.afflView(f, row, env, 0);
      const same = [["name", x.name], ["kind", x.kind], ["save.statistic", x.statistic], ["save.dc", x.dc], ["maxDuration.value", x.maxDuration.value],
        ["onset.value", x.onset.value], ["virulent", x.virulent], ["stage", x.stage]];   // единица без значения — не «пустая правка» (ставит значение 1), её не трогаем
      for (const k of ["maxDuration", "onset"]) if (x[k].value !== "") same.push([`${k}.unit`, x[k].unit]);
      d.stages.forEach((s, i) => {
        same.push([`s.${i}.duration.value`, s.duration?.value ?? ""], [`s.${i}.text`, s.text ?? ""]);
        if (s.duration) same.push([`s.${i}.duration.unit`, s.duration.unit]);
        (s.damage ?? []).forEach((g, j) => same.push([`s.${i}.damage.${j}.formula`, g.formula], [`s.${i}.damage.${j}.damageType`, g.damageType]));
        if (s.persistent) same.push([`s.${i}.persistent.formula`, s.persistent.formula], [`s.${i}.persistent.damageType`, s.persistent.damageType], [`s.${i}.persistent.dc`, s.persistent.dc ?? ""]);
        (s.mods ?? []).forEach((m, k) => { const [kind, o] = Object.entries(m)[0]; if (kind !== "forbid") for (const [field, val] of Object.entries(o)) same.push([`s.${i}.mods.${k}.${field}`, Array.isArray(val) ? val.join(", ") : val]); });
      });
      for (const [name, val] of same) {
        const was = row.text;
        af.afflSet(f, row, name, typeof val === "number" ? String(val) : val);
        if (row.text !== was) bad.push(`${file}: поле ${name}=${JSON.stringify(val)} меняет определение`);
      }
    }
    if (canon(rt(f).rule) !== want) bad.push(`${file}: пустые правки меняют правило`);
  }
  assert.deepEqual(bad.slice(0, 5), []);
});
