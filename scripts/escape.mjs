// «Освободиться»: у шага apply с признаком escape жертва получает шёпот с кнопками навыков (Освобождение, pf2e: Атлетика / Акробатика / безоружная атака против СЛ).
// Механика как у «Избавиться от тошноты» (turn-conditions.mjs): бросок у владельца, снятие у ГМа (callGM). Кнопка не одноразовая: каждая попытка — действие жертвы.
import { MOD, L, queue, callGM, DEGREES } from "./util.mjs";
import { esc, whisperDC, cardButton } from "./builtin/lib.mjs";

/* ---------- Чистая часть (node-тесты) ---------- */

/** СЛ шага: готовая > СЛ автора (dcStat: "spell" — заклинательная, иначе навык; не вычислилась — null, жертва вводит сама).
 *  useDc (СЛ источника из use.dc) — только без dcStat и только для испытаний: у проверки это защита жертвы (КБ/Стойкость). */
export const escapeDC = (esc, { spellDc = null, statDc = null, useDc = null } = {}) =>
  esc.dc ?? (esc.dcStat === "spell" ? spellDc : esc.dcStat ? statDc : useDc) ?? null;

/** Название для шёпота: у состояния — локализованное, у эффекта — исходный предмет (заклинание/действие), иначе имя документа. */
export function escapeLabel(item, originItem) {
  const key = item?.type === "condition" && globalThis.CONFIG?.PF2E?.conditionTypes?.[item.slug];
  return (key && game.i18n.localize(key)) || (item?.type === "condition" ? item.name : originItem?.name ?? item?.name ?? "");
}

/** Степень (0..3) из записи результата действия pf2e {outcome, roll}; null — броска не было. */
export function escapeDegree(entry) {
  const i = DEGREES.indexOf(entry?.outcome);
  return i >= 0 ? i : entry?.roll?.degreeOfSuccess ?? entry?.roll?.options?.degreeOfSuccess ?? null;
}

/** Успех и крит. успех освобождают. */
export const frees = (degree) => degree >= 2;

/** Что удалить: созданные шагом документы и всё, что выдано ими через GrantItem (обёртка-срок «отцепляет» состояние, а не удаляет). items: [{id, grantedById}]. */
export const escapeIds = (rootIds, items) => items.filter((i) => rootIds.includes(i.id) || rootIds.includes(i.grantedById)).map((i) => i.id);

/* ---------- Foundry ---------- */

/** ГМ (applyOps): шёпот жертве и ведущему. item — созданный шагом документ (обёртка или состояние). */
export function offerEscape(actor, item, esc_, dc, originItem = null) {
  const field = dc == null ? `<input type="number" class="paf-dc-input" data-af-escape-dc placeholder="${L("turn.dc")}">` : "";
  const buttons = esc_.stats.map((s) => cardButton(`data-af-escape="${s}"`, L(`turn.escapeStat.${s}`))).join("") + field;
  return whisperDC(actor, "turn.escape", { name: esc(actor.name), what: esc(escapeLabel(item, originItem)) }, dc,
    "escape", { escape: { actor: actor.uuid, dc, items: [item.uuid] } }, buttons);
}

/** ГМ: степень освобождения -> снять документы шага. Повтор безвреден: уже снятое пропускается. */
export function applyEscape(actorUuid, itemUuids, degree) {
  if (!frees(degree)) return { ok: true, freed: false };
  return queue(`actor:${actorUuid}`, async () => {
    const actor = await fromUuid(actorUuid);
    if (!actor) return { ok: true, freed: false };
    const ids = escapeIds(itemUuids.map((u) => u.split(".").pop()).filter((id) => actor.items.has(id)),
      actor.items.map((i) => ({ id: i.id, grantedById: i.flags?.pf2e?.grantedBy?.id })));
    if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
    return { ok: true, freed: true, gone: !ids.length };
  });
}

async function escapeRoll(h, stat, dcInput) {
  const actor = await fromUuid(h.actor), dc = h.dc ?? (Number.isFinite(dcInput) ? dcInput : null);
  if (!actor) return;
  if (!h.items.some((u) => actor.items.has(u.split(".").pop()))) return ui.notifications.info(L("turn.escapeGone", { name: actor.name }));   // уже снято: действие не тратим
  if (dc == null) return ui.notifications.warn(L("turn.needEscapeDC"));
  const res = await game.pf2e.actions.get("escape").use({ actors: [actor], statistic: stat, difficultyClass: dc });
  const degree = escapeDegree(res?.[0]);
  if (degree == null) return;   // бросок отменён
  const r = await callGM("applyEscape", h.actor, h.items, degree);
  if (!r?.ok || r.result?.ok === false) return ui.notifications.warn(L("chat.failed", { reason: r?.result?.error ?? r?.reason }));
  if (r.result?.gone) ui.notifications.info(L("turn.escapeGone", { name: actor.name }));   // снято, пока шёл бросок
  else if (r.result?.freed) ui.notifications.info(L("turn.escaped", { name: actor.name }));
}

const rolling = new Set();   // сообщения с броском в полёте: попыток может быть много, но не двойным кликом

function bind(message, html) {
  const h = message.flags?.[MOD]?.escape, root = html instanceof HTMLElement ? html : html?.[0];
  if (!h || !root) return;
  for (const btn of root.querySelectorAll("[data-af-escape]")) {
    btn.addEventListener("click", async () => {
      if (rolling.has(message.id)) return;
      rolling.add(message.id);
      btn.disabled = true;
      try { await escapeRoll(h, btn.dataset.afEscape, root.querySelector("[data-af-escape-dc]")?.valueAsNumber); }
      catch (e) { console.error(`${MOD} | escape`, e); }
      finally { rolling.delete(message.id); btn.disabled = false; }
    });
  }
}

export function init() { Hooks.on("renderChatMessageHTML", bind); }
