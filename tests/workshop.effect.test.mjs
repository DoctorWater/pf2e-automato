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
  assert.deepEqual(rulesOf(B("speed", { value: 10 })), [{ key: "FlatModifier", selector: "land-speed", type: "status", value: 10 }]);
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
  assert.deepEqual(rulesOf(B("cond", { slug: "frightened" }), ctx), [{ key: "GrantItem", uuid: u, onDeleteActions: { grantee: "restrict" } }]);
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
