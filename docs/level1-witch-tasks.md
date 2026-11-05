# Ведьма первого уровня: задания реализации L1-W

Статус: план и технические задания; реализация рантайма не выполнялась. Главный документ — [plan.md §13](../plan.md).
Источники: локальный снимок pf2e 8.6.1 (`tools/out/items.json` и полный `tools/out/html.json`), текущие каталоги и код.
Системные предоставления и числовые эффекты не дублировать. `ruleKeys` и каталог метаданных refs не доказывают полного исполнения.

## Обязательная основа и общие задания

| ID | Задание | Зависимость / приёмка |
|---|---|---|
| L1-W00 | Fixtures patron/patron-theme, familiar-witch, witch-spellcasting, hex-spells: выбранный покровитель, связанный фамильяр, наговор и стартовый focus spell | L1-C0. По локальному Hex Spells выбор `patrons-puppet` ИЛИ `phase-familiar`, не оба автоматически. Навыки/традиция/grants обслуживаются системой; не создавать новый конструктор персонажа |
| L1-W01 | Различить сотворение, поддержание и факт отправки описания в чат; выбрать конкретное поддерживаемое использование | L1-C1. Поддержание не новый cast, не тратит повторно focus/slot; завершение/пропуск снимает только привязанные эффекты. Нет выдуманного штатного hook: подтвердить API по локальному pf2e; если подходящего события нет, встроенный явный выбор «Поддержать» конкретного использования должен пройти тот же контракт и отдельный тест |
| L1-W02 | Общий запуск способности фамильяра при cast/sustain hex | W00/W01, L1-C2/C3. Один раз за раунд, optional, выбор до/после эффекта; расстояние от фамильяра, СЛ от ведьмы. Дубли сообщения/два клиента не повторяют применение. Обычный не-hex не запускает способность |
| L1-W03 | Проверить локальное ограничение one hex per turn | Подтвердить стадию ДО разрешения эффектов. `spell-cast` post-event сам по себе не способен предотвратить второе сотворение: без подтверждённого pre-use пути — явное предупреждение/ручное разрешение с обозначенной границей, не ложное обещание блокировки. По локальному тексту незаконная попытка теряет действия; не возвращать их молча. Чистое Sustain не учитывается как новый hex |
| L1-W04 | Источник/срок/ресурсы | L1-C3/C4. Один расход фокуса/реакции; один автор и конкретное применение, два покровителя/две цели не конфликтуют; завершение не снимает чужие состояния; graceful no-GM |

## Все 16 покровителей: наговоры и конкретный остаток

У каждого покровителя указана способность фамильяра ниже (F01–F16). Короткие ID заклинаний имеют префикс
`Compendium.pf2e.spells-srd.Item.`. `partial` означает существующую реализацию части механики, а не задачу написать её заново.

| ID / patron slug | Hex cantrip / источник | Текущее покрытие и задача | Первое обычное заклинание покровителя |
|---|---|---|---|
| L1-W20 / `whisper-of-wings` | `murmuration`, `4EmLum6EdvXxbxCj` | needs-handler. Обозначить существо в30 ft от ведьмы при cast; если цель приближается к нему, Will не чаще1/round. По степеням: unaffected / половина / полный 1d4 piercing ИЛИ sonic / оба типа1d4 и −2 status к attack/hostile skill checks этого раунда. Хранить пару цель–обозначенное существо, не заменять движение абстрактным входом в ауру | Gentle Landing |
| L1-W21 / `the-resentment` | `evil-eye`, `f45JpY7Ph2cAJGW2` | done 2026-11-05 (docs/plan-hexes.md, живой level1-hexes). Было: partial: catalog.pa накладывает sickened1/2 на fail/crit. Дополнить минимум1, пока hex активен И ведьма видит цель. Потеря видимости отменяет минимум, не обязательно всё состояние/заклинание; нельзя подменить это бессрочной тошнотой | Enfeeble |
| L1-W22 / `silence-in-snow` | `clinging-ice`, `MraZBLJ4Be3ogmWL` | done 2026-11-05 (docs/plan-hexes.md, живой level1-hexes). Было: partial: catalog.model по Reflex даёт эффект и выбор −5/−10 CIRCUMSTANCE Speed до конца spell. На L1 урон1d4 cold: critSuccess0, success половина, failure полный, critFailure двойной. Проверить применение урона отдельно от эффекта, поддержание и окончание; не считать эффектом сам факт карточки | Gust of Wind |
| L1-W23 / `cobyslarni` | `information-overload`, `PesUKf0lIt5zRofj` | done 2026-11-05 (docs/plan-hexes.md, живой level1-hexes). Было: needs-rule. Will: failure stupefied1, criticalFailure2; успех/критуспех без состояния; срок по заклинанию и W01. Это не штраф к Recall Knowledge или Perception | Déjà Vu |
| L1-W24 / `the-inscribed-one` | `discern-secrets`, `UmXhuKrYZR3W16mQ` | done 2026-11-05 (docs/plan-hexes.md, живой level1-hexes). Было: partial: catalog.model применяет `pzbU0cdyRvE66XBi`. Цель выбирает бесплатное Recall Knowledge/Seek/Sense Motive; +1 STATUS к использованной statistic, пока поддерживается; immunity1min. Проверить выбор statistic, добровольность/тайный результат, иммунитет и отзыв эффекта без второй копии | Runic Weapon |
| L1-W25 / `paradox-of-opposites` | `trade-death-for-life`, `4U2ZV1v38D0y2CRl` | done 2026-11-05 (docs/plan-hexes.md, живой level1-hexes). Было: partial: catalog.model даёт Fortitude и fast-healing effect выбранному согласному союзнику. Дополнить условие ФАКТИЧЕСКОГО нанесения1d4 void, не только степени: иммунитет/сопротивление могут дать0. Урон один раз за cast, fast healing1 пока поддерживается, не повторять урон при sustain | Sleep |
| L1-W26 / `devourer-of-decay` | `scroungers-glee`, `VNv96dJPi0WXKSFN` | done 2026-11-05 (docs/plan-hexes.md, живой level1-hexes). Было: needs-handler. Will failure frightened1/crit2; минимум1 только пока hex активен и цель СЛЫШИТ ведьму. Reaction Dismiss после критического Strike союзника по цели лечит именно этого союзника на1d4 на первом круге; снять только свой floor, не всё чужое состояние | Enfeeble |
| L1-W27 / `baba-yaga` | `spirit-object`, `yp4w9SG4RuqRM8KD` | needs-handler. Выбор объекта, движение до25 ft в пределах дальности; once/round Sustain: движение либо Strike по соседней цели, melee spell attack, 2d4 physical выбранного подходящего типа. Новый cast возвращает прежний объект в обычное состояние; объект/клетку/тип выбирает игрок, решения о допустимости ведущему | Chilling Spray |
| L1-W28 / `wilding-steward` | `wilding-word`, `GdN5YQE47gd79k7X` | needs-handler. Animal/fungus/plant получают −1 circumstance к Will; success −2 status к атакам/skill checks, вредящим ведьме; failure дополнительно sickened1 каждый раз при уроне ей; crit sickened2. Относительность к автору, не движение и не общий штраф всем атакам | Summon Animal ИЛИ Summon Plant or Fungus |
| L1-W29 / `spinner-of-threads` | `nudge-fate`, `G0T1xv1FoZ23Jxvt` | needs-handler. На failure/criticalFailure attack/skill/save только если +1 STATUS меняет категорию: пересчитать с реальным stacking/adjustments, закончить hex после изменения. Не расходовать на не изменившемся результате; новый cast прекращает прежнее применение автора | Sure Strike |
| L1-W30 / `ripple-in-the-deep` | `sting-of-the-sea`, `jyYBuGRfpkZz2kxs` | needs-handler. Fortitude в НАЧАЛЕ хода цели; criticalSuccess unaffected, success −2 visual Perception, failure dazzled, crit blinded, до конца её хода. Никакого лишнего save при cast; повторять, пока поддерживается | Dizzying Colors ИЛИ Grease |
| L1-W31 / `faiths-flamekeeper` | `stoke-the-heart`, `GeUbPvwdZ4B4l0up` | done 2026-11-05 (docs/plan-hexes.md, живой level1-hexes). Было: partial: catalog.model уже применяет `TpVkVALUBrBQjULn`, +2 status damage на первом круге. Проверить поддержание и окончание; не добавлять бонус поверх штатного RE | Command |
| L1-W32 / `starless-shadow` | `shroud-of-night`, `cE7PRAX8Up7fmYef` | partial: catalog.json даёт Will и заметку, не полную относительную видимость. На failure яркий свет для цели становится тусклым, без greater darkvision все существа для неё concealed; согласная цель может выбрать исход. Не навешивать concealed всем существам глобально | Fear |
| L1-W33 / `choir-politic` | `share-vision`, `TRlI5zAbNW2hDiH9` | done 2026-11-05 (docs/plan-hexes.md, живой level1-hexes). Было: partial: catalog.model применяет эффект автору/цели. Обе стороны обмениваются vision senses и получают +2 STATUS Perception; blinded/dazzled одной стороны действует на обе. Новый cast прекращает прежний. Проверить два носителя, очистку только связанного состояния и отсутствие расширения прав владения | Share Lore |
| L1-W34 / `the-unseen-broker` | `pact-broker`, `YNAthsgsJjQIXbc8` | needs-handler. Принятие пакта даёт ведьме −1 status Lie против цели. Реальное hostile action против ведьмы/союзников: отказавшаяся цель делает обычный Will; принявшая и нарушившая — степень хуже на1. Failure:2d4 mental, −1 status attack+damage против указанных существ; crit −2, success unaffected. После испытания immunity1min независимо исхода. Не подменять действие disposition | Command |
| L1-W35 / `mosquito-witch` | `buzzing-bites`, `BItahht2hEHvR9Bt` | done 2026-11-05 (docs/plan-hexes.md, живой level1-hexes). Было: partial: catalog.pa содержит эффекты, sickened-floor и иммунитет при удалении носителя. Проверить cast/sustain, sickened>=1 при crit пока spell активен, immunity1min после конца; immune-цель не должна получать лишний save/урон | Pest Form |

L1-W36: условный class archetype `seneschal` меняет начальный наговор на `manifest-will` (`IqBfoUaWDennHYoZ`),
а обычное rank1 выбирается по традиции. Отдельная задача: aura по традиции, начало хода существ, относительное concealment
только за границей эманации и запрет использовать его для Hide. Штатный эффект `WtuhkNCNAW1JaGSe` существует;
проверить его RE и добавить лишь неподдержанное. На первом круге: arcane — weakness1 к spell damage на1round;
divine — living/undead tempHP2 на1round; occult — союзник lesser cover внутри и1round после выхода;
primal — −10 STATUS всем Speeds на1round либо до Escape, с fungus/plant/wood traits. Для каждого варианта
нужен отдельный сценарий начала хода и окончания. Dedication2 не выдавать на первом уровне, но изменения первого уровня учитывать.

## Все 16 способностей фамильяра

Общая зависимость всех строк: W02/W04; цель выбирается от токена связанного фамильяра, источник срока — ведьма.
Короткие ID имеют префикс `Compendium.pf2e.familiar-abilities.Item.`. У всех 16 в snapshot нет собственных RE;
для Restored Spirit уже есть onUse в catalog.pa — это ручное применение эффекта, а не реализованный cast/sustain trigger.

| ID / slug / UUID | Механика и критерий приёмки |
|---|---|
| L1-WF01 / `familiar-of-balanced-luck` / `6ZmgkMHUGGb1mDhr` | Существо в15 ft: выбор +1 либо −1 STATUS AC до начала следующего хода ведьмы; использовать существующий эффект `0JvxhEv83bAD5PGv`, выбор/отказ, отсутствие неверного stacking |
| L1-WF02 / `familiar-of-freezing-rime` / `9xTjRt8LkZPB42Vi` | Burst5 с центром в клетке фамильяра, difficult terrain до начала следующего хода ведьмы; проверить геометрию и удаление только своей области |
| L1-WF03 / `familiar-of-flowing-script` / `9ypX5ZMor6RMiFKv` | Фамильяр может обеспечивать flanking как атакующее существо с reach5 до начала следующего хода ведьмы, visual effect; не давать всем глобальный off-guard и не создавать настоящую атаку |
| L1-WF04 / `familiar-of-stalking-night` / `FeEts6s2ABVEi0H6` | Соседний враг, от которого фамильяр concealed/hidden/undetected → frightened1. Проверить относительное восприятие, не общий флаг token.hidden; при неоднозначности подтверждение ведущего, не автоматическая утечка |
| L1-WF05 / `familiar-of-obscuring-snowfall` / `Fouq5RMNS8P1CDzx` | Burst5 у фамильяра до начала следующего хода ведьмы; враги, входящие в клетки, dazzled до того же срока. Вариант PFS центра у угла клетки пометить отдельно; вход/повтор и очистка не затрагивают чужую область |
| L1-WF06 / `familiar-of-bolstering-aid` / `HNoR0D2sKQaDNh5Z` | Соседний союзник +2 STATUS к следующей НЕатакующей skill check до начала следующего хода ведьмы; эффект `IgLMAwovQ9roTsRN` существует. Расходить на подходящем броске, не damage-roll/attack |
| L1-WF07 / `familiar-of-parasitic-might` / `J5Wyh1EPmk848ivR` | Существо в15 ft с HP строго ниже половины max → Fortitude против spell DC ведьмы; неуспех sickened1. Тест точной половины, дальности и иммунитетов |
| L1-WF08 / `familiar-of-insightful-observation` / `YptMhsztTS9dYGAY` | Бесплатный Recall Knowledge фамильяра навыком, в котором обучена ВЕДЬМА, с ЕЁ бонусом; не подставлять обученность/модификатор фамильяра. Тайный результат и предмет знания разрешает ведущий |
| L1-WF09 / `familiar-of-restored-spirit` / `ZCze1FY3Rmnvd6Dx` | Согласное существо в15 ft получает temp HP 2+floor(level/2), на L1 это2, до начала следующего хода ведьмы. Сохранить onUse эффект `twvhTLrLEfr7dz1m`, добавить trigger. Не складывать tempHP, окончание не стирает более новый чужой источник |
| L1-WF10 / `familiar-of-paired-perplexity` / `bhpa7DVdMsaNfodz` | Выбранное существо в20 ft: stupefied1 до начала следующего хода ведьмы, visual; без выдуманного save, учитывать иммунитеты и общий once/round |
| L1-WF11 / `familiar-of-ongoing-misery` / `mu9OL8v4rmr9311e` | SOURCE-BLOCKED: после сверки источника выбрать timed negative condition цели в15 ft и продлить на1 round с ограничением повторного продления экземпляра, если подтверждён этот текст. Не продлевать бессрочное и не запрещать законное снятие; конфликт описан ниже |
| L1-WF12 / `familiar-of-keen-senses` / `onye3PN84lmca11D` | На выбор imprecise scent/tremorsense/wavesense60 ft до начала следующего хода ведьмы и немедленное необязательное Point Out. Переиспользовать эффект `4wJM0OA9y2gsBAh7`; наличие чувства не раскрывает автоматически точные координаты |
| L1-WF13 / `familiar-of-swarms-heart` / `t6nzeTpsTJDwAUFZ` | Ведьма/союзник в одном пространстве с фамильяром получает concealment до начала следующего хода ведьмы; движение обновляет состав. Не сохранять concealed после выхода из пространства и не применять к врагам |
| L1-WF14 / `familiar-of-nimble-flight` / `uFsWy6Ii1WxA0u0w` | Необязательный Fly до15 ft, не провоцирует реакции; маршрут выбирает владелец. Не выдавать постоянную fly Speed, не обходить стены и не подавлять реакции на другие движения |
| L1-WF15 / `familiar-of-overwhelming-tides` / `xH7lvZkYYAAuxR62` | Выбрать существо в10 ft, push5 ft ОТ ФАМИЛЬЯРА. Повторное событие не двигает второй раз; обычные стены/занятость/принудительное движение и отсутствие подходящего токена проверяются |
| L1-WF16 / `familiar-of-enticing-negotiation` / `xXMPZXcwQgKRAu38` | Один враг в10 ft off-guard до начала следующего хода ведьмы; не подменять узкий выбор массовым эффектом; once/round и обычное снятие |

## Конфликт Горечи: локализованный блокер

`the-resentment` (`Compendium.pf2e.classfeatures.Item.9OwWgOP8ZWxTAqbg`) говорит о продлении **всех отрицательных
состояний с конечным сроком на цели**, не только наложенных наговором. Отдельная WF11 говорит об **одном выбранном**
состоянии, однократно для данного экземпляра. L1-WSOURCE: сверить установленный локальный оригинал/версию/исправления,
зафиксировать авторитетный текст и fixtures; до этого не выбирать трактовку произвольно. Заблокирована только WF11,
а не Evil Eye и не остальные независимые задания ведьмы. Внешнюю сверку выполнять только после подтверждения пользователя.

## Стартовые фокальные заклинания и все семь условных классовых черт L1

| ID / slug | Текущее и задание | Приёмка |
|---|---|---|
| L1-W40 / `patrons-puppet` / `aq1yonHeYpbaj3XI` | В начале хода предложить выбранный focus hex: Command связанного фамильяра без auditory/concentrate; нормальное число действий фамильяра | Focus1, free action по источнику, один cast и одна команда, отказ/нет фамильяра/ресурс0, W03 |
| L1-W41 / `phase-familiar` / `rMOI8JFJ0nT2mrCF` | catalog.model уже применяет `61Hl31nyzt63vvX9`; реакция ДО triggering damage: resistance5 all и immunity precision только этому урону | Подтвердить pre-damage API/путь или явно ограниченный ручной сценарий; не выдавать постоянную защиту. Focus/реакция один раз, откат корректен |
| L1-W42 / `cackle` (feat → spell `YVK3JUkPVzHIeGXQ`) | Черта даёт focus hex Cackle; сам cast Cackle ЕСТЬ новый hex, тратит фокус, затем Sustain выбранного spell. Вложенное Sustain не новый cast | Проверить W03, focus1, выбор поддерживаемого эффекта и допустимость триггера способности фамильяра без двойного применения |
| L1-W43 / `reach-spell` | Уже есть spellshape builtin и RE; +30 ft следующему допустимому заклинанию, touch→30 ft | Не складывать дубль, проверить реальную дальность выбранного cast и прекращение готовности при постороннем действии по тексту |
| L1-W44 / `widen-spell` | Уже есть spellshape builtin/RE; только следующий burst/cone/line без duration: burst>=10 +5, cone/line<=15 +5, больше +10 ft | Проверить геометрию и запрет неподходящих sustained/малых burst, отсутствие второго изменения |
| L1-W45 / `counterspell-prepared` | needs-handler: реакция на видимые manifestations cast того же подготовленного spell; потратить соответствующий подготовленный слот и counteract | Подтверждённая стадия до разрешения вражеского spell либо честный ручной сценарий. Проверить совпадение spell, слот/ресурс/исход; tradition — trait самой черты, не добавочное требование совпадения традиции чужого spell. Не тратить при отказе |
| L1-W46 / `witchs-armaments` | Native ChoiceSet/Strike/ItemAlteration уже создаёт nails/jaws/hair; не писать повторные атаки | Проверить выбранный вариант, кость/traits и повторное законное взятие черты; нет дубля Strike |
| L1-W47 / `cauldron` | Native CraftingAbility не равен полной подготовке. Формулы4 common potion/oil1; при daily prep одно временное масло/зелье из известных формул; следующее daily prep делает его инертным и заканчивает оставшиеся эффекты | Выбор формулы игроком, временный предмет без цены, повтор подготовки/очистка собственного источника без удаления обычных покупных зелий; дальнейшие уровни не включать |
| L1-W48 / `wortwitch` | Leshy familiar; иммунитет к circumstance penalties ranged spell attack/Perception от foliage и flat check только при concealment ТОЛЬКО растительностью | Не убирать concealed глобально и не пропускать проверку от других источников; причина растительности подтверждается ведущим/данными сцены, новый фамильяр не создаётся поверх уже связанного без выбора |

W42–W48 доступны на первом уровне лишь при законном дополнительном получении черты; обычная witch class feat — со второго.
Lesson focus spells (Life Boost, Blood Ward, Elemental Betrayal, Veil of Dreams, Needle of Vengeance, Stumbling Curse и т.п.)
не включать автоматически на первом уровне только потому, что базовый круг1. Для реально законно полученного выбора — отдельная строка сборки.

## Очередь и владение

1. W00, сверка источников и простые недостающие правила (например W23), аудит уже существующих эффектов.
2. W01–W04: один общий lifecycle/trigger/ресурсы, затем простые WF01/06/07/09/10/16 и остальные WF по их зависимостям.
3. W20–W35 отдельными заданиями: floor и относительные эффекты, start-turn и движение, сделки/пересчёт исходов;
   W25 проверять по фактически применённому урону. WF11 ждёт только своего source-resolution.
4. W40–W48 и условный W36 — по наличию выбора. Нестандартные pre-damage/pre-cast вмешательства идут отдельной технической проверкой.
5. L1-W50: обычные cantrips/rank1 выбранной традиции, spells первых уроков из таблицы, фоновые/навыковые/родословные
   черты, предметы и выбранная дополнительная familiar ability — инвентаризация фактической сборки и адресные сценарии.

Исполнитель класса получает собственные новые изолированные handlers/tests и `tests/live/level1-witch.js` при необходимости;
общий lifecycle принадлежит L1-C1. Все существующие общие файлы, каталоги, паки и ru/en меняет один интегратор (§13.5).
Имена новых файлов согласовать по механике; не создавать отдельный observer/общую схему без необходимости.

## Проверки реализации

Каждый ID имеет положительный/отрицательный сценарий строки. Дополнительно: cast против карточки описания; cast/Sustain/Cackle;
два hex одного хода и другой ход; once/round; before/after; два автора/цели; фамильяр отсутствует/переместился; source-ended;
потеря зрения/слуха; иммунитет и фактически0 урона; typed stacking; выбор/отказ; ресурсы; повтор сообщения/переброс/смена ведущего.
Валидация правил, форма round-trip при схеме, `node --check`, профильные тесты, `node --test`, ru/en; живой прогон только на
временных копиях «AF тест» с уборкой. Критик по смыслу и диффу. Source-blocked и непроверенный pre-hook не считать готовой механикой.
Текущая волна — документация: runtime-тесты и живые сценарии ещё не выполнялись.
