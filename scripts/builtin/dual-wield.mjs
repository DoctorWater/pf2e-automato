// «По одному в каждой руке»: стопка одноручного оружия (quantity ≥ 2) держится двумя руками как два оружия.
// pf2e знает только handsHeld 1/2, поэтому пишем carryType held + handsHeld 2 и флаг flags.pf2e-automato.dual на предмете.
// Меню «как нести» (pf2e.mjs:22930 #t, tooltip с carry-type.hbs) дополняем в DOM после открытия; значок строки (item-line.hbs:178) подменяем в renderActorSheet.
// Урон: processTwoHandTrait (pf2e.mjs:14259) поднимает кость по handsHeld === 2 — на время prepareStrike (35923) и Weapon#onPrepareSynthetics (52112)
// геттер handsHeld у такого оружия даёт 1 (по оружию в руке). Вне подготовки и без модуля геттер pf2e прежний (свободные руки, 35470, считаются по 2).
import { MOD, L, flagPath, forcedDelete } from "../util.mjs";
import { modeOf } from "../settings.mjs";

const hasTwoHand = (it) => (it?.system?.traits?.value ?? []).some((t) => t.startsWith("two-hand-"));

/** Чистая: пункт «по одному в каждой руке» показываем у стопки одноручного оружия; fatal-aim работает только при хвате двумя руками — не показываем. */
export const showDualItem = (it) => !!it?.isOfType?.("weapon") && (it.system?.quantity ?? 1) >= 2 && (it.system?.usage?.hands ?? 1) === 1
  && !(it.system?.traits?.value ?? []).some((t) => t.startsWith("fatal-aim"));

/** Чистая: флаг стоит и оружие и правда держат двумя руками (устаревший флаг после смены хвата pf2e не считается). */
export const isDual = (it) => !!it?.flags?.[MOD]?.dual && (it.system?.quantity ?? 1) >= 2 && it.system?.equipped?.carryType === "held" && it.system.equipped.handsHeld === 2 && (it.system?.usage?.hands ?? 1) === 1;

/** Чистая: пара для Двойного взмаха/финта — стопка и флаг, либо прежняя эвристика (handsHeld 1; handsHeld 2 — только без two-hand-*). */
export function isPair(it) {
  const eq = it?.system?.equipped;
  if (eq?.carryType !== "held" || (it.system.quantity ?? 1) < 2 || (it.system.usage?.hands ?? 1) !== 1) return false;
  return eq.handsHeld === 1 || (eq.handsHeld === 2 && (isDual(it) || !hasTwoHand(it)));
}

/** Чистая: меняется ли путь в изменениях update (вложенно или точечным ключом). */
const touches = (ch, path) => path in ch || path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), ch) !== undefined;

/** Чистая: патч снятия флага, если хват меняют, а флаг в тех же изменениях не трогают (меню pf2e, Token Action HUD, кнопки хвата Удара). */
export function staleFlagPatch(item, changes, del = forcedDelete) {
  if (!item?.flags?.[MOD]?.dual) return null;
  if (!touches(changes, "system.equipped.carryType") && !touches(changes, "system.equipped.handsHeld")) return null;
  if (touches(changes, flagPath("dual"))) return null;
  return del(flagPath("dual"));
}

/** Чистая: у dual убираем «Взяться двумя руками» (interact, annotation grip, hands 2); «Отпустить» (release, hands 1) остаётся. */
export const withoutTwoHandGrip = (actions) => actions.filter((x) => !(x.annotation === "grip" && x.action === "interact" && x.hands === 2));

// ---------- урон: нейтрализация подъёма кости ----------
const prep = new WeakSet();
function wrapPrep(proto, key) {
  const orig = proto[key];
  if (typeof orig !== "function") return false;
  proto[key] = function (...a) {
    const it = key === "prepareStrike" ? a[0] : this;
    const on = modeOf("macro") !== "off" && isDual(it) && !prep.has(it);
    if (on) prep.add(it);
    try {
      const res = orig.apply(this, a);
      if (on && key === "prepareStrike" && Array.isArray(res?.auxiliaryActions)) res.auxiliaryActions = withoutTwoHandGrip(res.auxiliaryActions);
      return res;
    } finally { if (on) prep.delete(it); }
  };
  return true;
}
function installDamage() {
  const W = CONFIG.PF2E.Item.documentClasses.weapon, C = CONFIG.PF2E.Actor.documentClasses.character;
  let d, p = W?.prototype;
  while (p && !(d = Object.getOwnPropertyDescriptor(p, "handsHeld"))) p = Object.getPrototypeOf(p);
  if (!d?.get) return console.warn(`${MOD} | dual-wield: нет геттера handsHeld`);
  Object.defineProperty(W.prototype, "handsHeld", { configurable: true, get() { const v = d.get.call(this); return prep.has(this) && v === 2 ? 1 : v; } });
  wrapPrep(W.prototype, "onPrepareSynthetics");
  wrapPrep(C.prototype, "prepareStrike");
}

// ---------- меню ----------
let last = null;          // предмет, для которого открыто меню
const dualItem = () => last?.actor?.items.get(last.id);
const off = () => modeOf("macro") === "off";
const warn = (what) => (e) => console.warn(`${MOD} | dual-wield ${what}`, e);

function patchMenu(aside) {
  const ul = aside.querySelector("ul"), item = dualItem();
  if (off() || !ul || !item || ul.dataset.afDual) return;
  ul.dataset.afDual = "1";
  const dual = isDual(item), held2 = ul.querySelector('a[data-carry-type="held"][data-hands-held="2"]');
  if (dual) held2?.classList.remove("selected");
  if (showDualItem(item) && held2) {
    const li = document.createElement("li");
    li.innerHTML = `<a data-af-dual class="${dual ? "selected" : ""}"><i class="fa-solid fa-fw fa-hand-rock"></i>${foundry.utils.escapeHTML(L("builtin.dual.menu"))}</a>`;
    held2.closest("li").after(li);
  }
  ul.addEventListener("click", (e) => {
    const a = e.target.closest?.("a");
    if (a?.dataset.afDual !== undefined) {
      if (!isDual(item)) item.update({ "system.equipped.carryType": "held", "system.equipped.handsHeld": 2, [flagPath("dual")]: true }).catch(warn("menu"));
      game.tooltip.dismissLockedTooltips();
    }
  });
}

// значок строки: одна «рука 2» -> две «руки 1»
function decorate(app, $html) {
  if (off()) return;
  for (const li of $html[0]?.querySelectorAll?.("li[data-item-id]") ?? []) {
    const it = app.actor?.items.get(li.dataset.itemId);
    if (!it || !isDual(it)) continue;
    const stack = li.querySelector("[data-action='open-carry-type-menu'] .fa-stack");
    if (!stack || stack.dataset.afDual) continue;
    stack.dataset.afDual = "1";
    stack.querySelector(".fa-2")?.classList.replace("fa-2", "fa-1");
    const twin = stack.cloneNode(true);
    stack.after(twin);
    for (const s of [stack, twin]) s.dataset.tooltip = L("builtin.dual.icon");
  }
}

export function init() {
  Hooks.once("init", () => { try { installDamage(); } catch (e) { console.error(`${MOD} | dual-wield`, e); } });
  Hooks.on("renderActorSheet", (app, $html) => { try { decorate(app, $html); } catch (e) { console.error(`${MOD} | dual-wield icon`, e); } });
  Hooks.on("preUpdateItem", (item, changes) => {
    const patch = staleFlagPatch(item, changes);
    if (patch) foundry.utils.mergeObject(changes, foundry.utils.expandObject(patch));
  });
  Hooks.on("updateSetting", (s) => {   // режим «макросы» сменили: пересобрать актёров с dual-предметами и перерисовать их листы
    if (s.key !== `${MOD}.mode.macro`) return;
    const toks = (game.scenes ?? []).flatMap((sc) => [...sc.tokens].filter((t) => !t.actorLink).map((t) => t.actor));
    for (const a of [...(game.actors ?? []), ...toks]) {
      if (!a?.items?.some((i) => i.flags?.[MOD]?.dual)) continue;
      try { a.reset(); for (const app of Object.values(a.apps ?? {})) app.render?.(); } catch (e) { warn("reset")(e); }
    }
  });
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-action='open-carry-type-menu']");
    if (!btn) return;
    const id = btn.closest("[data-item-id]")?.dataset.itemId, actor = ui.windows?.[btn.closest("[data-appid]")?.dataset.appid]?.actor;
    last = id && actor ? { id, actor } : null;
  }, true);
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.matches?.("aside.carry-type-menu")) patchMenu(n);
  }).observe(document.body, { childList: true });
}
