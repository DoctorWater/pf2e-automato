import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { blankBlock, blankModel, rulesOf, textOf, durationText, descriptionOf, validate, buildEffect, parseRaw, KINDS } from "../scripts/workshop/effect.mjs";

// t-заглушка: ключ + данные, чтобы проверять, что именно подставлено
const t = (k, d) => (d ? `${k}${JSON.stringify(d)}` : k);
const ctx = { t, uuidOf: (slug) => (slug === "frightened" ? "Compendium.pf2e.conditionitems.Item.FRIGHT" : null), condLabel: (s) => s.toUpperCase() };
const B = (kind, patch = {}) => ({ ...blankBlock(kind), ...patch });

test("каждый вид кубика -> правильный Rule Element", () => {
  assert.deepEqual(rulesOf(B("bonus", { sign: -1, value: 2, type: "circumstance", target: "saving-throw" })), [{ key: "FlatModifier", selector: "saving-throw", type: "circumstance", value: -2 }]);
  assert.deepEqual(rulesOf(B("bonus", { value: "1" })), [{ key: "FlatModifier", selector: "ac", type: "status", value: 1 }]);
  assert.deepEqual(rulesOf(B("speed", { value: 10 })), [{ key: "FlatModifier", selector: "all-speeds", type: "status", value: 10 }]);
  assert.deepEqual(rulesOf(B("resist")), [{ key: "Resistance", type: "fire", value: 5 }]);
  assert.deepEqual(rulesOf(B("resist", { except: "adamantine, magical" })), [{ key: "Resistance", type: "fire", value: 5, exceptions: ["adamantine", "magical"] }]);
  assert.deepEqual(rulesOf(B("temphp")), [{ key: "TempHP", value: 5 }]);
  assert.deepEqual(rulesOf(B("fastheal")), [{ key: "FastHealing", value: 2 }]);
  assert.deepEqual(rulesOf(B("dmg", { number: 2, die: "d8", dmgType: "cold" })), [{ key: "DamageDice", selector: "strike-damage", diceNumber: 2, dieSize: "d8", damageType: "cold" }]);
  assert.deepEqual(rulesOf(B("sense")), [{ key: "Sense", selector: "darkvision" }]);   // precise: без acuity, дальность не нужна
  assert.deepEqual(rulesOf(B("sense", { sense: "scent", range: 30 })), [{ key: "Sense", selector: "scent", acuity: "imprecise", range: 30 }]);
  assert.deepEqual(rulesOf(B("sense", { sense: "truesight", range: 20 })), [{ key: "Sense", selector: "truesight", range: 20 }]);
  assert.deepEqual(rulesOf(B("note", { title: " T ", text: "x" })), [{ key: "Note", selector: "saving-throw", title: "T", text: "x" }]);
  assert.deepEqual(rulesOf(B("aura", { slug: "fear", radius: 15 })), [{ key: "Aura", slug: "fear", radius: 15, traits: [], effects: [] }]);
  assert.deepEqual(rulesOf(B("light")), [{ key: "TokenLight", value: { bright: 20, dim: 40 } }]);
  assert.deepEqual(rulesOf(B("raw", { json: '[{"key":"A"},{"key":"B"}]' })).map((r) => r.key), ["A", "B"]);
});

test("состояние: UUID из рантайма или из броска, значение — алтерацией", () => {
  const u = "Compendium.pf2e.conditionitems.Item.FRIGHT";
  // испуг убывает по ходу игры — ГМ должен мочь его снять: detach; неубывающие — restrict
  assert.deepEqual(rulesOf(B("cond", { slug: "frightened" }), ctx), [{ key: "GrantItem", uuid: u, onDeleteActions: { grantee: "detach" } }]);
  assert.equal(rulesOf(B("cond", { slug: "clumsy" }), { ...ctx, uuidOf: () => "Compendium.pf2e.conditionitems.Item.CLUMSY" })[0].onDeleteActions.grantee, "restrict");
  assert.deepEqual(rulesOf(B("cond", { slug: "frightened", valued: true, value: "2" }), ctx)[0].alterations, [{ mode: "override", property: "badge-value", value: 2 }]);
  assert.equal(rulesOf(B("cond", { uuid: "Compendium.x.Item.y" }), ctx)[0].uuid, "Compendium.x.Item.y");   // перетащенный эффект
  assert.deepEqual(rulesOf(B("cond", { slug: "nope" }), ctx), []);
});

test("описание кубиков и длительность", () => {
  assert.match(textOf(B("bonus", { sign: -1, value: 2 }), ctx), /targets.ac.*−2.*penaltyKind\.status/);
  assert.match(textOf(B("bonus"), ctx), /\+1.*bonusKind\.status/);
  assert.match(textOf(B("speed", { value: 5 }), ctx), /text\.speed.*\+5/);
  assert.match(textOf(B("resist", { except: "silver" }), ctx), /resistExcept.*silver/);
  assert.match(textOf(B("resist"), ctx), /text\.resist\{/);
  assert.match(textOf(B("temphp"), ctx), /temphp/);
  assert.match(textOf(B("fastheal"), ctx), /fastheal/);
  assert.match(textOf(B("dmg"), ctx), /d6.*workshop.dtype.fire/);
  assert.match(textOf(B("sense"), ctx), /senseFree/);
  assert.match(textOf(B("sense", { sense: "scent" }), ctx), /text\.sense\{.*30/);
  assert.match(textOf(B("cond", { slug: "frightened", valued: true, value: 2 }), ctx), /FRIGHTENED 2/);
  assert.match(textOf(B("cond", { name: "Эффект" }), ctx), /Эффект/);
  assert.match(textOf(B("note", { text: "<p>привет</p>" }), ctx), /привет/);
  assert.match(textOf(B("aura"), ctx), /text\.aura.*10/);
  assert.match(textOf(B("light"), ctx), /text\.light.*20.*40/);
  assert.match(textOf(B("raw", { json: '{"key":"Foo"}' }), ctx), /Foo/);
  assert.equal(KINDS.length, 12);
  assert.match(durationText({ value: 3, unit: "rounds", expiry: "turn-end" }, t).short, /unitShort\.rounds/);
  assert.equal(durationText({ unit: "unlimited" }, t).short, "∞");
  assert.equal(descriptionOf([], ctx), "");
  assert.match(descriptionOf([B("temphp"), B("fastheal")], ctx), /^<p>.*<\/p>$/);
});

test("сборка source эффекта", () => {
  const m = { ...blankModel(), name: " Отвар ", level: "3", dur: { value: "2", unit: "rounds", expiry: "turn-end", counter: true }, blocks: [B("bonus"), B("resist")] };
  const e = buildEffect(m, ctx);
  assert.equal(e.type, "effect");
  assert.equal(e.name, "Отвар");
  assert.equal(e.img, "icons/svg/aura.svg");
  assert.equal(e.system.level.value, 3);
  assert.deepEqual(e.system.duration, { value: 2, unit: "rounds", expiry: "turn-end", sustained: false });
  assert.deepEqual(e.system.badge, { type: "counter", value: 1, min: 1, max: null, labels: null });
  assert.equal(e.system.rules.length, 2);
  assert.match(e.system.description.value, /desc\.prefix/);
  const u = buildEffect({ ...m, dur: { value: 1, unit: "unlimited", expiry: "turn-end", counter: false } }, ctx);
  assert.deepEqual(u.system.duration, { value: -1, unit: "unlimited", expiry: null, sustained: false });
  assert.equal("badge" in u.system, false);
});

test("валидация: ошибки текстом, не исключения", () => {
  const ok = { ...blankModel(), name: "X", blocks: [B("bonus")] };
  assert.deepEqual(validate(ok, ctx), []);
  assert.equal(validate({ ...ok, name: " " }, ctx).length, 1);
  assert.equal(validate({ ...ok, level: -1 }, ctx).length, 1);
  assert.equal(validate({ ...ok, level: "1.5" }, ctx).length, 1);
  assert.equal(validate({ ...ok, dur: { ...ok.dur, value: 0 } }, ctx).length, 1);
  assert.deepEqual(validate({ ...ok, dur: { ...ok.dur, value: 0, unit: "unlimited" } }, ctx), []);
  assert.match(validate({ ...ok, blocks: [] }, ctx)[0], /err\.empty/);
  const bad = (b) => validate({ ...ok, blocks: [b] }, ctx);
  for (const b of [B("bonus", { value: "" }), B("resist", { value: 0 }), B("resist", { except: "Адамант" }), B("temphp", { value: "x" }), B("fastheal", { value: -1 }),
    B("dmg", { number: 0 }), B("sense", { sense: "scent", range: 0 }), B("cond"), B("cond", { slug: "frightened", valued: true, value: 0 }), B("note"),
    B("aura", { slug: "Bad Slug" }), B("aura", { radius: 0 }), B("aura", { radius: 12 }), B("aura", { radius: 245 }), B("light", { bright: 0, dim: 0 }), B("light", { bright: 40, dim: 20 }), B("raw", { json: "{oops" }), B("raw", { json: "{}" })]) {
    assert.equal(bad(b).length, 1, JSON.stringify(b));
  }
  assert.deepEqual(bad(B("sense")), []);
  assert.deepEqual(bad(B("cond", { slug: "frightened" })), []);
});

test("сырой JSON: ошибка парсинга в валидации, rules пуст", () => {
  assert.match(parseRaw("{oops").error, /\w/);
  assert.equal(parseRaw("{}").error, "key");
  assert.equal(parseRaw("[]").error, "key");
  assert.equal(parseRaw('{"key":"A"}').error, null);
  const e = validate({ ...blankModel(), name: "X", blocks: [B("raw", { json: "{oops" })] }, ctx);
  assert.match(e[0], /rawJson.*error/);
  assert.deepEqual(rulesOf(B("raw", { json: "{oops" })), []);
});

test("аура: пустой slug не пишется; кратность радиуса", () => {
  assert.equal("slug" in rulesOf(B("aura"))[0], false);
  assert.equal(B("aura").slug, "");
  const v = (b) => validate({ ...blankModel(), name: "X", blocks: [b] }, ctx);
  assert.deepEqual(v(B("aura", { radius: 240 })), []);
  assert.deepEqual(v(B("aura", { radius: 5, slug: "fear-aura" })), []);
  assert.deepEqual(v(B("light", { bright: 20, dim: 20 })), []);
});

test("рантайм-проверки через ctx: исключения сопротивления и ключ своего правила", () => {
  const rt = { ...ctx, resistKnown: (k) => k === "adamantine", ruleKnown: (k) => k === "FlatModifier" };
  const v = (b) => validate({ ...blankModel(), name: "X", blocks: [b] }, rt);
  assert.deepEqual(v(B("resist", { except: "adamantine" })), []);
  assert.match(v(B("resist", { except: "adamantine, nonsense" }))[0], /exceptUnknown.*nonsense/);
  assert.deepEqual(v(B("raw", { json: '{"key":"FlatModifier"}' })), []);
  assert.match(v(B("raw", { json: '[{"key":"FlatModifier"},{"key":"Bogus"}]' }))[0], /rawUnknown.*Bogus/);
  assert.deepEqual(validate({ ...blankModel(), name: "X", blocks: [B("raw", { json: '{"key":"Bogus"}' })] }, ctx), []);   // без реестра не проверяем
});

test("шаблоны частей окна: ровно один корневой элемент", () => {
  const dir = new URL("../templates/", import.meta.url);
  const files = readdirSync(dir).filter((f) => /^workshop-.*\.hbs$/.test(f));
  assert.ok(files.length >= 4);
  const VOID = new Set(["input", "img", "br", "hr", "meta", "link"]);
  for (const f of files) {
    // глубина по тегам; {{...}} вырезаем, чтобы стрелки/атрибуты не мешали
    const html = readFileSync(new URL(f, dir), "utf8").replace(/\{\{[\s\S]*?\}\}/g, "").replace(/<!--[\s\S]*?-->/g, "");
    let depth = 0, roots = 0;
    for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g)) {
      const [, close, tag, self] = m;
      if (VOID.has(tag.toLowerCase()) || self) { if (!depth) roots++; continue; }
      if (close) depth--; else { if (!depth) roots++; depth++; }
    }
    assert.equal(roots, 1, `${f}: корневых элементов ${roots}`);
    assert.equal(depth, 0, `${f}: не закрыты теги`);
  }
});

// ---- условие, «чем бьёт», селектор скорости ----
import { whenPresetOf, whenFor, presetsFor, whenAtoms, whenSuffix, WHEN_KINDS, strikeSlug } from "../scripts/workshop/effect.mjs";
import { testPredicate, parseWhen } from "../scripts/predicate.mjs";
import { rulesOfMods } from "../scripts/inline-effect.mjs";

const pr = (kind, when, patch = {}) => rulesOf(B(kind, { when, ...patch }), ctx)[0].predicate;
const errs = (b) => validate({ ...blankModel(), name: "x", blocks: [B("temphp"), b] }, ctx);

test("условие: predicate на правиле каждого вида из WHEN_KINDS (строка и JSON), пустое и мусор не пишутся", () => {
  assert.deepEqual([...WHEN_KINDS].sort(), ["bonus", "cond", "dmg", "fastheal", "note", "resist", "sense", "speed", "temphp"]);
  for (const k of WHEN_KINDS) assert.deepEqual(pr(k, "self:condition:deafened, hp-percent:50", { slug: "frightened", uuid: "Compendium.x.Item.y", text: "x" }), ["self:condition:deafened", "hp-percent:50"], k);
  assert.deepEqual(pr("resist", '[{"lt":["hp-percent",50]}]'), [{ lt: ["hp-percent", 50] }]);
  assert.deepEqual(pr("resist", '[{"or":["a",{"not":"b"}]}]'), [{ or: ["a", { not: "b" }] }]);
  for (const w of ["", "  ", "[", '{"x":1}', "[]"]) assert.ok(!("predicate" in rulesOf(B("resist", { when: w }))[0]), w);
  for (const k of ["aura", "light"]) assert.ok(!("predicate" in rulesOf(B(k, { when: "x" }))[0]), k);
  assert.deepEqual(rulesOf(B("resist")), [{ key: "Resistance", type: "fire", value: 5 }]);   // без when — прежнее правило
});

test("условие: validate — whenBad, whenRoll (только виды, считаемые при подготовке актёра), whenHp у cond", () => {
  assert.match(errs(B("resist", { when: "[" })).join(), /whenBad/);
  assert.match(errs(B("resist", { when: "[]" })).join(), /whenBad/);
  assert.match(errs(B("resist", { when: "target:condition:prone" })).join(), /whenRoll/);
  assert.match(errs(B("resist", { when: '[{"not":"item:trait:fire"}]' })).join(), /whenRoll/);   // рекурсивно
  assert.deepEqual(errs(B("resist", { when: "origin:mode:undead" })), []);   // origin: у сопротивления есть
  for (const k of ["temphp", "fastheal", "sense", "speed"]) {
    assert.match(errs(B(k, { when: "target:mode:undead" })).join(), /whenRoll/, k);
    assert.match(errs(B(k, { when: "origin:mode:undead" })).join(), /whenRoll/, k);
    assert.deepEqual(errs(B(k, { when: "self:condition:prone" })), [], k);
  }
  assert.match(errs(B("cond", { slug: "frightened", when: "target:x" })).join(), /whenRoll/);
  assert.match(errs(B("cond", { slug: "frightened", when: '[{"lt":["hp-percent",50]}]' })).join(), /whenHp/);
  assert.deepEqual(errs(B("speed", { when: '[{"lt":["hp-percent",50]}]' })), []);
  assert.deepEqual(errs(B("resist", { when: '[{"lt":["hp-percent",50]}]' })), []);
  // bonus, dmg, note видят контекст броска: условие не проверяется
  for (const [k, p] of [["bonus", { target: "ac" }], ["bonus", { target: "saving-throw" }], ["dmg", {}], ["note", { text: "x" }]]) assert.deepEqual(errs(B(k, { when: "target:condition:prone, origin:trait:fire, item:trait:mental", ...p })), [], k);
  assert.deepEqual(whenAtoms([{ not: "a" }, { lt: ["hp-percent", 5] }, { or: ["b", { if: "c", then: "d" }] }]), ["a", "hp-percent", "b", "c", "d"]);
});

test("условие: пресеты — выбор сразу пишет полный предикат, разбор обратно, вид определяет target/origin", () => {
  const d = B("dmg"), r = B("resist"), ac = B("bonus", { target: "ac" }), st = B("bonus", { target: "saving-throw" }), atk = B("bonus", { target: "attack-roll" });
  assert.equal(whenFor("targetCond", undefined, d), "target:condition:prone");   // параметр по умолчанию, не пусто
  assert.equal(whenFor("selfCond", undefined, d), "self:condition:frightened");
  assert.equal(whenFor("hpLess", undefined, r), '[{"lt":["hp-percent",50]}]');
  assert.equal(whenFor("vsTrait", undefined, st), "item:trait:mental");
  assert.equal(whenFor("hpLess", "30", r), '[{"lt":["hp-percent",30]}]');
  assert.equal(whenFor("", undefined, d), "");
  for (const [b, preset, param] of [[d, "targetCond", "prone"], [d, "selfCond", "frightened"], [r, "hpLess", "50"], [st, "vsTrait", "mental"], [d, "undead", ""]]) {
    const when = whenFor(preset, param || undefined, b);
    assert.deepEqual(whenPresetOf({ ...b, when }), { preset, param }, preset);
  }
  // после «перерисовки» выбор не отскакивает: пресет читается из записанной строки
  assert.equal(whenPresetOf({ ...d, when: whenFor("hpLess", undefined, d) }).preset, "hpLess");
  assert.equal(whenFor("undead", undefined, d), "target:mode:undead");
  assert.equal(whenFor("undead", undefined, atk), "target:mode:undead");
  assert.equal(whenFor("undead", undefined, B("note", { target: "damage" })), "target:mode:undead");   // у note на спасброске цели нет — origin
  assert.equal(whenFor("undead", undefined, r), "origin:mode:undead");
  assert.equal(whenFor("undead", undefined, ac), "origin:mode:undead");
  assert.equal(whenFor("undead", undefined, st), "origin:mode:undead");
  assert.equal(whenPresetOf({ ...r, when: "target:mode:undead" }).preset, "custom");   // не тот атом для вида
  assert.equal(whenPresetOf({ ...d, when: "foo, bar" }).preset, "custom");
  assert.equal(whenPresetOf({ ...d, when: "" }).preset, "");
  assert.ok(!presetsFor(B("cond")).includes("hpLess"));   // у cond hp-percent не работает
  assert.ok(!presetsFor(r).includes("targetCond") && !presetsFor(B("temphp")).includes("undead"));
  assert.ok(presetsFor(st).includes("vsTrait") && !presetsFor(ac).includes("vsTrait"));
});

test("условие: pf2e вычисляет его по опциям (hp-percent, состояние цели)", () => {
  const hp = parseWhen(whenFor("hpLess", "50", B("resist")));
  assert.equal(testPredicate(hp, ["hp-percent:40"]), true);
  assert.equal(testPredicate(hp, ["hp-percent:50"]), false);
  assert.equal(testPredicate(parseWhen("target:condition:prone"), ["target:condition:prone"]), true);
  assert.equal(testPredicate(parseWhen("target:condition:prone"), ["self:condition:prone"]), false);
});

test("условие: строка описания — подпись пресета (без сырых слагов), своё условие — записью", () => {
  const c = { ...ctx, condLabel: (s) => `«${s}»` };
  assert.match(textOf(B("dmg", { when: "target:condition:prone" }), c), /text\.when.*when\.targetCond.*«prone»/);
  assert.doesNotMatch(textOf(B("dmg", { when: "target:condition:prone" }), c), /target:condition/);
  assert.match(textOf(B("resist", { when: '[{"lt":["hp-percent",50]}]' }), c), /hpLess.*n\W+50/);
  assert.match(textOf(B("resist", { when: "rage, !x" }), c), /text\.when\{"when":"rage, !x"\}/);
  assert.equal(textOf(B("resist"), c), textOf(B("resist", { when: "" }), c));
  assert.doesNotMatch(descriptionOf([B("dmg", { when: "target:mode:undead" })], c), /target:mode/);
  assert.equal(whenSuffix(B("aura", { when: "x" }), c), "");
});

test("чем бьёт: селектор Удара у dmg и бонуса на атаку/урон; пусто — как раньше", () => {
  assert.equal(rulesOf(B("dmg", { strike: "jaws" }))[0].selector, "jaws-damage");
  assert.equal(rulesOf(B("dmg", { strike: "  " }))[0].selector, "strike-damage");
  assert.equal(rulesOf(B("dmg"))[0].selector, "strike-damage");
  assert.equal(rulesOf(B("bonus", { target: "attack-roll", strike: "jaws" }))[0].selector, "jaws-attack");
  assert.equal(rulesOf(B("bonus", { target: "damage", strike: "jaws" }))[0].selector, "jaws-damage");
  assert.equal(rulesOf(B("bonus", { target: "attack-roll" }))[0].selector, "attack-roll");
  assert.equal(rulesOf(B("bonus", { target: "ac", strike: "jaws" }))[0].selector, "ac");   // к другим целям поле не относится
  assert.equal(rulesOf(B("dmg", { strike: "клык" }))[0].selector, "клык-damage");   // slug может быть кириллицей
  assert.match(textOf(B("dmg", { strike: "jaws" }), { ...ctx, strikeLabel: () => "Челюсти" }), /text\.strike.*Челюсти/);
  assert.equal(strikeSlug("jaws-damage", "damage"), "jaws");
  for (const g of ["melee-strike", "str", "spell", "x-base", "x-weapon-group"]) assert.equal(strikeSlug(`${g}-damage`, "damage"), null, g);
});

test("скорость: селектор по виду, по умолчанию all-speeds; текст называет вид", () => {
  assert.equal(rulesOf(B("speed"))[0].selector, "all-speeds");
  const { sel, ...noSel } = B("speed", { sel: "land-speed" });
  assert.equal(rulesOf({ ...noSel, sel: undefined })[0].selector, "all-speeds");
  for (const s of ["land", "fly", "swim", "climb", "burrow"]) assert.equal(rulesOf(B("speed", { sel: `${s}-speed` }))[0].selector, `${s}-speed`);
  assert.match(textOf(B("speed", { sel: "fly-speed" }), { ...ctx, speedLabel: () => "Полёт" }), /text\.speedSel.*Полёт/);
  assert.match(textOf(B("speed"), ctx), /^workshop\.text\.speed\{/);
  assert.match(textOf(B("speed", { sel: "speed" }), ctx), /^workshop\.text\.speed\{/);
});

test("inline-effect: блоки без новых полей дают прежние селекторы", () => {
  const r = rulesOfMods([{ speed: { type: "status", value: -10 } }, { bonus: { target: "attack-roll", type: "status", value: 1 } }]);
  assert.deepEqual(r.map((x) => x.selector), ["all-speeds", "attack-roll"]);
  assert.ok(r.every((x) => !("predicate" in x)));
});

// ---- доработка по Критику ----
test("условие: «своё» держится выбором блока; у note атом и «цель в состоянии» по цели", () => {
  const d = B("dmg", { when: "target:condition:prone" });
  assert.equal(whenPresetOf(d).preset, "targetCond");
  assert.equal(whenPresetOf({ ...d, whenPick: "custom" }).preset, "custom");   // выбор «своё» не отскакивает
  assert.equal(whenPresetOf({ ...d, when: "", whenPick: "custom" }).preset, "custom");
  assert.equal(whenFor("custom", undefined, { ...d, whenPick: "custom" }), "target:condition:prone");
  const sv = B("note", { target: "saving-throw", text: "x" }), at = B("note", { target: "attack-roll", text: "x" });
  assert.equal(whenFor("undead", undefined, sv), "origin:mode:undead");
  assert.equal(whenFor("undead", undefined, at), "target:mode:undead");
  assert.ok(!presetsFor(sv).includes("targetCond") && presetsFor(at).includes("targetCond") && presetsFor(sv).includes("vsTrait"));
});

test("чем бьёт: родовые домены pf2e (уровень мастерства, характеристики, melee/ranged) — raw; слаг в validate", () => {
  for (const g of ["untrained", "trained", "expert", "master", "legendary", "str", "dex", "con", "int", "wis", "cha", "jaws-melee", "jaws-ranged"]) {
    assert.equal(strikeSlug(`${g}-damage`, "damage"), null, g);
    assert.equal(strikeSlug(`${g}-attack`, "attack"), null, g);
  }
  assert.equal(strikeSlug("jaws-damage", "damage"), "jaws");
  const sl = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  const c2 = { ...ctx, sluggify: sl };
  const v = (b) => validate({ ...blankModel(), name: "x", blocks: [B("temphp"), b] }, c2).join();
  assert.match(v(B("dmg", { strike: "Челюсти" })), /err\.strike/);
  assert.match(v(B("dmg", { strike: "My Claw" })), /err\.strike/);
  assert.equal(v(B("dmg", { strike: "челюсти" })), "");
  assert.equal(v(B("dmg", { strike: "" })), "");
  assert.equal(v(B("bonus", { target: "ac", strike: "My Claw" })), "");   // к другим целям поле не относится
});
