// Эффекты попавшего Удара NPC: Хватка, Нокдаун, Отталкивание (и «Улучшенные»). Признак — attackEffects самого Удара (system.attackEffects.value),
// а не имя существа: подходят все Удары компендия. Улучшенные — бесплатное действие: проводим само (Захват / Сбивание с ног / Толчок по цели
// Удара, без штрафа за серию атак). Обычные тратят действие существа, а потратит ли его ведущий, модуль не знает — шёпот с кнопкой.
import { L, MOD, DEGREES, callGM } from "../util.mjs";
import { isHeldReroll } from "../hold.mjs";
import { esc, findFeat, whisper, cardButton, paHas } from "./lib.mjs";

// База (CONFIG.PF2E.attackEffects pf2e): grab / knockdown / push / trip, «improved-» — бесплатное действие. Варианты с расстоянием и «или притянуть»
// (push-10-feet, push-or-pull, improved-push-20-feet) — те же. Группа pf2e-automations, которой уступаем, у improved-push и trip её нет.
const BASE = { grab: ["grapple", "grab"], knockdown: ["trip", "knockdown"], push: ["shove", "push"], trip: ["trip", null] };
const ACT = /\[\[\/act (grapple|trip|shove)\b/;
const SHAPE = /^(improved-)?(grab|knockdown|push|trip)(?:-or-pull)?(?:-\d+-feet)?$/;

/** Чистая: attackEffect -> { action, free, pa } | null. own(slug) — текст способности актёра с этим slug (свои «tongue-grab», «throat-grab»): берём действие из [[/act …]]. */
export function effectInfo(effect, own = () => null) {
  const m = SHAPE.exec(effect);
  if (m) { const [action, pa] = BASE[m[2]]; return { action, free: !!m[1], pa }; }
  const act = ACT.exec(own(effect) ?? "")?.[1];
  return act ? { action: act, free: false, pa: null } : null;
}

/** Чистая: attackEffects Удара и степень атаки -> [{effect, action, free, pa}], по одному на действие (улучшенное вытесняет обычное). Промах — пусто. */
export function followUps(attackEffects, degree, own) {
  if (!(degree >= 2)) return [];
  const by = new Map();
  for (const effect of attackEffects ?? []) {
    const e = effectInfo(effect, own);
    if (e && (!by.has(e.action) || (e.free && !by.get(e.action).free))) by.set(e.action, { effect, ...e });
  }
  return [...by.values()];
}

/** Выполнить действие pf2e от лица актёра по цели (токен-документ). */
export const perform = (actor, action, targetDoc) =>
  game.pf2e.actions.get(action)?.use({ actors: [actor], target: targetDoc?.object ?? targetDoc?.actor });

export async function onMessage(message) {
  const ctx = message.flags?.pf2e?.context;
  if (ctx?.type !== "attack-roll" || (ctx.isReroll && !isHeldReroll(message))) return;   // переброс удержанного (hold.mjs): прежний бросок не обрабатывался
  const item = message.item, actor = message.actor;
  if (!actor || item?.type !== "melee") return;
  const degree = message.rolls?.[0]?.degreeOfSuccess ?? DEGREES.indexOf(ctx.outcome);
  const target = ctx.target?.token ? await fromUuid(ctx.target.token) : null;
  if (!target) return;
  const own = (slug) => findFeat(actor, slug)?.system?.description?.value ?? null;
  for (const f of followUps(item.system?.attackEffects?.value, degree, own)) {
    if (f.pa && paHas(f.pa)) continue;
    if (f.free) await perform(actor, f.action, target);
    else await whisper(actor, L("builtin.follow.hint", { name: esc(actor.name), strike: esc(item.name), act: L(`builtin.follow.act.${f.action}`), target: esc(target.name) }),
      "follow-up", { strike: { actor: actor.uuid, target: target.uuid, action: f.action, item: item.name } }, cardButton("data-af-follow", L(`builtin.follow.act.${f.action}`)));
  }
}

/** Кнопка шёпота (ведущий или владелец актёра): действие по цели; карточка гаснет, второго нажатия нет. */
export function bind(message, html) {
  const data = message.flags?.[MOD]?.strike, root = html instanceof HTMLElement ? html : html?.[0];
  const btn = root?.querySelector?.("[data-af-follow]");
  if (!data || !btn) return;
  if (data.used) { btn.disabled = true; return; }
  btn.addEventListener("click", async () => {
    const actor = await fromUuid(data.actor), target = await fromUuid(data.target);
    if (!actor?.isOwner || !target) return void ui.notifications.warn(L("builtin.reactive.cannot"));
    btn.disabled = true;
    await (game.user.isGM ? message.setFlag(MOD, "strike.used", true) : callGM("markStrikeUsed", message.id));
    await perform(actor, data.action, target);
  });
}
