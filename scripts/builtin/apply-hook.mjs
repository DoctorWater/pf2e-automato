// Единственная обёртка Actor#applyDamage на модуль (libWrapper не даёт регистрировать одну цель дважды).
// Подписчик: async (actor, opts, ctx) => ({ opts?, actor?, after?(res) }) | undefined. «До» — может заменить opts и актёра (свежий клон после реакции); after — после применения урона.
// first — подписчик идёт первым (удержание урона до решения о реакции, builtin/damaged.mjs): остальные видят уже изменённый opts.
import { MOD } from "../util.mjs";

const APPLY = "CONFIG.Actor.documentClass.prototype.applyDamage";
const subs = [];
let installed = false;

export function subscribe(fn, { first = false } = {}) {
  if (subs.includes(fn)) return;
  if (first) subs.unshift(fn); else subs.push(fn);
}

let clickSource = () => null;
/** Откуда пришёл клик по кнопке урона pf2e: fn() -> {id} | null. Снимок берётся в начале нанесения, до ожиданий подписчиков (удержание длиннее жизни метки клика). */
export const setClickSource = (fn) => { clickSource = fn; };

async function wrap(orig, opts, ...rest) {
  const afters = [];
  let self = this;
  const ctx = { click: clickSource() };   // подписчикам третьим аргументом
  for (const s of [...subs]) {
    const r = await s(self, opts, ctx);
    if (r?.opts) opts = r.opts;
    if (r?.actor) self = r.actor;
    if (r?.after) afters.push(r.after);
  }
  const res = await orig.call(self, opts, ...rest);
  for (const a of afters) await a(res, opts);
  return res;
}

/** Идемпотентно: можно звать из любого подписчика. */
export function install() {
  if (installed) return;
  if (globalThis.game?.modules?.get("lib-wrapper")?.active && globalThis.libWrapper) {
    libWrapper.register(MOD, APPLY, wrap, "WRAPPER");
    installed = true;
    return;
  }
  const proto = CONFIG.Actor.documentClass?.prototype;
  if (!proto?.applyDamage || proto.applyDamage.__afApply) { installed = !!proto?.applyDamage; return; }
  const orig = proto.applyDamage;
  proto.applyDamage = function (...a) { return wrap.call(this, orig, ...a); };
  proto.applyDamage.__afApply = true;
  installed = true;
}
