// Остаток 0.5b переноса pf2e-automations: признаки вместо ручных правил (tools/pa-port.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

globalThis.game = { user: { isActiveGM: true }, settings: { get: () => "auto" }, i18n: { localize: (k) => k, format: (k) => k }, pf2e: { ConditionManager: { conditions: new Map() } } };
globalThis.ui = { notifications: { warn() {} } };

const { translateItem, buildPaCatalog, subpackOf, statusOf, kindMismatch, applyAccepted, triggerOnly } = await import("../tools/pa-port.mjs");
const labels = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/labels.json", import.meta.url)), "utf8"));

const EFF = "Compendium.pf2e.equipment-effects.Item.AAAAAAAAAAAAAAAA", EFF2 = "Compendium.pf2e.spell-effects.Item.BBBBBBBBBBBBBBBB", CID = "cond0000000000id";
const ctx = { effects: { [EFF]: "Effect: X", [EFF2]: "Spell Effect: Y" }, condSlugs: new Set(["quickened"]), condIds: { quickened: CID }, grants: {}, labels: {}, condSlugByUuid: () => null, condNames: [] };
const L = `@UUID[${EFF}]`;
const sp = (extra = {}) => ({ type: "spell", slug: "x", name: "X", traits: [], range: "30 feet", ...extra });
const gr = (pred, extra = {}) => ({ rules: [{ type: "base", triggerType: "spell-cast", target: "SelfEffect", value: EFF, predicate: pred, ...extra }] });
const cons = (extra = {}) => ({ type: "consumable", slug: "x", name: "X", traits: [], ...extra });
const grp = (target) => ({ rules: [{ triggerType: "use", target, value: EFF, predicate: [] }] });

test("subpackOf: пассив, условие на шаге, сравнение ранга, чужой эффект и «спасбросок на нападение» — в подпачки, а не в остаток 0.5b", () => {
  assert.equal(subpackOf(["passive-event-trigger", "effect-not-in-text"]), "0.5g");
  assert.equal(subpackOf(["predicate:target:trait:undead"]), "0.5g");
  assert.equal(subpackOf(["predicate-op:lt", "predicate-op:gte"]), "0.5f");
  assert.equal(subpackOf(["effect-missing", "predicate-op:lt"]), "0.5f");   // правило с условием на ранг и пропавшим эффектом
  assert.equal(subpackOf(["external-effect"]), "0.5d");
  assert.equal(subpackOf(["save-on-attacked", "text-condition-missing:frightened"]), "0.5g");
  assert.equal(subpackOf(["trigger-type:postInfo/weapon"]), "0.5g");
  assert.equal(subpackOf(["text-condition-missing:invisible"]), "0.5b");   // нет общего признака — остаётся на разметку
});

test("translateItem: эффект из Workbench — external-effect (0.5d); сравнение круга у провалившегося правила — не долг (0.5f: шаг rank)", () => {
  const WB = "Compendium.xdy-pf2e-workbench.xdy-pf2e-workbench-items.Item.wOcAf3pf04cTM4Uk";
  const r = translateItem(sp(), "<p>x</p>", gr(["origin:item:x", { lt: ["origin:item:level", 9] }], { value: WB }), ctx);
  assert.equal(r.rule, null);
  assert.deepEqual(r.reason.split("; "), ["external-effect"]);
});

test("translateItem: sourceId своего предмета в предикате — привязка, чужой — условие", () => {
  const own = "Compendium.pf2e.actionspf2e.Item.AAAAAAAAAAAAAAAA";
  const act = { type: "action", slug: "x", name: "X", traits: [], actionType: "action", uuid: own };
  assert.equal(translateItem(act, L, gr([`origin:item:sourceId:${own}`], { triggerType: "postInfo" }), ctx).confidence, "high");
  assert.match(translateItem(act, L, gr(["origin:item:sourceId:Compendium.pf2e.actionspf2e.Item.BBBBBBBBBBBBBBBB"], { triggerType: "postInfo" }), ctx).reason, /predicate:origin:item:sourceId/);
});

test("translateItem: «before becoming @UUID[состояние]» — не выдача состояния", () => {
  const c = (pre) => `<p>${L} can carry more ${pre} @UUID[Compendium.pf2e.conditionitems.Item.${CID}]{Quickened}.</p>`;
  assert.equal(translateItem(cons(), c("before becoming"), grp("SelfEffect"), ctx).confidence, "high");
  assert.match(translateItem(cons(), c("and then becoming"), grp("SelfEffect"), ctx).reason, /text-condition-missing:quickened/);
});

test("kindMismatch: spell-cast — только заклинание, use — только снаряжение, армейская способность — не из обычной группы; владелец условия — сам предмет группы", () => {
  const g = (triggerType, srcTypes, predicate = ["origin:item:x"]) => ({ srcTypes: new Set(srcTypes), rules: [{ triggerType, predicate }] });
  assert.equal(kindMismatch(g("spell-cast", ["spell"]), { type: "action", slug: "x" }, false), true);   // действие NPC «Flicker» — не заклинание
  assert.equal(kindMismatch(g("spell-cast", ["spell"]), { type: "spell", slug: "x" }, false), false);
  assert.equal(kindMismatch(g("spell-cast", ["spell"]), { type: "action", slug: "x" }, true), false);   // найден по source — настоящий
  assert.equal(kindMismatch(g("use", ["equipment"]), { type: "action", slug: "x" }, false), true);      // «Blight Breath» у нуккелави — не флакон
  assert.equal(kindMismatch(g("use", ["equipment"]), { type: "consumable", slug: "x" }, false), false);
  assert.equal(kindMismatch(g("postInfo", ["action"]), { type: "feat", slug: "x" }, false), false);     // карточка есть у любого документа
  assert.equal(kindMismatch(g("saving-throw", ["spell"]), { type: "action", slug: "x" }, false), false); // бросок PA ловит по slug у любого документа (NPC «Slow»)
  assert.equal(kindMismatch(g("postInfo", ["action"]), { type: "campaignFeature", slug: "x" }, false), true);
  assert.equal(kindMismatch(g("spell-cast", ["spell"], ["feat:allegro"]), { type: "feat", slug: "allegro" }, false), false);   // feat:allegro — владелец условия
  assert.equal(kindMismatch({ srcTypes: new Set(), rules: [{ triggerType: "use" }] }, { type: "action", slug: "x" }, false), false);   // типы группы неизвестны
});

test("translateItem: копия NPC с СЛ из текста — dc {expr:markup}; предмет компендиума остаётся с числом; копии с разной головой — одна slug-запись", () => {
  const cx = { ...ctx, labels };
  const g = { rules: [{ type: "base", triggerType: "saving-throw", target: "SelfEffect", value: EFF, predicate: [{ or: ["outcome:failure", "outcome:criticalFailure"] }, "item:slug:swarm"] }] };
  const html = (dc, stat) => `<p>takes damage (@Check[${stat}|dc:${dc}|basic|options:area-effect] save) ${L}</p>`;
  const npc = (extra = {}) => ({ type: "action", slug: "swarm", name: "Swarm", traits: [], actionType: "action", ...extra });
  const a = translateItem(npc({ embedded: { actor: "A" } }), html(22, "reflex"), g, cx), b = translateItem(npc({ embedded: { actor: "B" } }), html(30, "fortitude"), g, cx);
  assert.deepEqual(a.rule.onUse.challenge.dc, { expr: "markup" });
  assert.equal(translateItem(npc(), html(22, "reflex"), g, cx).rule.onUse.challenge.dc.value, 22);
  const items = [{ uuid: "Compendium.x.Actor.1.Item.a", slug: "swarm", type: "action", embedded: true }, { uuid: "Compendium.x.Actor.2.Item.b", slug: "swarm", type: "action", embedded: true }];
  const d = (it, r) => ({ uuid: it.uuid, slug: "swarm", type: "action", confidence: "high", slugOnly: true, paStatus: "port", rule: r.rule });
  const r = buildPaCatalog([d(items[0], a), d(items[1], b)], [], items, []);
  assert.deepEqual(Object.keys(r.cat.bySlug), ["swarm"]);
  assert.deepEqual(r.skipped, {});
});

const rule = (n, eff = null, to = "self") => ({ v: 1, label: n, onUse: { targets: "self", excludeSelf: null, zone: null, challenge: null, apply: [eff ? { to, effect: { uuid: eff } } : { to, condition: { slug: "frightened", value: 1, policy: "max" } }] } });
const N = (id) => `Compendium.x.Actor.1.Item.${id}`;
const draft = (uuid, slug, type, r) => ({ uuid, slug, type, confidence: "high", slugOnly: true, paStatus: "port", rule: r });

test("buildPaCatalog: тёзки разных типов — ключ slug@type; армейская способность в расчёт общего ключа не входит", () => {
  const items = [{ uuid: N("a"), slug: "twin", type: "action", embedded: true }, { uuid: "Compendium.pf2e.feats-srd.Item.f", slug: "twin", type: "feat" }];
  // у черты черновика нет (её ведёт pf2e / не PA): общий ключ неоднозначен, но среди действий тёзка один
  const r = buildPaCatalog([draft(N("a"), "twin", "action", rule("A"))], [], items, []);
  assert.deepEqual(Object.keys(r.cat.bySlug), ["twin@action"]);
  assert.equal(r.outcome.get(N("a")), "ported");
  const camp = [{ uuid: N("c"), slug: "twin", type: "campaignFeature", embedded: true }, { uuid: N("a"), slug: "twin", type: "action", embedded: true }];
  assert.deepEqual(Object.keys(buildPaCatalog([draft(N("a"), "twin", "action", rule("A"))], [], camp, []).cat.bySlug), ["twin"]);
});

test("buildPaCatalog: тёзка со своим selfEffect не мешает slug-записи, если правило — ровно этот selfEffect (resolveRule его пропустит); иное правило — двойное применение", () => {
  const SE = "Compendium.pf2e.feat-effects.Item.SELF";
  const items = [{ uuid: N("a"), slug: "twin", type: "action", embedded: true }, { uuid: "Compendium.pf2e.feats-srd.Item.f", slug: "twin", type: "action", selfEffect: SE }];
  assert.deepEqual(Object.keys(buildPaCatalog([draft(N("a"), "twin", "action", rule("A", SE))], [], items, []).cat.bySlug), ["twin"]);
  assert.equal(buildPaCatalog([draft(N("a"), "twin", "action", rule("A", "Compendium.pf2e.feat-effects.Item.OTHER"))], [], items, []).skipped["slug-ambiguous"], 1);
});

test("translateItem: тир без правила PA, но с эффектом из текста (Dragon's Blood Pudding) — берём правило с этим эффектом", () => {
  const r = (slug, value) => ({ type: "base", triggerType: "use", target: "SelfEffect", value, predicate: [`consumable:${slug}`] });
  const g = { rules: [r("pud", EFF), r("pud-major", EFF2)] };
  const t = translateItem(cons({ slug: "pud-greater" }), L, g, ctx, { viaSource: true });
  assert.deepEqual(t.rule.onUse.apply.map((a) => a.effect.uuid), [EFF]);
  assert.equal(translateItem(cons({ slug: "pud-greater" }), "<p>x</p>", g, ctx, { viaSource: true }).reason, "slug-mismatch");
});

test("applyAccepted: ручной вердикт — статус вместо долга и долг в подпачку; без вердикта черновик не трогаем", () => {
  const ds = [{ uuid: "a", rule: { x: 1 }, confidence: "low", reason: "r" }, { uuid: "b", rule: null, reason: "r" }, { uuid: "c", rule: null, reason: "r" }];
  applyAccepted(ds, [{ uuid: "a", paStatus: "false-coverage", reason: "тёзка" }, { uuid: "b", debt: { subpack: "0.5g", reasons: ["secondary-activation"] }, reason: "вторичное действие" }, { uuid: "c", rule: null, reason: "исключён" }]);
  assert.deepEqual([ds[0].paStatus, ds[0].rule, ds[0].reason], ["false-coverage", null, "false-coverage: тёзка"]);
  assert.deepEqual([ds[1].debtSubpack, ds[1].debtReasons], ["0.5g", ["secondary-activation"]]);
  assert.deepEqual(statusOf(ds[1], new Map()), { status: "debt", reasons: ["secondary-activation"] });
  assert.equal(ds[2].reason, "r");
});

test("translateItem: тир-сосед блокирует подъём по source; текст со ссылкой на свой эффект, а правило другое — own-effect-in-text; эффект пака модуля не в счёт", () => {
  const h = "<p>без ссылки</p>";
  assert.equal(translateItem(sp({ name: "Other" }), h, gr(["item:slug:x"]), ctx, { viaSource: true }).confidence, "high");
  assert.match(translateItem(sp({ name: "Other" }), h, gr(["item:slug:x"]), { ...ctx, tierSiblings: () => true }, { viaSource: true }).reason, /effect-not-in-text/);
  const mine = "Compendium.pf2e.bestiary-effects.Item.OWNOWNOWNOWNOWNO";
  const cx = { ...ctx, effects: { ...ctx.effects, [mine]: "Effect: Own" } };
  assert.match(translateItem(sp(), `<p>${L} @UUID[${mine}]{Own}</p>`.replace(L, ""), gr(["item:slug:x"]), cx, { viaSource: true }).reason, /own-effect-in-text/);
  assert.doesNotMatch(translateItem(sp(), `<p>${L} @UUID[${mine}]</p>`, gr(["item:slug:x"]), cx, { viaSource: true }).reason, /own-effect-in-text/);   // ссылка и на эффект правила — не «чужой»
  const mod = "Compendium.pf2e-automato.effects.Item.MODMODMODMODMODM";
  assert.doesNotMatch(translateItem(sp(), `<p>@UUID[${mine}]</p>`, gr(["item:slug:x"], { value: mod }), { ...cx, effects: { ...cx.effects, [mod]: "Effect: Mod" } }, { viaSource: true }).reason, /own-effect-in-text/);
});

test("translateItem: «Self» у реакции — вручную (reaction-self), но при броске (ловушка Swarming Bites) Self — бросавший, это цель", () => {
  const act = { type: "action", slug: "x", name: "X", traits: [], actionType: "reaction" };
  assert.match(translateItem(act, L, gr(["item:slug:x"], { triggerType: "postInfo" }), ctx, { viaSource: true }).reason, /reaction-self/);
  const roll = gr(["outcome:failure", "item:slug:x"], { triggerType: "saving-throw" });
  assert.doesNotMatch(translateItem({ ...act, defense: { save: "reflex", basic: true } }, L, roll, { ...ctx, labels }).reason, /reaction-self/);
});

test("translateItem: lifted — что снято признаками 0.5b (для выборки --subpack 0.5b)", () => {
  assert.deepEqual(translateItem(sp({ name: "Other" }), "<p>x</p>", gr(["item:slug:x"]), ctx, { viaSource: true }).lifted, ["effect-by-source"]);
});

test("sample.mjs inSubpack(0.5b): поднятые признаками остатка — lifted, ручной вердикт, ключ slug@type, СЛ из разметки", async () => {
  const { inSubpack } = await import("../tools/sample.mjs");
  assert.equal(inSubpack({ lifted: ["effect-by-source"] }, "0.5b"), true);
  assert.equal(inSubpack({ confidence: "manual" }, "0.5b"), true);
  assert.equal(inSubpack({ catSlug: "a@action" }, "0.5b"), true);
  assert.equal(inSubpack({ rule: { onUse: { challenge: { dc: { expr: "markup" } } } } }, "0.5b"), true);
  assert.equal(inSubpack({ catSlug: "a", rule: {} }, "0.5b"), false);
  assert.equal(inSubpack({ catSlug: "a" }, "0.5c"), true);   // другие подпачки фильтруют сами
});

test("0.5g1: карточка пассивки — использование (postInfo годится), прочие триггеры у пассива — по-прежнему событие", () => {
  const pas = (extra = {}) => ({ type: "feat", slug: "x", name: "X", traits: [], actionType: "passive", ...extra });
  assert.equal(translateItem(pas(), L, gr(["origin:item:x"], { triggerType: "postInfo" }), ctx).confidence, "high");
  assert.match(translateItem(pas(), L, gr(["origin:item:x"], { triggerType: "spell-cast" }), ctx).reason, /passive-event-trigger/);
  assert.match(translateItem({ type: "weapon", slug: "x", name: "X", traits: [] }, L, gr(["origin:item:x"], { triggerType: "postInfo" }), ctx).reason, /trigger-type:postInfo\/weapon/);
});

test("0.5g1: черта-выдавалка действия группы — covered-заглушка; у настоящего носителя (по source) правило остаётся", () => {
  const feat = { type: "feat", slug: "x", name: "X", traits: [], actionType: "passive", ruleKeys: ["GrantItem"] };
  const g = gr(["origin:item:x"], { triggerType: "postInfo" }), c = { ...ctx, actionBySlug: new Map([["x", [{ uuid: "Compendium.pf2e.actionspf2e.Item.A", slug: "x", type: "action" }]]]) };
  assert.equal(translateItem(feat, L, g, c).stub, true);
  assert.equal(translateItem(feat, L, g, ctx).stub, undefined);   // действия с этим slug нет (тип выдаваемого документа, а не тип группы)
  assert.equal(translateItem({ ...feat, ruleKeys: [] }, "<p>no</p>", g, c).stub, undefined);
  assert.equal(translateItem({ ...feat, ruleKeys: [] }, "<p>@UUID[Compendium.pf2e.actionspf2e.Item.A]{X}</p>", g, c).stub, true);
  assert.equal(translateItem(feat, L, g, c, { viaSource: true }).stub, undefined);
});

test("0.5g1: спасбросок — «self» PA это получатель шага: self:trait:metal -> when target:trait:metal; с target в предикате — условие остаётся долгом", () => {
  const g = (pred) => ({ rules: [{ type: "base", triggerType: "saving-throw", target: "SelfEffect", value: EFF, predicate: pred }] });
  const s = sp({ defense: { save: "fortitude", basic: false } });
  const ok = translateItem(s, L, g(["outcome:criticalFailure", "item:slug:x", "self:trait:metal"]), ctx);
  assert.equal(ok.confidence, "high");
  assert.deepEqual(ok.rule.onUse.challenge.byDegree.criticalFailure[0].when, ["target:trait:metal"]);
  assert.match(translateItem(s, L, g(["outcome:criticalFailure", "item:slug:x", "self:trait:metal", "target:trait:undead"]), ctx).reason, /predicate:self:trait:metal/);
});

test("0.5g1: triggerOnly — документ назван лишь условием правила чужой черты этой же группы", () => {
  const g = { ownSlugs: new Set(["mentor"]), rules: [{ predicate: ["origin:item:heroism", "feat:mentor"] }] };
  assert.equal(triggerOnly(g, { slug: "heroism" }, false), true);
  assert.equal(triggerOnly(g, { slug: "heroism" }, true), false);
  assert.equal(triggerOnly(g, { slug: "mentor" }, false), false);
  assert.equal(triggerOnly({ ...g, rules: [{ predicate: ["origin:item:heroism"] }] }, { slug: "heroism" }, false), false);
});

test("0.5c: эффект «X Immunity» PA у броска — challenge.immunity: slug из имени, срок из текста, степени из текста; нет срока и иммунитета в тексте — low; вне броска — долг", () => {
  const IMM = "Compendium.pf2e-automations.effects.Item.IMM0000000000001", c = { ...ctx, paEffects: { IMM0000000000001: { name: "Effect: Foo Immunity", kind: "immunity" } } };
  const g = (extra = {}) => ({ rules: [{ type: "base", triggerType: "saving-throw", target: "SelfEffect", value: IMM, predicate: ["item:slug:x"], ...extra }, { type: "base", triggerType: "saving-throw", target: "SelfEffect", value: EFF, predicate: ["item:slug:x", "outcome:failure"] }] });
  const s = sp({ defense: { save: "will", basic: false } });
  const ok = translateItem(s, `${L}<p><strong>Success</strong> unaffected and temporarily immune for 24 hours.</p>`, g(), c);
  assert.deepEqual([ok.rule.onUse.challenge.immunity.slug, ok.rule.onUse.challenge.immunity.duration], ["foo", { value: 24, unit: "hours" }]);
  assert.match(translateItem(s, L, g(), c).reason, /immunity-not-in-text/);
  assert.equal(translateItem(sp(), L, { rules: [{ type: "base", triggerType: "spell-cast", target: "SelfEffect", value: IMM, predicate: ["item:slug:x"] }] }, c).reason, "immunity-after-save");
});
