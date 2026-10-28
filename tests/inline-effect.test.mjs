// Inline-эффект шага: effect: { mods } — схема, RE, рантайм, форма, запрет реакций.
import test from "node:test";
import assert from "node:assert/strict";
import { MOD } from "../scripts/util.mjs";
import { validateRule } from "../scripts/rules.mjs";
import { normalizeMods, rulesOfMods, textOfMods, noReactions, inlineSlug } from "../scripts/inline-effect.mjs";
import { applyInlineEffect } from "../scripts/apply.mjs";
import { ruleToForm, formToRule } from "../scripts/sheet.mjs";
import { stepText } from "../scripts/chat.mjs";

const DUR = { value: 1, unit: "rounds", expiry: "turn-start" };
const rule = (step) => ({ v: 1, onUse: { targets: "selected", apply: [step] } });
const ok = (step) => validateRule(rule(step));
const will = { bonus: { target: "will", type: "status", value: -2 } };

test("валидатор: допустимые кубики, срок обязателен, of разрешён", () => {
  const r = ok({ to: "target", effect: { mods: [will, { speed: { type: "status", value: -10 } }] }, duration: { ...DUR, of: "target" } });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const s = r.rule.onUse.apply[0];
  assert.deepEqual(s.effect, { mods: [will, { speed: { type: "status", value: -10 } }] });
  assert.deepEqual(s.duration, { value: 1, unit: "rounds", expiry: "turn-start", of: "target" });
  assert.equal(ok({ to: "target", effect: { mods: [{ forbid: "reactions" }] }, duration: DUR }).ok, true);
  assert.equal(ok({ to: "target", effect: { mods: [{ weak: { dmg: "fire", value: 5 } }, { resist: { dmg: "physical", value: 5 } }] }, duration: DUR }).ok, true);
});

test("валидатор: без срока, с бессрочным, с лишним — ошибка", () => {
  assert.equal(ok({ to: "target", effect: { mods: [will] } }).ok, false);
  assert.equal(ok({ to: "target", effect: { mods: [will] }, duration: { value: 1, unit: "unlimited" } }).ok, false);
  for (const extra of [{ badge: "increment" }, { replace: true }, { by: 2 }, { start: 2 }, { uuid: "X" }, { name: "x" }]) assert.equal(ok({ to: "target", effect: { mods: [will], ...extra }, duration: DUR }).ok, false, JSON.stringify(extra));
  for (const extra of [{ mark: "enemy" }, { choice: "a" }, { unlessEffect: "U" }]) assert.equal(ok({ to: "target", effect: { mods: [will] }, duration: DUR, ...extra }).ok, false, JSON.stringify(extra));
  assert.equal(ok({ to: "target", effect: { uuid: "X" }, duration: { ...DUR, of: "target" } }).ok, true, "of:target у эффекта по uuid — метка «до конца хода получателя» (Убежище)");
  assert.equal(ok({ to: "target", effect: { uuid: "X" }, duration: { ...DUR, of: "origin" } }).ok, false, "of:origin у эффекта по uuid — по-прежнему нельзя (это и так умолчание)");
});

test("normalizeMods: белый список", () => {
  const bad = [[], null, [{}], [{ raw: {} }], [{ forbid: "actions" }], [{ bonus: { target: "will", type: "status", value: 0 } }], [{ bonus: { target: "xx", type: "status", value: -1 } }],
    [{ bonus: { target: "will", type: "status", value: -1, key: "FlatModifier" } }], [{ bonus: { target: "will", type: "status", value: "-2" } }], [{ weak: { dmg: "fire", value: -5 } }],
    [{ resist: { dmg: "fire", value: 5, except: ["Bad Slug"] } }], [will, will], [{ bonus: { target: "will", type: "status", value: -1 }, speed: { type: "status", value: -5 } }]];
  for (const b of bad) assert.equal(normalizeMods(b).error, true, JSON.stringify(b));
  // знак штраф/бонус не проверяем (источник правды — текст предмета)
  assert.equal(normalizeMods([{ bonus: { target: "ac", type: "circumstance", value: 1 } }]).error, null);
  assert.equal(normalizeMods([{ bonus: { target: "will", type: "status", value: -1 } }, { bonus: { target: "fortitude", type: "status", value: -1 } }]).error, null);
});

test("rulesOfMods: Rule Elements pf2e", () => {
  assert.deepEqual(rulesOfMods([will]), [{ key: "FlatModifier", slug: "af-0", selector: "will", type: "status", value: -2 }]);
  assert.deepEqual(rulesOfMods([{ speed: { type: "status", value: -10 } }]), [{ key: "FlatModifier", slug: "af-0", selector: "all-speeds", type: "status", value: -10 }]);
  assert.deepEqual(rulesOfMods([{ weak: { dmg: "fire", value: 5 } }]), [{ key: "Weakness", slug: "af-0", type: "fire", value: 5 }]);
  assert.deepEqual(rulesOfMods([{ resist: { dmg: "physical", value: 5, except: ["silver"] } }]), [{ key: "Resistance", slug: "af-0", type: "physical", value: 5, exceptions: ["silver"] }]);
  assert.deepEqual(rulesOfMods([{ forbid: "reactions" }]), [{ key: "RollOption", slug: "af-0", domain: "all", option: "af:no-reactions" }]);
});

test("rulesOfMods: у каждого RE свой slug (pf2e не схлопывает одинаковые модификаторы)", () => {
  const r = rulesOfMods([{ bonus: { target: "saving-throw", type: "status", value: -1 } }, { bonus: { target: "will", type: "circumstance", value: -2 } }]);
  assert.equal(new Set(r.map((x) => x.slug)).size, r.length);
});

test("noReactions читает roll options актёра (игнорируемые правила истёкшего эффекта не считаются)", () => {
  const act = (opts) => ({ getRollOptions: (d) => (d[0] === "all" ? opts : []) });
  assert.equal(noReactions(act(["x", rulesOfMods([{ forbid: "reactions" }])[0].option])), true);
  assert.equal(noReactions(act(["x"])), false);
  assert.equal(noReactions({ itemTypes: { effect: [] } }), false);
  assert.equal(noReactions(null), false);
});

// ---- рантайм ----
const registry = new Map();
function mkActor(uuid) {
  let n = 0;
  const items = [];
  const actor = {
    uuid, items,
    get itemTypes() { return { effect: items.filter((i) => i.type === "effect") }; },
    getActiveTokens: () => [{ uuid: `Scene.s.Token.${uuid}` }],
    async createEmbeddedDocuments(_, datas) {
      return datas.map((d) => {
        const it = { ...structuredClone(d), id: `i${++n}`, uuid: `${uuid}.Item.i${n}`, actor };
        it.delete = async () => { items.splice(items.indexOf(it), 1); };
        registry.set(it.uuid, it); items.push(it);
        return it;
      });
    }
  };
  return actor;
}
const LOC = { "PF2E_AUTOMATO.inline.name": "Эффект: {name}", "PF2E_AUTOMATO.workshop.desc.prefix": "Пока действует: {list}.", "PF2E_AUTOMATO.workshop.text.bonus": "{target}: {amount} {kind}",
  "PF2E_AUTOMATO.workshop.targets.will": "Воля", "PF2E_AUTOMATO.workshop.penaltyKind.status": "штраф состояния", "PF2E_AUTOMATO.workshop.bonusKind.status": "бонус состояния" };
const fmt = (k, d) => (LOC[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => d?.[x] ?? "");
const setup = () => { globalThis.game = { i18n: { localize: (k) => fmt(k), format: fmt } }; };
const teardown = () => { delete globalThis.game; };

test("applyInlineEffect: эффект, срок, автор срока, slug, идемпотентность", async () => {
  setup();
  try {
    const t = mkActor("Actor.t"), author = { uuid: "Actor.a" }, item = { uuid: "Item.i", name: "Fetters", slug: "fetters", img: "i.webp", system: { traits: { value: [] } } };
    const spec = { mods: [will], duration: { ...DUR, of: "target" } };
    const r = await applyInlineEffect(t, spec, { key: "k1" }, { originActor: author, originItem: item });
    const e = r.item;
    assert.equal(r.op, "created"); assert.equal(e.type, "effect");
    assert.equal(e.name, "Эффект: Fetters"); assert.equal(e.system.slug, "af-fetters"); assert.equal(e.img, "i.webp");
    assert.deepEqual(e.system.rules, [{ key: "FlatModifier", slug: "af-0", selector: "will", type: "status", value: -2 }]);
    assert.deepEqual(e.system.duration, { sustained: false, value: 1, unit: "rounds", expiry: "turn-start" });
    assert.equal(e.system.context.origin.actor, "Actor.t");   // of:"target" — ход получателя
    assert.equal(e.flags[MOD].meta.key, "k1");
    assert.match(e.system.description.value, /Воля: −2 штраф состояния/);
    assert.equal((await applyInlineEffect(t, spec, { key: "k1" }, { originActor: author, originItem: item })).op, "skipped");
    assert.equal(t.items.length, 1);
    const own = await applyInlineEffect(mkActor("Actor.u"), { mods: [will], duration: DUR }, { key: "k2" }, { originActor: author, originItem: item });
    assert.equal(own.item.system.context.origin.actor, "Actor.a");   // of по умолчанию — origin
  } finally { teardown(); }
});

test("слабость и запрет реакций: срок и заготовка; inlineSlug детерминирован", async () => {
  setup();
  try {
    const t = mkActor("Actor.t"), item = { uuid: "Item.i", name: "X", slug: "af-x" };
    t.getRollOptions = () => t.items.flatMap((i) => i.system.rules).filter((r) => r.key === "RollOption").map((r) => r.option);
    const r = await applyInlineEffect(t, { mods: [{ forbid: "reactions" }], duration: { value: 1, unit: "rounds", expiry: "turn-end" } }, { key: "k" }, { originActor: { uuid: "Actor.a" }, originItem: item });
    assert.equal(noReactions(t), true);
    assert.equal(r.item.system.slug, "af-x");
    await r.item.delete();
    assert.equal(noReactions(t), false);
    assert.equal(inlineSlug("twin-feint"), "af-twin-feint");
  } finally { teardown(); }
});

// ---- форма и чат ----
test("форма: mods <-> строка листа без потерь (text = JSON, of сохраняется)", () => {
  const raw = rule({ to: "target", effect: { mods: [will, { forbid: "reactions" }] }, duration: { value: 1, unit: "rounds", expiry: "turn-end", of: "target" } });
  const v = validateRule(raw);
  assert.equal(v.ok, true);
  const form = ruleToForm(v.rule);
  const row = form.apply?.[0] ?? form.rows?.[0] ?? Object.values(form).flat().find((x) => x?.kind === "effect");
  assert.equal(row.kind, "effect"); assert.equal(row.durOf, "target");
  assert.deepEqual(JSON.parse(row.text), [will, { forbid: "reactions" }]);
  const back = validateRule(formToRule(form));
  assert.equal(back.ok, true, JSON.stringify(back.errors));
  assert.deepEqual(back.rule.onUse.apply[0], v.rule.onUse.apply[0]);
});

test("карточка: шаг mods показывается текстом кубиков, без «?»", () => {
  const env = { t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k), uuidName: () => null, conditionLabel: (s) => s };
  const s = stepText({ to: "target", effect: { mods: [will] } }, env, "target");
  const text = JSON.stringify(s);
  assert.ok(text.includes("workshop.text.bonus") && text.includes("workshop.targets.will"), text);
  assert.ok(!text.includes('"?"') && !/[^a-z.]\?/.test(text.replace(/"\?"/g, "")), text);
});
