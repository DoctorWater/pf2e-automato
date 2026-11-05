// Подпачка 0.5g4: шаги choose (выбор игрока) и to:"chosen", шаг damage, condition.policy:"reduce", срок эффекта (duration у шага effect, в том числе кубик).
// Схема + форма туда-обратно + рантайм (apply.mjs) + текст шага (chat.mjs) на фикстурах без Foundry.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const settings = {};
let msgs, uuids;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
globalThis.game = {
  user: { isActiveGM: true, id: "gm" },
  users: [],
  settings: { get: (_m, k) => settings[k] },
  i18n: { localize: (k) => k, format: (k) => k },
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } },
  pf2e: { ConditionManager: { conditions: new Map() } }
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), mergeObject: function merge(a, b) { for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? merge(a[k], v) : v; return a; }, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
globalThis.CONFIG = { PF2E: { Item: { documentClasses: { effect: { validTraits: {} } } } }, Canvas: { polygonBackends: { move: { testCollision: () => false } } }, Dice: { rolls: [] } };
globalThis.ChatMessage = { create: async () => {}, getWhisperRecipients: () => [] };
globalThis.Roll = class { constructor(f) { this.f = f; } async evaluate() { this.total = Roll.next; return this; } };
Roll.next = 3;

const { MOD, setSocket } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const { ruleToForm, formToRule } = await import("../scripts/sheet.mjs");
const { applyOps, undoOps } = await import("../scripts/apply.mjs");
const { stepText } = await import("../scripts/chat.mjs");

const validate = rules.validateRule;
const back = (rule) => validate(formToRule(ruleToForm(rule)));
const EFF = "Compendium.pf2e.spell-effects.Item.RfCEHpMoEAZvB9IZ", EFF2 = "Compendium.pf2e.spell-effects.Item.BBBBBBBBBBBBBBBB";
const ok = (apply) => validate({ v: 1, onUse: { targets: "self", apply } });
const bad = (apply) => assert.equal(ok(apply).ok, false, JSON.stringify(apply));

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.apply": "auto", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: true, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map();
  game.users = [];
  setSocket(null);
});

/* ---------- схема ---------- */

test("choose: из союзников, врагов и вариантов; to — только self; options с уникальными кодами; range — только у существ", () => {
  const good = (c) => ok([{ to: "self", choose: c }]);
  assert.deepEqual(good({ from: "allies" }).rule.onUse.apply, [{ to: "self", choose: { from: "allies" } }]);
  assert.deepEqual(good({ from: "enemies", range: 30, prompt: "Кого?" }).rule.onUse.apply[0].choose, { from: "enemies", prompt: "Кого?", range: 30 });
  assert.deepEqual(good({ from: "options", options: ["bullet", { value: "bolt", label: "Болт" }] }).rule.onUse.apply[0].choose.options, [{ value: "bullet" }, { value: "bolt", label: "Болт" }]);
  // получатель choose не указывают: у choose он всегда self; другой — ошибка
  assert.equal(validate({ v: 1, onUse: { targets: "selected", challenge: { statistic: "will", dc: { value: 20 }, byDegree: { failure: [{ choose: { from: "allies" } }] } }, apply: [] } }).rule.onUse.challenge.byDegree.failure[0].to, "self");
  for (const c of [{}, { from: "x" }, { from: "options" }, { from: "options", options: [] }, { from: "options", options: ["a", "a"] }, { from: "options", options: ["Bad Slug"] }, { from: "options", options: ["a"], range: 5 },
    { from: "allies", options: ["a"] }, { from: "allies", range: 3 }, { from: "allies", prompt: "" }, null, "allies"]) assert.equal(good(c).ok, false, JSON.stringify(c));
  bad([{ to: "target", choose: { from: "allies" } }]);
  bad([{ to: "self", choose: { from: "allies" }, effect: { uuid: EFF } }]);   // ровно один вид шага
});

test("to:chosen — только после choose из allies/enemies в том же списке; для видимости не годится", () => {
  assert.equal(ok([{ to: "self", choose: { from: "allies" } }, { to: "chosen", effect: { uuid: EFF } }]).ok, true);
  assert.equal(ok([{ to: "self", choose: { from: "enemies" } }, { to: "chosen", condition: { slug: "off-guard" } }]).ok, true);
  bad([{ to: "chosen", effect: { uuid: EFF } }]);
  bad([{ to: "self", choose: { from: "options", options: ["a"] } }, { to: "chosen", effect: { uuid: EFF } }]);   // выбор варианта не называет существо
  bad([{ to: "chosen", effect: { uuid: EFF } }, { to: "self", choose: { from: "allies" } }]);   // выбор позже шага
  bad([{ to: "self", choose: { from: "allies" } }, { to: "chosen", visibility: { level: "hidden", of: "self" } }]);
  // when: выбранный вариант — опция choice:<value>
  assert.equal(ok([{ to: "self", choose: { from: "options", options: ["a", "b"] } }, { to: "self", effect: { uuid: EFF }, when: ["choice:a"] }]).ok, true);
});

test("damage: формула кубиков или переменных, тип урона или healing", () => {
  const dmg = (d) => ok([{ to: "target", damage: d }]);
  assert.deepEqual(dmg({ formula: "2d6 + 3", damageType: "fire" }).rule.onUse.apply[0].damage, { formula: "2d6+3", damageType: "fire" });
  assert.equal(dmg({ formula: "@actor.level", damageType: "fire" }).ok, true);
  assert.equal(dmg({ formula: "(floor((max(6,@actor.level)-6)/2)+2)d8+4", damageType: "healing" }).ok, true);
  for (const d of [{ formula: "bad", damageType: "fire" }, { formula: "1d6", damageType: "plasma" }, { formula: "1d6" }, { damageType: "fire" }, null, "1d6"]) assert.equal(dmg(d).ok, false, JSON.stringify(d));
  bad([{ to: "target", damage: { formula: "1d6", damageType: "fire" }, note: "x" }]);
});

test("condition.policy:reduce: значение — на сколько снизить; срока нет", () => {
  assert.deepEqual(ok([{ to: "allies", range: 15, condition: { slug: "frightened", policy: "reduce" } }]).rule.onUse.apply[0].condition, { slug: "frightened", policy: "reduce" });
  assert.equal(ok([{ to: "self", condition: { slug: "frightened", value: 2, policy: "reduce" } }]).rule.onUse.apply[0].condition.value, 2);
  bad([{ to: "self", condition: { slug: "frightened", policy: "reduce" }, duration: { value: 1, unit: "rounds" } }]);
  bad([{ to: "self", condition: { slug: "frightened", policy: "lower" } }]);
});

test("duration у шага effect: число, кубик, конец хода; у состояния прежние правила; of — только у состояния", () => {
  const eff = (d) => ok([{ to: "target", effect: { uuid: EFF }, ...(d && { duration: d }) }]);
  assert.deepEqual(eff({ value: 8, unit: "hours" }).rule.onUse.apply[0].duration, { value: 8, unit: "hours", expiry: null });
  assert.deepEqual(eff({ value: "1D4", unit: "rounds", expiry: "turn-start" }).rule.onUse.apply[0].duration, { value: "1d4", unit: "rounds", expiry: "turn-start" });
  assert.deepEqual(eff({ value: 0, unit: "rounds", expiry: "turn-end" }).rule.onUse.apply[0].duration, { value: 0, unit: "rounds", expiry: "turn-end" });
  for (const d of [{ value: 0, unit: "rounds" }, { value: "d4", unit: "rounds" }, { value: "1d4+1", unit: "rounds" }, { value: 1, unit: "years" }, { value: 1, unit: "rounds", expiry: "never" }, { value: 1, unit: "rounds", of: "origin" }]) assert.equal(eff(d).ok, false, JSON.stringify(d));
  // кубик и у состояния: срок обёртки бросается при выдаче (Оружие небожителя: слепота на 1d4 раундов)
  assert.deepEqual(ok([{ to: "target", condition: { slug: "blinded" }, duration: { value: "1D4", unit: "rounds", expiry: "turn-end" } }]).rule.onUse.apply[0].duration, { value: "1d4", unit: "rounds", expiry: "turn-end", of: "origin" });
  bad([{ to: "target", condition: { slug: "blinded" }, duration: { value: "1d4+1", unit: "rounds" } }]);
  assert.equal(ok([{ to: "target", condition: { slug: "slowed" }, duration: { value: 1, unit: "rounds", of: "target" } }]).ok, true);
});

/* ---------- форма туда-обратно ---------- */

test("форма: choose, chosen, damage, reduce и срок эффекта проходят туда-обратно без потерь", () => {
  const rule = { v: 1, onUse: { targets: "self", apply: [
    { to: "self", choose: { from: "options", options: [{ value: "a", label: "А" }, { value: "b" }], prompt: "Что?" } },
    { to: "self", choose: { from: "allies", range: 60 } },
    { to: "chosen", effect: { uuid: EFF }, when: ["choice:a"] },
    { to: "target", damage: { formula: "2d6+@actor.level", damageType: "fire" } },
    { to: "self", damage: { formula: "1d8", damageType: "healing" } },
    { to: "allies", range: 15, condition: { slug: "frightened", value: 2, policy: "reduce" } },
    { to: "target", effect: { uuid: EFF2 }, duration: { value: "1d4", unit: "rounds", expiry: "turn-end" } },
    { to: "target", effect: { uuid: EFF }, duration: { value: 8, unit: "hours", expiry: null } }
  ] } };
  const v = validate(rule);
  assert.equal(v.ok, true, v.errors?.join("; "));
  const r = back(v.rule);
  assert.equal(r.ok, true, r.errors?.join("; "));
  assert.deepEqual(r.rule, v.rule);
  const ev = { v: 1, onEvent: [{ on: "turn-end", side: "self", apply: [{ to: "self", choose: { from: "enemies" } }, { to: "chosen", damage: { formula: "1d6", damageType: "mental" } }] }] };
  assert.deepEqual(back(validate(ev).rule).rule, validate(ev).rule);
});

/* ---------- рантайм ---------- */

const mkEffect = (o = {}) => ({
  type: "effect", id: o.id ?? "e1", uuid: `Actor.hero.Item.${o.id ?? "e1"}`, slug: o.slug ?? "rage", name: o.slug ?? "rage", _stats: { compendiumSource: o.src ?? EFF }, flags: {},
  system: { duration: o.duration ?? { value: 1, unit: "minutes", expiry: null }, badge: null, context: { origin: { actor: "Actor.hero" } } },
  toObject() { return { name: this.name, type: "effect", system: structuredClone(this.system), _id: this.id, flags: {} }; }
});
const mkActor = (uuid, extra = {}) => {
  const a = { uuid, name: uuid, level: 5, attributes: {}, items: [], itemTypes: { condition: [], effect: [] }, rollOptions: {}, getActiveTokens: () => [], ...extra };
  a.createEmbeddedDocuments = async (_t, docs) => docs.map((d) => { const e = mkEffect({ id: `n${a.itemTypes.effect.length}` }); e.system = d.system; e.name = d.name; e.actor = a; a.itemTypes.effect.push(e); a.items = a.itemTypes.effect; return e; });
  uuids.set(uuid, a);
  return a;
};
const mkMsg = (use, extra = {}) => {
  const m = { id: "M1", flags: { [MOD]: { use } }, async update(d) { for (const [k, v] of Object.entries(d)) setDeep(m, k, v); }, ...extra };
  msgs.set(m.id, m);
  return m;
};
const use = (extra = {}) => ({ kind: "use", actor: "Actor.hero", targets: [], state: {}, rule: { onUse: {} }, item: { uuid: null, name: "Тест" }, ...extra });
const src = (id = "x") => ({ type: "effect", name: id, toObject: () => ({ name: id, type: "effect", system: { rules: [], context: {}, level: { value: 1 }, duration: { value: 10, unit: "minutes", expiry: null } }, flags: {} }) });

test("reduce: значение падает на n, на нуле состояние снимается, откат возвращает; повтор шага не снижает дважды", async () => {
  const hero = mkActor("Actor.hero");
  const frightened = { id: "c1", uuid: "Actor.hero.Item.c1", slug: "frightened", isLocked: false, grantedBy: null, actor: hero, system: { value: { value: 3 } } };
  hero.itemTypes.condition = [frightened];
  uuids.set(frightened.uuid, frightened);
  game.pf2e.ConditionManager.updateConditionValue = async (_id, _a, v) => { frightened.system.value.value = v; };
  hero.decreaseCondition = async (c) => { hero.itemTypes.condition = hero.itemTypes.condition.filter((x) => x !== c); };
  const m = mkMsg(use());
  const step = (value) => [{ to: "self", condition: { slug: "frightened", policy: "reduce", ...(value && { value }) } }];
  const [op] = await applyOps(m, "self", step(), { scope: "apply" });
  assert.deepEqual(op, { op: "raised", item: frightened.uuid, prev: 3, key: "M1:self:0" });
  assert.equal(frightened.system.value.value, 2);
  assert.deepEqual(await applyOps(m, "self", step(), { scope: "apply" }), []);   // тот же шаг того же сообщения
  assert.equal(frightened.system.value.value, 2);
  await undoOps(m, "self");
  assert.equal(frightened.system.value.value, 3);
  // снизить на 3 — состояние уходит; откат ставит его заново (состояния у фикстуры нет: проверяем запись)
  const m2 = mkMsg(use()); m2.id = "M2";
  const [gone] = await applyOps(m2, "self", step(3), { scope: "apply" });
  assert.deepEqual(gone, { op: "removed", actor: "Actor.hero", slug: "frightened", prev: 3, key: "M2:self:0" });
  assert.equal(hero.itemTypes.condition.length, 0);
  // нет состояния — пропуск; без значения (не valued) — пропуск
  assert.deepEqual(await applyOps(mkMsg(use(), { id: "M3" }), "self", step(), { scope: "apply" }), []);
});

test("damage: DamageRoll по формуле с переменными -> applyDamage с токеном; лечение — отрицательное число без IWR; повтор не бьёт дважды", async () => {
  const rolled = [];
  CONFIG.Dice.rolls = [class DamageRoll { constructor(f) { this.f = f; rolled.push(f); } async evaluate() { this.total = 7; return this; } }];
  const hits = [];
  const tok = { id: "t", actor: null, parent: {} };
  const hero = mkActor("Actor.hero");
  const foe = mkActor("Actor.foe", { level: 3, applyDamage: async (d) => { hits.push(d); } });
  tok.actor = foe;
  hero.applyDamage = async (d) => { hits.push(d); };
  const m = mkMsg(use());
  const dmg = [{ to: "target", damage: { formula: "2d6+@actor.level", damageType: "fire" } }];
  const [op] = await applyOps(m, "t", dmg, { scope: "apply", target: tok });
  assert.deepEqual(rolled, ["(2d6+5)[fire]"]);   // @actor.level — уровень автора (hero 5)
  assert.equal(hits.length, 1);
  assert.equal(hits[0].token, tok);
  assert.equal(hits[0].damage.total, 7);
  assert.deepEqual(op, { op: "damaged", actor: "Actor.foe", amount: 7, key: "M1:t:0" });
  assert.deepEqual(await applyOps(m, "t", dmg, { scope: "apply", target: tok }), []);   // уже нанесено
  assert.equal(hits.length, 1);
  // лечение себя
  const heal = await applyOps(mkMsg(use(), { id: "M2" }), "self", [{ to: "self", damage: { formula: "1d8+4", damageType: "healing" } }], { scope: "apply" });
  assert.equal(heal[0].op, "damaged");
  assert.equal(hits[1].damage, -7);
  assert.equal(hits[1].skipIWR, true);
  // нулевая формула — шага нет
  assert.deepEqual(await applyOps(mkMsg(use(), { id: "M3" }), "self", [{ to: "self", damage: { formula: "0", damageType: "fire" } }], { scope: "apply" }), []);
  // откат урон не трогает (pf2e откатывает своей карточкой), а запись не ломает
  await undoOps(m, "t");
});

test("effect.duration: срок шага заменяет срок эффекта; кубик бросается; expiry без указания — из эффекта", async () => {
  const hero = mkActor("Actor.hero");
  uuids.set(EFF, Object.assign(src("a"), { uuid: EFF }));
  uuids.set(EFF2, src("b"));
  Roll.next = 3;
  const m = mkMsg(use());
  await applyOps(m, "self", [{ to: "self", effect: { uuid: EFF }, duration: { value: "1d4", unit: "rounds", expiry: "turn-start" } }, { to: "self", effect: { uuid: EFF2 }, duration: { value: 8, unit: "hours", expiry: null } }], { scope: "apply" });
  assert.deepEqual(hero.itemTypes.effect.map((e) => e.system.duration), [{ value: 3, unit: "rounds", expiry: "turn-start" }, { value: 8, unit: "hours", expiry: null }]);
  // без duration — срок из самого эффекта
  const m2 = mkMsg(use(), { id: "M2" });
  hero.itemTypes.effect = []; hero.items = [];
  await applyOps(m2, "self", [{ to: "self", effect: { uuid: EFF } }], { scope: "apply" });
  assert.deepEqual(hero.itemTypes.effect[0].system.duration, { value: 10, unit: "minutes", expiry: null });
});

test("choose из союзников: окно у игрока-автора, выбранный получает шаги to:chosen; повтор не спрашивает и не дублирует", async () => {
  const asked = [];
  setSocket({ executeAsUser: async (name, uid, data) => { asked.push([name, uid, data]); return data.choices[1].value; } });   // второй союзник
  const hero = mkActor("Actor.hero", { isAllyOf: (a) => a.ally, isEnemyOf: (a) => !a.ally, testUserPermission: () => true });
  const bob = mkActor("Actor.bob", { ally: true, token: { name: "Боб" } }), eve = mkActor("Actor.eve", { ally: true }), foe = mkActor("Actor.foe", { ally: false });
  const toks = [{ id: "h", actor: hero }, { id: "b", actor: bob }, { id: "e", actor: eve }, { id: "f", actor: foe }];
  const scene = { tokens: { filter: (fn) => toks.filter(fn) } };
  uuids.set("Scene.s.Token.h", { id: "h", actor: hero, parent: scene, name: "H" });
  uuids.set(EFF, src("a"));
  const player = { id: "p1", isGM: false, active: true };
  const m = mkMsg(use({ token: "Scene.s.Token.h" }), { author: player });
  const steps = [{ to: "self", choose: { from: "allies", prompt: "Кому помочь?" } }, { to: "chosen", effect: { uuid: EFF } }];
  const ops = await applyOps(m, "self", steps, { scope: "apply" });
  assert.equal(asked.length, 1);
  assert.deepEqual([asked[0][0], asked[0][1], asked[0][2].prompt, asked[0][2].choices.map((c) => c.value)], ["pickChoice", "p1", "Кому помочь?", ["Actor.bob", "Actor.eve"]]);
  assert.deepEqual(ops.map((o) => o.op), ["chose", "created"]);
  assert.equal(eve.itemTypes.effect.length, 1);
  assert.equal(bob.itemTypes.effect.length, 0);
  assert.equal(hero.itemTypes.effect.length, 0);
  // повтор: ответ взят из записи, окно не открывается, эффект не дублируется
  assert.deepEqual(await applyOps(m, "self", steps, { scope: "apply" }), []);
  assert.equal(asked.length, 1);
  assert.equal(eve.itemTypes.effect.length, 1);
  // закрытое окно — шаги с выбранным пропускаются
  setSocket({ executeAsUser: async () => null });
  assert.deepEqual(await applyOps(mkMsg(use({ token: "Scene.s.Token.h" }), { id: "M2", author: player }), "self", steps, { scope: "apply" }), []);
  // враги: только враги автора
  const seen = [];
  setSocket({ executeAsUser: async (_n, _u, d) => { seen.push(d.choices.map((c) => c.value)); return d.choices[0].value; } });
  await applyOps(mkMsg(use({ token: "Scene.s.Token.h" }), { id: "M3", author: player }), "self", [{ to: "self", choose: { from: "enemies" } }, { to: "chosen", effect: { uuid: EFF } }], { scope: "apply" });
  assert.deepEqual(seen, [["Actor.foe"]]);
  assert.equal(foe.itemTypes.effect.length, 1);
  // откат: выбор не откатывается, созданное — снимается
  await undoOps(m, "self");
});

test("choose из вариантов: выбранное — опция choice:<value> для when следующих шагов, в том числе в других вызовах applyOps с общим picks (запись onEvent)", async () => {
  setSocket({ executeAsUser: async (_n, _u, d) => d.choices.find((c) => c.value === "armor").value });
  const hero = mkActor("Actor.hero", { testUserPermission: () => true });
  game.users = [{ id: "p1", isGM: false, active: true }];
  uuids.set(EFF, src("armor-fx")); uuids.set(EFF2, src("weapon-fx"));
  const twin = mkMsg(use());   // у двойника события автора нет — спросит игрока-владельца актёра
  const picks = { opts: new Set(), actor: null };
  const ctx = { scope: "apply", picks };
  const pick = { to: "self", choose: { from: "options", options: [{ value: "armor", label: "Броня" }, { value: "weapon", label: "Оружие" }] } };
  await applyOps(twin, "self", [pick], { ...ctx, stepKey: "0.0" });
  assert.deepEqual([...picks.opts], ["choice:armor"]);
  await applyOps(twin, "self", [{ to: "self", effect: { uuid: EFF }, when: ["choice:armor"] }], { ...ctx, stepKey: "0.1" });
  await applyOps(twin, "self", [{ to: "self", effect: { uuid: EFF2 }, when: ["choice:weapon"] }], { ...ctx, stepKey: "0.2" });
  assert.deepEqual(hero.itemTypes.effect.map((e) => e.name), ["armor-fx"]);
  // единственный вариант выбирается без окна
  setSocket({ executeAsUser: async () => { throw new Error("не должно спрашивать"); } });
  const p2 = { opts: new Set(), actor: null };
  await applyOps(mkMsg(use(), { id: "M2" }), "self", [{ to: "self", choose: { from: "options", options: [{ value: "only" }] } }], { scope: "apply", picks: p2 });
  assert.deepEqual([...p2.opts], ["choice:only"]);
});

/* ---------- текст шага ---------- */

test("stepText: выбор, выбранный получатель, урон, лечение, снижение", () => {
  const env = { t: (k, d) => (d ? `${k}:${JSON.stringify(d)}` : k), conditionLabel: (s) => s, uuidName: () => null, damageLabel: (x) => x };
  assert.equal(stepText({ to: "self", choose: { from: "allies" } }, env, "self"), 'chat.stepChoose.allies:{"options":""}');
  assert.match(stepText({ to: "self", choose: { from: "options", options: [{ value: "a", label: "А" }, { value: "b" }] } }, env, "self"), /А \/ b/);
  assert.match(stepText({ to: "chosen", effect: { uuid: EFF } }, env, "self"), /^chat\.stepChosen/);
  assert.match(stepText({ to: "target", damage: { formula: "2d6", damageType: "fire" } }, env, "target"), /^chat\.stepTarget:.*chat\.stepDamage/);
  assert.match(stepText({ to: "self", damage: { formula: "1d8", damageType: "healing" } }, env, "self"), /chat\.stepHeal/);
  assert.match(stepText({ to: "allies", range: 15, condition: { slug: "frightened", policy: "reduce" } }, env, "self"), /chat\.stepReduce/);
});

test("choose from allies {of:target, withSelf}: кандидаты — союзники вокруг цели и сам автор (Защитная статуэтка); без of центр — автор, withSelf его не исключает («вы или союзник»)", async () => {
  const seen = [];
  setSocket({ executeAsUser: async (_n, _u, d) => { seen.push(d.choices.map((c) => c.value)); return d.choices[0].value; } });
  const hero = mkActor("Actor.hero", { isAllyOf: (a) => a.ally, isEnemyOf: (a) => !a.ally, testUserPermission: () => true });
  const bob = mkActor("Actor.bob", { ally: true }), foe = mkActor("Actor.foe", { ally: false });
  const at = (id, actor, x, y) => ({ id, actor, x, y, width: 1, height: 1, name: id });   // клетка 100 px = 5 фт; герой и Боб в 5 фт от врага
  const toks = [at("h", hero, 0, 100), at("b", bob, 100, 0), at("f", foe, 0, 0)];
  const scene = { grid: { size: 100, measurePath: ([p, q]) => ({ distance: Math.hypot(p.x - q.x, p.y - q.y) / 20 }) }, tokens: { filter: (fn) => toks.filter(fn) } };
  toks.forEach((t) => { t.parent = scene; });
  const [tHero, , tFoe] = toks;
  uuids.set("Scene.s.Token.h", tHero);
  uuids.set(EFF, src("a"));
  const player = { id: "p1", isGM: false, active: true };
  const run = (c, id) => applyOps(mkMsg(use({ token: "Scene.s.Token.h" }), { id, author: player }), "self", [{ to: "self", choose: c }, { to: "chosen", effect: { uuid: EFF } }], { scope: "apply", target: tFoe });
  await run({ from: "allies", range: 5, of: "target" }, "M1");
  await run({ from: "allies", range: 5, of: "target", withSelf: true }, "M2");
  await run({ from: "allies", range: 5, withSelf: true }, "M3");   // центр — сам автор: Боб в 7 фт, автор — кандидат
  assert.deepEqual(seen, [["Actor.bob"], ["Actor.hero", "Actor.bob"], ["Actor.hero"]]);
  assert.equal(validate({ v: 1, onUse: { targets: "self", apply: [{ to: "self", choose: { from: "enemies", withSelf: true } }] } }).ok, false);   // withSelf — только у союзников
});
