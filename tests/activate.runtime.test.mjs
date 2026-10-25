// activate: рантайм сообщения активации (plan-activate §5.2, §5.3) — чистые части cast.mjs / use.mjs. Живое — tests/live/activate.js.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) } };   // use.mjs тянет zone.mjs
const { validateRule } = await import("../scripts/rules.mjs");
const { rankOf, entryOf, locId, pickDc, activationDc, levelDc, effectText, giveBackPlan, withUse, withoutUse, usesLeft } = await import("../scripts/cast.mjs");
const { activationUse, hasSnapshot, isResumable, useKindOf } = await import("../scripts/use.mjs");
const { buildViewModel } = await import("../scripts/chat.mjs");
const { castOrigin } = await import("../scripts/builtin/lib.mjs");

const MOD = "pf2e-automato", ARC = "Compendium.pf2e.spells-srd.Item.kBhaPuzLUSwS6vVf";
const USE = { targets: "self", apply: [{ to: "self", condition: { slug: "prone" } }] };
const ITEM = { uuid: "Actor.a.Item.i", name: "Horn", type: "equipment" };

test("rankOf: число как есть; half:actor — половина уровня владельца вниз не ниже min; half:item — уровня предмета; нет ранга — undefined", () => {
  const lv = (actorLevel, itemLevel = 9) => ({ actorLevel, itemLevel });
  assert.equal(rankOf(3, lv(1)), 3);
  assert.equal(rankOf(undefined, lv(1)), undefined);
  assert.equal(rankOf({ half: "actor", min: 1 }, lv(7)), 3);   // 7/2 = 3.5 вниз
  assert.equal(rankOf({ half: "actor", min: 1 }, lv(1)), 1);
  assert.equal(rankOf({ half: "actor", min: 3 }, lv(2)), 3);   // не ниже min
  assert.equal(rankOf({ half: "actor", min: 1 }, lv(20)), 10);
  assert.equal(rankOf({ half: "item", min: 1 }, lv(20, 9)), 4);   // от предмета, не от актёра
  assert.equal(rankOf({ half: "actor", min: 2 }, lv(undefined)), 2);
});

test("entryOf: вариант поверх записи, per/requires/id — записи; locId различает варианты", () => {
  const rec = { id: "gaze", label: "Взгляд", per: { value: 1, unit: "days" }, requires: "invested", choices: [{ id: "a", spell: ARC, rank: 2 }, { id: "b", label: "B", onUse: USE, dc: 30 }] };
  const a = entryOf(rec, "a"), b = entryOf(rec, "b");
  assert.deepEqual([a.id, a.choice, a.spell, a.rank, a.label, a.per.unit, a.requires, "choices" in a], ["gaze", "a", ARC, 2, "Взгляд", "days", "invested", false]);
  assert.deepEqual([b.label, b.dc, b.onUse === USE], ["B", 30, true]);
  assert.equal(entryOf(rec, "zzz"), null);
  assert.equal(entryOf({ id: "x", spell: ARC }, undefined).id, "x");   // без choices — запись как есть
  assert.deepEqual([locId(rec), locId(a), locId(b)], ["gaze", "gaze.a", "gaze.b"]);
});

test("СЛ шагов: число в шаге -> СЛ записи -> СЛ по уровню предмета; class-spell — лучшая из классовой и заклинаний", () => {
  const ch = (dc) => ({ challenge: { statistic: "fortitude", ...(dc && { dc }) } });
  assert.equal(activationDc(ch({ value: 31 }), { dc: 27 }, 5), 31);
  assert.equal(activationDc(ch(null), { dc: 27 }, 5), 27);
  assert.equal(activationDc(USE, { dc: 27 }, 5), 27);
  assert.equal(activationDc(ch(null), { dc: null }, 5), levelDc(5));
  assert.equal(activationDc(ch(null), undefined, 20), levelDc(20));
  const ag = { dc: { against: "class-spell" } };
  assert.deepEqual(pickDc(ag, { itemLevel: 5, bestDc: 24, classDc: 29 }), { kind: "class", dc: 29 });
  assert.deepEqual(pickDc(ag, { itemLevel: 5, bestDc: 31, classDc: 29 }), { kind: "class", dc: 31 });
  assert.deepEqual(pickDc(ag, { itemLevel: 5, bestDc: 24 }), { kind: "class", dc: 24 });
  assert.deepEqual(pickDc(ag, { itemLevel: 5 }), { kind: "level", dc: levelDc(5) });   // у владельца нет ни той, ни другой
  assert.deepEqual(pickDc({ dc: 30 }, { itemLevel: 5, bestDc: 40 }), { kind: "text", dc: 30 });   // прежнее поведение не тронуто
});

test("effectText: блок активации с @Template; метка записи предпочтительнее; нет шаблона — пусто", () => {
  const html = `<p>Intro</p><p><strong>Activate</strong> Boom <span>1</span></p><p><strong>Effect</strong> A @Template[type:cone|distance:30]{30-foot cone}.</p>`
    + `<hr /><p><strong>Activate</strong> Roar</p><p><strong>Effect</strong> A @Template[type:emanation|distance:10]{10 feet}.</p>`;
  assert.match(effectText(html, "Roar"), /emanation/);
  assert.doesNotMatch(effectText(html, "Roar"), /cone/);
  assert.match(effectText(html, "Boom"), /cone/);
  assert.match(effectText(html, undefined), /cone/);   // метки нет — первый с шаблоном
  assert.equal(effectText("<p><strong>Activate</strong> X</p><p>no template</p>", "X"), "");
  assert.equal(effectText(undefined, "X"), "");
});

test("сообщение активации: снимок use со своим правилом {v,onUse}, метка activation, без flags.pf2e.origin; castOrigin = null", () => {
  const flag = { item: ITEM.uuid, id: "boom", useId: "U1" };
  const data = activationUse({ item: ITEM, resolved: { rule: { v: 1, activate: [{ id: "boom" }], macros: [{}] }, source: "catalog", confidence: "high", slug: "horn", sourceUuid: "Compendium.x.Item.h", hints: { possible: [1] } },
    onUse: { ...USE, targets: "selected" }, dc: 29, targets: [{ key: "t1", uuid: "S.T.t1", name: "Гоблин", pc: false }], rollOptions: ["origin:item:cast-by-activation"], activation: flag, actor: "Actor.a", token: "S.T.tk", content: "<p>x</p>", now: 5 });
  const u = data.flags[MOD].use;
  assert.deepEqual(data.flags[MOD].activation, flag);
  assert.equal(data.flags.pf2e, undefined);
  assert.deepEqual([u.kind, u.dc, u.createdAt, u.actor, u.token, u.confidence, u.src, u.item.uuid, u.item.sourceId], ["use", 29, 5, "Actor.a", "S.T.tk", "high", "catalog", ITEM.uuid, "Compendium.x.Item.h"]);
  assert.deepEqual(u.rule, { v: 1, onUse: { ...USE, targets: "selected" } });   // ни activate, ни macros исходного правила
  assert.deepEqual(u.rollOptions, ["origin:item:cast-by-activation"]);
  assert.equal(u.hints, undefined);
  assert.equal(u.targets.length, 1);
  assert.deepEqual(u.state, {});
  assert.equal(hasSnapshot({ flags: data.flags }), true);   // onPreCreateMessage снимок не перезапишет
  const msg = { flags: data.flags };
  assert.equal(castOrigin(msg), null);   // shield-ward / prey-share / apparition-sense / variable-cast не примут его за сотворение
  assert.equal(useKindOf(msg), null);
});

test("сообщение активации: область — state.awaitingRegion (шаблон бросают из сообщения), остальное — нет; исполнение ждёт регион", () => {
  const mk = (onUse) => activationUse({ item: ITEM, resolved: { rule: { v: 1 }, confidence: "high" }, onUse, dc: 20, targets: [], activation: { item: ITEM.uuid, id: "a", useId: "U" }, actor: "Actor.a", content: "" }).flags[MOD].use;
  const area = mk({ targets: "area", challenge: { statistic: "fortitude", dc: { value: 20 } } });
  assert.equal(area.state.awaitingRegion, true);
  assert.equal(isResumable(area, area.createdAt, 30), false);
  assert.deepEqual(mk(USE).state, {});
  assert.equal(mk(USE).rollOptions, undefined);
});

test("частота и useId: каст + добавка — оба сообщения в одной метке, возврат ровно раз; два нажатия — два использования", () => {
  const per = { value: 1, unit: "days", uses: 2 }, now = { time: 0, combat: null, round: 0 };
  let e = withUse(undefined, per, now, "U1");
  e = withUse(e, per, now, "U2");
  assert.equal(usesLeft(e, per, now), 0);   // два нажатия = два списания
  const f = (id) => ({ activation: { item: ITEM.uuid, id: "tattoo", useId: id } });
  // карточка заклинания и сообщение активации одного нажатия несут один useId
  const p1 = giveBackPlan(f("U1"), "spellCard", e);
  assert.deepEqual([p1.item, p1.id, p1.next.log], [ITEM.uuid, "tattoo", ["U2"]]);
  const after = p1.next;
  assert.equal(giveBackPlan(f("U1"), "useCard", after), null);   // второе сообщение того же нажатия — уже возвращено, повторно не вернётся
  assert.equal(giveBackPlan(f("U2"), "useCard", after).next, null);   // другое нажатие — своё; пусто -> флаг снимается
  assert.equal(giveBackPlan(f("Uzz"), "m", after), null);   // чужая метка
  // старая карточка (флаг cast без useId) — по id сообщения; cast у variable-cast ({actions}) счётчика не касается
  const old = { cast: { item: ITEM.uuid, id: "x" } };
  assert.equal(giveBackPlan(old, "m9", withUse(undefined, per, now, "m9")).next, null);
  assert.equal(giveBackPlan({ cast: { actions: 2 } }, "m9", e), null);
  assert.equal(giveBackPlan({}, "m9", e), null);
  assert.equal(withoutUse(e, "nope"), e);
});

test("карточка предмета: запись без spell — кнопка «Активировать», choices и half-ранг подписываются без [object Object]", () => {
  const r = validateRule({ v: 1, activate: [{ id: "cut", label: "Cut Fear", onUse: USE }, { id: "h", spell: ARC, rank: { half: "actor", min: 1 } }, { id: "c", label: "Куб", choices: [{ id: "a", spell: ARC }, { id: "b", label: "B", onUse: USE }] }] }).rule;
  const env = {
    t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k), mode: () => "auto", now: 1, resumeMinutes: 30, groups: () => [], toolbelt: false,
    tokenName: (k) => k, isOwner: () => false, isActorOwner: () => true, statLabel: (s) => s, conditionLabel: (s) => s,
    uuidName: (u) => (u === ARC ? "Electric Arc" : null), castInfo: (_u, c) => ({ why: null, left: null, dc: 17, rank: c.id === "h" ? 4 : undefined })
  };
  const msg = { id: "m1", author: { id: "a" }, flags: { [MOD]: { use: { v: 1, kind: "card", confidence: "high", rule: r, createdAt: 1, item: { uuid: "Actor.a.Item.i", name: "I" }, actor: "Actor.a", state: {} } } } };
  const vm = buildViewModel(msg, { id: "a", isGM: false }, env);
  assert.deepEqual(vm.cast.map((c) => c.text), ['cast.btnUse{"name":"Cut Fear"}', 'cast.btn{"name":"Electric Arc"}', 'cast.btnUse{"name":"Куб"}']);
  assert.match(vm.cast[1].meta, /cast\.rank\{"rank":4\}/);
  assert.doesNotMatch(vm.cast[0].meta, /rank/);
});

test("effectText: метка только по заголовку активации, иначе по порядку; хвост разделов обрезан", () => {
  const html = `<p><strong>Activate</strong> Alpha</p><p><strong>Effect</strong> hit Beta with @Template[type:cone|distance:30].</p>`
    + `<p><strong>Activate</strong> Beta</p><p><strong>Effect</strong> @Template[type:burst|distance:20]. @Check[reflex|dc:20]</p>`
    + `<hr /><p><strong>Craft Requirements</strong> @Check[crafting|dc:30]</p>`;
  assert.match(effectText(html, "Beta"), /burst/);   // «Beta» есть и в тексте Alpha, но заголовок — только у второго
  assert.doesNotMatch(effectText(html, "Beta"), /cone/);
  assert.match(effectText(html, "нет такой", 1), /burst/);   // метки нет в заголовках — по порядку
  assert.match(effectText(html, undefined, 0), /cone/);
  assert.doesNotMatch(effectText(html, "Beta"), /Craft|crafting/);
  assert.match(effectText(html, "Beta"), /@Check\[reflex/);   // свой @Check остаётся
  assert.doesNotMatch(effectText(html.replace("<hr />", "<h3>Special</h3>"), "Beta"), /crafting/);
});

test("useRank: ранг сотворения из метки activation для сообщения без origin; castRank и ранг предмета — прежний порядок", async () => {
  const { useRank } = await import("../scripts/apply.mjs");
  const act = (rank) => ({ flags: { [MOD]: { activation: { rank } } } });
  assert.equal(useRank(act(4), { level: 9 }), 4);
  assert.equal(useRank({ flags: { pf2e: { origin: { castRank: 3 } }, [MOD]: { activation: { rank: 4 } } } }, { level: 9 }), 3);
  assert.equal(useRank({ flags: {} }, { level: 9 }), 9);
  assert.equal(useRank({ flags: {} }, { rank: 2, level: 9 }), 2);
  assert.equal(useRank({ flags: {} }, null), 1);
});

test("карточка предмета: СЛ на кнопке — у заклинания и испытания; у выбора и самобаффа нет", () => {
  const CH = { targets: "selected", challenge: { statistic: "fortitude", byDegree: { failure: [{ to: "target", condition: { slug: "sickened", value: 1 } }] } } };
  const r = validateRule({ v: 1, activate: [{ id: "buff", label: "Buff", onUse: USE }, { id: "test", label: "Test", onUse: CH }, { id: "c", label: "C", choices: [{ id: "a", spell: ARC }, { id: "b", label: "B", onUse: USE }] }] }).rule;
  const env = { t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k), mode: () => "auto", now: 1, resumeMinutes: 30, groups: () => [], toolbelt: false, tokenName: (k) => k, isOwner: () => false, isActorOwner: () => true, statLabel: (s) => s, conditionLabel: (s) => s, uuidName: () => null, castInfo: () => ({ why: null, left: null, dc: 27, byLevel: true }) };
  const msg = { id: "m1", author: { id: "a" }, flags: { [MOD]: { use: { v: 1, kind: "card", confidence: "high", rule: r, createdAt: 1, item: { uuid: "Actor.a.Item.i", name: "I" }, actor: "Actor.a", state: {} } } } };
  const [buff, test2, ch] = buildViewModel(msg, { id: "a", isGM: false }, env).cast;
  assert.equal(buff.meta, "");
  assert.match(test2.meta, /chat\.dc.*cast\.byLevel/);
  assert.equal(ch.meta, "");
});
