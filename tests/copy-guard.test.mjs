// Ограждение копий NPC (plan-copy-guard.md): состояния правила против состояний текста копии.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initCatalog, resolveRule, guardVerdict, guardCopy, ruleStates, textStates, divergedOf, markupOf } from "../scripts/rules.mjs";
import { ruleOfItem, reactionItems } from "../scripts/reactions.mjs";
import { rev } from "../scripts/settings.mjs";

const labels = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/labels.json", import.meta.url)), "utf8"));
const SRC = "Compendium.pf2e.spells-srd.Item.f45JpY7Ph2cAJGW2";
const FRIGHT = "Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL";
const EFF = "Compendium.pf2e.spell-effects.Item.EEEEEEEEEEEEEEEE";
const slugByUuid = (u) => ({ [FRIGHT]: "frightened" })[u] ?? null;
const cond = (slug) => ({ to: "target", condition: { slug } });
const save = (...steps) => ({ v: 1, label: "r", onUse: { targets: "selected", apply: [], challenge: { statistic: "will", dc: { expr: "markup" }, byDegree: { failure: steps } } } });
const sickened = save(cond("sickened"));
const SICK_TEXT = "<p>@Check[will|dc:20] save.</p><hr /><p><strong>Failure</strong> The target becomes sickened 1.</p>";
const FRIGHT_TEXT = `<p>@Check[will|dc:20] save.</p><hr /><p><strong>Failure</strong> The target is @UUID[${FRIGHT}]{Frightened 1}.</p>`;

const npcItem = (html, extra = {}) => ({ uuid: "Actor.k.Item.evil", type: "spell", name: "Evil Eye", slug: "evil-eye", actor: { type: "npc" }, _stats: { compendiumSource: SRC, modifiedTime: 1 }, system: { description: { value: html }, traits: { value: [] } }, ...extra });
const withGame = (fn, settings = null) => {
  globalThis.game = { pf2e: { ConditionManager: { conditions: new Map([[FRIGHT, { slug: "frightened" }]]) } }, ...(settings && { settings: { get: () => settings } }) };
  try { return fn(); } finally { delete globalThis.game; }
};
const run = (cat, it) => { initCatalog([cat], labels); return withGame(() => resolveRule(it)); };

test("ruleStates: condition.slug из всех веток правила", () => {
  const rule = { onUse: { apply: [cond("a")], challenge: { byDegree: { failure: [cond("b")] } }, check: { byDegree: { success: [cond("c")] } }, zone: { condition: { slug: "d" } } }, onEvent: [{ apply: [cond("e")] }], cast: [{ onUse: { apply: [cond("f")] } }], onAttacked: { x: [cond("g")] } };
  assert.deepEqual([...ruleStates(rule)].sort(), ["a", "b", "c", "d", "e", "f", "g"]);
  assert.equal(ruleStates({ onUse: { apply: [{ to: "self", effect: { uuid: EFF } }] } }).size, 0);
});

test("textStates: слово, @UUID, inflicts:, алиас flat-footed, основа метки {Slow}", () => {
  assert.deepEqual([...textStates("<p>becomes sickened</p>")], ["sickened"]);
  assert.deepEqual([...textStates(FRIGHT_TEXT, slugByUuid)].sort(), ["frightened"]);
  assert.ok(textStates("@Check[will|options:inflicts:blinded]").has("blinded"));
  assert.ok(textStates("is flat-footed").has("off-guard"));
  assert.ok(textStates("@UUID[Compendium.pf2e.spells-srd.Item.x]{Slow} for 1 minute").has("slowed"));
});

test("guardVerdict: другое состояние и потеря состояния отключают; совпадение, «подразумевает» и эффекты — нет", () => {
  assert.deepEqual(guardVerdict(sickened, FRIGHT_TEXT, slugByUuid), { kind: "other", states: ["frightened"] });   // Evil Eye Kepgeda
  assert.deepEqual(guardVerdict(sickened, "<p>Nothing happens.</p>"), { kind: "lost", states: ["sickened"] });
  assert.equal(guardVerdict(sickened, SICK_TEXT), null);
  assert.equal(guardVerdict(save(cond("off-guard")), "<p>The target is grabbed.</p>"), null);   // Tongue Grab: grabbed покрывает off-guard
  assert.equal(guardVerdict(save(cond("flat-footed")), "<p>The target is off-guard.</p>"), null);
  assert.equal(guardVerdict(save(cond("off-guard")), "<p>The target is flat-footed.</p>"), null);
  const haste = { v: 1, onUse: { targets: "self", apply: [{ to: "self", effect: { uuid: EFF } }] } };   // потеря ссылки на эффект — не расхождение (Haste, Read Aura, Stoneskin)
  assert.equal(guardVerdict(haste, "<p>Old text without the effect link.</p>"), null);
  assert.equal(guardVerdict(save(cond("slowed")), "<p>@UUID[Compendium.pf2e.spells-srd.Item.x]{Slow}</p>"), null);
});

test("resolveRule: копия NPC с другим текстом — правило источника пропущено, вывод low + diverged; тот же текст — правило каталога", () => {
  const cat = { bySource: { [SRC]: sickened } };
  const bad = run(cat, npcItem(FRIGHT_TEXT));
  assert.deepEqual([bad.source, bad.confidence, bad.diverged], ["markup", "low", { kind: "other", states: ["frightened"] }]);
  assert.equal(bad.rule.onUse.challenge.byDegree.failure.some((s) => s.condition?.slug === "sickened"), false);
  const ok = run(cat, npcItem(SICK_TEXT, { uuid: "Actor.i.Item.evil" }));
  assert.deepEqual([ok.source, ok.diverged], ["catalog", undefined]);
});

test("resolveRule: нет вывода из разметки — null, но divergedOf помнит расхождение", () => {
  const it = npcItem("<p>Nothing happens.</p>", { uuid: "Actor.n.Item.evil" });
  assert.equal(run({ bySource: { [SRC]: sickened } }, it), null);
  assert.equal(divergedOf(it).kind, "lost");
});

test("guardCopy: только npc/hazard; hazard огораживается, персонаж, предмет без актёра и флаг — нет; мировой каталог — нет", () => {
  const cat = { bySource: { [SRC]: sickened } };
  assert.equal(run(cat, npcItem(FRIGHT_TEXT, { uuid: "A.1", actor: { type: "hazard" } })).source, "markup");
  assert.equal(run(cat, npcItem(FRIGHT_TEXT, { uuid: "A.2", actor: { type: "character" } })).source, "catalog");
  assert.equal(run(cat, npcItem(FRIGHT_TEXT, { uuid: "A.3", actor: undefined })).source, "catalog");
  assert.equal(run(cat, npcItem(FRIGHT_TEXT, { uuid: "A.4", flags: { "pf2e-automato": { rule: save(cond("prone")) } } })).source, "flag");
  initCatalog([{}], labels);
  const w = withGame(() => resolveRule(npcItem(FRIGHT_TEXT, { uuid: "A.5" })), { bySource: { [SRC]: sickened } });
  assert.equal(w.source, "world");   // мировое правило ГМа не огораживается
});

test("пути с origin (use.mjs:151/329 передают origin.uuid): предмет подтягивается и огораживается так же; без предмета — правило каталога", () => {
  initCatalog([{ bySource: { [SRC]: sickened }, bySlug: { "evil-eye": sickened } }], labels);
  const it = npcItem(FRIGHT_TEXT, { uuid: "O.1" });
  globalThis.fromUuidSync = (u) => (u === "O.1" ? it : null);
  try {
    const live = withGame(() => resolveRule({ origin: { uuid: "O.1", sourceId: SRC, slug: "evil-eye" } }));
    assert.equal(live.source, "markup");   // предмет на NPC найден -> копия с другим текстом
    const gone = withGame(() => resolveRule({ origin: { uuid: "O.gone", sourceId: SRC, slug: "evil-eye" } }));
    assert.deepEqual([gone.source, gone.diverged], ["catalog", undefined]);   // предмета нет (удалён) — огораживать нечем
  } finally { delete globalThis.fromUuidSync; }
  assert.equal(withGame(() => resolveRule({ origin: { slug: "evil-eye" } })).source, "catalog");   // путь ruleFor (actions.mjs): origin только со slug
});

test("Grab: шаг с when «цель уже restrained» продлевает состояние; [[/act grapple]] и метки действий дают grabbed/restrained; именные формы меток", () => {
  const grab = { v: 1, label: "Grab", onUse: { targets: "selected", apply: [{ to: "target", when: [{ not: "target:condition:restrained" }], condition: { slug: "grabbed" } }, { to: "target", when: ["target:condition:restrained"], condition: { slug: "restrained" } }] } };
  assert.deepEqual([...ruleStates(grab)], ["grabbed"]);
  assert.equal(guardVerdict(grab, "<p>The bear Grabs the target. @UUID[Compendium.pf2e.conditionitems.Item.g]{Grabbed}</p>", (u) => (u.endsWith(".g") ? "grabbed" : null)), null);
  assert.equal(guardVerdict(grab, "<p>it can use this action to attempt to [[/act grapple]] the target.</p>"), null);
  assert.equal(guardVerdict(save(cond("prone")), "<p>@UUID[Compendium.pf2e.actionspf2e.Item.x]{Trip} the target</p>"), null);
  assert.ok(textStates("@UUID[Compendium.pf2e.spells-srd.Item.x]{Invisibility}").has("invisible"));
  assert.ok(textStates("@UUID[Compendium.pf2e.spells-srd.Item.x]{Petrify}").has("petrified"));
});

test("reactionItems (onAttackMessage): идёт через resolveRule без ошибок, огороженная копия подсказки не даёт", () => {
  const react = { v: 1, onAttacked: { trigger: "attack-on-self", bonus: { stat: "ac", type: "circumstance", value: 1 }, cost: "reaction", notify: ["owner"] } };
  initCatalog([{ bySlug: { "nimble-dodge": react } }], labels);
  const dodge = { uuid: "D.1", type: "feat", name: "Nimble Dodge", slug: "nimble-dodge", actor: { type: "npc" }, _stats: {}, system: { slug: "nimble-dodge", description: { value: "<p>+2 AC.</p>" } } };
  const plain = { uuid: "D.2", type: "feat", name: "Other", slug: "other", _stats: {}, system: { description: { value: "" } } };
  const list = withGame(() => reactionItems({ items: [dodge, plain] }));
  assert.deepEqual(list.map((x) => x.item.name), ["Nimble Dodge"]);
});
test("guardCopy: @Localize раскрывается через английский, иначе не огораживаем; перевод без оригинала не огораживаем, с оригиналом — сравниваем его", () => {
  const rule = sickened, loc = (html, extra = {}) => npcItem(html, { uuid: `L.${Math.random()}`, ...extra });
  const text = "<p>@Localize[PF2E.NPC.Abilities.Glossary.Grab]</p>";
  assert.equal(guardCopy(rule, loc(text), { localize: () => null }), null);                                  // не раскрылось — fail-open
  assert.equal(guardCopy(rule, loc(text), { localize: () => "The target is frightened." }).kind, "other");   // раскрылось — сравнили
  const ru = "<p>Цель становится испуганной.</p>";
  assert.equal(guardCopy(rule, loc(ru)), null);                                                              // нет оригинала + кириллица
  const orig = { flags: { babele: { originalPayload: { description: FRIGHT_TEXT } } } };
  assert.equal(guardCopy(rule, loc(ru, orig), { condSlug: slugByUuid }).kind, "other");
  assert.equal(guardCopy(rule, loc(ru, { flags: { babele: { originalPayload: { description: SICK_TEXT } } } })), null);
});

test("guardCopy: кэш по uuid сбрасывается по modifiedTime и rev.n", () => {
  const it = npcItem(SICK_TEXT, { uuid: "C.1" });
  assert.equal(guardCopy(sickened, it), null);
  it.system.description.value = FRIGHT_TEXT;
  assert.equal(guardCopy(sickened, it, { condSlug: slugByUuid }), null);   // тот же modifiedTime — из кэша
  it._stats.modifiedTime = 2;
  assert.equal(guardCopy(sickened, it, { condSlug: slugByUuid }).kind, "other");
  it.system.description.value = SICK_TEXT;
  rev.n++;
  assert.equal(guardCopy(sickened, it), null);
});

test("ruleOfItem (реакции): то же решение, что у resolveRule — копия с расхождением правила каталога не получает", () => {
  initCatalog([{ bySource: { [SRC]: sickened } }], labels);
  const same = npcItem(SICK_TEXT, { uuid: "R.1" }), diverged = npcItem(FRIGHT_TEXT, { uuid: "R.2" });
  withGame(() => {
    assert.deepEqual(ruleOfItem(same), resolveRule(same).rule);
    assert.equal(ruleOfItem(same).label, "r");
    assert.notEqual(ruleOfItem(diverged)?.label, "r");   // вывод из разметки без метки каталога
    assert.deepEqual(ruleOfItem(diverged), resolveRule(diverged).rule);
  });
});

test("markupOf: русское описание -> английский оригинал Babele для вывода из разметки", () => {
  const ru = { system: { description: { value: "<p><b>Активация:</b> вы сотворяете</p>" } }, flags: { babele: { originalPayload: { description: "<p><strong>Activate</strong> You cast</p>" } } } };
  assert.equal(markupOf(ru), "<p><strong>Activate</strong> You cast</p>");
  const noOrig = { system: { description: { value: "<p>Русский</p>" } } };
  assert.equal(markupOf(noOrig), "<p>Русский</p>", "оригинала нет — как есть");
  const en = { system: { description: { value: "<p>English</p>" } }, flags: { babele: { originalPayload: { description: "<p>Other</p>" } } } };
  assert.equal(markupOf(en), "<p>English</p>", "английское описание не подменяется");
});
