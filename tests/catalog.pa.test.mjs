// rules/catalog.pa.json: шипуемый перенос pf2e-automations (tools/pa-port.mjs, buildPaCatalog).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

globalThis.game = { user: { isActiveGM: true }, settings: { get: () => "auto" }, i18n: { localize: (k) => k, format: (k) => k }, pf2e: { ConditionManager: { conditions: new Map() } } };
globalThis.ui = { notifications: { warn() {} } };

const { buildCatalog } = await import("../scripts/rules.mjs");
const { buildPaCatalog } = await import("../tools/pa-port.mjs");
const { roundTrip } = await import("../tools/validate.mjs");

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));
const pa = read("../rules/catalog.pa.json"), builtin = read("../rules/catalog.json"), campaign = read("../rules/catalog.campaign.json");

test("catalog.pa: собирается без ошибок, каждое правило проходит round-trip", () => {
  const c = buildCatalog([pa]);
  assert.deepEqual(c.errors, []);
  assert.ok(c.bySource.size > 100);
  for (const r of [...c.bySource.values(), ...c.bySlug.values()]) assert.ok(roundTrip(r));
});

test("catalog.pa: ручные каталоги побеждают при склейке (порядок как в loadCatalog)", () => {
  const c = buildCatalog([pa, builtin, campaign]);
  for (const m of [builtin, campaign]) {
    for (const f of ["bySource", "bySlug"]) for (const [k, raw] of Object.entries(m[f] ?? {})) assert.deepEqual(c[f].get(k), buildCatalog([{ [f]: { [k]: raw } }])[f].get(k), `${f}.${k}`);
  }
});

test("catalog.pa: ни один ключ не пересекается с ручными (источник и slug)", () => {
  for (const f of ["bySource", "bySlug"]) for (const m of [builtin, campaign]) for (const k of Object.keys(m[f] ?? {})) assert.ok(!(k in pa[f]), `${f}.${k}`);
});

test("buildPaCatalog: slug только если однозначен, конфликт источника и ручной каталог", () => {
  const rule = (n, v = 1) => ({ v: 1, label: n, onUse: { targets: "self", excludeSelf: null, zone: null, challenge: null, apply: [{ to: "self", condition: { slug: "frightened", value: v, policy: "max" } }] } });
  const P = "Compendium.pf2e.spells-srd.Item.";
  const d = (id, slug, rule_, confidence = "high") => ({ uuid: P + id, slug, confidence, rule: rule_ });
  const items = [{ uuid: P + "a", slug: "one" }, { uuid: P + "b", slug: "dup" }, { uuid: P + "c", slug: "dup" }, { uuid: P + "m", slug: "man" },
    { uuid: "Compendium.x.Actor.1.Item.n1", slug: "npc", embedded: true, source: P + "s" }, { uuid: "Compendium.x.Actor.2.Item.n2", slug: "npc2", embedded: true, source: P + "s" }];
  const r = buildPaCatalog([d("a", "one", rule("A")), d("b", "dup", rule("B")), d("c", "dup", rule("C", 2), "low"), d("m", "man", rule("M")),
    { ...d("n1", "npc", rule("N1")), uuid: items[4].uuid }, { ...d("n2", "npc2", rule("N2", 2)), uuid: items[5].uuid }], [d("c", "dup", rule("C", 2))], items, [{ bySlug: { man: {} } }]);
  assert.deepEqual(Object.keys(r.cat.bySlug), ["one"]);                               // dup: разные правила (имя не в счёт), man — у ручных
  assert.deepEqual(Object.keys(r.cat.bySource).sort(), [P + "a", P + "b", P + "c"]);   // c принят вручную; npc-копии с разными правилами отброшены
  assert.deepEqual(r.skipped, { "manual-wins": 1, "source-conflict": 2 });
});

const { translateItem } = await import("../tools/pa-port.mjs");
const EFF = "Compendium.pf2e.equipment-effects.Item.AAAAAAAAAAAAAAAA", CID = "cond0000000000id";
const ctx = { effects: { [EFF]: "Effect: X" }, condSlugs: new Set(["quickened"]), condIds: { quickened: CID }, grants: {}, labels: {}, condSlugByUuid: () => null, condNames: [] };
const L = `@UUID[${EFF}]`;
const grp = (target) => ({ rules: [{ triggerType: "use", target, value: EFF, predicate: [] }] });
const cons = (extra = {}) => ({ type: "consumable", slug: "x", name: "X", traits: [], ...extra });

test("translateItem: спасбросок в тексте при правиле «на себя» -> low (регресс: литерал backspace вместо граница слова)", () => {
  const r = translateItem(cons(), `<p>${L} @Check[fortitude|dc:20]</p>`, grp("SelfEffect"), ctx);
  assert.equal(r.confidence, "low"); assert.match(r.reason, /text-has-save-or-area/);
  assert.equal(translateItem(cons(), `<p>${L}</p>`, grp("SelfEffect"), ctx).confidence, "high");
});

test("translateItem: to:target у расходника без target -> low; с target остаётся high", () => {
  assert.match(translateItem(cons(), `<p>${L}</p>`, grp("TargetEffect"), ctx).reason, /to-target-no-item-target/);
  assert.equal(translateItem(cons({ target: "1 creature" }), `<p>${L}</p>`, grp("TargetEffect"), ctx).confidence, "high");
});

test("translateItem: «you gain the @UUID[состояние]» без него в правиле и GrantItem -> low", () => {
  const html = `<p>${L} you gain the @UUID[Compendium.pf2e.conditionitems.Item.${CID}]{Quickened} condition</p><p>bonus against @UUID[Compendium.pf2e.conditionitems.Item.${CID}]{Quickened}</p>`;
  assert.match(translateItem(cons(), html, grp("SelfEffect"), ctx).reason, /text-condition-missing:quickened/);
  assert.equal(translateItem(cons(), html, grp("SelfEffect"), { ...ctx, grants: { [EFF]: [CID] } }).confidence, "high");
  assert.equal(translateItem(cons(), `<p>${L}</p>` + html.split("</p>")[1], grp("SelfEffect"), ctx).confidence, "high");   // «бонус против» — не триггер
});

test("buildPaCatalog: PA bySource против ручного bySlug того же предмета; rule:null в accepted исключает", () => {
  const P = "Compendium.pf2e.spells-srd.Item.";
  const rule = { v: 1, label: "A", onUse: { targets: "self", excludeSelf: null, zone: null, challenge: null, apply: [{ to: "self", condition: { slug: "frightened", value: 1, policy: "max" } }] } };
  const dr = (id, slug) => ({ uuid: P + id, slug, confidence: "high", rule });
  const items = [{ uuid: P + "a", slug: "man" }, { uuid: P + "b", slug: "free" }, { uuid: P + "c", slug: "ex" }];
  const r = buildPaCatalog([dr("a", "man"), dr("b", "free"), dr("c", "ex")], [{ uuid: P + "c", rule: null }], items, [{ bySlug: { man: {} } }]);
  assert.deepEqual(Object.keys(r.cat.bySource), [P + "b"]);
  assert.deepEqual(r.skipped, { "manual-wins": 1, "excluded-manually": 1 });
});

const { falseCoverage, subpackOf, statusOf, targetKind } = await import("../tools/pa-port.mjs");
const EFF2 = "Compendium.pf2e.spell-effects.Item.BBBBBBBBBBBBBBBB", MISS = "Compendium.pf2e.spell-effects.Item.MMMMMMMMMMMMMMMM";
const ctx2 = { ...ctx, effects: { [EFF]: "Effect: X", [EFF2]: "Spell Effect: Y" } };
const sp = (extra = {}) => ({ type: "spell", slug: "x", name: "X", traits: [], range: "30 feet", ...extra });
const gr = (pred, extra = {}) => ({ rules: [{ type: "base", triggerType: "spell-cast", target: "SelfEffect", value: EFF, predicate: pred, ...extra }] });

test("translateItem: чужое feat:/spell: понижает, своё безвредно, условие и его отрицание с одним результатом безвредны", () => {
  assert.match(translateItem(sp(), L, gr(["item:slug:x", "feat:other"]), ctx2).reason, /predicate:feat:other/);
  assert.match(translateItem(sp(), L, gr(["item:slug:x", "spell:other"]), ctx2).reason, /predicate:spell:other/);
  assert.equal(translateItem(sp(), L, gr(["item:slug:x", "feat:x"]), ctx2).confidence, "high");
  const a = gr(["item:slug:x", { not: "feat:other" }]).rules[0], b = gr(["item:slug:x", "feat:other"]).rules[0];
  assert.equal(translateItem(sp(), L, { rules: [a, b] }, ctx2).confidence, "high");                                  // Taunt: фит меняет лишь дальность
  assert.match(translateItem(sp(), L, { rules: [a, { ...b, value: EFF2 }] }, ctx2).reason, /predicate:feat:other/);   // результаты разные — условие значимо
});

test("translateItem: триггер use/spell-cast годится непассивному действию, пассивному — нет", () => {
  const act = (actionType) => ({ type: "action", slug: "x", name: "X", traits: [], actionType });
  assert.equal(translateItem(act("action"), L, gr(["item:slug:x"]), ctx2).confidence, "high");
  assert.equal(translateItem(act("action"), L, gr(["item:slug:x"], { triggerType: "use" }), ctx2).confidence, "high");
  assert.match(translateItem(act("passive"), L, gr(["item:slug:x"]), ctx2).reason, /trigger-type:spell-cast\/action/);
  assert.match(translateItem(act("passive"), L, gr(["item:slug:x"], { triggerType: "use" }), ctx2).reason, /trigger-type:use\/action/);
});

test("translateItem: длительность без value — из самого эффекта, настоящие кубы остаются долгом", () => {
  const cx = (duration, extra = {}) => ({ rules: [{ type: "complex", triggerType: "use", target: "SelfEffect", predicate: [], values: [{ ...extra, duration }] }] });
  const r = translateItem(cons(), L, cx({ unit: "minutes" }, { effects: [EFF] }), ctx2);
  assert.equal(r.confidence, "high"); assert.deepEqual(r.rule.onUse.apply, [{ to: "self", effect: { uuid: EFF } }]);
  const c = translateItem(cons(), L, cx({ unit: "minutes" }, { conditions: ["quickened"] }), ctx2);
  assert.equal(c.rule.onUse.apply[0].duration, undefined);
  assert.equal(translateItem(cons(), L, cx({ value: "1d4", unit: "rounds", expiry: "turn-end" }, { effects: [EFF] }), ctx2).reason, "dice-duration");
  assert.equal(translateItem(cons(), L, cx({ value: 2, unit: "rounds" }, { conditions: ["quickened"] }), ctx2).rule.onUse.apply[0].duration.value, 2);
});

test("translateItem: пропавший id эффекта заменяется единственной ссылкой на эффект в тексте", () => {
  const g = (value = MISS) => gr(["item:slug:x"], { value });
  const r = translateItem(sp(), `<p>@UUID[${EFF2}]{Y}</p>`, g(), ctx2);
  assert.deepEqual(r.rule.onUse.apply.map((a) => a.effect.uuid), [EFF2]);
  assert.equal(r.confidence, "high");
  assert.equal(translateItem(sp(), `<p>@UUID[${EFF2}] @UUID[${EFF}]</p>`, g(), ctx2).reason, "effect-missing");   // две ссылки — неясно, какая
  assert.equal(translateItem(sp(), "<p>нет ссылок</p>", g(), ctx2).reason, "effect-missing");
  const two = { rules: [{ ...g().rules[0] }, { ...g().rules[0], value: EFF2, predicate: ["item:slug:x", "a b"] }] };
  assert.equal(translateItem(sp(), `<p>@UUID[${EFF2}]</p>`, two, ctx2).reason, "effect-missing");   // ссылка уже занята другим шагом
});

test("translateItem: предмет переименован — по source берём все правила при согласованных slug, у расходников выбираем тир", () => {
  const rule = (slug, value) => ({ type: "base", triggerType: "spell-cast", target: "SelfEffect", value, predicate: [`item:slug:${slug}`] });
  const sameOld = { rules: [rule("old", EFF), rule("old", EFF2)] };
  assert.equal(translateItem(sp(), L, sameOld, ctx2).reason, "slug-mismatch");                          // найден лишь по slug
  assert.equal(translateItem(sp(), L, sameOld, ctx2, { viaSource: true }).rule.onUse.apply.length, 2);
  assert.equal(translateItem(sp(), L, { rules: [rule("old", EFF), rule("older", EFF2)] }, ctx2, { viaSource: true }).reason, "slug-mismatch");   // slug-токены не согласованы
  const tiers = { rules: [rule("old-lesser", EFF), rule("old-greater", EFF2)].map((r) => ({ ...r, triggerType: "use", predicate: [r.predicate[0].replace("item:slug", "consumable")] })) };
  const t = translateItem(cons({ slug: "new-greater" }), `@UUID[${EFF2}]`, tiers, ctx2, { viaSource: true });
  assert.deepEqual(t.rule.onUse.apply.map((a) => a.effect.uuid), [EFF2]);
  assert.equal(translateItem(cons({ slug: "new-major" }), L, tiers, ctx2, { viaSource: true }).reason, "slug-mismatch");   // такого тира нет
});

test("translateItem: SelfOrTarget — цель или дальность предмета, иначе на себя; расходник «наносится на существо» — на цель", () => {
  const g = (type = "use") => ({ rules: [{ type: "base", triggerType: type, target: "SelfOrTargetEffect", value: EFF, predicate: [] }] });
  const t = translateItem(sp({ range: "touch", target: "1 creature" }), L, g("spell-cast"), ctx2);
  assert.deepEqual([t.confidence, t.rule.onUse.targets, t.rule.onUse.apply[0].to], ["high", "selected", "target"]);
  const s = translateItem(sp({ range: null, target: null }), L, g("spell-cast"), ctx2);
  assert.deepEqual([s.confidence, s.rule.onUse.targets, s.rule.onUse.apply[0].to], ["high", "self", "self"]);
  assert.equal(translateItem(sp({ range: null, target: "you" }), L, g("spell-cast"), ctx2).rule.onUse.targets, "self");
  const oil = translateItem(cons(), `<p>Applied to a non-incorporeal undead, the oil grants a bonus. ${L}</p>`, g(), ctx2);
  assert.deepEqual([oil.confidence, oil.rule.onUse.targets, oil.rule.onUse.apply[0].to], ["high", "selected", "target"]);   // без «to-target-no-item-target»
  assert.equal(translateItem(cons(), `<p>The oil has no effect when applied to another creature's weapon. ${L}</p>`, g(), ctx2).rule.onUse.targets, "self");
  assert.equal(translateItem(cons(), `<p>You drink it. ${L}</p>`, g(), ctx2).rule.onUse.targets, "self");
  assert.equal(targetKind(cons(), "<p>salve can be applied to the skin of a creature</p>"), "text");
  assert.equal(targetKind(cons({ range: "touch" }), ""), "data");
});

test("translateItem: pf2e делает сам — собственный selfEffect документа и обработчик Hunt Prey у действия с selfEffect", () => {
  const g = gr(["item:slug:x"]);
  assert.equal(translateItem(sp({ selfEffect: EFF }), L, g, ctx2).native, true);
  assert.equal(translateItem(sp({ selfEffect: EFF2 }), L, g, ctx2).native, undefined);
  assert.equal(translateItem(sp({ embedded: { actor: "A" } }), L, g, { ...ctx2, selfEffect: () => EFF }).native, undefined);   // у копии NPC selfEffect источника не в счёт
  assert.equal(translateItem(sp({ selfEffect: EFF }), L, { rules: [...g.rules, { ...g.rules[0], value: EFF2 }] }, ctx2).native, undefined);   // кроме него есть ещё эффект
  const hpg = { rules: [{ type: "handler", triggerType: "postInfo", value: "huntPrey", target: "none", predicate: [] }] };
  const hp = translateItem(sp({ selfEffect: EFF }), "", hpg, ctx2);
  assert.deepEqual([hp.native, hp.rule], [true, null]);
  assert.deepEqual(translateItem(sp({ embedded: { actor: "A" } }), "", hpg, ctx2).reason, "handler:huntPrey");   // копия NPC без selfEffect — долг
});

test("translateItem: «Effect: Fly» у Fly — эффект с именем самого предмета безвреден, чужой — нет", () => {
  assert.equal(translateItem(sp({ name: "X" }), "<p>без ссылки</p>", gr(["item:slug:x"]), ctx2).confidence, "high");
  assert.match(translateItem(sp({ name: "Other" }), "<p>без ссылки</p>", gr(["item:slug:x"]), ctx2).reason, /effect-not-in-text/);
});

test("falseCoverage: slug лишь в условии чужого фита — ложное покрытие; триггер, источник и имя группы — настоящее", () => {
  const g = { ownSlugs: new Set(["the-wave"]), rules: [{ predicate: ["feature:the-wave", { or: ["item:slug:fireball", "item:slug:ray"] }] }, { predicate: ["feature:the-wave", "origin:item:refocus"] }] };
  assert.equal(falseCoverage(g, { slug: "fireball" }, false), true);
  assert.equal(falseCoverage(g, { slug: "fireball" }, true), false);       // найден по source
  assert.equal(falseCoverage(g, { slug: "refocus" }, false), false);       // триггер правила
  assert.equal(falseCoverage(g, { slug: "the-wave" }, false), false);      // сам предмет группы
  assert.equal(falseCoverage({ ownSlugs: new Set(), rules: [{ predicate: ["item:slug:fireball"] }] }, { slug: "fireball" }, false), false);   // без чужого фита
});

test("buildPaCatalog: slug у копий NPC без source — если все предметы с ним одна способность", () => {
  const rule = (v = 1) => ({ v: 1, label: "n" + v, onUse: { targets: "self", excludeSelf: null, zone: null, challenge: null, apply: [{ to: "self", condition: { slug: "frightened", value: v, policy: "max" } }] } });
  const npc = (n, slug) => ({ uuid: `Compendium.x.Actor.${n}.Item.i`, slug, embedded: true });
  const items = [npc(1, "same"), npc(2, "same"), npc(3, "diff"), npc(4, "diff"), npc(5, "stranger"), npc(6, "stranger"), npc(7, "lowone"), npc(8, "lowone"), { uuid: "Compendium.pf2e.feats-srd.Item.z", slug: "stranger" }];
  const d = (it, r, extra = {}) => ({ uuid: it.uuid, slug: it.slug, confidence: "high", rule: r, slugOnly: true, ...extra });
  const r = buildPaCatalog([d(items[0], rule()), d(items[1], rule()), d(items[2], rule(1)), d(items[3], rule(2)), d(items[4], rule()), d(items[5], rule()), d(items[6], rule()), d(items[7], rule(), { confidence: "low" })], [], items, []);
  assert.deepEqual(Object.keys(r.cat.bySlug), ["same"]);                       // одинаковые — берём (имя правила не в счёт)
  assert.deepEqual(r.cat.bySource, {});                                        // у копий по slug источник не наш
  assert.equal(r.outcome.get(items[0].uuid), "ported");
  assert.equal(r.outcome.get(items[2].uuid), "source-conflict");               // разные правила при одном slug
  assert.equal(r.outcome.get(items[4].uuid), "slug-ambiguous");                // тот же slug у предмета вне переноса
  assert.equal(r.outcome.get(items[6].uuid), "slug-ambiguous");                // у соседа сомнительное правило
  assert.equal(r.included.length, 1);
});

test("buildPaCatalog: covered/native/false-coverage не переносятся; копия NPC по slug не вешает правило на источник", () => {
  const rule = { v: 1, label: "A", onUse: { targets: "self", excludeSelf: null, zone: null, challenge: null, apply: [{ to: "self", condition: { slug: "frightened", value: 1, policy: "max" } }] } };
  const P = "Compendium.pf2e.spells-srd.Item.";
  const items = [{ uuid: P + "a", slug: "a" }, { uuid: P + "b", slug: "b" }, { uuid: "Compendium.x.Actor.1.Item.n", slug: "n", embedded: true, source: P + "s" }];
  const dr = (i, extra) => ({ uuid: i.uuid, slug: i.slug, confidence: "high", rule, ...extra });
  const r = buildPaCatalog([dr(items[0], { paStatus: "native" }), dr(items[1], { paStatus: "port" }), dr(items[2], { slugOnly: true })], [], items, []);
  assert.deepEqual(Object.keys(r.cat.bySource), [P + "b"]);
  assert.deepEqual(Object.keys(r.cat.bySlug).sort(), ["b", "n"]);
  assert.deepEqual(r.skipped, { native: 1 });
});

test("сводка: подпачка долга и итоговый статус документа", () => {
  assert.equal(subpackOf(["handler:grab"]), "0.5e");
  assert.equal(subpackOf(["handler:knockdown"]), "0.5g");
  assert.equal(subpackOf(["pa-own-effect", "handler:deleteHoldingBreath"]), "0.5e");
  assert.equal(subpackOf(["pa-own-effect"]), "0.5d");
  assert.equal(subpackOf(["immunity-after-save"]), "0.5c");
  assert.equal(subpackOf(["roll-trigger:skill-check"]), "0.5c");
  assert.equal(subpackOf(["increase-badge"]), "0.5f");
  assert.equal(subpackOf(["on-damage-roll"]), "0.5g");
  assert.equal(subpackOf(["effect-missing"]), "0.5b");
  const out = new Map([["p", "ported"], ["l", "low"], ["c", "source-conflict"], ["m", "manual-wins"]]);
  assert.deepEqual(statusOf({ uuid: "p", rule: {}, paStatus: "port" }, out), { status: "ported" });
  assert.deepEqual(statusOf({ uuid: "x", paStatus: "native" }, out), { status: "native" });
  assert.deepEqual(statusOf({ uuid: "m", rule: {}, paStatus: "port" }, out), { status: "covered" });
  assert.deepEqual(statusOf({ uuid: "l", rule: {}, reason: "translated: 1 part(s); trigger-type:use/feat,predicate-op:gte" }, out), { status: "debt", reasons: ["trigger-type:use/feat", "predicate-op:gte"], low: true });
  assert.deepEqual(statusOf({ uuid: "c", rule: {}, reason: "translated" }, out), { status: "debt", reasons: ["source-conflict"] });
  assert.deepEqual(statusOf({ uuid: "n", rule: null, reason: "pa-own-effect; handler:x" }, out), { status: "debt", reasons: ["pa-own-effect", "handler:x"] });
});

test("translateItem: документ другого типа, найденный лишь по slug, — вероятно другой предмет (армейская Taunt) -> low", () => {
  const g = { ...gr(["item:slug:x"]), srcTypes: new Set(["spell"]) };
  const camp = { type: "campaignFeature", slug: "x", name: "X", traits: [], actionType: "action" };
  assert.match(translateItem(camp, L, g, ctx2).reason, /slug-only-other-item/);
  assert.equal(translateItem(camp, L, g, ctx2, { viaSource: true }).confidence, "high");               // найден по source
  assert.equal(translateItem(sp(), L, g, ctx2).confidence, "high");                                    // тот же тип
  assert.equal(translateItem({ ...camp, embedded: { actor: "A" } }, L, g, ctx2).confidence, "high");   // копия NPC
});

test("buildPaCatalog: копия NPC с source предмета, у которого есть черновик, не закрывает slug", () => {
  const rule = { v: 1, label: "A", onUse: { targets: "self", excludeSelf: null, zone: null, challenge: null, apply: [{ to: "self", condition: { slug: "frightened", value: 1, policy: "max" } }] } };
  const P = "Compendium.pf2e.spells-srd.Item.";
  const items = [{ uuid: P + "a", slug: "a" }, { uuid: "Compendium.x.Actor.1.Item.n", slug: "a", embedded: true, source: P + "a" }];
  const r = buildPaCatalog([{ uuid: P + "a", slug: "a", confidence: "high", rule }], [], items, []);
  assert.deepEqual(Object.keys(r.cat.bySlug), ["a"]);
});

test("translateItem: подъём «эффект с именем предмета» запрещён для эффектов с выбором/slug чужих предметов и расходников с тирами", () => {
  const g = gr(["item:slug:x"]);
  assert.equal(translateItem(sp({ name: "X" }), "<p>нет ссылки</p>", g, ctx2).confidence, "high");
  assert.match(translateItem(sp({ name: "X" }), "<p>нет ссылки</p>", g, { ...ctx2, effectRisk: { [EFF]: 1 } }).reason, /effect-not-in-text/);
  assert.match(translateItem(sp({ name: "X" }), "<p>нет ссылки</p>", g, { ...ctx2, tierSiblings: () => true }).reason, /effect-not-in-text/);
  assert.equal(translateItem(sp({ name: "X" }), `<p>@UUID[${EFF}]</p>`, g, { ...ctx2, effectRisk: { [EFF]: 1 } }).confidence, "high");   // ссылка в тексте — доказательство
});

const { manualVerdict, sigOf, markersOf } = await import("../tools/pa-port.mjs");
const mchk = (stat, vs, extra = {}) => ({ v: 1, onUse: { targets: "selected", apply: [], check: { statistic: stat, vs: { defense: vs }, byDegree: { success: [{ to: "target", condition: { slug: "prone" } }] }, ...extra } } });
const mchal = (dc, deg = { failure: [{ to: "target", condition: { slug: "frightened", value: 2 } }] }) => ({ v: 1, onUse: { targets: "selected", apply: [], challenge: { statistic: "will", dc, basic: false, byDegree: deg } } });

test("manualVerdict: ручное правило по slug покрывает только тот же предмет с тем же правилом", () => {
  const npc = { embedded: true, type: "action" };
  assert.deepEqual(manualVerdict(mchk("athletics", "reflex"), npc, mchk("athletics", "reflex"), null, null), { status: "covered" });
  assert.equal(manualVerdict(mchk("athletics", "fortitude"), npc, mchal({ value: 20 }), null, null).status, "slug-collision");   // ловушка Shove: спасбросок вместо Атлетики
  assert.equal(manualVerdict(mchk("athletics", "reflex"), { type: "campaignFeature" }, mchk("athletics", "reflex"), null, { type: "action" }).status, "slug-collision");   // армейский Feint
  assert.deepEqual(manualVerdict(mchal({ value: 18 }), npc, mchal({ value: 27 }), null, null).reasons, ["manual-gap", "dc"]);   // Scarecrow's Leer у Allosaurus
  assert.deepEqual(manualVerdict(mchal({ expr: "markup" }), npc, mchal({ value: 27 }), null, null), { status: "covered" });
  assert.deepEqual(manualVerdict(mchal({ source: "spell" }), npc, mchal({ value: 18 }), null, null).reasons, ["manual-gap", "dc"]);   // Breathe Fire NPC: фиксированная СЛ
  assert.equal(manualVerdict(mchal({ source: "spell" }), { type: "spell" }, mchal({ value: 18 }), null, null).status, "covered");
  const steps = mchal({ expr: "markup" }, { failure: [{ to: "target", condition: { slug: "frightened", value: 3 } }] });
  assert.deepEqual(manualVerdict(steps, npc, mchal({ expr: "markup" }), null, null).reasons, ["manual-gap", "steps"]);   // Frightful Presence: 3 вместо 4
});

test("manualVerdict: иммунитет после испытания в тексте — долг 0.5c; без правила сверка по маркерам текста", () => {
  const npc = { embedded: true, type: "action" }, txt = "<p>The creature is temporarily immune to this Frightful Presence for 1 minute.</p>";
  const v = manualVerdict(mchal({ expr: "markup" }, {}), npc, mchal({ expr: "markup" }, {}), null, null, txt);
  assert.deepEqual(v.reasons, ["manual-gap", "immunity-after-save"]);
  assert.equal(subpackOf(v.reasons), "0.5c");
  const macro = { v: 1, onUse: { targets: "selected", apply: [] }, macros: [{ builtin: "x" }] };
  assert.equal(manualVerdict(macro, npc, null, "handler:x", null, "", true).status, "covered");
  assert.deepEqual(manualVerdict(macro, npc, null, "handler:x", null, "", false).reasons, ["slug-collision", "text"]);   // Zashathal: по тексту Demoralize
  assert.deepEqual(manualVerdict(macro, npc, null, "handler:x", null, "", null).reasons, ["manual-gap", "unverified"]);
  assert.equal(markersOf("<p>@UUID[A.b]{x} @Check[will|dc:5] [[/act demoralize]]</p>"), "A.b|demoralize|will");
  assert.equal(sigOf(macro).mech, "macro");
});

test("ручной каталог: Frightful Presence — испуг 1/2/4 по тексту pf2e", () => {
  const f = builtin.bySlug["frightful-presence"].onUse.challenge.byDegree;
  assert.deepEqual(["success", "failure", "criticalFailure"].map((d) => f[d][0].condition.value), [1, 2, 4]);
});
