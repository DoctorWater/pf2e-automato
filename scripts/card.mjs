// Единая разметка шёпотов модуля: тот же .pf2e-automato / .paf-note / .paf-primary, что у блока в чате (styles/chat.css).
// .paf-card снаружи: renderBlock удаляет только прямого потомка .message-content.
export const card = (text, buttons = "") => `<div class="paf-card"><div class="pf2e-automato"><div class="paf-note">${text}${buttons}</div></div></div>`;
export const cardButton = (attrs, label, cls = "paf-primary") => `<button type="button" class="${cls}" ${attrs}>${label}</button>`;
