// Принудительное перемещение (шаг apply.move): толчок от автора / притяжение к автору. Исполняет активный ГМ (из applyOps).
// Чистая часть (forcedPath, moveOrder) — без Foundry; обёртка forcedMove — над сеткой и стенами сцены.
import { MOD } from "./util.mjs";

/**
 * Чистая: куда сдвинется токен. start — левый верхний угол (px), dir — единичный вектор, distance — футы,
 * size — px клетки, snap(p) -> p (привязка к сетке), measure(a, b) -> футы по сетке (диагонали сцены, гексы),
 * blocked(prev, next) -> null | "wall" | "creature" (проверка шага prev -> next).
 * Идём по лучу четвертями клетки: каждая новая клетка проверяется, остановка ПЕРЕД первой недопустимой или когда вышли за дистанцию.
 */
export function forcedPath({ start, dir, distance, size, unit = 5, snap, measure, blocked }) {
  let last = snap({ ...start });
  const first = last, path = [];
  const limit = (distance / unit) * size * 1.5 + size;   // с запасом на диагонали и гексы
  for (let t = size / 4; t <= limit; t += size / 4) {
    const p = snap({ x: start.x + dir.x * t, y: start.y + dir.y * t });
    if (p.x === last.x && p.y === last.y) continue;
    if (measure(first, p) > distance) break;
    const why = blocked(last, p);
    if (why) return { end: last, path, stoppedBy: why };
    path.push(p);
    last = p;
  }
  return { end: last, path, stoppedBy: null };
}

/**
 * Чистая: порядок целей. Толчок — от дальних к ближним (передний не мешает заднему), притяжение — наоборот.
 * steps — шаги степени; items — [{key, x, y}] центры целей; origin — {x, y}. Без шагов move порядок прежний.
 */
export function moveOrder(steps, items, origin) {
  const modes = (steps ?? []).filter((s) => s?.move).map((s) => s.move.mode);
  if (!modes.length || !origin) return items;
  const d = (i) => Math.hypot(i.x - origin.x, i.y - origin.y);
  const sign = modes.includes("push") ? -1 : 1;
  return [...items].sort((a, b) => sign * (d(a) - d(b)));
}

const rectsOverlap = (a, b) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
const centre = (doc, p, g) => ({ x: p.x + (doc.width * g) / 2, y: p.y + (doc.height * g) / 2 });

/**
 * ГМ: сдвинуть токен цели. mode push|pull, distance — футы. Возвращает {skipped: причина} или {from, to, id, stoppedBy}.
 * Причины пропуска: noToken, noOrigin, scene, grid, same. Нулевой сдвиг — {skipped: "blocked"}.
 */
export async function forcedMove(target, origin, { mode, distance }) {
  if (!target?.parent?.grid) return { skipped: "noToken" };   // цель без токена на сцене (актёр)
  const scene = target.parent;
  if (!origin) return { skipped: "noOrigin" };
  if (scene !== origin.parent || scene !== globalThis.canvas?.scene) return { skipped: "scene" };
  const grid = scene.grid, g = grid.size;
  if (grid.isGridless || grid.distance !== 5) return { skipped: "grid" };
  const tc = centre(target, target, g), oc = centre(origin, origin, g);
  const sign = mode === "push" ? 1 : -1;
  const len = Math.hypot(tc.x - oc.x, tc.y - oc.y);
  if (!len) return { skipped: "same" };
  const dir = { x: (sign * (tc.x - oc.x)) / len, y: (sign * (tc.y - oc.y)) / len };
  const others = scene.tokens.filter((t) => t !== target && t.actor && Math.abs((t.elevation ?? 0) - (target.elevation ?? 0)) < 1);
  const rectOf = (doc, p) => ({ x: p.x, y: p.y, w: doc.width * g, h: doc.height * g });
  // config.level ядру нужен документом уровня (ClockwiseSweepPolygon читает level.elevation.base), а у TokenDocument level — id
  const lvl = target.level ? scene.levels?.get?.(target.level) : null, level = lvl ? { level: lvl } : {};
  const snap = (p) => target.getSnappedPosition(p);   // гекс-сетка и размер токена — на стороне ядра
  const r = forcedPath({
    start: { x: target.x, y: target.y }, dir, distance, size: g, unit: grid.distance, snap,
    measure: (a, b) => grid.measurePath([a, b]).distance,
    blocked: (prev, next) => (others.some((t) => rectsOverlap(rectOf(target, next), rectOf(t, t))) ? "creature"
      : CONFIG.Canvas.polygonBackends.move.testCollision(centre(target, prev, g), centre(target, next, g), { type: "move", mode: "any", ...level }) ? "wall" : null)
  });
  if (!r.path.length) return { skipped: "blocked", stoppedBy: r.stoppedBy };
  const from = { x: target.x, y: target.y, elevation: target.elevation ?? 0 }, id = foundry.utils.randomID();
  const moved = await target.move([{ x: r.end.x, y: r.end.y, action: "displace" }], { id, constrainOptions: { ignoreWalls: true, ignoreCost: true }, showRuler: false, autoRotate: false, [MOD]: { forced: true } });
  if (moved === false || (target.x === from.x && target.y === from.y)) return { skipped: "blocked", stoppedBy: "refused" };
  return { from, to: { x: target.x, y: target.y, elevation: target.elevation ?? 0 }, id, stoppedBy: r.stoppedBy };
}

/** ГМ: вернуть позицию, если токен всё ещё там, куда его сдвинули. true — вернули; false — токен уже двигали / не найден. */
export async function undoMove(doc, { from, to, id }) {
  if (!doc || doc.x !== to.x || doc.y !== to.y) return false;
  if (doc._source?._movementHistory?.some((w) => w.movementId === id) && await doc.revertRecordedMovement(id)) return true;
  await doc.update({ x: from.x, y: from.y, elevation: from.elevation, action: "displace" }, { isUndo: true, animate: false, diff: false });   // isUndo: зоны и реакции на откат не срабатывают
  return true;
}
