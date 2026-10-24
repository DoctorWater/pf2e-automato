# Живые сценарии и инвентаризатор (вкладка ведущего)

Файлы в `tests/live/` — выражения `async () => {...}` для консоли/`evaluate_script` ведущего. Из node не запускаются (`node --check` — только синтаксис, см. ниже).

## Требования
- Вкладка Gamemaster, она же лидер вкладок ГМа и активный ГМ (иначе обработчики модуля не сработают). Вторую вкладку ГМа закрыть или держать на `about:blank`.
- Игроки могут быть в сети, но лучше нет: окна и шёпоты уходят и им, а чат-сообщения тестов удаляются.
- Модуль `pf2e-automato` активен, pf2e 8.6.x, Foundry v14. Сайдбар чата виден (кнопки в шёпотах ищутся в DOM `#chat`; сценарии сами переключают вкладку).
- Токен-действия HUD (`tah-*`) идут только при активном `token-action-hud-core`, иначе `SKIP`.
- Тесты не пишут в мировые данные кроме временных `AF тест: …` (актёры, сцены, бои, сообщения). Настройки пользователя (`showCheckDialogs`, `showDamageDialogs`) и `useToolbeltTargetHelper` на время прогона меняются и возвращаются в конце. Просматриваемые сцена и бой восстанавливаются.

## Как запустить
Через chrome-devtools: прочитать файл и передать его содержимое как `function` в `evaluate_script` (оно уже `async () => {...}`).
Либо макрос-скрипт мира: `const f = <вставить содержимое файла>; return f();`.

Инвентаризатор мира (ничего не пишет, скачивает `inventory-world.json`):
```
tests/live/inventory.js
window.__afInv = { save: true, full: false }   // необязательно: до запуска. full — вернуть весь JSON; types — свой список типов
```
Статусы предмета (как `tools/triage.mjs`): `pf2e` (только `selfEffect` у action/feat или Aura RE с непустыми `effects`) > `automations` (покрывает pf2e-automations) > `builtin` (обработчик из `scripts/builtin/`) > `module-high` (правило из флага/каталога или разметка с высокой уверенностью) > `markup-low` (выводится из разметки, уверенность ниже) > `manual` (активный предмет со следом в тексте, правила нет) > `none`. Все слои — в `layers`. Предметы без источника (NPC) дедуплицируются по type + slug + нормализованному тексту. Формат записи: `uuid` (`_stats.compendiumSource`, иначе `flags.core.sourceId`), `slug`, `type`, `name` (английское, из `flags.babele.originalName`), `nameRu`, `status`, `layers`, `pf2e`, `automations`, `module`, `builtin`, `actors`, `count`. Сводка: по статусам, по типам, по актёрам. Полный результат всегда в `window.__afInventory`.

Регрессионный набор:
```
tests/live/suite.js
window.__afSuite = { only: ["flanking", "range"], skip: [], cleanOnly: false }   // необязательно, до запуска
```
Результат: `{summary, table, rows}` (`ok / fail / skip`, строка на сценарий), то же в `console.table` и `window.__afSuiteResult`.

Сценарии (id): `power-volley`, `phantom-pain`, `tangle-vine`, `grapple-escape`, `flanking`, `surprise-attack`, `metamagic`, `range`, `range-reach`, `tentacles`, `reaction-hint`, `shield-block`, `frightened`, `sickened`, `tah-reload`, `tah-cover`.
Каждый создаёт свою сцену «AF тест: сцена <id>», актёров из компендиума (Варрис берётся копией из мира, если есть и у него есть Силовой залп), расставляет токены, действует и убирает всё за собой.

## Если упало посередине
Аварийная чистка (удаляет всё с префиксом `AF тест`: бои, сцены, актёров, сообщения; возвращает число оставшегося):
```
window.__afSuite = { cleanOnly: true }  // и запустить suite.js
```
Затем вручную: вернуть просматриваемый бой (`ui.combat.initialize({combat})`), снять цели (`game.user.targets.forEach(t => t.setTarget(false))`), проверить `game.user.flags.pf2e.settings.showCheckDialogs` (нужно `true`, если было так) и настройку модуля `useToolbeltTargetHelper`.

## Хрупкие места
- d20 фиксируется подменой `CONFIG.Dice.randomUniform`; если Foundry поменяет формулу, сценарии с фиксацией помечаются `SKIP` (проверка `1d20` после подмены).
- Окна `.paf-dialog` без ответа сценария закрываются (отмена); legacy-окно урона и ChoiceSet pf2e обрабатываются по имени класса/заголовка.
- `power-volley` отвечает в окна по `[data-action='2']`, `[name=t0]`, `[data-action=ok]`; `tah-*` — по `[data-paf-reload]` и `button[value^=pafCover]`; `metamagic` читает конус из текста кнопки `[data-action=spell-template]`.
- `frightened` ломается, если активен Workbench/pf2e-automations с уменьшением испуга (модуль уступает им).
- Сценарии зависят от слагов пака: `force-barrage`, `phantom-pain`, `tangle-vine`, `runic-weapon`, `burning-hands`, `shield`, `tentacular-limbs`, `widen-spell`, `reach-spell`, `nimble-dodge`, `surprise-attack`, `crossbow`, `crossbow-bolts`.
- Таймаут сценария 150 с.

## Механизмы пачки 0.5 (`pa05.js`)
Те же требования и приёмы, что у `suite.js` (фиксация d20, сцена и актёры «AF тест: …» с уборкой, таймаут сценария 150 с, ответ на окна — отмена). Проверяется состояние актёров и эффектов, а не текст чата.
```
tests/live/pa05.js
window.__afPa05 = { only: ["badge", "gear"], skip: [], cleanOnly: false }   // необязательно, до запуска
```
Результат: `{summary, table, rows:[{id,title,status,detail}]}`, то же в `console.table` и `window.__afPa05Result`. Аварийная чистка — `cleanOnly: true` (как у `suite.js`).

Сценарии (id): `challenge-immunity`, `suffocation`, `improved-grab`, `rage-immunity`, `remove-condition`, `badge`, `damage-step`, `damage-in-degree`, `reduce`, `onevent-strike`, `gear`, `damage-link`, `when`.
- Нужны режимы `mode.effect` и `mode.challenge` = `auto`, `mode.macro` не `off`; иначе сценарий `SKIP` с причиной. Группа, которой уступает модуль (pf2e-automations: `swallow-whole`, `grab`, `rage`, `hardwood-armor`, `life-link`), даёт `SKIP`.
- Данные по slug/uuid pf2e 8.6.1 (ремастер); нет предмета в паках — `SKIP`. Правила `badge`, `damage-step`, `reduce`, `when` — флаг `rule` на временном предмете-действии «AF правило» (проверяется `validateRule`), остальные — каталожные правила настоящих предметов (Frightful Presence, Stand, Tongue Grab, Hardwood Armor).
- Шаги NPC-целей читаются с актёра токена (`scene.tokens.get(id).actor`), не с исходного актёра: токены «развязаны».
- `damage-link` кладёт эффект Life Link на союзника напрямую (ранг 3 = до 5 урона): сотворение в ячейках стенда невозможно.

### Хрупкие места `pa05.js`
- Устаревшие slug в `suite.js` (не правились): `crossbow-bolts` теперь `bolts`; `burning-hands` в ремастере иной.
- `challenge-immunity`: СЛ 22 берётся из текста NPC-способности Abomination Vaults (`dc:22`), а исход «провал» рассчитан на неё и d20=10; кнопка «Применить» ищется в DOM `#chat` (`button[data-action^=apply]`).
- `suffocation`: опирается на `air.decrease()` (pf2e удаляет эффект на значке 1), запасной путь — прямое удаление; GrantItem должен выдать Remaining Air.
- `improved-grab`: бесплатный Захват NPC ищется по `options` `action:grapple`; кнопка «Применить» нажимается, если Захват не применился сам. `onevent-strike`/`improved-grab` правят `system.attackEffects.value` первого `melee` NPC.
- `when`: предикат `target:trait:<первая черта цели>`; `badge`: эффект Bless (`spell-effects`), счётчик значка и `_stats.compendiumSource` у созданной копии.
- `damage-step`: `3d1` untyped, ожидается ровно −3 ОЗ (у цели нет сопротивлений); откат урона pf2e имитируется записью ОЗ.

## strike-gate (`strike-gate.js`)
Те же требования и приёмы, что у `pa05.js`. `window.__afStrikeGate = { only: [...], skip: [...], cleanOnly: false }`; результат — `window.__afStrikeGateResult`.
Сценарии (id): `hit`, `miss`, `stale`, `npc-copies`, `crit-only`. Правило `onEvent.afterUse` — флагом на временном предмете-действии (не каталог); «испытание запустилось» — новое сообщение с `flags.pf2e-automato.use.state.event`. Нужен `mode.challenge` не `off`, иначе `SKIP`.
Хрупкое: бонус атаки подкручивается под КЗ цели через `strike.totalModifier` (d20=10 — попал, 19 — крит, 1 — промах); Удар PC — безоружный (первый `isMelee` в `system.actions`); `stale` опирается на `pf2e.startTurn` и два `nextTurn()`.

## zone-trigger (`zone-trigger.js`)
Те же требования и приёмы, что у `repeat-save.js`. `window.__afZoneTrigger = { only: [...], skip: [...], cleanOnly: false }`; результат — `window.__afZoneTriggerResult`. Область — временный регион сцены «AF тест», поведение вешает `api.attachZone`.
Сценарии (id): `start-turn` (в области в начале хода — бросок, вне — нет), `enter-move` (вход движением — карточка; область, созданная поверх токена, — без карточки), `per-round` (вход и конец хода в одном раунде — один бросок, в следующем раунде — снова).
Хрупкое: вход движением идёт через `TokenDocument.move` (нет — `update({x, y})`); исход — фиксация d20; карточка триггера опознаётся по ключу `trg:` в `use.state.event`.

## emanation-follow (`emanation-follow.js`)
Те же требования и приёмы, что у `zone-trigger.js` (без боя). `window.__afEmanation = { only: [...], skip: [...], cleanOnly: false }`; результат — `window.__afEmanationResult`. Эманация 10 фт — регион сцены «AF тест» с фигурой `emanation` (`base.type:"token"` от токена NPC-заклинателя), поведение вешает `api.attachZone`; карточка-владелец зоны — временное сообщение со `state.zone`.
Сценарии (id): `walk` (заклинатель идёт: `attachment.token` стоит, фигура сместилась, наезд на стоящую жертву — одна карточка, заклинатель карточек не получает и не «мигает» состоянием зоны), `undo` (откат хода `revertRecordedMovement` — без новой карточки), `delete` (токен удалён — регион удалён ядром, карточка `closed`), `follow-false` (регион не привязан, стоит), `path` (`enterBy:"path"`: проход мимо жертвы, в конце не накрывает — одна карточка), `path-end` (тот же проход по умолчанию — карточки нет), `stay` (`onCarrierGone:"stay"`: токен удалён — регион жив, привязки нет, status `active`).
Хрупкое: исход — фиксация d20; `stay` опирается на отмену удаления в `preDeleteToken` и повторное удаление токена после отвязки (проверяет и то, что токен действительно удалён); `walk`/`undo` — на порядок ядра `regionBoundary` -> `moveToken` -> `tokenEnter(null)` (`detail` называет, чего не хватило); `undo` стартует бой (ядро пишет историю движения только в начатом бою); радиус эманации — в пикселях (200 = 10 фт); позиции под сетку 100 px / 5 фт.

## aura-trigger (`aura-trigger.js`)
Те же требования и приёмы, что у `zone-trigger.js` (бой делается просматриваемым — `viewCombat`). `window.__afAuraTrigger = { only: [...], skip: [...], cleanOnly: false }`; результат — `window.__afAuraTriggerResult`. Носитель — NPC «AF тест: носитель» (несвязанный токен), правило `onEvent side:"near"` лежит флагом на временной способности «AF тест: аура страха» (для сценариев с `aura` — вместе с Aura RE pf2e `af-fear-aura`, радиус 30 фт); нет `token.auras` после создания — `SKIP`; `outcomes` требует `mode.challenge` и `mode.apply` = `auto`, иначе `SKIP`.
Сценарии (id): `enter-once` (PC входит — одна карточка; вышел и зашёл в том же раунде при `per:round` — без второй), `turn-end-per` (конец хода внутри в раунде входа — повтора нет; следующий раунд — снова), `outcomes` (провал — испуг и карточка в следующем раунде; успех — иммунитет и тишина), `range` (аура `range` без Aura RE: остановка снаружи — нет, вход — карточка), `carrier-moves` (носитель подходит к стоящей жертве — карточка).
Хрупкое: исход — фиксация d20 против СЛ 15; вход идёт через `TokenDocument.move` (метод `api`) и хук `moveToken`; позиции рассчитаны на сетку 100 px / 5 фт; карточка опознаётся по ключу `trg:` в `use.state.event`.

## repeat-save (`repeat-save.js`)
Те же требования и приёмы, что у `strike-gate.js`. `window.__afRepeatSave = { only: [...], skip: [...], cleanOnly: false }`; результат — `window.__afRepeatSaveResult`.
Сценарии (id): `apply`, `save-success`, `save-fail`, `author-gone`, `fear-drops` (испуг 1 падает сам — обёртки нет, карточек нет), `undo` (успех повтора -> `undoOps` карточки -> носитель и состояние вернулись). Правило — флаг на временном предмете-действии: Воля СЛ 20, провал и крит. провал -> замедление 1 (`slowed`; в `fear-drops` — испуг 1) с `repeat: {on: "turn-end", end: [success, criticalSuccess]}`; автор (PC) и цель (NPC-гоблин) в бою. «Повтор запустился» — новое сообщение с `flags.pf2e-automato.use.state.event`. Нужны `mode.challenge` и `mode.apply` = `auto`, иначе `SKIP`.
Хрупкое: исход повтора задаётся фиксацией d20 (20 — успех, 1 — провал) против СЛ 20; опирается на `pf2e.endTurn` и `combat.nextTurn()`; `author-gone` удаляет токен и актёра автора посреди боя.

## forced-move (`forced-move.js`)
Те же требования и приёмы, что у `repeat-save.js`. Запуск: вкладка активного ГМа (на сцене любой мир, модуль включён, mode.challenge/apply = auto) -> консоль -> вставить содержимое `tests/live/forced-move.js` как async-функцию и `await` её вызова. `window.__afForcedMove = { only: [...], skip: [...], cleanOnly: false }`; результат — `window.__afForcedMoveResult`.
Сценарии (id): `push` (толчок 10 фт, 600 -> 800, запись `moved`), `wall` (стена на пути: стоп перед ней), `pull` (притяжение вплотную к автору), `undo` (`undoOps` возвращает позицию), `no-reaction` (страж с Реагирующим Ударом рядом: шёпота реакции нет).
Сценарии области: `point` (взрыв радиуса 150 в (550,550), цель в (600,500): толчок 10 фт от центра -> 800, а не от автора внизу слева), `order` (три цели в ряд 600/700/800, толчок 5 фт, auto: все сдвинуты, значит дальняя шла первой). Область — круглый регион pf2e с `flags.pf2e.messageId` карточки, создаётся сценарием после `toMessage`.
Хрупкое: исход фиксируется d20=1 против СЛ 20 (провал/крит. провал); стена и позиции рассчитаны на сетку 100 px / 5 фт, автор в (500,500) (в `point`/`order` — в (100,1000)); `point`/`order` опираются на `testInsideRegion` токена по кругу и на то, что pf2e-region с `messageId` запускает `runRegion` (`detail` называет, что не сошлось).
