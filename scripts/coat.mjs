// Нанесение injury-яда на оружие (plan-weapon-poison.md): шаг `coat` расходника или действия. Носитель — эффект владельца с флагом `coat` и своим onEvent-правилом
// (flags[MOD].rule, его читает resolveRule как флаг предмета); сами события исполняет events.mjs, шаги — apply.mjs. Новых хуков и настроек нет.
// Только активный ГМ (шаги идут из applyOps).
import { MOD, L, queue, sluggify, flagPath } from "./util.mjs";
import { modeOf } from "./settings.mjs";
import { card } from "./card.mjs";
import { effectSource, esc, headOf } from "./builtin/lib.mjs";
import * as rules from "./rules.mjs";
import { findByKey, removeEffect, askChoice } from "./apply.mjs";

const FOREVER = { value: -1, unit: "unlimited", expiry: null };   // как у носителя недуга: яд держится до траты
const UNIVERSAL = ["item:damage:type:slashing", "item:damage:type:piercing", "damage:type:slashing", "damage:type:piercing"];   // тип урона оружия; у сообщения «урон получен» разбивки по экземплярам нет (см. plan §3.5)

/** slug носителя: оружие в нём, чтобы разные оружия и яды не схлопывались в eventItems. */
// только [a-z0-9-]: так требует валидатор (removeEffect.slug) — иначе кириллическое имя яда без slug делает правило носителя невалидным, и он молчит
export const coatSlug = (poison, weaponId) => sluggify(`coat-${poison}-${weaponId}`).replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-");

/**
 * onEvent-правило носителя. coat: { weapon (id), slug (носителя), ammo, challenge (СЛ — число), poison? (имя) }; armed — Удар попал, ждём урон.
 * Не взведён: крит. провал — трата; успех — взвод (внутренний шаг coatArm); боеприпасы — трата на любом исходе, взвода нет (снаряд улетел).
 * Взведён (попавший Удар «забрал» яд: следующие Удары его не несут и не тратят): урон по цели (gate target) — трата, испытание только если ОЗ или временные ОЗ
 * убыли и тип урона колющий/рубящий (when) и снятие реально произошло (gate removed); иначе трата без испытания. Урона нет — конец хода владельца тратит яд
 * без испытания (нулевой урон pf2e сообщением не пишет); вне боя (gate idle) его тратит следующий Удар этим оружием, plan §3.6.
 * Предикат `item:id:<оружие>` — опция предмета броска (ItemPF2e.getRollOptions): связь Удара с оружием без опций носителя.
 */
export function coatEvents(coat, armed = false) {
  const item = `item:id:${coat.weapon}`, spend = [{ to: "self", removeEffect: { slug: coat.slug } }], hit = ["outcome:success", "outcome:criticalSuccess"];
  const attack = (when, apply) => ({ on: "attack-roll", side: "self", when: [item, ...when], apply });
  const onEvent = armed ? [
    { on: "damage-taken", side: "origin", when: [item, { or: ["damage-taken:hp", "damage-taken:temp"] }, { or: UNIVERSAL }], gate: ["target", "removed"], apply: spend, challenge: coat.challenge },
    { on: "damage-taken", side: "origin", when: [item, { or: [{ and: [{ not: "damage-taken:hp" }, { not: "damage-taken:temp" }] }, { nor: UNIVERSAL }] }], gate: ["target"], apply: spend },
    { on: "turn-end", side: "self", apply: spend },
    { ...attack([], spend), gate: ["idle"] }
  ] : coat.ammo ? [attack([], spend)] : [attack(["outcome:criticalFailure"], spend), attack([{ or: hit }], [{ to: "self", coatArm: true }])];
  return { v: 1, ...(coat.poison && { label: coat.poison }), onEvent };
}

/** Чистая: у оружия есть колющий или рубящий урон (опции предмета pf2e, и у weapon, и у melee NPC). */
export const hasSP = (weapon) => (weapon?.getRollOptions?.("item") ?? []).some((o) => /^item:damage:type:(?:slashing|piercing)$/.test(o));

/**
 * Чистая: оружие расходует боеприпасы. pf2e (WeaponPF2e.strike.roll): consumeAmmo = !system.ammo.builtIn && system.expend > 0 — признак не зависит от того,
 * выбран ли боеприпас; expend ставит миграция 940 для дальнобойного не метательного оружия с перезарядкой.
 */
export const takesAmmo = (weapon) => (weapon?.system?.expend ?? 0) > 0 && !weapon?.system?.ammo?.builtIn;

/** Оружие владельца под яд: у персонажа — weapon, у NPC — только melee (Удар NPC идёт от melee, оружие из инвентаря даёт свой связанный melee); не брошенное и не в рюкзаке. */
export function coatCandidates(actor) {
  return (actor?.itemTypes?.[actor?.type === "npc" ? "melee" : "weapon"] ?? []).filter((w) => !["dropped", "stowed"].includes(w.system?.equipped?.carryType));
}

/** Оружие с боеприпасами: у melee NPC — связанное оружие инвентаря (flags.pf2e.linkedWeapon), иначе само. */
export const ammoWeapon = (actor, w) => (w?.type === "melee" ? actor?.items?.get?.(w.flags?.pf2e?.linkedWeapon) : w);

/** Чистая: яд взведён именно на эту цель (токен или актёр). */
export const armedAt = (item, token, actor) => {
  const t = item?.flags?.[MOD]?.coat?.armed?.target;
  return !!t && (t === token?.uuid || t === actor?.uuid);
};

/** СЛ испытания яда числом: value как есть, против защиты автора/разметка — через resolveDC (расходник к Удару может исчезнуть, поэтому число уходит в снимок). */
export async function coatDc(challenge, { item = null, actor = null } = {}) {
  if (Number.isFinite(challenge?.dc?.value)) return challenge.dc.value;
  const { resolveDC } = await import("./saves.mjs");   // не наверху: saves.mjs тянет apply.mjs, а тот — этот модуль
  return resolveDC({ rule: { onUse: { challenge } }, item: item && { uuid: item.uuid }, actor: actor?.uuid }, { item, actor });
}

const whisper = (key, data) => ChatMessage.create({ whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id), speaker: { alias: "pf2e-automato" }, content: card(L(key, data), "", headOf("coat")) });
const carrierOn = (actor, weaponId) => actor.itemTypes.effect.find((e) => e.flags?.[MOD]?.coat?.weapon === weaponId);

/**
 * Шаг coat (из applyOps): выбрать оружие, снять прежний яд с него (замена), создать носитель. -> { ops } для журнала applyOps:
 * [effRemoved (замена)?, coatMade]. Откат — undoOps: старый носитель создаётся заново, новый ищется по meta.key (id меняется при откате траты).
 * c: { meta, use, originItem, selfActor, originToken, chooser }.
 */
export async function coatStep(actor, step, c) {
  const poisonItem = c.originItem, name = poisonItem?.name ?? c.use?.item?.name ?? "?";
  if (modeOf("effect") !== "auto") { await whisper("coat.needsAuto", { name: esc(name) }); return { ops: [] }; }   // события носителя идут только при «Автоматически»
  if (c.done || findByKey(actor, c.meta.key)) return { ops: [] };   // done — шаг уже исполнен этой карточкой (носитель мог быть потрачен: повтор кнопки не наносит заново)
  const cands = coatCandidates(actor);
  if (!cands.length) { await whisper("coat.noWeapon", { name: esc(name) }); return { ops: [] }; }
  const id = cands.length === 1 ? cands[0].id : await askChoice(c.chooser, name, L("coat.prompt"), cands.map((w) => ({ value: w.id, label: hasSP(w) ? w.name : `${w.name} — ${L("coat.noSP")}` })));
  const weapon = cands.find((w) => w.id === id);
  if (!weapon) return { ops: [] };   // окно закрыто
  const dc = await coatDc(step.coat.challenge, { item: poisonItem, actor });
  if (dc == null) { await whisper("coat.noDC", { name: esc(name) }); return { ops: [] }; }
  if (!hasSP(weapon)) await whisper("coat.noSPNote", { name: esc(name), weapon: esc(weapon.name) });
  // замена и создание — одна очередь на актёра: две карточки нанесения на одно оружие не создадут два носителя (вложенные actor: ниже — другой ключ, без взаимной блокировки)
  return queue(`coat:${actor.uuid}`, () => coatMake(actor, step, c, { weapon, poisonItem, name, dc }));
}

async function coatMake(actor, step, c, { weapon, poisonItem, name, dc }) {
  if (findByKey(actor, c.meta.key)) return { ops: [] };   // повтор кнопки, пока висело окно
  const ops = [], old = carrierOn(actor, weapon.id);
  if (old) {   // второй яд заменяет первый (решение 1); removeEffect держит свою очередь актёра — снимаем до нашей
    const r = await removeEffect(actor, { slug: old.slug });
    if (r.op === "effRemoved") ops.push({ op: "effRemoved", actor: actor.uuid, data: r.data });
    await whisper("coat.replaced", { name: esc(actor.name), old: esc(old.flags[MOD].coat.poison ?? old.name), weapon: esc(weapon.name), poison: esc(name) });
  }
  const poison = rules.slugOf(null, poisonItem) || sluggify(name) || "poison";
  const coat = { weapon: weapon.id, ammo: takesAmmo(ammoWeapon(actor, weapon)), slug: coatSlug(poison, weapon.id), poison: name, challenge: { ...step.coat.challenge, dc: { value: dc } } };
  const made = await queue(`actor:${actor.uuid}`, async () => {
    if (findByKey(actor, c.meta.key)) return null;
    const token = actor.getActiveTokens?.(true, true)?.[0];
    const data = effectSource({
      name: L("coat.name", { poison: name, weapon: weapon.name }), img: poisonItem?.img ?? undefined, rules: [],
      description: `<p>${esc(L("coat.desc", { weapon: weapon.name }))}</p>${poisonItem?.uuid ? `<p>@UUID[${poisonItem.uuid}]</p>` : ""}`,
      duration: step.coat.duration ?? FOREVER,
      origin: { actor: c.selfActor?.uuid, token: c.originToken?.uuid, item: poisonItem?.uuid }, target: { actor: actor.uuid, token: token?.uuid }
    });
    data.system.slug = coat.slug;
    data.flags = { [MOD]: { meta: { ...c.meta }, coat, rule: coatEvents(coat) } };
    return (await actor.createEmbeddedDocuments("Item", [data]))[0] ?? null;
  });
  if (made) ops.push({ op: "coatMade", actor: actor.uuid, key: c.meta.key });
  return { ops };
}

/** Внутренний шаг носителя (coatEvents, A3): Удар попал — яд взведён на цель, правило сменяется «взведённым» набором. -> { op:"coatArm", item } | { op:"skipped" } */
export function coatArm(item, target) {
  return queue(`actor:${item.actor.uuid}`, async () => {
    const coat = item.flags?.[MOD]?.coat;
    if (!coat || coat.armed || !target) return { op: "skipped" };
    await item.update({ [flagPath("coat", "armed")]: { target }, [flagPath("rule")]: coatEvents(coat, true) });
    return { op: "coatArm", item };
  });
}

/** Откат взвода: цель и правило — как до Удара. */
export function coatUnarm(item) {
  return queue(`actor:${item.actor.uuid}`, async () => {
    const coat = item.flags?.[MOD]?.coat;
    if (coat) await item.update({ [flagPath("coat", "armed")]: null, [flagPath("rule")]: coatEvents(coat, false) });
  });
}

/** Откат нанесения: носитель ищется по meta.key, а не по uuid — после отката траты он пересоздан с новым id. */
export function coatUnmake(actor, key) {
  return queue(`actor:${actor.uuid}`, async () => {
    const item = findByKey(actor, key);
    if (item) await item.delete({ [MOD]: { undo: true } });   // не «снятие эффекта»: events.onItem такие удаления игнорирует
    return !!item;
  });
}
