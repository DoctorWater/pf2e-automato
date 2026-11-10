import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.game ??= {};
const { validateRule } = await import("../scripts/rules.mjs");
const { strikeLinkEntry, hasOutcome } = await import("../scripts/strike-link.mjs");
const model = JSON.parse(readFileSync(new URL("../rules/catalog.model.json", import.meta.url), "utf8")).bySource;

// недуги способностей NPC (injury), собранные tools/affliction-batch.mjs как обычные правила каталога: Удар запускает их через strike-link (пассивка + attackEffects)
const VENOMS = {
  "Compendium.pf2e.abomination-vaults-bestiary.Actor.OloMMRPtTQKF0x16.Item.LOeBCSVBauL8spor": "black-smear-poison",

  "Compendium.pf2e.pathfinder-monster-core.Actor.0H54u83vZ1w3xHcD.Item.oeOZCitfRoZXCLfy": "tor-linnorm-venom",
  "Compendium.pf2e.pathfinder-monster-core.Actor.JRBUBgJymEeEE4hm.Item.vwO9JU83wAh6vmts": "crag-linnorm-venom",
  "Compendium.pf2e.pathfinder-monster-core.Actor.Np5Z7RMQzvSNnH0h.Item.TfUyAj18NAaa1ZGV": "ice-linnorm-venom",
  "Compendium.pf2e.pathfinder-monster-core.Actor.k0HUy6WdbZUNfG8X.Item.Bcm7iwcliF6ChhW7": "tarn-linnorm-venom"
};

test("недуг NPC-способности из каталога: Удар с attackEffects запускает стадию 1 (запись onEvent с исходом)", () => {
  for (const [uuid, slug] of Object.entries(VENOMS)) {
    const rule = model[uuid];
    assert.ok(rule, `${slug}: правило в каталоге`);
    const item = { type: "action", slug, name: slug, uuid, system: { actionType: { value: "passive" }, frequency: null, description: { value: "" } }, flags: {} };
    const strike = { type: "melee", name: "Jaws", system: { attackEffects: { value: [slug] } } };
    item.actor = { items: [item, strike], itemTypes: { melee: [strike] } };
    const entry = strikeLinkEntry({ rule: validateRule(rule).rule, source: "catalog" }, item, [strike]);
    assert.ok(entry, `${slug}: связь с Ударом`);
    const e = entry.onEvent[0];
    assert.ok(hasOutcome(e), `${slug}: у записи есть исход`);
    assert.ok(e.when.includes(`item:attack-effect:${slug}`));
    assert.match(JSON.stringify(e), /"affliction":\{"stage":1/, `${slug}: стадия 1`);
  }
});
