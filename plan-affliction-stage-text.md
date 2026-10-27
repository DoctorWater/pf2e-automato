# affliction-stage-text: долг недугов «уточнения в стадиях» (127 записей, 85 имён) — разбор и план (кода в репозитории нет)

**Статус (2026-10-26): сделано, в дереве, не закоммичено.** Решения пользователя: Q1 — да, узко (`or` рядом со смертью/степенью успеха → долг, Ayrzul's Blight); Q2 — не делалось (Sportlebore Capsule потеряла бы basic-спасбросок); Q3 — `REFINE_OK` 18 записей от Критика (слово + защита от устаревания); Q4 — долг. Поправки Критика: текст копии = свой + полный текст образца; «but … also», отрицание, тот же slug при plus → долг; флаги стадии OR; смерть в условной конструкции (upon/while/if/after) не смертельная; ворота второго `@Check` (Tarantula Ampoule, Kraken Bottle) → долг. Итог `--write`: affliction-batch 302/200/278 → 304/238/238 (40 записей), долг `affliction-stage-text` 132 → 89; тесты зелёные.

Опора: `plan-affliction-text.md` §0 (решения пользователя) и §6, конвертер `tools/affliction.mjs` + `tools/affliction-batch.mjs`. Ключ `affliction-stage-text` в `rules/mechanisms.json`.

Решение: **долг делится на три части.** (1) Правка разбора без схемы и без противоречия §0 — **+25 записей (17 имён)**: подстановка стадии-образца, СЛ из сегмента «Saving Throw», «addiction is virulent», плоский `@Damage[1[…]]`, тавтология «as long as … at this stage». (2) Два небольших послабления §0 — нужен ответ пользователя (**+12 записей**). (3) Остальное ~90 записей — долг: нужны новые примитивы, каждый из которых **меньше порога ~30 документов**, либо сюжетное/выбор игрока.

## 1. Как мерили

Копия `tools/`, `scripts/`, `rules/`, `lang/` в scratchpad (`.../scratchpad/work`), правки под переменными окружения (`E1`…`E7`, `R1`, `REFOK`), `buildBatch()` без `--write`; базовый прогон совпал с репозиторием: `catalog 302, partial 200, debt 278`, из них 127 записей (85 имён) — этот долг (`stage clarification` 108 + `second save` 13 + `virulent` 3 + `untyped` 3). Файлы: `sd-measure.mjs` (прогон → `m-<метка>.json`), `sd-freed.mjs`, `sd-table.mjs`, `sd-stay2.mjs` (куда ушла каждая запись), `sd-docs.mjs` (размер групп в документах по всему корпусу), `sd-dump.mjs`/`sd-show.mjs` (тексты стадий). Все — в `C:/Users/USER/AppData/Local/Temp/claude/D--ClaudeFun-pf2e-automato/063f168e-0490-47e0-9c6b-238c1eb1e7cd/scratchpad/`.

Важно: в отчёте записи лежат по **первой** причине (`r.debt[0]`); у 65 из 127 причин несколько, поэтому «закрыли первую причину» ≠ «запись свободна». Цифры ниже — **итог прогона** (запись реально ушла из долга в `ok`/`partial`), а не число снятых регулярок. Вне 127 записей каталог не изменился (проверено `sd-outside.mjs`: только Kraken Bottle → partial и Horn of Rust сменил причину).

## 2. Группы: способ → замеренный прирост

Столбец «Сразу» — шаги 1–2 (§0 не нарушается); «С Q1–Q2» — после ответа на вопросы §7; «С Q3» — с белым списком по uuid.

| Группа (записей / имён) | Что в тексте | Способ | Сразу | С Q1–Q2 | С Q3 |
|---|---|---|---|---|---|
| **as stage N with changes** (35 / 18) | «As stage 2, except Clumsy 3» (Agonizing Welts, Corrupting Spite ×3); «as stage 1 plus Slowed 1» (Jelly Blood, Poison Sedum); «as stage 2, but also has void healing» (Void's Embrace) | (а) подстановка образца: состояния — по slug поверх, урон заменяет при «but/except», при «plus/and/also» неоднозначно → долг; остаток своей стадии — в `text` | **+12 / 7 имён** | +12 | +16 / 11 |
| **second save check in head** (13 / 13) | 4 вида: (i) первый `@Check` до метки «Saving Throw» — это не спасбросок недуга (Demon Dust: addiction 24, настоящий 20 — **сейчас берётся неверная СЛ**; Execution Powder, Tarantula Ampoule, Repulsion Resin, Flea Infested — проверка из условия); (ii) addiction (Qat, Demon Dust, Succubus Kiss, Grit); (iii) другая СЛ по типу цели в скобках (Rancid Breakfast, Counteflora, Spirit Naga — 3) | (а) СЛ — из сегмента `<strong>Saving Throw</strong>…`; прочие `@Check` вне сегмента — заметка; внутри сегмента (скобки с другой СЛ) — долг | **+6 / 6** | +6 | +6 |
| **virulent in text** (3 / 3) | «the addiction is virulent» (Scour, Cytillesh, Demon Dust) — признак наркотической зависимости, не яда; Mortasheen «virulent против животных» — настоящее условие | (а) не считать предложения со словом `addiction` | **+2** (Demon Dust считается выше) | +2 | +2 |
| **as long as** (11 / 4) | «can't be awakened as long as they remain at this stage» (Endless Nightmare ×9 записей, Frozen Nightmare) — повторяет правило модуля «состояние живёт, пока стадия»; Filth Fever («slowed, пока sickened»), Azarpal («sickened не ниже 1») — настоящие условия | (а) вырезать только тавтологию «as long as they/the creature remain(s) at this stage»; остальные — долг | **+3 / 1** | +3 | +4 / 2 |
| **flat damage / «structure not parsed»** (2 / 1) | `@Damage[1[poison]]` без кубика (Spider Swarm Venom) | (а) в разборе `\d+(?:d\d+)?`; `isDice` схемы уже принимает «1» | **+2 (в `ok`, без заметки)** | +2 | +2 |
| **or** (14 / 9) | реальный выбор: «2d6 cold **or** fire» (Antipode), «1d6 poison **or** 1d6 vitality» (Brightshade), «one of the following at random» (Thulgant) — ошибка при автозакрытии; текст смерти «dead, rising as X, **or** Y» (Zombie Rot, Ayrzul's Blight); «level equal to or less than» (Rust Creep ×5); «or the action fails» (flat-ворота, см. ниже) | (б) для стадии **без разобранной механики** с текстом смерти/превращения слово `or/upon/while/…` — не уточнение (Q1); остальные — белый список по uuid после Критика (Q3); Antipode/Brightshade/Thulgant — долг | 0 | +7 / 4 (Q1) | +11 / 6 |
| **while** (4 / 3) | «A creature that dies while infected … rises as» (Soulphage, Pallid Plague, Creeping Death) | как «or», Q1 | 0 | +3 / 3 | +4 |
| **@Check in stage** (10 / 8) | flat-ворота («must succeed at flat DC 5 to use a manipulate action **or** it fails»: Pummel-Growth, Smother Shroud, Clown Monarch, Tangle Spores, Twisted Loyalties — 5 имён); вторая basic-проверка в стадии (Sportlebore ×2); память (Toiler's Gruel); Fill Lungs, Rotting Curse | (б) только в тексте стадии: `@Check` не в списке §0, долг был введён консервативно (Q2); при снятии часть всё равно упирается в `or/if/upon` | 0 | +2 / 2 | +7 / 6 |
| **every / «каждый час»** (6 / 3) | «@Damage every hour» (Wretched Weeps, Grave Blight, Bubonic Plague, Bogwid Fever) — автомат нанёс бы урон один раз | (в) примитив «периодический урон стадии»: **8 имён / 15 записей** по корпусу | 0 | 0 | 0 |
| **for [[/gmr** (6 / 3) | «Paralyzed for [[/gmr 1d4 #hours]]» (Jorogumo, Blackfingers', Lunar Naga) — срок состояния броском | (в) примитив «срок броском» (решение 1в, §0) | 0 | 0 | 0 |
| **against / versus** (4 / 4) | «+1 item bonus to saves against mental effects» (Flayleaf, Alcohol, Refined Pesh, Blaze) — парсер положит безусловный бонус | (в) `mods.bonus` не имеет условия (`KEYS.bonus` = target/type/value, `inline-effect.mjs:11`): **10 имён / 10 записей** по корпусу (+ «visual Perception», «to hear and smell»); до примитива — долг | 0 | 0 | 0 |
| **one-shot damage, text says persistent** (4 / 3) | Breath of the Mantis God: разметка `@Damage[3d6[bleed]]`, описание — «persistent bleed»; Bubonic/Bogwid — «take 1d… every 1d4 hours» (периодический урон) | Breath — один документ, ручное правило/`REFINE_OK`; остальные — в «every» | 0 | 0 | 0 |
| **untyped damage** (3 / 3) | Eldritch Flare, Mythotoxin, Najra Lizard Venom — «untyped» = урон с условием («can't be recovered until…») | (г) долг: одиночные механики | 0 | 0 | 0 |
| **increases** (3 / 2) | «The status penalty increases to -2» (Expeditious Evolution), «drained increases by 2» (Abyssal Plague) | (г) стадия описывает приращение к прежнему значению — не сумма; 6 имён / 9 записей по корпусу | 0 | 0 | 0 |
| **for lying / whenever / if / except / until / for each** (≈ 13 / 11) | «damage **for lying**» (Liar's Demise, Fraudslayer Oil); Sloughing Toxin «for each action»; Ghoul Whispers/Forbidden Cravings «unless … raw meat», «returns to stage 4» (13 записей, 2 имени); Curare, Sea Serpent Algae, Shiver, Ravenous Sickness | (г) долг: условие меняет разобранный урон/состояние; примитива-группы нет (по 1–2 имени) | 0 | 0 | +2 |

**Итого:** шаги 1–2 дают **+25 записей / 17 имён** (из них 2 в `ok`, 23 в `partial`); Q1+Q2 — до **+37 / 26 имён**; белый список Q3 — до **+54 / 39 имён**. Остаток долга: 102 → 90 → 73 записи (68 → 60 → 46 имён). Верхняя граница, если снять `REFINE` целиком: +81 / 62 имени — **не рекомендую**: закрытие неверное (Antipode, Brightshade, «every hour», «for lying», «against fear»).

## 3. Готовые механизмы — проверено по коду

- **`choose` (`STEP_KINDS`)** — выбор делает автор шага при использовании (союзник/враг/вариант) и применяется к следующим шагам; у стадии недуга нет списка шагов и нет `when` (`vAfflStage` принимает только `duration/damage/persistent/conditions/mods/text`). «Cold or fire», «one of the following at random» им не выражаются.
- **`onEvent`** (`EVENT_ON`: attack-roll, skill-check, saving-throw, damage-taken, turn-start, turn-end, effect-created, …) — события боя, не мирового времени и не «попытки действия с чертой». Носитель недуга (`carrierSource`, `affliction-run.mjs`) не получает `onEvent`: связка стадия → правило отсутствует. «Каждый час» и «flat DC 5 при действии с manipulate» не выразить; одиночные случаи (Shiver — `effect-created`, Blackfinger Blight — `turn-start`) группы не образуют.
- **`when`** — только на шагах правила; в `afflictionRule` уже используется для иммунитета по трейту (шаг Д). На стадии не работает; для альтернативной СЛ (Counteflora «для растений») дал бы второе испытание — схема держит одно.
- Новых готовых механизмов для групп **нет**: ни `choose`, ни `onEvent`, ни `when` не закрывают ни одной группы выше.

## 4. Размер примитивов в документах (порог ~30)

Корпус: 833 недуга (name|html), 567 имён, 946 записей с копиями (`sd-docs.mjs`; регулярка по тексту стадий — верхняя граница).

| Кандидат | Имён | Записей | Видимо в долге после шагов 1–2 | Вывод |
|---|---|---|---|---|
| срок броском | **36** | 69 | 19 имён / 28 записей (часть заперта другими стенами: weapon, npc injury, spell) | у порога; решение пользователя (решение 1в §0 уже ведёт его в долг); первым из примитивов после `linger` |
| условный бонус/штраф | 10 | 10 | 4 имени | ниже порога |
| периодический урон | 8 | 15 | 4 имени | ниже порога |
| ворота «flat при действии» | 5 | 5 | 5 | заметка |
| выбор/альтернатива урона | 4 | 4 | 3 | долг |
| вторая СЛ по цели | 3 | 3 | 3 | долг |
| «increases to» | 6 | 9 | 2 | долг |

## 5. Порядок работ

1. **Подстановка стадии-образца** (`parseAffliction`, цикл `refs.forEach`) — самое большое: **+12 записей / 7 имён**, ~25 строк. Правило: `as stage N` + `but/except/plus/also/and`; состояния сливаются по slug, урон заменяется при «but/except» и уходит в долг при «plus/and/also», `mods` в обе стороны — долг; `text` стадии = её полный текст (иначе карточка покажет описание образца: Agonizing Welts ст. 3 при замеренной копии несёт текст стадии 2 с «Clumsy 2»). Цепочка (`as stage 2` ← `as stage 1`) разрешается по порядку, как сейчас. Тесты: Agonizing Welts, Jelly Blood, Void's Embrace; отрицательный — Sloughing Toxin («for each»), Ghoul Whispers («unless»).
2. **СЛ из сегмента «Saving Throw»** (`saveSegment` — единая функция для конвертера и `checkAffliction`, `affliction-batch.mjs:42–48`): **+6**, **исправляет неверную СЛ** (Demon Dust 20 вместо 24). Заодно — «addiction» в `virulent` (+2), плоский `@Damage[1[…]]` (+2 в `ok`), тавтология «as long as … at this stage» (+3). Итого шаги 1–2: **+25 / 17 имён**.
3. **Партия для Критика** по новым `partial` (23 записи: «прочее» 9, «особое излечение» 4, «сюжетное» 3, «нельзя снять» 3, «экспозиция» 2, «пока под действием» 1, «смерть» 1) — решение 4 §0: без выборки `--write --groups` не запускать. `ok`-записи (2) — по общему правилу выборки каталога.
4. **После ответов Q1–Q3:** послабление по смерти/превращению (+10), `@Check` в тексте (+2), белый список `REFINE_OK` по uuid (по образцу `FLAVOR_OK`; кандидаты: Enfiron Venom, Rust Creep, Zerk, Sightless Tincture, Dreamtime Tea, Twisted Loyalties, Greater/Sinmold/Rotter Infestation, Creeping Death, Frozen Nightmare + 4 flat-ворот) — +17 после Критика.
5. **Примитивы** — не в этой работе: «срок броском» (36 имён) — первым; условный бонус и периодический урон — только если вырастут за ~30.

## 6. Риски

- **Подстановка образца и неоднозначность «plus».** «As stage 1, plus 1d4 damage» — добавка или замена; в замеренной копии такие записи уходят в долг (`ambiguous`). Ложное закрытие здесь хуже, чем долг: выборка Критика обязательна.
- **Смена источника СЛ затрагивает любой недуг с «Saving Throw» в голове.** Замер: каталог вне 127 записей не изменился (2 записи с «no save/kind» сдвинулись), но перед `--write` пересчитать на настоящем коде.
- **Partial завышает «готово».** Новые 23 `partial` — те же отдельной строкой coverage; `ok` (2) — только плоский урон без остатка.
- **Послабление Q1** ослабляет защиту: слово `if/until/returns to stage` в тексте смерти остаётся долгом (Ghoul Whispers ст. 5 «если ел сырое мясо — умирает», иначе «возвращается на ст. 4»; заметка «Отметьте смерть» была бы неверной).
- **Дубли NPC-копий:** Ghoul Whispers/Forbidden Cravings (13 записей, 2 имени), Endless Nightmare (9 записей, 1 имя), Rust Creep (5), Corrupting Spite (3): вес записей выше веса имён.

## 7. Вопросы пользователю (только там, где §0 мешает)

- **Q1.** Слова `or/upon/while/…` в стадии, где **нет ни одной разобранной механики** (текст смерти/превращения «dead, rising as X or Y», «dies while infected … rises»): считать их не уточнением, а текстом? Остаются долгом `if/unless/until/as long as/instead/returns to stage`. Замер: **+10 записей / 7 имён**. Автомат здесь ничего не делает, заметка видна — ложного закрытия нет.
- **Q2.** `@Check` в тексте стадии (flat-ворота «или действие не удаётся», память, повторный basic-бросок): снять отдельный долг `@Check in stage`, оставив только `REFINE`? Замер: +2; без Q3 почти все упираются в `or/if`.
- **Q3.** Допустим ли **явный белый список по uuid** (`REFINE_OK`, как `FLAVOR_OK`) для записей, где слово-уточнение стоит в нераспознанном тексте и не меняет разобранное? Замер: **+17 записей / 14 имён**, список определяет Критик, а не регулярка.
- **Q4 (не блокирует).** Условный бонус «against fear» (4 имени) и вторая СЛ по цели (3 имени): оставить долгом или разрешить partial **без разбора этого бонуса в `mods`** (весь фрагмент — только в `text`)? Замер не делал: правка конвертера отдельная.
