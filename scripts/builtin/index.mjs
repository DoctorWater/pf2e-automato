// Реестр встроенных обработчиков (ссылка в правиле: {phase, builtin:"<id>"}) и хуки обработчиков без правила.
// run(scope) — тот же scope, что у макросов (macros.mjs buildScope). timeoutMs — вместо общих 30 с, если обработчик ждёт диалога.
// player — бросать у автора сообщения, если это игрок онлайн и владелец актёра (macros.mjs); finish(result, scope) — затем у ГМа.
import { MOD } from "../util.mjs";
import { modeOf } from "../settings.mjs";
import * as bloodMagic from "./blood-magic.mjs";
import * as twinFeint from "./twin-feint.mjs";
import * as dirtyTrick from "./dirty-trick.mjs";
import * as reactiveStrike from "./reactive-strike.mjs";
import * as onyxDog from "./onyx-dog.mjs";
import * as doubleSlice from "./double-slice.mjs";
import * as fakeOut from "./fake-out.mjs";
import * as intimidatingStrike from "./intimidating-strike.mjs";
import * as bladeDance from "./blade-dance.mjs";

const DIALOG_MS = 180000;

export const BUILTIN = {
  "twin-feint": { run: twinFeint.run, player: true, timeoutMs: DIALOG_MS },
  "dirty-trick": { run: dirtyTrick.run },
  "double-slice": { run: doubleSlice.run, player: true, timeoutMs: DIALOG_MS },
  "blade-dance": { run: bladeDance.run, timeoutMs: DIALOG_MS },
  "fake-out": { run: fakeOut.run, finish: fakeOut.finish, player: true, timeoutMs: DIALOG_MS },
  "intimidating-strike": { run: intimidatingStrike.run, finish: intimidatingStrike.finish, player: true, timeoutMs: DIALOG_MS },
  // тот же обработчик, что и в хуке, но по правилу на заклинании (scope.message — карточка каста)
  "blood-magic-aberrant": { run: (scope) => scope.message && bloodMagic.onMessage(scope.message), timeoutMs: DIALOG_MS }
};

// Обработчики по сообщениям чата без правила: кровь — тег заклинания, статуэтка — карточка предмета (kind "card" конвейер не исполняет).
const MESSAGE_HOOKS = [["blood-magic", bloodMagic.onMessage], ["reactive-strike", reactiveStrike.onMessage], ["onyx-dog", onyxDog.onMessage]];

export function initBuiltinHooks() {
  if (!globalThis.Hooks) return;   // node-тесты
  Hooks.on("createChatMessage", async (message) => {
    if (!game.user?.isActiveGM || modeOf("macro") === "off") return;
    for (const [id, fn] of MESSAGE_HOOKS) {
      try { await fn(message); } catch (e) { console.error(`${MOD} | builtin ${id}`, e); }
    }
  });
  Hooks.on("updateWorldTime", (t) => { if (game.user?.isActiveGM) onyxDog.expire(t).catch((e) => console.error(`${MOD} | onyx expire`, e)); });
  Hooks.on("renderChatMessageHTML", onyxDog.bindDismiss);
  Hooks.on("renderChatMessageHTML", reactiveStrike.bindStrike);
  Hooks.on("moveToken", (doc, movement) => {
    if (!game.user?.isActiveGM || modeOf("macro") === "off") return;
    reactiveStrike.onMove(doc, movement).catch((e) => console.error(`${MOD} | builtin reactive-strike move`, e));
  });
}

export { onyxDog, bloodMagic };
