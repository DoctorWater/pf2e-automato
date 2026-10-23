// rules/catalog.pa.json: шипуемый перенос pf2e-automations (tools/pa-port.mjs, buildPaCatalog).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

globalThis.game = { user: { isActiveGM: true }, settings: { get: () => "auto" }, i18n: { localize: (k) => k, format: (k) => k }, pf2e: { ConditionManager: { conditions: new Map() } } };
globalThis.ui = { notifications: { warn() {} } };

const { buildCatalog } = await import("../scripts/rules.mjs");
const { buildPaCatalog } = await import("../tools/pa-port.mjs");
const { roundTrip } = await import("../tools/validate.mjs");

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));
const pa = read("../rules/catalog.pa.json"), builtin = read("../rules/catalog.json"), campaign = read("../rules/catalog.campaign.json");

test("catalog.pa: собирается без ошибок, каждое правило проходит round-trip", () => {
  const c = buildCatalog([pa]);
  assert.deepEqual(c.errors, []);
  assert.ok(c.bySource.size > 100);
  for (const r of [...c.bySource.values(), ...c.bySlug.values()]) assert.ok(roundTrip(r));
});

test("catalog.pa: ручные каталоги побеждают при склейке (порядок как в loadCatalog)", () => {
  const c = buildCatalog([pa, builtin, campaign]);
  for (const m of [builtin, campaign]) {
    for (const f of ["bySource", "bySlug"]) for (const [k, raw] of Object.entries(m[f] ?? {})) assert.deepEqual(c[f].get(k), buildCatalog([{ [f]: { [k]: raw } }])[f].get(k), `${f}.${k}`);
  }
});

test("catalog.pa: ни один ключ не пересекается с ручными (источник и slug)", () => {
  for (const f of ["bySource", "bySlug"]) for (const m of [builtin, campaign]) for (const k of Object.keys(m[f] ?? {})) assert.ok(!(k in pa[f]), `${f}.${k}`);
});

test("buildPaCatalog: slug только если однозначен, конфликт источника и ручной каталог", () => {
  const rule = (n) => ({ v: 1, label: n, onUse: { targets: "self", excludeSelf: null, zone: null, challenge: null, apply: [{ to: "self", condition: { slug: "frightened", value: 1, policy: "max" } }] } });
  const P = "Compendium.pf2e.spells-srd.Item.";
  const d = (id, slug, rule_, confidence = "high") => ({ uuid: P + id, slug, confidence, rule: rule_ });
  const items = [{ uuid: P + "a", slug: "one" }, { uuid: P + "b", slug: "dup" }, { uuid: P + "c", slug: "dup" }, { uuid: P + "m", slug: "man" },
    { uuid: "Compendium.x.Actor.1.Item.n1", slug: "npc", embedded: true, source: P + "s" }, { uuid: "Compendium.x.Actor.2.Item.n2", slug: "npc2", embedded: true, source: P + "s" }];
  const r = buildPaCatalog([d("a", "one", rule("A")), d("b", "dup", rule("B")), d("c", "dup", rule("C"), "low"), d("m", "man", rule("M")),
    { ...d("n1", "npc", rule("N1")), uuid: items[4].uuid }, { ...d("n2", "npc2", rule("N2")), uuid: items[5].uuid }], [d("c", "dup", rule("C"))], items, [{ bySlug: { man: {} } }]);
  assert.deepEqual(Object.keys(r.cat.bySlug), ["one"]);                               // dup неоднозначен, man — у ручных
  assert.deepEqual(Object.keys(r.cat.bySource).sort(), [P + "a", P + "b", P + "c"]);   // c принят вручную; npc-копии с разными правилами отброшены
  assert.deepEqual(r.skipped, { "manual-wins": 1, "source-conflict": 2 });
});

const { translateItem } = await import("../tools/pa-port.mjs");
const EFF = "Compendium.pf2e.equipment-effects.Item.AAAAAAAAAAAAAAAA", CID = "cond0000000000id";
const ctx = { effects: { [EFF]: "Effect: X" }, condSlugs: new Set(["quickened"]), condIds: { quickened: CID }, grants: {}, labels: {}, condSlugByUuid: () => null, condNames: [] };
const L = `@UUID[${EFF}]`;
const grp = (target) => ({ rules: [{ triggerType: "use", target, value: EFF, predicate: [] }] });
const cons = (extra = {}) => ({ type: "consumable", slug: "x", name: "X", traits: [], ...extra });

test("translateItem: спасбросок в тексте при правиле «на себя» -> low (регресс: литерал backspace вместо граница слова)", () => {
  const r = translateItem(cons(), `<p>${L} @Check[fortitude|dc:20]</p>`, grp("SelfEffect"), ctx);
  assert.equal(r.confidence, "low"); assert.match(r.reason, /text-has-save-or-area/);
  assert.equal(translateItem(cons(), `<p>${L}</p>`, grp("SelfEffect"), ctx).confidence, "high");
});

test("translateItem: to:target у расходника без target -> low; с target остаётся high", () => {
  assert.match(translateItem(cons(), `<p>${L}</p>`, grp("TargetEffect"), ctx).reason, /to-target-no-item-target/);
  assert.equal(translateItem(cons({ target: "1 creature" }), `<p>${L}</p>`, grp("TargetEffect"), ctx).confidence, "high");
});

test("translateItem: «you gain the @UUID[состояние]» без него в правиле и GrantItem -> low", () => {
  const html = `<p>${L} you gain the @UUID[Compendium.pf2e.conditionitems.Item.${CID}]{Quickened} condition</p><p>bonus against @UUID[Compendium.pf2e.conditionitems.Item.${CID}]{Quickened}</p>`;
  assert.match(translateItem(cons(), html, grp("SelfEffect"), ctx).reason, /text-condition-missing:quickened/);
  assert.equal(translateItem(cons(), html, grp("SelfEffect"), { ...ctx, grants: { [EFF]: [CID] } }).confidence, "high");
  assert.equal(translateItem(cons(), `<p>${L}</p>` + html.split("</p>")[1], grp("SelfEffect"), ctx).confidence, "high");   // «бонус против» — не триггер
});

test("buildPaCatalog: PA bySource против ручного bySlug того же предмета; rule:null в accepted исключает", () => {
  const P = "Compendium.pf2e.spells-srd.Item.";
  const rule = { v: 1, label: "A", onUse: { targets: "self", excludeSelf: null, zone: null, challenge: null, apply: [{ to: "self", condition: { slug: "frightened", value: 1, policy: "max" } }] } };
  const dr = (id, slug) => ({ uuid: P + id, slug, confidence: "high", rule });
  const items = [{ uuid: P + "a", slug: "man" }, { uuid: P + "b", slug: "free" }, { uuid: P + "c", slug: "ex" }];
  const r = buildPaCatalog([dr("a", "man"), dr("b", "free"), dr("c", "ex")], [{ uuid: P + "c", rule: null }], items, [{ bySlug: { man: {} } }]);
  assert.deepEqual(Object.keys(r.cat.bySource), [P + "b"]);
  assert.deepEqual(r.skipped, { "manual-wins": 1, "excluded-manually": 1 });
});
