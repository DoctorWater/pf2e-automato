import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { ruleToForm, formToRule, applyOf, blankRow } from "../scripts/sheet.mjs";
import { validateRule } from "../scripts/rules.mjs";
import * as au from "../scripts/workshop/automation.mjs";

const t = (k, d) => (d ? `${k}${JSON.stringify(d)}` : k);
const env = {
  t, dc: null, area: { shape: "burst", size: 20 }, author: null,
  conditionLabel: (s) => s.toUpperCase(), uuidName: (u) => (u === "Compendium.x.Item.eff" ? "Эффект" : null),
  statLabel: (s) => `st:${s}`, valued: (s) => s === "frightened"
};
const fear = () => ruleToForm(validateRule({
  v: 1, onUse: { targets: "area", excludeSelf: true, challenge: { statistic: "will", dc: { source: "spell" }, basic: false, rollerRole: "target", byDegree: {
    success: [{ to: "target", condition: { slug: "frightened", value: 1, policy: "max" } }],
    criticalFailure: [{ to: "target", condition: { slug: "frightened", value: 3, policy: "max" }, duration: { value: 1, unit: "rounds", expiry: "turn-start", of: "origin" } }, { to: "target", effect: { uuid: "Compendium.x.Item.eff" } }] } } }
}).rule);

test("режим броска: производная от ch.on/ck.on, смена не теряет данные другого режима", () => {
  const f = fear();
  assert.equal(au.rollMode(f), "save");
  au.setRollMode(f, "check");
  assert.equal(au.rollMode(f), "check");
  assert.equal(f.ch.deg.success.length, 1);   // данные спасброска остались в форме
  au.setRollMode(f, "none");
  assert.equal(au.rollMode(f), "none");
  assert.equal(formToRule(f).onUse.challenge, null);
  au.setRollMode(f, "save");
  assert.equal(validateRule(formToRule(f)).ok, true);
  assert.equal(au.degPath("save"), "f.ch.deg");
  assert.equal(au.degPath("check"), "f.ck.deg");
});

test("плашки: значение у состояния, длительность, эффект по имени, видимость", () => {
  const row = { ...blankRow(), kind: "condition", text: "frightened", value: "2", durValue: "1", durUnit: "rounds" };
  assert.deepEqual(au.plate(row, env), { kind: "condition", name: "FRIGHTENED", valued: true, value: 2, dur: 'workshop.au.dur{"value":1,"unit":"workshop.unitShort.rounds"}', self: false, note: "" });
  const keepNote = au.plate({ ...blankRow(), kind: "effect", text: "x", keep: JSON.stringify({ who: "enemy", unlessEffect: "u", mark: "enemy", choice: "success" }) }, env).note;
  assert.match(keepNote, /keep\.enemy.*keep\.unless.*keep\.mark.*keep\.choice.*success/);
  const plain = au.plate({ ...blankRow(), kind: "condition", text: "prone", to: "self" }, env);
  assert.equal(plain.valued, false);
  assert.equal(plain.self, true);
  assert.equal(au.plate({ ...blankRow(), kind: "condition", text: "frightened" }, env).valued, true);   // значение пока пусто, но состояние со значением
  assert.equal(au.plate({ ...blankRow(), kind: "effect", text: "Compendium.x.Item.eff" }, env).name, "Эффект");
  assert.equal(au.plate({ ...blankRow(), kind: "effect", text: "Compendium.x.Item.zzz" }, env).name, "Compendium.x.Item.zzz");
  assert.equal(au.plate({ ...blankRow(), kind: "note", text: " hi " }, env).name, "hi");
  assert.equal(au.plate({ ...blankRow(), kind: "visibility", visLevel: "hidden" }, env).name, "chat.visLevel.hidden");
  assert.equal(au.plate({ ...blankRow(), kind: "condition", text: "" }, env).name, "?");
  assert.equal(au.plateText({ name: "A", valued: true, value: 2, dur: "1 rd" }), "A 2 (1 rd)");
});

test("сводки строк по форме правила", () => {
  const f = fear(), s = au.summaries(f, env);
  assert.match(s.when, /when\.onUse/);
  assert.match(s.targets, /targets\.area.*burst.*20.*author\.yes/);
  assert.match(s.roll, /roll\.save.*st:will.*dcSource/);
  assert.equal(s.mode, "save");
  assert.match(s.outcome, /sheet\.degree\.success: FRIGHTENED 1 · sheet\.degree\.criticalFailure: FRIGHTENED 3 \(.*\), Эффект/);
  assert.match(s.zone, /zoneOff/);
  assert.match(s.macros, /macrosNone/);
  assert.deepEqual(s.degLists.map((x) => x.deg), au.COLS);
  assert.equal(au.summaries({ ...f, targets: "selected" }, env).zone.includes("zoneNeedsArea"), true);
  assert.match(au.summaries({ ...f, targets: "self" }, env).targets, /targets\.self/);
  assert.match(au.summaries({ ...f, excludeSelf: "auto" }, env).targets, /author\.auto/);
  const known = au.summaries(f, { ...env, dc: 22 });
  assert.match(known.roll, /"dc":"22"/);
  assert.match(au.summaries({ ...f, label: "Страх", yield: "yes" }, env).when, /«Страх».*yieldYes/);
});

test("сводки: проверка автора, без броска, реакция, зона", () => {
  const f = fear();
  au.setRollMode(f, "check");
  f.ck.statistic = "intimidation, deception"; f.ck.vsText = "ac"; f.ck.vsType = "defense"; f.ck.map = "1";
  const s = au.summaries(f, env);
  assert.match(s.roll, /roll\.check.*st:intimidation \/ st:deception.*checks\.ac/);
  assert.match(s.roll, /map.*"n":1/);
  f.ck.vsType = "against"; f.ck.vsText = "will";
  assert.match(au.summaries(f, env).roll, /vsStat.*st:will/);
  au.setRollMode(f, "none");
  f.apply = [{ ...blankRow(), kind: "condition", text: "slowed", value: "1" }];
  const n = au.summaries(f, env);
  assert.equal(n.outcome, "SLOWED 1");
  assert.equal(n.degLists.length, 0);
  f.apply = [];
  assert.match(au.summaries(f, env).outcome, /nothing/);
  f.zone = { on: true, cond: "concealed", condValue: "", effect: "", seconds: "", rounds: "" };
  assert.match(au.summaries(f, env).zone, /zoneOn.*CONCEALED/);
  const r = ruleToForm(validateRule({ v: 1, onAttacked: { trigger: "attack-on-self", bonus: { stat: "ac", type: "circumstance", value: 2 }, cost: "reaction", notify: ["owner"] } }).rule);
  const rs = au.summaries(r, env);
  assert.match(rs.when, /onAttacked.*\+2.*circumstance/);
  assert.equal(rs.targets, "");   // не onUse: строк конвейера нет
  assert.match(au.story(r, env).text, /story\.onAttacked/);
  assert.match(au.story(ruleToForm(null), env).text, /story\.none/);
});

test("связный текст и строки по степеням", () => {
  const f = fear(), st = au.story(f, env);
  assert.match(st.text, /story\.save.*who\.area.*burst.*20/);
  assert.deepEqual(st.degrees.map((d) => d.deg), ["success", "criticalFailure"]);
  f.ch.basic = true;
  assert.match(au.story(f, env).text, /"basic":"workshop\.au\.basic"/);
  au.setRollMode(f, "none");
  f.apply = [{ ...blankRow(), kind: "note", text: "n" }];
  assert.match(au.story(f, env).text, /none-apply.*"list":"n"/);
  au.setRollMode(f, "save");
  assert.equal(au.story(f, env).degrees[0].label, "workshop.au.immediate");   // шаги без броска — отдельной строкой
});

test("шансы степеней: сумма всегда 20", () => {
  for (const [mod, dc] of [[5, 22], [14, 22], [-3, 10], [30, 10], [0, 40]]) assert.equal(au.odds(mod, dc).reduce((a, b) => a + b, 0), 20);
});

test("шансы степеней: проверка на точном примере", () => {
  // mod +0 против СЛ 11: итог = d20. 1 -> крит. провал(нат.1 сдвиг: провал->крит. провал), 2..10 провал, 11..19 успех, 20 -> крит. успех (успех+1)
  assert.deepEqual(au.odds(0, 11), [1, 9, 9, 1]);
  // mod +10 против СЛ 11: итог 11..30; >=21 (r>=11) крит. успех; 1 -> успех -1 ... итог 11 = успех, нат.1 -> провал
  assert.deepEqual(au.odds(10, 11), [0, 1, 9, 10]);
  assert.equal(au.likely([1, 9, 9, 1]), 1);   // ничья — худшая степень
  assert.equal(au.likely([0, 1, 9, 10]), 3);
  const bar = au.bar([1, 9, 9, 1]);
  assert.deepEqual(bar.map((b) => b.deg), au.COLS);
  assert.deepEqual(bar.map((b) => b.pct), [5, 45, 45, 5]);
});

test("пробный запуск: токены, модификатор и СЛ, проблемы", () => {
  const st = (mod, slug) => ({ slug, check: { mod }, dc: { value: 15 } });
  const actor = (mod) => ({ getStatistic: (s) => (s === "will" ? st(mod, "will") : null), saves: { will: { dc: { value: 20 } } }, perception: null });
  const rule = validateRule(formToRule(fear())).rule;
  const rows = au.tokenOdds(rule, [{ name: "Gob", actor: actor(5) }, { name: "NoStat", actor: { getStatistic: () => null } }], { ...env, dc: 22 });
  assert.equal(rows[0].counts.reduce((a, b) => a + b, 0), 20);
  assert.match(rows[0].vs, /vsSave.*st:will.*\+5.*22/);
  assert.equal(typeof rows[0].best, "number");
  assert.equal(rows[1].counts, null);
  assert.match(rows[1].problems[0], /noStatistic/);
  assert.equal(au.tokenOdds(rule, [{ name: "Gob", actor: actor(5) }], { ...env, dc: null })[0].counts, null);   // СЛ неизвестна — шансов нет

  // проверка автора: степень по КЛАССу защиты цели
  const f = fear();
  au.setRollMode(f, "check");
  f.ck.statistic = "athletics"; f.ck.vsType = "defense"; f.ck.vsText = "will";
  const ck = validateRule(formToRule(f)).rule;
  const author = { getStatistic: (s) => (s === "athletics" ? { slug: "athletics", check: { mod: 9 } } : null) };
  const r2 = au.tokenOdds(ck, [{ name: "T", actor: actor(0) }], { ...env, author });
  assert.match(r2[0].vs, /vsCheck.*\+9.*20/);
  assert.deepEqual(r2[0].counts, au.odds(9, 20));
});

test("область: размер кратен 5, @Template и system.area", () => {
  assert.equal(au.clampSize(0), 5);
  assert.equal(au.clampSize("12"), 15);
  assert.equal(au.clampSize(20), 20);
  assert.equal(au.templateTag("cone", 30), "@Template[cone|distance:30]");
  assert.deepEqual(au.parseTemplate("<p>@Template[burst|distance:20]{x}</p>"), { shape: "burst", size: 20 });
  assert.deepEqual(au.parseTemplate("@Template[type:line|distance:60|width:10]"), { shape: "line", size: 60 });
  assert.equal(au.parseTemplate("@Template[burst]"), null);
  assert.equal(au.parseTemplate("нет"), null);
  assert.equal(au.parseTemplate(undefined), null);
  assert.equal(au.withTemplate("<p>a</p>", "cone", 30), "<p>a</p><p>@Template[cone|distance:30]</p>");
  assert.equal(au.withTemplate(undefined, "burst", 5), "<p>@Template[burst|distance:5]</p>");
  assert.equal(au.withTemplate("<p>@Template[burst|distance:20|width:10]{Метка}</p>", "line", 12), "<p>@Template[line|distance:15|width:10]{Метка}</p>");
  assert.equal(au.withTemplate("@Template[type:burst|distance:20]", "cone", 30), "@Template[cone|distance:30]");
  // область заклинания: {type, value}; пустая system.area — берём тег описания, иначе значения по умолчанию
  assert.deepEqual(au.initialArea({ isSpell: true, area: { type: "cone", value: 30 }, description: "" }), { shape: "cone", size: 30 });
  assert.deepEqual(au.initialArea({ isSpell: true, area: null, description: "@Template[line|distance:60]" }), { shape: "line", size: 60 });
  assert.deepEqual(au.initialArea({ isSpell: true, area: null, description: "" }), au.DEFAULT_AREA);
  assert.deepEqual(au.initialArea({ isSpell: false, area: null, description: "@Template[line|distance:60]" }), { shape: "line", size: 60 });
});

test("тег области: неразобранный не трогаем, тип только первым позиционным", () => {
  assert.equal(au.templateState("<p>нет</p>"), "none");
  assert.equal(au.templateState("@Template[burst|distance:20]"), "parsed");
  assert.equal(au.templateState("@Template[burst|distance:resolve(@item.level*5)]"), "unparsed");
  const un = "<p>@Template[cone|distance:resolve(@item.rank*10)]</p>";
  assert.equal(au.withTemplate(un, "burst", 20), un);
  assert.equal(au.parseTemplate("@Template[distance:20|burst]"), null);   // burst не первый позиционный: pf2e тип не найдёт
  assert.equal(au.withTemplate("@Template[burst|distance:20|traits:fire]", "cone", 30), "@Template[cone|distance:30|traits:fire]");
  assert.equal(au.withTemplate("@Template[burst|distance:20]{$&}", "cone", 30), "@Template[cone|distance:30]{$&}");   // замена функцией: $& не раскрывается
});

test("запись области при сохранении: только если ГМ её менял", () => {
  const base = { shape: "burst", size: 10 }, spell = { isSpell: true, srcArea: null, description: "" }, item = { isSpell: false, srcArea: null, description: "<p>a</p>" };
  assert.deepEqual(au.areaPatch(spell, base, base, "area"), { "system.area": { type: "burst", value: 10 } });   // у заклинания области нет вовсе — пишем и значения по умолчанию
  assert.equal(au.areaPatch({ ...spell, description: "@Template[burst|distance:10]" }, base, base, "area"), null);   // К2: источник есть (тег) — не трогаем
  assert.equal(au.areaPatch({ ...spell, srcArea: { type: "burst", value: 10 } }, base, base, "area"), null);
  assert.deepEqual(au.areaPatch(spell, { shape: "cone", size: "12" }, base, "area"), { "system.area": { type: "cone", value: 15 } });
  assert.equal(au.areaPatch(spell, { shape: "cone", size: 30 }, base, "selected"), null);
  assert.equal(au.areaPatch({ ...spell, srcArea: { type: "cone", value: 30 } }, { shape: "cone", size: 30 }, base, "area"), null);
  // не заклинание: тег уходит в описание в том же обновлении
  assert.deepEqual(au.areaPatch(item, { shape: "cone", size: 30 }, base, "area"), { "system.description.value": "<p>a</p><p>@Template[cone|distance:30]</p>" });
  assert.deepEqual(au.areaPatch(item, base, base, "area"), { "system.description.value": "<p>a</p><p>@Template[burst|distance:10]</p>" });   // без тега и без изменений: пишем умолчание
  assert.equal(au.areaPatch({ ...item, description: "@Template[burst|distance:10]" }, base, base, "area"), null);
  assert.equal(au.areaPatch({ ...item, description: "@Template[burst|distance:resolve(x)]" }, { shape: "cone", size: 30 }, base, "area"), null);
});

test("проверка автора: MAP снижает модификатор, пометка «≈»", () => {
  const author = { getStatistic: () => ({ slug: "athletics", check: { mod: 9 } }) };
  const target = { saves: { will: { dc: { value: 20 } } } };
  const mk = (map) => { const f = fear(); au.setRollMode(f, "check"); f.ck.statistic = "athletics"; f.ck.vsType = "defense"; f.ck.vsText = "will"; f.ck.map = map; return validateRule(formToRule(f)).rule; };
  const r = au.tokenOdds(mk("2"), [{ name: "T", actor: target }], { ...env, author })[0];
  assert.deepEqual(r.counts, au.odds(-1, 20));
  assert.match(r.vs, /^≈ .*-1/);
  assert.doesNotMatch(au.tokenOdds(mk("0"), [{ name: "T", actor: target }], { ...env, author })[0].vs, /≈/);
});

test("круг правило -> форма -> правило без потерь по ВСЕМ валидным правилам каталогов", () => {
  let n = 0;
  for (const file of ["catalog.json", "catalog.campaign.json"]) {
    const j = JSON.parse(readFileSync(new URL(`../rules/${file}`, import.meta.url)));
    for (const field of ["bySource", "bySlug", "byName"]) for (const [key, raw] of Object.entries(j[field] ?? {})) {
      const v = validateRule(raw);
      if (!v.ok) continue;
      n++;
      const back = validateRule(formToRule(ruleToForm(v.rule)));
      assert.ok(back.ok, `${file}:${key} ${back.errors}`);
      assert.deepEqual(back.rule, v.rule, `${file}:${key}`);
    }
  }
  assert.ok(n > 50);
});

test("поля шага вне формы (who/mark/choice/unlessEffect), check.roll, builtin-макросы сохраняются", () => {
  const raw = { v: 1, onUse: { targets: "selected", check: { statistic: "athletics", vs: { defense: "ac" }, roll: "system", byDegree: {
    success: [{ to: "target", effect: { uuid: "Compendium.x.Item.e" }, who: "enemy", mark: "enemy", choice: "success", unlessEffect: "Compendium.x.Item.i" }, { to: "self", condition: { slug: "prone", policy: "max" }, who: "ally" }] } } },
  macros: [{ phase: "onUse", builtin: "intimidating-strike" }, { phase: "onUse", uuid: "builtin:twin-feint" }, { phase: "onDegree", degree: "success", uuid: "Macro.abc" }] };
  const v = validateRule(raw);
  assert.ok(v.ok, v.errors.join());
  const back = validateRule(formToRule(ruleToForm(v.rule)));
  assert.deepEqual(back.rule, v.rule);
  const f = ruleToForm(v.rule);
  f.ck.deg.success[1].kind = "note"; f.ck.deg.success[1].text = "x";   // mark/choice не у effect — отбрасываются, who остаётся
  assert.equal(validateRule(formToRule(f)).ok, true);
  const g = ruleToForm(v.rule);
  g.ck.deg.success[0].kind = "note"; g.ck.deg.success[0].text = "x";
  assert.equal(validateRule(formToRule(g)).ok, true);   // иначе валидатор отказал бы из-за mark у note
});

test("шаги формы -> правило без потерь через общий formToRule/applyOf", () => {
  const f = fear();
  f.ch.deg.success.push({ ...blankRow(), kind: "condition", text: "clumsy", value: "1" });
  const v = validateRule(formToRule(f));
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(v.rule.onUse.challenge.byDegree.success.length, 2);
  assert.equal(applyOf({ ...blankRow(), kind: "condition", text: "" }), null);   // пустой шаг в правило не попадает
});
