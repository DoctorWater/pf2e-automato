// Единственная обёртка Actor#applyDamage на модуль (libWrapper не даёт регистрировать одну цель дважды).
// Подписчик: async (actor, opts) => ({ opts?, after?(res) }) | undefined. «До» — может заменить opts; after — после применения урона.
import { MOD } from "../util.mjs";

const APPLY = "CONFIG.Actor.documentClass.prototype.applyDamage";
const subs = new Set();
let installed = false;

export function subscribe(fn) { subs.add(fn); }

async function wrap(orig, opts, ...rest) {
  const afters = [];
  for (const s of subs) {
    const r = await s(this, opts);
    if (r?.opts) opts = r.opts;
    if (r?.after) afters.push(r.after);
  }
  const res = await orig.call(this, opts, ...rest);
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
