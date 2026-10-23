// challenge.immunity (0.5c): схема, форма, ограничение по степеням, блок в чате, перенос из PA и сверка с ручным правилом.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateRule } from "../scripts/rules.mjs";
import { ruleToForm, formToRule } from "../scripts/sheet.mjs";
import { immunityAt, applyImmunity } from "../scripts/checks.mjs";
import { buildViewModel } from "../scripts/chat.mjs";
import { translateItem, manualVerdict, immunityFromText, buildPaCatalog } from "../tools/pa-port.mjs";
import { hasImmunity } from "../scripts/checks.mjs";
import { deriveFromMarkup } from "../scripts/rules.mjs";
import { makeContext } from "../tools/triage.mjs";

const imm = { slug: "fp", duration: { value: 1, unit: "minutes" } };
const ch = (immunity, byDegree = {}) => ({ v: 1, onUse: { targets: "selected", challenge: { statistic: "will", dc: { value: 20 }, immunity, byDegree } } });
const ok = (raw) => { const r = validateRule(raw); assert.ok(r.ok, r.errors?.join("; ")); return r.rule; };

test("validateRule: immunity у challenge; degrees — подмножество, все четыре = любая", () => {
  assert.deepEqual(ok(ch(imm)).onUse.challenge.immunity, imm);
  assert.deepEqual(ok(ch({ ...imm, degrees: ["success", "criticalSuccess"] })).onUse.challenge.immunity.degrees, ["success", "criticalSuccess"]);   // порядок как в DEGREES (индекс = степень успеха)
  assert.equal(ok(ch({ ...imm, degrees: ["criticalSuccess", "success", "failure", "criticalFailure"] })).onUse.challenge.immunity.degrees, undefined);
  for (const degrees of [[], ["nope"], "success"]) assert.equal(validateRule(ch({ ...imm, degrees })).ok, false);
  assert.equal(validateRule(ch({ slug: "x" })).ok, false);   // ни uuid, ни срока
});

test("форма <-> правило: immunity у challenge и check без потерь (в т.ч. degrees)", () => {
  const rules = [
    ch({ ...imm, label: "Невосприимчивость", degrees: ["criticalSuccess"] }),
    ch(imm, { failure: [{ to: "target", condition: { slug: "frightened", value: 2, policy: "max" } }] }),
    { v: 1, onUse: { targets: "selected", check: { statistic: "intimidation", vs: { defense: "will" }, immunity: { ...imm, degrees: ["failure", "criticalFailure"] }, byDegree: {} } } }
  ];
  for (const raw of rules) {
    const rule = ok(raw), f = ruleToForm(rule);
    assert.deepEqual(validateRule(formToRule(f)).rule, rule);
  }
  const f = ruleToForm(ok(ch({ ...imm, degrees: ["success"] })));
  assert.deepEqual(f.ch.imm.deg, { criticalSuccess: false, success: true, failure: false, criticalFailure: false });
  assert.equal(ruleToForm(ok(ch(undefined))).ch.imm.on, false);
});

test("immunityAt: нет degrees — любая степень; applyImmunity при чужой степени ничего не делает", async () => {
  assert.equal(immunityAt(imm, 0), true);
  const only = { ...imm, degrees: ["criticalSuccess"] };
  assert.deepEqual([3, 2, 1, 0].map((d) => immunityAt(only, d)), [true, false, false, false]);
  assert.equal(immunityAt(null, 3), false);
  assert.deepEqual(await applyImmunity({ id: "m" }, "a", { actor: {} }, only, 0), []);
});

const mkEnv = (over = {}) => ({
  t: (k, d) => (d ? `${k}${JSON.stringify(d)}` : k), mode: (k) => ({ zone: "auto", effect: "auto", challenge: "auto", apply: "button" })[k],
  now: 1_000_000_000, resumeMinutes: 30, groups: () => [], toolbelt: false, tokenName: (k) => `tok-${k}`,
  isOwner: () => false, isActorOwner: () => false, isPc: (k) => k === "b", isActorPc: () => false, statLabel: (s) => s, conditionLabel: (s) => s, uuidName: () => null, ...over
});
const msg = (rule, state = {}) => ({ id: "m1", author: { id: "ga" }, flags: { "pf2e-automato": { use: { v: 1, kind: "use", confidence: "high", rule, slug: "fp", createdAt: 1_000_000_000, dc: 20, item: { name: "Fear" }, targets: [{ key: "a", name: "Orc" }, { key: "b", name: "Bob" }], state } } } });
const gm = { id: "gm", isGM: true };

test("чат: иммунная цель испытания — без броска; план иммунитета только при подходящей степени", () => {
  const rule = ok(ch({ ...imm, degrees: ["criticalSuccess", "success"] }, { failure: [{ to: "target", condition: { slug: "frightened", value: 1, policy: "max" } }] }));
  const vm = buildViewModel(msg(rule), gm, mkEnv({ immune: (k) => k === "a" })).challenge;
  const [a, b] = vm.rows;
  assert.deepEqual([a.label, a.canRoll, b.canRoll], ["checks.immune", false, true]);
  const row = (deg) => buildViewModel(msg(rule, { challenge: { results: { b: { degree: deg, total: 9 } }, applied: {} } }), gm, mkEnv({ immune: () => false })).challenge.rows[1];
  assert.equal(row(2).plan.some((p) => /immunityPlan/.test(p)), true);    // успех
  assert.equal(row(1).plan.some((p) => /immunityPlan/.test(p)), false);   // провал: иммунитет не ставится, но состояние — да
  assert.equal(row(2).canApply, true);
  assert.equal(row(1).canApply, true);
});

/* ---------- перенос PA ---------- */

const labels = JSON.parse(readFileSync(new URL("../rules/labels.json", import.meta.url)));
const refs = { conditions: { frightened: { id: "TBSHQspnbcqxsmjL", name: "Frightened", nameRu: "Испуг" } }, effects: {} };
const ctx = { ...makeContext({ refs, labels, catalogJsons: [] }), effects: {}, condSlugs: new Set(["frightened"]), condIds: { frightened: "TBSHQspnbcqxsmjL" } };
const item = { uuid: "Compendium.pf2e.x.Actor.A.Item.1", type: "action", slug: "aura", name: "Aura", traits: [], actionType: "passive", defense: null, target: null, range: null, area: null, embedded: null, source: null };
const paImm = (pred, over = {}) => ({ type: "complex", triggerType: "saving-throw", target: "ImmunitySelfEffect", predicate: [...pred, "item:slug:aura"], values: [{ conditions: [], effects: [], immunities: ["aura"], duration: { expiry: "round-start", unit: "hours", value: 24 }, ...over }] });
const html = `<p>@Check[will|dc:20] save. Regardless of the result, the creature is temporarily immune for 1 minute.</p><p><strong>Critical Success</strong> Unaffected.</p><p><strong>Failure</strong> The creature is @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 1}.</p>`;
const run = (r, h = html) => translateItem(item, h, { rules: [r] }, ctx);

test("pa-port: иммунитет PA -> challenge.immunity; степени из предиката, без исхода — любая; состояния из текста", () => {
  const crit = html.replace("Regardless of the result, the creature is temporarily immune for 1 minute.", "").replace("Unaffected.", "Unaffected and temporarily immune for 24 hours.");
  const a = run(paImm([{ or: ["outcome:success", "outcome:criticalSuccess"] }]), crit);
  assert.equal(a.confidence, "high", a.reason);
  const c = a.rule.onUse.challenge;
  assert.deepEqual(c.immunity, { slug: "aura", duration: { value: 24, unit: "hours" }, degrees: ["criticalSuccess"] });   // степень — из текста (блок «Critical Success»), не из PA
  assert.equal(c.byDegree.failure[0].condition.slug, "frightened");   // каталог перекрывает разметку — шаги берём оттуда
  assert.equal(run(paImm([])).rule.onUse.challenge.immunity.degrees, undefined);
  assert.equal(run(paImm(["outcome:criticalSuccess"])).rule.onUse.challenge.immunity.degrees, undefined);   // текст: «regardless of the result» — любая
  assert.match(run(paImm([]), html.replace(/ Regardless[^.]*\./, "")).reason, /immunity-not-in-text/);   // в тексте иммунитета нет — PA выдумал (Miasma)
  assert.equal(run(paImm([]), html.replace("immune for 1 minute", "immune to all auras of this kind for 1 minute")).rule.onUse.challenge.immunity.scope, "slug");
});

test("pa-port: иммунитет без СЛ в тексте — долг; срок не целый — прежняя причина; не по броску — тоже", () => {
  assert.equal(run(paImm([]), "<p>No save here.</p>").reason, "no-roll-in-doc");   // в документе спасброска нет вовсе: PA на нём не срабатывает -> ложное покрытие (0.5f)
  assert.equal(run(paImm([]), "<p>Make a Will save, but no DC.</p>").reason, "no-save-def");   // спасбросок есть, СЛ нет — долг
  assert.equal(run(paImm([], { duration: { unit: "hours", value: "1d4" } })).reason, "immunity-after-save");
  assert.equal(run({ ...paImm([]), triggerType: "use" }).reason, "immunity-after-save");
});

test("manualVerdict: ручное правило с immunity закрывает долг; без — manual-gap; другой срок — manual-gap", () => {
  const html0 = "<p>Regardless of the result, the creature is temporarily immune to this for 1 minute.</p>";
  const npc = { type: "action", embedded: { actor: "A" } };
  assert.deepEqual(manualVerdict(ok(ch(imm)), npc, null, null, null, html0, true), { status: "covered" });
  assert.deepEqual(manualVerdict(ok(ch(undefined)), npc, null, null, null, html0, true).reasons, ["manual-gap", "immunity-after-save"]);
  const pa = ok(ch({ ...imm, duration: { value: 24, unit: "hours" } }));
  assert.deepEqual(manualVerdict(ok(ch(imm)), npc, pa, null, null, html0).reasons, ["manual-gap", "immunity-after-save"]);
  assert.equal(manualVerdict(ok(ch(imm)), npc, ok(ch(imm)), null, null, html0).status, "covered");
});

test("immunityFromText: степени и охват из текста предмета", () => {
  const t = (s) => immunityFromText(`<p>${s}</p>`);
  assert.equal(t("No such thing.").has, false);
  assert.equal(t("Regardless of the result, the creature is temporarily immune for 1 minute.").degrees, null);
  assert.deepEqual(t("A creature that succeeds at its save is temporarily immune for 1 minute.").degrees, ["success", "criticalSuccess"]);
  assert.deepEqual(t("A creature that critically succeeds is immune for 1 hour.").degrees, ["criticalSuccess"]);
  assert.deepEqual(t("The creature must attempt a save or be blinded for 1 minute and become temporarily immune for 1 day.").degrees, ["failure", "criticalFailure"]);   // Aura of Blinding Light
  assert.deepEqual(immunityFromText("<p>Save.</p><p><strong>Critical Success</strong> Unaffected and immune for 24 hours.</p>").degrees, ["criticalSuccess"]);
  assert.equal(t("A creature that succeeds is temporarily immune to all yzobus' auras for 1 minute.").anySource, true);
});

test("hasImmunity: истёкший эффект не в счёт; scope:slug — от любого автора", () => {
  const eff = (o) => ({ type: "effect", system: { context: { origin: { actor: "A" } }, ...o }, flags: { "pf2e-automato": { immunity: { slug: "x" } } }, _stats: {} });
  const mk = (...items) => ({ items });
  assert.equal(hasImmunity(mk(eff({})), { slug: "x" }, "A"), true);
  assert.equal(hasImmunity(mk(eff({ expired: true })), { slug: "x" }, "A"), false);
  assert.equal(hasImmunity(mk(eff({})), { slug: "x" }, "B"), false);
  assert.equal(hasImmunity(mk(eff({})), { slug: "x", scope: "slug" }, "B"), true);
  assert.equal(hasImmunity(mk(eff({})), { slug: "x", scope: "slug" }, null), true);
});

test("форма: scope:slug туда-обратно; валидатор отвергает прочие значения", () => {
  const r = ok(ch({ ...imm, scope: "slug" }));
  assert.equal(r.onUse.challenge.immunity.scope, "slug");
  assert.deepEqual(validateRule(formToRule(ruleToForm(r))).rule, r);
  assert.equal(validateRule(ch({ ...imm, scope: "author" })).ok, false);
});

test("slug-ключ каталога PA: тёзка без правила (долг) закрывает ключ без типа", () => {
  const it = (uuid, type) => ({ uuid, slug: "blight", type, name: "Blight", embedded: null, source: uuid });
  const rule = ok(ch(imm));
  const d = (uuid, type, r) => ({ uuid, slug: "blight", type, name: "Blight", status: "pa-port", paStatus: "port", confidence: r ? "high" : null, rule: r, reason: "x" });
  const { cat } = buildPaCatalog([d("A", "action", rule), d("S", "spell", null)], [], [it("A", "action"), it("S", "spell")], []);
  assert.equal(cat.bySlug.blight, undefined);          // тёзка-заклинание без правила поймало бы чужое правило
  assert.ok(cat.bySlug["blight@action"]);              // ключ с типом — только для действий
  assert.ok(buildPaCatalog([d("A", "action", rule)], [], [it("A", "action")], []).cat.bySlug.blight);
});

test("разметка: «As failure, but…» наследует состояния и сроки; either/or и условие — в подсказки", () => {
  const U = (id, n) => `@UUID[Compendium.pf2e.conditionitems.Item.${id}]{${n}}`;
  const cr = { clumsy: { id: "ClumsyAAAAAAAAAA" }, stupefied: { id: "StupefiedAAAAAAA" }, slowed: { id: "SlowedAAAAAAAAA" }, fascinated: { id: "FascAAAAAAAAAAAA" } };
  const c = makeContext({ refs: { conditions: cr, effects: {} }, labels, catalogJsons: [] });
  const bd = (body) => {
    const d = deriveFromMarkup({ type: "action", slug: "x", name: "X", system: { description: { value: `<p>@Check[will|dc:20]</p>${body}` }, actionType: { value: "passive" }, traits: { value: [] } } }, c.labels, c.condSlugByUuid, c.condNames);
    return { by: d?.rule.onUse.challenge.byDegree ?? {}, possible: d?.hints.possible ?? [] };
  };
  const dur = (l, s) => l?.find((a) => a.condition.slug === s)?.duration;
  const a = bd(`<p><strong>Failure</strong> The creature becomes ${U("ClumsyAAAAAAAAAA", "Clumsy 1")} and ${U("StupefiedAAAAAAA", "Stupefied 1")} until the start of its next turn.</p><p><strong>Critical Failure</strong> As failure, but ${U("ClumsyAAAAAAAAAA", "Clumsy 2")} and ${U("StupefiedAAAAAAA", "Stupefied 2")}.</p>`);
  assert.equal(dur(a.by.failure, "clumsy")?.expiry, "turn-start");
  assert.equal(dur(a.by.criticalFailure, "clumsy")?.expiry, "turn-start");
  assert.equal(a.by.criticalFailure.find((x) => x.condition.slug === "clumsy").condition.value, 2);
  const b = bd(`<p><strong>Failure</strong> The creature is ${U("SlowedAAAAAAAAA", "Slowed 1")} and ${U("FascAAAAAAAAAAAA", "Fascinated")}.</p><p><strong>Critical Failure</strong> As failure, but ${U("SlowedAAAAAAAAA", "Slowed 3")}.</p>`);
  assert.deepEqual(b.by.criticalFailure.map((x) => x.condition.slug).sort(), ["fascinated", "slowed"]);   // fascinated унаследован
  const e = bd(`<p><strong>Failure</strong> The creature becomes either ${U("ClumsyAAAAAAAAAA", "Clumsy 1")}, ${U("StupefiedAAAAAAA", "Stupefied 1")}, or ${U("SlowedAAAAAAAAA", "Slowed 1")}, at the GM choice.</p>`);
  assert.deepEqual(e.by, {});
  assert.equal(e.possible.length, 3);
  const w = bd(`<p><strong>Failure</strong> The creature is ${U("SlowedAAAAAAAAA", "Slowed 1")}. If it ends its turn adjacent to the source, it is ${U("StupefiedAAAAAAA", "Stupefied 1")}.</p>`);
  assert.deepEqual(w.by.failure.map((x) => x.condition.slug), ["slowed"]);
  assert.deepEqual(w.possible, ["failure:stupefied"]);
});

test("immunityFromText: точки в @UUID не рвут предложение; «is then immune» — при любой степени", () => {
  const u = "@UUID[Compendium.pf2e.conditionitems.Item.abc]{Frightened 1}";
  assert.equal(immunityFromText(`<p>The creature is ${u}. It is then temporarily immune for 1 minute.</p>`).degrees, null);
  assert.equal(immunityFromText(`<p>Must attempt a save or become ${u} and become temporarily immune for 1 day.</p>`).degrees?.[0], "failure");   // Aura of Blinding Light
});

