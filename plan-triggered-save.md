# triggered-save: спасбросок по триггеру — в области, в ауре, в начале/конце хода (план, код не написан)

Решение: не один новый механизм, а **одна форма «запись-триггер» поверх существующего** (`onEvent` + `challenge` + карточка-хозяин из `events.runEntry`) и три носителя. Всё, чего нет: событие `enter` для аур, сторона `near`, поле `per`, поле шага `repeat`, список `zone.triggers`. Карточка испытания, иммунитет, `who`/`when` у `challenge`, DC (`saves.resolveDC`), журнал, откат — переиспользуются как есть.

## 1. Что реально встречается (счёт по `tools/out/items.json`, описания en, + `triage.json`)

В `drafts-accepted` явных меток мало (`missing: triggered save` — 5: Sting of the Sea, Serpentstone Breath и др.; Mask of the Cursed Eye и Clockwork Devotion — **другие** триггеры: «цель заклинания», «конец срока», не наш случай). Остальное — скрыто в `markup-high` (простой спасбросок «при использовании») и `rule:null`. Счёт текстом: регулярки по `descEn`, точность проверена выборкой (~80–85%, ложные — «в начале хода получает действия», «ходит при условии»). «Открыто» = статус не pf2e/catalog/pa-port; копии NPC схлопнуты по slug+имени.

| подвид | пример (реальный текст) | top-документов | NPC (уникальных) | с поправкой на точность |
|---|---|---|---|---|
| **A. аура носителя** (feat/action/снаряжение/NPC) | Frightful Aura: «An enemy that enters or ends its turn in the aura must attempt a Will save…» (+иммунитет 1 мин) | 28 | ~155 | ~150 |
| **B. область предмета-источника** (облако, стена, эманация заклинания) | Spun Cloud (Green): «Any creature that ends its turn in the cloud must succeed at a Fortitude save or be Sickened 1» | 115 | ~100 | ~175 (из них ~25 — эманации у заклинателя: Diamond Dust, Entrancing Eyes, Glimmer of Charm) |
| **C. повторный спасбросок на цели** | Undermine Reality: «At the end of each of its turns, it can attempt another Will save, ending the spell on a success» | 59 | ~75 | ~110 (97 «может сбросить», 28 «обязан каждый ход», Sting of the Sea) |

Итого ~530 открытых документов, ~430 реальных; с копиями NPC ~920. Подтипы A по триггеру: «вход или ход» 75, только ход 136, только вход 31. «Первый раз за раунд / раз за ход» — 22 уникальных. У 328 из 363 текстов A есть Aura RE в самом pf2e (`auraEffects`) — геометрию берём у pf2e.

## 2. Минимальная форма в схеме

Общая запись-триггер (то же, что `onEvent`-запись, минус `side`): `{on: "enter"|"turn-start"|"turn-end", per?: "round"|"turn", when?, challenge?, apply?}`; кто бросает/кого касается — уже есть в `challenge`: `who:"enemy"|"ally"` (`saves.mjs:106`, `rules.mjs:959`), `when` (предикат цели, `saves.mjs:111` — «undead», «non-evil»), `immunity`, `byDegree`.

**A. Аура носителя** — `onEvent`-запись с новой стороной `side:"near"` (владелец — носитель ауры, «другой» — тот, чей ход/кто вошёл) и полями `range` (фт) либо `aura` (slug Aura RE pf2e):
```json
{"on":"turn-end","side":"near","aura":"frightful-aura","per":"round","challenge":{"statistic":"will","dc":{"against":"spell"},"who":"enemy","immunity":{"slug":"frightful-aura","duration":{"value":1,"unit":"minutes"}},"byDegree":{"failure":[{"condition":{"slug":"frightened","value":1}}],"criticalFailure":[{"condition":{"slug":"frightened","value":2}}]}}}
```
«Вход или ход» = две записи (`enter` и `turn-end`) с общим `per:"round"` и общим ключом иммунитета; Consecrated Aura — `range:20`, `when:["target:trait:undead"]`, «Will против СЛ заклинаний», иммунитет 1 мин при успехе.

**B. Область** — `onUse.zone.triggers: [запись-триггер]` (zone теперь может состоять только из триггеров: ослабить `zone.empty`, `rules.mjs:242`):
```json
{"onUse":{"targets":"area","zone":{"duration":{"seconds":60},"triggers":[{"on":"turn-end","challenge":{"statistic":"fortitude","dc":{"value":25},"traits":["olfactory","poison"],"byDegree":{"failure":[{"condition":{"slug":"sickened","value":1}}],"criticalFailure":[{"condition":{"slug":"sickened","value":2}}]}}}]},"challenge":null,"apply":[]}}
```
(Spun Cloud; «существа в области при создании» остаются обычным `onUse.challenge`, как сейчас, `use.mjs:322`.) Diamond Dust: `triggers:[{on:"enter",per:"turn"},{on:"turn-end",per:"turn"}]` с базовым Рефлексом и общим `per`-ключом.

**C. Повторный спасбросок** — поле шага `repeat` (брат `escape`, `rules.mjs:204`), но срабатывает **само** на границе хода, без кнопки: носитель — созданные шагом состояние/эффект (`meta` уже несёт ключ, автора, сообщение):
```json
{"to":"target","effect":{"uuid":"<эффект «квази-реальность»>"},"repeat":{"on":"turn-end","end":["success","criticalSuccess"]}}
```
(Состояния `quasi-real` в pf2e нет — носитель всегда `effect`, либо условие с явным сроком.) Поля: `on`, `statistic?`, `dc?`, `end` (степени, снимающие носитель), `byDegree?` (для «обязан каждый ход» — Sting of the Sea). Внутри `challenge.byDegree` `statistic/dc/traits/options` берутся из исходного испытания и переносятся в `meta.repeat`; **вне `challenge` (шаг в `onUse.apply`) `vApply` требует `repeat.statistic` и `repeat.dc`**.
СЛ на момент создания носителя: `use.dc ?? results[key].dc ?? await resolveDC(use)` (`use.dc` пишется только в `runChallenge`, `saves.mjs:196`, при броске PC кнопкой или из листа он пуст); результат — число в `meta.repeat.dc` (источник мог пропасть; прецедент — `turn-conditions.sourceDC`, `turn-conditions.mjs:32`).
**Носитель — всегда свой документ:** шаг с `repeat` идёт через `createTimed` (без срока — `unit:"unlimited"`), каскадное снятие как у `escape`. Если у цели уже есть такое состояние/эффект и `applyCondition` вернул `raised/skipped` (`apply.mjs:88-95`) или `hasEffect` пропустил эффект — явный отказ с заметкой в карточке, `meta.repeat` в чужой документ не пишем (иначе снимем чужое).

## 3. Рантайм

- **C:** `events.actorEvent` (`events.mjs:369`, хуки `pf2e.startTurn/endTurn`, `events.mjs:393`) после `runEvent` обходит предметы актёра с `meta.repeat.on === on` → карточка-хозяин (вынести из `runEntry`, `events.mjs:211–222`, функцию `hostChallenge({owner, other, challenge, key})`; предмет = `meta.origin`). **`owner` может быть `null`** (автор удалён: несвязанный NPC, токен снят, `fromUuid` → null; сейчас `runEntry` падает на `owner.uuid`, `events.mjs:189–220`): актёр снимка — строка `meta.by`, говорящий — имя предмета, СЛ — из снимка в `meta.repeat.dc`; иначе цель осталась бы под эффектом навсегда. Снятие носителя — **синтетические шаги `byDegree`** в правиле карточки для степеней из `end`: `{to:"target", removeKey:<meta.key>}` (внутренний вид шага, в схему не выносится), исполняется через `applyOps` с записью `effRemoved` и данных — `undoOps` восстанавливает, переброс идёт обычным `changedAfterApply`, `mode.apply` уважается. Макрос `afterChallenge` не используем: дедуп `runMacros` по `msg|afterChallenge|-|ref` (`macros.mjs:106–115`) ломает переброс, `mode.macro=off` выключает снятие, журнал и `apply` обойдены. Каскад выданного — как `escape.escapeIds` (`escape.mjs:29`). Пропускать `actor.isDead`. НПС-цели бросают у ГМа автоматически, PC — карточка с «Бросить» (это бросок, а не кнопка вместо автоматики).
- **B:** `ZoneBehaviorType.events` (`zone.mjs:62`) получает `tokenTurnStart/tokenTurnEnd` (ядро: `constants.mjs:2141`, `combat.mjs:1077`) рядом с уже имеющимся `tokenEnter`; обработчик — `isActiveGM` → `fireTrigger(sys, token, on)`. Автор/СЛ/сообщение — `sys.originActor/messageId` (`zone.mjs:44`), снимок `use.dc`. Закрытая/просроченная/скрытая зона (`expired`, `hidden`) не стреляет — уже есть в `hold`.
- **A:** (1) `turn-start/turn-end`: в `actorEvent` для **каждого** носителя `side:"near"` в бою проверить, что токен ходящего внутри (`aura` slug → `token.auras.get(slug).containsToken()` pf2e `pf2e.mjs:28016`; иначе `range` по `distanceTo`, как `range.mjs`); (2) `enter`: хук v14 `moveToken(doc, movement)` на активном ГМе — `movement.origin/destination/passed` дают «до» и «после» (проверить поля по `client/documents/token.mjs`), Map `inside` не нужен; «вошёл» = носитель/жертва была вне, стала внутри (двигается жертва или носитель).
- **Идемпотентность C:** хватает `evId` `turn:<бой>:<раунд>:<ход>:<участник>:<on>` (`events.mjs:383`): pf2e сам стреляет start/endTurn раз за раунд (`roundOfLastTurnEnd`, `pf2e.mjs:26633–26639`, переживает перезагрузку), пропущенные ходы не стреляют. Поиска по 100 сообщениям в T1 нет.
- **Идемпотентность A/B (T2/T3):** ключ `trg:<combat>:<round>[:<turn>]:<носитель|регион>:<жертва>:<запись>`; `per:"round"` — раунд, `per:"turn"` — раунд+индекс хода, без `per` — само событие (`turn:…` как сейчас, `events.mjs:383`). Вне боя `per` не ограничивает (окна нет: каждое событие — своя карточка; так задумано). Для зон (T2): `tokenEnter` приходит с `movement:null` при создании региона, включении и снятии `hidden` — такие входы фильтровать; ходовые события региона ядро шлёт без охраны pf2e (skipped, откат хода) — фильтр `event.data.skipped`, стойкий ключ, проверка `hidden/expired` внутри `fireTrigger`. Хранение: `fired` в памяти (`events.mjs:164`) + поиск карточки-хозяина с тем же `use.state.event` в последних 100 сообщениях (переживает перезагрузку).
- **Иммунитет:** до карточки `isImmune` (`saves.mjs:151`) — иммунная цель не получает карточки вообще. Снятие: зона — по сроку/`closeZone`; носитель C — по `end` или сроку самого эффекта; откат при перебросе — как у `onEvent` (журнал `events`), для зон/C — `undoOps` по ключу карточки.

## 4. Правки по слоям

- `rules.mjs`: `vEvent` — `side:"near"` (только для turn-start/turn-end/enter; `range`|`aura`, `per`; запрет `afterUse`), `EVENT_ON` + `"enter"`; `vZone` — `triggers` через общий `vTrigger`; `vApply` — `repeat` (требует `to:"target"` и `condition|effect`, не вместе с `escape`); `deriveFromMarkup` (`rules.mjs:971`): детектор `triggerSave(html)` (как `strikeGate`, `rules.mjs:957`) → правило `low` с подсказкой «не вешается автоматически: спасбросок по триггеру», чтобы ~250 текущих `markup-high` с ложным «спасброском при использовании» перестали считаться готовыми; `@Template[emanation|distance:N]` → `range:N`.
- `tools/trigger-save.mjs` по образцу `strike-gate.mjs`: конвертер для feat/action/NPC (`onUse.challenge`+текст → запись A, `Aura RE` slug из `ruleKeys`); `tools/validate.mjs` (`checkAnswer`, `:113`): ответ без триггера на тексте-триггере — ошибка; `stepsOf`/`semanticErrors` (`:50`,`:74`) смотрят в `zone.triggers` и `repeat.byDegree`; `tools/prompts/draft-rule.md` — три примера (A, B, C) и запрет «простого спасброска».
- `sheet.mjs`: `blankEvent/evForm/evRule` (`:134–136`) — `side:near`, `range`, `per`; `chForm` уже есть для триггера зоны и `repeat`; «Мастерская» (`workshop/app.mjs:507`, `automation.mjs:130`) — строки триггера; lang `au.ev.near*`, `au.repeat*`, ошибки `trg.*`/`repeat.*` (`lang/*/events.json`); README «События», `plan.md` §1.

## 5. Тесты и живая проверка

- node: `matchEntries` для `near`; `triggerKey` (раунд/ход/вне боя); переход `inside` false→true; `vTrigger/vZone/vApply repeat` (валидное/ошибки); `ruleToForm↔formToRule` для A/B/C; `triggerSave(html)` на 12 реальных текстах (положительные: Frightful Aura, Spun Cloud, Undermine Reality, Paralysis NPC; отрицательные: Aura of Courage, Mask of the Cursed Eye, «at the start of your turn you gain 3 actions»); `hostChallenge` вынесен без смены поведения — `events.test` зелёный.
- живое (копии «AF тест»): A — NPC с Frightful Aura: PC входит → одна карточка; конец хода внутри → ничего повторно в этом раунде (`per`), после успеха — иммунитет 1 мин; вышел/зашёл — тишина. B — Spun Cloud: конец хода в облаке → карточка, срок 1 мин снимает зону; скрытая зона не стреляет. C — Undermine Reality на NPC: конец его хода → бросок, успех снимает носитель; провал — повтор через ход; две копии NPC не мешают. Вкладка ГМа на about:blank (память «двоит исполнение»).

## 6. Сознательно не делаем

Выход из области (`exit`), «закончил движение в…», зона-хвост за токеном (эманация заклинателя двигается; пока статичный регион, как делает pf2e), кумулятивное снижение СЛ («−1 за каждый спасбросок», ~20 NPC), «иммунитет к этому сотворению» (иммунитет остаётся по автору+slug), чужие триггеры под меткой `triggered save` (Mask of the Cursed Eye — на заклинание-цель; Clockwork Devotion — конец срока), опасности (hazards), отказ PC-карточкам от кнопки. Для C: вне боя повтора нет (носитель остаётся до решения ГМа); Delay — бросок в момент задержки, как стреляет pf2e; мёртвые пропускаются.

**Подпачки (один примитив на пачку), по риску:**
1. **T1 `repeat` + `hostChallenge`:** ~110 док. Нет геометрии и новых событий; выносит общую карточку. Первой — самый дешёвый и проверяет общую часть.
2. **T2 `zone.triggers`:** ~150 (без 25 эманаций). Нативные события региона, срок/закрытие уже есть.
3. **T3 `side:"near"` + `enter`:** ~150. Самое рискованное (геометрия, `inside`, `per`), поэтому после того, как общий ключ идемпотентности проверен в T1–T2.
4. **T4 (по решению) эманации заклинателя:** ~25, регион следует за токеном.

## 7. Решения по итогам разбора Критика
Шаг 0 (до T1, отдельно): детектор `triggerSave(html)` + понижение ~250 ложных `markup-high` в `low`. Эманации следуют за токеном (T4, решение пользователя 2026-10-24, §9). Вход в ауру — `moveToken`, без Map. Иммунитет «к сотворению» откладывается (`slug@messageId` позже). Шум карточек PC — переиспользовать `challenge.messageMode`. Тест `hostChallenge(owner=null)` обязателен в T1.

## 8. Остаток открытых вопросов (устарело ниже — ответы выше)

1. ~~Эманации заклинателей: двигать регион за токеном или статичный?~~ **Решено пользователем 2026-10-24: двигается вслед за токеном заклинателя** (§9 «T4»; в §7 «эманации статичны» отменено).
2. Вход в ауру: свой `inside`-Map (потерян при перезагрузке, засев при старте боя) или опрос `TokenAura.containsToken` после `updateToken` — какой хук pf2e реально отдаёт позицию «до» в v14? Проверить вживую.
3. «Иммунитет к этому сотворению» (Entrancing Eyes) — нужен ключ иммунитета по `messageId`; в T1–T3 нет.
4. Карточка у каждого PC на каждый ход в ауре — шумно ли? Возможно, режим «шёпот владельцу».
5. 250 `markup-high` в этой группе нужно перетриажировать в `low`/долг — отдельным заходом после T1.

## 9. T4 — эманации заклинателя: область следует за токеном (реализовано)

**Что попадает.** 210 заклинаний с `area emanation`; с триггером в описании и спасброском — 29 документов, 20 slug (Diamond Dust, Entrancing Eyes, Captivating Adoration, Vacuum, Reaper's Lantern…). Работа T4 — не новые документы, а поведение уже существующего `zone.triggers` (T2); эманации-ауры feat/снаряжения — T3.

**Механизм: привязка ядром.** Регион эманации привязывается к токену заклинателя полем ядра `attachment.token` (`common/documents/region.mjs:70`). Дальше всё делает ядро v14, своего кода нет: в той же операции, что и ход, сдвигает фигуру `emanation` (`base.type:"token"`, без своих x/y; `client/documents/token.mjs:2509`), сохраняет членство заклинателя (его состояния зоны не мигают), синхронизирует `hidden`, удаляет регион при удалении токена. Нет ни сдвига фигур, ни очереди, ни хука `deleteToken`, ни поля `followToken`.
- **Какой токен** — из самой фигуры, не из `use.token`: токен сцены, у которого x/y/width/height/shape в `_source` равны `base` (признак ядра). `emanationToken(region)`, `zone.mjs`. Привязка — в `attachZone`, через него идут все три места запуска (`runRegion`, `attachFor`, `reconcileZones`); повтор не перепривязывает. Точного совпадения нет (отложенный запуск: заклинатель уже ушёл) — берётся единственный токен сцены актёра-автора (`originInfo.originActor`; ядро само сдвинет фигуру на дельту ходов, `token.mjs:2508-2516`). Нет подходящей фигуры/токена — зона статична.
- **Настройки области** (`onUse.zone`, валидатор `vZone`, Мастерская, промпт черновиков; значения по умолчанию — ключей нет): `follow:false` — не привязывать; `enterBy:"end"|"path"`; `onCarrierGone:"close"|"stay"`. Копируются в поведение зоны.

**Вход при наезде.** Ядро шлёт `tokenEnter` с `movement:null`, а `#enter` такие входы отбрасывает. Порядок ядра (проверен живой пробой): `regionBoundary` (в `region.tokens` наехавших ещё нет; у токена-носителя ещё прежний `movement`) -> `moveToken` носителя -> `tokenEnter(null)` стоящих. `regionBoundary` снимает состав `region.tokens`, `moveToken` (`onCarrierMoved`) докладывает `movement.id` хода (не `undo`/`config`), `#enter` при `movement==null` засчитывает вход токену, которого в снимке не было, один раз за ход (`trigger(token,"enter",{evId:"enter:"+id})`); запись живёт 3 с. Снятие `hidden` и включение поведения `regionBoundary` не шлют — записи нет, это не вход. Ход той же `movement.id` с новой границей (продолжение хода) снова даёт вход новичкам. ponytail: токен, брошенный внутрь области в пределах 3 с после хода заклинателя, засчитается входом. Для самой жертвы (`movement` задан) `undo`/`config` — не вход. Повторы отсекает ключ `trg:`; `hold`/`release` на входах с `null` работают как раньше. Автор триггеров не получает (`skipOrigin`, вывод из `areaShape`).
- `enterBy:"end"` (по умолчанию) — только итоговое положение, то есть ядерный вход.
- `enterBy:"path"` — в `moveToken` носителя (отключённое поведение пропускаем) проходим путь заклинателя (`pathRects`, `aura.mjs`) и проверяем стоящие токены по геометрии эманации (радиус из фигуры, `auraFeet`): был вне, на пути оказался внутри — тот же `evId`, один вход на жертву за ход. Состояние зоны (`hold`) по-прежнему по итоговому положению. `pathEntrants`, `zone.mjs`. ponytail: прямая между точками пути, квадратная сетка.

**Жизнь.** Удаление региона ядром (токен удалён, ГМ) — `onDeleteRegion` (`use.mjs`) выставляет карточке `state.zone.status="closed"`, если был `active` (истёкшая через `deleteRegionOnce` уже помечена). `onCarrierGone:"stay"` — `preDeleteToken` у ГМа, запросившего удаление, отменяет его (`return false`), `Promise.allSettled` снимает `attachment.token` с привязанных регионов этой зоны и удаляет токен заново (`options.afUnlinked`): ядро чистит `token.attachments` только по завершённой отвязке. Не удалась отвязка — `ui.notifications.warn`, токен удаляется всё равно (область закроет ядро). Удаление игроком (не ГМ) хук не трогает — область закроется. Область остаётся до конца срока. Окно подтверждения удаления ядра («привязанные регионы будут удалены») при `stay` неточно. Скрытый ГМом заклинатель — область скрыта, триггеры молчат: принято.

**Тесты.** node (`tests/zone-trigger.test.mjs`): вывод токена из фигуры, `follow:false`, вход по запомненному `movement.id`, отсечение undo/config, статус `closed`, `pathEntrants`, валидатор и форма. Живой `tests/live/emanation-follow.js`: `walk`, `undo`, `delete`, `follow-false`, `path`, `path-end`, `stay`.

**Риски (проверить живьём).** Порядок проверен живьём: `regionBoundary` -> `moveToken` -> `tokenEnter(null)`; удаление через `preDeleteToken` с отменой и повтором проходит (`stay` 7/7).
