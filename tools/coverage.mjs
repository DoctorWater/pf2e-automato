// Отчёт покрытия: проценты по типам, слоям, пачкам, приоритету + строка по PA. -> tools/out/coverage.json и раздел в coverage.md.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readJson, readOut, writeJson, outPath, isMain } from "./lib.mjs";
import { readModelAccepted } from "./drafts.mjs";

export const STATUSES = ["pf2e", "catalog", "pa", "model", "partial", "markup-high", "markup-head", "markup-low", "pa-port", "manual", "skip"];
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
/** «Готово» = закрыто pf2e, в каталоге, перенесено из PA (pa) или принятый ответ модели. Вывод из разметки (markup-*) — черновик: в рантайме сам не исполняется (решение 2026-10-24, выборки ~50% ошибок). */
const ready = (o) => o.pf2e + o.catalog + o.pa + o.model;

/** Триаж не знает о принятых ответах моделей: правило -> model, «нечего автоматизировать» -> skip model-null. */
export function withAccepted(tri, accepted) {
  const by = new Map(accepted.map((d) => [d.uuid, d]));
  return tri.map((t) => {
    const d = ["manual", "markup-head", "markup-high", "markup-low"].includes(t.status) ? by.get(t.uuid) : null;
    if (!d) return t;
    // проверка модели отвергла черновик разметки (нужен примитив, одни заметки): это долг, а не черновик
    // partial — правило закрывает часть активаций предмета (остальные ручные): в каталоге, но «готовым» не считается
    return d.rule && d.confidence === "model" ? { ...t, status: d.partial ? "partial" : "model" } : d.reason?.startsWith("model-null") ? { ...t, status: "skip", reason: "model-null" } : t.status.startsWith("markup") ? { ...t, status: "manual" } : t;
  });
}

/** pa-port из триажа — очередь переноса; закрытые переносом (правило в catalog.pa.json), ручным каталогом/обработчиком или самим pf2e -> pa. Долг, ложное покрытие, «PA ошибается», не переносимое — остаются pa-port. */
export function withPa(tri, paDrafts) {
  const DONE = new Set(["ported", "covered", "native"]);
  const done = new Set(paDrafts.filter((d) => DONE.has(d.finalStatus)).map((d) => d.uuid));
  return tri.map((t) => (t.status === "pa-port" && done.has(t.uuid) ? { ...t, status: "pa" } : t));
}

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
  const pa = d.pa;
  const o = d.overall;
  return `${START}
## Конвейер: сводка по снимку pf2e ${d.pf2eVersion} (${d.generatedAt.slice(0, 10)})

Генерируется \`node tools/coverage.mjs\` (шаг \`node tools/run.mjs\`); методика ниже (§0) осталась как была, этот раздел считает по **документам** после \`tools/triage.mjs\`. Статусы: \`pf2e\` — закрыто системой (selfEffect, Aura RE); \`catalog\` — уже в каталоге модуля; \`model\` — принятый ответ Haiku/Sonnet (\`rules/catalog.model.json\`); \`partial\` — принятое правило закрывает только часть активаций предмета (кастовые), остальные ручные: в каталоге, но в «готово» не входит; \`markup-high/low\` — черновик \`deriveFromMarkup\` (в рантайме — только кнопкой ведущего; ждёт проверки моделью: \`haiku-input.mjs --review\`); \`pa-port\` — закрывалось pf2e-automations, очередь переноса; \`manual\` — нужен черновик; \`skip\` — пассивное, без следа, только урон или дубль компендия в актёре. \`pa\` — закрыто переносом pf2e-automations (\`rules/catalog.pa.json\`, ручной каталог/обработчик или сам pf2e; долг и ложное покрытие PA остаются \`pa-port\`). «Готово %» = (pf2e + catalog + pa + model) / требует.

Всего документов ${d.total}; требуют автоматизации ${o.need}; готово ${ready(o)} (${pct(ready(o), o.need)}); частично ${o.partial} (правило закрывает часть активаций, в «готово» не входит); skip ${o.skip} (${Object.entries(d.skipReasons).map(([k, v]) => `${k} ${v}`).join(", ")}).

### PA (pf2e-automations ${pa?.paVersion ?? "?"})

${pa?.docs?.applicable ? `Документов pf2e под PA: ${pa.docs.total}; применимо ${pa.docs.applicable} (без ложного покрытия ${pa.docs.falseCoverage} — симулятор PA не находит срабатывания, — без «PA ошибается» ${pa.docs.paWrong ?? 0} и не переносимого по решению ${pa.docs.notPorted}). Готово ${pa.docs.done} (${pa.docs.percent}%): перенесено ${pa.docs.ported}, покрыто ручным каталогом или встроенным обработчиком ${pa.docs.covered}, делает pf2e ${pa.docs.native}. Долг ${pa.docs.debt}. Цель — 100%, тогда PA можно выключить.

${pa?.paWrongList?.length ? `PA ошибается (срабатывает по симулятору, но ставит то, что противоречит тексту; вне знаменателя — при выключении PA верное не теряется, правильную автоматизацию такие документы получат в основных пачках 1–10), ${pa.paWrongList.length}:\n\n${pa.paWrongList.map((w) => `- ${w.name} (\`${w.slug}\`)`).join("\n")}\n\n` : ""}${pa?.partialList?.length ? `Партиальные (засчитаны перенесёнными: правило не слабее PA, но по тексту неполно; пробелы — для основных пачек 1–10), документов ${pa.docs.partial}, правил ${pa.partialList.length}:\n\n${pa.partialList.map((w) => `- ${w.name} (\`${w.slug}\`, документов ${w.docs}): ${w.gaps.join("; ")}`).join("\n")}\n\n` : ""}Долг по подпачкам (ROADMAP §5.1): ${Object.entries(pa.debt.bySubpack).map(([k, v]) => `${k} ${v}`).join(", ")}.

Причины долга (документов):

${Object.entries(pa.debt.byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- \`${k}\`: ${v}`).join("\n")}
` : "PA: нет данных (запустите tools/pa-port.mjs)."}
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
  const pd = join(ROOT, "rules/drafts/pa-port.json");
  const tri = withPa(withAccepted(readOut("triage.json").items, readModelAccepted()), existsSync(pd) ? readJson(pd).items : []);
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
