import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.game ??= {};
const MOD = "pf2e-automato";
const { validateRule, isSelfEffectOnly, initCatalog } = await import("../scripts/rules.mjs");
const D = await import("../scripts/builtin/damaged.mjs");
const { buildDamagedViewModel } = await import("../scripts/chat.mjs");
const { setSocket, useTargetOverride } = await import("../scripts/util.mjs");
const { checkDraft } = await import("../tools/check-on-damaged-draft.mjs");

const USE = { targets: "selected", apply: [{ to: "target", effect: { uuid: "Compendium.pf2e.spell-effects.Item.x" } }] };
const rule = (onDamaged, extra = {}) => ({ v: 1, onUse: USE, onDamaged, ...extra });
const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));

/* ---------- схема ---------- */

test("валидатор: onDamaged совместим с onUse, несовместим с onAttacked, пустое правило с ним не пустое", () => {
  const ok = validateRule(rule({ who: "familiar", triggerOnly: true }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.rule.onDamaged, { who: "familiar", range: null, withSelf: false, when: null, requires: null, damage: null, triggerOnly: true, cost: null, notify: ["owner", "gm"] });
  assert.equal(validateRule({ v: 1, onDamaged: { who: "self", damage: { halve: true } } }).ok, true);   // без onUse: правило не пустое
  const both = validateRule({ v: 1, onAttacked: { trigger: "attack-on-self", bonus: { stat: "ac", type: "circumstance", value: 1 } }, onDamaged: { who: "self" } });
  assert.equal(both.ok, false);
  assert.ok(both.errors.some((e) => e.key === "rule.bothDamaged"));
});

test("валидатор: who/range/withSelf/damage/cost/requires/when/notify", () => {
  const keys = (d) => { const r = validateRule(rule(d)); return r.ok ? [] : r.errors.map((e) => e.key); };
  assert.deepEqual(keys({ who: "ally", range: 30, withSelf: true, damage: { reduce: "@item.rank*5" }, cost: { hp: "@item.rank" }, requires: "shield:raised", when: ["damage:type:fire"], notify: ["gm"] }), []);
  assert.deepEqual(keys({ who: "ally" }), []);   // range по умолчанию 30
  assert.equal(validateRule(rule({ who: "ally" })).rule.onDamaged.range, 30);
  assert.deepEqual(keys({ who: "eidolon" }), ["damaged.who"]);
  assert.deepEqual(keys({ who: "self", range: 30 }), ["damaged.range"]);
  assert.deepEqual(keys({ who: "self", withSelf: true }), ["damaged.withSelf"]);
  assert.deepEqual(keys({ who: "self", damage: { reduce: "2d6" } }), ["damaged.reduce"]);
  assert.deepEqual(keys({ who: "self", damage: { halve: false } }), ["damaged.damage"]);
  assert.deepEqual(keys({ who: "self", damage: { redirect: "self", part: "third" } }), ["damaged.damage"]);
  assert.deepEqual(keys({ who: "self", damage: { redirect: "self", part: "half" } }), []);
  assert.deepEqual(keys({ who: "self", cost: { hp: "d4" } }), ["damaged.cost"]);
  assert.deepEqual(keys({ who: "self", requires: "bad value" }), ["damaged.requires"]);
  assert.deepEqual(keys({ who: "self", when: "fire" }), ["apply.when"]);
  assert.deepEqual(keys({ who: "self", notify: ["everyone"] }), ["react.notify"]);
});

test("валидатор: damage.resist — список тип + число, один ключ", () => {
  const keys = (d) => { const r = validateRule(rule({ who: "self", damage: d })); return r.ok ? [] : r.errors.map((e) => e.key); };
  const ok = validateRule(rule({ who: "self", damage: { resist: [{ type: "triggering", value: "@actor.level" }, { type: "physical", value: "5" }] } }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.rule.onDamaged.damage, { resist: [{ type: "triggering", value: "@actor.level" }, { type: "physical", value: "5" }] });
  assert.deepEqual(keys({ resist: [] }), ["damaged.resist"]);
  assert.deepEqual(keys({ resist: [{ type: "fire", value: "2d6" }] }), ["damaged.resist"]);
  assert.deepEqual(keys({ resist: [{ type: "Fire!", value: "5" }] }), ["damaged.resist"]);
  assert.deepEqual(keys({ resist: [{ type: "fire", value: "5" }], halve: true }), ["damaged.damage"]);
});

test("isSelfEffectOnly: правило с onDamaged — не просто selfEffect (иначе pf2e-эффект и наш задвоятся)", () => {
  const fx = "Compendium.pf2e.spell-effects.Item.x";
  const base = { onUse: { challenge: null, check: null, zone: null, apply: [{ to: "self", effect: { uuid: fx } }] }, macros: [] };
  assert.equal(isSelfEffectOnly(base, fx), true);
  assert.equal(isSelfEffectOnly({ ...base, onDamaged: { who: "self" } }, fx), false);
});

/* ---------- п.5: опции и каталог ---------- */

test("опции карточки: реальные токены pf2e (check:outcome:critical-success, item:type:spell, area-damage, attack)", () => {
  const msg = (extra) => ({ flags: { pf2e: { context: { options: ["self:trait:fire"], ...extra.ctx }, ...extra.pf } }, rolls: [{ instances: [{ type: "fire" }, { type: "bludgeoning" }] }], ...extra.top });
  const o = D.damageOptions(msg({ ctx: { outcome: "criticalSuccess", sourceType: "attack" } }));
  assert.ok(o.has("damage:type:fire") && o.has("damage:type:bludgeoning") && o.has("origin:trait:fire"));
  assert.ok(o.has("check:outcome:critical-success") && o.has("attack"));
  assert.ok(!o.has("outcome:criticalSuccess") && !o.has("source:attack"), "прежних выдуманных токенов нет");
  assert.ok(D.damageOptions(msg({ ctx: { outcome: "success" } })).has("check:outcome:success"));
  assert.ok(D.damageOptions(msg({ top: { item: { type: "spell", area: { type: "burst" } } } })).has("item:type:spell"));
  assert.ok(D.damageOptions(msg({ top: { item: { type: "spell", area: { type: "burst" } } } })).has("area-damage"));
  assert.ok(!D.damageOptions(msg({ top: { item: { type: "spell", area: null } } })).has("area-damage"));
  assert.ok(D.damageOptions(msg({ pf: { origin: { type: "spell" } } })).has("item:type:spell"));
  assert.ok(!D.damageOptions(msg({})).has("attack"));
});

test("словарь опций: мёртвые токены не проходят, живые проходят", () => {
  for (const t of ["damage:type:fire", "check:outcome:critical-success", "attack", "area-damage", "item:type:spell"]) assert.equal(D.knownOption(t), true, t);
  for (const t of ["crit", "spell", "outcome:criticalSuccess", "source:attack", "damage:type:laser"]) assert.equal(D.knownOption(t), false, t);
  const stances = new Set(["wild-winds-stance"]);
  assert.equal(D.knownRequire("shield:raised", stances), true);
  assert.equal(D.knownRequire("stance:wild-winds-stance", stances), true);
  assert.equal(D.knownRequire("stance:no-such", stances), false);
  assert.equal(D.knownRequire("shield:lowered", stances), false);
  assert.deepEqual(D.tokensOf(["a", { or: ["b", { and: ["c"] }] }]).filter((t) => !["or", "and"].includes(t)), ["a", "b", "c"]);
});

test("каталог: ни одно when/requires правил onDamaged не мёртвое (черновик b10, модель, Phase Familiar), resist вместо reduce у «сопротивления»", () => {
  const { err } = checkDraft();
  assert.deepEqual(err, []);
  const stances = new Set(read("tools/out/items.json").items.filter((i) => (i.traits ?? []).includes("stance")).map((i) => i.slug));
  let seen = 0;
  for (const file of ["rules/catalog.model.json", "rules/catalog.json"]) {
    for (const [uuid, r] of Object.entries(read(file).bySource)) {
      const d = r?.onDamaged;
      if (!d) continue;
      seen++;
      for (const t of D.tokensOf(d.when)) if (!["or", "and", "not"].includes(t)) assert.equal(D.knownOption(t), true, `${file} ${uuid}: when «${t}»`);
      if (d.requires?.includes(":")) assert.equal(D.knownRequire(d.requires, stances), true, `${file} ${uuid}: requires «${d.requires}»`);
      const v = validateRule(r);
      assert.equal(v.ok, true, `${file} ${uuid}: ${JSON.stringify(v.errors)}`);
    }
  }
  assert.ok(seen >= 30, `правил onDamaged: ${seen}`);
  const draft = read("rules/drafts-accepted/b10-on-damaged.json").items.filter((i) => i.rule);
  const bySlug = (s) => draft.filter((i) => i.slug === s).map((i) => i.rule.onDamaged.damage);
  for (const s of ["pincushion", "sonic-redirection", "empty-vessel", "preemptive-reconfiguration", "withstand-the-storm", "hardening-necrosis", "thrice-fried-mudwings", "energy-ward"]) for (const x of bySlug(s)) assert.ok(x.resist, `${s}: resist`);
  for (const s of ["negate-damage", "frill-block", "dig-in"]) for (const x of bySlug(s)) assert.ok(x.reduce, `${s}: reduce`);
});

/* ---------- отбор ---------- */

test("отбор кандидатов: who + when по опциям карточки", () => {
  const fire = { who: "self", when: ["damage:type:fire"], withSelf: false };
  const options = D.damageOptions({
    flags: { pf2e: { context: { options: ["self:trait:fire"], outcome: "criticalSuccess", sourceType: "attack" } } },
    rolls: [{ instances: [{ type: "fire" }, { type: "bludgeoning" }] }]
  });
  assert.equal(D.matches(fire, { same: true, options }), true);
  assert.equal(D.matches(fire, { same: true, options: new Set(["damage:type:cold"]) }), false);
  assert.equal(D.matches({ who: "self", when: ["check:outcome:critical-success"] }, { same: true, options }), true);
  assert.equal(D.matches({ who: "self", when: null }, { same: false, options }), false);
  assert.equal(D.matches({ who: "familiar" }, { familiar: true, options }), true);
  assert.equal(D.matches({ who: "familiar" }, { same: true, options }), false);
  assert.equal(D.matches({ who: "ally", withSelf: false }, { ally: true, options }), true);
  assert.equal(D.matches({ who: "ally", withSelf: false }, { same: true, ally: true, options }), false);   // «вы» — только при withSelf
  assert.equal(D.matches({ who: "ally", withSelf: true }, { same: true, options }), true);
  assert.equal(D.matches({ who: "ally", withSelf: true }, { ally: false, options }), false);
});

test("ресурс и требование (self:shield:raised, стойка)", () => {
  assert.equal(D.resourceOk({ system: { frequency: { max: 1, value: 0 } } }, {}), false);
  assert.equal(D.resourceOk({ system: { frequency: { max: 1, value: 1 } } }, {}), true);
  assert.equal(D.resourceOk({ system: {} }, {}), true);
  assert.equal(D.resourceOk({ isFocusSpell: true, system: {} }, { system: { resources: { focus: { value: 0 } } } }), false);
  assert.equal(D.resourceOk({ isFocusSpell: true, system: {} }, { system: { resources: { focus: { value: 1 } } } }), true);
  const raised = { getRollOptions: () => ["self:shield:raised"] };
  assert.equal(D.requiresOk("shield:raised", {}, raised, () => "x"), true);   // у актёра опция с префиксом self:
  assert.equal(D.requiresOk("shield:raised", {}, { getRollOptions: () => [] }, () => null), false);
  assert.equal(D.requiresOk("stance:x", {}, raised, () => null), false);
  assert.equal(D.requiresOk("stance:wild-winds-stance", {}, { getRollOptions: () => ["self:effect:spell-effect-wild-winds-stance"] }, () => null), true);
  assert.equal(D.requiresOk("held", {}, raised, (_i, r) => (r === "held" ? "held" : null)), false);
  assert.equal(D.requiresOk(null, {}, raised, () => null), true);
});

test("п.9: дальность и множитель спасброска", () => {
  assert.equal(D.rangeOk("self", { onScene: false, dist: 999, limit: 5 }), true);
  assert.equal(D.rangeOk("familiar", { onScene: false, dist: 10, limit: 60 }), false);   // владельца нет на сцене
  assert.equal(D.rangeOk("familiar", { onScene: true, dist: 60, limit: 60 }), true);
  assert.equal(D.rangeOk("familiar", { onScene: true, dist: 65, limit: 60 }), false);
  assert.equal(D.rangeOk("ally", { onScene: true, dist: NaN, limit: 30 }), true);   // не измерить — не штрафуем
  assert.equal(D.rangeOk("ally", { onScene: true, dist: 500, limit: null }), true);
  assert.equal(D.multGate(undefined), true);   // урон не по спасброску
  assert.equal(D.multGate(null), false);       // итога спасброска ещё нет
  assert.equal(D.multGate(0), false);          // успех: ×0
  assert.equal(D.multGate(0.5), true);
});

/* ---------- решение ---------- */

test("расчёт изменения урона: reduce / halve / redirect, остаток при нескольких решениях", () => {
  const dec = D.decisionOf({ damage: { reduce: "@item.rank*5" } }, { rank: 3, level: 3, actorLevel: 5 });
  assert.equal(dec.reduce, 15);
  assert.equal(D.changeOf(dec, 40).cut, 15);
  assert.equal(D.changeOf(dec, 9).cut, 9);   // не больше урона
  assert.deepEqual(D.changeOf({ halve: true }, 9), { cut: 5, redirect: 0 });   // цель получает floor(9/2) = 4
  assert.deepEqual(D.changeOf({ redirect: "all" }, 9), { cut: 9, redirect: 9 });
  assert.deepEqual(D.changeOf({ redirect: "half" }, 9), { cut: 5, redirect: 5 });
  assert.deepEqual(D.changeOf({}, 9), { cut: 0, redirect: 0 });
  const d2 = D.decisionOf({ damage: { redirect: "self" }, cost: { hp: "@item.rank" }, triggerOnly: true }, { rank: 2 }, ["fx"]);
  assert.deepEqual(d2, { reduce: null, halve: false, redirect: "all", resist: null, triggerOnly: true, hp: 2, fx: ["fx"] });
  const plan = D.planOf([{ id: "a", dec: { reduce: 4 } }, { id: "b", dec: { halve: true } }], 10);
  assert.deepEqual(plan, { cut: 7, rows: [{ id: "a", cut: 4, redirect: 0 }, { id: "b", cut: 3, redirect: 0 }] });   // 10 -> 6 -> 3
  assert.equal(D.cutDamage(10, 4), 6);
  assert.equal(D.cutDamage({ alter: (m, a) => `${m}/${a}` }, 4), "1/-4");
});

test("п.7: resist — тип triggering раскрывается типами карточки под when; сопротивление не режет урон (cut 0), а идёт эффектом", () => {
  const when = D.whenTypes([{ or: ["damage:type:bludgeoning", "damage:type:piercing", "damage:type:slashing"] }, "attack"]);
  assert.deepEqual(when, ["bludgeoning", "piercing", "slashing"]);
  const d = { damage: { resist: [{ type: "triggering", value: "@actor.level" }] } };
  const dec = D.decisionOf(d, { rank: 1, level: 1, actorLevel: 7 }, [], { card: ["piercing", "fire"], when });
  assert.deepEqual(dec.resist, [{ type: "piercing", value: 7 }]);   // fire не под when
  assert.deepEqual(D.decisionOf({ damage: { resist: [{ type: "physical", value: "15" }] } }, {}, [], { card: ["fire"], when: [] }).resist, [{ type: "physical", value: 15 }]);
  assert.deepEqual(D.decisionOf({ damage: { resist: [{ type: "triggering", value: "5" }] } }, {}, [], { card: ["fire", "cold"], when: [] }).resist, [{ type: "fire", value: 5 }, { type: "cold", value: 5 }]);
  assert.equal(D.changeOf(dec, 20).cut, 0);
  const fx = D.resistEffect("HINT0123456789ab", dec.resist, { name: "Колючка", owner: "Actor.o", target: "Actor.t" });
  assert.equal(fx._id, "HINT0123456789ab");
  assert.equal(fx.type, "effect");
  assert.deepEqual(fx.system.rules, [{ key: "Resistance", type: "piercing", value: 7 }]);
  assert.equal(fx.system.context.origin.actor, "Actor.o");
  assert.equal(fx.system.duration.unit, "unlimited");
});

test("п.7: свежий клон несёт эфемерные эффекты старого и новые, контекстные опции переносятся", () => {
  const eph = { id: "eph1", type: "effect", toObject: () => ({ _id: "eph1", type: "effect", name: "damage-received" }) };
  const real = { _source: { items: [{ _id: "own1" }], flags: { pf2e: { rollOptions: { all: { own: true } } } } }, getContextualClone(options, effects) { this.args = { options, effects }; return { fresh: true }; } };
  const clone = { items: [{ id: "own1", type: "effect", toObject: () => ({ _id: "own1" }) }, eph, { id: "w", type: "weapon" }], flags: { pf2e: { rollOptions: { all: { own: true, "origin:enemy": true } } } } };
  const res = D.refreshed(clone, real, [{ _id: "new" }]);
  assert.deepEqual(res, { fresh: true });
  assert.deepEqual(real.args.options, ["origin:enemy"]);
  assert.deepEqual(real.args.effects.map((e) => e._id), ["eph1", "new"]);
  assert.equal(D.refreshed(clone, {}, []), null);
  assert.equal(D.refreshed(real, real, [{ _id: "z" }]) !== null, true);   // клон == настоящий актёр: тоже клонируем (эффект сопротивления нужен)
});

/* ---------- п.3: удержание привязано к карточке ---------- */

test("п.3: записи удержания — по карточке при известном источнике, по ходу при неизвестном; зависшее pending и применённое не держат", () => {
  const hold = {
    a: { message: "M1", state: "pending", turn: "c:1:0", until: 2000 },
    b: { message: "M2", state: "used", turn: "c:1:0", decision: {}, rev: 0 },
    c: { message: "M1", state: "used", turn: "c:1:0", decision: {}, rev: 1 },
    d: { message: "M3", state: "used", turn: "c:0:5", decision: {} },
    e: { message: "M1", state: "pending", turn: "c:1:0", until: 500 }
  };
  const ids = (src, now, consumed) => D.holdsFor(hold, src, now, consumed, 1000).map((x) => x.id);
  assert.deepEqual(ids("M1", "c:1:0"), ["a", "c"]);                         // e зависло (until), чужие карточки не трогаем
  assert.deepEqual(ids("M2", "c:1:0"), ["b"]);
  assert.deepEqual(ids("M1", "c:1:0", new Set(["c:1"])), ["a"]);            // c с rev 1 уже применён этим клиентом
  assert.deepEqual(ids("M1", "c:1:0", new Set(["c:0"])), ["a", "c"]);       // другая ревизия — ещё не применена (откат вернул решение)
  assert.deepEqual(ids(null, "c:1:0"), ["a", "b", "c"]);                    // источник неизвестен: все этого хода (d — прошлого хода)
  assert.deepEqual(ids(null, null), []);                                    // записи боя вне боя неприменимы без источника
  assert.deepEqual(D.holdsFor({ n: { message: "M", state: "used" } }, null, null, new Set(), 1000).map((x) => x.id), ["n"]);   // запись без хода (создана вне боя)
  assert.deepEqual(D.marksIn(["a", D.markOf("H1"), D.markOf("H2")]), ["H1", "H2"]);
  assert.equal(D.staleTurn(null, "c:1:0"), false);
  assert.equal(D.staleTurn("c:1:0", "c:1:1"), true);
});

test("удержание: ждёт решения; таймаут возвращает нерешённые; пусто — сразу", async () => {
  const state = { a: { state: "pending" }, b: { state: "pending" } };
  let fire = null, offs = 0;
  const get = (id) => state[id];
  const on = (fn) => { fire = fn; return () => { offs++; }; };
  const p = D.waitDecided(["a", "b"], 1000, get, on);
  state.a = { state: "used" }; fire();
  delete state.b; fire();   // запись снята (пропуск/срок) — решено
  assert.deepEqual(await p, []);
  assert.equal(offs, 1);
  state.a = { state: "pending" };
  assert.deepEqual(await D.waitDecided(["a"], 10, get, on), ["a"]);   // таймаут
  assert.deepEqual(await D.waitDecided([], 10, get, on), []);
});

test("окно реакции: разбор подсказки «получит урон»", () => {
  const env = { t: (k, d) => `${k}|${d.item}|${d.actor}|${d.target}`, uuidName: () => null, isActorOwner: (uuid, u) => uuid === "Actor.w" && u.id === "p" };
  const msg = (state) => ({ flags: { "pf2e-automato": { damaged: { actor: "Actor.w", item: "Item.i", itemName: "Щит", actorName: "Ведьма", targetName: "Фамильяр", state } } } });
  const vm = buildDamagedViewModel(msg("pending"), { isGM: false, id: "p" }, env);
  assert.equal(vm.popup, "builtin.damaged.popup|Щит|Ведьма|Фамильяр");
  assert.equal(vm.canUse, true);
  assert.equal(buildDamagedViewModel(msg("pending"), { isGM: false, id: "q" }, env).canUse, false);
  assert.equal(buildDamagedViewModel(msg("pending"), { isGM: true, id: "g" }, env).canUse, true);
  assert.equal(buildDamagedViewModel(msg("used"), { isGM: true, id: "g" }, env).canUse, false);
  assert.equal(buildDamagedViewModel(msg("expired"), { isGM: true, id: "g" }, env).canUse, false);
  assert.equal(buildDamagedViewModel({ flags: {} }, { isGM: true }, env), null);
});

test("apply-hook: first ставит подписчика первым, actor подменяется, снимок клика берётся до подписчиков и доходит до каждого", async () => {
  const targets = new Set(), wrappers = [];
  globalThis.game = { modules: { get: () => ({ active: true }) }, settings: { get: () => "off" } };
  globalThis.libWrapper = { register(_m, target, fn) { if (targets.has(target)) throw new Error("dup"); targets.add(target); wrappers.push(fn); } };
  const hook = await import("../scripts/builtin/apply-hook.mjs");
  const order = [], ctxs = [];
  let click = { id: "MSG1" };
  hook.setClickSource(() => click);
  hook.subscribe(async (a, _o, ctx) => { order.push(`late:${a.id}`); ctxs.push(ctx.click?.id); });
  hook.subscribe(async (a, o, ctx) => { order.push(`first:${a.id}`); ctxs.push(ctx.click?.id); click = null; return { actor: { id: "fresh" }, opts: { ...o, damage: o.damage - 1 }, after: () => order.push("after") }; }, { first: true });
  hook.install();
  const seen = [];
  await wrappers.at(-1).call({ id: "clone" }, async function (o) { seen.push([this.id, o.damage]); }, { damage: 5 });
  assert.deepEqual(seen, [["fresh", 4]]);
  assert.deepEqual(order, ["first:clone", "late:fresh", "after"]);
  assert.deepEqual(ctxs, ["MSG1", "MSG1"]);   // первый подписчик сбросил живую метку, второй всё равно видит снимок
  hook.setClickSource(() => null);
});

/* ---------- мир для интеграционных проверок ---------- */

const setPath = (obj, path, val) => {
  const keys = path.split("."), del = keys.at(-1).startsWith("-=") || (val && typeof val === "object" && val.constructor?.name === "ForcedDeletion");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  const last = keys.at(-1);
  if (last.startsWith("-=")) delete o[last.slice(2)]; else if (del) delete o[last]; else o[last] = val;
};
const doc = (data) => {
  const d = { flags: {}, ...data, update: async (ch) => { for (const [k, v] of Object.entries(ch)) setPath(d, k, v); } };
  return d;
};

function world({ mode = "auto" } = {}) {
  const msgs = [], map = new Map(), applied = [], calls = [];
  const message = (data) => { const m = doc({ id: `m${msgs.length}`, timestamp: Date.now(), ...data }); msgs.push(m); return m; };
  const gmTargets = new Set(["GM-OWN-TARGET"]);
  globalThis.game = {
    messages: { contents: msgs, get: (id) => msgs.find((m) => m.id === id), has: (id) => msgs.some((m) => m.id === id) },
    combats: [], user: { id: "gm", isGM: true, isActiveGM: true, targets: gmTargets }, users: { activeGM: { id: "gm" }, contents: [] },
    actors: { get: () => null },
    settings: { get: (_m, key) => (key === "mode.apply" ? mode : key === "debug" ? false : "auto") },
    i18n: { localize: (k) => k, format: (k) => k }, modules: { get: () => null }
  };
  globalThis.ui = { notifications: { info() {}, warn() {} } };
  globalThis.Hooks = { on() {}, off() {} };
  globalThis.fromUuid = async (u) => map.get(u) ?? null;
  const actor = (id, extra = {}) => {
    const a = { id, uuid: `Actor.${id}`, name: id, hitPoints: { value: 10 }, level: 5, items: [], itemTypes: { effect: [] }, effects: new Set(), type: "character",
      getFlag: () => null, setFlag: async () => {}, getActiveTokens: () => [], getRollOptions: () => [], testUserPermission: () => true, ...extra };
    map.set(a.uuid, a);
    return a;
  };
  const tokenOf = (a, id) => { const t = doc({ id, uuid: `Scene.S.Token.${id}`, name: a.name, actor: a, parent: { tokens: [] } }); map.set(t.uuid, t); return t; };
  return { msgs, map, applied, calls, message, actor, tokenOf, gmTargets };
}

const FX = "Compendium.pf2e.spell-effects.Item.fx";
const SRC = "Compendium.pf2e.spells-srd.Item.react";
function reactor(w, { who = "self", steps = [{ to: "self", effect: { uuid: FX } }], onDamaged = {}, mode } = {}) {
  const owner = w.actor("owner"), token = w.tokenOf(owner, "T1");
  const fam = w.actor("fam", { type: "familiar" }), famToken = w.tokenOf(fam, "T2");
  const raw = { v: 1, onUse: { targets: "selected", apply: steps }, onDamaged: { who, damage: { halve: true }, triggerOnly: true, ...onDamaged } };
  const v = validateRule(raw);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  initCatalog([{ bySource: { [SRC]: v.rule }, bySlug: {} }], {});
  const seen = { cast: 0, targets: null, userTargets: null };
  const item = { uuid: "Item.react", name: "Фазовый фамильяр", type: "spell", slug: "react", system: { level: { value: 1 } }, rank: 1, _stats: { compendiumSource: SRC, modifiedTime: 1 }, actor: owner,
    isOfType: (t) => t === "spell", spellcasting: { cast: async () => {
      seen.cast++; seen.targets = useTargetOverride.get(owner.uuid); seen.userTargets = [...game.user.targets];
      await new Promise((r) => setTimeout(r, 5));
      w.message({ content: "cast" });
    } } };
  owner.items = [item]; w.map.set(item.uuid, item);
  const dmg = w.message({ flags: { pf2e: { context: { type: "damage-roll", options: [] } } }, rolls: [{ total: 10, instances: [{ type: "fire" }] }] });
  const hintOn = (tok, extra = {}) => w.message({ flags: { [MOD]: { damaged: { message: dmg.id, token: tok.uuid, actor: owner.uuid, item: item.uuid, state: "pending", turn: null, rev: 0, itemName: item.name, ...extra } } } });
  const deps = { hasEffect: (a, uuid) => a.effects.has(uuid), applyEffect: async (a, spec) => { w.applied.push([a.uuid, spec.uuid]); a.effects.add(spec.uuid); } };
  return { owner, token, fam, famToken, item, dmg, hintOn, deps, seen };
}

const holdOn = (tok) => tok.flags?.[MOD]?.damagedHold ?? {};

/* ---------- п.1, 4, 6: использование ---------- */

test("п.1: цели использования — защищаемый токен через useTargetOverride, game.user.targets ГМа не трогается, переопределение снято", async () => {
  const w = world({ mode: "off" });
  const r = reactor(w);
  const hint = r.hintOn(r.token);
  const res = await D.useDamaged(hint.id, r.deps);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(r.seen.targets, [r.token]);
  assert.deepEqual(r.seen.userTargets, ["GM-OWN-TARGET"]);   // во время сотворения цели ГМа те же
  assert.deepEqual([...game.user.targets], ["GM-OWN-TARGET"]);
  assert.equal(useTargetOverride.has(r.owner.uuid), false);
  assert.equal(hint.flags[MOD].damaged.state, "used");
});

test("п.4: who:self — эффект ответа (to:self) не выпадает; в режиме button кладётся напрямую один раз, hold получает решение с fx", async () => {
  const w = world({ mode: "button" });
  const r = reactor(w);
  const hint = r.hintOn(r.token);
  await D.useDamaged(hint.id, r.deps);
  assert.deepEqual(w.applied, [[r.owner.uuid, FX]]);
  assert.deepEqual(hint.flags[MOD].damaged.decision.fx, [FX]);   // triggerOnly: эффект снимется после урона
  const e = holdOn(r.token)[hint.id];
  assert.equal(e.state, "used");
  assert.equal(e.decision.halve, true);
  assert.equal(e.message, r.dmg.id);
  // повтор не даёт дубля: эффект уже есть
  const hint2 = r.hintOn(r.token, { item: r.item.uuid });
  w.applied.length = 0;
  r.owner.effects.add(FX);
  await D.useDamaged(hint2.id, r.deps);
  assert.deepEqual(w.applied, []);
});

test("п.4: auto — эффект, лёгший сам (use.mjs), не дублируется; familiar — шаги to:target на фамильяра, to:self игнорируются", async () => {
  const w = world({ mode: "auto" });
  const r = reactor(w, { who: "familiar", steps: [{ to: "target", effect: { uuid: FX } }, { to: "self", effect: { uuid: "Compendium.pf2e.spell-effects.Item.mine" } }] });
  r.item.spellcasting.cast = async () => { w.message({ content: "cast" }); setTimeout(() => r.fam.effects.add(FX), 30); };   // эффект ложится позже самого сотворения
  const hint = r.hintOn(r.famToken);
  await D.useDamaged(hint.id, r.deps);
  assert.deepEqual(w.applied, []);
  assert.ok(r.fam.effects.has(FX));
  const w2 = world({ mode: "button" });
  const r2 = reactor(w2, { who: "familiar", steps: [{ to: "target", effect: { uuid: FX } }, { to: "self", effect: { uuid: "Compendium.pf2e.spell-effects.Item.mine" } }] });
  await D.useDamaged(r2.hintOn(r2.famToken).id, r2.deps);
  assert.deepEqual(w2.applied, [[r2.fam.uuid, FX]]);
});

test("п.6: две подсказки одного владельца — реакция тратится один раз (очередь по владельцу), вторая закрывается", async () => {
  const w = world({ mode: "off" });
  const r = reactor(w);
  const h1 = r.hintOn(r.token), h2 = r.hintOn(r.famToken);
  await Promise.all([D.useDamaged(h1.id, r.deps), D.useDamaged(h2.id, r.deps)]);
  assert.equal(r.seen.cast, 1);
  assert.equal(h1.flags[MOD].damaged.state, "used");
  assert.equal(h2.flags[MOD].damaged.state, "skipped");
  assert.equal(holdOn(r.famToken)[h2.id], undefined);
});

test("п.3/9: подсказка устарела — урон по цели уже нанесён или ход сменился: expired, реакция не тратится", async () => {
  const w = world({ mode: "off" });
  const r = reactor(w);
  r.dmg.flags[MOD] = { shieldBlock: { done: { T1: true } } };
  const hint = r.hintOn(r.token);
  r.token.flags[MOD] = { damagedHold: { [hint.id]: { message: r.dmg.id, state: "pending" } } };
  const res = await D.useDamaged(hint.id, r.deps);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "expired");
  assert.equal(hint.flags[MOD].damaged.state, "expired");
  assert.equal(holdOn(r.token)[hint.id], undefined);   // удержание снято: кнопки погасли, урон не ждёт
  assert.equal(r.seen.cast, 0);
});

test("п.3: «Без реакции» и таймаут — ответ с состоянием; поздний used не теряется; ранний timeout отклоняется", async () => {
  const w = world({ mode: "off" });
  const r = reactor(w);
  const hint = r.hintOn(r.token);
  r.token.flags[MOD] = { damagedHold: { [hint.id]: { message: r.dmg.id, state: "pending" } } };
  assert.deepEqual(await D.skipDamaged(hint.id, true), { ok: false, reason: "early" });   // с создания прошло мало: чужое «таймаут» не принимаем
  assert.equal(hint.flags[MOD].damaged.state, "pending");
  assert.equal((await D.skipDamaged(hint.id)).state, "skipped");
  assert.equal(holdOn(r.token)[hint.id], undefined);
  const late = r.hintOn(r.token, { state: "used", decision: { halve: true }, itemName: "Щит" });
  const res = await D.skipDamaged(late.id, true);
  assert.equal(res.state, "used");
  assert.equal(res.hold.state, "used");
  assert.equal(res.hold.decision.halve, true);
  const old = r.hintOn(r.token);
  old.timestamp = Date.now() - D.HOLD_MS - 10;
  assert.equal((await D.skipDamaged(old.id, true)).state, "skipped");
});

test("п.3: срок — expireFor гасит pending по паре «карточка + токен» (в т. ч. ×0), чужую пару и used не трогает; смена хода гасит прошлый ход", async () => {
  const w = world({ mode: "off" });
  const r = reactor(w);
  const a = r.hintOn(r.token, { turn: "c1:1:0" }), b = r.hintOn(r.famToken, { turn: "c1:1:0" }), u = r.hintOn(r.token, { state: "used", decision: {}, turn: "c1:1:0" });
  for (const h of [a, u]) r.token.flags[MOD] = { damagedHold: { ...holdOn(r.token), [h.id]: { message: r.dmg.id, state: h.flags[MOD].damaged.state } } };
  r.famToken.flags[MOD] = { damagedHold: { [b.id]: { message: r.dmg.id, state: "pending" } } };
  await D.expireFor(r.dmg.id, r.token.uuid);
  assert.equal(a.flags[MOD].damaged.state, "expired");
  assert.equal(holdOn(r.token)[a.id], undefined);
  assert.equal(b.flags[MOD].damaged.state, "pending");   // другая цель
  assert.equal(u.flags[MOD].damaged.state, "used");
  await D.onCombat({ id: "c1", started: true, round: 2, turn: 0 }, { round: 2 });
  assert.equal(b.flags[MOD].damaged.state, "expired");
  assert.equal(holdOn(r.famToken)[b.id], undefined);
  assert.equal(holdOn(r.token)[u.id], undefined);       // неиспользованное решение снято с токена
  assert.equal(u.flags[MOD].damaged.state, "used");
});

/* ---------- п.2, 3, 7: применение ---------- */

function applyWorld({ src = "M1" } = {}) {
  const w = world();
  const real = w.actor("target", { getContextualClone(options, effects) { real.last = { options, effects }; return { clone: true, uuid: "Actor.target" }; }, _source: { items: [], flags: { pf2e: { rollOptions: { all: {} } } } } });
  const token = w.tokenOf(real, "TT");
  const socket = [];
  setSocket({ executeAsUser: async (name, _id, ...args) => { socket.push([name, ...args]); return handlers[name]?.(...args) ?? { ok: true, result: { ok: true } }; } });
  const handlers = {};
  const opts = (damage = 10, extra = {}) => ({ damage, token, rollOptions: new Set(src ? [`${MOD}:basic:${src}:k`] : []), ...extra });
  return { w, real, token, socket, handlers, opts };
}

test("п.2/3: решение применяется к урону своей карточки: уменьшение, отметка отката, after зовёт ГМа с итогом и списком; чужая карточка и повтор — не трогаются", async () => {
  const x = applyWorld();
  x.token.flags[MOD] = { damagedHold: {
    h1: { message: "M1", state: "used", turn: null, rev: 0, name: "Щит", decision: { reduce: 4, halve: false, redirect: null } },
    h2: { message: "M2", state: "used", turn: null, rev: 0, name: "Чужой", decision: { reduce: 9 } }
  } };
  const r = await D.onApply({ uuid: "Actor.target" }, x.opts(10), { click: null });
  assert.equal(r.opts.damage, 6);                              // только h1: 10 - 4
  assert.ok(r.opts.rollOptions.has(D.markOf("h1")) && !r.opts.rollOptions.has(D.markOf("h2")));
  assert.equal(r.actor.clone, true);
  r.after();
  await new Promise((res) => setTimeout(res, 5));
  assert.deepEqual(x.socket, [["damagedAfter", "h1", 10, ["h1"]]]);
  assert.equal(await D.onApply({ uuid: "Actor.target" }, x.opts(10), {}), undefined);   // h1 этим клиентом уже применено
});

test("п.2/3: источник — клик pf2e (снимок ctx.click), не метка basic-damage; неизвестный источник — все записи этого хода", async () => {
  const x = applyWorld({ src: null });
  x.token.flags[MOD] = { damagedHold: { ck1: { message: "M1", state: "used", turn: null, rev: 0, name: "n", decision: { halve: true } }, ck2: { message: "M2", state: "used", turn: null, rev: 0, name: "n", decision: { reduce: 1 } } } };
  const r = await D.onApply({ uuid: "Actor.target" }, x.opts(10), { click: { id: "M2" } });
  assert.equal(r.opts.damage, 9);   // решение ck2 после долгого удержания всё ещё привязано к карточке клика
  const y = applyWorld({ src: null });
  y.token.flags[MOD] = { damagedHold: { ck3: { message: "M1", state: "used", turn: null, rev: 0, name: "n", decision: { reduce: 2 } } } };
  assert.equal((await D.onApply({ uuid: "Actor.target" }, y.opts(10), { click: null })).opts.damage, 8);
  const z = applyWorld({ src: null });
  z.token.flags[MOD] = { damagedHold: { ck4: { message: "M1", state: "used", turn: "old:1:0", rev: 0, name: "n", decision: { reduce: 2 } } } };
  game.combats = [{ id: "new", started: true, round: 1, turn: 0, active: true, scene: "s", combatants: [{ actor: z.real }] }];
  assert.equal(await D.onApply({ uuid: "Actor.target" }, z.opts(10), { click: null }), undefined);   // запись прошлого хода без известного источника не применяется
});

test("п.3: ожидание — решение пришло по токену; таймаут ждёт ответа skipDamaged, поздний used применяется, used после ухода урона не висит", async (t) => {
  const x = applyWorld();
  const until = Date.now() + 60000;
  x.token.flags[MOD] = { damagedHold: { w1: { message: "M1", state: "pending", turn: null, rev: 0, name: "n", until } } };
  Hooks.on = (name, fn) => { if (name === "updateToken") setTimeout(() => { x.token.flags[MOD].damagedHold.w1 = { message: "M1", state: "used", turn: null, rev: 0, name: "n", decision: { reduce: 3 } }; fn(); }, 10); };
  const r = await D.onApply({ uuid: "Actor.target" }, x.opts(10), {});
  assert.equal(r.opts.damage, 7);
  globalThis.Hooks = { on() {}, off() {} };

  const y = applyWorld();
  y.token.flags[MOD] = { damagedHold: { h9: { message: "M1", state: "pending", turn: null, rev: 0, name: "n", until } } };
  y.handlers.skipDamaged = (id, timeout) => ({ ok: true, result: { ok: true, skipped: true, state: "used", hold: { message: "M1", state: "used", rev: 0, name: "n", decision: { halve: true } } } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const p = D.onApply({ uuid: "Actor.target" }, y.opts(10), {});
  for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res));
  t.mock.timers.tick(D.HOLD_MS);
  const late = await p;
  t.mock.timers.reset();
  assert.deepEqual(y.socket[0], ["skipDamaged", "h9", true]);   // ждём ответ ГМа, а не решаем сами
  assert.equal(late.opts.damage, 5);                              // used, пришедшее в последний момент, не потеряно

  const z = applyWorld();
  z.token.flags[MOD] = { damagedHold: { h8: { message: "M1", state: "pending", turn: null, rev: 0, name: "n", until: Date.now() - 1 } } };
  assert.equal(await D.onApply({ uuid: "Actor.target" }, z.opts(10), {}), undefined);   // зависшая запись не держит урон
  assert.equal(z.socket.length, 0);
});

test("п.7: resist — эффект Resistance уходит в клон только этого нанесения, урон не режется, эфемерные эффекты старого клона переносятся", async () => {
  const x = applyWorld();
  x.token.flags[MOD] = { damagedHold: { rs1: { message: "M1", state: "used", turn: null, rev: 0, name: "Колючка", decision: { resist: [{ type: "piercing", value: 5 }] } } } };
  const eph = { id: "eph", type: "effect", toObject: () => ({ _id: "eph", type: "effect", name: "damage-received" }) };
  const clone = { items: [eph], flags: { pf2e: { rollOptions: { all: { "origin:enemy": true } } } } };
  const r = await D.onApply(clone, x.opts(10), {});
  assert.equal(r.opts.damage, 10);
  assert.deepEqual(x.real.last.options, ["origin:enemy"]);
  assert.equal(x.real.last.effects[0]._id, "eph");
  assert.deepEqual(x.real.last.effects[1].system.rules, [{ key: "Resistance", type: "piercing", value: 5 }]);
});

/* ---------- п.8, 10: перенос и откат ---------- */

test("п.10: перенос считает ГМ по решению, а не по числу от клиента; клиентский итог ограничен броском карточки; повтор не удваивает", async () => {
  const w = world();
  const owner = w.actor("owner", { update: async function (ch) { this.hp = ch["system.attributes.hp.value"]; }, system: { attributes: { hp: { value: 20, max: 20 } } } });
  const tokenA = w.tokenOf(w.actor("tgt"), "TT");
  const dmg = w.message({ rolls: [{ total: 20 }] });
  const mk = (id, dec) => { const m = w.message({ flags: { [MOD]: { damaged: { message: dmg.id, token: tokenA.uuid, actor: owner.uuid, state: "used", rev: 0, decision: dec } } } }); m.id = id; return m; };
  const h1 = mk("h1", { redirect: "half", hp: 2 });
  assert.equal((await D.settle("h1", 9999, ["h1"])).ok, true);
  assert.equal(owner.hp, 20 - (10 + 2));                    // половина от min(9999, бросок 20) + цена 2
  assert.equal(h1.flags[MOD].damaged.done, true);
  assert.equal(h1.flags[MOD].damaged.applied, 12);
  assert.equal((await D.settle("h1", 9999, ["h1"])).skipped, true);
  assert.equal(owner.hp, 8);
  // два решения вместе: второе считает остаток после первого
  owner.hp = undefined;
  const a = mk("a", { reduce: 4 }), b = mk("b", { redirect: "all" });
  await D.settle("b", 10, ["a", "b"]);
  assert.equal(owner.hp, 20 - 6);                           // b берёт остаток 10 - 4
  void a;
});

test("п.8: откат damage-taken возвращает перенос и цену, решение снова не израсходовано (rev растёт, запись на токене вернулась)", async () => {
  const w = world();
  const owner = w.actor("owner", { update: async function (ch) { this.hp = ch["system.attributes.hp.value"]; }, system: { attributes: { hp: { value: 8, max: 20 } } } });
  const tgt = w.actor("tgt"), token = w.tokenOf(tgt, "TT");
  const hint = w.message({ flags: { [MOD]: { damaged: { message: "D", token: token.uuid, actor: owner.uuid, state: "used", rev: 0, done: true, applied: 5, decision: { redirect: "all" }, itemName: "Щит" } } } });
  await D.onUpdate({ flags: { pf2e: { context: { options: [D.markOf(hint.id)] } } } }, { flags: { pf2e: { appliedDamage: { isReverted: true } } } });
  assert.equal(owner.hp, 13);
  const h = hint.flags[MOD].damaged;
  assert.equal(h.done, false);
  assert.equal(h.rev, 1);
  const e = holdOn(token)[hint.id];
  assert.equal(e.state, "used");
  assert.equal(e.rev, 1);
  // не откат (isReverted не менялся) и чужие сообщения — ничего
  await D.onUpdate({ flags: { pf2e: { context: { options: [D.markOf(hint.id)] } } } }, { content: "x" });
  assert.equal(owner.hp, 13);
  // повторное нанесение применит возвращённое решение, а прежняя ревизия — нет
  const consumedOld = D.holdsFor(holdOn(token), "D", null, new Set([`${hint.id}:0`]));
  assert.deepEqual(consumedOld.map((x) => x.id), [hint.id]);
});
