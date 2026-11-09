// Шаг apply «visibility»: валидатор, текст, форма листа, applyOps/undoOps с заглушкой PF2e Vision, невидимость и враждебное действие.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRule } from "../scripts/rules.mjs";
import { stepText } from "../scripts/chat.mjs";
import { ruleToForm, formToRule } from "../scripts/sheet.mjs";
import { endsOnHostile, isHostileMessage } from "../scripts/invis.mjs";

const rule = (apply) => ({ v: 1, onUse: { targets: "selected", apply } });
const V = { level: "hidden", of: "self", until: ["turn-end", "attack"] };

test("validateRule: visibility", () => {
  const ok = validateRule(rule([{ to: "target", visibility: V }]));
  assert.deepEqual(ok.errors ?? [], []);
  assert.deepEqual(ok.rule.onUse.apply[0], { to: "target", visibility: V });
  assert.deepEqual(validateRule(rule([{ to: "target", visibility: { level: "hidden", of: "self" } }])).rule.onUse.apply[0].visibility, { level: "hidden", of: "self" });
  for (const bad of [{ level: "observed", of: "self" }, { level: "hidden", of: "x" }, { level: "hidden", of: "target" }, { level: "hidden", of: "self", until: ["later"] }])
    assert.ok(validateRule(rule([{ to: "target", visibility: bad }])).errors.length, JSON.stringify(bad));
  assert.ok(validateRule(rule([{ to: "self", visibility: { level: "hidden", of: "self" } }])).errors.length);   // to == of
  assert.ok(validateRule(rule([{ to: "target", note: "n", visibility: V }])).errors.length);   // ровно один вид
});

test("stepText: visibility", () => {
  const dict = { "chat.stepVisTarget": "{level} от цели{until}", "chat.stepVisSelf": "цель: {level}{until}", "chat.visLevel.hidden": "спрятан", "chat.visUntil.turn-end": "до конца хода", "chat.visUntil.attack": "до атаки", "chat.visManual": "(вручную)" };
  const env = { t: (k, d = {}) => (dict[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => d[n]), vision: () => true };
  assert.equal(stepText({ to: "target", visibility: V }, env, "target"), "спрятан от цели (до конца хода, до атаки)");
  assert.equal(stepText({ to: "self", visibility: { level: "hidden", of: "target" } }, env, "target"), "цель: спрятан");
  assert.equal(stepText({ to: "target", visibility: V }, { ...env, vision: () => false }, "target"), "спрятан от цели (до конца хода, до атаки) (вручную)");
});

test("форма листа: visibility в обе стороны", () => {
  const r = validateRule(rule([{ to: "target", visibility: V }, { to: "target", visibility: { level: "undetected", of: "self", until: ["next-turn-end"] } }])).rule;
  const f = ruleToForm(r);
  assert.deepEqual([f.apply[0].kind, f.apply[0].visLevel, f.apply[0].visOf, f.apply[0].visUntil], ["visibility", "hidden", "self", "turn-end, attack"]);
  const back = validateRule(formToRule(f));
  assert.deepEqual(back.errors ?? [], []);
  assert.deepEqual(back.rule, r);
});

test("невидимость: рабочая часть — ранг < 4 и заклинание Невидимость; бросок атаки", () => {
  assert.equal(endsOnHostile({ rank: 2 }, "invisibility"), true);
  assert.equal(endsOnHostile({ rank: 3 }, "invisibility"), true);
  assert.equal(endsOnHostile({ rank: 4 }, "invisibility"), false);
  assert.equal(endsOnHostile({ rank: 2 }, "potion"), false);
  assert.equal(endsOnHostile({}, "invisibility"), false);   // ранг неизвестен — решает ГМ
  assert.equal(endsOnHostile(undefined, null), false);
  assert.equal(isHostileMessage({ flags: { pf2e: { context: { type: "attack-roll" } } } }), true);
  assert.equal(isHostileMessage({ flags: { pf2e: { context: { type: "damage-roll" } } } }), false);
});

test("applyOps/undoOps: visibility ставит источник и откатывается dropSource", async () => {
  const applied = [], lv = {};
  const scene = { id: "S", flags: {}, async update(d) { const [k, v] = Object.entries(d)[0]; scene.flags["pf2e-automato"] = k.includes("-=") ? {} : { vis: v }; } };   // forcedReplace/forcedDelete без Foundry — устаревшие == / -=
  const tok = (id) => ({ id, parent: scene, disposition: id === "me" ? 1 : -1 });
  const me = tok("me"), gob = tok("gob");
  scene.tokens = new Map([["me", me], ["gob", gob]]);   // мёртвые токены реестр выкидывает
  const docs = new Map([["Scene.S.Token.me", me], ["Scene.S.Token.gob", gob], ["Actor.a", { uuid: "Actor.a" }]]);
  globalThis.fromUuid = async (u) => docs.get(u) ?? null;
  globalThis.foundry = { utils: { getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
  globalThis.game = {
    user: { isActiveGM: true }, scenes: { get: () => scene }, settings: { get: () => true },
    combats: { active: { combatant: null, combatants: [{ sceneId: "S" }] } },   // until вне боя — отказ
    modules: { get: () => ({ active: true, api: { store: { getLevel: (t, o) => lv[`${t}>${o}`] ?? "observed", applyChanges: async (c) => { for (const x of c) lv[`${x.targetId}>${x.observerId}`] = x.level; applied.push(...c); } } } }) }
  };
  const message = {
    id: "M", flags: { "pf2e-automato": { use: { actor: "Actor.a", token: "Scene.S.Token.me", item: { name: "Diversion" }, targets: [{ key: "gob", uuid: "Scene.S.Token.gob" }], rule: {} } } },
    async update(d) { for (const [k, v] of Object.entries(d)) { const p = k.split("."); let o = this; for (const x of p.slice(0, -1)) o = o[x] ??= {}; o[p.at(-1)] = v; } }
  };
  const { applyOps, undoOps } = await import("../scripts/apply.mjs");
  const steps = [{ to: "target", visibility: V }];
  const ops = await applyOps(message, "gob", steps, { scope: "challenge", degree: 2 });
  assert.deepEqual(ops, [{ op: "vis", scene: "S", key: "auto:M:gob:c2.0" }]);
  assert.deepEqual(applied, [{ observerId: "gob", targetId: "me", level: "hidden" }]);
  const { readVis } = await import("../scripts/vision.mjs");
  assert.ok(!JSON.stringify(scene.flags["pf2e-automato"].vis).includes("c2.0"));   // точки в ключах закодированы: Foundry развернул бы их
  assert.deepEqual(readVis(scene).meta["auto:M:gob:c2.0"], { label: "Diversion", until: ["turn-end", "attack"], subjectId: "me" });
  assert.deepEqual(await applyOps(message, "gob", steps, { scope: "challenge", degree: 2 }), []);   // повтор — идемпотентно
  // без Vision — шаг не исполняется
  game.settings.get = () => false;
  assert.deepEqual(await applyOps(message, "gob", steps, { scope: "challenge", degree: 3 }), []);
  game.settings.get = () => true;
  applied.length = 0;
  assert.deepEqual(await undoOps(message, "gob"), { undone: 1 });
  assert.deepEqual(applied, [{ observerId: "gob", targetId: "me", level: "observed" }]);
});

test("каталог: Отвлекающий манёвр и Отвести глаза используют visibility", async () => {
  const { readFileSync } = await import("node:fs");
  const cat = JSON.parse(readFileSync(new URL("../rules/catalog.json", import.meta.url), "utf8"));
  const flag = JSON.parse(readFileSync(new URL("../tools/campaign-flag-rules.json", import.meta.url), "utf8"));
  const vis = (bd, d) => bd[d].find((a) => a.visibility)?.visibility;
  const div = cat.bySlug["create-a-diversion"].onUse.check.byDegree;
  assert.deepEqual(vis(div, "success"), V);
  assert.deepEqual(vis(div, "criticalSuccess"), V);
  const eyes = flag["Отвести глаза"].onUse.challenge.byDegree;
  assert.deepEqual([vis(eyes, "success"), vis(eyes, "failure"), vis(eyes, "criticalFailure")].map((v) => [v.level, v.of, v.until[0]]),
    [["concealed", "self", "turn-end"], ["hidden", "self", "turn-end"], ["undetected", "self", "next-turn-end"]]);
});

test("validateRule: visibility с to=self в onUse.apply запрещён, to=target/of=self — можно", () => {
  assert.ok(validateRule(rule([{ to: "self", visibility: { level: "hidden", of: "target" } }])).errors.length);
  assert.deepEqual(validateRule(rule([{ to: "target", visibility: { level: "hidden", of: "self" } }])).errors ?? [], []);
  const ch = { v: 1, onUse: { targets: "selected", challenge: { statistic: "will", dc: { value: 20 }, byDegree: { failure: [{ to: "self", visibility: { level: "hidden", of: "target" } }] } } } };
  assert.deepEqual(validateRule(ch).errors ?? [], []);   // в испытании self-наблюдатель работает: цель строки есть
});

test("invisVerdict и каталог Невидимости", async () => {
  const { invisVerdict } = await import("../scripts/invis.mjs");
  assert.equal(invisVerdict({ rank: 2 }, "invisibility"), "ends");
  assert.equal(invisVerdict({ rank: 4 }, "invisibility"), "never");
  assert.equal(invisVerdict(undefined, null), "unknown");
  assert.equal(invisVerdict({ rank: 2 }, "other"), "unknown");
  const { readFileSync } = await import("node:fs");
  const cat = JSON.parse(readFileSync(new URL("../rules/catalog.json", import.meta.url), "utf8"));
  assert.deepEqual(validateRule(cat.bySlug.invisibility).errors ?? [], []);
  assert.equal(validateRule(cat.bySlug.invisibility).rule.onUse.apply[0].duration.value, 10);
});

test("враждебное действие: снимается обёртка; без meta — карточка, а не тихое снятие", async () => {
  const hooks = {}, created = [], deleted = [];
  const wrapper = { uuid: "W", flags: { "pf2e-automato": { meta: { origin: "Item.spell", rank: 2 } } }, delete: async () => deleted.push("W") };
  const granted = { slug: "invisible", uuid: "C", grantedBy: wrapper, flags: {}, delete: async () => deleted.push("C") };
  const bare = { slug: "invisible", uuid: "B", flags: {}, delete: async () => deleted.push("B") };
  const high = { slug: "invisible", uuid: "H", flags: { "pf2e-automato": { meta: { origin: "Item.spell", rank: 4 } } }, delete: async () => deleted.push("H") };
  let mode = "auto", conds = [granted];
  globalThis.Hooks = { on: (n, f) => { hooks[n] = f; } };
  globalThis.game = { user: { isActiveGM: true }, settings: { get: () => mode }, i18n: { localize: (k) => k, format: (k) => k } };
  globalThis.fromUuidSync = () => ({ slug: "invisibility" });
  globalThis.foundry = { utils: { escapeHTML: (s) => s } };
  globalThis.ChatMessage = { create: async (d) => { created.push(d); }, getWhisperRecipients: () => [{ id: "gm" }] };
  const { init } = await import("../scripts/invis.mjs");
  init();
  const msg = () => ({ flags: { pf2e: { context: { type: "attack-roll" } } }, actor: { name: "A", uuid: "Actor.a", itemTypes: { condition: conds } } });
  await hooks.createChatMessage(msg());
  assert.deepEqual(deleted, ["W"]);   // обёртка, а не выданное состояние
  assert.equal(created.length, 1);
  deleted.length = 0; created.length = 0; conds = [bare, high];
  await hooks.createChatMessage(msg());   // auto, ранг неизвестен -> карточка; ранг 4 — ничего
  assert.deepEqual(deleted, []);
  assert.equal(created.length, 1);
  assert.match(created[0].content, /askUnknown/);
  mode = "off"; created.length = 0;
  await hooks.createChatMessage(msg());
  assert.equal(created.length, 0);
  delete globalThis.Hooks;
});

test("applyOps: пропуск шага пишется в ops; видимость на актёре при Vision пропускается", async () => {
  const scene = { id: "S", flags: {}, async update() {} };
  const me = { id: "me", parent: scene, disposition: 1 }, other = { id: "o", parent: { id: "S2" }, disposition: -1 };
  const warns = [];
  const docs = new Map([["T.me", me], ["T.o", other], ["Actor.a", { uuid: "Actor.a" }]]);
  globalThis.fromUuid = async (u) => docs.get(u) ?? null;
  globalThis.ui = { notifications: { warn: (m) => warns.push(m) } };
  globalThis.foundry = { utils: { getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) } };
  globalThis.game = { user: { isActiveGM: true }, scenes: { get: () => scene }, settings: { get: () => true }, i18n: { localize: (k) => k, format: (k) => k },
    modules: { get: () => ({ active: true, api: { store: { getLevel: () => "observed", applyChanges: async () => {} } } }) } };
  const message = (token) => ({ id: "M", flags: { "pf2e-automato": { use: { actor: "Actor.a", token, item: { name: "X" }, targets: [{ key: "o", uuid: "T.o" }], rule: {} } } },
    async update(d) { for (const [k, v] of Object.entries(d)) { const p = k.split("."); let o = this; for (const x of p.slice(0, -1)) o = o[x] ??= {}; o[p.at(-1)] = v; } } });
  const { applyOps, applyCondition } = await import("../scripts/apply.mjs");
  const steps = [{ to: "target", visibility: V }];
  assert.deepEqual(await applyOps(message(undefined), "o", steps, { scope: "apply" }), [{ op: "vis", skipped: "noToken", key: "auto:M:o:0" }]);
  assert.deepEqual(await applyOps(message("T.me"), "o", steps, { scope: "apply" }), [{ op: "vis", skipped: "scene", key: "auto:M:o:0" }]);   // токены на разных сценах
  assert.equal(warns.length, 2);
  // состояния видимости при Vision не ставятся
  const actor = { uuid: "Actor.o", attributes: {}, items: [], itemTypes: { condition: [] } };
  assert.deepEqual(await applyCondition(actor, { slug: "hidden" }), { op: "skipped", reason: "vision" });
  const ops = await applyOps(message("T.me"), "o", [{ to: "target", condition: { slug: "concealed" } }], { scope: "apply", target: { actor, disposition: -1, parent: scene, id: "o" } });
  assert.deepEqual(ops, [{ op: "vis", skipped: "marks", key: "M:o:0" }]);
});
