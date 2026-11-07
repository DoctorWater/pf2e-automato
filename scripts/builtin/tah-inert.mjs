// Token Action HUD (pf2e): кнопка действия, чья карточка ничего не делает, — неактивна (не нажимается, не выглядит доступной).
// «Стихийный взрыв» как действие — только описание в чат; атаки и урон — его же группа ударов TAH (pf2e ElementalBlast, id «<item>>стихия>…»).
import { L } from "../util.mjs";

const INERT = new Set(["elemental-blast"]);   // действия, использование которых идёт через удар pf2e, а не через карточку

/** Чистая: предмет-действие с «пустой» карточкой. */
export const isInert = (item) => item?.type === "action" && INERT.has(item.slug);

const actorOf = (hud) => hud?.actor ?? globalThis.canvas?.tokens?.controlled?.[0]?.actor ?? null;

export function init() {
  if (!game.modules.get("token-action-hud-core")?.active) return;
  // клик по кнопке действия (encodedValue «action|<id>»; удары взрыва — «elementalBlast|…», их не трогаем)
  Hooks.on("tokenActionHudCoreActionClick", (event, action, hud) => {
    const [kind, id] = String(action?.encodedValue ?? "").split("|");
    if (kind === "action" && isInert(actorOf(hud)?.items?.get(id))) return false;
  });
  Hooks.on("renderApplicationV2", (app, el) => {
    if (app !== game.tokenActionHud && el?.id !== "token-action-hud") return;   // id приложения TAH — «hud», элемент — #token-action-hud
    const actor = actorOf(app);
    for (const b of el.querySelectorAll("button[data-action-id]")) {
      if (!isInert(actor?.items?.get(b.dataset.actionId))) continue;   // точное совпадение id: удары взрыва — «<id>%3E…»
      b.disabled = true;
      b.classList.add("disabled");
      b.style.opacity = ".45";
      b.style.cursor = "not-allowed";
      b.dataset.tooltip = L("builtin.inertAction");
    }
  });
}
