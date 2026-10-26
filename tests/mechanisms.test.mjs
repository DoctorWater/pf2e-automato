import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MECHANISMS, mechanismOf, mechanismsOf, poolable, statusOf, debtByMechanism, THRESHOLD } from "../tools/mechanisms.mjs";
import { debtPool } from "../tools/debt-pool.mjs";

const it = (type, actionType, traits = []) => ({ uuid: "u", type, actionType, traits });
const N = "needs-primitive: missing: ";

// причина (+ предмет) -> ожидаемый ключ; метка «strike-gate» разносится по предмету (диагностика sonnet-debt-01)
const FIXTURE = [
  [N + "strike-gate", it("ammo", null, ["consumable", "magical"]), "ammo-bomb"],
  [N + "strike-gate", it("weapon", null, ["alchemical", "bomb", "consumable"]), "ammo-bomb"],
  [N + "ammo/bomb trigger (rune)", null, "ammo-bomb"],
  [N + "strike-gate", it("action", "passive"), "passive-hit-trigger"],
  [N + "strike-gate", it("feat", "passive", ["rogue"]), "passive-hit-trigger"],
  [N + "trigger on hit; delayed save", null, "passive-hit-trigger"],
  [N + "strike-gate", it("weapon", null, ["finesse"]), "weapon-next-strike"],
  [N + "strike-gate", it("feat", "action"), "strike-gate"],
  [N + "strike-gate; repeated save", it("action", "action"), "strike-gate"],
  [N + "push 10 ft", null, "push"],
  [N + "push 5/10 ft", null, "push"],
  [N + "push distance depends on hit count", null, "push-by-hits"],
  [N + "triggered save at turn start; forced action", null, "triggered-save"],
  [N + "triggered aura", null, "triggered-save"],
  [N + "ongoing save, slowed escalation", null, "repeat-save"],
  [N + "cast spell from list", null, "staff-charges"],
  [N + "cast: heal", null, "cast-activation"],
  [N + "-2 circumstance penalty (hearing only)", null, "mods-conditional"],
  [N + "+1 bonus vs. target", null, "mods-conditional"],
  [N + "bonus on disbelief saves", null, "mods-conditional"],
  [N + "-10 ft speed penalty on success", null, "mods"],
  [N + "strike-gate", it("spell", "action"), "spell-strike-gate"],
  [N + "actions change targets", null, "root-mode-choice"],
  [N + "random color choice", null, "root-mode-choice"],
  [N + "backlash choice", null, "root-mode-choice"],
  [N + "mode choice", it("spell", "action"), "root-mode-choice"],
  [N + "several modes", it("feat", "action"), "root-mode-choice"],
  [N + "mode choice", it("equipment", "action"), "mode-choice"],
  [N + "pushed into line", null, "forced-movement-other"],
  [N + "charges (staff)", null, "staff-charges"],
  [N + "next-cast (catalyst for Heal)", null, "next-cast"],
  [N + "affliction: linger: permanently", null, "affliction-linger"],
  [N + "affliction: duration: no stage has one", null, "affliction-duration"],
  [N + "affliction: stage clarification: as stage 2 with changes", null, "affliction-stage-text"],
  [N + "affliction stages", null, "affliction-stages"],
  [N + "affliction: weapon activation", null, "affliction-injury"],
  [N + "forced action", null, "forced-action"],
  [N + "condition tied to another condition (slowed while sickened)", null, "condition-link"],
  [N + "unclear duration (restrained)", null, "duration-unclear"],
  // ответ модели: канонический ключ или new:
  [N + "ammo-bomb", null, "ammo-bomb"],
  [N + "push-by-hits, push", null, "push-by-hits"],
  [N + "strike-gate", null, "strike-gate"],
  [N + "new: trample through creatures", null, null],
  [N + "degree shift on critical hit", null, "degree-shift"],
  [N + "repeated damage", null, null],
  [N + "forced fall", null, "forced-movement-other"],
  [N + "lift/forced movement", null, "forced-movement-other"],
  [N + "push out of line", null, "forced-movement-other"],
  [N + "triggered save on Shield Block", null, "event-trigger"],
  [N + "triggered save when target dies", null, "event-trigger"],
  [N + "triggered save", null, "event-trigger"],
  [N + "triggered save on critical hit", null, "passive-hit-trigger"],
  [N + "Freeze Ammunition", null, "ammo-bomb"],
  [N + "forced repeat of actions", null, "forced-action"],
  [N + "can't use hostile actions against you", null, "hostile-actions"],
  [N + "effect too long (unlimited effect)", null, "effect-too-long"],
  [N + "affliction: random duration", null, "random-duration"],
  [N + "-10 ft speed penalty on success", null, "mods"],
  [N + "can't use reactions", null, "mods"],
  [N + "teleport", null, "teleport"],
  [N + "trample through difficult terrain", null, "trample"],
  [N + "zone within reach", null, null]
];

test("словарь механизмов: причина из фикстуры сводится к ожидаемому ключу", () => {
  for (const [reason, item, key] of FIXTURE) assert.equal(mechanismOf(reason, item), key, `${reason} ${JSON.stringify(item)}`);
});

test("словарь механизмов: регэкспы компилируются, ключи уникальны и названы в промпте", () => {
  const md = readFileSync(new URL("../tools/prompts/draft-rule.md", import.meta.url), "utf8");
  for (const [k, m] of Object.entries(MECHANISMS)) {
    assert.ok(m.title && "primitive" in m && (m.aliases?.length || m.rule), k);
    for (const a of m.aliases ?? []) new RegExp(a, "i");
    assert.ok(md.includes("`" + k + "`"), `ключ ${k} не назван в draft-rule.md`);
  }
});

test("статус механизма: порог, примитив, промпт", () => {
  assert.equal(statusOf("push", 1), "к проходу");
  assert.equal(statusOf("passive-hit-trigger", 99), "к проходу");
  assert.equal(statusOf("ammo-bomb", THRESHOLD), "к плану");
  assert.equal(statusOf("ammo-bomb", THRESHOLD - 1), "ждёт");
});

test("счёт долга: только needs-primitive, без метки — отдельно", () => {
  const acc = [{ uuid: "a", reason: N + "push 10 ft" }, { uuid: "b", reason: "model: ok" }, { uuid: "c", reason: N + "weird thing" }, { uuid: "d", reason: N + "weird thing" }];
  const r = debtByMechanism(acc, []);
  assert.equal(r.rows.find((x) => x.key === "push").n, 1);
  assert.equal(r.unlabeled.n, 2);
  assert.deepEqual(r.unlabeled.top, [["weird thing", 2, "weird thing"]]);
});

test("все ключи записи: кусок за куском; новый ключ модели после «; »", () => {
  assert.deepEqual(mechanismsOf(N + "strike-gate; ammo-bomb", null), { keys: ["strike-gate", "ammo-bomb"], free: false });
  assert.deepEqual(mechanismsOf(N + "push 10 ft; several activations", null).keys, ["push", "mode-choice"]);
  assert.deepEqual(mechanismsOf(N + "push, weird thing", null), { keys: ["push"], free: true });
  assert.deepEqual(mechanismsOf(N + "new: trample, push", null), { keys: [], free: true });
  assert.deepEqual(mechanismsOf(N + "triggered save (aura), condition tied to another condition", null).keys, ["triggered-save", "condition-link"]);
});

test("poolable: примитив у всех ключей, промпт знает, нет via и кусков без ключа", () => {
  assert.equal(poolable({ keys: ["push", "mods"], free: false }), true);
  assert.equal(poolable({ keys: ["push", "ammo-bomb"], free: false }), false);
  assert.equal(poolable({ keys: ["push"], free: true }), false);
  assert.equal(poolable({ keys: ["passive-hit-trigger"], free: false }), true);
  assert.equal(poolable({ keys: ["cast-activation"], free: false }), false);
  assert.equal(poolable({ keys: [], free: false }), false);
});

test("debtPool: только записи, готовые по всем ключам, без отвеченных; в записи есть batch", () => {
  const pool = debtPool("all", new Set());
  assert.ok(pool.length > 0);
  for (const p of pool) {
    assert.match(p.batch, /^b\d+-/);
    const m = mechanismsOf("needs-primitive: " + p.why, p.it);
    assert.ok(poolable(m), p.why);
  }
  const without = debtPool("all", new Set([pool[0].uuid]));
  assert.equal(without.length, pool.length - 1);
  assert.ok(!without.some((p) => p.uuid === pool[0].uuid));
});

test("debtPool: unsure-ответ по переоткрытому ключу возвращается в пул, принятый — нет", () => {
  const p = debtPool("all", new Set()).find((x) => x.group.split("+").some((k) => ["triggered-save", "passive-hit-trigger"].includes(k)));
  assert.ok(p);
  assert.ok(debtPool("all", new Map([[p.uuid, true]])).some((x) => x.uuid === p.uuid));
  assert.ok(!debtPool("all", new Map([[p.uuid, false]])).some((x) => x.uuid === p.uuid));
});

test("разбор: запись под каждым ключом, blocked при чужом ключе без примитива", () => {
  const acc = [{ uuid: "a", reason: N + "push 10 ft; ammo-bomb" }, { uuid: "b", reason: N + "push 5 ft" }];
  const r = debtByMechanism(acc, []);
  const push = r.rows.find((x) => x.key === "push");
  assert.equal(push.n, 2);
  assert.equal(push.blocked, 1);
  assert.equal(r.rows.find((x) => x.key === "ammo-bomb").n, 1);
});

test("owner: долг ammo-bomb/event-trigger считается в пачке-владельце, по первому ключу причины", async () => {
  const { buildReport, tally } = await import("../tools/coverage.mjs");
  const { ownerOf } = await import("../tools/mechanisms.mjs");
  assert.equal(ownerOf(["ammo-bomb"]), "b08-consumables");
  assert.equal(ownerOf(["push", "event-trigger"]), "b04-reactions");
  assert.equal(ownerOf(["event-trigger", "ammo-bomb"]), "b04-reactions");
  assert.equal(ownerOf(["ammo-bomb", "event-trigger"]), "b08-consumables");
  assert.equal(ownerOf(["push"]), null);
  const items = [{ uuid: "a", type: "feat" }, { uuid: "b", type: "feat" }];
  const tri = [{ uuid: "a", status: "manual", batchName: "b01-save-conditions", priority: 1 }, { uuid: "b", status: "manual", batchName: "b01-save-conditions", priority: 1 }];
  const d = buildReport({ meta: {}, items, tri, pa: null, owners: new Map([["a", "b08-consumables"]]) });
  assert.equal(d.byBatch["b08-consumables"].manual, 1);
  assert.equal(d.byBatch["b01-save-conditions"].manual, 1);
  assert.equal(d.priority1ByBatch["b08-consumables"].manual, 1);
  assert.ok(tally);
});
