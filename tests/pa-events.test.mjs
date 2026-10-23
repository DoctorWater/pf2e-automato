// 0.5g3, перенос PA (tools/pa-port.mjs + tools/pa-events.mjs) и «при попадании» (tools/onhit.mjs): правила с событием -> onEvent на предмете-владельце. Без Foundry.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.game = { user: { isActiveGM: true }, settings: { get: () => true }, i18n: { localize: (k) => k, format: (k) => k }, modules: { get: () => null } };

const pa = await import("../tools/pa-port.mjs");
const ev = await import("../tools/pa-events.mjs");
const onhit = await import("../tools/onhit.mjs");
const { validateRule } = await import("../scripts/rules.mjs");
const { roundTrip } = await import("../tools/validate.mjs");

const FX = "Compendium.pf2e.feat-effects.Item.AAAAAAAAAAAAAAAA";
const pctx = { effects: { [FX]: "Effect: X" }, condSlugs: new Set(["frightened", "stunned", "grabbed"]), condIds: {}, grants: {}, labels: {}, condSlugByUuid: () => null, condNames: [] };
const feat = (extra = {}) => ({ type: "feat", slug: "my-feat", name: "My Feat", traits: [], actionType: "passive", ...extra });
const group = (rules, extra = {}) => ({ rules: rules.map((r) => ({ type: "base", extend: null, range: null, triggerType: "damage-roll", ...r })), ownSlugs: new Set(["my-feat"]), srcTypes: new Set(["feat"]), ...extra });
const tr = (rules, item = feat(), html = "", opts = {}, g = group(rules)) => pa.translateItem(item, html, g, pctx, opts);

/* ---------- условие записи из предиката ---------- */

const deps = { optStrings: (p, out = []) => { if (typeof p === "string") out.push(p); else if (Array.isArray(p)) p.forEach((x) => deps.optStrings(x, out)); else if (p && typeof p === "object") Object.values(p).forEach((v) => deps.optStrings(v, out)); return out; }, OWN: /^(?:origin:)?(feat|feature|spell):(?:slug:)?([a-z0-9-]+)$/ };

test("eventWhen: тождества предмета и его варианты не нужны; настоящие опции остаются; синтетика PA — отказ", () => {
  const item = { slug: "tumble-behind", uuid: "U" };
  assert.deepEqual(ev.eventWhen([{ or: ["feat:tumble-behind-rogue", "feat:tumble-behind-swashbuckler"] }, "action:tumble-through", { or: ["outcome:success"] }], item, "skill-check", deps).when, ["action:tumble-through", { or: ["outcome:success"] }]);
  assert.deepEqual(ev.eventWhen(["feat:tumble-behind", "origin:item:sourceId:U"], item, "skill-check", deps), { when: null });
  assert.deepEqual(ev.eventWhen(["feat:other"], item, "skill-check", deps).when, ["feat:other"]);   // чужой фит — условие
  assert.deepEqual(ev.eventWhen(["shield:block", "self:effect:shield"], item, "damage-taken", deps).when, ["damage-taken:shield", "self:effect:shield"]);
  assert.deepEqual(ev.eventWhen(["domain:x", "finisher:confident", "target", { gte: ["target:size", 2] }], item, "attack-roll", deps).when, ["domain:x", "finisher:confident", "target", { gte: ["target:size", 2] }]);
  assert.equal(ev.eventWhen(["mType:damage-roll"], item, "damage-roll", deps).fail, "event-predicate:mType:damage-roll");
  assert.equal(ev.eventWhen(["effect:spike-skin"], item, "damage-roll", deps).fail, "event-predicate:effect:spike-skin");   // опции эффекта — только у событий эффекта
  assert.deepEqual(ev.eventWhen(["effect:spike-skin"], item, "effect-created", deps).when, ["effect:spike-skin"]);
  assert.equal(ev.eventWhen(["{actor|signature}"], item, "damage-roll", deps).fail, "event-predicate:{actor|signature}");
});

test("eventWho: Self* — владелец, Target* — другой, Party — партия, SelfOr* — не переносим", () => {
  assert.deepEqual(["SelfEffect", "SelfAddCondition", "IncreaseBadgeEffect", "TurnOnOption", "TargetEffect", "TargetAddCondition", "PartyEffect", "SelfOrTargetEffect"].map(ev.eventWho), ["self", "self", "self", "self", "target", "target", "party", null]);
});

test("EVENT_HANDLERS: каждая запись выдаёт валидное правило onEvent, проходящее форму туда-обратно", () => {
  for (const [name, h] of Object.entries(ev.EVENT_HANDLERS)) {
    if (h.absorbed) continue;   // степени испытания другого handler (Bane: applyBaneImmunity)
    const e = { on: h.side === "origin" ? "effect-created" : "damage-roll", ...(h.side && { side: h.side }), ...(h.steps && { apply: h.steps }), ...(h.once && { once: true }),
      ...(h.challenge && { challenge: h.challenge.byDegree ? h.challenge : { statistic: h.challenge.statistic, dc: h.challenge.dc, byDegree: { failure: [{ condition: { slug: "stunned" } }] } } }) };
    const v = validateRule({ v: 1, onEvent: [e] });
    assert.equal(v.ok, true, `${name}: ${v.errors?.join(";")}`);
    assert.equal(roundTrip(v.rule), true, name);
  }
});

/* ---------- translateItem ---------- */

test("урон: правило PA -> onEvent на владельце, шаг на цель, условие из предиката (исход — тоже условие)", () => {
  const r = tr([{ target: "TargetAddCondition", value: "frightened", predicate: ["outcome:criticalSuccess", "self:effect:stance", "feat:my-feat"] }]);
  assert.equal(r.reason.startsWith("translated"), true, r.reason);
  assert.equal(r.rule.onUse, null);   // только события — onUse не нужен
  assert.deepEqual(r.rule.onEvent, [{ on: "damage-roll", side: "self", when: ["outcome:criticalSuccess", "self:effect:stance"], apply: [{ to: "target", condition: { slug: "frightened", policy: "max" } }] }]);
});

test("ход, урон получен, создание/снятие эффекта: события turn-end, damage-taken, effect-created, effect-deleted", () => {
  const entry = (trigger, pred) => tr([{ triggerType: trigger, target: "SelfEffect", value: FX, predicate: pred }]).rule?.onEvent?.[0];
  assert.equal(entry("end-turn", ["self:effect:x"]).on, "turn-end");
  assert.equal(entry("start-turn", []).on, "turn-start");
  assert.equal(entry("damage-taken", ["self:effect:x"]).on, "damage-taken");
  assert.equal(entry("create-item", ["effect:spike-skin"]).on, "effect-created");
  assert.equal(entry("delete-item", ["effect:spike-skin"]).on, "effect-deleted");
  assert.match(tr([{ triggerType: "end-turn", target: "SelfEffect", value: FX, predicate: ["effect:x"] }]).reason, /event-predicate:effect:x/);   // effect:* — только у событий эффекта
});

test("бросок другого действия: запись onEvent, если у документа нет собственного броска; иначе остаётся check, как раньше", () => {
  const rule = { triggerType: "skill-check", target: "TargetEffect", value: FX, predicate: ["feat:my-feat", "action:demoralize", { or: ["outcome:success", "outcome:criticalSuccess"] }] };
  const r = tr([rule]);
  assert.deepEqual(r.rule.onEvent[0].when, ["action:demoralize", { or: ["outcome:success", "outcome:criticalSuccess"] }]);
  assert.equal(r.rule.onUse, null);
  // бросок без исхода тоже событие (раньше roll-trigger)
  assert.equal(tr([{ ...rule, predicate: ["action:demoralize"] }]).rule.onEvent[0].on, "skill-check");
  // собственный бросок (slug предмета в предикате) в событие не превращается
  assert.equal(tr([{ ...rule, predicate: ["action:my-feat", "outcome:success"] }]).rule?.onEvent, undefined);
});

test("документ не владелец группы: событийные правила не получает (event-carrier), владелец по slug имени группы или по uuid получает", () => {
  const rule = { target: "TargetAddCondition", value: "frightened", predicate: ["action:strike"] };
  assert.match(tr([rule], feat({ slug: "strike", type: "action" })).reason, /event-carrier/);
  assert.equal(tr([rule]).rule.onEvent.length, 1);
  assert.equal(tr([rule], feat({ slug: "renamed" }), "", { viaSource: true }).rule.onEvent.length, 1);
});

test("handler из таблицы: Кувырок сзади, Панаш, Боевое выступление (once) — данные без кода под предмет", () => {
  const h = (value, trigger = "damage-roll", predicate = []) => ({ type: "handler", triggerType: trigger, value, target: "none", predicate });
  const r = tr([h("deleteTumbleBehindOffGuard", "attack-roll", ["self:effect:off-guard-tumble-behind", { or: ["outcome:failure", "outcome:criticalFailure"] }])], feat({ slug: "my-feat" }), "", {}, { rules: [h("deleteTumbleBehindOffGuard", "attack-roll", ["self:effect:off-guard-tumble-behind", { or: ["outcome:failure", "outcome:criticalFailure"] }])], ownSlugs: new Set(["my-feat"]) });
  assert.equal(r.rule.onEvent[0].on, "attack-roll");
  assert.deepEqual(r.rule.onEvent[0].apply, [{ to: "self", removeEffect: { uuid: "Compendium.pf2e-automato.effects.Item.Vh5E1Qgp34sTKfVs" } }]);
  const mp = tr([h("martialPerformance", "damage-roll", ["action:strike"])], feat(), "", {}, { rules: [h("martialPerformance", "damage-roll", ["action:strike"])], ownSlugs: new Set(["my-feat"]) });
  assert.equal(mp.rule.onEvent[0].once, true);
  assert.deepEqual(mp.rule.onEvent[0].apply.map((s) => s.extendEffect.slug), ["aura-inspire-courage", "aura-inspire-defense", "aura-song-of-strength"]);
  // handler вне таблицы (диалог, расчёт урона) остаётся долгом с понятной причиной
  assert.match(tr([h("strategicBypass", "attack-roll", [])], feat(), "", {}, { rules: [h("strategicBypass", "attack-roll", [])], ownSlugs: new Set(["my-feat"]) }).reason, /handler:strategicBypass/);
});

test("handler с испытанием (Оглушающие удары): степени берутся из saving-throw правил группы с тем же токеном, они отдельными частями не идут", () => {
  const sv = (outcome, cond, value) => ({ type: "base", triggerType: "saving-throw", target: "SelfAddCondition", value: cond, predicate: [outcome, "origin:item:stunning-blows"] });
  const rules = [
    { type: "handler", triggerType: "damage-roll", value: "stunningBlows", target: "none", predicate: ["stunning-blows"] },
    sv("outcome:failure", "stunned"), sv("outcome:criticalFailure", "stunned 3")
  ];
  const g = { rules, ownSlugs: new Set(["my-feat"]) };
  const r = pa.translateItem(feat(), "", g, pctx);
  assert.equal(r.reason.startsWith("translated: 1 part"), true, r.reason);
  const e = r.rule.onEvent[0];
  assert.deepEqual([e.on, e.when, e.challenge.statistic, e.challenge.dc], ["damage-roll", ["stunning-blows"], "fortitude", { against: "class" }]);
  assert.deepEqual(Object.keys(e.challenge.byDegree).sort(), ["criticalFailure", "failure"]);
  assert.equal(e.challenge.byDegree.criticalFailure[0].condition.value, 3);
  // saving-throw правил с токеном нет — испытание без степеней не переносим
  assert.match(pa.translateItem(feat(), "", { rules: [rules[0]], ownSlugs: new Set(["my-feat"]) }, pctx).reason, /event-challenge-steps/);
});

test("choiceSetSelection PA -> шаг effect.choice (готовый выбор эффекта, не долг choice-set)", () => {
  const r = tr([{ triggerType: "attack-roll", target: "SelfEffect", value: FX, choiceSetSelection: 5, predicate: ["target", "domain:x", "outcome:success"] }]);
  assert.deepEqual(r.rule.onEvent[0].apply, [{ to: "self", effect: { uuid: FX }, choice: 5 }]);
});

test("продление того же состояния (when target:condition:<то же>) не требует ссылки на состояние в тексте", () => {
  const r = tr([{ triggerType: "postInfo", target: "TargetAddCondition", value: "grabbed", predicate: ["target:condition:grabbed"] }, { triggerType: "postInfo", target: "TargetAddCondition", value: "grabbed", predicate: [{ not: "target:condition:grabbed" }] }], feat({ actionType: "action" }), "Grabs the target.");
  assert.doesNotMatch(r.reason, /condition-not-in-text:grabbed.*condition-not-in-text:grabbed/);
});

/* ---------- «при попадании Удара» ---------- */

const COND = { kWc1fhmv9LBiTuei: "grabbed", eIcWbB5o3pP6OIMe: "immobilized", TBSHQspnbcqxsmjL: "frightened" };
const link = (id, label) => `@UUID[Compendium.pf2e.conditionitems.Item.${id}]{${label}}`;
const hit = (html, slug = "tongue-grab") => onhit.deriveHit(html, { slug, name: "Tongue Grab" }, COND);

test("onhit: «если попал — схвачен» -> onEvent attack-roll на успех, привязанный к Удару через attackEffects", () => {
  const r = hit(`<p>If Belmazog hits a creature with her tongue, that creature becomes ${link("kWc1fhmv9LBiTuei", "Grabbed")} by Belmazog. Unlike with a normal grab, the creature isn't ${link("eIcWbB5o3pP6OIMe", "Immobilized")}, but it can't move.</p>`);
  assert.deepEqual(r.onEvent, [{ on: "attack-roll", side: "self", when: ["item:attack-effect:tongue-grab", { or: ["outcome:success", "outcome:criticalSuccess"] }], apply: [{ to: "target", condition: { slug: "off-guard", policy: "max" } }, { to: "target", effect: { uuid: "Compendium.pf2e-automato.effects.Item.pAfGrabNoImmob01" } }] }]);   // «схвачен, но не обездвижен»: Grabbed в 8.6.1 выдаёт Immobilized
  assert.equal(roundTrip(r), true);
  // без отрицания — само состояние
  assert.equal(hit(`<p>A creature hit by the vine is ${link("kWc1fhmv9LBiTuei", "Grabbed")}.</p>`).onEvent[0].apply[0].condition.slug, "grabbed");
  assert.deepEqual(hit(`<p>A creature hit by the toad's tongue becomes ${link("kWc1fhmv9LBiTuei", "Grabbed")} until the end of the toad's next turn.</p>`).onEvent[0].apply[0].duration, { value: 1, unit: "rounds", expiry: "turn-end", of: "origin" });
  assert.deepEqual(hit(`<p>A Medium or smaller creature hit by the trunk is ${link("kWc1fhmv9LBiTuei", "Grabbed")}.</p>`).onEvent[0].when.at(-1), { lte: ["target:size", 2] });
  assert.equal(hit(`<p>Any creature hit by a claw is ${link("TBSHQspnbcqxsmjL", "Frightened 2")}.</p>`).onEvent[0].apply[0].condition.value, 2);
});

test("onhit: спасбросок, крит, урон, второе состояние, неизвестное состояние, чужая форма предложения — правила нет", () => {
  const g = link("kWc1fhmv9LBiTuei", "Grabbed");
  for (const html of [
    `<p>A creature hit by the tongue must succeed at a @Check[reflex|dc:24] save or become ${g}.</p>`,
    `<p>A creature critically hit by the tongue is ${g}.</p>`,
    `<p>A creature hit by the tongue is ${g} and ${link("TBSHQspnbcqxsmjL", "Frightened 1")}.</p>`,
    `<p>A creature hit by the tongue is ${g}, and the toad begins to strangle it.</p>`,
    `<p>A creature hit by the tongue is ${g}. A creature grabbed in this way takes @Damage[1d6[bludgeoning]] each turn.</p>`,
    `<p>A creature hit by the tongue is ${link("zzzzzzzzzzzzzzzz", "Weird")}.</p>`,
    `<p>When the toad is hit, it is ${g}.</p>`, ""
  ]) assert.equal(hit(html), null, html);
  // разрыв конечности («sever … @Damage») — справка, правило остаётся
  assert.notEqual(hit(`<p>A creature hit by the tongue is ${g}. A creature can sever the tongue by dealing at least @Damage[8[slashing]] damage.</p>`), null);
});

test("onhit: каталог — по slug@action; копии с одинаковым правилом сливаются, с разным — conflicts; нет Удара с такой связью — пропуск", () => {
  const html = {
    a1: `<p>If A hits a creature with her tongue, that creature becomes ${link("kWc1fhmv9LBiTuei", "Grabbed")}.</p>`,
    a2: `<p>If B hits a creature with their tongue, that creature becomes ${link("kWc1fhmv9LBiTuei", "Grabbed")}.</p>`,
    c1: `<p>A creature hit by the claw is ${link("TBSHQspnbcqxsmjL", "Frightened 1")}.</p>`,
    c2: `<p>A creature hit by the claw is ${link("TBSHQspnbcqxsmjL", "Frightened 2")}.</p>`,
    d1: `<p>A creature hit by the vine is ${link("kWc1fhmv9LBiTuei", "Grabbed")}.</p>`
  };
  const items = [["a1", "tongue-grab"], ["a2", "tongue-grab"], ["c1", "fear-claw"], ["c2", "fear-claw"], ["d1", "vine"]].map(([uuid, slug]) => ({ uuid, slug, name: slug, type: "action", embedded: true }));
  const { cat, conflicts, stats } = onhit.buildOnhit(items, html, COND, (it) => (it.uuid === "d1" ? false : true));
  assert.deepEqual(Object.keys(cat), ["tongue-grab@action"]);
  assert.deepEqual(conflicts, ["fear-claw"]);
  assert.deepEqual([stats.docs, stats.linked, stats.noLink], [5, 4, 1]);
  // не NPC-копия и не действие — не берём
  assert.deepEqual(onhit.buildOnhit([{ uuid: "a1", slug: "x", name: "x", type: "feat", embedded: true }, { uuid: "a2", slug: "y", name: "y", type: "action" }], html, COND).cat, {});
  assert.equal(onhit.strikeLinks("Compendium.pf2e.nope.Actor.A.Item.B", "x", "Z:/no/such/dir"), null);
});

test("TokenMark: эффект с меткой в шаге onEvent всегда получает mark:enemy (по всем правилам каталога)", async () => {
  const { readFileSync } = await import("node:fs");
  const has = (u) => u === "U:mark";
  const r = ev.withMarks({ v: 1, onEvent: [{ on: "skill-check", side: "self", apply: [{ to: "self", effect: { uuid: "U:mark" } }, { to: "self", effect: { uuid: "U:plain" } }] }] }, has);
  assert.deepEqual(r.onEvent[0].apply.map((s) => s.mark ?? null), ["enemy", null]);
  assert.equal(roundTrip(validateRule(r).rule), true);
  const cat = JSON.parse(readFileSync(new URL("../rules/catalog.pa.json", import.meta.url), "utf8"));
  for (const rule of [...Object.values(cat.bySource), ...Object.values(cat.bySlug)]) for (const e of rule.onEvent ?? [])
    for (const s of [...(e.apply ?? []), ...Object.values(e.challenge?.byDegree ?? {}).flat()]) if (s.effect) assert.equal(!!s.mark, ev.hasTokenMark(s.effect.uuid), s.effect.uuid);
});

test("Predictable!: степень — шаг effect.choice (2 / 1 / −1), без окна выбора; Боевое выступление ловит и Удар NPC", async () => {
  const { readFileSync } = await import("node:fs");
  const acc = JSON.parse(readFileSync(new URL("../rules/drafts-accepted/pa-port.json", import.meta.url), "utf8")).items;
  const p = acc.find((d) => d.slug === "predictable");
  assert.deepEqual(p.rule.onEvent.map((e) => e.apply[0].choice), [2, 1, -1]);
  assert.equal(validateRule(p.rule).ok, true);
  const h = { type: "handler", triggerType: "damage-roll", value: "martialPerformance", target: "none", predicate: ["action:strike"] };
  const r = pa.translateItem(feat(), "", { rules: [h], ownSlugs: new Set(["my-feat"]) }, pctx);
  assert.deepEqual(r.rule.onEvent[0].when, [{ or: ["action:strike", "self:action:slug:strike"] }]);
});

test("Оглушающие удары: испытание с чертой incapacitation", () => {
  assert.deepEqual(ev.EVENT_HANDLERS.stunningBlows.challenge.traits, ["incapacitation"]);
});

test("событие: опция заменённого эффекта PA переписывается на slug замены pf2e (Bless), без замены — долг", () => {
  const BL = "Compendium.pf2e.spell-effects.Item.BBBBBBBBBBBBBBBB", NO = "Compendium.pf2e.spell-effects.Item.CCCCCCCCCCCCCCCC";
  const c = { ...pctx, effects: { ...pctx.effects, [BL]: "Spell Effect: Bless" }, paEffects: { P1: { name: "Effect: Aura Bless", kind: "pf2e", uuid: BL }, P2: { name: "Effect: Aura Nope", kind: "pf2e", uuid: NO } } };
  const rule = (opt) => [{ target: "TargetAddCondition", value: "frightened", predicate: [opt] }];
  const r = pa.translateItem(feat(), "", group(rule("self:effect:aura-bless")), c);
  assert.deepEqual(r.rule.onEvent[0].when, ["self:effect:bless"]);
  assert.match(pa.translateItem(feat(), "", group(rule("self:effect:aura-nope")), c).reason, /event-predicate:pa-effect/);
});

test("strike / sense-motive: false-coverage подтверждён симулятором PA (no-fire)", async () => {
  const { readFileSync } = await import("node:fs");
  const d = JSON.parse(readFileSync(new URL("../rules/drafts/pa-port.json", import.meta.url), "utf8"));
  for (const slug of ["strike", "sense-motive"]) {
    const x = (d.items ?? d).find((i) => i.slug === slug && i.uuid.includes("actionspf2e"));
    assert.equal(x.paStatus, "false-coverage");
    assert.equal(x.sim, "no-fire");
  }
});

test("eventWhen: варианты по классу (tumble-behind-*) — тождество предмета у любой копии", () => {
  const deps = { optStrings: (x) => JSON.stringify(x).match(/(?:feat|origin:item:sourceId):[\w:-]+/g) ?? [], OWN: /^(?:origin:)?(feat|feature|spell):(?:slug:)?([a-z0-9-]+)$/ };
  for (const slug of ["tumble-behind", "tumble-behind-rogue"])
    assert.deepEqual(ev.eventWhen([{ or: ["feat:tumble-behind-rogue", "feat:tumble-behind-swashbuckler"] }], { slug, uuid: "U" }, "skill-check", deps), { when: null });
  assert.notDeepEqual(ev.eventWhen([{ or: ["feat:aura-of-faith"] }], { slug: "aura-of-courage", uuid: "U" }, "skill-check", deps), { when: null });
});
