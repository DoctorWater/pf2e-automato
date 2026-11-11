// Кнопка «Перезарядка NdM» на карточке использования любой способности с перезарядкой (авто, условной, заданной в Мастерской; mech.rechargeSpec).
// Пока замок rc_<id> идёт, кнопка заблокирована; автобросок при использовании (метка rc_* на карточке) её тоже гасит: одна карточка — один бросок.
// Активна только кнопка последней карточки использования предмета этим актёром (по origin.uuid: у несвязанных копий NPC он свой). Вне боя — disabled.
// Состояние — DOM: refresh() пересчитывает все кнопки в открытых окнах чата без перерисовки сообщений. Ссылку «#Recharge» на карточке гасим, пока кнопка активна (два пути — двойной бросок).
import { MOD, L } from "./util.mjs";
import { modeOf } from "./settings.mjs";
import { combatOf } from "./builtin/lib.mjs";
import { rechargeSpec } from "./mech.mjs";
import { rcButtonState } from "./builtin/limit-text.mjs";
import { isUseCard, startRecharge, PENDING_MS } from "./builtin/impulse-gate.mjs";

const BTN = ".paf-recharge", LINK = "a[data-paf-rc]", RECHARGE = /recharge|перезаряд/i;
const PLURALS = new Set(["one", "few", "many", "other"]);   // как chat.pendingText: zero/two -> other

const keyOf = (m) => m.flags?.pf2e?.origin?.uuid ?? null;

// origin.uuid -> id последней карточки использования: один проход при первом обращении, дальше — только create/deleteChatMessage (update карту не меняет)
let lastCache = null;
const cardKey = (m) => (m.flags?.pf2e?.context?.type !== "damage-roll" ? keyOf(m) : null);
function lastMap() {
  if (lastCache) return lastCache;
  const map = new Map();
  for (const m of game.messages.contents) { const k = cardKey(m); if (k && isUseCard(m)) map.set(k, m.id); }   // дешёвое (origin.uuid) — до isUseCard
  return (lastCache = map);
}
const busy = new Set();   // id карточек, где бросок перезарядки уже идёт: второй клик не даёт второго броска

/** Чистая: карточка из текущего боя — по метке перезарядки, штампу хода или времени создания боя. */
export function inCombatCard(message, combat) {
  const f = message.flags?.[MOD], marked = Object.entries(f?.limitMarks ?? {}).filter(([k]) => k.startsWith("rc_"));
  if (marked.length) return marked.every(([, v]) => v?.c === combat.id);
  if (f?.act?.turn) return String(f.act.turn).startsWith(`${combat.id}:`);
  return (message.timestamp ?? 0) >= (combat._stats?.createdTime ?? 0);
}

function stateOf(b, ids = b.dataset.ids.split(",")) {
  const m = game.messages.get(b.dataset.msg), actor = m?.actor;
  if (!m || !actor) return null;
  const combat = combatOf(game.combats, actor), inCombat = !!combat?.started;
  const st = rcButtonState({
    ids, flags: actor.flags?.[MOD], marks: m.flags?.[MOD]?.limitMarks, fresh: Date.now() - (m.timestamp ?? 0) < PENDING_MS, inCombat,
    current: inCombat && inCombatCard(m, combat), last: keyOf(m) ? lastMap().get(keyOf(m)) === m.id : true, combatId: combat?.id, round: combat?.round
  });
  return { m, actor, st };
}

/** Подсказка отключённой кнопки; склонение «раундов» — по образцу chat.pendingText. */
function tipOf(st) {
  switch (st.reason) {
    case "outOfCombat": return L("builtin.limit.rcOutOfCombat");
    case "notLast": return L("builtin.limit.rcNotLast");
    case "rolled": return L("builtin.limit.rcRolled", { until: st.until });
    case "wait": { const cat = new Intl.PluralRules(game.i18n.lang).select(st.left); return L(`builtin.limit.rcWait.${PLURALS.has(cat) ? cat : "other"}`, { n: st.left, until: st.until }); }
    default: return "";
  }
}

function paint(b) {
  const r = stateOf(b);
  if (!r) return;
  const { st } = r, wait = busy.has(b.dataset.msg), tip = wait ? "" : tipOf(st), off = st.disabled || wait;
  // aria-disabled, не disabled: кнопка остаётся в порядке фокуса, подсказка читается; клик по неактивной даёт предупреждение (onClick)
  if (off) { b.setAttribute("aria-disabled", "true"); b.dataset.tooltip = tip; } else { b.removeAttribute("aria-disabled"); delete b.dataset.tooltip; }
  // ссылка «#Recharge»: гасим, пока кнопка активна; вне боя и при блоке она живая
  for (const a of b.closest(".message-content")?.querySelectorAll(LINK) ?? []) {
    const quench = !st.disabled;   // идущий бросок (busy) ссылку тоже держит погашенной
    a.classList.toggle("paf-rc-off", quench);
    if (quench) a.dataset.tooltip = L("chat.rechargeButton"); else delete a.dataset.tooltip;
  }
}

async function onClick(ev, b) {
  ev.preventDefault();
  const id = b.dataset.msg;
  if (busy.has(id)) return;
  const spec = rechargeSpec(game.messages.get(id)?.item), r = spec && stateOf(b, spec.ids);
  if (!r || r.st.disabled) { ui.notifications.warn(r ? tipOf(r.st) : L("builtin.limit.rcNotLast")); return void refresh(); }
  if (spec.dice !== b.dataset.dice) { b.dataset.dice = spec.dice; b.textContent = L("builtin.limit.rcButton", { dice: spec.dice }); }   // срок изменили в Мастерской после отрисовки карточки
  busy.add(id);
  paint(b);
  try { await startRecharge(r.m, r.actor, spec); }
  catch (e) { console.warn(`${MOD} | recharge button`, e); ui.notifications.warn(L("builtin.limit.rcFailed")); }
  finally { busy.delete(id); refresh(); }
}

function render(message, html) {
  if (modeOf("limits") === "off" || !isUseCard(message)) return;
  const actor = message.actor;
  if (!game.user.isGM && !(actor.isOwner && message.isAuthor)) return;   // игрок — на своей карточке у своего персонажа; запись на чужое сообщение прав не даёт
  const spec = rechargeSpec(message.item), root = html.querySelector(".message-content");
  if (!spec || !root) return;
  const box = document.createElement("div"), b = document.createElement("button");
  box.className = "message-buttons paf-recharge-box";
  b.type = "button";
  b.className = "paf-recharge";
  b.textContent = L("builtin.limit.rcButton", { dice: spec.dice });
  Object.assign(b.dataset, { msg: message.id, ids: spec.ids.join(","), dice: spec.dice });
  b.addEventListener("click", (ev) => { onClick(ev, b); });
  box.append(b);
  root.append(box);   // в самом конце карточки; блок модуля рисуется асинхронно и переносит кнопку (chat.mjs)
  for (const a of html.querySelectorAll("a.inline-roll, a[data-formula]")) if (RECHARGE.test(a.dataset?.flavor ?? "")) a.dataset.pafRc = "1";
  if (!html.dataset.pafRcGuard) {
    html.dataset.pafRcGuard = "1";
    html.addEventListener("click", (ev) => { const a = ev.target.closest?.(".paf-rc-off"); if (a) { ev.preventDefault(); ev.stopImmediatePropagation(); } }, true);
  }
  paint(b);
}

/** Пересчитать все кнопки в открытых окнах чата. */
export function refresh() {
  for (const b of document.querySelectorAll(BTN)) paint(b);
}

const touches = (ch) => ch?.flags?.[MOD] !== undefined;   // в v14 удаление флага приходит ForcedDeletion внутри flags[MOD]

export function init() {
  Hooks.on("renderChatMessageHTML", render);
  for (const h of ["updateCombat", "deleteCombat", "createCombatant", "deleteCombatant", "updateChatMessage"]) Hooks.on(h, () => refresh());
  Hooks.on("createChatMessage", (m) => { const k = lastCache && cardKey(m); if (k && isUseCard(m)) lastCache.set(k, m.id); refresh(); });
  Hooks.on("deleteChatMessage", () => { lastCache = null; refresh(); });
  Hooks.on("updateActor", (_a, ch) => { if (touches(ch)) refresh(); });
  Hooks.on("updateToken", (_t, ch) => { if (touches(ch?.delta)) refresh(); });
}
