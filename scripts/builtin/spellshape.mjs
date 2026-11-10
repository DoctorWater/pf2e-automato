// Метамагия (spellshape-черты pf2e: «Дальнее заклинание», «Расширенное заклинание» и т.п.). В pf2e каждая даёт toggleable RollOption
// `spellshape` с одной подопцией (значок «Метамагия» на листе и в TAH); предикаты заклинаний — `spellshape:<подопция>`.
// Переключатель нам не нужен — как у «Один выстрел, один труп»: 1) миграция убирает его у предмета и запоминает подопцию во флаге;
// 2) по сообщению об использовании действия активный ГМ вешает на актёра эффект с тем же RollOption (не toggleable);
// 3) сотворение эффект НЕ снимает: урон, атака и область по карточке считаются позже по ТЕКУЩИМ опциям актёра (pf2e пересчитывает черты
//    заклинания). Эффект помечается «потрачен сообщением X» (флаг spentBy, суффикс в имени); снимается следующим сотворением
//    (другое сообщение) и по концу хода (в бою); вне боя — только следующим сотворением.
// 4) mode.macro = off: переключатель возвращается из флага черты (restoreItem), при auto снимается снова.
// Метамагия с дополнительным выбором (тип урона, ChoiceSet и пр.) или несколькими подопциями не трогается: переключатель остаётся.
import { L, MOD, flagPath, queue } from "../util.mjs";
import { slugOf } from "../rules.mjs";
import { addEffect, castOrigin, combatOf, effectSource, esc, UNTIL_TURN_END, whisper } from "./lib.mjs";

export const KEY = "spellshape";
const CAST = "origin:action:slug:cast-a-spell";
const UNLIMITED = { value: -1, unit: "unlimited" };

const isShape = (r) => r?.key === "RollOption" && r.option === KEY && r.toggleable === true;

/** Чистая: правила -> { rules, changed, option }. Снимается ровно один toggleable RollOption `spellshape` с одной подопцией, если других выборов нет. */
export function stripToggle(rules = []) {
  const shapes = rules.filter(isShape);
  const sub = shapes[0]?.suboptions;
  const extra = rules.some((r) => r !== shapes[0] && (r?.key === "ChoiceSet" || (r?.key === "RollOption" && r.toggleable)));
  if (shapes.length !== 1 || !Array.isArray(sub) || sub.length !== 1 || !sub[0]?.value || extra) return { rules, changed: false, option: null };
  return { rules: rules.filter((r) => r !== shapes[0]), changed: true, option: String(sub[0].value) };
}

/** Чистая: правила черты с возвращённым переключателем (как у pf2e); переключатель уже есть — null. */
export function withToggle(rules = [], option, name) {
  if (rules.some(isShape)) return null;
  return [...rules, { key: "RollOption", option: KEY, toggleable: true, mergeable: true, placement: "spellcasting", label: "PF2E.TraitSpellshape", suboptions: [{ label: name, value: option }] }];
}

const DERIVED = new Set(["reach-spell"]);   // slug метамагии NPC без переключателя pf2e, у которой есть потребитель опции (range.mjs); следующая — сюда

/** Подопция метамагии предмета: флаг (миграция переключателя), иначе у способности NPC без переключателя — по slug. Предмет не пишется: откат нулевой. */
export function optionOf(item) {
  const f = item?.flags?.[MOD]?.[KEY];
  if (typeof f === "string") return f;
  if (!["feat", "action"].includes(item?.type) || (item.actor ?? item.parent)?.type !== "npc" || (item.system?.rules ?? []).some(isShape)) return null;
  const slug = slugOf(null, item);
  return DERIVED.has(slug) ? slug : null;
}

/** Чистая: сообщение pf2e -> "cast" (настоящее сотворение: карточка заклинания с rollOption cast-a-spell) | "use" (карточка действия/черты) | null. */
export function kindOf(origin) {
  if (origin?.type === "spell") return origin.rollOptions?.includes(CAST) ? "cast" : null;
  return origin?.type === "feat" || origin?.type === "action" ? "use" : null;
}

/** Чистая: правила эффекта — те же опции, что ставил бы переключатель. */
export const effectRules = (option) => [{ key: "RollOption", option: KEY }, { key: "RollOption", option: `${KEY}:${option}` }];

const shapeEffects = (items) => [...items].filter((i) => i.type === "effect" && i.flags?.[MOD]?.meta?.key === KEY);
const effectOf = (actor) => shapeEffects(actor.items)[0];
const removeEffect = (actor) => queue(`actor:${actor.uuid}`, async () => { await effectOf(actor)?.delete(); });
/** Другое действие или бросок: эффект, ещё не потраченный сотворением, выходит. Потраченный нужен урону и области уже брошенного сотворения — его снимет следующее сотворение. */
const dropUnspent = (actor) => queue(`actor:${actor.uuid}`, async () => { const e = effectOf(actor); if (e && !e.flags?.[MOD]?.spentBy) await e.delete(); });

/** Чистая: подопции `spellshape:*` уже потраченных эффектов — pf2e их ещё учитывает (карточка досчитывается), проверка дальности нет. */
export const spentOptions = (items) => shapeEffects(items).filter((e) => e.flags?.[MOD]?.spentBy)
  .flatMap((e) => (e.system?.rules ?? []).map((r) => r.option)).filter((o) => o?.startsWith(`${KEY}:`));

const isAct = (o) => o?.type === "feat" || o?.type === "action";
/** Чистая: сообщение — другое действие или бросок актёра, не сотворение (TraitDescriptionSpellshape: «следующее действие»). Карточки и броски заклинаний (origin spell) не в счёт;
 *  спасброски и урон — не действия: урон идёт за атакой или сотворением. Проверка навыка/Восприятия — действие, только если запрошена как действие (опция action:* или черты
 *  действия в контексте): тайная Внимательность и запрос ГМа метамагию не сжигают. Использование действия без броска (self-effect: Raise a Shield) — действие. */
export const breaksShape = (m) => {
  const pf = m?.flags?.pf2e, o = pf?.origin, ct = pf?.context?.type;
  if (o?.type === "spell") return false;
  if (ct === "attack-roll") return true;
  if (ct === "skill-check" || ct === "perception-check") return (pf.context.options ?? []).some((x) => String(x).startsWith("action:")) || !!pf.context.traits?.length;
  return ct && ct !== "self-effect" ? false : isAct(o);
};
const whoOf = (m) => m?.flags?.pf2e?.origin?.actor ?? m?.actor?.uuid ?? null;

/** Чистая: гонка «нажал метамагию и сразу сотворил» — эффекта ещё нет. messages — от старых к новым; shapeOf(uuid) — подопция черты (optionOf).
 *  Использование метамагии без сотворения после него -> `spellshape:<подопция>`, иначе null. */
export function recentShape(messages, actorUuid, shapeOf) {
  for (const m of [...messages].slice(-50).reverse()) {
    if (whoOf(m) !== actorUuid) continue;
    const o = castOrigin(m), kind = o && kindOf(o);
    if (kind === "cast") return null;
    const opt = kind === "use" && shapeOf(o.uuid);
    if (opt) return `${KEY}:${opt}`;
    if (breaksShape(m)) return null;   // другое действие или бросок после метамагии: срок вышел
  }
  return null;
}

/** Сотворение: эффект первый раз помечается потраченным, следующим другим сообщением — снимается. */
const spend = (actor, messageId) => queue(`actor:${actor.uuid}`, async () => {
  const e = effectOf(actor), by = e?.flags?.[MOD]?.spentBy;
  if (!e || by === messageId) return;
  if (by) await e.delete();
  else await e.update({ name: L("builtin.spellshape.spent", { name: e.name }), [flagPath("spentBy")]: messageId });
});

export async function migrateItem(item) {
  if (!["feat", "action"].includes(item?.type)) return;
  const { rules, changed, option } = stripToggle(item._source?.system?.rules ?? item.system.rules);
  if (changed) await item.update({ "system.rules": rules, [`flags.${MOD}.${KEY}`]: option });
}

export async function restoreItem(item) {
  const option = item?.flags?.[MOD]?.[KEY];
  if (!["feat", "action"].includes(item?.type) || typeof option !== "string") return;
  const rules = withToggle(item._source?.system?.rules ?? item.system.rules, option, item.name);
  if (rules) await item.update({ "system.rules": rules });
}

/** off: переключатели возвращаются; иначе — миграция (снятие). */
export const syncItem = (item, off) => (off ? restoreItem(item) : migrateItem(item));

export async function syncAll(off) {
  const actors = [...game.actors, ...game.scenes.contents.flatMap((s) => s.tokens.filter((t) => !t.actorLink).map((t) => t.actor))];
  for (const a of actors) {
    if (off) for (const e of shapeEffects(a?.items ?? [])) await e.delete();   // иначе опции эффекта и переключателя задвоятся
    for (const i of a?.items ?? []) await syncItem(i, off);
  }
}

/** Клиент автора: нажал метамагию, а активного ГМа нет — эффект некому повесить. */
export function warnNoGM(message) {
  const origin = castOrigin(message);
  if (!origin || kindOf(origin) !== "use" || message.author?.id !== game.user.id || game.users.activeGM) return;
  if (optionOf(fromUuidSync(origin.uuid ?? ""))) ui.notifications.warn(L("noGM"));
}

export async function onMessage(message) {
  const origin = castOrigin(message), actor = message.actor, kind = origin && actor && kindOf(origin);
  if (kind === "cast") return void await spend(actor, message.id);
  const item = kind === "use" ? await fromUuid(origin.uuid) : null;
  const option = item?.parent === actor && optionOf(item);
  if (!option) return void (actor && breaksShape(message) && await dropUnspent(actor));
  await removeEffect(actor);   // новая метамагия заменяет прежнюю: как у единого переключателя pf2e, выбрана одна
  const created = await addEffect(actor, effectSource({
    name: L("builtin.spellshape.effect", { name: item.name }), img: item.img,
    duration: combatOf(game.combats, actor) ? UNTIL_TURN_END : UNLIMITED,
    rules: effectRules(option), origin: { actor: actor.uuid, item: item.uuid }
  }), KEY);
  if (created) await whisper(actor, L("builtin.spellshape.hint", { name: esc(actor.name), shape: esc(item.name) }), KEY);
}
