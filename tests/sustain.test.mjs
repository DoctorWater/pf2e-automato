import test from "node:test";
import assert from "node:assert/strict";
import { MOD } from "../scripts/util.mjs";
import { applyOps, undoOps } from "../scripts/apply.mjs";
import * as sustain from "../scripts/sustain.mjs";

const DUR = { value: 1, unit: "minutes", expiry: null, of: "origin" };
const STEP = { to: "target", condition: { slug: "stupefied", value: 1 }, duration: DUR, sustain: true };
const KEY = sustain.anchorKey("M");
const registry = new Map();
let sent, pf2eSustain, world;

/** Актёр с предметами: удаление зовёт onDeleteItem, как хук deleteItem (откат — с флагом undo). */
function mkActor(uuid) {
  let n = 0;
  const items = [];
  const actor = {
    uuid, name: uuid, items,
    getActiveTokens: () => [{ uuid: `Tok.${uuid}` }],
    async createEmbeddedDocuments(_, datas) {
      return datas.map((d) => {
        const data = structuredClone(d);
        const it = { ...data, id: `${uuid}.i${++n}`, uuid: `${uuid}.Item.i${n}`, actor, isLocked: false, isExpired: false };
        it.toObject = () => structuredClone({ name: it.name, type: it.type, system: it.system, flags: it.flags });
        it.update = async (ch) => { for (const [p, v] of Object.entries(ch)) { const ks = p.split("."), last = ks.pop(); let o = it; for (const k of ks) o = (o[k] ??= {}); o[last] = v; } };
        it.delete = async (opts) => { items.splice(items.indexOf(it), 1); await sustain.onDeleteItem(it, opts); };
        registry.set(it.uuid, it); items.push(it);
        return it;
      });
    },
    get itemTypes() { return { condition: items.filter((i) => i.type === "condition") }; }
  };
  registry.set(uuid, actor);
  return actor;
}
const bound = (a) => a.items.filter((i) => i.flags?.[MOD]?.meta?.sustainOf === KEY);
const anchors = (a) => sustain.anchorsOf(a);

function setup() {
  registry.clear(); sent = []; pf2eSustain = 0;
  world = { combat: { id: "c1", round: 1 } };
  globalThis.game = {
    modules: { get: () => null }, user: { isActiveGM: true }, users: [{ id: "gm", isGM: true }],
    i18n: { localize: (k) => k, format: (k) => k },
    get combat() { return world.combat; },
    get combats() { return world.combat ? [{ combatants: world.combatants ?? [], ...world.combat }] : []; },
    messages: { find: (fn) => sent.find(fn) },
    settings: { get: () => true },
    pf2e: { actions: { get: () => ({ use: async () => { pf2eSustain++; await world.onUse?.(); } }) },
      ConditionManager: { getCondition: (slug) => ({ uuid: null, _stats: { compendiumSource: `Compendium.pf2e.conditionitems.Item.${slug}` }, name: slug, img: "i.svg", system: { value: { isValued: true } }, toObject() { return { name: slug, type: "condition", system: { slug, value: { isValued: true, value: null } } }; } }) } }
  };
  globalThis.foundry = { utils: { getProperty: (o, p) => p.split(".").reduce((a, k) => a?.[k], o) } };
  globalThis.fromUuid = async (u) => registry.get(u) ?? null;
  globalThis.ChatMessage = { create: async (d) => { sent.push(d); return d; }, getSpeaker: () => ({}) };
  globalThis.ui = { notifications: { warn() {} } };
}
const teardown = () => { for (const k of ["game", "foundry", "fromUuid", "ChatMessage", "ui"]) delete globalThis[k]; };

const mkMsg = () => ({
  id: "M", flags: { [MOD]: { use: { actor: "Actor.a", token: null, item: null, rule: { onUse: { challenge: {} } }, targets: [{ key: "t1", uuid: "Tok.1" }, { key: "t2", uuid: "Tok.2" }], state: {} } } },
  async update(d) { for (const [p, v] of Object.entries(d)) { const ks = p.split("."), last = ks.pop(); let o = this; for (const k of ks) o = (o[k] ??= {}); o[last] = v; } }
});
const spell = { type: "spell", name: "Information Overload", slug: "information-overload", uuid: "Item.io", img: "io.svg", rank: 0, system: { duration: { value: "1 minute", sustained: true }, traits: { value: [] } } };
const cast = async (m, key = "t1", steps = [STEP]) => applyOps(m, key, steps, { scope: "challenge", degree: 1, originItem: spell });
const gmWhispers = () => sent.filter((s) => s.whisper?.length && /paf-card/.test(s.content));

async function scene() {
  setup();
  const author = mkActor("Actor.a"), t1 = mkActor("Actor.t1"), t2 = mkActor("Actor.t2");
  registry.set("Tok.1", { uuid: "Tok.1", actor: t1 }); registry.set("Tok.2", { uuid: "Tok.2", actor: t2 });
  world.combatants = [{ actor: author }];
  const m = mkMsg();
  const ops = await cast(m);
  return { author, t1, t2, m, ops };
}

test("чистая часть: позиция, пропуск, страховка, срок якоря", () => {
  assert.deepEqual(sustain.posOf({ id: "c", round: 3 }), { combat: "c", round: 3 });
  assert.deepEqual(sustain.posOf({ id: "c", round: 0 }), { combat: null, round: null });
  assert.deepEqual(sustain.posOf(null), { combat: null, round: null });
  const pos = { combat: "c1", round: 2 };
  assert.equal(sustain.missedAt({ combat: "c1", round: 2 }, pos), false);
  assert.equal(sustain.missedAt({ combat: "c1", round: 1 }, pos), true);
  assert.equal(sustain.missedAt({ combat: "c0", round: 2 }, pos), true);   // другой бой = не поддержано
  assert.equal(sustain.missedAt({ combat: null, round: null }, pos), true);
  assert.equal(sustain.missedBefore({ combat: "c1", round: 1 }, pos), false);   // ход раунда 1 прошёл с поддержанием в раунде 1
  assert.equal(sustain.missedBefore({ combat: "c1", round: 1 }, { combat: "c1", round: 3 }), true);
  assert.equal(sustain.missedBefore({ combat: "c0", round: 5 }, pos), true);
  assert.deepEqual(sustain.anchorDuration({ system: { duration: { value: "1 minute", sustained: true } } }), { value: 1, unit: "minutes" });
  assert.deepEqual(sustain.anchorDuration({ system: { duration: { value: "", sustained: true } } }), { value: 10, unit: "minutes" });
  assert.deepEqual(sustain.anchorDuration({ system: { duration: { value: "1 minute, or 8 hours", sustained: true } } }), { value: 10, unit: "minutes" });
  assert.notEqual(sustain.anchorSlug("information-overload"), "af-information-overload");
});

test("первый шаг sustain создаёт якорь один раз, привязка и журнал", async () => {
  const { author, t1, t2, m, ops } = await scene();
  try {
    assert.equal(anchors(author).length, 1);
    const a = anchors(author)[0];
    assert.equal(a.slug ?? a.system.slug, "sustain-information-overload");
    assert.equal(a.system.duration.sustained, true);
    assert.deepEqual([a.system.duration.value, a.system.duration.unit], [1, "minutes"]);
    assert.equal(a.flags[MOD].meta.key, KEY);
    assert.deepEqual(a.flags[MOD].sustain.actors, ["Actor.t1"]);
    assert.equal(bound(t1).length, 1);
    assert.deepEqual(ops.map((o) => o.op), ["created", "anchor"]);
    assert.equal(gmWhispers().length, 0);   // в бою при сотворении предложения нет
    world.combat = { id: "c1", round: 2 };
    await sustain.remind({ actor: author });   // начало следующего хода автора — шёпот с кнопками
    assert.equal(gmWhispers().length, 1);
    assert.match(sent.at(-1).content, /data-af-sustain="support"/);
    assert.match(sent.at(-1).content, /data-af-sustain="dismiss"/);
    world.combat = { id: "c1", round: 1 };
    // вторая цель того же сообщения и повтор первой: якорь один, привязок две, журнал без второго anchor
    const ops2 = await cast(m, "t2");
    assert.deepEqual(ops2.map((o) => o.op), ["created"]);
    assert.deepEqual((await cast(m, "t1")).map((o) => o.op), []);
    assert.equal(anchors(author).length, 1);
    assert.deepEqual(anchors(author)[0].flags[MOD].sustain.actors, ["Actor.t1", "Actor.t2"]);
    assert.equal(bound(t2).length, 1);
    // sustain:false/отсутствие — без привязки и якоря
    const t3 = mkActor("Actor.t3"); registry.set("Tok.3", { uuid: "Tok.3", actor: t3 }); m.flags[MOD].use.targets.push({ key: "t3", uuid: "Tok.3" });
    await cast(m, "t3", [{ ...STEP, sustain: false }]);
    assert.equal(t3.items[0].flags[MOD].meta.sustainOf, undefined);
  } finally { teardown(); }
});

test("«Поддержать»: срок не продлевается, повтор в раунде не блокируется, Sustain pf2e выкладывается; сотворение этого раунда = поддержано", async () => {
  const { author } = await scene();
  try {
    const last = () => anchors(author)[0].flags[MOD].sustain.last;
    assert.deepEqual(last(), { combat: "c1", round: 1 });
    assert.deepEqual((await sustain.run(author.uuid, KEY)).result, "again");   // сотворено в этом раунде
    world.combat = { id: "c1", round: 2 };
    assert.equal((await sustain.run(author.uuid, KEY)).result, "fresh");
    assert.deepEqual(last(), { combat: "c1", round: 2 });
    assert.equal((await sustain.run(author.uuid, KEY)).result, "again");
    assert.equal(pf2eSustain, 1);   // Sustain pf2e — только при засчитанном поддержании; повтор не блокируется, но в чат не пишет
    assert.equal(anchors(author)[0].system.duration.value, 1);
    assert.deepEqual(await sustain.run(author.uuid, "nope:sustain"), { ok: true, skipped: true });
  } finally { teardown(); }
});

test("пропуск: конец хода автора без поддержания в раунде снимает якорь и привязанное, шёпот ГМу", async () => {
  const { author, t1, t2, m } = await scene();
  try {
    await cast(m, "t2");
    world.combat = { id: "c1", round: 2 };
    await sustain.onEndTurn({ actor: author }, { id: "c1", round: 2 });   // в раунде 2 поддержания не было
    assert.equal(anchors(author).length, 0);
    assert.equal(bound(t1).length + bound(t2).length, 0);
    assert.equal(gmWhispers().length, 1);   // только «закончилось»: в бою предложение — в начале хода, не при сотворении
    assert.match(sent.at(-1).content, /sustain\.ended\.missed/);
  } finally { teardown(); }
});

test("последний по инициативе: endTurn приходит с round = R+1, раунд хода — из roundOfLastTurnEnd (нет ложного пропуска)", async () => {
  const { author } = await scene();
  try {
    world.combat = { id: "c1", round: 2 };   // бой уже перешёл в раунд 2
    await sustain.onEndTurn({ actor: author, flags: { pf2e: { roundOfLastTurnEnd: 1 } } }, { id: "c1", round: 2 });   // сотворено в раунде 1
    assert.equal(anchors(author).length, 1);
    await sustain.onEndTurn({ actor: author, flags: { pf2e: { roundOfLastTurnEnd: 2 } } }, { id: "c1", round: 3 });   // раунд 2 без поддержания
    assert.equal(anchors(author).length, 0);
  } finally { teardown(); }
});

test("якорь ищется в бою автора, а не в game.combat; уже удалённый якорь — тихий пропуск", async () => {
  const { author } = await scene();
  try {
    world.combat = { id: "c1", round: 2 };
    const other = { id: "c9", round: 7, combatants: [] };
    Object.defineProperty(globalThis.game, "combat", { get: () => other, configurable: true });   // выбранная вкладка — чужой бой
    assert.equal((await sustain.run(author.uuid, KEY)).result, "fresh");
    assert.deepEqual(anchors(author)[0].flags[MOD].sustain.last, { combat: "c1", round: 2 });
    const a = anchors(author)[0];
    await a.delete();
    assert.equal((await sustain.check([author], { combat: "c1", round: 9 }, "turn")), 0);
  } finally { teardown(); }
});

test("«Откат → Применить» не шлёт второй шёпот; last берётся из момента сотворения (use.at)", async () => {
  const { author, m } = await scene();
  try {
    await undoOps(m, "t1");
    assert.equal(anchors(author).length, 0);
    const n = sent.length;
    m.flags[MOD].use.at = { combat: "c1", round: 1 };
    world.combat = { id: "c1", round: 3 };
    await cast(m);
    assert.equal(anchors(author).length, 1);
    assert.deepEqual(anchors(author)[0].flags[MOD].sustain.last, { combat: "c1", round: 1 });
    assert.equal(sent.length, n);
  } finally { teardown(); }
});

test("конец хода с поддержанием этого раунда ничего не снимает; чужой актёр не трогается", async () => {
  const { author, t1 } = await scene();
  try {
    world.combat = { id: "c1", round: 2 };
    await sustain.run(author.uuid, KEY);
    await sustain.onEndTurn({ actor: author }, { id: "c1", round: 2 });
    await sustain.onEndTurn({ actor: t1 }, { id: "c1", round: 2 });
    assert.equal(anchors(author).length, 1);
    assert.equal(bound(t1).length, 1);
  } finally { teardown(); }
});

test("другой бой = не поддержано; конец боя якорь не снимает", async () => {
  const { author, t1 } = await scene();
  try {
    world.combat = null;   // бой кончился: якорь живёт
    assert.equal(anchors(author).length, 1);
    world.combat = { id: "c2", round: 1 };   // новый бой: сотворение было в c1
    await sustain.onEndTurn({ actor: author }, world.combat);
    assert.equal(anchors(author).length, 0);
    assert.equal(bound(t1).length, 0);
  } finally { teardown(); }
});

test("«Прекратить» и истечение срока снимают привязанное (не через removeCarrier)", async () => {
  let s = await scene();
  try {
    assert.deepEqual(await sustain.run(s.author.uuid, KEY, "dismiss"), { ok: true, ended: "dismiss" });
    assert.equal(anchors(s.author).length, 0); assert.equal(bound(s.t1).length, 0);
  } finally { teardown(); }
  s = await scene();
  try {
    anchors(s.author)[0].isExpired = true;   // removeExpiredEffects выключена: якорь жив, но срок вышел
    assert.deepEqual(await sustain.run(s.author.uuid, KEY), { ok: true, ended: "expired" });
    assert.equal(bound(s.t1).length, 0); assert.equal(pf2eSustain, 0);
  } finally { teardown(); }
  s = await scene();
  try {
    anchors(s.author)[0].isExpired = true;
    await sustain.onEndTurn({ actor: s.author }, { id: "c1", round: 1 });   // и в конце хода
    assert.equal(anchors(s.author).length, 0); assert.equal(bound(s.t1).length, 0);
  } finally { teardown(); }
});

test("ручное удаление якоря = конец; недоступная цель — предупреждение, остальное снято", async () => {
  const { author, t1, t2, m } = await scene();
  try {
    await cast(m, "t2");
    const warns = [];
    globalThis.ui.notifications.warn = (x) => warns.push(x);
    registry.delete("Actor.t1");   // актёр недоступен
    await anchors(author)[0].delete();
    assert.equal(bound(t2).length, 0);
    assert.equal(bound(t1).length, 1);
    assert.equal(warns.length, 1);
  } finally { teardown(); }
});

test("страховка смены раунда: пропущенный ход без endTurn", async () => {
  const { author, t1 } = await scene();
  try {
    const combat = { id: "c1", round: 2, combatants: [{ actor: author }] };
    world.combat = combat;
    await sustain.sweep(combat);   // ход раунда 1 прошёл: сотворено в раунде 1 — жив
    assert.equal(anchors(author).length, 1);
    combat.round = 3;
    await sustain.sweep(combat);
    assert.equal(anchors(author).length, 0);
    assert.equal(bound(t1).length, 0);
  } finally { teardown(); }
});

test("откат: последняя привязка уходит — якорь удаляется как откат, без «конца заклинания»", async () => {
  const { author, t1, t2, m } = await scene();
  try {
    await cast(m, "t2");
    const before = sent.length;
    assert.equal((await undoOps(m, "t1")).undone, 1);   // привязка t2 ещё есть
    assert.equal(anchors(author).length, 1);
    assert.deepEqual(anchors(author)[0].flags[MOD].sustain.actors, ["Actor.t2"]);   // откатанная цель вычищена из списка
    assert.equal(bound(t1).length, 0);
    await undoOps(m, "t2");
    assert.equal(anchors(author).length, 0);
    assert.equal(sent.length, before);   // ни шёпота о конце
  } finally { teardown(); }
});

function sustainMsg(extra = {}) {
  return { id: `m${Math.random()}`, flags: {}, flavor: `<h4 class="action"><strong>PF2E.Actions.Sustain.Title</strong></h4>`, async update(d) { for (const [p, v] of Object.entries(d)) { const ks = p.split("."), last = ks.pop(); let o = this; for (const k of ks) o = (o[k] ??= {}); o[last] = v; } }, ...extra };
}

test("разбор чата: оба вида сообщений Sustain распознаются, обычные — нет", () => {
  setup();
  try {
    assert.equal(sustain.isSustainMessage(sustainMsg()), true);
    assert.equal(sustain.isSustainMessage(sustainMsg({ flavor: `<h4 class="action"><strong>Point Out</strong></h4>` })), false);
    assert.equal(sustain.isSustainMessage({ flags: { pf2e: { origin: { type: "action", slug: "sustain", actor: "Actor.a" } } } }), true);
    assert.equal(sustain.isSustainMessage({ flags: { pf2e: { origin: { type: "spell", slug: "sustain" } } } }), false);
    assert.equal(sustain.isSustainMessage({ flags: { pf2e: { origin: { type: "action", slug: "stride" } } } }), false);
  } finally { teardown(); }
});

test("разбор чата: один якорь — засчитывается, повтор по id сообщения — нет; несколько якорей — подсказка; свой Sustain не считается дважды", async () => {
  const { author, m } = await scene();
  try {
    world.combat = { id: "c1", round: 2 };
    const msg = sustainMsg({ actor: author });
    await sustain.onMessage(msg);
    assert.deepEqual(anchors(author)[0].flags[MOD].sustain.last, { combat: "c1", round: 2 });
    world.combat = { id: "c1", round: 3 };
    await sustain.onMessage(msg);   // то же сообщение
    assert.deepEqual(anchors(author)[0].flags[MOD].sustain.last.round, 2);
    // свой Sustain внутри run: разбор молчит (иначе пришёл бы раунд 3 раньше кнопки — результат тот же, но подсказка/двойной учёт недопустимы)
    world.onUse = () => sustain.onMessage(sustainMsg({ actor: author }));
    const r = await sustain.run(author.uuid, KEY);
    assert.equal(r.result, "fresh");
    world.onUse = null;
    // второй якорь (повторное сотворение — другое сообщение)
    const m2 = { ...mkMsg(), id: "M2" };
    await applyOps(m2, "t2", [STEP], { scope: "challenge", degree: 1, originItem: spell });
    assert.equal(anchors(author).length, 2);
    world.combat = { id: "c1", round: 4 };
    const before = sent.length;
    await sustain.onMessage(sustainMsg({ actor: author }));
    assert.equal(sent.length, before + 1);
    assert.match(sent.at(-1).content, /sustain\.pick/);
    assert.ok(anchors(author).every((a) => a.flags[MOD].sustain.last.round !== 4));
  } finally { teardown(); }
});

test("orphaned: токен удалённой сцены/токена — сирота, обычный актёр и живой токен — нет", async () => {
  const { orphaned, removeBound } = await import("../scripts/apply.mjs");
  const live = { isToken: true, token: { id: "t", parent: { tokens: new Map([["t", {}]]) } } };
  const gone = { isToken: true, token: { id: "t", parent: { tokens: new Map() } }, uuid: "x", items: [] };
  assert.deepEqual([orphaned({}), orphaned(live), orphaned(gone), orphaned(null)], [false, false, true, false]);
  assert.deepEqual(await removeBound(gone, "k"), { op: "skipped" });
});
