// affliction: стадии недугов (яд, болезнь, проклятие) — разбор текста «Saving Throw … Maximum Duration … Stage N …» в определение шага `affliction` (plan-affliction.md §3).
// Модель пишет обычное правило; здесь определение собирается кодом: провал -> стадия 1, крит. провал -> стадия 2, одинаковый def в обоих шагах.
// Нераспознанное остаётся текстом стадии (stages[].text) и попадает в unsure. Отчёт по документам: node tools/affliction.mjs
import { readOut, stripHtml, isMain } from "./lib.mjs";
import { VALUED, NOTE_MAX, afflictionStages, parseCheck, validateRule, DAMAGE_TYPES, AFFLICTION_KINDS } from "../scripts/rules.mjs";
import { STEP_TARGETS, BONUS_TYPES } from "../scripts/workshop/effect.mjs";
import { normalizeMods } from "../scripts/inline-effect.mjs";

const UNIT = { r: "rounds", m: "minutes", h: "hours", d: "days" };
// неделя = 7 дней (схема знает до дней); месяцы/годы схемой не выражаются — ANY_DUR без DUR_END = нераспознанный срок -> долг
const dur = (v, u) => (/^w/i.test(u) ? { value: +v * 7, unit: "days" } : { value: +v, unit: UNIT[u[0].toLowerCase()] });
const DUR_END = /\(\s*(\d+)\s*(round|minute|hour|day|week)s?\s*\)\s*[.,;]?\s*$/i;
const ANY_DUR = /\([^()]*\b(?:round|minute|hour|day|week|month|year)s?\s*\)\s*[.,;]?\s*$/i;
const STAGE_MARK = /<strong>\s*Stage\s+(\d+)\s*<\/strong>/gi;
const SAVES = ["fortitude", "reflex", "will"];
const DASH = "[–−-]";
// «–10-foot status penalty to Speeds», «–2 status penalty to Fortitude saves»
const SPEED_MOD = new RegExp(`(${DASH})\\s?(\\d+)[- ]foot\\s+(status|circumstance|item)\\s+penalty\\s+to\\s+(?:all\\s+)?(?:its\\s+|your\\s+)?Speeds?`, "i");
const ROLL_MOD = new RegExp(`(${DASH})\\s?(\\d+)\\s+(status|circumstance|item)\\s+penalty\\s+to\\s+(AC|attack rolls|saving throws|Fortitude saves|Reflex saves|Will saves|Perception(?: checks)?|skill checks)`, "i");
const TARGET_OF = { ac: "ac", "attack rolls": "attack-roll", "saving throws": "saving-throw", "fortitude saves": "fortitude", "reflex saves": "reflex", "will saves": "will", perception: "perception", "perception checks": "perception", "perception rolls": "perception", "skill checks": "skill-check" };

// число после названия — значение только у valued-состояний (у dazzled/confused/paralyzed «1» — не значение)
// состояния, которые в тексте стадии бывают названы без ссылки
const BARE = ["clumsy", "drained", "enfeebled", "frightened", "sickened", "stupefied", "slowed", "stunned", "doomed", "blinded", "dazzled", "deafened", "fatigued", "paralyzed", "unconscious", "prone", "confused", "fascinated", "petrified", "restrained", "immobilized", "quickened", "off-guard", "fleeing", "grabbed", "invisible"];
// случайный срок (бросок) в тексте стадии: примитива нет, срок соседа не подставляем
const RANDOM = /\[\[\/(?:gmr|br)|\b\d+d\d+\s+(?:rounds?|minutes?|hours?|days?)\b/i;
const SKILLS = "acrobatics|arcana|athletics|crafting|deception|diplomacy|intimidation|medicine|nature|occultism|performance|religion|society|stealth|survival|thievery";

/** Один блок «Stage N …» (HTML без метки) -> стадия схемы + признак «часть текста не разобрана». known — slug-и состояний, названных ссылками в документе (для «and fatigued» без ссылки). */
export function parseStage(html, { condSlug, known }) {
  const out = { duration: null, damage: [], persistent: null, conditions: [], mods: null, text: "" };
  let t = stripHtml(html), ref = null, bad = false, lost = false;   // lost — разметка урона/бонуса разобрана не целиком: структура потеряна, а не только остаток
  const whole = t;
  const setPers = (p) => { if (out.persistent) bad = lost = true; else out.persistent = p; };   // второй продолжительный урон — не теряем молча
  const d = DUR_END.exec(t), badDur = !d && (ANY_DUR.test(t) || /\(\s*\d+\s*(?:month|year)s?\s*\)/i.test(t));
  if (d) { out.duration = dur(d[1], d[2]); t = t.replace(DUR_END, ""); }
  if (/\bor\s+@Damage\[/i.test(t)) bad = true;   // «@Damage … or @Damage» — альтернатива, не сумма
  const asStage = /\bas\s+stage\s+(\d+)\b/i.exec(t);
  if (asStage) { ref = +asStage[1]; t = t.replace(asStage[0], ""); }
  // @Damage[1d10[poison]], @Damage[1d6[persistent,bleed]]
  t = t.replace(/@Damage\[((?:[^[\]]|\[[^\]]*\])*)\](?:\{[^}]*\})?(?:\s+damage)?/gi, (_m, inner) => {
    const m = /^\(?\s*(\d+d\d+(?:\s*[+-]\s*\d+)?)\s*\)?\[([a-z,\s-]+)\]$/i.exec(inner.split("|")[0].trim());
    if (!m) {
      // несколько кубиков в одном @Damage: «2d6[fire],1d6[persistent,fire]»
      const g = [...inner.split("|")[0].matchAll(/(\d+d\d+(?:\s*[+-]\s*\d+)?)\[([a-z,\s-]+)\]/gi)];
      if (g.length < 2 || g.map((x) => x[0]).join(",") !== inner.split("|")[0].trim()) { bad = lost = true; return " "; }
      for (const [, fo, ty] of g) {
        const tt = ty.toLowerCase().split(/[,\s]+/), t1 = tt.find((x) => DAMAGE_TYPES.includes(x)), f1 = fo.replace(/\s+/g, "");
        if (!t1) bad = lost = true;
        else if (tt.includes("persistent")) setPers({ formula: f1, damageType: t1 });
        else out.damage.push({ formula: f1, damageType: t1 });
      }
      return " ";
    }
    const formula = m[1].replace(/\s+/g, ""), types = m[2].toLowerCase().split(/[,\s]+/);
    const type = types.find((x) => DAMAGE_TYPES.includes(x));
    if (!type) bad = lost = true;
    else if (types.includes("persistent")) setPers({ formula, damageType: type });
    else out.damage.push({ formula, damageType: type });
    return " ";
  });
  t = t.replace(/(\d+d\d+(?:\s*[+-]\s*\d+)?)\s+persistent\s+([a-z]+)(?:\s+damage)?/gi, (m, f, ty) => (DAMAGE_TYPES.includes(ty.toLowerCase()) ? (setPers({ formula: f.replace(/\s+/g, ""), damageType: ty.toLowerCase() }), " ") : m));
  t = t.replace(/(\d+d\d+(?:\s*[+-]\s*\d+)?)\s+([a-z]+)(?:\s+damage)?/gi, (m, f, ty) => (DAMAGE_TYPES.includes(ty.toLowerCase()) ? (out.damage.push({ formula: f.replace(/\s+/g, ""), damageType: ty.toLowerCase() }), " ") : m));
  const add = (slug, value) => { if (!out.conditions.some((c) => c.slug === slug)) out.conditions.push({ slug, ...(value != null && { value }) }); };
  t = t.replace(/@UUID\[([^\]]+)\](?:\{([^}]*)\})?(?:\s+(\d+)\b(?!\s*(?:round|minute|hour|day)))?/g, (m, uuid, label = "", after) => {
    const slug = condSlug(uuid);
    if (!slug) return m;
    const inLabel = /(\d+)\s*$/.exec(label)?.[1];
    // «@UUID[…]{Frightened} 1»: число после ссылки — значение, но только valued-состоянию; иначе число остаётся в тексте
    const useAfter = !inLabel && after && VALUED.has(slug);
    add(slug, inLabel ? +inLabel : useAfter ? +after : null);
    return after && !useAfter ? ` ${after} ` : " ";
  });
  for (const slug of [...new Set([...known, ...BARE])]) {
    const re = new RegExp(`\\b${slug.replace(/-/g, "[ -]")}\\b(?:\\s+(\\d+))?`, "i");
    // состояние без ссылки (не из known) берёт число только если valued; иначе число останется в остатке -> unsure
    t = t.replace(re, (_m, v) => { const use = v && (VALUED.has(slug)); add(slug, use ? +v : null); return use || !v ? " " : ` ${v}`; });
  }
  const mods = [];
  t = t.replace(new RegExp(`\\+(\\d+)\\s+(status|circumstance|item)\\s+bonus\\s+to\\s+(AC|attack rolls|saving throws|Fortitude saves|Reflex saves|Will saves|Perception(?: checks| rolls)?|${SKILLS})(?:\\s+(?:checks|rolls))?`, "gi"), (_m, n, ty, tg) => {
    const target = TARGET_OF[tg.toLowerCase()] ?? tg.toLowerCase();
    if (!STEP_TARGETS.includes(target)) return _m;   // неизвестная цель — остаётся в тексте, стадия непонятая
    mods.push({ bonus: { target, type: ty.toLowerCase(), value: +n } });
    return " ";
  });
  t = t.replace(/\bweakness\s+(\d+)\s+to\s+([a-z]+)/gi, (_m, n, ty) => (mods.push({ weak: { dmg: ty.toLowerCase(), value: +n } }), " "));
  t = t.replace(/\b(?:can'?t|cannot)\s+(?:use|take)\s+reactions\b/gi, () => (mods.push({ forbid: "reactions" }), " "));
  t = t.replace(SPEED_MOD, (_m, _s, n, type) => (mods.push({ speed: { type: type.toLowerCase(), value: -+n } }), " "));
  t = t.replace(ROLL_MOD, (_m, _s, n, type, tg) => {
    const target = TARGET_OF[tg.toLowerCase()];
    if (STEP_TARGETS.includes(target) && BONUS_TYPES.includes(type.toLowerCase())) mods.push({ bonus: { target, type: type.toLowerCase(), value: -+n } });
    return " ";
  });
  if (mods.length && !normalizeMods(mods).error) out.mods = normalizeMods(mods).mods;
  else if (mods.length) bad = lost = true;
  // остаток: связки и знаки не в счёт, любое слово — непонятая часть (сюжетное, «carrier with no ill effect», «dead»)
  t = t.replace(/\bcarrier(?:\s+with\s+no\s+(?:ill\s+)?effects?)?\b|\bno\s+(?:ill\s+)?effects?\b/gi, " ");
  const rest = t.replace(/\b(?:and|the|a|an|of|plus|but|also|with)\b|damage|[\s,.;:()—–-]/gi, "");
  if (rest || bad) { out.text = clip(plainMarkup(whole.replace(DUR_END, "")), 600); bad = true; }
  const left = t.replace(/\b(?:and|the|a|an|of|plus|but|also|with)\b|damage/gi, " ").replace(/[\s,.;:()—–-]+/g, " ").trim();
  const untyped = [...out.damage, out.persistent].some((x) => x?.damageType === "untyped");   // в стадии недуга «untyped» — не тип урона, а потеря типа
  return { stage: out, ref, unsure: bad, left, lost, random: RANDOM.test(whole), badDur, untyped, check: /@Check\[/.test(whole) };
}

// долг: состояние остаётся после срока недуга (linger, примитива нет)
const LINGER = /(?<!\bas\s+long\s+as\b[^.]*)\bpersists?\b|\bremains?\s+(?:even\s+)?after\b|\b(?:after|beyond)\s+(?:the\s+)?(?:poison|disease|curse|affliction)(?:'s)?\s+(?:duration\s+)?(?:ends?|is\s+over|expires?)\b|\bcondition\b[^.]*\b(?:lasts?|ends?)\s+(?:for|after)\s+(?:\d+|an?|one)\b|\b(?:value|condition)\s+reduces?\s+by\b|\blasts?\s+(?:for\s+)?\d+\s+(?:minute|hour|day|week)s?\b|\bby\s+1\s+(?:per|each|every)\s+(?:hour|day)\b|\bpermanent(?:ly)?\b|\bunlimited\s+duration\b|\bonce\b[^.]*\bawakens?\b/i;
// «<состояние> for N ед.» в остатке стадии: срок состояния свой, не срок стадии (ссылки на состояния к этому моменту уже вынуты)
const LINGER_LEFT = /\bfor\s+(\d+)\s+(round|minute|hour|day|week|month|year)s?\b/gi;
const SEC = { r: 6, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };   // месяц и год — разные длины; всё, что не равно сроку стадии, — долг
const sameDur = (v, u, d) => d && /^[rmhdw]/i.test(u) && +v * SEC[u[0].toLowerCase()] === d.value * SEC[d.unit[0]] && !/^mo/i.test(u);
// «scarlet color persists» — косметика, не состояние
const COSMETIC = /(\bcolou?r\s+(?:that\s+)?)persists?\b/gi;
// долг: уточнение в остатке стадии (выбор, условие, повтор) — стадия без него закрыта неверно
const REFINE = /\bor\b|\bfor\s+each\b|\bfor\s+\w+ing\b|\b(?:if|unless|until|as\s+long\s+as|instead|upon)\b|\bfor\s+\[\[\/gmr|\b(?:against|when|while|every|whenever|except|versus|increases?|using)\b|\breturns?\s+to\s+stage\b/i;   // against/when/while — не в списке решения 1, добавлены: условие на бонус/штраф стадии теряется (Alcohol «+1 … against fear»)
const LETHAL = /\b(?:dead|death|dies|you\s+die)\b/i;
// метка группы partial (приоритет сверху вниз): по ней идут выборки Критика и --write --groups
const GROUPS = [
  ["нельзя снять", /can'?t\s+(?:be\s+)?(?:end|reduced?|cured?|healed|recover|wake)|can'?t\s+(?:be\s+)?removed|can'?t\s+remove\s+(?!(?:the\s+)?armor)|cannot\s+(?:be\s+)?(?:reduced?|cured|end)|cannot\s+(?:be\s+)?removed|can'?t\s+heal\b[^.]*\buntil\b[^.]*\bcured|can'?t\s+reduce|doesn'?t\s+(?:automatically\s+)?(?:decrease|reduce|improve)|until\s+(?:the\s+\w+\s+is\s+)?(?:cured|treated)/i],
  ["особое излечение", /\bcounteract(?!\s+(?:check|modifier|rank|DC))|remove disease|(?<!\bor the (?:poison|disease|curse) is )\bcured\b|\bcures?\b|\b(?:curse|disease|poison)\s+ends\b|\bcleanse/i],
  ["иммунитет", /(?<!even if (?:they|it) (?:are|is) )\bimmune\b(?!\s+to\s+(?:their|its|the\s+spell'?s)\b)(?!\s+or\s+has\s+resistance)/i],
  ["экспозиция", /affects?\s+(?:any|every)one|\bexposed\b|\bspreads?\s+(?:to|by|through|via|from|among)\b|\bcontagious|\bwears?\b|\bwho\s+(?:touch|wear|drink|eat)/i],
  ["пока под действием", /(?<!\b(?:dies|died)\s)\bwhile\s+(?:infected|cursed|afflicted|poisoned|diseased|affected|under)\b|\beach\s+(?:round|turn|hour|day)\b|\bat\s+the\s+start\s+of\b|\bwhenever\b(?![^.]*\bStrikes?\b)|\bevery\s+(?:round|turn|hour)\b/i],
  ["сюжетное", /\b(?:rises?|transforms?|turns?\s+(?:in)?to\s+(?!(?:an?\s+)?(?:foam|mist|gas|vapor|smoke|liquid|dust|color))|becomes?\s+an?|resurrect|explod|reanimat|undead|decomposes)\b/i]
];
const groupOf = (text, dead) => GROUPS.find(([, re]) => re.test(text))?.[0] ?? (dead ? "смерть" : "прочее");

// признаки механики в тексте вне стадий: такое правило не собираем, а в долг
const MECH = /n't\b|cannot|immune|persist|reduc|instead|remain|\bonly\b|\bnote\b|cumulative|\blasts\b|whenever|each round|\bper round\b|first time|\battack\b|\btrigger\b|critical|doubl|halve|regain|\bGM\b|@UUID|@Check|@Damage|\bDC\b|saving throw|\d+ (?:round|minute|hour|day)|\bcondition\b|\bmust\b/i;
const LABELS = /^(saving throw|onset|maximum duration|activate|craft requirements|price|frequency|requirements)$/i;

// заглушки: «Level 7», «DC 38», «(1 day)», «(inhaled, poison)», «Access member of …», одиночная ссылка «Effect: …» — не механика
const STUB = /^(?:level\s+\d+|dc\s+\d+|\(\s*\d+\s*(?:round|minute|hour|day)s?\s*\)|\([a-z, -]+\)|access\b[^.]*|(?:effect:?\s*)?@UUID\[Compendium\.pf2e\.[a-z-]*effects[^\]]*\](?:\{[^}]*\})?\.?)$/i;

/** Метка недуга, чей лор вне стадий — не механика (решение 7): outsideText для них игнорируется. Список по uuid, регулярками лор от механики не отличить. */
export const FLAVOR_OK = new Set([
  "Compendium.pf2e.equipment-srd.Item.d5aCuFS1dhKXhsZ0",   // Addlebrain: как активировать
  "Compendium.pf2e.equipment-srd.Item.qhn0PSd5TPGpblbg",   // Forgetful Drops
  "Compendium.pf2e.extinction-curse-bestiary.Actor.0pw0r1w8vO7aRocN.Item.Ui0JxPyP262iI9kF",   // Xulgath Bile: заметка разработчиков
  "Compendium.pf2e.gatewalkers-bestiary.Actor.MiOTuSswwDadkxoq.Item.i4knnfXzsgLdowF8",   // Paralyzing Poison
  "Compendium.pf2e.gatewalkers-bestiary.Actor.piLAtgB51zXEHmFt.Item.ioNgUNL5jHE25fqI",
  "Compendium.pf2e.equipment-srd.Item.gza0CcZEYhPKIYEk",   // Spider Mold
  "Compendium.pf2e.equipment-srd.Item.xvJ2jzqipBNrwZ2w",   // Sightless Tincture
  "Compendium.pf2e.gatewalkers-bestiary.Actor.m1M7f4Rd5zuBRVDe.Item.pepIdjNqJtUTl9Wn"   // Frozen Nightmare
]);

/** Добавка к заметке по uuid: механика, которой кнопка не равна тексту (идёт в заметке первой). */
export const EXTRA_NOTE = new Map([
  ["Compendium.pf2e.equipment-srd.Item.oEOfOdcxkSnzSHPC", "Яд срабатывает на укусившего вас в течение часа; кнопка подвергает выбранную цель."]   // Frogskin Tincture
]);

/** Мёртвая стадия: срок снят, носитель не удаляется; смерть отмечает ГМ. */
export const DEATH_NOTE = "Отметьте смерть.";
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// текст стадии + заметка о смерти: заметка не обрезается, перед ней точка
const withDeath = (text) => { const b = clip(text.trim().replace(/[;,:\s]+$/, ""), 600 - DEATH_NOTE.length - 2); return `${b}${!b || /[.!?…]$/.test(b) ? "" : "."} ${DEATH_NOTE}`.trim(); };

/** Заметка недуга: механика (MECH) первой, лор после; обрезка по границе предложения. cutMech — механика не поместилась. */
export function noteOf(outsides, extra = "") {
  const segs = outsides.map((x) => ({ mech: MECH.test(x), t: plainMarkup(x) })).filter((x) => x.t);
  const parts = [...(extra ? [{ mech: true, t: extra }] : []), ...segs.filter((x) => x.mech), ...segs.filter((x) => !x.mech)];
  const all = parts.map((x) => x.t).join(" ");
  if (all.length <= NOTE_MAX) return { note: all, cutMech: false };
  const head = all.slice(0, NOTE_MAX), end = [...head.matchAll(/[.!?](?=\s|$)/g)].at(-1);
  const note = end ? head.slice(0, end.index + 1) : clip(all, NOTE_MAX);
  return { note, cutMech: parts.filter((x) => x.mech).map((x) => x.t).join(" ").length > note.length };
}

/**
 * Все тексты вне блоков «Stage N» (заглушки не в счёт) -> [строки]. Допустимо только вводное описание до первой стадии и без механики (MECH).
 * Общий для конвертера и checkAffliction.
 */
export function outsideTexts(html) {
  const found = [], secs = [[]], add = (t) => { if (!STUB.test(t)) found.push(t); };
  for (const m of html.matchAll(/<hr\s*\/?>|<p[^>]*>[\s\S]*?<\/p>/gi)) {
    if (/^<hr/i.test(m[0])) secs.push([]); else secs.at(-1).push(m[0]);
  }
  for (const ps of secs) {
    const items = ps.map((p) => ({ p, plain: stripHtml(p).trim(), label: /^<p[^>]*>\s*<strong>\s*([^<]*?)\s*<\/strong>/i.exec(p)?.[1] })).filter((x) => x.plain);
    const first = items.findIndex((x) => x.label != null && /^stage\s+\d+$/i.test(x.label));
    for (const [i, x] of items.entries()) {
      if (x.label == null) { if (MECH.test(x.plain) || (first >= 0 && i > first)) add(x.plain); continue; }
      if (/^stage\s+\d+$/i.test(x.label)) {
        x.p.replace(/^<p[^>]*>|<\/p>$/gi, "").split(/<br\s*\/?>/i).map((t) => t.trim()).filter((t) => stripHtml(t).trim() && !/^<strong>\s*Stage\s+\d+/i.test(t)).forEach((t) => add(stripHtml(t).trim()));
      } else if (!LABELS.test(x.label) && !/^\([a-z, -]+\)$/i.test(x.plain.slice(x.label.length).trim())) add(x.plain);   // «Название (poison)» — заголовок, не текст
    }
  }
  return found;
}

/** Первый текст вне стадий | "" (признак «есть чужой текст»). */
export const outsideText = (html) => outsideTexts(html)[0] ?? "";

/** Разметка Foundry -> читаемый текст заметки: @UUID[…]{Метка} -> Метка, @Damage[1d6[poison]] -> 1d6 poison, @Check[fortitude|dc:20] -> DC 20 fortitude. */
const plainMarkup = (s) => s
  .replace(/@(?:UUID|Damage|Check|Template)\[(?:[^[\]]|\[[^\]]*\])*\]\{([^}]*)\}/g, "$1")
  .replace(/@Damage\[((?:[^[\]]|\[[^\]]*\])*)\]/g, (_m, i) => i.replace(/\|.*$/, "").replace(/\[([^\]]*)\]/g, " $1").replace(/,/g, " "))
  .replace(/@Check\[([^\]]*)\]/g, (_m, i) => { const [st, ...p] = i.split("|"), dc = p.find((x) => x.startsWith("dc:"))?.slice(3); return dc ? `DC ${dc} ${st}` : st; })
  .replace(/@UUID\[[^\]]*\]/g, "").replace(/\[\[\/(?:gmr|r) [^\]]*\]\]\{([^}]*)\}/g, "$1").replace(/\s+/g, " ").trim();

/**
 * html документа -> { def, unsure: [строки], dcMissing } | null (нет блоков Stage, нет спасброска или вида недуга).
 * opts: { name, traits: [трейты предмета], ignoreOutside? (лор вне стадий — не механика), extraNote? (добавка к заметке: то, чего нет в тексте),kind?, save?: { statistic, dc? } (защита из defense.save у заклинания), condSlug(uuid) -> slug | null }
 */
export function parseAffliction(html, { name, traits = [], kind = null, save = null, condSlug = () => null, ignoreOutside = false, extraNote = "" } = {}) {
  if (typeof html !== "string") return null;
  const marks = [...html.matchAll(STAGE_MARK)].map((m) => ({ n: +m[1], at: m.index, end: m.index + m[0].length }));
  if (marks.length < 2 || marks.some((m, i) => m.n !== i + 1)) return null;
  const head = html.slice(0, marks[0].at);
  // спасбросок до первой стадии (у NPC dc: бывает пуст); у заклинания без @Check — защита документа
  let sv = null, check = null;
  for (const m of html.matchAll(/@Check\[([^\]]*)\]/g)) {
    const c = parseCheck(m[1]), s = (c.type ?? "").split(",")[0];
    if (SAVES.includes(s) && m.index < marks[0].at) { check = c; sv = { statistic: s, ...(/^\d+$/.test(c.params.dc ?? "") && { dc: +c.params.dc }) }; break; }
  }
  sv ??= save?.statistic && SAVES.includes(save.statistic) ? { statistic: save.statistic, ...(save.dc != null && { dc: save.dc }) } : null;
  const traitList = [...traits, ...(check?.params.traits?.split(",") ?? [])];
  const k = kind ?? AFFLICTION_KINDS.find((x) => traitList.includes(x)) ?? /\((poison|disease|curse)\)/i.exec(stripHtml(head))?.[1]?.toLowerCase() ?? null;
  if (!sv || !AFFLICTION_KINDS.includes(k)) return null;
  const plainHead = stripHtml(head), unsure = [];
  const du = /Maximum Duration\s+(\d+)\s*(round|minute|hour|day|week)s?(?!\w)/i.exec(plainHead), on = /Onset\s+(\d+)(?!\w)\s*(round|minute|hour|day|week)s?/i.exec(plainHead);
  if (/Maximum Duration/i.test(plainHead) && !du) unsure.push("duration: maximum duration not a plain number");   // иначе maxDuration=null — «без срока»
  if (/<strong>\s*Onset/i.test(head) && !on) unsure.push("onset: not a plain number");
  if ([...head.matchAll(/@Check\[(?:fortitude|reflex|will)/g)].length > 1) unsure.push("second save check in head");
  const outsides = ignoreOutside ? [] : outsideTexts(html).filter((x) => x.toLowerCase() !== (name ?? "").toLowerCase());   // заголовок — само название недуга
  if (outsides.length) unsure.push(`text outside stages: ${outsides[0].slice(0, 70)}`);
  const known = [...new Set([...html.matchAll(/@UUID\[([^\]]+)\]/g)].map((m) => condSlug(m[1])).filter(Boolean))];
  const stages = [], refs = [], infos = [], debt = [];
  marks.forEach((m, i) => {
    const stop = html.slice(m.end).search(/<\/p>|<hr|<br|<\/li>|$/);
    const next = marks[i + 1]?.at ?? Infinity;
    const r = parseStage(html.slice(m.end, Math.min(next, m.end + stop)), { condSlug, known });
    stages.push(r.stage); refs.push(r.ref); infos.push(r);
    if (r.unsure) unsure.push(`stage ${m.n}: ${r.stage.text}`);
  });
  // «as stage 2»: содержимое названной стадии, срок свой
  // у ссылающейся стадии свой разбор/остаток («except Clumsy 3», «plus Slowed 1») — копия молча теряет его: долг
  refs.forEach((ref, i) => {
    const src = ref && stages[ref - 1], s = stages[i];
    if (src && (infos[i].left || s.conditions.length || s.damage.length || s.persistent || s.mods)) { debt.push(`stage clarification: as stage ${ref} with changes`); return; }
    if (src) { stages[i] = { ...structuredClone(src), duration: stages[i].duration ?? src.duration }; infos[i] = { ...infos[ref - 1], ref }; }
  });
  // смертельная стадия: конечная — срок стадии и maxDuration недуга сняты (иначе носитель удалится), смерть отмечает ГМ
  const lastIx = stages.length - 1, lethal = infos.map((x, i) => (x.unsure && LETHAL.test(x.left) ? i : -1)).filter((i) => i >= 0);
  const dead = lethal.includes(lastIx);
  if (dead) { stages[lastIx].duration = null; stages[lastIx].text = withDeath(stages[lastIx].text); }
  if (lethal.some((i) => i !== lastIx)) debt.push("stage clarification: death before the last stage");
  // срок: у случайной стадии соседа не берём, смертельная конечная срока не имеет
  // срок стадии: без него — срок соседа, если однозначен; «конечная» стадия без срока — только у болезни/проклятия без Maximum Duration
  if (infos.some((x) => x.badDur)) unsure.push("duration: unrecognized stage duration");
  const skip = (i) => infos[i].random || infos[i].badDur || (dead && i === lastIx);
  const have = stages.filter((x, i) => x.duration && !skip(i)), missing = stages.map((x, i) => (x.duration || skip(i) ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    const uniq = [...new Map(have.map((x) => [`${x.duration.value}${x.duration.unit}`, x.duration])).values()];
    const endOk = !du && k !== "poison" && missing.length === 1 && missing[0] === stages.length - 1;
    if (!have.length) unsure.push("duration: no stage has one");
    else if (!endOk) {
      if (uniq.length === 1) missing.forEach((i) => { stages[i].duration = structuredClone(uniq[0]); });
      else unsure.push(`duration: stage ${missing[0] + 1} has none, neighbours differ`);
    }
  }
  if (!sv.dc) unsure.push("dc");
  // долг с причиной (решение 1): признаки, которые автомат закрывает неверно; всё остальное — честный partial
  const lefts = infos.map((x) => x.left).filter(Boolean), mine = [...outsides, ...lefts].join(" | ");
  const lingerHit = LINGER.exec(mine.replace(COSMETIC, "$1"))?.[0] ?? infos.map((x, i) => [...x.left.matchAll(LINGER_LEFT)].find((m) => !sameDur(m[1], m[2], stages[i].duration))?.[0]).find(Boolean);
  if (lingerHit) debt.push(`linger: ${lingerHit.slice(0, 60)}`);
  if (infos.some((x) => x.untyped)) debt.push("untyped damage in stage");
  if (infos.some((x) => x.check)) debt.push("stage clarification: @Check in stage");
  if (/\bimmune\s+to\s+(?:any\s+)?(?:additional|further|more|repeated)\s+(?:exposure|doses?)\b/i.test(mine)) debt.push("immune to additional exposure");   // reexpose поднимает стадию вопреки тексту
  if (/\bpersistent\b/i.test(mine) && stages.some((x) => x.damage.length) && !stages.some((x) => x.persistent)) debt.push("stage clarification: one-shot damage, text says persistent");
  const refine = lefts.map((x) => REFINE.exec(x)?.[0]).find(Boolean);
  if (refine || infos.some((x) => x.lost)) debt.push(`stage clarification: ${refine ?? "structure not parsed"}`);
  if (infos.some((x) => x.random)) debt.push("random duration");
  if (unsure.length && !stages.some((x) => x.damage.length || x.persistent || x.conditions.length || x.mods)) debt.push("no stage mechanics");
  const { note, cutMech } = noteOf(outsides, extraNote);
  if (cutMech) debt.push("note: mechanics exceed the limit");
  const group = groupOf(mine, dead);
  // virulent — только из трейтов (предмета, @Check) или скобок заголовка; слово в описании («addiction is virulent») признаком не служит, но правило под сомнением
  const virulent = traitList.includes("virulent") || /\([^)]*\bvirulent\b[^)]*\)/i.test(plainHead);
  if (!virulent && /\bvirulent\b/i.test(stripHtml(html))) debt.push("virulent in text, not in traits");
  return {
    def: { name: name ?? "", kind: k, save: sv, maxDuration: du && !dead ? dur(du[1], du[2]) : null, onset: on ? dur(on[1], on[2]) : null, virulent, ...(traitList.length && { traits: [...new Set(traitList.filter((x) => /^[a-z0-9-]+$/.test(x) && !AFFLICTION_KINDS.includes(x) && x !== "virulent"))] }), ...(note && { note }), stages },
    unsure, debt, group
  };
}

// Текстовый иммунитет по черте (план, шаг Д): «Goblins … are immune», «Creatures with the fungus trait are immune». Подлежащее без черты (Krakens, Gugs, имена) не покрыто — оно в заметке.
const IMMUNE_TRAITS = [["goblin", /\bgoblins?\b/i], ["fungus", /\bfung(?:us|i)\b/i], ["plant", /\bplants\b/i], ["ooze", /\boozes\b/i], ["ethereal", /\bethereal\b/i], ["troll", /\btrolls\b/i], ["anadi", /\banadis?\b/i]];
export function immuneTraits(html) {
  const out = new Set();
  for (const s of stripHtml(html).split(/(?<=[.;])\s+|\n/)) {
    if (!/\b(?:are|is) immune\b(?!\s+to\s+(?:fire|critical))/i.test(s) || /\bnot\b|n['’]t\b|\bif\b|\beven\b/i.test(s)) continue;
    const subj = s.split(/\b(?:are|is) immune\b/i)[0];   // черта только в подлежащем
    for (const [t, re] of IMMUNE_TRAITS) if (re.test(subj)) out.add(t);
  }
  return [...out];
}

/**
 * Правило недуга: провал -> стадия 1, крит. провал -> стадия 2. base — правило модели/вывода: его испытание (навык, СЛ, basic, черты) и остальные степени остаются,
 * провал и крит. провал заменяются шагами недуга. Без base испытание строится из @Check текста.
 * -> { rule, def, unsure } | null (текст не разобран или правило не прошло валидатор: unsure говорит почему)
 */
export function afflictionRule(html, opts = {}) {
  const p = parseAffliction(html, { ...opts, save: opts.save ?? opts.base?.onUse?.challenge });
  if (!p) return null;
  const c = opts.base?.onUse?.challenge, step = (stage) => ({ to: "target", affliction: { stage, def: p.def } });
  const immune = immuneTraits(html), dc = p.def.save.dc != null ? { value: p.def.save.dc } : c?.dc ?? { expr: "markup" };
  const challenge = {
    statistic: c?.statistic ?? p.def.save.statistic, dc: c?.dc ?? dc, basic: false, rollerRole: "target",
    ...(c?.traits && { traits: c.traits }), ...(c?.options && { options: c.options }), ...((c?.when || immune.length) && { when: [...(c?.when ?? []), ...immune.map((t) => ({ not: `target:trait:${t}` }))] }),
    byDegree: { ...c?.byDegree, failure: [step(1)], criticalFailure: [step(Math.min(2, p.def.stages.length))] }
  };
  const rule = { v: 1, ...(opts.name && { label: opts.name }), onUse: { targets: opts.base?.onUse?.targets ?? "selected", excludeSelf: null, zone: null, challenge, apply: opts.base?.onUse?.apply ?? [] } };
  const v = validateRule(rule);
  const meta = { debt: p.debt, group: p.group };
  return v.ok ? { rule: v.rule, def: v.rule.onUse.challenge.byDegree.failure[0].affliction.def, unsure: p.unsure, ...meta } : { rule: null, def: p.def, unsure: [...p.unsure, ...v.errors.map(String)], ...meta };
}

/**
 * Правило injury-яда (испытание цели при использовании) -> нанесение на оружие: onUse.challenge уходит в шаг coat, использование — на себя (plan-weapon-poison.md §5).
 * Остальные шаги onUse.apply остаются после coat. duration — срок яда (Envenom), без него яд держится до траты. -> валидное правило | null
 */
export function coatOf(rule, { duration = null } = {}) {
  const u = rule?.onUse;
  if (!u?.challenge || u.check || u.zone) return null;
  const coat = { v: 1, ...(rule.label && { label: rule.label }), onUse: { ...u, targets: "self", excludeSelf: null, challenge: null, apply: [{ to: "self", coat: { weapon: "choose", ...(duration && { duration }), challenge: { ...u.challenge, traits: u.challenge.traits ?? [...new Set([u.challenge.byDegree?.failure?.[0]?.affliction?.def?.kind, "injury"].filter(Boolean))] } } }, ...(u.apply ?? [])] } };
  const v = validateRule({ ...rule, ...coat });
  return v.ok ? v.rule : null;
}

function main() {
  const html = readOut("html.json"), { items } = readOut("items.json"), refs = readOut("refs.json");
  const byId = new Map(Object.entries(refs.conditions).map(([slug, c]) => [c.id, slug]));
  const condSlug = (u) => (u.includes(".conditionitems.") ? byId.get(u.split(".").pop()) ?? null : null);
  const seen = new Set();
  let n = 0, clean = 0, rule = 0, noParse = 0;
  const bad = [];
  for (const it of items) {
    const h = html[it.uuid];
    if (!afflictionStages(h) || seen.has(`${it.name}|${h}`)) continue;
    seen.add(`${it.name}|${h}`);
    n++;
    const r = afflictionRule(h, { name: it.name, traits: it.traits ?? [], condSlug, save: it.defense ? { statistic: it.defense.save } : null });
    if (!r) { noParse++; continue; }
    if (r.rule) rule++;
    if (r.rule && !r.unsure.length) clean++; else bad.push(`${it.name}: ${r.unsure.slice(0, 2).join(" | ").slice(0, 120)}`);
  }
  console.log(`документов со стадиями: ${n}; не разобрано (нет спасброска/вида): ${noParse}; правило собрано: ${rule}; без остатка: ${clean}`);
  console.log(bad.slice(0, 15).join("\n"));
}
if (isMain(import.meta.url)) main();
