# DEBUG_CHECKLIST — операционные ассерты parent progressive

Синхронизация с кодом: `src/lessonLogger.ts` (`evaluateAestheticDiagnostics`, `computeMuktayiCheck`), `src/parentMode.ts` (`applyPrasaContinuity`, `enforceThomRule`, `de_sync_prep`), тесты `parentMode.test.ts`, `lessonLogger.test.ts`.

| Check ID | Условие | Ожидание | Failure mode |
|----------|---------|----------|--------------|
| `ASSERT_THOM_POSITION` | Встречен слог `Thom` | Финал tihai-landing **или** закрытие Arudi **или** акцент при высоком `i` (см. флаг `thomLegality`) | «Проходной бас», размытие гравитации Sam |
| `ASSERT_SCS_ROW` | Переходы слогов в живой части | `sequenceCheck` / `syllableContinuity`: индекс следует `(prev+step)%rowLength` (step=1, учёт `subdivisionHits`) | Поломка геометрии ряда; ложные эстетические штрафы |
| `ASSERT_PRASA_RECOG` | Сравнение с anchor **фразы** (первый такт с тем же `phraseId`) | `editFromPhraseAnchor ≤ min(PrasaMaxEdit, ⌊N/2⌋)` и тема vs parent в пределах `prasaLimit` фазы | Parent неузнаваем внутри фразы |
| `ASSERT_PRASA_RUNTIME` | После `applyPrasaContinuity` | Расхождения от anchor по классу токена ≤ `maxDiffs` (см. `parentMode.ts`) | Рантайм нарушил узнаваемость до логгера |
| `ASSERT_KARVAI_JATI` | `deSyncJati`: первый такт после `Pulse Shift` | Структурный буфер (bridge / prep) **и** если предыдущий такт полностью karvai — длина ≥ 4 пульсов | Смена Jati «в лоб» |
| `ASSERT_SAM_FINAL` | Последний значимый слог урока | `globalPulse % 8 === 7`, слог Ta/Thom, **акцент**; tihai landing задаёт `Thom` | Неверная посадка / слабый финал |
| `ASSERT_SUBDIV_STRONG_ENTRANCE` | `subdivisions[c] > 1` | Акцент на индексе клетки `c` (первая поддола пакета) | Акцент «спрятан» внутри пакета без декларации |
| `ASSERT_EDUPPU` | Не exempt-бары | Флаг `eduppuEntry`: синкопа / lift или exempt по фазе | Механический вход в Sam |
| `ASSERT_VARNA` | Плотность hard-hard стыков | Пороги `varnaPhoneticFlow` в логгере | «Заикание», стена согласных |
| `ASSERT_LAYA_ODD` | Jati 5/7/9 | `layaGatiCharacter`: плотность + `subdivAir` | Нет микро-воздуха в нечётном цикле |
| `ASSERT_SHADOW` | Подряд destabilization | `shadowingBreath`: не два complex подряд без дыхания | Перегруз destabilization |
| `ASSERT_SYL_NORM_1_9` | Перед сборкой слогов | `syllableAssembly.subdivNormalization`: все `normalizedValues` в `1..9`, контракт `normalizationContractOk=true` | Некорректные поддоли, дрейф словаря |
| `ASSERT_SYL_DEAD_TAIL` | Есть `deadStart < rowSyllCount` | `syllableAssembly.deadTail.tailSilentByDot=true`, `deadTailContractOk=true` | «Призрачные» слоги в мёртвом хвосте |
| `ASSERT_SYL_SEGMENT_POLICY` | В живой зоне есть `subdivs==1` сегменты | `syllableAssembly.phraseLenPolicy.segmentRanges` + `npsKalamBootstrap.cells[source=sarva_segment]`, контракт `segmentContractOk=true` | Неверный phraseLen/NPS для Sarva Laghu |
| `ASSERT_SYL_KALAM_BOOTSTRAP` | Любая живая клетка | `syllableAssembly.npsKalamBootstrap.cells[]`: `phraseLen`, `source`, `nps`, `kalam` | Невозможно верифицировать выбор Kalam на старте |
| `ASSERT_SYL_LONG_SEGMENT` | `segment.length > 9` | `syllableAssembly.phraseLenPolicy.longSegments[]` (ожидается non-empty только при длинных сегментах) | Длинный сегмент прошёл без явной фиксации compose-policy |

**Поля JSON:** `bars[].aestheticDiagnostics.prasaAnchor`, `syllableContinuity`, `progressT`, `bars[].syllableAssembly.subdivNormalization`, `bars[].syllableAssembly.deadTail`, `bars[].syllableAssembly.phraseLenPolicy`, `bars[].syllableAssembly.npsKalamBootstrap`, `summary.poetry`.
