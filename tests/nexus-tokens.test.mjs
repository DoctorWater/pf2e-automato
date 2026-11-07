import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreName, bestMatch } from "../scripts/nexus-tokens.mjs";

test("scoreName: целиком > с начала > слово внутри > подстрока", () => {
  assert.equal(scoreName("Goblin_Red_01.webp", "Goblin"), 4);
  assert.equal(scoreName("Goblin_Warrior_01.webp", "goblin"), 3);
  assert.equal(scoreName("Cave_Goblin_Blue.png", "Goblin"), 2);
  assert.equal(scoreName("Hobgoblin_01.webp", "Goblin"), 1);
  assert.equal(scoreName("Orc_01.webp", "Goblin"), 0);
  assert.equal(scoreName("Giant_Rat_Green.webp", "giant rat"), 4);
});

test("bestMatch: лучший файл; первое имя важнее; при равенстве короче; пусто -> null", () => {
  const files = ["t/Goblin_Warrior_01.webp", "t/Cave_Goblin.webp", "t/Goblin_Blue.webp", "t/Goblin_Red_02.webp"];
  assert.equal(bestMatch(files, ["Goblin"]), "t/Goblin_Blue.webp");
  assert.equal(bestMatch(["t/Wolf.webp", "t/Dire_Wolf.webp"], ["Dire Wolf", "Wolf"]), "t/Dire_Wolf.webp");
  assert.equal(bestMatch(["t/Orc.webp"], ["Goblin"]), null);
  assert.equal(bestMatch([{ filename: "Imp_Red.webp" }], ["Imp"], (x) => x.filename).filename, "Imp_Red.webp");
});

test("русские имена и обрывки не подбирают чужой токен; подстрока внутри слова — не совпадение", async () => {
  const { bestMatch } = await import("../scripts/nexus-tokens.mjs");
  const files = ["Goblin_Fighter_C1_Spear_01.webp", "Skeleton_Guard_A1_Spear_Undead_01.webp", "Simple_Barrel_01.webp"];
  assert.equal(bestMatch(files, ["Cкелет лошади", "Skeletal Horse"]), null);   // латинская «C» в русском имени
  assert.equal(bestMatch(files, ["Imp"]), null);
  assert.equal(bestMatch(files, ["Skeleton Guard"]), "Skeleton_Guard_A1_Spear_Undead_01.webp");
});
