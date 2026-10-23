// Временное снаряжение от эффекта: «Доспех из земли», «Деревянный доспех», «Металлический панцирь» и их щиты (группа — любой эффект с флагом gear).
// Флаг эффекта flags.pf2e-automato.gear: { armor?, shield?, shieldEffect?, upgrade?: {level, acBonus, traits?, category?}, scale?: {every, hardness, hp}, shatterOnCrit?, pa? }.
// Создание эффекта выдаёт броню (категория по тексту, наивысшее мастерство — MartialProficiency на самой броне; руны надетой брони копируются; надетая теряет 1 Объём,
// снимается и теряет инвестированность) и/или щит (прочность растёт с уровнем); shieldEffect — предложение автору выдать щит отдельным эффектом (свободная рука).
// Удаление эффекта убирает выданное и возвращает прежнюю броню. Выданное помечено флагом предмета gearOf = id эффекта и system.temporary; состояние возврата
// (oldArmor, oldBulk, oldInvested) лежит на эффекте (gearState) и продублировано на выданной броне — на случай, когда эффекта уже нет (сверка при запуске).
// Выдаёт только активный ведущий; уборка — всегда, без paHas и режима макросов. Каскад Blazing Armory — родной GrantItem (granter: cascade), кода нет.
import { L, MOD, queue, isActiveGM, whenSettled } from "../util.mjs";
import { addEffect, paHas, askOwner, askHere, worldActors } from "./lib.mjs";
import { modeOf } from "../settings.mjs";

const ASK_MS = 120000;

/** Чистая: флаг gear эффекта или null. */
export const gearFlag = (item) => (item?.type === "effect" ? item.flags?.[MOD]?.gear ?? null : null);
/** Чистая: id эффекта, выдавшего предмет, или null. */
export const grantedBy = (item) => item?.flags?.[MOD]?.gearOf ?? null;

/** Чистая: группа pf2e-automations, чьё слово «уступаем»: явная (щиты принадлежат группе импульса) или slug эффекта без «effect-». */
export const paSlug = (item, g = gearFlag(item)) => g?.pa ?? String(item?.slug ?? "").replace(/^effect-/, "");

/** Чистая: состояние возврата надетой настоящей брони — из _source (в подготовленных данных Объём и руны пересчитаны). */
export const wornState = (worn) => ({ oldArmor: worn.id, oldBulk: worn._source.system.bulk.value, oldInvested: !!worn._source.system.equipped?.invested });

/** Чистая: источник брони. state — wornState | null; runes — руны надетой (из _source). Категория — по тексту (upgrade.category с нужного уровня); наивысшее мастерство даёт MartialProficiency на самой броне (pa-effects.mjs). */
export function armorData(src, { effectId, state = null, runes = null, level = 1, upgrade = null }) {
  const d = clone(src), s = d.system;
  delete d._id;
  const up = upgrade && level >= upgrade.level ? upgrade : null;
  if (up) {
    s.acBonus = up.acBonus;
    s.traits = { ...s.traits, value: [...new Set([...(s.traits?.value ?? []).filter(Boolean), ...(up.traits ?? [])])] };
  }
  if (up?.category) s.category = up.category;
  if (runes) s.runes = clone(runes);
  if (state) s.bulk = { ...s.bulk, value: 0 };
  s.temporary = true;
  d.flags = { ...d.flags, [MOD]: { gearOf: effectId, ...state } };
  return d;
}

/** Чистая: источник щита; scale — прибавка Твёрдости и ОЗ за каждые every уровней начиная со 2-го (Level (+3) impulse). */
export function shieldData(src, { effectId, level = 1, scale = null }) {
  const d = clone(src), s = d.system, n = scale ? Math.max(0, Math.floor((level - 1) / scale.every)) : 0;
  delete d._id;
  if (n) {
    s.hardness += n * scale.hardness;
    s.hp = { ...s.hp, value: s.hp.value + n * scale.hp, max: s.hp.max + n * scale.hp };
  }
  s.temporary = true;
  s.equipped = { carryType: "held", handsHeld: 1 };   // сразу в руке, без промежуточного worn
  d.flags = { ...d.flags, [MOD]: { gearOf: effectId } };
  return d;
}

/** Чистая: выданный щит сломан или выпал из руки — эффект щита заканчивается («decays … if it becomes broken or leaves your grasp»). */
export const shieldGone = (shield) => !!shield.isBroken || shield.system?.equipped?.carryType !== "held";

/** Чистая: сумма ОЗ и временных ОЗ. */
export const hpTotal = (actor) => (actor?.system?.attributes?.hp?.value ?? 0) + (actor?.system?.attributes?.hp?.temp ?? 0);

const clone = (o) => JSON.parse(JSON.stringify(o));
const subKey = (id) => `gear-shield:${id}`;
const fresh = async (uuid) => { const d = (await fromUuid(uuid))?.toObject(); if (d) delete d._id; return d; };
const wornArmor = (actor) => actor.itemTypes.armor.find((a) => a.isWorn && a.system.equipped?.inSlot && !grantedBy(a)) ?? null;

/** Вернуть надетой прежнюю броню (Объём, слот, инвестированность). */
async function restore(actor, state) {
  const prev = state?.oldArmor && actor.items.get(state.oldArmor);
  if (!prev) return;
  await actor.changeCarryType(prev, { carryType: "worn", inSlot: true });
  await prev.update({ "system.bulk.value": state.oldBulk });
  if (state.oldInvested && prev.system.equipped?.invested === false) await actor.toggleInvested(prev.id);
}

/** Окно автору (игроку-владельцу онлайн, иначе ведущему): выдать щит? -> "yes" | "no" | null (закрыто / время вышло: окно закрывается само через ASK_MS). */
export async function pickShield(scope) {
  return (await askHere(scope.item?.name ?? "", `<p>${L("builtin.gear.askShield")}</p>`, [{ id: "yes", label: L("builtin.gear.yes") }, { id: "no", label: L("builtin.gear.no") }], ASK_MS))?.action ?? null;
}
const askShield = (actor, item) => askOwner(actor, "gear-shield", { item: item.uuid }, () => pickShield({ item })).catch(() => null);

/** createItem у активного ведущего. */
export async function onCreate(item) {
  const g = gearFlag(item), actor = item.actor;
  if (!g || !actor || paHas(paSlug(item, g))) return;
  // в слоте броня другого gear-эффекта (два разных импульса подряд): тот эффект заканчивается и убирает свою броню раньше, чем встанет новая
  const other = g.armor && actor.itemTypes.armor.find((a) => a.isWorn && a.system.equipped?.inSlot && grantedBy(a) && grantedBy(a) !== item.id);
  if (other && actor.items.has(grantedBy(other))) {
    await actor.items.get(grantedBy(other)).delete();
    await Promise.resolve();
    await queue(`actor:${actor.uuid}`, async () => {});   // дождаться уборки, поставленной хуком удаления
  }
  await queue(`actor:${actor.uuid}`, async () => {
    if (actor.items.some((i) => grantedBy(i) === item.id)) return;   // повторный хук
    if (g.armor) {
      const src = await fresh(g.armor);
      if (!src) return;
      const worn = wornArmor(actor), state = worn ? wornState(worn) : null;
      if (state) await item.update({ [`flags.${MOD}.gearState`]: state });   // сначала запись, потом любые правки настоящей брони
      const [armor] = await actor.createEmbeddedDocuments("Item", [armorData(src, { effectId: item.id, state, runes: worn?._source.system.runes, level: actor.level, upgrade: g.upgrade })]);
      if (!armor) return;
      await actor.changeCarryType(armor, { carryType: "worn", inSlot: true });
      if (worn) {
        await worn.update({ "system.bulk.value": Math.max(state.oldBulk - 1, 0) });
        if (state.oldInvested && worn.system.equipped?.invested) await actor.toggleInvested(worn.id);   // вне слота она не должна считаться инвестированной
        if (state.oldInvested && armor.system.equipped?.invested === false) await actor.toggleInvested(armor.id);
      }
    }
    if (g.shield) {
      const src = await fresh(g.shield);
      if (!src) return;
      await actor.createEmbeddedDocuments("Item", [shieldData(src, { effectId: item.id, level: actor.level, scale: g.scale })]);
    }
  });
  if (g.shieldEffect && actor.handsFree > 0 && (await askShield(actor, item)) === "yes") {
    const src = await fresh(g.shieldEffect);
    if (src) await addEffect(actor, src, subKey(item.id));
  }
}

/** Убрать выданное эффектом effectId и вернуть прежнюю броню. state — запасное состояние (с выданной брони), если на эффекте его нет. */
async function cleanup(actor, effectId, state) {
  await queue(`actor:${actor.uuid}`, async () => {
    const mine = actor.items.filter((i) => grantedBy(i) === effectId);
    const spare = mine.map((i) => i.flags[MOD]).find((f) => f.oldArmor);
    for (const i of [...mine, ...actor.items.filter((e) => e.flags?.[MOD]?.meta?.key === subKey(effectId))]) if (actor.items.has(i.id)) await i.delete();
    await restore(actor, state ?? spare);
  });
}

/** deleteItem у активного ведущего. Эффект — убрать выданное; выданная броня/щит удалены вручную (сломан щит и т. п.) — снять эффект, который их держал. */
export async function onDelete(item) {
  const actor = item.actor;
  if (!actor) return;
  if (gearFlag(item)) return cleanup(actor, item.id, item.flags?.[MOD]?.gearState);
  const by = grantedBy(item);
  if (by && actor.items.has(by)) await actor.items.get(by).delete();
}

/** updateItem: выданный щит сломан или выпал из руки — эффект, выдавший его, заканчивается. */
export async function onUpdate(item) {
  const by = grantedBy(item), actor = item.actor;
  if (item.type !== "shield" || !by || !actor?.items.has(by) || !shieldGone(item)) return;
  await actor.items.get(by).delete();
}

/** При запуске у активного ведущего: выданное без живого эффекта (ведущих не было при удалении, перезагрузка посреди процесса) — убрать и вернуть броню. */
export async function sweep() {
  for (const actor of worldActors()) {
    const orphans = [...new Set(actor.items.map(grantedBy).filter((id) => id && !actor.items.has(id)))];
    for (const id of orphans) await cleanup(actor, id, null);
  }
}

/** Metal Carapace: урон от критического попадания ломает панцирь (эффект снимается, onDelete убирает броню). Обёртка applyDamage — outcome приходит из карточки урона. */
export function wrapShatter() {
  const wrap = async function (orig, opts, ...rest) {
    // pf2e применяет урон к контекстному клону (ОЗ клона не меняются): смотрим настоящего актёра по uuid
    const real = fromUuidSync(this.uuid) ?? this, before = hpTotal(real), res = await orig.call(this, opts, ...rest);
    if (opts?.outcome === "criticalSuccess" && modeOf("macro") !== "off" && hpTotal(real) < before)
      for (const fx of real.itemTypes?.effect?.filter((e) => gearFlag(e)?.shatterOnCrit && e.isOwner) ?? []) await fx.delete();
    return res;
  };
  const APPLY = "CONFIG.Actor.documentClass.prototype.applyDamage";
  if (globalThis.game?.modules?.get("lib-wrapper")?.active && globalThis.libWrapper) return void libWrapper.register(MOD, APPLY, wrap, "WRAPPER");
  const proto = CONFIG.Actor.documentClass?.prototype;
  if (!proto?.applyDamage || proto.applyDamage.__afGear) return;
  const orig = proto.applyDamage;
  proto.applyDamage = function (...a) { return wrap.call(this, orig, ...a); };
  proto.applyDamage.__afGear = true;
}

/** Хуки группы (вызывается из index.mjs). Выдача — только при включённых макросах; уборка — всегда. */
export function init() {
  if (!globalThis.Hooks) return;
  const gm = (id, fn, needMode = false) => (...a) => { if (isActiveGM() && (!needMode || modeOf("macro") !== "off")) Promise.resolve().then(() => fn(...a)).catch((e) => console.error(`${MOD} | builtin ${id}`, e)); };
  Hooks.on("createItem", gm("gear create", onCreate, true));
  Hooks.on("deleteItem", gm("gear delete", onDelete));
  Hooks.on("updateItem", gm("gear update", onUpdate, true));
  Hooks.once("ready", async () => { await whenSettled(); gm("gear sweep", sweep)(); wrapShatter(); });
}
