# План L1-R3: «Ты следующий» (You're Next)

`Compendium.pf2e.feats-srd.Item.gjec0ts3wkFbjvHN`, slug `youre-next`. Приёмка — `docs/level1-rogue-tasks.md:46`, контракт — `plan.md:1015` (L1-C4). Сейчас: `rules/drafts/b04-reactions.json:144` — manual, правила нет. Мечник вне охвата.

## 1. Что уже есть в pf2e (по паку `feats`)

RE черты:
- `FlatModifier`: селектор `intimidation`, circumstance +2, **предикат `["action:demoralize","youre-next"]`**. Бонус включается, только если в опциях броска есть `youre-next`.
- `ItemAlteration` — подмена описания по классу; к механике отношения не имеет, дублировать не надо.

Значит +2 даёт сама система: реакция **сама проводит** Деморализацию с опцией `youre-next` в `extraRollOptions` (§4). Эффект на плуте, `RollOption` и запись снятия не нужны.

## 2. Как узнать «этот плут снизил ОЗ этого врага до 0»

Сообщение pf2e `damage-taken` создаётся в `applyDamage` (`pf2e.mjs:33322`): `flags.pf2e.origin = item.getOriginData()` (автор урона), `appliedDamage.updates[] = {path, value: старое−новое}` (дельта, не итог), `isHealing`, `shield`.

- Автор: `messageParties` берёт `ctx.origin?.actor ?? pf.origin?.actor` (`scripts/events.mjs:527`). Запись `onEvent {on:"damage-taken", side:"origin"}` исполняется у автора (`runEvent` `events.mjs:478`, `parties.origin` `:577`; «другой» для origin = жертва, `:576`). Урон без автора — владельца нет, запись не сработает.
- **«ОЗ стали 0» — новая опция (код, одна строка).** `self:hp-remaining:0` не работает: pf2e пишет `hp-remaining:N` без префикса (`pf2e.mjs:20159`), `getSelfRollOptions` переносит только `self:*`, а в наборе для origin смешаны опции жертвы и атакующего. В `messageOptions` (`events.mjs:531`, ветка `on === "damage-taken"` `:536`) добавить `damage-taken:hp0`, когда набор уже содержит `damage-taken:hp` и `message.actor` на 0 ОЗ. `damageOptions(applied)` (`:115`) чистая и актёра не видит — опция живёт в `messageOptions`.
- **Только враги:** в `when` записи штатная опция `origin:enemy` (pf2e кладёт её в `context.options` сообщения damage-taken, `pf2e.mjs:54165`; в набор попадает через `ctx.options`, `events.mjs:534`). Опций `alliance:*` нет — не использовать.
- Предикат записи: `["damage-taken:hp","damage-taken:hp0","origin:enemy"]`. Он отсекает:
  - лечение и откат — `onMessage` выходит сразу (`events.mjs:553`);
  - чужой урон — запись только у автора удара (side `origin`);
  - урон по уже лежащему на 0 — дельта 0, нет `damage-taken:hp` (`events.mjs:120`);
  - урон во временные ОЗ/щит — нет `damage-taken:hp`;
  - союзника и себя — нет `origin:enemy`.
- Откат карточки: `onUpdateMessage` (`events.mjs:603`) откатывает журнал записи.
- Остаточный риск: ОЗ читаются при обработке сообщения, не в момент урона (лечение между ними даст ложный отказ). Принять.

## 3. Реакция проводит Деморализацию сама

`reactions.mjs`/`hints.mjs` не подходят: подсказка привязана к атаке по владельцу (`onAttackMessage` `reactions.mjs:138`, пересчёт степени). Оттуда берём `reactionAvailable` (`:93`, учитывает `noReactions`) и флаг `reactionSpent` (`:192`, сброс на старте хода `:200`).

Каталог Деморализации: `catalog.campaign.json:28` (uuid действия) и `:69` (slug `demoralize`): `intimidation` против Воли, `options:["action:demoralize"]`, иммунитет `demoralize` 10 мин, 1/2 степень -> `frightened` 1/2. Берём как образец, не копируем.

Поток записи:
1. Гейт до окна: `cost:"reaction"` -> `reactionAvailable(owner)` либо выполнено `free`; иначе тишина.
2. Подтверждение = первый `choose` записи: `from:"enemies"`, `range:60` (`apply.mjs:603`). Кандидаты — без жертвы события (`ev.other`) и без существ с ОЗ ≤ 0; по желанию без имеющих иммунитет `demoralize`: доработка фильтра `enemies` (код). Закрытие окна = отказ; нет кандидатов — `apply.noCandidates` (`apply.mjs:604`). Запись без `choose` — окно да/нет.
3. После подтверждения — повторная проверка и **трата** реакции (§5).
4. Проверка `check` записи (§4): владелец против Воли выбранного, карточка `hostChallenge` (`events.mjs:257`) с `rollerRole:"author"`.

## 4. +2 и обобщение `entry.check`

Сейчас `entry.check` — только Lingering Composition: `spell-cast`+`afterUse`, СЛ `ofTargets:"level"` (`rules.mjs:646-649`, `vEventCheck` `:601`; исполнение `events.mjs:243-247`, `other: owner`). Обобщить до «проверка владельца против выбранного/другого участника»:
- `check` допустим и при `on:"damage-taken"` (снять ограничение `rules.mjs:647`); цель — выбранный `choose`-ом (`picks.actor`), а не `ev.other`;
- форма `check:{like:"demoralize", options:["youre-next"]}`: берёт `onUse.check` каталога по slug (statistic/vs/traits/immunity/byDegree) и добавляет опции. `check.options` идут в `extraRollOptions` (`checks.mjs:96`) -> FlatModifier черты даёт +2 ровно этому броску. Альтернатива — полный `check` в записи, но он дублирует иммунитет и степени;
- `vEventCheck` расширить под `like`/`options`/`vs`; `ev.empty` (`rules.mjs:650`) `check` уже допускает;
- иммунитет 10 мин ставит штатная цепочка `immunity` после броска.

## 5. Примитив реакции: поле записи, не шаг

Поле `onEvent`: `cost:"reaction"` и `free:<predicate>` — по опциям **владельца** (`whenOptions` с `selfActor`, `apply.mjs:343`; для плута `skill:intimidation:rank:4`). Валидатор — `vEvent` (`rules.mjs:619`, рядом с `once` `:635`): `cost` только `"reaction"`, `free` только вместе с `cost`, предикат через `isPredicate`. Порядок фиксирует `runEntry` (`events.mjs:197`):
1. Гейт `reactionAvailable`/`noReactions` до окна. Если `free` истинно — гейт пропускается и реакция не тратится.
2. Очередь `queue("reaction:" + owner.uuid)` вокруг записи и **дедуп пачки**: тот же `origin.uuid`, пока окно открыто и несколько секунд после. Не «по раунду»: отказ/тайм-аут окна не блокирует реакцию на раунд.
3. Подтверждение — первый `choose` записи (или окно да/нет).
4. Трата только после подтверждения, с повторной проверкой: `setFlag(MOD,"reactionSpent",{combat,round})` как `reactions.mjs:190-193` (вне боя не ставим) + `item.toMessage()` для Action Tracker (`:189`). В журнал записи — op `reactionSpent` с `prev` (прежнее значение флага); `undoLog` (`events.mjs:500`) возвращает `prev`. Ограничение: карточку трекера откатом не вернуть.
5. Из `useReaction` (`reactions.mjs:188-193`) вынести общий `spendReaction(actor, item)`.

Дальний шаг (не в L1-R3): перенос `onAttacked` на это же поле.

## 6. Форма и Мастерская (поле не должно теряться)

`check` уже ездит как есть (`scripts/sheet.mjs:180` `evForm`, `:184` `evRule`). `cost`/`free` — по образцу `hold`/`check`:
- `sheet.mjs`: `blankEvent` (`:178`) — `cost:"", free:""`; `evForm` — `cost: e.cost ?? ""`, `free: whenText(e.free)`; `evRule` — `cost` и `free` (через `parseWhen`) только при непустом `cost`. `rowOf`/`KEEP` (`:48`, `:35`) шагов касаются: проверить, что `choose` шага переживает `rowOf`->`applyOf` (если нет — добавить в `KEEP`).
- `scripts/workshop/app.mjs`: рядом с `once`/`afterUse` (`:706-707`) — чекбокс «Реакция» и условие «бесплатно, если». Смена `on`/`side` (`:449-451`) не сбрасывает `cost`/`free`.
- `scripts/workshop/automation.mjs`: `evLine` (`:342-347`) — показать «реакция» в строке записи.
- i18n `lang/ru|en`: `workshop.au.ev.cost`, `workshop.au.ev.free`, prompt выбора, подпись строки.
- Тест round-trip: `evRule(evForm(entry))` равно исходной записи.

## 7. Повторы и итоговый набор изменений

- Повтор сообщения/переподключение: `entryKey` + журнал `flags[MOD].events` (`events.mjs:200`).
- Второе «применить» на той же карточке: жертва уже на 0 — тишина.
- Серия урона (область): очередь + дедуп по `origin.uuid` -> одно окно; закрыл/тайм-аут — следующая пачка снова спросит.
- Откат урона: `undoLog` возвращает флаг (`prev`), карточка проверки удаляется.
- У `damage-taken` переброса нет.

Код (минимум): `scripts/events.mjs` (опция `hp0`, `runEntry`: гейт/очередь/дедуп/трата/undo, обобщённый `check`), `scripts/rules.mjs` (`cost`/`free`, расширение `check`), `scripts/apply.mjs` (фильтр кандидатов `enemies`), `scripts/reactions.mjs` (`spendReaction`), `scripts/sheet.mjs`, `scripts/workshop/app.mjs`, `scripts/workshop/automation.mjs`, lang ru/en, `rules/catalog.json` (запись черты), тесты. Запись:
```
{"on":"damage-taken","side":"origin","when":["damage-taken:hp","damage-taken:hp0","origin:enemy"],
 "cost":"reaction","free":["skill:intimidation:rank:4"],
 "apply":[{"to":"self","choose":{"from":"enemies","range":60,"prompt":"..."}}],
 "check":{"like":"demoralize","options":["youre-next"]}}
```

## 8. Юнит-тесты (`tests/youre-next.test.mjs`, образец `tests/events.test.mjs`)

1. `messageOptions` из мок-актёра: урон по ОЗ и 0 ОЗ -> `damage-taken:hp0`; >0 -> нет; лечение/`isReverted` -> нет; только temp/щит -> нет; `updates` без hp (уже на 0) -> нет; `origin:enemy` из `context.options` есть/нет.
2. Валидатор: запись проходит; `free` без `cost` — ошибка; `cost:"x"` — ошибка; `check` на `damage-taken` проходит; `check.like` с неизвестным slug — ошибка.
3. Гейт: доступна / потрачена в раунде / `noReactions` / новый раунд; `free` (ранг 4) — без траты.
4. Очередь+дедуп: два сообщения одного `origin.uuid` — одно окно; после отказа новая пачка спрашивает; тайм-аут не блокирует раунд.
5. Трата только после подтверждения; закрытое окно — флага нет; повторная проверка при гонке.
6. Журнал: op `reactionSpent` с `prev`; `undoLog` возвращает прежнее значение.
7. Кандидаты: без `ev.other`, без ОЗ ≤ 0, (опц.) без иммунных.
8. Бросок: `extraRollOptions` содержит `action:demoralize` и `youre-next`.
9. Round-trip формы: `evRule(evForm(e))` сохраняет `cost`/`free`/`check`.

## 9. Живые сценарии (вкладка ГМа, строго по одному)

1. Плут сбивает врага до 0 -> окно выбора врага в 60 фт -> карточка Деморализации с +2 в модификаторах, реакция потрачена, иммунитет 10 мин на цели.
2. Закрыл окно -> реакция цела; следующая пачка снова спрашивает.
3. Нет кандидатов в 60 фт -> уведомление, реакция цела.
4. Реакция потрачена (Nimble Dodge) -> окна нет.
5. Область: два врага падают разом -> одно окно.
6. Откат карточки урона -> реакция возвращена; карточка трекера остаётся (ограничение).
7. Легендарное Запугивание -> реакция не тратится, окно при каждом падении.
8. Союзник/сам себя, чужой удар, лечение, повторный урон по лежащему на 0 — окон нет.
9. Переподключение клиента после окна — повторного расхода нет.
10. Мастерская: открыть запись черты, сохранить без правок — `cost`/`free`/`check` на месте.

## 10. Открытые вопросы
- `check.like` против полного `check` в записи (выбран `like`: нет дубля иммунитета/степеней).
- Окно дедупа пачки: «пока окно открыто + N с» (предложение 5 с).
- Фильтр кандидатов по иммунитету `demoralize`: желателен, не обязателен.
- Источник ОЗ жертвы для `hp0` (`actor.hitPoints.value` или `system.attributes.hp.value`) — по мок-актёру теста.

## 11. Статус реализации (юнит-уровень)

Сделано (`node --test` 1316 pass / 0 fail / 2 skip, `tests/youre-next.test.mjs` — 14):
- `events.mjs`: `messageOptions` экспортирован, опция `damage-taken:hp0`; `runEntry` — гейт `reactionAvailable`/`free` -> очередь `reaction:<владелец>` + дедуп 5 с по `origin.uuid` -> `execEntry` (подтверждение первым `choose` либо окном да/нет, трата после повторной проверки, op `reactionSpent{actor,prev}`); полная проверка записи (`check` без `dc`) идёт обычным проходом, цель — выбранный `choose`, карточка `hostChallenge`.
- `rules.mjs`: `cost`/`free` (только onEvent, `free` только с `cost`, `choose` — первым шагом), `check` полной формы (vCheck с обязательным `vs`) только у `damage-taken` с шагом `choose`.
- `apply.mjs`: `ctx.skipPick` (без жертвы и ОЗ <= 0) для записей с `cost`; `undoOps` возвращает `reactionSpent.prev`.
- `reactions.mjs`: `spendReaction(actor, item)` (общий с `useReaction`).
- Форма/Мастерская: `cost` (чекбокс) и `free` (предикат) в `sheet.mjs`, `workshop/app.mjs`, `workshop/automation.mjs`; `choose` шага round-trip без KEEP; lang ru/en (`events.json`).
- `rules/catalog.json`: запись черты по uuid (по slug нельзя: у NPC-действий тот же slug).

Осталось: живые сценарии §9 (не запускались); `onAttacked` на поле `cost` — дальний шаг; в `rules/drafts/b04-reactions.json` статус записи не менялся.
Отклонения от плана: проверка — полная копия Деморализации с `options:["action:demoralize","youre-next"]`, `check.like` не вводился; форма `cost` — булев чекбокс.

### Ограничения (после замечаний Критика)
- Дедуп (5 с, `владелец|origin.uuid`) и очередь `reaction:<владелец>`: при `free` и при двух врагах одной области — одно окно (второй враг не получает своего); второй Удар того же предмета в течение 5 с после закрытия окна — тоже без окна. Очередь держит записи origin этого владельца, пока открыто окно.
- Токен выбранного врага — `tokenOf(actor)` (первый активный токен актёра); у связанного актёра с несколькими токенами это может быть не тот токен, что на карте рядом.
- `origin:ally/enemy` из `context.options` pf2e отбрасываются, считаются по паре жертва/автор (`alliance`) — для всех записей `damage-taken`.
- Исправлено: кандидаты без иммунных к проверке; режимы challenge/effect off — тишина до окна; откат урона при открытом окне; `reactionSpent` откатывается, только пока флаг тот же (`set`); `spendReaction` сначала флаг, потом трекер; чекер окна да/нет как у `choose`.
