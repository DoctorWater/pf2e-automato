// Героям 3-го уровня, кусок 1: правила каталога (Heal, Calm, Grim Tendrils, Dizzying Colors, Darkness…), шок на срок, иммунитет Щита, триаж «одни заметки».
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

globalThis.game = { user: { isActiveGM: true }, settings: { get: () => "auto" }, modules: { get: () => null }, i18n: { localize: (k) => k, format: (k) => k } };
const { validateRule, buildCatalog } = await import("../scripts/rules.mjs");
const { notesOnly } = await import("../tools/validate.mjs");
const { triageItem, makeContext } = await import("../tools/triage.mjs");
const saves = await import("../scripts/saves.mjs");
const { applyCondition } = await import("../scripts/apply.mjs");
const sb = await import("../scripts/builtin/shield-block.mjs");

const cat = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/catalog.json", import.meta.url)), "utf8"));
const S = (id) => cat.bySource[`Compendium.pf2e.spells-srd.Item.${id}`];
const deg = (r, d) => r.onUse.challenge.byDegree[d];

test("catalog.json: все записи проходят validateRule, ключи bySource — UUID компендия", () => {
  for (const f of ["bySource", "bySlug"]) for (const [k, r] of Object.entries(cat[f])) assert.ok(validateRule(r).ok, `${f}.${k}`);
  const { errors, bySource } = buildCatalog([cat]);
  assert.deepEqual(errors, []);
  for (const k of bySource.keys()) assert.match(k, /^Compendium\.pf2e\.[\w-]+\.Item\.\w{16}$/);
});

test("Heal: бросает только нежить; Grim Tendrils: область и только живые", () => {
  const actor = (opts) => ({ uuid: "A", getSelfRollOptions: () => opts });
  const heal = S("rfZpqmj0AIIdkVIs").onUse.challenge;
  assert.equal(saves.challengeApplies(heal, actor(["target:trait:undead"]), "C"), true);
  assert.equal(saves.challengeApplies(heal, actor(["target:trait:humanoid"]), "C"), false);
  const gt = S("k34hDOfIIMAxNL4a").onUse;
  assert.equal(gt.targets, "area");
  assert.deepEqual(gt.challenge.when, ["target:mode:living"]);
  assert.equal(saves.challengeApplies(gt.challenge, actor(["target:mode:living"]), "C"), true);
  assert.equal(saves.challengeApplies(gt.challenge, actor(["target:mode:undead"]), "C"), false);
});

test("Calm: эффект только на успех (и bySlug.calm / calm-emotions перекрыты); провал — заметки", () => {
  for (const r of [S("b515AZlB0sridKSq"), cat.bySlug.calm, cat.bySlug["calm-emotions"]]) {
    assert.equal(deg(r, "success")[0].effect.uuid, "Compendium.pf2e.spell-effects.Item.Qr5rgoZvI4KmFY0N");
    for (const d of ["failure", "criticalFailure"]) assert.ok(deg(r, d).every((s) => s.note && !s.effect));
  }
});

test("Dizzying Colors: крит. провал — шок на срок (stunned без значения), не stunned 3", () => {
  const cf = validateRule(S("UKsIOWmMx4hSpafl")).rule.onUse.challenge.byDegree.criticalFailure;
  const st = cf.find((s) => s.condition.slug === "stunned");
  assert.equal(st.condition.value, undefined);
  assert.deepEqual(st.duration, { value: 1, unit: "rounds", expiry: "turn-start", of: "origin" });
  assert.ok(!JSON.stringify(cat).includes('"stunned","value":3'));
});

test("Invisibility: срок по кругу, одна запись (bySlug)", () => {
  const ap = cat.bySlug.invisibility.onUse.apply;
  assert.deepEqual(ap.map((a) => [a.rank, a.duration.value]), [[{ max: 3 }, 10], [{ min: 4 }, 1]]);
  assert.equal(S("XXqE1eY3w3z6xJCB"), undefined);
});

test("Command / Charm / Shroud of Night / Darkness — одни заметки; Angelic Halo, Maestro's Instrument", () => {
  for (const id of ["aIHY2DArKFweIrpf", "vLA0q0WOK2YPuJs6", "cE7PRAX8Up7fmYef", "4GE2ZdODgIQtg51c"]) assert.ok(notesOnly(validateRule(S(id)).rule), id);
  const d = S("4GE2ZdODgIQtg51c").onUse;
  assert.deepEqual([d.zone ?? null, d.apply.length], [null, 1]);
  assert.match(deg(S("vLA0q0WOK2YPuJs6"), "failure")[0].note, /пересчитать степень с \+4/);
  assert.match(deg(S("cE7PRAX8Up7fmYef"), "failure")[0].note, /без броска/);
  assert.equal(S("w3uGXDVEdbLFZVO0").onUse.targets, "self");
  const a = cat.bySource["Compendium.pf2e.equipment-srd.Item.bAfyWCvgsYDyw3ff"].activate[0];
  assert.deepEqual([a.spell.slice(-16), a.dc, a.rank, a.requires, a.per], ["vLA0q0WOK2YPuJs6", 17, 1, "held", { value: 1, unit: "days" }]);
});

test("триаж: правило из одних заметок — manual notes-only, не «готово»", () => {
  const ctx = makeContext({ refs: { conditions: {}, effects: {} }, catalogJsons: [cat], labels: {} });
  const it = (id, name) => ({ uuid: `Compendium.pf2e.spells-srd.Item.${id}`, pack: "spells-srd", type: "spell", slug: name, name, nameRu: null, level: 1, rank: 1, traits: [], category: null, actionType: null, cost: "2", frequency: null });
  const html = "<p>@Check[will|dc:20] text</p>";
  const r = triageItem(it("aIHY2DArKFweIrpf", "command"), html, ctx);
  assert.deepEqual([r.status, r.reason], ["manual", "notes-only"]);
  assert.equal(triageItem(it("UKsIOWmMx4hSpafl", "dizzying-colors"), html, ctx).status, "catalog");
});

// --- шок на срок и иммунитет Щита: мок актёра как в apply.duration.test.mjs
const registry = new Map();
function mkActor(uuid) {
  let n = 0;
  const items = [];
  const actor = {
    uuid, items, attributes: {},
    get itemTypes() { return { condition: items.filter((i) => i.type === "condition"), effect: items.filter((i) => i.type === "effect") }; },
    getActiveTokens: () => [{ uuid: `Scene.s.Token.${uuid}` }],
    async createEmbeddedDocuments(_, datas) {
      return datas.map((d) => {
        const it = { ...structuredClone(d), id: `i${++n}`, uuid: `${uuid}.Item.i${n}`, actor, isLocked: false };
        it.delete = async () => { items.splice(items.indexOf(it), 1); };
        registry.set(it.uuid, it); items.push(it); return it;
      });
    }
  };
  registry.set(uuid, actor);
  return actor;
}
const setup = () => {
  registry.clear();
  globalThis.game = { ...globalThis.game, pf2e: { ConditionManager: { getCondition: (slug) => ({ uuid: null, name: slug[0].toUpperCase() + slug.slice(1), system: { value: { isValued: ["stunned", "clumsy"].includes(slug) } }, _stats: { compendiumSource: `Compendium.pf2e.conditionitems.Item.${slug}` } }) } } };
  globalThis.foundry = { utils: { getProperty: (o, p) => p.split(".").reduce((a, k) => a?.[k], o), mergeObject: (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...(a[k] ?? {}), ...v } : v; return a; } } };
  globalThis.CONFIG = { PF2E: { Item: { documentClasses: { effect: { validTraits: {} } } } } };
  globalThis.fromUuid = async (u) => registry.get(u) ?? null;
};

test("шок на срок: stunned без значения — detach (pf2e вправе убавить), имя без числа, значение 4 на раунд; со значением — как раньше", async () => {
  setup();
  const t = mkActor("Actor.t"), ctx = { originActor: { uuid: "Actor.a" } };
  const dur = { value: 1, unit: "rounds", expiry: "turn-start", of: "origin" };
  const e = (await applyCondition(t, { slug: "stunned", duration: dur }, { key: "s" }, ctx)).item;
  assert.equal(e.name, "Stunned");
  assert.equal(e.system.rules[0].onDeleteActions.grantee, "detach");
  assert.equal(e.system.rules[0].alterations[0].value, 4);   // с запасом на ручное убавление
  const m = (await applyCondition(t, { slug: "stunned", duration: { ...dur, value: 1, unit: "minutes" } }, { key: "s3" }, ctx)).item;
  assert.equal(m.system.rules[0].alterations[0].value, 40);
  const n = (await applyCondition(t, { slug: "stunned", value: 2, duration: dur }, { key: "s2" }, ctx)).item;
  assert.equal(n.name, "Stunned 2");
  assert.equal(n.system.rules[0].onDeleteActions.grantee, "detach");
});

test("Щит: после блока эффект снят и выдан Shield Immunity (ключ shield-imm), повтор ничего не делает", async () => {
  setup();
  const a = mkActor("Actor.w");
  const shield = (await a.createEmbeddedDocuments("Item", [{ type: "effect", name: "Shield", system: { slug: "spell-effect-shield" } }]))[0];
  shield.slug = "spell-effect-shield";
  a.attributes.shield = { itemId: shield.id };
  a.items.get = (id) => a.items.find((i) => i.id === id);
  registry.set(sb.SHIELD_IMMUNITY, { type: "effect", toObject: () => ({ _id: "x", type: "effect", name: "Shield Immunity", system: { rules: [], duration: { value: 10, unit: "minutes" } }, _stats: {} }) });
  await sb.dropSpellShield(a.uuid, shield.id, 0);
  assert.deepEqual(a.items.map((i) => i.name), ["Shield Immunity"]);
  assert.equal(a.items[0]._stats.compendiumSource, sb.SHIELD_IMMUNITY);
  assert.equal(a.items[0].flags["pf2e-automato"].meta.key, `shield-imm:${shield.id}`);
  await sb.dropSpellShield(a.uuid, shield.id, 0);
  assert.equal(a.items.length, 1);
});

test("шок на срок: срок-кубик бросается до расчёта значения", async () => {
  setup();
  globalThis.Roll = class { constructor(f) { this.f = f; } async evaluate() { return { total: 3 }; } };
  const t = mkActor("Actor.t");
  const e = (await applyCondition(t, { slug: "stunned", duration: { value: "1d4", unit: "rounds", expiry: "turn-start", of: "origin" } }, { key: "sd" }, { originActor: { uuid: "Actor.a" } })).item;
  assert.equal(e.system.duration.value, 3);
  assert.equal(e.system.rules[0].alterations[0].value, 12);
});

test("Щит Amped: Блок ломает последний слой — эффект снят, иммунитет выдан", async () => {
  setup();
  const a = mkActor("Actor.w2");
  const sh = (await a.createEmbeddedDocuments("Item", [{ type: "effect", name: "Amped", system: { slug: "spell-effect-shield-amped", badge: { value: 1 } } }]))[0];
  sh.slug = "spell-effect-shield-amped";
  a.attributes.shield = { itemId: sh.id };
  a.items.get = (id) => a.items.find((i) => i.id === id);
  registry.set(sb.SHIELD_IMMUNITY, { type: "effect", toObject: () => ({ _id: "x", type: "effect", name: "Shield Immunity", system: { rules: [], duration: { value: 10, unit: "minutes" } }, _stats: {} }) });
  await sb.dropSpellShield(a.uuid, sh.id, 1);
  assert.deepEqual(a.items.map((i) => i.name), ["Shield Immunity"]);
});
