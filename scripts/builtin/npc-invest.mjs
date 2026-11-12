// Кнопка «Вложено» на листе NPC. pf2e рисует её только у персонажа (item-line.hbs: isInvestable задаёт лишь CharacterSheetPF2e, pf2e.mjs:24970),
// а без вложения гасит все правила предмета с признаком «Вложение» (конструктор RuleElement: requiresInvestment && !isInvested).
// Само вложение ничего не угадывает: решает ведущий, данные — штатное system.equipped.invested, без модуля pf2e их читает так же.
// Предметы из статблока бестиария остаются невложенными, пока ведущий их не вложит: их бонусы уже в цифрах существа.
import { MOD } from "../util.mjs";

/** Чистая: показывать кнопку — как isInvestable персонажа (не убран, опознан, есть признак) + предмет можно экипировать. */
export const canInvest = (item) => item?.isInvested != null && !item.isStowed && !!item.isIdentified;

/** Как CharacterPF2e#toggleInvested (pf2e.mjs:36255): вкладывая неэкипированное, сначала надеть. */
async function toggle(actor, item) {
  const on = !item.isInvested;
  if (on && !item.isEquipped) {
    const usage = item.system.usage;
    await actor.changeCarryType(item, { carryType: usage.type === "carried" ? "worn" : usage.type, handsHeld: usage.hands ?? 0, inSlot: true });
  }
  await item.update({ "system.equipped.invested": on });
}

function decorate(app, $html) {
  const actor = app.actor;
  if (actor?.type !== "npc" || !app.isEditable) return;
  for (const li of $html[0]?.querySelectorAll?.("li[data-item-id]") ?? []) {
    const item = actor.items.get(li.dataset.itemId);
    const controls = li.querySelector(":scope > .data .item-controls, .item-controls");
    if (!canInvest(item) || !controls || controls.querySelector("[data-af-invest]")) continue;
    const a = document.createElement("a");
    a.className = `invested${item.isInvested ? " active" : ""}`;
    a.dataset.afInvest = "1";
    a.dataset.tooltip = "PF2E.ui.equipmentInvested";
    a.innerHTML = `<i class="fa-solid fa-gem fa-fw"></i>`;
    a.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggle(actor, item).catch((err) => console.error(`${MOD} | npc-invest`, err)); });
    controls.prepend(a);
  }
}

export function init() {
  Hooks.on("renderActorSheet", (app, $html) => { try { decorate(app, $html); } catch (e) { console.error(`${MOD} | npc-invest`, e); } });
}
