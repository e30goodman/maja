# 2. Полиритм: акцент Ta, кнопка Ta, редактор Ta

## 2.1. Модель данных (два слоя)

### Плоский слой (как в легаси)

- **`taDingKeys: Set<string>`** — ключи `"row-col"` с **явным** Ta-ding (звук / белая рамка в UI там, где правила рисования это разрешают).
- **`accents: Set<string>`** — акцентированные клетки.
- **`firstBeatAccent: boolean`** — глобальный «Ta на первой доле» в простом режиме.
- **`firstBeatDingSuppressedRows: Set<number>`** — в **редакторе Ta** пользователь снял дефолтную белую метку на `col 0` для строки `row` (без добавления ключа в `taDingKeys`).

### Полиритм (по голосам / линиям)

- **`taDingKeysByLane`**, **`accentsByLane`**, **`firstBeatAccentByLane`** — карты `lane → Set keys` или `lane → bool`.
- При загрузке снапшота, если в JSON нет lane-карт, они **восстанавливаются** из плоских множеств через `distributeSetToLanes` (`parseSnapshotRow`).
- **`useEffect` в `App.tsx`**: при включённом `polyMode` изменения плоских `accents` / `taDingKeys` **перераскладываются** по линиям (`distributeSetToLanes`), чтобы не рассинхрониться.

**Канонический путь аудио/подсветки в poly:** часто читают **lane-версии** через хелперы `getLaneTaSetRef`, `getLaneAccentsSetRef`, `flattenLaneSetMap` для UI.

## 2.2. Кнопка «Ta» внизу панели (не редактор)

Файл: `App.tsx`, нижний ряд кнопок.

| Жест | Поведение |
|------|-----------|
| **Короткий тап** | **Легаси:** `setFirstBeatAccent(prev => !prev)`. **Полиритм:** одним `flushSync` выставляется **одинаковое** значение Ta для **всех линий** (`firstBeatAccentByLane` 0/1/2 = одно и то же), синхронно `firstBeatAccent` с lane 0. Это сознательно «как в легаси», но на все голоса. |
| **Долгое нажатие** (`SNAPSHOT_MENU_HOLD_MS`) | Переключение **`isTaEditorMode`**: войти/выйти из режима правки белых рамок Ta по клеткам. |

Визуал кнопки: подсветка зависит от `isTaEditorMode`, `polyMode ? firstBeatAccentByLane[activeClickVoiceTarget] : firstBeatAccent`, `isDeadCellsEditorMode`.

## 2.3. Видимость Ta на сетке (`SequencerGrid.tsx`)

В строку передаётся **битовая строка** `taDingSig` по уже выбранному ряду (в poly это ряд **конкретного голоса** после мультиплексирования `absR`).

### Режим редактора (`isTaEditorMode === true`)

- Белая рамка **только** если в бите `taDingSig[c] === '1'` (**явный** ключ), см. `showEditorDing`.
- Тап по клетке вызывает `toggleTaDing(r, c)` — не трогает акцент напрямую.

### Обычный режим

Флаг **`showNonEditorDing`** (ядро логики):

1. **Любая колонка > 0:** достаточно `isTaDing` — явный Ta на этой доле.
2. **Колонка 0 (первая доля):** белая рамка только если:
   - не мёртвая ячейка;
   - **не** режим редактора;
   - строка **не** в `firstBeatRowSuppressed` (из `firstBeatDingSuppressedRows`);
   - и выполняется **одно из**:
     - есть явный Ta в бите; **или**
     - `accentMapVersion === 0` **и** `forceFirstBeatEditorFrames` **и** нет явного Ta на долях >0 (`!rowHasExplicitTaDingPastCol0`) — это «легаси-фантом» белой рамки для подсказки редактора первой доли.

**`accentMapVersion`:** при версии **1** карта акцентов на первых долях **явная**; легаси-ветка с `=== 0` отключает авто-фантомы там, где они мешают.

**`forceFirstBeatEditorFrames`:** считается в `App.tsx` из `firstBeatAccent`, `taDingKeysUi`, suppressed rows — если нужно держать белые рамки видимыми для редактирования первой доли.

### Что видит грид из `App` по Ta

- **`taDingKeysUi`**: в poly — `flattenLaneSetMap(taDingKeysByLane, ...)`, иначе плоский набор.
- **`visibleTaDingKeys`**: в poly = `taDingKeysUi`; в легаси при **выключенном** глобальном Ta возвращает **пустой** Set — тогда сетка не подсвечивает Ta, пока пользователь снова не включит кнопку.

## 2.4. Аудио (кратко)

Первая доля / Ta на звук завязаны на `resolveFirstBeatHitRow`, `getLaneTaSetRef`, `playBarFirstHighClick` / `playSharpClick` в `App.tsx`. Ломать визуал Ta и аудио Ta — **разные** регрессии; при починке UI проверяйте **и** воспроизведение первой доли в poly.

## 2.5. Чек-лист: что проверить после правок

1. **Poly on, 2 и 3 голоса:** тап Ta — все линии в одном состоянии; доли `r-0` подсвечиваются согласованно.
2. **Редактор Ta:** долгое нажатие на кнопку Ta → рамки только по явным ключам; тап по `0` доле toggles ключ в `taDingKeys` / lane-map.
3. **`visibleTaDingKeys`:** в легаси при `firstBeatAccent === false` нет «фантомных» Ta; в poly ключи из lane не пропадают.
4. **Снапшот / paste:** lane-карты круглятся через `flatten` / `distribute` — после вставки Ta на тех же клетках.

## 2.6. Инструкция «вызвать обратно», если сломалось

### Симптом: кнопка Ta не реагирует / не переключает полиритм

1. Найти обработчик `onClick` / `onPointerDown` кнопки Ta в `App.tsx` (поиск `taHoldTimerRef`, `setIsTaEditorMode`).
2. Убедиться, что **`disabled={isDeadCellsEditorMode}`** не оставлен случайно при других флагах.
3. Проверить, что **`flushSync`** в poly-ветке тапа не удалили — иначе рассинхрон state/ref.

### Симптом: в poly белая рамка на первой доле везде или нигде

1. Открыть `SequencerGrid.tsx`, блок `showNonEditorDing` / `rowHasExplicitTaDingPastCol0`.
2. Сверить с **`accentMapVersion`** и **`forceFirstBeatEditorFrames`** из `App.tsx` (`useMemo` рядом с `firstBeatEditorSuppressedSig`).
3. Не удалять условие `!rowHasExplicitTaDingPastCol0` без замены — оно гасит фантом, когда пользователь уже поставил Ta на другие доли.

### Симптом: Ta в аудио есть, в UI нет (или наоборот)

1. Разделить цепочки: **данные** (`taDingKeys` / ByLane) vs **видимость** (`visibleTaDingKeys`) vs **отрисовка** (`showNonEditorDing`).
2. Проверить `toggleTaDing` в `App.tsx` — в poly должен обновлять **lane**-мапу и затем `flatten` в плоский при необходимости.

### Симптом: после снапшота lane-Ta пропал

1. `parseSnapshotRow`: наличие `taDingKeysByLane` в JSON; иначе `distributeSetToLanes` из плоского.
2. Не хранить только плоский без lane в полиритме — восстановление даст **не** тот же разнос по голосам.

### Откат кода

```text
git log --oneline -- konnakol_trainer/src/App.tsx konnakol_trainer/src/SequencerGrid.tsx
git show <commit>:konnakol_trainer/src/SequencerGrid.tsx
```

Точечный откат только при понимании диффа — эти два файла общие для многих фич.

---

*Канон: `konnakol_trainer/src/App.tsx` (состояние Ta, полиритм, снапшоты), `konnakol_trainer/src/SequencerGrid.tsx` (рамки и hit-target клеток).*
