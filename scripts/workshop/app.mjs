// Мастерская: окно ГМа (ApplicationV2), режим «Эффект»; новые режимы — новые части PARTS.
// Чистая часть (модель кубиков -> RE, валидация) — effect.mjs; здесь только DOM, Foundry и создание документов.
import { MOD, L } from "../util.mjs";
import { dropSpec } from "../sheet.mjs";
import { safeUuid } from "../saves.mjs";
import * as fx from "./effect.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const TPL = (n) => `modules/${MOD}/templates/workshop-${n}.hbs`;
const ICONS = { bonus: "plus-minus", resist: "shield-halved", temphp: "heart", fastheal: "heart-pulse", dmg: "burst", speed: "person-running", sense: "eye", cond: "circle-exclamation", note: "note-sticky", aura: "circle-dot", light: "sun", raw: "code" };

const t = (key, data) => L(key, data);
const choices = (list, prefix) => Object.fromEntries(list.map((k) => [k, t(`workshop.${prefix}.${k}`)]));
const picks = (list, prefix, cur) => list.map((v) => ({ value: v, label: t(`workshop.${prefix}.${v}`), on: v === cur }));

/** Состояния pf2e: slug -> UUID компендиума берём в рантайме у ConditionManager (id в коде не зашиты). */
const conditions = () => game.pf2e.ConditionManager.conditions;
const condUuid = (slug) => conditions().get(slug)?.uuid ?? null;
const condValued = (slug) => !!conditions().get(slug)?.system?.value?.isValued;
// persistent-damage требует формулу и тип; состояния зрения у модуля идут своей политикой (apply.mjs SIGHT_CONDITIONS)
const NOT_GRANTABLE = new Set(["persistent-damage", "hidden", "undetected", "concealed", "observed", "unnoticed"]);
const condLabel = (slug) => { const k = CONFIG.PF2E.conditionTypes?.[slug]; return k ? game.i18n.localize(k) : slug; };

/** Мировая папка Item «AuTOMATO / Эффекты»: ищем по флагу (имя переводится), затем по имени; нет — создаём. */
async function effectsFolder() {
  const name = t("workshop.folder");
  return game.folders.find((f) => f.type === "Item" && f.getFlag(MOD, "workshop"))
    ?? game.folders.find((f) => f.type === "Item" && f.name === name && !f.folder)
    ?? await Folder.create({ name, type: "Item", flags: { [MOD]: { workshop: true } } });
}

export class Workshop extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;
  #id = 0;
  #sel = null;       // id раскрытого кубика
  #busy = false;
  model = fx.blankModel();

  static DEFAULT_OPTIONS = {
    id: "pf2e-automato-workshop",
    classes: ["pf2e-automato-workshop"],
    position: { width: 1040, height: 720 },
    window: { title: "PF2E_AUTOMATO.workshop.title", icon: "fa-solid fa-hammer", resizable: true },
    actions: {
      addBlock(_e, el) { this.#add(el.dataset.kind); },
      removeBlock(_e, el) { this.model.blocks = this.model.blocks.filter((b) => b.id !== Number(el.dataset.block)); this.#redraw(); },
      toggleBlock(_e, el) { const id = Number(el.dataset.block); this.#sel = this.#sel === id ? null : id; this.#redraw(); },
      pick(_e, el) { this.#set(el, el.dataset.v); this.#redraw(); },
      pickImg() {
        new foundry.applications.apps.FilePicker.implementation({ type: "image", current: this.model.img, callback: (path) => { this.model.img = path; this.render(); } }).render({ force: true });
      },
      create() { return this.#create(false); },
      createOpen() { return this.#create(true); }
    }
  };

  static PARTS = {
    header: { template: TPL("header") },
    effect: { template: TPL("effect"), scrollable: [""] },
    aside: { template: TPL("aside"), scrollable: ["", "pre"] },
    footer: { template: TPL("footer") }
  };

  /** Открыть (единственное окно). Только ГМ. */
  static open() {
    if (!game.user.isGM) return ui.notifications.warn(t("workshop.gmOnly"));
    return (Workshop.#instance ??= new Workshop()).render({ force: true });
  }

  _onClose(options) { Workshop.#instance = null; return super._onClose(options); }

  #ctx() { return { t, uuidOf: condUuid, condLabel, resistKnown: (k) => k in CONFIG.PF2E.resistanceTypes, ruleKnown: (k) => k in game.pf2e.RuleElements.all }; }
  #block(id) { return this.model.blocks.find((b) => b.id === Number(id)); }
  #add(kind, patch = {}) {
    const b = { id: ++this.#id, ...fx.blankBlock(kind), ...patch };
    this.model.blocks.push(b);
    this.#sel = b.id;
    this.#redraw();
    return b;
  }
  #redraw() { return this.render({ parts: ["effect", "aside", "footer"] }); }
  #set(el, v) {
    const f = el.dataset.f;
    if (el.dataset.block) this.#block(el.dataset.block)[f] = v;
    else foundry.utils.setProperty(this.model, f, v);
  }

  #view(b, ctx) {
    const c = {
      target: choices(fx.TARGETS, "targets"), noteTarget: choices(fx.TARGETS.filter((x) => x !== "ac"), "targets"),
      resist: choices(fx.RESIST_TYPES, "dtype"), dmgType: choices(fx.DAMAGE_TYPES, "dtype"), die: Object.fromEntries(fx.DICE.map((d) => [d, d])),
      sense: choices(fx.SENSES, "senses"), acuity: choices(fx.ACUITY, "acuities"),
      cond: { "": b.uuid ? b.name : t("workshop.condNone"), ...Object.fromEntries([...Object.keys(CONFIG.PF2E.conditionTypes ?? {})].filter((s) => conditions().has(s) && !NOT_GRANTABLE.has(s)).sort((a, z) => condLabel(a).localeCompare(condLabel(z))).map((s) => [s, condLabel(s)])) }
    };
    return {
      ...b, c, open: this.#sel === b.id, kindLabel: t(`workshop.kind.${b.kind}`), text: fx.textOf(b, ctx),
      isSigned: b.kind === "bonus" || b.kind === "speed", isBonus: b.kind === "bonus", isSpeed: b.kind === "speed",
      plus: Number(b.sign) > 0, types: picks(fx.BONUS_TYPES, "btype", b.type),
      showAcuity: b.kind === "sense" && !fx.PRECISE.has(b.sense), showRange: b.kind === "sense" && !fx.NO_RANGE.has(b.sense),
      [`is_${b.kind}`]: true
    };
  }

  async _prepareContext() {
    const m = this.model, ctx = this.#ctx(), errors = fx.validate(m, ctx);
    const rules = m.blocks.flatMap((b) => fx.rulesOf(b, ctx)), dur = fx.durationText(m.dur, t);
    return {
      name: m.name, level: m.level, img: m.img, subtitle: t("workshop.subtitle", { folder: t("workshop.folder") }),
      dur: m.dur, units: picks(fx.UNITS, "unit", m.dur.unit), expiry: choices(fx.EXPIRY, "expiry"), unlimited: m.dur.unit === "unlimited",
      blocks: m.blocks.map((b) => this.#view(b, ctx)),
      palette: fx.KINDS.map((kind) => ({ kind, icon: ICONS[kind], label: t(`workshop.kind.${kind}`) })),
      preview: { durShort: dur.short, durLong: dur.long, count: rules.length, json: JSON.stringify(rules, null, 2) },
      desc: fx.descriptionText(m.blocks, ctx),
      errors, error: errors[0] ? errors[0] + (errors.length > 1 ? ` ${t("workshop.err.more", { n: errors.length - 1 })}` : "") : ""
    };
  }

  _onFirstRender() {
    const el = this.element;
    // Текст/числа: правим модель на лету и обновляем только предпросмотр — перерисовка форм сбила бы фокус
    el.addEventListener("input", (ev) => {
      const f = ev.target.closest("[data-f]");
      if (!f || f.tagName === "SELECT" || f.type === "checkbox") return;
      this.#set(f, f.value);
      this.render({ parts: ["aside", "footer"] });
      const id = f.dataset.block;
      if (id) { const row = el.querySelector(`.ws-text[data-block="${id}"]`); if (row) row.textContent = fx.textOf(this.#block(id), this.#ctx()); }
    });
    // Выбор из списка и флажки: могут менять набор полей — перерисовываем форму
    el.addEventListener("change", (ev) => {
      const f = ev.target.closest("[data-f]");
      if (!f || !(f.tagName === "SELECT" || f.type === "checkbox")) return;
      const v = f.type === "checkbox" ? f.checked : f.value;
      this.#set(f, v);
      if (f.dataset.f === "slug" && f.dataset.block && this.#block(f.dataset.block).kind === "cond") Object.assign(this.#block(f.dataset.block), { uuid: "", name: "", valued: condValued(v) });
      this.#redraw();
    });
    el.addEventListener("dragover", (ev) => ev.preventDefault());
    el.addEventListener("drop", (ev) => this.#drop(ev).catch((e) => console.error(`${MOD} | workshop`, e)));
  }

  /** Бросок состояния/эффекта из компендиума: в выбранный кубик «состояние» или в новый. */
  async #drop(ev) {
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(ev);
    if (!data?.type) return;
    ev.preventDefault();
    const doc = data.type === "Item" ? await safeUuid(data.uuid) : null;
    const spec = dropSpec(data, doc);
    if (spec?.temp) return ui.notifications.warn(L("sheet.dropTemp"));
    if (!spec || spec.macro) return ui.notifications.warn(t("workshop.dropBad"));
    let patch;
    if (spec.kind === "condition") {
      if (!conditions().has(spec.text) || NOT_GRANTABLE.has(spec.text)) return ui.notifications.warn(t("workshop.dropBad"));
      patch = { slug: spec.text, uuid: "", name: "", valued: condValued(spec.text) };
    } else patch = { slug: "", uuid: spec.text, name: doc.name, valued: false };
    const cur = this.#block(this.#sel);
    if (cur?.kind === "cond") { Object.assign(cur, patch); this.#redraw(); } else this.#add("cond", patch);
  }

  async #create(open) {
    if (!game.user.isGM || this.#busy) return;
    const ctx = this.#ctx();
    if (fx.validate(this.model, ctx).length) return;
    this.#busy = true;
    try {
      const folder = await effectsFolder();
      const item = await Item.create({ ...fx.buildEffect(this.model, ctx), folder: folder.id });
      ui.notifications.info(t("workshop.created", { name: item.name, folder: folder.name }));
      if (open) item.sheet.render(true);
    } catch (e) {
      console.error(`${MOD} | workshop`, e);
      ui.notifications.error(`${t("workshop.createFailed")}: ${e?.message ?? e}`);
    } finally { this.#busy = false; }
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
}
