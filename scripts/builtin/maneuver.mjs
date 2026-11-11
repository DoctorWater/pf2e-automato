// «Манёвр атакой заклинания вместо Атлетики»: Telekinetic Maneuver (core и копии NPC), Magnetic Attraction. Кнопки манёвров на карточке сотворения;
// бросок — действие pf2e со statistic "spell-attack" (то же, что у `[[/act grapple statistic=spell-attack]]` в Desperate Surge). Степени успеха применяет
// actions.onRollMessage (правила каталога disarm/trip/shove/reposition). Кнопку pf2e «Spell Attack» на такой карточке прячет damage-button.attackOrder (один путь).
// ОГРАНИЧЕНИЕ pf2e: Разоружение/Толчок/Сбивание добавляют модификатор мощи лучшего экипированного оружия с чертой манёвра независимо от statistic.
import { MOD, L } from "../util.mjs";
import { modeOf } from "../settings.mjs";
import { itemRange, markFar } from "../range.mjs";
import { itemSlug, messageTargets, docOf } from "./lib.mjs";
import { askMap } from "../checks.mjs";
import { mechOf } from "../mech.mjs";
import { isCounterGate } from "../hold.mjs";

/** slug заклинания -> манёвры, из которых игрок выбирает один за сотворение. */
export const SPELLS = {
  "telekinetic-maneuver": ["disarm", "shove", "reposition", "trip"],
  "magnetic-attraction": ["disarm"]
};
// uuid действий pf2e (компендиум actionspf2e): ссылка в тексте не зависит от языка копии
const IDS = { disarm: "Dt6B1slsBy8ipJu9", shove: "7blmbDrQFNfdT731", reposition: "lOE4yjUnETTdaf2T", trip: "ge56Lu1xXVFYUnLP" };
export const TITLE = { disarm: "PF2E.Actions.Disarm.Title", shove: "PF2E.Actions.Shove.Title", reposition: "PF2E.Actions.Reposition.Title", trip: "PF2E.Actions.Trip.Title" };

/** Чистая: основа локализованного названия для поиска в падежах перевода («Толчок» → «толч» находит «Толчка»): первое слово без двух последних букв, не короче 4. */
export const titleStem = (title) => { const w = String(title ?? "").trim().split(/\s+/)[0].toLowerCase(); return w.length > 5 ? w.slice(0, -2) : w.slice(0, 4); };

/** Чистая: манёвры заклинания по тексту копии (uuid-ссылка, английское название или основа локализованного — pf2ru ставит ссылки не на все); текст ничего не назвал — весь список таблицы. */
export function maneuverList(slug, text, titles = {}) {
  const all = SPELLS[slug];
  if (!all) return [];
  const t = String(text ?? ""), low = t.toLowerCase();
  const found = all.filter((m) => t.includes(IDS[m]) || new RegExp(`\\b${m}\\b`, "i").test(t) || (titles[m] && /[а-яё]/i.test(titles[m]) && low.includes(titleStem(titles[m]))));
  return found.length ? found : all;
}

const localTitles = () => Object.fromEntries(Object.entries(TITLE).map(([m, k]) => [m, globalThis.game?.i18n?.localize(k) ?? ""]));

/** Манёвры предмета по тексту, без режима и переопределения; [] — не наша группа. */
export const maneuversAuto = (item) => (item?.type === "spell" ? maneuverList(itemSlug(item), item.system?.description?.value, localTitles()) : []);

/** Чистая: переопределение предмета (mech.maneuvers) пересекается с таблицей SPELLS[slug]; пусто или вне таблицы — вычисленные. */
export function pickManeuvers(slug, auto, over) {
  const mine = over?.length ? (SPELLS[slug] ?? []).filter((m) => over.includes(m)) : [];
  return mine.length ? mine : auto;
}

/** Манёвры карточки/предмета; [] — не наша группа или модуль выключен (mode.macro). */
export const maneuversOf = (item) => (item?.type === "spell" && modeOf("macro") !== "off" ? pickManeuvers(itemSlug(item), maneuversAuto(item), mechOf(item).maneuvers) : []);

const busy = new Set();   // id карточек с броском в полёте (двойной клик)
const usedHere = new Set();   // карточки, помеченные локально (нажал не автор сообщения и не ГМ — флаг записать нельзя)

/** Параметры use() действия pf2e: цель — Actor или токен (TokenDocument pf2e молча заменяет целями игрока). */
export function useParams(actor, target, map) {
  return { actors: [actor], target: target?.object ?? target?.actor ?? target, statistic: "spell-attack", ...(map && { multipleAttackPenalty: map }) };
}

async function roll(message, slug, ev) {
  const actor = message.actor, item = message.item;
  if (busy.has(message.id) || isCounterGate(message)) return;   // сотворение удержано/сорвано контрзаклинанием
  const targets = messageTargets(message);
  if (targets.length !== 1) return void ui.notifications.warn(L("builtin.maneuver.needTarget", { name: item.name }));
  let target = docOf(targets[0]);
  if (!ev?.altKey) {   // дальность заклинания: вне неё действия нет (обход Alt — решение ГМа)
    const src = message.token?.object ?? actor.getActiveTokens?.()[0];
    const far = markFar([{ uuid: target.uuid }], src, itemRange(item, message.flags?.pf2e?.origin?.rollOptions))[0]?.far;
    if (far) return void ui.notifications.warn(L("builtin.maneuver.far", { name: target.name, d: Math.round(far.d), r: far.r }));
  }
  busy.add(message.id);
  try {
    let map = 0;
    if (item.traits?.has("attack")) { map = await askMap(); if (map == null) return; }   // заклинание с чертой attack считается атакой для штрафа
    const done = await game.pf2e.actions.get(slug).use(useParams(actor, target, map));
    if (!done?.length) return;   // бросок не состоялся (ошибка контекста выдана pf2e)
    usedHere.add(message.id);
    if (message.isAuthor || game.user.isGM) await message.setFlag(MOD, "maneuver", slug);
    else for (const b of document.querySelectorAll(`[data-message-id="${message.id}"] .paf-maneuver-box`)) b.hidden = true;
  } catch (e) { console.error(`${MOD} | maneuver`, e); ui.notifications.error(String(e?.message ?? e)); }
  finally { busy.delete(message.id); }
}

/** Кнопки манёвров под карточкой сотворения (владелец актёра). После первого броска карточка кнопок не получает: один манёвр за сотворение. */
export function bind(message, html) {
  if (message.flags?.pf2e?.context?.type !== "spell-cast" || !message.flags.pf2e.origin?.rollOptions?.includes("origin:action:slug:cast-a-spell") || !message.actor?.isOwner || message.flags?.[MOD]?.maneuver || usedHere.has(message.id) || isCounterGate(message)) return;
  const list = maneuversOf(message.item), card = html.querySelector(".chat-card");
  if (!list.length || !card) return;
  const box = document.createElement("div");
  box.className = "message-buttons paf-maneuver-box";
  for (const slug of list) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = game.i18n.localize(TITLE[slug]);
    b.addEventListener("click", (ev) => { ev.preventDefault(); roll(message, slug, ev); });
    box.append(b);
  }
  card.after(box);
}
