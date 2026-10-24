import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripHtml, cut } from "../tools/lib.mjs";
import { traceOf, isActive, batchOf, priorityOf, triageItem, makeContext, stepCount } from "../tools/triage.mjs";
import { makeDraft, modelCatalog } from "../tools/drafts.mjs";
import { checkAnswer, processAnswers, roundTrip, retryText, emptyState, mergeAccepted } from "../tools/validate.mjs";
import { pick, rng, poolOf } from "../tools/sample.mjs";
import { chunk, compress } from "../tools/haiku-input.mjs";
import { translateItem, parseDebts } from "../tools/pa-port.mjs";
import { validateRule } from "../scripts/rules.mjs";
import { tally, replaceBlock, withAccepted, withPa } from "../tools/coverage.mjs";
import { buildCatalog } from "../scripts/rules.mjs";
import { normText } from "../tools/extract.mjs";

const labels = JSON.parse(readFileSync(new URL("../rules/labels.json", import.meta.url)));
const refs = { conditions: { frightened: { id: "TBSHQspnbcqxsmjL", name: "Frightened", nameRu: "Испуг" }, prone: { id: "pronepronepronep", name: "Prone", nameRu: null } }, effects: { "Compendium.pf2e.spell-effects.Item.AAA": "E" } };
const ctx = makeContext({ refs, labels, catalogJsons: [{ bySlug: { daze: { v: 1, onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "prone" } }] } } } }] });
const base = { uuid: "Compendium.pf2e.x.Item.1", pack: "x", type: "spell", slug: "s", name: "S", nameRu: null, level: 1, rank: 1, traits: [], category: null, actionType: null, cost: "2", frequency: null, range: null, area: null, defense: null, duration: null, target: null, selfEffect: null, ruleKeys: [], source: null, embedded: null, dupTop: null };
const U = (id) => `@UUID[Compendium.pf2e.conditionitems.Item.${id}]`;

test("след и пачка по механике", () => {
  const save = { ...base, defense: { save: "will", basic: false } };
  assert.deepEqual([traceOf(save, "").S, traceOf(save, "").E], [true, false]);
  assert.equal(batchOf(save, "", traceOf(save, "")), 1);
  const react = { ...base, type: "action", actionType: "reaction" };
  assert.equal(batchOf(react, "", traceOf(react, "")), 4);
  const npc = { ...base, embedded: { actor: "A" } };
  assert.equal(batchOf(npc, "", traceOf(npc, "")), 9);
  assert.equal(batchOf({ ...base, type: "consumable" }, "", {}), 8);
  assert.equal(isActive({ ...base, type: "feat", actionType: "passive", traits: [], frequency: null }, ""), false);
});

test("приоритет: заклинания 0-5, расходники, NPC, кампания", () => {
  assert.equal(priorityOf({ ...base, rank: 5 }), 1);
  assert.equal(priorityOf({ ...base, rank: 6 }), 2);
  assert.equal(priorityOf({ ...base, type: "consumable" }), 1);
  assert.equal(priorityOf({ ...base, embedded: {} }), 3);
  assert.equal(priorityOf({ ...base, type: "campaignFeature" }), 4);
});

test("pf2e-automations — статус pa-port (слой 3), а не слой 1", () => {
  const c2 = makeContext({ refs, labels, automationsRules: [{ uuid: "g", name: "Spark", group: "spell", source: [], isActive: true, baseRules: [], complexRules: [], handlerRules: [] }] });
  const r = triageItem({ ...base, slug: "spark" }, "<p>x @Check[will]</p>", c2);
  assert.deepEqual([r.status, r.layer], ["pa-port", 3]);
});

test("формат черновика: ровно поля контракта", () => {
  const t = { status: "manual", layer: 3, confidence: null, reason: "r", rule: null };
  const d = makeDraft(base, t);
  assert.deepEqual(Object.keys(d), ["uuid", "slug", "type", "name", "nameRu", "layer", "status", "confidence", "reason", "rule"]);
  assert.equal(d.rule, null);
  const rule = validateRule({ v: 1, label: "x", onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "prone" } }] } }).rule;
  assert.equal(makeDraft(base, { ...t, status: "markup-high", confidence: "high", rule }).status, "markup-high");
});

test("эталонные правила промпта валидны и проходят круг форма-правило", () => {
  const md = readFileSync(new URL("../tools/prompts/draft-rule.md", import.meta.url), "utf8");
  const rules = [...md.matchAll(/```json\n(.*)\n```/g)].map((m) => JSON.parse(m[1]));
  assert.ok(rules.length >= 8 && rules.length <= 12);
  const any = new Proxy({}, { get: () => true });
  for (const r of rules) {
    const a = checkAnswer({ uuid: "u", rule: r }, { conditions: any, effects: any });
    assert.equal(a.kind, "accepted", JSON.stringify(a.errors) + JSON.stringify(r).slice(0, 80));
  }
});

test("выборка: детерминирована по сиду, не зависит от порядка входа", () => {
  const list = Array.from({ length: 200 }, (_, i) => ({ uuid: `u${String(i).padStart(3, "0")}` }));
  const a = pick(list, 50, 7), b = pick([...list].reverse(), 50, 7), c = pick(list, 50, 8);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.map((x) => x.uuid), c.map((x) => x.uuid));
  assert.equal(new Set(a.map((x) => x.uuid)).size, 50);
  assert.equal(rng(1)(), rng(1)());
  assert.equal(pick(list.slice(0, 5), 50, 1).length, 5);
});

test("таблица для Haiku: по 40 предметов, @UUID состояния сжат", () => {
  const items = Array.from({ length: 85 }, (_, i) => ({ ...base, uuid: `u${i}`, descEn: `x ${U("TBSHQspnbcqxsmjL")}{Frightened 1}` }));
  const files = chunk("b01", items, { TBSHQspnbcqxsmjL: "frightened" }, 40);
  assert.deepEqual(files.map((f) => f.name), ["b01-01.md", "b01-02.md", "b01-03.md"]);
  assert.match(files[0].text, /@Cond\[frightened\]\{Frightened 1\}/);
  assert.equal(compress("@UUID[Compendium.pf2e.spell-effects.Item.AAA]{E}", {}), "@UUID[Compendium.pf2e.spell-effects.Item.AAA]{E}");
});

test("долги переноса из отчёта и подсчёт покрытия", () => {
  const md = "| Сущность | a | b | Расхождения |\n|---|---|---|---|\n| Вымысел (figment) | a | b | — |\n| Наставление (guidance) | a | b | нет проверки |\n";
  assert.deepEqual(parseDebts(md), [{ entity: "Наставление (guidance)", slug: "guidance", gap: "нет проверки" }]);
  const t = tally([{ key: "k", status: "manual" }, { key: "k", status: "skip" }, { key: "k", status: "pf2e" }]);
  assert.deepEqual([t.k.need, t.k.total], [2, 3]);
});

test("текст без HTML сохраняет @-разметку; сжатие режет воду, но не блоки степеней и @Check", () => {
  assert.equal(stripHtml("<p>Hit @Check[will|dc:20]{Will}&nbsp;now</p><hr><p>B</p>"), "Hit @Check[will|dc:20]{Will} now\n---\nB");
  const t = `${"Flavor sentence one. ".repeat(80)}\nCritical Success unaffected\nFailure frightened 1 @Check[will|dc:20]\nCritical Failure frightened 2`;
  const c = cut(t, 300);
  assert.ok(c.includes("Critical Success unaffected") && c.includes("@Check[will|dc:20]") && c.includes("Critical Failure frightened 2"));
  assert.ok(c.includes("[flavor cut]") && !c.includes("…"));
  const huge = `Failure ${"x ".repeat(2000)}`;   // сама механика не влезла — «…», ответ должен быть unsure
  assert.ok(cut(huge, 300).endsWith("…"));
});

test("слой и статус: pf2e / catalog / skip / markup / manual", () => {
  const eff = "Compendium.pf2e.feat-effects.Item.Z";
  const act = { ...base, type: "action", actionType: "action", cost: "1", selfEffect: eff };
  const h = `${U("TBSHQspnbcqxsmjL")}{Frightened}`;
  assert.equal(triageItem(act, `<p>You gain @UUID[${eff}]{E}</p>`, ctx).status, "pf2e");
  assert.equal(triageItem({ ...base, slug: "daze" }, "<p>x @Check[will]</p>", ctx).status, "catalog");
  assert.equal(triageItem({ ...base, type: "feat", actionType: "passive" }, "<p>x</p>", ctx).status, "skip");
  const dup = triageItem({ ...base, embedded: {}, dupTop: "Compendium.pf2e.x.Item.9" }, "", ctx);
  assert.deepEqual([dup.status, dup.layer], ["skip", null]);
  const sv = { ...base, defense: { save: "will", basic: false } };
  const ok = triageItem(sv, `<p><strong>Failure</strong> The target is ${h} 1.</p>`, ctx);
  assert.equal(ok.status, "markup-high");
  assert.equal(ok.layer, 2);
  // испытание без шагов, но с подсказкой (условное состояние): правило-голова, автоматизацией не считается
  const head = triageItem(sv, `<p><strong>Failure</strong> If it ends its turn adjacent to the source, it is ${h} 1.</p>`, ctx);
  assert.equal(head.status, "markup-head");
  assert.ok(head.rule.onUse.challenge);
  const empty = triageItem(sv, "<p>@Check[will|dc:20] damage</p>", ctx);   // правило без шагов — не вывод, а manual
  assert.equal(empty.status, "manual");
  assert.ok(stepCount(ok.rule) > 0);
  assert.equal(stepCount({ v: 1, onEvent: [{ on: "attack-roll" }] }), 1);   // правило только из onEvent — не пустое
});

test("слой 1 не переоценён: selfEffect с чужой частью и Aura без effects не закрыты системой", () => {
  const eff = "Compendium.pf2e.feat-effects.Item.Z";
  const act = { ...base, type: "action", actionType: "action", cost: "1", selfEffect: eff };
  const part = triageItem(act, `<p>You and an ally gain @UUID[${eff}]{E}.</p>`, ctx);
  assert.notEqual(part.status, "pf2e");
  assert.match(part.reason, /^часть на себя закрыта selfEffect/);
  assert.notEqual(triageItem(act, `<p>You gain @UUID[${eff}]{E} and @UUID[Compendium.pf2e.conditionitems.Item.pronepronepronep]{Prone}.</p>`, ctx).status, "pf2e");
  const aura = { ...base, type: "feat", actionType: "passive", traits: ["aura"], ruleKeys: ["Aura"], auraEffects: false };
  const html = "<p>Creatures in the aura are @UUID[Compendium.pf2e.spell-effects.Item.AAA]{E} for 1 round.</p>";
  assert.notEqual(triageItem(aura, html, ctx).status, "pf2e");
  assert.equal(triageItem({ ...aura, auraEffects: true }, html, ctx).status, "pf2e");
});

test("пассив со спасброском — не пассив; NPC-melee без разметки не требует автоматизации", () => {
  const passive = { ...base, type: "feat", actionType: "passive" };
  assert.equal(isActive(passive, "<p>Hits cause @Check[will|dc:20]</p>"), true);
  assert.equal(isActive(passive, "<p>+2 to saves</p>"), false);
  assert.equal(isActive({ ...passive, embedded: {} }, `<p>${U("TBSHQspnbcqxsmjL")}{Frightened}</p>`), true);
  assert.equal(isActive({ ...base, type: "melee", embedded: {} }, "grab, poison"), false);
});

test("каталог по slug — только для документа того же типа и пака; встроенные NPC по slug не совпадают", () => {
  const items = [{ ...base, uuid: "Compendium.pf2e.spells-srd.Item.D", pack: "spells-srd", slug: "daze", type: "spell" }];
  const c = makeContext({ refs, labels, items, catalogJsons: [{ bySlug: { daze: { v: 1, onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "prone" } }] } } } }] });
  const t = (o) => triageItem({ ...base, slug: "daze", pack: "spells-srd", ...o }, "<p>@Check[will]</p>", c).status;
  assert.equal(t({}), "catalog");
  assert.notEqual(t({ type: "equipment", pack: "equipment-srd" }), "catalog");
  assert.notEqual(t({ embedded: { actor: "A" }, type: "action", actionType: "action" }), "catalog");
});

test("пачка: мгновенный спасбросок по области — пачка 1, с длительностью — зона", () => {
  const sv = { ...base, area: "burst 20ft", defense: { save: "reflex", basic: false } };
  assert.equal(batchOf(sv, "", traceOf(sv, "")), 1);
  const dur = { ...sv, duration: "1 minute" };
  assert.equal(batchOf(dur, "", traceOf(dur, "")), 6);
  const aura = { ...sv, traits: ["aura"] };
  assert.equal(batchOf(aura, "", traceOf(aura, "")), 6);
});

test("дубль NPC с компендием — только при совпадении текста", () => {
  assert.equal(normText("<p>Foo  BAR</p>"), normText("<p>foo bar</p>"));
  assert.notEqual(normText("<p>Spore cloud 10 ft</p>"), normText("<p>Spore cloud 30 ft</p>"));
});

const anyRef = { conditions: new Proxy({}, { get: () => true }), effects: new Proxy({}, { get: () => true }) };
const good = { v: 1, onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "prone" } }] } };

test("validate: ошибка схемы, выдуманные ссылки, лишние поля, пустое правило, чужая статистика, builtin", () => {
  assert.equal(checkAnswer({ uuid: "u", rule: good }, refs).kind, "accepted");
  assert.equal(roundTrip(checkAnswer({ uuid: "u", rule: good }, refs).rule), true);
  assert.equal(checkAnswer({ uuid: "u", rule: { v: 1, onUse: { targets: "everyone" } } }, refs).kind, "error");
  const err = (rule, html = null, r = refs) => checkAnswer({ uuid: "u", rule }, r, html);
  assert.match(err({ v: 1, onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "wobbly" } }] } }).errors[0], /wobbly/);
  assert.match(err({ ...good, foo: 1 }).errors[0], /\.foo/);
  assert.match(err({ v: 1, onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "prone" }, bogus: true }] } }).errors[0], /bogus/);
  assert.match(err({ v: 1, onUse: { targets: "self", apply: [] } }).errors[0], /no steps/);
  const chal = (statistic, dc) => ({ v: 1, onUse: { targets: "selected", challenge: { statistic, dc, basic: false, byDegree: { failure: [{ to: "target", condition: { slug: "prone" } }] } } } });
  assert.equal(err(chal("will", { source: "spell" })).kind, "accepted");
  assert.match(err(chal("perception", { source: "spell" })).errors[0], /fortitude, reflex or will/);
  assert.match(err(chal("will", { against: "nonsense" })).errors[0], /dc\.against/);
  assert.equal(err(chal("will", { against: "class" })).kind, "accepted");
  const chk = (statistic) => ({ v: 1, onUse: { targets: "selected", check: { statistic, vs: { defense: "ac" }, byDegree: { success: [{ to: "target", condition: { slug: "prone" } }] } } } });
  assert.equal(err(chk("athletics")).kind, "accepted");
  assert.match(err(chk("fortitude")).errors[0], /check\.statistic/);
  assert.match(err({ v: 1, macros: [{ phase: "onUse", builtin: "no-such-handler" }] }).errors.join(), /no-such-handler/);
  assert.match(err({ v: 1, onUse: { targets: "area", zone: { condition: { slug: "wobbly" } }, apply: [] } }).errors.join(), /zone condition "wobbly"/);
  const eff = "Compendium.pf2e.spell-effects.Item.AAA", e = { v: 1, onUse: { targets: "self", apply: [{ to: "self", effect: { uuid: eff } }] } };
  assert.equal(err(e, `text @UUID[${eff}]{E}`).kind, "accepted");
  assert.match(err(e, "text without the link").errors[0], /not mentioned/);
});

test("validate: очереди накапливаются, unsure хранит догадку, пропущенные ловятся, дважды невалидное -> Sonnet", () => {
  const items = ["a", "b", "c", "d"].map((uuid) => ({ uuid, status: "manual", rule: null }));
  const state = emptyState();
  const r1 = processAnswers([{ uuid: "a", rule: { v: 1 } }, { uuid: "b", rule: good, note: "ok" }, { uuid: "c", rule: good, unsure: true, note: "?" }, { uuid: "zzz", rule: null }], items, refs, state, { expected: ["a", "b", "c", "d"] });
  assert.deepEqual([r1.accepted.map((x) => x.uuid), r1.errors, r1.sonnet, r1.unknown, r1.missing], [["b"], ["a", "d"], ["c"], ["zzz"], ["d"]]);
  assert.equal(r1.accepted[0].confidence, "model");
  assert.deepEqual(state.sonnet.c.guess, good);
  assert.deepEqual(Object.keys(state.retry).sort(), ["a", "d"]);
  const r2 = processAnswers([{ uuid: "a", rule: { v: 1 } }], items, refs, state);   // второй вызов не теряет прошлую очередь
  assert.deepEqual(Object.keys(state.sonnet).sort(), ["a", "c"]);
  assert.deepEqual(Object.keys(state.retry), ["d"]);
  assert.equal(r2.sonnet[0], "a");
  const r3 = processAnswers([{ uuid: "c", rule: good, unsure: false }], items, refs, state);   // принятое уходит из очереди
  assert.deepEqual([r3.accepted.length, Object.keys(state.sonnet)], [1, ["a"]]);
  const n = processAnswers([{ uuid: "d", rule: null, note: "only damage" }], items, refs, state).accepted[0];
  assert.deepEqual([n.status, n.rule, n.reason], ["skip", null, "model-null: only damage"]);
  assert.match(retryText([{ uuid: "d", errors: ["x"] }], { d: "### 1 d\ntext" }), /### 1 d\ntext\nERRORS:\n {2}\* x/);
  const m = mergeAccepted({ items: [{ uuid: "b" }] }, [{ uuid: "a" }, { uuid: "b", rule: 1 }], { batch: "x", pf2eVersion: "8" });
  assert.deepEqual(m.items.map((d) => d.uuid), ["a", "b"]);
  assert.deepEqual(Object.keys(m.meta), ["batch", "pf2eVersion"]);   // без generatedAt: файл идёт в git
});

test("выборка по источнику: markup / model (с model-null) / pa-port; сид не в черновиках", () => {
  const d = [
    { uuid: "1", status: "markup-high", confidence: "high", rule: {} },
    { uuid: "2", status: "manual", confidence: "model", reason: "model: x", rule: {} },
    { uuid: "3", status: "skip", confidence: null, reason: "model-null: none", rule: null },
    { uuid: "4", status: "pa-port", confidence: "low", rule: {} },
    { uuid: "5", status: "manual", confidence: null, reason: "r", rule: null }
  ];
  assert.deepEqual(poolOf(d, "markup").map((x) => x.uuid), ["1"]);
  assert.deepEqual(poolOf(d, "model").map((x) => x.uuid), ["2", "3"]);
  assert.deepEqual(poolOf(d, "pa-port").map((x) => x.uuid), ["4"]);
  assert.deepEqual(poolOf(d, "all").map((x) => x.uuid), ["1", "2", "3", "4"]);
});

test("хайку-вход: номера кусков стабильны, отвеченное не отправляется повторно", () => {
  const items = Array.from({ length: 85 }, (_, i) => ({ ...base, uuid: `u${String(i).padStart(2, "0")}`, descEn: "x" }));
  const answered = new Set(items.slice(0, 40).map((i) => i.uuid));
  assert.deepEqual(chunk("b01", items, {}, 40, answered).map((f) => f.name), ["b01-02.md", "b01-03.md"]);
  const some = new Set([items[41].uuid]);
  const f2 = chunk("b01", items, {}, 40, some)[1];
  assert.equal(f2.name, "b01-02.md");
  assert.match(f2.text, /39 items/);
});

test("catalog.model: принятые правила моделей -> bySource; null и не model в каталог не идут, в покрытии — model / skip", () => {
  const rule = { v: 1, onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "prone" } }] } };
  const acc = [{ uuid: "U2", rule, confidence: "model" }, { uuid: "U1", rule: null, confidence: null, reason: "model-null: x" }, { uuid: "U4", rule: null, confidence: "needs-primitive", reason: "needs-primitive: push" }, { uuid: "U3", rule, confidence: "high" }];
  const cat = buildCatalog([JSON.parse(modelCatalog(acc))]);
  assert.deepEqual([...cat.bySource.keys()], ["U2"]);
  assert.equal(cat.errors.length, 0);
  const tri = withAccepted([{ uuid: "U1", status: "manual", reason: "x" }, { uuid: "U2", status: "manual" }, { uuid: "U4", status: "manual" }, { uuid: "U3", status: "catalog" }], acc);
  assert.deepEqual(tri.map((t) => t.status), ["skip", "model", "manual", "catalog"]);
  assert.equal(tri[0].reason, "model-null");
});

test("покрытие PA: перенесённое, покрытое и pf2e -> pa; долг и ложное покрытие остаются pa-port", () => {
  const tri = ["a", "b", "c", "d", "e"].map((uuid) => ({ uuid, status: "pa-port" }));
  const pd = [["a", "ported"], ["b", "covered"], ["c", "native"], ["d", "debt"], ["e", "false-coverage"]].map(([uuid, finalStatus]) => ({ uuid, finalStatus }));
  assert.deepEqual(withPa(tri, pd).map((t) => t.status), ["pa", "pa", "pa", "pa-port", "pa-port"]);
});

test("coverage.md: блок сводки заменяется между маркерами и вставляется перед §0 (в блоке есть $ и скобки)", () => {
  const md = "# T\n\nintro\n\n## 0. Методика и оговорки\nbody\n";
  const b1 = "<!-- pipeline:start -->\nA $& $1 [x] \\s\\S\n<!-- pipeline:end -->\n";
  const once = replaceBlock(md, b1);
  assert.match(once, /intro\n\n<!-- pipeline:start -->[\s\S]*<!-- pipeline:end -->\n\n## 0\. Методика/);
  const b2 = b1.replace("A", "B");
  const twice = replaceBlock(once, b2);
  assert.ok(twice.includes("B $& $1 [x]") && !twice.includes("A $&"));
  assert.equal(twice.split("pipeline:start").length, 2);
  assert.equal(replaceBlock(twice, b2), twice);   // идемпотентно
});

test("pa-port: high только если ссылка есть в тексте, триггер подходит типу и в предикате нет сравнений", () => {
  const eff = "Compendium.pf2e.spell-effects.Item.AAA";
  const c = { ...ctx, effects: refs.effects, condSlugs: new Set(Object.keys(refs.conditions)), condIds: { prone: "pronepronepronep" } };
  const g = (extra = {}, pred = ["origin:item:s"]) => ({ rules: [{ type: "base", triggerType: "spell-cast", value: eff, target: "SelfEffect", predicate: pred, ...extra }] });
  const html = `@UUID[${eff}]{E}`;
  const r1 = translateItem(base, html, g(), c);
  assert.equal(r1.confidence, "high");
  assert.equal(r1.rule.onUse.targets, "self");
  assert.match(translateItem(base, "", g({}, ["feat:s"]), c).reason, /effect-not-in-text/);               // ссылки нет в тексте, а PA предмет по slug не называл
  assert.equal(translateItem(base, "", g(), c, { viaSource: true }).confidence, "high");                    // группа названа по uuid этого документа — доказательство
  assert.match(translateItem({ ...base, type: "feat", actionType: "passive" }, html, g(), c).reason, /passive-event-trigger/);   // spell-cast на пассивной черте: правило на использование мёртвое — триггер по событию (0.5g)
  assert.equal(translateItem({ ...base, type: "feat", actionType: "action" }, html, g(), c).confidence, "high");   // на непассивной — годится
  assert.equal(translateItem({ ...base, type: "feat", actionType: "passive" }, html, g({ triggerType: "postInfo" }), c).confidence, "high");   // карточка пассивки = использование (0.5g1, use.mjs useKindOf)
  const hi = translateItem(base, html, g({}, ["origin:item:s", { gte: ["origin:item:level", 7] }]), c);   // сравнение круга — шаг rank (0.5f), не условие
  assert.deepEqual([hi.confidence, hi.rule.onUse.apply[0].rank], ["high", { min: 7 }]);
  assert.deepEqual(translateItem(base, html, g({}, ["origin:item:s", { eq: ["origin:item:level", 7] }]), c).rule.onUse.apply[0].when, [{ eq: ["origin:item:level", 7] }]);   // прочие сравнения — условие шага when (0.5g2)
  assert.match(translateItem(base, html, g({}, ["origin:item:s", { lge: ["self:level", 7] }]), c).reason, /predicate-op:lge/);   // опечатка PA вне круга — по-прежнему долг
  assert.equal(translateItem(base, html, g({}, ["origin:item:s", { or: ["a:b"] }]), c).confidence, "low");   // «a:b» — неизвестный токен
  assert.equal(translateItem({ ...base, embedded: { actor: "A" } }, html, g(), c, { slugOnly: true }).slugOnly, true);   // NPC только по slug: пометка для каталога (bySlug без bySource), на уверенность не влияет
  assert.equal(translateItem({ ...base, type: "action", actionType: "reaction" }, html, g({ triggerType: "postInfo" }, ["feat:s"]), c).confidence, "low");   // реакция «на себя» без привязки PA к предмету — ошибка вероятна
  assert.equal(translateItem({ ...base, type: "action", actionType: "reaction" }, html, g({ triggerType: "postInfo" }), c, { viaSource: true }).confidence, "low");   // и по source — тоже: «Self» у реакции проверяется вручную (Clue In, Bristle)
  const sv = { ...base, defense: { save: "will", basic: false } };
  const g2 = { rules: [{ type: "base", triggerType: "saving-throw", value: "prone", target: "SelfAddCondition", predicate: [{ or: ["outcome:failure", "outcome:criticalFailure"] }, "origin:item:s"] }] };
  const r2 = translateItem(sv, "<p>@UUID[Compendium.pf2e.conditionitems.Item.pronepronepronep]{Prone}</p>", g2, c);
  assert.deepEqual(Object.keys(r2.rule.onUse.challenge.byDegree).sort(), ["criticalFailure", "failure"]);
  assert.equal(translateItem(base, "", { rules: [{ type: "handler", triggerType: "damage-roll", value: "h", target: "none" }] }, c).reason, "handler:h");
  assert.equal(translateItem(base, "", { rules: [{ type: "base", triggerType: "use", value: "Compendium.pf2e-automations.effects.Item.X", target: "SelfEffect" }] }, c).reason, "pa-own-effect");
  assert.equal(translateItem(base, "", { rules: [{ type: "complex", triggerType: "saving-throw", target: "ImmunitySelfEffect", values: [{ immunities: ["x"] }], predicate: ["outcome:success"] }] }, c).reason, "immunity-after-save");
});

test("validate: правило из одних заметок ведущему -> notes-only (не skip); с иммунитетом или состоянием — правило", () => {
  const note = { to: "target", note: "Оттолкните цель на 10 футов" };
  const ch = (extra = {}) => ({ v: 1, onUse: { targets: "selected", challenge: { statistic: "will", dc: { source: "spell" }, basic: false, byDegree: { failure: [note] }, ...extra }, apply: [] } });
  assert.equal(checkAnswer({ uuid: "u", rule: ch() }, refs).kind, "notes-only");
  assert.equal(checkAnswer({ uuid: "u", rule: ch({ immunity: { slug: "s", duration: { value: 1, unit: "minutes" } } }) }, refs).kind, "accepted");
  const mixed = ch(); mixed.onUse.challenge.byDegree.criticalFailure = [{ to: "target", condition: { slug: "prone" } }];
  assert.equal(checkAnswer({ uuid: "u", rule: mixed }, refs).kind, "accepted");
});
