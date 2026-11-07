import { MOD } from "./util.mjs";
import { summonPacks } from "./summon-index.mjs";

const MODES = {
  "mode.zone": "auto", "mode.effect": "auto", "mode.challenge": "auto",
  "mode.apply": "button", "mode.reaction": "auto", "mode.macro": "auto", "mode.limits": "auto", "mode.shieldBlock": "auto", "mode.damageGate": "auto", "mode.frightened": "auto", "mode.sickened": "auto"
};
const TWO_STATE = new Set(["mode.reaction", "mode.macro", "mode.limits", "mode.damageGate", "mode.shieldBlock", "mode.frightened", "mode.sickened"]);   // auto | off

export const S = {
  get: (key) => game.settings.get(MOD, key),
  set: (key, val) => game.settings.set(MOD, key, val)
};

// Счётчик версии каталогов: кэши производных данных (значки) сверяются с ним.
export const rev = { n: 0 };

export function modeOf(kind /* zone|effect|challenge|apply|reaction|macro */) {
  return S.get(`mode.${kind}`);
}

/** Режим вида с учётом уверенности: low при auto — только кнопкой. get — подмена источника режима (чистые вызывающие). */
export const effectiveMode = (kind, use, get = modeOf) => {
  const m = get(kind);
  return m === "auto" && use?.confidence === "low" ? "button" : m;
};

/** Меню выбора компендиумов-источников: флажки по всем Actor-компендиумам мира. Класс строится при init (ApplicationV2 есть только в Foundry). */
function summonPacksMenu() {
  const L = (k) => game.i18n.localize(k);
  const esc = (s) => foundry.utils.escapeHTML(String(s));
  return class SummonPacksMenu extends foundry.applications.api.ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: `${MOD}-summon-packs`, tag: "form", position: { width: 460 }, window: { title: "PF2E_AUTOMATO.settings.summon.packs.title", contentClasses: ["standard-form"] },
      form: { closeOnSubmit: true, handler: async (_ev, _form, data) => { const v = data.object.pack ?? []; await S.set("summon.packs", Array.isArray(v) ? v : [v]); } },
      actions: { reset: async function () { await S.set("summon.packs", []); this.close(); } }
    };
    async _renderHTML() {
      const cur = new Set(summonPacks());   // пусто в настройке — отмечены бестиарии по умолчанию
      const rows = game.packs.filter((p) => p.documentName === "Actor").sort((a, b) => a.title.localeCompare(b.title))
        .map((p) => `<label class="checkbox"><input type="checkbox" name="pack" value="${esc(p.collection)}"${cur.has(p.collection) ? " checked" : ""}> ${esc(p.title)} <small>${esc(p.metadata.packageName)}</small></label>`);
      return `<div class="form-group stacked" style="max-height:60vh;overflow:auto">${rows.join("") || esc(L("PF2E_AUTOMATO.settings.summon.packs.empty"))}</div>
        <footer class="form-footer"><button type="button" data-action="reset">${esc(L("PF2E_AUTOMATO.settings.summon.packs.default"))}</button><button type="submit">${esc(L("PF2E_AUTOMATO.settings.summon.packs.save"))}</button></footer>`;
    }
    _replaceHTML(html, content) { content.innerHTML = html; }
  };
}

export function init() {
  const name = (k) => `PF2E_AUTOMATO.settings.${k}.name`;
  const hint = (k) => `PF2E_AUTOMATO.settings.${k}.hint`;
  const reg = (key, data) => game.settings.register(MOD, key, { name: name(key), hint: hint(key), config: true, scope: "world", ...data });

  for (const [key, def] of Object.entries(MODES)) {
    const choices = { auto: "PF2E_AUTOMATO.mode.auto", button: "PF2E_AUTOMATO.mode.button", off: "PF2E_AUTOMATO.mode.off" };
    if (TWO_STATE.has(key)) delete choices.button;
    reg(key, { type: String, default: def, choices, ...(key === "mode.macro" && { onChange: (v) => Hooks.callAll("pf2e-automato.macroMode", v) }) });
  }
  reg("sustain.parse", { type: Boolean, default: true });   // Sustain из чата pf2e засчитывается якорю автора
  reg("yieldToAutomations", { type: Boolean, default: true });
  reg("useToolbeltTargetHelper", { type: Boolean, default: true });
  reg("challenge.messageMode", {
    type: String, default: "gm",
    choices: { public: "PF2E_AUTOMATO.messageMode.public", gm: "PF2E_AUTOMATO.messageMode.gm" }
  });
  reg("affliction.noteMode", {
    type: String, default: "public",
    choices: { public: "PF2E_AUTOMATO.messageMode.public", gm: "PF2E_AUTOMATO.messageMode.gm" }
  });
  reg("reaction.showWindow", { type: Boolean, default: true, scope: "client" });
  reg("vision.marks", { type: Boolean, default: true, onChange: (on) => Hooks.callAll("pf2e-automato.visionMarks", on) });
  reg("resumeMinutes", { type: Number, default: 30, range: { min: 1, max: 1440, step: 1 } });
  game.settings.register(MOD, "summon.packs", { name: name("summon.packs"), hint: hint("summon.packs"), scope: "world", config: false, type: Array, default: [] });   // [] = бестиарии pf2e (summon-index.mjs)
  game.settings.registerMenu(MOD, "summon.packs", { name: name("summon.packs"), label: `PF2E_AUTOMATO.settings.summon.packs.menu`, hint: hint("summon.packs"), icon: "fa-solid fa-book-skull", type: summonPacksMenu(), restricted: true });
  game.settings.register(MOD, "catalog", { scope: "world", config: false, type: Object, default: { bySource: {}, bySlug: {} }, onChange: () => { rev.n++; } });
  game.settings.register(MOD, "debug", { name: name("debug"), hint: hint("debug"), scope: "client", config: true, type: Boolean, default: false });
}
