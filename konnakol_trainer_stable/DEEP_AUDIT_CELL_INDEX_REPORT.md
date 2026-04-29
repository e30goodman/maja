# DEEP AUDIT: Cell0 vs Cell1+ (Sequencer)

## Симптом и воспроизведение

- Сценарий: в `Divs` слайдере конкретной ячейки установить `0` (soft masking: `subdivs` не обнуляется, маска становится `[false...]`).
- Факт:
  - `cIdx=0` (Cell 1) очищается сразу.
  - `cIdx>=1` (Cell 2+) может продолжать показывать старый слог (`Ka` и т.п.) до внешнего триггера ререндера.

## Блок 1: Falsy Index Trap и ключи

### Результат

- Классической ловушки `if (cIdx)` не найдено в критичном UI/label потоке.
- Индексные ветки в основном явные (`cIdx === 0`, `cIdx >= 1`, `activeEditCell === null`), не truthy/falsy.
- `cellKey` формируется стабильно как `${row}-${cell}` и читается через `split('-')` с валидацией.

### Вывод

- Корень бага не в falsy-обработке индекса `0`.
- `0` и `1` расходятся не из-за `if (idx)`, а из-за различной ветки генерации слогов.

## Блок 2: Три логики ввода (Slider / Expanded LP / Collapsed LP)

## 1) Specific Cell Slider

- Путь:
  1. `activeEditCell` -> `cellKey`.
  2. `onChange` Divs:
     - если `nextValue===0`: `setCellStepMasks(...[cellKey]=Array(currentSubdivs).fill(false))`.
     - иначе: `setCustomSubdivisions(...[cellKey]=nextValue)` и очистка маски.
  3. Рендер получает `cellStepMasks` + `customSubdivisions`.

## 2) Long-press (expanded panel)

- Путь:
  1. `onPointerDown` на cell -> таймер hold.
  2. После hold: `nextSubdivLongPress(current, panelExpanded=true)` (диапазон `1..9`).
  3. `setCustomSubdivisions(...[checkKey]=next)`.
  4. При drag по Y: `stepSubdivByDelta(..., panelExpanded=true)` -> `setCustomSubdivisions`.

## 3) Long-press (collapsed panel)

- Идентичный путь, но `panelExpanded=false`.
- Диапазон циклов только `1..4`.

### Вывод по блоку 2

- Все 3 пути корректно адресуют cell через один и тот же ключ `${rIdx}-${cIdx}`.
- Ключевая разница бага не в маршруте ввода, а в upstream генерации labels после изменения state.

## Блок 3: Upstream mute-логика (buildRowCellSyllableLabels)

## Найденная корневая причина (подтверждено кодом)

В `buildRowCellSyllableLabels` для `subdivs===1` маска шага проверяется **только для текущего `cIdx` до входа в сегмент**, но **не применяется поячейчно внутри сегмента** `segStart..segLen`.

Упрощенно:

1. Для текущего `cIdx`:
   - если `stepMask[0] === false` -> push `['-']` (работает для `cIdx=0`, когда он текущий).
2. Иначе строится contiguous-segment всех соседних `subdiv=1`.
3. Для элементов сегмента push идет как `phrase[i]`, без проверки их `stepMask`.

### Почему именно `cIdx=0` "магически" работает

- При mute `cIdx=0` он попадает в early-branch `stepMask[0]===false`, получает `'-'`.
- При mute `cIdx=1` (когда `cIdx=0` не muted) цикл сначала заходит в сегмент с `segStart=0`, и `cIdx=1` получает слог из сегментной фразы (`Ka`) без учета его mask.

### Проверка гипотезы про `withAccent` и reference reuse

- `withAccent` всегда создает новые объекты (`phrase.map(...)`), не возвращает старые ссылки.
- `rowCellLabelsEqual` сравнивает содержимое (`syl`, `accent`) глубоко; кэш повторно использует старую строку только при полном равенстве.
- Значит проблема не в `withAccent`/memo-референсах, а в неправильной mute-семантике для сегментов.

## Блок 4: UI Layer и fallback

- JSX ячейки рендерит:
  - `const syl = rowCellLabels[cIdx]?.[i]?.syl ?? ''`
  - `mutedGlyph = syl === '-' || syl === '–'`
  - текст: `isDead || mutedGlyph ? '' : syl`
- То есть UI слой корректен: если upstream отдаст `'-'`, ячейка визуально очистится.
- `subdivSig` и `rowStepMaskSig` собираются позиционно по `c=0..rowSylls-1`; для row-мемо они участвуют в props-сравнении.
- Следовательно, залипание для `cIdx>=1` вызывается upstream label data, а не JSX fallback.

## Дифференциальная таблица (ожидание/факт)

- `cIdx=0`, mask=false:
  - ожидание: пусто
  - факт: пусто
  - причина: early-branch `stepMask[0]===false` применяется на текущем индексе.
- `cIdx=1`, mask=false (при `cIdx=0` не muted):
  - ожидание: пусто
  - факт: старый слог до внешнего ререндера/действия
  - причина: попадание в сегмент `subdiv=1`, где per-cell mask для сегмента не применяется.

## Минимальный безопасный fix-план (без UI-геометрии)

1. В `buildRowCellSyllableLabels` после вычисления сегментной фразы (`segStart..segLen`) применять mask для каждой ячейки сегмента:
   - для `segCellKey = \`${rowIdx}-${segStart+i}\`` брать `resolveEffectiveStepMask(segCellKey, 1, cellStepMasks)`.
   - если `mask[0]===false`, пушить `'-'`, иначе `phrase[i]`.
2. Не трогать UI/JSX/CSS слой.
3. Сохранить текущие контракты:
   - независимость white Ta и purple accent;
   - `totalBars` как data SoT;
   - snapshot backward compatibility.

## Риск регрессии

- Низкий в UI-геометрии (не меняется).
- Средний в логике генерации labels для `subdiv=1` сегментов (затрагивает только mute-поведение).
- Контрольные зоны:
  - mono/poly parity;
  - `bars=1`, особенно `c0`;
  - snapshot save/load для `cellStepMasks`;
  - `c0` и `c>0` UI/audio parity.

## Рекомендуемый чек-лист валидации после фикса

1. `Divs=0` через slider на `c0`, `c1`, `cLast` -> мгновенно пусто.
2. Повторить для row с несколькими contiguous `subdiv=1`.
3. Повторить после long-press циклов (expanded/collapsed).
4. Проверить shift-click mute шага внутри subdiv>1 ячеек.
5. Проверить snapshot round-trip и поведение после восстановления.
