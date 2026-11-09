async () => {
  // Аудит §3.2 «одна кнопка в один момент»: какие кнопки шагов видны на карточке заклинания на каждом шаге.
  // Сцена: токены «Эзрен», «Валерос», «Разбойник 1–3» (tests/live/demo-stage.js, сетка 60). Созданные заклинания и сообщения убираются.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sc = () => game.scenes.viewed, tok = (n) => sc().tokens.find((t) => t.name === n);
  const made = [], msgs = new Set(), hM = Hooks.on("createChatMessage", (m) => msgs.add(m.id));
  const D = { wait, tok, reset: async () => {
    for (const r of sc().regions.contents) if (msgs.has(r.flags?.pf2e?.messageId)) await r.delete();   // только регионы своих карточек (§4.2), до удаления сообщений
    await ChatMessage.deleteDocuments([...msgs].filter((id) => game.messages.has(id))); msgs.clear();
    game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false })); canvas.tokens.releaseAll();
  } };
  const SPELLS = [
    ["Fear", 1, ["Разбойник 2"]], ["Ibex's Harvest", 1, []], ["Thunderstrike", 1, ["Разбойник 2"]], ["Electric Arc", 1, ["Разбойник 1", "Разбойник 2"]],
    ["Fireball", 3, []], ["Breathe Fire", 1, []], ["Sleep", 1, []], ["Ray of Frost", 1, ["Разбойник 2"]], ["Hydraulic Push", 1, ["Разбойник 2"]],
    ["Force Barrage", 1, ["Разбойник 2"]], ["Heal", 1, ["Валерос"]], ["Dispel Magic", 2, ["Разбойник 2"]]
  ];
  const ez = D.tok("Эзрен").actor, entryId = ez.itemTypes.spell.find((s) => s.name === "Ужас").system.location.value;
  const pack = game.packs.get("pf2e.spells-srd"), idx = await pack.getIndex();
  const cat = (b) => {
    const a = b.dataset.action ?? "";
    if (/spell-template/.test(a) || b.closest(".paf-area-box")) return "ОБЛАСТЬ";
    if (a === "spell-save") return "СПАСБРОСОК(pf2e)";
    if (/spell-attack/.test(a)) return "АТАКА";
    if (/-damage$/.test(a) || b.closest(".paf-damage-box")) return "УРОН";
    if (a === "spell-counteract") return "КОНТРА";
    if (b.closest(".pf2e-automato")) return "модуль:" + (a || b.textContent.trim().slice(0, 20));
    return (a || "?") + ":" + b.textContent.trim().slice(0, 20);
  };
  const cardOf = (id) => document.querySelector(`#chat [data-message-id="${id}"]`);
  const vis = (id) => {
    const el = cardOf(id); if (!el) return null;
    return [...el.querySelectorAll("button")].filter((b) => !b.hidden && b.offsetParent && !b.closest(".message-header, .message-metadata") && !/delete|toggle/.test(b.dataset.action ?? ""))
      .map((b) => cat(b) + (cat(b).startsWith("модуль") ? "" : `«${b.textContent.trim().slice(0, 24)}»`));
  };
  const place = async () => {
    const view = canvas.app.view, b = canvas.clientCoordinatesFromCanvas({ x: 480, y: 270 });
    const ev = (t) => view.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, clientX: b.x, clientY: b.y, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: t === "pointerdown" ? 1 : 0 }));
    ev("pointermove"); await wait(200); ev("pointermove"); await wait(200); ev("pointerdown"); await wait(80); ev("pointerup");
  };
  const out = {};
  for (const [orig, rank, targets] of SPELLS) {
    const res = (out[orig] = { stages: [] });
    try {
      await D.reset(); canvas.pan({ x: -140, y: 494, scale: 1 });
      const e = idx.find((x) => x.originalName === orig); if (!e) { res.err = "нет в компендиуме"; continue; }
      let sp = ez.itemTypes.spell.find((s) => s.name === e.name);
      if (!sp) { const s = (await pack.getDocument(e._id)).toObject(); s.system.location = { value: entryId }; [sp] = await ez.createEmbeddedDocuments("Item", [s]); made.push(sp.id); }
      res.name = sp.name;
      D.tok("Эзрен").object.control({ releaseOthers: true });
      targets.forEach((n, i) => D.tok(n).object.setTarget(true, { releaseOthers: i === 0 }));
      const before = new Set(game.messages.contents.map((m) => m.id));
      await Promise.race([sp.spellcasting.cast(sp, { rank, consume: false }), wait(6000)]);
      await wait(3000);
      const card = game.messages.contents.find((m) => !before.has(m.id) && m.flags?.pf2e?.context?.type === "spell-cast") ?? game.messages.contents.find((m) => !before.has(m.id));
      if (!card) { res.err = "нет карточки"; continue; }
      res.stages.push(["после каста", vis(card.id)]);
      const click = async (sel, label, ms = 3500) => { const b = [...cardOf(card.id).querySelectorAll(sel)].find((x) => !x.hidden && x.offsetParent); if (!b) return false; b.click(); await wait(ms); res.stages.push([label, vis(card.id)]); return true; };
      if (await click("[data-action=spell-template]", "клик «Разместить»", 400)) { await place(); await wait(4500); res.stages.push(["после размещения", vis(card.id)]); }
      await click("[data-action=spell-attack]", "после атаки");
      await click("[data-action=spell-damage], .paf-damage-box button", "после урона");
      const close = [...foundry.applications.instances.values()].filter((a) => a instanceof foundry.applications.api.DialogV2); for (const a of close) await a.close();
    } catch (err) { res.err = String(err?.message ?? err).slice(0, 200); }
  }
  await D.reset(); Hooks.off("createChatMessage", hM);
  if (made.length) await ez.deleteEmbeddedDocuments("Item", made.filter((id) => ez.items.has(id)));
  window.__audit = out;
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.err ? v.err : v.stages.map(([s, b]) => `${s}: ${b?.join(" | ") || "—"}`)]));
}
