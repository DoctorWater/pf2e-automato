import test from "node:test";
import assert from "node:assert/strict";
import { LIMIT, idemKey, countOf, durSeconds, isUseCard, limitProblem, pickAllowed, actionPack, distanceFt, placeAt } from "../scripts/summon.mjs";

test("лимиты: призванное не призывает, не больше 4 приспешников, Alt обходит", () => {
  assert.equal(LIMIT, 4);
  assert.equal(limitProblem({ nested: true, minions: 0 }), "nested");
  assert.equal(limitProblem({ nested: false, minions: 3 }), null);
  assert.equal(limitProblem({ nested: false, minions: 4 }), "cap");
  assert.equal(limitProblem({ nested: false, minions: 3, add: 2 }), "cap");
  assert.equal(limitProblem({ nested: true, minions: 9, force: true }), null);
});

test("идемпотентность: ключ «сообщение + номер», количество из правила", () => {
  assert.equal(idemKey("m1", 0), "m1:summon:0");
  assert.notEqual(idemKey("m1", 0), idemKey("m1", 1));
  assert.equal(countOf({ count: 3 }), 3);
  assert.equal(countOf({}), 1);
  assert.equal(countOf(null), 1);
});

test("выбор проверяется по списку кандидатов (npc, common, уровень — у S1)", () => {
  const list = [{ uuid: "A", name: "a" }, { uuid: "B", name: "b" }];
  assert.equal(pickAllowed(list, "B").name, "b");
  assert.equal(pickAllowed(list, "C"), null);
  assert.equal(pickAllowed(null, "A"), null);
});


test("действия приспешника: по сотворению и при засчитанном Поддержании — 2; повтор/пусто — ничего", () => {
  assert.deepEqual(actionPack("cast", ["Зомби", "Скелет"]), { key: "actionsCast", actions: 2, list: "Зомби, Скелет" });
  assert.equal(actionPack("fresh", ["X"]).key, "actionsSustain");
  assert.equal(actionPack("fresh", ["X"]).actions, 2);
  assert.equal(actionPack("again", ["X"]), null);
  assert.equal(actionPack("fresh", []), null);
});

test("карточка: сотворение/способность — да, броски с context — нет", () => {
  assert.equal(isUseCard({ flags: { pf2e: { origin: { type: "spell" }, context: { type: "spell-cast" } } } }), true);
  assert.equal(isUseCard({ flags: { pf2e: { origin: { type: "feat" } } } }), true);
  assert.equal(isUseCard({ flags: { pf2e: { origin: { type: "spell" }, context: { type: "damage-roll" } } } }), false);
  assert.equal(isUseCard({ flags: {} }), false);
});

test("срок в секундах; расстояние и место", () => {
  assert.equal(durSeconds({ value: 1, unit: "minutes" }), 60);
  assert.equal(durSeconds(null), 0);
  const o = { x: 0, y: 0, w: 1, h: 1 };
  assert.equal(distanceFt(o, { x: 1, y: 0, w: 1, h: 1 }), 5);   // вплотную
  assert.equal(distanceFt(o, { x: 6, y: 0, w: 1, h: 1 }), 30);  // 30 фт по прямой
  assert.equal(distanceFt(o, { x: 4, y: 4, w: 1, h: 1 }), 30);  // диагональ 1-2-1: 4+2 = 6 клеток
  assert.deepEqual(placeAt({ x: 3, y: 3 }, { w: 1, h: 1 }, []), { x: 3, y: 3, w: 1, h: 1 });
  const busy = placeAt({ x: 3, y: 3 }, { w: 1, h: 1 }, [{ x: 3, y: 3, w: 1, h: 1 }]);
  assert.ok(busy && !(busy.x === 3 && busy.y === 3) && Math.abs(busy.x - 3) <= 1 && Math.abs(busy.y - 3) <= 1);
  assert.equal(placeAt({ x: 0, y: 0 }, { w: 1, h: 1 }, [{ x: -1, y: -1, w: 3, h: 3 }]), null);
});

test("rangeCells: клетки в пределах дальности вокруг токена (без клеток самого токена)", async () => {
  const { rangeCells } = await import("../scripts/summon.mjs");
  const cells = rangeCells({ x: 10, y: 10, w: 1, h: 1 }, 5, 5);
  assert.equal(cells.length, 8);   // 5 фт — соседние клетки, включая диагональ
  assert.ok(!cells.some((c) => c.x === 10 && c.y === 10));
  assert.ok(rangeCells({ x: 10, y: 10, w: 1, h: 1 }, 30, 5).every((c) => Math.abs(c.x - 10) <= 6 && Math.abs(c.y - 10) <= 6));
});
