// «Охота на добычу» у NPC. У PC действие ставит selfEffect pf2e (TokenMark «hunted-prey»); у копий NPC selfEffect нет, только переключатель
// `hunted-prey` (RollOption toggleable) в правилах способности. Признак — этот переключатель на способности без selfEffect: по использованию
// включаем его и помечаем цель родным эффектом pf2e «Hunt Prey» (TokenMark на токен цели; прежняя метка снимается — добыча одна).
// Цели берутся из снимка автора (preCreateChatMessage): у ведущего-исполнителя чужих целей нет.
import { L, MOD, queue, flagPath } from "../util.mjs";
import { addEffect, paHas } from "./lib.mjs";

export const KEY = "hunt-prey", MARK_EFFECT = "Compendium.pf2e.feat-effects.Item.MeXyXqWY9qN42bSQ";
const OPTION = /^(?:hunted-prey|hunt-prey)$/;

/** Чистая: переключатель добычи в правилах способности без selfEffect, иначе null. */
export function preyToggle(item) {
  if (item?.type !== "action" || item.system?.selfEffect) return null;
  return item.system?.rules?.find((r) => r.key === "RollOption" && r.toggleable && OPTION.test(r.option))?.option ?? null;
}

/** Чистая: сколько добыч одновременно — две у черты «Двойная добыча» (опция feat:double-prey, как у PA) и у способностей NPC с текстом «one or two». */
export const maxPrey = (rollOptions, descriptionHtml) => (rollOptions?.["feat:double-prey"] || /\bone or two\b/i.test(String(descriptionHtml ?? "").replace(/<[^>]+>/g, " ")) ? 2 : 1);

/** Чистая: правила эффекта метки с токеном цели. */
export const markRules = (rules, targetUuid) => rules.map((r) => (r.key === "TokenMark" ? { ...r, uuid: targetUuid } : r));

/** Автор сообщения: снимок целей, только для карточек с переключателем добычи. */
export function snapTargets(message) {
  const origin = message.flags?.pf2e?.origin;
  if (origin?.type !== "action" || !preyToggle(fromUuidSync(origin.uuid ?? ""))) return;
  message.updateSource({ [flagPath("preyTargets")]: [...(game.user.targets ?? [])].map((t) => (t.document ?? t).uuid) });
}

export async function onMessage(message) {
  const item = message.flags?.pf2e?.origin?.type === "action" ? message.item : null, option = preyToggle(item), actor = item?.actor;
  if (!option || !actor || paHas("hunt-prey")) return;
  const uuids = message.flags?.[MOD]?.preyTargets ?? [];
  const max = maxPrey(actor.rollOptions?.all, item.system?.description?.value);
  if (!uuids.length || uuids.length > max) return void ui.notifications.warn(L(max > 1 ? "builtin.hunt.needTargets" : "builtin.hunt.needTarget", { name: actor.name }));
  const targets = (await Promise.all(uuids.map((u) => fromUuid(u)))).filter((t) => t?.actor);
  const src = (await fromUuid(MARK_EFFECT))?.toObject();
  if (src && targets.length) {
    await queue(`actor:${actor.uuid}`, async () => {   // новая охота заменяет прежние метки
      for (const e of actor.items.filter((i) => i.type === "effect" && i.flags?.[MOD]?.meta?.key?.startsWith(KEY))) await e.delete();
    });
    for (const t of targets) {
      const data = foundry.utils.deepClone(src);
      delete data._id;
      data.system.rules = markRules(data.system.rules, t.uuid);
      await addEffect(actor, data, `${KEY}:${t.uuid}`);
    }
  }
  if (!actor.rollOptions?.all?.[option]) await actor.toggleRollOption("all", option, item.id, true);
}
