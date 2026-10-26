// Высота местности: токен, закончивший движение в регионе, получает высоту региона (насыпи, склоны, крыши).
import { MOD } from "./util.mjs";

const TYPE = `${MOD}.height`;
// ponytail: ключи движений живут до перезагрузки страницы (одна запись на движение); чистить, если станет заметно
const settled = new Set();

/** Чистая: высота места, где стоит токен; пересекаются регионы — берётся наибольшая; null — регионов высоты нет. */
export function heightAt(token) {
  let h = null;
  for (const region of token.parent?.regions ?? []) {
    for (const b of region.behaviors) {
      if (b.type !== TYPE || b.disabled || !token.testInsideRegion(region)) continue;
      if (h === null || b.system.height > h) h = b.system.height;
    }
  }
  return h;
}

/** Чистая: в регионе токена есть смена уровня — v14 ждёт выбора игрока, а любое наше обновление отменит её как «новое движение». */
function onStairs(token) {
  for (const region of token.parent?.regions ?? [])
    for (const b of region.behaviors)
      if (b.type === "changeLevel" && !b.disabled && token.testInsideRegion(region)) return true;
  return false;
}

/**
 * Дождаться конца движения и поставить высоту. Обновление elevation в v14 — само движение: посреди пути оно обрывает
 * чужое, а на лестнице отменяет смену уровня. Поэтому после ожидания пишем, только если токен тот же, без нового движения.
 */
export async function settleHeight(token) {
  const id = token.movement?.id;
  const key = `${token.uuid}:${id ?? "create"}`;
  if (settled.has(key)) return;   // за одно движение токен может войти в несколько регионов
  settled.add(key);
  await token.movement?.finished;
  if (token.rendered) await token.object.movementAnimationPromise;
  const m = token.movement;
  if ((m?.id !== id && !m?.chain?.includes(id)) || ["planned", "pending", "paused"].includes(m?.state)) return;   // началось другое движение
  if (onStairs(token)) return;   // ждёт смены уровня
  const h = heightAt(token);
  if (h !== null && token.elevation !== h) await token.update({ elevation: h });   // без await между проверкой и записью
}

export class HeightBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["PF2E_AUTOMATO.height", "BEHAVIOR.TYPES.base"];

  static defineSchema() {
    return { height: new foundry.data.fields.NumberField({ required: true, nullable: false, initial: 0 }) };
  }

  // Статическое событие: работает при любом system.events. Обновляет тот, кто двигал токен.
  static events = { tokenEnter: HeightBehaviorType.#enter };

  static async #enter(event) { if (event.user?.isSelf) await settleHeight(event.data.token); }
}

export function init() {
  CONFIG.RegionBehavior.dataModels[TYPE] = HeightBehaviorType;
  CONFIG.RegionBehavior.typeLabels[TYPE] = "PF2E_AUTOMATO.height.label";
  CONFIG.RegionBehavior.typeHints[TYPE] = "PF2E_AUTOMATO.height.hint";
  CONFIG.RegionBehavior.typeIcons[TYPE] = "fa-solid fa-mountain";
}
