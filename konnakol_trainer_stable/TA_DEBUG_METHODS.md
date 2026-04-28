# TA Debug Methods (konnakol_trainer_stable)

Практический playbook для диагностики багов `Ta/c0`, UI/audio desync и регрессий после resize/snapshot.

Источник контракта: `TA_LOGIC_GUIDE.md`.

---

## 1) Базовые инварианты (проверять первыми)

1. Белая рамка `Ta` и фиолетовый `accent` - независимые слои.
2. В poly source of truth: `accentsByLane`, `taDingKeysByLane`, `firstBeatAccentByLane`.
3. В Ta-editor на `c0` при активном default first-beat клик переключает suppression, а не explicit `r-0`.
4. Runtime first-beat policy не привязывается к `accentMapVersion`.
5. Любые Ta-решения считаются в data-domain (`totalBars`), а не через `visibleBars`/`virtualBars`.

Если инвариант нарушен, это почти всегда root cause.

---

## 2) Метод "Быстрый triage"

При первом воспроизведении бага снимайте компактный runtime-срез:

```ts
{
  mode: { polyMode, isTaEditorMode },
  laneId,
  row: r,
  col: c,
  on0Accent,
  on0Ding,
  firstBeatEnabled,
  suppressedRow,
  firstBeatHitPolicy,
  firstBeatCellHitRow
}
```

Интерпретация:

- `firstBeatCellHitRow=false` при `fa=true`, `supRow=false`, `policy=legacy` -> поломка policy/гейта.
- `firstBeatCellHitRow=true`, но рамки нет -> визуальный баг (visibility).
- рамка есть, звука нет -> баг в audio-ветке/гейтах playback.

---

## 3) Метод "Матрица c0" (обязательная регрессия)

Всегда прогоняйте комбинации:

- `mono/poly`
- `editor/normal`
- `firstBeat on/off`
- `suppressed true/false`
- `accentMapVersion 0/1`
- `totalBars 1/2+`

Критические кейсы:

1. `bars=1`: изменение вне `c0` -> выход из editor -> `c0` не должен пропасть в normal.
2. Возврат сетки в default -> `c0` может снова скрыться в normal.
3. `firstBeat=true`, клик `c0` в editor -> только suppression toggle.
4. `firstBeat=false`, клик `c0` -> обычный explicit `r-0`.
5. Poly lane isolation: lane1 не получает ghost `Ta` от lane0.
6. `accentMapVersion=1` не должен принудительно вести к `explicit_ta_only`.

---

## 4) Метод "Resize/Snapshot forensic"

При баге "после resize/load":

1. Сравните state до/после по row-based структурам:
   - `firstBeatDingSuppressedRows`
   - `taDingKeys*`
   - `accents*`
   - `deadCells`
2. Убедитесь, что pruning идет по `totalBars`.
3. Проверьте, что snapshot-parse не теряет suppression (`Set/Array`) и lane maps.

Сигнал проблемы: после downsize до `1` сбрасываются reveal-триггеры, хотя изменения сетки остались.

---

## 5) Метод "UI/Audio parity split"

Разделяйте диагностику на 2 слоя:

- UI-слой:
  - `showEditorDing`
  - `showNonEditorDing`
  - `canShowDefaultTaInNormal`
  - `isTaGridAtDefault`
- Audio-слой:
  - `resolveFirstBeatHitRow(...)`
  - `shouldPlayFirstBeatTa`
  - MIDI parity ветка

Если для одного и того же `(r,c,lane,suppression,policy)` UI и Audio дают разный итог, баг почти всегда в derived visibility или ad-hoc рендер-условии.

---

## 6) Минимальный regression-pack команд

Запуск из `konnakol_trainer_stable`:

```powershell
npx tsx src/taVisibility.test.ts
npx tsx src/barsDomain.test.ts
npx tsx src/midiExport.test.ts
npm run lint
```

Эти проверки покрывают:

- normal visibility/reveal на `c0`,
- bars-domain pruning,
- parity first-beat в MIDI-политике.

---

## 7) Быстрый pre-merge чек

1. Poly 2-voice: нет lane bleed и ghost `Ta`.
2. `c0` в editor корректно работает через suppression-модель.
3. В normal explicit `c>0` не зависит от default `c0` reveal.
4. Snapshot save/load сохраняет suppression и lane maps.
5. UI и audio совпадают на `c0` и explicit `c>0`.
