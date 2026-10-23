// Общие помощники встроенных обработчиков. Чистые функции не трогают foundry (юнит-тесты, tests/builtin.test.mjs).
import { L, MOD, queue, sharedDialog, sluggify, socket } from "../util.mjs";
import { card, HEADS } from "../card.mjs";
import { shouldYield } from "../compat.mjs";
export { card, cardButton } from "../card.mjs";

/** pf2e-automations ещё ведёт эту механику (активна группа с таким slug и включена настройка «уступать»): обработчик молчит, чтобы не было двойного срабатывания. */
export const paHas = (slug) => shouldYield(null, { slug });

export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export const COND = {
  clumsy: "Compendium.pf2e.conditionitems.Item.i3OJZU2nk64Df3xm",
  offGuard: "Compendium.pf2e.conditionitems.Item.AJh5ex99aV6VTggg"
};
export const grantCondition = (uuid) => ({ key: "GrantItem", uuid, onDeleteActions: { grantee: "restrict" } });

/** «до конца текущего хода» — идиома pf2e: 0 раундов, expiry turn-end (pf2e.mjs:45866). */
export const UNTIL_TURN_END = { value: 0, unit: "rounds", expiry: "turn-end" };

/** Данные эффекта-обёртки. origin/target: {actor, token, item} — UUID или null. */
export function effectSource({ name, description = "", rules = [], duration = UNTIL_TURN_END, origin = {}, target = {}, img = "icons/svg/aura.svg" }) {
  return {
    name, type: "effect", img,
    system: {
      description: { value: description }, rules, level: { value: 0 }, tokenIcon: { show: true },
      duration: { sustained: false, ...duration },
      context: {
        origin: { actor: origin.actor ?? null, token: origin.token ?? null, item: origin.item ?? null, spellcasting: null, rollOptions: [] },
        target: target.actor ? { actor: target.actor, token: target.token ?? null } : null,   // pf2e: actor цели не может быть null, только вся цель
        roll: null
      }
    }
  };
}

/** Создать эффект на актёре; повтор с тем же key — пропуск (идемпотентно). Очередь актёра общая с apply.mjs. */
export function addEffect(actor, source, key) {
  return queue(`actor:${actor.uuid}`, async () => {
    if (actor.items.some((i) => i.flags?.[MOD]?.meta?.key === key)) return null;
    const data = foundry.utils.mergeObject(source, { flags: { [MOD]: { meta: { key, source: "builtin" } } } }, { inplace: false });
    const [item] = await actor.createEmbeddedDocuments("Item", [data]);
    return item;
  });
}

/** Состояние через apply.mjs (политика max, идемпотентность по meta.key). Импорт ленивый — без цикла macros <-> apply. */
export async function addCondition(actor, spec, key) {
  const { applyCondition } = await import("../apply.mjs");
  return applyCondition(actor, spec, { key, source: "builtin" });
}

/** Диалог выбора у активного ГМа. buttons: [{id, label}]; возвращает id или null (закрыт). */
export const ask = async (title, content, buttons) =>
  (await sharedDialog({ title, content, buttons: buttons.map((b) => ({ action: b.id, label: b.label })) }))?.action ?? null;

/** Диалог автору: игроку — у него; ГМу — общее окно всех вкладок ГМа (первый ответ побеждает). -> { action, form } | null (закрыт). */
export async function askHere(title, content, buttons, ms = 0) {   // ms > 0 — окно закрывается само (результат null)
  if (game.user.isGM) return (await sharedDialog({ title, content, ms, buttons: buttons.map((b) => ({ action: b.id, label: b.label })) })) ?? null;
  const res = await foundry.applications.api.DialogV2.wait({
    window: { title }, classes: ["paf-dialog"], content, rejectClose: false,
    render: (_e, dlg) => { if (ms > 0) setTimeout(() => dlg.close(), ms); },
    buttons: buttons.map((b, i) => ({ action: b.id, label: b.label, default: i === 0, callback: (_e, btn) => ({ action: b.id, form: btn.form ? Object.fromEntries(new FormData(btn.form)) : {} }) }))
  });
  return res ?? null;
}

/** Шапка карточки по тегу шёпота: название из lang `card.<tag>`, иконка из HEADS. */
export const headOf = (tag) => (HEADS[tag] ? { title: L(`card.${tag}`), icon: HEADS[tag] } : null);

/** Шёпот ГМам и владельцам актёра: text — текст, buttons — готовые cardButton(...). only: "gm" | "players" — только одним адресатам. */
export function whisper(actor, text, tag, extra = {}, buttons = "", only = null) {
  const content = card(text, buttons, headOf(tag));
  const ids = new Set(only === "players" ? [] : game.users.filter((u) => u.isGM).map((u) => u.id));
  if (only !== "gm") for (const u of game.users) if (!u.isGM && actor?.testUserPermission?.(u, "OWNER")) ids.add(u.id);
  if (only === "players" && !ids.size) return null;   // пустой whisper — публичное сообщение
  // говорит сам актёр (портрет и имя в шапке сообщения, как у карточек pf2e), а не ведущий
  return ChatMessage.create({ content, whisper: [...ids], speaker: ChatMessage.getSpeaker?.({ actor }), flags: { [MOD]: { builtin: tag, ...extra } } });
}

/** Шёпот с СЛ: метаигра pf2e (metagame.dcs) выключена — ведущему текст `key` с СЛ, владельцам `key + "Hidden"` без неё (отдельные сообщения: шёпот общий, текст не скрыть). */
export async function whisperDC(actor, key, vars, dc, tag, extra, buttons) {
  const text = (d) => L(key, { ...vars, dc: d ?? "?" });
  if (dc == null || game.pf2e?.settings?.metagame?.dcs) return whisper(actor, text(dc), tag, extra, buttons);
  await whisper(actor, text(dc), tag, extra, buttons, "gm");
  await whisper(actor, L(`${key}Hidden`, vars), tag, extra, buttons, "players");
}

/** Токен-документ из токена канваса или документа. */
export const docOf = (t) => t?.document ?? t ?? null;

/** Источник сообщения pf2e: origin {actor, uuid, type, rollOptions}; кастомные не-кастовые контексты отбрасываем. */
export function castOrigin(message) {
  const pf = message?.flags?.pf2e, ctx = pf?.context?.type;
  if (!pf?.origin || (ctx && ctx !== "spell-cast")) return null;
  return pf.origin;
}

/** Чистая: предмет не-эффект с этим slug; у предметов без slug (NPC-способности, перевод) — по babele.originalName и по имени. */
export function findFeat(actor, slug) {
  return actor?.items?.find((i) => i.type !== "effect" && (i.slug === slug || sluggifyName(i.flags?.babele?.originalName) === slug || sluggifyName(i.name) === slug)) ?? null;
}
const sluggifyName = (s) => (typeof s === "string" ? s.toLowerCase().trim().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : null);

/** Чистая: правило «цель с этим предикатом застигнута врасплох для Ударов (бросок и урон)». */
export const offGuardRule = (predicate) => ({ key: "EphemeralEffect", affects: "target", selectors: ["strike-attack-roll", "spell-attack-roll", "strike-damage", "attack-spell-damage"], uuid: COND.offGuard, predicate });

/** Чистая: бой, в котором участвует актёр (по uuid; у токенов без связи actor — свой). */
export const combatOf = (combats, actor) => combats.find((c) => c.combatants.some((x) => x.actor?.uuid === actor.uuid)) ?? null;

/** Чистая: эффект боя «повис» — боя нет или актёра в нём нет. combats — коллекция с get(id). */
export const isStale = (combatId, actorUuid, combats) => {
  const c = combatId ? combats.get(combatId) : null;
  return !c || !c.combatants.some((x) => x.actor?.uuid === actorUuid);
};

/** Подмести эффекты с meta.key боя, чей бой кончился или чей владелец вышел из боя (flags[MOD].combat — id боя). Только активный ГМ. */
export async function sweepEffects(key) {
  const actors = [...game.actors, ...game.scenes.contents.flatMap((s) => s.tokens.filter((t) => !t.actorLink).map((t) => t.actor))];
  const find = (a) => a.items.find((i) => i.type === "effect" && i.flags?.[MOD]?.meta?.key === key);
  for (const a of actors) {
    const e = a && find(a);
    if (e && isStale(e.flags?.[MOD]?.combat, a.uuid, game.combats)) await queue(`actor:${a.uuid}`, async () => { await find(a)?.delete(); });
  }
}

/** Чистая: slug предмета; у копий NPC и переводов slug нет или чужой — по исходному имени (babele) и имени. */
export const itemSlug = (item) => item?.slug || sluggify(item?.flags?.babele?.originalName ?? item?.name) || null;

/** Чистая: предмет актёра с одним из slug (не эффект) -> slug | null. */
export const heldSlug = (actor, slugs) => {
  const set = slugs instanceof Set ? slugs : new Set(slugs);
  for (const i of actor?.items ?? []) if (i.type !== "effect" && set.has(itemSlug(i))) return itemSlug(i);
  return null;
};

/** Токены-цели сообщения: снимок правила (use.targets), иначе цели автора (ядро синхронизирует User#targets между клиентами). */
export function messageTargets(message) {
  const snap = message.flags?.[MOD]?.use?.targets;
  return (snap ? snap.map((t) => fromUuidSync(t.uuid)) : [...(message.author?.targets ?? [])]).map(docOf).filter((t) => t?.actor);
}

/**
 * Выбор принадлежит игроку-владельцу: окно у него (runPlayerBuiltin, реестр builtin/index.mjs), нет игрока онлайн или он не ответил — окно ведущего (local()).
 * packed — { targets: [uuid] }; возвращает то, что вернул обработчик, либо local().
 */
export async function askOwner(actor, bid, packed, local) {
  const player = game.users.find((u) => !u.isGM && u.active && actor.testUserPermission?.(u, "OWNER"));
  if (player) {
    try {
      return await Promise.race([socket.executeAsUser("runPlayerBuiltin", player.id, bid, { actor: actor.uuid, ...packed }), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 180000))]);
    } catch (e) { console.warn(`${MOD} | ${bid}: окно у игрока не вышло, спрашиваем ведущего`, e); }
  }
  return local();
}

/** Актёры мира и актёры несвязанных токенов всех сцен. */
export const worldActors = () => [...game.actors, ...game.scenes.contents.flatMap((s) => s.tokens.filter((t) => !t.actorLink).map((t) => t.actor))].filter(Boolean);
