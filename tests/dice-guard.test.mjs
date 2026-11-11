// Ожидание анимации Dice So Nice перед автоприменением: фоновая вкладка не ждёт; сообщение, удалённое за время ожидания, не применяется.
import { test } from "node:test";
import assert from "node:assert/strict";

const msgs = new Map();
const dsn = (onWait) => ({ waitFor3DAnimationByMessageID: async (id) => { await onWait?.(id); return true; } });
globalThis.game = { user: { isActiveGM: true, isGM: true }, users: [], modules: { get: () => null }, settings: { get: () => "auto" }, i18n: { localize: (k) => k, format: (k) => k }, messages: { get: (id) => msgs.get(id) ?? null, has: (id) => msgs.has(id) }, combats: [] };
globalThis.ui = { notifications: { warn() {}, info() {} } };
globalThis.fromUuid = async () => null;
globalThis.fromUuidSync = () => null;
globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o), setProperty() {} } };
const { afterDice } = await import("../scripts/util.mjs");
const bd = await import("../scripts/builtin/basic-damage.mjs");
const events = await import("../scripts/events.mjs");
const use = await import("../scripts/use.mjs");

test("afterDice: вкладка в фоне (document.hidden) — не ждёт", async () => {
  let called = 0;
  game.dice3d = dsn(() => { called++; });
  globalThis.document = { hidden: true };
  try { await afterDice("m1"); } finally { delete globalThis.document; }
  assert.equal(called, 0);
});

test("basic-damage.settle: сообщение урона удалено за время ожидания анимации — урон не наносится", async () => {
  msgs.set("d1", { id: "d1", flags: { "pf2e-automato": { basicDamage: { card: "c1", done: {} } } } });
  game.dice3d = dsn(() => msgs.delete("d1"));
  const res = await bd.settle("d1");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no-link");
});

test("basic-damage.settle manual (кнопка ГМа) не ждёт анимацию", async () => {
  let called = 0;
  msgs.set("d2", { id: "d2", flags: { "pf2e-automato": { basicDamage: { card: "nope", done: {} } } } });
  game.dice3d = dsn(() => { called++; });
  const res = await bd.settle("d2", { manual: true });
  assert.equal(called, 0);
  assert.equal(res.reason, "no-card");
});

test("events.onMessage: бросок удалён за время ожидания — дальше не идёт (актёр не читается)", async () => {
  const mk = (id) => { const t = { touched: false }; return { t, m: { id, rolls: [{}], flags: { pf2e: { context: { type: "attack-roll", options: [] } } }, get actor() { t.touched = true; return null; }, get token() { t.touched = true; return null; }, get item() { t.touched = true; return null; } } }; };
  const a = mk("e1"), b = mk("e2");
  msgs.set("e1", a.m); msgs.set("e2", b.m);
  game.dice3d = dsn((id) => { if (id === "e2") msgs.delete("e2"); });
  await events.onMessage(a.m).catch(() => {});
  await events.onMessage(b.m).catch(() => {});
  assert.equal(a.t.touched, true, "контроль: без удаления onMessage читает стороны");
  assert.equal(b.t.touched, false);
});

test("use.onCreateMessage: бросок удалён за время ожидания — применение не идёт", async () => {
  const mk = (id) => { const t = { touched: false }; return { t, m: { id, flags: { pf2e: { context: { type: "saving-throw", options: [] } } }, get rolls() { t.touched = true; return []; } } }; };
  const a = mk("u1"), b = mk("u2");
  msgs.set("u1", a.m); msgs.set("u2", b.m);
  game.dice3d = dsn((id) => { if (id === "u2") msgs.delete("u2"); });
  await use.onCreateMessage(a.m).catch(() => {});
  await use.onCreateMessage(b.m).catch(() => {});
  assert.equal(a.t.touched, true, "контроль: без удаления acceptSavingThrow читает rolls");
  assert.equal(b.t.touched, false);
});
