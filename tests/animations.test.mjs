import test from "node:test";
import assert from "node:assert/strict";
import { hasSneakDice, aeonLook } from "../scripts/builtin/animations.mjs";

test("hasSneakDice: кубики sneak-attack в броске урона, не отключённые и не проигнорированные", () => {
  const opts = (...mods) => ({ damage: { modifiers: mods } });
  assert.equal(hasSneakDice(opts({ slug: "sneak-attack", enabled: true, ignored: false })), true);
  assert.equal(hasSneakDice(opts({ slug: "sneak-attack", enabled: false })), false, "предикат не прошёл — кубики выключены");
  assert.equal(hasSneakDice(opts({ slug: "sneak-attack", ignored: true })), false);
  assert.equal(hasSneakDice(opts({ slug: "precise-strike" })), false);
  assert.equal(hasSneakDice(undefined), false);
  assert.equal(hasSneakDice({}), false);
  // перевод: slug из русской подписи, узнаём по имени предмета Атаки исподтишка у актёра
  const ru = opts({ slug: "атака-исподтишка", label: "Атака исподтишка", enabled: true, ignored: false });
  assert.equal(hasSneakDice(ru, ["Атака исподтишка"]), true);
  assert.equal(hasSneakDice(ru, []), false, "у актёра нет Атаки исподтишка — не узнаём");
});

test("aeonLook: вид камня вечных по slug; неизвестный камень — обычный; не камень — null", () => {
  assert.deepEqual(aeonLook("aeon-stone-western-star"), { file: "jb2a.twinkling_stars.points04.orange", colors: {}, scale: 0.6 });
  assert.equal(aeonLook("aeon-stone-black-pearl").file, "jb2a.ioun_stones.01.blue.insight");
  assert.deepEqual(aeonLook("aeon-stone-new-kind"), { file: "jb2a.ioun_stones.01", colors: {}, scale: 0.15 });
  assert.equal(aeonLook("longsword"), null);
  assert.equal(aeonLook(null), null);
});
