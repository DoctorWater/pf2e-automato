// Отчёт покрытия: проценты по типам, слоям, пачкам, приоритету + строка по PA. -> tools/out/coverage.json и раздел в coverage.md.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readOut, writeJson, outPath, isMain } from "./lib.mjs";

export const STATUSES = ["pf2e", "catalog", "markup-high", "markup-low", "pa-port", "manual", "skip"];
const NEED = STATUSES.filter((s) => s !== "skip");
const START = "<!-- pipeline:start -->", END = "<!-- pipeline:end -->";

/** Подсчёт: rows = [{key, status}] -> { key: {status: n, need, total} }. */
export function tally(rows) {
  const out = {};
  for (const { key, status } of rows) {
    const o = (out[key] ??= Object.fromEntries(STATUSES.map((s) => [s, 0])));
    o[status]++;
  }
  for (const o of Object.values(out)) { o.need = NEED.reduce((n, s) => n + o[s], 0); o.total = o.need + o.skip; }
  return out;
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
/** «Готово» = закрыто pf2e, в каталоге или выведено с высокой уверенностью. */
const ready = (o) => o.pf2e + o.catalog + o["markup-high"];

function table(title, t, sortKeys) {
  const keys = sortKeys ?? Object.keys(t).sort();
  const head = `| ${title} | всего | требует | ${STATUSES.slice(0, -1).join(" | ")} | skip | готово % |\n|${"---|".repeat(STATUSES.length + 4)}\n`;
  return head + keys.map((k) => { const o = t[k]; return `| ${k} | ${o.total} | ${o.need} | ${STATUSES.slice(0, -1).map((s) => o[s]).join(" | ")} | ${o.skip} | ${pct(ready(o), o.need)} |`; }).join("\n") + "\n";
}

export function buildReport({ meta, items, tri, pa }) {
  const triBy = new Map(tri.map((t) => [t.uuid, t]));
  const rows = items.map((it) => { const t = triBy.get(it.uuid); return { it, t, status: t.status }; });
  const by = (f) => tally(rows.map((r) => ({ key: f(r), status: r.status })));
  const skipReasons = {};
  for (const r of rows) if (r.status === "skip") { const k = r.t.reason.replace(/:.*/, ""); skipReasons[k] = (skipReasons[k] ?? 0) + 1; }
  const p1 = rows.filter((r) => r.t.priority === 1);
  const data = {
    pf2eVersion: meta.pf2eVersion, generatedAt: new Date().toISOString(), total: rows.length,
    overall: tally(rows.map((r) => ({ key: "all", status: r.status }))).all,
    byType: by((r) => `${r.it.embedded ? "npc:" : ""}${r.it.type}`),
    byLayer: by((r) => `слой ${r.t.layer ?? "—"}`),
    byBatch: by((r) => r.t.batchName ?? "(нет пачки)"),
    byPriority: by((r) => `P${r.t.priority}`),
    priority1ByBatch: tally(p1.map((r) => ({ key: r.t.batchName ?? "(нет пачки)", status: r.status }))),
    skipReasons, pa
  };
  return data;
}

export function renderMd(d) {
  const pa = d.pa, g = pa?.groups;
  const o = d.overall;
  return `${START}
## Конвейер: сводка по снимку pf2e ${d.pf2eVersion} (${d.generatedAt.slice(0, 10)})

Генерируется \`node tools/coverage.mjs\` (шаг \`node tools/run.mjs\`); методика ниже (§0) осталась как была, этот раздел считает по **документам** после \`tools/triage.mjs\`. Статусы: \`pf2e\` — закрыто системой (selfEffect, Aura RE); \`catalog\` — уже в каталоге модуля; \`markup-high/low\` — правило выведено \`deriveFromMarkup\`; \`pa-port\` — закрывалось pf2e-automations, очередь переноса; \`manual\` — нужен черновик; \`skip\` — пассивное, без следа, только урон или дубль компендия в актёре. «Готово %» = (pf2e + catalog + markup-high) / требует.

Всего документов ${d.total}; требуют автоматизации ${o.need}; готово ${ready(o)} (${pct(ready(o), o.need)}); skip ${o.skip} (${Object.entries(d.skipReasons).map(([k, v]) => `${k} ${v}`).join(", ")}).

### PA (pf2e-automations ${pa?.paVersion ?? "?"})

${g ? `| групп PA всего | перенесено (в каталоге) | переводится скриптом | требует примитива | требует ручного |\n|---|---|---|---|---|\n| ${g.total} | ${g.ported} (${pct(g.ported, g.total)}) | ${g.script} (${pct(g.script, g.total)}) | ${g.primitive} (${pct(g.primitive, g.total)}) | ${g.manual} (${pct(g.manual, g.total)}) |\n\nДокументов pf2e под PA: ${pa.docs.total} (в каталоге ${pa.docs.catalog}, переведено ${pa.docs.translated}, не переведено ${pa.docs.failed}). Цель — 100% групп в \`перенесено\`, тогда PA можно выключить. «Долгов переноса» (перенесено слабее PA): ${pa.debts.length}.\n\nПричины непереведённого (документов) — кандидаты в примитивы схемы:\n\n${Object.entries(pa.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- \`${k}\`: ${v}`).join("\n")}\n` : "PA: нет данных (запустите tools/pa-port.mjs)."}
### По типам

${table("тип", d.byType)}
### По слоям (ROADMAP §2)

${table("слой", d.byLayer)}
### По пачкам (ROADMAP §5)

${table("пачка", d.byBatch)}
### По приоритету (ROADMAP §4: P1 частое, P2 остальное, P3 NPC, P4 кампании)

${table("приоритет", d.byPriority)}
### Приоритет 1 по пачкам

${table("пачка", d.priority1ByBatch)}${END}
`;
}

/** Подставить блок сводки между маркерами (или перед §0, если маркеров ещё нет). Без регэкспов: блок содержит $ и скобки. */
export function replaceBlock(md, block) {
  const a = md.indexOf(START), b = md.indexOf(END);
  if (a >= 0 && b > a) return md.slice(0, a) + block.trimEnd() + md.slice(b + END.length).replace(/^\n?/, "\n");
  const k = md.indexOf("## 0. Методика и оговорки");
  return k < 0 ? md + "\n" + block : md.slice(0, k) + block + "\n" + md.slice(k);
}

function main() {
  const { meta, items } = readOut("items.json");
  const tri = readOut("triage.json").items;
  const pa = existsSync(outPath("pa-port.json")) ? readOut("pa-port.json") : null;
  const d = buildReport({ meta, items, tri, pa });
  writeJson(outPath("coverage.json"), d, 1);
  const p = join(ROOT, "coverage.md");
  let md = readFileSync(p, "utf8");
  const block = renderMd(d);
  writeFileSync(p, replaceBlock(md, block));
  console.log("coverage: готово", d.overall);
}

if (isMain(import.meta.url)) main();
