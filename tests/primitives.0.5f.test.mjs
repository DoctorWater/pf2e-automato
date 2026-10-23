// Подпачка 0.5f: шаг removeCondition, effect.badge:"increment", шаг rank {min,max}, check без vs (бросок системы, шаги на автора).
// Схема + форма туда-обратно + рантайм (apply.mjs, actions.mjs) + текст шага (chat.mjs) на фикстурах без Foundry.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const settings = {};
let msgs, uuids;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
globalThis.game = {
  user: { isActiveGM: true, id: "gm" },
  settings: { get: (_m, k) => settings[k] },
  i18n: { localize: (k) => k, format: (k) => k },
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } },
  pf2e: { ConditionManager: { conditions: new Map() } }
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
globalThis.ChatMessage = { create: async () => {}, getWhisperRecipients: () => [] };

const { MOD } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const { ruleToForm, formToRule } = await import("../scripts/sheet.mjs");
const { onRollMessage } = await import("../scripts/actions.mjs");
const { applyOps, applyEffect, removeCondition } = await import("../scripts/apply.mjs");
const { stepText, buildViewModel } = await import("../scripts/chat.mjs");

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));
const validate = rules.validateRule;
const back = (rule) => validate(formToRule(ruleToForm(rule)));
const EFF = "Compendium.pf2e.spell-effects.Item.RfCEHpMoEAZvB9IZ";

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.apply": "auto", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: true, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map();
});

test("removeCondition: схема, нормализация, ошибки", () => {
  const ok = validate({ v: 1, onUse: { targets: "self", apply: [{ removeCondition: { slug: "prone" } }] } });
  assert.deepEqual(ok.errors ?? [], []);
  assert.deepEqual(ok.rule.onUse.apply[0], { to: "self", removeCondition: { slug: "prone" } });
  for (const bad of [{ removeCondition: {} }, { removeCondition: { slug: "Prone!" } }, { removeCondition: { slug: "prone" }, effect: { uuid: EFF } }, { removeCondition: { slug: "prone" }, duration: { value: 1, unit: "rounds" } }]) {
    assert.equal(validate({ v: 1, onUse: { targets: "self", apply: [bad] } }).ok, false, JSON.stringify(bad));
  }
});

test("rank: границы min/max; пустое, обратное и вне 1..10 — ошибка", () => {
  const step = (rank) => validate({ v: 1, onUse: { targets: "self", apply: [{ effect: { uuid: EFF }, rank }] } });
  assert.deepEqual(step({ min: 3 }).rule.onUse.apply[0].rank, { min: 3 });
  assert.deepEqual(step({ max: 2 }).rule.onUse.apply[0].rank, { max: 2 });
  assert.deepEqual(step({ min: 2, max: 4 }).rule.onUse.apply[0].rank, { min: 2, max: 4 });
  for (const bad of [{}, { min: 5, max: 4 }, { min: 0 }, { max: 11 }, { min: 1.5 }, "3"]) assert.equal(step(bad).ok, false, JSON.stringify(bad));
});

test("effect.badge: только increment", () => {
  const eff = (e) => validate({ v: 1, onUse: { targets: "self", apply: [{ effect: e }] } });
  assert.deepEqual(eff({ uuid: EFF, badge: "increment" }).rule.onUse.apply[0].effect, { uuid: EFF, badge: "increment" });
  assert.deepEqual(eff({ uuid: EFF }).rule.onUse.apply[0].effect, { uuid: EFF });
  assert.equal(eff({ uuid: EFF, badge: "set" }).ok, false);
});

test("check без vs: нужен roll:system, targets:self, шаги по умолчанию на себя; иначе ошибки", () => {
  const mk = (over = {}, check = {}) => ({ v: 1, onUse: { targets: "self", check: { statistic: "athletics", roll: "system", byDegree: { criticalFailure: [{ condition: { slug: "prone" } }] }, ...check }, ...over } });
  const ok = validate(mk());
  assert.deepEqual(ok.errors ?? [], []);
  assert.equal(ok.rule.onUse.check.vs, undefined);
  assert.equal(ok.rule.onUse.check.byDegree.criticalFailure[0].to, "self");
  assert.equal(validate(mk({}, { roll: undefined })).ok, false);                                  // без роли системы
  assert.equal(validate(mk({ targets: "selected" })).ok, false);                                  // бросок без цели — только «на себя»
  assert.equal(validate(mk({}, { byDegree: { failure: [{ to: "target", condition: { slug: "prone" } }] } })).ok, false);
  assert.equal(validate(mk({}, { immunity: { slug: "x", duration: { value: 1, unit: "minutes" } } })).ok, false);
  // с vs «на себя» по-прежнему нельзя
  assert.equal(validate(mk({}, { vs: { defense: "will" } })).ok, false);
});

test("форма туда-обратно: removeCondition, rank, badge, check без vs", () => {
  const rs = [
    { v: 1, onUse: { targets: "self", apply: [{ removeCondition: { slug: "prone" }, rank: { min: 2 } }] } },
    { v: 1, onUse: { targets: "self", apply: [{ effect: { uuid: EFF, badge: "increment" } }, { effect: { uuid: EFF }, rank: { min: 2, max: 3 } }] } },
    { v: 1, onUse: { targets: "self", check: { statistic: "athletics", roll: "system", byDegree: { criticalFailure: [{ condition: { slug: "prone" } }], success: [{ removeCondition: { slug: "grabbed" } }] } } } },
    { v: 1, onUse: { targets: "selected", check: { statistic: ["athletics", "acrobatics"], vs: { defense: "reflex" }, byDegree: { success: [{ to: "target", removeCondition: { slug: "dying" } }] } } } }
  ];
  for (const raw of rs) {
    const rule = validate(raw).rule;
    assert.ok(rule, JSON.stringify(raw));
    const b = back(rule);
    assert.ok(b.ok, b.errors?.join("; "));
    assert.deepEqual(b.rule, rule);
  }
  const f = ruleToForm(validate(rs[2]).rule);
  assert.equal(f.ck.vsType, "none");
});

test("stepText: снять состояние, значок, круг", () => {
  const env = { t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k), conditionLabel: (s) => s, uuidName: () => "Bless" };
  assert.equal(stepText({ to: "self", removeCondition: { slug: "prone" } }, env, "self"), 'chat.stepRemoveSelf{"what":"prone"}');
  assert.match(stepText({ to: "target", effect: { uuid: EFF, badge: "increment" } }, env, "target"), /chat\.stepBadge/);
  assert.match(stepText({ to: "self", effect: { uuid: EFF }, rank: { min: 3 } }, env, "self"), /^\[chat\.stepRank\{"range":"3\+"\}\] /);
  assert.match(stepText({ to: "self", effect: { uuid: EFF }, rank: { min: 2, max: 4 } }, env, "self"), /2–4/);
});

/* ---------- рантайм ---------- */

const mkActor = (conds = [], effects = []) => {
  const a = {
    uuid: "Actor.hero", name: "Hero", level: 5, attributes: {}, removed: [],
    items: [], itemTypes: { condition: conds, effect: effects },
    async decreaseCondition(c, o) { const slug = c.slug ?? c; assert.equal(o.forceRemove, true); a.removed.push(slug); a.itemTypes.condition = a.itemTypes.condition.filter((c) => c.slug !== slug); }
  };
  return a;
};

test("removeCondition: снимает целиком и помнит значение; нет состояния — пропуск", async () => {
  const hero = mkActor([{ slug: "frightened", _source: { system: { value: { value: 2 } } } }]);
  assert.deepEqual(await removeCondition(hero, "frightened"), { op: "removed", slug: "frightened", prev: 2 });
  assert.deepEqual(hero.removed, ["frightened"]);
  assert.deepEqual(await removeCondition(hero, "frightened"), { op: "skipped" });
});

const mkMsg = (use, extra = {}) => {
  const m = { id: "M1", flags: { [MOD]: { use }, ...extra }, async update(d) { for (const [k, v] of Object.entries(d)) setDeep(m, k, v); } };
  msgs.set(m.id, m);
  return m;
};

test("applyOps: removeCondition снимает состояние и пишет op; rank вне границ пропускает шаг", async () => {
  const hero = mkActor([{ slug: "prone", _source: { system: { value: { value: null } } } }, { slug: "dying", _source: { system: { value: { value: 1 } } } }]);
  uuids.set("Actor.hero", hero);
  const steps = [
    { to: "self", removeCondition: { slug: "dying" }, rank: { min: 3 } },   // круг 2 — не подходит
    { to: "self", removeCondition: { slug: "prone" }, rank: { max: 2 } }
  ];
  const m = mkMsg({ kind: "use", actor: "Actor.hero", targets: [], state: {}, rule: { onUse: {} }, item: { uuid: null, name: "Тест" } }, { pf2e: { origin: { castRank: 2 } } });
  const ops = await applyOps(m, "self", steps, { scope: "apply" });
  assert.deepEqual(ops, [{ op: "removed", slug: "prone", actor: "Actor.hero" }]);
  assert.deepEqual(hero.removed, ["prone"]);
  assert.deepEqual(m.flags[MOD].use.state.apply.self.ops, ops);
});

test("applyEffect badge:increment: есть эффект — значок +1 без копии, повтор того же шага не добавляет; нет эффекта — создаёт", async () => {
  let raised = 0;
  const cur = {
    type: "effect", _stats: { compendiumSource: EFF }, flags: {}, system: { badge: { type: "counter", value: 1 } },
    async increase() { raised++; this.system.badge.value++; },
    async update(d) { for (const [k, v] of Object.entries(d)) setDeep(this, k, v); }
  };
  const hero = mkActor([], [cur]);
  const r = await applyEffect(hero, { uuid: EFF, badge: "increment" }, { key: "M1:self:0" }, {});
  assert.deepEqual([r.op, r.prev, r.key, raised, cur.system.badge.value], ["badged", 1, "M1:self:0", 1, 2]);
  assert.deepEqual(cur.flags[MOD].bumped, ["M1:self:0"]);
  assert.deepEqual(await applyEffect(hero, { uuid: EFF, badge: "increment" }, { key: "M1:self:0" }, {}), { op: "skipped" });
  assert.equal(raised, 1);
  cur.system.badge.max = 2;   // уже 2 из 2: прибавлять некуда
  assert.deepEqual(await applyEffect(hero, { uuid: EFF, badge: "increment" }, { key: "M1:self:9" }, {}), { op: "skipped" });
  assert.equal(raised, 1);
  // эффекта нет — идём обычным путём создания (fromUuid не находит эффект -> skipped, но не badged)
  const r2 = await applyEffect(mkActor([], []), { uuid: EFF, badge: "increment" }, { key: "M1:self:1" }, {});
  assert.equal(r2.op, "skipped");
});

/* ---------- check без vs: бросок действия, шаги на автора ---------- */

const mkRoll = (outcome, degree, id = "R1") => {
  const m = { ...rollMsg(outcome, degree), id, async update(d) { for (const [k, v] of Object.entries(d)) setDeep(m, k, v); } };
  msgs.set(id, m);
  return m;
};
const heroActor = () => mkActor([{ slug: "prone", _source: { system: { value: { value: null } } } }]);
const jumpRule = { v: 1, label: "Прыжок", onUse: { targets: "self", check: { statistic: "athletics", roll: "system", byDegree: { criticalFailure: [{ removeCondition: { slug: "prone" } }] } } } };
const rollMsg = (outcome, degree) => ({
  id: "R1", author: { id: "pl" }, rolls: [{ total: 8, dice: [{ results: [{ active: true, result: 3 }] }], degreeOfSuccess: degree }],
  flags: { pf2e: { context: { type: "skill-check", action: "high-jump", options: ["action:high-jump", "check:statistic:athletics"], origin: { actor: "Actor.hero", token: "Scene.s.Token.hero" }, target: null, dc: { value: 30 }, outcome, isReroll: false } } }
});

test("onRollMessage: check без vs — «цель» сам автор, результат по степени, шаг применяется на него", async () => {
  rules.initCatalog([{ v: 1, bySlug: { "high-jump": jumpRule } }], read("../rules/labels.json"));
  const hero = heroActor();
  uuids.set("Actor.hero", hero);
  uuids.set("Scene.s.Token.hero", { id: "hero", uuid: "Scene.s.Token.hero", name: "Hero", actor: hero });
  const m = mkRoll("criticalFailure", 0);
  await onRollMessage(m);
  const use = m.flags[MOD].use;
  assert.deepEqual(use.targets.map((t) => t.key), ["hero"]);
  assert.equal(use.state.challenge.results.hero.degree, 0);
  assert.deepEqual(hero.removed, ["prone"]);
  const vm = buildViewModel(m, { id: "gm", isGM: true }, { t: (k) => k, mode: (k) => settings[`mode.${k}`], now: 1, resumeMinutes: 30, groups: () => [], toolbelt: false, tokenName: () => "?", isOwner: () => false, isActorOwner: () => false, statLabel: (s) => s, conditionLabel: (s) => s, uuidName: () => null, checkDc: () => null, immune: () => false });
  assert.equal(vm.challenge.stat, "checks.headSelf");
  assert.equal(vm.challenge.rows[0].canRoll, false);
});

test("onRollMessage: check без vs — другая степень шага не запускает; без исхода (нет СЛ) — результата нет", async () => {
  rules.initCatalog([{ v: 1, bySlug: { "high-jump": jumpRule } }], read("../rules/labels.json"));
  const hero = heroActor();
  uuids.set("Actor.hero", hero);
  uuids.set("Scene.s.Token.hero", { id: "hero", uuid: "Scene.s.Token.hero", name: "Hero", actor: hero });
  const ok = mkRoll("success", 2);
  await onRollMessage(ok);
  assert.equal(ok.flags[MOD].use.state.challenge.results.hero.degree, 2);
  assert.deepEqual(hero.removed, []);
  const none = mkRoll(null, null, "R2");
  none.flags.pf2e.context.dc = null;
  await onRollMessage(none);
  assert.equal(none.flags[MOD].use.state.challenge, undefined);
});

/* ---------- перенос PA (tools/pa-port.mjs) ---------- */

const pa = await import("../tools/pa-port.mjs");
const PEFF = "Compendium.pf2e.spell-effects.Item.AAAAAAAAAAAAAAAA";
const pctx = { effects: { [PEFF]: "Spell Effect: X" }, condSlugs: new Set(["prone", "dying"]), condIds: { prone: "proneproneprone00" }, grants: {}, labels: {}, condSlugByUuid: () => null, condNames: [] };
const grp = (rules) => ({ rules: rules.map((r) => ({ type: "base", extend: null, range: null, ...r })) });
const spell = (extra = {}) => ({ type: "spell", slug: "x", name: "X", traits: [], range: "30 feet", ...extra });
const act = (extra = {}) => ({ type: "action", slug: "jump", name: "Jump", traits: [], actionType: "action", ...extra });

test("rankOf: gte/lge/gt/lt/lte по уровню предмета -> min/max; чужие сравнения и невозможные границы остаются условием", () => {
  const L = "origin:item:level";
  assert.deepEqual(pa.rankOf(["a", { gte: [L, 7] }]).rank, { min: 7 });
  assert.deepEqual(pa.rankOf([{ lge: [L, 2] }]).rank, { min: 2 });   // lge — опечатка PA
  assert.deepEqual(pa.rankOf([{ lt: [L, 5] }, { gt: [L, 1] }]).rank, { min: 2, max: 4 });
  assert.deepEqual(pa.rankOf([{ lte: [L, 3] }]).rank, { max: 3 });
  assert.deepEqual(pa.rankOf([{ lt: [L, 1] }]).rank, null);          // max 0: не бывает
  assert.deepEqual(pa.rankOf([{ eq: [L, 3] }]).rank, null);
  assert.deepEqual(pa.rankOf([{ or: [{ gte: [L, 3] }] }]).rank, null);   // внутри or — не переносим
  assert.deepEqual(pa.rankOf([{ gte: ["self:level", 3] }]).rank, null);
  assert.deepEqual(pa.rankOf(["a", { gte: [L, 7] }]).rest, ["a"]);
});

test("translateItem: RemoveCondition -> removeCondition; «target:condition:X» — не условие; IncreaseBadge+Effect -> один шаг badge", () => {
  const rm = pa.translateItem(spell(), "", grp([{ triggerType: "spell-cast", target: "TargetRemoveCondition", value: "dying", predicate: ["origin:item:x", "target:condition:dying"] }]), pctx);
  assert.equal(rm.confidence, "high");
  assert.deepEqual(rm.rule.onUse.apply, [{ to: "target", removeCondition: { slug: "dying" } }]);
  const bd = pa.translateItem(spell({ type: "action", actionType: "action" }), `@UUID[${PEFF}]`, grp([
    { triggerType: "spell-cast", target: "TargetEffect", value: PEFF, predicate: ["origin:item:x", { not: "target:effect:x" }] },
    { triggerType: "spell-cast", target: "TargetIncreaseBadgeEffect", value: PEFF, predicate: ["origin:item:x", "target:effect:x"] }]), pctx);
  assert.equal(bd.confidence, "high");
  assert.deepEqual(bd.rule.onUse.apply, [{ to: "target", effect: { uuid: PEFF, badge: "increment" } }]);
  const rk = pa.translateItem(spell(), "", grp([{ triggerType: "spell-cast", target: "TargetRemoveCondition", value: "dying", predicate: ["origin:item:x", { gte: ["origin:item:level", 3] }] }]), pctx);
  assert.deepEqual(rk.rule.onUse.apply[0].rank, { min: 3 });
});

test("translateItem: бросок действия без цели -> check без vs; чужой бросок — roll-of-other-action; нет броска в тексте — no-roll-in-doc", () => {
  const own = grp([{ triggerType: "skill-check", target: "SelfAddCondition", value: "prone", predicate: ["outcome:criticalFailure", { or: ["action:jump", "action:climb"] }] }]);
  const html = "<p>You attempt an [[/act jump]]{Athletics} check.</p> @UUID[Compendium.pf2e.conditionitems.Item.proneproneprone00]{Prone}";
  const r = pa.translateItem(act(), html, own, pctx);
  assert.deepEqual(r.rule.onUse.check, { statistic: "athletics", roll: "system", rollerRole: "author", byDegree: { criticalFailure: [{ to: "self", condition: { slug: "prone", policy: "max" } }] } });
  assert.equal(r.rule.onUse.targets, "self");
  const other = grp([{ triggerType: "skill-check", target: "TargetEffect", value: PEFF, predicate: ["feat:j", "action:demoralize", "outcome:success"] }]);
  assert.match(pa.translateItem(act({ slug: "j" }), `[[/act demoralize]]{Intimidation} @UUID[${PEFF}]`, other, pctx).reason, /roll-of-other-action|event-carrier/);   // чужой бросок: 0.5g3 ведёт его событием (event-carrier), если нет владельца
  const save = grp([{ triggerType: "saving-throw", target: "SelfAddCondition", value: "prone", predicate: ["outcome:failure", "item:slug:jump"] }]);
  assert.equal(pa.translateItem(act(), "<p>It is permanently slowed.</p>", save, pctx).reason, "no-roll-in-doc");
  assert.equal(pa.translateItem(act(), "<p>Make a Will save.</p>", save, pctx).reason, "no-save-def");
  assert.equal(pa.subpackOf(["roll-of-other-action"]), "0.5g");
});

test("sample --subpack 0.5f: только правила с примитивами 0.5f", async () => {
  const { usesPrimitive05f } = await import("../tools/sample.mjs");
  const mk = (u) => ({ onUse: { targets: "self", apply: [], ...u } });
  assert.equal(usesPrimitive05f(mk({ apply: [{ to: "self", removeCondition: { slug: "prone" } }] })), true);
  assert.equal(usesPrimitive05f(mk({ apply: [{ to: "self", effect: { uuid: PEFF, badge: "increment" } }] })), true);
  assert.equal(usesPrimitive05f(mk({ apply: [{ to: "self", effect: { uuid: PEFF }, rank: { min: 2 } }] })), true);
  assert.equal(usesPrimitive05f(mk({ check: { statistic: "athletics", roll: "system", byDegree: {} } })), true);
  assert.equal(usesPrimitive05f(mk({ apply: [{ to: "self", effect: { uuid: PEFF } }] })), false);
  assert.equal(usesPrimitive05f(mk({ check: { statistic: "athletics", vs: { defense: "ac" }, byDegree: {} } })), false);
});

test("Мастерская: плашки шагов (снять состояние, круг, значок) и сводка проверки без цели", async () => {
  const au = await import("../scripts/workshop/automation.mjs");
  const env = { t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k), conditionLabel: (s) => s, uuidName: () => "Бла", statLabel: (s) => s, dc: null, area: { shape: "burst", size: 20 } };
  const f = ruleToForm(validate({ v: 1, onUse: { targets: "self", check: { statistic: "athletics", roll: "system", byDegree: { criticalFailure: [{ removeCondition: { slug: "prone" }, rank: { min: 2 } }], success: [{ effect: { uuid: EFF, badge: "increment" } }] } } } }).rule);
  const p = au.plate(f.ck.deg.criticalFailure[0], env);
  assert.deepEqual([p.kind, p.name, p.note], ["remove", 'workshop.au.removePlate{"name":"prone"}', 'workshop.au.keep.rank{"range":"2+"}']);
  assert.match(au.plate(f.ck.deg.success[0], env).note, /keep\.stack/);
  const s = au.summaries(f, env);
  assert.match(s.roll, /roll\.checkSelf/);
  assert.match(au.story(f, env).text, /story\.checkSelf/);
  assert.deepEqual(au.tokenOdds(validate({ v: 1, onUse: { targets: "self", check: { statistic: "athletics", roll: "system", byDegree: { success: [{ note: "x" }] } } } }).rule, [{ name: "T", actor: {} }], env)[0].problems, []);
});

/* ---------- правки по замечаниям Критика ---------- */

const mkCondActor = ({ hp = 0, conds = [] } = {}) => {
  let n = 0;
  const a = {
    uuid: "Actor.c", name: "C", hitPoints: { value: hp }, items: [], itemTypes: { condition: conds.map((c, i) => ({ id: `c${i}`, ...c })), effect: [] },
    async decreaseCondition(s) { const slug = s.slug ?? s; a.itemTypes.condition = a.itemTypes.condition.filter((c) => c.slug !== slug); },
    async createEmbeddedDocuments(_t, [d]) { const it = { id: `n${n++}`, slug: d.slug, _source: d, system: d.system }; a.itemTypes.condition.push(it); return [it]; }
  };
  game.pf2e.ConditionManager = {
    getCondition: (slug) => ({ slug, name: slug, toObject: () => ({ slug, system: { value: { isValued: slug === "wounded", value: 1 } }, flags: {} }) }),
    async updateConditionValue(id, actor, v) { const c = actor.itemTypes.condition.find((x) => x.id === id); c._source = { system: { value: { value: v } } }; c.system = { value: { value: v } }; }
  };
  return a;
};
const val = (v) => ({ _source: { system: { value: { value: v } } }, system: { value: { value: v } } });

test("removeCondition dying: Раненый +1 и при 0 ОЗ Без сознания; откат возвращает и то и другое", async () => {
  const a = mkCondActor({ hp: 0, conds: [{ slug: "dying", ...val(1) }] });
  uuids.set("Actor.c", a);
  const m = mkMsg({ kind: "use", actor: "Actor.c", targets: [], state: {}, rule: { onUse: {} }, item: { uuid: null, name: "Стабилизация" } });
  const ops = await applyOps(m, "self", [{ to: "self", removeCondition: { slug: "dying" } }], { scope: "apply" });
  assert.deepEqual(a.itemTypes.condition.map((c) => c.slug).sort(), ["unconscious", "wounded"]);
  assert.deepEqual(ops[0].also, [{ slug: "unconscious", prev: null }, { slug: "wounded", prev: null }]);
  const { undoOps } = await import("../scripts/apply.mjs");
  await undoOps(m, "self");
  assert.deepEqual(a.itemTypes.condition.map((c) => c.slug), ["dying"]);
});

test("removeCondition dying: ОЗ больше 0 — без Без сознания; уже есть Раненый 1 — станет 2, откат вернёт 1", async () => {
  const a = mkCondActor({ hp: 5, conds: [{ slug: "dying", ...val(1) }, { slug: "wounded", ...val(1) }] });
  uuids.set("Actor.c", a);
  const m = mkMsg({ kind: "use", actor: "Actor.c", targets: [], state: {}, rule: { onUse: {} }, item: { uuid: null, name: "S" } });
  const ops = await applyOps(m, "self", [{ to: "self", removeCondition: { slug: "dying" } }], { scope: "apply" });
  const w = () => a.itemTypes.condition.find((c) => c.slug === "wounded");
  assert.equal(w()._source.system.value.value, 2);
  assert.deepEqual(ops[0].also, [{ slug: "wounded", prev: 1 }]);
  const { undoOps } = await import("../scripts/apply.mjs");
  await undoOps(m, "self");
  assert.equal(w()._source.system.value.value, 1);
  assert.deepEqual(a.itemTypes.condition.map((c) => c.slug).sort(), ["dying", "wounded"]);
});

test("removeCondition: выданное и заблокированное состояние не трогаем; не удалилось — skipped", async () => {
  const a = mkCondActor({ conds: [{ slug: "prone", grantedBy: {}, ...val(null) }, { slug: "grabbed", isLocked: true, ...val(null) }] });
  assert.deepEqual(await removeCondition(a, "prone"), { op: "skipped" });
  assert.deepEqual(await removeCondition(a, "grabbed"), { op: "skipped" });
  const stuck = mkCondActor({ conds: [{ slug: "prone", ...val(null) }] });
  stuck.decreaseCondition = async () => {};
  assert.deepEqual(await removeCondition(stuck, "prone"), { op: "skipped" });
});

test("значок: повтор шага, создавшего эффект, не прибавляет; by:2 до максимума; откат badged возвращает значение и ключ", async () => {
  const cur = {
    id: "e1", type: "effect", _stats: { compendiumSource: EFF }, flags: { [MOD]: { meta: { key: "M1:target:0" } } }, system: { badge: { type: "counter", value: 2, max: 4 } },
    async increase() { this.system.badge.value++; },
    async update(d) { for (const [k, v] of Object.entries(d)) setDeep(this, k, v); }
  };
  const a = mkActor([], [cur]);
  a.items = [cur];
  assert.deepEqual(await applyEffect(a, { uuid: EFF, badge: "increment", by: 2 }, { key: "M1:target:0" }, {}), { op: "skipped" });   // свой же ключ
  assert.equal(cur.system.badge.value, 2);
  const r = await applyEffect(a, { uuid: EFF, badge: "increment", by: 2 }, { key: "M2:target:0" }, {});
  assert.deepEqual([r.op, r.prev, cur.system.badge.value], ["badged", 2, 4]);
  // откат
  uuids.set("Actor.hero", a); uuids.set("E1", Object.assign(cur, { actor: a }));
  const m = mkMsg({ kind: "use", actor: "Actor.hero", targets: [], state: { apply: { self: { ops: [{ op: "badged", item: "E1", prev: 2, key: "M2:target:0" }] } } }, rule: { onUse: {} }, item: { uuid: null, name: "K" } });
  m.update = async function (d) { for (const [k, v] of Object.entries(d)) { if (k.includes("-=")) continue; setDeep(this, k, v); } };
  cur.flags[MOD].bumped = ["M2:target:0"];
  const { undoOps } = await import("../scripts/apply.mjs");
  await undoOps(m, "self");
  assert.deepEqual([cur.system.badge.value, cur.flags[MOD].bumped], [2, []]);
});

test("валидатор: effect.by только с badge, 1..10", () => {
  const e = (x) => validate({ v: 1, onUse: { targets: "self", apply: [{ effect: { uuid: EFF, ...x } }] } });
  assert.deepEqual(e({ badge: "increment", by: 2 }).rule.onUse.apply[0].effect, { uuid: EFF, badge: "increment", by: 2 });
  assert.equal(e({ by: 2 }).ok, false);
  assert.equal(e({ badge: "increment", by: 0 }).ok, false);
  const b = back(e({ badge: "increment", by: 2 }).rule);
  assert.deepEqual(b.rule.onUse.apply[0].effect.by, 2);
});

test("перенос PA: одинаковые шаги с rank, покрывающие 1..10, схлопываются; Heightened «targets/touch» -> цель; lge помечен beyond-pa", () => {
  const e = (rank) => ({ to: "self", effect: { uuid: EFF }, ...(rank && { rank }) });
  assert.deepEqual(pa.mergeRanks([e({ max: 6 }), e({ min: 7 })]), [e()]);
  assert.equal(pa.mergeRanks([e({ max: 2 }), e({ min: 4 })]).length, 2);
  const H = "<p>Heightened (3rd) The spell's range is touch and it targets 1 willing creature. Heightened (5th) The duration is longer.</p>";
  assert.deepEqual([pa.heightenedTargets(H, 3), pa.heightenedTargets(H, 2), pa.heightenedTargets("<p>Heightened (4th) Add Fish Tail</p>", 4)], [true, false, false]);
  const g = (rules) => ({ rules: rules.map((r) => ({ type: "base", triggerType: "spell-cast", target: "SelfOrTargetEffect", value: PEFF, ...r })) });
  const r = pa.translateItem(spell({ range: null, target: null }), `@UUID[${PEFF}] ${H}`, g([{ predicate: ["origin:item:x", { lt: ["origin:item:level", 3] }] }, { predicate: ["origin:item:x", { lge: ["origin:item:level", 3] }] }]), pctx);
  assert.deepEqual(r.rule.onUse.apply.map((a) => [a.to, a.rank]), [["self", { max: 2 }], ["target", { min: 3 }]]);
  assert.match(r.reason, /beyond-pa: lge/);
});

test("effect.start: значок нового эффекта; валидатор, форма, создание", async () => {
  const e = (x) => validate({ v: 1, onUse: { targets: "self", apply: [{ effect: { uuid: EFF, ...x } }] } });
  assert.deepEqual(e({ badge: "increment", by: 2, start: 2 }).rule.onUse.apply[0].effect, { uuid: EFF, badge: "increment", by: 2, start: 2 });
  assert.equal(e({ start: 2 }).ok, false);
  assert.equal(e({ badge: "increment", start: 11 }).ok, false);
  const r = e({ badge: "increment", by: 2, start: 2 }).rule;
  assert.deepEqual(back(r).rule, r);
  // создание: у источника значок 1 -> 2
  const src = { type: "effect", toObject: () => ({ _id: "x", name: "E", type: "effect", _stats: {}, system: { badge: { type: "counter", value: 1, max: 4 }, level: { value: 1 }, rules: [] }, flags: {} }) };
  uuids.set(EFF, src);
  globalThis.CONFIG = { PF2E: { Item: { documentClasses: { effect: { validTraits: {} } } } } };
  globalThis.foundry.utils.mergeObject = (a, b) => ({ ...a, ...b });
  let made;
  const a = { uuid: "Actor.s", items: [], itemTypes: { effect: [], condition: [] }, getActiveTokens: () => [], async createEmbeddedDocuments(_t, [d]) { made = d; return [{ uuid: "I" }]; } };
  await applyEffect(a, { uuid: EFF, badge: "increment", by: 2, start: 2 }, { key: "K" }, {});
  assert.equal(made.system.badge.value, 2);
});

test("перенос PA: Кража тени — значок и шаг из текста копии; крит. другое число — low", () => {
  const SS = "Compendium.pf2e-automato.effects.Item.sBB3VElfaqa9ZYyL";
  const c = { ...pctx, effects: { [SS]: "Effect: Steal Shadow" }, paEffects: { sBB3VElfaqa9ZYyL: { kind: "own" } } };
  const rules = [{ type: "base", triggerType: "postInfo", extend: null, range: null, target: "TargetIncreaseBadgeEffect", value: "Compendium.pf2e-automations.effects.Item.sBB3VElfaqa9ZYyL", predicate: ["origin:item:jump"] }];
  const L = (t) => `<p>@UUID[${SS}]{E} pulls ${t}</p>`;
  const r2 = pa.translateItem(act(), L("{Enfeebled 2}."), { rules }, c);
  assert.deepEqual(r2.rule.onUse.apply[0].effect, { uuid: SS, badge: "increment", by: 2, start: 2 });
  assert.equal(r2.confidence, "high");
  const r1 = pa.translateItem(act(), L("{Enfeebled 1}."), { rules }, c);
  assert.deepEqual(r1.rule.onUse.apply[0].effect, { uuid: SS, badge: "increment" });
  assert.match(pa.translateItem(act(), L("{Enfeebled 2} (or {Enfeebled 3} on a critical hit)."), { rules }, c).reason, /badge-crit/);
});
