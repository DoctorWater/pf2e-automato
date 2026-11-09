import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { ruleToForm, formToRule, applyOf, blankRow, keepSet } from "../scripts/sheet.mjs";
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
  assert.match(au.summaries({ ...f, label: "Fear", yield: "yes" }, { ...env, itemName: "Страх" }).when, /«Страх».*yieldYes/);
  assert.doesNotMatch(au.summaries({ ...f, label: "Fear", yield: "yes" }, env).when, /Fear/);   // английский label каталога не показываем
  const fr = au.plate({ ...blankRow(), kind: "condition", text: "frightened", value: "" }, { ...env, valued: () => true });
  assert.equal(fr.value, 1);   // value не задан — pf2e ставит 1
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
  for (const file of ["catalog.json"]) {
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

/* ---------- A3/B1/D: редакторы вместо JSON ---------- */

const step = (kind, o = {}) => ({ ...blankRow(), kind, to: "target", ...o });
const ruleWith = (apply, ch) => ({ v: 1, onUse: { targets: "selected", ...(ch ? { challenge: { statistic: "will", dc: { value: 20 }, basic: false, rollerRole: "target", byDegree: { failure: apply }, ...ch } } : {}), apply: ch ? [] : apply } });
const formWith = (row, inChallenge = false) => { const f = ruleToForm(validateRule(ruleWith([{ to: "target", note: "x" }], inChallenge ? {} : null)).rule); (inChallenge ? f.ch.deg.failure : f.apply)[0] = row; return f; };
const stateOf = (row) => Object.fromEntries(au.refineState(row).map((s) => [s.key, s]));

const KEEP_FOR = {
  ally: ["who", "ally"], enemy: ["who", "enemy"], escape: ["escape", { stats: ["athletics"] }], repeat: ["repeat", { on: "turn-end", statistic: "will", dc: 20 }],
  repeatCh: ["repeat", { on: "turn-end" }], unless: ["unlessEffect", "Compendium.x.Item.i"], mark: ["mark", "enemy"], choice: ["choice", "x"]
};
const BASES = {
  cond: { kind: "condition", text: "slowed", value: "1" },
  condReduce: { kind: "condition", text: "frightened", value: "1", policy: "reduce" },
  effReady: { kind: "effect", text: "Compendium.x.Item.e" },
  effStack: { kind: "effect", text: "Compendium.x.Item.e", stack: true },
  effUnstack: { kind: "effect", text: "Compendium.x.Item.e", unstack: true },
  effReplace: { kind: "effect", text: "Compendium.x.Item.e", replace: true },
  effOwn: { kind: "effect", text: JSON.stringify([{ forbid: "reactions" }]), durValue: "1" },
  note: { kind: "note", text: "x" },
  damage: { kind: "damage", text: "1d6", pType: "fire" },
  pers: { kind: "persistent", text: "1d6", pType: "fire" },
  rmEff: { kind: "removeEffect", text: "foo" },
  vis: { kind: "visibility", visOf: "target" },
  choose: { kind: "choose", text: JSON.stringify({ from: "allies" }) }
};
// место шага: apply без испытания, степени испытания, степени проверки; перед шагом — choose, чтобы to:"chosen" был допустим
const PLACES = {
  apply: (rows) => ({ v: 1, onUse: { targets: "selected", apply: rows } }),
  ch: (rows) => ({ v: 1, onUse: { targets: "selected", apply: [], challenge: { statistic: "will", dc: { value: 20 }, basic: false, rollerRole: "target", byDegree: { failure: rows } } } }),
  ck: (rows) => ({ v: 1, onUse: { targets: "selected", apply: [], check: { statistic: "athletics", vs: "ac", byDegree: { failure: rows } } } })
};
const verdict = (place, row) => {
  const f = ruleToForm(validateRule(PLACES[place]([{ to: "self", choose: { from: "allies" } }, { to: "target", note: "y" }])).rule);
  const list = place === "apply" ? f.apply : place === "ch" ? f.ch.deg.failure : f.ck.deg.failure;
  list[1] = row;
  return validateRule(formToRule(f)).ok;
};

test("«Дополнительно»: перебор вид шага × кому × место × плашка — доступность совпадает с валидатором", () => {
  const LENIENT = { ally: "needTarget", enemy: "needTarget", mark: "needEffect", choice: "needEffect" }, seen = { allowed: 0, locked: 0 };
  for (const [bn, b] of Object.entries(BASES)) for (const to of ["target", "self", "party", "allies", "chosen"]) for (const place of Object.keys(PLACES)) {
    const base = { ...blankRow(), ...b, to, ...(to === "allies" && { range: "30" }) };
    if (!verdict(place, base)) continue;   // основа сама недопустима (например choose не в to:self) — не наш случай
    for (const state of au.refineState(base)) {
      const row = { ...base }, [name, val] = KEEP_FOR[state.key === "repeat" && place === "ch" ? "repeatCh" : state.key];
      keepSet(row, name, val);
      const ok = verdict(place, row), id = `${bn} to=${to} ${place} ${state.key}`;
      if (!state.locked) { assert.equal(ok, true, `${id}: плашка доступна, а валидатор отвергает (${state.why})`); seen.allowed++; }
      else {
        seen.locked++;
        // запертая, но «валидная» — только то, что валидатор молча пропускает: who у шагов не «к цели» (рантайм его не проверяет, apply.mjs),
        // mark/choice у не-эффекта (applyOf их не пишет)
        if (ok) assert.equal(LENIENT[state.key], state.why, `${id}: заперта (${state.why}), а валидатор принимает`);
      }
    }
  }
  assert.ok(seen.allowed > 100 && seen.locked > 100, JSON.stringify(seen));
});

test("«Дополнительно»: причины и bad", () => {
  const cond = step("condition", { text: "slowed", value: "1" });
  assert.equal(stateOf({ ...cond, to: "self" }).ally.why, "needTarget");
  assert.equal(stateOf({ ...cond, to: "self" }).escape.why, "needTarget");
  assert.equal(stateOf(step("note", { text: "x" })).repeat.why, "needCarrier");
  assert.equal(stateOf({ ...cond, policy: "reduce" }).repeat.why, "noReduce");
  const both = { ...cond }; au.refineClick(both, "escape");
  assert.deepEqual([stateOf(both).repeat.locked, stateOf(both).repeat.why, stateOf(both).escape.locked], [true, "vsEscape", false]);
  const bad = { ...both, to: "self" };
  assert.deepEqual([stateOf(bad).escape.bad, stateOf(bad).escape.locked], [true, false]);
  // включённые без значения — bad с причиной empty, не locked
  const eff = step("effect", { text: "Compendium.x.Item.e" });
  au.refineClick(eff, "unless"); au.refineClick(eff, "choice");
  assert.deepEqual([stateOf(eff).unless.bad, stateOf(eff).unless.why, stateOf(eff).choice.bad], [true, "empty", true]);
  au.keepEdit(eff, "unless", "Compendium.x.Item.i"); au.keepEdit(eff, "choice", "2");
  assert.deepEqual([stateOf(eff).unless.bad, stateOf(eff).choice.bad], [false, false]);
});

test("смена вида шага чистит недопустимое для нового вида: Освобождение -> «Игрок выбирает»", () => {
  const row = step("condition", { text: "slowed", value: "1" });
  au.refineClick(row, "escape"); au.refineClick(row, "ally");
  au.setStepKind(row, "choose");
  assert.equal(row.text, JSON.stringify({ from: "allies" }));
  assert.equal(row.keep, "");   // и escape (нет носителя), и who (choose всегда на себя)
  assert.equal(verdict("apply", { ...row, to: "self" }), true);
  const eff = step("effect", { text: "Compendium.x.Item.e" });
  au.refineClick(eff, "mark"); au.refineClick(eff, "enemy");
  au.setStepKind(eff, "condition");
  assert.deepEqual(JSON.parse(eff.keep), { who: "enemy" });   // mark — только у effect; who остаётся
  assert.deepEqual([au.setStepKind(eff, "persistent"), eff.text], [undefined, "1d6"]);
});

test("setStepText: состояние подставляет значение, у эффекта «[» срезается", () => {
  const c = step("condition", { text: "" });
  au.setStepText(c, "frightened", true); assert.equal(c.value, "1");
  au.setStepText(c, "prone", false); assert.equal(c.value, "");
  const e = step("effect");
  au.setStepText(e, " [{\"x\":1}]"); assert.equal(e.text, "{\"x\":1}]");
});

test("плашки: who взаимоисключающие, клик по параметрической открывает карточку, недоступная не меняется", () => {
  const row = step("condition", { text: "slowed", value: "1" });
  assert.equal(au.refineClick(row, "ally"), false);
  assert.equal(stateOf(row).ally.on, true);
  au.refineClick(row, "enemy");
  assert.deepEqual([stateOf(row).ally.on, stateOf(row).enemy.on, JSON.parse(row.keep).who], [false, true, "enemy"]);
  au.refineClick(row, "enemy");
  assert.equal(row.keep, "");   // выключили — поле ушло, пустая строка
  assert.equal(au.refineClick(row, "repeat", false), true);   // включилась и открылась
  assert.equal(au.refineClick(row, "repeat", true), false);   // включённая: клик закрывает
  assert.equal(au.refineClick(row, "repeat", false), true);    // и открывает
  const before = row.keep;
  assert.equal(au.refineClick(row, "escape", false), false);   // vsRepeat: недоступна
  assert.equal(au.refineClick(row, "mark", false), false);     // не effect
  assert.equal(row.keep, before);
  au.refineSet(row, "repeat", false);
  assert.equal(row.keep, "");
});

test("повторный спасбросок и Освобождение: поля карточки -> правило, туда-обратно без потерь", () => {
  const row = step("condition", { text: "slowed", value: "1", durValue: "1", durUnit: "minutes" });
  au.refineClick(row, "repeat");
  au.keepEdit(row, "repeat.on", "turn-start");
  au.keepEdit(row, "repeat.statistic", "will");
  au.keepEdit(row, "repeat.dc", "22");
  au.keepEdit(row, "repeat.end.failure", true);
  au.keepEdit(row, "repeat.end.success", false);
  au.keepEdit(row, "repeat.traits", "mental, fear");
  const f = formWith(row);
  const v = validateRule(formToRule(f));
  assert.ok(v.ok, v.errors.join());
  assert.deepEqual(v.rule.onUse.apply[0].repeat, { on: "turn-start", statistic: "will", dc: 22, traits: ["mental", "fear"], end: ["failure", "criticalSuccess"] });
  assert.deepEqual(validateRule(formToRule(ruleToForm(v.rule))).rule, v.rule);
  assert.deepEqual(au.keepView(f.apply[0]).repeat.end, { criticalFailure: false, failure: true, success: false, criticalSuccess: true });

  const esc = step("effect", { text: "Compendium.x.Item.e" });
  au.refineClick(esc, "escape");
  assert.deepEqual(au.keepView(esc).escape.stats, { athletics: true, acrobatics: true, unarmed: false });
  au.keepEdit(esc, "escape.stats.unarmed", true); au.keepEdit(esc, "escape.stats.acrobatics", false);
  au.keepEdit(esc, "escape.dc", "18"); au.keepEdit(esc, "escape.dcStat", "spell");
  const ev = validateRule(formToRule(formWith(esc)));
  assert.ok(ev.ok, ev.errors.join());
  assert.deepEqual(ev.rule.onUse.apply[0].escape, { stats: ["athletics", "unarmed"], dc: 18, dcStat: "spell" });
  au.keepEdit(esc, "escape.dc", ""); au.keepEdit(esc, "escape.dcStat", "");
  assert.deepEqual(JSON.parse(esc.keep).escape, { stats: ["athletics", "unarmed"] });
  au.keepEdit(esc, "escape.stats.athletics", false); au.keepEdit(esc, "escape.stats.unarmed", false);
  assert.equal(validateRule(formToRule(formWith(esc))).ok, false);   // пустой набор — ошибка валидатора, а не молчаливая подмена
});

test("повтор внутри испытания: навык и СЛ берутся из испытания", () => {
  const row = step("condition", { text: "slowed", value: "1" });
  au.refineClick(row, "repeat");
  assert.equal(au.inChallenge("f.ch.deg.failure.0"), true);
  assert.equal(au.inChallenge("f.ev.0.ch.deg.success.1"), true);
  assert.equal(au.inChallenge("f.zone.trig.0.ch.deg.success.1"), true);
  assert.equal(au.inChallenge("f.apply.0"), false);
  assert.equal(au.inChallenge("f.ck.deg.success.0"), false);
  assert.ok(validateRule(formToRule(formWith(row, true))).ok);
  assert.equal(validateRule(formToRule(formWith(row, false))).ok, false);   // вне испытания statistic и dc обязательны
});

test("unless / mark / choice: пустое значение в правило не идёт, число остаётся числом", () => {
  const row = step("effect", { text: "Compendium.x.Item.e" });
  au.refineClick(row, "unless"); au.refineClick(row, "mark"); au.refineClick(row, "choice");
  assert.equal(stateOf(row).unless.on && stateOf(row).choice.on, true);
  const a0 = applyOf(row);
  assert.deepEqual([a0.unlessEffect, a0.choice, a0.mark], [undefined, undefined, "enemy"]);
  au.keepEdit(row, "unless", " Compendium.x.Item.i "); au.keepEdit(row, "choice", "2");
  const a1 = applyOf(row);
  assert.deepEqual([a1.unlessEffect, a1.choice], ["Compendium.x.Item.i", 2]);
  au.keepEdit(row, "choice", "athletics");
  assert.equal(applyOf(row).choice, "athletics");
  assert.equal(validateRule(formToRule(formWith(row))).ok, true);
});

test("свой эффект: свойства, срок, переключение источника", () => {
  const row = step("effect", { text: "Compendium.x.Item.e", stack: true, replace: false });
  au.refineClick(row, "unless");
  au.setEffectSource(row, "own");
  assert.equal(au.isOwn(row), true);
  assert.deepEqual([row.durValue, row.stack, JSON.parse(row.keep || "{}").unlessEffect], ["1", false, undefined]);   // срок подставлен, несочетаемое снято
  assert.deepEqual(au.modsView(row).map((m) => m.kind), ["bonus"]);
  au.modSet(row, 0, "value", "−2"); au.modSet(row, 0, "type", "status"); au.modSet(row, 0, "target", "will");
  au.modAdd(row, "speed"); au.modSet(row, 1, "value", "-10");
  au.modAdd(row, "resist"); au.modSet(row, 2, "dmg", "fire"); au.modSet(row, 2, "except", "magical, adamantine");
  au.modAdd(row, "forbid");
  assert.equal(au.modCanAdd(row, "weak"), false);   // уже 4 свойства
  assert.equal(au.modCanAdd(row, "bonus"), false);
  Object.assign(row, { durUnit: "rounds", durExpiry: "turn-end", durOf: "target" });
  const v = validateRule(formToRule(formWith(row)));
  assert.ok(v.ok, v.errors.join());
  const a = v.rule.onUse.apply[0];
  assert.deepEqual(a.effect.mods, [{ bonus: { target: "will", type: "status", value: -2 } }, { speed: { type: "status", value: -10 } }, { resist: { dmg: "fire", value: 5, except: ["magical", "adamantine"] } }, { forbid: "reactions" }]);
  assert.deepEqual(a.duration, { value: 1, unit: "rounds", expiry: "turn-end", of: "target" });
  assert.deepEqual(validateRule(formToRule(ruleToForm(v.rule))).rule, v.rule);
  au.modRemove(row, 3); au.modRemove(row, 2);
  assert.equal(au.modCanAdd(row, "bonus"), true);
  au.modAdd(row, "bonus");   // вторая цель бонуса — первая свободная, без дубля
  assert.notEqual(au.modsView(row)[2].target, "will");
  assert.ok(validateRule(formToRule(formWith(row))).ok);
  au.modSet(row, 0, "value", "-");   // черновик набора: уходит в валидатор ошибкой, не падает
  assert.equal(validateRule(formToRule(formWith(row))).ok, false);
  au.setEffectSource(row, "ready");
  assert.deepEqual([au.isOwn(row), row.text, row.durValue, row.durOf], [false, "Compendium.x.Item.e", "", "origin"]);   // UUID вернулся из keep.hold
  assert.deepEqual(JSON.parse(row.keep), { unlessEffect: "" });   // и «кроме»; hold опустел
});

test("готовый -> свой -> готовый возвращает UUID и поля; спрятанное не попадает в правило", () => {
  const row = step("effect", { text: "Compendium.x.Item.e" });
  au.refineClick(row, "unless"); au.keepEdit(row, "unless", "Compendium.x.Item.i"); au.refineClick(row, "mark"); au.refineClick(row, "choice"); au.keepEdit(row, "choice", "-2");
  const before = JSON.parse(row.keep);
  au.setEffectSource(row, "own");
  assert.deepEqual(Object.keys(JSON.parse(row.keep)), ["hold"]);
  assert.deepEqual(applyOf(row).unlessEffect, undefined);
  const own = validateRule(formToRule(formWith(row)));
  assert.ok(own.ok, own.errors.join());
  assert.deepEqual(Object.keys(own.rule.onUse.apply[0]).filter((k) => ["unlessEffect", "mark", "choice", "hold"].includes(k)), []);
  au.setEffectSource(row, "ready");
  assert.equal(row.text, "Compendium.x.Item.e");
  const after = JSON.parse(row.keep);
  assert.deepEqual(after, before);   // в том числе число осталось числом
  assert.equal("hold" in after, false);
});

test("choice: тип, что был — строка из каталога остаётся строкой; «+2» принимается в свойстве", () => {
  const row = step("effect", { text: "Compendium.x.Item.e", keep: JSON.stringify({ choice: "-2" }) });
  au.keepEdit(row, "choice", "-3"); assert.equal(JSON.parse(row.keep).choice, "-3");
  au.keepEdit(row, "choice", "athletics"); au.keepEdit(row, "choice", "4"); assert.equal(JSON.parse(row.keep).choice, 4);
  const own = step("effect", { text: "" });
  au.setEffectSource(own, "own");
  au.modSet(own, 0, "value", "+2"); assert.equal(au.modsView(own)[0].value, 2);
});

test("choose «варианты -> союзники -> варианты» возвращает варианты", () => {
  const row = step("choose", { to: "self", text: JSON.stringify({ from: "options", options: [{ value: "fire", label: "Огонь" }, { value: "cold" }] }) });
  au.chooseSet(row, "from", "allies");
  assert.deepEqual(au.chooseOf(row), { from: "allies" });
  assert.equal(validateRule(formToRule(formWith(row))).ok, true);
  au.chooseSet(row, "from", "options");
  assert.deepEqual(au.chooseOf(row).options, [{ value: "fire", label: "Огонь" }, { value: "cold" }]);
  assert.equal(row.keep, "");
});

test("свой эффект: сопротивление и слабость без дублей кубиков", () => {
  const row = step("effect", { text: "" });
  au.setEffectSource(row, "own");
  au.modRemove(row, 0);
  assert.equal(au.modCanAdd(row, "weak"), true);
  au.modAdd(row, "weak"); au.modAdd(row, "weak");
  assert.equal(au.modsView(row).length, 1);
  assert.deepEqual(au.modsView(row)[0], { i: 0, kind: "weak", dmg: "fire", value: 5, except: "" });
});

test("Игрок выбирает: поля вместо JSON, варианты, смена источника", () => {
  const row = step("choose", { to: "self", text: JSON.stringify({ from: "allies" }) });
  au.chooseSet(row, "prompt", "Кого прикрыть?"); au.chooseSet(row, "range", "30"); au.chooseSet(row, "of", "target");
  let v = validateRule(formToRule(formWith(row)));
  assert.ok(v.ok, v.errors.join());
  assert.deepEqual(v.rule.onUse.apply[0].choose, { from: "allies", prompt: "Кого прикрыть?", range: 30, of: "target" });
  au.chooseSet(row, "from", "options");   // у вариантов нет дальности и «от кого»; одна пустая строка варианта
  assert.deepEqual(au.chooseOf(row), { from: "options", prompt: "Кого прикрыть?", options: [{ value: "" }] });
  assert.equal(validateRule(formToRule(formWith(row))).ok, false);   // код пуст
  au.chooseSet(row, "opt.0.value", "fire"); au.chooseSet(row, "opt.0.label", "Огонь");
  au.chooseSet(row, "opt.add"); au.chooseSet(row, "opt.1.value", "cold"); au.chooseSet(row, "opt.1.when", "feat:x, target:trait:undead");
  v = validateRule(formToRule(formWith(row)));
  assert.ok(v.ok, v.errors.join());
  assert.deepEqual(v.rule.onUse.apply[0].choose.options, [{ value: "fire", label: "Огонь" }, { value: "cold", when: ["feat:x", "target:trait:undead"] }]);
  assert.deepEqual(au.chooseView(row).options[1], { i: 1, value: "cold", label: "", when: "feat:x, target:trait:undead" });
  assert.deepEqual(validateRule(formToRule(ruleToForm(v.rule))).rule, v.rule);
  au.chooseSet(row, "opt.0.remove");
  assert.equal(au.chooseView(row).options.length, 1);
  au.chooseSet(row, "from", "enemies");
  assert.deepEqual(au.chooseOf(row), { from: "enemies", prompt: "Кого прикрыть?" });
  const strOpts = step("choose", { to: "self", text: JSON.stringify({ from: "options", options: ["a", { value: "b", label: "B" }] }) });
  assert.deepEqual(au.chooseView(strOpts).options.map((o) => [o.value, o.label]), [["a", ""], ["b", "B"]]);   // строки вариантов — как объекты
});

test("макросы: вид «макрос | встроенный», список обработчиков", () => {
  const m = { uuid: "Macro.abc", phase: "onUse", degree: "", form: "" };
  au.macroSetForm(m, "builtin");
  assert.deepEqual([m.form, m.uuid], ["builtin", ""]);   // начинается с пустого «—»
  m.uuid = "builtin:double-slice";
  assert.deepEqual(validateRule(formToRule({ ...ruleToForm(null), kind: "none", macros: [m] })).rule.macros, [{ phase: "onUse", builtin: "double-slice" }]);
  au.macroSetForm(m, "builtin");   // тот же вид — ничего
  assert.equal(m.uuid, "builtin:double-slice");
  au.macroSetForm(m, "");
  assert.deepEqual([m.form, m.uuid], ["", ""]);
  const opts = au.builtinOptions(["rage", "double-slice", "gear"], (id) => ({ "double-slice": "Двойной взмах", rage: "Ярость" })[id] ?? null);
  assert.deepEqual(opts.map((o) => o[0]).sort(), ["builtin:double-slice", "builtin:gear", "builtin:rage"]);
  assert.equal(opts.find((o) => o[0] === "builtin:gear")[1], "gear");   // подписи нет — id
  assert.equal(opts.find((o) => o[0] === "builtin:rage")[1], "Ярость (rage)");
});

test("условие испытания ch.when: основное, событие, триггер зоны — туда-обратно", () => {
  const ch = { statistic: "will", dc: { value: 20 }, basic: false, rollerRole: "target", when: ["target:trait:undead"], byDegree: { failure: [{ to: "target", condition: { slug: "slowed", value: 1 } }] } };
  const raw = { v: 1, onUse: { targets: "area", zone: { condition: null, effect: null, duration: null, events: null, triggers: [{ on: "turn-end", challenge: ch }] }, challenge: ch, apply: [] }, onEvent: [{ on: "attack-roll", side: "self", apply: [], challenge: ch }] };
  const v = validateRule(raw);
  assert.ok(v.ok, v.errors.join());
  const f = ruleToForm(v.rule);
  assert.deepEqual([f.ch.when, f.ev[0].ch.when, f.zone.trig[0].ch.when], ["target:trait:undead", "target:trait:undead", "target:trait:undead"]);
  f.ev[0].ch.when = "target:trait:fiend, outcome:success";
  assert.deepEqual(validateRule(formToRule(f)).rule.onEvent[0].challenge.when, ["target:trait:fiend", "outcome:success"]);
  assert.deepEqual(validateRule(formToRule(ruleToForm(v.rule))).rule, v.rule);
});

test("replace шага «эффект»: форма <-> правило", () => {
  const v = validateRule(ruleWith([{ to: "target", effect: { uuid: "Compendium.x.Item.e", replace: true } }]));
  assert.ok(v.ok, v.errors.join());
  const f = ruleToForm(v.rule);
  assert.equal(f.apply[0].replace, true);
  assert.deepEqual(validateRule(formToRule(f)).rule, v.rule);
});

test("openWorkshop: голый Item, UUID, {item, mode}; простой объект с system и мусор — null", () => {
  const item = { documentName: "Item", type: "feat" };
  assert.equal(au.openArgs(item).item, item);
  assert.equal(au.openArgs({ item, mode: "automation" }).mode, "automation");
  assert.equal(au.openArgs("Actor.x.Item.y").item, "Actor.x.Item.y");
  assert.deepEqual(au.openArgs(), {});
  assert.equal(au.openArgs({ item: 5 }), null);
  assert.equal(au.openArgs({ item: { system: {} } }), null);
  assert.equal(au.openArgs(42), null);
});

test("degPath от корня P; resetCast гасит переход внутрь и ключи cast.*", () => {
  assert.equal(au.degPath("save"), "f.ch.deg");
  assert.equal(au.degPath("check", "f.cast.1.choices.0.use"), "f.cast.1.choices.0.use.ck.deg");
  const a = { sel: "f.cast.0.use.apply.0", picker: "x", card: "y", stage: 2, into: "f.cast.0.use", open: { cast: true, roll: true } };
  au.resetCast(a);
  assert.deepEqual(a, { sel: null, picker: null, card: null, stage: null, into: null, open: { cast: true, roll: true } });
});

test("ROLL_RE: корень f или шаги активации/варианта; ck.roll и чужие пути не ловит", () => {
  const hit = (p) => au.ROLL_RE.exec(p)?.[1];
  assert.equal(hit("f.roll"), "f");
  assert.equal(hit("f.cast.3.use.roll"), "f.cast.3.use");
  assert.equal(hit("f.cast.3.choices.1.use.roll"), "f.cast.3.choices.1.use");
  for (const p of ["f.ck.roll", "f.cast.0.use.ck.roll", "f.cast.0.roll", "f.ev.0.roll", "roll", "f.cast.0.use.roll.x"]) assert.equal(hit(p), undefined, p);
});

test("zoneNote: зона включена, а цель не «Область» — предупреждение; иначе нет", () => {
  assert.deepEqual(au.zoneNote({ zone: { on: true }, targets: "selected" }, t), { note: "workshop.au.zoneNeedArea" });
  assert.equal(au.zoneNote({ zone: { on: true }, targets: "area" }, t), null);
  assert.equal(au.zoneNote({ zone: { on: false }, targets: "self" }, t), null);
});

test("сводка активации: без своего СЛ — СЛ записи, со своим числом — оно", () => {
  const f = ruleToForm(validateRule({ v: 1, activate: [{ id: "s", label: "S", dc: { level: "high" }, onUse: { targets: "selected", challenge: { statistic: "fortitude", byDegree: {} } } }] }).rule);
  const c = f.cast[0];
  assert.match(au.useSummary(c.use, env, c).roll, /"dc":"workshop\.au\.dcCast\.high"/);   // без слова «СЛ»: его пишет сама сводка
  c.dcType = "value"; c.dc = "18";
  assert.match(au.useSummary(c.use, env, c).roll, /"dc":"18"/);
  c.use.ch.dcText = "31";
  assert.match(au.useSummary(c.use, env, c).roll, /31/);
});

test("сводка активации: цели · бросок · исход, без СЛ правила; хвост «шагов: N» в строке записи", () => {
  const f = ruleToForm(validateRule({ v: 1, activate: [{ id: "s", label: "S", onUse: { targets: "selected", challenge: { statistic: "fortitude", dc: { value: 27 }, byDegree: { failure: [{ to: "target", condition: { slug: "sickened", value: 1 } }] } }, apply: [{ to: "self", condition: { slug: "prone" } }] } }] }).rule);
  const s = au.useSummary(f.cast[0].use, { ...env, dc: 99 });
  assert.match(s.roll, /27/);
  assert.doesNotMatch(s.roll, /99/);
  assert.match(s.outcome, /failure/);
  assert.deepEqual(Object.keys(au.useSummaries(f.cast, env)), ["cast.0"]);
  assert.match(au.castLine(f.cast[0], env).body, /au\.cast\.stepsN\{"n":2\}/);
});
