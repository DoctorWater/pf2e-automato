// Симулятор срабатывания pf2e-automations (PA) на документе pf2e: «ложное покрытие» решает он, а не эвристика по тексту предиката.
// PA не смотрит на группы: у каждого сообщения чата (hooks/message.ts) он считает тип триггера (helpers.ts triggerType) и набор roll options (getRollOptions),
// берёт ВСЕ активные правила этого типа и проверяет их предикаты (game.pf2e.Predicate.test). Здесь то же для документа: какие карточки/броски он даёт,
// какие опции pf2e кладёт на них (ItemPF2e#getRollOptions / getOriginData, pf2e 8.6.1) и какие правила PA после этого срабатывают.
// Состояние актёра (feat:, self:, target:, origin:effect: …) неизвестно — предикат с ним «возможен»; срабатыванием считается «да» или «возможно» при ≥1 опции личности документа.
import { stripHtml } from "./lib.mjs";

const ROLL = new Set(["saving-throw", "skill-check", "attack-roll", "perception-check", "damage-roll"]);
const ACT = new Set(["action", "feat", "campaignFeature"]);
const SAVE = /@Check\[(?:fortitude|reflex|will)\b|\b(?:Fortitude|Reflex|Will)\s+(?:saves?|DC)\b|\bsaving throws?\b/i;
const SKILL = /@Check\[(?!fortitude|reflex|will|flat)[a-z-]+|\[\[\/act\s/i;
const UNKNOWN_PREFIX = /^(?:feat|feature|self|target|class|ancestry|heritage|deity|background|spellcasting|armor|weapon|shield|effect|origin:effect|origin:self|origin:actor|parent|sub-item|encounter|check|damage|domain|proficiency|skill|attack|scope|thaumaturge|stance|kinetic)(?::|$)/;
const SPELL_RANK_LEVEL = new Set(["level", "rank"]);

/** Опции ItemPF2e#getRollOptions(prefix) по данным документа (items.json). */
export function itemOptions(it, prefix) {
  const out = new Set();
  const kind = it.type === "feat" && it.category === "classfeature" ? "feature" : it.type;
  if (prefix !== kind) out.add(`${prefix}:type:${kind}`);
  out.add(`${prefix}:${it.slug}`); out.add(`${prefix}:slug:${it.slug}`);
  for (const t of it.traits ?? []) out.add(`${prefix}:trait:${t}`);
  if (it.rarity) out.add(`${prefix}:rarity:${it.rarity}`);
  if (it.type === "spell" || (it.traits ?? []).includes("magical")) out.add(`${prefix}:magical`);
  const lv = it.type === "spell" ? it.rank : it.level;
  if (Number.isInteger(lv)) out.add(`${prefix}:level:${lv}`);
  return out;
}

/** Какие триггеры PA документ порождает (по типу и тексту). */
export function triggersOf(it, html) {
  const act = ACT.has(it.type), text = html ?? "";
  const t = new Set();
  if (it.type === "spell") t.add("spell-cast");
  else if (act) t.add("postInfo");   // карточку пассивки тоже можно отправить в чат — postInfo как у живой; spell-cast — только origin.type === "spell" (helpers.ts triggerType)
  else { t.add("use"); t.add("postInfo"); }
  if (it.defense?.save || SAVE.test(stripHtml(text) + " " + text)) t.add("saving-throw");
  if (SKILL.test(text) || (act && /\[\[\/act\s/.test(text))) t.add("skill-check");
  if (/@Check\[perception/i.test(text)) t.add("perception-check");
  if ((it.traits ?? []).includes("attack") || it.type === "weapon" || /\bStrike\b/.test(text)) t.add("attack-roll");
  if (/@Damage\[/.test(text) || it.type === "weapon") t.add("damage-roll");
  if (it.type === "effect") t.add("self-effect");
  return t;
}

/** Предикат PA над опциями документа: "yes" | "no" | "maybe"; hit — опции личности документа, оказавшиеся «да». */
export function evalPredicate(pred, ctx) {
  const { trigger, it, origin, item, typed, src, html } = ctx;
  const roll = ROLL.has(trigger), npc = String(it.uuid).includes(".Actor.");
  let hit = 0;
  const known = (tok, set, prefix) => {
    if (set.has(tok)) return "yes";
    const rest = tok.slice(prefix.length + 1);
    if (/^(?:type|slug|trait|rarity|sourceId):/.test(rest) || /^[a-z0-9-]+$/.test(rest)) return "no";
    return rest.startsWith("level:") ? "maybe" : "maybe";
  };
  const tok = (s) => {
    let r;
    if (/^origin:item:sourceId:/.test(s)) r = s === `origin:item:sourceId:${src}` ? "yes" : "no";
    else if (s.startsWith("origin:item:")) r = known(s, origin, "origin:item");
    else if (roll && s.startsWith("item:")) r = known(s, item, "item");
    else if (trigger === "use" && s.startsWith(`${it.type}:`) && !UNKNOWN_PREFIX.test(s)) r = known(s, typed, it.type);
    else if (s.startsWith("mType:")) r = s === `mType:${trigger}` ? "yes" : "no";
    else if (s === "useEquipment") r = trigger === "use" ? "yes" : "no";
    else if (s.startsWith("outcome:")) r = roll ? "maybe" : "no";
    else if (s.startsWith("action:")) r = roll && (s === `action:${it.slug}` || html.includes(`[[/act ${s.slice(7)}`)) ? "yes" : "no";
    else if (s.startsWith("spell:")) r = "no";
    // состояние актёра, которого у NPC не бывает: классовые черты и эффекты игрока (аура кинетика) — «нет», а не «возможно»
    else if (npc && /^(?:feature|class):|^(?:origin|self):effect:(?:kinetic-aura|stance-)/.test(s)) r = "no";
    else r = "maybe";
    if (r === "yes" && /^(?:origin:item|item):(?:slug:)?[a-z0-9-]+$|^origin:item:sourceId:|^action:|^[a-z]+:(?:slug:)?[a-z0-9-]+$/.test(s) && !UNKNOWN_PREFIX.test(s) && !s.startsWith("mType:")) hit++;
    return r;
  };
  const and = (l) => (l.includes("no") ? "no" : l.every((x) => x === "yes") ? "yes" : "maybe");
  const or = (l) => (l.includes("yes") ? "yes" : l.every((x) => x === "no") ? "no" : "maybe");
  const not = (x) => (x === "yes" ? "no" : x === "no" ? "yes" : "maybe");
  const st = (s) => {
    if (typeof s === "string") return tok(s);
    if (!s || typeof s !== "object") return "maybe";
    if ("if" in s) return or([not(st(s.if)), st(s.then)]);
    const [k, v] = Object.entries(s)[0] ?? [];
    if (k === "and") return and(v.map(st));
    if (k === "or") return or(v.map(st));
    if (k === "not") return not(st(v));
    if (k === "nor") return not(or(v.map(st)));
    if (k === "nand") return not(and(v.map(st)));
    return "maybe";   // сравнения, xor, iff — не знаем
  };
  const preds = Array.isArray(pred) ? pred : pred == null ? [] : [pred];
  const res = and(preds.map(st));
  return { res, hit };
}

/** Правила PA (все активные группы), с триггером, предикатом и именем группы. */
export function paRules(groups) {
  return groups.filter((g) => g.isActive !== false).flatMap((g) => [...(g.baseRules ?? []), ...(g.complexRules ?? []), ...(g.handlerRules ?? [])].map((r) => ({ rule: r, group: g.name })));
}

/** Срабатывания PA на документе: [{group, trigger, res: yes|maybe, rule}]. Пусто — PA на нём не срабатывает (ложное покрытие). */
export function simulate(it, html, rules) {
  const src = it.embedded ? it.source ?? it.uuid : it.uuid;
  const triggers = triggersOf(it, html);
  const origin = itemOptions(it, "origin:item"), item = itemOptions(it, "item"), typed = itemOptions(it, it.type === "feat" && it.category === "classfeature" ? "feature" : it.type);
  const fires = [];
  for (const { rule, group } of rules) {
    if (!triggers.has(rule.triggerType)) continue;
    const { res, hit } = evalPredicate(rule.predicate, { trigger: rule.triggerType, it, origin, item, typed, src, html: html ?? "" });
    if (res !== "no" && hit > 0) fires.push({ group, trigger: rule.triggerType, res, rule });
  }
  return fires;
}
