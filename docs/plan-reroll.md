# План: переброс после провала (onFailed), v2

v1 разобран Критиком; v2: удержание сообщения проверки через `hold.mjs` (модуль не пересчитывает исход после применения — `saves.mjs:309-331`), переброс на клиенте автора, очередь по проверке, реальный словарь опций, общие части с `damaged.mjs` — в `builtin/lib.mjs`.

## Задача

Группа ~90 предметов pf2e: триггер «You / an ally … fail(s) a … check / saving throw / attack roll» + «reroll» (`tools/out/items.json`, `descEn`). Пример — Удача полурослика (Меллик, RustySpirit). Общий механизм по образцу `onDamaged` (`scripts/builtin/damaged.mjs`, `docs/plan-on-damaged.md`).

## Схема `onFailed`

Несовместима с `onAttacked`/`onDamaged`; с `onUse` совместима.

```json
"onFailed": {
  "who": "self" | "ally" | "any",       // ally — союзник в range фт; any — любое существо в range (word-of-revision); withSelf
  "range": 30, "withSelf": false,
  "check": ["save","skill","perception","attack"],   // ctx.type: saving-throw, skill-check, perception-check, attack-roll/spell-attack-roll
  "degree": "fail" | "critFail" | "failNotCrit",    // fail = провал или крит. провал
  "when": <предикат по опциям проверки>,
  "requires": <как у onDamaged>,
  "keep": "new" | "higher",              // по умолчанию new
  "notify": ["owner","gm"]
}
```

Реальные опции для `when` (pf2e): `check:statistic:<will|reflex|fortitude|perception|<навык>>`, `check:type:<saving-throw|skill|perception>`, `item:trait:<mental|emotion|incapacitation|poison|death|…>`, `origin:trait:<…>`, `action:<grapple|balance|recall-knowledge|…>`, `damaging-effect`. Словарь `knownOption` и тест каталога — как у onDamaged.

`skip`: «due to a misfortune», «during a combat», Aid, «would die», бросок врага (impossible-technique), «вокруг переброса» (fortunes-favor, beckoning-cat), «portray a famous», «against a trap», плоские проверки (Cyrusian, blood-crazed), `companion`.

Цена: реакция — `spendReaction`; бесплатное действие — нет; частота `system.frequency`; заклинание — сотворение (ячейка/фокус, `useOnce`).

## Удержание (hold.mjs)

1. preCreate сообщения проверки (клиент бросающего): исход по `degree`, не переброс, нет удачи (`ctx.isReroll`, `check:reroll`, `ctx.rollTwice === "keep-higher"`), есть кандидат (владелец-способность по правилу, ресурс, дальность, `when`) → `gate.hold = "reroll"` (причина удержания; Святилище — своя причина, `events.mjs:661,694-699` и плашка `damage-gate.mjs:43-48` касаются только его).
2. Пока удержано — диспетчеры (`events`, `use`, builtin) сообщение не обрабатывают; модульные броски, пишущие исход напрямую (`saves.mjs:213`, `checks.mjs:128,176`), при удержанном `rollMessage` не пишут — запишет `replay`.
3. «Без переброса», таймаут, смена хода → выпуск: `resolve(release)` → `replay`. Таймер у ГМа; при `ready` ГМ выпускает зависшие удержания причины `reroll` («сомнение — выпускаем», `hold.mjs:4`).
4. Переброс pf2e удаляет старое сообщение и создаёт новое (копирует только `flags.pf2e`) — новое обрабатывается с чистого листа. Потребители, пропускающие `isReroll` (`strike-effects.mjs:38`, `oscillating-wave.mjs:52`, `reactions.mjs:186`), должны отличать «переброс удержанного (старое не обрабатывалось)» от обычного повтора.
5. Спасброски Toolbelt (без сообщения, `saves.mjs:26-28`) — вне объёма.

## Подсказка

ГМ по созданному удержанному сообщению: шёпот адресатам `notify`, флаг `flags[MOD].failed = { message, actor, item, state }`, кнопки «<название с листа>» и «Без переброса». Тайная/слепая проверка (`messageMode` blind/gm) — подсказка только ГМу.

## Нажатие

1. Очередь по проверке `failed:<id сообщения>` (+ `reaction-owner:<владелец>` для траты реакции); перепроверка через `game.messages.get`.
2. Состояние `rerolling` до вызова (удаление старого сообщения не гасит подсказку).
3. `rerollFromMessage(message, { keep })` — на клиенте автора проверки (`socket.executeAsUser`, образец `builtin/lib.mjs:155`); автор не в сети — у ГМа. Метод ничего не возвращает: успех = появилось новое сообщение.
4. Успех → списать частоту/реакцию/сотворить, подсказка `used`, остальные подсказки этой проверки закрыть (удача одна на проверку). Неудача → вернуть `pending`.

## Общее с damaged.mjs

Импортировать экспортированные (`resourceOk`, `requiresOk`, `rangeOk`, `eligible`, `turnKey`, `staleTurn`, `tokensOf`); приватные (`recipients`, `distanceOf`, `itemsOf`, `ownerQueue`, `expireWhere`, `bind`, `useOnce`) вынести в `builtin/lib.mjs` с параметром ключа правила / data-атрибута — не копировать.

## Потолки

- Проверки без СЛ (`ctx.outcome` нет) — не видны.
- Навязывание переброса врагу (misfortune), Мастерская — вне объёма.

## Реализация (отклонения)

Файлы: `scripts/builtin/failed.mjs` (новый), `scripts/hold.mjs`, `scripts/{escape,turn-conditions}.mjs`, `scripts/builtin/{suffocation,dirty-trick,strikes}.mjs` (доработка по Критику), `scripts/builtin/lib.mjs`, `scripts/builtin/damaged.mjs`, `scripts/rules.mjs` (`vFailed`), `scripts/events.mjs`, `scripts/damage-gate.mjs`, `scripts/saves.mjs`, `scripts/checks.mjs`, `scripts/builtin/{strike-effects,oscillating-wave,index}.mjs`, `scripts/{main,sheet,card}.mjs`, `lang/{ru,en}/{rules,builtin,common}.json`, `rules/catalog.json` (Удача полурослика), `tests/on-failed.test.mjs`, `tests/checks.test.mjs` (+1 тест).

- **Причины удержания.** `gate.hold`: `true` — Святилище, `"reroll"` — переброс. `isHeld` — любая; `isSanctuaryHold` — только Святилище (плашка и скрытие кнопок в `damage-gate`, пары, `siblingPending`, `onDeleteHost`). `resolve` для `reroll` выпускает одно сообщение, для Святилища — пару; группы друг друга не выпускают. `events.onMessage` на удержании `reroll` выходит сразу (его `bail` выпускал бы как зависшее Святилище).
- **Святилище приоритетнее.** Если сообщение уже родилось удержанным Святилищем, переброс не удерживается (одна причина на сообщение) — переброс такой атаки недоступен.
- **«Переброс удержанного».** `hold.mjs`: `noteHeldDeleted` (deleteChatMessage удержанного `reroll`, все клиенты; ключ актёр + тип, TTL 10 с) + `stampHeldReroll` (preCreateChatMessage на клиенте автора: pf2e awaits `delete` перед `toMessage`, запись потребляется один раз) ставит на новое сообщение флаг `flags[MOD].rerollOf = <id старого>`. `isHeldReroll(m)` читает флаг (любой клиент/ГМ). Читают `strike-effects`, `oscillating-wave`; `reactions.mjs:186` не менялся: для переброса он обновляет существующую подсказку, а при её отсутствии создаёт новую — флаг не нужен. `events` (стопка журнала), `saves/checks/actions` (`isReroll`) на удержанном не меняются — у старого сообщения не было ни журнала, ни результата. Потолок (`ponytail:`): чужое удаление удержанного + обычный переброс того же актёра/типа в течение 10 с пометятся флагом — pf2e не передаёт id старого сообщения.
- **Прямые потребители броска.** Брали степень из промиса `check.roll`/`action.use` и применяли сразу. `hold.settledDegree(msg, degree)`: сообщение не удержано — степень сразу; удержано — опрос (250 мс) до выпуска (степень исходного) или появления сообщения с `rerollOf` (его степень), таймаут `HOLD_WAIT_MS` 35 с (> `HOLD_MS`), старое пропало без замены — исходная после 5 с. Сообщение броска — из `callback` pf2e (у `action.use` — `res[0].message`). Подключено: `escape.mjs`, `builtin/suffocation.mjs` (очередь актёра занята до 35 с), `turn-conditions.mjs` (retch), `builtin/dirty-trick.mjs`, `builtin/strikes.rollStrike` (а через него Реактивный удар, Танец клинков, Двойной финт/взмах, Устрашающий удар). `fake-out.mjs` (Check.roll, `type: "check"`) не держится: `typeOk` его типа нет. Опции «не удерживать» не потребовалось.
- **Модульные броски.** `saves.runChallenge`, `checks.runCheck/runOneRoll`: удержанный `rollMessage` — исход не пишется и `rollTried` НЕ ставится (он возвращает ГМу кнопку «Бросить» по цели, а бросок уже есть); исход запишет `replay` через `use.onCreateMessage` -> `acceptSavingThrow` по маркеру. Потолок: если удержанное сообщение удалено вручную без замены, ни результата, ни кнопки не будет — повторить можно только новым запуском карточки. Повторный `runCheck` по тому же ключу до выпуска всё же бросит заново (как и для любого нерешённого ключа) — отдельно не защищено.
- **Лист предмета.** `sheet.carryUneditable(form, f)`: `read()` вкладки возвращает `failed`/`damaged` вместе с `ev/cast/pulse/range` (раньше флаг без них перекрывал каталог при сохранении). Тест — путь `read` → `formToRule`.
- **Кандидаты синхронно.** `preCreateChatMessage` не умеет ждать импорта, поэтому `ruleOfItem`/`alliesIn`/`reactionAvailable`/`requirementOf`/`slugOf` подгружаются на `ready` (`loadDeps`) и берутся из кэша; в тестах — `setDeps`. `lib.itemsWith` — синхронная форма `lib.itemsOf`.
- **Вынесено в `lib.mjs`:** `recipients`, `distanceOf`, `ownerQueue`, `reactorsOf`, `itemsOf`/`itemsWith`, `useOnce`, `expireWhere` (с `hintOf`/`close`), `bindHint` (с `attr`/`use`/`skip`). `damaged.mjs` на них. `rangeOk`, `eligible`, `resourceOk`, `requiresOk`, `turnKey`, `staleTurn`, `tokensOf` — по-прежнему из `damaged.mjs` (импорт).
- **Очереди.** `failed:<id проверки>` -> `reaction-owner:<владелец>` только в этом порядке; `expireWhere` (только очередь владельца) и закрытие чужих подсказок другой проверки не вкладываются в `failed:*` — выпуск этих проверок идёт после, отдельным `timeout(id)`.
- **Выпуск.** `resolve(m, "release", { wait: false })` из очереди `failed:*` (replay не ждём). Таймер `HOLD_MS` (30 с) — у ГМа (`setTimeout`, в браузере не `unref`), при срабатывании проверяет `isActiveGM()` (лидер вкладок): не лидер — ничего, выпустит `sweep` нового лидера (`leader.onLead` в `main.mjs`); после неудачной попытки переброса таймер перезаводится на 5 с. `sweep`: зависшие `rerolling` гасит ВСЕГДА (очередь в памяти потеряна после F5/смены лидера), затем без подсказок или старше `HOLD_MS` — выпуск, свежие получают таймер на остаток. `onMessage` целиком в try/catch: сбой создания подсказок -> созданные ждут таймера, нет ни одной — выпуск; сбой вне очереди -> `timeout(id, true)`; проверка не остаётся удержанной.
- **`noLuck`** учитывает и `message.rolls[0].isRerollable === false` (броски kh/kl, `pf2e.mjs:19322`): `noLuck(ctx, roll)`.
- **Каталог.** Правила на действиях, бросаемых без СЛ (исхода нет — `degreeOk` их не увидит): Wait, Give Me a Moment (Вспомнить информацию), Acrobat's Staff (Удержание равновесия), Blessed Medicine (Лечение болезни) — `skip` в `drafts-accepted/b11-on-failed.json` и убраны из `catalog.model.json` (`tools/drafts.mjs` не запускался, правка точечная). Остальные action-правила b11 (Grapple/Shove/Trip/Reposition/Tumble Through, Lie, Make an Impression, High/Long Jump) — у pf2e есть СЛ по умолчанию.
- **Успех = `doReroll` вернул true И старое сообщение исчезло.** `doReroll` возвращает false, если сообщения уже нет или оно не удержано (удалено/переброшено очком героя/выпущено) — тогда pf2e не вызывается, цена не списывается; ждём доставки удаления до 3 с. Цена (`useOnce` / `spendReaction`) — после успеха; если сотворение/карточка не вышли — переброс уже сделан, цена не списана: `console.warn`, подсказка всё равно `used`. Реакция — по `actionType`/`time` = `reaction`.
- **`isHeld` / окно реакции.** Всплывающего окна реакции (`reactions.mjs`) для подсказки переброса нет — только шёпот в чате. Выбор `rerollCheck` — сокет-обработчик для запроса ГМа; автор-ГМ или не в сети — `doReroll` локально.
- **Словарь `knownOption`** (`failed.mjs`): `check:statistic:<slug>`, `check:type:<saving-throw|skill|perception|attack-roll|spell-attack-roll|flat>`, `item:trait:*`, `origin:trait:*`, `action:*`, `damaging-effect`. `tokensOf` реэкспортирован из `damaged.mjs`.
- **Потолки (сверх плана).** Кандидатов видит только клиент бросающего: ally/any-владелец, которого он не может прочесть (нет прав на актёра), не даст удержания. Отдельного режима отключения нет — `mode.reaction=off` или отсутствие активного ГМа снимает удержание. Живой прогон не делался.
