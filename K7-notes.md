# Заметки для интеграции (K7) — собирает Руководитель по отчётам кусков

## Из K0
- `HANDLERS`: не проведены `applyUse`, `applyDerived`, `createZone` — дописать; проверить права отправителя.
- `queue` не реентерабелен: `apply.*` сами берут `queue("actor:"+uuid)`.
- Каталог: UUID дымовой шашки не известен (только `bySlug`) — уточнить живьём (`Compendium.pf2e.equipment-srd.Item.MoBlVd36uD9xVvZC` по данным прогона — сверить) и добавить `bySource`.
- Значения frightened в catalog «Frightful Presence» не сверены с текстом (у pf2e-automations: success 1, failure 2, crit failure 4); впрочем, предмет покрыт pf2e-automations → уступаем.
- Реестр compat сбрасывается хуком `updateSetting` — проверить живьём.
- Список valued-состояний в rules.mjs зашит — сверить с pf2e (`isValued`).
- `node --test tests/` в Node 24 не работает — использовать `node --test`.

## Из K5 (реакции)
- `reactions.onAttackMessage` НЕ подписан на `createChatMessage` сам — должен вызываться из `use.mjs` (onCreateMessage) у активного ГМа; проверить, что K2 подключил, иначе подключить в K7 (без двойного вызова).
- Кнопка шёпота — свой атрибут `[data-reaction-use]` и свой слушатель в `renderChatMessageHTML` (reactions.mjs); если chat.mjs (K4) тоже обрабатывает реакции — оставить один путь.
- `useReaction` вызывает `macros.runMacros("onReaction", …)` в try/catch — после K3 проверить фазу.
- Круговые бонусы к КБ не сравниваются по типу (бонус реакции всегда +N) — известное ограничение v1.
- Живые сценарии реакций (шёпот, переброс без дубля, трекер, reactionSpent в бою и сброс на startTurn) — в харнессе/ручном чек-листе.

## Из K1 (зоны)
- Раунды считаются по `updateCombat` (direction 1, переход 0→1 не считается), а не `pf2e.startTurn` — осознанно.
- Ключи: состояние `zone:<regionUuid>`, эффект `zone:<regionUuid>:fx`; при обоих `zoneEnter` срабатывает дважды на токен.
- `userConnected` в zone вызывает только `reconcileZones`; `resumePending` из того же хука должен навесить use.mjs (K2) — проверить.
- Хук `deleteRegion` за K2; `purgeZoneState` и так вызывается из `deleteRegionOnce`.
- Обработчик сокета `createZone` в main.mjs — провести в `attachZone` и записать `state.zone={regionUuid,status:"active"}`.
- `deleteRegionOnce` пишет `state.zone.status` (expired/closed) в сообщение — сверх контракта, учесть в chat.
- `expireZones/reconcileZones` сканируют все сцены мира.
- Живая проверка: сниппет в `D:/ClaudeFun/pf2e-automato/tests/live/k1.js` (Руководитель), плюс F5, раунды боя, хуки на втором клиенте.

## Из K8 (кампания)
- **ЗАДАЧА: ужесточить `deriveFromMarkup` (rules.mjs)** — на реальных описаниях даёт неверное: «Отвести глаза» вешает concealed/hidden/undetected на цель (а это агент относительно цели); «Гипнотический приказ», «Вкрадчивое слово» — off-guard на цель без срока (по тексту только для атак агента); «Боевая медицина» (low) — иммунитет на лекаря вместо цели; «Блестящее сияние» (low) — зона off-guard вместо условного эффекта. Проверить, какие из этих выводов помечались high (исполнялись бы сами!) и понизить: состояния восприятия (concealed/hidden/undetected/unnoticed/invisible/observed) и off-guard вне блока степени — только low; «иммунитет к …»-эффекты — цель, а не автор.
- Не разбираются: блок степени без ссылки («аналогичен провалу, но … тошноту 2»), «как успех/как провал» без наследования, состояние вне блока (Ступор); в русском описании «Сбрасывания» пропал `@Check[reflex|dc:]` (вопрос к pf2ru-translation — проверить, теряет ли сборка `dc:` пустой).
- `catalog.campaign.json`: ключ `flagRules` (5 правил для предметов со slug null) загрузчиком игнорируется — внедряются скриптом из `inventory-report.md` во флаг `flags.pf2e-automato.rule` (условие `!it.slug` — сверить в живом мире).
- Щит: `bySlug` не заведён (slug `shield` = щиты-предметы) — только `bySource`.
- На проверку ГМу: Сбрасывание (СЛ вводится кнопкой), Масло (только существа), Дымовая завеса (срок 12 с / 2 раунда), Вкрадчивое слово (fascinated без срока), Гипнотический приказ (шок = stunned).
- Заклинания с целью не проверены (в инвентаре нет `system.target`).

## Из K2 (конвейер)
- K2 сам вызывает `saves.acceptSavingThrow` и `reactions.onAttackMessage` из `createChatMessage` у активного ГМа — K5-пункт про подписку закрыт; проверить, что reactions/saves сами не подписаны тоже (двойной вызов).
- Новое поле `state.done` (нет в §1.4) — учесть в chat/контракте.
- low-ключи шагов: `state.derived.pending` = `u<i>` (индекс в `onUse.apply`) и `"zone"` — K4/K7 `applyDerived` должны использовать те же.
- Для регионов `use.targets` перезаписывается токенами области (+ уже применённые); `state.area.keys` дублирует. Сверить, что `saves.challengeTargets` берёт обновлённые.
- Очереди: `use:<id>` для runUse/runRegion (saves берёт `msg:<id>`).
- `originInfo` для `attachZone` = `{uuid, actor, originUuid, originActor, messageId, slug}` — сверить с K1 (`{originUuid, originActor, messageId, name?}`).
- Карточка без области снимок не пишет; правила без onUse/макросов (только onAttacked) — без снимка.
- `resumePending` из `userConnected` — проверить, что вызывается (K1 заметил, что в zone только reconcileZones).
- Живьём не проверено: `message.item`/`fromUuidSync` в `preCreateChatMessage`; `data.flags.pf2e` в `preCreateRegion`; путь `flags.pf2e-toolbelt.targetHelper.skip`.

## Из K4 (чат)
- **ДУБЛЬ реакций:** chat.mjs рисует подсказку реакции из `flags[MOD].reaction` и даёт кнопку `use-reaction`, а reactions.mjs (K5) кладёт текст+кнопку `[data-reaction-use]` прямо в content шёпота со своим слушателем. Оставить ОДИН путь (предпочтительно chat.mjs рисует, reactions.mjs не кладёт HTML-кнопку, или наоборот) — и проверить, что `useReaction(hintId)` с одной сигнатурой.
- Множитель урона считается локально в chat.mjs (basic: ×2/×1/×½/0) — после K3 перейти на `saves.damageMultiplier`, если он есть.
- PC-бросок: кнопка `roll-save` у PC вызывает локально `saves.rollSave(actor, challenge, ctx)`, ctx = `{marker, messageId, tokenKey, token, dc, use, message}` — сверить с сигнатурой K3.
- Кнопки: `apply`/`undo` (`data-token` = ключ|`all`), `apply-use`, `apply-derived(id, stepKey)`, `set-dc` (DialogV2.input), `resume`, `create-zone(id, regionUuid)`, `close-zone(regionUuid)`, `use-reaction(hintId)` — провести недостающие HANDLERS.
- «Ожидает ГМа» = kind use && !done && !yielded && пустой state.
- `buildViewModel(message, user, env?)` — третий параметр для тестов.

## Из K3 (испытания + макросы)
- `saves.damageMultiplier` реализован (basic ×2/×1/×½/0) — заменить локальный расчёт в chat.mjs.
- `rollSave` игнорирует лишние поля ctx из chat.mjs, маркер строит сам — ок.
- `changedAfterApply` ставится при любом перебросе после применения (не только при смене степени) — возможно, сузить до смены степени.
- Приём по маркеру работает и для skill/perception-check; без маркера — только saving-throw.
- `mode.apply=auto` вызывает applyByDegree и при пустом byDegree, если есть onDegree-макросы.
- Дедуп макросов: нет для zoneEnter/zoneExit и для сообщений без use-флага; `onReaction` дедупится, если у сообщения есть use-флаг (проверить совместимость с K5).
- `use.dc` из снимка приоритетнее `rule.challenge.dc` (для setDC) — учитывать в K2.
- Toolbelt: при `useToolbeltTargetHelper` и `checks` сами не бросаем.
- Живая проверка: сниппет в отчёте K3 → `tests/live/k3.js` (Руководитель).

## Из K6 (вкладка + харнесс)
- Вкладка: заблокированный компендий — форма редактируема, отключены только «Сохранить в предмет»/«Сбросить»/«Принять распознанное» (отклонение от §6, осознанно).
- Подсказки разметки (`hints`, `inflicts:`) не показываются: `labelsData` приватна в rules.mjs — экспортировать геттер в K7, если нужно.
- Флаг правила пишется `flags.pf2e-automato.==rule` (замена целиком).
- Харнесс: `tests/af-harness.js`, вызов `const f=<текст>; const r=await f(); console.table(r.rows); r.summary`. Опирается на селекторы K4 (`.pf2e-automato button[data-action]`), кнопку реакции `[data-reaction-use]` (K5) — после устранения дубля реакций поправить селектор; регэксп множителя угадан.
- Сценарий 10 импортирует `use.mjs` напрямую ради `resumePending` — добавить в `api`.
- Не сверены в v14: `selectOptions` (valueAttr/labelAttr), inline-партиалы, `{{checked}}`.
- Тестовый PC `AF PC` создаётся только при наличии игрока и принадлежит ему — ПРОВЕРИТЬ: не должен ли он вообще не создаваться (пользователь запретил трогать персонажей игроков; временный PC — новый актёр, не их персонаж, но владение игроку — изменение данных мира, видимое игроку). Предпочтительно: владельцем не назначать, PC-бросок — skipped.
