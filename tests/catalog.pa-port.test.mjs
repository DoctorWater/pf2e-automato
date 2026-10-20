// Перенос pf2e-automations: сущности кампании и общие действия в rules/catalog.campaign.json (pa-port-report.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

globalThis.game = {
  user: { isActiveGM: true },
  settings: { get: (_m, k) => ({ "mode.macro": "auto" })[k] ?? "auto" },
  i18n: { localize: (k) => k, format: (k) => k },
  pf2e: { ConditionManager: { conditions: new Map() } }
};
globalThis.ui = { notifications: { warn() {} } };

const { validateRule, buildCatalog, initCatalog, resolveRule } = await import("../scripts/rules.mjs");
const { BUILTIN } = await import("../scripts/builtin/index.mjs");
const strike = await import("../scripts/builtin/intimidating-strike.mjs");

const read = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"));
const builtin = read("../rules/catalog.json"), campaign = read("../rules/catalog.campaign.json"), labels = read("../rules/labels.json");
const inv = [...read("../inventory-campaign.json").items, ...read("../party-inventory.json").items];

const SP = "Compendium.pf2e.spells-srd.Item.", FT = "Compendium.pf2e.feats-srd.Item.", AC = "Compendium.pf2e.actionspf2e.Item.", EQ = "Compendium.pf2e.equipment-srd.Item.";
// slug -> [источник | null, тип предмета]
const ENT = {
  figment: [SP + "0zU8CPejjQFnhZFI", "spell"], guidance: [SP + "izcxFQFwf3woCnFs", "spell"], daze: [SP + "4gBIw4IDrSfFHik4", "spell"],
  "forbidding-ward": [SP + "RA7VKcen3p56rVyZ", "spell"], "runic-weapon": [SP + "TFitdEOpQC4SzKQQ", "spell"], "phantom-pain": [SP + "R8bqnYiThB6MYTxD", "spell"],
  soothe: [SP + "szIyEsvihc5e1w8n", "spell"], "intimidating-strike": [FT + "lkcM4V3VDAtjlR9P", "feat"], light: [SP + "WBmvzNDfpwka3qT4", "spell"],
  "breathe-fire": [SP + "y6rAdMK6EFlV6U0t", "spell"], "scarecrows-leer": [null, "action"],
  "potency-crystal": [EQ + "ZCsksGf6NPUKz2Uw", "consumable"], "potency-crystal-greater": [EQ + "aSRUX4WGfalK4A5J", "consumable"], "potency-crystal-major": [EQ + "9a7nJAErs4dfetFJ", "consumable"],
  "bravos-brew-lesser": [EQ + "zM9VX3QwM81DzDUA", "consumable"], "bravos-brew-moderate": [EQ + "oCuwJ9IUDAuzsUwa", "consumable"], "bravos-brew-greater": [EQ + "sWPkbSlWAEAStBqD", "consumable"],
  "dirty-trick": [FT + "5eNKs6738aykAhK2", "feat"],
  demoralize: [AC + "2u915NdUyQan6uKF", "action"], feint: [AC + "QNAVeNKtHA0EUw4X", "action"], trip: [AC + "ge56Lu1xXVFYUnLP", "action"], grapple: [AC + "PMbdMWc2QroouFGD", "action"],
  shove: [AC + "7blmbDrQFNfdT731", "action"], disarm: [AC + "Dt6B1slsBy8ipJu9", "action"], reposition: [AC + "lOE4yjUnETTdaf2T", "action"], escape: [AC + "SkZAQRkLLkmBQNB9", "action"],
  "tumble-through": [AC + "21WIfSu7Xd7uKqV8", "action"], "create-a-diversion": [AC + "GkmbTGfg8KcgynOA", "action"], "bon-mot": [FT + "0GF2j54roPFIDmXf", "feat"], aid: [AC + "HCl3pzVefiv9ZKQW", "action"],
  "treat-wounds": [AC + "1kGNdIIhuglAjIp9", "action"], "battle-medicine": [FT + "wYerMk6F1RZb0Fwt", "feat"], "treat-poison": [AC + "KjoCEEmPGTeFE4hh", "action"],
  "treat-disease": [AC + "TC7OcDa7JlWbqMaN", "action"], "command-an-animal": [AC + "q9nbyIF0PEBqMtYe", "action"], "drop-prone": [AC + "HYNhdaPtF1QmQbR3", "action"]
};
const PORTED = Object.keys(ENT).filter((s) => s !== "breathe-fire");   // Дыхание огнём уже в catalog.json

const cat = buildCatalog([builtin, campaign]);
const rule = (slug) => cat.bySlug.get(slug);
const steps = (slug, deg) => rule(slug).onUse.check.byDegree[deg] ?? [];
const conds = (list) => list.filter((s) => s.condition);

test("pa-port: каталог собирается без ошибок; каждая сущность есть в bySource и bySlug (где есть источник/slug)", () => {
  assert.deepEqual(cat.errors, []);
  for (const [slug, [src]] of Object.entries(ENT)) {
    assert.ok(rule(slug), `bySlug.${slug}`);
    if (src) assert.deepEqual(cat.bySource.get(src), rule(slug), `bySource.${slug}`);
  }
  for (const k of cat.bySource.keys()) assert.match(k, /^Compendium\.pf2e\.[\w-]+\.Item\.\w{16}$/);
});

test("pa-port: resolveRule на предметах (инвентарь героев/мира или синтетический по slug+источнику) даёт каталог", () => {
  initCatalog([builtin, campaign], labels);
  try {
    for (const [slug, [src, type]] of Object.entries(ENT)) {
      const real = inv.find((i) => i.slug === slug && (i.compendiumSource ?? null) === src);
      const item = real
        ? { type: real.type, name: real.name, slug, _stats: { compendiumSource: src }, system: { description: { value: real.description }, defense: real.defense, area: real.area, target: real.target, selfEffect: real.selfEffect, traits: { value: real.traits } } }
        : { type, name: slug, slug, _stats: { compendiumSource: src }, system: { description: { value: "" }, traits: { value: [] } } };
      const r = resolveRule({ item });
      assert.equal(r?.source, "catalog", slug);
      assert.deepEqual(r.rule, rule(slug), slug);
      if (src) assert.equal(resolveRule({ item: { ...item, slug: null } })?.source, "catalog", `${slug}: по источнику без slug`);
    }
    // выписанные из инвентаря сущности кампании действительно там есть (иначе проверка выше синтетическая)
    for (const s of ["figment", "guidance", "daze", "forbidding-ward", "phantom-pain", "light", "intimidating-strike", "scarecrows-leer", "breathe-fire", "dirty-trick"])
      assert.ok(inv.some((i) => i.slug === s), `${s} в инвентаре`);
  } finally { initCatalog([builtin], labels); }
});

test("pa-port: 13 сущностей кампании — эффекты и степени как в тексте", () => {
  const apply = (s) => rule(s).onUse.apply;
  const effs = (s) => apply(s).filter((a) => a.effect).map((a) => `${a.to}:${a.effect.uuid.split(".").pop()}`);
  assert.deepEqual(effs("figment"), ["self:2Hg3a06gZCSnUgSA"]);
  assert.deepEqual(effs("guidance"), ["target:3qHKBDF7lrHw8jFK", "target:3LyOkV25p7wA181H"]);   // бонус и иммунитет сразу
  assert.deepEqual(effs("forbidding-ward"), ["target:ctMxYPGEpstvhW9C"]);
  assert.deepEqual(effs("runic-weapon"), ["target:GnWkI3T3LYRlm3X8"]);
  assert.deepEqual(effs("soothe"), ["target:nkk4O5fyzrC0057i"]);
  assert.deepEqual(effs("light"), ["target:cVVZXNbV0nElVOPZ"]);
  for (const s of ["potency-crystal", "potency-crystal-greater", "potency-crystal-major"]) assert.deepEqual(effs(s), ["self:R5ugeFK3MPwkbv0s"]);
  for (const s of ["bravos-brew-lesser", "bravos-brew-moderate", "bravos-brew-greater"]) assert.deepEqual(effs(s), ["self:eh7EqmDBDW30ShCu"]);
  // Ступор: простой Воли, крит. провал — ошеломление 1; Фантомная боль: тошнота 1/2
  const daze = rule("daze").onUse.challenge;
  assert.equal(daze.basic, true);
  assert.deepEqual(daze.byDegree.criticalFailure.map((a) => a.condition), [{ slug: "stunned", value: 1, policy: "max" }]);
  const pain = rule("phantom-pain").onUse.challenge.byDegree;
  assert.equal(pain.failure[0].condition.value, 1);
  assert.equal(pain.criticalFailure[0].condition.value, 2);
  // Дыхание огнём — из встроенного каталога: конус, простой Рефлекс
  const fire = rule("breathe-fire").onUse;
  assert.equal(fire.targets, "area");
  assert.equal(fire.challenge.statistic, "reflex");
  assert.equal(fire.challenge.basic, true);
  // Злобный взгляд пугала: Воля СЛ 18, испуг 1/2/3, заворожён до конца СЛЕДУЮЩЕГО хода цели
  const leer = rule("scarecrows-leer").onUse.challenge;
  assert.deepEqual([leer.statistic, leer.dc.value, leer.basic], ["will", 18, false]);
  assert.deepEqual([1, 2, 3].map((v, i) => leer.byDegree[["success", "failure", "criticalFailure"][i]][0].condition.value), [1, 2, 3]);
  const fasc = leer.byDegree.failure.find((a) => a.condition.slug === "fascinated");
  assert.deepEqual(fasc.duration, { value: 1, unit: "rounds", expiry: "turn-end", of: "target" });
  assert.equal(leer.byDegree.criticalSuccess.some((a) => a.condition), false);
});

test("pa-port: Устрашающий удар — правило ссылается на встроенный обработчик; Грязный приём — правило check без макроса", () => {
  const is = rule("intimidating-strike");
  assert.deepEqual(is.macros, [{ phase: "onUse", builtin: "intimidating-strike" }]);
  assert.equal(typeof BUILTIN["intimidating-strike"].run, "function");
  assert.ok(BUILTIN["dirty-trick"], "файл-обработчик Грязного приёма остался");

  const dt = rule("dirty-trick");
  assert.deepEqual(dt.macros, []);
  assert.equal(dt.onUse.check.statistic, "thievery");
  assert.deepEqual(dt.onUse.check.vs, { defense: "reflex" });
  assert.deepEqual(steps("dirty-trick", "criticalSuccess")[0].condition, { slug: "clumsy", value: 1, policy: "max" });
  assert.equal(steps("dirty-trick", "criticalSuccess")[0].duration, undefined);
  assert.deepEqual(steps("dirty-trick", "success")[0].duration, { value: 1, unit: "rounds", expiry: "turn-start", of: "origin" });
  assert.deepEqual(steps("dirty-trick", "criticalFailure").map((s) => [s.to, s.condition.slug]), [["self", "prone"]]);
});

test("pa-port: Устрашающий удар — испуг по степени Удара и урону; бросают у игрока, испуг ставит ГМ", () => {
  assert.equal(strike.frightenFor(2, 5), 1);
  assert.equal(strike.frightenFor(3, 5), 2);
  assert.equal(strike.frightenFor(3, 0), 0);   // попал, но урона нет
  assert.equal(strike.frightenFor(1, 5), 0);
  assert.equal(strike.frightenFor(null, 5), 0);
  assert.equal(BUILTIN["intimidating-strike"].player, true);
  assert.equal(typeof BUILTIN["intimidating-strike"].finish, "function");
  assert.equal(rule("intimidating-strike").onUse.targets, "selected");
});

test("pa-port: общие действия — защита, статистика, степени", () => {
  const defs = {
    demoralize: ["intimidation", "will"], feint: ["deception", "perception"], trip: ["athletics", "reflex"], grapple: ["athletics", "fortitude"],
    shove: ["athletics", "fortitude"], disarm: ["athletics", "reflex"], reposition: ["athletics", "fortitude"], "tumble-through": ["acrobatics", "reflex"],
    "create-a-diversion": ["deception", "perception"], "bon-mot": ["diplomacy", "will"], "command-an-animal": ["nature", "will"]
  };
  for (const [s, [stat, def]] of Object.entries(defs)) {
    const ck = rule(s).onUse.check;
    assert.equal(ck.statistic, stat, s);
    assert.deepEqual(ck.vs, { defense: def }, s);
    assert.deepEqual(ck.options, [`action:${s}`], s);
    assert.equal(rule(s).onUse.targets, "selected", s);
  }
  const prone = (slug, deg, to = "target") => conds(steps(slug, deg)).some((c) => c.condition.slug === "prone" && c.to === to);

  // Demoralize: испуг 2/1, иммунитет 10 минут, при провале ничего
  assert.deepEqual([steps("demoralize", "criticalSuccess"), steps("demoralize", "success")].map((l) => l[0].condition.value), [2, 1]);
  assert.deepEqual(steps("demoralize", "failure"), []);
  assert.deepEqual(rule("demoralize").onUse.check.immunity, { slug: "demoralize", label: "Деморализация", duration: { value: 10, unit: "minutes" } });
  // Trip/Shove: ничком у цели при успехе (Trip) и у автора при крит. провале
  assert.ok(prone("trip", "criticalSuccess") && prone("trip", "success") && prone("trip", "criticalFailure", "self"));
  assert.ok(prone("shove", "criticalFailure", "self"));
  assert.equal(conds(steps("shove", "success")).length, 0);
  // Grapple: удержан (крит.) / схвачен до конца следующего хода автора
  assert.deepEqual(conds(steps("grapple", "criticalSuccess")).map((c) => [c.condition.slug, c.duration.expiry, c.duration.of]), [["restrained", "turn-end", "origin"]]);
  assert.deepEqual(conds(steps("grapple", "success")).map((c) => [c.condition.slug, c.duration.expiry]), [["grabbed", "turn-end"]]);
  // Disarm: эффект «Ослабленный хват» при успехе; крит. провал — автор «застигнут врасплох» до начала своего хода
  assert.equal(steps("disarm", "success")[0].effect.uuid, "Compendium.pf2e.other-effects.Item.PuDS0DEq0CnaSIFV");
  assert.deepEqual(steps("disarm", "criticalFailure")[0], { to: "self", condition: { slug: "off-guard", policy: "max" }, duration: { value: 1, unit: "rounds", expiry: "turn-start", of: "origin" } });
  // Feint: КС — до конца следующего хода, У — до конца этого хода (value:0 + turn-end), КП — автор
  assert.deepEqual(steps("feint", "criticalSuccess")[0].duration.expiry, "turn-end");
  assert.deepEqual(steps("feint", "success")[0].duration, { value: 0, unit: "rounds", expiry: "turn-end", of: "origin" });
  assert.equal(steps("feint", "criticalFailure")[0].to, "self");
  // Escape: список статистик автора, СЛ Атлетики схватившего
  assert.deepEqual(rule("escape").onUse.check.statistic, ["athletics", "acrobatics"]);
  assert.deepEqual(rule("escape").onUse.check.vs, { against: "athletics" });
  // Treat Wounds / Battle Medicine: СЛ 15 и эффект-иммунитет по uuid
  assert.equal(rule("treat-wounds").onUse.check.vs.dc, 15);
  assert.equal(rule("treat-wounds").onUse.check.immunity.uuid, "Compendium.pf2e.feat-effects.Item.Lb4q2bBAgxamtix5");
  assert.equal(rule("battle-medicine").onUse.check.immunity.uuid, "Compendium.pf2e.feat-effects.Item.2XEYQNZTCGpdkyR6");
  assert.equal(rule("battle-medicine").macros.length, 0);
  // Bon Mot: эффект на цель (КС/У) и на автора (КП)
  assert.deepEqual(["criticalSuccess", "success", "criticalFailure"].map((d) => steps("bon-mot", d)[0].to ?? "target"), ["target", "target", "self"]);
  // Create a Diversion / Tumble Through: у действий без «крит.» результатов крит. степени повторяют соседние
  for (const s of ["create-a-diversion", "tumble-through"]) {
    assert.deepEqual(steps(s, "criticalSuccess"), steps(s, "success"), s);
    assert.deepEqual(steps(s, "criticalFailure"), steps(s, "failure"), s);
  }
  // Aid / Treat Poison / Treat Disease / Drop Prone: безусловные шаги
  assert.equal(rule("aid").onUse.apply[0].effect.uuid, "Compendium.pf2e.other-effects.Item.AHMUpMbaVkZ5A1KX");
  assert.equal(rule("treat-poison").onUse.apply[0].effect.uuid, "Compendium.pf2e.other-effects.Item.1FrAlPeNseApVrX3");
  assert.equal(rule("treat-disease").onUse.apply[0].effect.uuid, "Compendium.pf2e.other-effects.Item.TGGdM7XnjQkkijK7");
  assert.deepEqual(rule("drop-prone").onUse.apply, [{ to: "self", condition: { slug: "prone", policy: "max" } }]);
});

test("pa-port: сверка с англ. снимком pf2e (если он лежит рядом): источники — предметы нужного типа/slug, эффекты — эффекты", { skip: !existsSync("D:/ClaudeFun/pf2-translation/pf2ru-translation/sources/pf2e-8.4.1/packs/spells.json") }, () => {
  const dir = "D:/ClaudeFun/pf2-translation/pf2ru-translation/sources/pf2e-8.4.1/packs/";
  const packs = { "spells-srd": "spells", "feats-srd": "feats", actionspf2e: "actions", "equipment-srd": "equipment", "spell-effects": "spell-effects", "feat-effects": "feat-effects", "other-effects": "other-effects", "equipment-effects": "equipment-effects" };
  const docs = {};
  const find = (uuid) => {
    const [, pack, id] = /^Compendium\.pf2e\.([\w-]+)\.Item\.(\w+)$/.exec(uuid) ?? [];
    const f = packs[pack];
    return f ? (docs[f] ??= Object.fromEntries(JSON.parse(readFileSync(dir + f + ".json", "utf8")).map((d) => [d._id, d])))[id] : null;
  };
  for (const slug of PORTED) {
    const src = ENT[slug][0];
    if (src) assert.equal(find(src)?.system?.slug, slug, `${slug}: источник`);
  }
  const walk = (o, at) => {
    if (Array.isArray(o)) return o.forEach((x) => walk(x, at));
    if (!o || typeof o !== "object") return;
    const u = o.effect?.uuid ?? (typeof o.uuid === "string" && o.uuid.startsWith("Compendium") ? o.uuid : null);
    if (u) assert.equal(find(u)?.type, "effect", `${at}: ${u}`);
    Object.values(o).forEach((v) => walk(v, at));
  };
  for (const slug of PORTED) walk(rule(slug), slug);
});
