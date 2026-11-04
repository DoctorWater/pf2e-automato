async () => {
  // Ярость варвара (scripts/builtin/rage.mjs) на копии персонажа мира с действием «Ярость» (по умолчанию первый варвар 3 уровня; window.__afRage = { actor: "<id>" }).
  // Проверки: удары инстинкта животного (птица: клюв/коготь) и урон ярости; карточка Ярости вешает эффект сам (ВОЗ, удары, скорость); кнопка pf2e не дублирует;
  // повтор и утомление — шёпот, без эффекта; концентрация в ярости — шёпот; без сознания — конец ярости и иммунитет к ВОЗ; инициатива — шёпот «Вспыльчивость»
  // с кнопкой; конец боя — конец ярости. Пишет в мир только «AF тест: …» и всё убирает. Нужен mode.macro не off.
  const PFX = "AF тест: ", RAGE = "Compendium.pf2e.feat-effects.Item.z3uyCMBddrPK5umr";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(150); } return null; };
  const rows = [], row = (id, ok, detail = "") => rows.push({ id, status: ok ? "ok" : "fail", detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  const sweep = async () => {
    const test = (n) => typeof n === "string" && n.startsWith(PFX);
    for (const c of game.combats.filter((c) => test(c.scene?.name))) await c.delete().catch(() => {});
    const ids = new Set(game.actors.filter((a) => test(a.name)).map((a) => a.id));
    const msgs = game.messages.filter((m) => ids.has(m.speaker?.actor)).map((m) => m.id);
    if (msgs.length) await ChatMessage.deleteDocuments(msgs).catch(() => {});
    for (const s of game.scenes.filter((s) => test(s.name))) await s.delete().catch(() => {});
    for (const a of game.actors.filter((a) => test(a.name))) await a.delete().catch(() => {});
  };
  if (window.__afRage?.cleanOnly) return sweep();
  if (game.settings.get("pf2e-automato", "mode.macro") === "off") return { summary: "SKIP: mode.macro = off" };
  const base = game.actors.get(window.__afRage?.actor) ?? game.actors.find((a) => a.class?.slug === "barbarian" && a.level === 3);
  if (!base) return { summary: "SKIP: нет варвара" };
  await sweep();
  const rage = await import("/modules/pf2e-automato/scripts/builtin/rage.mjs");
  const src = base.toObject(); delete src._id; src.name = PFX + base.name; src.ownership = { default: 0 };
  const a = await Actor.create(src);
  const rages = () => a.itemTypes.effect.filter((e) => e.slug === "effect-rage");
  const lastWhisper = (since) => game.messages.contents.slice(since).filter((m) => m.flags?.["pf2e-automato"]?.builtin === "rage").at(-1);
  const action = a.itemTypes.action.find((i) => i.slug === "rage");
  try {
    // 1. удары инстинкта: нет вне ярости
    const instinct = () => a.system.actions.filter((s) => s.slug?.startsWith("instinct-"));
    row("no-rage-strikes", instinct().length === 0, instinct().map((s) => s.slug));
    // 2. карточка Ярости -> эффект сам
    const speed0 = a.system.movement?.speeds?.land?.value;
    await game.pf2e.rollItemMacro(action.uuid);
    await waitFor(() => rages().length);
    await wait(300);
    const want = a.level + a.system.abilities.con.mod;
    row("rage-card", rages().length === 1 && a.system.attributes.hp.temp === want, { effects: rages().length, temp: a.system.attributes.hp.temp, want });
    row("rage-speed", a.system.movement?.speeds?.land?.value === speed0 + 5, { before: speed0, after: a.system.movement?.speeds?.land?.value });   // «Яростная поступь»: +5 -> +10
    // 3. удары инстинкта и урон ярости (+2, у быстрого — +1)
    const dmg = async (slug) => { const s = a.system.actions.find((x) => x.slug === slug); return s && String(await s.damage({ getFormula: true })); };
    const beak = await dmg("instinct-beak"), talon = await dmg("instinct-talon");
    const animal = a.items.find((i) => i.slug === "animal-instinct")?.flags?.pf2e?.rulesSelections?.animalInstinct;
    row("instinct-strikes", animal !== "bird" || (/1d10/.test(beak) && /1d6/.test(talon) && +beak.match(/\+ ?(\d+)/)?.[1] - +talon.match(/\+ ?(\d+)/)?.[1] === 1), { animal, beak, talon, strikes: instinct().map((s) => s.slug) });
    // 4. второй эффект (кнопка pf2e) не создаётся
    await a.createEmbeddedDocuments("Item", [(await fromUuid(RAGE)).toObject()]).catch(() => {});
    row("no-duplicate", rages().length === 1, { effects: rages().length });
    // 5. повторная Ярость — шёпот
    let n = game.messages.size;
    await game.pf2e.rollItemMacro(action.uuid);
    const again = await waitFor(() => lastWhisper(n));
    row("again-whisper", !!again && rages().length === 1, again?.content.replace(/<[^>]+>/g, "").slice(0, 120));
    // 6. концентрация в ярости (Деморализация) — шёпот
    n = game.messages.size;
    await game.pf2e.actions.get("demoralize")?.use({ actors: [a], event: new MouseEvent("click", { shiftKey: !!game.user.flags.pf2e?.settings?.showCheckDialogs }) }).catch((e) => e);
    const conc = await waitFor(() => lastWhisper(n));
    row("concentrate-whisper", !!conc, conc?.content.replace(/<[^>]+>/g, "").slice(0, 120));
    // 7. без сознания — конец ярости, иммунитет
    await a.increaseCondition("unconscious");
    const gone = await waitFor(() => !rages().length && a.itemTypes.effect.some((e) => e.slug === "effect-rage-temporary-hit-points-immunity"));
    row("unconscious-ends", !!gone && a.system.attributes.hp.temp === 0, { effects: a.itemTypes.effect.map((e) => e.slug), temp: a.system.attributes.hp.temp });
    await a.decreaseCondition("unconscious", { forceRemove: true });
    for (const e of a.itemTypes.effect) await e.delete();
    // 8. утомление — шёпот, без эффекта
    await a.increaseCondition("fatigued");
    n = game.messages.size;
    await game.pf2e.rollItemMacro(action.uuid);
    const fat = await waitFor(() => lastWhisper(n));
    row("fatigued-whisper", !!fat && !rages().length, fat?.content.replace(/<[^>]+>/g, "").slice(0, 120));
    await a.decreaseCondition("fatigued", { forceRemove: true });
    // 9. инициатива — шёпот «Вспыльчивость», кнопка -> ярость (обработчик напрямую: без сцены и боя, вид ГМа не переключается)
    n = game.messages.size;
    await rage.onMessage({ actor: a, token: null, flags: { pf2e: { context: { type: "initiative" } } } });
    const qt = await waitFor(() => lastWhisper(n));
    ui.sidebar?.changeTab?.("chat", "primary");
    const btn = await waitFor(() => document.querySelector(`#chat [data-message-id="${qt?.id}"] [data-af-rage]`));
    btn?.click();
    row("quick-tempered", !!(await waitFor(() => rages().length === 1)), { whisper: !!qt, button: !!btn, effects: rages().length });
    // 10. конец боя — конец ярости
    await rage.onCombatEnd({ combatants: [{ actor: a }] });
    row("combat-end", !!(await waitFor(() => !rages().length)), { effects: a.itemTypes.effect.map((e) => e.slug) });
  } catch (e) {
    row("error", false, String(e?.stack ?? e).slice(0, 300));
  } finally {
    await sweep();
  }
  const fail = rows.filter((r) => r.status !== "ok").length;
  console.table(rows);
  return (window.__afRageResult = { summary: `${rows.length - fail}/${rows.length} ok`, rows });
}
