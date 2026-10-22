// Единая разметка шёпотов модуля — карточка в языке «Мастерской» (styles/chat.css, .paf-card): пергамент, шапка с названием,
// текст, ряд кнопок. .paf-card снаружи: renderBlock удаляет только прямого потомка .message-content.

/** Шапки шёпотов по тегу: иконка Font Awesome; название — lang `card.<tag>` (подставляет вызывающий). */
export const HEADS = {
  "blade-dance": "fa-khanda", "double-slice": "fa-khanda", "one-shot-one-kill": "fa-crosshairs", "onyx-dog": "fa-dog",
  "reactive-strike": "fa-bolt", "shield-block": "fa-shield-halved", "surprise-attack": "fa-user-ninja", escape: "fa-unlock",
  retch: "fa-face-dizzy", spellshape: "fa-wand-sparkles", invis: "fa-ghost", saves: "fa-dice-d20", vision: "fa-eye"
};

/** head: { title, icon } | null. buttons — готовые cardButton(...) (и поле СЛ, если нужно). */
export function card(text, buttons = "", head = null) {
  const top = head?.title ? `<header class="paf-card-head">${head.icon ? `<i class="fa-solid ${head.icon}" inert></i>` : ""}<span>${head.title}</span></header>` : "";
  const acts = buttons ? `<div class="paf-card-actions">${buttons}</div>` : "";
  return `<div class="paf-card"><div class="pf2e-automato"><section class="paf-sheet">${top}<div class="paf-note">${text}</div>${acts}</section></div></div>`;
}

export const cardButton = (attrs, label, cls = "paf-primary") => `<button type="button" class="${cls}" ${attrs}>${label}</button>`;
