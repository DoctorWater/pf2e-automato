// Источники существ для призыва (черта summon): компендиумы Actor и индекс кандидатов. Правило — onUse.summon (rules/summons.json).
import { S } from "./settings.mjs";

/** Таблица черты summon pf2e: ранг заклинания -> максимальный уровень существа. */
export const SUMMON_LEVELS = { 1: -1, 2: 1, 3: 2, 4: 3, 5: 5, 6: 7, 7: 9, 8: 11, 9: 13, 10: 15 };

/** Чистая: уровень существа по рангу. levels — своя таблица {ранг: уровень}: берётся наибольший ключ ≤ ранга (потолок — последняя запись); ранг ниже первого — null. */
export function levelFor(rank, levels = SUMMON_LEVELS) {
  const r = Number(rank);
  const k = Object.keys(levels).map(Number).filter((n) => n <= r).sort((a, b) => b - a)[0];
  return k == null ? null : levels[k];
}

const BESTIARY = /bestiary|monster-core|npc-core/;

/** Collection id Actor-компендиумов-источников: настройка summon.packs; пусто — бестиарии из настроек браузера компендиумов pf2e (вкладка bestiary). */
export function summonPacks() {
  const set = S.get("summon.packs");
  if (Array.isArray(set) && set.length) return set.filter((id) => game.packs.get(id)?.documentName === "Actor");
  const loaded = game.pf2e?.compendiumBrowser?.loadedPacks?.("bestiary");
  if (loaded?.length) return [...loaded];
  // браузер pf2e ещё не собрал список: бестиарии системы по имени
  return game.packs.filter((p) => p.documentName === "Actor" && p.metadata.packageName === "pf2e" && BESTIARY.test(p.metadata.name)).map((p) => p.collection);
}

let cache = { key: "", promise: null };

/** Индекс Actor-компендиумов (один раз за сессию на набор источников): [{uuid, name, level, img, traits, rarity, type}]. Паки без доступа (LIMITED) — пропускаются. */
export function buildIndex(ids = summonPacks()) {
  const key = [...ids].sort().join("|");
  if (cache.key !== key || !cache.promise) {
    cache = { key, promise: loadIndex(ids) };
    cache.promise.catch(() => { cache = { key: "", promise: null }; });
  }
  return cache.promise;
}

async function loadIndex(ids) {
  const out = [];
  for (const id of ids) {
    const pack = game.packs.get(id);
    if (!pack || pack.documentName !== "Actor" || !pack.testUserPermission(game.user, "LIMITED")) continue;
    let idx;
    try { idx = await pack.getIndex({ fields: ["system.traits.value", "system.traits.rarity", "system.details.level.value", "prototypeToken.width", "prototypeToken.height", "prototypeToken.texture.src"] }); } catch { continue; }
    for (const e of idx) out.push(entryOf(e, `Compendium.${pack.collection}.Actor.${e._id}`));
  }
  return out;
}

const entryOf = (e, uuid) => ({
  uuid: e.uuid ?? uuid, name: e.name, original: e.originalName ?? e.flags?.babele?.originalName ?? null, img: e.img, type: e.type,
  token: { src: e.prototypeToken?.texture?.src ?? e.img, w: e.prototypeToken?.width ?? 1, h: e.prototypeToken?.height ?? 1 },
  level: e.system?.details?.level?.value ?? 0, traits: e.system?.traits?.value ?? [], rarity: e.system?.traits?.rarity ?? "common"
});

/**
 * Чистая: фильтр индекса. Только npc и common, хоть один признак из traits (ИЛИ; пусто — любой), уровень ≤ maxLevel; уровень убыв., затем имя.
 * uuid — ровно это существо (правило onUse.summon.uuid), без фильтров черты.
 */
export function filterIndex(index, { traits = [], uuid = null, maxLevel = Infinity } = {}) {
  const pick = ({ uuid: u, name, original, level, img, traits: t, token }) => ({ uuid: u, name, original, level, img, traits: t, token });
  if (uuid) return index.filter((e) => e.uuid === uuid).map(pick);
  return index
    .filter((e) => e.type === "npc" && e.rarity === "common" && e.level <= maxLevel && (!traits.length || traits.some((t) => e.traits.includes(t))))
    .sort((a, b) => b.level - a.level || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(pick);
}

/** Кандидаты призыва. С uuid, которого нет в выбранных компендиумах (например, Призрачный приспешник при снятом флажке), существо берётся прямо из компендиума. */
export async function candidates({ traits = [], uuid = null, maxLevel = Infinity } = {}) {
  const index = await buildIndex();
  const found = filterIndex(index, { traits, uuid, maxLevel });
  if (!uuid || found.length) return found;
  const doc = await fromUuid(uuid).catch(() => null);
  if (doc?.documentName !== "Actor" || !doc.testUserPermission?.(game.user, "LIMITED")) return [];
  return [{ uuid, name: doc.name, original: doc.flags?.babele?.originalName ?? null, token: { src: doc.prototypeToken?.texture?.src ?? doc.img, w: doc.prototypeToken?.width ?? 1, h: doc.prototypeToken?.height ?? 1 }, level: doc.system?.details?.level?.value ?? 0, img: doc.img, traits: doc.system?.traits?.value ?? [] }];
}
