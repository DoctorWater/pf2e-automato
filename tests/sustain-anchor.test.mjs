import test from "node:test";
import assert from "node:assert/strict";
import { MOD } from "../scripts/util.mjs";
import * as sustain from "../scripts/sustain.mjs";

let sent, registry;
function setup(actors) {
  sent = []; registry = new Map();
  globalThis.game = {
    modules: { get: () => null }, user: { isActiveGM: true }, users: [{ id: "gm", isGM: true }],
    i18n: { localize: (k) => k, format: (k) => k },
    combats: [], combat: null, messages: { find: (fn) => sent.find(fn) }, settings: { get: () => true },
    actors: { contents: actors }, scenes: { contents: [] }
  };
  globalThis.fromUuid = async (u) => registry.get(u) ?? null;
  globalThis.ChatMessage = { create: async (d) => { sent.push(d); return d; }, getSpeaker: () => ({}) };
  globalThis.ui = { notifications: { warn() {} } };
}
const teardown = () => { for (const k of ["game", "fromUuid", "ChatMessage", "ui"]) delete globalThis[k]; };

function mkActor(uuid) {
  let n = 0;
  const items = [];
  const actor = {
    uuid, name: uuid, items, getActiveTokens: () => [{ uuid: `Tok.${uuid}` }],
    async createEmbeddedDocuments(_, datas) {
      return datas.map((d) => {
        const it = { ...structuredClone(d), id: `${uuid}.i${++n}`, uuid: `${uuid}.Item.i${n}`, actor, isExpired: false };
        it.update = async (ch) => { for (const [p, v] of Object.entries(ch)) { const ks = p.split("."), last = ks.pop(); let o = it; for (const k of ks) o = (o[k] ??= {}); o[last] = v; } };
        it.delete = async (opts) => { items.splice(items.indexOf(it), 1); await sustain.onDeleteItem(it, opts); };
        items.push(it); registry.set(it.uuid, it);
        return it;
      });
    }
  };
  return actor;
}
const effect = (actor, name, meta) => actor.createEmbeddedDocuments("Item", [{ name, type: "effect", system: { slug: name }, flags: { [MOD]: { meta } } }]).then(([e]) => e);
const spell = (traits = [], sustained = true) => ({ type: "spell", name: "Figment", slug: "figment", uuid: "Item.fig", system: { duration: { value: "sustained", sustained }, traits: { value: traits } } });
const msg = (author, item, id = "M") => ({ id, item, actor: author, token: null });
const anchors = (a) => sustain.anchorsOf(a);

test("onCast: якорь у любого поддерживаемого заклинания, повтор не двоит, без Поддержания — нет", async () => {
  const author = mkActor("Actor.a");
  setup([author]);
  try {
    await sustain.onCast(msg(author, spell()));
    await sustain.onCast(msg(author, spell()));
    assert.equal(anchors(author).length, 1);
    assert.equal(anchors(author)[0].flags[MOD].meta.key, sustain.anchorKey("M"));
    assert.equal(sent.length, 1);   // одно предложение с кнопками
    assert.match(sent[0].content, /sustain\.offer\b|sustain\.offer</);
    await sustain.onCast(msg(author, spell([], false), "N"));
    assert.equal(anchors(author).length, 1);
  } finally { teardown(); }
});

test("onCast: наговор — тихое предложение; якорь шага sustain:true и автоякорь — один", async () => {
  const author = mkActor("Actor.a");
  setup([author]);
  try {
    await sustain.attach(author, { uuid: "Actor.t" }, { key: sustain.anchorKey("M"), msg: "M", item: spell(["hex"]) });
    await sustain.onCast(msg(author, spell(["hex"])));
    assert.equal(anchors(author).length, 1);
    assert.deepEqual(anchors(author)[0].flags[MOD].sustain.actors, ["Actor.t"]);
    const hexOnly = mkActor("Actor.h");
    await sustain.onCast(msg(hexOnly, spell(["hex"]), "H"));
    assert.match(sent.at(-1).content, /offerQuiet/);
  } finally { teardown(); }
});

test("конец якоря снимает эффекты без привязки по сообщению; чужие, привязанные и другой каст — нет", async () => {
  const author = mkActor("Actor.a"), target = mkActor("Actor.t");
  setup([author, target]);
  try {
    await sustain.onCast(msg(author, spell()));
    const own = await effect(target, "own", { source: "apply", message: "M", origin: "Item.fig" });
    const other = await effect(target, "other-cast", { source: "apply", message: "M2", origin: "Item.fig" });
    const foreign = await effect(target, "other-item", { source: "apply", message: "M", origin: "Item.other" });
    await sustain.check([author], { combat: "c1", round: 1 }, "round");   // последнее Поддержание — вне боя: раунд 1 ещё не пропущен
    assert.equal(anchors(author).length, 1);
    await sustain.check([author], { combat: "c1", round: 3 }, "round");   // пропуск
    assert.equal(anchors(author).length, 0);
    assert.deepEqual(target.items.map((i) => i.name).sort(), ["other-cast", "other-item"]);
    assert.ok(!target.items.includes(own) && target.items.includes(other) && target.items.includes(foreign));
    assert.ok(sent.some((s) => /sustain\.dropped/.test(s.content)));
  } finally { teardown(); }
});

test("откат (undo) и Поддержание в раунд — эффекты не снимаются; sustainOf не снимается вторым путём", async () => {
  const author = mkActor("Actor.a"), target = mkActor("Actor.t");
  setup([author, target]);
  try {
    await sustain.onCast(msg(author, spell()));
    await effect(target, "own", { source: "apply", message: "M", origin: "Item.fig" });
    await effect(target, "bound", { source: "apply", message: "M", origin: "Item.fig", sustainOf: sustain.anchorKey("M") });
    await anchors(author)[0].delete({ [MOD]: { undo: true } });
    assert.equal(target.items.length, 2);
    assert.equal(sustain.unboundOf([target], "M", "Item.fig").map((i) => i.name).join(), "own");
  } finally { teardown(); }
});

test("recipientsOf: автор, use.targets и токены области; сообщения нет — null", () => {
  const actor = (n) => ({ documentName: "Actor", n });
  const [au, t1, t2] = [actor("au"), actor("t1"), actor("t2")];
  const scene = { tokens: { get: (k) => (k === "k2" ? { actor: t2 } : null) } };
  globalThis.fromUuidSync = (u) => ({ T1: { actor: t1 }, R: { parent: scene } })[u] ?? null;
  const m = { actor: au, flags: { [MOD]: { use: { targets: [{ uuid: "T1" }], state: { area: { regionUuid: "R", keys: ["k2", "gone"] } } } } } };
  assert.deepEqual(sustain.recipientsOf(m), [au, t1, t2]);
  assert.equal(sustain.recipientsOf(null), null);
  delete globalThis.fromUuidSync;
});

test("toRemind: напоминаем о живых якорях, не поддержанных в этом раунде; сотворённые в этом раунде и истёкшие — нет", () => {
  const a = (last, isExpired = false) => ({ isExpired, flags: { [MOD]: { sustain: { last } } } });
  const pos = { combat: "c", round: 3 };
  const fresh = a({ combat: "c", round: 3 }), old = a({ combat: "c", round: 2 }), gone = a({ combat: "c", round: 2 }, true), other = a({ combat: "x", round: 3 });
  assert.deepEqual(sustain.toRemind([fresh, old, gone, other], pos), [old, other]);
});
