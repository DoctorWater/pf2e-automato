// Сборка пака эффектов модуля: packs/_source/effects/*.json -> LevelDB packs/effects (формат Foundry: ключ `!items!<id>`, значение — документ без _key).
// packs/effects в git не лежит (Foundry переписывает базу при открытии мира, а папка модуля — junction на репозиторий): собирается локально и для релиза, см. README.
// Пересборка пропускается, если источники не менялись (хеш в packs/.effects.hash); занятая Foundry база или нет classic-level — предупреждение, не ошибка.
import { readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOT, isMain, cmp } from "./lib.mjs";
import { classicLevel } from "./packs.mjs";

export const PACK_ID = "pf2e-automato", PACKS = { effects: { src: join(ROOT, "packs/_source/effects"), out: join(ROOT, "packs/effects"), hash: join(ROOT, "packs/.effects.hash") },
  equipment: { src: join(ROOT, "packs/_source/equipment"), out: join(ROOT, "packs/equipment"), hash: join(ROOT, "packs/.equipment.hash") } };

/** Документы источника пака [{_key, ...doc}], по id. */
export const sourceDocs = (name = "effects") =>
  readdirSync(PACKS[name].src).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(PACKS[name].src, f), "utf8"))).sort((a, b) => cmp(a._id, b._id));
export const stripKey = ({ _key, ...doc }) => doc;

/** Собрать пак в out (по умолчанию packs/effects). -> число документов | null (пропущено: причина в warn). */
export async function buildPack(name = "effects", out = PACKS[name].out) {
  const docs = sourceDocs(name), CL = classicLevel();
  if (!CL) { console.warn("build-packs: classic-level не найден (FOUNDRY_NODE_MODULES) — пак не собран"); return null; }
  const stamp = createHash("sha1").update(JSON.stringify(docs)).digest("hex"), main = out === PACKS[name].out;
  if (main && existsSync(out) && existsSync(PACKS[name].hash) && readFileSync(PACKS[name].hash, "utf8") === stamp) { console.log("build-packs: источники не менялись, пак актуален"); return docs.length; }
  try {
    rmSync(PACKS[name].hash, { force: true });   // частичное удаление при занятой базе не должно выглядеть как «пак актуален»
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const db = new CL(out, { keyEncoding: "utf8", valueEncoding: "utf8" });
    await db.open();
    await db.batch(docs.map((d) => ({ type: "put", key: d._key, value: JSON.stringify(stripKey(d)) })));
    await db.close();
  } catch (e) {
    console.warn(`build-packs: база занята (открыт мир Foundry?) — пересборка пропущена: ${e.code ?? e.message}`);
    return null;
  }
  for (const f of ["LOG", "LOG.old"]) rmSync(join(out, f), { force: true });
  if (main) writeFileSync(PACKS[name].hash, stamp);
  return docs.length;
}

if (isMain(import.meta.url)) for (const name of Object.keys(PACKS)) { const n = await buildPack(name); if (n != null) console.log(`build-packs: ${name} — ${n} документов`); }
