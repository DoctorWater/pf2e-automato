// Событие «ПЗ упали до 0»: onEvent damage-taken + hp0 + use -> useOnce (карточка предмета); валидатор, форма «Когда», повторный удар, откат, цепочка
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const settings = {};
let msgs, uuids, created, dialogs, now = 1_000_000;
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
globalThis.foundry = { applications: { api: { DialogV2: { wait: async (c) => { dialogs.shown.push(c.content); return dialogs.pick == null ? null : { action: "ok", form: { choice: String(dialogs.pick) } }; } } } },
  data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { escapeHTML: (s) => String(s), deepClone: (o) => structuredClone(o), setProperty: setDeep, getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
globalThis.CONFIG = { PF2E: {}, Canvas: { polygonBackends: { move: { testCollision: () => false } } } };
globalThis.ChatMessage = { create: async (d) => { const m = { id: `H${created.length + 1}`, ...d, async delete() { msgs.delete(this.id); } }; created.push(m); msgs.set(m.id, m); return m; }, getSpeaker: () => ({}), getWhisperRecipients: () => [] };

const { MOD, useTargetOverride } = await import("../scripts/util.mjs");
const lib = await import("../scripts/builtin/lib.mjs");
const rules = await import("../scripts/rules.mjs");
const ev = await import("../scripts/events.mjs");
const { ruleToForm, formToRule, HP0 } = await import("../scripts/sheet.mjs");
const au = await import("../scripts/workshop/automation.mjs");
const validate = rules.validateRule;

beforeEach(() => {
  Object.assign(settings, { "mode.challenge": "auto", "mode.effect": "auto", "mode.apply": "auto", "mode.macro": "auto", useToolbeltTargetHelper: false, yieldToAutomations: false, resumeMinutes: 30 });
  msgs = new Map(); uuids = new Map(); created = []; dialogs = { shown: [], pick: 0 };
  globalThis.game.combat = null;
  Date.now = () => now;
});

/* ---------- мир ---------- */

const scene = { tokens: [], grid: { size: 100, measurePath: ([a, b]) => ({ distance: (Math.hypot(a.x - b.x, a.y - b.y) / 100) * 5 }) } };
let seq = 0, used, usedTargets;
// владелец с предметом-взрывом: toMessage — «карточка предмета» (без state.event, как обычное использование)
function mkOwner(name, entry, { hp = 0, x = 0 } = {}) {
  const id = `${name}${++seq}`, rule = validate({ v: 1, onEvent: [entry] }).rule;
  const item = { type: "feat", id: "boom", uuid: `Actor.${id}.Item.boom`, name: "Death Throes", slug: "death-throes", system: {}, flags: { [MOD]: { rule } },
    async toMessage() { used.push(name); usedTargets.push(useTargetOverride.get(`Actor.${id}`)); await ChatMessage.create({ flags: { [MOD]: { use: { actor: `Actor.${id}`, state: {} } } } }); } };
  const a = { uuid: `Actor.${id}`, name, id, level: 3, alliance: "opposition", items: [item], itemTypes: { condition: [], effect: [] }, hitPoints: { value: hp }, _flags: {},
    getRollOptions: () => [], getSelfRollOptions: (p) => [`${p}:test`], getFlag: (_m, k) => a._flags[k], async setFlag(_m, k, v) { a._flags[k] = v; }, async unsetFlag(_m, k) { delete a._flags[k]; } };
  const tok = { id: `T${id}`, uuid: `Scene.s.Token.T${id}`, name, actor: a, parent: scene, x: x * 100, y: 0, width: 1, height: 1 };
  a.getActiveTokens = () => [tok]; a.token = tok;
  item.actor = a; item.parent = a; uuids.set(item.uuid, item); uuids.set(a.uuid, a); uuids.set(tok.uuid, tok);
  return a;
}
const HP0_ENTRY = { on: "damage-taken", side: "self", when: ["damage-taken:hp0"], use: true };
let msgN = 0;
const dmgMsg = (actor, { applied = { updates: [{ path: "system.attributes.hp.value", value: 5 }] }, options = [] } = {}) => {
  const id = `D${++msgN}`;
  const m = { id, flags: { pf2e: { context: { type: "damage-taken", options }, ...(applied && { appliedDamage: applied }) } }, rolls: [], actor, async update(d) { for (const [k, v] of Object.entries(d)) setDeep(m, k, v); } };
  msgs.set(id, m);
  return m;
};
beforeEach(() => { used = []; usedTargets = []; });

/* ---------- валидатор ---------- */

test("use: валидная запись без шагов; use без владельца-источника и не true — отказ", () => {
  const r = validate({ v: 1, onEvent: [HP0_ENTRY] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rule.onEvent[0], { on: "damage-taken", side: "self", when: ["damage-taken:hp0"], use: true });
  for (const bad of [{ ...HP0_ENTRY, use: "yes" }, { ...HP0_ENTRY, use: false }, { on: "attack-roll", side: "target", use: true }, { on: "turn-end", side: "origin", use: true },
    { ...HP0_ENTRY, challenge: { statistic: "fortitude", dc: { value: 20 }, byDegree: { failure: [{ to: "target", condition: { slug: "frightened", value: 1 } }] } } }, { ...HP0_ENTRY, check: { stat: "athletics", dc: 20 } }])   // use + испытание/проверка: у записи одна карточка-хозяин для отката
    assert.equal(validate({ v: 1, onEvent: [bad] }).ok, false, JSON.stringify(bad));
  assert.equal(validate({ v: 1, onEvent: [{ on: "damage-taken", side: "self" }] }).ok, false);   // без use и шагов запись по-прежнему пуста
});

test("use + cost:reaction: шаги не нужны (подтверждение — окно да/нет), без use и шагов реакция отвергается", () => {
  assert.deepEqual(validate({ v: 1, onEvent: [{ ...HP0_ENTRY, cost: "reaction" }] }).errors, []);
  assert.equal(validate({ v: 1, onEvent: [{ on: "damage-taken", side: "self", cost: "reaction" }] }).ok, false);
});

/* ---------- Мастерская: «ПЗ упали до 0» туда-обратно ---------- */

test("«Когда»: hp0 читается из правила и пишется обратно; условие hp0 не попадает в текст «Условие»", () => {
  for (const when of [["damage-taken:hp0"], ["damage-taken:hp0", "origin:enemy"]]) {
    const raw = { v: 1, onEvent: [{ on: "damage-taken", side: "self", when, use: true }] };
    const rule = validate(raw).rule, form = ruleToForm(rule);
    assert.equal(form.ev[0].on, HP0);
    assert.equal(form.ev[0].use, true);
    assert.equal(form.ev[0].when, when.slice(1).join(", "));
    assert.deepEqual(validate(formToRule(form, rule)).rule.onEvent, rule.onEvent);
  }
  const plain = validate({ v: 1, onEvent: [{ on: "damage-taken", side: "self", when: ["origin:enemy"], apply: [{ removeEffect: { slug: "x" } }] }] }).rule;
  assert.equal(ruleToForm(plain).ev[0].on, "damage-taken");   // обычный «получен урон» остаётся собой
  assert.deepEqual(validate(formToRule(ruleToForm(plain), plain)).rule.onEvent, plain.onEvent);
});

test("«Когда»: у hp0 только владелец; смена события сбрасывает сторону", () => {
  assert.deepEqual(au.evSides({ on: HP0 }), ["self"]);
  const e = { on: HP0, side: "origin", afterUse: true };
  au.evOnChanged(e, HP0);
  assert.equal(e.side, "self");
  assert.equal(e.afterUse, false);
});

/* ---------- исполнение ---------- */

test("hp0: урон довёл до 0 — предмет использован один раз; повтор того же сообщения не запускает", async () => {
  const a = mkOwner("zombie", HP0_ENTRY);
  const m = dmgMsg(a);
  await ev.onMessage(m);
  assert.deepEqual(used, ["zombie"]);
  await ev.onMessage(m);
  assert.equal(used.length, 1);
  assert.equal(created.some((c) => c.flags?.[MOD]?.use?.state?.event), false);   // карточка — обычная, не «испытание события»
});

test("hp0: ПЗ ещё выше 0, лечение, откат, удар по уже нулевым ПЗ (appliedDamage без изменения ПЗ) — не запускают", async () => {
  const alive = mkOwner("alive", HP0_ENTRY, { hp: 4 });
  await ev.onMessage(dmgMsg(alive));
  const dead = mkOwner("dead", HP0_ENTRY);
  await ev.onMessage(dmgMsg(dead, { applied: { isHealing: true, updates: [{ path: "system.attributes.hp.value", value: 5 }] } }));
  await ev.onMessage(dmgMsg(dead, { applied: { isReverted: true, updates: [{ path: "system.attributes.hp.value", value: 5 }] } }));
  await ev.onMessage(dmgMsg(dead, { applied: null }));   // pf2e: урона по ПЗ нет (уже 0) — appliedDamage не пишется
  await ev.onMessage(dmgMsg(dead, { applied: { updates: [{ path: "system.attributes.hp.temp", value: 2 }] } }));   // урон ушёл во временные ПЗ
  assert.deepEqual(used, []);
});

test("режим effect выключен — тишина", async () => {
  settings["mode.effect"] = "off"; settings["mode.challenge"] = "off";
  await ev.onMessage(dmgMsg(mkOwner("zombie", HP0_ENTRY)));
  assert.deepEqual(used, []);
});

test("не активный ГМ — не используется", async () => {
  globalThis.game.user.isActiveGM = false;
  try { await ev.onMessage(dmgMsg(mkOwner("zombie", HP0_ENTRY))); } finally { globalThis.game.user.isActiveGM = true; }
  assert.deepEqual(used, []);
});

test("реакция + use: окно да/нет, трата после подтверждения; отказ — предмет не использован, реакция цела; откат урона возвращает реакцию", async () => {
  globalThis.game.combat = { id: "c1", round: 1, started: true, active: true, scene: "s", combatants: [] };
  const a = mkOwner("brute", { ...HP0_ENTRY, cost: "reaction" });
  globalThis.game.combat.combatants = [{ actorId: a.id, actor: a }];
  dialogs.pick = null;
  await ev.onMessage(dmgMsg(a));
  assert.deepEqual(used, []);
  assert.equal(a._flags.reactionSpent, undefined);
  dialogs.pick = 0;
  now += 10_000;   // окно отказа закрыло пачку на 5 с
  const m = dmgMsg(a);
  await ev.onMessage(m);
  assert.deepEqual(used, ["brute"]);
  assert.ok(a._flags.reactionSpent);
  await ev.onUpdateMessage(m, { flags: { pf2e: { appliedDamage: { isReverted: true } } } });
  assert.equal(a._flags.reactionSpent, undefined);
  assert.equal(created.filter((c) => c.flags?.[MOD]?.use && msgs.has(c.id)).length, 0);   // карточка взрыва из журнала удалена откатом
});

test("откат урона без реакции тоже удаляет карточку (host в журнале)", async () => {
  const a = mkOwner("zombie", HP0_ENTRY), m = dmgMsg(a);
  await ev.onMessage(m);
  assert.equal(created.filter((c) => msgs.has(c.id)).length, 1);
  await ev.onUpdateMessage(m, { flags: { pf2e: { appliedDamage: { isReverted: true } } } });
  assert.equal(created.filter((c) => msgs.has(c.id)).length, 0);
});

test("use: цели карточки смерти — источник урона, а не мертвец; нет источника — пусто; useOnce без токена не падает", async () => {
  const a = mkOwner("zombie", HP0_ENTRY), killer = mkOwner("killer", HP0_ENTRY, { hp: 9, x: 1 });
  const m = dmgMsg(a); m.flags.pf2e.origin = { actor: killer.uuid };
  const k = dmgMsg(a); // без источника
  await ev.onMessage(m);
  assert.deepEqual(usedTargets[0].map((t) => t.id), [killer.token.id]);
  const b = mkOwner("zombie2", HP0_ENTRY);
  await ev.onMessage(dmgMsg(b));
  assert.deepEqual(usedTargets[1], []);
  assert.ok(k);
  const c = mkOwner("zombie3", HP0_ENTRY);
  assert.ok(await lib.useOnce(c, c.items[0], null));
  assert.deepEqual(usedTargets[2], []);
  assert.equal(useTargetOverride.has(c.uuid), false);
});

test("use: событие от сообщения этого же предмета (урон от собственного взрыва) его не использует", async () => {
  const a = mkOwner("zombie", HP0_ENTRY), m = dmgMsg(a);
  m.flags.pf2e.origin = { uuid: a.items[0].uuid };
  await ev.onMessage(m);
  assert.deepEqual(used, []);
});

test("use: режим effect не auto — шёпот ГМу, предмет не использован", async () => {
  settings["mode.effect"] = "manual";
  await ev.onMessage(dmgMsg(mkOwner("zombie", HP0_ENTRY)));
  assert.deepEqual(used, []);
  assert.equal(created.length, 1);
  assert.ok(created[0].whisper);
});

test("use: только damage-taken, turn-start, turn-end; сброс флажка при смене события и стороны", () => {
  assert.equal(validate({ v: 1, onEvent: [{ on: "turn-end", side: "self", use: true }] }).ok, true);
  for (const on of ["attack-roll", "damage-roll", "spell-cast", "saving-throw", "effect-created"]) assert.equal(validate({ v: 1, onEvent: [{ on, side: "self", use: true }] }).ok, false, on);
  const e = { on: "damage-taken", side: "self", use: true };
  au.evOnChanged(e, "damage-roll");
  assert.equal(e.use, false);
  const e2 = { on: "turn-end", side: "self", use: true };
  au.evOnChanged(e2, "enter");
  assert.equal(e2.use, false);
});

test("цепочка: карточка взрыва не гасит события урона у соседей (нет state.event); соседний взрыв срабатывает от урона по карточке первого", async () => {
  const a = mkOwner("first", HP0_ENTRY), b = mkOwner("second", HP0_ENTRY);
  await ev.onMessage(dmgMsg(a));
  const card = created.find((c) => c.flags?.[MOD]?.use);
  assert.ok(card);
  // урон модуля по карточке первого взрыва: маркер в опциях сообщения урона соседа
  await ev.onMessage(dmgMsg(b, { options: [`${MOD}:${card.id}:Tx`] }));
  assert.deepEqual(used, ["first", "second"]);
  // для сравнения: карточка испытания события (state.event) события у соседей гасит
  const c = await ChatMessage.create({ flags: { [MOD]: { use: { state: { event: "k" } } } } });
  const third = mkOwner("third", HP0_ENTRY);
  await ev.onMessage(dmgMsg(third, { options: [`${MOD}:${c.id}:Tx`] }));
  assert.deepEqual(used, ["first", "second"]);
});
