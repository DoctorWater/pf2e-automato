// K7: права сокета, forced-операторы, низкоуверенные шаги/зона, дозапуск области, chat-блок, разметка K8.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

globalThis.foundry = { data: { regionBehaviors: { RegionBehaviorType: class {} }, fields: new Proxy({}, { get: () => class {} }) } };
const { allowed, forcedDelete, forcedReplace } = await import("../scripts/util.mjs");
const use = await import("../scripts/use.mjs");
const { buildViewModel } = await import("../scripts/chat.mjs");
const { deriveFromMarkup } = await import("../scripts/rules.mjs");

const MOD = "pf2e-automato";
const rd = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8"));

/* ---------- права отправителя ---------- */

test("allowed: gm / author / owner", () => {
  const gm = { id: "g", isGM: true }, pl = { id: "p", isGM: false };
  for (const need of ["gm", "author", "owner"]) assert.equal(allowed(gm, need), true);
  assert.equal(allowed(pl, "gm", { authorId: "p", owns: true }), false);          // только ГМ — даже автору
  assert.equal(allowed(pl, "author", { authorId: "p" }), true);
  assert.equal(allowed(pl, "author", { authorId: "q" }), false);
  assert.equal(allowed(pl, "author", {}), false);                                  // нет автора (сообщение не найдено)
  assert.equal(allowed(pl, "owner", { owns: true }), true);
  assert.equal(allowed(pl, "owner", { owns: false }), false);
  assert.equal(allowed(undefined, "owner", { owns: true }), false);                // неизвестный отправитель
});

test("forcedDelete/forcedReplace: устаревший синтаксис без операторов, операторы v14 при наличии", () => {
  assert.deepEqual(forcedDelete("flags.m.use.state.apply.k1"), { "flags.m.use.state.apply.-=k1": null });
  assert.deepEqual(forcedReplace("flags.m.rule", { a: 1 }), { "flags.m.==rule": { a: 1 } });
  class Del {} class Rep { constructor(v) { this.v = v; } static create(v) { return new Rep(v); } }
  const prev = globalThis.foundry;
  globalThis.foundry = { data: { operators: { ForcedDeletion: Del, ForcedReplacement: Rep } } };
  try {
    const d = forcedDelete("flags.m.use.state.apply.k1");
    assert.deepEqual(Object.keys(d), ["flags.m.use.state.apply.k1"]);
    assert.ok(d["flags.m.use.state.apply.k1"] instanceof Del);
    assert.ok(forcedReplace("flags.m.rule", 5)["flags.m.rule"] instanceof Rep);
  } finally { globalThis.foundry = prev; }
});

/* ---------- use: производные шаги, зона, дозапуск области ---------- */

function world(modes, messages, regions = []) {
  globalThis.game = {
    settings: { get: (m, k) => ({ ...modes, resumeMinutes: 30 })[k] },
    messages: { contents: messages, get: (id) => messages.find((x) => x.id === id) },
    scenes: { contents: [{ regions: { contents: regions } }] }
  };
  globalThis.fromUuid = async () => null;
  globalThis.fromUuidSync = (u) => regions.find((r) => r.uuid === u) ?? null;
  for (const m of messages) m.update = async (patch) => {
    for (const [k, v] of Object.entries(patch)) {
      const parts = k.split("."), last = parts.pop();
      let o = m; for (const p of parts) o = (o[p] ??= {});
      if (last.startsWith("-=")) delete o[last.slice(2)]; else o[last] = v;
    }
  };
}
const mk = (id, rule, extra = {}) => ({ id, flags: { [MOD]: { use: { v: 1, kind: "use", rule, confidence: "high", createdAt: Date.now(), targets: [], state: {}, ...extra } } } });
const st = (m) => m.flags[MOD].use;
const ZONE = { v: 1, onUse: { targets: "area", zone: { condition: { slug: "concealed" } }, challenge: null, apply: [{ to: "self", condition: { slug: "frightened", value: 1 } }] } };
const region = (id, messageId) => ({ uuid: `Scene.s.Region.${id}`, flags: { pf2e: { messageId, origin: {} } }, parent: { tokens: { contents: [] } } });

test("runRegion low: регион запоминается в state.zone (pending), шаг зоны — в derived.pending (п.3)", async () => {
  const m = mk("m", ZONE, { confidence: "low" });
  world({ "mode.zone": "auto" }, [m]);
  await use.runRegion(region("r", "m"), m);
  assert.deepEqual(st(m).state.zone, { regionUuid: "Scene.s.Region.r", status: "pending" });
  assert.deepEqual(st(m).state.derived, { pending: ["zone"], applied: [] });
});

test("chat: у low-зоны «Создать зону» скрыта (есть derived), у обычной pending — показана (п.3)", () => {
  const env = { t: (k) => k, mode: () => "auto", now: 1, resumeMinutes: 30, groups: () => [], toolbelt: false, tokenName: String, isOwner: () => false, isActorOwner: () => false, statLabel: String, conditionLabel: String, uuidName: () => null };
  const gm = { id: "g", isGM: true };
  const msg = (state) => ({ id: "m", author: { id: "g" }, flags: { [MOD]: { use: { v: 1, kind: "use", confidence: "low", rule: ZONE, createdAt: 1, targets: [], state } } } });
  const low = buildViewModel(msg({ zone: { regionUuid: "R", status: "pending" }, derived: { pending: ["zone"], applied: [] } }), gm, env);
  assert.equal(low.zone.canCreate, false);
  assert.deepEqual(low.derived.map((d) => d.key), ["zone"]);
  const high = buildViewModel(msg({ zone: { regionUuid: "R", status: "pending" } }), gm, env);
  assert.equal(high.zone.canCreate, true);
});

test("chat: awaitingRegion показывается и при state.done (п.13)", () => {
  const env = { t: (k) => k, mode: () => "auto", now: 1, resumeMinutes: 30, groups: () => [], toolbelt: false, tokenName: String, isOwner: () => false, isActorOwner: () => false, statLabel: String, conditionLabel: String, uuidName: () => null };
  const m = { id: "m", author: { id: "g" }, flags: { [MOD]: { use: { v: 1, kind: "use", confidence: "high", rule: ZONE, createdAt: 1, targets: [], state: { awaitingRegion: true, done: true } } } } };
  assert.equal(buildViewModel(m, { id: "g", isGM: true }, env).awaitingRegion, "chat.awaitingRegion");
});

test("applyDerived: не ожидаемый/применённый шаг, режим off (п.11)", async () => {
  const rule = { v: 1, onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "frightened", value: 1 } }] } };
  const m = mk("m", rule, { confidence: "low", state: { derived: { pending: ["u0", "u1"], applied: ["u1"] } } });
  world({ "mode.effect": "off", "mode.zone": "auto" }, [m]);
  await assert.rejects(() => use.applyDerived("m", "u5"), /не ожидается/);
  assert.equal(await use.applyDerived("m", "u1"), false);                           // уже применён
  await assert.rejects(() => use.applyDerived("m", "u0"), /режим off/);
});

test("applyUse: low и kind card отклоняются (п.11)", async () => {
  const rule = { v: 1, onUse: { targets: "self", apply: [{ to: "self", condition: { slug: "frightened" } }] } };
  const low = mk("l", rule, { confidence: "low" }), card = mk("c", rule, { kind: "card" });
  world({ "mode.effect": "button" }, [low, card]);
  await assert.rejects(() => use.applyUse("l"), /недоступно/);
  await assert.rejects(() => use.applyUse("c"), /недоступно/);
});

test("createZone: регион чужого сообщения / не из state.zone отклоняется (п.11)", async () => {
  const m = mk("m", ZONE, { state: { zone: { regionUuid: "Scene.s.Region.ok", status: "pending" } } });
  world({ "mode.zone": "button" }, [m], [region("ok", "other"), region("alien", "m")]);
  await assert.rejects(() => use.createZone("m", "Scene.s.Region.ok"), /не принадлежит/);
  await assert.rejects(() => use.createZone("m", "Scene.s.Region.alien"), /не ожидает/);
  await assert.rejects(() => use.createZone("m", "Scene.s.Region.none"), /не принадлежит/);
});

test("resumePending: готовое сообщение с областью без state.area берёт последний живой регион (п.5)", async () => {
  const m = mk("m", ZONE, { state: { done: true } });
  const old = region("r1", "m"), last = region("r2", "m");
  world({ "mode.zone": "button", "mode.effect": "off", "mode.challenge": "off", "mode.macro": "off" }, [m], [old, region("x", "zzz"), last]);
  await use.resumePending({ maxAgeMinutes: 30 });
  assert.equal(st(m).state.zone.regionUuid, "Scene.s.Region.r2");
  // область уже снята — повторный дозапуск ничего не делает
  const m2 = mk("m2", ZONE, { state: { done: true, zone: { regionUuid: "Scene.s.Region.r1", status: "active" } } });
  world({ "mode.zone": "button" }, [m2], [old]);
  await use.resumePending({ maxAgeMinutes: 30 });
  assert.equal(st(m2).state.zone.status, "active");
});

/* ---------- deriveFromMarkup на описаниях K8 (п.10) ---------- */

const labels = rd("rules/labels.json");
const campaign = rd("inventory-campaign.json").items;
const COND = {
  dfCMdR4wnpbYNTix: "stunned", fesd1n5eVhpCSS18: "sickened", j91X7x0XSomq8d60: "prone", eIcWbB5o3pP6OIMe: "immobilized",
  AJh5ex99aV6VTggg: "off-guard", DmAIPqOBomZ7H95W: "concealed", iU0fEDdBp3rXpTMC: "hidden", VRSef5y1LmL2Hkjf: "undetected",
  AdPVz7rbaVSRxHFg: "fascinated", TBSHQspnbcqxsmjL: "frightened", Yl48xTdMh3aeQYL2: "wounded"
};
const slugOfUuid = (u) => (/conditionitems/.test(u) ? COND[u.split(".").pop()] ?? null : null);
const derive = (key) => {
  const i = campaign.find((x) => x.key === key);
  assert.ok(i, key);
  return deriveFromMarkup({ type: i.type, name: i.name, slug: i.slug, system: { description: { value: i.description }, defense: i.defense, area: i.area, selfEffect: i.selfEffect } }, labels, slugOfUuid);
};
const slugsIn = (by) => Object.fromEntries(Object.entries(by).map(([d, l]) => [d, l.map((a) => a.condition?.slug)]));

test("K8 «Отвести глаза»: состояния восприятия не ставятся на цель, испытание остаётся high", () => {
  const d = derive("action|Отвести глаза");
  assert.equal(d.confidence, "high");
  assert.deepEqual(d.rule.onUse.challenge.byDegree, {});
  assert.deepEqual(d.hints.excluded.sort(), ["criticalFailure:undetected", "failure:hidden", "success:concealed"]);
});

test("K8 «Гипнотический приказ»: off-guard -> подсказка, шок (stunned) остаётся", () => {
  const d = derive("action|Гипнотический приказ");
  assert.equal(d.confidence, "high");
  assert.deepEqual(slugsIn(d.rule.onUse.challenge.byDegree), { failure: ["stunned"], criticalFailure: ["stunned"] });
  assert.deepEqual(d.hints.excluded, ["success:off-guard"]);
});

test("K8 «Вкрадчивое слово»: off-guard -> подсказка, fascinated на крит. провал остаётся", () => {
  const d = derive("action|Вкрадчивое слово");
  assert.deepEqual(slugsIn(d.rule.onUse.challenge.byDegree), { criticalFailure: ["fascinated"] });
  assert.deepEqual(d.hints.excluded, ["success:off-guard"]);
});

test("K8 «Боевая медицина»: иммунитет получает цель, low", () => {
  const d = derive("feat|battle-medicine");
  assert.equal(d.confidence, "low");
  assert.equal(d.rule.onUse.targets, "selected");
  assert.deepEqual(d.rule.onUse.apply.map((a) => a.to), ["target"]);
});

test("K8 «Блестящее сияние»: условный off-guard не превращается в зону; «Дымовая завеса» — зона low", () => {
  assert.equal(derive("action|baleful-glow"), null);
  const smoke = derive("action|Дымовая завеса");
  assert.equal(smoke.confidence, "low");
  assert.equal(smoke.rule.onUse.zone.condition.slug, "concealed");
});

test("K8 «Злобный взгляд пугала»: frightened по степеням остаётся high (регрессия)", () => {
  const d = derive("action|scarecrows-leer");
  assert.equal(d.confidence, "high");
  assert.deepEqual(slugsIn(d.rule.onUse.challenge.byDegree), { success: ["frightened"], failure: ["frightened", "fascinated"], criticalFailure: ["frightened"] });
});

test("B3: яд/боеприпас/масло с эффектом — low, обычный расходник — high", () => {
  const E = "Compendium.pf2e.equipment-effects.Item.eff00000000000x";
  const d = (sys) => deriveFromMarkup({ type: "consumable", name: "T", system: { description: { value: `<p>@UUID[${E}]</p>` }, ...sys } }, labels, slugOfUuid);
  assert.equal(d({}).confidence, "high");
  assert.equal(d({ traits: { value: ["poison"] } }).confidence, "low");
  assert.equal(d({ category: "ammo" }).confidence, "low");
  assert.equal(d({ category: "oil" }).confidence, "low");
});

test("passive: пассивная черта с эффектом в тексте не даёт правила, активная — low", () => {
  const E = "Compendium.pf2e.feat-effects.Item.eff00000000000x";
  const d = (actionType) => deriveFromMarkup({ type: "feat", name: "Bloodline", system: { actionType: { value: actionType }, description: { value: `<p>@UUID[${E}]</p>` } } }, labels, slugOfUuid);
  assert.equal(d("passive"), null);
  assert.equal(d("action").confidence, "low");
});

/* ---------- Toolbelt: результат приходит хуком, без saving-throw-сообщения ---------- */

test("acceptToolbeltSave: бросок и переброс пишутся в результаты; чужое/без испытания игнорируется", async () => {
  const { acceptToolbeltSave } = await import("../scripts/saves.mjs");
  const rule = { v: 1, onUse: { targets: "selected", challenge: { statistic: "reflex", dc: { value: 15 }, basic: true, byDegree: {} }, apply: [] } };
  const m = mk("tb", rule, { targets: [{ key: "t1", uuid: "Scene.s.Token.t1" }] });
  world({ "mode.apply": "button", useToolbeltTargetHelper: false }, [m]);
  globalThis.game.user = { isActiveGM: true, id: "gm" };
  globalThis.game.users = { activeGM: { id: "gm" } };
  const target = { id: "t1" };
  await acceptToolbeltSave({ data: { success: "failure", value: 12 }, message: m, roll: {}, target });
  assert.deepEqual([st(m).state.challenge.results.t1.degree, st(m).state.challenge.results.t1.src], [1, "toolbelt"]);
  await acceptToolbeltSave({ data: { success: "success", value: 19 }, message: m, roll: {}, target });   // не переброс — дубль игнорируется
  assert.equal(st(m).state.challenge.results.t1.degree, 1);
  await acceptToolbeltSave({ data: { success: "success", value: 19 }, message: m, roll: {}, target, isReroll: true });
  assert.deepEqual([st(m).state.challenge.results.t1.degree, st(m).state.challenge.results.t1.total], [2, 19]);
  assert.equal(await acceptToolbeltSave({ data: { success: "bogus", value: 1 }, message: m, roll: {}, target }), null);
  const noCh = mk("n", { v: 1, onUse: { targets: "self", apply: [] } });
  assert.equal(await acceptToolbeltSave({ data: { success: "success", value: 1 }, message: noCh, roll: {}, target }), null);
});

test("B4: «невосприимчива» (pf2ru) и «иммунитет» — эффект получает цель", () => {
  const E = "Compendium.pf2e.feat-effects.Item.eff00000000000x";
  const d = (text) => deriveFromMarkup({ type: "action", name: "T", system: { actionType: { value: "action" }, description: { value: `<p>${text} @UUID[${E}]</p>` } } }, labels, slugOfUuid);
  for (const text of ["Цель становится невосприимчива к этому действию на 1 час.", "Цель получает иммунитет к этому действию на 1 час."]) assert.equal(d(text).rule.onUse.apply[0].to, "target", text);
  assert.equal(d("Вы получаете бонус.").rule.onUse.apply[0].to, "self");
});
