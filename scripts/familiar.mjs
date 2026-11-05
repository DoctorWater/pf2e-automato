// Фамильяр ведьмы (docs/plan-familiar.md): поиск по system.master.id, токен на сцене токена ведьмы, «способность недоступна» (0 ОЗ, без сознания, мёртв).
// Чистые функции без хуков: исполнение записей side:"familiar" — events.mjs.

/** Актёры-фамильяры ведьмы. Обратной ссылки в данных pf2e нет (master.familiar — ленивый), поэтому перебор мировых актёров. */
export const familiarsOf = (witch) => [...(globalThis.game?.actors ?? [])].filter((a) => a.type === "familiar" && witch?.id && a.system?.master?.id === witch.id);

/** Токен фамильяра на сцене scene: документы токенов сцены (не getActiveTokens — работает и без холста); первый видимый, иначе null. */
export const familiarToken = (fam, scene) => { const l = [...(scene?.tokens ?? [])].filter((t) => t.actorId === fam.id); return l.find((t) => !t.hidden) ?? l[0] ?? null; };   // видимый, иначе скрытый (центр отсчёта годится и он)

/** Фамильяр не может действовать: 0 ОЗ, без сознания, мёртв (решение Руководителя — способность не запускается). */
export const familiarDown = (fam) => (fam.hitPoints?.value ?? fam.system?.attributes?.hp?.value ?? 1) <= 0 || !!fam.isDead || !!fam.hasCondition?.("unconscious");

/** СЛ колдовства заклинания (запись колдовства, из которой оно сотворено): не «первая запись актёра» — мультикласс. null — не определить. */
export const spellDcOf = (spell) => spell?.spellcasting?.statistic?.dc?.value ?? null;
