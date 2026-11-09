// Встроенные обработчики (scripts/builtin): чистая логика + исполнение ссылок {builtin} в macros.runMacros.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MOD = "pf2e-automato";
const settingsMode = { macro: "auto" };
globalThis.game = {
  user: { isActiveGM: true },
  settings: { get: (_m, k) => settingsMode[k.replace("mode.", "")] ?? "auto" },
  i18n: { localize: (k) => k, format: (k) => k }
};
const warns = [];
globalThis.ui = { notifications: { warn: (m) => warns.push(m) } };

const { BUILTIN } = await import("../scripts/builtin/index.mjs");
const { builtinId, runMacros, runMacroRef } = await import("../scripts/macros.mjs");
const blood = await import("../scripts/builtin/blood-magic.mjs");
const twin = await import("../scripts/builtin/twin-feint.mjs");
const dirty = await import("../scripts/builtin/dirty-trick.mjs");
const fakeOut = await import("../scripts/builtin/fake-out.mjs");
const rs = await import("../scripts/builtin/reactive-strike.mjs");
const onyx = await import("../scripts/builtin/onyx-dog.mjs");
const lib = await import("../scripts/builtin/lib.mjs");

/* ---------- X1 ---------- */

test("X1: заклинание крови опознаётся по тегу наследия, только заклинание", () => {
  assert.equal(blood.isBloodSpell({ type: "spell", rollOptions: ["origin:item:tag:blood-magic-spell"] }), true);
  assert.equal(blood.isBloodSpell({ type: "spell", rollOptions: ["origin:item:trait:occult"] }), false);
  assert.equal(blood.isBloodSpell({ type: "feat", rollOptions: ["origin:item:tag:blood-magic-spell"] }), false);
  assert.equal(blood.isBloodSpell(null), false);
});

test("X1: варианты — себе, по кнопке на цель, пропуск; выбор разбирается обратно", () => {
  const targets = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
  assert.deepEqual(blood.bloodOptions([]).map((o) => o.id), ["self", "skip"]);
  assert.deepEqual(blood.bloodOptions(targets).map((o) => o.id), ["self", "t:a", "t:b", "skip"]);
  assert.deepEqual(blood.bloodChoice("self", targets), { to: "self" });
  assert.deepEqual(blood.bloodChoice("t:b", targets), { to: "target", token: targets[1] });
  assert.equal(blood.bloodChoice("t:zzz", targets), null);
  assert.equal(blood.bloodChoice("skip", targets), null);
  assert.equal(blood.bloodChoice(null, targets), null);
});

/* ---------- X2 ---------- */

test("X2: цель — ровно одна; off-guard только для второго Удара — EphemeralEffect на атакующем (атака и урон)", () => {
  assert.equal(twin.soleTarget([]), null);
  assert.equal(twin.soleTarget([1, 2]), null);
  assert.equal(twin.soleTarget([7]), 7);
  const e = twin.secondStrikeEffect("n");
  assert.equal(e.type, "effect");
  assert.deepEqual(e.system.rules, [{ key: "EphemeralEffect", selectors: ["strike-attack-roll", "strike-damage"], uuid: lib.COND.offGuard }]);
});

/* ---------- X3 ---------- */

test("X3: Грязный приём по степеням", () => {
  assert.deepEqual(dirty.dirtyTrickPlan(3), [{ to: "target", kind: "condition", slug: "clumsy", value: 1 }]);
  assert.deepEqual(dirty.dirtyTrickPlan(2), [{ to: "target", kind: "effect" }]);
  assert.deepEqual(dirty.dirtyTrickPlan(1), []);
  assert.deepEqual(dirty.dirtyTrickPlan(0), [{ to: "self", kind: "condition", slug: "prone" }]);
});

/* ---------- X4 / X6 ---------- */

test("X4: триггер Реагирующего удара и враждебность", () => {
  assert.equal(rs.reactiveTrigger(["origin:item:trait:manipulate", "origin:item:ranged"]), "manipulate");
  assert.equal(rs.reactiveTrigger(["origin:item:trait:move"]), "move");
  assert.equal(rs.reactiveTrigger(["item:ranged"]), "ranged");
  assert.equal(rs.reactiveTrigger(["origin:item:trait:fire"]), null);
  assert.equal(rs.reactiveTrigger(), null);
  assert.equal(rs.opposed(1, -1), true);
  assert.equal(rs.opposed(1, -2), true);
  assert.equal(rs.opposed(1, 1), false);
  assert.equal(rs.opposed(0, -1), false);
});

test("X6: бонус «Помочь» по степени", () => {
  assert.deepEqual([0, 1, 2, 3].map((d) => fakeOut.aidBonus(d)), [-1, 0, 1, 2]);
  assert.deepEqual([3, 4].map((r) => fakeOut.aidBonus(3, r)), [3, 4]);   // крит. успех мастера/легенды
});

/* ---------- X5 ---------- */

test("X5: перезарядка неделя; поиск свободной клетки рядом с владельцем", () => {
  assert.equal(onyx.cooldownLeft(1000, null), 0);
  assert.equal(onyx.cooldownLeft(onyx.WEEK + 10, 10), 0);
  assert.equal(onyx.cooldownLeft(100, 10), onyx.WEEK - 90);
  assert.equal(onyx.isFigurine({ slug: "wondrous-figurine-onyx-dog" }), true);
  assert.equal(onyx.isFigurine({ _stats: { compendiumSource: onyx.FIGURINE } }), true);
  assert.equal(onyx.isFigurine({ slug: "other" }), false);

  const owner = { x: 5, y: 5, w: 1, h: 1 }, one = { w: 1, h: 1 };
  const s1 = onyx.findSpot(owner, one, [owner]);
  assert.ok(Math.abs(s1.x - 5) <= 1 && Math.abs(s1.y - 5) <= 1 && !(s1.x === 5 && s1.y === 5));
  // заняты все 8 соседних — null
  const ring = [];
  for (let x = 4; x <= 6; x++) for (let y = 4; y <= 6; y++) ring.push({ x, y, w: 1, h: 1 });
  assert.equal(onyx.findSpot(owner, one, ring), null);
  // занята ровно одна клетка, ближайшая по порядку — берётся другая
  const s2 = onyx.findSpot(owner, one, [{ ...s1, w: 1, h: 1 }]);
  assert.notDeepEqual(s2, s1);
  // крупная собака 2x2 не пересекает владельца
  const big = onyx.findSpot(owner, { w: 2, h: 2 }, []);
  assert.ok(big.x + 2 <= 5 || big.x >= 6 || big.y + 2 <= 5 || big.y >= 6);
});

/* ---------- исполнение ссылок {builtin} ---------- */

test("builtinId: поле builtin и форма uuid:\"builtin:<id>\"", () => {
  assert.equal(builtinId({ phase: "onUse", builtin: "x" }), "x");
  assert.equal(builtinId({ phase: "onUse", uuid: "builtin:y" }), "y");
  assert.equal(builtinId({ phase: "onUse", uuid: "Macro.abc" }), null);
});

test("runMacros: builtin исполняется со scope, ошибка и неизвестный id не ломают конвейер", async () => {
  const calls = [];
  BUILTIN._ok = { run: (s) => { calls.push(s); } };
  BUILTIN._boom = { run: () => { throw new Error("бум"); } };
  const rule = { macros: [
    { phase: "onUse", builtin: "_boom" }, { phase: "onUse", uuid: "builtin:_ok" },
    { phase: "onUse", builtin: "_нет" }, { phase: "onUse", builtin: "_ok" }
  ] };
  warns.length = 0;
  const out = await runMacros("onUse", { rule, actor: { name: "a" }, targets: [1] });
  assert.deepEqual(out.map((o) => o.ok), [false, true, false, true]);
  assert.equal(out[0].error, "бум");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].phase, "onUse");
  assert.deepEqual(calls[0].targets, [1]);
  assert.equal(warns.length, 2);
});

test("runMacros: режим macro=off и не-активный ГМ — ничего; дедуп по сообщению", async () => {
  const calls = [];
  BUILTIN._ok = { run: () => { calls.push(1); } };
  const rule = { macros: [{ phase: "onUse", builtin: "_ok" }] };
  settingsMode.macro = "off";
  assert.deepEqual(await runMacros("onUse", { rule }), []);
  settingsMode.macro = "auto";
  game.user.isActiveGM = false;
  assert.deepEqual(await runMacros("onUse", { rule }), []);
  game.user.isActiveGM = true;

  const message = { id: "m1", flags: { [MOD]: { use: { rule, state: {} } } }, update: async (d) => {
    for (const [path, v] of Object.entries(d)) {
      const keys = path.split(".").slice(2);   // flags.pf2e-automato.<...>
      let o = message.flags[MOD];
      for (const k of keys.slice(0, -1)) o = o[k] ??= {};
      o[keys.at(-1)] = v;
    }
  } };
  await runMacros("onUse", { message });
  await runMacros("onUse", { message });
  assert.equal(calls.length, 1);
  assert.deepEqual(message.flags[MOD].use.state.macros.done, ["m1|onUse|-|builtin:_ok"]);
});

test("runMacroRef: player — у автора-игрока онлайн через сокет, finish — у ГМа с результатом", async () => {
  const util = await import("../scripts/util.mjs");
  const calls = [], done = [];
  util.setSocket({ executeAsUser: async (name, uid, bid, packed) => { calls.push([name, uid, bid, packed]); return { v: 1 }; } });
  BUILTIN._pl = { player: true, run: async () => ({ v: "gm" }), finish: async (r) => done.push(r) };
  const pl = { id: "pl", isGM: false, active: true };
  const actor = { uuid: "Actor.a", testUserPermission: (u) => u === pl };
  const scope = { phase: "onUse", actor, message: { id: "M", author: pl }, targets: [{ uuid: "Scene.s.Token.t" }] };
  assert.equal((await runMacroRef({ phase: "onUse", builtin: "_pl" }, scope)).ok, true);
  assert.deepEqual(calls, [["runPlayerBuiltin", "pl", "_pl", { phase: "onUse", actor: "Actor.a", token: null, item: null, message: "M", targets: ["Scene.s.Token.t"] }]]);
  assert.deepEqual(done, [{ v: 1 }]);
  // автор офлайн / ГМ / не владелец — у ГМа
  for (const author of [{ ...pl, active: false }, { id: "g2", isGM: true, active: true }, { id: "x", isGM: false, active: true }]) {
    await runMacroRef({ phase: "onUse", builtin: "_pl" }, { ...scope, message: { id: "M", author } });
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(done.slice(1), [{ v: "gm" }, { v: "gm" }, { v: "gm" }]);
  delete BUILTIN._pl; util.setSocket(null);
});

test("runMacroRef: таймаут builtin по timeoutMs обработчика", async () => {
  BUILTIN._hang = { run: () => new Promise(() => {}), timeoutMs: 20 };
  const r = await runMacroRef({ phase: "onUse", builtin: "_hang" }, {});
  assert.equal(r.ok, false);
  assert.equal(r.error, "PF2E_AUTOMATO.saves.macroTimeout");
});

/* ---------- каталог ---------- */

test("catalog.json и flagRules: все builtin-ссылки указывают на существующий обработчик", () => {
  const cat = JSON.parse(readFileSync(fileURLToPath(new URL("../rules/catalog.json", import.meta.url)), "utf8"));
  cat.flagRules = JSON.parse(readFileSync(fileURLToPath(new URL("../tools/campaign-flag-rules.json", import.meta.url)), "utf8"));
  const ids = [];
  for (const sec of ["bySource", "bySlug", "byName", "flagRules"]) for (const [k, r] of Object.entries(cat[sec])) {
    if (k === "_doc") continue;
    for (const m of r.macros ?? []) { const id = builtinId(m); if (id) ids.push(id); }
  }
  assert.deepEqual([...new Set(ids)].sort(), ["blade-dance", "double-slice", "fake-out", "intimidating-strike", "twin-feint"]);   // Грязный приём теперь правило check (pa-port)
  for (const id of ids) assert.equal(typeof BUILTIN[id]?.run, "function", id);
});

/* ---------- реакции-Удары, Танец клинков, Обманка ---------- */

test("reactionOf: Реагирующий удар / Возможность для атаки — strike; Старая выучка (по имени или флагу) — oldTraining", () => {
  assert.equal(rs.reactionOf({ slug: "reactive-strike", type: "action" }), "strike");
  assert.equal(rs.reactionOf({ slug: "attack-of-opportunity", type: "action" }), "strike");
  assert.equal(rs.reactionOf({ slug: null, name: "Старая выучка", type: "action" }), "oldTraining");
  assert.equal(rs.reactionOf({ slug: null, name: "x", type: "action", flags: { [MOD]: { builtin: "old-training" } } }), "oldTraining");
  assert.equal(rs.reactionOf({ slug: "reactive-strike", type: "effect" }), null);
  assert.equal(rs.reactionOf({ slug: "shield-block", type: "action" }), null);
});

test("blade-dance: застигнут врасплох только если оба Удара попали", async () => {
  const bd = await import("../scripts/builtin/blade-dance.mjs");
  assert.equal(bd.bothHit(2, 3), true);
  assert.equal(bd.bothHit(2, 1), false);
  assert.equal(bd.bothHit(null, 3), false);
});

test("fake-out: оружие — огнестрел/арбалет; эффект бонуса обстоятельства к атакам", () => {
  const w = (id, group, traits = []) => ({ item: { id, isOfType: (t) => t === "weapon", system: { group, traits: { value: traits } } } });
  assert.deepEqual(fakeOut.gunCandidates([w("a", "firearm"), w("a", "firearm"), w("b", "bow"), w("c", "crossbow"), w("d", "bow", ["crossbow"])]).map((s) => s.item.id), ["a", "c", "d"]);
  const e = fakeOut.aidEffect("n", 2, {});
  assert.equal(e.system.slug, "af-fake-out-aid");
  assert.deepEqual(e.system.rules[0], { key: "FlatModifier", selector: ["strike-attack-roll", "spell-attack-roll"], type: "circumstance", value: 2, label: "n", removeAfterRoll: true });
  assert.equal(fakeOut.AID_DC, 15);
});

test("Реагирующий удар по перемещению: расстояние между токенами по pf2e и покинутые клетки", () => {
  const sq = (x, y) => ({ x, y, w: 1, h: 1 });
  assert.equal(rs.gapFeet(sq(0, 0), sq(1, 0)), 5);    // соседние
  assert.equal(rs.gapFeet(sq(0, 0), sq(1, 1)), 5);    // по диагонали рядом
  assert.equal(rs.gapFeet(sq(0, 0), sq(2, 0)), 10);
  assert.equal(rs.gapFeet(sq(0, 0), sq(2, 2)), 10);   // одна диагональ — 5 фт
  assert.equal(rs.gapFeet(sq(0, 0), sq(3, 3)), 20);   // две диагонали — 5 + 10
  assert.equal(rs.gapFeet({ x: 0, y: 0, w: 2, h: 2 }, sq(2, 0)), 5);   // большой токен
  assert.deepEqual(rs.leftSquares("o", ["a", "b", "end"]), ["o", "a", "b"]);
  assert.deepEqual(rs.leftSquares("o", ["end"]), ["o"]);
});
