# Ta Logic Guide (konnakol_trainer_stable)

Этот документ фиксирует текущую рабочую логику `Ta`/акцентов и все каверзные моменты, которые уже ломались.

См. также практический playbook с отладочными методами:
- `TA_DEBUG_METHODS.md`

Цель: чтобы при следующих правках не запутаться и не получить регрессы вида:
- "невидимые Ta" в полиритме,
- расхождение UI vs audio,
- невозможность вернуть/снять дефолтную первую долю,
- неожиданные эффекты от кнопки `Ta` и режима редактора.

---

## 1) Ключевые сущности (не путать)

- `accents` / `accentsByLane`  
  Фиолетовые акценты (square accent). Это **не** Ta-рамки.

- `taDingKeys` / `taDingKeysByLane`  
  Явные Ta-маркеры по клеткам (включая `r-0`, но для `r-0` есть спец-логика).

- `firstBeatAccent` / `firstBeatAccentByLane`  
  Дефолтная "первая доля Ta" как состояние, а не как explicit key.

- `firstBeatDingSuppressedRows`  
  Строки, где дефолтный `Ta` на `c0` выключен пользователем в Ta-редакторе.

---

## 2) Главный принцип

Белая Ta-рамка и фиолетовый акцент — независимые слои.

- Белая рамка = Ta-логика (`taDingKeys`, `firstBeat*`, suppression).
- Фиолетовая заливка = акцентная логика (`accents*`).

Любая правка, которая смешивает эти карты напрямую, почти гарантированно создаст регресс.

---

## 3) Полиритм: lane separation (обязательно)

В poly режиме чтение/запись должно идти через lane-контейнеры:
- `accentsByLane`
- `taDingKeysByLane`
- `firstBeatAccentByLane`

Плоские `Set` используются как производные/совместимость, но не как источник истины для lane-специфичного поведения.

---

## 4) Логика `toggleTaDing` для `c === 0`

### 4.1 Poly + Ta-editor + `c0`

Если `firstBeatAccentByLane[lane] === true`:
- клик по `c0` не должен превращаться в обычный explicit `taDing`.
- он переключает suppression строки:
  - если строка не suppressed -> добавить в `firstBeatDingSuppressedRows`
  - если suppressed -> убрать из `firstBeatDingSuppressedRows`
- explicit key `r-0` при этом удаляется/не используется.

Если `firstBeatAccentByLane[lane] === false`:
- `c0` работает как обычная explicit Ta-клетка (`taDingKeysByLane` add/remove).

### 4.2 Mono + Ta-editor + `c0`

Та же идея:
- при активном дефолтном first-beat клик переключает suppression,
- при выключенном дефолтном first-beat клик переключает explicit `r-0`.

---

## 5) Runtime first-beat policy (audio)

Используется `resolveFirstBeatHitRow(policy, on0Accent, on0Ding, firstBeatEnabled, suppressedRow)`.

Важно:
- `explicit_ta_only` -> только `on0Ding`
- `explicit_any` -> `on0Accent || on0Ding`
- `legacy`:
  - если строка suppressed -> только `on0Ding`
  - иначе `on0Accent || on0Ding || firstBeatEnabled`

Это нужно, чтобы:
- lane0 мог сохранять legacy-ощущение,
- lane>0 не получал ghost Ta от простого акцента,
- suppression реально работал.

---

## 6) UI-логика в `SequencerGrid`

### 6.1 Ta-editor (`isTaEditorMode === true`)

`showEditorDing` должен показывать:
- explicit Ta (`isTaDing`),
- и дефолт `c0`, если строка не suppressed и `forceFirstBeatEditorFrames` включен.

### 6.2 Обычный режим (`isTaEditorMode === false`)

Сейчас в normal режиме:
- показываются explicit Ta (`isTaDing`);
- дефолтные `c0`-рамки зависят от правила "reveal" (см. ниже), чтобы выполнить UX-ожидания.

---

## 7) Правило "reveal/hidden" для default `c0` в normal

Текущая идея (по пользовательскому контракту):
- default `c0` может быть скрыт в normal до "события изменения",
- после изменения сетки становится видим в normal,
- если пользователь вернул сетку обратно к дефолту — может снова скрываться.

Для этого используются эвристики вида:
- `accentMapVersion`
- `firstBeatRowSuppressed.size`
- "сетка вернулась к дефолту"

### Каверзный момент

Исторически именно тут больше всего регрессов:
- одно условие может случайно скрывать все дефолты,
- или наоборот включать их всегда.

Если правите этот блок:
1. отдельно проверяйте случай "чистый дефолт из снапшота",
2. отдельно "первое изменение в редакторе",
3. отдельно "вернули обратно к дефолту",
4. отдельно "есть explicit Ta на `c>0`",
5. отдельно poly lane0/lane1.

---

## 7.1) Bars domains (критично для Ta)

Нужно разделять 3 домена тактов:

- `totalBars` (data domain) — реальное число тактов в state/snapshot/audio.
- `visibleBars` (view domain) — сколько тактов пользователь видит в текущем UI.
- `virtualBars` / `renderableBars` (render domain) — сколько строк рендерится технически (например, в autoplay).

Инвариант:

- Ta-политика (`suppressedRows`, explicit keys, first-beat visibility, snapshot normalize, audio parity)
  работает **только по `totalBars`**.
- `visibleBars`/`virtualBars` не должны менять Ta-derived решения.

Практически в коде:
- derive helper `deriveTaNormalVisibility` принимает только `totalBars` (не render/view домены).
- pruning row-based state при resize выполняется на data-domain (`barsDomain.ts`).

Resize-контракт:

- При уменьшении `totalBars`: удалить все row-based значения с `r >= totalBars` из
  `firstBeatDingSuppressedRows`, `taDingKeys*`, `accents*`, `deadCells` и row-map полей.
- При увеличении `totalBars`: новые строки стартуют из дефолтного data-state и не наследуют
  временные UI-состояния.

---

## 8) Snapshot / backward compatibility

## 7.2) Зафиксированный глюк (bars = 1)

Что было:

- При `totalBars = 1` после выхода из Ta-редактора дефолтная рамка на первой клетке (`c0`)
  иногда гасла в normal mode, хотя пользователь перед этим включал другие акценты/рамки.
- На слух режим мог оставаться «живым», но визуально `c0` исчезала (ложный сигнал, что всё в дефолте).

Почему происходило:

- Reveal-условие в normal mode было слишком узким: опиралось на `suppressedRows.size > 0`
  (или эквивалентно узкий маркер), и не учитывало, что в одном такте уже есть значимые изменения
  в других клетках.
- После cleanup/resize до `1` такта `suppressedRows` легко становился пустым, и старый guard
  гасил `c0`, даже если пользователь реально изменил сетку.

Как избегать:

1. Для normal-mode использовать единый derived-флаг видимости (`canShowDefaultTaInNormal`),
   а не локальные ad-hoc проверки в `SequencerGrid`.
2. В `canShowDefaultTaInNormal` учитывать не только suppression, но и валидные изменения
   вне `c0` (explicit Ta/акценты), чтобы `bars = 1` не выпадал в ложный default.
3. Явно гасить дефолтные `c0` только когда сетка действительно вернулась в дефолт
   (`isTaGridAtDefault = true` на валидных данных).
4. Обязательно гонять отдельный сценарий регрессии для `totalBars = 1`:
   - включить изменения в других клетках,
   - выйти из Ta-редактора,
   - проверить, что `c0` в normal mode не пропадает до фактического revert в default.

См. тесты: `src/taVisibility.test.ts`, `src/barsDomain.test.ts`.

---

При загрузке snapshot важно нормализовать:
- lane maps (`accentsByLane`, `taDingKeysByLane`, `firstBeatAccentByLane`)
- suppression (`Set` и `Array` форматы)

Если suppression теряется при parse/apply:
- появляются "призрачные" дефолтные first-beat Ta после загрузки.

---

## 9) Что легко сломать

1. **Смешать акцент и Ta в одну карту**  
   -> визуал и аудио расходятся.

2. **Использовать глобальные флаги для всех lane в poly без lane-правил**  
   -> bleed между голосами.

3. **Считать `c0` обычной Ta-клеткой всегда**  
   -> ломается suppression-модель.

4. **Менять только UI без проверки audio policy**  
   -> "вижу одно, слышу другое".

5. **Пропустить снапшотные edge-cases**  
   -> баги только после paste/load, не при живом редактировании.

---

## 10) Мини-чеклист перед любым merge

1. Poly 2-voice:
   - lane0 и lane1 изолированы,
   - в lane1 нет ghost Ta.

2. Ta-editor `c0`:
   - клик включает/выключает suppression корректно,
   - explicit `r-0` не "залипает" в режиме default-first-beat.

3. Normal mode:
   - отображение default `c0` соответствует текущему UX-правилу,
   - explicit `c>0` работает независимо.

4. Snapshot:
   - save/load не теряет suppression и lane maps.

5. Audio parity:
   - runtime и midi policy совпадают по first-beat правилам.

---

## 11) Рекомендации по рефактору (без изменения поведения)

1. Вынести политику normal-видимости default `c0` в отдельный helper:
   - вход: `isTaEditorMode`, `forceFirstBeat`, `rowSuppressed`, `isTaDing`, `uiModeFlags`
   - выход: `showEditorDing`, `showNonEditorDing`

2. Добавить unit-тесты на UI-правило (минимум таблица кейсов):
   - default snapshot,
   - after first change,
   - after revert to default,
   - explicit `c>0` present.

3. Явно документировать "source of truth" в коде рядом с вычислением флагов:
   - что откуда берется,
   - что нельзя смешивать.

---

## 12) Быстрый map по файлам

- Основная state+audio логика: `src/App.tsx`
- Рендер и interaction клеток: `src/SequencerGrid.tsx`
- MIDI policy parity: `src/midiExport.ts`, `src/midiExport.test.ts`

---

Если меняете Ta-логику — сначала фиксируйте контракт здесь, потом код.

---

## 13) Инцидент-отчёт: исчезающий/невидимый `Ta` на `c0`

### 13.1 Что ломалось (симптомы)

1. **Normal mode (`bars=1`)**: белая рамка `Ta` на первой клетке (`c0`) визуально исчезала, но звук first-beat продолжал играть.
2. **После выхода из Ta-editor**: при наличии других акцентов `c0` мог гаснуть визуально, хотя состояние не было "пустым".
3. **Ta-editor**: после снятия `c0` suppression и повторной установки `Ta` маркер становился функциональным, но невидимым (UI/audio desync).

### 13.2 Корневая причина (root cause)

Проблема была не в аудио, а в **рассинхроне условий видимости** между `App.tsx` (derived-флаги) и `SequencerGrid.tsx` (фактический рендер):

- использовались слишком узкие reveal-условия для legacy `c0` в normal mode;
- при downsize `totalBars` часть row-state корректно прунилась, но это обнуляло "триггеры отображения", если они зависели только от текущего `suppressedRows.size`;
- в editor-ветке видимость `c0` дополнительно ошибочно гейтилась через `accentMapVersion === 0`, из-за чего при `accentMapVersion=1` маркер становился невидим.

Итог: **данные и звук корректные, а визуальный слой принимал неверное решение**.

### 13.3 Принятое решение

1. **Развели домены bars**:
   - `totalBars` — data-domain (источник истины для state),
   - `visibleBars` — только UI-domain,
   - `virtual/renderable` — только рендер-оптимизация.
2. **Добавили deterministic pruning** row-based состояний при resize (`barsDomain` утилиты), чтобы state после downsize/upsize был предсказуем.
3. **Усилили derived-флаг normal-видимости `c0`**:
   - учитывается не только suppression, но и факт реального ухода от default (`accentMapVersion`, explicit `Ta`/accent вне `c0`).
4. **Исправили editor visibility contract**:
   - убран ложный gate `accentMapVersion === 0` для `showEditorDing`,
   - editor `c0` теперь определяется только релевантными Ta-условиями (explicit или default-first-beat без suppression).

### 13.4 Финальная логика (коротко)

- **Ta-editor**: белая рамка = `explicit Ta` ИЛИ `default c0` (если row не suppressed).
- **Normal mode**: белая рамка = `explicit Ta` ИЛИ `legacy default c0`, но только когда пользователь уже вышел из "чистого default" состояния.
- **Audio/MIDI**: first-beat policy едина и не зависит от viewport/virtualization.

### 13.5 Как не попадать в это снова (anti-regression)

1. **Никогда не смешивать**:
   - purple accent visibility,
   - white Ta visibility,
   - runtime first-beat audio policy.
2. Любое условие рендера `c0` менять только парно:
   - в `App.tsx` (derived-флаги),
   - в `SequencerGrid.tsx` (использование флагов).
3. При изменении bars всегда проверять 3 сценария:
   - downsize до `1`,
   - upsize обратно,
   - snapshot save/load между этими состояниями.
4. Держать инвариант: **virtual/viewport не влияет на Ta truth** (только на то, какие строки отрисованы).
5. Перед merge прогонять минимальный чек:
   - mono + poly,
   - editor + normal,
   - UI/audio parity на `c0` и explicit `c>0`.

---

## 14) Инцидент: first-beat audio ошибочно привязан к `accentMapVersion`

### 14.1 Что показали логи

- `firstBeatHitPolicy: "explicit_ta_only"` при `accentMapVersion: 1`
- `on0Ding: false`, `fa: true`, `supRow: false`
- итог: `firstBeatCellHitRow: false` и `shouldPlayFirstBeatTa: false`

Вывод: первый слог (`c0`) гасился не из-за suppression и не из-за mute, а из-за неверной first-beat policy, ошибочно завязанной на `accentMapVersion`.

### 14.2 Оценка гипотез

- `H1` (policy сломан через `accentMapVersion`) — **CONFIRMED**
- `H2` (`suppressedRow` ломает first beat) — **REJECTED** (`supRow=false`)
- `H3/H4/H5` (поздние гейты playback/mute) — **INCONCLUSIVE** для того прогона, но не root cause, так как сигнал обнулялся раньше

### 14.3 Фикс

Убран принудительный переход на `explicit_ta_only` при `accentMapVersionRef.current >= 1` в обеих ветках расчёта:

- `konnakol_trainer/src/App.tsx`
- `konnakol_trainer_stable/src/App.tsx`

Теперь policy берется только из:

- `resolveRuntimeFirstBeatPolicy(polyMode, laneId)`

Это соответствует контракту из этого гайда и сохраняет корректную first-beat логику для `c0`.

### 14.4 Как избегать этой ошибки

1. **Никогда не связывать напрямую** `accentMapVersion` с runtime audio policy first-beat.
2. `accentMapVersion` — это UI/история правок, а не источник истины для аудио-решения по `c0`.
3. First-beat policy должна определяться только:
   - режимом (`poly/mono`),
   - lane-правилом,
   - explicit/suppression сигналами (`on0Ding`, `on0Accent`, `suppressedRow`, `firstBeatEnabled`).
4. Для регрессии обязательно гонять кейс:
   - `accentMapVersion=1`, `on0Ding=false`, `fa=true`, `supRow=false`,
   - ожидание: `c0` звучит по policy `legacy`/lane-rule, а не гасится как `explicit_ta_only`.

---

## 15) Инцидент: `alt` на `c0` включает белые Ta-рамки на всех тактах

### 15.1 Симптом

- В normal mode при постановке `alt` (purple accent) на первую клетку такта (`c0`) начинали гореть белые Ta-индикации (`c0`) на всех строках.
- После снятия этого `alt` белые рамки визуально могли не исчезать (ложное "залипание" reveal).

### 15.2 Root cause

Рендер-ветка normal-mode в `SequencerGrid` позволяла legacy-показ `c0` без защиты по `accentMapVersion`:

- `showLegacyDefaultInNormal` вычислялся при `canShowDefaultTaInNormal=true`,
- при этом отсутствовал guard `accentMapVersion === 0`,
- и в состоянии `accentMapVersion=1` (после touch на `c0`) это включало белую рамку `c0` для всех строк.

Итог: purple-событие на `c0` ошибочно влияло на white-layer reveal в normal mode.

### 15.3 Решение

В `SequencerGrid` для `showLegacyDefaultInNormal` восстановлен guard:

- `accentMapVersion === 0`

То есть legacy default-рамка `c0` в normal mode не должна отображаться в состоянии "edited accent map", если для этого нет отдельного валидного Ta-основания.

### 15.4 Как избегать

1. Для normal `c0` проверять отдельно:
   - purple accent intent (`isAccent`),
   - white Ta intent (`isTaDing` / default first-beat policy).
2. Не допускать, чтобы один `c0`-tap в accent-layer автоматически поднимал white reveal для всех строк.
3. Держать `showLegacyDefaultInNormal` под явным контрактом (включая `accentMapVersion` gate) и покрывать регрессией:
   - поставить `alt` на `c0`,
   - снять `alt`,
   - убедиться, что белые рамки `c0` не "залипают" глобально.
