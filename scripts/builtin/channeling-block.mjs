// «Трата слота как реакция»: Проводящий блок (и копии NPC) — при Блоке щитом можно потратить заклинание «Лечение»/«Вред», твёрдость щита растёт на (ранг)d8.
// Бросок и прибавку к твёрдости pf2e делает сам: «Effect: Channeling Block» (feat-effects) — бейдж-формула (@item.level)d8 и ItemAlteration твёрдости щита.
// Здесь только то, чего pf2e не делает: слот и его трата. Выбор — решение игрока: варианты «Блок + <заклинание> (ранг)» идут кнопками в самой подсказке «Блок»
// (shield-block.mjs), без модального окна внутри очереди применения урона.
import { L } from "../util.mjs";
import { addEffect, cardButton, esc, heldSlug, paHas, whisper } from "./lib.mjs";

export const SLUGS = new Set(["channeling-block"]);
export const EFFECT = "Compendium.pf2e.feat-effects.Item.Rzg3c7hfkvTlxPDp";
const SPELLS = new Set(["heal", "harm"]);

/**
 * Чистая: варианты траты. entry: {id, name, mode: "prepared" | "counted", slots: {ранг: {value, max, prepared: [{id, expended}]}}, spells: [{id, slug, name, base, signature}]}.
 * prepared — слот подготовки с этим заклинанием не потрачен; counted (спонтанные, гибкие) — есть слот ранга; сигнатурное заклинание — в слоте любого ранга от базового.
 * -> [{id: "entry:spell:rank:slot", entry, spell, rank, slot, label}]
 */
export function blockOptions(entries, label = (e, s, r) => `${e.name}: ${s.name} (${r})`) {
  const out = [], add = (e, s, rank, slot) => out.push({ id: `${e.id}:${s.id}:${rank}:${slot ?? ""}`, entry: e.id, spell: s.id, rank, slot, label: label(e, s, rank) });
  for (const e of entries) {
    const spells = e.spells.filter((s) => SPELLS.has(s.slug));
    for (const [rank, slots] of Object.entries(e.slots ?? {})) {
      if (!slots?.max) continue;
      if (e.mode === "prepared") slots.prepared?.forEach((p, i) => { const s = p?.id && !p.expended && spells.find((x) => x.id === p.id); if (s) add(e, s, +rank, i); });
      else if (slots.value > 0) for (const s of spells) if (s.signature ? +rank >= s.base : +rank === s.base) add(e, s, +rank, null);
    }
  }
  return out;
}

/** Чистая: щит в attributes.shield — настоящий предмет-щит (не эффект щита-заклинания: тот заканчивается блоком и твёрдости от Проводящего блока не получает). */
export const realShield = (actor) => actor?.items?.get(actor.attributes?.shield?.itemId)?.type === "shield";

/** Чистая: по одному варианту на пару «заклинание + ранг» (одинаковые подготовленные слоты не множим). */
export const uniqueOptions = (opts) => opts.filter((o, i) => opts.findIndex((x) => x.spell === o.spell && x.rank === o.rank && x.entry === o.entry) === i);

/** Данные колдовства актёра -> входные данные blockOptions. Врождённое и очки фокуса не тратят слот — пропуск. */
export const entriesOf = (actor) => (actor?.itemTypes?.spellcastingEntry ?? []).filter((e) => e.spells && !e.isInnate && !e.isFocusPool && !e.isRitual).map((e) => ({
  id: e.id, name: e.name, mode: e.isPrepared && !e.isFlexible ? "prepared" : "counted",
  slots: Object.fromEntries([...Array(10)].map((_, i) => [i + 1, e.system.slots?.[`slot${i + 1}`]])),
  spells: [...e.spells].map((s) => ({ id: s.id, slug: s.slug, name: s.name, base: s.system.location?.heightenedLevel ?? s.rank, signature: !!s.system.location?.signature }))
}));

/** Варианты актёра: есть черта, настоящий щит и слот. */
export function optionsOf(actor) {
  const slug = heldSlug(actor, SLUGS);
  return !slug || paHas(slug) || !realShield(actor) ? [] : uniqueOptions(blockOptions(entriesOf(actor)));
}

/** Кнопки подсказки «Блок»: «Блок + <заклинание> (ранг)» на каждый вариант (data-af-cb — id слота). */
export const buttons = (actor) => optionsOf(actor).map((o) => cardButton(`data-af-shield-block data-af-cb="${esc(o.id)}"`, L("builtin.channeling.button", { label: esc(o.label) }), "")).join("");

/**
 * Ведущий, перед применением блока: вариант cb ещё доступен -> слот потрачен, эффект pf2e наложен -> эффект (удалить после урона: твёрдость нужна только этому блоку).
 * Нет черты / слота — null (блок идёт без траты).
 */
export async function begin(actor, key, cb) {
  const o = optionsOf(actor).find((x) => x.id === cb);
  if (!o || !await actor.spellcasting.get(o.entry)?.consume(actor.items.get(o.spell), o.rank, o.slot ?? undefined)) return null;
  const src = (await fromUuid(EFFECT))?.toObject();
  if (!src) return null;
  delete src._id;
  src.system.level.value = o.rank;
  src.system.context = { ...src.system.context, origin: { actor: actor.uuid, token: null, item: null, spellcasting: null, rollOptions: [] } };
  const eff = await addEffect(actor, src, `channeling-block:${key}`);
  if (eff) await whisper(actor, L("builtin.channeling.done", { name: esc(actor.name), spell: esc(actor.items.get(o.spell)?.name), rank: o.rank, bonus: eff.system.badge?.value ?? "?" }), "shield-block");
  return eff;
}
