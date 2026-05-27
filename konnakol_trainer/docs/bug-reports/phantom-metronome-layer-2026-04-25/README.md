# Phantom Metronome Layer (2026-04-25)

## Technical Description

### Problem

Intermittently, users hear a low "phantom" metronome layer even when metronome sliders are set to zero.
Observed behavior:

- sometimes tied to first-beat cells (`c0` / Ta-first-beat path),
- sometimes perceived across many/all cells,
- partially affected by passive mute controls,
- not consistently silenced by bus sliders in runtime perception.

### Root-Cause Hypotheses (validated during isolation)

1. Audio routing has multiple emission branches (not a single unified trigger path):
   - first-beat/Ta branch (`playBarFirstHighClick(...)`),
   - regular role-based branch (`playSharpClick(...)` with `accent|alt|base`).
2. Branches were not uniformly guarded by effective gain checks before scheduling.
3. For some execution paths, sound scheduling could still happen even when role/bus gain was effectively zero from the user perspective.

### Why It Happened

The engine computes events in separate logical branches:

- first-beat Ta articulation path,
- role-based grid path (accent/alt/base-passive),
- overlap handling path.

Mute intent from sliders was not enforced with a strict "do not schedule at zero gain" rule across all branches.
As a result, rare branch combinations could produce residual audible events.

### Isolation Process Used

1. Binary disabling of suspect layered presets.
2. Runtime branch isolation with temporary kill toggles:
   - first-beat branch,
   - accent role,
   - alt role,
   - base/passive role.
3. Confirmation outcome:
   - major residual source was first-beat branch,
   - additional part came from base/passive route.

### Implemented Fix

In `src/App.tsx`:

1. Added hard guard in `playBarFirstHighClick(...)`:
   - return early when `voiceGainMul <= 0`.
2. Computed `accentGain` once in scheduling flow and used it for first-beat/ta-ding calls.
3. Enforced first-beat/ta-ding scheduling only when `accentGain > 0`.
4. Added strict role-gain guard for regular role path:
   - if computed `voiceRoleGain <= 0`, do not call `playSharpClick(...)`.
5. Removed temporary debug UI/toggles and temporary preset-disable diagnostics after validation.

### Expected Result

- With bus/role gain at zero, corresponding branch does not schedule any sound.
- No residual low phantom layer from first-beat or passive/base route.
- Runtime behavior remains consistent with user-visible mixer controls.

---

## Human-Friendly Explanation

### Что было не так

Иногда в приложении оставался тихий "призрачный" клик, даже когда громкость метронома была выкручена в ноль.
Это выглядело как будто играет невидимая сетка.

### Почему так вышло

Звук в приложении запускается не одной кнопкой, а несколькими внутренними дорожками:

- отдельная дорожка для первой доли (Ta/first-beat),
- обычная дорожка для ролей (акцент, альт, пассив).

Часть этих дорожек не всегда проверяла "громкость реально ноль?" перед запуском звука.

### Что сделали

- Добавили строгую проверку: если итоговая громкость ветки `<= 0`, звук вообще не создается.
- Отдельно поправили first-beat ветку, чтобы она тоже уважала нулевую громкость.
- Убрали временные тестовые тумблеры и вернули чистый интерфейс.

### Итог

Если пользователь ставит громкость в ноль, соответствующий слой теперь должен молчать полностью, без фантомных низких хвостов.

