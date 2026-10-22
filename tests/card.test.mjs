import { test } from "node:test";
import assert from "node:assert/strict";
import { card, cardButton } from "../scripts/card.mjs";

test("card: обёртка div (подсказки сами начинаются с <p>), кнопка внутри .paf-note", () => {
  const html = card("<p><b>Блок</b></p>", cardButton("data-x", "Ok"));
  assert.match(html, /<div class="paf-note"><p><b>Блок<\/b><\/p><button [^>]*>Ok<\/button><\/div>/);
  assert.ok(!/<p class="paf-note"/.test(html));
});
