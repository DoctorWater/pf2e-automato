// Испуг и тошнота по ходам. pf2e 8.6 сам испуг не уменьшает (Combatant#onEndTurn трогает только продолжительный урон), поэтому:
// - pf2e.endTurn: испуг -1 (одно значение «испуг» = максимум экземпляров, значит уменьшаем КАЖДЫЙ; на 0 снимается);
// - pf2e.startTurn: шёпот про тошноту с кнопкой «Избавиться» (Стойкость против СЛ источника: успех -1, крит. успех -2, провал — ничего).
// Хуки pf2e вызывает только клиент активного ГМа (Combat#_manageTurnEvents) — исполняем на нём, если он лидер.
import { MOD, L, queue, callGM, isActiveGM, degreeFromTotal } from "./util.mjs";
import { modeOf } from "./settings.mjs";
import { esc, whisper, cardButton } from "./builtin/lib.mjs";

const WB = "xdy-pf2e-workbench", WB_KEY = "decreaseFrightenedConditionEachTurn", PA = "pf2e-automations";

/* ---------- Чистая часть (node-тесты) ---------- */

/** instances: [{id, value, locked}] — все экземпляры испуга; yielded — другой модуль (workbench/pf2e-automations) уже уменьшает. Запертые (grantee: restrict) не трогаем. -> [{id, to}] (to 0 = снять). */
export function frightenedPlan(instances, yielded = false) {
  if (yielded) return [];
  return instances.filter((i) => i.value > 0 && !i.locked).map((i) => ({ id: i.id, to: i.value - 1 }));
}

/** Степень Стойкости (0..3) -> на сколько падает тошнота: успех 1, крит. успех 2; провал и крит. провал — без изменений (pf2e Retch). */
export const retchDelta = (degree) => (degree === 3 ? 2 : degree === 2 ? 1 : 0);

/** Новое значение тошноты (0 = снять). */
export const retchValue = (value, degree) => Math.max(0, value - retchDelta(degree));

/** Экземпляры тошноты [{id, value, locked}] -> [{id, to}]: все незапертые со значением выше нового (видимое значение реально падает). */
export function retchPlan(instances, degree) {
  const top = Math.max(0, ...instances.filter((i) => !i.locked).map((i) => i.value ?? 0)), to = retchValue(top, degree);
  return instances.filter((i) => !i.locked && i.value > to).map((i) => ({ id: i.id, to }));
}

/** СЛ источника тошноты: items — состояние и его обёртка (flags[MOD].meta.message -> снимок use.dc). getMsg(id) -> сообщение | null. */
export function sourceDC(items, getMsg) {
  for (const it of items) {
    const id = it?.flags?.[MOD]?.meta?.message, dc = getMsg(id)?.flags?.[MOD]?.use?.dc;
    if (id && Number.isFinite(dc)) return dc;
  }
  return null;
}

/* ---------- Foundry ---------- */

const decreaserOn = () => {
  try {
    return (game.modules.get(WB)?.active && game.settings.get(WB, WB_KEY) === true)
      || (game.modules.get(PA)?.active && game.settings.get(PA, "decreaseFrightened") === true);
  } catch { return false; }
};

async function onEndTurn(combatant) {
  const actor = combatant?.actor;
  if (!isActiveGM() || !actor || modeOf("frightened") === "off") return;
  await queue(`actor:${actor.uuid}`, async () => {
    const inst = actor.itemTypes.condition.filter((c) => c.slug === "frightened").map((c) => ({ id: c.id, value: c.value ?? 0, locked: !!c.isLocked }));
    for (const { id, to } of frightenedPlan(inst, decreaserOn())) {
      try { await game.pf2e.ConditionManager.updateConditionValue(id, actor, to); }
      catch (e) { console.error(`${MOD} | frightened`, e); }
    }
  });
}

async function onStartTurn(combatant) {
  const actor = combatant?.actor;
  if (!isActiveGM() || !actor || modeOf("sickened") === "off") return;
  const c = actor.getCondition?.("sickened");
  if (!c) return;
  const dc = sourceDC([c, actor.items.get(c.flags?.pf2e?.grantedBy?.id)], (id) => game.messages.get(id));
  const field = dc == null ? `<input type="number" class="paf-dc-input" data-af-retch-dc placeholder="${L("turn.dc")}">` : "";
  await whisper(actor, L("turn.sickened", { name: esc(actor.name), value: c.value, dc: dc ?? "?" }),
    "retch", { retch: { actor: actor.uuid, dc } }, cardButton("data-af-retch", L("turn.retch")) + field);
}

/** ГМ: применить результат Стойкости к тошноте. Идемпотентности нет намеренно: каждая «Избавиться» — отдельное действие. */
export function applyRetch(actorUuid, degree) {
  return queue(`actor:${actorUuid}`, async () => {
    const actor = await fromUuid(actorUuid);
    const inst = actor?.itemTypes.condition.filter((c) => c.slug === "sickened").map((c) => ({ id: c.id, value: c.value ?? 1, locked: !!c.isLocked })) ?? [];
    if (!inst.length) return { ok: true, skipped: true };
    for (const { id, to } of retchPlan(inst, degree)) await game.pf2e.ConditionManager.updateConditionValue(id, actor, to);
    return { ok: true };
  });
}

/** Бросок у владельца (кнопка в шёпоте), применение — у ГМа. */
async function retch(h, dcInput) {
  const actor = await fromUuid(h.actor), dc = h.dc ?? (Number.isFinite(dcInput) ? dcInput : null);
  if (!actor?.saves?.fortitude) return;
  if (dc == null) return ui.notifications.warn(L("turn.needDC"));
  const r = await actor.saves.fortitude.roll({ dc: { value: dc }, extraRollOptions: ["action:retch"], skipDialog: false });
  const degree = r?.degreeOfSuccess ?? r?.options?.degreeOfSuccess ?? (r ? degreeFromTotal(r.total, dc, r.dice?.[0]?.total ?? null) : null);
  if (degree == null) return;   // бросок отменён
  const res = await callGM("applyRetch", h.actor, degree);
  if (!res?.ok || res.result?.ok === false) ui.notifications.warn(L("chat.failed", { reason: res?.result?.error ?? res?.reason }));
}

const retching = new Set();   // id сообщений с броском в полёте: избавляться можно несколько раз за ход, но не двойным кликом

function bind(message, html) {
  const h = message.flags?.[MOD]?.retch, root = html instanceof HTMLElement ? html : html?.[0];
  const btn = root?.querySelector?.("[data-af-retch]");
  if (!h || !btn) return;
  btn.addEventListener("click", async () => {
    if (retching.has(message.id)) return;
    retching.add(message.id);
    btn.disabled = true;
    try { await retch(h, root.querySelector("[data-af-retch-dc]")?.valueAsNumber); }
    catch (e) { console.error(`${MOD} | retch`, e); }
    finally {   // сообщение могло перерисоваться (всплывающий чат) — включаем все копии кнопки
      retching.delete(message.id);
      document.querySelectorAll(`[data-message-id="${message.id}"] [data-af-retch]`).forEach((b) => { b.disabled = false; });
      btn.disabled = false;
    }
  });
}

export function init() {
  Hooks.on("pf2e.endTurn", onEndTurn);
  Hooks.on("pf2e.startTurn", onStartTurn);
  Hooks.on("renderChatMessageHTML", bind);
}
