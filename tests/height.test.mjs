// height.mjs на заглушках foundry: выбор высоты, ожидание конца движения, одно обновление на движение.
import { test } from "node:test";
import assert from "node:assert/strict";

class Field { constructor(o) { this.o = o; } }
globalThis.foundry = { data: { fields: { NumberField: Field }, regionBehaviors: { RegionBehaviorType: class {} } } };
const { heightAt, settleHeight, HeightBehaviorType } = await import("../scripts/height.mjs");

const T = "pf2e-automato.height";
const region = (id, ...behaviors) => ({ id, behaviors });
const hb = (height, disabled = false) => ({ type: T, disabled, system: { height } });

function mkToken(regions, inside, extra = {}) {
  const updates = [];
  return {
    uuid: "Scene.s.Token.t", elevation: 0, rendered: false, updates,
    parent: { regions },
    testInsideRegion: (r) => inside.includes(r.id),
    update: async (d) => { updates.push(d); },
    ...extra
  };
}

test("heightAt: регион, где стоит токен; пересечение — наибольшая; выключенное и чужие поведения не в счёт", () => {
  const regs = [region("bank", hb(10)), region("roof", hb(25)), region("off", hb(40, true)), region("fog", { type: "pf2e-automato.zone", system: {} })];
  assert.equal(heightAt(mkToken(regs, ["bank"])), 10);
  assert.equal(heightAt(mkToken(regs, ["bank", "roof"])), 25);
  assert.equal(heightAt(mkToken(regs, ["off", "fog"])), null);
  assert.equal(heightAt(mkToken(regs, [])), null);
  assert.equal(heightAt(mkToken([region("road", hb(0))], ["road"])), 0);   // 0 — тоже высота, не «нет региона»
});

test("settleHeight: ждёт конца движения, одно обновление на движение, без обновления при совпадении", async () => {
  let finish;
  const movement = { id: "m1", finished: new Promise((r) => { finish = r; }) };
  const t = mkToken([region("bank", hb(10))], ["bank"], { movement });
  const a = settleHeight(t), b = settleHeight(t);   // второй регион того же движения
  await Promise.resolve();
  assert.equal(t.updates.length, 0);   // движение ещё идёт
  finish(true);
  await Promise.all([a, b]);
  assert.deepEqual(t.updates, [{ elevation: 10 }]);

  const same = mkToken([region("road", hb(0))], ["road"], { uuid: "Scene.s.Token.u" });
  await settleHeight(same);   // создание токена: движения нет, высота уже совпадает
  assert.equal(same.updates.length, 0);
});

test("settleHeight: не пишет, если началось новое движение, оно не завершено или токен на лестнице смены уровня", async () => {
  const bank = region("bank", hb(10));
  const run = async (uuid, mutate, regions = [bank], inside = ["bank"]) => {
    let finish;
    const movement = { id: "m1", state: "completed", finished: new Promise((r) => { finish = r; }) };
    const t = mkToken(regions, inside, { uuid, movement });
    const p = settleHeight(t);
    mutate(t);
    finish(true);
    await p;
    return t.updates.length;
  };
  assert.equal(await run("t.a", (t) => { t.movement = { id: "m2", state: "completed" }; }), 0);   // быстрый повторный рывок
  assert.equal(await run("t.b", (t) => { t.movement = { ...t.movement, state: "paused" }; }), 0);
  assert.equal(await run("t.c", () => {}, [bank, region("stairs", { type: "changeLevel", disabled: false })], ["bank", "stairs"]), 0);
  assert.equal(await run("t.d", () => {}, [bank, region("stairs", { type: "changeLevel", disabled: true })], ["bank", "stairs"]), 1);
  assert.equal(await run("t.e", () => {}), 1);   // контроль: без помех пишет
});

test("схема и событие: поле height, обрабатывает только двигавший токен", async () => {
  assert.equal(HeightBehaviorType.defineSchema().height.o.initial, 0);
  assert.deepEqual(Object.keys(HeightBehaviorType.events), ["tokenEnter"]);
  const t = mkToken([region("bank", hb(10))], ["bank"], { uuid: "Scene.s.Token.v" });
  await HeightBehaviorType.events.tokenEnter({ user: { isSelf: false }, data: { token: t } });
  assert.equal(t.updates.length, 0);
  await HeightBehaviorType.events.tokenEnter({ user: { isSelf: true }, data: { token: t } });
  assert.deepEqual(t.updates, [{ elevation: 10 }]);
});

test("settleHeight: цепочка движений — вход на не последнем сегменте ставит высоту, чужое движение — нет", async () => {
  const run = async (uuid, after) => {
    const t = mkToken([region("bank", hb(10))], ["bank"], { uuid, movement: { id: "s1", chain: ["s0"], finished: Promise.resolve(true), state: "completed" } });
    const p = settleHeight(t);
    t.movement = after;
    await p;
    return t.updates.length;
  };
  assert.equal(await run("t.c1", { id: "s2", chain: ["s0", "s1"], state: "completed" }), 1);   // 1-й сегмент уступил 2-му той же цепочки
  assert.equal(await run("t.c2", { id: "n1", chain: [], state: "completed" }), 0);
});
