# План: примитив `move` (принудительное перемещение)

Ветка `worktree-agent-aebfe7002cd63c536`, база `pack-1-save-conditions` (846b026); ссылки file:line сверены с ней. Foundry v14.366, pf2e 8.6.1. Только план, код не тронут.

## 1. Масштаб (регулярка по `tools/out/items.json`, `descEn`, без `dupTop`, 39 748 документов)
Грубо, без ручной чистки; подвиды пересекаются.

| Подвид | Документов | Примеры |
|---|---|---|
| push: «pushed N feet», «push … away» | ~310 | Shove, Spinning Crush, Air Gate |
| исход Success/Failure с «pushed/pulled/moved N feet» | ~107 (почти все внутри push) | Forceful Shot, Scattering Shout |
| pull: «pulled toward you / to an adjacent square» | ~41 | Lassoing Lash, Feed the Void |
| «move the target up to N feet» (клетку выбирает игрок) | ~10 | Reposition, Telekinetic Haul |
| teleport ЦЕЛИ (слово «teleport» всего 450+, в основном «себя») | ~50 | Sudden Transposition, Far-Flung Fetch |
| явный «forced movement» | ~75 (часть про «принудить Stride» — не наше) | Drag Down, Statue Form |
| **Итого уникальных** | **~480** (action 216, feat 93, spell 100, остальное ~70) | |

Дистанция в тексте: 5 фт — 136, 10 фт — 140, 15 — 17, 20 — 23, 30 — 20, 40+ — ~25. Дистанция «по степени» отдельного поля не требует (см. §2).

Долг пачки 1: `rules/drafts-accepted/b01-save-conditions.json` — 98 записей `needs-primitive`; с push/pull/teleport/forced movement в `reason` ~25 (push N/N ft ~17, pull 1, teleport 4, forced movement 3, forced fall 2). Цифра «~60» из задания включает «forced action» (~12) и «triggered save on move» (~4) — это ДРУГИЕ примитивы, в `move` не входят.

## 2. Решение: один шаг `move`, режимы push и pull в v1
Новый вид шага (`scripts/rules.mjs:87` `STEP_KINDS`; ROADMAP §3 «не больше одного примитива на пачку»):
```json
{ "to": "target", "move": { "mode": "push" | "pull", "distance": 10, "from": "origin" } }
```
- `distance` — целое, кратное 5, >=5. Дистанция по степени НЕ вводится: есть `challenge.byDegree` / `check.byDegree` (`rules.mjs:301`, `:373`), в каждой степени свой шаг `move` (Shove: успех 5, крит 10).
- `from`: `"origin"` (токен автора, по умолчанию) или `"point"` (центр области/зоны — «pushed from the emanation»; только при `ctx.region`, иначе шаг пропущен + уведомление ГМу, как `visSkip`, `apply.mjs:532`).
- `push` — по лучу «автор -> цель» ровно N футов или до препятствия. `pull` — по тому же лучу к автору, максимум N, останавливается вплотную (в соседней клетке).
- «Up to» трактуем как максимум; игрока не спрашиваем (ROADMAP §7: никаких кнопок для того, что модуль делает сам).
- Получатель: `to:"target"` (и группы через общий разворот `jobs`, `apply.mjs:446`). `to:"self"` не в v1.
- Условия — существующими полями: `when` (`apply.mjs:458`), `who`, `rank`. «Только Large или меньше» — `when` по roll options цели (`target:size:*`; существование проверить, см. §8) либо резервное поле `maxSize`.
- «Сбить с ног и толкнуть» — ДВА шага подряд (`condition prone` + `move`): `vApply` требует один вид на шаг (`rules.mjs:110`).
- Валидатор: блок `a.move` в `vApply` (`rules.mjs:96`) по образцу `a.damage`; ключ ошибки `move.bad`, строки `rules.err.move.bad` ru+en. `ruleToForm`/`formToRule` (`scripts/sheet.mjs`) — обязательны для примитива (ROADMAP §3).

## 3. Геометрия и клетки
Новый `scripts/move.mjs`: чистая часть без Foundry (как `rules.mjs`) + тонкая обёртка.
- Чистая `forcedPath({from, to, size, distance, mode, blocked(cell), cost(cellA,cellB)})` -> `{cells, end, stoppedBy: null|"wall"|"creature"|"edge"|"limit"}`. Токен — прямоугольник w x h клеток. Направление: вектор центр автора -> центр цели; шаг по клеткам, ближайшим к лучу на каждом 5-футовом шаге; диагональ 5/10/5 как в pf2e (счётчик внутри функции). Остановка ПЕРЕД первой недопустимой клеткой. Нулевой путь — не ошибка: шаг пропущен с причиной `blocked`.
- Обёртка Foundry: стены — `CONFIG.Canvas.polygonBackends.move.testCollision(from, to, {type:"move", mode:"any"})`; занятость — токены сцены на той же `elevation`, чей прямоугольник пересекает целевую клетку (pf2e не даёт закончить в занятой клетке). Падение, лаву, ловушки НЕ считаем.
- Перенос: `td.move([{x, y, action:"displace"}], {constrainOptions:{ignoreWalls:true, ignoreCost:true}, showRuler:false, autoRotate:false})` — `TokenDocument#move` (`client/documents/token.mjs:707`), действие `displace` (`client/config.mjs:2439`). Стены учтены нашим расчётом; встроенное ограничение v14 остановило бы токен молча, и честного журнала не получилось бы.
- pf2e в `pf2e.mjs` использует опцию `forced-movement` (2 вхождения; контекст проверить, §8). Свои реакции модуля и события зон (`events.mjs`, `zone.mjs`) получают `{[MOD]:{forced:true}}` в опциях апдейта и не считают это добровольным движением (не запускают «вошёл в зону — испытание» дважды).

## 4. Исполнение, журнал, откат
- Исполняет активный ГМ внутри `applyOps` (`apply.mjs:426`; `plan.md` §2 «apply.mjs … ТОЛЬКО на клиенте активного ГМа»; пути входа — `events.mjs:204`, `saves.mjs:354`). Права игрока не нужны.
- Ветка `if (step.move)` рядом с `step.damage` (`apply.mjs:508`), до общего `applyCondition/applyEffect`. Идемпотентность по `meta.key` и `doneOps` + очередь `queue(\`msg:${id}\`)` как у урона: повтор карточки и переброс испытания не двигают токен второй раз.
- `immuneToTraits` (`apply.mjs:463`) на `move` не распространять (иммунитетов к перемещению по чертам нет).
- Журнал: `{op:"moved", token:<uuid>, from:{x,y,elevation}, to:{x,y,elevation}, movementId, key}`; нулевой путь — `{op:"moved", skipped:"blocked", key}` (строка считается отработанной, как `vis skipped`) + `notify("move.blocked")`.
- Откат: ветка в `undoOps` (`apply.mjs:589`): токен всё ещё в `to` — `td.revertRecordedMovement(movementId)` (`token.mjs:~722`); иначе ничего, `notify("move.undoMoved")`. `skipped` пополняет пропуск в `apply.mjs:596`.

## 5. Тесты
- Юнит `tests/move.test.mjs` (node, без Foundry): `forcedPath` — 4 стороны, диагональ 5/10/5, стена через 2 клетки, занятая клетка, Large 2x2 в углу, pull вплотную, pull на соседнюю клетку (нулевой путь), distance больше доступного, край сцены.
- Валидатор: `distance` не кратна 5, неизвестный `mode`, `from:"point"` без области, `move` + `condition` в одном шаге.
- `applyOps` с моками в стиле `tests/apply.damage.test.mjs`: запись `moved`, повтор не двигает, `undoOps` возвращает позицию, уже сдвинутый токен не откатывается.
- Живой сценарий (ROADMAP §7: актёры «AF тест: …», вкладка ГМа на about:blank): Shove через Athletics/byDegree (крит 10 / успех 5, цель Large, стена за спиной), заклинание-притяжение из b01, откат карточкой, переигрывание испытания, автор без токена.

## 6. Не в этой пачке (v2)
- `mode:"teleport"` цели (~50) и «move up to N» с выбором клетки (~10, Reposition): нужен выбор точки на холсте автором (по образцу `askChoice`, `apply.mjs:365`) и проверка дальности/линии эффекта — отдельный механизм, отдельная пачка.
- «Принудить Stride/Step» (`forced action`, ~12 в долге) — другой примитив (чужое действие).

## 7. Сознательно не делаем
- Падение, лава, ловушки, урон «если упёрся в стену» — остаётся `note`, применяет ГМ руками.
- Другие сцены/этажи (`level` v14): только та же сцена и `elevation`.
- `from:"origin"` без токена автора — шаг пропущен с уведомлением.
- Кнопок «подтвердить перемещение» нет; откат — карточкой.

## 8. Открытые вопросы
1. Есть ли у pf2e roll options размера цели (`target:size:*`) для `when`, иначе вводим `maxSize`.
2. Что значит `forced-movement` в `pf2e.mjs` (опция домена, трейт, особенность Stride).
3. Луч по центрам клеток или 8 направлений сетки при диагональном push (гекс-карты — свой обход).
4. Проход «сквозь» занятую клетку: pf2e запрещает лишь закончить в ней; в плане — остановка перед занятой (консервативно).
5. Сравнение: в `pf2e-automations` (`src/index.js`, минифицировано) примитива перемещения не найдено; `pf2e-toolbelt` тоже не делает. Проверено поверхностным grep.

## 9. Реализовано (правки по разбору Критика; перекрывают разделы выше)
- `from` убрано: только токен автора (`from:"point"` — позже). `maxSize` не нужен: размер — `when` `{"lte":["target:size",3]}`. Валидатор: только `to:"target"`, ключи только `mode` и `distance`.
- Очередь `msg:` в шаге НЕ берётся (нереентерабельна); идемпотентность — журнал `doneOps` по ключу без степени (`c.<i>` в испытании).
- Геометрия — `grid.getSnappedPoint` + `grid.measurePath` (диагонали сцены, гексы); пропуск с уведомлением (`moveSkip.*`): другая сцена, нет токена автора, безсеточная или не 5-фт сетка, нулевой путь. Токен на `level` учитывается в `testCollision`.
- Откат: журнал хранит `from`/`to`/`id` (`td.move(..., {id})`); `revertRecordedMovement(id)`, если история есть (она пишется только в бою), иначе `update({...from, action:"displace"}, {isUndo:true, animate:false})`; токен уже сдвинут — не трогаем.
- Реакции: `reactive-strike.onMove` пропускает перемещение, где все `waypoints` — `displace`. Зоны не трогаем: толчок в область — законный вход.
- Порядок целей в `applyByDegree`: толчок — дальние первыми, притяжение — ближние (`moveOrder`).
- Файлы: `scripts/move.mjs`, `rules.mjs`, `apply.mjs`, `saves.mjs`, `chat.mjs`, `sheet.mjs`, `workshop/*`, `templates/workshop-auto.hbs`, `lang/*`, `tests/move.test.mjs`, `tests/live/forced-move.js`.
- Правки по второму разбору: привязка — `target.getSnappedPosition` (гексы, мелкие токены), а не `grid.getSnappedPoint`; `move` запрещён в триггерах зоны и при `onUse.targets:"area"` (`move.bad`; эманацию вокруг автора форма зоны не отличает, поэтому запрет целиком); цель без токена — `moveSkip.noToken`; `target.move()===false` или позиция не изменилась — `blocked`.
- Ограничение: `moveOrder` работает только при «Применить всем». В auto `afterRecord` применяет цели по приходу спасбросков, порядок не гарантирован (отложить до `allResolved` — отдельная доработка).

## 10. Доработка: from:point и порядок
Закрывает два пункта ROADMAP «Открыто». Код: `scripts/move.mjs` (`areaPoint`, параметр `point` у `forcedMove`), `apply.mjs` (шаг `move`), `saves.mjs` (`afterRecord`, `applyByDegree`), `use.mjs` (`moveSorted`), `rules.mjs`.

**from:"point".** Шаг `{move:{mode, distance, from:"point"}}`. Точка берётся из региона использования: `use.state.area.regionUuid` (ставит `runRegion`) либо `ctx.region`. `areaPoint`: одна фигура-круг (взрыв pf2e) — `shapes[0].{x,y}`; `flags.pf2e.areaShape==="emanation"` — центр `region.bounds` (центр рамки = токен-носитель, поэтому эманация «от центра» = «от автора»); конус, линия, прямоугольник — центра нет. Нет точки (регион удалён, форма без центра) — шаг идёт от токена автора, ГМу уведомление `moveSkip.noPoint`; нет и автора — прежний пропуск `noOrigin`. `forcedMove(target, origin, move, point)`: вектор считается от `point`, а не от центра автора; сцену проверяем по `canvas.scene`. Притяжение к точке ограничено целыми клетками до центра, чтобы не проскочить его.
Валидатор: `from` — `origin|point`; при `targets:"area"` разрешён только `from:"point"` (прежний запрет «от автора в области» сохраняется: эманацию вокруг автора форма не отличает), вне области `from:"point"` — `move.bad`; триггеры зоны и `onEvent` — по-прежнему запрет любого `move`. Форма: поле `moveFrom`; Мастерская — выбор «Откуда»; промпт: `from:"point"` вместо `unsure "missing: push from point"`.

**Порядок в auto.** `afterRecord` при `move` в `byDegree` не применяет цель по приходу её спасброска, а ждёт `allResolved` (все с результатом либо иммунны) и один раз зовёт `applyByDegree(msg,"all")`, где `moveOrder` уже сортирует цели (центр — точка области либо автор; повторный `afterChallenge` подавляется флагом). Шаги `onUse.apply` по области (`runRegion`, кнопка «Применить») сортируются тем же `moveOrder` (`moveSorted`). Задержка: до последнего спасброска, зато без таймеров и очередей.

**Риски.** (1) Цель, которая не бросает (игрок ушёл, окно закрыто), держит всю карточку: остаётся «Применить всем». Шаги без `move` в той же карточке тоже откладываются — осознанно, чтобы не плодить два пути. (2) Круг-взрыв pf2e — один круг; составные области, смещённые от центра фигуры (конус как взрыв), откатываются на автора. (3) Центр цели считаем по токену, не по клетке: на гексах и у Large цели возможна ничья по расстоянию — порядок среди равных не определён. (4) `check.byDegree` (одиночный бросок автора) идёт не через `applyByDegree`: порядок по областям там не проверялся. (5) `state.area` по «последнему региону» (§3.C-3) — если ГМ перекинул область, точка берётся из последнего. (6) Живые `point`/`order` не прогонялись (нет браузера): допущения — `testInsideRegion` по центру токена, `runRegion` на регионе с `messageId`.
