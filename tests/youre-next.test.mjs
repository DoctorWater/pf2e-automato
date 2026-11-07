// L1-R3 «Ты следующий» (docs/plan-youre-next.md): hp0, поле записи cost/free, гейт, дедуп пачки, трата после подтверждения, откат, кандидаты, бросок, форма.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const settings = {};
let msgs, uuids, created, dialogs, flags, now;
const setDeep = (o, path, v) => { const ks = path.split("."), last = ks.pop(); ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v; };
globalThis.game = {
  user: { isActiveGM: true, id: "gm" },
  settings: { get: (_m, k) => settings[k] },
  i18n: { localize: (k) => k, format: (k) => k },
  modules: { get: () => null },
  messages: { get: (id) => msgs.get(id), get contents() { return [...msgs.values()]; } },
  pf2e: { ConditionManager: { conditions: new Map() } },
  combat: null,
  get combats() { return this.combat ? [this.combat] : []; }
};
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async (u) => uuids.get(u) ?? null;
globalThis.fromUuidSync = (u) => uuids.get(u) ?? null;
// окно выбора: dialogs.pick — индекс варианта (null — закрыто); запоминаем html, чтобы видеть кандидатов
globalThis.foundry = { applications: { api: { DialogV2: { wait: async (c) => { dialogs.shown.push(c.content); await dialogs.before?.(); return dialogs.pick == null ? null : { action: "ok", form: { choice: String(dialogs.pick) } }; } } } },
  data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { escapeHTML: (s) => String(s), deepClone: (o) => structuredClone(o), setProperty: setDeep, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
globalThis.CONFIG = { PF2E: {}, Canvas: { polygonBackends: { move: { testCollision: () => false } } } };
globalThis.ChatMessage = { create: async (d) => { const m = { id: `H${created.length + 1}`, ...d, async delete() { msgs.delete(this.id); } }; created.push(m); msgs.set(m.id, m); return m; }, getSpeaker: () => ({}), getWhisperRecipients: () => [] };

const { MOD } = await import("../scripts/util.mjs");
const rules = await import("../scripts/rules.mjs");
const ev = await import("../scripts/events.mjs");
const reactions = await import("../scripts/reactions.mjs");
const checks = await import("../scripts/checks.mjs");
const { ruleToForm, formToRule } = await import("../scripts/sheet.mjs");
const catalog = (await import("node:fs")).readFileSync(new URL("../rules/catalog.json", import.meta.url), "utf8");
const NEXT = "Compendium.pf2e.feats-srd.Item.gjec0ts3wkFbjvHN";
const ENTRY = JSON.parse(catalog).bySource[NEXT].onEvent[0];
const validate = rules.validateRule;
const EFF = "Compendium.pf2e.spell-effects.Item.RfCEHpMoEAZvB9IZ";

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.effect": "auto", "mode.apply": "auto", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: false, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map(); created = []; dialogs = { shown: [], pick: 0 }; flags = {}; now = 1_000_000;
  globalThis.game.combat = null;
  Date.now = () => now;
});

/* ---------- мир ---------- */

const scene = { tokens: [], grid: { size: 100, measurePath: ([a, b]) => ({ distance: (Math.hypot(a.x - b.x, a.y - b.y) / 100) * 5 }) } };
scene.tokens.filter = Array.prototype.filter;
let seq = 0;
// актёр с токеном на сцене: враг/союзник — по полю side; ОЗ — hitPoints
function mkActor(name, { side = "foe", hp = 10, x = 0, items = [], opts = [] } = {}) {
  const id = `${name}${++seq}`;
  const a = { uuid: `Actor.${id}`, name, id, level: 3, alliance: side === "foe" ? "opposition" : "party", items, itemTypes: { condition: [], effect: [] }, hitPoints: { value: hp }, side, _flags: {}, _opts: opts,
    getRollOptions: () => a._opts, getSelfRollOptions: (p) => [`${p}:test`], isEnemyOf: (o) => o.side !== a.side, isAllyOf: (o) => o.side === a.side,
    getFlag: (_m, k) => a._flags[k], async setFlag(_m, k, v) { a._flags[k] = v; }, async unsetFlag(_m, k) { delete a._flags[k]; } };
  const tok = { id: `T${id}`, uuid: `Scene.s.Token.T${id}`, name, actor: a, parent: scene, x: x * 100, y: 0, width: 1, height: 1, disposition: side === "foe" ? -1 : 1 };
  a.getActiveTokens = () => [tok]; a.token = tok;
  scene.tokens.push(tok);
  for (const i of items) { i.actor = a; i.parent = a; uuids.set(i.uuid, i); }
  uuids.set(a.uuid, a); uuids.set(tok.uuid, tok);
  return a;
}
const mkFeat = (rule) => ({ type: "feat", id: "yn", uuid: "Actor.rogue.Item.yn", name: "You're Next", slug: "youre-next", system: {}, flags: { [MOD]: { rule } } });
const rogueRule = (entry = ENTRY) => validate({ v: 1, onEvent: [entry] }).rule;
function world(entry = ENTRY, { legendary = false } = {}) {
  scene.tokens.length = 0;
  const rogue = mkActor("rogue", { side: "pc", x: 0, items: [mkFeat(rogueRule(entry))], opts: legendary ? ["skill:intimidation:rank:4"] : [] });
  const victim = mkActor("victim", { hp: 0, x: 1 });
  const near = mkActor("near", { x: 2 }), dead = mkActor("dead", { hp: 0, x: 3 }), far = mkActor("far", { x: 50 }), friend = mkActor("friend", { side: "pc", x: 2 });
  return { rogue, victim, near, dead, far, friend };
}
const startCombat = (...actors) => { globalThis.game.combat = { id: "c1", round: 1, started: true, active: true, scene: "s", combatants: actors.map((a) => ({ actorId: a.id, actor: a })) }; };
let msgN = 0;
// сообщение damage-taken: урон дошёл до ОЗ жертвы (hitPoints выставлены в world), автор — rogue
const dmgMsg = (w, { origin = "Item.sword", applied = { updates: [{ path: "system.attributes.hp.value", value: 5 }] }, options = ["origin:enemy"], actor = w.victim, id = `D${++msgN}` } = {}) => {
  const m = { id, flags: { pf2e: { context: { type: "damage-taken", options }, origin: { actor: w.rogue.uuid, uuid: origin }, ...(applied && { appliedDamage: applied }) } }, rolls: [], actor, async update(d) { for (const [k, v] of Object.entries(d)) setDeep(m, k, v); } };
  msgs.set(id, m);
  return m;
};

/* ---------- 1. опция damage-taken:hp0 (настоящий messageOptions) ---------- */

test("messageOptions: hp0 — урон дошёл до ОЗ и жертва на 0", () => {
  const w = world();
  const opts = (m, actor = w.victim) => ev.messageOptions(m, { actor, target: null, origin: w.rogue }, "damage-taken").set;
  const o = opts(dmgMsg(w));
  assert.ok(o.has("damage-taken:hp") && o.has("damage-taken:hp0") && o.has("origin:enemy"));
  w.victim.hitPoints.value = 3;
  assert.equal(opts(dmgMsg(w)).has("damage-taken:hp0"), false);   // ещё жива
  w.victim.hitPoints.value = 0;
  assert.equal(opts(dmgMsg(w, { applied: { isHealing: true, updates: [{ path: "system.attributes.hp.value", value: 5 }] } })).has("damage-taken:hp0"), false);   // лечение
  assert.equal(opts(dmgMsg(w, { applied: { isReverted: true, updates: [{ path: "system.attributes.hp.value", value: 5 }] } })).has("damage-taken:hp"), true);   // откат отсекает onMessage, не опции
  assert.equal(opts(dmgMsg(w, { applied: { updates: [{ path: "system.attributes.hp.temp", value: 5 }] } })).has("damage-taken:hp0"), false);   // только временные ОЗ
  assert.equal(opts(dmgMsg(w, { applied: { updates: [], shield: { damage: 4 } } })).has("damage-taken:hp0"), false);   // щит
  assert.equal(opts(dmgMsg(w, { applied: { updates: [{ path: "system.attributes.hp.value", value: 0 }] } })).has("damage-taken:hp0"), false);   // уже лежал: дельты нет
  const grp = opts(dmgMsg(w, { options: ["origin:ally"] }));   // pf2e копит origin:* по всем целям группы: берём по паре жертва/автор
  assert.ok(grp.has("origin:enemy") && !grp.has("origin:ally"));
  assert.ok(opts(dmgMsg(w, { options: ["origin:enemy"] }), w.friend).has("origin:ally") && !opts(dmgMsg(w, { options: ["origin:enemy"] }), w.friend).has("origin:enemy"));
  const sys = { system: { attributes: { hp: { value: 0 } } }, getSelfRollOptions: () => [], getRollOptions: () => [] };   // без hitPoints — system.attributes.hp
  assert.equal(opts(dmgMsg(w), sys).has("damage-taken:hp0"), true);
});

/* ---------- 2. валидатор ---------- */

test("валидатор: запись черты проходит; cost/free только как положено; check на damage-taken", () => {
  assert.deepEqual(validate({ v: 1, onEvent: [ENTRY] }).errors, []);
  const out = validate({ v: 1, onEvent: [ENTRY] }).rule.onEvent[0];
  assert.equal(out.cost, "reaction"); assert.deepEqual(out.free, ENTRY.free);
  assert.ok(out.check.options.includes("youre-next") && out.check.options.includes("action:demoralize"));
  const bad = (patch) => validate({ v: 1, onEvent: [{ ...ENTRY, ...patch }] }).ok;
  assert.equal(bad({ cost: "x" }), false);
  assert.equal(bad({ cost: true }), false);
  assert.equal(bad({ cost: undefined }), false);   // free без cost
  assert.equal(bad({ free: "skill:x" }), false);   // free — предикат
  assert.equal(bad({ apply: [{ to: "self", effect: { uuid: "Compendium.pf2e.spell-effects.Item.RfCEHpMoEAZvB9IZ" } }, ENTRY.apply[0]] }), false);   // выбор — первым шагом
  assert.equal(bad({ on: "turn-start", side: "self" }), false);   // полная проверка — только после урона
  assert.equal(bad({ check: { ...ENTRY.check, vs: undefined } }), false);   // без vs
  assert.equal("cost" in validate({ v: 1, onUse: { targets: "self", apply: [{ effect: { uuid: EFF } }], cost: "reaction" } }).rule.onUse, false);   // cost живёт только у onEvent
});

/* ---------- 3-8. исполнение ---------- */

const run = (m) => ev.onMessage(m);
const asked = () => dialogs.shown.length;
const hostCards = () => created.filter((c) => c.flags?.[MOD]?.use);

test("гейт: реакция доступна — окно, трата, карточка проверки; потрачена в раунде — тишина; новый раунд — снова", async () => {
  const w = world(); startCombat(w.rogue);
  await run(dmgMsg(w));
  assert.equal(asked(), 1);
  assert.deepEqual(w.rogue._flags.reactionSpent, { combat: "c1", round: 1 });
  assert.equal(hostCards().length, 1);
  await run(dmgMsg(w, { origin: "Item.other" }));   // другая пачка в том же раунде: реакции нет — окна нет
  assert.equal(asked(), 1);
  globalThis.game.combat.round = 2;
  now += 10_000;
  await run(dmgMsg(w, { origin: "Item.third" }));
  assert.equal(asked(), 2);
});

test("гейт: noReactions и не-враг/лечение/не лёг — окна нет", async () => {
  const w = world(); startCombat(w.rogue);
  const { NO_REACTIONS } = await import("../scripts/workshop/effect.mjs");
  w.rogue._opts = [NO_REACTIONS];
  await run(dmgMsg(w));
  assert.equal(asked(), 0);
  w.rogue._opts = [];
  w.friend.hitPoints.value = 0;
  await run(dmgMsg(w, { actor: w.friend, options: ["origin:enemy"] }));   // групповое применение: ctx.options врага, а жертва — союзник
  await run(dmgMsg(w, { applied: { isHealing: true, updates: [{ path: "system.attributes.hp.value", value: 5 }] } }));
  w.victim.hitPoints.value = 4;   // не лёг
  await run(dmgMsg(w));
  assert.equal(asked(), 0);
});

test("free (ранг 4): окно при каждом падении, реакция не тратится", async () => {
  const w = world(ENTRY, { legendary: true }); startCombat(w.rogue);
  await run(dmgMsg(w, { origin: "Item.a" }));
  now += 10_000;
  await run(dmgMsg(w, { origin: "Item.b" }));
  assert.equal(asked(), 2);
  assert.equal(w.rogue._flags.reactionSpent, undefined);
  assert.equal(hostCards().length, 2);
});

test("дедуп: два сообщения одного источника — одно окно; отказ не блокирует раунд, новая пачка спрашивает", async () => {
  const w = world(); startCombat(w.rogue);
  dialogs.pick = null;   // закрыл окно
  await Promise.all([run(dmgMsg(w, { origin: "Item.fireball" })), run(dmgMsg(w, { origin: "Item.fireball" }))]);
  assert.equal(asked(), 1);
  assert.equal(w.rogue._flags.reactionSpent, undefined);   // отказ — реакция цела
  assert.equal(hostCards().length, 0);
  now += 6000;   // следующая пачка
  dialogs.pick = 0;
  await run(dmgMsg(w, { origin: "Item.fireball" }));
  assert.equal(asked(), 2);
  assert.ok(w.rogue._flags.reactionSpent);
});

test("трата после подтверждения: реакцию потратили, пока окно было открыто, — без траты и проверки", async () => {
  const w = world(); startCombat(w.rogue);
  dialogs.before = async () => { w.rogue._flags.reactionSpent = { combat: "c1", round: 1 }; };
  await run(dmgMsg(w));
  assert.equal(asked(), 1);
  assert.equal(hostCards().length, 0);
  assert.deepEqual(w.rogue._flags.reactionSpent, { combat: "c1", round: 1 });
});

test("кандидаты: без жертвы, лежащих, союзников и дальше 60 фт; нет кандидатов — окна и траты нет", async () => {
  const w = world(); startCombat(w.rogue);
  await run(dmgMsg(w));
  const html = dialogs.shown[0];
  assert.ok(html.includes("near"));
  for (const x of [w.victim, w.dead, w.far, w.friend]) assert.equal(html.includes(x.name), false, x.name);
  scene.tokens.splice(scene.tokens.findIndex((t) => t.actor === w.near), 1);
  now += 10_000; globalThis.game.combat.round = 2;
  const before = asked();
  await run(dmgMsg(w, { origin: "Item.z" }));
  assert.equal(asked(), before);
  assert.equal(w.rogue._flags.reactionSpent.round, 1);
});

test("журнал: op reactionSpent с prev; откат карточки урона возвращает флаг и удаляет карточку проверки", async () => {
  const w = world(); startCombat(w.rogue);
  const prev = { combat: "c0", round: 7 };   // флаг прежнего боя доступность не ломает
  w.rogue._flags.reactionSpent = prev;
  const m = dmgMsg(w);
  await run(m);
  const rec = m.flags[MOD].events[0];
  const op = rec.recs.flatMap((r) => r.ops).find((o) => o.op === "reactionSpent");
  assert.deepEqual(op.prev, prev);
  assert.equal(op.actor, w.rogue.uuid);
  assert.equal(hostCards().length, 1);
  await ev.onUpdateMessage(m, { flags: { pf2e: { appliedDamage: { isReverted: true } } } });
  assert.deepEqual(w.rogue._flags.reactionSpent, prev);
  assert.equal(msgs.has(rec.host), false);
  const w2 = world(); startCombat(w2.rogue);   // без прежнего флага откат его снимает
  const m2 = dmgMsg(w2, { origin: "Item.n" });
  await run(m2);
  assert.ok(w2.rogue._flags.reactionSpent);
  await ev.onUpdateMessage(m2, { flags: { pf2e: { appliedDamage: { isReverted: true } } } });
  assert.equal(w2.rogue._flags.reactionSpent, undefined);
});

test("повтор того же сообщения не открывает окно и не тратит заново", async () => {
  const w = world(); startCombat(w.rogue);
  const m = dmgMsg(w);
  await run(m); await run(m);
  assert.equal(asked(), 1);
});

test("бросок: карточка проверки несёт полную Деморализацию, rollCheck кладёт action:demoralize и youre-next в extraRollOptions", async () => {
  const w = world(); startCombat(w.rogue);
  await run(dmgMsg(w));
  const card = hostCards()[0], use = card.flags[MOD].use, ck = use.rule.onUse.check;
  assert.equal(ck.statistic, "intimidation"); assert.deepEqual(ck.vs, { defense: "will" });
  assert.equal(ck.immunity.slug, "demoralize"); assert.deepEqual(Object.keys(ck.byDegree).sort(), ["criticalSuccess", "success"]);
  assert.equal(use.targets[0].uuid, w.near.token.uuid);   // цель — выбранный враг
  let params;
  w.rogue.getStatistic = () => ({ check: { roll: async (p) => { params = p; return { degreeOfSuccess: 2, total: 20, dice: [] }; } } });
  w.near.saves = { will: { dc: { value: 15 } } };
  const r = await checks.rollCheck(w.rogue, ck, { message: card, tokenKey: use.targets[0].key, target: w.near.token });
  assert.ok(r);
  assert.ok(params.extraRollOptions.includes("action:demoralize") && params.extraRollOptions.includes("youre-next"));
});

test("запись без choose: окно да/нет, трата после «да»", async () => {
  const w = world({ on: "damage-taken", side: "origin", when: ["damage-taken:hp0"], cost: "reaction", apply: [{ to: "self", effect: { uuid: EFF } }] });
  startCombat(w.rogue);
  dialogs.pick = null;
  await run(dmgMsg(w));
  assert.equal(asked(), 1); assert.equal(w.rogue._flags.reactionSpent, undefined);
  now += 6000; dialogs.pick = 0;
  await run(dmgMsg(w, { origin: "Item.q" }));
  assert.equal(asked(), 2); assert.ok(w.rogue._flags.reactionSpent);
});

/* ---------- 9. форма ---------- */

test("форма: evRule(evForm(e)) сохраняет cost/free/check/choose; запись без cost не обрастает полями", () => {
  const rule = rogueRule();
  const back = formToRule(ruleToForm(rule));
  const e = back.onEvent[0];
  assert.equal(e.cost, "reaction"); assert.deepEqual(e.free, ENTRY.free); assert.deepEqual(e.check, rule.onEvent[0].check);
  assert.deepEqual(e.apply[0].choose, rule.onEvent[0].apply[0].choose);
  assert.deepEqual(validate(back).errors, []);
  const plain = formToRule(ruleToForm(validate({ v: 1, onEvent: [{ on: "damage-roll", apply: [{ removeEffect: { slug: "x" } }] }] }).rule)).onEvent[0];
  assert.equal("cost" in plain, false); assert.equal("free" in plain, false);
});

test("spendReaction: вне боя флаг не ставится; в бою — prev", async () => {
  const w = world();
  assert.equal(await reactions.spendReaction(w.rogue, null), null);
  startCombat(w.rogue);
  assert.deepEqual(await reactions.spendReaction(w.rogue, null), { prev: null, set: { combat: "c1", round: 1 } });
});

test("кандидаты: враг с иммунитетом проверки от этого плута не предлагается", async () => {
  const w = world(); startCombat(w.rogue);
  const imm = ENTRY.check.immunity;
  w.near.items = [{ type: "effect", system: { context: { origin: { actor: w.rogue.uuid } } }, flags: { [MOD]: { immunity: { slug: imm.slug } } }, _stats: {} }];
  const b = mkActor("second", { x: 4 });
  await run(dmgMsg(w));
  const html = dialogs.shown[0];
  assert.equal(html.includes("near"), false);
  assert.ok(html.includes("second") && b);
});

test("mode.challenge=off: запись с проверкой молчит до окна, реакция цела", async () => {
  const w = world(); startCombat(w.rogue);
  settings["mode.challenge"] = "off";
  await run(dmgMsg(w));
  assert.equal(asked(), 0);
  assert.equal(w.rogue._flags.reactionSpent, undefined);
});

test("откат урона, пока окно открыто: реакция не тратится, карточки проверки нет", async () => {
  const w = world(); startCombat(w.rogue);
  const m = dmgMsg(w);
  dialogs.before = async () => { m.flags.pf2e.appliedDamage.isReverted = true; };
  await run(m);
  assert.equal(asked(), 1);
  assert.equal(w.rogue._flags.reactionSpent, undefined);
  assert.equal(hostCards().length, 0);
});

test("откат reactionSpent: чужой более поздний флаг не затирается", async () => {
  const w = world(); startCombat(w.rogue);
  const m = dmgMsg(w);
  await run(m);
  w.rogue._flags.reactionSpent = { combat: "c1", round: 2 };   // позже поставили другой раунд
  await ev.onUpdateMessage(m, { flags: { pf2e: { appliedDamage: { isReverted: true } } } });
  assert.deepEqual(w.rogue._flags.reactionSpent, { combat: "c1", round: 2 });
});

test("валидатор: cost без шагов apply (только challenge) и choose по вариантам — отказ", () => {
  const ch = { statistic: "will", dc: { value: 15 }, basic: false, rollerRole: "target", byDegree: { success: [{ to: "target", note: "x" }] } };
  assert.equal(validate({ v: 1, onEvent: [{ on: "damage-taken", side: "origin", cost: "reaction", challenge: ch }] }).ok, false);
  const opt = { to: "self", choose: { from: "options", options: ["a", "b"] } };
  assert.equal(validate({ v: 1, onEvent: [{ on: "damage-taken", side: "origin", cost: "reaction", apply: [opt] }] }).ok, false);
});
