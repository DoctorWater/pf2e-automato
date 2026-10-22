import { test } from "node:test";
import assert from "node:assert/strict";
import { card, cardButton, HEADS } from "../scripts/card.mjs";

test("card: текст в .paf-note (подсказки сами начинаются с <p>), кнопки отдельным рядом", () => {
  const html = card("<p><b>Блок</b></p>", cardButton("data-x", "Ok"));
  assert.match(html, /<div class="paf-note"><p><b>Блок<\/b><\/p><\/div><div class="paf-card-actions"><button [^>]*>Ok<\/button><\/div>/);
  assert.ok(!/<p class="paf-note"/.test(html));
  assert.ok(!html.includes("paf-card-head"));
});

test("card: шапка с иконкой; без кнопок — без ряда", () => {
  const html = card("x", "", { title: "Освобождение", icon: HEADS.escape });
  assert.match(html, /<header class="paf-card-head"><i class="fa-solid fa-unlock" inert><\/i><span>Освобождение<\/span><\/header>/);
  assert.ok(!html.includes("paf-card-actions"));
});
