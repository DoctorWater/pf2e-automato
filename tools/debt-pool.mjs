// Пул модельного прохода по долгу: записи со статусом «к проходу» по словарю механизмов (rules/mechanisms.json).
// Запуск: node tools/debt-pool.mjs [batch=all] [size=40] [prefix=mdebt] -> tools/out/mdebt-pool.json + tools/out/haiku/mdebt-NN.md (старый пул debt-* не перезаписывается: по нему идут ответы) (шапка — draft-rule.md).
import { readOut, readJson, writeText, writeJson, outPath, ACCEPTED, arg, isMain } from "./lib.mjs";
import { join } from "node:path";
import { itemBlock } from "./haiku-input.mjs";
import { stripHtml, cut } from "./lib.mjs";
import { readdirSync } from "node:fs";
import { debtByMechanism, isDebt, plainReason, poolable } from "./mechanisms.mjs";

export const TAGS = { repeat: /repeat(ed)?\b|ongoing save|save each turn/, mods: /penalty|bonus|clumsy|slowed|floor/ };

/** Ключи, которым промпт научили после первых проходов: отвеченные на них «unsure» из старых ответов возвращаются в пул (ответы файлов *debt2* — повторный проход, окончательные). */
export const REOPENED = new Set(["triggered-save", "passive-hit-trigger"]);

/** Номер прохода по имени файла ответов: `*debt2*` -> 2, `*debt-01*` (первый проход, без цифры) -> 1; со второго прохода ответ окончательный. */
export const passOf = (file) => +(file.match(/debt(\d+)/)?.[1] ?? 1);

/** uuid -> «можно переспросить» (true: все ответы на него — unsure и ни один не из повторного прохода, passOf ≥ 2) по tools/out/answers/*debt*; ответ ещё не принят в drafts-accepted. */
export function answeredMap() {
  const out = new Map();
  for (const f of readdirSync(outPath("answers")).filter((f) => /debt/.test(f)))
    for (const a of readJson(outPath("answers", f))) if (a?.uuid) out.set(a.uuid, (out.get(a.uuid) ?? true) && !!a.unsure && passOf(f) < 2);
  return out;
}

/** Записи, у которых примитив есть у всех ключей (poolable) по словарю rules/mechanisms.json; без уже отвеченных. batch "all" = все пачки; в записи — batch для приёма ответа (validate.mjs mdebt). */
export function debtPool(batch = "all", answered = answeredMap()) {
  // Set (тест) — просто отвеченные; Map — отвеченные, кроме «unsure» по REOPENED-ключам
  const done = (uuid, keys) => answered instanceof Map ? answered.has(uuid) && !(answered.get(uuid) && keys.some((k) => REOPENED.has(k))) : answered.has(uuid);
  const files = readdirSync(ACCEPTED).filter((f) => /^b\d+-.*\.json$/.test(f) && (batch === "all" || f === batch + ".json"));
  const accepted = files.flatMap((f) => readJson(join(ACCEPTED, f)).items.map((d) => ({ d, batch: f.replace(/\.json$/, "") })));
  const items = new Map(readOut("items.json").items.map((i) => [i.uuid, i]));
  const { byUuid } = debtByMechanism(accepted.map((x) => x.d), [...items.values()]);
  return accepted.filter(({ d }) => isDebt(d) && poolable(byUuid.get(d.uuid)) && items.has(d.uuid) && !done(d.uuid, byUuid.get(d.uuid).keys))
    .map(({ d, batch }) => ({ it: items.get(d.uuid), uuid: d.uuid, batch, group: byUuid.get(d.uuid).keys.join("+"), tags: Object.keys(TAGS).filter((t) => TAGS[t].test(d.reason)), why: plainReason(d.reason), current: d.rule ?? null }))
    .sort((a, b) => a.group.localeCompare(b.group) || (a.it.level ?? 0) - (b.it.level ?? 0) || a.uuid.localeCompare(b.uuid));
}

function main() {
  const batch = arg("batch", "all"), size = +arg("size", 40), prefix = arg("prefix", "mdebt"), pool = debtPool(batch);
  const refs = readOut("refs.json"), html = readOut("html.json");
  const condById = Object.fromEntries(Object.entries(refs.conditions).map(([s, c]) => [c.id, s]));
  const files = [];
  for (let i = 0; i < pool.length; i += size) {
    const part = pool.slice(i, i + size), no = String(i / size + 1).padStart(2, "0");
    const body = part.map((p, j) => {
      const b = itemBlock(j + 1, { ...p.it, descEn: stripHtml(html[p.uuid]) || p.it.descEn, descRu: "" }, condById, null, 8000);
      return `${b}${p.it.descRu ? `RU: ${cut(p.it.descRu, 1200)}\n` : ""}REASON: ${p.why}\n${p.current ? `CURRENT: ${JSON.stringify(p.current)}\n` : ""}`;
    }).join("\n");
    files.push({ name: `${prefix}-${no}.md`, text: `# debt ${batch} / ${no}: ${part.length} items\nAnswer per tools/prompts/draft-rule.md. Use the uuid after the number as "uuid". Each item has REASON (the old debt) and sometimes CURRENT (partial rule).\n\n${body}` });
  }
  for (const f of files) writeText(outPath("haiku", f.name), f.text);
  writeJson(outPath(`${prefix}-pool.json`), pool.map(({ it, ...p }) => p), 1);
  const by = {}; for (const p of pool) by[p.group] = (by[p.group] ?? 0) + 1;
  console.log(`debt-pool ${batch}: ${pool.length} предметов, ${files.length} файлов`, by, "tags", { repeat: pool.filter((p) => p.tags.includes("repeat")).length, mods: pool.filter((p) => p.tags.includes("mods")).length });
}
if (isMain(import.meta.url)) main();
