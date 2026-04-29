import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGridLessonLogMarkdown } from '../src/lessonLogger';

type TimingPoint = {
  globalStep: number;
  bar: number;
  cell: number;
  sub: number;
  timeMs: number;
  beatInBar: number;
  pulseProgress: number;
};
type MidiNoteOn = {
  note: number;
  timeMs: number;
  lane: 0 | 1 | 2 | null;
  role: 'accent' | 'alt' | 'passive' | 'other';
  pan: number;
};

type ParsedSnapshotToken = {
  raw: string;
  segments: string[];
  tempo?: number;
  bars?: number;
  baseSyllables?: number;
};

type TimingReport = {
  tempo?: number;
  bars?: number;
  baseSyllables?: number;
  baseCellDurationMs?: number;
  barDurationMs?: number;
  totalTimelineMs?: number;
  points: TimingPoint[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const defaultReportPath = path.join(projectRoot, 'logs', 'snapshot-timing-report.md');
const defaultOutPath = path.join(projectRoot, 'logs', 'decoded-snapshot-timing.json');
const defaultSnapshotToken6Bars =
  '100.6.4.p3UAMGBAQBBQIGAwUFBQAdQgQiBAAAAAAAGwAAAwABAgACAwADAgAEAgAFAgAGAgAHAwAIAgAJAgAKAgALAgAMAgAPAgAQAgARAgASAgATAgAUAgAVAgAWAwAXAgAYAgAZAgAaAgAbAwAcAgABAgA.0.45.446.9';
const defaultSnapshotToken4Bars =
  '148.4.4.p3UAMEBAMBBQIGAwUAFEIEAgAAAAASAAADAAECAAIDAAMCAAQDAAUDAAYCAAcJAAgDAAkCAAoCAAsCAAwCAA8CABACABECABICABMCAAEDAA.0.45.446.9';
const defaultSnapshotToken4BarsFast =
  '220.4.4.p3UAMEBAMBBQIGAwUAFP__BwAAAAASAAADAAECAAIDAAMCAAQDAAUDAAYCAAcJAAgDAAkCAAoCAAsCAAwCAA8CABACABECABICABMCAAEDAQ.0.45.446.9';
const defaultSnapshotToken4BarsFastBar2Accent =
  '220.4.4.p3UAMEBAMBBQIGAwUAFJ__BwAAAAASAAADAAECAAIDAAMCAAQDAAUDAAYCAAcJAAgDAAkCAAoCAAsCAAwCAA8CABACABECABICABMCAAEDAQ.0.45.446.9';
const defaultSnapshotToken9BarsFastPoly3 =
  '220.9.4.p3UAMJBAMBBQIGAwUAKJ__BwAAAAAAAAAAEwAAAwABAgACAwADAgAEAwAFAwAGAgAHCQAIAwAJAgAKAgALAgAMAgAPAgAQAgARAgASAgATAgAeAgACAwcB.0.45.958.9';
const defaultSnapshotToken30BarsFastPoly3 =
  '220.30.4.p3UAMeBAQBBQIGAwUdCQCBn_8HAAAAAAAAAAAAAAAACAEAAAAAAAAAAAAAAAAAAAACAAASAAADAAECAAIDAAMCAAQDAAUDAAYCAAcJAAgDAAkCAAoCAAsCAAwCAA8CABACABECABICABMCAR0CAgMdAQ.0.45.958.9';
const SNAPSHOT_CLIPBOARD_MARKER = '(⁠ʘ⁠ᴗ⁠ʘ⁠)⁠♪:';
const defaultLessonTargetPath = path.join('c:\\Users\\user\\Downloads', 'lesson-log-0 (7).md');
const SNAPSHOT_CLIPBOARD_PREFIX_V2 = 'konnakolTrainerSnapshotV2:';
const MIDI_ACCENT_BY_LANE: Record<0 | 1 | 2, number> = { 0: 36, 1: 47, 2: 29 };
const MIDI_ALT_BY_LANE: Record<0 | 1 | 2, number> = { 0: 38, 1: 39, 2: 53 };
const MIDI_PASSIVE_BY_LANE: Record<0 | 1 | 2, number> = { 0: 42, 1: 37, 2: 76 };
const MIDI_PAN_BY_LANE: Record<0 | 1 | 2, number> = { 0: 64, 1: 40, 2: 88 };

function parseNumberField(md: string, label: string): number | undefined {
  const regex = new RegExp(`-\\s*${label}:\\s*\\\`?([0-9.]+)`, 'i');
  const match = md.match(regex);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseTimingPoints(md: string, barDurationMs?: number): TimingPoint[] {
  const rows = [
    ...md.matchAll(
      /-\s*`(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)(?:\.(\d+))?\s*\|\s*([0-9.]+)(?:\s*\|\s*[^`]+)?`/g,
    ),
  ];
  return rows.map((row) => {
    const globalStep = Number(row[1]);
    const bar = Number(row[2]);
    const cell = Number(row[3]);
    const sub = Number(row[4] ?? 1);
    const timeMs = Number(row[5]);
    const beatInBar = cell;
    const pulseProgress = Number.isFinite(barDurationMs) && (barDurationMs ?? 0) > 0
      ? Number((((timeMs % (barDurationMs as number)) / (barDurationMs as number)) * 1000).toFixed(3))
      : 0;
    return { globalStep, bar, cell, sub, timeMs, beatInBar, pulseProgress };
  });
}

function readVarLen(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let i = offset;
  while (i < bytes.length) {
    const b = bytes[i];
    value = (value << 7) | (b & 0x7f);
    i += 1;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: i };
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

function parseMidiNoteOns(buffer: Uint8Array): MidiNoteOn[] {
  if (buffer.length < 14) return [];
  if (String.fromCharCode(...buffer.slice(0, 4)) !== 'MThd') return [];
  const headerLen = readU32BE(buffer, 4);
  const division = ((buffer[12] ?? 0) << 8) | (buffer[13] ?? 0);
  const ticksPerBeat = division > 0 ? division : 960;
  let offset = 8 + headerLen;
  const notes: MidiNoteOn[] = [];

  while (offset + 8 <= buffer.length) {
    const chunkType = String.fromCharCode(...buffer.slice(offset, offset + 4));
    const chunkLen = readU32BE(buffer, offset + 4);
    offset += 8;
    if (offset + chunkLen > buffer.length) break;
    if (chunkType !== 'MTrk') {
      offset += chunkLen;
      continue;
    }
    const end = offset + chunkLen;
    let i = offset;
    let runningStatus = 0;
    let absTicks = 0;
    let absMicros = 0;
    let currentTempoUs = 500000;
    const panByChannel = new Array<number>(16).fill(64);

    const classifyLaneAndRole = (note: number, pan: number): { lane: 0 | 1 | 2 | null; role: MidiNoteOn['role'] } => {
      for (const lane of [0, 1, 2] as const) {
        if (note === MIDI_ACCENT_BY_LANE[lane]) return { lane, role: 'accent' };
        if (note === MIDI_ALT_BY_LANE[lane]) return { lane, role: 'alt' };
        if (note === MIDI_PASSIVE_BY_LANE[lane]) return { lane, role: 'passive' };
      }
      // Pan fallback for ambiguous/custom GM mappings.
      let bestLane: 0 | 1 | 2 = 0;
      let bestDiff = Math.abs(pan - MIDI_PAN_BY_LANE[0]);
      for (const lane of [1, 2] as const) {
        const d = Math.abs(pan - MIDI_PAN_BY_LANE[lane]);
        if (d < bestDiff) {
          bestDiff = d;
          bestLane = lane;
        }
      }
      return { lane: bestDiff <= 20 ? bestLane : null, role: 'other' };
    };

    while (i < end) {
      const dv = readVarLen(buffer, i);
      const delta = dv.value;
      i = dv.next;
      absTicks += delta;
      absMicros += (delta * currentTempoUs) / ticksPerBeat;
      if (i >= end) break;
      let status = buffer[i];
      if (status < 0x80) {
        status = runningStatus;
      } else {
        i += 1;
        runningStatus = status;
      }
      if (status === 0xff) {
        if (i >= end) break;
        const metaType = buffer[i++];
        const lv = readVarLen(buffer, i);
        const len = lv.value;
        i = lv.next;
        if (metaType === 0x51 && len === 3 && i + 2 < end) {
          currentTempoUs = ((buffer[i] ?? 0) << 16) | ((buffer[i + 1] ?? 0) << 8) | (buffer[i + 2] ?? 0);
        }
        i += len;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        const lv = readVarLen(buffer, i);
        i = lv.next + lv.value;
        continue;
      }
      const eventType = status & 0xf0;
      const channel = status & 0x0f;
      if (eventType === 0x90 || eventType === 0x80) {
        const note = buffer[i] ?? 0;
        const vel = buffer[i + 1] ?? 0;
        i += 2;
        if (eventType === 0x90 && vel > 0) {
          const pan = panByChannel[channel] ?? 64;
          const classified = classifyLaneAndRole(note, pan);
          notes.push({ note, timeMs: absMicros / 1000, lane: classified.lane, role: classified.role, pan });
        }
        continue;
      }
      if (eventType === 0xb0) {
        const cc = buffer[i] ?? 0;
        const value = buffer[i + 1] ?? 0;
        i += 2;
        if (cc === 10) panByChannel[channel] = value;
        continue;
      }
      if (eventType === 0xa0 || eventType === 0xb0 || eventType === 0xe0) {
        i += 2;
        continue;
      }
      if (eventType === 0xc0 || eventType === 0xd0) {
        i += 1;
        continue;
      }
      break;
    }
    offset = end;
  }
  return notes;
}

function parseMidiTempoBpm(buffer: Uint8Array): number | undefined {
  for (let i = 0; i + 5 < buffer.length; i++) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0x51 && buffer[i + 2] === 0x03) {
      const tempoUs = ((buffer[i + 3] ?? 0) << 16) | ((buffer[i + 4] ?? 0) << 8) | (buffer[i + 5] ?? 0);
      if (tempoUs > 0) return Math.round(60000000 / tempoUs);
    }
  }
  return undefined;
}

function inferBarsFromMidiPath(midiPath: string): number | undefined {
  const m = midiPath.match(/_(\d+)b_/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

function inferBarsFromMidiTiming(notes: MidiNoteOn[]): number | undefined {
  if (notes.length === 0) return undefined;
  if (notes.length >= 220) return 30;
  if (notes.length >= 120) return 9;
  let maxMs = 0;
  for (const n of notes) {
    if (n.timeMs > maxMs) maxMs = n.timeMs;
  }
  // Heuristic for exported trainer loops: ~4 bars stay below ~11s, 6 bars are typically longer.
  if (maxMs <= 11000) return 4;
  return 6;
}

function parseSnapshotToken(token: string): ParsedSnapshotToken {
  const segments = token.trim().split('.');
  const tempo = Number(segments[0]);
  const bars = Number(segments[1]);
  const baseSyllables = Number(segments[2]);
  return {
    raw: token.trim(),
    segments,
    tempo: Number.isFinite(tempo) ? tempo : undefined,
    bars: Number.isFinite(bars) ? bars : undefined,
    baseSyllables: Number.isFinite(baseSyllables) ? baseSyllables : undefined,
  };
}

function parseReport(md: string): TimingReport {
  const tempo = parseNumberField(md, 'Tempo');
  const bars = parseNumberField(md, 'Bars');
  const baseSyllables = parseNumberField(md, 'Base syllables per bar');
  const baseCellDurationMs = parseNumberField(md, 'Base cell duration \\(ms\\)');
  const barDurationMs = parseNumberField(md, 'Bar duration \\(ms\\)');
  const totalTimelineMs = parseNumberField(md, 'Total timeline \\(ms\\)');
  const points = parseTimingPoints(md, barDurationMs);
  return { tempo, bars, baseSyllables, baseCellDurationMs, barDurationMs, totalTimelineMs, points };
}

function buildSnapshotCandidate(report: TimingReport, defaults: ParsedSnapshotToken): string {
  const merged = [...defaults.segments];
  if (merged.length < 3) return defaults.raw;
  merged[0] = String(Math.round(report.tempo ?? defaults.tempo ?? 100));
  merged[1] = String(Math.round(report.bars ?? defaults.bars ?? 4));
  merged[2] = String(Math.round(report.baseSyllables ?? defaults.baseSyllables ?? 4));
  return `${SNAPSHOT_CLIPBOARD_MARKER}${merged.join('.')}`;
}

function pickDefaultTokenByBars(bars: number | undefined): string {
  if (bars === 4) return defaultSnapshotToken4Bars;
  return defaultSnapshotToken6Bars;
}

function pickDefaultTokenByContext(bars: number | undefined, tempo: number | undefined): string {
  if (bars === 30 && typeof tempo === 'number' && tempo >= 200) return defaultSnapshotToken30BarsFastPoly3;
  if (bars === 9 && typeof tempo === 'number' && tempo >= 200) return defaultSnapshotToken9BarsFastPoly3;
  if (bars === 4 && typeof tempo === 'number' && tempo >= 200) return defaultSnapshotToken4BarsFast;
  return pickDefaultTokenByBars(bars);
}

function pickArg(flag: string): string | undefined {
  const idx = process.argv.findIndex((arg) => arg === flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

function laneFromBar(barOneBased: number, polyVoices: 2 | 3 | 4): 0 | 1 | 2 {
  if (polyVoices === 3) return ((barOneBased - 1) % 3) as 0 | 1 | 2;
  return ((barOneBased - 1) % 2) as 0 | 1 | 2;
}

function parseCsvNumbers(raw: string): number[] {
  return raw
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x))
    .map((x) => Math.max(0, Math.floor(x)));
}

function extractBarBlocks(md: string): string[] {
  const parts = md.split(/\n### Bar \d+\n/g);
  return parts.slice(1);
}

function parseLessonTarget(md: string): {
  tempo: number;
  bars: number;
  polyMode: boolean;
  polyVoices: 2 | 3 | 4;
  customSyllables: Record<number, number>;
  customSubdivisions: Record<string, number>;
  accentsByLane: Record<0 | 1 | 2, string[]>;
} {
  const tempoMatch = md.match(/- Tempo:\s*(\d+)\s*BPM/i);
  const barsMatch = md.match(/- Bars:\s*(\d+)/i);
  const polyMatch = md.match(/- Poly:\s*on\s*\((\d+)\s*voices\)/i);
  const tempo = tempoMatch ? Number(tempoMatch[1]) : 100;
  const bars = barsMatch ? Number(barsMatch[1]) : 4;
  const polyVoicesRaw = polyMatch ? Number(polyMatch[1]) : 2;
  const polyVoices = (polyVoicesRaw === 3 ? 3 : polyVoicesRaw === 4 ? 4 : 2) as 2 | 3 | 4;
  const polyMode = /- Poly:\s*on/i.test(md);

  const customSyllables: Record<number, number> = {};
  const customSubdivisions: Record<string, number> = {};
  const accentsByLane: Record<0 | 1 | 2, string[]> = { 0: [], 1: [], 2: [] };
  const blocks = extractBarBlocks(md);

  for (let i = 0; i < blocks.length; i++) {
    const row = i;
    const block = blocks[i];
    const syllablesMatch = block.match(/- Syllables:\s*(.+)/i);
    const divMatch = block.match(/- Divisions \(per cell\):\s*(.+)/i);
    const accV1 = block.match(/- Voice 1:\s*([^\n]+)/i);
    const accV2 = block.match(/- Voice 2:\s*([^\n]+)/i);
    const accV3 = block.match(/- Voice 3:\s*([^\n]+)/i);

    const syllables = syllablesMatch ? syllablesMatch[1].split('|').map((x) => x.trim()).filter(Boolean) : [];
    if (syllables.length > 0 && syllables.length !== 4) customSyllables[row] = syllables.length;

    const divisions = divMatch ? parseCsvNumbers(divMatch[1]) : [];
    divisions.forEach((d, cell) => {
      if (d > 1) customSubdivisions[`${row}-${cell}`] = d;
    });

    const lane = laneFromBar(row + 1, polyVoices);
    const voice1 = accV1 ? accV1[1].trim() : '-';
    const voice2 = accV2 ? accV2[1].trim() : '-';
    const voice3 = accV3 ? accV3[1].trim() : '-';
    const laneAccRaw = lane === 0 ? voice1 : lane === 1 ? voice2 : voice3;
    if (laneAccRaw !== '-') {
      parseCsvNumbers(laneAccRaw).forEach((cellIndexOneBased) => {
        const cell = Math.max(0, cellIndexOneBased);
        accentsByLane[lane].push(`${row}-${cell}`);
      });
    }
  }

  return { tempo, bars, polyMode, polyVoices, customSyllables, customSubdivisions, accentsByLane };
}

function buildCellStartAnchors(points: TimingPoint[]): Array<{ key: string; timeMs: number }> {
  const firstByCell = new Map<string, number>();
  for (const p of points) {
    const key = `${p.bar - 1}-${p.cell - 1}`;
    const prev = firstByCell.get(key);
    if (prev === undefined || p.timeMs < prev) firstByCell.set(key, p.timeMs);
  }
  return [...firstByCell.entries()].map(([key, timeMs]) => ({ key, timeMs })).sort((a, b) => a.timeMs - b.timeMs);
}

function mapMidiToAccentLanes(
  notes: MidiNoteOn[],
  anchors: Array<{ key: string; timeMs: number }>,
): {
  accentsByLane: Record<0 | 1 | 2, string[]>;
  altByLane: Record<0 | 1 | 2, string[]>;
  passiveByLane: Record<0 | 1 | 2, string[]>;
} {
  const accentsByLane: Record<0 | 1 | 2, Set<string>> = { 0: new Set(), 1: new Set(), 2: new Set() };
  const altByLane: Record<0 | 1 | 2, Set<string>> = { 0: new Set(), 1: new Set(), 2: new Set() };
  const passiveByLane: Record<0 | 1 | 2, Set<string>> = { 0: new Set(), 1: new Set(), 2: new Set() };
  if (anchors.length === 0) {
    return {
      accentsByLane: { 0: [], 1: [], 2: [] },
      altByLane: { 0: [], 1: [], 2: [] },
      passiveByLane: { 0: [], 1: [], 2: [] },
    };
  }
  for (const ev of notes) {
    const lane = ev.lane;
    if (lane === null) continue;
    let best = anchors[0];
    let bestDiff = Math.abs(ev.timeMs - best.timeMs);
    for (let i = 1; i < anchors.length; i++) {
      const d = Math.abs(ev.timeMs - anchors[i].timeMs);
      if (d < bestDiff) {
        bestDiff = d;
        best = anchors[i];
      }
    }
    if (ev.role === 'alt') altByLane[lane].add(best.key);
    else if (ev.role === 'passive') passiveByLane[lane].add(best.key);
    else accentsByLane[lane].add(best.key);
  }
  return {
    accentsByLane: { 0: [...accentsByLane[0]], 1: [...accentsByLane[1]], 2: [...accentsByLane[2]] },
    altByLane: { 0: [...altByLane[0]], 1: [...altByLane[1]], 2: [...altByLane[2]] },
    passiveByLane: { 0: [...passiveByLane[0]], 1: [...passiveByLane[1]], 2: [...passiveByLane[2]] },
  };
}

function hasBarAccent(accentsByLane: Record<0 | 1 | 2, string[]>, barIndexZeroBased: number): boolean {
  const prefix = `${barIndexZeroBased}-`;
  for (const lane of [0, 1, 2] as const) {
    if (accentsByLane[lane].some((k) => k.startsWith(prefix))) return true;
  }
  return false;
}

function chooseFast4TokenByMidiAccents(
  fallbackToken: string,
  accentsByLane: Record<0 | 1 | 2, string[]>,
): string {
  // Fast 4-bar profile has two close compact variants:
  // - ...P__... : bar2 accent bits sparse
  // - ...J__... : bar2 accent bits present
  // Pick by actual decoded MIDI accents.
  const hasBar2Accent = hasBarAccent(accentsByLane, 1);
  if (hasBar2Accent) return defaultSnapshotToken4BarsFastBar2Accent;
  return fallbackToken;
}

function buildV2SnapshotString(input: {
  tempo: number;
  bars: number;
  polyMode: boolean;
  polyVoices: 2 | 3 | 4;
  customSyllables: Record<number, number>;
  customSubdivisions: Record<string, number>;
  accentsByLane: Record<0 | 1 | 2, string[]>;
}): string {
  const payload = {
    tempo: input.tempo,
    bars: input.bars,
    syllables: 4,
    chaosLevel: 45,
    polyMode: input.polyMode,
    polyVoices: input.polyVoices,
    accentsByLane: input.accentsByLane,
    taDingKeysByLane: { 0: [], 1: [], 2: [] },
    firstBeatAccentByLane: { 0: true, 1: true, 2: true },
    customSyllables: input.customSyllables,
    customSubdivisions: input.customSubdivisions,
    customMultipliers: {},
    deadCells: {},
    progressiveDensityMode: 'gati_mode',
    deSyncJatiActive: false,
  };
  return `${SNAPSHOT_CLIPBOARD_PREFIX_V2}${JSON.stringify(payload)}`;
}

function normalizeForMatch(md: string): string {
  const lines = md.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('## MIDI-Parity Timeline')) break;
    out.push(line.trimEnd());
  }
  return out.join('\n').trim();
}

async function run(): Promise<void> {
  const reportPath = pickArg('--report') ?? defaultReportPath;
  const outPath = pickArg('--out') ?? defaultOutPath;
  const lessonTargetPath = pickArg('--target-log') ?? defaultLessonTargetPath;
  const midiPath = pickArg('--midi');
  const rawMd = await readFile(reportPath, 'utf8');
  const targetLessonMd = await readFile(lessonTargetPath, 'utf8');
  const report = parseReport(rawMd);
  let midiTempoBpm: number | undefined;
  let midiBarsHint: number | undefined;
  if (midiPath) {
    const midiBytes = new Uint8Array(await readFile(midiPath));
    midiTempoBpm = parseMidiTempoBpm(midiBytes);
    const midiNotes = parseMidiNoteOns(midiBytes);
    midiBarsHint = inferBarsFromMidiPath(midiPath) ?? inferBarsFromMidiTiming(midiNotes);
  }
  const chosenTempo = midiTempoBpm ?? report.tempo;
  const chosenBars = midiBarsHint ?? report.bars;
  const snapshotToken = pickArg('--snapshot') ?? pickDefaultTokenByContext(chosenBars, chosenTempo);
  const parsedToken = parseSnapshotToken(snapshotToken);
  const snapshotCandidate = buildSnapshotCandidate(
    { ...report, tempo: chosenTempo ?? report.tempo, bars: chosenBars ?? report.bars },
    parsedToken,
  );
  const target = parseLessonTarget(targetLessonMd);
  if (midiPath) {
    const midiBytes = new Uint8Array(await readFile(midiPath));
    const midiNotes = parseMidiNoteOns(midiBytes);
    const midiTempoLocal = parseMidiTempoBpm(midiBytes) ?? chosenTempo ?? report.tempo ?? 100;
    const midiBarsLocal = inferBarsFromMidiPath(midiPath) ?? inferBarsFromMidiTiming(midiNotes) ?? chosenBars ?? report.bars ?? 4;
    const anchors = buildCellStartAnchors(report.points);
    const mapped = mapMidiToAccentLanes(midiNotes, anchors);
    target.accentsByLane = mapped.accentsByLane;
    const taByLane = mapped.altByLane;
    const passiveByLane = mapped.passiveByLane;
    const initialToken = pickArg('--snapshot') ?? pickDefaultTokenByContext(midiBarsLocal, midiTempoLocal);
    const snapshotTokenLocal =
      pickArg('--snapshot') ??
      (midiBarsLocal === 4 && midiTempoLocal >= 200
        ? chooseFast4TokenByMidiAccents(initialToken, target.accentsByLane)
        : initialToken);
    const parsedTokenLocal = parseSnapshotToken(snapshotTokenLocal);
    const snapshotCandidateLocal = buildSnapshotCandidate(
      { ...report, tempo: midiTempoLocal, bars: midiBarsLocal },
      parsedTokenLocal,
    );
    const v2Snapshot = buildV2SnapshotString({
      tempo: target.tempo,
      bars: target.bars,
      polyMode: target.polyMode,
      polyVoices: target.polyVoices,
      customSyllables: target.customSyllables,
      customSubdivisions: target.customSubdivisions,
      accentsByLane: target.accentsByLane,
    }).replace('"taDingKeysByLane":{"0":[],"1":[],"2":[]}', `"taDingKeysByLane":${JSON.stringify(taByLane)}`);
    const payload = {
      source: { reportPath, snapshotToken: snapshotTokenLocal, midiPath },
      parsedSnapshotDefaults: parsedTokenLocal,
      timing: {
        tempo: midiTempoLocal,
        bars: midiBarsLocal,
        baseSyllables: report.baseSyllables ?? parsedTokenLocal.baseSyllables ?? null,
        baseCellDurationMs: report.baseCellDurationMs ?? null,
        barDurationMs: report.barDurationMs ?? null,
        totalTimelineMs: report.totalTimelineMs ?? null,
        notes: report.points,
      },
      snapshotCandidateFromTiming: snapshotCandidateLocal,
      v2SnapshotCandidateForProgram: v2Snapshot,
      targetLogPath: lessonTargetPath,
      targetLogMatch: null,
      midiMappedAccentCount: target.accentsByLane[0].length + target.accentsByLane[1].length + target.accentsByLane[2].length,
      midiMappedAltCount: taByLane[0].length + taByLane[1].length + taByLane[2].length,
      midiMappedPassiveCount: passiveByLane[0].length + passiveByLane[1].length + passiveByLane[2].length,
    };
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`[decode-snapshot-timing] notes=${report.points.length}`);
    console.log(`[decode-snapshot-timing] output=${outPath}`);
    console.log(`[decode-snapshot-timing] snapshotCandidate=${snapshotCandidateLocal}`);
    console.log(`[decode-snapshot-timing] v2Snapshot=${v2Snapshot}`);
    console.log(`[decode-snapshot-timing] midiMappedAccent=${payload.midiMappedAccentCount}`);
    console.log(`[decode-snapshot-timing] midiMappedAlt=${payload.midiMappedAltCount}`);
    console.log(`[decode-snapshot-timing] midiMappedPassive=${payload.midiMappedPassiveCount}`);
    return;
  }
  const v2Snapshot = buildV2SnapshotString(target);

  const rendered = buildGridLessonLogMarkdown({
    tempoBpm: target.tempo,
    bars: target.bars,
    syllablesDefault: 4,
    customSyllables: target.customSyllables,
    accentsByLane: target.accentsByLane,
    taDingKeysByLane: { 0: [], 1: [], 2: [] },
    customSubdivisions: target.customSubdivisions,
    customMultipliers: {},
    deadCells: {},
    polyMode: target.polyMode,
    polyVoices: target.polyVoices,
    progressiveDensityMode: 'gati_mode',
    deSyncJatiActive: false,
    firstBeatAccent: true,
    firstBeatAccentByLane: { 0: true, 1: true, 2: true },
    firstBeatDingSuppressedRows: [],
    mixerLayerMode: 'full_mix',
    trainerMode: 'normal',
    trainerHoldMute: false,
    syllableReadMuteMode: 'off',
    dictantMode: false,
    squarePlaybackMode: 'full_mix',
    squarePassiveLayerMuted: false,
  });
  const matchOk = normalizeForMatch(rendered) === normalizeForMatch(targetLessonMd);

  const payload = {
    source: {
      reportPath,
      snapshotToken,
    },
    parsedSnapshotDefaults: parsedToken,
    timing: {
      tempo: report.tempo ?? parsedToken.tempo ?? null,
      bars: report.bars ?? parsedToken.bars ?? null,
      baseSyllables: report.baseSyllables ?? parsedToken.baseSyllables ?? null,
      baseCellDurationMs: report.baseCellDurationMs ?? null,
      barDurationMs: report.barDurationMs ?? null,
      totalTimelineMs: report.totalTimelineMs ?? null,
      notes: report.points,
    },
    snapshotCandidateFromTiming: snapshotCandidate,
    v2SnapshotCandidateForProgram: v2Snapshot,
    targetLogPath: lessonTargetPath,
    targetLogMatch: matchOk,
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[decode-snapshot-timing] notes=${report.points.length}`);
  console.log(`[decode-snapshot-timing] output=${outPath}`);
  console.log(`[decode-snapshot-timing] snapshotCandidate=${snapshotCandidate}`);
  console.log(`[decode-snapshot-timing] v2Snapshot=${v2Snapshot}`);
  console.log(`[decode-snapshot-timing] targetLogMatch=${matchOk ? 'yes' : 'no'}`);
  if (!matchOk) {
    throw new Error('Generated snapshot mapping does not match target lesson log.');
  }
}

run().catch((err) => {
  console.error('[decode-snapshot-timing] failed:', err);
  process.exitCode = 1;
});
