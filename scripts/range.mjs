// Дальность предмета против расстояния до цели (pf2e: token.distanceTo учитывает размер, диагонали и высоту).

/** RollOption эффекта «Руки-щупальца»: досягаемость заклинаний касания тоже 10 фт. */
export const TENTACLES = "tentacular-limbs";

/** Чистая: цели снимка без вышедших за дальность (они не получают ни проверок, ни эффектов, ни макросов). */
export const inRange = (targets) => (targets ?? []).filter((t) => !t.far);

/** Чистая: метамагия «Дальнее заклинание» в rollOptions origin (поддерживается и `metamagic:reach-spell`, и `self:effect:reach-spell`). */
export const hasReachSpell = (opts) => (opts ?? []).some((o) => /(^|:)reach-spell$/.test(o));

/** Чистая: дальность в футах. range — SpellPF2e#range ({max}|null; касание = досягаемость заклинателя), touch — SpellPF2e#isMelee. null — дальности нет/не числовая. */
export function maxRange(range, touch, opts) {
  const reach = hasReachSpell(opts);
  if (touch) return reach ? 30 : Math.max(range?.max ?? 5, (opts ?? []).includes(TENTACLES) ? 10 : 0);   // Дальнее заклинание: касание 30 фт; Руки-щупальца: 10 фт
  return range?.max ? range.max + (reach ? 30 : 0) : null;
}

/** Чистая: {d, r} если цель дальше дальности, иначе null. NaN (нет холста/токена) — не штрафуем. */
export const farFrom = (dist, max) => (max != null && Number.isFinite(dist) && dist > max ? { d: dist, r: max } : null);

/** Чистая: запись rules/ranges.json {ft, area?, grow?} -> футы для актёра уровня level. area (место области) здесь не проверяется — null. */
export function tableRange(entry, level) {
  if (!entry || entry.area || !(entry.ft > 0)) return null;
  const g = entry.grow;
  return entry.ft + (g && level > 1 ? g.add * Math.floor((level - 1) / g.every) : 0);
}

/** Чистая: запись по uuid источника, иначе по slug (в bySlug попадают только slug, где все документы согласны — tools/ranges.mjs). */
export const lookupRange = (table, sourceId, slug) => (sourceId && table?.bySource?.[sourceId]) || (slug && table?.bySlug?.[slug]) || null;

let source = null;
/** rules.mjs регистрирует поставщика записи дальности предмета (каскад resolveRule с оверлеем ranges.json); без него дальность не проверяется. */
export const setRangeSource = (fn) => { source = fn; };

/** Дальность предмета в футах: заклинание — с учётом метамагии, черта/действие — onUse.range правила (в т.ч. оверлей rules/ranges.json); null — не проверять. */
export function itemRange(item, opts) {
  if (item?.type === "spell") return maxRange(item.range, !!item.isMelee, opts);
  if (item?.type !== "feat" && item?.type !== "action") return null;
  return tableRange(source?.(item) ?? null, item.actor?.level);
}

/** Для целей снимка: добавляет `far:{d,r}` тем, кто вне дальности (токен заклинателя -> токен цели).
 *  Только квадратная сетка: на гексах и без сетки distanceTo у pf2e меряет от левых верхних углов без учёта размеров. */
export function markFar(targets, srcToken, max) {
  if (max == null || !srcToken || !globalThis.canvas?.grid?.isSquare) return targets;
  return targets.map((t) => {
    const obj = fromUuidSync(t.uuid)?.object;
    const far = obj ? farFrom(srcToken.distanceTo(obj, { reach: max }), max) : null;
    return far ? { ...t, far } : t;
  });
}
