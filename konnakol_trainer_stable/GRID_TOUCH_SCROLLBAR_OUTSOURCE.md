# Grid / Touch / Scrollbar Outsource Dump

Цель файла: отдать внешнему исполнителю полную картину по `SequencerGrid` (сетка тактов), touch/pointer-жестам и скроллбару списка тактов.

## 1) Главные файлы

- `src/SequencerGrid.tsx` — вся логика отрисовки сетки, pointer/touch-жесты, скролл-контейнер тактов.
- `src/App.tsx` — сборка `SequencerGrid` пропсами, ref-обвязка, actionsRef для row-обработчиков.

## 2) Ключевые константы жестов (сейчас)

Файл: `src/SequencerGrid.tsx`

- `CELL_SUBDIV_ARM_SLOP_Y_PX = 10`
- `PULSE_ROULETTE_SLOP_Y_PX = 0`
- `PULSE_MODE_TOGGLE_CANCEL_SLOP_Y_PX = 8`
- `PULSE_HOLD_MS = 200`
- `CELL_HOLD_MS = 200`
- `allowedSubdivisions(...) => [1,2,3,4]` (4 позиции в рулетке cells)

## 3) Скроллбар тактов (вертикальный список rows)

Файл: `src/SequencerGrid.tsx`, контейнер `gridRef`:

- `overflow-y-auto overflow-x-hidden`
- webkit scrollbar стили:
  - `&::-webkit-scrollbar: w-1.5`
  - `thumb: bg-[#2f4066], rounded`
- inline style:
  - `scrollbarGutter: 'stable'`
  - `scrollbarColor: '#2f4066 transparent'`
  - `scrollbarWidth: 'thin'`
  - `width: 'calc(100% + 10px)'`
  - `paddingRight: '10px'`
  - `marginRight: '-10px'`

Это текущая схема «дотянуть контент до линии скроллбара и оставить видимый gutter».

## 4) Touch policy (текущее поведение)

### 4.1 Pulse-кнопка такта (gati/jati + roulette)

Файл: `src/SequencerGrid.tsx`, левая колонка row, вторая кнопка.

События:

- `onPointerDown`:
  - старт hold-таймера (`PULSE_HOLD_MS`)
  - `pointerCapture` НЕ на down, а при подтвержденном hold
- по таймеру hold:
  - `setPointerCapture(...)`
  - `a.isHoldingRef.current = true`
  - `lockElementTouchScroll(el)` => `el.style.touchAction='none'`
  - если до hold не было pre-move (`pulseMovedBeforeHoldRef=false`) — toggle gati/jati через `setPulseMeterUnlinked(...)`
  - `pulseHoldReadyRef = true`, haptic (`navigator.vibrate(50)`)
- `onPointerMove`:
  - до hold копится pre-move по `PULSE_MODE_TOGGLE_CANCEL_SLOP_Y_PX`
  - после hold: roulette по Y (шаг 16px), меняет `customSyllables` строки
- `onPointerUp/Cancel/Leave`:
  - очистка таймеров/refs
  - `releasePointerCapture` если захвачен
  - `unlockElementTouchScroll(el)` => удалить inline `touch-action`
- `onClick`:
  - гасится после hold через `pulseUnlinkJustFiredRef`, чтобы не было лишнего `+1`

### 4.2 Cells (subdivision roulette)

Файл: `src/SequencerGrid.tsx`, каждая ячейка строки.

События:

- `onPointerDown`:
  - нет раннего `pointerCapture` (приоритет обычному скроллу)
  - старт arm-сессии (`dataset.subdivArmStartY/latestY/active`)
  - старт hold-таймера (`CELL_HOLD_MS`)
- `onPointerMove`:
  - до hold: если |dy| > `CELL_SUBDIV_ARM_SLOP_Y_PX`, hold таймер отменяется
  - после hold: roulette по Y (`stepSubdivByDelta(...)`)
- по таймеру hold:
  - попытка `setPointerCapture`
  - если capture не подтвердился (`hasPointerCapture=false`) — выход
  - `a.isHoldingRef = true`, haptic
  - `lockElementTouchScroll(btn)` => inline `touch-action='none'`
  - старт `subdivHoldSessionRef`
- `onPointerUp/Cancel/Leave`:
  - release capture
  - очистка dataset/timer/session
  - `unlockElementTouchScroll(btn)`

## 5) CSS touch-action стратегия (сейчас)

Файл: `src/SequencerGrid.tsx` className:

- pulse button: содержит `touch-pan-y`
- cells button: содержит `touch-pan-y`

Идея:

- по умолчанию скролл разрешен вертикально (`pan-y`)
- только при подтвержденном hold конкретный элемент временно получает `touch-action: none`

## 6) Интеграция с App (важно для аутсорса)

Файл: `src/App.tsx`:

- `gridRef` создается в App и передается в `SequencerGrid`
- `sequencerGridRowActionsRef.current = { ... }` формируется в App:
  - таймеры и refs (`holdTimerRef`, `pulseUnlinkHoldTimerRef`, `isHoldingRef`, `subdivHoldSessionRef`, ...)
  - state setters (`setCustomSubdivisions`, `setCustomSyllables`, `setPulseMeterUnlinked`, ...)
  - `onPulseLongPressModeSwitch(...)` — перевод random parent между `gati_mode`/`jati_mode`
- рендер:
  - `<SequencerGrid ... sequencerGridRowActionsRef={...} setRowElStable={...} />`

## 7) Поведение режима gati/jati на pulse (актуально)

- long-press на pulse (`PULSE_HOLD_MS=200`) может включить/выключить gati/jati
- если до hold был немедленный сдвиг пальца по Y (pre-move > `PULSE_MODE_TOGGLE_CANCEL_SLOP_Y_PX`), toggle режима пропускается
- в этом сценарии работает roulette без лишнего toggle

## 8) Горячие точки для анализа внешним подрядчиком

1. `width/paddingRight/marginRight` у scroll-контейнера — проверить, не ломает ли drag скроллбара в конкретных браузерах/плотностях DPI.
2. `touch-pan-y` + временный inline `touch-action:none` — проверить кроссбраузерно (Android Chrome / iOS Safari / desktop touch).
3. `pointerCapture` timing:
   - pulse: capture после hold
   - cells: capture после hold и только при успешном захвате
4. suppress click после hold (`pulseUnlinkJustFiredRef`, `isHoldingRef`) — проверить отсутствие побочных `+1`.
5. `onPointerLeave` логика при наличии capture — не терять gesture сессию и не залипать в blocked-scroll.

## 9) Быстрый checklist ручной проверки

1. Свайп по списку тактов на пустом месте и поверх cells/pulse: скролл сразу.
2. Hold на pulse без движения: gati/jati toggle + индикатор под удержанием.
3. Hold на pulse с немедленным slide: roulette, без toggle режима.
4. Hold на cell + slide Y: subdivision roulette (1/2/3/4), haptic при старте hold.
5. После любого cancel/up/leave: скролл мгновенно возвращается, ничего не «залипает».

