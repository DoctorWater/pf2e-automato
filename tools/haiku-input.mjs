// manual-предметы пачки -> tools/out/haiku/<batch>-NN.md, по 40 предметов, только поля для правила.
// Запуск: node tools/haiku-input.mjs [batch|all] [--p 1] [--size 40] [--review]
// --review: правила, выведенные из разметки (markup-high/low, без NPC) -> tools/out/review/: черновик + полный текст на проверку моделью (tools/prompts/review-rule.md)
import { rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ACCEPTED, readJson, readOut, writeText, writeJson, outPath, arg, cut, stripHtml, cmp, isMain } from "./lib.mjs";
import { activatePool } from "./activate-pool.mjs";

const ACT_MAX = 8000, ACT_RU_MAX = 1200;   // активации: текст нужен весь (механика в дальних абзацах), RU — для сверки
const DESC_MAX = 900, REVIEW_MAX = 2500;   // при проверке черновика нужен весь текст: ошибки вывода — в дальних абзацах
const COND = /@UUID\[Compendium\.pf2e\.conditionitems\.Item\.(\w+)\]/g;

/** @UUID на состояние -> @Cond[slug] (короче; в правиле нужен только slug). Ссылки на эффекты остаются с полным UUID. */
export const compress = (text, condById) => text.replace(COND, (m, id) => (condById[id] ? `@Cond[${condById[id]}]` : m));

export function itemBlock(n, it, condById, draft = null, max = draft ? REVIEW_MAX : DESC_MAX) {
  const f = (k, v) => (v ? `${k} ${v}` : null);
  const head = [it.type, it.name + (it.nameRu ? ` (${it.nameRu})` : ""), it.slug, it.rank != null ? `rank ${it.rank}` : f("lvl", it.level), f("cost", it.cost)].filter(Boolean).join(" · ");
  const facts = [f("range", it.range), f("area", it.area), it.defense && `save ${it.defense.save}${it.defense.basic ? " (basic)" : ""}`, f("dur", it.duration), f("target", it.target), f("freq", it.frequency), it.selfEffect && "selfEffect"].filter(Boolean).join(" | ");
  const traits = it.traits.length ? `traits: ${it.traits.slice(0, 8).join(", ")}` : "";
  const desc = compress(cut(it.descEn || it.descRu || "", max), condById);
  return `### ${n} ${it.uuid}\n${head}\n${[facts, traits].filter(Boolean).join(" | ")}\n${desc}\n${draft ? `DRAFT: ${JSON.stringify(draft)}\n` : ""}`;
}

/**
 * items[] (все manual пачки в порядке приоритет/уровень/uuid) -> [{name, text}]. Куски нарезаются по ПОЗИЦИИ в полном списке,
 * уже отвеченные (answered: Set uuid) выбрасываются внутри куска — номера файлов не плывут.
 */
export function chunk(batch, items, condById, size = 40, answered = new Set(), draftOf = null) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const part = items.slice(i, i + size).filter((it) => !answered.has(it.uuid));
    if (!part.length) continue;
    const no = String(i / size + 1).padStart(2, "0");
    const body = part.map((it, j) => itemBlock(j + 1, it, condById, draftOf?.(it.uuid))).join("\n");
    const prompt = draftOf ? "tools/prompts/review-rule.md" : "tools/prompts/draft-rule.md";
    out.push({ name: `${draftOf ? "review-" : ""}${batch}-${no}.md`, text: `# ${batch} / ${no}: ${part.length} items\nAnswer per ${prompt}. Use the uuid after the number as "uuid".\n\n${body}` });
  }
  return out;
}

/** Пачка `activate`: пул активаций (tools/activate-pool.mjs) -> tools/out/haiku/activate-NN.md, по `size`; в каждом предмете REASON, CURRENT (частичное правило) и RU-текст; шапка — памятка. */
export function activateChunks(pool, condById, size = 40, memo = "", html = {}) {
  const out = [];
  for (let i = 0; i < pool.length; i += size) {
    const part = pool.slice(i, i + size), no = String(i / size + 1).padStart(2, "0");
    const body = part.map((p, j) => {
      const b = itemBlock(j + 1, { ...p.it, descEn: stripHtml(html[p.it.uuid]) || p.it.descEn, descRu: "" }, condById, null, ACT_MAX);
      const ru = p.it.descRu ? `RU: ${cut(p.it.descRu, ACT_RU_MAX)}\n` : "";
      return `${b}${ru}REASON: ${p.why}\n${p.current ? `CURRENT: ${JSON.stringify(p.current)}\n` : ""}`;
    }).join("\n");
    out.push({ name: `activate-${no}.md`, text: `# activate / ${no}: ${part.length} items\nAnswer per tools/prompts/draft-rule.md. Use the uuid after the number as "uuid".\n\n${memo}\n${body}` });
  }
  return out;
}

function activateMain(size) {
  const pool = activatePool(), refs = readOut("refs.json");
  const condById = Object.fromEntries(Object.entries(refs.conditions).map(([s, c]) => [c.id, s]));
  const memo = readFileSync(join(ROOT, "tools/prompts/activate-memo.md"), "utf8");
  for (const f of existsSync(outPath("haiku")) ? readdirSync(outPath("haiku")).filter((n) => n.startsWith("activate-")) : []) rmSync(outPath("haiku", f));
  const files = activateChunks(pool, condById, size, memo, readOut("html.json"));
  for (const f of files) writeText(outPath("haiku", f.name), f.text);
  writeJson(outPath("activate-pool.json"), pool.map((p) => ({ uuid: p.it.uuid, batch: p.batch, kind: p.kind, why: p.why })), 1);
  const by = {};
  for (const p of pool) { const k = p.kind === "mode" ? "mode choice" : p.why.replace(/activation \d+: /, "").replace(/(\d+|\{[^}]*\}|undefined|null)/g, "#").slice(0, 40); by[k] = (by[k] ?? 0) + 1; }
  console.log(`haiku-input activate: ${pool.length} предметов, ${files.length} файлов`, by);
}

function main() {
  if (process.argv[2] === "activate") return activateMain(+arg("size", 40));
  const which = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "all";
  const p = arg("p") ? +arg("p") : null, size = +arg("size", 40), review = process.argv.includes("--review");
  const dir = review ? "review" : "haiku", want = new Set(review ? ["markup-high", "markup-low"] : ["manual"]);
  const { items } = readOut("items.json"), tri = readOut("triage.json").items, refs = readOut("refs.json");
  const condById = Object.fromEntries(Object.entries(refs.conditions).map(([s, c]) => [c.id, s]));
  const triBy = new Map(tri.map((t) => [t.uuid, t]));
  const by = {};
  for (const it of items) {
    const t = triBy.get(it.uuid);
    if (!want.has(t.status) || (review && it.embedded) || (which !== "all" && t.batchName !== which)) continue;
    (by[t.batchName] ??= []).push({ it, pr: t.priority });
  }
  rmSync(outPath(dir), { recursive: true, force: true });
  const draftOf = review ? (u) => triBy.get(u).rule : null;
  let files = 0;
  for (const [batch, list] of Object.entries(by)) {
    list.sort((a, b) => a.pr - b.pr || (a.it.level ?? 0) - (b.it.level ?? 0) || cmp(a.it.uuid, b.it.uuid));
    const ap = join(ACCEPTED, `${batch}.json`);
    const answered = new Set(existsSync(ap) ? readJson(ap).items.filter((d) => !d.partial?.length || d.reason?.startsWith("model: affliction converter")).map((d) => d.uuid) : []);   // partial (правило закрывает не всё) остаётся в очереди: ручные активации ждут модели; partial-недуги конвертера — нет (ответ модели заменил бы правило)
    if (p) for (const x of list) if (x.pr !== p) answered.add(x.it.uuid);   // фильтр приоритета не должен менять нумерацию кусков
    for (const f of chunk(batch, list.map((x) => x.it), condById, size, answered, draftOf)) { writeText(outPath(dir, f.name), f.text); files++; }
  }
  console.log(`haiku-input: ${files} файлов`, Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])));
}

if (isMain(import.meta.url)) main();
