// Мастерская, режим «Автоматизация»: чистое ядро (без Foundry при импорте, node-тесты).
// Работает поверх модели формы вкладки листа (sheet.mjs: ruleToForm/formToRule/applyOf) — свою модель правила не заводим.
import { DEGREES, degreeFromTotal } from "../util.mjs";
import { stepText } from "../chat.mjs";
import { textOfMods } from "../inline-effect.mjs";
import { modOf } from "../sheet.mjs";
import { defenseDc, pickStatistic } from "../checks.mjs";
import { perText } from "../cast.mjs";

export const SHAPES = ["burst", "cone", "line", "emanation"];
export const COLS = [...DEGREES].reverse();   // слева направо: крит. успех -> крит. провал
export const DEFAULT_AREA = { shape: "burst", size: 10 };

const num = (v) => { const s = String(v ?? "").trim().replace(",", "."); return s !== "" && Number.isFinite(Number(s)) ? Number(s) : null; };

/* ---------- режим броска: производная от ch.on / ck.on (взаимоисключающи в правиле) ---------- */

export const rollMode = (f) => (f.ch?.on ? "save" : f.ck?.on ? "check" : "none");
export function setRollMode(f, mode) { f.ch.on = mode === "save"; f.ck.on = mode === "check"; }
/** Путь (от корня состояния окна, где форма лежит в `f`) к спискам шагов по степеням. */
export const degPath = (mode) => (mode === "save" ? "f.ch.deg" : "f.ck.deg");

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

/* ---------- плашки шагов и сводки ---------- */

const plus = (n) => (n >= 0 ? `+${n}` : String(n));

/** Строка формы (step) -> плашка. env: {t, conditionLabel, uuidName, valued?(slug)}. */
export function plate(row, env) {
  const { t } = env;
  const dv = num(row.durValue) ?? (/^\d+d\d+$/i.test(String(row.durValue ?? "").trim()) ? String(row.durValue).trim() : null);
  let keep = {};
  try { keep = row.keep ? JSON.parse(row.keep) : {}; } catch { /* битая строка: пометок нет */ }
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
  if (row.kind === "extendEffect") return { ...base, name: t("workshop.au.extendPlate", { slug: row.text || "?", rounds: num(row.value) ?? "?" }) };
  if (row.kind === "rollOption") return { ...base, name: t(row.optOff ? "workshop.au.optionOffPlate" : "workshop.au.optionPlate", { option: row.text || "?" }) };
  if (row.kind === "effect") return { ...base, name: row.text?.startsWith("[") ? (() => { try { return textOfMods(JSON.parse(row.text), { t }); } catch { return "?"; } })() : row.text ? env.uuidName(row.text) ?? row.text : "?", dur: String(row.durValue ?? "").trim() ? t("workshop.au.dur", { value: String(row.durValue).trim(), unit: t(`workshop.unitShort.${row.durUnit}`) }) : "" };
  if (row.kind === "damage") return { ...base, name: `${String(row.text ?? "").trim() || "?"} · ${row.pType === "healing" ? t("workshop.au.healing") : env.damageLabel?.(row.pType) ?? row.pType}` };
  if (row.kind === "move") return { ...base, name: t(`workshop.au.movePlate.${row.moveMode === "pull" ? "pull" : "push"}`, { distance: String(row.text ?? "").trim() || "?" }) };
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
    head: `${t(`workshop.au.ev.on.${e.on}`)} · ${t(`workshop.au.ev.side.${e.side}`)}${when ? ` · ${when}` : ""}${e.side === "near" ? ` · ${e.aura?.trim() ? t("workshop.au.ev.auraShort", { aura: e.aura.trim() }) : t("workshop.au.ev.rangeShort", { range: e.range })}${e.per ? ` · ${t(`workshop.au.trg.per.${e.per}`)}` : ""}` : ""}${e.once ? ` · ${t("workshop.au.ev.onceShort")}` : ""}${e.afterUse ? ` · ${t("workshop.au.ev.afterUseShort")}` : ""}`,
    body: [steps, ch].filter(Boolean).join("; ") || t("workshop.au.nothing")
  };
}
/** Одна активация cast (форма) -> строка: заклинание · ранг · СЛ · частота · требование. */
export function castLine(c, env) {
  const { t } = env, dc = String(c.dc ?? "").trim(), pv = num(c.perValue);
  return {
    head: String(c.label ?? "").trim() || env.uuidName(c.spell) || String(c.spell ?? "").trim() || "?",
    body: [num(c.rank) !== null && t("cast.rank", { rank: num(c.rank) }), c.dcType === "high" ? t("workshop.au.cast.dcHigh") : c.dcType === "value" ? t("chat.dc", { dc: dc || "?" }) : t("workshop.au.cast.dcAuto"),
      pv !== null && perText({ value: pv, unit: c.perUnit, uses: num(c.perUses) ?? 1 }, t), c.requires !== "auto" && t(`workshop.au.cast.req.${c.requires}`)].filter(Boolean).join(" · ")
  };
}
const castSummary = (f, env) => ((f.cast ?? []).length ? f.cast.map((c) => { const l = castLine(c, env); return `${l.head}: ${l.body}`; }).join(" · ") : env.t("workshop.au.cast.none"));

const evSummary = (f, env) => ((f.ev ?? []).length ? f.ev.map((e) => { const l = evLine(e, env); return `${l.head}: ${l.body}`; }).join(" · ") : env.t("workshop.au.ev.none"));

/** Все сводки свёрнутых строк. env: {t, statLabel, conditionLabel, uuidName, valued?, dc, area:{shape,size}}. */
export function summaries(f, env) {
  const { t } = env, mode = rollMode(f), onUse = f.kind === "onUse";
  const yieldText = { yes: t("workshop.au.yieldYes"), no: t("workshop.au.yieldNo") }[f.yield];
  const when = [
    f.kind === "onAttacked" ? t("workshop.au.when.onAttacked", { value: plus(num(f.react.value) ?? 0), type: t(`workshop.btype.${f.react.type}`) })
      : t(`workshop.au.when.${f.kind}`),
    ...(f.label?.trim() ? [`«${f.label.trim()}»`] : []), ...(yieldText ? [yieldText] : [])
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
  return { when, targets: onUse ? targets : "", roll: onUse ? roll : "", outcome: onUse ? outcome : "", zone: onUse ? zone : "", macros, events: evSummary(f, env), cast: castSummary(f, env), mode, degLists };
}

/** Связный текст правила и строки по степеням для правой панели. */
export function story(f, env) {
  const { t } = env, s = summaries(f, env), mode = s.mode;
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
