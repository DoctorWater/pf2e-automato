// Перекрытия: ручное правило catalog.json.bySlug[slug] vs сгенерированные bySource (model, pa) для документов с тем же slug.
// Каталоги не правит. Запуск: node tools/check-catalogs.mjs [--all]   (по умолчанию печатает первые 20 конфликтов)
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const load = (p) => JSON.parse(readFileSync(root + p, "utf8"));

/** Ключ bySlug: "slug" или "slug@type". */
export const splitKey = (k) => { const i = k.indexOf("@"); return i < 0 ? { slug: k, type: null } : { slug: k.slice(0, i), type: k.slice(i + 1) }; };

/** slugs: ключи ручного bySlug; items: [{uuid,slug,type}]; generated: { файл: bySource-объект } -> [{ key, uuid, file }]. */
export function findConflicts(slugs, items, generated) {
  const want = new Map();
  for (const k of slugs) { const { slug, type } = splitKey(k); (want.get(slug) ?? want.set(slug, []).get(slug)).push({ k, type }); }
  const out = [];
  for (const it of items) {
    for (const w of want.get(it.slug) ?? []) {
      if (w.type && w.type !== it.type) continue;
      for (const [file, bySource] of Object.entries(generated)) if (Object.hasOwn(bySource, it.uuid)) out.push({ key: w.k, uuid: it.uuid, file });
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manual = Object.keys(load("rules/catalog.json").bySlug ?? {});
  const generated = {};
  for (const f of ["catalog.model.json", "catalog.pa.json", "catalog.rusthenge.json"]) generated[f] = (existsSync(root + "rules/" + f) ? load("rules/" + f) : {}).bySource ?? {};
  const items = load("tools/out/items.json").items;   // 64 МБ, один раз
  const found = findConflicts(manual, items, generated);
  console.log(`ручных bySlug: ${manual.length}; конфликтов: ${found.length}`);
  for (const c of process.argv.includes("--all") ? found : found.slice(0, 20)) console.log(`${c.key}\t${c.file}\t${c.uuid}`);
}
