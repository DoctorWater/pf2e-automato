// Перезапись мировых данных cast -> activate (plan-activate.md §6). Хук ready под активным ГМ; повтор безопасен (нет cast — нет работы).
// id записей и флаг счётчика uses не трогаются. Компендиумы мира и незагруженные акторы не мигрируются: рантайм читает оба ключа.
import { MOD, isActiveGM, whenSettled, forcedReplace, flagPath } from "./util.mjs";
import { S } from "./settings.mjs";

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

/** Сырой флаг правила -> он же с ключом activate (при обоих побеждает activate, как в рантайме); null — менять нечего. */
export function renameRule(raw) {
  if (!isObj(raw) || raw.cast == null) return null;
  const { cast, ...rest } = raw;
  return rest.activate != null ? rest : { ...rest, activate: cast };
}

/** Мировой каталог {bySource, bySlug, byName} -> копия с переименованными правилами; null — менять нечего. */
export function renameCatalog(cat) {
  if (!isObj(cat)) return null;
  let changed = false;
  const out = { ...cat };
  for (const field of ["bySource", "bySlug", "byName"]) {
    if (!isObj(cat[field])) continue;
    out[field] = Object.fromEntries(Object.entries(cat[field]).map(([k, r]) => {
      const n = renameRule(r);
      changed ||= !!n;
      return [k, n ?? r];
    }));
  }
  return changed ? out : null;
}

/** Предмет верхнего уровня: сырой флаг — целиком; вложенный (pf2e сливает его правку mergeObject без performDeletions) — cast: null. */
async function migrateItem(item) {
  const next = renameRule(item.flags?.[MOD]?.rule);
  if (!next) return 0;
  await item.update(item.parentItem ? { [flagPath("rule")]: { ...next, cast: null } } : forcedReplace(flagPath("rule"), next));
  return 1;
}

export async function migrateWorld() {
  let n = 0;
  const cat = renameCatalog(S.get("catalog"));
  if (cat) { await S.set("catalog", cat); n++; }
  const tops = [...game.items, ...game.actors.flatMap((a) => [...a.items])];
  for (const top of tops) for (const item of [top, ...(top.subitems ?? [])]) n += await migrateItem(item);
  if (n) console.log(`${MOD} | cast -> activate: переписано ${n}`);
  return n;
}

export function init() {
  Hooks.once("ready", async () => {
    await whenSettled();
    if (isActiveGM()) await migrateWorld().catch((e) => console.error(`${MOD} | migrate activate`, e));
  });
}
