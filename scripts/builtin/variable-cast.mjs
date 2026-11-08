// Заклинания с переменным временем («1 to 3», «1 or 2», «2 or 3»): pf2e не спрашивает число действий и не кладёт `item:cast:actions:N`
// (glyph «1 - 3» не входит в 1|2|3, pf2e.mjs:53322; у Силового залпа нет overlays/правил). Спрашиваем у автора сообщения сразу после сотворения —
// ячейка уже потрачена ОДИН раз самой системой, повторно колдовать не нужно. Выбор пишем в сообщение: origin.rollOptions += `origin:item:cast:actions:N`
// и flags.pf2e-automato.cast.actions. Для «снарядов по числу действий» (Силовой залп) — распределение по целям и один бросок урона на цель.
import { L, MOD, flagPath } from "../util.mjs";
import { isLeader } from "../leader.mjs";
import { inRange } from "../range.mjs";
import { askHere, castOrigin, esc } from "./lib.mjs";

const CHOICES = { "1 to 3": [1, 2, 3], "1 or 2": [1, 2], "2 or 3": [2, 3] };
/** Слаги заклинаний «столько снарядов, сколько действий» (Magic Missile — старое название, оба в pf2e). */
export const MISSILE_SLUGS = new Set(["force-barrage", "magic-missile"]);

const CAST = "origin:action:slug:cast-a-spell";

/** Чистая: сообщение сотворения (origin) переменного заклинания, число действий которого ещё спросят (use.mjs ставит state.awaitingActions). */
export const asksActions = (origin, time) => origin?.type === "spell" && !!origin.rollOptions?.includes(CAST) && !!actionChoices(time);

/** Чистая: допустимые числа действий по system.time.value или null (время не переменное). */
export const actionChoices = (time) => CHOICES[String(time ?? "").trim().toLowerCase()] ?? null;

/** Чистая: у заклинания варианты pf2e по числу действий (overlays с time: Heal, Harm, Qi Blast…) — число выбирают кнопкой варианта на карточке, своё окно не нужно. */
export const pf2eVariants = (spell) => Object.values(spell?._source?.system?.overlays ?? {}).some((o) => o?.system?.time?.value);

/** Чистая: число действий выбранного варианта pf2e (origin:item:cast:actions:N); 0 — вариант не выбран или время не 1–3 («2 rounds»). */
export const variantActions = (origin) => (origin?.variant ? Number(origin.rollOptions?.map((o) => /^origin:item:cast:actions:([123])$/.exec(o)?.[1]).find(Boolean) ?? 0) : 0);

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

export const askActions = (name, choices) => askHere(name, `<p>${L("builtin.cast.prompt", { name: esc(name) })}</p>`, choices.map((n) => ({ id: String(n), label: L(`builtin.cast.act.${n}`) })));

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

/** Чистая: правка ещё не созданного сообщения урона — цель в контексте и подпись снарядов. pf2e для не-атак цель в контекст не кладёт
 *  (pf2e.mjs:18420), а читает её ChatMessagePF2e.target (pf2e.mjs:29357: flags.pf2e.context.target.token = UUID токена) и pf2e-toolbelt. */
export function targetPatch(msg, t, n) {
  if (!t) return null;
  const target = { actor: t.actor.uuid, token: t.uuid };
  return {
    flavor: `${msg.flavor ?? ""}<p>${L("builtin.cast.volley", { n, target: esc(t.name) })}</p>`,
    ...(msg.flags?.pf2e?.context ? { "flags.pf2e.context.target": target, "flags.pf2e.target": target } : {}),
    // toolbelt (targetHelper) уже записал сюда все цели пользователя и читает свой флаг раньше context.target
    ...(msg.flags?.["pf2e-toolbelt"]?.targetHelper?.targets ? { "flags.pf2e-toolbelt.targetHelper.targets": [t.uuid] } : {})
  };
}

/** Один бросок урона заклинания с подменённой (в памяти) формулой. spell.rollDamage возвращает DamageRoll, а сообщение pf2e создаёт само
 *  внутри (DamagePF2e.roll) -> подписываем его в preCreateChatMessage. Формулу pf2e разбирает синхронно (loadVariant / getDamage до первого await),
 *  поэтому возвращаем её сразу после вызова: подмена не переживёт prepareData актёра и не наложится на соседний бросок.
 *  Умножается только system.damage; добавка усиления (heightening.damage) не масштабируется — см. rollMissiles (при ней бросаем по одному). */
async function rollScaled(spell, castRank, n, target) {
  const sets = [spell.system.damage, spell._source?.system?.damage].filter(Boolean);   // variant строится из _source (loadVariant -> toObject)
  const saved = sets.map((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.formula])));
  for (const d of sets) for (const v of Object.values(d)) v.formula = scaleFormula(v.formula, n);
  const el = document.createElement("div");
  el.dataset.castRank = String(castRank);
  const sign = (msg) => {
    const pf = msg.flags?.pf2e;
    if (!msg.isAuthor || pf?.context?.type !== "damage-roll" || pf.origin?.uuid !== spell.uuid) return;
    Hooks.off("preCreateChatMessage", sign);
    const patch = targetPatch(msg, target, n);
    if (patch) msg.updateSource(patch);
  };
  Hooks.on("preCreateChatMessage", sign);
  let roll;
  try { roll = spell.rollDamage({ target: el }); }
  finally { sets.forEach((d, i) => { for (const [k, f] of Object.entries(saved[i])) d[k].formula = f; }); }
  try { return await roll; }
  finally { Hooks.off("preCreateChatMessage", sign); }
}

/** preCreateChatMessage (только на вкладке, создающей сообщение): снимок целей каста. Исполняет лидер вкладок ГМа —
 *  у него свои (пустые) цели, поэтому без снимка снаряды ушли бы без цели. */
export function snapTargets(message) {
  const origin = castOrigin(message);
  if (origin?.type !== "spell" || !actionChoices(fromUuidSync(origin.uuid ?? "")?.system?.time?.value)) return;
  message.updateSource({ [flagPath("castTargets")]: [...(game.user.targets ?? [])].map((t) => (t.document ?? t).uuid) });
}

/** Цели каста: снимок castTargets, затем use.targets (scripts/use.mjs); нет снимка — текущие цели. */
async function missileTargets(message) {
  const own = message.flags?.[MOD]?.castTargets;
  const all = message.flags?.[MOD]?.use?.targets ?? [], snap = inRange(all);   // все вне дальности — целей нет, а не «текущие цели»
  if (own) {   // пустой снимок — сотворили без целей
    const far = new Set(all.filter((t) => t.far).map((t) => t.uuid));
    return (await Promise.all(own.filter((u) => !far.has(u)).map((u) => fromUuid(u)))).filter((d) => d?.actor);
  }
  const docs = all.length ? await Promise.all(snap.map((t) => fromUuid(t.uuid))) : [...(game.user.targets ?? [])].map((t) => t.document ?? t);
  return docs.filter((d) => d?.actor);
}

export async function rollMissiles(message, spell, actions) {
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
    for (const k of heightened ? Array(n).fill(1) : [n]) await rollScaled(spell, castRank, k, t);
  }
}

/** createChatMessage на КАЖДОМ клиенте и вкладке. Игрок: у себя (две вкладки — побеждает та, что первой записала выбор).
 *  ГМ: только лидер вкладок своего пользователя (не активный ГМ мира: сотворил может и второй ГМ). Снимает state.awaitingActions на любом выходе. */
export async function onMessage(message) {
  if (!message.isAuthor || message.flags?.[MOD]?.cast?.actions) return;
  if (game.user.isGM && !isLeader()) return;
  const origin = castOrigin(message);
  if (origin?.type !== "spell" || !origin.rollOptions?.includes(CAST)) return;
  // awaitingActions ставит автор (use.mjs) до создания сообщения; снимаем в том же update, что пишет число; на отмене и любой ошибке — без опции
  const release = { [flagPath("use", "state", "awaitingActions")]: false };
  const standing = () => !!game.messages.get(message.id)?.flags?.[MOD]?.use?.state?.awaitingActions;
  let spell = null, actions = 0, byVariant = false;
  try {
    spell = origin.uuid ? await fromUuid(origin.uuid) : null;
    const choices = actionChoices(spell?.system?.time?.value);
    if (!choices) return;
    if (pf2eVariants(spell)) { byVariant = true; return; }   // флаг снимет use.variantChosen по кнопке варианта pf2e
    actions = Number((await askActions(spell.name, choices).catch(() => null))?.action);
    if (!choices.includes(actions)) { actions = 0; return; }
    if (game.messages.get(message.id)?.flags?.[MOD]?.cast?.actions) { actions = 0; return; }   // другая вкладка того же игрока уже выбрала (и сняла флаг)
    await message.update({
      "flags.pf2e.origin.rollOptions": [...origin.rollOptions, `origin:item:cast:actions:${actions}`],
      [flagPath("cast")]: { actions },
      ...release
    });
  } finally {
    if (!byVariant && standing()) await message.update(release);
  }
  if (actions && MISSILE_SLUGS.has(spell.slug)) await rollMissiles(message, spell, actions);
}
