// Шаги apply: who (союзник/враг по disposition), mark (метка TokenMark на врага), unlessEffect, невосприимчивость к чертам источника.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { opposed, immuneToTraits } from "../scripts/apply.mjs";
import { validateRule } from "../scripts/rules.mjs";

test("opposed: дружественный против нейтрального/враждебного — враги; дружественные между собой — нет", () => {
  assert.equal(opposed(1, -1), true);
  assert.equal(opposed(1, 0), true);
  assert.equal(opposed(1, 1), false);
  assert.equal(opposed(-1, -2), false);
});

test("immuneToTraits: иммунитет pf2e по типу совпал с чертой источника", () => {
  assert.equal(immuneToTraits([{ type: "mental" }], ["mental", "illusion"]), true);
  assert.equal(immuneToTraits([{ type: "fire" }], ["mental"]), false);
  assert.equal(immuneToTraits(undefined, ["mental"]), false);
});

test("validateRule: who/mark/unlessEffect в шаге apply", () => {
  const ok = validateRule({ v: 1, onUse: { targets: "selected", apply: [{ to: "target", who: "ally", mark: "enemy", unlessEffect: "Compendium.x.Item.y", effect: { uuid: "Compendium.pf2e.spell-effects.Item.z" } }] } });
  assert.deepEqual(ok.errors ?? [], []);
  assert.deepEqual(ok.rule.onUse.apply[0], { to: "target", effect: { uuid: "Compendium.pf2e.spell-effects.Item.z" }, who: "ally", mark: "enemy", unlessEffect: "Compendium.x.Item.y" });
  const bad = validateRule({ v: 1, onUse: { targets: "selected", apply: [{ to: "target", who: "friend", mark: "enemy", note: "n" }] } });
  assert.ok(bad.errors.length >= 2);
});

test("каталог: Запрещающая защита — эффект союзнику с меткой на врага; Наставление — не при иммунитете", () => {
  const cat = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/catalog.campaign.json", import.meta.url)), "utf8"));
  const fw = cat.bySlug["forbidding-ward"].onUse.apply.find((a) => a.effect);
  assert.deepEqual([fw.who, fw.mark], ["ally", "enemy"]);
  for (const a of cat.bySlug.guidance.onUse.apply) assert.equal(a.unlessEffect, "Compendium.pf2e.spell-effects.Item.3LyOkV25p7wA181H");
  assert.equal(validateRule(cat.bySlug["forbidding-ward"]).errors?.length ?? 0, 0);
});

test("chooserOf: окно выбора — у автора-игрока онлайн и владельца источника, иначе у ГМа", async () => {
  const { chooserOf } = await import("../scripts/apply.mjs");
  const pl = { id: "pl", isGM: false, active: true };
  const actor = { testUserPermission: (u) => u === pl };
  assert.equal(chooserOf({ author: pl }, actor), pl);
  assert.equal(chooserOf({ author: { ...pl, active: false } }, actor), null);
  assert.equal(chooserOf({ author: { id: "g", isGM: true, active: true } }, actor), null);
  assert.equal(chooserOf({ author: { id: "x", isGM: false, active: true } }, actor), null);
});

test("каталог byName: Танец клинков — способность NPC без slug и источника; не перебивает предмет со slug", async () => {
  const { initCatalog, resolveRule } = await import("../scripts/rules.mjs");
  const cat = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/catalog.campaign.json", import.meta.url)), "utf8"));
  initCatalog([cat], null);
  assert.equal(resolveRule({ item: { name: "Танец клинков", system: { slug: null }, _stats: {} } })?.rule?.macros?.[0]?.builtin, "blade-dance");
  assert.equal(resolveRule({ item: { name: "Танец клинков", system: { slug: "other" }, _stats: {} } }), null);
});

test("wantsSnapshot: проверка roll:system без apply — снимок не на карточке", async () => {
  globalThis.foundry ??= { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) }, utils: { deepClone: (o) => structuredClone(o), getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
  const { wantsSnapshot } = await import("../scripts/use.mjs");
  assert.equal(wantsSnapshot("use", { onUse: { check: { roll: "system" }, apply: [] } }), false);
  assert.equal(wantsSnapshot("use", { onUse: { check: { statistic: "x" }, apply: [] } }), true);
});
