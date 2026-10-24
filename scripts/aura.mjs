// Геометрия ауры владельца (onEvent side:"near"). Чистые функции: прямоугольники токенов в клетках {x, y, w, h, z, d}, расстояние — футы.
// ponytail: квадратная сетка (на гексах/без сетки расстояние приблизительное). Стены — в events.mjs (луч центр -> центр).

/** Расстояние в футах между прямоугольниками токенов по правилу pf2e — каждая 2-я диагональ 10 фт; соседние — 5. */
export function gapFeet(a, b, unit = 5) {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return (Math.max(dx, dy) + Math.floor(Math.min(dx, dy) / 2) + 1) * unit;
}

/**
 * Расстояние ауры как measureDistanceCuboid pf2e: шаги по осям = зазор+1 (по высоте — 0, если вертикальные отрезки токенов пересекаются; z/d — низ и высота в клетках),
 * дальше measureDistanceOnGrid: floor(1.75·двойные диагонали + 1.5·диагонали + прямые)·unit.
 */
export function auraFeet(a, b, unit = 5) {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w)) + 1;
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h)) + 1;
  const [az, ad, bz, bd] = [a.z ?? 0, a.d ?? 1, b.z ?? 0, b.d ?? 1];
  const dz = az < bz + bd && bz < az + ad ? 0 : Math.max(0, bz - (az + ad), az - (bz + bd)) + 1;
  const [lo, mid, hi] = [dx, dy, dz].sort((p, q) => p - q);
  return Math.floor(lo * 1.75 + (mid - lo) * 1.5 + (hi - mid)) * unit;
}

/** Аура pf2e с этим slug у токена: документ (TokenDocumentPF2e.auras) раньше отрисовщика. */
export const auraOf = (token, slug) => (token?.auras ?? token?.object?.auras)?.get?.(slug) ?? null;

/** Радиус записи near в футах: range, либо radius ауры pf2e с этим slug у токена владельца (нет такой ауры — null: запись не действует). */
export function nearRadius(entry, token) {
  if (entry.range != null) return entry.range;
  const aura = auraOf(token, entry.aura);
  return Number.isFinite(aura?.radius) ? aura.radius : null;
}

export const insideAura = (radius, carrier, other, unit = 5) => radius != null && auraFeet(carrier, other, unit) <= radius;


/**
 * Прямоугольники токена вдоль пути origin -> passed.waypoints -> destination, по клетке за шаг (первый — origin). Вход «сквозь» ауру ловится по промежуточным клеткам.
 * ponytail: прямая между точками пути (без учёта клеток-обходов); потолок — 400 клеток на отрезок; промежуточные точки без elevation — середина пути на конечной высоте.
 */
export function pathRects(doc, movement) {
  const g = doc.parent?.grid?.size || 100, pts = [movement.origin, ...(movement.passed?.waypoints ?? []), movement.destination].filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const out = [rectOf(doc, pts[0])];
  for (let k = 1; k < pts.length; k++) {
    const [a, b] = [pts[k - 1], pts[k]], n = Math.min(400, Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / g)));
    for (let i = 1; i <= n; i++) out.push(rectOf(doc, { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n, width: b.width ?? a.width, height: b.height ?? a.height }));
  }
  return out;
}

/**
 * Прямоугольник токена в клетках; pos — положение вместо документного (origin/destination движения). Привязка к клеткам как snapBounds pf2e:
 * x/y — floor, w/h — ceil; токен меньше клетки занимает клетку своего центра. z/d — низ и высота по вертикали в клетках.
 */
export function rectOf(doc, pos = doc) {
  const g = doc.parent?.grid?.size || 100, unit = doc.parent?.grid?.distance || 5;
  const [w, h] = [pos.width ?? doc.width, pos.height ?? doc.height];
  const [x, y] = [pos.x / g + (w < 1 ? w / 2 : 0), pos.y / g + (h < 1 ? h / 2 : 0)];
  return { x: Math.floor(x), y: Math.floor(y), w: Math.ceil(w), h: Math.ceil(h), z: (pos.elevation ?? doc.elevation ?? 0) / unit, d: Math.ceil(doc.depth ?? Math.min(w, h)) };
}
