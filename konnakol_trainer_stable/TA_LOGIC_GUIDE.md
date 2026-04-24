# Ta Logic Guide (konnakol_trainer_stable)

Этот документ фиксирует текущую рабочую логику `Ta`/акцентов и все каверзные моменты, которые уже ломались.

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
