# План L1-W02: способность фамильяра покровителя при сотворении/поддержании наговора (волна 4, ведьма)

Статус: **проект, код не писан; версия 2 по замечаниям Критика.** Опора: `plan.md` §13, `docs/level1-witch-tasks.md` (L1-W02, WF01..WF16), `docs/plan-sustain.md` (волна 1 реализована), `docs/plan-youre-next.md` (`cost`/`free`/`choose`/`check`).
pf2e — локальный `systems/pf2e/pf2e.mjs` (`pf2e:строка`), снимок 8.6.1 — `tools/out/items.json`. Все 16 способностей имеют один запуск: «When you **Cast or Sustain a hex**» (`familiar-abilities`: 117 документов, 16 с этим текстом). W03 (один наговор за ход) из плана вынесен — см. «Дальше».

## 1. Источник события

| Что | Как узнаём | Статус |
|---|---|---|
| Сотворение | `eventOfMessage` -> `"spell-cast"` (`origin.type==="spell"`, `useKindOf==="use"`, `origin:action:slug:cast-a-spell`, `pf2e:94`). Карточка-описание = `card`, события нет (W01). | есть |
| «Это hex» | `origin:item:trait:hex` в опциях сообщения (как `origin:item:trait:composition` у Lingering Composition, `rules/catalog.json:33`). В `plan-sustain.md` §4.1 написано `item:trait:hex` — неточно, поправить. | есть |
| Поддержание | pf2e события не даёт. `sustain.mjs:count()` возвращает `"fresh"` ровно раз за раунд на якорь, но никому не сообщает. | **нужен хук** |

**Событие Поддержания — общее `spell-sustain`** (как в `plan-sustain.md` §4 п.2, `EVENT_ON` += `spell-sustain`), а не скрытый смысл `spell-cast`. Чтобы одна запись способности ловила оба: поле `on` принимает **массив** `["spell-cast","spell-sustain"]` (валидатор `vEvent` `rules.mjs:627`, `matchEntries` `events.mjs:83` сравнивает через `[].concat(entry.on).includes(on)`; одиночная строка работает как раньше). Предикат записи на Поддержание — `when` по опциям события `spell-sustain` (см. п.3), без особых имён.

Что добавить:
1. `sustain.mjs`: реестр `export const sustained = new Set()` (как `hold.replayers`); `count()` при `"fresh"` вызывает слушателей `({anchor, actor, pos})` **без ожидания** (`void`/`.catch`): иначе `queue("sustain:"+key)` держится на окне выбора (`askChoice`) и блокирует следующий клик. `events.mjs:init` подписывается и вызывает `runSpellEvent("spell-sustain", …)`.
2. **Опции для `when` при Поддержании** — из **заклинания якоря**: `fromUuid(anchor.flags[MOD].sustain.src)` -> `spell.getRollOptions("origin:item")` (+ опции ведьмы `self:*`), поэтому `origin:item:trait:hex` работает одинаково на cast и sustain. Сообщения-карточки при Поддержании нет, берём не его.
3. **Автоякорь.** Якорь сейчас создаётся только шагом `sustain:true`. Для Evil Eye и прочих наговоров его нет, Поддержание модулю неизвестно. Решение: на `spell-cast` с `origin:item:trait:hex`, `duration.sustained` и при наличии у ведьмы фамильяра с записями `side:"familiar"` создаём якорь тем же `anchorKey(message.id)` (`sustain.attach`, правка: `target` необязателен, `actors:[]`). Ключ тот же, что у шага `sustain:true`, поэтому у Information Overload якорь один (идемпотентно по `meta.key`).
   Это **меняет решение `plan-sustain.md` §11 «якорь из `duration.sustained` не делаем — волна 2»**: оно касалось системного эффекта заклинания (Workshop), а здесь якорь создаётся по сообщению сотворения и правилу фамильяра; в §11 `plan-sustain.md` добавить одну строку об этом.
   **Шум шёпотов:** `offer` (кнопки) и «пропущено» на каждый Evil Eye — гасим: для якоря без получателей (`actors:[]`, автоякорь) `offer` шлётся только автору (не ГМу) одной компактной строкой, а шёпот «пропущено» — вообще не шлём (проверка `actors.length`); эффектов к снятию нет.
4. **Ключи и дедуп.** Ключ запуска — `ev.id` (сообщение / `${anchorKey}:${round}`), не `ev.key` (он только у `side:"near"`). Сотворение: журнал `events` + `fired`; Поддержание: `count()` раз за раунд + `fired`. Исполняет только `guardActiveGM()`; повтор сообщения и два клиента отсекаются. **Вне боя** (`pos.round == null`): `count()` не отсекает по раунду, дедуп — окно 6 с по ключу (как `plan-sustain.md` §4.2); пропуска нет.
5. **Две цели сотворения** (`messageTargets` даёт список, `onMessage` крутит `go(t,…)` по каждой): запись `side:"familiar"` исполняется **один раз на сообщение**, как записи с `check` (`go(null, message.id, true)`, `events.mjs:~635`), а не по разу на цель.

## 2. Связанный фамильяр и его токен

- `FamiliarPF2e.master` (`pf2e:36201`) = `game.actors.get(system.master.id)` только для `character`; обратной ссылки в данных нет (`master.familiar` — ленивый). Поиск: `familiarsOf(witch) = game.actors.filter(a => a.type==="familiar" && a.system.master.id===witch.id)` (чистая функция, `scripts/familiar.mjs`).
- **Токен:** на сцене токена ведьмы — `witchToken.parent.tokens.filter(t => t.actorId === fam.id)` (документы токенов сцены, не `getActiveTokens`: работает без холста/не на активной сцене; для незалинкованных копий проверяем `actorId`). Несколько токенов — первый видимый.
- Исполнение — от лица **ведьмы** (владелец окон — владелец ведьмы, `apply.chooserOf`); токен фамильяра — только центр отсчёта. Владелец фамильяра не спрашивается.
- Нет фамильяра / нет токена на этой сцене: запись молчит, ГМу один шёпот за сессию на ведьму. Запасного центра от токена ведьмы нет.
- **Фамильяр с 0 ОЗ или `unconscious`/мёртв — способность не запускается** (решение Руководителя); проверка `hp.value<=0 || hasCondition("unconscious") || isDead`.

## 3. Где лежит способность

- Способность — предмет типа `action` на **актёре-фамильяре** (`allowedItemTypes` включает `action`, `pf2e:36198`). Носитель ищем только там: `eventItems(familiar)` (`events.mjs:165`). «На ведьме» не поддерживаем, схлопывания и второго прогона нет.
- Что именно кладёт `familiar-witch` `GrantItem` по снимку не определить: проверка живая (§7, шаг 0). Если способность окажется не на фамильяре — это блокер, пересмотр плана, а не запасная ветка.
- **Каталог:** записи — в `rules/catalog.json` (`catalog.pa.json` генерируется `tools/pa-port.mjs`, ручные правки в нём пропадут). Ключ правила заменяется **целиком**, поэтому `onUse` Restored Spirit (сейчас в `catalog.pa.json:391/924`) **переносится** в запись `catalog.json` рядом с новым `onEvent` — иначе ручное применение пропадёт.

## 4. Контракт записи

```json
{"on":["spell-cast","spell-sustain"],"side":"familiar","when":["origin:item:trait:hex"],
 "apply":[ {"choose":{"from":"creatures","range":15}},
           {"to":"chosen","effect":{"uuid":"…"},"duration":{"value":1,"unit":"rounds","expiry":"turn-start","of":"origin"}} ]}
```

`side:"familiar"` (значение `EVENT_SIDES`, `rules.mjs:592`; допустимо только с `on` из `spell-cast`/`spell-sustain`): запись лежит на предмете фамильяра ведьмы-автора. Записи других сторон на `spell-sustain` не реагируют.

Движок уже умеет:
- **Расстояние от фамильяра:** `choose.range` от `originToken` (`apply.mjs:612`), `execEntry` берёт `ev.ownerToken` (так сделан `fireNear`, `events.mjs:457`); для familiar — токен фамильяра.
- **Срок:** `duration{1, rounds, turn-start, of:"origin"}` (`rules.mjs:1091`) — до начала хода ведьмы-автора.
- **Отказ:** закрытие окна выбора — шаги не исполняются (`apply.mjs:621`).
- Откат/дедуп — `undoLog`, `fired`, журнал.

**Новое (минимум):**
1. `side:"familiar"` + `on` массивом (§1).
2. `choose.from:"creatures"`: любое существо в `range` от токена фамильяра **кроме самого фамильяра**; в `allies` фамильяр (токен-центр) тоже исключается. Ведьма как кандидат: по тексту WF01/WF07/WF10 «creature» — да, кандидат (сама ведьма — существо в 15 ft; если токен ведьмы вблизи); WF09 «willing creature» — да, `withSelf:true` — ведьма. Реализация: `alliesIn` с отношением «любой» и `withSelf:true`.
3. `choose.where`: предикат по опциям **кандидата** (`getRollOptions()`). WF07 — `{"lt":["hp-percent",50]}`: pf2e пишет `hp-percent:N`, `N = floor(value/max*100)` (`pf2e:20160`), поэтому `N<50` ⇔ `value/max<0.5`, строго «меньше половины» (ровно половина — не кандидат). Предикатный `lt` над префиксным числом поддержан и pf2e (`pf2e:3965`), и `predicate.mjs:34`; виртуальной опции не нужно. Покрыть тестом (5/10, 4/10, 49/100, 50/100).
4. **Исполнение записи `side:"familiar"` без `other`:** `other = null`, испытание/проверка — по выбранному `picks.actor` (как «полная проверка» Ты следующий, `events.mjs:282`), а не по `ev.other`.
5. `confirm:true` (окно «да/нет» без траты реакции) — не в первой партии; нужно WF13/WF14/WF08.

**Порог примитива** (~30 документов): прямых потребителей `side:"familiar"` — 16 (<30), нового механизма не вводим: значение стороны, массив `on`, `from:"creatures"`, `where`. Событие `spell-sustain` с хуком окупается шире — ≈30 документов классовых черт покровителей (`W20–W35`) и `plan-sustain.md` §4.

## 5. Первая партия: WF01, WF06, WF07, WF09, WF10

(`WF16` убран из первой партии — вместе с `once/round` позже.) Записи — в `rules/catalog.json` (по правилам владения интегратор), общий `when:["origin:item:trait:hex"]`, срок как в §4, если не оговорено. В снимке у способностей собственных RE нет.

| WF | Запись | Эффект | Отрицательный сценарий |
|---|---|---|---|
| **WF01** Balanced Luck | `choose from:"creatures" range:15`; затем `choose from:"options"` (+1/−1, `value:"plus"/"minus"`); два шага `to:"chosen"` с `when:["choice:plus"]` / `["choice:minus"]`, **с `choice`**: выбор передаётся в `selection` ChoiceSet эффекта (`apply.mjs:434`, `ctx.choice`) | `0JvxhEv83bAD5PGv` — у него свой ChoiceSet: без передачи selection pf2e спросит второй раз; проверить живьём | закрытое окно — эффекта нет; цель дальше 15 ft **от токена фамильяра** — нет в списке; повтор в том же раунде не плодит второй эффект (pf2e stacking по status) |
| **WF06** Bolstering Aid | `choose from:"allies" range:5` -> `to:"chosen"` | `IgLMAwovQ9roTsRN` (+2 status к следующей не-атакующей skill check) | враг/дальше 5 ft — не кандидат; сам фамильяр не кандидат; расходуется не на атаку |
| **WF07** Parasitic Might | `choose from:"creatures" range:15 where:{"lt":["hp-percent",50]}` -> `challenge` Fortitude, `dc:{source:"spell"}`, `failure`/`criticalFailure` -> `sickened 1` (`fesd1n5eVhpCSS18`) | состояние без срока по тексту. **Кто бросает: выбранное существо** (Fortitude цели); **СЛ — ведьмы, из записи колдовства самого наговора**: на cast — `message.item.spellcasting`, на Поддержание — заклинание якоря (`fromUuid(src).spellcasting`); значение передаётся в `hostChallenge({dc})` явно, не через `dc.source:"spell"` по первой записи актёра (закрывает мультикласс) | ровно половина ОЗ — не кандидат; нет кандидатов — `apply.noCandidates`; ГМ может править СЛ кнопкой «СЛ» карточки; иммунитет к sickened — ГМ/штатно |
| **WF09** Restored Spirit | `choose from:"creatures" range:15 withSelf:true` (согласие — выбор игрока) -> `to:"chosen"` | `twvhTLrLEfr7dz1m` (2+⌊level/2⌋ temp HP; на 1 ур. 2), перенесён вместе с `onUse` в `catalog.json` | второй источник temp HP не суммируется (берётся больший, pf2e); дальше 15 ft не кандидат |
| **WF10** Paired Perplexity | `choose from:"creatures" range:20` -> `to:"chosen"` | `stupefied 1` до начала следующего хода ведьмы, `of:"origin"`; без спасброска | иммунитет к visual effect **не покрыт** (`isImmune` не знает его): остаётся решением ГМа, в запись не вносим; закрытое окно = отказ |

Позже: WF02/WF05 — область у токена фамильяра (`zone`, спайк §4.3 `plan-sustain.md`); WF03 — flanking без глобального off-guard; WF04 — относительное восприятие + ГМ; WF08 — Recall Knowledge ведьмой (`check`); WF11 — сделана 2026-11-06 (`docs/plan-rustyspirit.md` P1); WF12 — `choose options` + `4wJM0OA9y2gsBAh7`; WF13/WF14 — `confirm`/`move`; WF15 — `move push` от `ownerToken`; **WF16 — вместе с `once/round`**.

## 6. Дальше (вне этого плана)

- **W03, один наговор за ход:** отдельный шаг позже. Единственная возможная pre-точка — обёртка `SpellcastingEntryPF2e.cast` (`pf2e:53699`, до `consume`); решение отложено, пока обёртка не оценена. Честного запрета по `spell-cast` post-event дать нельзя.
- **Cackle (W42):** по букве — сотворение Cackle (hex, `spell-cast`) и вложенное Поддержание (`spell-sustain` через кнопку якоря) дают **два запуска**; особого механизма нет.

## 7. Тесты

**Юнит** (`tests/familiar.test.mjs`, `node --test`; образец `tests/sustain.test.mjs`):
1. `familiarsOf`/токен: по `system.master.id`; чужой фамильяр не берётся; токен — по `scene.tokens`, не `getActiveTokens`; **токен фамильяра на другой сцене / сцена не на холсте** -> молчание, не падение.
2. Валидатор: `on` массив и строка; `side:"familiar"` только с `spell-cast/spell-sustain`; `from:"creatures"`, `where` — валидны/ошибки; регрессия `tests/sustain-rule.test.mjs`, `tests/youre-next.test.mjs`.
3. Запуск: hex-cast -> запись; не-hex -> нет; карточка-описание -> нет; **Поддержание не-hex якоря не запускает** (опции берутся из заклинания якоря, `origin:item:trait:hex` отсутствует); Поддержание hex-якоря запускает.
4. **Две цели сотворения -> один запуск** (`side:"familiar"` раз на сообщение).
5. Дедуп: один `message.id` дважды — один запуск; `count()` `again` — события нет; `fresh` — одно; не-активный ГМ — ноль; ключ по `ev.id`.
6. WF07: **кто бросает** (выбранная цель) и **чья СЛ** (из `spellcasting` заклинания, не из первой записи актёра; ведьма-мультикласс); `where` — 5/10 нет, 4/10 да, 49/100 да, 50/100 нет.
7. Расстояние от токена фамильяра, не ведьмы; фамильяр не кандидат в `allies`/`creatures`; фамильяр с 0 ОЗ/unconscious — не запускает.
8. Cackle: cast + нажатие «Поддержать» на якоре = два запуска (разные ключи `ev.id`).
9. Автоякорь: тот же `anchorKey(message.id)`; у Information Overload якорь один; для `actors:[]` нет шёпота «пропущено» и `offer` не уходит ГМу.
10. Каталожный: 5 записей первой партии валидны, `effect.uuid` есть в снимке, срок `turn-start of origin`, `onUse` Restored Spirit сохранён в `catalog.json`.

**Живые** (`tests/live/level1-familiar.js`, каркас `tests/live/level1-sustain.js`: `bound`, `waitFor`, `sweep` по префиксу «AF тест: »; по одному, вкладка ГМа):
- **Шаг 0:** у «Фейя (ведьма)» (папка «Герои 1 ур. (автоматизация)») есть patron, the-resentment, familiar-witch, hex-spells, witch-spellcasting, cackle; hex-заклинания evil-eye, cackle, phase-familiar; focus 2/2. **Актёров `familiar` в мире нет; патрон Фейи — Горечь (WF11, заблокирована).** Поэтому: копия Фейи «AF тест: …» + актёр `type:"familiar"` «AF тест: фамильяр» (`system.master.id` = копия), токен на тестовой сцене; способность WF01/06/07/09/10 выдаётся предметом из `familiar-abilities` **на фамильяра**; сверить, где её кладёт `GrantItem` на настоящей сборке.
- Сценарии: (1) Evil Eye cast -> окно WF10 -> stupefied 1 до начала хода ведьмы; закрытое окно — нет эффекта; (2) Поддержание следующего раунда (автоякорь) -> запуск; (3) cast + Sustain в одном раунде — по правилам Sustain один за раунд, cast и Sustain — два запуска; (4) не-hex cantrip — ничего; (5) Cackle: cast + Поддержание = два запуска; (6) две цели сотворения -> одно окно; (7) токен фамильяра убран со сцены -> шёпот ГМу; (8) фамильяр на 0 ОЗ — тишина; (9) WF07 при ОЗ 5/10 и 6/10, СЛ = СЛ колдовства копии Фейи; (10) WF01: селектор эффекта не спрашивает второй раз; (11) повторный клик/два клиента — без дубля; (12) шум шёпотов: нет «пропущено» ГМу на каждый Evil Eye.

## 8. Риски и открытые вопросы

- Место способности по снимку не определено — проверка шага 0; не на фамильяре — блокер.
- Селектор ChoiceSet у `0JvxhEv83bAD5PGv` и совпадение `choice` — проверить на живом эффекте (в `items.json` эффектов нет).
- `origin:item:trait:hex` в опциях сообщения и в `spell.getRollOptions("origin:item")` — проверить живьём.
- Автоякорь для каждого sustained-hex ведьмы с таким фамильяром: следить за лишними якорями/шумом.
- Поддержание, не прошедшее через кнопку/разбор чата, модулю неизвестно (общий риск `plan-sustain.md` §7).
- Порядок «до/после эффекта наговора»: окно выбора открывается сразу при сотворении и ждёт ответа игрока; жёсткого порядка нет.
- Иммунитет к visual effect (WF10) и 0 ОЗ/потеря фамильяра в середине эффекта — ГМ.
- Живой прогон — только на временных актёрах; реальной WF-способности патрона Фейи нет.

## 9. Владение и очередь

`scripts/familiar.mjs` (поиск, `runSpellEvent`, нужные проверки) — новый файл исполнителя класса; точечно `events.mjs` (`runEvent`/`onMessage`: `side:"familiar"` раз на сообщение, `ownerToken`; `matchEntries` с массивом `on`), `sustain.mjs` (реестр `sustained`, `attach` без получателя, тишина для автоякоря), `apply.mjs`/`rules.mjs` (`creatures`, `where`, `on`-массив, `side:"familiar"`, `spell-sustain`); форма `sheet.mjs`, Мастерская, `lang/*`, каталоги — один интегратор. Порядок: (1) `spell-sustain` + хук + автоякорь; (2) `side:"familiar"` + `on`-массив + `creatures`; (3) WF10, WF09, WF06, WF01; (4) `where` + WF07; (5) `confirm` и остальные WF.

## 10. Статус реализации
2026-11-05: первая партия реализована (WF01/06/07/09/10, `side:"familiar"`, `spell-sustain`, `on` массивом, автоякорь sustained-hex, `scripts/familiar.mjs`). План — Критик + перепроверка; код — Критик (P1 валидатор, P2 ×9) + перепроверка (регулярка Мастерской исправлена). Шаг 0 закрыт вживую: способность лежит только на актёре-фамильяре, GrantItem нет; `origin:item:trait:hex` в опциях есть. Юнит: `tests/familiar.test.mjs`. Вживую (`tests/live/level1-familiar.js`) 9/9 = 43 проверки; регрессия level1-sustain 3/3, level1-rogue 6/6, batch2 6/6. Осталось: W03, WF16 (once/round), остальные WF, P2-4 (порядок автоякоря и якоря шага `sustain:true` у будущего hex) — комментарий в `sustain.mjs`.
