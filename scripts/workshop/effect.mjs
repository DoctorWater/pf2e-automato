// Мастерская, режим «Эффект»: чистое ядро (без Foundry при импорте, node-тесты).
// Модель: { name, level, img, dur: { value, unit, expiry, counter }, blocks: [кубик] } -> source эффекта pf2e с Rule Elements.
// Схемы RE сверены с pf2e 8.6.1 (pf2e.mjs): FlatModifier/DamageDice/Resistance/TempHP/FastHealing/Sense/Aura/TokenLight/Note.
import { ENDS_EARLY } from "../util.mjs";
import { parseWhen, whenText, whenHuman, isPredicate } from "../predicate.mjs";

export const KINDS = ["bonus", "resist", "temphp", "fastheal", "dmg", "speed", "sense", "cond", "note", "aura", "light", "raw"];
export const TARGETS = ["ac", "saving-throw", "attack-roll", "damage", "perception", "skill-check"];
/** Цели модификатора в шагах правил: к TARGETS добавлены отдельные спасброски и навыки («−2 к Воле» не должно стать штрафом ко всем спасброскам). */
export const SAVES = ["fortitude", "reflex", "will"];
export const SKILLS = ["acrobatics", "arcana", "athletics", "crafting", "deception", "diplomacy", "intimidation", "medicine", "nature", "occultism", "performance", "religion", "society", "stealth", "survival", "thievery"];
export const STEP_TARGETS = [...TARGETS, ...SAVES, ...SKILLS];
export const NO_REACTIONS = "af:no-reactions";   // roll option актёра: эффект «нельзя использовать реакции»
export const BONUS_TYPES = ["status", "circumstance", "item", "untyped"];
// ключи CONFIG.PF2E.damageTypes (кости урона) и resistanceTypes (сопротивления)
export const DAMAGE_TYPES = ["fire", "cold", "electricity", "acid", "sonic", "force", "mental", "poison", "spirit", "vitality", "void", "bludgeoning", "piercing", "slashing", "bleed"];
export const RESIST_TYPES = [...DAMAGE_TYPES, "physical", "energy", "all-damage"];
export const DICE = ["d4", "d6", "d8", "d10", "d12"];
export const SENSES = ["darkvision", "greater-darkvision", "low-light-vision", "see-invisibility", "truesight", "infrared-vision", "echolocation", "scent", "tremorsense", "lifesense", "motion-sense", "bloodsense", "wavesense", "spiritsense", "thoughtsense", "magicsense", "electromagnetic-sense"];
export const PRECISE = new Set(["darkvision", "greater-darkvision", "low-light-vision", "see-invisibility", "truesight", "infrared-vision", "echolocation"]);   // acuity pf2e задаёт сам
export const NO_RANGE = new Set(["darkvision", "greater-darkvision", "low-light-vision", "see-invisibility"]);   // дальность не нужна
export const ACUITY = ["precise", "imprecise", "vague"];
export const UNITS = ["rounds", "minutes", "hours", "days", "unlimited"];
export const EXPIRY = ["turn-start", "turn-end"];
export const DEFAULT_IMG = "icons/svg/aura.svg";

/** Виды, которым можно задать условие (predicate pf2e): остальные (aura, light, raw, forbid, weak) его не берут. */
export const WHEN_KINDS = new Set(["bonus", "speed", "resist", "temphp", "fastheal", "dmg", "sense", "note", "cond"]);
/** Селекторы скорости: speed — «все» по смыслу all-speeds (читается из чужих правил, в списке показывается как «все Скорости»). */
export const SPEED_SEL = ["all-speeds", "land-speed", "fly-speed", "swim-speed", "climb-speed", "burrow-speed"];
const speedSel = (b) => b.sel ?? "all-speeds";
const isAllSpeeds = (sel) => sel === "all-speeds" || sel === "speed";
// Родовые домены pf2e (не конкретный Удар): правило с таким селектором остаётся raw
const GENERIC = new Set(["melee", "ranged", "melee-strike", "ranged-strike", "weapon", "unarmed", "spell", "attack", "inline", "str", "dex", "con", "int", "wis", "cha", "strike", "untrained", "trained", "expert", "master", "legendary"]);
/** Селектор "{slug}-attack|damage" конкретного Удара -> slug; родовой домен или не-Удар -> null. */
export function strikeSlug(selector, kind) {
  const s = typeof selector === "string" ? selector.match(new RegExp(`^(.+)-${kind}$`))?.[1] : null;
  return s && !GENERIC.has(s) && !/-(base|base-type|weapon-group|melee|ranged)$/.test(s) && !/[\s:]/.test(s) ? s : null;
}
/** «Чем бьёт» применимо: к урону от свойства и к бонусу на атаку/урон. */
export const hasStrike = (b) => b.kind === "dmg" || (b.kind === "bonus" && (b.target === "attack-roll" || b.target === "damage"));
const strikeOf = (b) => (hasStrike(b) ? String(b.strike ?? "").trim() : "");

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const num = (v) => {
  const s = String(v ?? "").trim().replace(",", ".");
  return s !== "" && Number.isFinite(Number(s)) ? Number(s) : NaN;
};
const amount = (n) => `${n < 0 ? "−" : "+"}${Math.abs(n)}`;
const excepts = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const signedValue = (b) => (num(b.sign) < 0 ? -1 : 1) * Math.abs(num(b.value));

const BLANKS = {
  bonus: { sign: 1, value: 1, type: "status", target: "ac" },
  resist: { dmg: "fire", value: 5, except: "" },
  temphp: { value: 5 },
  fastheal: { value: 2 },
  dmg: { number: 1, die: "d6", dmgType: "fire" },
  speed: { sign: 1, value: 10, type: "status" },
  sense: { sense: "darkvision", acuity: "imprecise", range: 30 },
  cond: { slug: "", uuid: "", name: "", value: 1, valued: false },
  note: { target: "saving-throw", title: "", text: "" },
  aura: { slug: "", radius: 10 },
  light: { bright: 20, dim: 40 },
  raw: { json: '{\n  "key": ""\n}' }
};
export const blankBlock = (kind) => ({ kind, ...BLANKS[kind] });
export const blankModel = () => ({ name: "", level: 0, img: DEFAULT_IMG, dur: { value: 1, unit: "minutes", expiry: "turn-start", counter: false }, blocks: [] });

/** Сырой JSON -> { rules: [объект], error: строка|null }. Допустим один объект или массив объектов с key. */
export function parseRaw(json) {
  let data;
  try { data = JSON.parse(json); } catch (e) { return { rules: [], error: String(e.message) }; }
  const list = Array.isArray(data) ? data : [data];
  if (!list.length || list.some((r) => !r || typeof r !== "object" || Array.isArray(r) || typeof r.key !== "string" || !r.key.trim())) return { rules: [], error: "key" };
  return { rules: list, error: null };
}

/** Кубик -> массив Rule Elements. ctx.uuidOf(slug) — UUID состояния из компендиума (в рантайме: ConditionManager). Условие (when) — predicate каждого правила. */
export function rulesOf(b, ctx = {}) {
  const rules = base(b, ctx), p = WHEN_KINDS.has(b.kind) ? parseWhen(b.when) : undefined;
  return isPredicate(p) ? rules.map((r) => ({ ...r, predicate: p })) : rules;
}

function base(b, ctx) {
  const s = strikeOf(b);
  switch (b.kind) {
    case "bonus": return [{ key: "FlatModifier", selector: s && b.target === "attack-roll" ? `${s}-attack` : s ? `${s}-damage` : b.target, type: b.type, value: signedValue(b) }];
    case "speed": return [{ key: "FlatModifier", selector: speedSel(b), type: b.type, value: signedValue(b) }];   // all-speeds — «ко всем Скоростям»; pf2e применяет к каждой
    // кубики шагов правил (inline-эффект, scripts/inline-effect.mjs); в палитру Мастерской не входят
    case "weak": return [{ key: "Weakness", type: b.dmg, value: num(b.value) }];
    case "forbid": return [{ key: "RollOption", domain: "all", option: NO_REACTIONS }];   // pf2e не запрещает реакции сам: опцию читают реакции модуля (reactionAvailable)
    case "resist": return [{ key: "Resistance", type: b.dmg, value: num(b.value), ...(excepts(b.except).length && { exceptions: excepts(b.except) }) }];
    case "temphp": return [{ key: "TempHP", value: num(b.value) }];
    case "fastheal": return [{ key: "FastHealing", value: num(b.value) }];
    case "dmg": return [{ key: "DamageDice", selector: s ? `${s}-damage` : "strike-damage", diceNumber: num(b.number), dieSize: b.die, damageType: b.dmgType }];
    case "sense": return [{ key: "Sense", selector: b.sense, ...(!PRECISE.has(b.sense) && { acuity: b.acuity }), ...(!NO_RANGE.has(b.sense) && { range: num(b.range) }) }];
    case "cond": {
      const uuid = b.uuid || ctx.uuidOf?.(b.slug);
      if (!uuid) return [];
      // значение — алтерацией badge-value, как в apply.mjs createTimed
      return [{ key: "GrantItem", uuid, onDeleteActions: { grantee: ENDS_EARLY.has(b.slug) ? "detach" : "restrict" }, ...(b.valued && { alterations: [{ mode: "override", property: "badge-value", value: num(b.value) }] }) }];
    }
    case "note": return [{ key: "Note", selector: b.target, ...(b.title?.trim() && { title: b.title.trim() }), text: b.text }];
    case "aura": return [{ key: "Aura", ...(String(b.slug ?? "").trim() && { slug: b.slug.trim() }), radius: num(b.radius), traits: [], effects: [] }];
    case "light": return [{ key: "TokenLight", value: { bright: num(b.bright), dim: num(b.dim) } }];
    case "raw": return parseRaw(b.json).rules;
  }
  return [];
}

// ---- условие: пресеты (единственный источник правды — строка when, пресет разбирается из неё) ----
const PRESET_DEFAULT = { targetCond: "prone", selfCond: "frightened", hpLess: "50", vsTrait: "mental" };
const ROLL_BONUS = new Set(["attack-roll", "damage", "skill-check", "perception"]);
/** Противник — нежить: у нападающего свой бросок (target:), у защищающегося — origin: (pf2e клонирует цель с origin нападающего). */
const rollish = (b) => b.kind === "dmg" || ((b.kind === "bonus" || b.kind === "note") && ROLL_BONUS.has(b.target));   // есть цель броска (у спасброска её нет)
const undeadAtom = (b) => (rollish(b) ? "target:mode:undead" : "origin:mode:undead");
/** Пресеты, доступные виду; "" — без условия, custom — запись руками. */
export function presetsFor(b) {
  const out = ["", "selfCond"];
  if (b.kind !== "cond") out.push("hpLess");
  if (b.kind === "dmg" || b.kind === "note" || b.kind === "resist" || b.kind === "bonus") out.push("undead");
  if (rollish(b)) out.push("targetCond");
  if ((b.kind === "bonus" && b.target === "saving-throw") || b.kind === "note") out.push("vsTrait");
  return [...["", "targetCond", "selfCond", "hpLess", "undead", "vsTrait"].filter((x) => out.includes(x)), "custom"];
}
/** when -> { preset, param }; не узнанное — custom. */
export function whenPresetOf(b) {
  const text = String(b.when ?? "").trim();
  if (b.whenPick === "custom") return { preset: "custom", param: "" };   // явный выбор «своё» (не отскакивает к узнанному пресету); сбрасывается правкой записи
  if (!text) return { preset: "", param: "" };
  const p = parseWhen(text), s = isPredicate(p) && p.length === 1 ? p[0] : null;
  const found = (() => {
    if (typeof s === "string") {
      if (s === undeadAtom(b)) return { preset: "undead", param: "" };
      const m = s.match(/^(target|self):condition:(.+)$/);
      if (m) return { preset: m[1] === "target" ? "targetCond" : "selfCond", param: m[2] };
      const v = s.match(/^item:trait:(.+)$/);
      if (v) return { preset: "vsTrait", param: v[1] };
    } else if (s && Object.keys(s).length === 1 && Array.isArray(s.lt) && s.lt[0] === "hp-percent" && Number.isFinite(s.lt[1])) return { preset: "hpLess", param: String(s.lt[1]) };
    return null;
  })();
  return found && presetsFor(b).includes(found.preset) ? found : { preset: "custom", param: "" };
}
/** Пресет (+ параметр, иначе значение по умолчанию) -> строка when. Выбор пресета сразу пишет полный предикат. */
export function whenFor(preset, param, b) {
  const x = String(param ?? PRESET_DEFAULT[preset] ?? "").trim();
  switch (preset) {
    case "targetCond": return x && `target:condition:${x}`;
    case "selfCond": return x && `self:condition:${x}`;
    case "hpLess": return x && Number.isFinite(num(x)) ? whenText([{ lt: ["hp-percent", num(x)] }]) : "";
    case "undead": return undeadAtom(b);
    case "vsTrait": return x && `item:trait:${x}`;
    case "custom": return String(b.when ?? "");
  }
  return "";
}
/** Все строки-утверждения предиката (рекурсивно, с операндами сравнений). */
export function whenAtoms(p) {
  const one = (s) => {
    if (typeof s === "string") return [s];
    if ("if" in s) return [...one(s.if), ...one(s.then)];
    const v = Object.values(s)[0];
    return Array.isArray(v) ? v.flatMap((x) => (typeof x === "string" || (x && typeof x === "object") ? one(x) : [])) : typeof v === "string" || (v && typeof v === "object") ? one(v) : [];
  };
  return Array.isArray(p) ? p.flatMap(one) : [];
}
// Условия, которые pf2e считает при подготовке актёра: бросков, цели и предмета там ещё нет
const PREP = new Set(["temphp", "fastheal", "sense", "speed", "cond"]);
const ROLL_ATOM = /^(target|origin|item|action|check|damage|weapon|attack|spell):/;
const RESIST_ATOM = /^(target|item|action|check|damage):/;   // origin: у сопротивления есть (клон цели с origin нападающего)

/** Суффикс «, если …»: узнанный пресет — подписью на языке игрока, своё условие — записью. */
export function whenSuffix(b, ctx) {
  const p = WHEN_KINDS.has(b.kind) ? parseWhen(b.when) : undefined;
  if (!isPredicate(p)) return "";
  const { t } = ctx, { preset, param } = whenPresetOf(b);
  const when = preset === "custom" ? whenHuman(p) : t(`workshop.when.${preset}`, { name: ctx.condLabel?.(param) ?? param, n: param, trait: ctx.traitLabel?.(param) ?? param });
  return t("workshop.text.when", { when });
}

/** Кубик -> строка для списка и описания. ctx.t(key, data) — перевод (ключи после PF2E_AUTOMATO.), ctx.condLabel(slug). */
export const textOf = (b, ctx) => body(b, ctx) + (strikeOf(b) ? ctx.t("workshop.text.strike", { strike: ctx.strikeLabel?.(strikeOf(b)) ?? strikeOf(b) }) : "") + whenSuffix(b, ctx);

function body(b, ctx) {
  const { t } = ctx;
  switch (b.kind) {
    case "bonus": {
      const v = signedValue(b);
      return t("workshop.text.bonus", { target: t(`workshop.targets.${b.target}`), amount: amount(v), kind: t(`workshop.${v < 0 ? "penalty" : "bonus"}Kind.${b.type}`) });
    }
    case "speed": {
      const v = signedValue(b);
      const kind = t(`workshop.${v < 0 ? "penalty" : "bonus"}Kind.${b.type}`);
      return isAllSpeeds(speedSel(b)) ? t("workshop.text.speed", { amount: amount(v), kind }) : t("workshop.text.speedSel", { speed: ctx.speedLabel?.(speedSel(b)) ?? speedSel(b), amount: amount(v), kind });
    }
    case "resist": return t(excepts(b.except).length ? "workshop.text.resistExcept" : "workshop.text.resist", { type: t(`workshop.dtype.${b.dmg}`), value: b.value, except: excepts(b.except).join(", ") });
    case "weak": return t("workshop.text.weak", { type: t(`workshop.dtype.${b.dmg}`), value: b.value });
    case "forbid": return t("workshop.text.forbid");
    case "temphp": return t("workshop.text.temphp", { value: b.value });
    case "fastheal": return t("workshop.text.fastheal", { value: b.value });
    case "dmg": return t("workshop.text.dmg", { number: b.number, die: b.die, type: t(`workshop.dtype.${b.dmgType}`) });
    case "sense": return t(NO_RANGE.has(b.sense) ? "workshop.text.senseFree" : "workshop.text.sense", { sense: t(`workshop.senses.${b.sense}`), range: b.range });
    case "cond": {
      const name = b.name || ctx.condLabel?.(b.slug) || b.slug || "?";
      return t("workshop.text.cond", { name: b.valued ? `${name} ${b.value}` : name });
    }
    case "note": return t("workshop.text.note", { target: t(`workshop.targets.${b.target}`), text: String(b.text ?? "").replace(/<[^>]*>/g, "").trim() });
    case "aura": return t("workshop.text.aura", { radius: b.radius });
    case "light": return t("workshop.text.light", { bright: b.bright, dim: b.dim });
    case "raw": return t("workshop.text.raw", { keys: parseRaw(b.json).rules.map((x) => x.key).join(", ") || "?" });
  }
  return "";
}

/** Длительность: { short, long } для значка и подписи. */
export function durationText(dur, t) {
  if (dur.unit === "unlimited") return { short: "∞", long: t("workshop.dur.unlimitedLong") };
  return {
    short: t("workshop.dur.short", { value: dur.value, unit: t(`workshop.unitShort.${dur.unit}`) }),
    long: t("workshop.dur.long", { value: dur.value, unit: t(`workshop.unitShort.${dur.unit}`), expiry: t(`workshop.expiryLong.${dur.expiry}`) })
  };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Автотекст описания эффекта (обычный текст; "" без кубиков). */
export const descriptionText = (blocks, ctx) => (blocks.length ? ctx.t("workshop.desc.prefix", { list: blocks.map((b) => textOf(b, ctx)).join("; ") }) : "");
export const descriptionOf = (blocks, ctx) => (blocks.length ? `<p>${esc(descriptionText(blocks, ctx))}</p>` : "");

/** Ошибки на понятном языке; пустой массив — можно создавать. */
export function validate(m, ctx) {
  const { t } = ctx, out = [];
  if (!String(m.name ?? "").trim()) out.push(t("workshop.err.name"));
  if (!Number.isInteger(num(m.level)) || num(m.level) < 0) out.push(t("workshop.err.level"));
  if (m.dur.unit !== "unlimited" && !(Number.isInteger(num(m.dur.value)) && num(m.dur.value) > 0)) out.push(t("workshop.err.duration"));
  if (!m.blocks.length) out.push(t("workshop.err.empty"));
  m.blocks.forEach((b, i) => {
    const bad = (key, data) => out.push(t("workshop.err.block", { n: i + 1, what: t(`workshop.err.${key}`, data) }));
    const pos = (v) => Number.isFinite(num(v)) && num(v) > 0;
    switch (b.kind) {
      case "bonus": case "speed": case "temphp": case "fastheal": if (!pos(b.value)) bad("value"); break;
      case "resist": { if (!pos(b.value)) bad("value"); const ex = excepts(b.except); if (ex.some((x) => !SLUG.test(x))) bad("except"); else { const u = ex.find((x) => ctx.resistKnown && !ctx.resistKnown(x)); if (u) bad("exceptUnknown", { key: u }); } break; }
      case "dmg": if (!(Number.isInteger(num(b.number)) && num(b.number) > 0)) bad("dice"); break;
      case "sense": if (!NO_RANGE.has(b.sense) && !pos(b.range)) bad("range"); break;
      case "cond": if (!(b.uuid || ctx.uuidOf?.(b.slug))) bad("cond"); else if (b.valued && !pos(b.value)) bad("value"); break;
      case "note": if (!String(b.text ?? "").trim()) bad("noteText"); break;
      case "aura": {
        const sl = String(b.slug ?? "").trim(), r = num(b.radius);
        if (sl && !SLUG.test(sl)) bad("slug");
        if (!(r >= 5 && r <= 240 && r % 5 === 0)) bad("radius");   // pf2e клампит ceil(r/5)*5 в 5..240
        break;
      }
      case "light": if (!(num(b.bright) >= 0 && num(b.dim) >= 0 && num(b.bright) + num(b.dim) > 0)) bad("light"); else if (num(b.dim) < num(b.bright)) bad("lightDim"); break;
      case "raw": { const r = parseRaw(b.json); if (r.error === "key") bad("rawKey"); else if (r.error) bad("rawJson", { error: r.error }); else { const u = r.rules.find((x) => ctx.ruleKnown && !ctx.ruleKnown(x.key)); if (u) bad("rawUnknown", { key: u.key }); } break; }
    }
    if (hasStrike(b) && strikeOf(b) && ctx.sluggify && strikeOf(b) !== ctx.sluggify(strikeOf(b))) bad("strike");   // Челюсти-damage не сработает: домен — слаг
    if (WHEN_KINDS.has(b.kind) && String(b.when ?? "").trim()) {
      const p = parseWhen(b.when), atoms = isPredicate(p) ? whenAtoms(p) : [];
      if (!isPredicate(p)) bad("whenBad");
      else if ((PREP.has(b.kind) && atoms.some((a) => ROLL_ATOM.test(a))) || (b.kind === "resist" && atoms.some((a) => RESIST_ATOM.test(a)))) bad("whenRoll");
      else if (b.kind === "cond" && atoms.some((a) => a.startsWith("hp-percent"))) bad("whenHp");   // GrantItem считается раньше, чем pf2e выставляет hp-percent
    }
  });
  return out;
}

/** Модель -> source мирового Item типа effect. */
export function buildEffect(m, ctx) {
  const d = m.dur, unlimited = d.unit === "unlimited";
  return {
    name: String(m.name).trim(), type: "effect", img: m.img || DEFAULT_IMG,
    system: {
      level: { value: num(m.level) || 0 },
      duration: { value: unlimited ? -1 : num(d.value), unit: d.unit, expiry: unlimited ? null : d.expiry, sustained: false },
      ...(d.counter && { badge: { type: "counter", value: 1, min: 1, max: null, labels: null } }),
      tokenIcon: { show: true },
      rules: m.blocks.flatMap((b) => rulesOf(b, ctx)),
      description: { value: descriptionOf(m.blocks, ctx) }
    }
  };
}
