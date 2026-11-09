# План: три пробела Мастерской (шаги активации, черты недуга, notify реакций)

Цель: окно «Мастерская» правит весь контракт правила без ручного JSON. Порядок работ: **3 → 2 → 1А → 1Б** (каждый пункт сдаётся отдельно).
Числа посчитаны скриптом node по `rules/catalog*.json` (содержательные данные — в `catalog.model.json`). Ревизия 2 — по замечаниям Критика и решениям Руководителя.

## Данные каталога

| Что | Число |
| --- | --- |
| правил с `activate` | 290 (437 записей, 6 с `choices` = 12 вариантов) |
| записей/вариантов с `onUse` | 101 в 98 правилах |
| ключи `onUse` в активациях | `challenge+targets` 71, `apply+targets` 26, `check+targets` 3, `targets+zone+excludeSelf` 1 |
| `onUse.targets` | `selected` 38, `area` 38, `self` 25 |
| `challenge` | `dc` всегда `{value}` (70) или без dc (1); `traits` 12, `options` 16, `immunity` 7, `damageByDegree` 2 |
| шаги `byDegree` | condition 133, duration 57, who 36, persistent 21, move 8, note 5, effect 2, when 2 |
| шаги `apply` | effect 22, note 7, condition 1 |
| `check` / `zone` | 3 / 1 правило |
| шагов `affliction`/`coat`/`choose` в активациях | 0 |
| определения недуга | 1126 в 563 правилах; `def.traits` у 456 определений в **228** правилах (1..5 штук, в одном правиле копии согласованы) |
| `onDamaged` / `onFailed` | 98 правил (32 + 64 в model-каталоге, ещё по одному в `catalog.json`); `notify` везде умолчание `["owner","gm"]` |

---

## Пункт 3. `notify` у onDamaged / onFailed (малый, ~1 ч)

### Рантайм
- Формат: подмножество `["owner","gm"]`, у onDamaged/onFailed **непустое** (`rules.mjs:656`, `:678`, ошибка `react.notify`), умолчание `["owner","gm"]` (`rules.mjs:631`, `:668`).
- Читается: `scripts/builtin/damaged.mjs:263`, `scripts/builtin/failed.mjs:152` → `recipients` (`scripts/builtin/lib.mjs:166`): `gm` — все ГМы; `owner` — **только не-ГМ пользователи с правом OWNER** на актёра. Нет получателей → подсказки нет вовсе.
- onFailed: секретный бросок принудительно шлёт только ГМу, `notify` игнорируется (`failed.mjs:152`).
- Следствие: при одном `owner` у актёра без игроков-владельцев (NPC, персонаж без игрока) подсказки **не получит никто**, ГМ в том числе. У onAttacked (`reactions.mjs:196`) `owner` — любой пользователь с OWNER, включая ГМа: смысл другой, поэтому подписи `sheet.notifyOwner/GM` («Шепнуть владельцу/ведущему») для реакций не берём.

### Изменения
- `scripts/sheet.mjs`: `dmForm`/`flForm` — `notify: { owner, gm }` (булевы из `d?.notify ?? ["owner","gm"]`). `dmRule`/`flRule` — **защита `d.notify &&` остаётся**; принимаем и массив (как есть), и объект (`["owner","gm"].filter(k => объект[k] === true || "true")`). `carryUneditable` (`:231`) без изменений (переносит `notify` как есть, любого вида).
- `scripts/workshop/app.mjs` `reactFields` (`:72`): в конец два `F.chk` — `${p}.notify.owner`, `${p}.notify.gm`; оба сняты → валидатор покажет `react.notify` (текст уже есть в `rules.react.notify`) и не даст сохранить.
- Тест `workshop.reactions.test.mjs:54` («без переноса notify сбросился бы к умолчанию», `notify: undefined`) остаётся зелёным — именно из-за сохранённой защиты.

### Строки (`lang/{ru,en}/workshop.json`, группа `workshop.au.react`, рядом с `triggerOnly`)
- `notifyOwner`: ru «Подсказка игрокам-владельцам» / en «Hint to owning players».
- `notifyGm`: ru «Подсказка ведущему» / en «Hint to the GM».
- `notifyTip` (подсказка у первого флажка): ru «Подсказка «Ответить?» приходит шёпотом. «Игрокам-владельцам» — только игрокам, ведущему она не придёт: если у актёра нет игрока-владельца, при одном этом флажке её не получит никто.» / en «The “respond?” hint is whispered. “Owning players” means players only, not the GM: if the actor has no owning player, this alone sends the hint to nobody.»
- `notifyTipFailed` (добавляется к `notifyTip` у onFailed): ru «Бросок, скрытый от игроков, подсказывает только ведущему.» / en «A roll hidden from players hints the GM only.»

### Круговой проход
`["owner","gm"]`, `["gm"]`, `["owner"]` — тождество после `validateRule`; порядок в массиве нормализуется к `owner, gm`.

### Тесты
`workshop.reactions.test.mjs`: round-trip трёх значений для onDamaged и onFailed; оба сняты → `react.notify`; форма со старым массивом пишется; `notify: undefined` по-прежнему даёт умолчание (`:54`). `on-failed.test.mjs:60` остаётся как есть.

### Риски
Низкие: тип поля формы меняется (поиск `\.dm\.notify|\.fl\.notify`: `sheet.mjs:231`, тесты).

---

## Пункт 2. Черты недуга `def.traits` (малый, ~1 ч)

### Рантайм
- `def.traits?: string[]`, валидатор `rules.mjs:344` (`SLUG = /^[a-z0-9-]+$/`, ошибка `afflict.def`), пустой массив отбрасывается (`:355`). Вид недуга в `traits` каталога не дублируется.
- `scripts/affliction.mjs:50` (`meta.traits = kind ∪ def.traits`), `affliction-run.mjs:124` (иммунитет), `:102` (черты предмета-носителя фильтруются по pf2e).
- Определение — JSON в `row.text`; `ruleToForm/formToRule` не затрагиваются.

### Изменения
- `scripts/workshop/affliction-edit.mjs`: `afflSet` — ветка `traits`: split по `,`, trim, **`toLowerCase()`**, без пустых и повторов; пусто → `delete def.traits` (как `note`). Не-slug после приведения (пробелы внутри, `!`) уходит валидатору (`afflict.def`). `afflView` — `traits: (def.traits ?? []).join(", ")`.
- `scripts/workshop/app.mjs` `afflFields` (`:196–200`): `F.text(`${A}.traits`, …, { cls: "ws-full", tip })` рядом с «Заметкой»; **плейсхолдера нет** (прежний `poison, inhaled` противоречил подсказке «вид добавляется сам»). Datalist не делаем (не работает по элементам через запятую); чипы — позже.
- Группы и «Отделить»: `traits` — часть `def`; `mutate` пишет клон `def` всем членам группы; `split` (`affliction-edit.mjs:109`) копирует группу целиком, дальше правки независимы. Особой логики нет, проверяется тестом.

### Строки (`lang/{ru,en}/workshop.json`, `workshop.au.affl`)
- `traits`: «Дескрипторы» / «Traits».
- `traitsTip`: ru «Через запятую, строчными латиницей, как в pf2e (inhaled, mental). Вид недуга добавляется сам. Общее для всех шагов этого недуга.» / en «Comma-separated lowercase slugs as in pf2e (inhaled, mental). The affliction kind is added automatically. Shared by all steps of this affliction.»

### Тесты
`workshop.affliction.test.mjs`: (1) по образцу «заметка недуга» (`:284`): правка в одном шаге уходит во второй, регистр приводится (`"Mental, MENTAL"` → `["mental"]`), пусто убирает ключ, `afflView().traits`; (2) «Отделить» — правка не расходится по остальным; (3) негатив `"poi son"` → `afflict.def`; (4) в тесте «пустых правок каждого поля» (`:263`) добавить `["traits", x.traits]`; (5) каталожный round-trip (`:251`) зелёный на 228 правилах.

### Риски
Низкие. Если `traits` у копий разошлись (в каталоге 0), `ensure()` разведёт их по группам — существующее поведение для любого поля.

---

## Пункт 1. Шаги активации — «переход внутрь» (большой, ~2 дня, две сдачи)

### Рантайм
`activate[].onUse` (и `choices[].onUse`) — полноценный `onUse`: `cast.mjs:275–285` → `use.activationUse` (`use.mjs:163`). Грамматика `vActOnUse` (`rules.mjs:~806`): как `rule.onUse`, но СЛ испытания — только `{value}` либо без `dc` (тогда `dc` записи → СЛ по уровню предмета, `cast.mjs:64`). Форма основного onUse покрывает активацию целиком, кроме правила про СЛ.

### Решение: переход внутрь вместо вложенного конвейера
По образцу `coatBack` (`app.mjs:274`): окно «Автоматизация» показывает строки «Цели / Бросок / Исход» **от корня `P`** — это `f` (по умолчанию) или `f.cast.N[.choices.M].use`. В режиме «внутри» сверху кнопка «← к активации» (`workshop.au.cast.back`), строки «Когда/Активации/Макросы/Зона» основного правила скрыты. В строке «Активации» (карточка записи/варианта) остаётся **только сводка шагов + кнопка «Шаги…»**, она ставит `a.into = "f.cast.N[.choices.M].use"` и перерисовывает. Никакого второго конвейера в карточке, UI не раздувается: нужен один новый контекст отрисовки.

- **Состояние:** `a.into` (null | путь корня). `P = a.into ?? "f"`; `m = getProperty(a, P)`.
- **Данные формы:** в `castForm`/`choiceForm` (`sheet.mjs:216–218`) **только** `use` (модель `{ targets, excludeSelf, pulse, range, zone, ch, ck, apply }` — выборка из `ruleToForm({v:1,onUse:u})`); **строка `onUse`, `useRaw`, textarea и аварийная ветка удаляются**. Если `onUse` в данных не объект — `use` собирается из того, что есть (валидатор в любом случае скажет, что не так); специального пути нет.
- `useRule(use)`: `formToRule({ kind: "onUse", ...use, macros: [] }).onUse`; null-ключи убираются replacer'ом (как `J`, `sheet.mjs:195`); `challenge.dc` без `value` удаляется (иначе `activate.dcForm`); **если нет ни шагов, ни броска (`ch`/`ck`), ни зоны — возвращает `undefined`** → `castRule` не пишет `onUse`, срабатывает существующая ошибка `activate.kind` (без `spell`/`choices`/`onUse`).
- `blankCast/blankChoice`: `use: blankUse()` (targets `selected`, пусто). `castRule`: `usesSteps(c) && useRule(c.use) !== undefined && { onUse }`. Смена вида на `steps`/`both` ничего не инициализирует (`use` есть всегда).

### Общая функция полей броска (в фазе А)
Строки `ch` сейчас в **трёх копиях**: `app.mjs:662–666` (основной save), `:702–706` (триггеры зоны), `:743–747` (события). Выносим `rollFieldsOf(P, m, { mode })` — поля испытания/проверки от корня пути; подключаем **сразу** в трёх местах + активация (для события/триггера `P` = `f.ev.i` / `f.zone.trig.i`, режим только «испытание»). Для вложенного (`P ≠ "f"`) в `dcType` только `value` (+ текущее через `withCur`), поле СЛ с placeholder «как у активации»; **`dcType = "source"` исключён** (`app.mjs:455` — автопереключение при `v === "save"` на заклинании делается только при `P === "f"`).

### Пути — все от `P`
- `au.degPath(mode, P)` (`automation.mjs:24`): `${P}.ch.deg` / `${P}.ck.deg` (без хардкода `f.`); `au.setRollMode(m, mode)` уже работает с любым объектом.
- `#setAuto`: `path === "roll"` → `new RegExp("^(.+)\\.roll$")` по **концу пути** (не захватывает `…ck.roll`: у ck своё поле `roll`, поэтому регэксп `^(f(?:\.cast\.\d+(?:\.choices\.\d+)?\.use)?)\.roll$`, строго корень перед `.roll`); сегмент режима использует путь `${P}.roll`. `f.targets === "self"` → `a.sel = null`, `f.ck.vsType` (`:475–482`) → то же с `${P}.…`. Ветка `^(f\.cast\.\d+)\.kind$` (`:465`) → `^(f\.cast\.\d+(?:\.choices\.\d+)?)\.kind$` (иначе у варианта `choice` смена вида не сработает).
- `#addStep` (`:487`): «к кому» по умолчанию — `targets` корня списка (`m.targets === "self"` → `self`), а не `a.f.targets`; жёсткие `/^f\.ev\.\d+\.apply$/`, `/\.coat\.ch\.deg\./` остаются, `p.startsWith("f.apply.")` в `coatOk` → `${P}.apply.` (coat в активациях не предлагается: `coatOk` ложь при `P ≠ "f"`).
- Запасной путь броска на карточку `"f.apply"` в обработчике drop (`:926`) **убирается**: без явной колонки — предупреждение `workshop.au.dropColumn` (в режиме «внутри» цель — колонка/«Применить сразу» корня `P`, определяется из DOM).
- `inChallenge`/`stepRows`/`stepLabel` — по regexp, пути `…ch.deg.` подходят; `stepRows` (`affliction-edit.mjs:33`) расширяется шагами `cast.N[.choices.M].use` (apply + `ch/ck.deg.*`), иначе недуг в активации не попадёт в группу; `stepLabel` — «(активация N)».
- Сброс состояния: `removeCast`, `removeChoice` (`:354–355`) и смена вида записи/варианта обнуляют `a.sel`, `a.picker`, `a.card`, `a.stage`, `a.into` (если путь удалён/сдвинулся) и стирают `a.open["cast.N…"]` (ключи сдвигаются с индексами — проще очистить все ключи `cast.*`). Кнопка «← к активации» тоже чистит `sel/picker/card`.

### «Автор в области» и зона
- В строке «Цели» активации показывается `triSeg(`${P}.excludeSelf`, …authorIn…)` при `targets === "area"` (как в основном, `app.mjs:650`).
- Зона/триггеры внутри активации **без UI** (1 правило), модель `use.zone` едет как есть. Риск молчаливой потери: `formToRule` пишет `zone` только при `targets === "area" && zone.on`; смена цели с «Область» на другую раньше «теряла» зону без слова. Решение: (1) `use.zone` в форме **не стирается** при смене цели (вернули «Область» — зона вернулась); (2) в строке «Цели» при `zone.on && targets !== "area"` — предупреждение «Зона не будет записана, пока цель не «Область»» (`workshop.au.zoneNeedArea`; рисуется и в основном окне, для единообразия). Само удаление зоны остаётся действием основного окна.
- Область активации: шаблон берётся из текста Effect описания (`cast.mjs:277`), плашку `areaNote` во «внутри» не рисуем — одна строка-подсказка.

### Сводка активации в строке «Активации»
`au.summaries({ kind: "onUse", ...m, ev: [], cast: [] }, { ...env, dc: null })` — `dc: null`, чтобы `buildReport`/`env.dc` основного правила не подмешивались; **области и макросов в сводке нет** (берём `targets` без `area`-хвоста, `macros` не трогаем). Складываем `targets · roll · outcome` в **`sums["cast.N"]`** (ключ блока, `app.mjs:606` → `#paint` `data-sum`, `:847`), чтобы текст обновлялся при вводе внутри перехода. `castLine` (`automation.mjs:352`) — в хвост «шагов: N».

### Тесты и проверка
- `tests/workshop.activate.test.mjs`: **строки 57, 68, 70, 98 обновить** под модель `use` без строки `onUse`: `:57` вариант `kind: "steps"` собирается через `use`; `:68`/`:70` — «битый/пустой onUse» превращается в «активация вида steps без шагов → `useRule` undefined → `activate.kind`»; `:98` («onUse без null-ключей») — проверка `useRule(f.cast[0].use)` без `null`. Новые: round-trip всех каталожных активаций через `use` (101); шаг `condition` в `use.apply` и в `use.ch.deg.failure`; `dc` пусто → challenge без `dc`, число → `{value}`; `choices.M` независим; сброс `a.into/a.sel` при удалении записи (чистая функция сброса вынесена в автоматизацию для теста).
- `workshop.affliction.test.mjs`: `stepRows`/`sharedPaths`/`stepLabel` на путях активации. `workshop.automation.test.mjs`: сводка активации, `degPath(mode, P)`, регэксп `roll` не ловит `ck.roll`. `sheet.test.mjs`: `carryUneditable` с `cast[].use`.
- Тесты общей `rollFieldsOf` — на чистом описателе полей (где возможно без Foundry) для `P = f`, `f.ev.0`, `f.zone.trig.0`, `f.cast.0.use`: пути полей, нет `source` во вложенном.
- Живой прогон на «Тестовые копии (автоматизация)»: активация с challenge + 4 степени: «Шаги…» → добавить шаг → «← к активации» → сохранить → использовать; заодно события и триггеры зоны (отрисовка после рефакторинга). Убрать копии после.

### Строки (`lang/{ru,en}/events.json`, `workshop.au.cast`; `affl` — `workshop.json`)
- `steps`: ru «Шаги…» / en «Steps…» (кнопка); `stepsN`: ru «шагов: {n}» / en «steps: {n}» (хвост `castLine` и сводка); `back`: ru «← к активации» / en «← back to activation»; `useTitle`: ru «Шаги активации: {name}» / en «Activation steps: {name}» (заголовок режима внутри; `name` — `item.name`/метка записи).
- `dcPh`: ru «как у активации» / en «as in the activation»; `dcTip`: ru «Пусто: берётся СЛ активации, а если и её нет — СЛ по уровню предмета.» / en «Empty: the activation’s DC is used, then the item-level DC.»
- `areaFromDesc`: ru «Шаблон области берётся из описания предмета.» / en «The area template is taken from the item description.»
- `workshop.au.zoneNeedArea`: ru «Зона не будет записана, пока цель не «Область».» / en «The zone is not saved unless the target is “Area”.»
- `workshop.au.affl.inCast`: ru «активация {n}» / en «activation {n}».
- Переиспользуем: `workshop.au.row.targets/roll/outcome`, `targetsBtn.*`, `rollBtn.*`, `immediate`, `sheet.degree.*`, `chWhen`, `authorIn`. Названия — с листа (`item.name`), не из lang.

### Круговой проход
`onUse` (объект) → `use` → `useRule` → объект; ожидается тождество на 101 каталожной записи (форма основного onUse проходит каталог). Критичное: null-ключи (replacer), пустой `dc` (удаляется), `damageByDegree`/`immunity` едут в `ch.dmgDeg/imm`, `rollerRole` у `check` (3 записи — тест поймает потерю, при потере — баг и основного окна), `zone` (1) через `use.zone`. `carryUneditable` — `cast` целиком, включая `use`; вкладка листа его не показывает.

### Риски
1. Жёсткие пути (`f.…`) — перечислены выше; перед сдачей `grep -n '"f\.\|f\.targets\|f\.ck\|f\.ch\|a\.f\.' scripts/workshop/app.mjs`.
2. Рефакторинг `rollFieldsOf` затрагивает события и триггеры (три места) — покрыто тестами и живым прогоном; поэтому он в фазе А.
3. Недуг в активации — без `stepRows` не синхронизируется (включено).
4. Режим «внутри» — новое состояние окна (`a.into`): сбрасывать при смене вида правила, закрытии, удалении записи, смене предмета.
5. Объём `app.mjs` растёт; `app.mjs` уже 1151 строка — частично компенсируется удалением двух копий полей броска.

**Объём:** фаза А (`use` в модели, `a.into`, `rollFieldsOf` + события + триггеры, пути от `P`, сводка, targets/challenge/apply/степени) — ~150 строк, ключи lang (≈10), ≈10 тестов; фаза Б (`check` и сегмент «Бросок» внутри) — ~30 строк. ≈ 2 дня, двумя сдачами.

---

## Порядок сдачи и проверка
1. 3 → 2 → 1А → 1Б; перед каждой сдачей `node --test tests/*.test.mjs` (без glob на этой Node не работает), Критик по диффу, коммит только по «коммить».
2. Незакоммиченные правки пользователя (`README.md`, `lang/*/builtin.json`, `rules/catalog.json`, `scripts/apply.mjs`, `scripts/builtin/impulse-gate.mjs`, `scripts/events.mjs`, `tests/arch-w2.test.mjs`, `tests/youre-next.test.mjs`, `tests/live/enemies.js`) не трогаем; `tests/i18n.test.mjs` — ключи в оба языка сразу.

## Открытые вопросы
1. Пункт 2: достаточно ли текста через запятую (чипы — позже)? В плане — текст.
2. Пункт 1: зона/триггеры активации без UI (1 правило) — подтвердить; в плане — да, плюс предупреждение `zoneNeedArea`.
