// Досягаемость Удара в ближнем бою. pf2e блокирует дальнюю атаку за пределом дальности («The target is out of range», pf2e.mjs ~20441/35991/24505),
// а ближнюю по цели вне досягаемости пропускает. Делаем так же, как система с дальним оружием: бросок не делается, предупреждение.
// Точка — обёртка game.pf2e.Check.roll (хука «до броска» у pf2e нет). Только квадратная сетка и токены на текущей сцене (как range.mjs).
// Обход: Alt при клике (ручная прибавка досягаемости — Руки-щупальца до 20 фт, решение ГМа) и unchecked() для бросков самого модуля
// (Реактивный удар — цель к нажатию уже ушла; Двойной взмах проверяет оба оружия заранее).
import { L, MOD } from "../util.mjs";
import { modeOf } from "../settings.mjs";

/** Чистая: предмет — Удар ближнего боя (оружие, атака NPC, Стихийный взрыв вблизи). Заклинания касания не трогаем — их дальность ведёт range.mjs. */
export const isMeleeStrike = (ctx) => ctx?.type === "attack-roll" && !!ctx.item?.isMelee && ["weapon", "melee", "action"].includes(ctx.item.type);

/** Чистая: {d, r}, если цель дальше досягаемости; иначе null. Нет чисел — не блокируем. */
export const outOfReach = (dist, reach) => (Number.isFinite(dist) && Number.isFinite(reach) && dist > reach ? { d: dist, r: reach } : null);

/** Чистая: токен атакующего. Нет в контексте (несвязанный NPC, бросок с листа мирового актёра) — выделенный токен этого актёра, если он ровно один. */
export function pickSource(ctxToken, controlled, actorId) {
  if (ctxToken) return ctxToken;
  const mine = (controlled ?? []).filter((t) => t.actor?.id === actorId);
  return mine.length === 1 ? mine[0] : null;
}

/** {d, r, name} — Удар item актёра actor с токена src по токену tgt вне досягаемости; иначе null. */
export function farFor(actor, item, src, tgt) {
  if (!src || !tgt || !globalThis.canvas?.grid?.isSquare || src.scene !== canvas.scene || tgt.scene !== canvas.scene) return null;
  // как pf2e isFlankingAttack: weapon передаётся и для действия (Стихийный взрыв)
  // ponytail: у атаки NPC (melee) досягаемость pf2e берёт только из признака reach-*; увеличенный NPC (CreatureSize) получит ложный блок — Alt
  const reach = actor?.getReach?.({ action: "attack", weapon: item });
  const far = outOfReach(src.distanceTo(tgt, { reach }), reach);   // reach в distanceTo — исключение pf2e для диагонали при досягаемости 10 фт
  return far && { ...far, name: tgt.name };
}

function check(context) {
  if (!isMeleeStrike(context)) return null;
  const actor = context.actor ?? context.origin?.actor;
  const src = pickSource((context.token ?? context.origin?.token)?.object, globalThis.canvas?.tokens?.controlled, actor?.id);
  return farFor(actor, context.item, src, context.target?.token?.object);
}

let skip = 0;
/** Бросок модуля без проверки досягаемости (свои сценарии уже решили, что Удар законен). */
export async function unchecked(fn) {
  skip++;
  try { return await fn(); } finally { skip--; }
}

const altHeld = () => !!globalThis.game?.keyboard?.isModifierActive?.("Alt");

async function wrap(orig, ...args) {
  let far = null;
  if (!skip && !altHeld() && modeOf("limits") !== "off") {
    try { far = check(args[1]); } catch (e) { console.warn(`${MOD} | melee-reach`, e); }
  }
  if (far) { ui.notifications.warn(L("builtin.reach.out", far)); return null; }   // как pf2e с дальним оружием: null — броска нет
  return orig(...args);
}

let installed = false;
/** Идемпотентно; вызывать после ready (game.pf2e.Check есть). */
export function install() {
  if (installed || !globalThis.game?.pf2e?.Check?.roll) return;
  if (game.modules.get("lib-wrapper")?.active && globalThis.libWrapper) {
    try { libWrapper.register(MOD, "game.pf2e.Check.roll", wrap, "MIXED"); installed = true; }
    catch (e) {   // например, другой модуль держит OVERRIDE; installed не ставим — повтор возможен
      console.error(`${MOD} | melee-reach: libWrapper.register`, e);
      if (game.user?.isGM) ui.notifications.warn(L("builtin.wrapFailed", { what: L("builtin.reachName"), error: e?.message ?? e }));
    }
    return;
  }
  installed = true;
  const C = game.pf2e.Check, orig = C.roll.bind(C);
  C.roll = (...a) => wrap(orig, ...a);
}
