import test from "node:test";
import assert from "node:assert/strict";
import { MOD } from "../scripts/util.mjs";
import { applyCondition, applyOps, undoOps } from "../scripts/apply.mjs";
import { validateRule } from "../scripts/rules.mjs";

const registry = new Map();
function mkActor(uuid) {
  let n = 0;
  const items = [];
  const actor = {
    uuid, items,
    get itemTypes() { return { condition: items.filter((i) => i.type === "condition") }; },
    getActiveTokens: () => [{ uuid: `Scene.s.Token.${uuid}` }],
    async createEmbeddedDocuments(_, datas) {
      return datas.map((d) => {
        const it = { ...structuredClone(d), id: `i${++n}`, uuid: `${uuid}.Item.i${n}`, actor, isLocked: false };
        it.delete = async () => { items.splice(items.indexOf(it), 1); };
        registry.set(it.uuid, it); items.push(it);
        return it;
      });
    }
  };
  registry.set(uuid, actor);
  return actor;
}
const setup = () => {
  registry.clear();
  // как в pf2e: getCondition() отдаёт клон без uuid, источник — в _stats.compendiumSource
  globalThis.game = { modules: { get: () => null }, pf2e: { ConditionManager: { getCondition: (slug) => ({ uuid: null, _stats: { compendiumSource: `Compendium.pf2e.conditionitems.Item.${slug}` }, name: slug, img: "i.svg", system: { value: { isValued: slug === "clumsy" || slug === "frightened" } }, toObject() { return { name: slug, type: "condition", system: { slug, value: { isValued: false, value: null } } }; } }) } } };
  globalThis.foundry = { utils: { getProperty: (o, p) => p.split(".").reduce((a, k) => a?.[k], o) } };
  globalThis.fromUuid = async (u) => registry.get(u) ?? null;
};
const teardown = () => { for (const k of ["game", "foundry", "fromUuid"]) delete globalThis[k]; };
const DUR = { value: 1, unit: "rounds", expiry: "turn-start", of: "origin" };

test("applyCondition с duration: обёртка-эффект, GrantItem + badge-value, автор срока", async () => {
  setup();
  try {
    const t = mkActor("Actor.t"), author = { uuid: "Actor.a" };
    const r = await applyCondition(t, { slug: "clumsy", value: 2, duration: DUR }, { key: "k1" }, { originActor: author, originToken: { uuid: "Tok.a" } });
    const e = r.item;
    assert.equal(r.op, "created"); assert.equal(e.type, "effect");
    assert.deepEqual(e.system.duration, { sustained: false, value: 1, unit: "rounds", expiry: "turn-start" });
    assert.equal(e.system.context.origin.actor, "Actor.a");
    assert.equal(e.system.context.target.actor, "Actor.t");
    assert.deepEqual(e.system.rules[0], { key: "GrantItem", uuid: "Compendium.pf2e.conditionitems.Item.clumsy", onDeleteActions: { grantee: "restrict" },
      alterations: [{ mode: "override", property: "badge-value", value: 2 }] });
    assert.equal(e.flags[MOD].meta.key, "k1");
    assert.equal((await applyCondition(t, { slug: "clumsy", value: 2, duration: DUR }, { key: "k1" }, { originActor: author })).op, "skipped");   // идемпотентность
    assert.equal(t.items.length, 1);
    // of:"target" — отсчёт по ходам получателя; не-valued без alterations
    const r2 = await applyCondition(t, { slug: "prone", duration: { ...DUR, of: "target", expiry: "turn-end" } }, { key: "k2" }, { originActor: author });
    assert.equal(r2.item.system.context.origin.actor, "Actor.t");
    assert.equal(r2.item.system.rules[0].alterations, undefined);
  } finally { teardown(); }
});

test("applyCondition с duration: убывающие и досрочные — detach, обычные — restrict", async () => {
  setup();
  try {
    const t = mkActor("Actor.t"), ctx = { originActor: { uuid: "Actor.a" } };
    const f = await applyCondition(t, { slug: "frightened", value: 2, duration: DUR }, { key: "f" }, ctx);
    assert.equal(f.item.system.rules[0].onDeleteActions.grantee, "detach");
    assert.deepEqual(f.item.system.rules[0].alterations, [{ mode: "override", property: "badge-value", value: 2 }]);
    assert.equal((await applyCondition(t, { slug: "prone", duration: DUR }, { key: "p" }, ctx)).item.system.rules[0].onDeleteActions.grantee, "detach");   // Встать
    const c = await applyCondition(t, { slug: "clumsy", value: 1, duration: DUR }, { key: "c" }, ctx);
    assert.equal(c.item.system.rules[0].onDeleteActions.grantee, "restrict");
  } finally { teardown(); }
});

test("повышение без срока не трогает состояние, выданное обёрткой-сроком, — создаёт своё", async () => {
  setup();
  try {
    const t = mkActor("Actor.t");
    // выданный обёрткой испуг 1 (grantedBy есть, detach — не заперт)
    t.items.push({ type: "condition", slug: "frightened", isLocked: false, grantedBy: { id: "wrap" }, system: { value: { value: 1 } } });
    const r = await applyCondition(t, { slug: "frightened", value: 2 }, { key: "k" });
    assert.equal(r.op, "created");
    assert.equal(t.items.filter((i) => i.type === "condition").length, 2);
    assert.equal(t.items[0].system.value.value, 1);   // выданный не повышен
  } finally { teardown(); }
});

const mkMsg = (rule) => ({
  id: "M", flags: { [MOD]: { use: { actor: "Actor.a", token: null, item: null, rule, targets: [{ key: "t1", uuid: "Tok.1" }, { key: "t2", uuid: "Tok.2" }], state: {} } } },
  async update(d) {
    for (const [p, v] of Object.entries(d)) { const ks = p.split("."), last = ks.pop(); let o = this; for (const k of ks) o = (o[k] ??= {}); o[last] = v; }
  }
});

test("applyOps: duration у шага; self-ключ по цели для check, общий для challenge; undo снимает обёртку", async () => {
  setup();
  try {
    const author = mkActor("Actor.a"), t1 = mkActor("Actor.t1"), t2 = mkActor("Actor.t2");
    registry.set("Tok.1", { uuid: "Tok.1", actor: t1 }); registry.set("Tok.2", { uuid: "Tok.2", actor: t2 });
    const steps = [{ to: "target", condition: { slug: "clumsy", value: 1 }, duration: DUR }, { to: "self", condition: { slug: "prone" } }];
    const run = async (rule) => {
      const m = mkMsg(rule);
      await applyOps(m, "t1", steps, { scope: "challenge", degree: 0 });
      await applyOps(m, "t2", steps, { scope: "challenge", degree: 0 });
      return m;
    };
    let m = await run({ onUse: { check: {} } });
    assert.equal(author.items.length, 2);   // по броску на цель
    assert.equal(t1.items[0].type, "effect");
    assert.deepEqual(await undoOps(m, "t1"), { undone: 2 });
    assert.equal(t1.items.length, 0);
    author.items.length = 0; t1.items.length = 0; t2.items.length = 0;
    await run({ onUse: { challenge: {} } });
    assert.equal(author.items.length, 1);   // испытание: один раз
  } finally { teardown(); }
});

test("rules: валидация Apply.duration", () => {
  const mk = (step) => validateRule({ v: 1, onUse: { targets: "selected", check: { statistic: "athletics", vs: { defense: "ac" }, byDegree: { success: [step] } } } });
  const ok = mk({ condition: { slug: "clumsy", value: 1 }, duration: { value: 1, unit: "rounds", expiry: "turn-start" } });
  assert.ok(ok.ok, ok.errors.join());
  assert.deepEqual(ok.rule.onUse.check.byDegree.success[0].duration, { value: 1, unit: "rounds", expiry: "turn-start", of: "origin" });
  assert.equal(mk({ condition: { slug: "clumsy" } }).rule.onUse.check.byDegree.success[0].duration, undefined);
  for (const d of [{ value: 0, unit: "rounds" }, { value: 1, unit: "years" }, { value: 1, unit: "rounds", expiry: "x" }, { value: 1, unit: "rounds", of: "z" }])
    assert.equal(mk({ condition: { slug: "clumsy" }, duration: d }).ok, false);
  assert.deepEqual(mk({ condition: { slug: "off-guard" }, duration: { value: 0, unit: "rounds", expiry: "turn-end" } }).rule.onUse.check.byDegree.success[0].duration, { value: 0, unit: "rounds", expiry: "turn-end", of: "origin" });
  assert.equal(mk({ condition: { slug: "off-guard" }, duration: { value: 0, unit: "rounds", expiry: "turn-start" } }).ok, false);
  assert.equal(mk({ note: "x", duration: { value: 1, unit: "rounds" } }).ok, false);
});
