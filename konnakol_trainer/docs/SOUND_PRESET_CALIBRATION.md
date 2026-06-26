# Sound preset calibration panel

Dev-панель для калибровки **parallel limiter** и **envelope gate** по связке **пресет × слой**.  
В обычном UI панель **скрыта**; runtime по-прежнему читает сохранённые значения из `localStorage` и baked defaults.

См. также общий аудио-путь: [SOUND_ENGINE_FLOW.md](./SOUND_ENGINE_FLOW.md).

---

## Как включить панель

1. Открой `src/App.tsx`.
2. Найди константу:

```ts
const SHOW_SOUND_PRESET_CALIBRATION_PANEL = false;
```

3. Поставь `true`:

```ts
const SHOW_SOUND_PRESET_CALIBRATION_PANEL = true;
```

4. Перезапусти dev-сервер (`npm run dev`) или пересобери (`npm run build`).
5. Панель появится **справа** от основного телефонного фрейма (на `sm+` ширине).

Чтобы снова скрыть — верни `false`. Код панели и store **не удаляются**.

---

## Слои (3 музыкальные роли)

| Слой в панели | Что калибруется |
|---------------|-----------------|
| **Passive** | обычные клики, шина `passive` |
| **Alt accent** | фиолетовый альт-акцент, шина `alt` |
| **Accent Ta** | Ta на первой доле / Ta-ding (`playBarFirstHighClick`) |

Внутренняя шина `accent` в Web Audio **не** является отдельным слоем калибровки.

---

## Пресеты

Список совпадает с `SOUND_PRESET_CALIBRATION_ORDER` в `src/soundPresetCalibration.ts` (21 пресет).

**Drum machine** — id `drum_machine` (legacy `hi_hat` мигрирует автоматически).  
Accent Ta для Drum machine — **предзаписанный сэмпл** (~200 ms), envelope с выравниванием по онсету 6 ms.

---

## Ручки envelope

| Ручка | Назначение |
|-------|------------|
| **Mix** | 0% = нативный decay слоя, 100% = полный gate |
| **Out** | громкость wet/gate-ветки (makeup) |
| **Fade in** | длина fade-in до пика (0–20 ms) |
| **Decay** | длина спада после пика (1–120 ms) |

Кнопки:

- **Fade-in · …** / **Decay · …** — форма кривой
- **Envelope → native** — Mix 0, сброс envelope-полей
- **Сброс слоя к baked** — заводские baked-значения для classic passive/ta и т.д.

Пока **Mix = 0%**, кручение Fade in / Decay **не влияет на звук** (можно настроить заранее, потом поднять Mix).

---

## Parallel

Gain, Wet, LA, Phase + пресет цепи (Tight / Punch / Glue / Sustain).

- **Passive / Alt** — через `syncVoiceBusParallelWet` на voice buses.
- **Accent Ta** — отдельная цепь `taAccentParallel.ts` → вход accent bus.

---

## Хранение

- Ключ: `konnakol_sound_preset_calibration_v1` в `localStorage`
- Автосохранение при любом изменении в панели
- Сброс storage (если нужно начать с нуля):

```js
localStorage.removeItem('konnakol_sound_preset_calibration_v1');
location.reload();
```

---

## Ключевые файлы

| Файл | Роль |
|------|------|
| `src/SoundPresetCalibrationPanel.tsx` | UI |
| `src/soundPresetCalibration.ts` | store, defaults, runtime lookup |
| `src/clickTailEnvelope.ts` | fade-in / decay / sample path |
| `src/parallelBusChain.ts` | parallel limiter DSP |
| `src/taAccentParallel.ts` | Ta-only parallel |
| `src/classicPassiveParallel.ts` | baked classic passive parallel |
| `src/taAccentEnvelope.ts` | baked classic passive/ta envelope |
