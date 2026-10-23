// «Сокрушение» (Smite): если отмеченный враг совершает враждебное действие против чемпиона или его союзника (бросок атаки по цели), эффект Сокрушения у чемпиона продлевается
// до конца следующего хода этого врага (текст черты; так же делает extendSmite у pf2e-automations). Эффект pf2e ставит сама черта (selfEffect, TokenMark на жертву) — здесь только продление.
import { queue } from "../util.mjs";
import { paHas } from "./lib.mjs";

export const SLUG = "smite", SMITE_EFFECT = "Compendium.pf2e.feat-effects.Item.AlnxieIRjqNqsdVu";
const ATTACKS = new Set(["attack-roll", "spell-attack-roll"]);

/** Чистая: эффект помечает токен (TokenMark на его uuid). */
export const marks = (effect, tokenUuid) => !!tokenUuid && (effect?.system?.rules ?? effect?._source?.system?.rules ?? []).some((r) => r.key === "TokenMark" && r.uuid === tokenUuid);

/** Чистая: правка эффекта — срок отсчитывается с хода врага (инициатива) от текущего мирового времени, кончается в конце хода. */
export const extension = (worldTime, initiative) => ({ "system.start": { value: worldTime, initiative }, "system.duration.expiry": "turn-end" });

export async function onMessage(message) {
  const ctx = message.flags?.pf2e?.context;
  if (!ATTACKS.has(ctx?.type) || !ctx.target?.actor || paHas(SLUG)) return;
  const combat = game.combat, attacker = message.actor, token = message.token ?? null, target = fromUuidSync(ctx.target.actor);
  if (!combat?.active || !attacker?.combatant || !token || !target) return;
  // эффект Сокрушения у чемпиона, чья метка — этот враг, а цель атаки — сам чемпион или его союзник
  const effects = combat.turns.map((c) => c.actor).filter((a) => a && attacker.isEnemyOf?.(a) && (a === target || target.isAllyOf?.(a)))
    .map((a) => a.itemTypes.effect.find((e) => e._stats?.compendiumSource === SMITE_EFFECT)).filter((e) => e && marks(e, token.uuid));
  for (const e of effects) await queue(`actor:${e.actor.uuid}`, () => e.update(extension(game.time.worldTime, attacker.combatant.initiative)));
}
