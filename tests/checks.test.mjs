// onUse.check: валидация, СЛ защиты, иммунитет, блок чата, бросок автора и приём результата (заглушки глобалов Foundry).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MOD } from "../scripts/util.mjs";
import { validateRule } from "../scripts/rules.mjs";
import { defenseDc, dcSlug, pickStatistic, hasImmunity, runCheck, rollCheck, applyImmunity } from "../scripts/checks.mjs";
import { acceptSavingThrow } from "../scripts/saves.mjs";
import { buildViewModel } from "../scripts/chat.mjs";

const demoralize = {
  v: 1, label: "Demoralize",
  onUse: { targets: "selected", check: {
    statistic: "intimidation", vs: { defense: "will" }, traits: ["auditory", "emotion", "mental"],
    immunity: { slug: "demoralize", duration: { value: 10, unit: "minutes" } },
    byDegree: { criticalSuccess: [{ condition: { slug: "frightened", value: 2 } }], success: [{ condition: { slug: "frightened", value: 1 } }] }
  } }
};
const withCheck = (c) => ({ v: 1, onUse: { targets: "selected", check: c } });

/* ---------- валидация ---------- */

test("validateRule: Demoralize / Trip / Treat Wounds нормализуются", () => {
  const r = validateRule(demoralize);
  assert.ok(r.ok, r.errors.join());
  const ck = r.rule.onUse.check;
  assert.equal(ck.rollerRole, "author");
  assert.deepEqual(ck.vs, { defense: "will" });
  assert.equal(ck.byDegree.success[0].to, "target");
  assert.equal(r.rule.onUse.challenge, null);

  const trip = validateRule(withCheck({ statistic: "athletics", vs: { defense: "reflex" }, mapIncreases: 1, byDegree: {
    criticalSuccess: [{ condition: { slug: "prone" } }, { note: "1d6" }], success: [{ condition: { slug: "prone" } }], criticalFailure: [{ to: "self", condition: { slug: "prone" } }] } }));
  assert.ok(trip.ok, trip.errors.join());
  assert.equal(trip.rule.onUse.check.byDegree.criticalFailure[0].to, "self");
  assert.equal(trip.rule.onUse.check.mapIncreases, 1);

  const tw = validateRule(withCheck({ statistic: ["medicine"], vs: { dc: 20 }, immunity: { slug: "treat-wounds", uuid: "Compendium.pf2e.feat-effects.Item.Lb4q2bBAgxamtix5" } }));
  assert.ok(tw.ok, tw.errors.join());
  assert.deepEqual(tw.rule.onUse.check.vs, { dc: 20 });
});

test("validateRule: ошибки check", () => {
  const bad = (c, frag, onUse = {}) => {
    const r = validateRule({ v: 1, onUse: { targets: "selected", check: c, ...onUse } });
    assert.equal(r.ok, false, frag);
    assert.ok(r.errors.some((e) => e.key === frag), `${frag}: ${r.errors.join("; ")}`);
  };
  bad({ statistic: "Athletics!", vs: { defense: "will" } }, "chk.stat");
  bad({ statistic: "athletics" }, "chk.vsNone");
  bad({ statistic: "athletics", vs: { defense: "will", dc: 5 } }, "chk.vsMany");
  bad({ statistic: "athletics", vs: { defense: "speed" } }, "chk.defense");
  bad({ statistic: "athletics", vs: { defense: "ac" }, mapIncreases: 3 }, "chk.map");
  bad({ statistic: "athletics", vs: { defense: "ac" }, immunity: { slug: "x" } }, "imm.empty");
  bad({ statistic: "athletics", vs: { defense: "ac" }, byDegree: { win: [] } }, "degrees.unknown");
  bad({ statistic: "athletics", vs: { defense: "ac" } }, "use.both", { challenge: { statistic: "will", dc: { value: 1 } } });
  bad({ statistic: "athletics", vs: { defense: "ac" } }, "use.checkSelf", { targets: "self" });
});

/* ---------- СЛ защиты, статистика, иммунитет ---------- */

const dcOf = (v) => ({ dc: { value: v } });
const target = { armorClass: { value: 18 }, perception: dcOf(21), saves: { reflex: dcOf(17), will: dcOf(19) }, getStatistic: (s) => (s === "athletics" ? dcOf(23) : null) };

test("defenseDc: КБ / спасбросок / Восприятие / фикс / against; нет актёра", () => {
  assert.equal(defenseDc(target, { defense: "ac" }), 18);
  assert.equal(defenseDc(target, { defense: "reflex" }), 17);
  assert.equal(defenseDc(target, { defense: "perception" }), 21);
  assert.equal(defenseDc(target, { against: "athletics" }), 23);
  assert.equal(defenseDc(target, { against: "perception" }), 21);
  assert.equal(defenseDc(null, { dc: 15 }), 15);
  assert.equal(defenseDc(null, { defense: "will" }), null);
  assert.equal(defenseDc({ saves: {} }, { defense: "will" }), null);
});

test("dcSlug: ac -> armor, фикс -> null", () => {
  assert.deepEqual([{ defense: "ac" }, { defense: "will" }, { against: "athletics" }, { dc: 9 }].map(dcSlug), ["armor", "will", "athletics", null]);
});

test("pickStatistic: slug, список — с большим модификатором, нет — null", () => {
  const actor = { perception: { id: "per" }, getStatistic: (s) => ({ athletics: { id: "ath", check: { mod: 7 } }, acrobatics: { id: "acr", check: { mod: 9 } } })[s] ?? null };
  assert.equal(pickStatistic(actor, "athletics").id, "ath");
  assert.equal(pickStatistic(actor, ["athletics", "acrobatics"]).id, "acr");
  assert.equal(pickStatistic(actor, "perception").id, "per");
  assert.equal(pickStatistic(actor, "medicine"), null);
});

test("hasImmunity: тот же автор + (источник | наш slug); чужой автор / иной slug — нет", () => {
  const eff = (origin, extra) => ({ type: "effect", system: { context: { origin: { actor: origin } } }, _stats: {}, flags: {}, ...extra });
  const mk = (...items) => ({ items });
  const imm = { slug: "demoralize" }, byUuid = { slug: "tw", uuid: "Compendium.x" };
  assert.equal(hasImmunity(mk(eff("A", { flags: { [MOD]: { immunity: { slug: "demoralize" } } } })), imm, "A"), true);
  assert.equal(hasImmunity(mk(eff("B", { flags: { [MOD]: { immunity: { slug: "demoralize" } } } })), imm, "A"), false);
  assert.equal(hasImmunity(mk(eff("A", { flags: { [MOD]: { immunity: { slug: "other" } } } })), imm, "A"), false);
  assert.equal(hasImmunity(mk(eff("A", { _stats: { compendiumSource: "Compendium.x" } })), byUuid, "A"), true);
  assert.equal(hasImmunity(mk(), imm, "A"), false);
  assert.equal(hasImmunity(mk(eff("A")), null, "A"), false);
});

/* ---------- блок чата ---------- */

const mkEnv = (over = {}) => ({
  t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k), mode: () => "auto", now: 1, resumeMinutes: 30, groups: () => [], toolbelt: false,
  tokenName: (k) => `tok-${k}`, isOwner: () => false, isActorOwner: (uuid, user) => user.owns?.includes(uuid) ?? false,
  statLabel: (s) => s, conditionLabel: (s) => s, uuidName: () => null,
  checkDc: (k) => ({ a: 19, b: null })[k], immune: (k) => k === "b", ...over
});
const rule = validateRule(demoralize).rule;
const mkMsg = (state = {}) => ({ id: "m1", author: { id: "ua" }, flags: { [MOD]: { use: {
  v: 1, kind: "use", confidence: "high", rule, createdAt: 1, actor: "Actor.o", item: { name: "Demoralize" }, state,
  targets: [{ key: "a", name: "Orc" }, { key: "b", name: "Bob" }] } } } });
const gm = { id: "gm", isGM: true }, author = { id: "ua", isGM: false, owns: ["Actor.o"] }, other = { id: "x", isGM: false };

test("чат check: заголовок, СЛ цели, иммунная цель без кнопки, роли", () => {
  const vm = buildViewModel(mkMsg(), gm, mkEnv());
  assert.match(vm.challenge.stat, /checks\.head/);
  assert.match(vm.challenge.stat, /intimidation/);
  assert.equal(vm.challenge.dcUnknown, null);
  assert.equal(vm.challenge.canSetDC, false);
  const [a, b] = vm.challenge.rows;
  assert.match(a.dc, /chat\.dc.*19/);
  assert.equal(a.canRoll, true);
  assert.equal(b.label, "checks.immune");
  assert.equal(b.canRoll, false);
  assert.equal(buildViewModel(mkMsg(), author, mkEnv()).challenge.rows[0].canRoll, true);
  assert.equal(buildViewModel(mkMsg(), other, mkEnv()).challenge.rows[0].canRoll, false);
});

test("чат check: результат -> степень, СЛ из результата, план + иммунитет, кнопка Применить даже при пустом плане", () => {
  const r = { degree: 3, total: 30, dc: 19 };
  const btn = mkEnv({ mode: () => "button" });
  const vm = buildViewModel(mkMsg({ challenge: { results: { a: r } } }), gm, btn);
  const row = vm.challenge.rows[0];
  assert.equal(buildViewModel(mkMsg({ challenge: { results: { a: r } } }), gm, mkEnv()).challenge.rows[0].canApply, false);   // apply=auto: модуль применяет сам — кнопки нет
  const auto = mkEnv({ mode: () => "auto" });
  assert.equal(buildViewModel(mkMsg({ challenge: { results: { a: r }, autoTried: { a: true } } }), gm, auto).challenge.rows[0].canApply, true);   // попытка была, не применено -> кнопка
  assert.equal(row.degree, "criticalSuccess");
  assert.match(row.dc, /19/);
  assert.equal(row.plan.length, 2);
  assert.match(row.plan[0], /frightened/);
  assert.match(row.plan[1], /immunityPlan/);
  assert.equal(row.canApply, true);
  const noSteps = buildViewModel(mkMsg({ challenge: { results: { a: { degree: 0, total: 3, dc: 19 } } } }), gm, btn).challenge.rows[0];
  assert.equal(noSteps.canApply, true);   // иммунитет применяется при любой степени
});

test("чат check: «Бросить» по автору — автор-PC бросает сам, автор-NPC бросает модуль (кнопка после сбоя)", () => {
  const roll = (env, user, state) => buildViewModel(mkMsg(state), user, mkEnv(env)).challenge.rows[0].canRoll;
  assert.equal(roll({ isActorPc: () => true }, author), true);   // игрок -> NPC: модуль не бросает, кнопка у автора
  assert.equal(roll({ isActorPc: () => true }, gm), true);
  assert.equal(roll({ isActorPc: () => false }, gm), false);     // автор-NPC: модуль бросит сам
  assert.equal(roll({ isActorPc: () => false }, gm, { challenge: { rollTried: { a: true } } }), true);
});

test("чат check: нет целей -> подсказка", () => {
  const m = mkMsg(); m.flags[MOD].use.targets = [];
  assert.equal(buildViewModel(m, gm, mkEnv()).challenge.toolbelt, "checks.noTargets");
});

/* ---------- бросок автора и приём ---------- */

const settings = {};
let msgs, uuids, rolls, notes;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
const mkRealMsg = (id, use) => { const m = { id, flags: { [MOD]: { use } }, async update(d) { for (const [k, v] of Object.entries(d)) setDeep(m, k, v); } }; msgs.set(id, m); return m; };
const useFor = (over = {}) => ({
  v: 1, kind: "use", confidence: "high", rule, createdAt: Date.now(), actor: "Actor.o", item: { uuid: "Item.dem", name: "Demoralize" },
  targets: [{ key: "t1", uuid: "tok.t1" }], state: {}, ...over
});
const mkTarget = (items = []) => ({ id: "t1", uuid: "tok.t1", name: "Orc", actor: { name: "Orc", uuid: "Actor.orc", items, saves: { will: dcOf(19) } } });

beforeEach(() => {
  Object.assign(settings, { "mode.macro": "auto", "mode.apply": "button", "mode.challenge": "auto", useToolbeltTargetHelper: false, resumeMinutes: 30, "challenge.messageMode": "gmroll" });
  msgs = new Map(); rolls = []; notes = [];
  const authorActor = { uuid: "Actor.o", name: "Hero", hasPlayerOwner: false, getActiveTokens: () => [],
    getStatistic: (s) => s === "intimidation" ? { check: { roll: async (p) => { rolls.push(p); p.callback?.(null, null, { id: "rm1" }); return { degreeOfSuccess: 2, total: 25, dice: [] }; } } } : null };
  uuids = new Map([["Actor.o", authorActor], ["tok.t1", mkTarget()], ["Item.dem", { name: "Demoralize" }]]);
  globalThis.game = {
    user: { isActiveGM: true, id: "gm" },
    settings: { get: (_m, k) => settings[k] },
    i18n: { localize: (k) => k, format: (k) => k },
    messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } }
  };
  globalThis.ui = { notifications: { warn: (m) => notes.push(["warn", m]), info: (m) => notes.push(["info", m]) } };
  globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
  globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
});
afterEach(() => { for (const k of ["game", "ui", "fromUuid", "fromUuidSync"]) delete globalThis[k]; });

test("runCheck: автор-NPC бросает по СЛ защиты цели с маркером, результат записан со степенью и СЛ", async () => {
  const m = mkRealMsg("M1", useFor());
  const done = await runCheck(m);
  assert.deepEqual(done, ["t1"]);
  assert.equal(rolls.length, 1);
  assert.deepEqual(rolls[0].dc, { value: 19, slug: "will" });
  assert.equal(rolls[0].target, uuids.get("tok.t1").actor);
  assert.ok(rolls[0].extraRollOptions.includes(`${MOD}:M1:t1`));
  assert.equal(rolls[0].skipDialog, true);
  const res = m.flags[MOD].use.state.challenge.results.t1;
  assert.equal(res.degree, 2); assert.equal(res.total, 25); assert.equal(res.dc, 19);
  assert.deepEqual(await runCheck(m), []);   // повтор — без второго броска
  assert.equal(rolls.length, 1);
});

test("runCheck: иммунная цель — броска нет; PC-автор без кнопки не бросает, с кнопкой (only) — бросает", async () => {
  const imm = { type: "effect", system: { context: { origin: { actor: "Actor.o" } } }, _stats: {}, flags: { [MOD]: { immunity: { slug: "demoralize" } } } };
  uuids.set("tok.t1", mkTarget([imm]));
  assert.deepEqual(await runCheck(mkRealMsg("M2", useFor())), []);
  assert.equal(rolls.length, 0);
  uuids.set("tok.t1", mkTarget());
  uuids.get("Actor.o").hasPlayerOwner = true;
  const m = mkRealMsg("M3", useFor());
  assert.deepEqual(await runCheck(m), []);
  assert.deepEqual(await runCheck(m, { only: "t1" }), ["t1"]);
});

test("rollCheck: MAP -> attackNumber; нет СЛ / статистики — null с предупреждением", async () => {
  const m = mkRealMsg("M4", useFor());
  const authorActor = uuids.get("Actor.o");
  await rollCheck(authorActor, { ...rule.onUse.check, mapIncreases: 2 }, { message: m, tokenKey: "t1", target: mkTarget() });
  assert.equal(rolls[0].attackNumber, 3);
  assert.equal(await rollCheck(authorActor, rule.onUse.check, { message: m, tokenKey: "t1", target: { name: "X", actor: { name: "X", items: [], saves: {} } } }), null);
  assert.equal(await rollCheck(authorActor, { ...rule.onUse.check, statistic: "medicine" }, { message: m, tokenKey: "t1", target: mkTarget() }), null);
  assert.equal(notes.filter((n) => n[0] === "warn").length, 2);
});

test("acceptSavingThrow: skill-check автора — по маркеру и по origin + токену цели", async () => {
  const m = mkRealMsg("M5", useFor());
  const viaMarker = { id: "r1", author: { id: "ua" }, rolls: [{ total: 22, degreeOfSuccess: 3, dice: [] }],
    flags: { pf2e: { context: { type: "skill-check", options: [`${MOD}:M5:t1`], dc: { value: 19 } } } } };
  assert.equal((await acceptSavingThrow(viaMarker)).ok, true);
  assert.equal(m.flags[MOD].use.state.challenge.results.t1.degree, 3);
  assert.equal(m.flags[MOD].use.state.challenge.results.t1.dc, 19);

  const m2 = mkRealMsg("M6", useFor());
  const byOrigin = { id: "r2", author: { id: "ua" }, rolls: [{ total: 12, degreeOfSuccess: 1, dice: [] }],
    flags: { pf2e: { origin: { uuid: "Item.dem" }, context: { type: "skill-check", actor: "o", options: ["check:statistic:intimidation"], target: { actor: "Actor.orc", token: "tok.t1" } } } } };
  assert.equal((await acceptSavingThrow(byOrigin)).ok, true);
  assert.equal(m2.flags[MOD].use.state.challenge.results.t1.degree, 1);
});

test("applyImmunity: эффект на цель с флагом/автором, ops в applied; повтор и существующий иммунитет — пусто", async () => {
  const created = [];
  const tgt = mkTarget();
  tgt.actor.items = [];
  tgt.actor.createEmbeddedDocuments = async (_t, [d]) => { const it = { ...d, type: "effect", uuid: "Actor.orc.Item.e1", system: d.system, flags: d.flags, _stats: {} }; tgt.actor.items.push(it); created.push(d); return [it]; };
  uuids.set("tok.t1", tgt);
  globalThis.foundry = { utils: {
    mergeObject: (a, b) => { const out = structuredClone(a); out.flags = { ...out.flags, [MOD]: { ...out.flags?.[MOD], ...b.flags[MOD] } }; return out; },
    getProperty: (o, path) => path.split(".").reduce((x, k) => x?.[k], o)
  } };
  try {
    const m = mkRealMsg("M7", useFor());
    const imm = rule.onUse.check.immunity;
    const ops = await applyImmunity(m, "t1", tgt, imm, 2);
    assert.equal(ops.length, 1);
    assert.equal(created[0].flags[MOD].immunity.slug, "demoralize");
    assert.equal(created[0].system.slug, "demoralize-immunity");   // roll option effect:<slug>-immunity для предикатов (Bane)
    assert.equal(created[0].system.context.origin.actor, "Actor.o");
    assert.deepEqual(created[0].system.duration, { sustained: false, value: 10, unit: "minutes", expiry: "turn-start" });
    assert.equal(m.flags[MOD].use.state.challenge.applied.t1.ops.length, 1);
    assert.equal(m.flags[MOD].use.state.challenge.applied.t1.degree, 2);
    assert.deepEqual(await applyImmunity(m, "t1", tgt, imm, 2), []);   // иммунитет уже есть
  } finally { delete globalThis.foundry; }
});

test("rollCheck: askMap у атакующего манёвра спрашивает MAP у автора (отмена -> без броска); без askMap/без trait attack — не спрашивает", async () => {
  const trip = validateRule(withCheck({ statistic: "intimidation", vs: { defense: "will" }, traits: ["attack"] })).rule.onUse.check;
  const m = mkRealMsg("M8", useFor({ rule: validateRule({ v: 1, onUse: { targets: "selected", check: { statistic: "intimidation", vs: { defense: "will" }, traits: ["attack"] } } }).rule }));
  const authorActor = uuids.get("Actor.o");
  let asked = 0, answer = "2";
  globalThis.foundry = { applications: { api: { DialogV2: { wait: async () => { asked++; return answer == null ? null : { action: answer }; } } } } };
  try {
    await rollCheck(authorActor, trip, { message: m, tokenKey: "t1", target: mkTarget(), askMap: true });
    assert.equal(rolls[0].attackNumber, 3); assert.equal(asked, 1);
    answer = null;
    assert.equal(await rollCheck(authorActor, trip, { message: m, tokenKey: "t1", target: mkTarget(), askMap: true }), null);
    assert.equal(rolls.length, 1);
    await rollCheck(authorActor, trip, { message: m, tokenKey: "t1", target: mkTarget() });   // авто-бросок ГМа: без вопроса
    await rollCheck(authorActor, rule.onUse.check, { message: m, tokenKey: "t1", target: mkTarget(), askMap: true });   // нет trait attack
    assert.equal(asked, 2); assert.equal(rolls.length, 3);
    assert.equal(rolls[1].attackNumber, undefined);
  } finally { delete globalThis.foundry; }
});

test("runCheck: бросок удержан ради переброса (hold.mjs) — исход не пишется, rollTried не ставится (кнопки «Бросить» у ГМа пока нет)", async () => {
  const actor = uuids.get("Actor.o"), stat = actor.getStatistic;
  actor.getStatistic = (s) => ({ check: { roll: async (p) => { rolls.push(p); p.callback?.(null, null, { id: "rm1", flags: { [MOD]: { gate: { hold: "reroll" } } } }); return { degreeOfSuccess: 0, total: 3, dice: [] }; } } });
  const m = mkRealMsg("M9", useFor());
  assert.deepEqual(await runCheck(m), []);
  assert.equal(m.flags[MOD].use.state.challenge?.results?.t1, undefined);
  assert.equal(rolls.length, 1);
  assert.equal(m.flags[MOD].use.state.challenge?.rollTried?.t1, undefined);   // исход запишет replay (acceptSavingThrow по маркеру)
  actor.getStatistic = stat;
});
