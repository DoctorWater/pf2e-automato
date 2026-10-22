import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game = { user: { isActiveGM: true }, i18n: { localize: (k) => k, format: (k) => k }, users: [] };
const sa = await import("../scripts/builtin/surprise-attack.mjs");
const lib = await import("../scripts/builtin/lib.mjs");

test("surprise: инициатива Обманом/Скрытностью", () => {
  assert.equal(sa.classify({ type: "initiative", options: ["check:statistic:base:deception"] }), true);
  assert.equal(sa.classify({ type: "initiative", options: ["check:statistic:base:stealth"] }), true);
  assert.equal(sa.classify({ type: "initiative", options: ["check:statistic:base:perception"] }), false);
  assert.equal(sa.classify({ type: "attack-roll", options: [] }), null);
});

test("surprise: правила, сигнатуры, снятие метки", () => {
  const rules = sa.rulesFor(["a", "b"]);
  assert.equal(rules[0].key, "EphemeralEffect");
  assert.deepEqual(rules[0].predicate, ["target:signature:a"]);
  assert.deepEqual(sa.sigsOf(rules), ["a", "b"]);
  assert.deepEqual(sa.sigsOf(sa.dropSig(rules, "a")), ["b"]);
});

test("surprise: кто ещё не ходил", () => {
  const A = (n) => ({ signature: n });
  const me = A("me"), x = A("x"), y = A("y");
  const turns = [{ actor: x }, { actor: me }, { actor: y }];
  assert.deepEqual(sa.pending(turns, false, 0, me), [x, y]);
  assert.deepEqual(sa.pending(turns, true, 0, me), [y]);   // x ходит сейчас, me исключён
  assert.deepEqual(sa.pending(turns, true, 2, me), []);
});

test("findFeat: slug или babele.originalName", () => {
  const a = { items: [{ type: "feat", slug: null, flags: { babele: { originalName: "Dread Striker" } } }, { type: "effect", slug: "x" }] };
  assert.equal(lib.findFeat(a, "dread-striker"), a.items[0]);
  assert.equal(lib.findFeat({ items: [{ type: "feat", slug: "dread-striker" }] }, "dread-striker").slug, "dread-striker");
  assert.equal(lib.findFeat(a, "x"), null);
  assert.equal(lib.findFeat({ items: [{ type: "feat", slug: null, name: "Dread Striker" }] }, "dread-striker").name, "Dread Striker");   // NPC-способность без slug
});

test("offGuardRule: селекторы как у pf2e", () => {
  assert.deepEqual(lib.offGuardRule([]).selectors, ["strike-attack-roll", "spell-attack-roll", "strike-damage", "attack-spell-damage"]);
});

test("бой актёра и висящие эффекты боя", () => {
  const A = (u) => ({ actor: { uuid: u } });
  const c1 = { id: "c1", combatants: [A("a")] }, c2 = { id: "c2", combatants: [A("b")] };
  assert.equal(lib.combatOf([c1, c2], { uuid: "b" }), c2);
  assert.equal(lib.combatOf([c1, c2], { uuid: "z" }), null);
  const combats = new Map([["c1", c1]]);
  assert.equal(lib.isStale("c1", "a", combats), false);
  assert.equal(lib.isStale("c1", "b", combats), true);   // актёра в бою нет
  assert.equal(lib.isStale("c2", "b", combats), true);   // боя нет
  assert.equal(lib.isStale(undefined, "a", combats), true);   // флага нет (эффект старой версии)
});

