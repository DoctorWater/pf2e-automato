// Заклинания с переменным временем («1 to 3», «1 or 2», «2 or 3»): pf2e не спрашивает число действий и не кладёт `item:cast:actions:N`
// (glyph «1 - 3» не входит в 1|2|3, pf2e.mjs:53322; у Силового залпа нет overlays/правил). Спрашиваем у автора сообщения сразу после сотворения —
// ячейка уже потрачена ОДИН раз самой системой, повторно колдовать не нужно. Выбор пишем в сообщение: origin.rollOptions += `origin:item:cast:actions:N`
// и flags.pf2e-automato.cast.actions. Для «снарядов по числу действий» (Силовой залп) — распределение по целям и один бросок урона на цель.
import { L, MOD, flagPath } from "../util.mjs";
import { isLeader } from "../leader.mjs";
import { askHere, castOrigin, esc } from "./lib.mjs";

const CHOICES = { "1 to 3": [1, 2, 3], "1 or 2": [1, 2], "2 or 3": [2, 3] };
/** Слаги заклинаний «столько снарядов, сколько действий» (Magic Missile — старое название, оба в pf2e). */
export const MISSILE_SLUGS = new Set(["force-barrage", "magic-missile"]);

/** Чистая: допустимые числа действий по system.time.value или null (время не переменное). */
export const actionChoices = (time) => CHOICES[String(time ?? "").trim().toLowerCase()] ?? null;

/** Чистая: снарядов всего = действия × (1 + по одному на каждые 2 ранга выше базового: «+2 — ещё снаряд за действие»). */
export const missileCount = (actions, castRank, baseRank = 1) => actions * (1 + Math.max(0, Math.floor(((castRank ?? baseRank) - baseRank) / 2)));

/** Чистая: поровну по кругу: (5, 2) -> [3, 2]. */
export const evenSplit = (total, n) => Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));

/** Чистая: распределение корректно — целые >= 0 с суммой total. */
export const validSplit = (counts, total) => counts.every((c) => Number.isInteger(c) && c >= 0) && counts.reduce((a, b) => a + b, 0) === total;

/** Чистая: формула урона одного снаряда -> суммарная формула n снарядов в одну цель (складываются в один бросок). */
export function scaleFormula(formula, n) {
  const f = String(formula ?? "").trim();
  const m = /^(\d+)d(\d+)(?:\s*\+\s*(\d+))?$/.exec(f);
  if (m) return `${m[1] * n}d${m[2]}${m[3] ? `+${m[3] * n}` : ""}`;
  return Array(n).fill(f).join(" + ");
}

const askActions = (name, choices) => askHere(name, `<p>${L("builtin.cast.prompt", { name: esc(name) })}</p>`, choices.map((n) => ({ id: String(n), label: L("builtin.cast.actions", { n }) })));

async function askSplit(name, targets, total) {
  let counts = evenSplit(total, targets.length);
  for (let tries = 0; tries < 3; tries++) {
    const rows = targets.map((t, i) => `<div class="form-group"><label>${esc(t.name)}</label><input type="number" name="t${i}" min="0" max="${total}" step="1" value="${counts[i]}"></div>`).join("");
    const res = await askHere(name, `<p>${L("builtin.cast.split", { total })}</p>${rows}`, [{ id: "ok", label: L("builtin.cast.roll") }]);
    if (!res) return null;
    const next = targets.map((_, i) => Number(res.form?.[`t${i}`]));
    if (validSplit(next, total)) return next;
    counts = evenSplit(total, targets.length);
    ui.notifications.warn(L("builtin.cast.splitBad", { total }));
  }
  return evenSplit(total, targets.length);
}

/** Один бросок урона заклинания с подменённой (в памяти, сразу восстанавливается) формулой: pf2e читает её синхронно в начале rollDamage.
 *  Умножается только system.damage; добавка усиления (heightening.damage) не масштабируется — см. rollMissiles (при ней бросаем по одному). */
async function rollScaled(spell, castRank, n) {
  const sets = [spell.system.damage, spell._source?.system?.damage].filter(Boolean);   // variant строится из _source (loadVariant -> toObject)
  const saved = sets.map((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.formula])));
  for (const d of sets) for (const v of Object.values(d)) v.formula = scaleFormula(v.formula, n);
  const el = document.createElement("div");
  el.dataset.castRank = String(castRank);
  let p;
  try { p = spell.rollDamage({ target: el }); }
  finally { sets.forEach((d, i) => { for (const [k, f] of Object.entries(saved[i])) d[k].formula = f; }); }
  return p;
}

/** Подписать сообщение урона целью. pf2e для не-атак цель в контекст не кладёт (pf2e.mjs:53114), а читает её ChatMessagePF2e.target
 *  (pf2e.mjs:29357: flags.pf2e.context.target.token = UUID токена) и pf2e-toolbelt (flags.pf2e.context.target.token). */
export async function signTarget(msg, t, n) {
  if (!msg?.update || !t) return;
  const ctx = msg.flags?.pf2e?.context;
  await msg.update({
    flavor: `${msg.flavor ?? ""}<p>${L("builtin.cast.volley", { n, target: esc(t.name) })}</p>`,
    ...(ctx ? { "flags.pf2e.context.target": { actor: t.actor.uuid, token: t.uuid } } : {})
  });
}

/** Цели каста: снимок use.targets, записанный клиентом автора в момент каста (scripts/use.mjs); нет снимка — текущие цели автора. */
async function missileTargets(message) {
  const snap = message.flags?.[MOD]?.use?.targets ?? [];
  const docs = snap.length ? await Promise.all(snap.map((t) => fromUuid(t.uuid))) : [...(game.user.targets ?? [])].map((t) => t.document ?? t);
  return docs.filter((d) => d?.actor);
}

async function rollMissiles(message, spell, actions) {
  const castRank = message.flags?.pf2e?.origin?.castRank ?? spell.rank;
  const total = missileCount(actions, castRank, spell.baseRank ?? 1);
  const all = await missileTargets(message);
  let plan;
  if (all.length <= 1) plan = [[all[0] ?? null, total]];
  else {
    const counts = await askSplit(spell.name, all, total);
    if (!counts) return;
    plan = all.map((t, i) => [t, counts[i]]).filter(([, c]) => c > 0);
  }
  const heightened = Object.keys(spell.system.heightening?.damage ?? {}).length > 0;   // добавка усиления не умножается -> по одному снаряду
  for (const [t, n] of plan) {
    for (const k of heightened ? Array(n).fill(1) : [n]) await signTarget(await rollScaled(spell, castRank, k), t, k);
  }
}

/** createChatMessage на КАЖДОМ клиенте и вкладке. Игрок: у себя (две вкладки — побеждает та, что первой записала выбор).
 *  ГМ: только лидер вкладок своего пользователя (не активный ГМ мира: сотворил может и второй ГМ), окно общее (sharedDialog, первый ответ побеждает). */
export async function onMessage(message) {
  if (!message.isAuthor || message.flags?.[MOD]?.cast) return;
  if (game.user.isGM && !isLeader()) return;
  const origin = castOrigin(message);
  if (origin?.type !== "spell" || !origin.rollOptions?.includes("origin:action:slug:cast-a-spell")) return;
  const spell = origin.uuid ? await fromUuid(origin.uuid) : null;
  const choices = actionChoices(spell?.system?.time?.value);
  if (!choices) return;
  const actions = Number((await askActions(spell.name, choices))?.action);
  if (!choices.includes(actions)) return;
  if (game.messages.get(message.id)?.flags?.[MOD]?.cast) return;   // другая вкладка того же игрока уже выбрала
  await message.update({
    "flags.pf2e.origin.rollOptions": [...origin.rollOptions, `origin:item:cast:actions:${actions}`],
    [flagPath("cast")]: { actions }
  });
  if (MISSILE_SLUGS.has(spell.slug)) await rollMissiles(message, spell, actions);
}
