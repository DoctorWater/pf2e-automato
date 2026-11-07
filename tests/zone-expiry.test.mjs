// Пак C: срок зоны по ходу автора, Поддержание зоны, место области. Чистые функции zone.mjs + валидатор поля срока.
import { test } from "node:test";
import assert from "node:assert/strict";

class Field { constructor(o) { this.o = o; } }
globalThis.foundry = {
  data: { fields: { StringField: Field, NumberField: Field, BooleanField: Field, ArrayField: Field, ObjectField: Field }, regionBehaviors: { RegionBehaviorType: class {} } }
};
const { nextTurnEndRound, turnPassed, extendedEnd, baseGap, ZoneBehaviorType } = await import("../scripts/zone.mjs");
const { validateRule } = await import("../scripts/rules.mjs");

test("nextTurnEndRound: ход автора впереди в этом раунде — этот раунд, иначе следующий", () => {
  assert.equal(nextTurnEndRound(3, 2, 2), 4);   // на своём ходу
  assert.equal(nextTurnEndRound(3, 0, 2), 3);   // реакция до своего хода
  assert.equal(nextTurnEndRound(3, 4, 2), 4);   // после своего хода
});

test("turnPassed: зона живёт весь ход автора и кончается, когда бой перешёл дальше", () => {
  // автор на месте 2, зона до конца его хода в раунде 4
  assert.equal(turnPassed(4, 2, 3, 2), false);
  assert.equal(turnPassed(4, 2, 3, 3), false);
  assert.equal(turnPassed(4, 2, 4, 1), false);
  assert.equal(turnPassed(4, 2, 4, 2), false);   // ход автора идёт — ещё держится
  assert.equal(turnPassed(4, 2, 4, 3), true);    // ход автора окончен
  assert.equal(turnPassed(4, 2, 5, 0), true);    // последний по инициативе: следующий раунд
  assert.equal(turnPassed(4, -1, 3, 0), true);   // автора убрали из боя
});

test("extendedEnd: Поддержание продлевает на ход, но не выше максимума", () => {
  assert.equal(extendedEnd(4, null), 5);
  assert.equal(extendedEnd(4, 11), 5);
  assert.equal(extendedEnd(11, 11), null);
  assert.equal(extendedEnd(10, 11), 11);
});

test("baseGap: расстояние токена до основания; центр на углу клеток — ближайшая клетка", () => {
  const tok = { x: 0, y: 0, w: 1, h: 1 };
  assert.equal(baseGap(tok, { x: 100, y: 0 }, 100, 5), 5);   // на углу: ближайшая клетка — соседняя
  assert.equal(baseGap(tok, { x: 550, y: 50 }, 100, 5), 25);  // клетка 5 по x: 5 клеток = 25 фт
  assert.equal(baseGap(tok, { x: 1300, y: 50 }, 100, 5), 60);  // 12 клеток = 60 фт (граница колонны)
  assert.ok(baseGap(tok, { x: 1350, y: 50 }, 100, 5) > 60);
});

test("схема: поля срока по ходу автора", () => {
  const s = ZoneBehaviorType.defineSchema();
  for (const k of ["endCombat", "endRound", "endCombatant", "maxRound"]) assert.ok(k in s, k);
});

test("валидатор: duration.until / sustainMax", () => {
  const rule = (duration) => validateRule({ v: 1, onUse: { targets: "area", zone: { condition: { slug: "concealed" }, duration } } });
  const ok = rule({ until: "next-turn-end", rounds: 2, sustainMax: 10 });
  assert.equal(ok.ok, true, ok.errors?.join("; "));
  assert.deepEqual(ok.rule.onUse.zone.duration, { rounds: 2, until: "next-turn-end", sustainMax: 10 });
  assert.equal(rule({ until: "forever" }).ok, false);
  assert.equal(rule({ sustainMax: 10, rounds: 2 }).ok, false);   // без until потолок бессмыслен
  assert.equal(rule({ until: "next-turn-end", sustainMax: 0 }).ok, false);
});
