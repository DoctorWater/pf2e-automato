// HUD токена: ручной переключатель укрытия (эффект pf2e «Укрытие») и кнопка «Перезарядить» (то же, что WeaponReloader на листе pf2e).
import { L } from "./util.mjs";

export const COVER_UUID = "Compendium.pf2e.other-effects.Item.I9lfZUiCwMiGogVi";
// Те же selection, что pf2e пишет в ChoiceSet при действии «Укрыться» (pf2e.mjs: SingleAction take-cover) — окно выбора не появляется.
export const COVER = { standard: { bonus: 2, level: "standard" }, greater: { bonus: 4, level: "greater" } };

/* ---------- Чистая часть (node-тесты) ---------- */

/** effects: [{id, level}] — висящие эффекты укрытия. -> { remove: id[], add: level|null }; повторный клик по активному уровню снимает его. */
export function coverToggle(effects, level) {
  return { remove: effects.map((e) => e.id), add: effects.some((e) => e.level === level) ? null : level };
}

/** w: { reload, capacity, repeating }. Оружие, которое перезаряжают (как в pf2e: есть магазин и Перезарядка не 0/«-»). */
export const needsReload = (w) => w.capacity > 0 && (!!w.repeating || !["", "0", "-", "null", "undefined"].includes(String(w.reload ?? "").trim()));

/** Оружие из HUD-списка: только перезаряжаемые; full — магазин полон. */
export const reloadList = (ws) => ws.filter(needsReload).map((w) => ({ ...w, full: w.loaded >= w.capacity }));

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

const el = (tag, cls, attrs = {}) => Object.assign(document.createElement(tag), { className: cls }, attrs);

function coverButton(hud, actor, level, active, icon) {
  const b = el("button", `control-icon paf-cover${active ? " active" : ""}`, { type: "button" });
  b.dataset.tooltipText = L(`hud.cover.${level}`);
  b.setAttribute("aria-label", L(`hud.cover.${level}`));
  b.innerHTML = `<i class="fa-solid ${icon}" inert></i>`;
  b.addEventListener("click", async () => {
    b.disabled = true;
    try { await setCover(actor, level); } finally { hud.render(); }
  });
  return b;
}

function onRender(hud, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const actor = hud.document?.actor ?? hud.object?.actor;
  if (!root || !actor?.isOwner || !actor.itemTypes) return;
  const col = root.querySelector(".col.right");
  if (!col) return;
  const anchor = col.querySelector(".palette.status-effects") ?? col.firstElementChild;

  const lv = new Set(coverEffects(actor).map((e) => e.level));
  const nodes = [coverButton(hud, actor, "standard", lv.has("standard"), "fa-shield-halved"), coverButton(hud, actor, "greater", lv.has("greater"), "fa-shield")];

  const list = reloadList(actor.itemTypes.weapon.map(weaponData));
  if (list.length) {
    const btn = el("button", "control-icon paf-reload", { type: "button" });
    btn.dataset.action = "togglePalette"; btn.dataset.palette = "pafReload";
    btn.dataset.tooltipText = L("hud.reload"); btn.setAttribute("aria-label", L("hud.reload"));
    btn.innerHTML = `<i class="fa-solid fa-rotate" inert></i>`;
    const pal = el("div", "palette palette-list", {});
    pal.dataset.palette = "pafReload";
    for (const d of list) {
      const w = actor.items.get(d.id);
      const ammos = d.full ? [] : ammoFor(actor, w), state = L("hud.loaded", { n: d.loaded, max: d.capacity });
      for (const ammo of ammos) {
        const a = el("a", "palette-list-entry", { innerHTML: "<span></span>" });
        a.firstChild.textContent = `${d.name}: ${ammo.name} (${ammo.quantity}) — ${state}`;
        a.addEventListener("click", async () => { hud.togglePalette(null); try { await reload(actor, w, ammo); } finally { hud.render(); } });
        pal.append(a);
      }
      if (!ammos.length) {
        const a = el("a", "palette-list-entry paf-disabled", { innerHTML: "<span></span>" });
        a.firstChild.textContent = `${d.name} — ${state}${d.full ? "" : ` (${L("hud.noAmmo")})`}`;
        pal.append(a);
      }
    }
    nodes.push(btn, pal);
  }
  anchor.after(...nodes);
}

export function init() {
  Hooks.on("renderTokenHUD", onRender);
}
