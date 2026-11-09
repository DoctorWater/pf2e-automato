async () => {
  // Живая проверка оформления кнопок модуля в чате (DESIGN.md «Кнопки модуля в чате»): шаг залит и от 36px, вариант — контур, скрытое скрыто.
  // Сцена — tests/live/demo-stage.js. Созданные заклинания, сообщения и регионы убираются.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sc = () => game.scenes.viewed, tok = (n) => sc().tokens.find((t) => t.name === n);
  const made = [], msgs = new Set(), hM = Hooks.on("createChatMessage", (m) => msgs.add(m.id));
  const FILL = "rgb(94, 0, 0)", out = {}, bad = [];
  const el = (id) => document.querySelector(`#chat [data-message-id="${id}"]`);
  const look = (b) => { const cs = getComputedStyle(b); return { t: b.textContent.trim().slice(0, 24), fill: cs.backgroundColor === FILL, h: Math.round(b.getBoundingClientRect().height), shown: cs.display !== "none" && !!b.offsetParent }; };
  const btns = (id, sel = "button") => [...(el(id)?.querySelectorAll(sel) ?? [])].filter((b) => !b.closest(".message-header, .message-metadata") && !/delete|toggle|applyDamage|shieldBlock/.test(b.dataset.action ?? "")).map(look).filter((x) => x.shown);
  const expect = (name, cond, info) => { if (!cond) bad.push(`${name}: ${JSON.stringify(info)}`); };
  const ez = tok("Эзрен").actor, entryId = ez.itemTypes.spell.find((s) => s.name === "Ужас")?.system.location.value;
  const pack = game.packs.get("pf2e.spells-srd"), idx = await pack.getIndex();
  const spell = async (orig) => { const e = idx.find((x) => x.originalName === orig); let sp = ez.items.find((i) => i.name === e.name); if (!sp) { const s = (await pack.getDocument(e._id)).toObject(); s.system.location = { value: entryId }; [sp] = await ez.createEmbeddedDocuments("Item", [s]); made.push(sp.id); } return sp; };
  const cast = async (sp, rank, targets) => { tok("Эзрен").object.control({ releaseOthers: true }); targets.forEach((n, i) => tok(n).object.setTarget(true, { releaseOthers: i === 0 })); const before = new Set(game.messages.contents.map((m) => m.id)); await sp.spellcasting.cast(sp, { rank, consume: false }); await wait(3000); return game.messages.contents.find((m) => !before.has(m.id) && m.flags?.pf2e?.context?.type === "spell-cast"); };
  const place = async (id) => { el(id).querySelector("[data-action=spell-template]").click(); await wait(600); const view = canvas.app.view, b = canvas.clientCoordinatesFromCanvas({ x: 480, y: 270 }); const ev = (t) => view.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, clientX: b.x, clientY: b.y, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: t === "pointerdown" ? 1 : 0 })); ev("pointermove"); await wait(200); ev("pointermove"); await wait(200); ev("pointerdown"); await wait(80); ev("pointerup"); await wait(4500); };
  try {
    // Огненный шар: до области — один залитый шаг «Разместить»; после — залитый «Бросить урон»; карточка урона — залитая «Применить урон…»
    const fb = await cast(await spell("Fireball"), 3, []);
    out.fireball0 = btns(fb.id); expect("fireball0", out.fireball0.length === 1 && out.fireball0[0].fill && out.fireball0[0].h >= 36, out.fireball0);
    await place(fb.id);
    out.fireball1 = btns(fb.id); expect("fireball1", out.fireball1.length === 1 && out.fireball1[0].fill && /урон/i.test(out.fireball1[0].t), out.fireball1);
    el(fb.id).querySelector("[data-action=spell-damage]").click(); await wait(3500);
    const dm = game.messages.contents.filter((m) => m.flags?.pf2e?.context?.type === "damage-roll").at(-1);
    out.damageCard = btns(dm.id, ".paf-bd button"); expect("damageCard", out.damageCard.length === 1 && out.damageCard[0].fill && out.damageCard[0].h >= 36, out.damageCard);
    out.fireball2 = btns(fb.id); expect("fireball2 (урон брошен)", out.fireball2.length === 0, out.fireball2);
    // Ужас: строки целей — контур 28px; «Применить всё» — залито (шага урона нет)
    await game.settings.set("pf2e-automato", "mode.challenge", "auto");
    const fear = await cast(await spell("Fear"), 1, ["Разбойник 1"]);
    out.fear = btns(fear.id);
    const row = out.fear.find((b) => b.t === "Применить"), all = out.fear.find((b) => /всё/.test(b.t));
    expect("fear row", !row || (!row.fill && row.h <= 30), row); expect("fear all", !all || (all.fill && all.h >= 36), all);
    // Луч мороза: «Атака» залита, две со штрафом — контур
    const ray = await cast(await spell("Ray of Frost"), 1, ["Разбойник 2"]);
    out.ray = btns(ray.id); expect("ray", out.ray.filter((b) => b.fill).length === 1 && out.ray.filter((b) => !b.fill).length === 2, out.ray);
    // Излечение: варианты — все контуром
    const heal = await cast(await spell("Heal"), 1, ["Валерос"]);
    out.heal = btns(heal.id); expect("heal", out.heal.length >= 2 && out.heal.every((b) => !b.fill), out.heal);
    // Раскат грома: после итогов видны «применить сразу», строки, «Применить всё» и урон — залит только урон
    const ts = await cast(await spell("Thunderstrike"), 1, ["Разбойник 2"]);
    out.thunder = btns(ts.id);
    // общее: не больше одной заливки на карточке (DESIGN.md: одна бордовая заливка)
    for (const [k, v] of Object.entries(out)) expect(`${k}: одна заливка`, v.filter((b) => b.fill).length <= 1, v);
    // скрытые кнопки шага не видны (display:flex не перебивает hidden)
    const hidden = [...document.querySelectorAll("#chat button[hidden]")].filter((b) => getComputedStyle(b).display !== "none");
    expect("hidden", hidden.length === 0, hidden.map((b) => b.dataset.action));
  } catch (e) { bad.push(`fatal: ${String(e?.message ?? e).slice(0, 200)}`); }
  finally {
    Hooks.off("createChatMessage", hM);
    for (const r of sc().regions.contents) if (msgs.has(r.flags?.pf2e?.messageId)) await r.delete();
    await ChatMessage.deleteDocuments([...msgs].filter((id) => game.messages.has(id)));
    if (made.length) await ez.deleteEmbeddedDocuments("Item", made.filter((id) => ez.items.has(id)));
    game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
  }
  return { ok: bad.length === 0, bad, out };
}
