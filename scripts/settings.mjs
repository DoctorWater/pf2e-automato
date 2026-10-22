import { MOD } from "./util.mjs";

const MODES = {
  "mode.zone": "auto", "mode.effect": "auto", "mode.challenge": "auto",
  "mode.apply": "button", "mode.reaction": "auto", "mode.macro": "auto", "mode.shieldBlock": "auto", "mode.damageGate": "auto", "mode.frightened": "auto", "mode.sickened": "auto"
};
const TWO_STATE = new Set(["mode.reaction", "mode.macro", "mode.damageGate", "mode.shieldBlock", "mode.frightened", "mode.sickened"]);   // auto | off

export const S = {
  get: (key) => game.settings.get(MOD, key),
  set: (key, val) => game.settings.set(MOD, key, val)
};

// Счётчик версии каталогов: кэши производных данных (значки) сверяются с ним.
export const rev = { n: 0 };

export function modeOf(kind /* zone|effect|challenge|apply|reaction|macro */) {
  return S.get(`mode.${kind}`);
}

export function init() {
  const name = (k) => `PF2E_AUTOMATO.settings.${k}.name`;
  const hint = (k) => `PF2E_AUTOMATO.settings.${k}.hint`;
  const reg = (key, data) => game.settings.register(MOD, key, { name: name(key), hint: hint(key), config: true, scope: "world", ...data });

  for (const [key, def] of Object.entries(MODES)) {
    const choices = { auto: "PF2E_AUTOMATO.mode.auto", button: "PF2E_AUTOMATO.mode.button", off: "PF2E_AUTOMATO.mode.off" };
    if (TWO_STATE.has(key)) delete choices.button;
    reg(key, { type: String, default: def, choices });
  }
  reg("yieldToAutomations", { type: Boolean, default: true });
  reg("useToolbeltTargetHelper", { type: Boolean, default: true });
  reg("challenge.messageMode", {
    type: String, default: "gm",
    choices: { public: "PF2E_AUTOMATO.messageMode.public", gm: "PF2E_AUTOMATO.messageMode.gm" }
  });
  reg("reaction.showWindow", { type: Boolean, default: true, scope: "client" });
  reg("reaction.onlyWhenChanges", { type: Boolean, default: true });
  reg("vision.marks", { type: Boolean, default: true, onChange: (on) => Hooks.callAll("pf2e-automato.visionMarks", on) });
  reg("resumeMinutes", { type: Number, default: 30, range: { min: 1, max: 1440, step: 1 } });
  game.settings.register(MOD, "catalog", { scope: "world", config: false, type: Object, default: { bySource: {}, bySlug: {} }, onChange: () => { rev.n++; } });
  game.settings.register(MOD, "debug", { name: name("debug"), hint: hint("debug"), scope: "client", config: true, type: Boolean, default: false });
}
