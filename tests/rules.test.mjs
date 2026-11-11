import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateRule, slugOf, sourceOf, deriveFromMarkup, initCatalog, resolveRule, onAttackedIndex, parseCheck } from "../scripts/rules.mjs";

const path = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const rd = (p) => JSON.parse(readFileSync(path(p), "utf8"));
const catalog = rd("rules/catalog.json");
const labels = rd("rules/labels.json");

const COND = { TBSH: "frightened", AdPV: "fascinated", fesd: "sickened", cond: "concealed" };
const condSlug = (uuid) => (uuid.includes("conditionitems") ? COND[uuid.split(".").pop().slice(0, 4)] ?? null : null);
const U = (c) => `@UUID[Compendium.pf2e.conditionitems.Item.${c}]`;
const EFF = "Compendium.pf2e.equipment-effects.Item.eff00000000000x";

/* ---------- validateRule ---------- */

test("каталог проходит validateRule", () => {
  for (const cat of [catalog])
    for (const f of ["bySource", "bySlug"])
      for (const [k, r] of Object.entries(cat[f])) {
        const v = validateRule(r);
        assert.ok(v.ok, `${f}.${k}: ${v.errors}`);
      }
});

test("validateRule: дефолты нормализации", () => {
  const { rule } = validateRule(catalog.bySlug["frightful-presence"]);
  assert.equal(rule.yield, true);
  assert.equal(rule.onTurn, null);
  assert.deepEqual(rule.macros, []);
  assert.equal(rule.onUse.challenge.byDegree.failure[0].condition.policy, "max");
  const r2 = validateRule({ v: 1, onUse: { targets: "self", apply: [{ effect: { uuid: "X" } }] } }).rule;
  assert.equal(r2.onUse.apply[0].to, "self");
  const r3 = validateRule({ v: 1, onUse: { targets: "selected", challenge: { statistic: "will", dc: { value: 15 }, byDegree: { failure: [{ note: "x" }] } } } }).rule;
  assert.equal(r3.onUse.challenge.byDegree.failure[0].to, "target");
  assert.equal(validateRule(catalog.bySlug["nimble-dodge"]).rule.onAttacked.notify.length, 2);
});

test("validateRule: ошибки", () => {
  const bad = (raw, key) => {
    const v = validateRule(raw);
    assert.equal(v.ok, false, JSON.stringify(raw));
    assert.equal(v.rule, null);
    assert.ok(v.errors.some((e) => e.key === key), `${key}: ${v.errors.join("; ")}`);
  };
  bad(null, "rule.obj");
  bad({ onUse: { targets: "self", apply: [{ note: "x" }] } }, "rule.version");
  bad({ v: 1 }, "rule.empty");
  bad({ v: 1, onTurn: {} }, "rule.onTurn");
  bad({ v: 1, onUse: { targets: "self", apply: [{ note: "x" }] }, onAttacked: { trigger: "attack-on-self", bonus: { stat: "ac", type: "circumstance", value: 2 } } }, "rule.both");
  bad({ v: 1, onUse: { targets: "selected", zone: { condition: { slug: "x" } } } }, "zone.onlyArea");
  bad({ v: 1, onUse: { targets: "area", zone: { condition: { slug: "x" }, events: { a: 1 } } } }, "zone.events");
  bad({ v: 1, onUse: { targets: "area", zone: {} } }, "zone.empty");
  bad({ v: 1, onUse: { targets: "self", apply: [{ condition: { slug: "a" }, effect: { uuid: "b" } }] } }, "apply.kind");
  bad({ v: 1, onUse: { targets: "self", apply: [{ condition: { slug: "a", policy: "min" } }] } }, "cond.policy");
  bad({ v: 1, onUse: { targets: "selected", challenge: { statistic: "will", dc: { value: 1, expr: "x" }, byDegree: {} } } }, "dc.many");
  bad({ v: 1, onUse: { targets: "selected", challenge: { statistic: "will", dc: { value: 1 }, byDegree: { great: [] } } } }, "degrees.unknown");
  bad({ v: 1, onUse: { targets: "bogus" } }, "use.targets");
  bad({ v: 1, macros: [{ uuid: "Macro.a", phase: "onUse", degree: "success" }] }, "macro.degreeOnly");
  bad({ v: 1, macros: [{ uuid: "Macro.a", phase: "later" }] }, "macro.phase");
  bad({ v: 1, onAttacked: { trigger: "x", bonus: { stat: "ac", type: "circumstance", value: 2 } } }, "react.trigger");
});

test("validateRule: макросы (пример §1.6.5)", () => {
  const v = validateRule({
    v: 1, onUse: { targets: "area", challenge: { statistic: "reflex", dc: { source: "spell" }, basic: true, byDegree: {} } },
    macros: [{ uuid: "Macro.AbCdEf1234567890", phase: "afterChallenge" }, { uuid: "Macro.Zy", phase: "onDegree", degree: "criticalFailure" }]
  });
  assert.ok(v.ok, v.errors);
  assert.equal(v.rule.macros[1].degree, "criticalFailure");
});

/* ---------- slugOf / sourceOf ---------- */

test("slugOf: каскад", () => {
  assert.equal(slugOf({ slug: "a" }, { slug: "b" }), "a");
  assert.equal(slugOf({}, { slug: "b" }), "b");
  assert.equal(slugOf({ rollOptions: ["x", "origin:item:slug:smoke-ball-lesser"] }, { slug: null }), "smoke-ball-lesser");
  assert.equal(slugOf({}, { flags: { babele: { originalName: "Nimble Dodge" } } }), "nimble-dodge");
  assert.equal(slugOf({}, null), null);
  // переведённый предмет без system.slug: rollOption кириллический, берём babele.originalName; одинокий не-ASCII slug игнорируем
  assert.equal(slugOf({ rollOptions: ["origin:item:slug:бросок-щита"] }, { slug: null, flags: { babele: { originalName: "Raise a Shield" } } }), "raise-a-shield");
  assert.equal(slugOf({ rollOptions: ["origin:item:slug:бросок-щита"] }, { slug: null }), null);
  assert.equal(slugOf({ rollOptions: ["origin:item:slug:raise-a-shield"] }, { slug: null }), "raise-a-shield");
});

test("sourceOf: каскад", () => {
  assert.equal(sourceOf({ sourceId: "C.o" }, { _stats: { compendiumSource: "C.s" }, flags: { core: { sourceId: "C.f" } } }), "C.s");
  assert.equal(sourceOf({ sourceId: "C.o" }, { _stats: {}, flags: { core: { sourceId: "C.f" } } }), "C.f");
  assert.equal(sourceOf({ sourceId: "C.o" }, { _stats: {}, flags: {} }), "C.o");   // расходник уже удалён
  assert.equal(sourceOf({}, null), null);
});

/* ---------- parseCheck ---------- */

test("parseCheck", () => {
  const c = parseCheck("reflex,will|dc:20|basic|traits:fire,mental");
  assert.equal(c.type, "reflex,will");
  assert.equal(c.params.dc, "20");
  assert.ok(c.flags.has("basic"));
  assert.equal(parseCheck("type:will|dc:5").type, "will");
});

/* ---------- deriveFromMarkup ---------- */

const mkItem = (type, html, sys = {}) => ({ type, name: "T", system: { description: { value: html }, ...sys } });

test("derive: блоки степеней RU, @Check, значение в подписи (Напугано 2)", () => {
  const html = `<p>Существо входит в ауру: @Check[will|dc:18]{Воли}.</p><hr>
<p><strong>Критический успех:</strong> Существо невредимо.</p>
<p><strong>Успех:</strong> Существо становится ${U("TBSHQspnbcqxsmjL")}{Напугано 1}.</p>
<p><strong>Провал:</strong> Существо ${U("TBSHQspnbcqxsmjL")}{Напугано 2} и ${U("AdPVz7rbaVSRxHFg")}{Заворожено} пугалом.</p>
<p><strong>Критический провал:</strong> Как провал, но ${U("TBSHQspnbcqxsmjL")}{Напугано 3}.</p>`;
  const d = deriveFromMarkup(mkItem("action", html), labels, condSlug);
  assert.equal(d.confidence, "high");
  const ch = d.rule.onUse.challenge;
  assert.equal(ch.statistic, "will");
  assert.deepEqual(ch.dc, { value: 18 });
  assert.equal(d.rule.onUse.targets, "selected");
  assert.deepEqual(ch.byDegree.success, [{ to: "target", condition: { slug: "frightened", value: 1, policy: "max" } }]);
  assert.deepEqual(ch.byDegree.failure.map((a) => [a.condition.slug, a.condition.value]), [["frightened", 2], ["fascinated", undefined]]);
  assert.equal(ch.byDegree.criticalFailure[0].condition.value, 3);
  assert.equal(ch.byDegree.criticalSuccess, undefined);
});

test("derive: <b>Метка:</b> + <br>, число после ссылки, defense.save -> dc spell", () => {
  const html = `Цель проходит испытание Воли.<br>
<b>Критический успех:</b> цель избегает эффекта.<br>
<b>Провал:</b> цель получает ${U("fesd1n5eVhpCSS18")}{тошноту} 1 на 1 раунд. Дальше.<br>
<b>Критический провал:</b> аналогичен провалу, но тошноту 2.
<hr><b>Повышенное (+1):</b> урон растёт.`;
  const d = deriveFromMarkup(mkItem("spell", html, { defense: { save: { statistic: "will", basic: false } } }), labels, condSlug);
  assert.equal(d.confidence, "high");
  assert.deepEqual(d.rule.onUse.challenge.dc, { source: "spell" });
  assert.deepEqual(Object.keys(d.rule.onUse.challenge.byDegree), ["failure", "criticalFailure"]);   // «тошноту 2» простым текстом
  assert.equal(d.rule.onUse.challenge.byDegree.failure[0].condition.value, 1);
});

test("derive: английские метки, basic, traits, inflicts-подсказка, expr", () => {
  const html = `<p>@Check[reflex|dc:resolve(@actor.level)|basic|traits:fire|options:inflicts:frightened,area-effect]</p><p><strong>Failure</strong> You are ${U("TBSHQspnbcqxsmjL")}{Frightened 2}.</p>`;
  const d = deriveFromMarkup(mkItem("action", html), labels, condSlug);
  const ch = d.rule.onUse.challenge;
  assert.equal(ch.basic, true);
  assert.deepEqual(ch.dc, { expr: "resolve(@actor.level)" });
  assert.deepEqual(ch.traits, ["fire"]);
  assert.deepEqual(ch.options, ["inflicts:frightened", "area-effect"]);
  assert.deepEqual(d.hints.inflicts, ["frightened"]);
  assert.equal(ch.byDegree.failure[0].condition.value, 2);
});

test("derive: область + defense.save -> targets area", () => {
  const d = deriveFromMarkup(mkItem("spell", "<p>@Template[cone|distance:30] жар</p>", { area: { type: "cone", value: 30 }, defense: { save: { statistic: "reflex", basic: true } } }), labels, condSlug);
  assert.equal(d.rule.onUse.targets, "area");
  assert.equal(d.rule.onUse.challenge.basic, true);
});

test("derive: consumable с эффектом = self, high", () => {
  const d = deriveFromMarkup(mkItem("consumable", `<p>Вы пьёте.</p><p>@UUID[${EFF}]</p>`), labels, condSlug);
  assert.equal(d.confidence, "high");
  assert.deepEqual(d.rule.onUse.apply, [{ to: "self", effect: { uuid: EFF } }]);
  assert.equal(d.rule.onUse.targets, "self");
});

test("derive: action с эффектом без selfEffect = low; с selfEffect = null", () => {
  const html = `<p>Эффект: @UUID[${EFF}]</p>`;
  const d = deriveFromMarkup(mkItem("action", html), labels, condSlug);
  assert.equal(d.confidence, "low");
  assert.equal(d.rule.onUse.apply[0].to, "self");
  assert.equal(deriveFromMarkup(mkItem("feat", html, { selfEffect: { uuid: EFF } }), labels, condSlug), null);
});

test("derive: заклинание с целью и эффектом = на цель, high", () => {
  const d = deriveFromMarkup(mkItem("spell", `<p>@UUID[${EFF}]</p>`, { target: { value: "1 существо" } }), labels, condSlug);
  assert.equal(d.confidence, "high");
  assert.deepEqual(d.rule.onUse.apply, [{ to: "target", effect: { uuid: EFF } }]);
  assert.equal(d.rule.onUse.targets, "selected");
  assert.equal(deriveFromMarkup(mkItem("spell", `<p>@UUID[${EFF}]</p>`), labels, condSlug), null);   // цели нет — не угадываем
});

test("derive: @Template + состояние вне блоков = кандидат в зону, low", () => {
  const d = deriveFromMarkup(mkItem("consumable", `<p>Дым @Template[burst|distance:10] даёт ${U("cond1xxxxxxxxxxx")}{скрытость}.</p>`), labels, condSlug);
  assert.equal(d.confidence, "low");
  assert.deepEqual(d.rule.onUse.zone, { condition: { slug: "concealed" }, effect: null, duration: null, events: null });
  assert.equal(d.rule.onUse.targets, "area");
});

test("derive: нет признаков -> null; не-спасбросок @Check не даёт испытания", () => {
  assert.equal(deriveFromMarkup(mkItem("feat", "<p>Просто текст.</p>"), labels, condSlug), null);
  assert.equal(deriveFromMarkup(mkItem("feat", "<p>@Check[medicine]{Медицины}</p>"), labels, condSlug), null);
  assert.equal(deriveFromMarkup({ type: "feat", system: {} }, labels, condSlug), null);
});

/* ---------- resolveRule: порядок §1.2 ---------- */

test("resolveRule: флаг > каталог bySource > bySlug > разметка; onAttackedIndex", () => {
  initCatalog([catalog], labels);
  globalThis.game = { pf2e: { ConditionManager: { conditions: new Map([["Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL", { slug: "frightened" }]]) } } };
  try {
    const R = (item, origin) => resolveRule({ origin, item });
    const bySrc = R({ type: "spell", slug: "zzz", _stats: { compendiumSource: "Compendium.pf2e.spells-srd.Item.y6rAdMK6EFlV6U0t" }, system: {} });
    assert.equal(bySrc.source, "catalog");
    assert.equal(bySrc.rule.label, "Огненное дыхание");
    const bySlug = R({ type: "consumable", slug: "smoke-ball-lesser", _stats: {}, system: {} });
    assert.equal(bySlug.rule.onUse.zone.condition.slug, "concealed");
    // расходник удалён: slug из rollOptions
    assert.equal(R(null, { rollOptions: ["origin:item:slug:smoke-ball-greater"] }).slug, "smoke-ball-greater");
    const flagRule = { v: 1, onUse: { targets: "self", apply: [{ note: "флаг" }] } };
    assert.equal(R({ type: "consumable", slug: "smoke-ball-lesser", flags: { "pf2e-automato": { rule: flagRule } }, system: {} }).source, "flag");
    const markup = R({ type: "consumable", slug: "unknown", _stats: {}, system: { description: { value: `<p>@UUID[${EFF}]</p>` } } });
    assert.equal(markup.source, "markup");
    assert.equal(markup.confidence, "low");   // живой вывод с шагами сам не исполняется: проверенное — из каталога
    assert.equal(R({ type: "consumable", slug: "unknown", system: {} }), null);
    assert.equal(onAttackedIndex().get("nimble-dodge").onAttacked.bonus.value, 2);
    assert.equal(onAttackedIndex().has("breathe-fire"), false);
  } finally { delete globalThis.game; }
});

test("resolveRule(документ эффекта): геттер pf2e origin (актёр) не считается origin карточки", () => {
  // у EffectPF2e .origin — актёр-автор: rollOptions у него объект (раньше — TypeError в slugOf)
  const effect = { name: "Эффект без slug", type: "effect", system: { slug: null }, _stats: {}, origin: { rollOptions: {}, sourceId: "Compendium.x.y.Item.z" } };
  assert.doesNotThrow(() => resolveRule(effect));
});
