// Мастерская: окно ГМа (ApplicationV2). Режимы: «Эффект» (effect.mjs) и «Автоматизация» предмета (automation.mjs).
// Чистая часть — effect.mjs / automation.mjs; здесь только DOM, Foundry и запись в документы.
// Части окна у обоих режимов одни и те же (id), шаблоны подставляются по режиму в _configureRenderParts.
import { MOD, L, errText, DEGREES, callGM, forcedReplace, forcedDelete, flagPath, damageLabel } from "../util.mjs";
import { modeOf } from "../settings.mjs";
import { DENY, divergedHint, dropSpec, ruleToForm, formToRule, blankRow, blankEvent, blankTrigger, blankCast, reportEnv, pickedTokens, ruleUuids, buildReport } from "../sheet.mjs";
import { validateRule, resolveRule, divergedOf, slugOf, sourceOf, DAMAGE_TYPES, EVENT_ON, EVENT_SIDES, EVENT_TARGETED, EVENT_AFTER_USE, NEAR_ON, TRIGGER_ON, TRIGGER_PER, ESCAPE_STATS, REPEAT_ON } from "../rules.mjs";
import { automationsGroups } from "../compat.mjs";
import { safeUuid } from "../saves.mjs";
import * as fx from "./effect.mjs";
import * as au from "./automation.mjs";
import * as im from "./item.mjs";
import { BUILTIN } from "../builtin/index.mjs";
import { hintsView, hintList } from "../hints.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const TPL = (n) => `modules/${MOD}/templates/workshop-${n}.hbs`;
const ICONS = { bonus: "plus-minus", resist: "shield-halved", temphp: "heart", fastheal: "heart-pulse", dmg: "burst", speed: "person-running", sense: "eye", cond: "circle-exclamation", note: "note-sticky", aura: "circle-dot", light: "sun", raw: "code" };

const t = (key, data) => L(key, data);
const choices = (list, prefix) => Object.fromEntries(list.map((k) => [k, t(`workshop.${prefix}.${k}`)]));
const picks = (list, prefix, cur) => list.map((v) => ({ value: v, label: t(`workshop.${prefix}.${v}`), on: v === cur }));
const sheetChoices = (prefix, list) => Object.fromEntries(list.map((k) => [k, t(`sheet.${prefix}.${k}`)]));

/** Состояния pf2e: slug -> UUID компендиума берём в рантайме у ConditionManager (id в коде не зашиты). */
const conditions = () => game.pf2e.ConditionManager.conditions;
const condUuid = (slug) => conditions().get(slug)?.uuid ?? null;
const condValued = (slug) => !!conditions().get(slug)?.system?.value?.isValued;
// persistent-damage требует формулу и тип; состояния зрения у модуля идут своей политикой (apply.mjs SIGHT_CONDITIONS)
const NOT_GRANTABLE = new Set(["persistent-damage", "hidden", "undetected", "concealed", "observed", "unnoticed"]);
const condLabel = (slug) => { const k = CONFIG.PF2E.conditionTypes?.[slug]; return k ? game.i18n.localize(k) : slug; };
/** Состояния для быстрого выбора: [{slug,label}] по алфавиту (тот же отбор, что в режиме «Эффект»). */
const grantable = () => Object.keys(CONFIG.PF2E.conditionTypes ?? {}).filter((s) => conditions().has(s) && !NOT_GRANTABLE.has(s))
  .map((slug) => ({ slug, label: condLabel(slug) })).sort((a, z) => a.label.localeCompare(z.label));

const TRAIT_SETS = ["spellTraits", "actionTraits", "featTraits", "consumableTraits", "equipmentTraits", "weaponTraits", "npcAttackTraits"];
const traitLabel = (s) => { for (const k of TRAIT_SETS) { const v = CONFIG.PF2E[k]?.[s]; if (v) return game.i18n.localize(v); } return s; };

/** Мировые папки Item мастерской: ищем по флагу (имя переводится), затем по имени. Эффекты — флаг true, предметы — "item". */
const FOLDERS = { effect: { flag: true, key: "workshop.folder" }, item: { flag: "item", key: "workshop.item.folder" } };
const findFolder = (kind) => {
  const { flag, key } = FOLDERS[kind], name = t(key);
  return game.folders.find((f) => f.type === "Item" && f.getFlag(MOD, "workshop") === flag) ?? game.folders.find((f) => f.type === "Item" && f.name === name && !f.folder) ?? null;
};
const workshopFolder = async (kind) => findFolder(kind) ?? await Folder.create({ name: t(FOLDERS[kind].key), type: "Item", flags: { [MOD]: { workshop: FOLDERS[kind].flag } } });

/* ---------- поля режима «Автоматизация»: описатели для шаблона (одна разметка на все виды) ---------- */

const withCur = (opts, cur) => {
  const list = Array.isArray(opts) ? opts : Object.entries(opts);
  const out = list.map(([value, label]) => ({ value, label }));
  return cur === undefined || cur === null || out.some((o) => String(o.value) === String(cur)) ? out : [...out, { value: cur, label: String(cur) }];
};
const F = {
  seg: (path, label, cur, opts) => ({ path, label, seg: opts.map(([value, l]) => ({ value, label: l, on: String(cur) === value })) }),
  num: (path, label, value, extra = {}) => ({ path, label, type: "number", value, inpCls: "ws-num", ...extra }),
  text: (path, label, value, extra = {}) => ({ path, label, type: "text", value, ...extra }),
  sel: (path, label, value, opts, extra = {}) => ({ path, label, value, options: withCur(opts, value), ...extra }),
  chk: (path, label, value, extra = {}) => ({ path, label, check: true, value, ...extra })
};
const TRI = ["auto", "yes", "no"];
const triSeg = (path, label, cur) => F.seg(path, label, cur, TRI.map((k) => [k, t(`workshop.au.tri.${k}`)]));

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

/** Поля раскрытого шага (строка apply / степени). row — строка модели формы, p — её путь. */
function stepFields(row, p, names, card) {
  const out = [
    F.seg(`${p}.to`, t("workshop.au.stepTo"), row.to, ["target", "self", "party", "allies", "chosen"].map((k) => [k, t(`sheet.to.${k}`)])),
    ...(row.to === "allies" ? [F.num(`${p}.range`, t("sheet.row.range"), row.range, { min: 5, placeholder: "30" })] : []),
    F.sel(`${p}.kind`, t("workshop.au.stepKind"), row.kind, Object.assign(sheetChoices("row", row.kind === "affliction" ? ["affliction"] : ["condition", "effect", "note", "visibility", "persistent", "remove", "removeEffect", "extendEffect", "rollOption", "damage", "choose", "move"]), { choose: t("workshop.au.chooseKind") })   // недуг — только чтение: свой единственный вид, новых строк не создаём
  ];
  const rank = [F.num(`${p}.rankMin`, t("sheet.row.rankMin"), row.rankMin, { min: 1 }), F.num(`${p}.rankMax`, t("sheet.row.rankMax"), row.rankMax, { min: 1 })];
  if (row.kind === "remove") out.push(F.sel(`${p}.text`, t("workshop.au.condition"), row.text, { "": "—", ...Object.fromEntries(grantable().map((c) => [c.slug, c.label])) }));
  else if (row.kind === "condition") {
    out.push(
      F.sel(`${p}.text`, t("workshop.au.condition"), row.text, { "": "—", ...Object.fromEntries(grantable().map((c) => [c.slug, c.label])) }),
      F.num(`${p}.value`, t("sheet.row.value"), row.value, { min: 1 }),
      F.sel(`${p}.policy`, t("sheet.row.policy"), row.policy, sheetChoices("policy", ["max", "add", "reduce"])),
      F.text(`${p}.durValue`, t("sheet.duration"), row.durValue, { inpCls: "ws-num", placeholder: "1d4" }),
      F.sel(`${p}.durUnit`, t("workshop.au.unit"), row.durUnit, sheetChoices("unit", ["rounds", "minutes", "hours", "days"])),
      F.sel(`${p}.durExpiry`, t("workshop.expires"), row.durExpiry, { "": t("sheet.expiry.none"), "turn-start": t("sheet.expiry.start"), "turn-end": t("sheet.expiry.end") }),
      F.sel(`${p}.durOf`, t("workshop.au.durOf"), row.durOf, sheetChoices("of", ["origin", "target"]))
    );
  } else if (row.kind === "effect") {
    const own = au.isOwn(row);   // «свой»: effect.mods — список свойств; «готовый»: UUID эффекта из компендиума
    out.push(F.seg(`${p}.src`, t("workshop.au.mod.source"), own ? "own" : "ready", [["ready", t("workshop.au.mod.ready")], ["own", t("workshop.au.mod.own")]]));
    if (own) out.push(modsField(row, p));
    else out.push(F.text(`${p}.text`, t("workshop.au.effectUuid"), row.text, { drop: "effect", cls: "ws-grow", hint: names.get(row.text) ?? "" }),
      F.chk(`${p}.stack`, t("workshop.au.stack"), row.stack, { disabled: row.replace && !row.stack }), F.chk(`${p}.unstack`, t("workshop.au.unstack"), row.unstack, { disabled: row.replace && !row.unstack }),
      ...(row.stack ? [F.num(`${p}.stackBy`, t("workshop.au.stackBy"), row.stackBy, { min: 1, placeholder: "1" }), F.num(`${p}.stackStart`, t("workshop.au.stackStart"), row.stackStart, { min: 1, placeholder: "1" })] : []),
      F.chk(`${p}.replace`, t("sheet.row.replace"), row.replace, { tip: t("sheet.row.replaceTip"), disabled: (row.stack || row.unstack) && !row.replace }));
    // срок: у готового — переопределение (число или кубик 1d4); у своего — обязателен, плюс «чей ход»
    out.push(F.text(`${p}.durValue`, t(own ? "workshop.au.mod.dur" : "workshop.au.effDur"), row.durValue, { inpCls: "ws-num", placeholder: "1d4", req: own, tip: t(own ? "workshop.au.mod.durHint" : "workshop.au.effDurHint") }),
      F.sel(`${p}.durUnit`, t("workshop.au.unit"), row.durUnit, sheetChoices("unit", ["rounds", "minutes", "hours", "days"])),
      F.sel(`${p}.durExpiry`, t("workshop.expires"), row.durExpiry, { "": t("sheet.expiry.none"), "turn-start": t("sheet.expiry.start"), "turn-end": t("sheet.expiry.end") }),
      ...(own ? [F.sel(`${p}.durOf`, t("workshop.au.durOf"), row.durOf, sheetChoices("of", ["origin", "target"]))] : []));
  }
  else if (row.kind === "damage") out.push(
    F.text(`${p}.text`, t("workshop.au.persFormula"), row.text, { placeholder: "2d6" }),
    F.sel(`${p}.pType`, t("workshop.au.persType"), row.pType, [["healing", t("workshop.au.healing")], ...DAMAGE_TYPES.map((v) => [v, damageLabel(v)])]),
    F.chk(`${p}.dmgBasic`, t("workshop.au.dmgBasic"), row.dmgBasic)
  );
  else if (row.kind === "move") out.push(F.num(`${p}.text`, t("workshop.au.moveDist"), row.text, { min: 5, placeholder: "10" }), F.sel(`${p}.moveMode`, t("workshop.au.moveMode"), row.moveMode, sheetChoices("moveMode", ["push", "pull"])), F.sel(`${p}.moveFrom`, t("workshop.au.moveFrom"), row.moveFrom ?? "origin", sheetChoices("moveFrom", ["origin", "point"])));
  else if (row.kind === "choose") out.push(...chooseFields(row, p));
  else if (row.kind === "removeEffect") out.push(F.text(`${p}.text`, t("workshop.au.effectRef"), row.text, { drop: "effect", cls: "ws-grow", hint: names.get(row.text) ?? "" }), F.chk(`${p}.ofOrigin`, t("workshop.au.ofOrigin"), row.ofOrigin));
  else if (row.kind === "extendEffect") out.push(F.text(`${p}.text`, t("workshop.au.effectSlug"), row.text, { cls: "ws-grow" }), F.num(`${p}.value`, t("workshop.au.extendRounds"), row.value, { min: 1 }));
  else if (row.kind === "rollOption") out.push(F.text(`${p}.domain`, t("sheet.row.domain"), row.domain, { placeholder: "all" }), F.text(`${p}.text`, t("workshop.au.optionName"), row.text, { cls: "ws-grow" }), F.chk(`${p}.optOff`, t("workshop.au.optOff"), row.optOff));
  else if (row.kind === "note") out.push(F.text(`${p}.text`, t("workshop.au.noteText"), row.text, { cls: "ws-grow" }));
  else if (row.kind === "persistent") out.push(
    F.text(`${p}.text`, t("workshop.au.persFormula"), row.text, { placeholder: "1d6" }),
    F.sel(`${p}.pType`, t("workshop.au.persType"), row.pType, DAMAGE_TYPES.map((v) => [v, damageLabel(v)])),
    F.num(`${p}.value`, t("workshop.au.persDc"), row.value, { min: 1, placeholder: "15" })
  );
  else out.push(
    F.sel(`${p}.visLevel`, t("workshop.au.visLevel"), row.visLevel, sheetChoices("vis.level", ["concealed", "hidden", "undetected", "unnoticed"])),
    F.sel(`${p}.visOf`, t("workshop.au.visOf"), row.visOf, sheetChoices("vis.of", ["self", "target"])),
    F.text(`${p}.visUntil`, t("workshop.au.visUntil"), row.visUntil, { placeholder: t("sheet.row.until") })
  );
  if (row.kind !== "note" && row.kind !== "visibility") out.push(...rank);   // круг сотворения: шаг только в этом диапазоне
  if (row.kind !== "note") out.push(F.text(`${p}.when`, t("workshop.au.stepWhen"), row.when, { cls: "ws-full", placeholder: "feat:x, target:trait:undead", hint: t("workshop.au.stepWhenHint") }));   // условие шага (предикат pf2e)
  if (row.kind !== "choose" && row.kind !== "affliction") out.push(refineField(row, p, names, card));
  return out;
}

/** Свойства своего эффекта (effect.mods): строки по видам, кнопки добавления. */
function modsField(row, p) {
  const bare = { bare: true };
  const list = au.modsView(row).map((m) => {
    const q = `${p}.mods.${m.i}`, val = F.text(`${q}.value`, t("workshop.value"), m.value, { ...bare, inpCls: "ws-num" });
    const type = F.sel(`${q}.type`, t("workshop.type"), m.type, choices(fx.BONUS_TYPES, "btype"), bare), dmg = F.sel(`${q}.dmg`, t("workshop.damage"), m.dmg, choices(fx.RESIST_TYPES, "dtype"), bare);
    const fields = { bonus: [val, type, { note: t("workshop.au.mod.to") }, F.sel(`${q}.target`, t("workshop.target"), m.target, choices(fx.STEP_TARGETS, "targets"), { ...bare, cls: "ws-grow" })],
      speed: [val, { note: t("workshop.au.mod.ft") }, type], resist: [dmg, val, F.text(`${q}.except`, t("workshop.except"), m.except, { ...bare, placeholder: t("workshop.exceptHint") })], weak: [dmg, val], forbid: [{ note: t("workshop.text.forbid") }] }[m.kind] ?? [];
    return { i: m.i, kind: t(m.kind === "weak" ? "workshop.au.mod.weak" : m.kind === "forbid" ? "workshop.au.mod.forbid" : `workshop.kind.${m.kind}`), fields, rm: { path: p, op: `modRm:${m.i}` } };
  });
  const adds = au.MOD_ADD.map((kind) => ({ path: p, op: `modAdd:${kind}`, label: t(kind === "weak" ? "workshop.au.mod.weak" : kind === "forbid" ? "workshop.au.mod.forbid" : `workshop.kind.${kind}`), off: !au.modCanAdd(row, kind) }));
  return { mods: { list, adds, hint: t("workshop.au.mod.max", { n: au.MODS_MAX }), note: t("workshop.au.mod.slugNote"), empty: !list.length && t("workshop.au.mod.none") }, label: "" };
}

/** Шаг «Игрок выбирает»: источник, вопрос; для существ — дальность и «от кого», для вариантов — строки {value, label?, when?}. */
function chooseFields(row, p) {
  const c = au.chooseView(row), q = `${p}.choose`;
  const out = [F.seg(`${q}.from`, t("workshop.au.chs.from"), c.from, au.CHOOSE_FROM.map((k) => [k, t(`workshop.au.chs.${k}`)])), F.text(`${q}.prompt`, t("workshop.au.chs.prompt"), c.prompt, { cls: "ws-grow" })];
  if (c.from === "options") out.push({ opts: {
    list: c.options.map((o) => ({ i: o.i, fields: [F.text(`${q}.opt.${o.i}.value`, t("workshop.au.chs.value"), o.value, { bare: true, placeholder: "fire" }), F.text(`${q}.opt.${o.i}.label`, t("workshop.au.chs.label"), o.label, { bare: true, placeholder: t("workshop.au.chs.label") }),
      F.text(`${q}.opt.${o.i}.when`, t("workshop.au.chs.when"), o.when, { bare: true, placeholder: t("workshop.au.chs.whenHint") })], rm: { path: p, op: `opt:opt.${o.i}.remove` } })),
    add: { path: p, op: "opt:opt.add" }, hint: t("workshop.au.chs.hint") }, label: t("workshop.au.chs.optionsLabel") });
  else out.push(F.num(`${q}.range`, t("workshop.au.chs.range"), c.range, { min: 5, placeholder: "—" }), F.seg(`${q}.of`, t("workshop.au.chs.of"), c.of, [["", t("workshop.au.chs.ofOrigin")], ["target", t("workshop.au.chs.ofTarget")]]));
  return out;
}

/** «Дополнительно»: плашки-переключатели и карточка открытой плашки. card — "<путь шага>|<плашка>" или null. */
function refineField(row, p, names, card) {
  const open = card?.startsWith(`${p}|`) ? card.slice(p.length + 1) : null, v = au.keepView(row), inCh = au.inChallenge(p);
  const list = au.refineState(row).map((s) => ({ ...s, path: p, label: t(`workshop.au.ref.pill.${s.key}`), tip: s.why ? t(`workshop.au.ref.why.${s.why}`) : "", open: open === s.key }));
  const K = `${p}.keep`, deg = (path, on, d) => F.chk(path, t(`sheet.degree.${d}`), on);
  const cards = {
    escape: { fields: [{ group: { label: t("workshop.au.ref.escStats"), fields: ESCAPE_STATS.map((s) => F.chk(`${K}.escape.stats.${s}`, s === "unarmed" ? t("workshop.au.ref.unarmed") : t(`workshop.targets.${s}`), v.escape.stats[s])) }, label: "" },
      F.num(`${K}.escape.dc`, t("workshop.au.ref.escDc"), v.escape.dc, { min: 1, placeholder: t("workshop.au.ref.escDcAuto") }), F.text(`${K}.escape.dcStat`, t("workshop.au.ref.escDcStat"), v.escape.dcStat, { list: "ws-skills", placeholder: "spell" })], hint: t("workshop.au.ref.escHint") },
    repeat: { fields: [F.seg(`${K}.repeat.on`, t("workshop.au.ref.repWhen"), v.repeat.on, REPEAT_ON.map((k) => [k, t(`workshop.au.ref.repOn.${k}`)])),
      { group: { label: t("workshop.au.ref.repEnd"), fields: DEGREES.slice().reverse().map((d) => deg(`${K}.repeat.end.${d}`, v.repeat.end[d], d)) }, label: "" },
      ...(inCh ? [] : [F.text(`${K}.repeat.statistic`, t("workshop.au.ref.repStat"), v.repeat.statistic, { list: "ws-skills", placeholder: "will" }), F.num(`${K}.repeat.dc`, t("workshop.au.ref.repDc"), v.repeat.dc, { min: 1 }),
        F.text(`${K}.repeat.traits`, t("sheet.traits"), v.repeat.traits), F.text(`${K}.repeat.options`, t("sheet.options"), v.repeat.options)])], hint: t(inCh ? "workshop.au.ref.repHintIn" : "workshop.au.ref.repHintOut") },
    unless: { fields: [F.text(`${K}.unless`, t("workshop.au.effectUuid"), v.unless, { drop: "effect", cls: "ws-grow", hint: names.get(v.unless) ?? "" })], hint: t("workshop.au.ref.unlessHint") },
    choice: { fields: [F.text(`${K}.choice`, t("workshop.au.ref.choiceValue"), v.choice, { cls: "ws-grow" })], hint: t("workshop.au.ref.choiceHint") }
  };
  return { refine: { path: p, list, card: open && cards[open] ? { key: open, path: p, title: t(`workshop.au.ref.card.${open}`), off: t("workshop.au.ref.off"), ...cards[open] } : null }, label: t("workshop.au.ref.label") };
}

export class Workshop extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;
  #id = 0;
  #sel = null;       // id раскрытого кубика (режим «Эффект»)
  #busy = false;
  #mode = "effect";
  #item = null;
  #au = null;        // состояние режима «Автоматизация»: { f, base, area, baseArea, open, sel, picker }
  #names = new Map();   // uuid -> имя документа | null (разрешённые заранее: fromUuidSync на вложенных UUID бросает)
  #typing = false;   // идёт ввод: имена документов не запрашиваем на каждую букву, догоняем по паузе
  #settle = foundry.utils.debounce(async () => { this.#typing = false; await this.render({ parts: ["aside", "footer"] }); this.#paint(); }, 500);
  #live = null;      // сводки/плашки последней подготовки — для правки текста на месте без перерисовки полей
  #wiz = { m: im.blankItem(), step: 0, q: "", found: [], seq: 0, picked: null, picker: false, done: null };   // режим «Предмет»
  #back = null;      // "item": эффект создаём для мастера предмета — после «Создать» вернёмся туда
  #find = foundry.utils.debounce(() => this.#search(), 300);
  model = fx.blankModel();

  static DEFAULT_OPTIONS = {
    id: "pf2e-automato-workshop",
    classes: ["pf2e-automato-workshop"],
    position: { width: 1040, height: 720 },
    window: { title: "PF2E_AUTOMATO.workshop.title", icon: "fa-solid fa-hammer", resizable: true },
    actions: {
      addBlock(_e, el) { this.#add(el.dataset.kind); },
      removeBlock(_e, el) { const o = this.#owner(); o.blocks = o.blocks.filter((b) => b.id !== Number(el.dataset.block)); this.#redraw(); },
      toggleBlock(_e, el) { const id = Number(el.dataset.block); this.#sel = this.#sel === id ? null : id; this.#redraw(); },
      pick(_e, el) { this.#set(el, el.dataset.v); this.#redraw(); },
      pickImg() {
        new foundry.applications.apps.FilePicker.implementation({ type: "image", current: this.model.img, callback: (path) => { this.model.img = path; this.render(); } }).render({ force: true });
      },
      create() { return this.#create(false); },
      createOpen() { return this.#create(true); },
      setMode(_e, el) { this.#mode = el.dataset.mode; this.#back = null; this.#wiz.picker = false; this.render({ window: { title: this.title } }); },
      goStep(_e, el) { this.#wiz.step = Number(el.dataset.n); this.#wiz.picker = false; this.#redraw(); },
      pickBase(_e, el) { return this.#guard(() => this.#pickBase(el.dataset.uuid)); },
      dropBase() { const w = this.#wiz; w.m = this.#fresh(w.m.type, w.m); w.picked = null; this.#redraw(); },
      pickItemImg() {
        new foundry.applications.apps.FilePicker.implementation({ type: "image", current: this.#wiz.m.img, callback: (path) => { this.#wiz.m.img = path; this.render(); } }).render({ force: true });
      },
      toggleTraits() { this.#wiz.picker = !this.#wiz.picker; this.#redraw(); },
      addTrait(_e, el) { const w = this.#wiz; if (!w.m.traits.includes(el.dataset.slug)) w.m.traits.push(el.dataset.slug); w.picker = false; this.#redraw(); },
      removeTrait(_e, el) { const m = this.#wiz.m; m.traits = m.traits.filter((x) => x !== el.dataset.slug); this.#redraw(); },
      newEffect() { this.#back = "item"; this.#mode = "effect"; if (!this.model.name.trim()) this.model.name = this.#wiz.m.name; this.render({ window: { title: this.title } }); },
      createItem() { return this.#guard(() => this.#createItem()); },
      openPipe() { return this.#guard(() => this.#openPipe()); },
      async openDone() { (await safeUuid(this.#wiz.done?.uuid))?.sheet.render(true); },
      newItem() { this.#wiz = { m: im.blankItem(), step: 0, q: "", found: [], seq: 0, picked: null, picker: false, done: null }; this.render(); },
      toggleRow(_e, el) { const o = this.#au.open; o[el.dataset.row] = !o[el.dataset.row]; this.#redraw(); },
      toggleStep(_e, el) { const a = this.#au; a.sel = a.sel === el.dataset.path ? null : el.dataset.path; a.card = null; this.#redraw(); },
      // правка раскрытого шага кнопками: свойства своего эффекта, варианты выбора, плашки «Дополнительно» (op — "вид:аргумент")
      rowOp(_e, el) {
        const a = this.#au, row = foundry.utils.getProperty(a, el.dataset.path), [op, arg] = el.dataset.op.split(":");
        if (op === "modAdd") au.modAdd(row, arg);
        else if (op === "modRm") au.modRemove(row, Number(arg));
        else if (op === "opt") au.chooseSet(row, arg);
        else if (op === "pill") { const id = `${el.dataset.path}|${arg}`; a.card = au.refineClick(row, arg, a.card === id) ? id : null; }
        else if (op === "pillOff") { au.refineSet(row, arg, false); a.card = null; }
        this.#redraw();
      },
      togglePicker(_e, el) { const a = this.#au; a.picker = a.picker === el.dataset.list ? null : el.dataset.list; this.#redraw(); },
      addStep(_e, el) { this.#addStep(el.dataset.list, { kind: el.dataset.kind ?? "condition", text: el.dataset.slug ?? "" }); },
      removeStep(_e, el) {
        const [list, i] = this.#split(el.dataset.path);
        foundry.utils.getProperty(this.#au, list).splice(i, 1);
        this.#au.sel = null;
        this.#au.card = null;
        this.#redraw();
      },
      stepVal(_e, el) {
        const row = foundry.utils.getProperty(this.#au, el.dataset.path);
        row.value = String(Math.max(1, (Number(row.value) || 0) + Number(el.dataset.d)));
        this.#redraw();
      },
      addMacro() { this.#au.f.macros.push({ uuid: "", phase: "onUse", degree: "" }); this.#au.open.macros = true; this.#redraw(); },
      addEvent() { this.#au.f.ev.push(blankEvent()); this.#au.open.events = true; this.#au.sel = null; this.#redraw(); },
      addCast() { this.#au.f.cast.push(blankCast()); this.#au.open.cast = true; this.#redraw(); },
      removeCast(_e, el) { this.#au.f.cast.splice(Number(el.dataset.i), 1); this.#redraw(); },
      removeEvent(_e, el) { this.#au.f.ev.splice(Number(el.dataset.i), 1); this.#au.sel = null; this.#redraw(); },
      addTrigger() { this.#au.f.zone.trig.push(blankTrigger()); this.#au.sel = null; this.#redraw(); },
      removeTrigger(_e, el) { this.#au.f.zone.trig.splice(Number(el.dataset.i), 1); this.#au.sel = null; this.#redraw(); },
      insertTemplate() { return this.#guard(() => this.#insertTemplate()); },
      openSheet() { this.#item?.sheet.render(true); },
      saveItem() { return this.#guard(() => this.#saveItem()); },
      resetDraft() { this.#loadAu(); this.render(); },
      unsetRule() { return this.#guard(async () => { await this.#item.update(forcedDelete(flagPath("rule"))); this.#loadAu(); this.render(); }); },
      accept() { return this.#guard(async () => { await this.#item.update(forcedReplace(flagPath("rule"), resolveRule(this.#item).rule)); this.#loadAu(); this.render(); }); },
      worldSave(_e, el) { return this.#guard(() => this.#world(el.dataset.scope, true)); },
      worldDel(_e, el) { return this.#guard(() => this.#world(el.dataset.scope, false)); }
    }
  };

  static PARTS = {
    header: { template: TPL("header") },
    tabs: { template: TPL("tabs") },
    main: { template: TPL("effect"), templates: [TPL("blocks")], scrollable: [""] },
    aside: { template: TPL("aside"), scrollable: ["", "pre"] },
    footer: { template: TPL("footer") }
  };

  _configureRenderParts(options) {
    const parts = super._configureRenderParts(options);
    const mode = { automation: "auto", item: "item" }[this.#mode];
    if (mode) {
      parts.header.template = TPL(`${mode}-head`);
      parts.main.template = TPL(mode);
      parts.aside.template = TPL(`${mode}-aside`);
      parts.footer.template = TPL(`${mode}-footer`);
    }
    return parts;
  }

  /** Открыть (единственное окно). Только ГМ. item — Item или его UUID: включает режим «Автоматизация». */
  static async open({ item = null, mode } = {}) {
    if (!game.user.isGM) return ui.notifications.warn(t("workshop.gmOnly"));
    if (typeof item === "string") item = await safeUuid(item);
    if (item && DENY.has(item.type)) { ui.notifications.warn(t("workshop.au.denied")); item = null; }
    const app = (Workshop.#instance ??= new Workshop());
    if (!(item && !(await app.#setItem(item)))) app.#mode = ((m) => (m === "automation" && app.#item ? "automation" : m === "item" ? "item" : "effect"))(mode ?? (item ? "automation" : app.#mode));
    return app.render({ force: true, window: { title: app.title } });
  }

  /** Подгрузить предмет; при несохранённой правке другого предмета спрашиваем. false — пользователь отказался. */
  async #setItem(item) {
    const same = this.#item?.uuid === item.uuid;
    if (this.#item && !same && this.#dirty()) {
      const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: t("workshop.au.switchTitle") }, content: `<p>${foundry.utils.escapeHTML(t("workshop.au.switch", { name: this.#item.name }))}</p>`, rejectClose: false });
      if (!ok) return false;
    }
    this.#item = item;
    if (!same || !this.#au) this.#loadAu();
    return true;
  }

  /** Закрытие с несохранённой правкой — через подтверждение. */
  async close(options = {}) {
    if (!options.force && this.#mode === "automation" && this.#dirty()) {
      const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: t("workshop.au.switchTitle") }, content: `<p>${foundry.utils.escapeHTML(t("workshop.au.closeAsk", { name: this.#item.name }))}</p>`, rejectClose: false });
      if (!ok) return this;
    }
    const w = this.#wiz;
    if (!options.force && !w.done && JSON.stringify(w.m) !== JSON.stringify(im.blankItem(w.m.type))) {
      const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: t("workshop.au.switchTitle") }, content: `<p>${foundry.utils.escapeHTML(t("workshop.item.closeAsk"))}</p>`, rejectClose: false });
      if (!ok) return this;
    }
    return super.close(options);
  }

  _onClose(options) { Workshop.#instance = null; return super._onClose(options); }

  get title() { return this.#mode === "automation" && this.#item ? `${super.title} — ${this.#item.name}` : super.title; }

  /* ---------- «Автоматизация»: состояние ---------- */

  #loadAu(keepView = false) {
    const item = this.#item, res = resolveRule(item), f = ruleToForm(res?.rule ?? null), prev = keepView ? this.#au : null;
    if (!res) f.kind = "onUse";
    const area = au.initialArea({ isSpell: item.type === "spell", area: item._source.system.area, description: item._source.system.description?.value });
    const hints = res?.source === "markup" && game.user.isGM ? hintsView(res.hints, { condLabel, degLabel: (d) => t(`sheet.degree.${d}`).toLowerCase() }) : null;
    this.#au = { hints, f, base: JSON.stringify(f), area, baseArea: { ...area }, open: prev?.open ?? { when: false, targets: false, roll: true, outcome: true, zone: false, macros: false, events: true, cast: true }, sel: prev?.sel ?? null, picker: null, card: null, probeDc: prev?.probeDc ?? "" };
  }

  #dirty() {
    const a = this.#au;
    return !!a && (JSON.stringify(a.f) !== a.base || (a.f.targets === "area" && (a.area.shape !== a.baseArea.shape || au.clampSize(a.area.size) !== au.clampSize(a.baseArea.size))));
  }

  #split(path) { const i = path.lastIndexOf("."); return [path.slice(0, i), Number(path.slice(i + 1))]; }

  /** Записать значение поля: путь — от состояния окна (`f.ch.statistic`, `area.size`), особые пути — со связанными правками. */
  #setAuto(path, v) {
    const a = this.#au, f = a.f;
    if (path === "roll") {
      au.setRollMode(f, v);
      if (v === "save" && f.ch.dcType === "value" && !String(f.ch.dcText ?? "").trim() && this.#item.type === "spell") f.ch.dcType = "source";   // как разбор разметки: СЛ заклинателя
      if (v === "check" && f.targets === "self") f.targets = "selected";   // проверка автора против защиты цели: цель — не он сам
      a.sel = null;
      return;
    }
    // поля, которых нет в строке формы как есть: «Дополнительно» (row.keep), свойства эффекта и варианты выбора (JSON в row.text), источник эффекта, вид макроса
    const sub = [[/^(.*)\.keep\.(.+)$/, au.keepEdit], [/^(.*)\.mods\.(\d+\.\w+)$/, (r, n, x) => { const [i, field] = n.split("."); au.modSet(r, Number(i), field, x); }], [/^(.*)\.choose\.(.+)$/, au.chooseSet], [/^(.*)\.src$/, (r, _n, x) => au.setEffectSource(r, x)]];
    for (const [re, fn] of sub) { const hit = re.exec(path); if (hit) return fn(foundry.utils.getProperty(a, hit[1]), hit[2], v); }
    const mac = /^f\.macros\.(\d+)\.form$/.exec(path);
    if (mac) return au.macroSetForm(f.macros[Number(mac[1])], v);
    const m = /^(.*)\.(kind|text)$/.exec(path);
    const row = m && m[1] !== "f" && m[1] !== "f.zone" ? foundry.utils.getProperty(a, m[1]) : null;
    if (row && "durOf" in row) {   // строка шага: смена вида и текста — в ядре
      if (m[2] === "kind") au.setStepKind(row, v);
      else au.setStepText(row, v, row.kind === "condition" && condValued(v));
    } else foundry.utils.setProperty(a, path, v);
    if (path === "f.targets" && v === "self") a.sel = null;
    // событие без цели (ход, эффект, урон по носителю): сторона «цель броска» невозможна — вернуть «владелец»
    const ev = /^(f\.ev\.\d+)\.on$/.exec(path);
    if (ev) { const e = foundry.utils.getProperty(a, ev[1]); if (e.side === "target" && !EVENT_TARGETED.has(v)) e.side = "self"; if (!EVENT_AFTER_USE.has(v)) e.afterUse = false; if (v === "enter") e.side = "near"; else if (e.side === "near" && !NEAR_ON.includes(v)) e.side = "self"; }
    const sd = /^(f\.ev\.\d+)\.side$/.exec(path);   // скрытый флажок «после использования» не должен давать ошибку валидации
    if (sd) { const e = foundry.utils.getProperty(a, sd[1]); if (v !== "self") e.afterUse = false; }
    // проверка без цели бросается на себя; вернули цель — «на выбранных»
    if (path === "f.ck.vsType") { if (v === "none") { f.targets = "self"; f.ck.imm.on = false; } else if (f.targets === "self") f.targets = "selected"; }
  }

  #addStep(list, { kind, text }) {
    // шаг записи события — по умолчанию владельцу; шаги по степеням её испытания — тому, кто бросает
    const a = this.#au, rows = foundry.utils.getProperty(a, list), row = { ...blankRow(), kind, text, to: /^f\.ev\.\d+\.apply$/.test(list) || a.f.targets === "self" ? "self" : "target" };
    if (kind === "condition" && condValued(text)) row.value = "1";
    if (kind === "persistent" || kind === "damage") row.text = "1d6";
    if (kind === "move") Object.assign(row, { text: "10", to: "target" });
    if (kind === "choose") Object.assign(row, { text: "{\"from\":\"allies\"}", to: "self" });
    rows.push(row);
    a.sel = `${list}.${rows.length - 1}`;
    a.picker = null;
    this.#redraw();
  }

  #areaSrc() { const i = this.#item; return { isSpell: i.type === "spell", srcArea: i._source.system.area, description: i._source.system.description?.value }; }

  async #insertTemplate() {
    const { area } = this.#au, item = this.#item;
    await item.update({ "system.description.value": au.withTemplate(item._source.system.description?.value, area.shape, area.size) });
    this.render();
  }

  /** Обёртка действий с записью: ошибки — уведомлением, повторный клик не запускает второй. */
  async #guard(fn) {
    if (this.#busy) return;
    this.#busy = true;
    try { await fn(); }
    catch (e) { console.error(`${MOD} | workshop`, e); ui.notifications.error(String(e?.message ?? e)); }
    finally { this.#busy = false; }
  }

  async #saveItem() {
    const a = this.#au, item = this.#item, v = validateRule(formToRule(a.f));
    if (!v.ok) return;
    const patch = au.areaPatch(this.#areaSrc(), a.area, a.baseArea, a.f.targets);
    await item.update({ ...forcedReplace(flagPath("rule"), v.rule), ...patch });
    ui.notifications.info(t("sheet.saved"));
    this.#loadAu();
    this.render({ window: { title: this.title } });
  }

  async #world(scope, save) {
    const item = this.#item, key = scope === "source" ? { source: sourceOf(null, item) } : { slug: slugOf(null, item) };
    let rule = null;
    if (save) { const v = validateRule(formToRule(this.#au.f)); if (!v.ok) return; rule = v.rule; }
    const res = await callGM("saveCatalogRule", key, rule);
    ui.notifications[res?.ok ? "info" : "error"](res?.ok ? t("sheet.saved") : `${t("sheet.failed")}: ${res?.error ?? res?.reason ?? "?"}`);
    if (res?.ok && resolveRule(item)?.source !== "flag") this.#loadAu(true);   // действующее правило теперь из каталога — черновик больше не «несохранённый»
    this.render();
  }

  /* ---------- общее ---------- */

  #ctx() { return { t, uuidOf: condUuid, condLabel, resistKnown: (k) => k in CONFIG.PF2E.resistanceTypes, ruleKnown: (k) => k in game.pf2e.RuleElements.all }; }
  #owner() { return this.#mode === "item" ? this.#wiz.m : this.model; }   // чьи кубики правим: эффекта или предмета
  #block(id) { return this.#owner().blocks.find((b) => b.id === Number(id)); }
  #add(kind, patch = {}) {
    const b = { id: ++this.#id, ...fx.blankBlock(kind), ...patch };
    this.#owner().blocks.push(b);
    this.#sel = b.id;
    this.#redraw();
    return b;
  }
  #redraw() { this.#typing = false; return this.render({ parts: this.#mode === "item" ? ["header", "main", "aside", "footer"] : ["main", "aside", "footer"] }); }
  #set(el, v) {
    if (el.dataset.i !== undefined) return this.#setIt(el.dataset.i, v);
    if (el.dataset.a !== undefined) return this.#setAuto(el.dataset.a, v);
    const f = el.dataset.f;
    if (el.dataset.block) this.#block(el.dataset.block)[f] = v;
    else foundry.utils.setProperty(this.model, f, v);
  }

  #text(b, ctx = this.#ctx()) { return this.#mode === "item" ? im.blockText(this.#wiz.m.type, b, ctx) : fx.textOf(b, ctx); }

  #view(b, ctx) {
    const c = {
      target: choices(fx.TARGETS, "targets"), noteTarget: choices(fx.TARGETS.filter((x) => x !== "ac"), "targets"),
      resist: choices(fx.RESIST_TYPES, "dtype"), dmgType: choices(fx.DAMAGE_TYPES, "dtype"), die: Object.fromEntries(fx.DICE.map((d) => [d, d])),
      sense: choices(fx.SENSES, "senses"), acuity: choices(fx.ACUITY, "acuities"),
      cond: { "": b.uuid ? b.name : t("workshop.condNone"), ...Object.fromEntries(grantable().map((c) => [c.slug, c.label])) }
    };
    return {
      ...b, c, open: this.#sel === b.id, kindLabel: t(`workshop.kind.${b.kind}`), summary: this.#text(b, ctx),
      isSigned: b.kind === "bonus" || b.kind === "speed", isBonus: b.kind === "bonus", isSpeed: b.kind === "speed",
      plus: Number(b.sign) > 0, types: picks(fx.BONUS_TYPES, "btype", b.type),
      showAcuity: b.kind === "sense" && !fx.PRECISE.has(b.sense), showRange: b.kind === "sense" && !fx.NO_RANGE.has(b.sense),
      [`is_${b.kind}`]: true
    };
  }

  async _prepareContext() {
    const modes = [{ key: "effect", label: t("workshop.mode.effect"), on: this.#mode === "effect" }];
    if (this.#item) modes.unshift({ key: "automation", label: t("workshop.mode.automation"), on: this.#mode === "automation" });
    modes.push({ key: "item", label: t("workshop.mode.item"), on: this.#mode === "item" });
    const common = { modes, multi: modes.length > 1 };
    if (this.#mode === "automation") return { ...common, ...await this.#autoCtx() };
    if (this.#mode === "item") return { ...common, ...this.#itemCtx() };
    const m = this.model, ctx = this.#ctx(), errors = fx.validate(m, ctx);
    const rules = m.blocks.flatMap((b) => fx.rulesOf(b, ctx)), dur = fx.durationText(m.dur, t);
    return {
      ...common,
      name: m.name, level: m.level, img: m.img, subtitle: t("workshop.subtitle", { folder: t("workshop.folder") }),
      dur: m.dur, units: picks(fx.UNITS, "unit", m.dur.unit), expiry: choices(fx.EXPIRY, "expiry"), unlimited: m.dur.unit === "unlimited",
      blocks: m.blocks.map((b) => this.#view(b, ctx)),
      palette: fx.KINDS.map((kind) => ({ kind, icon: ICONS[kind], label: t(`workshop.kind.${kind}`) })),
      preview: { durShort: dur.short, durLong: dur.long, count: rules.length, json: JSON.stringify(rules, null, 2) },
      desc: fx.descriptionText(m.blocks, ctx), hint: t(this.#back ? "workshop.item.returnHint" : "workshop.footHint"),
      errors, error: errors[0] ? errors[0] + (errors.length > 1 ? ` ${t("workshop.err.more", { n: errors.length - 1 })}` : "") : ""
    };
  }

  /** Контекст режима «Автоматизация»: плашки, поля строк, сводки, правая панель, подвал. */
  async #autoCtx() {
    const a = this.#au, item = this.#item, f = a.f, mode = au.rollMode(f);
    const raw = formToRule(f), v = validateRule(raw), rule = v.ok ? v.rule : raw;
    const need = this.#typing ? [] : ruleUuids(raw).filter((u) => !this.#names.has(u));
    await Promise.all(need.map(async (u) => this.#names.set(u, (await safeUuid(u))?.name ?? null)));
    const base = await reportEnv(item, rule, Object.fromEntries(this.#names));
    const area = { shape: a.area.shape, size: au.clampSize(a.area.size) };
    const env = { ...base, uuidName: (u) => this.#names.get(u) ?? null, valued: condValued, area };
    const sums = au.summaries(f, env), story = au.story(f, env);
    const probeDc = String(a.probeDc ?? "").trim(), needDc = mode === "save" && env.dc == null;
    const penv = needDc && probeDc !== "" && Number.isFinite(Number(probeDc)) ? { ...env, dc: Number(probeDc) } : env;   // СЛ только для пробы, в правило не пишется
    const res = resolveRule(item), slug = res?.slug ?? slugOf(null, item), sourceUuid = res?.sourceUuid ?? sourceOf(null, item);
    const groups = automationsGroups({ slug, sourceUuid });
    const setting = game.settings.get(MOD, "yieldToAutomations");
    const sheetStat = ["reflex", "fortitude", "will", "perception", "flat"];

    // шаги списка -> плашки; a.sel указывает раскрытый шаг
    const plates = {};
    const stepsOf = (path) => (foundry.utils.getProperty(a, path) ?? []).map((row, i) => {
      const p = `${path}.${i}`, pl = au.plate(row, env);
      const text = pl.dur ? `${pl.name} · ${pl.dur.replace(/ /g, " ")}` : pl.name;
      plates[p] = { text, value: pl.value };
      return { path: p, ...pl, text, open: a.sel === p, stepper: pl.kind === "condition" && pl.valued };
    });
    const okGhost = new Set(grantable().map((c) => c.slug));
    const lst = (path, label, deg = "") => {
      const steps = stepsOf(path), have = new Set((foundry.utils.getProperty(a, path) ?? []).filter((r) => r.kind === "condition").map((r) => r.text));
      const ghosts = deg && a.hints ? a.hints.possible.filter((h) => h.deg === deg && okGhost.has(h.slug) && !have.has(h.slug)).map((h) => ({ slug: h.slug, timed: h.timed, text: t("workshop.au.hintPossible", { name: h.label }), tip: t(h.timed ? "workshop.au.hintTimedTip" : "workshop.au.hintPossibleTip", { name: h.label }) })) : [];
      return { list: path, label, deg, steps, ghosts, picker: a.picker === path };
    };
    let edit = null;
    if (a.sel) {
      const row = foundry.utils.getProperty(a, a.sel);
      if (row) edit = { path: a.sel, title: au.plateText(au.plate(row, env)), fields: stepFields(row, a.sel, this.#names, a.card) };
      else a.sel = null;
    }

    const whenFields = [
      F.text("f.label", t("sheet.label"), f.label, { cls: "ws-grow" }),
      F.seg("f.kind", t("workshop.au.event"), f.kind, ["onUse", "onAttacked", "onEvent", "cast", "none"].map((k) => [k, t(`workshop.au.kind.${k}`)])),
      F.seg("f.yield", t("sheet.yieldLabel"), f.yield, [["auto", t("sheet.yield.auto")], ["yes", t("sheet.yes")], ["no", t("sheet.yield.no")]])
    ];
    if (f.kind === "onAttacked") whenFields.push(
      F.sel("f.react.type", t("workshop.au.reactType"), f.react.type, choices(fx.BONUS_TYPES, "btype")), F.num("f.react.value", t("workshop.au.reactValue"), f.react.value),
      F.chk("f.react.owner", t("sheet.notifyOwner"), f.react.owner), F.chk("f.react.gm", t("sheet.notifyGM"), f.react.gm)
    );

    const shapes = Object.fromEntries([...au.SHAPES, a.area.shape].map((s) => [s, t(`workshop.au.shape.${s}`)]));
    const targetFields = [F.seg("f.targets", t("workshop.au.whoLabel"), f.targets, ["self", "selected", "area"].map((k) => [k, t(`workshop.au.targetsBtn.${k}`)]))];
    if (f.targets === "area") targetFields.push(
      F.seg("area.shape", t("workshop.au.shapeLabel"), a.area.shape, Object.entries(shapes)), F.num("area.size", t("workshop.au.sizeLabel"), a.area.size, { min: 5, step: 5 }),
      triSeg("f.excludeSelf", t("workshop.au.authorIn"), f.excludeSelf)
    );
    const isSpell = item.type === "spell", html = item._source.system.description?.value, have = au.parseTemplate(html), tag = au.templateTag(area.shape, area.size);
    const same = have && have.shape === area.shape && have.size === area.size, unparsed = au.templateState(html) === "unparsed";
    const areaNote = f.targets !== "area" ? null : {
      note: isSpell ? t("workshop.au.areaSpell", { shape: shapes[area.shape], size: area.size }) : unparsed ? t("workshop.au.areaUnparsed") : same ? t("workshop.au.areaHave", { tag }) : t("workshop.au.areaDesc", { tag }),
      insert: !isSpell && !same && !unparsed, locked: !item.isOwner || !!item.compendium?.locked
    };

    const rollFields = [F.seg("roll", t("workshop.au.whoRolls"), mode, ["save", "check", "none"].map((k) => [k, t(`workshop.au.rollBtn.${k}`)]))];
    if (mode === "save") {
      const c = f.ch;
      rollFields.push(
        F.text("f.ch.statistic", t("sheet.statistic"), c.statistic, { list: "ws-skills" }), F.sel("f.ch.dcType", t("sheet.dcLabel"), c.dcType, sheetChoices("dc", ["value", "expr", "markup", "source", "against"]))
      );
      if (["value", "expr", "against"].includes(c.dcType)) rollFields.push(F.text("f.ch.dcText", t("workshop.au.dcValue"), c.dcText, { inpCls: "ws-num" }));
      rollFields.push(F.chk("f.ch.basic", t("sheet.basic"), c.basic), F.text("f.ch.traits", t("sheet.traits"), c.traits), F.text("f.ch.options", t("sheet.options"), c.options), chWhen("f.ch", c), ...immFields("f.ch.imm", c.imm));
    } else if (mode === "check") {
      const k = f.ck, defs = sheetChoices("stat", ["fortitude", "reflex", "will", "perception"]);
      rollFields.push(
        F.text("f.ck.statistic", t("workshop.au.checkStat"), k.statistic, { list: "ws-skills", placeholder: "athletics, acrobatics" }), F.sel("f.ck.vsType", t("sheet.vsLabel"), k.vsType, sheetChoices("vs", ["defense", "dc", "against", "none"]))
      );
      if (k.vsType === "none") { /* СЛ задаёт система: поля защиты нет */ }
      else if (k.vsType === "defense") rollFields.push(F.sel("f.ck.vsText", t("workshop.au.vsWhat"), k.vsText, { ac: t("checks.ac"), ...defs }));
      else rollFields.push(F.text("f.ck.vsText", t("workshop.au.vsWhat"), k.vsText, { inpCls: "ws-num" }));
      rollFields.push(
        F.sel("f.ck.map", t("sheet.map"), k.map, [["", "—"], ["0", "0"], ["1", "1"], ["2", "2"]]), F.text("f.ck.traits", t("sheet.traits"), k.traits), F.text("f.ck.options", t("sheet.options"), k.options),
        ...(k.vsType === "none" ? [] : immFields("f.ck.imm", k.imm))
      );
    }

    const allConds = Object.keys(CONFIG.PF2E.conditionTypes ?? {}).map((s) => [s, condLabel(s)]).sort((x, y) => x[1].localeCompare(y[1]));
    const z = f.zone, zoneFields = f.targets !== "area" ? [] : [F.chk("f.zone.on", t("sheet.zoneOn"), z.on)];
    if (f.targets === "area" && z.on) zoneFields.push(
      F.sel("f.zone.cond", t("sheet.zoneCond"), z.cond, [["", "—"], ...allConds], { drop: "condition" }), F.num("f.zone.condValue", t("sheet.row.value"), z.condValue, { min: 1 }),
      F.text("f.zone.effect", t("sheet.zoneEffect"), z.effect, { drop: "effect", cls: "ws-grow" }), F.num("f.zone.seconds", t("sheet.seconds"), z.seconds, { min: 1 }), F.num("f.zone.rounds", t("sheet.rounds"), z.rounds, { min: 1 }),
      F.chk("f.zone.noFollow", t("sheet.zoneNoFollow"), z.noFollow),
      F.sel("f.zone.enterBy", t("sheet.zoneEnterBy"), z.enterBy, [["end", t("sheet.zoneEnterEnd")], ["path", t("sheet.zoneEnterPath")]]),
      F.sel("f.zone.gone", t("sheet.zoneGone"), z.gone, [["close", t("sheet.zoneGoneClose")], ["stay", t("sheet.zoneGoneStay")]])
    );

    // триггеры зоны: событие, «не чаще», шаги существа и (по желанию) его испытание
    const trgSel = !!a.sel?.startsWith("f.zone.trig.");
    const trgs = f.targets === "area" && z.on ? z.trig.map((e, i) => {
      const p = `f.zone.trig.${i}`, c = e.ch;
      return {
        i, title: `${i + 1}. ${t(`workshop.au.trg.on.${e.on}`)}`,
        fields: [
          F.sel(`${p}.on`, t("workshop.au.trg.onLabel"), e.on, choices(TRIGGER_ON, "au.trg.on")),
          F.sel(`${p}.per`, t("workshop.au.trg.perLabel"), e.per, { "": t("workshop.au.trg.perNone"), ...choices(TRIGGER_PER, "au.trg.per") }),
          F.chk(`${p}.ch.on`, t("workshop.au.trg.challenge"), c.on),
          ...(c.on ? [
            F.text(`${p}.ch.statistic`, t("sheet.statistic"), c.statistic, { list: "ws-skills" }), F.sel(`${p}.ch.dcType`, t("sheet.dcLabel"), c.dcType, sheetChoices("dc", ["value", "expr", "markup", "source", "against"])),
            ...(["value", "expr", "against"].includes(c.dcType) ? [F.text(`${p}.ch.dcText`, t("workshop.au.dcValue"), c.dcText, { inpCls: "ws-num" })] : []),
            F.chk(`${p}.ch.basic`, t("sheet.basic"), c.basic),
            F.text(`${p}.ch.traits`, t("sheet.traits"), c.traits), F.text(`${p}.ch.options`, t("sheet.options"), c.options), chWhen(`${p}.ch`, c),
            ...immFields(`${p}.ch.imm`, c.imm)
          ] : [])
        ],
        apply: lst(`${p}.apply`, t("workshop.au.trg.apply")),
        cols: c.on ? au.COLS.map((d) => lst(`${p}.ch.deg.${d}`, t(`sheet.degree.${d}`), d)) : null
      };
    }) : [];

    const builtins = au.builtinOptions(Object.keys(BUILTIN), (id) => (game.i18n.has(`PF2E_AUTOMATO.card.${id}`) ? game.i18n.localize(`PF2E_AUTOMATO.card.${id}`) : null));
    const macros = f.macros.map((m, i) => ({
      path: `f.macros.${i}`, name: m.form === "builtin" || m.uuid.startsWith("builtin:") ? "" : this.#names.get(m.uuid) ?? "",
      fields: [F.seg(`f.macros.${i}.form`, t("workshop.au.mac.kind"), m.form === "builtin" ? "builtin" : "", [["", t("workshop.au.mac.macro")], ["builtin", t("workshop.au.mac.builtin")]]),
        m.form === "builtin" ? F.sel(`f.macros.${i}.uuid`, t("workshop.au.mac.handler"), m.uuid, [["", "—"], ...builtins], { cls: "ws-grow" }) : F.text(`f.macros.${i}.uuid`, "UUID", m.uuid, { drop: "macro", cls: "ws-grow", placeholder: "Macro.xxxxxxxx" }), F.sel(`f.macros.${i}.phase`, t("workshop.au.phase"), m.phase, sheetChoices("phase", ["onUse", "afterChallenge", "onDegree", "zoneEnter", "zoneExit", "onReaction"])),
        ...(m.phase === "onDegree" ? [F.sel(`f.macros.${i}.degree`, t("workshop.au.degree"), m.degree, { "": t("sheet.anyDegree"), ...sheetChoices("degree", DEGREES) })] : [])]
    }));

    // события onEvent: у записи — событие, сторона, условие, «один раз», шаги владельца и (по желанию) испытание другого участника
    const evSel = !!a.sel?.startsWith("f.ev.");
    const evs = f.ev.map((e, i) => {
      const p = `f.ev.${i}`, c = e.ch;
      return {
        i, title: `${i + 1}. ${t(`workshop.au.ev.on.${e.on}`)}`,
        fields: [
          F.sel(`${p}.on`, t("workshop.au.ev.onLabel"), e.on, choices(EVENT_ON, "au.ev.on")),
          F.sel(`${p}.side`, t("workshop.au.ev.sideLabel"), e.side, choices(EVENT_SIDES.filter((s) => (s !== "target" || EVENT_TARGETED.has(e.on)) && (s !== "near" ? e.on !== "enter" : NEAR_ON.includes(e.on))), "au.ev.side")),
          ...(e.side === "near" ? [
            F.text(`${p}.aura`, t("workshop.au.ev.zoneAura"), e.aura, { placeholder: "frightful-aura", hint: t("workshop.au.ev.zoneAuraHint") }), F.num(`${p}.range`, t("workshop.au.ev.zoneRange"), e.range, { min: 1 }),
            F.sel(`${p}.per`, t("workshop.au.trg.perLabel"), e.per, { "": t("workshop.au.trg.perNone"), ...choices(TRIGGER_PER, "au.trg.per") })
          ] : []),
          F.text(`${p}.when`, t("workshop.au.ev.whenLabel"), e.when, { cls: "ws-grow", placeholder: "outcome:success, target:condition:off-guard", hint: t("workshop.au.ev.whenHint") }),
          F.chk(`${p}.once`, t("workshop.au.ev.once"), e.once),
          ...(EVENT_AFTER_USE.has(e.on) && e.side === "self" ? [F.chk(`${p}.afterUse`, t("workshop.au.ev.afterUse"), e.afterUse)] : []),
          F.chk(`${p}.ch.on`, t("workshop.au.ev.challenge"), c.on),
          ...(c.on ? [
            F.text(`${p}.ch.statistic`, t("sheet.statistic"), c.statistic, { list: "ws-skills" }), F.sel(`${p}.ch.dcType`, t("sheet.dcLabel"), c.dcType, sheetChoices("dc", ["value", "expr", "markup", "source", "against"])),
            ...(["value", "expr", "against"].includes(c.dcType) ? [F.text(`${p}.ch.dcText`, t("workshop.au.dcValue"), c.dcText, { inpCls: "ws-num" })] : []),
            F.chk(`${p}.ch.basic`, t("sheet.basic"), c.basic),
            F.text(`${p}.ch.traits`, t("sheet.traits"), c.traits), F.text(`${p}.ch.options`, t("sheet.options"), c.options), chWhen(`${p}.ch`, c),
            ...immFields(`${p}.ch.imm`, c.imm)
          ] : [])
        ],
        apply: lst(`${p}.apply`, t("workshop.au.ev.apply")),
        cols: c.on ? au.COLS.map((d) => lst(`${p}.ch.deg.${d}`, t(`sheet.degree.${d}`), d)) : null
      };
    });

    // активации cast: заклинание (бросок из компендиума), ранг, СЛ, частота, требование к предмету
    const casts = f.cast.map((c, i) => {
      const p = `f.cast.${i}`;
      return {
        i, title: `${i + 1}. ${c.label?.trim() || this.#names.get(c.spell) || t("workshop.au.cast.untitled")}`,
        fields: [
          F.text(`${p}.spell`, t("workshop.au.cast.spell"), c.spell, { drop: "spell", cls: "ws-spell", hint: this.#names.get(c.spell) ?? "", placeholder: "Compendium.pf2e.spells-srd.Item.…" }),
          F.num(`${p}.rank`, t("workshop.au.cast.rank"), c.rank, { min: 1, placeholder: t("workshop.au.cast.rankBase") }),
          F.sel(`${p}.dcType`, t("sheet.dcLabel"), c.dcType, choices(["auto", "value", "high"], "au.cast.dc")),
          ...(c.dcType === "value" ? [F.num(`${p}.dc`, t("workshop.au.dcValue"), c.dc, { min: 1 })] : []),
          F.num(`${p}.attack`, t("workshop.au.cast.attack"), c.attack, { placeholder: t("workshop.au.cast.attackAuto") }),
          F.num(`${p}.counteract`, t("workshop.au.cast.counteract"), c.counteract, { placeholder: t("workshop.au.cast.counteractAuto") }),
          F.num(`${p}.perValue`, t("workshop.au.cast.perValue"), c.perValue, { min: 1 }),
          F.sel(`${p}.perUnit`, t("workshop.au.unit"), c.perUnit, sheetChoices("unit", ["rounds", "minutes", "hours", "days"])),
          F.num(`${p}.perUses`, t("workshop.au.cast.perUses"), c.perUses, { min: 1, placeholder: "1" }),
          F.sel(`${p}.requires`, t("workshop.au.cast.requires"), c.requires, choices(["auto", "invested", "equipped", "held", "none"], "au.cast.req")),
          F.text(`${p}.id`, t("workshop.au.cast.id"), c.id, { placeholder: "electric-arc" }), F.text(`${p}.label`, t("sheet.label"), c.label),
          F.text(`${p}.note`, t("workshop.au.cast.note"), c.note, { cls: "ws-grow" })
        ]
      };
    });

    const onUse = f.kind === "onUse", R = (key, o) => ({ key, label: t(`workshop.au.row.${key}`), fold: true, open: !!a.open[key], sum: sums[key], hot: key === "outcome", ...o });
    const rows = [
      R("when", { fields: whenFields }),
      ...(f.kind === "onEvent" || f.ev.length ? [R("events", { is_events: true, evs, hot: true, edit: evSel ? edit : null })] : []),
      ...(f.kind === "cast" || f.cast.length ? [R("cast", { is_cast: true, casts, hot: true })] : []),
      ...(onUse ? [
        R("targets", { fields: targetFields, area: areaNote }),
        R("roll", { fields: rollFields }),
        R("outcome", { is_outcome: true, hintExcluded: a.hints?.excluded.length ? t("workshop.au.hintExcluded", { list: hintList(a.hints.excluded) }) : null, cols: mode === "none" ? null : au.COLS.map((d) => lst(`${au.degPath(mode)}.${d}`, t(`sheet.degree.${d}`), d)), imm: ((l) => ({ ...l, quiet: mode !== "none" && !l.steps.length && !l.picker }))(lst("f.apply", t(mode === "none" ? "workshop.au.immediate" : "workshop.au.immediateExtra"))), edit: evSel || trgSel ? null : edit }),
        R("zone", { fold: f.targets === "area", fields: zoneFields, ...(f.targets === "area" && z.on && { is_trig: true, trgs, edit: trgSel ? edit : null }) })
      ] : []),
      R("macros", { is_macros: true, macros })
    ];
    this.#live = { sums, plates };

    // правая панель: связный текст, строка про режим применения, пробный запуск
    const tokens = pickedTokens();
    let probe = null;
    if (v.ok && onUse) {
      const rep = buildReport(v.rule, tokens, penv);
      const rows2 = mode === "none" ? [] : au.tokenOdds(v.rule, tokens, penv).map((r) => {
        const bar = r.counts ? au.bar(r.counts).map((s) => ({ ...s, label: t(`sheet.degree.${s.deg}`), show: s.pct >= 15 })) : null;
        const best = r.best === null ? null : sums.degLists.find((x) => x.deg === DEGREES[r.best]);
        return { ...r, bar, aria: bar?.map((s) => `${s.label} ${s.pct}%`).join(", "), likely: best ? t("workshop.au.likely", { degree: t(`sheet.degree.${best.deg}`).toLowerCase(), effects: best.text || t("workshop.au.noEffects") }) : "" };
      });
      probe = { needDc, probeDc: a.probeDc ?? "", tokens: rows2, count: tokens.length, none: mode === "none", noTokens: !tokens.length, problems: rep.problems, legend: au.COLS.map((d) => ({ deg: d, label: t(`sheet.degree.${d}`) })) };
    }
    const errors = v.errors.map(errText), dirty = this.#dirty();
    const lockedFlag = !item.isOwner || !!item.compendium?.locked;
    return {
      head: {
        img: item.img, name: item.name, covered: groups.join(", "),
        kind: [game.i18n.localize(`TYPES.Item.${item.type}`), isSpell ? item.rank : item.system.level?.value].filter((x) => x !== undefined && x !== null).join(" "),
        traits: (item.system.traits?.value ?? []).map(traitLabel),
        src: { ...(res ? { label: t(`sheet.src.${res.source}`), low: res.confidence === "low", canAccept: res.source !== "flag", locked: lockedFlag } : { label: t("workshop.au.noRule") }), diverged: divergedHint(res?.diverged ?? divergedOf(item)) }
      },
      skills: [...sheetStat, ...Object.keys(CONFIG.PF2E.skills ?? {})], conds: grantable().map((c) => ({ ...c, q: c.label.toLowerCase() })),
      rows, doubleWarn: !!groups.length && (f.yield === "no" || (f.yield === "auto" && !setting)) ? t("sheet.doubleWarn") + ` «${groups.join(", ")}»` : "",
      probeMsg: t(onUse ? "workshop.au.probeBlocked" : "workshop.au.probeOnlyUse"), story, applyNote: onUse ? t(`workshop.au.applyMode.${modeOf("apply")}`) : "", probe,
      errors, error: errors[0] ? errors[0] + (errors.length > 1 ? ` ${t("workshop.err.more", { n: errors.length - 1 })}` : "") : "",
      dirty, status: t(dirty ? "workshop.au.dirty" : res?.source === "flag" ? "workshop.au.savedState" : "workshop.au.notInItem"),
      lockedFlag, noSource: !sourceUuid, noSlug: !slug, isWorld: res?.source === "world", canUnset: res?.source === "flag" && !lockedFlag
    };
  }

  /** Сводки и плашки на месте: ввод текста не перерисовывает поля (иначе теряется фокус). */
  #paint() {
    const live = this.#live, el = this.element;
    if (!live || !el) return;
    for (const n of el.querySelectorAll("[data-sum]")) if (n.dataset.sum in live.sums) n.textContent = live.sums[n.dataset.sum];
    for (const n of el.querySelectorAll("[data-plate]")) { const p = live.plates[n.dataset.plate]; if (p) n.textContent = p.text; }
    for (const n of el.querySelectorAll("[data-pv]")) { const p = live.plates[n.dataset.pv]; if (p) n.textContent = p.value; }
  }

  _onFirstRender() {
    const el = this.element;
    // Текст/числа: правим модель на лету и обновляем только предпросмотр — перерисовка форм сбила бы фокус
    el.addEventListener("input", async (ev) => {
      if (ev.target.matches("[data-filter]")) {   // поиск в списке состояний: только прячем строки
        const q = ev.target.value.trim().toLowerCase();
        for (const b of ev.target.closest(".ws-pick").querySelectorAll("[data-q]")) b.hidden = !b.dataset.q.includes(q);
        return;
      }
      const f = ev.target.closest("[data-f],[data-a],[data-i]");
      if (!f || f.tagName === "SELECT" || f.type === "checkbox") return;
      this.#set(f, f.value);
      if (f.dataset.i === "q") return this.#find();
      if (f.dataset.a === "probeDc") return;   // пересчёт по change (Enter/уход из поля): перерисовка панели сбила бы курсор
      if (this.#mode === "automation") { this.#typing = true; await this.render({ parts: ["aside", "footer"] }); this.#paint(); this.#settle(); return; }
      this.render({ parts: ["aside", "footer"] });
      const id = f.dataset.block;
      if (id) { const row = el.querySelector(`.ws-text[data-block="${id}"]`); if (row) row.textContent = this.#text(this.#block(id)); }
    });
    // Выбор из списка и флажки: могут менять набор полей — перерисовываем форму
    el.addEventListener("change", (ev) => {
      const f = ev.target.closest("[data-f],[data-a],[data-i]");
      if (f?.dataset.a === "probeDc") { this.#set(f, f.value); this.render({ parts: ["aside"] }); return; }
      if (!f || !(f.tagName === "SELECT" || f.type === "checkbox")) return;
      const v = f.type === "checkbox" ? f.checked : f.value;
      this.#set(f, v);
      if (f.dataset.f === "slug" && f.dataset.block && this.#block(f.dataset.block).kind === "cond") Object.assign(this.#block(f.dataset.block), { uuid: "", name: "", valued: condValued(v) });
      this.#redraw();
    });
    // Список состояний закрывается кликом мимо
    el.addEventListener("click", (ev) => {
      if (this.#au?.picker && !ev.target.closest(".ws-pick, [data-action=togglePicker]")) { this.#au.picker = null; this.#redraw(); }
      if (this.#mode === "item" && this.#wiz.picker && !ev.target.closest(".ws-pick, [data-action=toggleTraits]")) { this.#wiz.picker = false; this.#redraw(); }
    });
    el.addEventListener("dragover", (ev) => ev.preventDefault());
    el.addEventListener("drop", (ev) => ({ automation: () => this.#dropAuto(ev), item: () => this.#dropItem(ev) }[this.#mode] ?? (() => this.#drop(ev)))().catch((e) => console.error(`${MOD} | workshop`, e)));
  }

  /** Бросок состояния/эффекта из компендиума: в выбранный кубик «состояние» или в новый. */
  async #drop(ev) {
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(ev);
    if (!data?.type) return;
    ev.preventDefault();
    const doc = data.type === "Item" ? await safeUuid(data.uuid) : null;
    const spec = dropSpec(data, doc);
    if (spec?.temp) return ui.notifications.warn(L("sheet.dropTemp"));
    if (!spec || spec.macro || spec.kind === "spell") return ui.notifications.warn(t("workshop.dropBad"));
    let patch;
    if (spec.kind === "condition") {
      if (!conditions().has(spec.text) || NOT_GRANTABLE.has(spec.text)) return ui.notifications.warn(t("workshop.dropBad"));
      patch = { slug: spec.text, uuid: "", name: "", valued: condValued(spec.text) };
    } else patch = { slug: "", uuid: spec.text, name: doc.name, valued: false };
    const cur = this.#block(this.#sel);
    if (cur?.kind === "cond") { Object.assign(cur, patch); this.#redraw(); } else this.#add("cond", patch);
  }

  /** Бросок на режим «Автоматизация»: макрос — в список макросов; состояние/эффект — в поле UUID под курсором или в колонку/список шагов. */
  async #dropAuto(ev) {
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(ev);
    if (!data?.type) return;   // обычный текст — штатное поведение полей
    ev.preventDefault();
    const a = this.#au, doc = data.type === "Item" ? await safeUuid(data.uuid) : null, spec = dropSpec(data, doc);
    if (spec?.temp) return ui.notifications.warn(L("sheet.dropTemp"));
    if (!spec) return ui.notifications.warn(t("workshop.au.dropBad"));
    if (spec.macro) {
      const field = ev.target.closest("[data-drop=macro]");
      if (field) this.#setAuto(field.dataset.a, spec.macro);
      else { a.f.macros.push({ uuid: spec.macro, phase: "onUse", degree: "" }); a.open.macros = true; }
      return this.#redraw();
    }
    const field = ev.target.closest("[data-drop=effect], [data-drop=condition], [data-drop=spell]");
    if (field && spec.kind === field.dataset.drop) { this.#setAuto(field.dataset.a, spec.text); return this.#redraw(); }
    if (spec.kind === "spell") { a.f.cast.push({ ...blankCast(), spell: spec.text }); a.open.cast = true; return this.#redraw(); }   // заклинание мимо поля — новая активация
    if (spec.kind === "condition" && (!conditions().has(spec.text) || NOT_GRANTABLE.has(spec.text))) return ui.notifications.warn(t("workshop.dropBad"));
    const list = ev.target.closest(".ws-dcol, .ws-dimm")?.querySelector("[data-list]")?.dataset.list ?? (au.rollMode(a.f) === "none" && a.f.kind === "onUse" ? "f.apply" : null);
    if (!list) return ui.notifications.warn(t("workshop.au.dropColumn"));
    this.#addStep(list, spec);
  }

  /* ---------- режим «Предмет» ---------- */

  #actor() { return canvas.tokens?.controlled[0]?.actor ?? null; }

  /** Новая основа типа type; название, описание, цена, редкость, эффект и выбор «куда» переносим с прежней. */
  #fresh(type, old) {
    const m = im.blankItem(type);
    return { ...m, name: old.name, desc: old.desc, price: old.price, rarity: old.rarity, effect: old.effect, to: old.to, auto: old.auto, dest: old.dest,
      blocks: ["equipment", "weapon"].includes(type) && ["equipment", "weapon"].includes(old.type) ? old.blocks : [],
      level: type === "feat" ? Math.max(1, Number(old.level) || 1) : old.level, img: old.img.startsWith(im.DEFAULT_DIR) ? m.img : old.img };
  }

  #setEffect(e) {
    const m = this.#wiz.m;
    if (im.linksEffect(m.type)) m.desc = im.withEffectLink(m.desc, m.effect, e);
    m.effect = e;
  }

  #setIt(path, v) {
    const w = this.#wiz, m = w.m;
    if (path === "type") {
      if (v === m.type) return;
      const on = im.linksEffect(v);
      if (m.effect && on !== im.linksEffect(m.type)) m.desc = im.withEffectLink(m.desc, on ? null : m.effect, on ? m.effect : null);
      w.m = this.#fresh(v, m);
      w.picked = null;
      if (w.q.trim()) this.#find();
    } else if (path === "effectUuid") {
      const found = game.items.get(String(v).replace(/^Item\./, ""));
      this.#setEffect(v ? { uuid: v, name: found?.name ?? (m.effect?.uuid === v ? m.effect.name : v) } : null);
    } else if (path === "q") w.q = v;
    else foundry.utils.setProperty(m, path, v);
  }

  async #search() {
    const w = this.#wiz, q = w.q.trim().toLowerCase(), seq = ++w.seq;
    let found = [];
    if (q.length >= 2) {
      const index = await game.packs.get(im.PACKS[w.m.type])?.getIndex({ fields: ["system.level.value"] });
      found = (index?.contents ?? []).filter((e) => e.type === w.m.type && e.name.toLowerCase().includes(q)).sort((a, z) => a.name.localeCompare(z.name)).slice(0, 30)
        .map((e) => ({ uuid: e.uuid, name: e.name, lvl: e.system?.level?.value != null ? `${t("workshop.level")} ${e.system.level.value}` : "" }));
    }
    if (seq !== w.seq) return;   // ответ устарел: ввод ушёл дальше
    w.found = found;
    const el = this.element?.querySelector('[name="i-q"]'), sel = el && document.activeElement === el ? [el.selectionStart, el.selectionEnd] : null;
    await this.render({ parts: ["main"] });
    if (sel) this.element.querySelector('[name="i-q"]')?.setSelectionRange(...sel);   // ядро возвращает фокус, но не каретку
  }

  async #pickBase(uuid) {
    const doc = await safeUuid(uuid), w = this.#wiz;
    if (!doc) return;
    const keep = w.m;
    w.m = { ...im.modelFromSource(doc.toObject()), to: keep.to, auto: keep.auto, dest: keep.dest };
    w.picked = uuid;
    if (im.linksEffect(w.m.type)) w.m.effect = keep.type === w.m.type ? keep.effect : null;
    this.#redraw();
  }

  /** Бросок эффекта на режим «Предмет»: в выбор эффекта (расходник, непассивное действие/черта). */
  async #dropItem(ev) {
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(ev);
    if (!data?.type) return;
    ev.preventDefault();
    const doc = data.type === "Item" ? await safeUuid(data.uuid) : null, spec = dropSpec(data, doc), m = this.#wiz.m;
    if (spec?.temp) return ui.notifications.warn(L("sheet.dropTemp"));
    if (spec?.kind === "condition" && (m.type === "equipment" || m.type === "weapon")) return this.#drop(ev);   // состояние — в кубик «Состояние»
    if (spec?.kind !== "effect") return ui.notifications.warn(t("workshop.item.dropBad"));
    if (!(m.type === "consumable" || ((m.type === "action" || m.type === "feat") && m.act.type !== "passive"))) return ui.notifications.warn(t("workshop.item.dropNo"));
    this.#setEffect({ uuid: spec.text, name: doc.name });
    this.#redraw();
  }

  async #createItem() {
    const w = this.#wiz, m = w.m, ctx = this.#ctx(), actor = m.dest === "actor" ? this.#actor() : null;
    if (w.done || im.validate(m, ctx).length || (m.dest === "actor" && (!actor || !actor.allowedItemTypes.includes(im.PHYSICAL.has(m.type) ? "physical" : m.type)))) return;
    const folder = await workshopFolder("item");
    const item = await Item.create({ ...im.buildItem(m, ctx), folder: folder.id });
    w.done = { uuid: item.uuid, name: item.name }; w.doneSnap = JSON.stringify(m);   // сразу: сбой копии на актёре не должен приводить ко второму мировому предмету
    ui.notifications.info(t("workshop.item.created", { name: item.name, folder: folder.name }));
    if (actor) {
      const d = item.toObject();
      for (const k of ["_id", "folder", "sort", "ownership", "_stats"]) delete d[k];
      const [copy] = await actor.createEmbeddedDocuments("Item", [d]);
      if (copy) w.done = { uuid: copy.uuid, name: copy.name };   // правило работает у копии на актёре — её и открываем в конвейере
    }
    this.render({ parts: ["main", "footer"] });
  }

  async #openPipe() {
    const doc = await safeUuid(this.#wiz.done?.uuid);
    if (!doc || !(await this.#setItem(doc))) return;
    this.#mode = "automation";
    await this.render({ window: { title: this.title } });
  }

  /** Контекст режима «Предмет»: шаги, поля по типу, карточка предпросмотра, подвал. */
  #itemCtx() {
    const w = this.#wiz, m = w.m, ctx = this.#ctx(), type = m.type, pf = CONFIG.PF2E;
    const physical = im.PHYSICAL.has(type), isAbility = type === "action" || type === "feat", passive = isAbility && m.act.type === "passive";
    const actor = this.#actor(), loc = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, game.i18n.localize(v?.label ?? v)]));
    const sorted = (o) => Object.fromEntries(Object.entries(loc(o)).sort((a, z) => a[1].localeCompare(z[1])));
    const seg = (list, cur, label) => list.map((v) => ({ value: String(v), label: label(v), on: String(cur) === String(v) }));
    const actorOk = !actor || actor.allowedItemTypes.includes(physical ? "physical" : type);   // NPC не принимает черты, лут и транспорт — действия и черты
    const errors = [...im.validate(m, ctx), ...(m.dest === "actor" ? (!actor ? [t("workshop.item.err.noActor")] : !actorOk ? [t("workshop.item.err.actorType", { name: actor.name, type: game.i18n.localize(`TYPES.Item.${type}`) })] : []) : [])];
    const stale = !!w.done && JSON.stringify(m) !== w.doneSnap;
    const typeName = game.i18n.localize(`TYPES.Item.${type}`), kind = [typeName, type === "action" ? null : m.level].filter((x) => x !== null && x !== "").join(" ");

    // эффекты папки мастерской + текущий (брошенный из компендиума)
    const folder = findFolder("effect"), effects = { "": t("workshop.item.noEffect") };
    for (const e of game.items.filter((i) => i.type === "effect" && folder && i.folder?.id === folder.id).sort((a, z) => a.name.localeCompare(z.name))) effects[e.uuid] = e.name;
    if (m.effect && !(m.effect.uuid in effects)) effects[m.effect.uuid] = m.effect.name;

    const dict = pf[{ consumable: "consumableTraits", equipment: "equipmentTraits", weapon: "weaponTraits", action: "actionTraits", feat: "featTraits" }[type]] ?? {};
    const label = (s) => (dict[s] ? game.i18n.localize(dict[s]) : traitLabel(s));
    const traitList = Object.keys(dict).filter((s) => !(s in pf.rarityTraits) && !m.traits.includes(s)).map((s) => ({ slug: s, label: label(s) }))
      .sort((a, z) => a.label.localeCompare(z.label)).map((x) => ({ ...x, q: `${x.label} ${x.slug}`.toLowerCase() }));
    const category = type === "consumable" ? sorted(pf.consumableCategories) : type === "feat" ? sorted(pf.featCategories) : type === "action" ? { "": "—", ...sorted(pf.actionCategories) } : {};
    const bulkOpts = [...im.BULKS, ...(im.BULKS.includes(Number(m.bulk)) ? [] : [Number(m.bulk)])].map((b) => ({ value: b, label: im.bulkText(b, t), on: Number(m.bulk) === b }));

    // шаг «Автоматизация»: сводка правила тем же языком, что конвейер
    const raw = im.ruleOf(m), v = raw && validateRule(raw);
    let sums = null;
    if (v?.ok) {
      const s = au.summaries(ruleToForm(v.rule), { t, statLabel: (x) => x, conditionLabel: condLabel, damageLabel, uuidName: (u) => (m.effect?.uuid === u ? m.effect.name : null), valued: condValued, area: au.DEFAULT_AREA });
      sums = ["when", "targets", "roll", "outcome"].map((k) => ({ label: t(`workshop.au.row.${k}`), text: s[k] }));
    }
    const autoNote = type === "consumable" ? t(m.auto ? "workshop.item.autoNone" : "workshop.item.autoOff") : t(`workshop.item.autoNote.${isAbility ? "ability" : "rules"}`);
    const rules = im.rulesOf(m, ctx), hasEffect = m.effect && (type === "consumable" || (isAbility && !passive));
    const plan = [
      t("workshop.item.plan.item", { name: m.name.trim() || "…", folder: t("workshop.item.folder") }),
      hasEffect && t("workshop.item.plan.effect", { name: m.effect.name }), rules.length && t("workshop.item.plan.rules", { n: rules.length }), sums && t("workshop.item.plan.rule"),
      m.dest === "actor" && actor && t("workshop.item.plan.actor", { name: actor.name })
    ].filter(Boolean);

    const keys = ["base", "general", "does", "auto", "done"];
    const steps = keys.map((k, i) => ({ i, n: i + 1, label: t(`workshop.item.step.${k}`), on: w.step === i, done: i < w.step, last: i === 4 }));
    const rar = pf.rarityTraits, blocksText = rules.length ? m.blocks.map((b) => this.#text(b, ctx)).join("; ") : "";
    const eff = hasEffect ? t(m.to === "self" || isAbility ? "workshop.item.note.effectSelf" : "workshop.item.note.effectTarget", { name: m.effect.name }) : "";
    return {
      head: { img: m.img, kind, sub: m.base ? t("workshop.item.headCopy", { name: m.base }) : t("workshop.item.headNew", { type: typeName, folder: t("workshop.item.folder") }) },
      steps, s0: w.step === 0, s1: w.step === 1, s2: w.step === 2, s3: w.step === 3, s4: w.step === 4,
      types: im.TYPES.map((key) => ({ key, name: t(`workshop.item.type.${key}`), hint: t(`workshop.item.typeHint.${key}`), on: key === type })),
      q: w.q, found: w.found.map((f) => ({ ...f, on: f.uuid === w.picked })), packLabel: t(`workshop.item.pack.${im.PACK_LABEL[type]}`),
      findNote: w.q.trim().length < 2 ? t("workshop.item.searchHint") : w.found.length ? "" : t("workshop.item.noFound"),
      m, physical, isConsumable: type === "consumable", isEquipment: type === "equipment", isWeapon: type === "weapon", isAbility, passive,
      hasLevel: type !== "action", minLevel: type === "feat" ? 1 : 0, hasRarity: type !== "action", hasCategory: type !== "equipment" && type !== "weapon",
      categoryLabel: type === "equipment" || type === "weapon" ? "" : t(`workshop.item.category.${type}`), rarities: seg(im.RARITIES, m.rarity, (k) => game.i18n.localize(rar[k])),
      c: { category, usage: sorted(Object.fromEntries([...new Set([...im.USAGES, m.usage])].map((u) => [u, pf.usages?.[u] ?? u]))), effects, wCategory: sorted(pf.weaponCategories), wGroup: { "": "—", ...sorted(pf.weaponGroups) }, die: Object.fromEntries(fx.DICE.map((d) => [d, d])), dmgType: choices(fx.DAMAGE_TYPES, "dtype") },
      bulkOpts, traits: m.traits.map((s) => ({ slug: s, label: label(s) })), picker: w.picker, traitList, linkNote: im.linksEffect(type),
      effectUuid: m.effect?.uuid ?? "", tos: seg(["self", "target"], m.to, (k) => t(`workshop.item.to_${k}`)),
      actTypes: seg(im.ACT_TYPES, m.act.type, (k) => t(`workshop.item.actType_${k}`)), actions: seg([1, 2, 3], m.act.actions, (k) => t(`workshop.item.act.n${k}`)), showActions: m.act.type === "action",
      kinds: seg(["melee", "ranged"], m.weapon.kind, (k) => t(`workshop.item.kind_${k}`)), ranged: m.weapon.kind === "ranged",
      hands: seg(["held-in-one-hand", "held-in-two-hands"], m.usage, (k) => t(`workshop.item.hands_${k}`)),
      hasActivation: type === "consumable" || type === "equipment", activations: seg(im.ACTIVATIONS, m.activation, (k) => t(`workshop.item.act.${k === "" ? "none" : /^\d$/.test(k) ? `n${k}` : k}`)),
      hasBlocks: type === "equipment" || type === "weapon", doesNote: t(`workshop.item.does.${type}`),
      blocks: m.blocks.map((b) => this.#view(b, ctx)), palette: fx.KINDS.map((kd) => ({ kind: kd, icon: ICONS[kd], label: t(`workshop.kind.${kd}`) })),
      canAuto: type === "consumable", sums, autoNote, plan, done: w.done,
      dests: [{ value: "world", label: t("workshop.item.dest.world"), on: m.dest === "world" }, { value: "actor", label: actor ? t("workshop.item.dest.actor", { name: actor.name }) : t("workshop.item.dest.actorNone"), on: m.dest === "actor", disabled: !actorOk }],
      // карточка предпросмотра и подвал
      img: m.img, name: m.name.trim(), kind, rarity: type !== "action" && m.rarity !== "common" ? { key: m.rarity, label: game.i18n.localize(rar[m.rarity]) } : null,
      cardTraits: m.traits.map(label), facts: im.facts(m, t), descHtml: im.descPreview(m.desc),
      notes: [eff, blocksText && t("workshop.item.note.blocks", { list: blocksText }), sums && t("workshop.item.note.rule", { text: sums[3].text })].filter(Boolean),
      errors, error: errors[0] ? errors[0] + (errors.length > 1 ? ` ${t("workshop.err.more", { n: errors.length - 1 })}` : "") : "",
      hint: t(stale ? "workshop.item.stale" : "workshop.item.footHint"),
      canBack: w.step > 0, canNext: w.step < 4, back: w.step - 1, next: w.step + 1, nextLabel: t(`workshop.item.step.${keys[Math.min(4, w.step + 1)]}`).toLowerCase()
    };
  }

  async #create(open) {
    if (!game.user.isGM || this.#busy) return;
    const ctx = this.#ctx();
    if (fx.validate(this.model, ctx).length) return;
    this.#busy = true;
    let back = false;
    try {
      const folder = await workshopFolder("effect");
      const item = await Item.create({ ...fx.buildEffect(this.model, ctx), folder: folder.id });
      ui.notifications.info(t("workshop.created", { name: item.name, folder: folder.name }));
      if (open) item.sheet.render(true);
      if (this.#back) {   // эффект делали для предмета: подставляем его и возвращаемся
        this.#mode = "item"; this.#back = null; this.#wiz.step = 2; this.#sel = null;
        this.#setEffect({ uuid: item.uuid, name: item.name });
        this.model = fx.blankModel();
        back = true;
      }
    } catch (e) {
      console.error(`${MOD} | workshop`, e);
      ui.notifications.error(`${t("workshop.createFailed")}: ${e?.message ?? e}`);
    } finally { this.#busy = false; }
    if (back) this.render({ window: { title: this.title } });
  }

  /** Цели/выделение изменились или предмет обновили извне: пробный запуск и (без правок) форма — заново. */
  static refresh({ item = null } = {}) {
    const app = Workshop.#instance;
    if (app?.rendered && app.#mode === "item" && !item && app.#wiz.step === 4) return app.render({ parts: ["main", "footer"] });   // «выдать актёру» зависит от выделенного токена
    if (!app?.rendered || app.#mode !== "automation") return;
    if (item) {
      if (app.#item?.uuid !== item.uuid) return;
      if (!app.#dirty()) app.#loadAu(true);
      return app.render({ window: { title: app.title } });
    }
    app.render({ parts: ["aside"] });
  }
}

/** Кнопка в шапке вкладки Items боковой панели (только ГМ). */
export function init() {
  Hooks.on("renderItemDirectory", (_app, html) => {
    const bar = html.querySelector(".header-actions");
    if (!game.user.isGM || !bar || bar.querySelector(".paf-workshop")) return;
    const b = Object.assign(document.createElement("button"), { type: "button", className: "paf-workshop" });
    b.innerHTML = `<i class="fa-solid fa-hammer" inert></i><span>${t("workshop.open")}</span>`;
    b.addEventListener("click", () => Workshop.open());
    bar.append(b);
  });
  const probe = foundry.utils.debounce(() => Workshop.refresh(), 100);   // выделение рамкой шлёт controlToken на каждый токен
  for (const hook of ["targetToken", "controlToken"]) Hooks.on(hook, (user) => { if (hook !== "targetToken" || user?.id === game.user.id) probe(); });
  Hooks.on("updateItem", (item) => Workshop.refresh({ item }));
}
