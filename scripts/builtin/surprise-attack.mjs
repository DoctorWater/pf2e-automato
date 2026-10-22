// «Внезапная атака» (Surprise Attack): после инициативы Обманом/Скрытностью в 1-м раунде существа, ещё не ходившие в бою, застигнуты врасплох
// перед плутом. На плуте — эффект с EphemeralEffect на каждое такое существо (предикат `target:signature:<actor.signature>`): off-guard живёт на
// контекстной копии цели только в атаках плута (как у тисков), даёт `target:condition:off-guard` -> Атака исподтишка срабатывает сама.
// Метка существа снимается, когда начинается его ход (updateCombat); эффект — когда меток нет, с 2-го раунда и по концу боя.
// Всё делает активный ГМ. ponytail: порядок ходов берём из боя на момент сообщения (бросок инициативы посреди боя — по текущему порядку).
import { L, MOD, queue } from "../util.mjs";
import { addEffect, combatOf, effectSource, esc, findFeat, offGuardRule, whisper } from "./lib.mjs";

export const SLUG = "surprise-attack";
const UNLIMITED = { value: -1, unit: "unlimited" };
const SIG = "target:signature:";

/** Чистая: сообщение инициативы -> true, если бросали Обман или Скрытность. null — это не инициатива. */
export function classify(ctx) {
  if (ctx?.type !== "initiative") return null;
  const o = ctx.options ?? [];
  return o.includes("check:statistic:base:deception") || o.includes("check:statistic:base:stealth");
}

/** Чистая: правила эффекта по сигнатурам существ. */
export const rulesFor = (sigs) => sigs.map((s) => offGuardRule([`${SIG}${s}`]));
/** Чистая: сигнатуры из правил. */
export const sigsOf = (rules = []) => rules.flatMap((r) => (r?.predicate ?? []).filter((p) => typeof p === "string" && p.startsWith(SIG)).map((p) => p.slice(SIG.length)));
/** Чистая: правила без метки существа. */
export const dropSig = (rules = [], sig) => rules.filter((r) => !(r?.predicate ?? []).includes(`${SIG}${sig}`));

/** Чистая: кто ещё не ходил. turns — порядок ходов [{actor}], idx — индекс текущего (если бой начат). Сам плут исключён. */
export function pending(turns, started, idx, self) {
  return (started ? turns.slice(idx + 1) : turns).map((c) => c.actor).filter((a) => a && a !== self && a.signature);
}

const effectOf = (actor) => actor.items.find((i) => i.type === "effect" && i.flags?.[MOD]?.meta?.key === SLUG);
const removeEffect = (actor) => queue(`actor:${actor.uuid}`, async () => { await effectOf(actor)?.delete(); });

export async function onMessage(message) {
  const mine = classify(message.flags?.pf2e?.context);
  const actor = mine !== null && message.actor;
  if (!actor || !findFeat(actor, SLUG)) return;
  // бой — тот, где актёр участвует (game.combat — бой, который смотрит ведущий-исполнитель, он может быть другим)
  const combat = combatOf(game.combats.contents.filter((c) => c.round <= 1), actor);
  if (!combat) return;
  if (!mine) return void await removeEffect(actor);   // повторный бросок другой характеристикой
  const sigs = pending(combat.turns, combat.started, combat.turn, actor).map((a) => a.signature);
  if (!sigs.length) return void await removeEffect(actor);
  const rules = rulesFor(sigs);
  const updated = await queue(`actor:${actor.uuid}`, async () => {
    const old = effectOf(actor);
    if (old) await old.update({ "system.rules": rules, [`flags.${MOD}.combat`]: combat.id });
    return !!old;
  });
  if (updated) return;
  const feat = findFeat(actor, SLUG);
  const created = await addEffect(actor, {
    ...effectSource({ name: L("builtin.surprise.effect"), duration: UNLIMITED, img: feat.img, rules, origin: { actor: actor.uuid, item: feat.uuid } }),
    flags: { [MOD]: { combat: combat.id } }
  }, SLUG);
  if (created) await whisper(actor, L("builtin.surprise.hint", { name: esc(actor.name) }), SLUG);
}

/** Смена хода/раунда: у существа, чей ход начался, метку снять у всех плутов; со 2-го раунда эффект снять. */
export async function onTurn(combat, changed) {
  if (!("turn" in changed) && !("round" in changed)) return;
  const sig = combat.combatant?.actor?.signature;
  for (const c of combat.combatants) {
    const actor = c.actor;
    if (!actor) continue;
    await queue(`actor:${actor.uuid}`, async () => {
      const eff = effectOf(actor);
      if (!eff) return;
      const cur = eff.system.rules, rules = combat.round > 1 ? [] : dropSig(cur, sig);
      if (!rules.length) await eff.delete();
      else if (rules.length !== cur.length) await eff.update({ "system.rules": rules });
    });
  }
}

export async function onCombatEnd(combat) {
  for (const c of combat.combatants) if (c.actor) await removeEffect(c.actor);
}
