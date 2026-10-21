// buildViewModel на фикстурах §1.4 (env подменяет доступ к Foundry).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildViewModel, buildReactionViewModel } from "../scripts/chat.mjs";

const MOD = "pf2e-automato";
const modes = { zone: "auto", effect: "auto", challenge: "auto", apply: "button" };
const mkEnv = (over = {}) => ({
  t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k),
  mode: (k) => over.modes?.[k] ?? modes[k],
  now: 1_000_000_000, resumeMinutes: 30,
  groups: () => over.groups ?? [], toolbelt: false,
  tokenName: (k) => `tok-${k}`, isOwner: (k, u, user) => user.owns?.includes(k) ?? false,
  isActorOwner: (uuid, user) => user.owns?.includes(uuid) ?? false,
  statLabel: (s) => s, conditionLabel: (s) => s, uuidName: () => null, ...over.env
});
const fear = {
  v: 1, yield: null,
  onUse: {
    targets: "selected",
    challenge: {
      statistic: "will", dc: { value: 20 }, basic: false,
      byDegree: { failure: [{ condition: { slug: "frightened", value: 1 } }], criticalFailure: [{ condition: { slug: "frightened", value: 2 } }] }
    }
  }
};
const mkMsg = (use, author = "u-author") => ({ id: "m1", author: { id: author }, flags: { [MOD]: { use: { v: 1, kind: "use", confidence: "high", rule: fear, slug: "fp", createdAt: 1_000_000_000, dc: 20, item: { name: "Fear" }, targets: [{ key: "a", name: "Orc" }, { key: "b", name: "Bob", pc: true }], state: {}, ...use } } } });
const gm = { id: "gm", isGM: true }, pl = { id: "u-author", isGM: false, owns: ["b"] }, other = { id: "x", isGM: false };

test("нет снимка -> null", () => assert.equal(buildViewModel({ flags: {} }, gm, mkEnv()), null));

test("yielded: только пометка, без кнопок", () => {
  const vm = buildViewModel(mkMsg({ state: { yielded: "pf2e-automations" } }), gm, mkEnv());
  assert.equal(vm.yielded, "chat.yielded");
  assert.equal(vm.challenge, null);
});

test("роли: кнопка броска у ГМа везде, у владельца — только своей цели, у прочих нет", () => {
  const rows = (u) => buildViewModel(mkMsg({}), u, mkEnv()).challenge.rows.map((r) => r.canRoll);
  assert.deepEqual(rows(gm), [true, true]);
  assert.deepEqual(rows(pl), [false, true]);
  assert.deepEqual(rows(other), [false, false]);
});

test("режим challenge=off убирает бросок; Toolbelt — тоже", () => {
  assert.deepEqual(buildViewModel(mkMsg({}), gm, mkEnv({ modes: { challenge: "off" } })).challenge.rows.map((r) => r.canRoll), [false, false]);
  const vm = buildViewModel(mkMsg({}), gm, mkEnv({ env: { toolbelt: true } }));
  assert.ok(vm.challenge.toolbelt);
  assert.ok(vm.challenge.rows.every((r) => !r.canRoll));
});

test("результат: Применить только ГМу и по режиму apply; applied -> Отменить; changedAfterApply", () => {
  const state = { challenge: { results: { a: { degree: 1, total: 12 }, b: { degree: 2, total: 22 } }, applied: {} } };
  let vm = buildViewModel(mkMsg({ state }), gm, mkEnv());
  assert.deepEqual(vm.challenge.rows.map((r) => r.canApply), [true, false]);   // у b нет шагов на успех
  assert.ok(vm.challenge.canApplyAll);
  assert.equal(buildViewModel(mkMsg({ state }), pl, mkEnv()).challenge.canApplyAll, false);
  assert.equal(buildViewModel(mkMsg({ state }), gm, mkEnv({ modes: { apply: "off" } })).challenge.canApplyAll, false);

  state.challenge.applied.a = { ops: [{ op: "created" }], degree: 1 };
  state.challenge.results.a.changedAfterApply = true;
  vm = buildViewModel(mkMsg({ state }), gm, mkEnv());
  assert.equal(vm.challenge.rows[0].canUndo, true);
  assert.equal(vm.challenge.rows[0].canApply, false);
  assert.ok(vm.challenge.rows[0].changed);
});

test("множитель урона: только basic, только показ", () => {
  const basic = { ...fear, onUse: { ...fear.onUse, challenge: { ...fear.onUse.challenge, basic: true, byDegree: {} } } };
  const state = { challenge: { results: { a: { degree: 0, total: 3 }, b: { degree: 2, total: 22 } } } };
  const vm = buildViewModel(mkMsg({ rule: basic, state }), gm, mkEnv());
  assert.match(vm.challenge.rows[0].multiplier, /"value":2/);
  assert.match(vm.challenge.rows[1].multiplier, /½/);
  assert.equal(vm.challenge.canApplyAll, false);
  assert.equal(buildViewModel(mkMsg({ state }), gm, mkEnv()).challenge.rows[0].multiplier, null);
});

test("СЛ неизвестен: ввод только ГМу и до первого результата", () => {
  const noDc = { ...fear, onUse: { ...fear.onUse, challenge: { ...fear.onUse.challenge, dc: { expr: "markup" } } } };
  assert.equal(buildViewModel(mkMsg({ rule: noDc, dc: null }), gm, mkEnv()).challenge.canSetDC, true);
  assert.equal(buildViewModel(mkMsg({ rule: noDc, dc: null }), pl, mkEnv()).challenge.canSetDC, false);
});

test("yield:false: предупреждение только ГМу и только при покрытии", () => {
  const rule = { ...fear, yield: false };
  const env = mkEnv({ groups: ["Fright"] });
  assert.equal(buildViewModel(mkMsg({ rule }), gm, env).warnings.length, 1);
  assert.equal(buildViewModel(mkMsg({ rule }), pl, env).warnings.length, 0);
  assert.equal(buildViewModel(mkMsg({ rule }), gm, mkEnv()).warnings.length, 0);
});

test("Ожидает ГМа / Дозапустить по давности", () => {
  const vm = buildViewModel(mkMsg({}), gm, mkEnv());
  assert.ok(vm.waiting);
  assert.equal(vm.waiting.canResume, false);
  const old = { createdAt: 1_000_000_000 - 31 * 60000 };
  assert.equal(buildViewModel(mkMsg(old), gm, mkEnv()).waiting.canResume, true);
  assert.equal(buildViewModel(mkMsg(old), pl, mkEnv()).waiting.canResume, false);
  assert.equal(buildViewModel(mkMsg({ ...old, state: { done: true } }), gm, mkEnv()).waiting, null);
  // есть состояние -> не ждёт
  const st = { challenge: { results: {} }, area: { keys: ["a"] } };
  assert.equal(buildViewModel(mkMsg({ ...old, state: st }), gm, mkEnv()).waiting, null);
});

test("область: ждём регион, а не ГМа", () => {
  const rule = { ...fear, onUse: { ...fear.onUse, targets: "area" } };
  const vm = buildViewModel(mkMsg({ rule }), gm, mkEnv());
  assert.ok(vm.awaitingRegion);
  assert.equal(vm.waiting, null);
});

test("зона: создать — ГМ при pending; закрыть — ГМ и автор при active", () => {
  const zrule = { v: 1, onUse: { targets: "area", zone: { condition: { slug: "concealed" } } } };
  const z = (status) => ({ rule: zrule, state: { zone: { status, regionUuid: "Scene.s.Region.r" } } });
  assert.equal(buildViewModel(mkMsg(z("pending")), gm, mkEnv()).zone.canCreate, true);
  assert.equal(buildViewModel(mkMsg(z("pending")), pl, mkEnv()).zone.canCreate, false);
  assert.equal(buildViewModel(mkMsg(z("active")), pl, mkEnv()).zone.canClose, true);
  assert.equal(buildViewModel(mkMsg(z("active")), other, mkEnv()).zone.canClose, false);
});

test("low-кнопка: ГМ и автор, режим вида off скрывает, applied убирает", () => {
  const rule = { v: 1, onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "quickened" } }] } };
  const use = { rule, confidence: "low", state: { derived: { pending: ["u0"] } } };
  const vm = buildViewModel(mkMsg(use), pl, mkEnv());
  assert.equal(vm.derived.length, 1);
  assert.equal(vm.derived[0].canApply, true);
  assert.equal(vm.useApply, null);   // low не показывается как «Применить»
  assert.equal(buildViewModel(mkMsg(use), other, mkEnv()).derived[0].canApply, false);
  assert.equal(buildViewModel(mkMsg(use), gm, mkEnv({ modes: { effect: "off" } })).derived.length, 0);
  use.state.derived.applied = ["u0"];
  assert.equal(buildViewModel(mkMsg(use), gm, mkEnv()).derived.length, 0);
});

test("onUse.apply high в режиме button: кнопка у автора/ГМа, пока не применено", () => {
  const rule = { v: 1, onUse: { targets: "self", apply: [{ to: "self", effect: { uuid: "Compendium.x" } }] } };
  const env = mkEnv({ modes: { effect: "button" } });
  assert.equal(buildViewModel(mkMsg({ rule }), pl, env).useApply.canApply, true);
  assert.equal(buildViewModel(mkMsg({ rule }), other, env).useApply.canApply, false);
  assert.equal(buildViewModel(mkMsg({ rule, state: { apply: { self: { ops: [] } } } }), pl, env).useApply.canApply, false);
  assert.equal(buildViewModel(mkMsg({ rule }), pl, mkEnv()).useApply.canApply, false);   // auto
});

test("подсказка реакции: владелец/ГМ, used скрывает кнопку", () => {
  const msg = (used) => ({ id: "h", flags: { [MOD]: { reaction: { actor: "Actor.1", item: "Item.2", before: 2, after: 1, used } } } });
  const env = mkEnv();
  assert.equal(buildReactionViewModel(msg(false), gm, env).canUse, true);
  assert.equal(buildReactionViewModel(msg(false), { id: "p", owns: ["Actor.1"] }, env).canUse, true);
  assert.equal(buildReactionViewModel(msg(false), other, env).canUse, false);
  assert.equal(buildReactionViewModel(msg(true), gm, env).canUse, false);
  assert.equal(buildReactionViewModel({ flags: {} }, gm, env), null);
});

test("метаигра pf2e: ГМ видит всё; игрок без dcs/results не видит СЛ и степень; число броска — только своей цели", () => {
  const state = { challenge: { results: { a: { degree: 1, total: 12 }, b: { degree: 2, total: 22 } }, applied: {} } };
  const hide = mkEnv({ env: { metagame: { dcs: false, results: false } } });
  const g = buildViewModel(mkMsg({ state }), gm, hide).challenge;
  assert.match(g.dc, /20/);
  assert.deepEqual(g.rows.map((r) => r.total), [12, 22]);
  const p = buildViewModel(mkMsg({ state }), pl, hide).challenge;   // pl владеет b
  assert.equal(p.dc, null);
  assert.equal(p.dcUnknown, null);
  assert.deepEqual(p.rows.map((r) => [r.total, r.degree]), [[null, "none"], [22, "none"]]);   // у владельца b число есть, степени нет
  assert.equal(p.rows[1].label, "chat.resultHidden");
  assert.equal(p.rows[1].multiplier, null);
  assert.equal(p.rows[0].label, "chat.resultHidden");
  assert.deepEqual(p.rows[0].plan, []);
  const open = buildViewModel(mkMsg({ state }), other, mkEnv()).challenge;   // настройки включены
  assert.match(open.dc, /20/);
  assert.deepEqual(open.rows.map((r) => r.total), [12, 22]);
});

test("метаигра: СЛ check скрыта у игрока (в шапке и в строке PC-цели), если фиксированная; СЛ защиты PC — видна; СЛ PC-актёра в шапке видна", () => {
  const fixed = { v: 1, onUse: { targets: "selected", check: { statistic: "will", vs: { dc: 22 }, byDegree: {} } } };
  const def = { v: 1, onUse: { targets: "selected", check: { statistic: "will", vs: { defense: "will" }, byDegree: {} } } };
  const env = (e) => mkEnv({ env: { metagame: { dcs: false, results: true }, checkDc: (k, use) => use.rule.onUse.check.vs.dc ?? 19, isPc: (k) => k === "b", ...e } });
  let vm = buildViewModel(mkMsg({ rule: fixed }), other, env()).challenge;
  assert.match(vm.stat, /chat\.dcHidden/);
  assert.deepEqual(vm.rows.map((r) => r.dc), [null, null]);
  assert.match(buildViewModel(mkMsg({ rule: fixed }), gm, env()).challenge.stat, /22/);
  vm = buildViewModel(mkMsg({ rule: def }), other, env()).challenge;
  assert.deepEqual([vm.rows[0].dc, /19/.test(vm.rows[1].dc)], [null, true]);
  vm = buildViewModel(mkMsg({ rule: fixed }), other, env({ isActorPc: () => true })).challenge;
  assert.match(vm.stat, /22/);
});

test("заголовок равный названию предмета не выводится", () => {
  assert.equal(buildViewModel(mkMsg({}), gm, mkEnv()).title, null);
  assert.equal(buildViewModel(mkMsg({ rule: { ...fear, label: "Boo" } }), gm, mkEnv()).title, "Boo");
});
