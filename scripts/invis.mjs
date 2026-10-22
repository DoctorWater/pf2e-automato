// Невидимость, наложенная заклинанием «Невидимость» 2–3 ранга, кончается после враждебного действия носителя (Player Core).
// Ранг и источник берём из meta, которое ставит applyOps (meta.origin, meta.rank). При длительности meta лежит на эффекте-обёртке,
// а состояние выдано через GrantItem (grantee: restrict) — снимать надо обёртку. Без meta ранг неизвестен — решает ГМ карточкой.
import { MOD, L, isActiveGM, queue } from "./util.mjs";
import { modeOf } from "./settings.mjs";

/** Чистая: "ends" — заклинание Невидимость ранга < 4; "never" — ранг >= 4 (не кончается); "unknown" — иначе (ранг неизвестен). */
export function invisVerdict(meta, originSlug) {
  if (originSlug !== "invisibility" || !Number.isFinite(meta?.rank)) return "unknown";
  return meta.rank < 4 ? "ends" : "never";
}
export const endsOnHostile = (meta, originSlug) => invisVerdict(meta, originSlug) === "ends";

/** Чистая: сообщение — бросок атаки (spell-attack-roll в pf2e — домен, тип контекста у атак заклинаний тоже attack-roll). Урон — на усмотрение ГМа. */
export const isHostileMessage = (m) => m?.flags?.pf2e?.context?.type === "attack-roll";

const originSlug = (meta) => { try { return fromUuidSync(meta?.origin)?.slug ?? null; } catch { return null; } };
const gmIds = () => ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
const holder = (item) => item.grantedBy ?? item;   // что снимать: обёртка, иначе само состояние

async function onMessage(m) {
  const mode = modeOf("effect");
  if (!isActiveGM() || mode === "off" || !isHostileMessage(m) || !m.actor) return;
  const actor = m.actor;
  for (const item of actor.itemTypes.condition.filter((c) => c.slug === "invisible")) {
    const target = holder(item), meta = target.flags?.[MOD]?.meta ?? item.flags?.[MOD]?.meta;
    const verdict = invisVerdict(meta, originSlug(meta));
    if (verdict === "never") continue;
    const name = foundry.utils.escapeHTML(actor.name);
    if (mode === "auto" && verdict === "ends") {
      await queue(`actor:${actor.uuid}`, () => target.delete());
      await ChatMessage.create({ whisper: gmIds(), speaker: { alias: "pf2e-automato" }, content: `<p>${L("invis.ended", { name })}</p>` });
    } else {
      await ChatMessage.create({
        whisper: gmIds(), speaker: { alias: "pf2e-automato" }, flags: { [MOD]: { invis: target.uuid } },
        content: `<p>${L(verdict === "ends" ? "invis.ask" : "invis.askUnknown", { name })}</p><button type="button" data-automato-invis="${target.uuid}">${L("invis.remove")}</button>`
      });
    }
  }
}

export function init() {
  Hooks.on("createChatMessage", onMessage);
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const btn = html.querySelector("[data-automato-invis]");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const item = await fromUuid(btn.dataset.automatoInvis);
      if (item?.actor) await queue(`actor:${item.actor.uuid}`, () => item.delete());
    });
  });
}
