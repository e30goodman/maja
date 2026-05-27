# CELL DIV0 Investigation Report

## Контекст
- Исследован кейс: `cell` с `Divs=0` при закрытом слайдере табуляров/панели (`isPanelExpanded=false`) в сценариях `longpress` и `point on`.
- Фокус: только `konnakol_trainer`, без изменений UI-геометрии и без фикса в коде (только анализ).

## Ключевой контракт `divs`
- В доменной модели `subdivs` не бывает `0`: только `1..9` (`clampSubdivs`, `ensureCellConfig`).
- Значение `0` на UI-слайдере `Divs` (`min=0`) не записывает `subdivs=0`; это команда mute.
- Реализация mute:
  - `nextInt===0` в `handleCellDivUpdate()` ставит mask `all false` для текущего количества subdiv.
  - `CellConfig` интерпретирует это как `isMuted=true`.
- Следствие: `Divs=0` в интерфейсе = "клетка заглушена", а не "в клетке 0 subdivisions".

## Точки в коде (source-of-truth)
- Модель и нормализация: `src/stepMask.ts`
  - `CellConfig` / `ensureCellConfig()` / `normalizeCellConfig()`.
  - `applyCellIntentToConfig('SLIDER_TO_ZERO')` -> `isMuted=true`, `subdivs` сохраняется.
- UI-слайдер Divs: `src/App.tsx`
  - `Divs` range `0..9`.
  - Отображение: `config.isMuted ? 0 : config.subdivs`.
  - Обновление: `handleCellDivUpdate(cellKey, nextValue)`.

## Flow 1: `longpress` на клетке при закрытой панели
1. `onPointerDown` в `src/SequencerGrid.tsx` запускает hold-таймер (`CELL_HOLD_MS`).
2. По таймеру:
   - захват pointer,
   - `isHoldingRef.current = true`,
   - проверка `panelExpanded = a.isPanelExpandedRef.current`.
3. Специальная ветка для muted-клетки при закрытой панели:
   - если `cellFullyMuted && !panelExpanded`, вызывается `a.handleCellDivUpdate(checkKey, 1)`,
   - затем `return` (циклирование subdiv по longpress не выполняется).

Итог для `longpress`:
- `Divs=0` -> перевод в `Divs=1` (unmute) одним удержанием.
- Редактор конкретной клетки не открывается при закрытой панели.

## Flow 2: `point on` (обычный pointer tap/click) на клетке при закрытой панели
1. `onPointerDown` только армит hold-логику.
2. Если удержание не достигнуто, срабатывает `onClick`.
3. В `onClick` для обычного режима выполняется `toggleAccent(...)`; изменения `divs` нет.

Итог для `point on`:
- `Divs=0` остается `0` (клетка остается muted), если это не longpress.
- По tap меняется акцент/другое поведение клетки, но не subdiv/mute state.

## Влияние состояния "слайдер закрыт"
- Закрытие панели (`isPanelExpanded=false`) принудительно очищает `activeEditCell`/`activeEditRow`.
- При закрытой панели longpress использует упрощенную ветку: для muted клетки только quick-unmute до `1`, без входа в расширенный режим редактирования.
- При открытой панели longpress идет в ветку с `nextSubdivLongPress(...)` и может открыть cell-edit контекст.

## Почему создается ощущение "проблемы divs=0"
- UI показывает `0` для `isMuted=true`; это намеренно.
- В рендере сетки `visualSubdivs` для fully-muted клетки насильно `1`, чтобы клетка оставалась визуально стабильной.
- Из-за этого пользователь видит:
  - в слайдере/значении: `0`,
  - в клетке: не "0 сегментов", а обычная визуальная ячейка.
- Это не рассинхрон данных, а выбранная модель отображения muted-состояния.

## MRS (минимальный воспроизводимый сценарий)
1. Открыть редактирование Divs для любой клетки.
2. Установить `Divs=0`.
3. Закрыть панель табуляров (`isPanelExpanded=false`).
4. Сценарий A: сделать `longpress` на этой клетке.
   - Ожидание по текущему коду: `Divs` станет `1` (unmute).
5. Сценарий B: сделать обычный tap (`point on`) по этой же клетке.
   - Ожидание по текущему коду: `Divs` останется `0`, меняется только click-логика клетки (например accent toggle).

## Root-cause / статус
- Root-cause не как bug в арифметике `subdivs`, а как семантика UX/interaction:
  - `0` трактуется как mute-команда.
  - Для закрытой панели longpress имеет отдельную "rescue" ветку (`0 -> 1`).
  - Tap не трогает mute/subdiv state.
- Если ожидание было иным (например, tap тоже должен снимать mute, или longpress должен открывать editor даже при закрытой панели), это продуктовый/interaction gap.

## Риски регрессии при будущем фиксе
- Нельзя ломать контракт `subdivs in 1..9` и логику `isMuted` через mask.
- Нельзя менять геометрию UI без явного разрешения.
- Нельзя ломать совместимость `customSubdivisions` + `cellStepMasks` + `cellConfigs` (legacy split/merge).

## Рекомендуемый план фикса (без внедрения)
1. Зафиксировать целевую UX-семантику для `point on` на muted-клетке при `isPanelExpanded=false`.
2. Если требуется унификация:
   - либо tap тоже делает `0 -> 1`,
   - либо убрать special-case unmute из longpress (менее вероятно желаемо).
3. Добавить unit/UI tests на матрицу сценариев:
   - `panel open/closed` x `tap/longpress` x `muted/unmuted`.
4. Проверить snapshot/backward compatibility для `cellConfigs` и legacy-полей.

## Критерии готовности будущего фикса
- Явно детерминированное поведение `tap` и `longpress` для muted-клетки в обоих состояниях панели.
- Нет появления `subdivs=0` в данных.
- Нет регрессии в рендере сетки и в mask-логике.
