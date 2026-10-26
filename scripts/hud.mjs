// HUD токена: ручной переключатель укрытия (эффект pf2e «Укрытие») и кнопка «Перезарядить» (то же, что WeaponReloader на листе pf2e).
import { L } from "./util.mjs";
import { askHere } from "./builtin/lib.mjs";

export const COVER_UUID = "Compendium.pf2e.other-effects.Item.I9lfZUiCwMiGogVi";
// Те же selection, что pf2e пишет в ChoiceSet при действии «Укрыться» (pf2e.mjs: SingleAction take-cover) — окно выбора не появляется.
export const COVER = { lesser: { bonus: 1, level: "lesser" }, standard: { bonus: 2, level: "standard" }, greater: { bonus: 4, level: "greater" } };

/* ---------- Чистая часть (node-тесты) ---------- */

/** effects: [{id, level}] — висящие эффекты укрытия. -> { remove: id[], add: level|null }; повторный клик по активному уровню снимает его. */
export function coverToggle(effects, level) {
  return { remove: effects.map((e) => e.id), add: effects.some((e) => e.level === level) ? null : level };
}

/** w: { reload, capacity, repeating }. Оружие, которое перезаряжают (как в pf2e: есть магазин и Перезарядка не 0/«-»). */
export const needsReload = (w) => w.capacity > 0 && (!!w.repeating || !["", "0", "-", "null", "undefined"].includes(String(w.reload ?? "").trim()));

/** Оружие, которому нужна перезарядка и в котором нет заряженного боеприпаса: атаки заменяются кнопкой «Перезарядить». */
export const isUnloaded = (w) => needsReload(w) && !(w.loaded > 0);

/** encodedValue кнопки удара TAH pf2e: «strike|<itemId>>slug>...» (хвост — encodeURIComponent). -> itemId | null. */
export function strikeItemId(value) {
  const [type, rest] = String(value ?? "").split("|");
  return type === "strike" && rest ? decodeURIComponent(rest).split(">")[0] || null : null;
}

/** Использование из того же значения (4-й сегмент: melee | ranged | thrown | ""). Ближний вариант комбинированного оружия — клон с тем же id
 *  (pf2e toMeleeUsage, keepId) и без перезарядки: его кнопки не трогаем. */
export function strikeUsage(value) {
  const [type, rest] = String(value ?? "").split("|");
  return type === "strike" && rest ? decodeURIComponent(rest).split(">")[3] ?? "" : "";
}

/** Число действий для значка/сообщения: repeating — 3, иначе целая Перезарядка > 0. */
export const reloadGlyph = (w) => { const n = w.repeating ? 3 : Number(w.reload); return n > 0 && Number.isInteger(n) ? String(n) : ""; };

/* ---------- Foundry ---------- */

const coverEffects = (actor) => actor.itemTypes.effect
  .filter((e) => e.sourceId === COVER_UUID || e._stats?.compendiumSource === COVER_UUID)
  .map((e) => ({ id: e.id, level: e.system.rules.find((r) => r.key === "ChoiceSet")?.selection?.level ?? null }));

async function setCover(actor, level) {
  const { remove, add } = coverToggle(coverEffects(actor), level);
  if (remove.length) await actor.deleteEmbeddedDocuments("Item", remove);
  if (!add) return;
  const src = await fromUuid(COVER_UUID);
  if (src?.type !== "effect") return ui.notifications.warn(L("hud.noCover"));
  const data = { ...src.toObject(), _id: null };
  data._stats = { ...data._stats, compendiumSource: COVER_UUID };
  const cs = data.system.rules.find((r) => r.key === "ChoiceSet");
  if (cs) cs.selection = { ...COVER[add] };
  await actor.createEmbeddedDocuments("Item", [data]);
}

const ammoFor = (actor, w) => [...actor.itemTypes.ammo, ...actor.itemTypes.weapon.filter((i) => i.system.usage?.canBeAmmo)]
  .filter((a) => !a.isStowed && a.isAmmoFor?.(w) && a.quantity > 0 && !emptyMag(a));

const emptyMag = (a) => a.isOfType("ammo") && a.isMagazine && a.system.uses.value === 0;   // pf2e пустой магазин зарядом не считает
const loadedOf = (w) => (w.subitems?.contents ?? []).filter((s) => (s.isOfType("ammo") || (s.isOfType("weapon") && s.isAmmoFor?.(w))) && !emptyMag(s));

const weaponData = (w) => ({
  id: w.id, name: w.name, reload: w.system.reload?.value, capacity: w.system.ammo?.capacity ?? 0,
  repeating: w.system.traits.value.includes("repeating"),
  loaded: loadedOf(w).reduce((n, s) => n + s.quantity, 0)
});

/** Как WeaponReloader.reloadWeapon pf2e: attach 1 шт. боеприпаса; сообщение «Взаимодействие: Перезарядка» — только в бою (как в pf2e). */
async function reload(actor, w, ammo) {
  const now = weaponData(w);   // как WeaponReloader pf2e: полный магазин не дозаряжаем (двойной клик до перерисовки HUD)
  if (now.loaded >= now.capacity) return;
  if (!(await w.attach(ammo, { quantity: 1, stack: true }))) return;
  if (!game.combat) return;
  const d = weaponData(w), glyph = reloadGlyph(d), T = foundry.applications.handlebars.renderTemplate;
  const trait = { name: "manipulate", label: CONFIG.PF2E.actionTraits.manipulate, description: CONFIG.PF2E.traitsDescriptions?.manipulate ?? null };
  const flavor = await T("./systems/pf2e/templates/chat/action/flavor.hbs", {
    action: { title: "PF2E.Actions.Interact.Title", subtitle: "PF2E.Actions.Interact.Reload.Title", glyph }, traits: [trait]
  });
  const content = await T("./systems/pf2e/templates/chat/action/content.hbs", {
    imgPath: w.img, message: game.i18n.format("PF2E.Actions.Interact.Reload.Description", { actor: actor.name, weapon: w.name, ammo: ammo.name })
  });
  await ChatMessage.create({
    content, flavor, style: CONST.CHAT_MESSAGE_STYLES.EMOTE,
    speaker: ChatMessage.getSpeaker({ actor, token: actor.getActiveTokens(false, true)[0] })
  });
}


/* ---------- Token Action HUD ---------- */

const DELIM = "|";   // DELIMITER core TAH
const esc = (t) => foundry.utils.escapeHTML(String(t));
const tip = (t) => `<div class="tah-tooltip-wrapper">${esc(t)}</div>`;
const tah = () => game.tokenActionHud?.hudManager;

/** Укрытия — обычные действия категории «Эффекты» (группа effects pf2e-TAH); активный уровень подсвечен как активное состояние. */
const COVER_ICONS = { lesser: "fa-circle-half-stroke", standard: "fa-shield-halved", greater: "fa-shield" };
const coverActionHandler = {
  extendActionHandler() {
    const ah = this.actionHandler, actor = ah.actor;
    if (!actor?.isOwner || !actor.itemTypes) return;
    const on = new Set(coverEffects(actor).map((e) => e.level));
    ah.addActions(Object.keys(COVER).map((level) => ({
      id: `pafCover-${level}`, name: L(`hud.cover.${level}`), listName: L(`hud.cover.${level}`),
      encodedValue: ["pafCover", level].join(DELIM), cssClass: `toggle${on.has(level) ? " active" : ""}`,
      icon1: `<i class="fa-solid ${COVER_ICONS[level]}"></i>`
    })), { id: "effects", type: "system" });
  }
};
const coverRollHandler = {
  prehandleActionEvent: () => false,
  handleActionClick(event, value, actionHandler) {
    const [type, level] = String(value ?? "").split(DELIM);
    if (type !== "pafCover") return false;
    const actor = actionHandler?.actor;
    if (actor && COVER[level]) setCover(actor, level).finally(() => Hooks.callAll("forceUpdateTokenActionHud"));
    return true;
  }
};

async function pickAndReload(actor, w, ammos) {
  let ammo = ammos[0];
  if (ammos.length > 1) {
    const res = await askHere(`${L("hud.reload")}: ${w.name}`, `<p>${esc(L("hud.pickAmmo").replace(/^./, (c) => c.toUpperCase()))}</p>`,
      ammos.map((a) => ({ id: a.id, label: `${a.name} (${a.quantity})` })));   // окно модуля (.paf-dialog)
    ammo = ammos.find((a) => a.id === res?.action);
  }
  if (ammo) await reload(actor, w, ammo);
}

function reloadButton(actor, w, ammos) {
  const text = L("hud.reload"), off = !ammos.length;
  const wrap = document.createElement("div");
  wrap.className = "tah-action"; wrap.dataset.part = "action"; wrap.dataset.pafReload = w.id;
  const tipText = off ? `${text}: ${L("hud.noAmmo")}` : ammos.length > 1 ? `${text}: ${L("hud.pickAmmo")}` : `${text}: ${ammos[0].name} (${ammos[0].quantity})`;
  wrap.innerHTML = `<button type="button" class="tah-action-button tah-button-box${off ? " disabled" : ""}" data-part="actionButton"${off ? ` aria-disabled="true"` : ""}
    data-tooltip="${esc(tip(tipText))}" data-tooltip-class="tah-tooltip"><span class="tah-button-content"><div class="tah-icon"><i class="fa-solid fa-rotate"></i></div><div class="tah-button-text">${esc(text)}</div></span></button>`;
  if (!off) wrap.firstElementChild.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    try { await pickAndReload(actor, w, ammos); } finally { Hooks.callAll("forceUpdateTokenActionHud"); }
  });
  return wrap;
}

/** После каждой отрисовки TAH: у незаряженного оружия кнопки Strike/MAP/Урон/Критический (значение strike|id>...) прячем, на их месте — «Перезарядить». Строка доп. действий не трогается. */
function onRender(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0] ?? app.element;
  const actor = tah()?.actor;
  if (!root || !actor?.isOwner || !actor.itemTypes) return;
  const rows = new Map();   // контейнер .tah-actions -> Map(itemId -> кнопки)
  for (const b of root.querySelectorAll(".tah-action-button[value^='strike|']")) {
    const id = strikeItemId(b.value), box = b.closest(".tah-actions");
    if (!id || !box || b.closest("[data-paf-reload]") || strikeUsage(b.value) === "melee") continue;
    if (!rows.has(box)) rows.set(box, new Map());
    rows.get(box).set(id, [...(rows.get(box).get(id) ?? []), b.closest(".tah-action")]);
  }
  for (const [box, byItem] of rows) for (const [id, wraps] of byItem) {
    const w = actor.items.get(id);
    if (!w?.isOfType("weapon") || !isUnloaded(weaponData(w))) continue;
    const btn = reloadButton(actor, w, ammoFor(actor, w));
    wraps[0].before(btn);
    for (const x of wraps) x.style.display = "none";
  }
}

export function init() {
  Hooks.on("tokenActionHudCoreAddActionHandlerExtenders", (ah) => ah.addActionHandlerExtender({ ...coverActionHandler }));
  Hooks.on("tokenActionHudCoreAddRollHandlerExtenders", (rh) => rh.addRollHandlerExtender({ ...coverRollHandler }));
  Hooks.on("renderTokenActionHud", onRender);
}
