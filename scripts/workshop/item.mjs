// Мастерская, режим «Предмет»: чистое ядро (без Foundry при импорте, node-тесты).
// Модель мастера -> source мирового Item pf2e (расходник/снаряжение/оружие/действие/черта) + правило автоматизации во флаге.
// Поля сверены с pf2e 8.6.1: template.json (consumable/equipment/weapon), AbilitySystemData и FeatSystemData (action/feat).
import { MOD, errText, sluggify } from "../util.mjs";
import { validateRule, dupActivate } from "../rules.mjs";
import * as fx from "./effect.mjs";
import { rulesOf as grantRules, grantErrors } from "./passive.mjs";

export const TYPES = ["consumable", "equipment", "weapon", "action", "feat"];
export const PHYSICAL = new Set(["consumable", "equipment", "weapon"]);
export const RARITIES = ["common", "uncommon", "rare", "unique"];
export const ACT_TYPES = ["action", "reaction", "free", "passive"];
export const ACTIVATIONS = ["", "1", "2", "3", "reaction", "free"];
export const BULKS = [0, 0.1, 1, 2, 3, 4, 5, 6, 8, 10];
export const USAGES = ["worn", "held-in-one-hand", "held-in-two-hands", "carried"];
// компендиумы pf2e, где искать основу (equipment хранит и расходники, и снаряжение, и оружие)
// (id коллекций — по system.json pf2e 8.6.1: equipment-srd, actionspf2e, feats-srd)
export const PACKS = { consumable: "pf2e.equipment-srd", equipment: "pf2e.equipment-srd", weapon: "pf2e.equipment-srd", action: "pf2e.actionspf2e", feat: "pf2e.feats-srd" };
export const PACK_LABEL = { consumable: "equipment", equipment: "equipment", weapon: "equipment", action: "actions", feat: "feats" };
const DEFAULT_CAT = { consumable: "potion", feat: "general", action: "" };
const GLYPH = { 1: "1", 2: "2", 3: "3", reaction: "R", free: "F" };
const WEAPON_SEL = { "strike-damage": "{item|id}-damage", damage: "{item|id}-damage", "attack-roll": "{item|id}-attack" };   // правила оружия — только на него

export const DEFAULT_DIR = "systems/pf2e/icons/default-icons/";
export const defaultImg = (type) => `${DEFAULT_DIR}${type}.svg`;
/** Ссылку на эффект дописываем в описание только там, где у pf2e нет родного selfEffect. */
export const linksEffect = (type) => type === "consumable";

const num = (v) => { const s = String(v ?? "").trim().replace(",", "."); return s !== "" && Number.isFinite(Number(s)) ? Number(s) : NaN; };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const isMeleeThrown = (x) => /^thrown-\d+$/.test(x);   // ближнее оружие, которое можно метнуть (кинжал): range задан, но оно не дальнобойное
const HTMLISH = /<\/?[a-z][^>]*>/i;

export const blankItem = (type = "consumable") => ({
  type, name: "", img: defaultImg(type), level: type === "feat" ? 1 : 0, price: 0, bulk: 0.1, rarity: "common", traits: type === "consumable" ? ["consumable"] : [],
  category: DEFAULT_CAT[type] ?? "", uses: 1, usage: type === "equipment" ? "worn" : "held-in-one-hand", desc: "",
  activation: "", act: { type: type === "feat" ? "passive" : "action", actions: 1 },
  weapon: { category: "simple", group: "", dice: 1, die: "d6", dmgType: "slashing", kind: "melee", range: 30 },
  effect: null, to: "self", blocks: [], auto: true, dest: "world",
  src: null, base: "", baseSlug: ""   // src — очищенный source копии; base/baseSlug — имя и slug оригинала
});

/* ---------- цена и масса ---------- */

/** {pp,gp,sp,cp} -> золотые (число). */
export const gpOf = (v) => Math.round(((v?.pp ?? 0) * 10 + (v?.gp ?? 0) + (v?.sp ?? 0) / 10 + (v?.cp ?? 0) / 100) * 100) / 100;
/** Золотые -> монеты pf2e (целые, нулевые не пишем). */
export function coinsOf(gp) {
  let cp = Math.round((Number(gp) || 0) * 100);
  const out = { gp: Math.floor(cp / 100), sp: Math.floor((cp % 100) / 10), cp: cp % 10 };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v > 0));
}
export const bulkText = (b, t) => (Number(b) === 0 ? "—" : Number(b) < 1 ? t("workshop.item.bulkL") : String(b));

/* ---------- копия из компендиума ---------- */

/** Source копии -> новый предмет: без _id/папки/источника и старого slug (иначе каталоги правил узнают оригинал). */
export function cleanCopy(src) {
  const o = JSON.parse(JSON.stringify(src));
  for (const k of ["_id", "folder", "sort", "ownership", "_stats"]) delete o[k];
  if (o.flags) { delete o.flags.core; delete o.flags.babele; delete o.flags[MOD]; if (!Object.keys(o.flags).length) delete o.flags; }
  o.system = { ...o.system, slug: null };
  return o;
}

/** Source оригинала -> модель мастера (поля формы + очищенный source для сборки). */
export function modelFromSource(src) {
  const s = src.system ?? {}, m = blankItem(src.type), w = s.damage ?? {};
  Object.assign(m, {
    src: cleanCopy(src), base: src.name, baseSlug: src.system?.slug || sluggify(src.name), name: src.name, img: src.img || m.img,
    level: s.level?.value ?? m.level, price: gpOf(s.price?.value), bulk: s.bulk?.value ?? 0,
    rarity: s.traits?.rarity ?? "common", traits: (s.traits?.value ?? []).filter((x) => !RARITIES.includes(x)),
    category: s.category ?? m.category, uses: s.uses?.max ?? 1, usage: s.usage?.value ?? m.usage, desc: s.description?.value ?? "",
    act: { type: s.actionType?.value ?? m.act.type, actions: s.actions?.value ?? 1 },
    effect: s.selfEffect?.uuid ? { uuid: s.selfEffect.uuid, name: s.selfEffect.name } : null
  });
  if (src.type === "weapon") m.weapon = { ...m.weapon, category: s.category ?? "simple", group: s.group ?? "", dice: w.dice ?? 1, die: w.die ?? "d6", dmgType: w.damageType ?? "slashing", kind: s.range && !(s.traits?.value ?? []).some(isMeleeThrown) ? "ranged" : "melee", range: s.range ?? 30 };
  return m;
}

/* ---------- описание ---------- */

export const effectLink = (e) => `@UUID[${e.uuid}]{${e.name}}`;

/** Заменить ссылку на старый эффект ссылкой на новый (null — убрать); нет старой — дописать абзацем. */
export function withEffectLink(desc, from, to) {
  let d = String(desc ?? "");
  if (from) d = d.replace(effectLink(from), to ? effectLink(to) : "").replace(/<p>\s*<\/p>/g, "").trim();
  if (to && !d.includes(`@UUID[${to.uuid}]`)) d = !d ? effectLink(to) : HTMLISH.test(d) ? `${d}<p>${effectLink(to)}</p>` : `${d}\n${effectLink(to)}`;
  return d;
}

/** Описание для записи: текст мастера (простой -> абзацы), строка активации, ссылка на эффект (если её ещё нет). */
export function descHtml(m, t) {
  const d = String(m.desc ?? "").trim();
  const parts = [HTMLISH.test(d) ? d : d.split(/\n+/).filter((l) => l.trim()).map((l) => `<p>${esc(l)}</p>`).join("")];
  if (["consumable", "equipment"].includes(m.type) && m.activation && !/action-glyph/.test(d)) parts.push(`<p><strong>${esc(t("workshop.item.activate"))}</strong> <span class="action-glyph">${GLYPH[m.activation]}</span></p>`);
  if (linksEffect(m.type) && m.effect && !d.includes(`@UUID[${m.effect.uuid}]`)) parts.push(`<p>${effectLink(m.effect)}</p>`);
  return parts.filter(Boolean).join("");
}

/** Безопасный HTML для карточки предпросмотра: текст без тегов, @UUID[..]{имя} — плашкой. */
export function descPreview(desc) {
  const text = String(desc ?? "").replace(/<\/(p|div|li|h\d)>|<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return text.split(/\n+/).filter((l) => l.trim()).map((l) => `<p>${esc(l).replace(/@UUID\[[^\]]*\]\{([^}]*)\}/g, '<span class="ws-ref">$1</span>')}</p>`).join("");
}

/* ---------- что делает ---------- */

/** Сырое правило автоматизации: у расходника «при использовании применить эффект к себе/цели». null — правила не будет. */
export function ruleOf(m) {
  if (m.type !== "consumable" || !m.auto || !m.effect) return null;
  const self = m.to === "self";
  return { v: 1, yield: null, onUse: { targets: self ? "self" : "selected", apply: [{ to: self ? "self" : "target", effect: { uuid: m.effect.uuid } }] }, onAttacked: null, macros: [], onTurn: null };
}

/** Свойства пишутся в предмет: снаряжение и оружие, пассивные действия и черты (у активных правила работали бы постоянно). */
export const hasRules = (m) => ["equipment", "weapon"].includes(m.type) || ((m.type === "action" || m.type === "feat") && m.act.type === "passive");

/** Rule Elements предмета из кубиков; у оружия селекторы «все Удары» сужаем до самого оружия. GrantItem — только inMemoryOnly (passive.rulesOf). */
export function rulesOf(m, ctx) {
  if (!hasRules(m)) return [];
  const rules = m.blocks.flatMap((b) => grantRules(m.type === "weapon" ? { ...b, strike: "" } : b, ctx));   // у оружия «чем бьёт» — само оружие (WEAPON_SEL), скрытый strike от прежнего типа не в счёт
  return m.type === "weapon" ? rules.map((r) => (WEAPON_SEL[r.selector] ? { ...r, selector: WEAPON_SEL[r.selector] } : r)) : rules;
}

/** Подпись активации/типа действия. */
export function actText(m, t) {
  if (m.type === "action" || m.type === "feat") {
    const { type, actions } = m.act;
    return t(`workshop.item.act.${type === "action" ? `n${actions}` : type}`);
  }
  return m.activation ? t(`workshop.item.act.${/^\d$/.test(m.activation) ? `n${m.activation}` : m.activation}`) : "";
}

/** Строки «Цена …; Масса …; Активация …» для карточки: [{label, text}]. */
export function facts(m, t) {
  const out = [];
  if (PHYSICAL.has(m.type)) out.push({ label: t("workshop.item.fPrice"), text: t("workshop.item.gp", { n: num(m.price) || 0 }) }, { label: t("workshop.item.fBulk"), text: bulkText(m.bulk, t) });
  if (m.type === "weapon") {
    const w = m.weapon;
    out.push({ label: t("workshop.item.fDamage"), text: `${num(w.dice) || 1}${w.die} ${t(`workshop.dtype.${w.dmgType}`)}` });
    if (w.kind === "ranged") out.push({ label: t("workshop.item.fRange"), text: t("workshop.item.ft", { n: num(w.range) || 0 }) });
  }
  const act = actText(m, t);
  if (act) out.push({ label: t(PHYSICAL.has(m.type) ? "workshop.item.activate" : "workshop.item.fActions"), text: act });
  return out;
}

/* ---------- проверка и сборка ---------- */

/** Ошибки на понятном языке; пустой массив — можно создавать. ctx — как у effect.mjs (+ t). */
export function validate(m, ctx) {
  const { t } = ctx, out = [], err = (k, d) => out.push(t(`workshop.item.err.${k}`, d));
  if (!String(m.name ?? "").trim()) err("name");
  if (m.type !== "action") {
    const lv = num(m.level), min = m.type === "feat" ? 1 : 0;   // у черты pf2e уровень 1..30
    if (!Number.isInteger(lv) || lv < min || lv > 30) err(m.type === "feat" ? "levelFeat" : "level");
  }
  if (PHYSICAL.has(m.type) && !(num(m.price) >= 0)) err("price");
  if (m.type === "consumable" && !(Number.isInteger(num(m.uses)) && num(m.uses) >= 1)) err("uses");
  if (m.type === "weapon") {
    if (!(Number.isInteger(num(m.weapon.dice)) && num(m.weapon.dice) >= 1)) err("dice");
    if (m.weapon.kind === "ranged" && !(Number.isInteger(num(m.weapon.range)) && num(m.weapon.range) >= 5)) err("range");
  }
  if (m.blocks.length && hasRules(m)) out.push(...fx.validate({ ...fx.blankModel(), name: "x", blocks: m.blocks }, ctx), ...grantErrors(m.blocks, ctx));
  const raw = ruleOf(m);
  if (raw) { const v = validateRule(raw), dup = dupActivate(raw); if (dup || !v.ok) err("rule", { error: errText(dup ?? v.errors[0]) }); }
  return out;
}

const put = (o, path, v) => { const k = path.split("."); const last = k.pop(); let c = o; for (const p of k) c = c[p] ??= {}; c[last] = v; };

/** Модель -> source мирового Item. ctx.t — перевод (для строки активации), ctx как у effect.mjs. */
export function buildItem(m, ctx) {
  const it = m.src ? cleanCopy(m.src) : { type: m.type, system: {} };
  const set = (p, v) => put(it, `system.${p}`, v), w = m.weapon;
  it.name = m.name.trim();
  it.img = m.img || defaultImg(m.type);
  set("description.value", descHtml(m, ctx.t));
  set("traits.value", [...m.traits]);
  if (m.type !== "action") set("level.value", num(m.level) || 0);
  if (m.type !== "action") set("traits.rarity", m.rarity);
  if (PHYSICAL.has(m.type)) { set("price.value", coinsOf(m.price)); set("bulk.value", Number(m.bulk)); }
  if (m.type === "consumable") { set("category", m.category); set("uses", { value: num(m.uses), max: num(m.uses), autoDestroy: it.system.uses?.autoDestroy ?? true }); }
  if (m.type === "equipment" || m.type === "weapon") set("usage.value", m.usage);
  if (m.type === "weapon") {
    set("category", w.category); set("group", w.group || null);
    set("damage", { ...(it.system.damage ?? {}), dice: num(w.dice), die: w.die, damageType: w.dmgType });
    if (w.kind === "ranged") set("range", num(w.range));
    else if (!(it.system.range && m.traits.some(isMeleeThrown))) set("range", null);   // метательное ближнее оружие хранит range — не обнуляем
  }
  if (m.type === "action" || m.type === "feat") {
    const passive = m.act.type === "passive";
    set("actionType.value", m.act.type);
    set("actions.value", m.act.type === "action" ? num(m.act.actions) : null);
    set("selfEffect", m.effect && !passive ? { uuid: m.effect.uuid, name: m.effect.name } : null);   // у пассивных pf2e selfEffect обнуляет сам
    set("category", m.type === "feat" ? m.category : m.category || null);
  }
  // явный slug: иначе pf2e и сторонние модули берут sluggify(имя), и копия с прежним именем «узнаётся» как оригинал
  let slug = sluggify(it.name);
  if (slug && slug === m.baseSlug) slug += "-custom";
  set("slug", slug || null);
  const rules = rulesOf(m, ctx);
  if (rules.length) set("rules", [...(it.system.rules ?? []), ...rules]);
  const rule = ruleOf(m), v = rule && validateRule(rule);
  if (v?.ok) put(it, `flags.${MOD}.rule`, v.rule);
  return it;
}

/** Строка кубика для списка; у оружия — явно «этого оружия». */
export function blockText(type, b, ctx) {
  const { t } = ctx, v = (Number(b.sign) < 0 ? -1 : 1) * Math.abs(Number(b.value));
  if (type === "weapon" && b.kind === "dmg") return t("workshop.item.wText.dmg", { number: b.number, die: b.die, type: t(`workshop.dtype.${b.dmgType}`) }) + fx.whenSuffix(b, ctx);
  if (type === "weapon" && b.kind === "bonus" && ["attack-roll", "damage"].includes(b.target))
    return t(`workshop.item.wText.${b.target === "damage" ? "damage" : "attack"}`, { amount: `${v < 0 ? "−" : "+"}${Math.abs(v)}`, kind: t(`workshop.${v < 0 ? "penalty" : "bonus"}Kind.${b.type}`) }) + fx.whenSuffix(b, ctx);
  return fx.textOf(b, ctx);
}
