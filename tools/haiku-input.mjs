// manual-предметы пачки -> tools/out/haiku/<batch>-NN.md, по 40 предметов, только поля для правила.
// Запуск: node tools/haiku-input.mjs [batch|all] [--p 1] [--size 40]
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTED, readJson, readOut, writeText, outPath, arg, cut, cmp, isMain } from "./lib.mjs";

const DESC_MAX = 900;
const COND = /@UUID\[Compendium\.pf2e\.conditionitems\.Item\.(\w+)\]/g;

/** @UUID на состояние -> @Cond[slug] (короче; в правиле нужен только slug). Ссылки на эффекты остаются с полным UUID. */
export const compress = (text, condById) => text.replace(COND, (m, id) => (condById[id] ? `@Cond[${condById[id]}]` : m));

export function itemBlock(n, it, condById) {
  const f = (k, v) => (v ? `${k} ${v}` : null);
  const head = [it.type, it.name + (it.nameRu ? ` (${it.nameRu})` : ""), it.slug, it.rank != null ? `rank ${it.rank}` : f("lvl", it.level), f("cost", it.cost)].filter(Boolean).join(" · ");
  const facts = [f("range", it.range), f("area", it.area), it.defense && `save ${it.defense.save}${it.defense.basic ? " (basic)" : ""}`, f("dur", it.duration), f("target", it.target), f("freq", it.frequency), it.selfEffect && "selfEffect"].filter(Boolean).join(" | ");
  const traits = it.traits.length ? `traits: ${it.traits.slice(0, 8).join(", ")}` : "";
  const desc = compress(cut(it.descEn || it.descRu || "", DESC_MAX), condById);
  return `### ${n} ${it.uuid}\n${head}\n${[facts, traits].filter(Boolean).join(" | ")}\n${desc}\n`;
}

/**
 * items[] (все manual пачки в порядке приоритет/уровень/uuid) -> [{name, text}]. Куски нарезаются по ПОЗИЦИИ в полном списке,
 * уже отвеченные (answered: Set uuid) выбрасываются внутри куска — номера файлов не плывут.
 */
export function chunk(batch, items, condById, size = 40, answered = new Set()) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const part = items.slice(i, i + size).filter((it) => !answered.has(it.uuid));
    if (!part.length) continue;
    const no = String(i / size + 1).padStart(2, "0");
    const body = part.map((it, j) => itemBlock(j + 1, it, condById)).join("\n");
    out.push({ name: `${batch}-${no}.md`, text: `# ${batch} / ${no}: ${part.length} items\nAnswer per tools/prompts/draft-rule.md. Use the uuid after the number as "uuid".\n\n${body}` });
  }
  return out;
}

function main() {
  const which = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "all";
  const p = arg("p") ? +arg("p") : null, size = +arg("size", 40);
  const { items } = readOut("items.json"), tri = readOut("triage.json").items, refs = readOut("refs.json");
  const condById = Object.fromEntries(Object.entries(refs.conditions).map(([s, c]) => [c.id, s]));
  const triBy = new Map(tri.map((t) => [t.uuid, t]));
  const by = {};
  for (const it of items) {
    const t = triBy.get(it.uuid);
    if (t.status !== "manual" || (which !== "all" && t.batchName !== which)) continue;
    (by[t.batchName] ??= []).push({ it, pr: t.priority });
  }
  rmSync(outPath("haiku"), { recursive: true, force: true });
  let files = 0;
  for (const [batch, list] of Object.entries(by)) {
    list.sort((a, b) => a.pr - b.pr || (a.it.level ?? 0) - (b.it.level ?? 0) || cmp(a.it.uuid, b.it.uuid));
    const ap = join(ACCEPTED, `${batch}.json`);
    const answered = new Set(existsSync(ap) ? readJson(ap).items.map((d) => d.uuid) : []);
    if (p) for (const x of list) if (x.pr !== p) answered.add(x.it.uuid);   // фильтр приоритета не должен менять нумерацию кусков
    for (const f of chunk(batch, list.map((x) => x.it), condById, size, answered)) { writeText(outPath("haiku", f.name), f.text); files++; }
  }
  console.log(`haiku-input: ${files} файлов`, Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])));
}

if (isMain(import.meta.url)) main();
