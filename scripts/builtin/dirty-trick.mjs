// X3. Грязный приём: проверку Воровства бросает АВТОР против СЛ Рефлекса цели, результат применяется по степени.
// ponytail: штраф за последовательные атаки (у приёма трейт attack) не считаем — attackNumber не передаётся.
import { L } from "../util.mjs";
import { settledDegree } from "../hold.mjs";
import { COND, addCondition, addEffect, effectSource, grantCondition } from "./lib.mjs";

/** Чистая: степень 0..3 -> шаги. kind: condition (slug) | effect (неуклюжесть на 1 раунд). */
export function dirtyTrickPlan(degree) {
  if (degree === 3) return [{ to: "target", kind: "condition", slug: "clumsy", value: 1 }];
  if (degree === 2) return [{ to: "target", kind: "effect" }];
  if (degree === 0) return [{ to: "self", kind: "condition", slug: "prone" }];
  return [];
}

export async function run(scope) {
  const actor = scope.actor, target = scope.targets?.length === 1 ? scope.targets[0] : null;
  if (!actor?.skills?.thievery || !target?.actor) return void ui.notifications.warn(L("builtin.needOneTarget", { name: scope.item?.name ?? "" }));
  let msg = null;
  const roll = await actor.skills.thievery.check.roll({
    dc: { slug: "reflex" }, target: target.actor, token: scope.token ?? undefined, skipDialog: true,
    action: "dirty-trick", extraRollOptions: ["action:dirty-trick"], traits: ["attack", "manipulate"], title: scope.item?.name,
    callback: (_r, _o, m) => { msg = m; }
  });
  const first = roll?.options?.degreeOfSuccess ?? roll?.degreeOfSuccess;
  if (!(first >= 0)) return;
  const degree = await settledDegree(msg, first);   // удержан ради переброса (hold.mjs) — ждём итог
  const mid = scope.message?.id ?? "live";
  for (const [i, s] of dirtyTrickPlan(degree).entries()) {
    const who = s.to === "self" ? actor : target.actor, key = `${mid}:${s.to === "self" ? "self" : target.id}:dirty${i}`;
    if (s.kind === "condition") await addCondition(who, { slug: s.slug, value: s.value }, key);
    else await addEffect(who, effectSource({
      name: L("builtin.dirty.effect"), duration: { value: 1, unit: "rounds", expiry: "turn-start" }, rules: [grantCondition(COND.clumsy)],
      origin: { actor: actor.uuid, token: scope.token?.uuid, item: scope.item?.uuid }, target: { actor: who.uuid, token: target.uuid }
    }), key);
  }
}
