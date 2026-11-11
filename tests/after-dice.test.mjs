// afterDice (util.mjs): ждёт Dice So Nice, не виснет и не падает.
import { test } from "node:test";
import assert from "node:assert/strict";
import { afterDice } from "../scripts/util.mjs";

test("без DSN возвращается сразу", async () => {
  delete globalThis.game;
  await afterDice("m1");
  globalThis.game = {};
  await afterDice({ id: "m1" });
  await afterDice(null);
});

test("ждёт разрешения waitFor3DAnimationByMessageID с id сообщения", async () => {
  const order = [];
  globalThis.game = { dice3d: { waitFor3DAnimationByMessageID: (id) => new Promise((r) => setTimeout(() => { order.push(`anim:${id}`); r(true); }, 20)) } };
  await afterDice({ id: "m2" });
  order.push("after");
  assert.deepEqual(order, ["anim:m2", "after"]);
});

test("таймаут-предохранитель и ошибка DSN не ломают вызов", async () => {
  globalThis.game = { dice3d: { waitFor3DAnimationByMessageID: () => new Promise(() => {}) } };
  const t = Date.now();
  await afterDice("m3", 30);
  assert.ok(Date.now() - t < 1000);
  globalThis.game = { dice3d: { waitFor3DAnimationByMessageID: () => Promise.reject(new Error("x")) } };
  const warn = console.warn; console.warn = () => {};
  try { await afterDice("m4"); } finally { console.warn = warn; }
});
