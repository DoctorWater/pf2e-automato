import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateRule, buildCatalog } from "../scripts/rules.mjs";

const cat = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/catalog.campaign.json", import.meta.url)), "utf8"));

test("catalog.campaign: все записи (bySource, bySlug, flagRules) проходят validateRule", () => {
  for (const f of ["bySource", "bySlug", "flagRules"])
    for (const [k, r] of Object.entries(cat[f])) {
      if (k === "_doc") continue;
      const v = validateRule(r);
      assert.ok(v.ok, `${f}.${k}: ${v.errors}`);
    }
});

test("catalog.campaign: загрузчик не отбрасывает записи, ключи bySource — UUID компендия", () => {
  const { bySource, bySlug, errors } = buildCatalog([cat]);
  assert.deepEqual(errors, []);
  assert.ok(bySource.size >= 4);
  assert.ok(bySlug.size >= 4);
  for (const k of bySource.keys()) assert.match(k, /^Compendium\.pf2e\.[\w-]+\.Item\.\w{16}$/);
});
