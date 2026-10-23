// Случайная выборка N правил пачки (ROADMAP §10) с фиксированным сидом -> файл для Критика: правило + свойства предмета + descEn + descRu.
// Запуск: node tools/sample.mjs <batch> [--source markup|model|pa-port|all] [--n 50] [--seed 1]
// Отдельная выборка по источнику нужна, чтобы считать долю ошибок Haiku (model) отдельно от разметки (markup) и переноса PA.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ACCEPTED, readJson, readOut, writeText, outPath, arg, cmp, isMain } from "./lib.mjs";

/** mulberry32: детерминированный ГСЧ по целому сиду. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** n элементов без повторов; порядок входа не влияет на выбор (сортируем по uuid), результат стабилен по сиду. */
export function pick(list, n, seed) {
  const a = [...list].sort((x, y) => cmp(x.uuid, y.uuid)), r = rng(seed);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, Math.min(n, a.length));
}

/** Источник правила черновика: markup (deriveFromMarkup), model (ответ Haiku/Sonnet, в т.ч. model-null), pa-port (перенос PA). */
export const sourceOf = (d) => (d.confidence === "model" || d.reason?.startsWith("model-null") ? "model" : d.status === "pa-port" ? "pa-port" : d.status?.startsWith("markup") ? "markup" : null);

/** В пул выборки идут правила и model-null (проверка «модель зря сказала: нечего автоматизировать»). */
export const poolOf = (items, source = "all") => items.filter((d) => (d.rule || d.reason?.startsWith("model-null")) && sourceOf(d) && (source === "all" || sourceOf(d) === source));

const props = (it) => [it.defense && `save ${it.defense.save}${it.defense.basic ? " (basic)" : ""}`, it.range && `range ${it.range}`, it.duration && `duration ${it.duration}`, it.area && `area ${it.area}`, it.target && `target ${it.target}`, it.cost && `cost ${it.cost}`, it.frequency && `freq ${it.frequency}`].filter(Boolean).join(" | ") || "—";

export function sampleMd(batch, source, seed, picked, itemBy) {
  const head = `# Sample ${batch} [${source}]: ${picked.length} rules, seed ${seed}\nFor each: does the rule match the item text (who, which degree, what, DC, duration, range)? Verdict: ok / wrong (why). For model-null: was there really nothing to automate?\n`;
  return head + picked.map((d, i) => {
    const it = itemBy.get(d.uuid) ?? {};
    return `\n## ${i + 1}. ${d.name}${d.nameRu ? ` / ${d.nameRu}` : ""}  [${sourceOf(d)}: ${d.status}, ${d.confidence}]\n${d.uuid}\nPROPS: ${props(it)}\n\nRULE:\n\`\`\`json\n${d.rule ? JSON.stringify(d.rule) : "null  // " + d.reason}\n\`\`\`\nEN: ${it.descEn ?? ""}\n\nRU: ${it.descRu ?? "(no translation)"}\n`;
  }).join("");
}

function main() {
  const batch = process.argv[2];
  if (!batch || batch.startsWith("--")) throw new Error("usage: node tools/sample.mjs <batch> [--source markup|model|pa-port|all] [--n 50] [--seed 1]");
  const n = +arg("n", 50), seed = +arg("seed", 1), source = arg("source", batch === "pa-port" ? "pa-port" : "all");
  // pa-port: только правила, попавшие в rules/catalog.pa.json (tools/pa-port.mjs пишет их в out/pa-catalog.json)
  const drafts = batch === "pa-port" ? readOut("pa-catalog.json") : readJson(join(ROOT, "rules/drafts", `${batch}.json`));
  const itemBy = new Map(readOut("items.json").items.map((i) => [i.uuid, i]));
  const pool = poolOf(drafts.items, source);
  const picked = pick(pool, n, seed);
  // правила с проверкой/испытанием редки — берём все сверх случайных n
  if (batch === "pa-port") for (const d of pool) if ((d.rule.onUse?.check || d.rule.onUse?.challenge) && !picked.includes(d)) picked.push(d);
  writeText(outPath("sample", `${batch}-${source}-seed${seed}.md`), sampleMd(batch, source, seed, picked, itemBy));
  // сид хранится отдельно от черновиков (drafts.mjs их перегенерирует): rules/drafts-accepted/_samples.json
  const sp = join(ACCEPTED, "_samples.json");
  const all = existsSync(sp) ? readJson(sp) : {};
  all[`${batch}:${source}`] = { seed, n: picked.length, pool: pool.length };
  writeText(sp, JSON.stringify(all, null, 1) + "\n");
  console.log(`sample ${batch} [${source}]: ${picked.length} из ${pool.length}, seed ${seed}`);
}

if (isMain(import.meta.url)) main();
