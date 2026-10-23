// Пак эффектов модуля (packs/_source/effects -> packs/effects) и перенос эффектов pf2e-automations (tools/pa-effects.mjs, tools/pa-port.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

globalThis.game = { user: { isActiveGM: true }, settings: { get: () => "auto" }, i18n: { localize: (k) => k, format: (k) => k }, pf2e: { ConditionManager: { conditions: new Map() } } };
globalThis.ui = { notifications: { warn() {} } };

const { translateItem } = await import("../tools/pa-port.mjs");
const { sourceDocs, stripKey, buildPack, PACKS } = await import("../tools/build-packs.mjs");
const { classicLevel } = await import("../tools/packs.mjs");

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p) => JSON.parse(readFileSync(root(p), "utf8"));
const OWN = /Compendium\.pf2e-automato\.effects\.Item\.(\w+)/g;
const docs = sourceDocs(), ids = new Set(docs.map((d) => d._id)), map = read("tools/pa-effects.json").effects;

test("пак: источники — Item/effect, _key и имя файла совпадают с _id, id уникальны, ссылок на pf2e-automations не осталось", () => {
  assert.ok(docs.length > 50);
  assert.equal(ids.size, docs.length);
  const files = readdirSync(PACKS.effects.src);
  for (const d of docs) {
    assert.equal(d.type, "effect", d.name);
    assert.equal(d._key, `!items!${d._id}`);
    assert.ok(files.some((f) => f.endsWith(`_${d._id}.json`)), d.name);
    assert.doesNotMatch(JSON.stringify(d), /pf2e-automations/, d.name);
  }
});

test("пак: все ссылки на Compendium.pf2e-automato.effects (в правилах каталогов и внутри самих эффектов) есть в источниках", () => {
  const texts = [["источники", JSON.stringify(docs)], ...["catalog.json", "catalog.campaign.json", "catalog.pa.json"].map((f) => [f, readFileSync(root(`rules/${f}`), "utf8")])];
  let n = 0;
  for (const [where, t] of texts) for (const m of t.matchAll(OWN)) { n++; assert.ok(ids.has(m[1]), `${where}: нет ${m[1]}`); }
  assert.ok(n > 20);
});

test("карта эффектов PA: own — ровно документы пака; остальные виды не в паке и устроены корректно", () => {
  const own = Object.entries(map).filter(([, e]) => e.kind === "own").map(([id]) => id).sort();
  assert.deepEqual(own, [...ids].sort());
  for (const [id, e] of Object.entries(map)) {
    if (e.kind === "pf2e") assert.match(e.uuid, /^Compendium\.pf2e\.[\w-]+\.Item\.\w{16}$/, id);
    if (e.kind === "conditions") {
      assert.ok(e.steps.length && e.steps.every((s) => /^[a-z-]+$/.test(s.slug)), id);
      if (e.duration) assert.ok(e.duration.value >= 1 || e.duration.expiry === "turn-end", id);
    }
    assert.ok(["own", "pf2e", "conditions", "marker", "immunity", "equipment", "script"].includes(e.kind), id);
  }
  // иконки активностей исследования и иммунитеты (0.5c) в паке не живут
  for (const n of ["Track", "Investigate", "Hustle", "Search", "Scout", "Defend"]) assert.equal(Object.values(map).find((e) => e.name === n)?.kind, "marker", n);
  assert.ok(Object.values(map).filter((e) => /immunity/i.test(e.name)).every((e) => e.kind === "immunity" || e.authored));   // свои метки иммунитета (tools/pa-effects.authored.mjs) в паке живут: unlessEffect берёт их как метку
});

test("сборка LevelDB из источников читается обратно и совпадает с ними", async (t) => {
  const CL = classicLevel();
  if (!CL) return t.skip("classic-level не найден (FOUNDRY_NODE_MODULES)");
  const tmp = join(tmpdir(), `pack-effects-test-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  assert.equal(await buildPack("effects", tmp), docs.length);
  const db = new CL(tmp, { keyEncoding: "utf8", valueEncoding: "utf8" });
  await db.open();
  const got = new Map();
  for await (const [k, v] of db.iterator({ gte: "!items!", lt: "!items!ÿ" })) got.set(k, JSON.parse(v));
  await db.close();
  rmSync(tmp, { recursive: true, force: true });
  assert.equal(got.size, docs.length);
  for (const d of docs) assert.deepEqual(got.get(d._key), stripKey(d), d.name);
});

const PA = (id) => `Compendium.pf2e-automations.effects.Item.${id}`;
const CID = "cond0000000000id", PF = "Compendium.pf2e.spell-effects.Item.BBBBBBBBBBBBBBBB", MINE = "Compendium.pf2e-automato.effects.Item.OWN0000000000001";
const paEffects = {
  SLOW1: { kind: "conditions", name: "Effect: Slowed 1 for 1 round", steps: [{ slug: "slowed", value: 1 }], duration: { value: 1, unit: "rounds", expiry: "turn-end" } },
  GRAB: { kind: "conditions", name: "Effect: Grabbed", steps: [{ slug: "grabbed" }], duration: null },
  OWN0000000000001: { kind: "own", name: "Spell Effect: Mine" },
  EQV: { kind: "pf2e", name: "Effect: Eq", uuid: PF },
  TRACK: { kind: "marker", name: "Track" },
  IMM: { kind: "immunity", name: "Effect: Jinx Immunity" },
  ARM: { kind: "equipment", name: "Effect: Armor in Earth" }
};
const ctx = { effects: { [PF]: "Spell Effect: Eq", [MINE]: "Spell Effect: Mine" }, paEffects, condSlugs: new Set(["slowed", "grabbed"]), condIds: { slowed: CID, grabbed: CID }, grants: {}, labels: {}, condSlugByUuid: () => null, condNames: [] };
const sp = () => ({ type: "spell", slug: "x", name: "X", traits: [], range: "30 feet" });
const html = `<p>@UUID[Compendium.pf2e.conditionitems.Item.${CID}]</p>`;
const grp = (...effects) => ({ rules: [{ type: "base", triggerType: "spell-cast", target: "SelfEffect", values: [{ effects }], predicate: ["item:slug:x"] }] });
const apply = (r) => r.rule?.onUse.apply;

test("перенос: эффект PA из одних состояний — шаг condition со сроком (origin), без пака", () => {
  const r = translateItem(sp(), html, grp(PA("SLOW1")), ctx);
  assert.deepEqual(apply(r), [{ to: "self", condition: { slug: "slowed", value: 1, policy: "max" }, duration: { value: 1, unit: "rounds", expiry: "turn-end", of: "origin" } }]);
  assert.deepEqual(apply(translateItem(sp(), html, grp(PA("GRAB")), ctx)), [{ to: "self", condition: { slug: "grabbed", policy: "max" } }]);
  assert.deepEqual(r.paEffects, ["SLOW1"]);
});

test("перенос: эффект PA своего пака -> ссылка на наш пак; эквивалент pf2e -> ссылка на pf2e", () => {
  assert.deepEqual(apply(translateItem(sp(), html, grp(PA("OWN0000000000001")), ctx)), [{ to: "self", effect: { uuid: MINE } }]);
  assert.deepEqual(apply(translateItem(sp(), html, grp(PA("EQV")), ctx)), [{ to: "self", effect: { uuid: PF } }]);
  // эффект есть в карте, но справочник refs его не знает — не молчаливый перенос
  assert.equal(translateItem(sp(), html, grp(PA("OWN0000000000001")), { ...ctx, effects: {} }).reason, "effect-missing");
});

test("перенос: иконка активности — не переносится (статус, а не долг); с другими шагами иконка опускается; иммунитет — 0.5c; снаряжение PA — 0.5g; неизвестный — pa-own-effect", () => {
  assert.equal(translateItem(sp(), html, grp(PA("TRACK")), ctx).reason, "activity-marker");
  assert.deepEqual(apply(translateItem(sp(), html, grp(PA("TRACK"), PA("SLOW1")), ctx)).map((a) => a.condition.slug), ["slowed"]);
  assert.equal(translateItem(sp(), html, grp(PA("IMM")), ctx).reason, "immunity-after-save");
  assert.equal(translateItem(sp(), html, grp(PA("ARM")), ctx).reason, "pa-own-equipment");
  assert.equal(translateItem(sp(), html, grp(PA("NOPE")), ctx).reason, "pa-own-effect");
});

test("сводка: not-ported — отдельный статус вне долга; пока снаряжение PA не перенесено — 0.5g", async () => {
  const { statusOf, subpackOf } = await import("../tools/pa-port.mjs");
  assert.deepEqual(statusOf({ paStatus: "not-ported" }, new Map()), { status: "not-ported" });
  assert.equal(subpackOf(["pa-own-equipment"]), "0.5g");
  assert.equal(subpackOf(["pa-own-effect"]), "0.5d");
});

test("срок правила PA переопределяет срок эффекта: единица и значение из правила, недостающее — из эффекта (Slow: 1 раунд -> 1 минута)", async () => {
  const { overrideDuration, nameDegree } = await import("../tools/pa-port.mjs");
  const own = { value: 1, unit: "rounds", expiry: "turn-end" };
  assert.deepEqual(overrideDuration(own, { unit: "minutes" }), { duration: { value: 1, unit: "minutes", expiry: "turn-end" } });
  assert.deepEqual(overrideDuration(own, { value: 3, unit: "rounds" }).duration.value, 3);
  assert.deepEqual(overrideDuration(own, null), { duration: own });
  assert.equal(overrideDuration(null, { unit: "minutes" }).low, "duration-override-unknown");   // у эффекта срока нет, а в правиле нет значения
  assert.equal(overrideDuration(own, { unit: "unlimited" }).duration, null);
  assert.equal(nameDegree("Effect: Aromatic Lure (Critical Failure)"), "criticalFailure");
  assert.equal(nameDegree("Effect: Jinx Failure"), "failure");
  assert.equal(nameDegree("Effect: Successful Feint on"), undefined);
});

test("перенос: срок значения PA доходит до шага condition; у шага effect срок не теряется молча (low); степень в имени против outcome — low; script-эффект — обработчик", () => {
  const SL = { ...paEffects, OWNF: { kind: "own", name: "Effect: Mine (Failure)", dur: { value: 1, unit: "rounds" } }, SCR: { kind: "script", name: "Effect: Share Life" } };
  const c = { ...ctx, paEffects: SL };
  const g = (v, pred = ["item:slug:x"]) => ({ rules: [{ type: "base", triggerType: "spell-cast", target: "SelfEffect", values: [v], predicate: pred }] });
  assert.equal(apply(translateItem(sp(), html, g({ effects: [PA("SLOW1")], duration: { unit: "minutes" } }), c))[0].duration.unit, "minutes");
  const own = translateItem(sp(), html, g({ effects: [PA("OWN0000000000001")], duration: { unit: "minutes" } }), { ...c, paEffects: { ...SL, OWN0000000000001: { kind: "own", name: "Spell Effect: Mine", dur: { value: 1, unit: "rounds" } } } });
  assert.deepEqual(apply(own)[0].duration, { value: 1, unit: "minutes", expiry: null });   // 0.5g4: срок правила — duration у шага effect, а не low
  const same = translateItem(sp(), html, g({ effects: [PA("OWN0000000000001")], duration: { unit: "rounds" } }), { ...c, paEffects: { ...SL, OWN0000000000001: { kind: "own", name: "Spell Effect: Mine", dur: { value: 1, unit: "rounds" } } } });
  assert.equal(apply(same)[0].duration, undefined);
  assert.equal(translateItem(sp(), html, g({ effects: [PA("SCR")] }), c).reason, "script-effect");
  const o = (pred) => g({ effects: [PA("OWNF")] }, ["item:slug:x", ...pred]);
  assert.match(translateItem({ ...sp(), defense: { save: "will" } }, html, { rules: [{ ...o(["outcome:success"]).rules[0], triggerType: "saving-throw" }] }, ctx0(c)).reason, /effect-degree-mismatch/);
});
const ctx0 = (c) => ({ ...c, effects: { ...c.effects, "Compendium.pf2e-automato.effects.Item.OWNF": "Effect: Mine (Failure)" } });

test("перенос: срок правила PA у ссылки на эффект pf2e отличается от срока эффекта — duration у шага (See the Unseen), совпадает — шаг без срока, кубик — строкой", () => {
  const c = { ...ctx, effectDur: { [PF]: { value: 10, unit: "minutes" } } };
  const g = (duration) => ({ rules: [{ type: "base", triggerType: "spell-cast", target: "SelfEffect", values: [{ effects: [PF], duration }], predicate: ["item:slug:x"] }] });
  const r8 = translateItem(sp(), html, g({ value: 8, unit: "hours" }), c);
  assert.doesNotMatch(r8.reason, /effect-duration-override/);
  assert.deepEqual(apply(r8)[0].duration, { value: 8, unit: "hours", expiry: null });
  assert.equal(apply(translateItem(sp(), html, g({ value: 10, unit: "minutes" }), c))[0].duration, undefined);
  assert.deepEqual(apply(translateItem(sp(), html, g({ value: "1d4", unit: "rounds", expiry: "turn-end" }), c))[0].duration, { value: "1d4", unit: "rounds", expiry: "turn-end" });
  assert.deepEqual(apply(translateItem(sp(), html, g({ unit: "hours" }), c))[0].duration, { value: 10, unit: "hours", expiry: null });   // только единица: значение — из эффекта (как PA)
});
