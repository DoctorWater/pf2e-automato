// Мастерская, режим «Эффект»: чистое ядро (без Foundry при импорте, node-тесты).
// Модель: { name, level, img, dur: { value, unit, expiry, counter }, blocks: [кубик] } -> source эффекта pf2e с Rule Elements.
// Схемы RE сверены с pf2e 8.6.1 (pf2e.mjs): FlatModifier/DamageDice/Resistance/TempHP/FastHealing/Sense/Aura/TokenLight/Note.

export const KINDS = ["bonus", "resist", "temphp", "fastheal", "dmg", "speed", "sense", "cond", "note", "aura", "light", "raw"];
export const TARGETS = ["ac", "saving-throw", "attack-roll", "damage", "perception", "skill-check"];
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

/** Кубик -> массив Rule Elements. ctx.uuidOf(slug) — UUID состояния из компендиума (в рантайме: ConditionManager). */
export function rulesOf(b, ctx = {}) {
  switch (b.kind) {
    case "bonus": return [{ key: "FlatModifier", selector: b.target, type: b.type, value: signedValue(b) }];
    case "speed": return [{ key: "FlatModifier", selector: "land-speed", type: b.type, value: signedValue(b) }];
    case "resist": return [{ key: "Resistance", type: b.dmg, value: num(b.value), ...(excepts(b.except).length && { exceptions: excepts(b.except) }) }];
    case "temphp": return [{ key: "TempHP", value: num(b.value) }];
    case "fastheal": return [{ key: "FastHealing", value: num(b.value) }];
    case "dmg": return [{ key: "DamageDice", selector: "strike-damage", diceNumber: num(b.number), dieSize: b.die, damageType: b.dmgType }];
    case "sense": return [{ key: "Sense", selector: b.sense, ...(!PRECISE.has(b.sense) && { acuity: b.acuity }), ...(!NO_RANGE.has(b.sense) && { range: num(b.range) }) }];
    case "cond": {
      const uuid = b.uuid || ctx.uuidOf?.(b.slug);
      if (!uuid) return [];
      // значение — алтерацией badge-value, как в apply.mjs createTimed
      return [{ key: "GrantItem", uuid, onDeleteActions: { grantee: "restrict" }, ...(b.valued && { alterations: [{ mode: "override", property: "badge-value", value: num(b.value) }] }) }];
    }
    case "note": return [{ key: "Note", selector: b.target, ...(b.title?.trim() && { title: b.title.trim() }), text: b.text }];
    case "aura": return [{ key: "Aura", ...(String(b.slug ?? "").trim() && { slug: b.slug.trim() }), radius: num(b.radius), traits: [], effects: [] }];
    case "light": return [{ key: "TokenLight", value: { bright: num(b.bright), dim: num(b.dim) } }];
    case "raw": return parseRaw(b.json).rules;
  }
  return [];
}

/** Кубик -> строка для списка и описания. ctx.t(key, data) — перевод (ключи после PF2E_AUTOMATO.), ctx.condLabel(slug). */
export function textOf(b, ctx) {
  const { t } = ctx;
  switch (b.kind) {
    case "bonus": {
      const v = signedValue(b);
      return t("workshop.text.bonus", { target: t(`workshop.targets.${b.target}`), amount: amount(v), kind: t(`workshop.${v < 0 ? "penalty" : "bonus"}Kind.${b.type}`) });
    }
    case "speed": {
      const v = signedValue(b);
      return t("workshop.text.speed", { amount: amount(v), kind: t(`workshop.${v < 0 ? "penalty" : "bonus"}Kind.${b.type}`) });
    }
    case "resist": return t(excepts(b.except).length ? "workshop.text.resistExcept" : "workshop.text.resist", { type: t(`workshop.dtype.${b.dmg}`), value: b.value, except: excepts(b.except).join(", ") });
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
