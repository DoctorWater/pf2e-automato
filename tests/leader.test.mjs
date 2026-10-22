import { test } from "node:test";
import assert from "node:assert/strict";
import { pickLeader, formOf, alive, newSid, TTL, TTL_HIDDEN, isLeader, whenSettled, sharedDialog } from "../scripts/leader.mjs";

const P = (o) => new Map(Object.entries(o).map(([k, [t, ready, hidden = false]]) => [k, { t, ready, hidden }]));

test("одна сессия — лидер сразу", () => assert.equal(pickLeader("b", true, new Map(), 1000), "b"));
test("лидер — наименьший sid среди живых готовых; видимость не влияет", () => {
  const peers = P({ a: [1000, true, true], c: [1000, true, false] });
  assert.equal(pickLeader("b", true, peers, 2000), "a");
  assert.equal(pickLeader("a", true, peers, 2000), "a");
});
test("неготовая сессия не кандидат: ни чужая, ни своя", () => {
  assert.equal(pickLeader("b", true, P({ a: [1000, false] }), 2000), "b");
  assert.equal(pickLeader("a", false, P({ b: [1000, true] }), 2000), "b");
  assert.equal(pickLeader("a", false, P({ b: [1000, false] }), 2000), undefined);
});
test("TTL: обычный пир 15 с, скрытый 75 с", () => {
  assert.equal(alive({ t: 0, hidden: false }, TTL), true);
  assert.equal(alive({ t: 0, hidden: false }, TTL + 1), false);
  assert.equal(alive({ t: 0, hidden: true }, TTL + 1), true);
  assert.equal(alive({ t: 0, hidden: true }, TTL_HIDDEN + 1), false);
  assert.equal(pickLeader("b", true, P({ a: [0, true, true] }), TTL + 1), "a");
  assert.equal(pickLeader("b", true, P({ a: [0, true, false] }), TTL + 1), "b");
});
test("formOf: checkbox — checked, radio — значение отмеченного", () => {
  const els = [
    { name: "s", type: "select-one", value: "2" }, { name: "h", type: "checkbox", checked: false },
    { name: "r", type: "radio", value: "a", checked: false }, { name: "r", type: "radio", value: "b", checked: true },
    { name: "q", type: "radio", value: "x", checked: false }, { type: "submit", value: "ok" }
  ];
  assert.deepEqual(formOf({ elements: els }), { s: "2", h: false, r: "b" });
  assert.deepEqual(formOf(null), {});
});
test("новая вкладка получает больший sid, чем старая", async () => {
  const old = newSid(); await new Promise((r) => setTimeout(r, 3));
  assert.ok(old < newSid());
});
test("без start(): лидер сразу, whenSettled готов", async () => {
  assert.equal(isLeader(), true);
  await whenSettled();
});
test("sharedDialog без сети — одно локальное окно", async () => {
  let cfg;
  globalThis.foundry = { applications: { api: { DialogV2: { wait: async (c) => { cfg = c; return c.buttons[0].callback(null, { form: { elements: [{ name: "x", type: "text", value: "1" }, { name: "h", type: "checkbox", checked: true }] } }); } } } } };
  try {
    const r = await sharedDialog({ title: "t", content: "c", buttons: [{ action: "ok", label: "OK" }] });
    assert.deepEqual(r, { action: "ok", form: { x: "1", h: true } });
    assert.equal(cfg.window.title, "t");
  } finally { delete globalThis.foundry; }
});
