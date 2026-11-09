// Мастерская, режим «Автоматизация»: чистое ядро (без Foundry при импорте, node-тесты).
// Работает поверх модели формы вкладки листа (sheet.mjs: ruleToForm/formToRule/applyOf) — свою модель правила не заводим.
import { DEGREES, degreeFromTotal } from "../util.mjs";
import { stepText } from "../chat.mjs";
import { textOfMods } from "../inline-effect.mjs";
import { modOf, keepGet, keepSet, blankCoat } from "../sheet.mjs";
import { ESCAPE_STATS, REPEAT_END, FAILED_CHECK } from "../rules.mjs";
import { STEP_TARGETS } from "./effect.mjs";
import { parseWhen, whenText, whenHuman } from "../predicate.mjs";
import { defenseDc, pickStatistic } from "../checks.mjs";
import { perText } from "../cast.mjs";

export const SHAPES = ["burst", "cone", "line", "emanation"];
export const COLS = [...DEGREES].reverse();   // слева направо: крит. успех -> крит. провал
export const DEFAULT_AREA = { shape: "burst", size: 10 };

const num = (v) => { const s = String(v ?? "").trim().replace(",", "."); return s !== "" && Number.isFinite(Number(s)) ? Number(s) : null; };

/* ---------- режим броска: производная от ch.on / ck.on (взаимоисключающи в правиле) ---------- */

export const rollMode = (f) => (f.ch?.on ? "save" : f.ck?.on ? "check" : "none");
export function setRollMode(f, mode) { f.ch.on = mode === "save"; f.ck.on = mode === "check"; }
/** Путь (от корня состояния окна) к спискам шагов по степеням; P — корень строк «Цели / Бросок / Исход»: `f` или шаги активации `f.cast.N[.choices.M].use`. */
export const degPath = (mode, P = "f") => `${P}.${mode === "save" ? "ch" : "ck"}.deg`;

/** Выход из режима «внутри» активации и сброс всего, что указывало в шаги: после удаления записи/варианта пути сдвигаются. */
export const resetCast = (a) => Object.assign(a, { sel: null, picker: null, card: null, stage: null, into: null });

/** Корень пути строк «Цели / Бросок / Исход»: правило (`f`) или шаги активации (`f.cast.N[.choices.M].use`). */
export const ROOT = String.raw`f(?:\.cast\.\d+(?:\.choices\.\d+)?\.use)?`;
/** Путь поля «Кто бросает»: не ловит `…ck.roll` (у проверки своё поле roll). */
export const ROLL_RE = new RegExp(String.raw`^(${ROOT})\.roll$`);

/** Предупреждение у строки «Цели»: зона пишется в правило только при цели «Область». */
export const zoneNote = (m, t) => (m.zone?.on && m.targets !== "area" ? { note: t("workshop.au.zoneNeedArea") } : null);

const stepCount = (u) => (u.apply?.length ?? 0) + (u.ch?.on || u.ck?.on ? COLS.reduce((n, d) => n + ((u.ch?.on ? u.ch : u.ck).deg?.[d]?.length ?? 0), 0) : 0);

/* ---------- форма/размер области <-> system.area заклинания и @Template в описании ---------- */

export const clampSize = (v) => Math.max(5, Math.ceil((Number(v) || 5) / 5) * 5);   // как pf2e: кратно 5, не меньше 5
export const templateTag = (shape, size) => `@Template[${shape}|distance:${clampSize(size)}]`;
const TEMPLATE_RE = /@Template\[([^\]]*)\]/;
const params = (inner) => inner.split("|").map((p) => p.trim()).filter(Boolean);
// тип — только первый позиционный параметр (pf2e.mjs:18833: #n(e, {first: "type"})) либо type:x
const isShapeParam = (p, i) => (i === 0 && !p.includes(":")) || /^type:/.test(p) || /^distance:/.test(p);

/** Первый @Template[...] описания -> {shape,size}|null (null и при неразобранном: distance:resolve(...) и т.п.). */
export function parseTemplate(html) {
  const m = TEMPLATE_RE.exec(html ?? "");
  if (!m) return null;
  const list = params(m[1]), kv = Object.fromEntries(list.filter((p) => p.includes(":")).map((p) => p.split(/:(.*)/s).slice(0, 2)));
  const shape = kv.type ?? (list[0] && !list[0].includes(":") ? list[0] : null), size = num(kv.distance);
  return shape && size ? { shape, size } : null;
}

/** "none" — тега нет; "parsed" — разобран; "unparsed" — тег есть, но мы его не понимаем (трогать нельзя). */
export const templateState = (html) => (!TEMPLATE_RE.test(html ?? "") ? "none" : parseTemplate(html) ? "parsed" : "unparsed");

/** Описание с тегом области: первый @Template обновляется (width/traits сохраняются), иначе дописывается абзац; неразобранный тег не трогаем. */
export function withTemplate(html, shape, size) {
  const src = html ?? "";
  const state = templateState(src);
  if (state === "unparsed") return src;
  if (state === "none") return `${src}<p>${templateTag(shape, size)}</p>`;
  return src.replace(TEMPLATE_RE, (_m, inner) => `@Template[${[shape, `distance:${clampSize(size)}`, ...params(inner).filter((p, i) => !isShapeParam(p, i))].join("|")}]`);
}

/** Начальная область: у заклинаний — system.area ({type,value}), иначе (и у заклинаний без неё) — тег в описании; нет — значения по умолчанию. */
export function initialArea({ isSpell, area, description }) {
  const a = isSpell && area ? { shape: area.type, size: area.value } : parseTemplate(description);
  return a ?? { ...DEFAULT_AREA };
}

/**
 * Что дописать в предмет при сохранении: цель «Область» и (ГМ изменил область относительно base либо у предмета нет источника области).
 * Заклинание — system.area; остальные — @Template в описание (кроме неразобранного тега). null — писать нечего.
 */
export function areaPatch({ isSpell, srcArea, description }, area, base, targets) {
  const size = clampSize(area.size);
  const changed = !(area.shape === base.shape && size === clampSize(base.size));
  const noSource = !(isSpell && srcArea) && templateState(description) === "none";   // области у предмета нет вовсе — без записи правило не заработает
  if (targets !== "area" || !(changed || noSource)) return null;
  if (isSpell) return srcArea?.type === area.shape && srcArea?.value === size ? null : { "system.area": { type: area.shape, value: size } };
  const html = withTemplate(description, area.shape, size);
  return html === (description ?? "") ? null : { "system.description.value": html };
}

/* ---------- «Дополнительно»: плашки-переключатели шага ----------
 * Поля шага вне строки формы (who, escape, repeat, unlessEffect, mark, choice) лежат в row.keep (JSON-строка): вкладка листа
 * несёт её скрытым полем и ничего не теряет, Мастерская правит через keepGet/keepSet. Допустимость — как в валидаторе (rules.mjs vApply). */

export const REFINE = ["ally", "enemy", "escape", "repeat", "unless", "mark", "choice"];
const REFINE_CARD = new Set(["escape", "repeat", "unless", "choice"]);   // плашки с параметрами: клик открывает карточку
const ESCAPE_DEFAULT = ["athletics", "acrobatics"];
const text = (v) => String(v ?? "").trim();
const csvList = (s) => text(s).split(",").map((x) => x.trim()).filter(Boolean);
const numOrRaw = (v) => { const s = text(v).replace(",", "."); return s === "" ? null : Number.isFinite(Number(s)) ? Number(s) : s; };   // нечисло уйдёт в валидатор ошибкой

/** Шаг лежит в списке по степеням испытания: повтор берёт навык и СЛ у испытания. */
export const inChallenge = (path) => /(^|\.)ch\.deg\./.test(path);
/** Эффект шага собран из свойств (effect.mods), а не готовый. */
export const isOwn = (row) => row.kind === "effect" && text(row.text).startsWith("[");

function refineWhy(row, key) {
  const own = isOwn(row), carrier = row.kind === "condition" || row.kind === "effect", k = keepGet(row);
  const base = (row.to !== "target" && "needTarget") || (!carrier && "needCarrier") || null;
  switch (key) {
    case "escape": return base || (k.repeat != null && "vsRepeat") || null;
    case "repeat": return base || (k.escape != null && "vsEscape") || (row.kind === "condition" && row.policy === "reduce" && "noReduce")
      || (row.kind === "effect" && (row.stack || row.unstack) && "noBadge") || (row.kind === "effect" && row.replace && "noReplace") || null;
    case "unless": return own ? "noOwn" : k.unlessEffect === "" ? "empty" : null;
    case "mark": return row.kind !== "effect" ? "needEffect" : own ? "noOwn" : null;
    case "choice": return row.kind !== "effect" ? "needEffect" : own ? "noOwn" : k.choice === "" ? "empty" : null;
    default:   // ally | enemy: в рантайме who проверяется только у шагов «к цели» (apply.mjs), у остальных молча не работает
      return row.to !== "target" || row.kind === "choose" ? "needTarget" : null;
  }
}

/** Плашки шага: [{key, on, card, why (код причины|null), locked (недоступна), bad (включена, но не сочетается или пуста)}]. */
export function refineState(row) {
  const k = keepGet(row);
  const on = { ally: k.who === "ally", enemy: k.who === "enemy", escape: k.escape != null, repeat: k.repeat != null, unless: k.unlessEffect != null, mark: k.mark != null, choice: k.choice != null };
  return REFINE.map((key) => { const why = refineWhy(row, key); return { key, on: on[key], card: REFINE_CARD.has(key), why, locked: !!why && !on[key], bad: !!why && on[key] }; });
}

export function refineSet(row, key, on) {
  if (key === "ally" || key === "enemy") keepSet(row, "who", on ? key : null);   // взаимоисключающие: одно поле who
  else if (key === "mark") keepSet(row, "mark", on ? "enemy" : null);
  else if (key === "escape") keepSet(row, "escape", on ? { stats: [...ESCAPE_DEFAULT] } : null);
  else if (key === "repeat") keepSet(row, "repeat", on ? { on: "turn-end" } : null);
  else if (key === "unless") keepSet(row, "unlessEffect", on ? "" : null);   // включена, значения ещё нет: applyOf пустое не пишет
  else if (key === "choice") keepSet(row, "choice", on ? "" : null);
}

/** Убрать из keep всё, что для строки недопустимо (после смены вида шага). hold — не поле правила, остаётся. */
export function keepFit(row) {
  for (const s of refineState(row)) if (s.on && s.why) refineSet(row, s.key, false);
}

/** Клик по плашке -> открыта ли её карточка. Недоступная — ничего; с параметрами: выключенная включается и открывается, включённая открывает/закрывает карточку. */
export function refineClick(row, key, open = false) {
  const s = refineState(row).find((x) => x.key === key);
  if (!s || s.locked) return false;
  if (s.card) { if (s.on) return !open; refineSet(row, key, true); return true; }
  refineSet(row, key, !s.on);
  return false;
}

/** Значения для полей карточек. */
export function keepView(row) {
  const k = keepGet(row), e = k.escape ?? {}, r = k.repeat ?? {}, es = e.stats ?? ESCAPE_DEFAULT, re = r.end ?? REPEAT_END;
  return {
    unless: k.unlessEffect ?? "", choice: k.choice ?? "",
    escape: { stats: Object.fromEntries(ESCAPE_STATS.map((s) => [s, es.includes(s)])), dc: e.dc ?? "", dcStat: e.dcStat ?? "" },
    repeat: { on: r.on ?? "turn-end", end: Object.fromEntries(DEGREES.map((d) => [d, re.includes(d)])), statistic: r.statistic ?? "", dc: r.dc ?? "", traits: (r.traits ?? []).join(", "), options: (r.options ?? []).join(", ") }
  };
}

/** Правка поля карточки: path — `unless`, `choice`, `escape.stats.<стат>`, `escape.dc|dcStat`, `repeat.on|end.<степень>|statistic|dc|traits|options`. */
export function keepEdit(row, path, v) {
  const [a, b, c] = path.split(".");
  if (a === "unless") return keepSet(row, "unlessEffect", text(v));
  if (a === "choice") {   // тип сохраняется: у числоподобной строки из каталога ("-2") остаётся строка
    const was = keepGet(row).choice, asText = typeof was === "string" && /^-?\d+$/.test(was);
    return keepSet(row, "choice", !asText && /^-?\d+$/.test(text(v)) ? Number(text(v)) : text(v));
  }
  const o = { ...(keepGet(row)[a] ?? {}) }, put = (key, val) => { if (val == null || val === "" || (Array.isArray(val) && !val.length)) delete o[key]; else o[key] = val; };
  if (b === "stats") o.stats = ESCAPE_STATS.filter((s) => (s === c ? !!v : (o.stats ?? ESCAPE_DEFAULT).includes(s)));
  else if (b === "end") o.end = DEGREES.filter((d) => (d === c ? !!v : (o.end ?? REPEAT_END).includes(d)));
  else if (b === "dc") put("dc", numOrRaw(v));
  else if (b === "traits" || b === "options") put(b, csvList(v));
  else put(b, text(v));
  keepSet(row, a, o);
}

/* ---------- шаг «эффект»: готовый | свой (effect.mods в row.text как JSON) ---------- */

export const MODS_MAX = 4;
export const MOD_ADD = ["bonus", "speed", "resist", "weak", "forbid"];
const MOD_DEFAULT = { bonus: { type: "status", value: -1 }, speed: { type: "status", value: -10 }, resist: { dmg: "fire", value: 5 }, weak: { dmg: "fire", value: 5 } };
export const modsOf = (row) => { try { const l = JSON.parse(row.text); return Array.isArray(l) ? l : []; } catch { return []; } };
const modsPut = (row, list) => { row.text = JSON.stringify(list); };
const modParts = (m) => { const [kind, v] = Object.entries(m ?? {})[0] ?? ["bonus", {}]; return [kind, kind === "forbid" ? null : v ?? {}]; };
const freeTarget = (list) => STEP_TARGETS.find((t) => !list.some((m) => m?.bonus?.target === t));

/** Свойства для списка: [{i, kind, value?, type?, target?, dmg?, except?}]. */
export const modsView = (row) => modsOf(row).map((m, i) => { const [kind, v] = modParts(m); return { i, kind, ...(v && { ...v, except: (v.except ?? []).join(", ") }) }; });
/** Можно добавить свойство вида: до 4, а дубль вида (у бонуса — той же цели) валидатор отвергает. */
export const modCanAdd = (row, kind) => { const l = modsOf(row); return l.length < MODS_MAX && (kind === "bonus" ? freeTarget(l) !== undefined : !l.some((m) => m?.[kind] != null)); };
export function modAdd(row, kind) {
  if (!modCanAdd(row, kind)) return;
  const l = modsOf(row);
  l.push(kind === "forbid" ? { forbid: "reactions" } : { [kind]: { ...(kind === "bonus" && { target: freeTarget(l) }), ...MOD_DEFAULT[kind] } });
  modsPut(row, l);
}
export function modRemove(row, i) { const l = modsOf(row); l.splice(i, 1); modsPut(row, l); }
/** Правка поля свойства. Значение — целое число (допустим ведущий «+»); пока набирается нечисло, едет строкой (валидатор покажет ошибку). */
export function modSet(row, i, field, v) {
  const l = modsOf(row), [kind, o] = modParts(l[i]);
  if (!o) return;
  if (field === "value") o.value = /^[+\-−]?\d+$/.test(text(v)) ? Number(text(v).replace("−", "-")) : text(v);
  else if (field === "except") { const x = csvList(v); if (x.length) o.except = x; else delete o.except; }
  else o[field] = v;
  l[i] = { [kind]: o };
  modsPut(row, l);
}
/* Снятое при смене режима прячется в keep.hold (в правило и в поля вкладки листа не идёт: applyOf берёт из keep только свои имена) и возвращается при возврате. */
const hold = (row, name, v) => { const h = { ...keepGet(row).hold }; if (v == null) delete h[name]; else h[name] = v; keepSet(row, "hold", Object.keys(h).length ? h : null); };
const HELD = ["unlessEffect", "mark", "choice"];

/** Переключить источник эффекта: "own" — свойства (срок обязателен, значок/замена/метка/выбор/«кроме» не сочетаются), "ready" — готовый (UUID). */
export function setEffectSource(row, src) {
  const k = keepGet(row);
  if (src === "own" && !isOwn(row)) {
    if (text(row.text)) hold(row, "uuid", text(row.text));
    for (const n of HELD) if (k[n] != null) { hold(row, n, k[n]); keepSet(row, n, null); }
    Object.assign(row, { text: "[]", stack: false, unstack: false, replace: false, durValue: text(row.durValue) || "1" });
    modAdd(row, "bonus");
  } else if (src === "ready" && isOwn(row)) {
    const h = k.hold ?? {};
    Object.assign(row, { text: h.uuid ?? "", durValue: "", durOf: "origin" });
    for (const n of ["uuid", ...HELD]) { if (n !== "uuid" && h[n] != null) keepSet(row, n, h[n]); hold(row, n, null); }
  }
}

/* ---------- правка вида/текста шага: логика, общая для отрисовки ---------- */

/** Смена вида шага: текст и значение сбрасываются (у choose — заготовка JSON), спрятанное и недопустимое для нового вида уходит из keep. */
export function setStepKind(row, kind) {
  Object.assign(row, { kind, text: kind === "persistent" ? "1d6" : kind === "choose" ? JSON.stringify({ from: "allies" }) : "", value: "" });
  if (kind === "coat") coatInit(row); else delete row.coat;
  keepSet(row, "hold", null);
  keepFit(row);
}
/** Шаг «яд на оружие»: пустая модель (row.coat), владелец — сам. */
export const coatInit = (row) => Object.assign(row, { to: "self", text: "", coat: blankCoat() });
/** Правка основного текста шага: состояние подставляет значение (valued — значимое ли), у эффекта «[…]» набрать нельзя (это свойства своего эффекта). */
export function setStepText(row, v, valued = false) {
  row.text = v;
  if (row.kind === "condition") row.value = valued ? row.value || "1" : "";
  else if (row.kind === "effect") row.text = String(v).replace(/^[\s[]+/, "");
}

/* ---------- шаг «Игрок выбирает» (row.text — JSON {from, options?, prompt?, range?, of?, withSelf?}) ---------- */

export const CHOOSE_FROM = ["allies", "enemies", "creatures", "options", "conditions"];
export const chooseOf = (row) => { try { const c = JSON.parse(row.text); return c && typeof c === "object" && !Array.isArray(c) ? c : {}; } catch { return {}; } };
const optsOf = (c) => (Array.isArray(c.options) ? c.options.map((o) => (typeof o === "string" ? { value: o } : { ...o })) : []);
export function chooseView(row) {
  const c = chooseOf(row);
  return { from: c.from ?? "", prompt: c.prompt ?? "", range: c.range ?? "", of: c.of ?? "", options: optsOf(c).map((o, i) => ({ i, value: o.value ?? "", label: o.label ?? "", when: typeof o.when === "string" ? o.when : whenText(o.when) })) };
}
/** Правка поля: from, prompt, range, of, добавление/удаление вариантов (`opt.add`, `opt.<i>.remove`) и их полей (`opt.<i>.value|label|when`). */
export function chooseSet(row, name, v) {
  const c = chooseOf(row), [a, i, f] = name.split(".");
  if (a === "opt") {
    const opts = optsOf(c);
    if (i === "add") opts.push({ value: "" });
    else if (f === "remove") opts.splice(Number(i), 1);
    else if (f === "when") { const w = parseWhen(v); if (w === undefined) delete opts[Number(i)].when; else opts[Number(i)].when = w; }
    else if (f === "value") opts[Number(i)].value = text(v);
    else if (text(v)) opts[Number(i)][f] = text(v); else delete opts[Number(i)][f];
    c.options = opts;
  } else if (a === "from") {
    c.from = v;
    const held = keepGet(row).hold?.options;   // варианты прячутся при уходе к существам и возвращаются обратно
    if (v === "options") { for (const k of ["range", "of", "withSelf", "where"]) delete c[k]; c.options = optsOf(c).length ? optsOf(c) : held?.length ? held : [{ value: "" }]; hold(row, "options", null); }
    else { if (optsOf(c).length) hold(row, "options", optsOf(c)); delete c.options; if (v !== "allies" && v !== "creatures") delete c.withSelf; if (v === "conditions") for (const k of ["range", "of", "where"]) delete c[k]; }
  } else if (a === "range") { const n = numOrRaw(v); if (n == null) delete c.range; else c.range = n; }
  else if (a === "of") { if (v === "target") c.of = "target"; else delete c.of; }
  else if (text(v)) c[a] = text(v); else delete c[a];
  row.text = JSON.stringify(c);
}

/* ---------- макросы: «макрос | встроенный» ---------- */

/** Смена вида макроса: оба начинают пустыми (встроенный — «—», обработчик выбирает ГМ). */
export function macroSetForm(m, form) {
  if ((form === "builtin") === (m.form === "builtin")) return;
  Object.assign(m, { form: form === "builtin" ? "builtin" : "", uuid: "" });
}
/** Список обработчиков для выбора: [[builtin:<id>, «Название (id)» или id]] по названию. name(id) — подпись из lang или null. */
export const builtinOptions = (ids, name) => ids.map((id) => { const n = name(id); return [`builtin:${id}`, n && n !== id ? `${n} (${id})` : id]; }).sort((a, z) => a[1].localeCompare(z[1]));

/* ---------- плашки шагов и сводки ---------- */

const plus = (n) => (n >= 0 ? `+${n}` : String(n));

/** Строка формы (step) -> плашка. env: {t, conditionLabel, uuidName, valued?(slug)}. */
export function plate(row, env) {
  const { t } = env;
  const dv = num(row.durValue) ?? (/^\d+d\d+$/i.test(String(row.durValue ?? "").trim()) ? String(row.durValue).trim() : null);
  const keep = keepGet(row);
  const [lo, hi] = [num(row.rankMin), num(row.rankMax)];
  const range = lo !== null && hi !== null ? (lo === hi ? lo : `${lo}–${hi}`) : lo !== null ? `${lo}+` : hi !== null ? `≤${hi}` : null;
  const note = [range !== null && t("workshop.au.keep.rank", { range }), row.kind === "effect" && row.stack && t("workshop.au.keep.stack"), row.kind === "effect" && row.unstack && !row.stack && t("workshop.au.keep.unstack"), row.kind === "removeEffect" && row.ofOrigin && t("workshop.au.keep.ofOrigin"),
    row.to === "party" && t("workshop.au.keep.party"), row.to === "chosen" && t("workshop.au.keep.chosen"), row.to === "allies" && t("workshop.au.keep.allies", { range: num(row.range) ?? "?" }), String(row.when ?? "").trim() && t("workshop.au.keep.when", { when: String(row.when).trim() }), keep.who && t(`workshop.au.keep.${keep.who}`), keep.unlessEffect && t("workshop.au.keep.unless"), keep.mark && t("workshop.au.keep.mark"), keep.choice != null && t("workshop.au.keep.choice", { v: keep.choice }), keep.escape && t("workshop.au.keep.escape"), keep.repeat && t("workshop.au.keep.repeat"), (row.dmgBasic === true || row.dmgBasic === "true") && t("workshop.au.keep.basic")].filter(Boolean).join(" · ");
  const base = { kind: row.kind, valued: false, value: "", dur: "", self: row.to === "self", note };
  if (row.kind === "condition") {
    const value = num(row.value);
    return {
      ...base, name: row.text ? env.conditionLabel(row.text) : "?", value: value ?? "",
      valued: value !== null || !!env.valued?.(row.text), dur: dv !== null ? t("workshop.au.dur", { value: dv, unit: t(`workshop.unitShort.${row.durUnit}`) }) : ""
    };
  }
  if (row.kind === "remove") return { ...base, name: t("workshop.au.removePlate", { name: row.text ? env.conditionLabel(row.text) : "?" }) };
  if (row.kind === "removeEffect") return { ...base, name: t("workshop.au.removePlate", { name: row.text ? env.uuidName(row.text) ?? row.text : "?" }) };
  if (row.kind === "extendEffect") return { ...base, name: t(row.text === "*" ? "workshop.au.extendCastPlate" : row.text === "~" ? "workshop.au.extendChosenPlate" : "workshop.au.extendPlate", { slug: row.text, rounds: num(row.value) ?? "?" }) };
  if (row.kind === "refundFocus") return { ...base, name: t("workshop.au.refundPlate") };
  if (row.kind === "rollOption") return { ...base, name: t(row.optOff ? "workshop.au.optionOffPlate" : "workshop.au.optionPlate", { option: row.text || "?" }) };
  if (row.kind === "effect") return { ...base, name: row.text?.startsWith("[") ? (() => { try { return textOfMods(JSON.parse(row.text), { t }); } catch { return "?"; } })() : row.text ? env.uuidName(row.text) ?? row.text : "?", dur: String(row.durValue ?? "").trim() ? t("workshop.au.dur", { value: String(row.durValue).trim(), unit: t(`workshop.unitShort.${row.durUnit}`) }) : "" };
  if (row.kind === "damage") return { ...base, name: `${String(row.text ?? "").trim() || "?"} · ${row.pType === "healing" ? t("workshop.au.healing") : env.damageLabel?.(row.pType) ?? row.pType}` };
  if (row.kind === "affliction") {   // недуг: плашка и сводка стадий
    let x = null;
    try { x = JSON.parse(row.text); } catch { /* битый JSON: строка «?» */ }
    return { ...base, name: x?.def ? t("workshop.au.afflPlate", { name: x.def.name || "?", stage: x.stage ?? 1, of: x.def.stages?.length ?? "?" }) : "?", note };
  }
  if (row.kind === "coat") {   // яд на оружие: название — по первому недугу в степенях его испытания
    const names = Object.values(row.coat?.ch?.deg ?? {}).flat().filter((r) => r.kind === "affliction").map((r) => { try { return JSON.parse(r.text)?.def?.name; } catch { return null; } });
    return { ...base, name: t("workshop.au.coatPlate", { name: names.find(Boolean) ?? "?" }), note };
  }
  if (row.kind === "move") return { ...base, name: t(`workshop.au.movePlate.${row.moveMode === "choose" ? "choose" : `${row.moveMode === "pull" ? "pull" : "push"}${row.moveFrom === "point" ? "Point" : ""}`}`, { distance: String(row.text ?? "").trim() || "?" }) };
  if (row.kind === "choose") return { ...base, name: t("workshop.au.choosePlate") };
  if (row.kind === "persistent") return { ...base, name: `${String(row.text ?? "").trim() || "?"} · ${env.damageLabel?.(row.pType) ?? row.pType}` };
  if (row.kind === "visibility") return { ...base, name: t(`chat.visLevel.${row.visLevel}`) };
  return { ...base, name: String(row.text ?? "").trim() || "?" };
}

export const plateText = (p) => `${p.name}${p.valued && p.value !== "" ? ` ${p.value}` : ""}${p.dur ? ` (${p.dur})` : ""}`;
const plates = (rows, env) => (rows ?? []).map((r) => plateText(plate(r, env))).join(", ");

const stats = (s, env) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => env.statLabel(x)).join(" / ");

function dcLabel(ch, env) {
  if (env.dc != null) return String(env.dc);
  const { t } = env, text = String(ch.dcText ?? "").trim();
  return { value: text, expr: text, markup: t("workshop.au.dcMarkup"), source: t("workshop.au.dcSource"), against: t("workshop.au.dcAgainst", { stat: env.statLabel(text) }) }[ch.dcType] || "?";
}

function vsLabel(k, env) {
  const { t } = env, x = String(k.vsText ?? "").trim();
  if (k.vsType === "none") return t("workshop.au.vsNone");
  if (k.vsType === "dc") return t("workshop.au.vsDc", { dc: x || "?" });
  return x === "ac" ? t("checks.ac") : t("workshop.au.vsStat", { stat: env.statLabel(x) });
}

const whoText = (f, env) => {
  const { t } = env;
  if (f.targets === "self") return t("workshop.au.who.self");
  if (f.targets === "area") return t("workshop.au.who.area", { shape: t(`workshop.au.shape.${env.area.shape}`), size: env.area.size });
  return t("workshop.au.who.selected");
};

/** Одна запись onEvent (форма) -> строка: событие · сторона · условие: шаги [· испытание]. */
export function evLine(e, env) {
  const { t } = env, when = String(e.when ?? "").trim();
  const steps = plates(e.apply, env), ch = e.ch?.on ? t("workshop.au.ev.chLine", { stat: env.statLabel(e.ch.statistic), dc: dcLabel(e.ch, { ...env, dc: null }) }) : "";
  return {
    head: `${[].concat(e.on).map((k) => t(`workshop.au.ev.on.${k}`)).join(", ")} · ${t(`workshop.au.ev.side.${e.side}`)}${when ? ` · ${when}` : ""}${e.side === "near" ? ` · ${e.aura?.trim() ? t("workshop.au.ev.auraShort", { aura: e.aura.trim() }) : t("workshop.au.ev.rangeShort", { range: e.range })}${e.per ? ` · ${t(`workshop.au.trg.per.${e.per}`)}` : ""}` : ""}${e.once ? ` · ${t("workshop.au.ev.onceShort")}` : ""}${e.afterUse ? ` · ${t("workshop.au.ev.afterUseShort")}` : ""}${e.cost ? ` · ${t("workshop.au.ev.costShort")}` : ""}`,
    body: [steps, ch].filter(Boolean).join("; ") || t("workshop.au.nothing")
  };
}
/** Одна активация cast (форма) -> строка: заклинание · ранг · СЛ · частота · требование. */
export const castDc = (c, t) => (c.dcType === "high" ? t("workshop.au.cast.dcHigh") : c.dcType === "class" ? t("workshop.au.cast.dc.class") : c.dcType === "value" ? t("chat.dc", { dc: String(c.dc ?? "").trim() || "?" }) : t("workshop.au.cast.dcAuto"));
export function castLine(c, env) {
  const { t } = env, pv = num(c.perValue);
  return {
    head: String(c.label ?? "").trim() || env.uuidName(c.spell) || String(c.spell ?? "").trim() || String(c.id ?? "").trim() || "?",
    body: [c.kind && c.kind !== "spell" && (c.kind === "choice" ? t("workshop.au.cast.choiceCount", { n: (c.choices ?? []).length }) : t(`workshop.au.cast.kind.${c.kind}`)),
      c.kind !== "choice" && c.kind !== "steps" && (c.rankMode?.startsWith("half-") ? t(`workshop.au.cast.rankMode.${c.rankMode}`) : num(c.rank) !== null && c.rankMode !== "base" && t("cast.rank", { rank: num(c.rank) })),
      castDc(c, t),
      (c.kind === "steps" || c.kind === "both") && c.use && t("workshop.au.cast.stepsN", { n: stepCount(c.use) }),
      pv !== null && perText({ value: pv, unit: c.perUnit, uses: num(c.perUses) ?? 1 }, t), c.requires !== "auto" && t(`workshop.au.cast.req.${c.requires}`)].filter(Boolean).join(" · ")
  };
}

/** Сводка шагов активации (модель use): цели, бросок, исход. Без области и макросов; СЛ правила в сводку не подмешиваем (dc: null). */
export function useSummary(u, env, c) {
  const own = String(u.ch?.dcText ?? "").trim() !== "";   // своё число в испытании — его и показываем, иначе СЛ записи активации (c)
  // СЛ записи без слова «СЛ»: сводка испытания сама пишет «СЛ {dc}»
  const dc = !c ? null : c.dcType === "value" ? String(c.dc ?? "").trim() || "?" : env.t(`workshop.au.dcCast.${["high", "class"].includes(c.dcType) ? c.dcType : "auto"}`);
  const s = summaries({ kind: "onUse", yield: "auto", label: "", ...u, ev: [], cast: [], macros: [] }, { ...env, dc: own ? null : dc });
  return { targets: u.targets === "area" ? env.t("workshop.au.targetsBtn.area") : s.targets, roll: s.roll, outcome: s.outcome };
}
/** Сводки всех записей и вариантов: { "cast.N": текст, "cast.N.choices.M": текст } для строк «Активации». */
export function useSummaries(casts, env) {
  const out = {}, one = (key, c) => { if (c.kind === "steps" || c.kind === "both") { const s = useSummary(c.use, env, c); out[key] = [s.targets, s.roll, s.outcome].join(" · "); } };
  (casts ?? []).forEach((c, i) => { one(`cast.${i}`, c); if (c.kind === "choice") c.choices.forEach((v, j) => one(`cast.${i}.choices.${j}`, v)); });
  return out;
}
const castSummary = (f, env) => ((f.cast ?? []).length ? f.cast.map((c) => { const l = castLine(c, env); return `${l.head}: ${l.body}`; }).join(" · ") : env.t("workshop.au.cast.none"));

const evSummary = (f, env) => ((f.ev ?? []).length ? f.ev.map((e) => { const l = evLine(e, env); return `${l.head}: ${l.body}`; }).join(" · ") : env.t("workshop.au.ev.none"));

/** Все сводки свёрнутых строк. env: {t, statLabel, conditionLabel, uuidName, valued?, dc, area:{shape,size}}. */
export function summaries(f, env) {
  const { t } = env, mode = rollMode(f), onUse = f.kind === "onUse" || isReaction(f);
  const yieldText = { yes: t("workshop.au.yieldYes"), no: t("workshop.au.yieldNo") }[f.yield];
  const when = [
    f.kind === "onAttacked" ? t("workshop.au.when.onAttacked", { value: plus(num(f.react.value) ?? 0), type: t(`workshop.btype.${f.react.type}`) })
      : t(`workshop.au.when.${f.kind}`),
    ...(f.label?.trim() && !isReaction(f) ? [`«${f.label.trim()}»`] : []), ...(yieldText ? [yieldText] : [])
  ].join(" · ");

  const targets = f.targets === "area"
    ? t("workshop.au.targets.area", { shape: t(`workshop.au.shape.${env.area.shape}`), size: env.area.size, author: t(`workshop.au.author.${f.excludeSelf}`) })
    : t(`workshop.au.targets.${f.targets}`);

  const roll = mode === "save" ? t("workshop.au.roll.save", { basic: f.ch.basic ? t("workshop.au.basic") : "", stat: env.statLabel(f.ch.statistic), dc: dcLabel(f.ch, env) })
    : mode === "check" ? t(f.ck.vsType === "none" ? "workshop.au.roll.checkSelf" : "workshop.au.roll.check", { stat: stats(f.ck.statistic, env) || "?", vs: vsLabel(f.ck, env) }) + (num(f.ck.map) ? ` · ${t("workshop.au.map", { n: num(f.ck.map) })}` : "")
    : t("workshop.au.roll.none");

  const degLists = mode === "none" ? [] : COLS.map((d) => ({ deg: d, text: plates((mode === "save" ? f.ch : f.ck).deg[d], env) }));
  const outcome = mode === "none" ? plates(f.apply, env) || t("workshop.au.nothing")
    : degLists.filter((x) => x.text).map((x) => `${t(`sheet.degree.${x.deg}`)}: ${x.text}`).join(" · ") || t("workshop.au.nothing");

  const z = f.zone;
  const zone = f.targets !== "area" ? t("workshop.au.zoneNeedsArea") : !z.on ? t("workshop.au.zoneOff")
    : t("workshop.au.zoneOn", { what: z.cond ? `${env.conditionLabel(z.cond)}${num(z.condValue) ? ` ${z.condValue}` : ""}` : z.effect ? env.uuidName(z.effect) ?? z.effect : z.trig?.length ? t("workshop.au.zoneTrig", { n: z.trig.length }) : "?" });
  const macros = f.macros.length ? t("workshop.au.macrosN", { n: f.macros.length }) : t("workshop.au.macrosNone");
  return { when, targets: onUse && !isReaction(f) ? targets : "", roll: onUse ? roll : "", outcome: onUse ? outcome : "", zone: onUse ? zone : "", macros, events: evSummary(f, env), cast: castSummary(f, env), mode, degLists };
}

export const isReaction = (f) => f.kind === "onDamaged" || f.kind === "onFailed";

/** Значения `prefix:<slug>` по всему предикату (в and/or/not тоже). */
const predSlugs = (p, prefix) => (typeof p === "string" ? (p.startsWith(prefix) && /^[a-z-]+$/.test(p.slice(prefix.length)) ? [p.slice(prefix.length)] : [])
  : Array.isArray(p) ? p.flatMap((x) => predSlugs(x, prefix)) : p && typeof p === "object" ? Object.entries(p).flatMap(([k, x]) => (k === "not" ? [] : predSlugs(x, prefix))) : []);
const damageTypesOf = (p) => predSlugs(p, "damage:type:");
/** Предикат без условий, которые фраза уже показала отдельно (типы урона, статистика): атомы с prefix и группы or только из них. */
function dropSlugs(p, prefix) {
  const only = (x) => (typeof x === "string" ? predSlugs(x, prefix).length > 0 : Array.isArray(x?.or) && x.or.every(only));
  if (only(p)) return undefined;
  if (!Array.isArray(p)) return p;
  const a = p.filter((x) => !only(x));
  return a.length ? a : undefined;
}

/** Кто реагирует: «владелец» / «фамильяр» / «союзник в 30 фт» (+ «включая владельца»). */
function reactWho(d, env) {
  const { t } = env, r = num(d.range);
  return d.who === "self" ? t("workshop.au.react.who.self") : d.who === "familiar" ? t("workshop.au.react.who.familiar")
    : t(`workshop.au.react.who.${d.who}`, { range: r ?? 30 }) + (d.withSelf ? t("workshop.au.react.withSelf") : "");
}

/** Условие срабатывания из предиката: типы урона отдельно, остальное — читаемой строкой «если …». */
function reactCond(d, env, prefix) {
  const { t } = env, p = parseWhen(d.when), r = dropSlugs(p, prefix);
  const types = [...new Set(damageTypesOf(p))].map((x) => env.damageLabel?.(x) ?? x);
  const rest = r === undefined ? "" : typeof r === "string" ? r : whenHuman(r);
  return { types, text: rest ? t("workshop.au.react.if", { when: rest }) : "" };
}

/** Фраза-история реакции (onDamaged/onFailed) для правой панели: на языке игрока, без служебных слов. */
export function reactLine(f, env) {
  const { t } = env, steps = plates(f.apply, env), req = String(f[f.kind === "onDamaged" ? "dm" : "fl"].requires ?? "").trim();
  const tail = [req && t("workshop.au.react.requiresText", { req }), steps && t("workshop.au.react.steps", { list: steps })].filter(Boolean).join(" ");
  if (f.kind === "onDamaged") {
    const d = f.dm, c = reactCond(d, env, "damage:type:"), x = d.mode;
    const mod = x === "reduce" ? t("workshop.au.react.reduce", { n: String(d.reduce ?? "").trim() || "?" })
      : x === "halve" ? t("workshop.au.react.halve")
      : x === "resist" ? Object.values(d.resist ?? {}).filter((r) => String(r.type ?? "").trim()).map((r) => t(r.type === "triggering" ? "workshop.au.react.resistTrigText" : "workshop.au.react.resist", { type: env.damageLabel?.(r.type) ?? r.type, n: String(r.value ?? "").trim() || "?" })).join(", ")
      : x === "redirect" ? t(`workshop.au.react.redirect.${d.part}`) : "";
    const hp = String(d.hp ?? "").trim();
    const parts = [mod, hp && t("workshop.au.react.costText", { hp }), d.triggerOnly && t("workshop.au.react.triggerOnlyText")].filter(Boolean).join("; ");
    return `${t("workshop.au.react.damaged", { who: reactWho(d, env), types: c.types.length ? t("workshop.au.react.ofTypes", { types: c.types.join(", ") }) : "", cond: c.text })}${parts ? ` — ${parts}` : ""}.${tail ? ` ${tail}` : ""}`;
  }
  const d = f.fl, c = reactCond(d, env, "check:statistic:"), on = FAILED_CHECK.filter((k) => d.check?.[k] === true || d.check?.[k] === "true");
  const stat = [...new Set(predSlugs(parseWhen(d.when), "check:statistic:"))];
  const what = on.length === FAILED_CHECK.length ? t("workshop.au.react.chk.any") : on.map((k) => t(`workshop.au.react.chk.${k}`)).join(", ");
  return `${t("workshop.au.react.failed", { degree: t(`workshop.au.react.deg.${d.degree}`), what, stat: stat.length ? t("workshop.au.react.stat", { stat: stat.map((s) => env.statLabel(s)).join(" / ") }) : "", who: d.who === "self" ? "" : t(`workshop.au.react.whoFail.${d.who}`, { range: num(d.range) ?? 30 }) + (d.withSelf ? t("workshop.au.react.withSelf") : ""), cond: c.text, keep: t(`workshop.au.react.keep.${d.keep}`) })}${tail ? ` ${tail}` : ""}`;
}

/** Связный текст правила и строки по степеням для правой панели. */
export function story(f, env) {
  const { t } = env, s = summaries(f, env), mode = s.mode;
  if (isReaction(f)) return { text: reactLine(f, env), degrees: [] };
  if (f.kind === "onAttacked") return { text: t("workshop.au.story.onAttacked", { value: plus(num(f.react.value) ?? 0), type: t(`workshop.btype.${f.react.type}`) }), degrees: [] };
  if (f.kind === "none") return { text: t("workshop.au.story.none"), degrees: [] };
  if (f.kind === "cast") return { text: t("workshop.au.story.cast"), degrees: (f.cast ?? []).map((c) => { const l = castLine(c, env); return { deg: "ev", label: l.head, text: l.body }; }) };
  if (f.kind === "onEvent") return { text: t("workshop.au.story.onEvent"), degrees: (f.ev ?? []).map((e) => { const l = evLine(e, env); return { deg: "ev", label: l.head, text: l.body }; }) };
  const who = whoText(f, env);
  const immediate = plates(f.apply, env);
  const text = mode === "save" ? t("workshop.au.story.save", { who, basic: f.ch.basic ? t("workshop.au.basic") : "", stat: env.statLabel(f.ch.statistic), dc: dcLabel(f.ch, env) })
    : mode === "check" ? t(f.ck.vsType === "none" ? "workshop.au.story.checkSelf" : "workshop.au.story.check", { stat: stats(f.ck.statistic, env) || "?", vs: vsLabel(f.ck, env) })
    : t(immediate ? "workshop.au.story.none-apply" : "workshop.au.story.none-empty", { who, list: immediate });
  const degrees = s.degLists.filter((x) => x.text).map((x) => ({ deg: x.deg, label: t(`sheet.degree.${x.deg}`), text: x.text }));
  if (mode !== "none" && immediate) degrees.unshift({ deg: "", label: t("workshop.au.immediate"), text: immediate });
  return { text, degrees };
}

/* ---------- шансы степеней ---------- */

/** d20 + mod против dc -> число граней из 20 на степень [крит. провал, провал, успех, крит. успех] (нат. 20/1 сдвигают степень). */
export function odds(mod, dc) {
  const n = [0, 0, 0, 0];
  for (let r = 1; r <= 20; r++) n[degreeFromTotal(r + mod, dc, r)]++;
  return n;
}
/** Самая вероятная степень (индекс 0..3); при равенстве — худшая, как в макете. */
export const likely = (n) => n.reduce((best, v, i) => (v > n[best] ? i : best), 0);

/**
 * Пробный запуск: по каждому токену модификатор, СЛ и шансы степеней. rule — валидное правило.
 * env: {t, dc (испытания), author, statLabel}. -> [{name, vs, counts|null, best, problems: []}]
 */
export function tokenOdds(rule, tokens, env) {
  const { t } = env, ch = rule.onUse?.challenge, ck = rule.onUse?.check;
  const authorStat = ck && env.author ? pickStatistic(env.author, ck.statistic) : null;
  return (tokens ?? []).map(({ name, actor }) => {
    const row = { name, vs: "", counts: null, best: null, problems: [] };
    let mod = null, dc = null, mapPenalty = 0;
    if (ch) {
      const st = pickStatistic(actor, ch.statistic);
      if (!st) row.problems.push(t("saves.noStatistic", { name, stat: ch.statistic }));
      else { mod = modOf(st); dc = env.dc; row.vs = t("workshop.au.vsSave", { stat: env.statLabel(ch.statistic), mod: plus(mod), dc: dc ?? "?" }); }
    } else if (ck?.vs) {   // без vs СЛ задаёт система: шансов не посчитать
      dc = defenseDc(actor, ck.vs);
      mapPenalty = 5 * (ck.mapIncreases ?? 0);   // agile (-4) не различаем: шансы приблизительные
      if (dc == null) row.problems.push(t("checks.dcUnknown", { name }));
      if (authorStat) {
        mod = modOf(authorStat) - mapPenalty;
        row.vs = `${mapPenalty ? "≈ " : ""}${t("workshop.au.vsCheck", { stat: env.statLabel(authorStat.slug ?? ck.statistic), mod: plus(mod), dc: dc ?? "?" })}`;
      }
    }
    if (mod !== null && dc != null) { row.counts = odds(mod, dc); row.best = likely(row.counts); }
    return row;
  });
}

/** Полосы для отображения: слева направо крит. успех -> крит. провал, доли в процентах (грань = 5%). */
export const bar = (counts) => COLS.map((d) => ({ deg: d, pct: counts[DEGREES.indexOf(d)] * 5 }));

/** Аргумент api.openWorkshop: голый Item, UUID-строка или {item, mode}. null — аргумент непонятен. */
export function openArgs(arg) {
  if (arg == null) return {};
  if (typeof arg === "string" || arg.documentName === "Item") return { item: arg };
  if (typeof arg !== "object" || Array.isArray(arg) || !("item" in arg || "mode" in arg)) return null;
  const { item = null } = arg;
  return item === null || typeof item === "string" || item.documentName === "Item" ? arg : null;
}
