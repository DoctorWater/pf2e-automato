// «Доля добычи»: Дар заступника (Warden's Boon), Общая добыча (Shared Prey), Тройная угроза (Triple Threat, одна добыча -> два союзника) — надстройка над hunt-prey.mjs.
// Признак группы — тег pf2e `hunters-edge-sharing` у черты (у pf2e его несут ещё Animal Companion (Ranger): компаньон не переносится, нет связи хозяин -> компаньон в данных).
// Какой эффект выдать, говорит сам pf2e: ItemAlteration черт охотничьего преимущества (Flurry / Outwit / Precision) дописывает к описанию черты ссылку на
// «Effect: Share Hunter's Edge (…)» с учётом masterful-вариантов — берём ссылки оттуда, имён не перечисляем. Метка добычи (TokenMark share-hunters-edge) в этих эффектах без цели:
// подставляем токен добычи охотника (markRules из hunt-prey.mjs).
//  — Дар заступника: действие, цель — союзник; срок — до конца его следующего хода.
//  — Общая добыча / Тройная угроза: после «Охоты на добычу» ровно с одной добычей; игрок-владелец выбирает союзников (окно у него, иначе у ведущего); эффекты живут до новой охоты.
import { L, MOD, queue } from "../util.mjs";
import { addEffect, askHere, askOwner, docOf, esc, itemSlug, messageTargets, paHas, whisper, worldActors } from "./lib.mjs";
import { markRules } from "./hunt-prey.mjs";

export const TAG = "hunters-edge-sharing", HUNT_EFFECT_SLUG = "effect-hunt-prey", SHARE_EFFECT = /^effect-share-hunters-edge/, KEY = "prey-share";
/** Сколько союзников у черты, срабатывающей после «Охоты на добычу» с одной добычей (остальные черты с тегом — не здесь). */
export const PASSIVE_ALLIES = { "shared-prey": [1], "triple-threat": [2, 1] };   // индекс — число добыч минус один: сколько союзников получают доли

/** Чистая: черта с тегом группы. */
export const isSharer = (item) => item?.type !== "effect" && (item?.system?.traits?.otherTags ?? []).includes(TAG);

/** Чистая: Дар заступника-подобное — действие с тегом (а не пассивка с хуком на охоту). */
export const isBoon = (item) => isSharer(item) && item.system?.actionType?.value !== "passive";

/** Чистая: токены добычи — эффекты с меткой «hunted-prey» и токеном. */
export const preyUuids = (effects) => effects.filter((e) => e.type === "effect").flatMap((e) => (e.system?.rules ?? []).filter((r) => r.key === "TokenMark" && r.slug === "hunted-prey" && r.uuid).map((r) => r.uuid));

/** Чистая: раунды срока Дара заступника — «до конца следующего хода союзника». Союзник ходит позже текущего в этом раунде (инициатива ниже) — 0, уже ходил — 1. Нет боя — null (без срока). */
export const boonRounds = (currentInit, allyInit) => (currentInit == null || allyInit == null ? null : currentInit <= allyInit ? 1 : 0);

/** Чистая: ссылки на «Share Hunter's Edge» в HTML описания черты (после ItemAlteration pf2e). */
export const effectLinks = (html) => [...new Set([...String(html ?? "").matchAll(/Compendium\.pf2e\.feat-effects\.Item\.\w+/g)].map((m) => m[0]))];

/** Эффекты охотничьего преимущества для союзника: ссылки из описания черты, оставляем эффекты Share Hunter's Edge. */
async function edgeEffects(item) {
  const html = (await item.getDescription?.())?.value ?? item.system.description.value;
  const found = await Promise.all(effectLinks(html).map((u) => fromUuid(u)));
  return found.filter((e) => e && SHARE_EFFECT.test(e.slug ?? e.system?.slug ?? ""));
}

/** Выдать союзнику эффекты преимущества охотника на добычу prey. kind: "boon" | "shared"; rounds — срок (null — без срока). */
export async function share(hunter, ally, item, prey, kind, rounds = null) {
  const effects = await edgeEffects(item), { removeByKey } = await import("../apply.mjs");
  for (const e of effects) {
    const data = e.toObject();
    delete data._id;
    data.system.rules = markRules(data.system.rules, prey);
    data.system.context = { ...data.system.context, origin: { actor: hunter.uuid, token: null, item: item.uuid, spellcasting: null, rollOptions: [] }, target: { actor: ally.uuid, token: null }, roll: null };
    if (rounds !== null) data.system.duration = { ...data.system.duration, value: rounds, unit: "rounds", expiry: "turn-end", sustained: false };
    data.flags = { ...data.flags, [MOD]: { share: { hunter: hunter.uuid, kind } } };
    const key = `${KEY}:${hunter.uuid}:${e.id}:${prey}`;   // по эффекту на каждую добычу: метка TokenMark держит одну цель
    await removeByKey(ally, key);   // повторный Дар заступника обновляет срок
    await addEffect(ally, data, key);
  }
  if (effects.length) await whisper(hunter, L("builtin.share.done", { ally: esc(ally.name), hunter: esc(hunter.name) }), "hunt-prey");
  return effects.length;
}

/** Снять эффекты доли добычи охотника (kind "shared": новая охота). */
export async function dropShares(hunterUuid, kind = "shared") {
  for (const a of worldActors()) {
    const ids = a.items.filter((i) => i.type === "effect" && i.flags?.[MOD]?.share?.hunter === hunterUuid && i.flags[MOD].share.kind === kind).map((i) => i.id);
    if (ids.length) await queue(`actor:${a.uuid}`, async () => { await a.deleteEmbeddedDocuments("Item", ids); });
  }
}

/** Дар заступника: карточка действия с тегом группы, цель — союзник. */
export async function onMessage(message) {
  const item = message.flags?.pf2e?.origin?.type ? message.item : null, hunter = item?.actor, slug = itemSlug(item);
  if (!hunter || !isBoon(item) || paHas(slug)) return;
  const prey = preyUuids(hunter.itemTypes.effect)[0];
  if (!prey) return void ui.notifications.warn(L("builtin.share.needPrey", { name: hunter.name }));
  const ally = messageTargets(message)[0]?.actor;
  if (!ally || ally.uuid === hunter.uuid) return void ui.notifications.warn(L("builtin.share.needAlly", { name: hunter.name }));
  const c = game.combat;
  await share(hunter, ally, item, prey, "boon", c?.started ? boonRounds(c.combatant?.initiative, ally.combatant?.initiative) : null);
}

/** У игрока (runPlayerBuiltin): окно выбора союзника (scope.targets — токены-кандидаты) -> uuid токена | "none" | null. */
export async function pick(scope) {
  const res = await askHere(L("builtin.share.title"), `<p>${L("builtin.share.prompt", { name: esc(scope.actor?.name) })}</p>`, buttons(scope.targets.map(docOf)));
  return res?.action ?? null;
}
const buttons = (tokens) => [...tokens.map((t) => ({ id: t.uuid, label: t.name })), { id: "none", label: L("builtin.share.none") }];

const timers = new Map();

/** createItem у активного ведущего: у охотника появился эффект «Охота на добычу» (pf2e — действие PC, hunt-prey.mjs — NPC). Пачка эффектов одной охоты обрабатывается один раз. */
export function onCreate(item) {
  const hunter = item.type === "effect" && item.slug === HUNT_EFFECT_SLUG ? item.actor : null;
  if (!hunter) return;
  clearTimeout(timers.get(hunter.uuid));
  timers.set(hunter.uuid, setTimeout(() => { timers.delete(hunter.uuid); afterHunt(hunter).catch((e) => console.error(`${MOD} | prey-share`, e)); }, 400));
}

async function afterHunt(hunter) {
  await dropShares(hunter.uuid);
  const feat = hunter.items.find((i) => isSharer(i) && PASSIVE_ALLIES[itemSlug(i)] && !paHas(itemSlug(i)));
  const prey = preyUuids(hunter.itemTypes.effect);
  const allies = feat ? PASSIVE_ALLIES[itemSlug(feat)][prey.length - 1] ?? 0 : 0;
  const chosen = new Set([hunter.uuid]);
  for (let n = allies; n > 0; n--) {
    const cand = (canvas?.tokens?.placeables ?? []).filter((t) => t.actor && !chosen.has(t.actor.uuid) && t.actor.isAllyOf?.(hunter) && t.actor.isOfType?.("character", "npc", "familiar")).map((t) => t.document);
    if (!cand.length) break;
    const id = await askOwner(hunter, "share-pick", { targets: cand.map((t) => t.uuid) },
      async () => (await askHere(L("builtin.share.title"), `<p>${L("builtin.share.prompt", { name: esc(hunter.name) })}</p>`, buttons(cand)))?.action ?? null);
    const ally = cand.find((t) => t.uuid === id)?.actor;
    if (!ally) break;
    chosen.add(ally.uuid);
    for (const p of prey) await share(hunter, ally, feat, p, "shared");
  }
}
