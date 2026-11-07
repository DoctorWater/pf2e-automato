async () => {
  // Живой прогон onFailed (docs/plan-reroll.md): Удача полурослика на временной копии Меллика (RustySpirit). Сам герой не меняется.
  // Провал спасброска -> сообщение удержано (gate.hold "reroll") + шёпот -> кнопка -> переброс (новое сообщение, частота 0) -> второй провал без подсказки;
  // «Без переброса» -> удержание снято. Параметры: window.__afReroll = { hero: "<id актёра>" }. Результат — массив строк PASS/FAIL.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* ещё нет */ } await wait(150); } return null; };
  const hero = game.actors.get(window.__afReroll?.hero ?? "9Ub1novChQL3E9m9");
  if (!hero) return ["SKIP: нет героя"];
  const fails = [], ok = (c, label) => { if (!c) fails.push(label); };
  const msgs = (t0) => game.messages.contents.filter((m) => m._stats.createdTime >= t0);
  const hintFor = (t0) => msgs(t0).find((m) => m.flags?.[MOD]?.failed);
  const saveRoll = (a) => a.saves.reflex.roll({ dc: { value: 60 }, skipDialog: true, createMessage: true });
  const t00 = Date.now();
  let copy = null;
  try {
    const d = hero.toObject(); delete d._id; delete d.folder; d.name = PFX + hero.name; d.ownership = { default: 0 };
    copy = await Actor.create(d);
    const luck = copy.items.find((i) => i.slug === "halfling-luck");
    ok(!!luck, "у копии есть Удача полурослика");
    if (luck && luck.system.frequency) await luck.update({ "system.frequency.value": 1 });
    // 1) провал -> удержание и подсказка -> переброс
    let t0 = Date.now();
    await saveRoll(copy);
    const save1 = await waitFor(() => msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "saving-throw"));
    ok(!!save1, "сообщение спасброска");
    ok(save1?.flags?.[MOD]?.gate?.hold === "reroll", `спасбросок удержан: ${JSON.stringify(save1?.flags?.[MOD]?.gate)}`);
    const h1 = await waitFor(() => hintFor(t0));
    ok(!!h1 && h1.flags[MOD].failed.state === "pending", `подсказка pending: ${h1?.flags?.[MOD]?.failed?.state}`);
    const btn = document.querySelector(`#chat [data-message-id="${h1?.id}"] [data-af-failed="use"]`);
    ok(btn?.textContent?.trim() === luck?.name, `кнопка — название с листа: «${btn?.textContent?.trim()}»`);
    const t1 = Date.now();
    btn?.click();
    const re = await waitFor(() => msgs(t1).find((m) => m.flags?.pf2e?.context?.type === "saving-throw" && m.flags.pf2e.context.isReroll), 12000);
    ok(!!re, "переброшенный спасбросок");
    ok(!game.messages.get(save1?.id), "старое сообщение удалено pf2e");
    ok(!re?.flags?.[MOD]?.gate?.hold, `переброс не удержан повторно: ${JSON.stringify(re?.flags?.[MOD]?.gate)}`);
    ok(!!(await waitFor(() => game.messages.get(h1?.id)?.flags[MOD].failed.state === "used", 6000)), `подсказка used: ${game.messages.get(h1?.id)?.flags?.[MOD]?.failed?.state}`);
    ok(!!(await waitFor(() => copy.items.get(luck.id)?.system.frequency?.value === 0, 6000)), `частота списана: ${copy.items.get(luck.id)?.system.frequency?.value}`);
    // 2) второй провал — частоты нет: ни удержания, ни подсказки
    t0 = Date.now();
    await saveRoll(copy);
    const save2 = await waitFor(() => msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "saving-throw"));
    await wait(2000);
    ok(!!save2 && !save2.flags?.[MOD]?.gate?.hold && !hintFor(t0), "частота 0 — без удержания и подсказки");
    // 3) «Без переброса» — удержание снято
    await luck.update({ "system.frequency.value": 1 });
    t0 = Date.now();
    await saveRoll(copy);
    const save3 = await waitFor(() => msgs(t0).find((m) => m.flags?.pf2e?.context?.type === "saving-throw"));
    const h3 = await waitFor(() => hintFor(t0));
    document.querySelector(`#chat [data-message-id="${h3?.id}"] [data-af-failed="skip"]`)?.click();
    ok(!!(await waitFor(() => !game.messages.get(save3?.id)?.flags?.[MOD]?.gate?.hold, 6000)), `«Без переброса» — удержание снято: ${JSON.stringify(game.messages.get(save3?.id)?.flags?.[MOD]?.gate)}`);
    ok(game.messages.get(h3?.id)?.flags?.[MOD]?.failed?.state === "skipped", `подсказка skipped: ${game.messages.get(h3?.id)?.flags?.[MOD]?.failed?.state}`);
    ok(copy.items.get(luck.id)?.system.frequency?.value === 1, "пропуск частоту не тратит");
  } catch (e) {
    fails.push(`ошибка: ${e?.message ?? e}`);
  } finally {
    const ids = msgs(t00).map((m) => m.id);
    if (ids.length) await ChatMessage.deleteDocuments(ids).catch(() => {});
    if (copy) await copy.delete().catch(() => {});
  }
  return [fails.length ? `FAIL reroll: ${fails.join("; ")}` : "PASS reroll"];
}
