## AGENT-4 RESIZE-CONTRACT

Проверка выполнена по коду `src/App.tsx`, `src/SequencerGrid.tsx`, `src/barsDomain.ts`, `src/barsDomain.test.ts`.
Фокус: строгая симметрия `downsize/upsize` для row-based data-state.

| Data type | Downsize expected/fact | Upsize expected/fact | Gap |
| --- | --- | --- | --- |
| `deadCells` | **Expected:** удалить все `r >= totalBars`. **Fact:** есть явная очистка по `bars` в effect (`setDeadCells` с удалением out-of-range row). | **Expected:** новые строки дефолтные. **Fact:** после downsize stale row не сохраняются, при upsize не восстанавливаются автоматически. | Нет явного gap по resize-контракту. |
| `firstBeatDingSuppressedRows` | **Expected:** удалить все `r >= totalBars`. **Fact:** есть effect на `[bars]`, который фильтрует Set по диапазону. | **Expected:** новые строки дефолтные (не suppressed). **Fact:** после фильтрации downsize при upsize новые row остаются без suppression. | Нет явного gap по resize-контракту. |
| `accents` (flat `Set<string>`) | **Expected:** удалить ключи с `row >= totalBars`. **Fact:** на resize нет явного prune в state; out-of-range ключи в состоянии могут сохраняться. | **Expected:** новые строки только default-state. **Fact:** при повторном upsize старые ключи могут снова стать валидными и визуально/логически вернуться. | **Есть gap:** нарушена строгая симметрия/детерминизм (stale state survives downsize). |
| `taDingKeys` (flat `Set<string>`) | **Expected:** удалить ключи с `row >= totalBars`. **Fact:** симметрично `accents`, явного prune на resize нет. | **Expected:** upsize создает дефолт для новых row. **Fact:** старые ключи могут ре-активироваться после роста bars. | **Есть gap:** возможен non-default restore после upsize. |
| `accentsByLane` (`LaneSetMap`) | **Expected:** очистить lane-данные с `row >= totalBars`. **Fact:** при poly часто пересобирается через `distributeSetToLanes(..., bars, ...)`, но это не гарантированный single-source prune для всех resize-путей. | **Expected:** новые строки default. **Fact:** при наличии stale в flat-наборах возможна повторная материализация при upsize. | **Есть gap:** очистка косвенная/частичная, не строгий deterministic контракт. |
| `taDingKeysByLane` (`LaneSetMap`) | **Expected:** удалить out-of-range row в lane map. **Fact:** аналогично `accentsByLane`, устойчивого централизованного prune на resize не найдено. | **Expected:** upsize -> default для новых row. **Fact:** возможен возврат исторических lane keys. | **Есть gap:** риск lane stale restore. |
| `customSyllables` (`Record<number, number>`) | **Expected:** удалить `r >= totalBars`. **Fact:** явного prune на bars resize не найдено (кроме reset в отдельных других сценариях). | **Expected:** новые row с дефолтным syllables. **Fact:** при upsize старые `customSyllables[r]` могут вернуться. | **Есть gap:** новые строки не гарантированно default после round-trip resize. |
| `customMultipliers` (`Record<number, number>`) | **Expected:** удалить `r >= totalBars`. **Fact:** явный prune есть в логике смены syllables, но не найден как гарантированный шаг при каждом bars-resize. | **Expected:** upsize -> default multiplier. **Fact:** stale row-множители могут пережить downsize и вернуться. | **Есть gap:** частично очищаемая структура. |
| `customSubdivisions` (`Record<\"r-c\", number>`) | **Expected:** удалить ключи с `row >= totalBars`. **Fact:** prune есть при глобальной смене syllables, но не обнаружен как обязательный шаг каждого bars-resize. | **Expected:** новые строки default subdivisions. **Fact:** старые subdivisions могут вновь стать видимыми при upsize. | **Есть gap:** non-deterministic round-trip по rows. |
| `pulseMeterUnlinked` (`Record<number, boolean>`) | **Expected:** удалить `r >= totalBars`. **Fact:** normalize есть при load snapshot, но явного bars-resize prune не найдено. | **Expected:** новые rows default (`false`). **Fact:** stale `true` на старших row может вернуться после upsize. | **Есть gap:** upsize может не быть дефолтным для новых rows. |

Итог по контракту:
- Полная строгая симметрия `downsize/upsize` сейчас не подтверждается.
- Есть частично очищаемые структуры, где stale данные переживают downsize и могут ре-появиться при upsize.
- `barsDomain.ts` содержит нужные deterministic prune-примитивы и тесты, но их обязательное централизованное применение в основном resize-пайплайне не подтверждено.

STATUS: DONE
## AGENT-5 TEST-MATRIX

### CASE-01: default -> change -> revert (normal mode)
- Preconditions: `totalBars = 4`; normal mode; grid в дефолтном состоянии (`isTaGridAtDefault = true`), suppression выключен; snapshot пуст.
- Steps:
  1) Зафиксировать baseline state/UI/audio.
  2) Изменить один не-`c0` элемент в bar 2 (например accent/ta key).
  3) Проверить reveal default Ta helper-поведение.
  4) Вернуть изменение точно в исходное значение.
  5) Сравнить с baseline.
- Expected state/UI/audio:
  - state: после шага 2 `isTaGridAtDefault = false`; после шага 4 снова `true`; lane/state maps без лишних ключей.
  - UI: после revert отображение и reveal совпадают с baseline; ghost Ta отсутствуют.
  - audio: воспроизведение после revert идентично baseline (same hits/accent timing).
- Priority: P0
- Automation target: integration (state + UI) + deterministic audio-event snapshot.

### CASE-02: deterministic downsize/upsize contract
- Preconditions: `totalBars = 8`; normal mode; есть пользовательские изменения в барах 1, 4, 7; poly lane data заполнены.
- Steps:
  1) Выполнить downsize до `totalBars = 4`.
  2) Проверить очистку row-based data для `r >= 4`.
  3) Выполнить upsize обратно до `totalBars = 8`.
  4) Проверить инициализацию новых строк (4..7) только дефолтным data-state.
- Expected state/UI/audio:
  - state: после downsize отсутствуют данные баров 5..8 во всех row/lane контейнерах; после upsize новые бары дефолтные, без восстановления старого мусора.
  - UI: видимые ячейки после resize консистентны с `totalBars`; никаких артефактов virtual/reveal.
  - audio: проигрывание не содержит событий удаленных баров; новые бары звучат как default.
- Priority: P0
- Automation target: reducer/state contract test + UI smoke + audio sequence assertion.

### CASE-03: snapshot parity при одинаковом totalBars
- Preconditions: `totalBars = 6`; сформирован нетривиальный паттерн (изменения, suppression, poly lane maps).
- Steps:
  1) Снять snapshot A.
  2) Выполнить restore snapshot A в новом runtime/чистом инстансе с тем же `totalBars = 6`.
  3) Снять snapshot B.
  4) Сравнить A и B (структурно и по воспроизведению).
- Expected state/UI/audio:
  - state: snapshot A == snapshot B по Ta/suppression/lane map данным (порядок/значения стабильны).
  - UI: после restore визуальное состояние полностью совпадает.
  - audio: последовательность событий и акцентов эквивалентна до/после restore.
- Priority: P0
- Automation target: snapshot round-trip test + audio parity harness.

### CASE-04: poly lane parity + отсутствие lane bleed
- Preconditions: poly mode; `totalBars = 4`; lane A и lane B имеют различающиеся Ta/accent паттерны.
- Steps:
  1) Настроить lane A (изменения в bar 1/2), lane B оставить partially default.
  2) Проиграть и зафиксировать события по lane.
  3) Изменить lane B и проверить, что lane A не изменился.
  4) Выполнить resize (4 -> 2 -> 4) и повторно проверить lane-изоляцию.
- Expected state/UI/audio:
  - state: `accentsByLane`, `taDingKeysByLane`, `firstBeatAccentByLane` изолированы; cross-lane записи отсутствуют.
  - UI: изменения lane B не отображаются в lane A и наоборот.
  - audio: события каждого lane соответствуют только его данным; bleed отсутствует.
- Priority: P0
- Automation target: poly integration test с lane-scoped assertions.

### CASE-05: bars = 1 stability (normal mode)
- Preconditions: normal mode; `totalBars = 1`; default grid.
- Steps:
  1) Проверить baseline для `bars=1`.
  2) Выполнить change -> revert на единственном bar.
  3) Снять/восстановить snapshot при `bars=1`.
  4) Сделать resize 1 -> 2 -> 1 и проверить контракты очистки/инициализации.
- Expected state/UI/audio:
  - state: граничный случай не ломает индексацию; после revert и restore состояние детерминировано; после возврата к 1 бару нет хвостовых данных.
  - UI: корректный рендер одной строки без ghost/reveal регрессий.
  - audio: стабильное воспроизведение единственного бара, без лишних событий.
- Priority: P0
- Automation target: dedicated regression test suite for single-bar boundary.

### GAP ANALYSIS (минимально достаточное покрытие и пробелы)
- Покрыто минимумом: все 5 обязательных сценариев плана, включая state/UI/audio паритет и deterministic resize.
- Пробел 1: нет явно выделенного test oracle для `canShowDefaultTaInNormal` (нужен unit-level truth table по suppression + non-`c0` + `isTaGridAtDefault`).
- Пробел 2: не зафиксирована независимость от `visibleBars/virtualBars` отдельным property/regression тестом (нужен сценарий одинакового `totalBars` при разных virtualization windows).
- Пробел 3: для audio parity желателен стабильный event-log формат (если сейчас сравнение только косвенное через UI/state).
- Пробел 4: отсутствует negative test на частично поврежденный snapshot (graceful fallback без lane bleed).

STATUS: DONE
## AGENT-2 STATE-PIPELINE

### Data flow map
- `totalBars` (state/ref `bars`) нормализуется через `snapBarsToPolyGrid(...)` в `normalizeBarsForMode` и `applyBarsWithPotatoFreeze`, то есть пользовательский ввод Bars в основном пути проходит через data-domain.
- При загрузке snapshot `setBars(snapBarsToPolyGrid(...))` использует тот же контракт для числа тактов, но `accents/taDingKeys` и lane-map далее записываются отдельными вызовами без единой финальной сверки по `totalBars`.
- В poly-ветках интеракций (`toggleAccent`, `toggleTaDing`) запись идет через lane-контейнеры (`setAccentsByLane`, `setTaDingKeysByLane`) и затем строится flat через `flattenLaneSetMap(...)` для совместимости/UI.
- Для чтения в poly используются lane-aware селекторы (`getLaneAccentsSetRef`, `getLaneTaSetRef`, `getLaneFirstBeatRef`), а для рендера сетки формируются `accentsUi/taDingKeysUi` из lane-map (`flattenLaneSetMap`).

### Violations
1. Нет единой точки нормализации перед записью в state/ref для snapshot/apply-пайплайна.
   - В `applySnapshotDataToUi` flat и lane структуры выставляются независимо (`setAccents`, `setTaDingKeys`, `setAccentsByLane`, `setTaDingKeysByLane`) без единого normalize-шага, который бы гарантировал консистентность с `totalBars` в момент коммита.
2. В poly lane-контейнеры не являются строгим single source of truth.
   - Эффекты `useEffect(... distributeSetToLanes(taDingKeys, bars, polyVoices) ...)` и аналогичный для `accents` пересчитывают lane-map из flat set в poly, т.е. направление данных периодически lane <- flat, а не только flat <- lane (derived/compat).
3. Плоские set-структуры используются не только как derived/compat.
   - В poly-потоке есть прямой dependency на flat как на источник для пересборки lane-map (см. пункт 2), а также snapshot-restore заполняет flat напрямую до/параллельно lane-map.

### Impact
- Риск рассинхронизации `flat` vs `byLane` при restore/resize/быстрых последовательных апдейтах: логика Ta может опираться на разные представления в разные моменты рендера.
- Нарушается заявленный контракт "poly source of truth = lane-контейнеры": часть кода фактически допускает обратную проекцию из flat, что маскирует ошибки и усложняет детерминированность.
- Отсутствие централизованной normalize-процедуры увеличивает вероятность ghost Ta/lane bleed при edge-case сценариях (особенно после snapshot apply и изменений `bars`).

### Patch plan
1. Ввести единый нормализатор состояния перед любым bulk apply (`normalizeBarsAndLaneState(next, totalBars, polyVoices)`), который:
   - режет ключи по `r < totalBars`,
   - валидирует `c` по row syllables/dead-cells,
   - в poly принимает lane-map как канон,
   - flat пересчитывает только через `flattenLaneSetMap(...)`.
2. Удалить/заменить poly-эффекты вида lane <- distribute(flat).
   - Оставить только направление lane -> flat (derived/compat), либо вычислять flat memo-слоем без обратной записи в lane-state.
3. В `applySnapshotDataToUi` и аналогичных restore-путях:
   - сначала нормализовать входные lane-контейнеры по `totalBars`,
   - затем атомарно записывать lane-state,
   - после этого обновлять flat как derived совместимость.
4. Зафиксировать инвариант в код-комментариях/гайде: "В poly запрещены записи lane-map из flat; flat не используется как source".

STATUS: DONE
## AGENT-1 DOMAIN-INVARIANTS

### Findings

1) Критичного смешения data-domain (`totalBars`/`bars`) с view/render доменом в Ta/snapshot/audio решениях не обнаружено.

- **Evidence (file/symbol):**
  - `src/App.tsx` -> `scheduleGridCellAtTime()`: Ta/audio ветвление строится от `rIdx`, `barsRef`, lane maps, `firstBeatDingSuppressedRowsRef`, `accentMapVersionRef`; `absR` не участвует в выборе Ta/accent роли.
  - `src/barsDomain.ts` -> `pruneGridKeySetByBars()`, `pruneLaneSetMapByBars()`, `pruneSuppressedRowsByBars()`: нормализация идет строго по `totalBars`.
  - `src/App.tsx` -> `canShowDefaultTaInNormal`: derived-флаг строится по data-state (`accentsUi`, `taDingKeysUi`, suppression, `accentMapVersion`), не по параметрам виртуализации.
- **Risk:** низкий (текущий контракт соблюдается).
- **Minimal fix:** без изменений; сохранить текущий инвариант и закрыть его тестом parity (одинаковый `totalBars`, разные render/view условия).

2) Обнаружена точка потенциального смешения доменов в playhead-логике (не в audio decision напрямую, но рядом с критическим контуром).

- **Evidence (file/symbol):**
  - `src/App.tsx` -> блок `nextNote` (ветка с `displayScaleBars`/`frozenScaleRef`, расчет `compact`, обновление `playAbsBarRef`).
  - `src/SequencerGrid.tsx` -> `virtualRowCount` и `absR`/`rIdx = absR % bars`.
- **Risk:** средний на регрессию UI/Ta reveal при будущих изменениях: view-параметры (`displayScaleBars`, virtual rows) уже влияют на `absR`-траекторию, и при случайном расширении условий можно протянуть это в Ta-derived логику.
- **Minimal fix:** явно зафиксировать границу:
  - `absR/virtualRowCount/displayScaleBars` использовать только для scroll/highlight;
  - Ta/snapshot/audio решения принимать только по `rIdx` и состоянию, отфильтрованному по `bars` (`totalBars`).

3) В `SequencerGrid` Ta-видимость для legacy/default вычисляется по `rIdx` (data row), а не по `absR` (render row), что корректно, но участок хрупкий.

- **Evidence (file/symbol):**
  - `src/SequencerGrid.tsx` -> `showLegacyDefaultInNormal`, `showNonEditorDingWithLegacy`, `firstBeatRowSuppressed.has(rIdx)`.
  - Там же: row duplication через `virtualRowCount`, но Ta-предикаты используют `rIdx`.
- **Risk:** низкий сейчас, средний при рефакторе виртуализации (легко ошибочно подменить `rIdx` на `absR`).
- **Minimal fix:** добавить guard-комментарий/тест: при `virtualRowCount > bars` Ta-предикаты идентичны для всех копий строки (`absR % bars`).

STATUS: DONE
