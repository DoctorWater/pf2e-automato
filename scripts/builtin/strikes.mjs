// Общее для действий, в которые входит Удар (Двойной взмах, Двойной финт, Устрашающий удар): выбор оружия и MAP, броски атаки и урона.
// ponytail: «текущий» MAP pf2e не хранит (его выбирает игрок вариантом Удара) — спрашиваем в диалоге; по умолчанию без штрафа.
import { L } from "../util.mjs";
import { esc } from "./lib.mjs";

/** Чистая: 0..3 -> попал ли Удар. */
export const isHit = (degree) => degree >= 2;

/**
 * Чистая: оружие ближнего боя, удерживаемое одной рукой («по одному в каждой руке»); один предмет — один раз, а пара одной строкой
 * инвентаря (количество ≥ 2, напр. «Клинок-коготь» ×2) — дважды. strike: {item}.
 */
export function twoWeaponCandidates(strikes) {
  const seen = new Set();
  return strikes.flatMap((s) => {
    const it = s.item;
    if (!it?.isOfType?.("weapon") || !it.isMelee || it.system?.equipped?.carryType !== "held" || it.system.equipped.handsHeld !== 1) return [];
    if (seen.has(it.id)) return [];
    seen.add(it.id);
    return (it.system.quantity ?? 1) >= 2 ? [s, s] : [s];
  });
}

/** Чистая: любой готовый Удар ближнего боя (оружие в руках, безоружная атака, атака NPC); один предмет — один раз. */
export function meleeCandidates(strikes) {
  const seen = new Set();
  return strikes.filter((s) => s.ready !== false && s.item?.isMelee && !seen.has(s.item.id) && seen.add(s.item.id));
}

/**
 * Диалог: n выпадающих списков оружия (только если вариантов больше n) и MAP первого Удара.
 * labels: { title, picks: [label…], map, mapHint, ok }. -> { picks: [индексы], map } | null.
 */
export async function askStrikes(cands, n, labels) {
  const opt = (sel) => cands.map((s, i) => `<option value="${i}"${i === sel ? " selected" : ""}>${esc(s.item.name)}</option>`).join("");
  const picks = cands.length > n ? labels.picks.map((l, k) => `<div class="form-group"><label>${esc(l)}</label><select name="w${k}">${opt(k)}</select></div>`).join("") : "";
  const maxVar = Math.max(...cands.map((s) => s.variants.length)) - 1;
  const maps = [0, 1, 2].filter((i) => i <= maxVar).map((i) => `<option value="${i}">${esc(cands[0].variants[i]?.label ?? i)}</option>`).join("");
  const res = await foundry.applications.api.DialogV2.wait({
    window: { title: labels.title }, rejectClose: false,
    content: `${picks}<div class="form-group"><label>${esc(labels.map)}</label><select name="map">${maps}</select></div><p class="hint">${esc(labels.mapHint ?? L("builtin.strike.mapHint"))}</p>`,
    buttons: [{ action: "ok", label: labels.ok ?? L("builtin.strike.ok"), default: true, callback: (_e, button) => {
      const f = button.form.elements;
      return { picks: Array.from({ length: n }, (_, k) => Number(f[`w${k}`]?.value ?? k)), map: Number(f.map.value) };
    } }]
  });
  return res && typeof res === "object" ? res : null;
}

/** Strike берём заново: после переключателя/временного эффекта актёр пересобран. */
const fresh = (actor, s) => actor.system.actions.find((a) => a.item?.id === s.item.id && (a.item.altUsageType ?? null) === (s.item.altUsageType ?? null)) ?? s;

/** Бросок Удара вариантом i (0..2) по документу токена цели. -> { roll, degree }. */
export async function rollStrike(actor, strike, i, target, options = []) {
  const s = fresh(actor, strike);
  const roll = await s.variants[Math.min(i, s.variants.length - 1)].roll({ target: { document: target }, options });
  return { roll, degree: roll?.options?.degreeOfSuccess ?? null };
}

/** Бросок урона Удара (крит — critical). createMessage false — вернуть бросок без сообщения. */
export const rollDamage = (actor, strike, i, target, crit, createMessage = true) =>
  fresh(actor, strike)[crit ? "critical" : "damage"]({ target: { document: target }, createMessage, mapIncreases: i });

/** Подпись варианта MAP i у Удара. */
export const mapLabel = (strike, i) => strike.variants[Math.min(i, strike.variants.length - 1)]?.label ?? "";
