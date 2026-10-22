// vision.mjs: чистая часть — политика реестра, сроки, расчёт ячеек дыма/состояний.
import { test } from "node:test";
import assert from "node:assert/strict";
const { planCell, planRelease, settleCells, withSource, removeSource, stepUntil, expireByEvent, turnForward, insideDiff, normalizeUntil, dropDead, smokeCells, blindedCells, dazzledCells, invisibleCells, preciseNonVisual, worst } =
  await import("../scripts/vision.mjs");

const mkVis = () => ({ cells: {}, meta: {} });
const level = (m) => (t, o) => m[`${t}>${o}`] ?? "observed";
const cellsOf = (...a) => a.map(([o, t, l]) => ({ observerId: o, targetId: t, level: l }));

test("worst: больший ранг", () => {
  assert.equal(worst("observed", "hidden", "concealed"), "hidden");
  assert.equal(worst("undetected", "hidden"), "undetected");
});

test("planCell: новая ячейка — base=current, пишем худшее", () => {
  const p = planCell({ base: null, last: null, src: { a: "concealed" } }, "observed");
  assert.deepEqual(p.entry, { base: "observed", last: "concealed", src: { a: "concealed" } });
  assert.equal(p.apply, "concealed");
});

test("planCell: нужный уровень уже стоит — не пишем; внешнее изменение сдвигает base", () => {
  assert.equal(planCell({ base: null, last: null, src: { a: "hidden" } }, "hidden").apply, null);
  const p = planCell({ base: "observed", last: "concealed", src: { a: "concealed" } }, "hidden");   // ГМ поставил hidden
  assert.equal(p.entry.base, "hidden");
  assert.equal(p.apply, null);
  assert.equal(p.entry.last, "hidden");
  const q = planCell({ base: "observed", last: "concealed", src: { a: "concealed" } }, "observed");   // Seek/очистка Vision
  assert.equal(q.entry.base, "observed");
  assert.equal(q.apply, "concealed");
});

test("planRelease: откат на base, только если ячейку не трогали", () => {
  assert.equal(planRelease({ base: "observed", last: "concealed", src: {} }, "concealed").apply, "observed");
  assert.equal(planRelease({ base: "observed", last: "concealed", src: {} }, "hidden").apply, null);
  assert.equal(planRelease({ base: "hidden", last: "hidden", src: {} }, "hidden").apply, null);
});

test("settleCells: два источника, снятие одного, потом второго", () => {
  const vis = mkVis(), state = {};
  const run = (keys) => {
    const r = settleCells(vis.cells, keys, level(state));
    vis.cells = r.cells;
    for (const c of r.changes) state[`${c.targetId}>${c.observerId}`] = c.level === "observed" ? undefined : c.level;
    return r.changes;
  };
  run(withSource(vis, "s1", cellsOf(["o", "t", "concealed"])));
  assert.equal(state["t>o"], "concealed");
  assert.deepEqual(run(withSource(vis, "s2", cellsOf(["o", "t", "hidden"]))), cellsOf(["o", "t", "hidden"]));
  assert.deepEqual(run(removeSource(vis, "s2")), cellsOf(["o", "t", "concealed"]));
  assert.deepEqual(run(removeSource(vis, "s1")), cellsOf(["o", "t", "observed"]));
  assert.deepEqual(vis.cells, {});
});

test("settleCells: снятие после внешнего изменения оставляет ячейку, запись удаляется", () => {
  const vis = mkVis();
  let r = settleCells(vis.cells, withSource(vis, "s", cellsOf(["o", "t", "concealed"])), level({}));
  vis.cells = r.cells;
  r = settleCells(vis.cells, removeSource(vis, "s"), level({ "t>o": "undetected" }));
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.cells, {});
});

test("withSource: замена вклада целиком, observed и сам-на-себя пропускаются", () => {
  const vis = mkVis();
  withSource(vis, "s", cellsOf(["o", "t", "concealed"], ["o", "o", "hidden"], ["o", "x", "observed"]), { label: "L", until: [] });
  assert.deepEqual(Object.keys(vis.cells), ["t>o"]);
  assert.deepEqual(vis.meta.s, { label: "L" });
  const touched = withSource(vis, "s", cellsOf(["p", "t", "concealed"]));
  assert.deepEqual(vis.cells["t>o"].src, {});
  assert.deepEqual(touched.sort(), ["t>o", "t>p"]);
});

test("stepUntil: turn-end, next-turn-end", () => {
  assert.equal(stepUntil(["turn-end"], "turn-end").expired, true);
  assert.deepEqual(stepUntil(["next-turn-end"], "turn-end"), { until: ["turn-end"], used: false, expired: false });
  assert.equal(stepUntil(["attack"], "turn-end").expired, false);   // атаки ещё не было
});

test("stepUntil attack: первая атака помечает, снятие на damage / следующей атаке / конце хода", () => {
  const a = stepUntil(["attack"], "attack");
  assert.deepEqual(a, { until: ["attack"], used: true, expired: false });
  assert.equal(stepUntil(["attack"], "damage").expired, false);   // урона без атаки не бывает, но и снимать нечего
  assert.equal(stepUntil(["attack"], "damage", true).expired, true);
  assert.equal(stepUntil(["attack"], "attack", true).expired, true);
  assert.equal(stepUntil(["attack"], "turn-end", true).expired, true);
});

test("normalizeUntil: next-turn-end вне хода субъекта — это его ближайший ход", () => {
  assert.deepEqual(normalizeUntil(["next-turn-end"], "S", "X"), ["turn-end"]);
  assert.deepEqual(normalizeUntil(["next-turn-end", "attack"], "S", "S"), ["next-turn-end", "attack"]);
});

test("turnForward: вперёд по ходу/раунду, откат — нет", () => {
  assert.equal(turnForward({ round: 1, turn: 0 }, { round: 1, turn: 1 }), true);
  assert.equal(turnForward({ round: 1, turn: 2 }, { round: 2, turn: 0 }), true);
  assert.equal(turnForward({ round: 1, turn: 2 }, { round: 1, turn: 1 }), false);
  assert.equal(turnForward({ round: 2, turn: 0 }, { round: 1, turn: 3 }), false);
});

test("insideDiff: вход и выход по смене множества", () => {
  assert.deepEqual(insideDiff(["a", "b"], ["b", "c"]), { entered: ["c"], exited: ["a"] });
  assert.deepEqual(insideDiff([], []), { entered: [], exited: [] });
});

test("dropDead: ячейки удалённых токенов уходят", () => {
  const vis = mkVis();
  withSource(vis, "s", cellsOf(["o", "t", "hidden"], ["o", "dead", "hidden"], ["dead", "t", "hidden"]));
  dropDead(vis, (id) => id !== "dead");
  assert.deepEqual(Object.keys(vis.cells), ["t>o"]);
});

test("expireByEvent: только источники субъекта; next-turn-end живёт до второго конца хода", () => {
  const vis = mkVis();
  withSource(vis, "a", cellsOf(["o", "t", "hidden"]), { subjectId: "S", until: ["next-turn-end"] });
  withSource(vis, "b", cellsOf(["o", "u", "hidden"]), { subjectId: "S", until: ["attack"] });
  withSource(vis, "c", cellsOf(["o", "v", "hidden"]), { subjectId: "Z", until: ["turn-end"] });
  assert.deepEqual(expireByEvent(vis, "S", "turn-end"), []);
  assert.deepEqual(expireByEvent(vis, "S", "turn-end"), ["t>o"]);
  assert.deepEqual(expireByEvent(vis, "S", "attack"), []);   // помечен, ждёт урона
  assert.equal(vis.meta.b.used, true);
  assert.deepEqual(expireByEvent(vis, "S", "damage"), ["u>o"]);
  assert.deepEqual(Object.keys(vis.meta), ["c"]);
});

const T = (id, ...senses) => ({ id, senses: senses.map(([type, acuity, range]) => ({ type, acuity, range })) });
const near = () => 10;
const ids = (cells) => cells.map((x) => `${x.observerId}>${x.targetId}`).sort();

test("preciseNonVisual: зрительные не считаются, дальность и неизвестное расстояние", () => {
  assert.equal(preciseNonVisual([{ type: "darkvision", acuity: "precise" }], 5), false);
  assert.equal(preciseNonVisual([{ type: "echolocation", acuity: "precise", range: 40 }], 30), true);
  assert.equal(preciseNonVisual([{ type: "echolocation", acuity: "precise", range: 40 }], 50), false);
  assert.equal(preciseNonVisual([{ type: "echolocation", acuity: "precise", range: 40 }], null), false);
  assert.equal(preciseNonVisual([{ type: "echolocation", acuity: "precise", range: Infinity }], null), true);
  assert.equal(preciseNonVisual([{ type: "scent", acuity: "imprecise", range: 30 }], 5), false);
});

test("smokeCells: внутри/снаружи и исключение чувством", () => {
  const a = T("a"), b = T("b"), c = T("c");
  assert.deepEqual(ids(smokeCells([a, b, c], new Set(["a"]), near)), ["a>b", "a>c", "b>a", "c>a"]);   // b и c друг друга видят
  const eco = T("b", ["echolocation", "precise", 40]);
  assert.deepEqual(ids(smokeCells([a, eco, c], new Set(["a"]), near)), ["a>b", "a>c", "c>a"]);
  assert.equal(smokeCells([a, b], new Set(), near).length, 0);
});

test("blinded: hidden для всех, кроме ощущаемых точным чувством в дальности", () => {
  const s = T("s", ["tremorsense", "imprecise", 30], ["echolocation", "precise", 20]);
  const out = blindedCells(s, [s, T("x"), T("y")], (a, b) => (b === "x" ? 10 : 30));
  assert.deepEqual(out, cellsOf(["s", "y", "hidden"]));
});

test("dazzled: concealed только если зрение — единственное точное чувство", () => {
  assert.deepEqual(dazzledCells(T("s", ["darkvision", "precise"]), [T("s"), T("x")]), cellsOf(["s", "x", "concealed"]));
  assert.deepEqual(dazzledCells(T("s", ["echolocation", "precise", 10]), [T("s"), T("x")]), []);
});

test("invisible: видел -> hidden (метка), не видел -> undetected разово, see-invisibility -> concealed, truesight — пропуск", () => {
  const s = T("s");
  const toks = [s, T("seer"), T("blind"), T("si", ["see-invisibility", "precise"]), T("ts", ["truesight", "precise"]), T("conc")];
  const out = invisibleCells(s, toks, level({ "s>blind": "hidden", "s>conc": "concealed" }));
  assert.deepEqual(out.marks, cellsOf(["seer", "s", "hidden"], ["si", "s", "concealed"], ["conc", "s", "hidden"]));
  assert.deepEqual(out.once, cellsOf(["blind", "s", "undetected"]));
});

const { integrationStatus, countSourceCells, dismissInPlace, rebuildEntries } = await import("../scripts/vision.mjs");

test("integrationStatus: off / missing / on с версией", () => {
  const ok = { active: true, version: "1.0.0", api: { store: { getLevel() {}, applyChanges() {} } } };
  assert.deepEqual(integrationStatus(ok, false), { key: "off" });
  assert.deepEqual(integrationStatus(ok, true), { key: "on", version: "1.0.0" });
  assert.deepEqual(integrationStatus({ ...ok, active: false }, true), { key: "missing" });
  assert.deepEqual(integrationStatus({ active: true, api: {} }, true), { key: "missing" });
  assert.deepEqual(integrationStatus(undefined, true), { key: "missing" });
});

test("countSourceCells считает ячейки с вкладом источника", () => {
  const vis = mkVis();
  withSource(vis, "zone:a", cellsOf(["o1", "t1", "concealed"], ["o2", "t1", "concealed"]));
  withSource(vis, "cond:b", cellsOf(["o1", "t1", "hidden"]));
  assert.equal(countSourceCells(vis, "zone:a"), 2);
  assert.equal(countSourceCells(vis, "cond:b"), 1);
  assert.equal(countSourceCells(vis, "zone:none"), 0);
  assert.equal(countSourceCells(undefined, "x"), 0);
});

test("dismissInPlace: метки сняты, источник помечен и rebuild его пропускает", () => {
  const vis = mkVis();
  const recipe = { kind: "blinded", itemUuid: "u" };
  withSource(vis, "cond:b", cellsOf(["o1", "t1", "hidden"]), { label: "Ослеплён", recipe });
  withSource(vis, "zone:a", cellsOf(["o1", "t2", "concealed"]), { label: "Дым", recipe: { kind: "zone" } });
  assert.deepEqual(dismissInPlace(vis, "cond:b"), ["t1>o1"]);
  assert.equal(countSourceCells(vis, "cond:b"), 0);
  assert.deepEqual(vis.meta["cond:b"], { label: "Ослеплён", recipe, dismissed: true });
  assert.deepEqual(rebuildEntries(vis.meta).map(([k]) => k), ["zone:a"]);
  assert.deepEqual(dismissInPlace(vis, "cond:none"), []);
});
