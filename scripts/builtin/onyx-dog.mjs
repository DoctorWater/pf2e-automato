// X5. Ониксовая собака: «отправка в чат» статуэтки = активация. Импортируем Guard Dog из Monster Core мировым актёром
// (токену неприсоединённого актёра нужен мировой актёр), ставим токен рядом с владельцем, помечаем флагом модуля.
// ИЗМЕНЕНИЕ МИРА: создаётся актёр Guard Dog (flags.pf2e-automato.summon); удаляется вместе с токеном при отзыве (кнопка у ГМа,
// истечение 6 ч игрового времени, dismiss()).
import { MOD, L } from "../util.mjs";
import { ask, castOrigin, whisper, esc, cardButton } from "./lib.mjs";

export const FIGURINE = "Compendium.pf2e.equipment-srd.Item.BANLXq8FhwqsDu0v";
export const GUARD_DOG = "Compendium.pf2e.pathfinder-monster-core.Actor.KHTYbQgR5hnFZdGL";
export const DURATION = 6 * 3600, WEEK = 7 * 24 * 3600;

export const isFigurine = (item) => !!item && (item._stats?.compendiumSource === FIGURINE || item.slug === "wondrous-figurine-onyx-dog");

/** Секунд до конца недельной перезарядки (0 — готово). */
export const cooldownLeft = (now, last) => (last == null ? 0 : Math.max(0, last + WEEK - now));

export const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Чистая: свободная позиция (в клетках) вплотную к владельцу, ближайшая к нему. origin/size/occupied: {x,y,w,h} в клетках. */
export function findSpot(origin, size, occupied) {
  const c = [];
  for (let y = origin.y - size.h; y <= origin.y + origin.h; y++) for (let x = origin.x - size.w; x <= origin.x + origin.w; x++) {
    const r = { x, y, w: size.w, h: size.h };
    if (!hit(r, origin)) c.push(r);
  }
  const d = (r) => Math.hypot(r.x + r.w / 2 - origin.x - origin.w / 2, r.y + r.h / 2 - origin.y - origin.h / 2);
  return c.sort((a, b) => d(a) - d(b)).find((r) => !occupied.some((o) => hit(r, o))) ?? null;
}

export async function onMessage(message) {
  const origin = castOrigin(message);
  if (origin?.type !== "equipment") return;
  const item = await fromUuid(origin.uuid);
  if (!isFigurine(item) || !item.actor) return;
  const owner = item.actor;
  const left = cooldownLeft(game.time.worldTime, item.getFlag(MOD, "summonedAt"));
  const note = left ? `<p><b>${L("builtin.onyx.cooldown", { days: Math.ceil(left / 86400) })}</b></p>` : "";
  const yes = await ask(L("builtin.onyx.title"), `<p>${L("builtin.onyx.prompt", { name: esc(owner.name) })}</p>${note}`,
    [{ id: "yes", label: L("builtin.onyx.yes") }, { id: "no", label: L("builtin.onyx.no") }]);
  if (yes !== "yes") return;
  const sp = message.speaker ?? {};
  const scene = (sp.scene && game.scenes.get(sp.scene)) ?? canvas.scene;
  const ownerToken = scene?.tokens.get(sp.token) ?? owner.getActiveTokens(true, true)[0];
  if (!scene || !ownerToken) return void ui.notifications.warn(L("builtin.onyx.noToken"));
  await summon(owner, item, ownerToken, scene);
}

export async function summon(owner, item, ownerToken, scene) {
  const src = await fromUuid(GUARD_DOG);
  if (!src) throw new Error(`нет актёра ${GUARD_DOG}`);
  const data = src.toObject();
  delete data._id; data.folder = null;
  data.ownership = { default: 0, ...Object.fromEntries(Object.entries(owner.ownership ?? {}).filter(([id, lvl]) => id !== "default" && lvl >= 3)) };
  data.flags = { ...data.flags, [MOD]: { summon: { owner: owner.uuid, item: item.uuid, expires: game.time.worldTime + DURATION } } };
  const dog = await Actor.implementation.create(data);
  try {
    const td = await dog.getTokenDocument({ disposition: ownerToken.disposition });
    const g = scene.grid.size, cell = (t) => ({ x: Math.round(t.x / g), y: Math.round(t.y / g), w: Math.max(1, Math.round(t.width)), h: Math.max(1, Math.round(t.height)) });
    const spot = findSpot(cell(ownerToken), { w: Math.max(1, Math.round(td.width)), h: Math.max(1, Math.round(td.height)) }, scene.tokens.map(cell));
    if (!spot) throw new Error(L("builtin.onyx.noSpot"));
    const tdata = td.toObject();
    delete tdata._id;
    const [token] = await scene.createEmbeddedDocuments("Token", [{ ...tdata, x: spot.x * g, y: spot.y * g }]);
    await item.setFlag(MOD, "summonedAt", game.time.worldTime);
    await whisper(owner, L("builtin.onyx.summoned", { name: esc(owner.name), dog: esc(token.name) }), "onyx-dog", {}, cardButton(`data-af-dismiss="${dog.id}"`, L("builtin.onyx.dismiss")));
    return { dog, token };
  } catch (e) { await dog.delete(); throw e; }
}

/** Отзыв: токены и мировой актёр. dogId — id актёра с флагом summon. */
export async function dismiss(dogId) {
  const dog = game.actors.get(dogId);
  if (!dog?.getFlag(MOD, "summon")) return false;
  for (const scene of game.scenes) {
    const ids = scene.tokens.filter((t) => t.actorId === dogId).map((t) => t.id);
    if (ids.length) await scene.deleteEmbeddedDocuments("Token", ids);
  }
  await dog.delete();
  return true;
}

export async function expire(worldTime) {
  for (const a of game.actors.filter((x) => x.getFlag(MOD, "summon")?.expires <= worldTime)) await dismiss(a.id);
}

/** Кнопка «Отозвать» в шёпоте (только ГМ). */
export function bindDismiss(message, html) {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  root?.querySelectorAll?.("[data-af-dismiss]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    await dismiss(b.dataset.afDismiss).catch((e) => ui.notifications.error(String(e?.message ?? e)));
  }));
}
