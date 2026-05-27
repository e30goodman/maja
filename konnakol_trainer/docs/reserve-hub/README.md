# Резервный хаб (документация под Git)

Каноническая копия знаний по двум хрупким подсистемам тренера. При регрессии сверяйте с **текущим** кодом в `src/App.tsx`, `src/SequencerGrid.tsx` — этот хаб не исполняется рантаймом, только поясняет.

| Файл | Тема |
|------|------|
| [01-snapshot-clipboard-cipher.md](./01-snapshot-clipboard-cipher.md) | Компактный пресет в буфере: маркер, p1/p2/p3, флаги, ветки декодера |
| [02-poly-ta-accent-editor.md](./02-poly-ta-accent-editor.md) | Полиритм + Ta: данные, UI кнопки Ta, сетка, редактор, восстановление |

**Быстрый поиск в коде:** `encodeSnapshotClipboard`, `tryDecodeSnapshotClipboard`, `packGridTokenPacked`, `unpackGridTokenPacked`, `buildSnapshotFlags`, `visibleTaDingKeys`, `toggleTaDing`, `firstBeatAccentByLane`.
