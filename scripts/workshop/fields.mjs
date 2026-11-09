// Мастерская, режим «Автоматизация»: описатели полей для шаблона (чистое ядро без Foundry, node-тесты).
import { DEGREES } from "../util.mjs";

export const withCur = (opts, cur) => {
  const list = Array.isArray(opts) ? opts : Object.entries(opts);
  const out = list.map(([value, label]) => ({ value, label }));
  return cur === undefined || cur === null || out.some((o) => String(o.value) === String(cur)) ? out : [...out, { value: cur, label: String(cur) }];
};
export const F = {
  seg: (path, label, cur, opts, extra = {}) => ({ path, label, ...extra, seg: opts.map(([value, l]) => ({ value, label: l, on: String(cur) === value })) }),
  num: (path, label, value, extra = {}) => ({ path, label, type: "number", value, inpCls: "ws-num", ...extra }),
  text: (path, label, value, extra = {}) => ({ path, label, type: "text", value, ...extra }),
  sel: (path, label, value, opts, extra = {}) => ({ path, label, value, options: withCur(opts, value), ...extra }),
  chk: (path, label, value, extra = {}) => ({ path, label, check: true, value, ...extra })
};

/** Поля, зависящие от подписей: t — функция перевода (в окне L, в тестах любая). */
export function fieldKit(t) {
  const sheetChoices = (prefix, list) => Object.fromEntries(list.map((k) => [k, t(`sheet.${prefix}.${k}`)]));

  /** Условие испытания (предикат pf2e по целям): испытание проводится только для подходящих. */
  const chWhen = (p, c) => F.text(`${p}.when`, t("workshop.au.chWhen"), c.when, { cls: "ws-full", placeholder: "target:trait:undead", hint: t("workshop.au.chWhenHint") });

  /** Невосприимчивость после действия (испытание и проверка): p — путь модели (f.ch.imm | f.ck.imm), m — её значение. */
  const immFields = (p, m) => [
    F.chk(`${p}.on`, t("workshop.au.immunity"), m.on),
    ...(m.on ? [
      F.text(`${p}.slug`, t("workshop.au.immSlug"), m.slug), F.text(`${p}.label`, t("sheet.label"), m.label), F.text(`${p}.uuid`, "UUID", m.uuid, { drop: "effect" }),
      F.num(`${p}.value`, t("sheet.duration"), m.value, { min: 1 }), F.sel(`${p}.unit`, t("workshop.au.unit"), m.unit, sheetChoices("unit", ["minutes", "hours", "days"])),
      ...DEGREES.map((d) => F.chk(`${p}.deg.${d}`, t(`workshop.au.immOn.${d}`), m.deg[d])), F.chk(`${p}.any`, t("workshop.au.immAny"), m.any)
    ] : [])
  ];

  /**
   * Поля броска у объекта m с корнем пути P (f | f.ev.i | f.zone.trig.i | f.cast.N[.choices.M].use): испытание (mode "save") или проверка ("check").
   * Сегмента «кто бросает» здесь нет — его рисует вызывающий (его нет у событий и триггеров).
   * activation: СЛ активации — только число (или пусто: возьмётся СЛ записи), поэтому без «источника», выражений и «против».
   */
  function rollFieldsOf(P, m, { mode, activation = false }) {
    if (mode === "save") {
      const c = m.ch, out = [
        F.text(`${P}.ch.statistic`, t("sheet.statistic"), c.statistic, { list: "ws-skills" }),
        F.sel(`${P}.ch.dcType`, t("sheet.dcLabel"), c.dcType, sheetChoices("dc", activation ? ["value"] : ["value", "expr", "markup", "source", "against"]))
      ];
      if (["value", "expr", "against"].includes(c.dcType)) out.push(F.text(`${P}.ch.dcText`, t("workshop.au.dcValue"), c.dcText, { inpCls: "ws-num", ...(activation && { placeholder: t("workshop.au.cast.dcPh"), tip: t("workshop.au.cast.dcTip") }) }));
      out.push(F.chk(`${P}.ch.basic`, t("sheet.basic"), c.basic), F.text(`${P}.ch.traits`, t("sheet.traits"), c.traits), F.text(`${P}.ch.options`, t("sheet.options"), c.options), chWhen(`${P}.ch`, c), ...immFields(`${P}.ch.imm`, c.imm));
      return out;
    }
    if (mode === "check") {
      const k = m.ck, defs = sheetChoices("stat", ["fortitude", "reflex", "will", "perception"]), out = [
        F.text(`${P}.ck.statistic`, t("workshop.au.checkStat"), k.statistic, { list: "ws-skills", placeholder: "athletics, acrobatics" }), F.sel(`${P}.ck.vsType`, t("sheet.vsLabel"), k.vsType, sheetChoices("vs", ["defense", "dc", "against", "none"]))
      ];
      if (k.vsType === "none") { /* СЛ задаёт система: поля защиты нет */ }
      else if (k.vsType === "defense") out.push(F.sel(`${P}.ck.vsText`, t("workshop.au.vsWhat"), k.vsText, { ac: t("checks.ac"), ...defs }));
      else out.push(F.text(`${P}.ck.vsText`, t("workshop.au.vsWhat"), k.vsText, { inpCls: "ws-num" }));
      out.push(
        F.sel(`${P}.ck.map`, t("sheet.map"), k.map, [["", "—"], ["0", "0"], ["1", "1"], ["2", "2"]]), F.text(`${P}.ck.traits`, t("sheet.traits"), k.traits), F.text(`${P}.ck.options`, t("sheet.options"), k.options),
        chWhen(`${P}.ck`, k), ...(k.vsType === "none" ? [] : [F.chk(`${P}.ck.one`, t("sheet.oneRoll"), k.one), ...immFields(`${P}.ck.imm`, k.imm)])
      );
      return out;
    }
    return [];
  }

  return { sheetChoices, chWhen, immFields, rollFieldsOf };
}
