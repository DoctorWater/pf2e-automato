// Общее для действий, в которые входит Удар (Двойной взмах, Двойной финт, Устрашающий удар): выбор оружия и MAP, броски атаки и урона.
// ponytail: «текущий» MAP pf2e не хранит (его выбирает игрок вариантом Удара) — спрашиваем в диалоге; по умолчанию без штрафа.
import { L, sharedDialog } from "../util.mjs";
import { esc } from "./lib.mjs";
import { settledDegree } from "../hold.mjs";
import { isPair } from "./dual-wield.mjs";

/** Чистая: 0..3 -> попал ли Удар. */
export const isHit = (degree) => degree >= 2;

/**
 * Чистая: оружие ближнего боя, удерживаемое одной рукой («по одному в каждой руке»); один предмет — один раз, а пара одной строкой
 * инвентаря (количество ≥ 2, напр. «Клинок-коготь» ×2) — дважды: стопка одноручного оружия в одной руке или в двух
 * (по одному в каждой руке: флаг dual модуля, либо handsHeld 2 без two-hand-*; см. dual-wield.mjs isPair). Одно одноручное в двух руках — не пара. strike: {item}.
 */
export function twoWeaponCandidates(strikes) {
  const seen = new Set();
  return strikes.flatMap((s) => {
    const it = s.item, eq = it?.system?.equipped, pair = isPair(it);
    if (!it?.isOfType?.("weapon") || !it.isMelee) return [];
    if (!pair && !(eq?.carryType === "held" && eq.handsHeld === 1 && (it.system.usage?.hands ?? 1) === 1)) return [];
    if (seen.has(it.id)) return [];
    seen.add(it.id);
    return pair ? [s, s] : [s];
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
  const res = await sharedDialog({
    title: labels.title,
    content: `${picks}<div class="form-group"><label>${esc(labels.map)}</label><select name="map">${maps}</select></div><p class="hint">${esc(labels.mapHint ?? L("builtin.strike.mapHint"))}</p>`,
    buttons: [{ action: "ok", label: labels.ok ?? L("builtin.strike.ok") }]
  });
  const f = res?.form;
  return f ? { picks: Array.from({ length: n }, (_, k) => Number(f[`w${k}`] ?? k)), map: Number(f.map) } : null;
}

/** Strike берём заново: после переключателя/временного эффекта актёр пересобран. */
const fresh = (actor, s) => actor.system.actions.find((a) => a.item?.id === s.item.id && (a.item.altUsageType ?? null) === (s.item.altUsageType ?? null)) ?? s;

/** Бросок Удара вариантом i (0..2) по документу токена цели. -> { roll, degree }. */
export async function rollStrike(actor, strike, i, target, options = []) {
  const s = fresh(actor, strike);
  let msg = null;
  const roll = await s.variants[Math.min(i, s.variants.length - 1)].roll({ target: { document: target }, options, callback: (_r, _o, m) => { msg = m; } });
  // удержанный ради переброса бросок (hold.mjs) — не итог: ждём выпуск или переброс
  return { roll, degree: await settledDegree(msg, roll?.options?.degreeOfSuccess ?? null) };
}

/** Бросок урона Удара (крит — critical). createMessage false — вернуть бросок без сообщения. */
export const rollDamage = (actor, strike, i, target, crit, createMessage = true) =>
  fresh(actor, strike)[crit ? "critical" : "damage"]({ target: { document: target }, createMessage, mapIncreases: i });

/** Подпись варианта MAP i у Удара. */
export const mapLabel = (strike, i) => strike.variants[Math.min(i, strike.variants.length - 1)]?.label ?? "";
