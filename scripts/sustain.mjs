// Жизненный цикл поддерживаемого заклинания (docs/plan-sustain.md, волна 1). Всё исполняет клиент активного ГМа-лидера.
// Якорь — видимый эффект «Поддержание: <заклинание>» на авторе со своим slug (sustain-<slug>), чтобы removeEffect/extendEffect по slug предмета его не задевали.
// Шаг правила с sustain:true привязывает выданное к якорю (meta.sustainOf = ключ якоря); якорь кончается — привязанное снимается (apply.removeBound).
// Якорь не создаётся из системного эффекта заклинания с duration.sustained (Traveling Workshop): это вторая модель срока и режим на 8 часов — волна 2.
import { MOD, L, flagPath, queue, guardActiveGM, callGM, sluggify } from "./util.mjs";
import { itemDuration, slugOf } from "./rules.mjs";
import { effectSource, whisper, esc } from "./builtin/lib.mjs";
import { cardButton } from "./card.mjs";
import { S } from "./settings.mjs";
import { removeBound } from "./apply.mjs";

/** Слушатели Поддержания ({anchor, actor, pos}): events.mjs запускает способность фамильяра. count() зовёт их без ожидания — окно выбора не держит очередь якоря. */
export const sustained = new Set();

/* ---------- чистая часть ---------- */

export const anchorKey = (msgId) => `${msgId}:sustain`;
export const anchorSlug = (spellSlug) => `sustain-${spellSlug || "spell"}`;
/** Позиция в бою: {combat, round}; вне боя (или бой не начат) — пустая. */
export const posOf = (combat) => (combat && combat.round > 0 ? { combat: combat.id, round: combat.round } : { combat: null, round: null });
/** Последнее поддержание (или сотворение) именно в этом бою и раунде. Другой бой = не поддержано. */
export const sameTurn = (last, pos) => !!pos?.combat && last?.combat === pos.combat && last.round === pos.round;
/** Конец хода автора в pos: поддержание этого раунда не было — пропуск. */
export const missedAt = (last, pos) => !sameTurn(last, pos);
/** Смена раунда до pos.round: ход автора в предыдущем раунде уже прошёл, поддержание было не раньше него. */
export const missedBefore = (last, pos) => !(!!pos?.combat && last?.combat === pos.combat && last.round >= pos.round - 1);
// ponytail: срок якоря — по тексту заклинания (itemDuration); у «sustained» без срока и «1 minute, or 8 hours» это null — берём 10 минут (потолок Поддержания по правилам)
export const anchorDuration = (item) => itemDuration(item?.system?.duration) ?? { value: 10, unit: "minutes" };

/** Бой, где актёр участвует и который идёт (round > 0): позиция {combat, round}; иначе пустая. game.combat — не обязательно тот бой. */
export const posOfActor = (actor) => posOf(globalThis.game?.combats?.find?.((c) => c.round > 0 && c.combatants.some((x) => x.actor?.uuid === actor?.uuid)));
const alive = (anchor) => !!anchor?.actor?.items?.some?.((i) => i.id === anchor.id);

const metaOf = (item) => item?.flags?.[MOD]?.meta;
const dataOf = (item) => item?.flags?.[MOD]?.sustain;
export const findAnchor = (actor, key) => actor?.items?.find((i) => metaOf(i)?.source === "sustain" && metaOf(i).key === key) ?? null;
export const anchorsOf = (actor) => actor?.items?.filter((i) => i.type === "effect" && metaOf(i)?.source === "sustain") ?? [];

/** Сообщение Sustain pf2e: предмет-действие с листа (origin, slug sustain) либо SimpleAction (h4.action с локализованным названием). */
export function isSustainMessage(message) {
  const o = message?.flags?.pf2e?.origin;
  if (o) return o.type !== "spell" && slugOf(o) === "sustain";
  const m = /<h4[^>]*class="action"[^>]*>\s*<strong>([^<]*)<\/strong>/.exec(message?.flavor ?? "");
  return !!m && m[1].trim() === game.i18n.localize("PF2E.Actions.Sustain.Title").trim();
}

/* ---------- якорь ---------- */

// ponytail: автоякорь фамильяра (events.runFamiliar) и якорь шага sustain:true делят ключ anchorKey(message.id): кто пришёл первым, создаёт якорь и шлёт offer,
// второй только добавляет привязку. Будущему hex со sustain:true: offer уже ушёл «тихим» текстом; prune по откату шага автоякорь без привязок не снимает.
/** Якорь по ключу на авторе (идемпотентно по meta.key) + актёр-получатель в список привязок (target null — автоякорь наговора: привязок нет). -> {item, created} */
export function attach(author, target, { key, msg, item, token, at, pulse, create = true }) {
  return queue(`actor:${author.uuid}`, async () => {
    let anchor = findAnchor(author, key), created = false;
    if (!anchor && create) {
      const d = anchorDuration(item), tok = token ?? author.getActiveTokens?.(true, true)?.[0];
      const data = effectSource({
        name: L("sustain.name", { name: item?.name ?? "?" }), img: item?.img,
        description: `<p>${esc(L("sustain.desc"))}</p>${item?.uuid ? `<p>@UUID[${item.uuid}]</p>` : ""}`,
        duration: { value: d.value, unit: d.unit, expiry: null, sustained: true },
        origin: { actor: author.uuid, token: tok?.uuid, item: item?.uuid }, target: { actor: author.uuid, token: tok?.uuid }
      });
      data.system.slug = anchorSlug(item?.slug ?? sluggify(item?.name));
      // message "ev:…" — как у эффектов событий: onItem не гоняет по якорю onEvent effect-created/deleted
      data.flags = { [MOD]: { meta: { key, source: "sustain", message: "ev:sustain", origin: item?.uuid ?? null, by: author.uuid }, sustain: { msg, src: item?.uuid ?? null, actors: [], last: at ?? posOfActor(author), ...(pulse && { pulse: true }) } } };
      [anchor] = await author.createEmbeddedDocuments("Item", [data]);
      created = !!anchor;
    }
    if (!anchor) return { item: null, created: false };
    if (pulse && !dataOf(anchor)?.pulse) await anchor.update({ [flagPath("sustain", "pulse")]: true });   // якорь уже поставил шаг sustain:true — без флага prune снял бы его при откате
    const actors = dataOf(anchor)?.actors ?? [];
    if (target && !actors.includes(target.uuid)) await anchor.update({ [flagPath("sustain", "actors")]: [...actors, target.uuid] });
    // откат → «Применить» заново: карточка с кнопками по этому ключу уже есть — второй не шлём
    if (created && !globalThis.game?.messages?.find?.((m) => m.flags?.[MOD]?.sustain?.key === key)) Promise.resolve(offer(author, anchor, item, key, !target && !pulse)).catch((e) => console.error(`${MOD} | sustain offer`, e));
    return { item: anchor, created };
  });
}

/** Откат: у якоря не осталось живых привязок — якорь удаляется как откат (без «конца заклинания»). */
export async function prune(author, key) {
  const anchor = findAnchor(author, key);
  if (!anchor || dataOf(anchor)?.pulse) return false;   // якорь заклинания с импульсом живёт и без привязок
  const all = dataOf(anchor)?.actors ?? [], live = [];
  for (const uuid of all) if ((await fromUuid(uuid))?.items?.some((i) => metaOf(i)?.sustainOf === key)) live.push(uuid);
  if (live.length) {
    if (live.length !== all.length) await queue(`actor:${author.uuid}`, () => anchor.update({ [flagPath("sustain", "actors")]: live }));
    return false;
  }
  await queue(`actor:${author.uuid}`, () => anchor.delete({ [MOD]: { undo: true } }));
  return true;
}

/** Шёпот автору и ГМу с кнопками. Карточка живёт, пока жив якорь; поздний клик — «уже закончено». */
function offer(author, anchor, item, key, quiet = false) {
  const buttons = cardButton(`data-af-sustain="support"`, L("sustain.support")) + cardButton(`data-af-sustain="dismiss"`, L("sustain.dismiss"), "paf-ghost");
  // автоякорь (фамильяр): ГМу не шумим на каждый наговор — одна строка только владельцам; без владельцев-игроков Поддержание засчитает разбор чата
  return whisper(author, L(quiet ? "sustain.offerQuiet" : "sustain.offer", { name: esc(author.name), spell: esc(item?.name ?? "?") }), "sustain", { sustain: { actor: author.uuid, key } }, buttons, quiet ? (game.users.some((u) => !u.isGM && author.testUserPermission?.(u, "OWNER")) ? "players" : "gm") : null);   // нет владельца-игрока — то же короткое предложение ГМу
}

/* ---------- конец ---------- */

/** Хук deleteItem: якорь исчез (кнопка, пропуск, срок, ручное удаление) — снять привязанное. Откат (undo) не считается концом. */
export async function onDeleteItem(item, options) {
  if (item?.type !== "effect" || metaOf(item)?.source !== "sustain" || options?.[MOD]?.undo || !guardActiveGM()) return;
  const key = metaOf(item).key, lost = [];
  for (const uuid of new Set(dataOf(item)?.actors ?? [])) {
    const actor = await fromUuid(uuid).catch(() => null);
    if (!actor) { lost.push(uuid); continue; }
    try { await removeBound(actor, key); } catch (e) { console.error(`${MOD} | sustain end`, e); lost.push(actor.name); }
  }
  if (lost.length) globalThis.ui?.notifications?.warn(L("sustain.unreachable", { spell: item.name, list: lost.join(", ") }));
}

/** Удалить якорь под очередью его ключа (не вложенно в run). -> true, если удалили. */
const end = (anchor) => queue(`sustain:${metaOf(anchor).key}`, async () => { if (!alive(anchor)) return false; await anchor.delete(); return true; });

/** Проверить якоря актёров: истёк срок (на случай removeExpiredEffects=off) или пропущено. mode "turn" — конец хода автора, "round" — смена раунда. Шёпот ГМу со списком снятого. */
export async function check(actors, pos, mode) {
  let total = 0;
  for (const actor of new Set(actors)) {
    const gone = [];
    for (const anchor of anchorsOf(actor)) {
      try {   // сбой одного якоря не обрывает проверку остальных
        const last = dataOf(anchor)?.last;
        const reason = anchor.isExpired ? "expired" : (mode === "turn" ? missedAt(last, pos) : pos.round >= 2 && missedBefore(last, pos)) ? "missed" : null;
        const quiet = !(dataOf(anchor)?.actors ?? []).length && !dataOf(anchor)?.pulse;   // автоякорь без привязок: снимать нечего, «пропущено» не шлём
        if (reason && await end(anchor)) { total++; if (!quiet) gone.push(L(`sustain.ended.${reason}`, { name: esc(actor.name), spell: esc(anchor.name) })); }
      } catch (e) { console.error(`${MOD} | sustain check`, e); }
    }
    if (gone.length) { await whisper(actor, gone.join("<br>"), "sustain", {}).catch((e) => console.error(`${MOD} | sustain whisper`, e)); }   // ГМ и владельцы актёра
  }
  return total;
}

/** pf2e.endTurn (клиент ГМа): ход автора кончается без Поддержания этого раунда — якорь заканчивается. */
export async function onEndTurn(combatant, encounter) {
  if (!guardActiveGM() || !combatant?.actor) return;
  // pf2e.endTurn приходит уже после перехода хода: у последнего по инициативе encounter.round = R+1. Раунд конца хода — флаг, который pf2e пишет до хука.
  const round = combatant.flags?.pf2e?.roundOfLastTurnEnd ?? encounter.previous?.round ?? encounter.round;
  await check([combatant.actor], { combat: encounter.id, round }, "turn");
}

/** Страховка: начало любого хода (pf2e.startTurn у активного ГМа: раунд уже новый) и переход в лидеры — пропущенные ходы (skip/delay, endTurn не вызван). */
export async function sweep(combat) {
  if (!guardActiveGM() || !combat) return;
  await check(combat.combatants.map((c) => c.actor).filter(Boolean), posOf(combat), "round");
}

/* ---------- Поддержание ---------- */

let posting = 0;   // пока модуль сам выкладывает Sustain pf2e, разбор чата его не засчитывает второй раз

/** Засчитать Поддержание якорю (под очередью ключа). -> "expired" | "fresh" | "again" */
async function count(anchor) {
  if (!alive(anchor)) return "gone";
  if (anchor.isExpired) { await anchor.delete(); return "expired"; }
  const pos = posOfActor(anchor.actor);
  if (sameTurn(dataOf(anchor)?.last, pos)) return "again";   // сотворено или уже поддержано в этом раунде: срок не продлевается, повтор не ошибка
  await anchor.update({ [flagPath("sustain", "last")]: pos });
  for (const f of sustained) Promise.resolve().then(() => f({ anchor, actor: anchor.actor, pos })).catch((e) => console.error(`${MOD} | sustain listener`, e));
  return "fresh";
}

/** Кнопка «Поддержать» / «Прекратить» шёпота (через gm()-путь, проверка владельца в main.mjs). Поддержание само выкладывает Sustain pf2e. */
export function run(actorUuid, key, how = "support") {
  return queue(`sustain:${key}`, async () => {
    const actor = await fromUuid(actorUuid), anchor = findAnchor(actor, key);
    if (!anchor) return { ok: true, skipped: true };
    if (how === "dismiss") { await anchor.delete(); return { ok: true, ended: "dismiss" }; }
    const r = await count(anchor);
    if (r === "expired") return { ok: true, ended: "expired" };
    if (r !== "fresh") return { ok: true, result: r };   // повтор в раунде: срок не продлевается, Sustain в чат второй раз не выкладываем
    const sustainAction = game.pf2e?.actions?.get?.("sustain");
    posting++;
    try { await sustainAction?.use({ actors: [actor] }); }
    catch (e) { console.warn(`${MOD} | sustain action`, e); }
    finally { posting--; }
    return { ok: true, result: r };
  });
}

/** createChatMessage: Sustain из чата pf2e (SimpleAction или действие с листа). Засчитывается единственному якорю автора; несколько — подсказка. Идемпотентно по id сообщения. */
export async function onMessage(message) {
  if (posting || !guardActiveGM() || !S.get("sustain.parse") || message.flags?.[MOD]?.sustainSeen || !isSustainMessage(message)) return;
  const o = message.flags?.pf2e?.origin;
  const actor = (o?.actor ? await fromUuid(o.actor).catch(() => null) : null) ?? message.actor;
  const anchors = anchorsOf(actor);
  if (!anchors.length) return;
  await message.update({ [flagPath("sustainSeen")]: true });
  if (anchors.length > 1) return void await whisper(actor, L("sustain.pick", { name: esc(actor.name) }), "sustain", {}, "", "gm");
  const key = metaOf(anchors[0]).key;
  await queue(`sustain:${key}`, () => count(anchors[0]));
}

/* ---------- кнопки в чате ---------- */

function bind(message, html) {
  const h = message.flags?.[MOD]?.sustain, root = html instanceof HTMLElement ? html : html?.[0];
  if (!h?.key || !h.actor || !root?.querySelectorAll) return;
  for (const btn of root.querySelectorAll("[data-af-sustain]")) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const res = await callGM("sustainRun", h.actor, h.key, btn.dataset.afSustain);
        if (!res?.ok) globalThis.ui?.notifications?.warn(L("chat.failed", { reason: res?.reason }));
        else if (res.result?.skipped) globalThis.ui?.notifications?.warn(L("sustain.gone"));
      } catch (e) { console.error(`${MOD} | sustain`, e); }
      finally { btn.disabled = false; }
    });
  }
}

export function init() {
  Hooks.on("renderChatMessageHTML", bind);
  Hooks.on("deleteItem", (item, options) => { onDeleteItem(item, options).catch((e) => console.error(`${MOD} | sustain.delete`, e)); });
  Hooks.on("createChatMessage", (m) => { onMessage(m).catch((e) => console.error(`${MOD} | sustain.message`, e)); });
  Hooks.on("pf2e.endTurn", (c, e) => { onEndTurn(c, e).catch((err) => console.error(`${MOD} | sustain.endTurn`, err)); });
  Hooks.on("pf2e.startTurn", (_c, combat) => { sweep(combat).catch((e) => console.error(`${MOD} | sustain.round`, e)); });
}
