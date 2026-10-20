import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { buildAutomationsIndex, groupsCovering } from "../scripts/compat.mjs";

const REAL = "C:/Users/USER/AppData/Local/Temp/claude/E--Foundry-VTT-v14-366/46b70f73-cd76-4b9a-a57a-6e1e8d6f2758/scratchpad/pf2e-automations-rulesV3.json";

test("compat: предикаты action:/feat:, not пропускается, weak только без strong", () => {
  const idx = buildAutomationsIndex({
    a: { name: "Battle Medicine", baseRules: [{ predicate: ["action:treat-wounds"] }] },
    b: { name: "Foo", baseRules: [{ predicate: ["origin:item:foo", "feat:bar", { not: "item:slug:baz" }] }] },
    c: { name: "Qux", complexRules: [{ predicate: [{ or: ["feat:quux"] }] }] },
    d: { name: "Src", handlerRules: [{ predicate: ["origin:item:sourceId:Compendium.pf2e.x.Item.A", "item:trait:fire", "self:effect:zzz"] }] }
  });
  const c = (o) => groupsCovering(idx, o);
  assert.deepEqual(c({ slug: "battle-medicine" }), ["Battle Medicine"]);   // slug имени группы
  assert.deepEqual(c({ slug: "treat-wounds" }), ["Battle Medicine"]);
  assert.deepEqual(c({ slug: "foo" }), ["Foo"]);
  assert.deepEqual(c({ slug: "bar" }), []);
  assert.deepEqual(c({ slug: "baz" }), []);
  assert.deepEqual(c({ slug: "quux" }), ["Qux"]);
  assert.deepEqual(c({ sourceUuid: "Compendium.pf2e.x.Item.A" }), ["Src"]);
  assert.deepEqual([c({ slug: "fire" }), c({ slug: "zzz" })], [[], []]);
});

test("compat: реальный реестр покрывает battle-medicine, shield, frightful-presence, bravos-brew", { skip: !existsSync(REAL) }, () => {
  const idx = buildAutomationsIndex(JSON.parse(readFileSync(REAL, "utf8")).rules);
  for (const slug of ["battle-medicine", "shield", "frightful-presence", "bravos-brew-lesser"])
    assert.ok(groupsCovering(idx, { slug }).length >= 1, slug);
});
