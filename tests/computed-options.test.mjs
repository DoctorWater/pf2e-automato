import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game ??= {};
const { decorate, alliesInReach, packNeed, needFor, computedFor, checkNeutralization, resetWarned } = await import("../scripts/builtin/computed-options.mjs");

const me = { id: "me", uuid: "A.me" }, tgt = { id: "t" }, tgtDoc = { object: tgt };
const mk = (id, ally, dist, hp = 5, reach = 5, extra = {}) => ({ id, actor: { uuid: `A.${id}`, isAllyOf: (a) => a === me && ally, hitPoints: { value: hp }, getReach: () => reach }, distanceTo: () => dist, ...extra });

test("alliesInReach: живые союзники с целью в досягаемости, без врагов, павших и далёких", () => {
  const tokens = [mk("a1", true, 5), mk("a2", true, 10, 5, 10), mk("far", true, 10), mk("foe", false, 5), mk("down", true, 5, 0), tgt];
  assert.equal(alliesInReach(me, { id: "me" }, tgtDoc, tokens), 2);
  assert.equal(alliesInReach(me, { id: "me" }, null, tokens), 0);
});

test("alliesInReach: себя исключаем по id токена и по uuid актёра (контекстный клон)", () => {
  const self = mk("me", true, 5), clone = mk("other-token", true, 5);
  clone.actor.uuid = "A.me";
  assert.equal(alliesInReach(me, { id: "me" }, tgtDoc, [self, clone]), 0);
  assert.equal(alliesInReach(me, null, tgtDoc, [clone, mk("a", true, 5)]), 1);
});

test("alliesInReach: скрытый токен не считается", () => {
  const t = (id, hidden) => mk(id, true, 5, 5, 5, { document: { hidden } });
  assert.equal(alliesInReach(me, { id: "me" }, tgtDoc, [t("a", false), t("b", true)]), 1);
});

test("packNeed: порог 1 у Superior Pack Attack, Coordinated Assault и Phantom Wolf (по источнику), иначе 2", () => {
  const PW = "Compendium.pf2e.season-of-ghosts-bestiary.Actor.R805QpID53EycZ5E";
  assert.equal(packNeed("superior-pack-attack", null), 1);
  assert.equal(packNeed("coordinated-assault", null), 1);
  assert.equal(packNeed("pack-attack", PW), 1);
  assert.equal(packNeed("pack-attack", "Compendium.pf2e.pathfinder-bestiary.Actor.x"), 2);
  assert.equal(packNeed("pack-attack", null), 2);   // мировая копия без источника — порог 2
});

test("needFor: минимум по предметам актёра", () => {
  const actor = { _stats: {} };
  assert.equal(needFor(actor, [{ slug: "pack-attack" }, { slug: "superior-pack-attack" }]), 1);
  assert.equal(needFor(actor, [{ slug: "pack-attack" }]), 2);
});

test("computedFor: пороги 1 и 2, гейт без погашенного переключателя", () => {
  const two = new Map([["pack-attack", new Set([{ slug: "pack-attack" }])]]), one = new Map([["pack-attack", new Set([{ slug: "coordinated-assault" }])]]);
  const a = {};
  assert.deepEqual(computedFor(a, two, () => 2), ["pack-attack"]);
  assert.deepEqual(computedFor(a, two, () => 1), []);
  assert.deepEqual(computedFor(a, one, () => 1), ["pack-attack"]);
  assert.deepEqual(computedFor(a, one, () => 0), []);
  let called = false;
  assert.deepEqual(computedFor(a, null, () => { called = true; return 9; }), []);   // гейт: у актёра ничего не погашено — сцену не считаем
  assert.equal(called, false);
});

test("checkNeutralization: предупреждение один раз, без нейтрализации и не при off", () => {
  resetWarned();
  let n = 0;
  const warn = () => n++;
  assert.equal(checkNeutralization({ installed: true, mode: "auto", warn }), false);
  assert.equal(checkNeutralization({ installed: false, mode: "off", warn }), false);
  assert.equal(checkNeutralization({ installed: false, mode: "auto", warn }), true);
  assert.equal(checkNeutralization({ installed: false, mode: "auto", warn }), false);
  assert.equal(n, 1);
});

test("decorate: опция попадает в options (массив и Set), altUsages, идемпотентно, режим off в момент броска", async () => {
  const { wrapRules } = await import("../scripts/builtin/neutralize-rules.mjs");
  const item = { slug: "coordinated-assault", actor: null, _stats: {} };   // порог 1
  const actor = Object.assign(me, { system: {}, token: null });
  item.actor = actor;
  game.settings = { get: (_m, k) => (mode.v && k === "mode.computed" ? mode.v : "auto") };
  game.modules = { get: () => null };
  game.user = { targets: { first: () => ({ document: { parent: scene, object: { id: "t" } } }) } };
  const scene = {}, mode = { v: null };
  globalThis.canvas = { scene, tokens: { placeables: [mk("a", true, 5)] } };
  const { setReady } = await import("../scripts/builtin/neutralize-rules.mjs");
  setReady("computed", true);
  wrapRules(() => [{ key: "RollOption", toggleable: true, option: "pack-attack", item }]);
  const seen = [];
  const f = (c) => { seen.push(c); };
  const alt = { damage: f, critical: f };
  actor.system.actions = [{ damage: f, critical: f, altUsages: [alt] }];
  decorate(actor);
  const wrapped = actor.system.actions[0].damage;
  decorate(actor);
  assert.equal(actor.system.actions[0].damage, wrapped);   // идемпотентно
  actor.system.actions[0].damage({ options: ["x"] });
  actor.system.actions[0].critical({ options: new Set(["y"]) });
  alt.damage();
  assert.deepEqual(seen.map((c) => [...(c.options ?? [])]), [["x", "pack-attack"], ["y", "pack-attack"], ["pack-attack"]]);
  mode.v = "off";
  seen.length = 0;
  actor.system.actions[0].damage({ options: ["x"] });
  assert.deepEqual(seen[0].options, ["x"]);
});
