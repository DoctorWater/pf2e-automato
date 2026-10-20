# Ревью стыков (Критик) — задание K7. Все пункты ПРИНЯТЫ Руководителем.

1. **Сокеты без проверки отправителя; closeZone удаляет любой регион** (main.mjs:34-54, zone.mjs:442-447). Хелпер `sender(this)`; права:
   только ГМ — applyByDegree, undoApplied, setDC, resumeUse, createZone; ГМ или автор сообщения — applyUse, applyDerived, closeZone;
   ГМ или владелец `h.actor` — useReaction; ГМ или владелец актёра цели — rollSaveFor. `zone.closeZone`: без нашего поведения — ничего не удалять.
2. **Харнесс трогает игроков** (af-harness.js): убрать создание `AF PC` с владением игроку (:117-123) и ветки tPC/player (:153, :249-258), PC-бросок → skip
   «ручной чек-лист»; уборка (:475) — только свои сообщения (author === game.user + наш флаг/известные id), не все за время прогона.
3. **low-зона без региона** (use.mjs:231-237): в low-ветке `state.zone = {regionUuid, status:"pending"}`; `applyDerived("zone")` берёт регион оттуда;
   chat.mjs:121 скрыть canCreate, если "zone" в derived.pending.
4. **onReaction-макросы не запускаются** (reactions.mjs:389, macros.mjs:448-476): в useReaction передать `rule` (resolveRule/itemFlagRule/onAttackedIndex);
   buildScope брать `ctx.actor ?? …`, `ctx.item ?? …`.
5. **Дозапуск без области; userConnected без resumePending**: resumeUse/resumePending после execUse для targets==="area" — найти последний живой регион с
   flags.pf2e.messageId===id и runRegion, если нет state.area; `Hooks.on("userConnected", () => isActiveGM && resumePending())`; в api — resumePending, reconcileZones.
6. **После F5 нет блока** (chat.mjs:15-17,213; main.mjs:86): renderBlock async, `template ??= await getTemplate(...)`, либо после загрузки перерисовать
   сообщения с flags[MOD] (`ui.chat.updateMessage`).
7. **После «Ввести СЛ» испытание не стартует** (main.mjs:44-49, saves.mjs:161-162, chat.mjs:153-159): setDC → `saves.runChallenge(m)`; runChallenge
   записывает вычисленный СЛ в use.dc, если не было; use.mjs:97-100 — СЛ заклинателя только при dc.source==="spell" или пустом dc.
8. **Реакция рисуется дважды**: оставить путь chat.mjs; в reactions.content() — только текст без <button>, убрать renderHint и подписку
   renderChatMessageHTML; харнесс :449 — `.pf2e-automato button[data-action="use-reaction"]`.
9. **undoApplied вне очереди** (main.mjs:36-40): обернуть в `queue("msg:"+id)`.
10. **deriveFromMarkup, K8** (rules.mjs:338-358): НЕ понижать всё испытание до low; в ветке A исключать из byDegree состояния восприятия
    (concealed, hidden, undetected, unnoticed, invisible, observed) и off-guard → hints, остальное high; B4 «иммунитет…» → to:"target",
    targets:"selected", low (applyDerived для u<i> с to:"target" идёт по use.targets); B3 poison/ammo/oil «на пьющего» → low. Плюс находки K8
   из K7-notes (Отвести глаза, Гипнотический приказ, Вкрадчивое слово, Боевая медицина, Блестящее сияние) — тесты на эти описания.
11. **Недостающие HANDLERS** — под `queue("use:"+id)`, без вызова execUse/runRegion внутри (тот же ключ):
    applyUse(id, targetKey?) — kind use + high; общая функция с execUse (то же разбиение selfSteps/tgtSteps и индексы meta.key); для области цели из state.area.keys.
    applyDerived(id, stepKey) — "u<i>" → onUse.apply[i] одним шагом на вызов applyOps(…, {scope:"derived", stepKey}); "zone" → attachZone по state.zone.regionUuid;
    затем derived.applied += key; при mode вида off — отказ.
    createZone(id, regionUuid) — только ГМ; проверить region.flags.pf2e.messageId===id и state.zone.regionUuid===regionUuid; attachZone(region, use.rule,
    {originUuid: use.item.uuid, originActor: use.actor, messageId: id, name: use.item.name}); state.zone={regionUuid, status:"active"}.
    originInfo — одна форма {originUuid, originActor, messageId, name}; убрать uuid/actor/slug в use.mjs:245.
12. **Харнесс расходится с кодом**: S10 — сообщение с готовым снимком kind:"card", затем update на kind:"use" и старый createdAt; проверять api.resumePending();
    S2/S4 — breathe-fire покрыт pf2e-automations → копия с флагом yield:false; copyWith — `d._stats = {}`; castBF — `{actualCast:true, data:{castRank}}`;
    S8 — setS("mode.apply","auto") на время сценария; перед S5 заново `smoke = await addEq(...)`.
13. **Мелкое**: chat.mjs:106-108 — проверять state.awaitingRegion до !done; chat.mjs:52 — saves.damageMultiplier; синтаксис `-=`/`==` (use.mjs:263, apply.mjs:431,
    sheet.mjs:126,128) в v14 устарел — перейти на ForcedDeletion/ForcedReplacement (common/data/fields.mjs:1112-1125, 2086-2097), если доступны, иначе оставить;
    undoApplied по строке испытания откатывает и state.apply[key] — отметить в README.
