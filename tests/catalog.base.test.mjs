import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateRule, buildCatalog } from "../scripts/rules.mjs";

const cat = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/catalog.json", import.meta.url)), "utf8"));
const flagRules = JSON.parse(readFileSync(fileURLToPath(new URL("../tools/campaign-flag-rules.json", import.meta.url)), "utf8"));

test("catalog.json: все записи (bySource, bySlug, flagRules) проходят validateRule", () => {
  for (const f of ["bySource", "bySlug", "byName", "flagRules"])
    for (const [k, r] of Object.entries({ ...cat, flagRules }[f])) {
      if (k === "_doc") continue;
      const v = validateRule(r);
      assert.ok(v.ok, `${f}.${k}: ${v.errors}`);
    }
});

test("catalog.json: загрузчик не отбрасывает записи, ключи bySource — UUID компендия", () => {
  const { bySource, bySlug, errors } = buildCatalog([cat]);
  assert.deepEqual(errors, []);
  assert.ok(bySource.size >= 4);
  assert.ok(bySlug.size >= 4);
  for (const k of bySource.keys()) assert.match(k, /^Compendium\.pf2e(?:-automato)?\.[\w-]+\.Item\.\w{16}$/);   // pf2e-automato — носители на эффектах своего пака (Убежище)
});
