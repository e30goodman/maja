import React, { useState, useRef, useEffect, useMemo, useCallback, startTransition } from 'react';
import {
	Settings,
	Minus,
	Plus,
	Dices,
	Play,
	Snowflake,
	ChevronUp,
	ChevronDown,
	Eraser,
	Copy,
	ClipboardPaste,
} from 'lucide-react';
import { SequencerGrid, type SequencerGridRowActions } from './SequencerGrid';

type PlayheadHighlightEvent = { t: number; pos: { r: number; c: number; absR: number } };

function insertPlayheadSorted(queue: PlayheadHighlightEvent[], ev: PlayheadHighlightEvent) {
	let lo = 0;
	let hi = queue.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (queue[mid].t <= ev.t) lo = mid + 1;
		else hi = mid;
	}
	queue.splice(lo, 0, ev);
}

const CHAOS_SLIDER_MAX = 100;
/** При «отвязке» пульса от числа долей такта длительность шага считается как при 4 долях (квартальная сетка). */
const PULSE_METER_BASE_SYLLABLES = 4;

/** Long-press квадрата: off | только акцентные щелчки выкл (пассивы играют) | все щелчки по сетке выкл. */
type SyllableReadMuteMode = 'off' | 'full' | 'no_accent_sharp';

function normalizeSyllableReadMuteModeFromSnapshot(modeRaw: unknown, legacyLatched: unknown): SyllableReadMuteMode {
	if (modeRaw === 'full' || modeRaw === 'no_accent_sharp') return modeRaw;
	if (legacyLatched === true) return 'no_accent_sharp';
	return 'off';
}

function normalizePulseMeterUnlinked(raw: unknown): Record<number, boolean> {
	if (!raw || typeof raw !== 'object') return {};
	const out: Record<number, boolean> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		const ri = parseInt(k, 10);
		if (Number.isFinite(ri) && ri >= 0) out[ri] = Boolean(v);
	}
	return out;
}
/** Random pulsation: пул пульсов по ручке chaos (равномерный выбор внутри пула). */
const RANDOM_PULSE_POOL_LE_30 = [1, 2, 3, 4, 5] as const;
const RANDOM_PULSE_POOL_LE_70 = [1, 2, 3, 4, 5, 6, 7] as const;
const RANDOM_PULSE_POOL_FULL = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

function pickRandomPulsationMeter(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	if (c <= 30) return RANDOM_PULSE_POOL_LE_30[Math.floor(Math.random() * RANDOM_PULSE_POOL_LE_30.length)]!;
	if (c <= 70) return RANDOM_PULSE_POOL_LE_70[Math.floor(Math.random() * RANDOM_PULSE_POOL_LE_70.length)]!;
	return RANDOM_PULSE_POOL_FULL[Math.floor(Math.random() * RANDOM_PULSE_POOL_FULL.length)]!;
}

/** Доля акцентуемых долей: 0→0, 25→25%, 50→50%, 75→75%, 100→90% (кусочно-линейно). */
function accentFillRatioFromChaos(c: number): number {
	const x = Math.max(0, Math.min(CHAOS_SLIDER_MAX, c));
	if (x <= 25) return 0.25 * (x / 25);
	if (x <= 50) return 0.25 + (x - 25) * (0.25 / 25);
	if (x <= 75) return 0.5 + (x - 50) * (0.25 / 25);
	return 0.75 + (x - 75) * (0.15 / 25);
}

/** Random pulsation (длина такта / поддоли): chaos≤30 → 1–5; 31–70 → 1–7; >70 → 1–9. */
function pickWeightedMeter2to9(chaos: number): number {
	return pickRandomPulsationMeter(chaos);
}

const CELL_SPEED_RANDOM_POOL = [2, 3, 4] as const;

/** Random Speed (cell speed): только поддоли 2, 3 или 4. */
function pickRandomCellSpeedSubdiv(): number {
	return CELL_SPEED_RANDOM_POOL[Math.floor(Math.random() * CELL_SPEED_RANDOM_POOL.length)]!;
}

/**
 * Доля долей такта, в которых random speed выставляет новую поддоль (остальные сбрасываются в дефолт).
 * chaos 0–33 → 33%; 34–66 → 66%; 67–89 → линейно 66%→100%; ≥90 → 100%.
 */
function cellSpeedFillFractionFromChaos(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	if (c <= 33) return 0.33;
	if (c <= 66) return 0.66;
	if (c >= 90) return 1;
	return 0.66 + ((c - 66) / (90 - 66)) * (1 - 0.66);
}

function pickAccentCountForBar(chaos: number, curSyl: number): number {
	const x = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	if (curSyl < 1) return 0;
	const minAcc = Math.min(curSyl, x > 15 ? 2 : 1);
	const maxCap = Math.min(curSyl, Math.max(minAcc, Math.floor(curSyl * 0.9)));
	const ratio = accentFillRatioFromChaos(x);
	const cap = Math.floor(curSyl * ratio);
	const spread = 1 + Math.floor(curSyl * 0.12);
	const jitter = Math.floor((Math.random() - 0.5) * spread);
	let n = Math.max(0, Math.min(curSyl, cap + jitter));
	n = Math.min(maxCap, Math.max(minAcc, n));
	return n;
}

function pickBarSpeedMultiplier(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	if (c <= 40) return 1;
	if (c <= 70) {
		const p2 = ((c - 40) / 30) * 0.5;
		return Math.random() < p2 ? 2 : 1;
	}
	const t = (c - 70) / 30;
	const w1 = 0.38 * (1 - t) + 0.1;
	const w2 = 0.32 + 0.06 * t;
	const w3 = 0.15 * t + 0.05;
	const w4 = 0.15 * t + 0.05;
	const tot = w1 + w2 + w3 + w4;
	let r = Math.random() * tot;
	if ((r -= w1) <= 0) return 1;
	if ((r -= w2) <= 0) return 2;
	if ((r -= w3) <= 0) return 3;
	return 4;
}

const SNAPSHOT_SLOT_COUNT = 7;
const SNAPSHOT_STORAGE_KEY = 'konnakolTrainerSnapshotsV1';
/** Clipboard export: compact string for messengers. */
const METRONOME_CONFIG_PREFIX = 'METRONOME_CONFIG:';
/** Legacy prefix with raw JSON after colon — still accepted when pasting. */
const SNAPSHOT_CLIPBOARD_PREFIX_LEGACY = 'konnakolTrainerSnapshotV1:';
/** Hold snapshot slot to open Copy / Paste menu. */
const SNAPSHOT_MENU_HOLD_MS = 520;

function utf8ToBase64Json(json: string): string {
	const bytes = new TextEncoder().encode(json);
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return btoa(bin);
}

function base64JsonToUtf8(b64: string): string {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
	return new TextDecoder().decode(bytes);
}

type SequencerCellJSON = { accent: boolean; pulsation: number };

function buildSequencerCellsForSnapshot(s: ReturnType<typeof createEmptySnapshot>): Record<string, SequencerCellJSON> {
	const acc = s.accents instanceof Set ? s.accents : new Set(Array.isArray(s.accents) ? s.accents : []);
	const out: Record<string, SequencerCellJSON> = {};
	for (let r = 0; r < s.bars; r++) {
		const syl = s.customSyllables[r] !== undefined ? s.customSyllables[r] : s.syllables;
		for (let c = 0; c < syl; c++) {
			const k = `${r}-${c}`;
			const p = s.customSubdivisions[k];
			const pul = typeof p === 'number' && p >= 1 && p <= 9 ? p : 1;
			out[k] = { accent: acc.has(k), pulsation: pul };
		}
	}
	return out;
}

/** Восстановление акцентов и поддолей из плотной сетки (имеет приоритет над legacy-полями). */
function hydrateSequencerFromCells(cellsRaw: unknown, d: ReturnType<typeof createEmptySnapshot>) {
	if (!cellsRaw || typeof cellsRaw !== 'object') return;
	const cells = cellsRaw as Record<string, unknown>;
	const nextAcc = new Set<string>();
	const nextSub: Record<string, number> = {};
	for (let r = 0; r < d.bars; r++) {
		const syl = d.customSyllables[r] !== undefined ? d.customSyllables[r] : d.syllables;
		for (let c = 0; c < syl; c++) {
			const k = `${r}-${c}`;
			const row = cells[k];
			if (!row || typeof row !== 'object') continue;
			const o = row as Record<string, unknown>;
			if (o.accent === true) nextAcc.add(k);
			const p = parseInt(String(o.pulsation), 10);
			const pul = Number.isFinite(p) && p >= 1 && p <= 9 ? p : 1;
			if (pul !== 1) nextSub[k] = pul;
		}
	}
	d.accents = nextAcc;
	d.customSubdivisions = nextSub;
}

function createEmptySnapshot() {
	return {
		tempo: 100,
		bars: 4,
		syllables: 4,
		accents: new Set<string>(),
		customSyllables: {} as Record<number, number>,
		customMultipliers: {} as Record<number, number>,
		customSubdivisions: {} as Record<string, number>,
		/** Дефолт рандомайзера: режим вкл., pulsation + cell speed + accents (pattern), chaos 15. */
		randomModeEnabled: true,
		randomPulsation: true,
		randomPattern: true,
		randomSpeed: true,
		randomBarSpeed: false,
		chaosLevel: 15,
		clickSound: 'modern' as 'modern' | 'oldschool',
		/** Верхняя панель: темп + слайдеры (Chevron) развёрнута. */
		panelExpanded: false,
		/** Ряд r: длительность клетки от PULSE_METER_BASE_SYLLABLES, не от customSyllables[r]. */
		pulseMeterUnlinked: {} as Record<number, boolean>,
		/** Заморозка высоты ряда (число видимых тактов) или null. */
		frozenScale: null as number | null,
		onlyAccents: false,
		firstBeatAccent: true,
		syllableReadMuteMode: 'off' as SyllableReadMuteMode,
	};
}

function parseSnapshotRow(raw: unknown) {
	const d = createEmptySnapshot();
	if (!raw || typeof raw !== 'object') return d;
	const o = raw as Record<string, unknown>;
	const tempo = parseInt(String(o.tempo), 10);
	const bars = parseInt(String(o.bars), 10);
	const syllables = parseInt(String(o.syllables), 10);
	if (Number.isFinite(tempo) && tempo >= 20 && tempo <= 400) d.tempo = tempo;
	if (Number.isFinite(bars) && bars >= 1 && bars <= 100) d.bars = bars;
	if (Number.isFinite(syllables) && syllables >= 1 && syllables <= 9) d.syllables = syllables;
	const acc = o.accents;
	if (Array.isArray(acc)) d.accents = new Set(acc.filter((x): x is string => typeof x === 'string'));
	const cs = o.customSyllables;
	if (cs && typeof cs === 'object') {
		for (const [k, v] of Object.entries(cs as Record<string, unknown>)) {
			const ri = parseInt(k, 10);
			const vi = parseInt(String(v), 10);
			if (Number.isFinite(ri) && Number.isFinite(vi) && vi >= 1 && vi <= 9) d.customSyllables[ri] = vi;
		}
	}
	const cm = o.customMultipliers;
	if (cm && typeof cm === 'object') {
		for (const [k, v] of Object.entries(cm as Record<string, unknown>)) {
			const ri = parseInt(k, 10);
			const vi = Number(v);
			if (Number.isFinite(ri) && Number.isFinite(vi) && vi >= 1 && vi <= 4) d.customMultipliers[ri] = vi;
		}
	}
	const cd = o.customSubdivisions;
	if (cd && typeof cd === 'object') {
		for (const [k, v] of Object.entries(cd as Record<string, unknown>)) {
			const vi = parseInt(String(v), 10);
			if (typeof k === 'string' && Number.isFinite(vi) && vi >= 1 && vi <= 9) d.customSubdivisions[k] = vi;
		}
	}
	if (typeof o.randomModeEnabled === 'boolean') d.randomModeEnabled = o.randomModeEnabled;
	if (typeof o.randomPulsation === 'boolean') d.randomPulsation = o.randomPulsation;
	if (typeof o.randomPattern === 'boolean') d.randomPattern = o.randomPattern;
	if (typeof o.randomSpeed === 'boolean') d.randomSpeed = o.randomSpeed;
	if (typeof o.randomBarSpeed === 'boolean') d.randomBarSpeed = o.randomBarSpeed;
	const cl = parseInt(String(o.chaosLevel), 10);
	if (Number.isFinite(cl) && cl >= 0 && cl <= 100) {
		d.chaosLevel = cl;
	} else if (o.randomMaxNotes !== undefined) {
		const legacy = parseInt(String(o.randomMaxNotes), 10);
		if (Number.isFinite(legacy) && legacy >= 0 && legacy <= 9) {
			d.chaosLevel = legacy <= 0 ? 18 : Math.min(100, 12 + legacy * 9);
		}
	}
	if (o.clickSound === 'oldschool') d.clickSound = 'oldschool';
	if (typeof o.panelExpanded === 'boolean') d.panelExpanded = o.panelExpanded;
	if (o.sequencerCells && typeof o.sequencerCells === 'object') {
		hydrateSequencerFromCells(o.sequencerCells, d);
	}
	const pu = o.pulseMeterUnlinked;
	if (pu && typeof pu === 'object') {
		const next: Record<number, boolean> = {};
		for (const [k, v] of Object.entries(pu as Record<string, unknown>)) {
			const ri = parseInt(k, 10);
			if (Number.isFinite(ri) && ri >= 0) next[ri] = Boolean(v);
		}
		d.pulseMeterUnlinked = next;
	}
	if (typeof o.onlyAccents === 'boolean') d.onlyAccents = o.onlyAccents;
	if (typeof o.firstBeatAccent === 'boolean') d.firstBeatAccent = o.firstBeatAccent;
	d.syllableReadMuteMode = normalizeSyllableReadMuteModeFromSnapshot(o.syllableReadMuteMode, o.syllableReadMuteLatched);
	const fs = o.frozenScale;
	if (fs === null || fs === undefined) d.frozenScale = null;
	else {
		const fn = parseInt(String(fs), 10);
		d.frozenScale = Number.isFinite(fn) && fn >= 1 && fn <= 100 ? fn : null;
	}
	return d;
}

function snapSlotLooksUsed(s: ReturnType<typeof createEmptySnapshot>) {
	if (s.tempo !== 100 || s.bars !== 4 || s.syllables !== 4) return true;
	if (s.accents.size > 0) return true;
	if (Object.keys(s.customSyllables).length > 0) return true;
	if (Object.keys(s.customMultipliers).length > 0) return true;
	if (Object.keys(s.customSubdivisions).length > 0) return true;
	if (s.randomModeEnabled || s.randomPulsation || !s.randomPattern || s.randomSpeed || s.randomBarSpeed) return true;
	if (s.chaosLevel !== 0) return true;
	if (s.clickSound !== 'modern') return true;
	if (s.panelExpanded === true) return true;
	if (s.pulseMeterUnlinked && Object.values(s.pulseMeterUnlinked).some(Boolean)) return true;
	if (s.onlyAccents) return true;
	if (s.firstBeatAccent === false) return true;
	if (s.frozenScale != null) return true;
	if (s.syllableReadMuteMode !== 'off') return true;
	return false;
}

function snapshotToJSON(s: ReturnType<typeof createEmptySnapshot>) {
	return {
		tempo: s.tempo,
		bars: s.bars,
		syllables: s.syllables,
		accents: [...s.accents],
		sequencerCells: buildSequencerCellsForSnapshot(s),
		customSyllables: s.customSyllables,
		customMultipliers: s.customMultipliers,
		customSubdivisions: s.customSubdivisions,
		randomModeEnabled: s.randomModeEnabled,
		randomPulsation: s.randomPulsation,
		randomPattern: s.randomPattern,
		randomSpeed: s.randomSpeed,
		randomBarSpeed: s.randomBarSpeed,
		chaosLevel: s.chaosLevel,
		clickSound: s.clickSound,
		panelExpanded: s.panelExpanded,
		pulseMeterUnlinked: Object.fromEntries(
			Object.entries(s.pulseMeterUnlinked || {}).filter(([, v]) => v),
		) as Record<string, boolean>,
		frozenScale: s.frozenScale ?? null,
		onlyAccents: s.onlyAccents,
		firstBeatAccent: s.firstBeatAccent,
		syllableReadMuteMode: s.syllableReadMuteMode,
	};
}

function encodeSnapshotClipboard(s: ReturnType<typeof createEmptySnapshot>): string {
	const json = JSON.stringify(snapshotToJSON(s));
	return METRONOME_CONFIG_PREFIX + utf8ToBase64Json(json);
}

function tryDecodeSnapshotClipboard(text: string): ReturnType<typeof createEmptySnapshot> | null {
	const t = text.trim();
	if (t.startsWith(METRONOME_CONFIG_PREFIX)) {
		const b64 = t.slice(METRONOME_CONFIG_PREFIX.length).replace(/\s+/g, '');
		if (!b64) return null;
		try {
			const json = base64JsonToUtf8(b64);
			return parseSnapshotRow(JSON.parse(json));
		} catch {
			return null;
		}
	}
	if (t.startsWith(SNAPSHOT_CLIPBOARD_PREFIX_LEGACY)) {
		try {
			const raw = JSON.parse(t.slice(SNAPSHOT_CLIPBOARD_PREFIX_LEGACY.length));
			return parseSnapshotRow(raw);
		} catch {
			return null;
		}
	}
	return null;
}

function loadSnapshotStorage(): {
	activeSnapshot: number;
	snapshots: Record<number, ReturnType<typeof createEmptySnapshot>>;
} {
	const snapshots: Record<number, ReturnType<typeof createEmptySnapshot>> = {};
	for (let i = 1; i <= SNAPSHOT_SLOT_COUNT; i++) snapshots[i] = createEmptySnapshot();
	let activeSnapshot = 1;
	try {
		const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
		if (!raw) return { activeSnapshot, snapshots };
		const data = JSON.parse(raw) as { activeSnapshot?: number; snapshots?: Record<string, unknown> };
		if (typeof data.activeSnapshot === 'number' && data.activeSnapshot >= 1 && data.activeSnapshot <= SNAPSHOT_SLOT_COUNT) {
			activeSnapshot = Math.floor(data.activeSnapshot);
		}
		const bag = data.snapshots;
		if (bag && typeof bag === 'object') {
			for (let i = 1; i <= SNAPSHOT_SLOT_COUNT; i++) {
				const row = bag[String(i)] ?? (bag as any)[i];
				if (row) snapshots[i] = parseSnapshotRow(row);
			}
		}
	} catch {
		/* keep defaults */
	}
	return { activeSnapshot, snapshots };
}

/**
 * @param accentOnlyPlayback When true, only accented steps sound — blend accent with passive timbre.
 *   When false, passive steps also sound — accented hits use accent-only (high) to avoid doubling + clipping.
 */
const playSharpClick = (
  ctx: AudioContext,
  time: number,
  isChecked: boolean,
  soundType: 'modern' | 'oldschool' = 'modern',
  accentOnlyPlayback = false,
) => {
  // Old school = same as legacy maja `konnakol_metronome` (triangle + pitch sweep).
  if (soundType === 'oldschool') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(isChecked ? 500 : 250, time);
    osc.frequency.exponentialRampToValueAtTime(isChecked ? 120 : 80, time + (isChecked ? 0.04 : 0.02));
    /** Пассивный oldschool: +20% к пику относительно legacy (без UI-слайдера). */
    const OLDSCHOOL_PASSIVE_PEAK_MUL = 1.2;
    const peak = isChecked ? 0.9 : 0.4 * OLDSCHOOL_PASSIVE_PEAK_MUL;
    const decay = isChecked ? 0.04 : 0.02;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, time + decay);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + Math.max(0.05, decay + 0.01));
    return;
  }

  if (isChecked && accentOnlyPlayback) {
    const decay = 0.042;
    const oscLo = ctx.createOscillator();
    const oscHi = ctx.createOscillator();
    const gLo = ctx.createGain();
    const gHi = ctx.createGain();
    oscLo.type = 'sine';
    oscHi.type = 'sine';
    oscLo.frequency.setValueAtTime(800, time);
    oscHi.frequency.setValueAtTime(920, time);
    const peakLo = 0.17;
    const peakHi = 0.22;
    gLo.gain.setValueAtTime(0, time);
    gLo.gain.linearRampToValueAtTime(peakLo, time + 0.002);
    gLo.gain.exponentialRampToValueAtTime(0.001, time + decay);
    gHi.gain.setValueAtTime(0, time);
    gHi.gain.linearRampToValueAtTime(peakHi, time + 0.002);
    gHi.gain.exponentialRampToValueAtTime(0.001, time + decay);
    oscLo.connect(gLo);
    oscHi.connect(gHi);
    gLo.connect(ctx.destination);
    gHi.connect(ctx.destination);
    oscLo.start(time);
    oscHi.start(time);
    oscLo.stop(time + decay + 0.012);
    oscHi.stop(time + decay + 0.012);
    return;
  }

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(isChecked ? 920 : 800, time);
  const peak = isChecked ? 0.36 : 0.28;
  const decay = 0.04;
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(peak, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.001, time + decay);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(time);
  osc.stop(time + decay + 0.01);
};

const playBarFirstHighClick = (ctx: AudioContext, time: number, soundType: 'modern' | 'oldschool' = 'modern') => {
  if (soundType === 'oldschool') {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(920, time);
    osc.frequency.exponentialRampToValueAtTime(210, time + 0.03);
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.78, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.035);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
    return;
  }

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(1550, time);
  osc.frequency.exponentialRampToValueAtTime(520, time + 0.035);
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(0.30, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.042);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(time);
  osc.stop(time + 0.06);
};

export default function App() {
  const initialBoot = useMemo(() => loadSnapshotStorage(), []);
  const seed = initialBoot.snapshots[initialBoot.activeSnapshot];

  const [tempo, setTempo] = useState(seed.tempo);
  const [bars, setBars] = useState(seed.bars);
  const [syllables, setSyllables] = useState(seed.syllables);

  // Metronome state
  const [isPlaying, setIsPlaying] = useState(false);
  const [accents, setAccents] = useState<Set<string>>(() => new Set(seed.accents));
  const [activePos, setActivePos] = useState({ r: -1, c: -1, absR: -1 });
  const playAbsBarRef = useRef(0);
  const [listOffset, setListOffset] = useState(0);
  const [customSyllables, setCustomSyllables] = useState<Record<number, number>>(() => ({ ...seed.customSyllables }));
  const [customMultipliers, setCustomMultipliers] = useState<Record<number, number>>(() => ({ ...seed.customMultipliers }));
  const [customSubdivisions, setCustomSubdivisions] = useState<Record<string, number>>(() => ({ ...seed.customSubdivisions }));
  const [pulseMeterUnlinked, setPulseMeterUnlinked] = useState<Record<number, boolean>>(() =>
    normalizePulseMeterUnlinked(seed.pulseMeterUnlinked),
  );

  // Metronome Sound Toggles
  const [onlyAccents, setOnlyAccents] = useState(() => seed.onlyAccents === true);
  const [firstBeatAccent, setFirstBeatAccent] = useState(() => seed.firstBeatAccent !== false);

  // Randomizer States
  const [randomModeEnabled, setRandomModeEnabled] = useState(seed.randomModeEnabled);
  const [randomPulsation, setRandomPulsation] = useState(seed.randomPulsation);
  const [randomPattern, setRandomPattern] = useState(seed.randomPattern);
  const [randomSpeed, setRandomSpeed] = useState(seed.randomSpeed);
  const [randomBarSpeed, setRandomBarSpeed] = useState(seed.randomBarSpeed);
  const [chaosLevel, setChaosLevel] = useState(
    typeof seed.chaosLevel === 'number' && seed.chaosLevel >= 0 && seed.chaosLevel <= 100
      ? seed.chaosLevel
      : 0,
  );
  const [showRandomSettings, setShowRandomSettings] = useState(false);
  const showRandomSettingsRef = useRef(false);
  showRandomSettingsRef.current = showRandomSettings;
  const coldStartRef = useRef(true);

  // Click Sound
  const [clickSound, setClickSound] = useState<'modern' | 'oldschool'>(seed.clickSound);

  // Preset Snapshot State (7 slots; persisted in localStorage)
  const [activeSnapshot, setActiveSnapshot] = useState(initialBoot.activeSnapshot);
  const [snapshots, setSnapshots] = useState<Record<number, any>>(() => {
    const o = initialBoot.snapshots;
    const out: Record<number, any> = {};
    for (let i = 1; i <= SNAPSHOT_SLOT_COUNT; i++) {
      const s = o[i];
      out[i] = {
        ...s,
        accents: new Set(s.accents),
        customSyllables: { ...s.customSyllables },
        customMultipliers: { ...s.customMultipliers },
        customSubdivisions: { ...s.customSubdivisions },
        panelExpanded: s.panelExpanded === true,
        pulseMeterUnlinked: { ...(s.pulseMeterUnlinked || {}) },
        frozenScale: typeof s.frozenScale === 'number' && s.frozenScale >= 1 ? s.frozenScale : null,
        onlyAccents: s.onlyAccents === true,
        firstBeatAccent: s.firstBeatAccent !== false,
        syllableReadMuteMode: normalizeSyllableReadMuteModeFromSnapshot(
          s.syllableReadMuteMode,
          (s as { syllableReadMuteLatched?: boolean }).syllableReadMuteLatched,
        ),
      };
    }
    return out;
  });

  const snapshotsRef = useRef(snapshots);
  snapshotsRef.current = snapshots;
  const activeSnapshotRef = useRef(activeSnapshot);
  activeSnapshotRef.current = activeSnapshot;
  const snapshotHoldTimerRef = useRef<number | null>(null);
  const snapshotHoldSlotRef = useRef<number | null>(null);
  const snapshotHoldAteClickRef = useRef(false);
  const snapshotSlotButtonRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const [snapshotClipMenu, setSnapshotClipMenu] = useState<{
    slot: number;
    x: number;
    y: number;
  } | null>(null);

  const persistSnapshotsTimerRef = useRef<number | null>(null);
  const clipboardToastTimerRef = useRef<number | null>(null);
  const [clipboardToast, setClipboardToast] = useState<string | null>(null);

  const showClipboardToast = (message: string) => {
    setClipboardToast(message);
    if (clipboardToastTimerRef.current !== null) {
      window.clearTimeout(clipboardToastTimerRef.current);
    }
    clipboardToastTimerRef.current = window.setTimeout(() => {
      clipboardToastTimerRef.current = null;
      setClipboardToast(null);
    }, 2600);
  };

  const [activeEditCell, setActiveEditCell] = useState<string | null>(null);
  const [activeEditRow, setActiveEditRow] = useState<number | null>(null);
  const [frozenScale, setFrozenScale] = useState<number | null>(() =>
    typeof seed.frozenScale === 'number' && seed.frozenScale >= 1 ? seed.frozenScale : null,
  );
  const [isPanelExpanded, setIsPanelExpanded] = useState(() => seed.panelExpanded === true);
  const isPanelExpandedRef = useRef(seed.panelExpanded === true);
  isPanelExpandedRef.current = isPanelExpanded;

  useEffect(() => {
    if (!isPanelExpanded) {
      setActiveEditCell(null);
      setActiveEditRow(null);
    }
  }, [isPanelExpanded]);

  /** Long-press по клетке такта (поддоли). */
  const holdTimerRef = useRef<number | null>(null);
  /** Long-press по числу слогов в такте (unlink от глобального метра) — отдельно, чтобы клетки не сбивали таймер. */
  const pulseUnlinkHoldTimerRef = useRef<number | null>(null);
  const isHoldingRef = useRef(false);
  /** Long-press square: toggle «без щелчков по клеткам»; ding такта Ta не мьютится. */
  const squareHoldTimerRef = useRef<number | null>(null);
  const squareHoldAteClickRef = useRef(false);
  const [syllableReadMuteMode, setSyllableReadMuteMode] = useState<SyllableReadMuteMode>(() =>
    normalizeSyllableReadMuteModeFromSnapshot(
      seed.syllableReadMuteMode,
      (seed as { syllableReadMuteLatched?: boolean }).syllableReadMuteLatched,
    ),
  );
  const syllableReadMuteModeRef = useRef(syllableReadMuteMode);
  syllableReadMuteModeRef.current = syllableReadMuteMode;
  const tapTimesRef = useRef<number[]>([]);

  const handleTap = () => {
    const now = Date.now();
    const times = tapTimesRef.current;
    
    // Clear times if it's been more than 2 seconds since last tap
    if (times.length > 0 && now - times[times.length - 1] > 2000) {
      tapTimesRef.current = [];
    }
    
    tapTimesRef.current.push(now);
    
    // Keep only the last 4 taps for a moving average
    if (tapTimesRef.current.length > 4) {
      tapTimesRef.current.shift();
    }
    
    if (tapTimesRef.current.length > 1) {
      let totalInterval = 0;
      for (let i = 1; i < tapTimesRef.current.length; i++) {
        totalInterval += (tapTimesRef.current[i] - tapTimesRef.current[i - 1]);
      }
      const averageInterval = totalInterval / (tapTimesRef.current.length - 1);
      const newTempo = Math.round(60000 / averageInterval);
      
      // Clamp between 20 and 400
      setTempo(Math.min(400, Math.max(20, newTempo)));
    }
  };

  const clearSequencer = () => {
    setActiveEditCell(null);
    setActiveEditRow(null);
    const defaults = createEmptySnapshot();
    const emptyAcc = new Set<string>();
    setAccents(emptyAcc);
    accentsRef.current = emptyAcc;
    setTempo(defaults.tempo);
    tempoRef.current = defaults.tempo;
    const defaultBars = defaults.bars;
    setBars(defaultBars);
    barsRef.current = defaultBars;
    setSyllables(PULSE_METER_BASE_SYLLABLES);
    syllablesRef.current = PULSE_METER_BASE_SYLLABLES;
    setCustomSyllables({});
    customSyllablesRef.current = {};
    setCustomMultipliers({});
    customMultipliersRef.current = {};
    setCustomSubdivisions({});
    customSubdivisionsRef.current = {};
    setPulseMeterUnlinked({});
    pulseMeterUnlinkedRef.current = {};
    setFrozenScale(null);
    frozenScaleRef.current = null;
  };

  const toggleRandomFeature = (feature: 'pulsation' | 'pattern' | 'speed' | 'barSpeed') => {
    let willBeEnabled = false;
    if (feature === 'pulsation') {
      willBeEnabled = !randomPulsation;
      setRandomPulsation(!randomPulsation);
    } else if (feature === 'pattern') {
      willBeEnabled = !randomPattern;
      setRandomPattern(!randomPattern);
    } else if (feature === 'speed') {
      willBeEnabled = !randomSpeed;
      setRandomSpeed(!randomSpeed);
    } else if (feature === 'barSpeed') {
      willBeEnabled = !randomBarSpeed;
      setRandomBarSpeed(!randomBarSpeed);
    }
    
    if (willBeEnabled && !randomModeEnabled) {
      setRandomModeEnabled(true);
    }
  };

  // (Removed Djembe hold timers)

  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledPageRef = useRef<number>(-1);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const timerIDRef = useRef<number | null>(null);
  const playheadQueueRef = useRef<PlayheadHighlightEvent[]>([]);
  const playheadTimerRef = useRef<number | null>(null);
  const sequencerGridRowActionsRef = useRef<SequencerGridRowActions | null>(null);
  const nextNoteTimeRef = useRef(0);
  const currentStepRef = useRef(0);
  const isPlayingRef = useRef(false);

  const barsRef = useRef(bars);
  const syllablesRef = useRef(syllables);
  const tempoRef = useRef(tempo);
  const accentsRef = useRef(accents);
  const customSyllablesRef = useRef(customSyllables);
  const customMultipliersRef = useRef(customMultipliers);
  const customSubdivisionsRef = useRef(customSubdivisions);
  const pulseMeterUnlinkedRef = useRef(pulseMeterUnlinked);
  const onlyAccentsRef = useRef(onlyAccents);
  const firstBeatAccentRef = useRef(firstBeatAccent);
  const randomModeEnabledRef = useRef(randomModeEnabled);
  const randomPulsationRef = useRef(randomPulsation);
  const randomPatternRef = useRef(randomPattern);
  const randomSpeedRef = useRef(randomSpeed);
  const randomBarSpeedRef = useRef(randomBarSpeed);
  const chaosLevelRef = useRef(chaosLevel);
  const clickSoundRef = useRef(clickSound);
  const frozenScaleRef = useRef(frozenScale);

  /** Пока тянут глобальные слайдеры Bars/Syllables — не писать `snapshots` из эффекта; flush на pointerup. */
  const barsSliderDraggingRef = useRef(false);
  const syllablesSliderDraggingRef = useRef(false);
  const sliderWindowListenersAttachedRef = useRef(false);
  const onWindowPointerEndCaptureRef = useRef<() => void>(() => {});
  const flushLiveSnapshotToActiveSlotRef = useRef<() => void>(() => {});

  useEffect(() => { barsRef.current = bars; }, [bars]);
  useEffect(() => { syllablesRef.current = syllables; }, [syllables]);
  useEffect(() => { tempoRef.current = tempo; }, [tempo]);
  useEffect(() => { accentsRef.current = new Set(accents); }, [accents]);
  useEffect(() => { customMultipliersRef.current = { ...customMultipliers }; }, [customMultipliers]);
  useEffect(() => { customSubdivisionsRef.current = { ...customSubdivisions }; }, [customSubdivisions]);
  useEffect(() => {
    pulseMeterUnlinkedRef.current = { ...pulseMeterUnlinked };
  }, [pulseMeterUnlinked]);
  useEffect(() => { customSyllablesRef.current = { ...customSyllables }; }, [customSyllables]);
  useEffect(() => { onlyAccentsRef.current = onlyAccents; }, [onlyAccents]);
  useEffect(() => { firstBeatAccentRef.current = firstBeatAccent; }, [firstBeatAccent]);
  useEffect(() => { randomModeEnabledRef.current = randomModeEnabled; }, [randomModeEnabled]);
  useEffect(() => { randomPulsationRef.current = randomPulsation; }, [randomPulsation]);
  useEffect(() => { randomPatternRef.current = randomPattern; }, [randomPattern]);
  useEffect(() => { randomSpeedRef.current = randomSpeed; }, [randomSpeed]);
  useEffect(() => { randomBarSpeedRef.current = randomBarSpeed; }, [randomBarSpeed]);
  useEffect(() => { chaosLevelRef.current = chaosLevel; }, [chaosLevel]);
  useEffect(() => { clickSoundRef.current = clickSound; }, [clickSound]);
  useEffect(() => { frozenScaleRef.current = frozenScale; }, [frozenScale]);

  const buildLiveSnapshotFromRefs = (): ReturnType<typeof createEmptySnapshot> => ({
    tempo: tempoRef.current,
    bars: barsRef.current,
    syllables: syllablesRef.current,
    accents: new Set(accentsRef.current),
    customSyllables: { ...customSyllablesRef.current },
    customMultipliers: { ...customMultipliersRef.current },
    customSubdivisions: { ...customSubdivisionsRef.current },
    randomModeEnabled: randomModeEnabledRef.current,
    randomPulsation: randomPulsationRef.current,
    randomPattern: randomPatternRef.current,
    randomSpeed: randomSpeedRef.current,
    randomBarSpeed: randomBarSpeedRef.current,
    chaosLevel: chaosLevelRef.current,
    clickSound: clickSoundRef.current,
    panelExpanded: isPanelExpandedRef.current,
    pulseMeterUnlinked: { ...pulseMeterUnlinkedRef.current },
    frozenScale: frozenScaleRef.current,
    onlyAccents: onlyAccentsRef.current,
    firstBeatAccent: firstBeatAccentRef.current,
    syllableReadMuteMode: syllableReadMuteModeRef.current,
  });

  const stableWindowPointerEnd = useCallback(() => {
    onWindowPointerEndCaptureRef.current();
  }, []);

  const attachSliderWindowListeners = useCallback(() => {
    if (sliderWindowListenersAttachedRef.current) return;
    sliderWindowListenersAttachedRef.current = true;
    window.addEventListener('pointerup', stableWindowPointerEnd, true);
    window.addEventListener('pointercancel', stableWindowPointerEnd, true);
  }, [stableWindowPointerEnd]);

  flushLiveSnapshotToActiveSlotRef.current = () => {
    startTransition(() => {
      setSnapshots((prev) => ({
        ...prev,
        [activeSnapshotRef.current]: buildLiveSnapshotFromRefs(),
      }));
    });
  };

  onWindowPointerEndCaptureRef.current = () => {
    if (!barsSliderDraggingRef.current && !syllablesSliderDraggingRef.current) return;
    barsSliderDraggingRef.current = false;
    syllablesSliderDraggingRef.current = false;
    if (sliderWindowListenersAttachedRef.current) {
      sliderWindowListenersAttachedRef.current = false;
      window.removeEventListener('pointerup', stableWindowPointerEnd, true);
      window.removeEventListener('pointercancel', stableWindowPointerEnd, true);
    }
    flushLiveSnapshotToActiveSlotRef.current();
  };

  useEffect(() => {
    return () => {
      if (sliderWindowListenersAttachedRef.current) {
        sliderWindowListenersAttachedRef.current = false;
        window.removeEventListener('pointerup', stableWindowPointerEnd, true);
        window.removeEventListener('pointercancel', stableWindowPointerEnd, true);
      }
    };
  }, [stableWindowPointerEnd]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        onWindowPointerEndCaptureRef.current();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const getSnapshotPayloadForSlotExport = (slot: number): ReturnType<typeof createEmptySnapshot> => {
    if (activeSnapshotRef.current === slot) {
      return buildLiveSnapshotFromRefs();
    }
    const raw = snapshotsRef.current[slot] ?? createEmptySnapshot();
    const acc = raw.accents;
    const accentsArr =
      acc instanceof Set
        ? [...acc]
        : Array.isArray(acc)
          ? acc.filter((x): x is string => typeof x === 'string')
          : [];
    return parseSnapshotRow({
      tempo: raw.tempo,
      bars: raw.bars,
      syllables: raw.syllables,
      accents: accentsArr,
      sequencerCells: raw.sequencerCells,
      customSyllables: raw.customSyllables,
      customMultipliers: raw.customMultipliers,
      customSubdivisions: raw.customSubdivisions,
      randomModeEnabled: raw.randomModeEnabled,
      randomPulsation: raw.randomPulsation,
      randomPattern: raw.randomPattern,
      randomSpeed: raw.randomSpeed,
      randomBarSpeed: raw.randomBarSpeed,
      chaosLevel: raw.chaosLevel,
      clickSound: raw.clickSound,
      panelExpanded: raw.panelExpanded,
      pulseMeterUnlinked: raw.pulseMeterUnlinked,
      frozenScale: raw.frozenScale,
      onlyAccents: raw.onlyAccents,
      firstBeatAccent: raw.firstBeatAccent,
      syllableReadMuteMode: raw.syllableReadMuteMode,
      syllableReadMuteLatched: raw.syllableReadMuteLatched,
    });
  };

  useEffect(() => {
    setPulseMeterUnlinked((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        const ri = Number(k);
        if (ri >= bars) {
          delete next[ri];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [bars]);

  /** All pattern rows fit in the phone frame: no virtual strip, no playhead autoscroll. */
  const allBarsFitViewport = frozenScale === null && bars <= 10;

  const sequence = React.useMemo(() => {
    const seq = [];
    for (let r = 0; r < bars; r++) {
      const syls = customSyllables[r] !== undefined ? customSyllables[r] : syllables;
      for (let c = 0; c < syls; c++) {
        seq.push({ r, c, activeSyllables: syls });
      }
    }
    return seq;
  }, [bars, syllables, customSyllables]);

  const sequenceRef = useRef(sequence);
  sequenceRef.current = sequence; // Always keep ref atomic with render

  // Auto-save preset whenever parameters change (пропуск во время drag Bars/Syllables — см. pointerup flush)
  useEffect(() => {
    if (barsSliderDraggingRef.current || syllablesSliderDraggingRef.current) {
      return;
    }
    startTransition(() => {
      setSnapshots((prev) => ({
        ...prev,
        [activeSnapshot]: {
          tempo,
          bars,
          syllables,
          accents,
          customSyllables,
          customMultipliers,
          customSubdivisions,
          randomModeEnabled,
          randomPulsation,
          randomPattern,
          randomSpeed,
          randomBarSpeed,
          chaosLevel: chaosLevelRef.current,
          clickSound,
          panelExpanded: isPanelExpanded,
          pulseMeterUnlinked: { ...pulseMeterUnlinked },
          frozenScale,
          onlyAccents,
          firstBeatAccent,
          syllableReadMuteMode,
        },
      }));
    });
  }, [
    tempo,
    bars,
    syllables,
    accents,
    customSyllables,
    customMultipliers,
    customSubdivisions,
    pulseMeterUnlinked,
    activeSnapshot,
    randomModeEnabled,
    randomPulsation,
    randomPattern,
    randomSpeed,
    randomBarSpeed,
    clickSound,
    isPanelExpanded,
    frozenScale,
    onlyAccents,
    firstBeatAccent,
    syllableReadMuteMode,
  ]);

  useEffect(() => {
    if (persistSnapshotsTimerRef.current !== null) {
      window.clearTimeout(persistSnapshotsTimerRef.current);
    }
    persistSnapshotsTimerRef.current = window.setTimeout(() => {
      persistSnapshotsTimerRef.current = null;
      try {
        const out: Record<string, ReturnType<typeof snapshotToJSON>> = {};
        for (let i = 1; i <= SNAPSHOT_SLOT_COUNT; i++) {
          let s = snapshots[i];
          if (i === activeSnapshot && s) {
            s = { ...s, chaosLevel: chaosLevelRef.current };
          }
          if (s) out[String(i)] = snapshotToJSON(s);
        }
        localStorage.setItem(
          SNAPSHOT_STORAGE_KEY,
          JSON.stringify({ activeSnapshot, snapshots: out }),
        );
      } catch (e) {
        console.warn('[konnakol_trainer] snapshot persist failed', e);
      }
    }, 400);
    return () => {
      if (persistSnapshotsTimerRef.current !== null) {
        window.clearTimeout(persistSnapshotsTimerRef.current);
        persistSnapshotsTimerRef.current = null;
      }
    };
  }, [snapshots, activeSnapshot, chaosLevel]);

  const applySnapshotDataToUi = (
    snap: ReturnType<typeof createEmptySnapshot>,
    options?: { preservePanel?: boolean },
  ) => {
    setTempo(snap.tempo);
    setBars(snap.bars);
    setSyllables(snap.syllables);
    setAccents(
      new Set(
        Array.isArray(snap.accents)
          ? snap.accents
          : snap.accents instanceof Set
            ? [...snap.accents]
            : [],
      ),
    );
    setCustomSyllables({ ...snap.customSyllables });
    setCustomMultipliers({ ...(snap.customMultipliers || {}) });
    setCustomSubdivisions({ ...(snap.customSubdivisions || {}) });
    setRandomModeEnabled(
      snap.randomModeEnabled !== undefined ? Boolean(snap.randomModeEnabled) : false,
    );
    setRandomPulsation(
      snap.randomPulsation !== undefined ? Boolean(snap.randomPulsation) : false,
    );
    setRandomPattern(
      snap.randomPattern !== undefined ? Boolean(snap.randomPattern) : true,
    );
    setRandomSpeed(
      snap.randomSpeed !== undefined ? Boolean(snap.randomSpeed) : false,
    );
    setRandomBarSpeed(
      snap.randomBarSpeed !== undefined ? Boolean(snap.randomBarSpeed) : false,
    );
    setChaosLevel(
      typeof snap.chaosLevel === 'number' && snap.chaosLevel >= 0 && snap.chaosLevel <= 100
        ? snap.chaosLevel
        : 0,
    );
    setClickSound(snap.clickSound === 'oldschool' ? 'oldschool' : 'modern');
    setPulseMeterUnlinked(normalizePulseMeterUnlinked(snap.pulseMeterUnlinked));
    setOnlyAccents(snap.onlyAccents === true);
    setFirstBeatAccent(snap.firstBeatAccent !== false);
    const nextMute = normalizeSyllableReadMuteModeFromSnapshot(
      snap.syllableReadMuteMode,
      (snap as { syllableReadMuteLatched?: boolean }).syllableReadMuteLatched,
    );
    setSyllableReadMuteMode(nextMute);
    syllableReadMuteModeRef.current = nextMute;
    setFrozenScale(
      typeof snap.frozenScale === 'number' && snap.frozenScale >= 1 ? snap.frozenScale : null,
    );
    if (!options?.preservePanel) {
      setIsPanelExpanded(snap.panelExpanded === true);
    }
  };

  const loadSnapshot = (id: number) => {
    onWindowPointerEndCaptureRef.current();
    flushChaosToActiveSnapshot();
    setActiveSnapshot(id);
    const snap = snapshots[id] ?? createEmptySnapshot();
    applySnapshotDataToUi(snap, { preservePanel: true });
  };

  const normalizeSnapshotForStorage = (
    s: ReturnType<typeof createEmptySnapshot>,
  ): ReturnType<typeof createEmptySnapshot> => ({
    ...s,
    accents: s.accents instanceof Set ? new Set(s.accents) : new Set(Array.isArray(s.accents) ? s.accents : []),
    customSyllables: { ...s.customSyllables },
    customMultipliers: { ...s.customMultipliers },
    customSubdivisions: { ...s.customSubdivisions },
    panelExpanded: s.panelExpanded === true,
    pulseMeterUnlinked: { ...(s.pulseMeterUnlinked || {}) },
    frozenScale: typeof s.frozenScale === 'number' && s.frozenScale >= 1 ? s.frozenScale : null,
    onlyAccents: s.onlyAccents === true,
    firstBeatAccent: s.firstBeatAccent !== false,
    syllableReadMuteMode: normalizeSyllableReadMuteModeFromSnapshot(s.syllableReadMuteMode, undefined),
  });

  const closeSnapshotClipMenu = () => setSnapshotClipMenu(null);

  const copySnapshotSlotToClipboard = async (slot: number) => {
    try {
      const payload = getSnapshotPayloadForSlotExport(slot);
      await navigator.clipboard.writeText(encodeSnapshotClipboard(payload));
      showClipboardToast('Settings copied to clipboard!');
      closeSnapshotClipMenu();
    } catch (e) {
      console.warn('[konnakol_trainer] clipboard write failed', e);
      showClipboardToast('Could not write to clipboard');
      closeSnapshotClipMenu();
    }
  };

  const pasteSnapshotFromClipboard = async (slot: number) => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      console.warn('[konnakol_trainer] clipboard read failed', e);
      showClipboardToast('Clipboard access denied');
      closeSnapshotClipMenu();
      return;
    }
    const parsed = tryDecodeSnapshotClipboard(text);
    if (!parsed) {
      showClipboardToast('No METRONOME_CONFIG preset in clipboard');
      closeSnapshotClipMenu();
      return;
    }
    try {
      const stored = normalizeSnapshotForStorage(parsed);
      onWindowPointerEndCaptureRef.current();
      flushChaosToActiveSnapshot();
      setActiveSnapshot(slot);
      applySnapshotDataToUi(stored, { preservePanel: true });
      showClipboardToast('Preset applied!');
    } catch (e) {
      console.warn('[konnakol_trainer] apply preset failed', e);
      showClipboardToast('Could not apply preset');
    }
    closeSnapshotClipMenu();
  };

  const openSnapshotClipMenu = (slot: number) => {
    const el = snapshotSlotButtonRefs.current[slot];
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const margin = 52;
    const x = Math.min(window.innerWidth - margin, Math.max(margin, cx));
    setSnapshotClipMenu({
      slot,
      x,
      y: r.bottom + 8,
    });
  };

  useEffect(() => {
    if (!snapshotClipMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSnapshotClipMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snapshotClipMenu]);

  // Ensure currentStepRef bounds are respected if grid shrinks
  useEffect(() => {
    if (currentStepRef.current >= sequence.length) {
      currentStepRef.current = 0;
    }
  }, [sequence.length]);

  // Determine display metrics that drive auto-scrolling
  const displayScaleBars = frozenScale !== null ? Math.min(frozenScale, 10) : Math.min(bars, 10);
  const useFixedFlex = frozenScale !== null || bars > 10;
  
  // Create a scroll stride that overlaps by 1 row
  const scrollStride = Math.max(1, displayScaleBars - 1);

  const setRowElStable = useCallback((absR: number, el: HTMLDivElement | null) => {
    rowRefs.current[absR] = el;
  }, []);

  /**
   * Автоскролл при воспроизведении.
   * Если freeze даёт ровно **1** видимый такт (`frozenScale === 1`) и тактов в паттерне > 1:
   * листаем через 10 ms после **начала** подсветки последней доли такта (следующая строка в ленте).
   * Иначе — прежняя логика «страниц» по scrollStride и половине такта.
   */
  useEffect(() => {
    let tid: number | null = null;
    const cleanup = () => {
      if (tid !== null) {
        window.clearTimeout(tid);
        tid = null;
      }
    };

    if (!isPlaying) {
      lastScrolledPageRef.current = -1;
      if (gridRef.current) gridRef.current.scrollTop = 0;
      return cleanup;
    }

    const frozenOneBarViewport =
      frozenScale !== null && Math.min(frozenScale, 10) === 1 && bars > 1;

    if (frozenOneBarViewport) {
      if (activePos.absR >= 0) {
        const rowSylls =
          customSyllables[activePos.r] !== undefined ? customSyllables[activePos.r] : syllables;
        if (rowSylls >= 1 && activePos.c === rowSylls - 1) {
          tid = window.setTimeout(() => {
            tid = null;
            const nextAbs = activePos.absR + 1;
            const rowEl = rowRefs.current[nextAbs];
            if (rowEl) {
              rowEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }, 10);
        }
      }
      return cleanup;
    }

    if (frozenScale === null && bars <= 10) {
      return cleanup;
    }

    if (activePos.absR >= 0 && gridRef.current) {
      let logicalPage = Math.floor(activePos.absR / scrollStride);

      if (activePos.absR > 0 && activePos.absR % scrollStride === 0) {
        const rIdx = activePos.absR % bars;
        const rowSylls = customSyllables[rIdx] !== undefined ? customSyllables[rIdx] : syllables;
        const isPastHalfway = activePos.c >= Math.floor(rowSylls / 2);

        if (!isPastHalfway) {
          logicalPage -= 1;
        }
      }

      if (logicalPage !== lastScrolledPageRef.current) {
        lastScrolledPageRef.current = logicalPage;
        const pageStartAbsR = logicalPage * scrollStride;
        const rowEl = rowRefs.current[pageStartAbsR];

        if (rowEl) {
          rowEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    }

    return cleanup;
  }, [
    activePos.absR,
    activePos.c,
    activePos.r,
    isPlaying,
    scrollStride,
    customSyllables,
    syllables,
    bars,
    frozenScale,
  ]);

  useEffect(() => {
    return () => {
      if (timerIDRef.current) clearTimeout(timerIDRef.current);
      if (snapshotHoldTimerRef.current !== null) {
        window.clearTimeout(snapshotHoldTimerRef.current);
        snapshotHoldTimerRef.current = null;
      }
      if (clipboardToastTimerRef.current !== null) {
        window.clearTimeout(clipboardToastTimerRef.current);
        clipboardToastTimerRef.current = null;
      }
      if (squareHoldTimerRef.current !== null) {
        window.clearTimeout(squareHoldTimerRef.current);
        squareHoldTimerRef.current = null;
      }
      syllableReadMuteModeRef.current = 'off';
      setSyllableReadMuteMode('off');
      if (playheadTimerRef.current !== null) {
        window.clearTimeout(playheadTimerRef.current);
        playheadTimerRef.current = null;
      }
      playheadQueueRef.current = [];
      if (audioCtxRef.current) audioCtxRef.current.close().catch(() => {});
    };
  }, []);

  const flushChaosToActiveSnapshot = () => {
    const slot = activeSnapshotRef.current;
    const chaos = chaosLevelRef.current;
    startTransition(() => {
      setSnapshots((prev) => {
        const cur = prev[slot];
        if (!cur || cur.chaosLevel === chaos) return prev;
        return { ...prev, [slot]: { ...cur, chaosLevel: chaos } };
      });
    });
  };

  const clearPlayheadScheduling = () => {
    if (playheadTimerRef.current !== null) {
      window.clearTimeout(playheadTimerRef.current);
      playheadTimerRef.current = null;
    }
    playheadQueueRef.current = [];
  };

  function schedulePlayheadWake() {
    if (playheadTimerRef.current !== null) {
      window.clearTimeout(playheadTimerRef.current);
      playheadTimerRef.current = null;
    }
    if (!isPlayingRef.current || !audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    const q = playheadQueueRef.current;
    let lastPos: { r: number; c: number; absR: number } | null = null;
    while (q.length > 0 && q[0].t <= ctx.currentTime) {
      lastPos = q.shift()!.pos;
    }
    if (lastPos !== null) setActivePos(lastPos);
    if (q.length === 0) return;
    const delayMs = Math.max(0, (q[0].t - ctx.currentTime) * 1000);
    playheadTimerRef.current = window.setTimeout(() => {
      playheadTimerRef.current = null;
      schedulePlayheadWake();
    }, delayMs);
  }

  const toggleAccent = useCallback((r: number, c: number) => {
    setAccents((prev) => {
      const next = new Set(prev);
      const key = `${r}-${c}`;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const nextNote = () => {
    try {
      const seq = sequenceRef.current;
      if (seq.length === 0) {
        nextNoteTimeRef.current += 0.5;
        return;
      }
      
      // Boundary safety net
      if (currentStepRef.current >= seq.length || currentStepRef.current < 0) {
        currentStepRef.current = 0;
      }

      let currentSeqItem = seq[currentStepRef.current];

      // Randomizer Orchestration at bar boundary
      if (currentSeqItem && currentSeqItem.c === 0 && isPlayingRef.current) {
        if (coldStartRef.current) {
          coldStartRef.current = false;
        } else if (randomModeEnabledRef.current) {
          const targetR = currentSeqItem.r;
          const prevBar = (targetR - 1 + barsRef.current) % barsRef.current;
          let didChange = false;

          const chaos = chaosLevelRef.current;

          if (randomPulsationRef.current) {
            customSyllablesRef.current[prevBar] = pickWeightedMeter2to9(chaos);
            didChange = true;
          }

          if (randomPatternRef.current) {
            const curSyl = customSyllablesRef.current[prevBar] ?? syllablesRef.current;
            
            for (let i = 0; i < 9; i++) accentsRef.current.delete(`${prevBar}-${i}`);
            
            const candidates = Array.from({length: curSyl}, (_, i) => i).sort(() => Math.random() - 0.5);
            const fillCount = pickAccentCountForBar(chaos, curSyl);
            for (let i = 0; i < fillCount; i++) {
               accentsRef.current.add(`${prevBar}-${candidates[i]}`);
            }
            didChange = true;
          }

          if (randomSpeedRef.current) {
            const curSyl = customSyllablesRef.current[prevBar] ?? syllablesRef.current;
            const candidates = onlyAccentsRef.current 
              ? Array.from({length: curSyl}, (_, i) => i).filter(i => accentsRef.current.has(`${prevBar}-${i}`))
              : Array.from({length: curSyl}, (_, i) => i);
              
            for (let i = 0; i < 9; i++) delete customSubdivisionsRef.current[`${prevBar}-${i}`];

            const cellSpeedHitP = cellSpeedFillFractionFromChaos(chaos);
            candidates.forEach(i => {
              if (Math.random() < cellSpeedHitP) {
                customSubdivisionsRef.current[`${prevBar}-${i}`] = pickRandomCellSpeedSubdiv();
              }
            });
            didChange = true;
          }

          if (randomBarSpeedRef.current) {
            customMultipliersRef.current[prevBar] = pickBarSpeedMultiplier(chaos);
            didChange = true;
          }

          if (didChange) {
            const newSeq = [];
            for (let r = 0; r < barsRef.current; r++) {
              const syls = customSyllablesRef.current[r] !== undefined ? customSyllablesRef.current[r] : syllablesRef.current;
              for (let c = 0; c < syls; c++) {
                newSeq.push({ r, c, activeSyllables: syls });
              }
            }
            sequenceRef.current = newSeq;
            
            const targetStepIndex = sequenceRef.current.findIndex(item => item.r === targetR && item.c === 0);
            if (targetStepIndex !== -1) {
              currentStepRef.current = targetStepIndex;
            } else {
              currentStepRef.current = 0;
            }
            
            currentSeqItem = sequenceRef.current[currentStepRef.current];

            setTimeout(() => {
              startTransition(() => {
                if (randomPulsationRef.current) setCustomSyllables({ ...customSyllablesRef.current });
                if (randomPatternRef.current) setAccents(new Set(accentsRef.current));
                if (randomSpeedRef.current) setCustomSubdivisions({ ...customSubdivisionsRef.current });
                if (randomBarSpeedRef.current) setCustomMultipliers({ ...customMultipliersRef.current });
              });
            }, 0);
          }
        }
      }

      if (!currentSeqItem) {
        nextNoteTimeRef.current += 0.5;
        return; 
      }

      const rowR = currentSeqItem.r;
      const effectiveSyllables = currentSeqItem.activeSyllables || syllablesRef.current;
      const pulseSyllables = pulseMeterUnlinkedRef.current[rowR]
        ? PULSE_METER_BASE_SYLLABLES
        : effectiveSyllables;
      const mult = customMultipliersRef.current[rowR] || 1;

      const effectiveBpm = tempoRef.current * (pulseSyllables / 4) * mult;
      if (effectiveBpm > 0) {
        nextNoteTimeRef.current += 60.0 / effectiveBpm;
      } else {
        nextNoteTimeRef.current += 0.5;
      }
      
      const oldR = currentSeqItem.r;
      currentStepRef.current = (currentStepRef.current + 1) % Math.max(1, sequenceRef.current.length);
      const nextSeqItem = sequenceRef.current[currentStepRef.current];
      
      if (nextSeqItem) {
          const newR = nextSeqItem.r;
          if (newR !== oldR) {
              const compact =
                frozenScaleRef.current === null && barsRef.current <= 10;
              if (compact) {
                /* Loop on same screen: playhead row index stays 0..bars-1. */
                playAbsBarRef.current = newR;
              } else if (newR === 0 && oldR === barsRef.current - 1) {
                playAbsBarRef.current += 1;
              } else if (newR > oldR) {
                playAbsBarRef.current += newR - oldR;
              } else {
                playAbsBarRef.current = newR;
              }
          }
      }
    } catch (e) {
      console.error("Critical error in nextNote:", e);
      // Emergency fallback to prevent the browser from freezing in an infinite while loop!
      nextNoteTimeRef.current += 0.5; 
      currentStepRef.current = 0; // Wrap around safely
    }
  };

  const scheduleNote = (stepIdx: number, absR: number, time: number) => {
    const seq = sequenceRef.current;
    const currentSeqItem = seq[stepIdx];
    if (!currentSeqItem) return;

    const { r: rIdx, c: cIdx } = currentSeqItem;
    const isAccent = accentsRef.current.has(`${rIdx}-${cIdx}`);

    if (!audioCtxRef.current) return;
    
    const subdivs = customSubdivisionsRef.current[`${rIdx}-${cIdx}`] || 1;
    const mult = customMultipliersRef.current[rIdx] || 1;
    const rowSyl = currentSeqItem.activeSyllables || syllablesRef.current;
    const pulseSyllables = pulseMeterUnlinkedRef.current[rIdx] ? PULSE_METER_BASE_SYLLABLES : rowSyl;
    const effectiveBpm = tempoRef.current * (pulseSyllables / 4) * mult;
    const stepDuration = 60.0 / effectiveBpm;
    const subDuration = stepDuration / subdivs;

    /** Long-press квадрата: `full` — тишина по сетке; `no_accent_sharp` — акцентные доли со звуком пассивных. */
    const muteMode = syllableReadMuteModeRef.current;
    for (let sub = 0; sub < subdivs; sub++) {
      const subTime = time + sub * subDuration;
      const isFirstOfBar = cIdx === 0 && sub === 0;

      if (isFirstOfBar && firstBeatAccentRef.current && muteMode !== 'full') {
        playBarFirstHighClick(audioCtxRef.current, subTime, clickSoundRef.current);
      }

      const mainAccentClick = isAccent && sub === 0;
      if (muteMode === 'full') {
        continue;
      }
      const shouldPlayBeat = !onlyAccentsRef.current || isAccent;
      if (!shouldPlayBeat) {
        continue;
      }
      /** В `no_accent_sharp` главный щелчок на акцентной клетке — тембр пассивной доли (`isChecked` false). */
      const sharpAsChecked =
        muteMode === 'no_accent_sharp' && mainAccentClick ? false : mainAccentClick;
      playSharpClick(
        audioCtxRef.current,
        subTime,
        sharpAsChecked,
        clickSoundRef.current,
        onlyAccentsRef.current,
      );
    }

    insertPlayheadSorted(playheadQueueRef.current, {
      t: time,
      pos: { r: rIdx, c: cIdx, absR },
    });
    schedulePlayheadWake();
  };

  const scheduler = () => {
    if (!isPlayingRef.current || !audioCtxRef.current) return;
    while (nextNoteTimeRef.current < audioCtxRef.current.currentTime + 0.1) {
      scheduleNote(currentStepRef.current, playAbsBarRef.current, nextNoteTimeRef.current);
      nextNote();
    }
    timerIDRef.current = window.setTimeout(scheduler, 25);
  };

  const togglePlayback = () => {
    if (isPlaying) {
      setIsPlaying(false);
      isPlayingRef.current = false;
      clearPlayheadScheduling();
      setActivePos({ r: -1, c: -1, absR: -1 });
      currentStepRef.current = 0; // Reset pattern position to start
      if (timerIDRef.current) clearTimeout(timerIDRef.current);
      if (squareHoldTimerRef.current !== null) {
        window.clearTimeout(squareHoldTimerRef.current);
        squareHoldTimerRef.current = null;
      }
      syllableReadMuteModeRef.current = 'off';
      setSyllableReadMuteMode('off');
      squareHoldAteClickRef.current = false;
    } else {
      setIsPanelExpanded(false);
      setShowRandomSettings(false);
      setIsPlaying(true);
      isPlayingRef.current = true;
      clearPlayheadScheduling();
      coldStartRef.current = true; // Mark cold start
      
      const startSeqItem = sequenceRef.current[currentStepRef.current];
      playAbsBarRef.current = startSeqItem ? startSeqItem.r : 0;
      
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContextClass();
      }
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }
      // Guarantee loop limits if grid resized
      if (currentStepRef.current >= sequenceRef.current.length) {
        currentStepRef.current = 0;
      }
      nextNoteTimeRef.current = audioCtxRef.current.currentTime + 0.05;
      scheduler();
    }
  };

  /* Синхронизация refs с render до pointerup flush (до useEffect по deps). */
  tempoRef.current = tempo;
  barsRef.current = bars;
  syllablesRef.current = syllables;
  accentsRef.current = accents;
  customSyllablesRef.current = { ...customSyllables };
  customMultipliersRef.current = { ...customMultipliers };
  customSubdivisionsRef.current = { ...customSubdivisions };
  pulseMeterUnlinkedRef.current = { ...pulseMeterUnlinked };

  sequencerGridRowActionsRef.current = {
    isHoldingRef,
    holdTimerRef,
    pulseUnlinkHoldTimerRef,
    isPanelExpandedRef,
    showRandomSettingsRef,
    syllables,
    setActiveEditRow,
    setActiveEditCell,
    setIsPanelExpanded,
    setCustomMultipliers,
    setPulseMeterUnlinked,
    setCustomSyllables,
    setCustomSubdivisions,
    toggleAccent,
    pulseMeterUnlinkedRef,
  };

  return (
    <div className="min-h-screen bg-[#0b101e] sm:bg-black/95 text-slate-200 p-0 sm:p-6 font-sans flex flex-col items-center justify-center">
      {/* Phone emulator container */}
      <div className="w-full max-w-[390px] h-[100dvh] sm:h-[844px] sm:rounded-[2.5rem] sm:border-[6px] border-[#1e2a45] shadow-2xl bg-[#0b101e] flex flex-col gap-3 p-3 relative overflow-hidden shrink-0">
        
        {/* Top Header Controls */}
        <div className="flex gap-2 items-center">
          <button 
            onClick={() => {
              if (!showRandomSettings) {
                setShowRandomSettings(true);
                setIsPanelExpanded(true);
              } else {
                setShowRandomSettings(false);
              }
            }}
            className="p-3 bg-[#161f33] rounded-xl border border-[#23314f] text-slate-400 hover:text-slate-200 transition-colors"
          >
            <Settings size={20} />
          </button>
          {!isPanelExpanded && !showRandomSettings ? (
            <div className="flex-1 flex items-center gap-2 min-w-0 py-2 px-1.5 bg-[#161f33] rounded-xl border border-[#23314f] touch-none">
              <button
                type="button"
                onClick={() => setTempo((t) => Math.max(20, t - 1))}
                className="p-2 bg-[#23314f] rounded-lg text-slate-300 hover:bg-[#2c3d63] active:bg-[#1b253b] transition-colors shrink-0"
              >
                <Minus size={18} strokeWidth={2.5} />
              </button>
              <div
                className="flex-1 relative flex items-center h-8 min-w-0 cursor-pointer touch-none"
                onPointerDown={(e) => {
                  const el = e.currentTarget;
                  el.setPointerCapture(e.pointerId);
                  const rect = el.getBoundingClientRect();
                  const thumbHalf = 24;
                  const updateTempo = (clientX: number) => {
                    const activeWidth = rect.width - thumbHalf * 2;
                    const x = Math.max(0, Math.min(activeWidth, clientX - rect.left - thumbHalf));
                    const percent = x / Math.max(1, activeWidth);
                    setTempo(Math.round(20 + percent * 380));
                  };
                  updateTempo(e.clientX);
                  const onMove = (moveEvt: PointerEvent) => {
                    updateTempo(moveEvt.clientX);
                  };
                  const onUp = () => {
                    el.removeEventListener('pointermove', onMove);
                    el.removeEventListener('pointerup', onUp);
                    el.releasePointerCapture(e.pointerId);
                  };
                  el.addEventListener('pointermove', onMove);
                  el.addEventListener('pointerup', onUp);
                }}
              >
                <div className="absolute w-full h-1.5 bg-[#0b101e] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#364976]"
                    style={{ width: `calc(24px + ${((tempo - 20) / 380)} * calc(100% - 48px))` }}
                  />
                </div>
                <div
                  className="absolute z-10 bg-[#23314f] border border-[#2f4066] px-3 w-12 text-center py-1 rounded-full text-sm font-bold shadow-md -translate-x-1/2 flex items-center justify-center select-none"
                  style={{ left: `calc(24px + ${((tempo - 20) / 380)} * calc(100% - 48px))` }}
                >
                  {tempo}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setTempo((t) => Math.min(400, t + 1))}
                className="p-2 bg-[#23314f] rounded-lg text-slate-300 hover:bg-[#2c3d63] active:bg-[#1b253b] transition-colors shrink-0"
              >
                <Plus size={18} strokeWidth={2.5} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleTap}
              className="flex-1 py-3 bg-[#161f33] rounded-xl border border-[#23314f] font-semibold text-slate-300 tracking-wide hover:bg-[#1a253c] active:bg-purple-900/50 active:border-purple-500/50 active:text-purple-100 transition-all active:scale-95 duration-75"
            >
              Tap
            </button>
          )}
          <button 
            onClick={clearSequencer}
            className="p-3 bg-[#161f33] rounded-xl border border-[#23314f] text-slate-400 hover:text-red-400 hover:border-red-500/30 active:bg-red-500/20 transition-all duration-200"
            title="Clear Sequencer"
          >
            <Eraser size={20} />
          </button>
        </div>

        {/* Global Settings (Tempo & Row Selectors) */}
        <div className="relative bg-[#161f33] rounded-2xl border border-[#23314f] flex flex-col shrink-0 mb-3">
          {showRandomSettings ? (
            <div className={`grid transition-all duration-300 ${isPanelExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div className={`overflow-hidden flex flex-col transition-all duration-300 ${isPanelExpanded ? 'px-2.5 py-4 gap-5' : 'px-2.5 py-0 gap-0'}`}>
                <div className="flex flex-col gap-4 px-1 pb-1">
                  <div className="flex justify-between items-center text-slate-300 font-bold text-[11px] uppercase tracking-wider">
                    <span className="flex items-center gap-2 drop-shadow-[0_0_8px_rgba(59,130,246,0.5)] text-blue-300">
                      <Dices size={14} /> Randomizer
                    </span>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-2">
                     <button 
                       onClick={() => toggleRandomFeature('pulsation')}
                       className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                         randomPulsation 
                           ? 'bg-purple-600/20 border-purple-500/50 text-purple-300 shadow-[0_0_10px_rgba(168,85,247,0.15)]' 
                           : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                       }`}
                     >
                       Pulsation
                     </button>
                     <button 
                        onClick={() => toggleRandomFeature('pattern')}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                          randomPattern 
                            ? 'bg-purple-600/20 border-purple-500/50 text-purple-300 shadow-[0_0_10px_rgba(168,85,247,0.15)]' 
                            : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                        }`}
                     >
                        Accents
                     </button>
                     <button 
                        onClick={() => toggleRandomFeature('speed')}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                          randomSpeed 
                            ? 'bg-purple-600/20 border-purple-500/50 text-purple-300 shadow-[0_0_10px_rgba(168,85,247,0.15)]' 
                            : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                        }`}
                     >
                        Cell Speed
                     </button>
                     <button 
                        onClick={() => toggleRandomFeature('barSpeed')}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                          randomBarSpeed 
                            ? 'bg-purple-600/20 border-purple-500/50 text-purple-300 shadow-[0_0_10px_rgba(168,85,247,0.15)]' 
                            : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                        }`}
                     >
                        Bar Speed
                     </button>
                  </div>

                  <div className="flex flex-col gap-2 px-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-400 font-bold tracking-wider uppercase">
                        Chaos level
                      </span>
                      <span className="text-purple-300 font-mono text-xs font-bold">{chaosLevel}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={chaosLevel}
                      onChange={(e) => setChaosLevel(parseInt(e.target.value, 10))}
                      onPointerUp={() => flushChaosToActiveSnapshot()}
                      onPointerCancel={() => flushChaosToActiveSnapshot()}
                      onBlur={() => flushChaosToActiveSnapshot()}
                      className="w-full h-2 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110"
                    />
                  </div>

                  <div className="w-full h-px bg-[#1e2a45]/80 my-0.5"></div>

                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-slate-400 font-bold tracking-wider uppercase">Click Sound</span>
                    <div className="flex bg-[#0b101e] p-[3px] rounded-lg border border-[#2f4066]/50">
                       <button onClick={() => setClickSound('modern')} className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${clickSound === 'modern' ? 'bg-[#364976] text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}>Modern</button>
                       <button onClick={() => setClickSound('oldschool')} className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${clickSound === 'oldschool' ? 'bg-[#364976] text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}>Oldschool</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <>
              {isPanelExpanded ? (
                <div className="px-2.5 pt-3 pb-1">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setTempo((t) => Math.max(20, t - 1))}
                      className="p-2 bg-[#23314f] rounded-lg text-slate-300 hover:bg-[#2c3d63] active:bg-[#1b253b] transition-colors shrink-0"
                    >
                      <Minus size={18} strokeWidth={2.5} />
                    </button>
                    <div
                      className="flex-1 relative flex items-center h-8 cursor-pointer touch-none"
                      onPointerDown={(e) => {
                        const el = e.currentTarget;
                        el.setPointerCapture(e.pointerId);
                        const rect = el.getBoundingClientRect();
                        const updateTempo = (clientX: number) => {
                          const thumbHalf = 24;
                          const activeWidth = rect.width - thumbHalf * 2;
                          const x = Math.max(0, Math.min(activeWidth, clientX - rect.left - thumbHalf));
                          const percent = x / Math.max(1, activeWidth);
                          setTempo(Math.round(20 + percent * 380));
                        };
                        updateTempo(e.clientX);

                        const onMove = (moveEvt: PointerEvent) => {
                          updateTempo(moveEvt.clientX);
                        };
                        const onUp = () => {
                          el.removeEventListener('pointermove', onMove);
                          el.removeEventListener('pointerup', onUp);
                          el.releasePointerCapture(e.pointerId);
                        };

                        el.addEventListener('pointermove', onMove);
                        el.addEventListener('pointerup', onUp);
                      }}
                    >
                      <div className="absolute w-full h-1.5 bg-[#0b101e] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#364976]"
                          style={{ width: `calc(24px + ${((tempo - 20) / 380)} * calc(100% - 48px))` }}
                        />
                      </div>
                      <div
                        className="absolute z-10 bg-[#23314f] border border-[#2f4066] px-3 w-12 text-center py-1 rounded-full text-sm font-bold shadow-md -translate-x-1/2 flex items-center justify-center select-none"
                        style={{ left: `calc(24px + ${((tempo - 20) / 380)} * calc(100% - 48px))` }}
                      >
                        {tempo}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTempo((t) => Math.min(400, t + 1))}
                      className="p-2 bg-[#23314f] rounded-lg text-slate-300 hover:bg-[#2c3d63] active:bg-[#1b253b] transition-colors shrink-0"
                    >
                      <Plus size={18} strokeWidth={2.5} />
                    </button>
                  </div>
                </div>
              ) : null}
              <div
                className={`grid transition-all duration-300 ${isPanelExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
              >
                <div
                  className={`overflow-hidden flex flex-col transition-all duration-300 ${isPanelExpanded ? 'px-2.5 pb-2 pt-0' : 'px-2.5 py-0'}`}
                >
                  <div className="flex flex-col">
                    <div className="flex justify-between items-center px-1 translate-y-[3px]">
                      {[1, 2, 3, 4, 5, 6, 7].map((num) => {
                        const isActive = activeSnapshot === num;
                        const hasData =
                          isActive || snapSlotLooksUsed(snapshots[num] ?? createEmptySnapshot());

                        return (
                          <button
                            key={num}
                            type="button"
                            ref={(el) => {
                              snapshotSlotButtonRefs.current[num] = el;
                            }}
                            title="Tap: select slot. Hold: copy / paste preset menu"
                            className={`w-8 h-8 flex items-center justify-center rounded-full text-[13px] font-bold transition-all touch-none select-none ${
                              isActive
                                ? 'bg-[#1e2a45] text-white shadow-sm ring-1 ring-[#3a5080] scale-110'
                                : hasData
                                  ? 'text-slate-300 bg-[#1e2a45]/30 hover:bg-[#1e2a45]/60 hover:text-white'
                                  : 'text-slate-600 hover:text-slate-400'
                            }`}
                            onPointerDown={() => {
                              snapshotHoldAteClickRef.current = false;
                              snapshotHoldSlotRef.current = num;
                              if (snapshotHoldTimerRef.current !== null) {
                                window.clearTimeout(snapshotHoldTimerRef.current);
                                snapshotHoldTimerRef.current = null;
                              }
                              snapshotHoldTimerRef.current = window.setTimeout(() => {
                                snapshotHoldTimerRef.current = null;
                                const s = snapshotHoldSlotRef.current;
                                snapshotHoldSlotRef.current = null;
                                if (s == null) return;
                                snapshotHoldAteClickRef.current = true;
                                openSnapshotClipMenu(s);
                              }, SNAPSHOT_MENU_HOLD_MS);
                            }}
                            onPointerUp={() => {
                              if (snapshotHoldTimerRef.current !== null) {
                                window.clearTimeout(snapshotHoldTimerRef.current);
                                snapshotHoldTimerRef.current = null;
                              }
                            }}
                            onPointerCancel={() => {
                              if (snapshotHoldTimerRef.current !== null) {
                                window.clearTimeout(snapshotHoldTimerRef.current);
                                snapshotHoldTimerRef.current = null;
                              }
                            }}
                            onClick={() => {
                              if (snapshotHoldAteClickRef.current) {
                                snapshotHoldAteClickRef.current = false;
                                return;
                              }
                              loadSnapshot(num);
                            }}
                            onContextMenu={(e) => e.preventDefault()}
                          >
                            {num}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Dynamic Scaling Sliders (Always Visible) */}
          <div className={`px-2.5 pt-1 pb-3 flex flex-col mb-2 transition-all duration-300 ${isPanelExpanded ? 'gap-4' : 'gap-0'}`}>
            <div className="flex items-center gap-2">
              <div className="flex items-center w-12 justify-between pr-1 shrink-0">
                <span className="text-[11px] uppercase tracking-wider text-slate-400 font-bold">Bars</span>
                <button 
                  onClick={() => setFrozenScale(frozenScale !== null ? null : bars)}
                  className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-all duration-300 ${
                    frozenScale !== null 
                      ? 'bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/50 shadow-[0_0_8px_rgba(59,130,246,0.3)]' 
                      : 'bg-[#1e2a45]/40 text-slate-400 hover:text-slate-200 hover:bg-[#1e2a45] ring-1 ring-[#2f4066]/30'
                  }`}
                  title={frozenScale !== null ? "Unfreeze row height" : "Freeze current row height"}
                >
                  <Snowflake size={12} />
                </button>
              </div>
              <input 
                type="range" 
                min="1" 
                max="32" 
                value={bars} 
                onPointerDown={() => {
                  barsSliderDraggingRef.current = true;
                  attachSliderWindowListeners();
                }}
                onChange={(e) => setBars(parseInt(e.target.value, 10))} 
                className="flex-1 h-3 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-blue-400 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110" 
              />
              <div className="w-5 shrink-0 flex justify-end">
                <input 
                  type="text"
                  inputMode="numeric"
                  key={`bars-input-${bars}`}
                  defaultValue={bars}
                  onFocus={e => e.target.select()}
                  onBlur={e => {
                    let val = parseInt(e.target.value);
                    if (isNaN(val) || val < 1) val = 1;
                    if (val > 100) val = 100;
                    setBars(val);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                  className="w-full text-xs font-bold text-slate-300 text-right bg-transparent hover:bg-[#1e2a45] focus:bg-[#1e2a45] rounded outline-none transition-colors py-1 cursor-text select-text"
                  title="Click to type a number (up to 100)"
                />
              </div>
            </div>

            <div className={`grid transition-all duration-300 ${isPanelExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div className="overflow-hidden">
                <div className="relative h-4 w-full">
                  {/* Global Syllables Slider */}
                  <div className={`absolute inset-0 flex items-center gap-2 transition-all duration-300 ${(activeEditCell !== null || activeEditRow !== null) ? 'opacity-0 pointer-events-none scale-y-50' : 'opacity-100 scale-y-100'}`}>
                    <span className="text-[11px] uppercase tracking-wider text-slate-400 font-bold w-12 shrink-0">Syllbs</span>
                    <input 
                      type="range" 
                      min="1" 
                      max="9" 
                      value={syllables} 
                      onPointerDown={() => {
                        syllablesSliderDraggingRef.current = true;
                        attachSliderWindowListeners();
                      }}
                      onChange={(e) => setSyllables(parseInt(e.target.value, 10))} 
                      className="flex-1 h-3 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-emerald-400 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110" 
                    />
                    <div className="w-5 shrink-0 flex justify-end">
                      <span className="w-full py-1 text-xs font-bold text-slate-300 text-right">{syllables}</span>
                    </div>
                  </div>

                  {/* Specific Bar Syllables Slider */}
                  <div className={`absolute inset-0 flex items-center gap-2 transition-all duration-300 ${activeEditRow !== null && activeEditCell === null ? 'opacity-100 scale-y-100 z-10' : 'opacity-0 pointer-events-none scale-y-50 translate-y-4'}`}>
                    <span className="text-[11px] uppercase tracking-wider text-purple-400 font-bold w-12 shrink-0 truncate">Bar {activeEditRow !== null ? activeEditRow + 1 : ''}</span>
                    <input 
                      type="range" 
                      min="1" 
                      max="9" 
                      value={activeEditRow !== null ? (customSyllables[activeEditRow] || syllables) : 1} 
                      onChange={(e) => {
                        if (activeEditRow !== null) {
                          setCustomSyllables(prev => ({...prev, [activeEditRow]: parseInt(e.target.value)}));
                        }
                      }} 
                      className="flex-1 h-3 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110" 
                    />
                    <div className="w-5 shrink-0 flex items-center justify-end gap-0.5">
                      <span className="text-[11px] font-bold text-purple-300 text-right">{activeEditRow !== null ? (customSyllables[activeEditRow] || syllables) : ''}</span>
                      <button onClick={() => setActiveEditRow(null)} className="w-[14px] h-[14px] flex shrink-0 items-center justify-center rounded-full bg-purple-900/60 text-[8px] text-purple-300 hover:bg-purple-800 transition-colors">✕</button>
                    </div>
                  </div>

                  {/* Specific Cell Subdivisions Slider */}
                  <div className={`absolute inset-0 flex items-center gap-2 transition-all duration-300 ${activeEditCell !== null ? 'opacity-100 scale-y-100 z-20' : 'opacity-0 pointer-events-none scale-y-50 translate-y-4'}`}>
                    <span className="text-[11px] uppercase tracking-wider text-purple-400 font-bold w-12 shrink-0 truncate">Divs</span>
                    <input 
                      type="range" 
                      min="1" 
                      max="9" 
                      value={activeEditCell !== null ? (customSubdivisions[activeEditCell] || 1) : 1} 
                      onChange={(e) => {
                        if (activeEditCell !== null) {
                          setCustomSubdivisions(prev => ({...prev, [activeEditCell]: parseInt(e.target.value)}));
                        }
                      }} 
                      className="flex-1 h-3 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110" 
                    />
                    <div className="w-5 shrink-0 flex items-center justify-end gap-0.5">
                      <span className="text-[11px] font-bold text-purple-300 text-right">{activeEditCell !== null ? (customSubdivisions[activeEditCell] || 1) : ''}</span>
                      <button onClick={() => setActiveEditCell(null)} className="w-[14px] h-[14px] flex shrink-0 items-center justify-center rounded-full bg-purple-900/60 text-[8px] text-purple-300 hover:bg-purple-800 transition-colors">✕</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          {/* Collapse Arrow Toggle */}
          <button 
            onClick={() => setIsPanelExpanded(!isPanelExpanded)}
            className="absolute bottom-0 left-4 translate-y-1/2 w-8 h-8 bg-[#1e2a45] rounded-full flex items-center justify-center text-slate-400 hover:text-white hover:bg-[#2c3d63] transition-colors shadow-lg border border-[#2f4066] z-30"
          >
            {isPanelExpanded ? <ChevronUp size={16} strokeWidth={3} /> : <ChevronDown size={16} strokeWidth={3} />}
          </button>
        </div>

        <SequencerGrid
          gridRef={gridRef}
          bars={bars}
          syllables={syllables}
          customSyllables={customSyllables}
          customSubdivisions={customSubdivisions}
          customMultipliers={customMultipliers}
          accents={accents}
          pulseMeterUnlinked={pulseMeterUnlinked}
          isPlaying={isPlaying}
          activePos={activePos}
          displayScaleBars={displayScaleBars}
          useFixedFlex={useFixedFlex}
          allBarsFitViewport={allBarsFitViewport}
          activeEditRow={activeEditRow}
          activeEditCell={activeEditCell}
          sequencerGridRowActionsRef={sequencerGridRowActionsRef}
          setRowElStable={setRowElStable}
        />

        {/* Bottom Actions */}
        <div className="flex gap-3 mt-1 shrink-0 h-[60px]">
          {/* Randomizer */}
          <button 
            onClick={() => setRandomModeEnabled(prev => !prev)}
            className={`flex-1 rounded-xl border flex justify-center items-center transition-colors relative ${
              randomModeEnabled
                ? 'bg-blue-600/30 border-blue-400/60 shadow-[0_0_15px_rgba(59,130,246,0.3)] text-blue-200'
                : 'bg-[#161f33] border-[#23314f] text-slate-400 hover:text-slate-200 hover:bg-[#1a253c]'
            }`}
          >
            <Dices size={24} />
          </button>
          
          {/* First Beat Accent ("Ta") */}
          <button 
            onClick={() => setFirstBeatAccent(!firstBeatAccent)}
            className={`flex-1 rounded-xl flex justify-center items-center transition-all bg-[#161f33] ${
              firstBeatAccent 
                ? 'border border-purple-400 shadow-[0_0_15px_rgba(192,132,252,0.4)] text-purple-200' 
                : 'border border-[#23314f] text-slate-400 hover:text-slate-200 hover:bg-[#1a253c] active:bg-[#131b2c]'
            }`}
          >
            <span className="font-bold text-[22px] tracking-wide">Ta</span>
          </button>

          {/* All beats vs accent-only (square); long-press: режим от muteMode (см. aria-label). */}
          <button 
            onPointerDown={() => {
              squareHoldAteClickRef.current = false;
              if (squareHoldTimerRef.current !== null) {
                window.clearTimeout(squareHoldTimerRef.current);
                squareHoldTimerRef.current = null;
              }
              squareHoldTimerRef.current = window.setTimeout(() => {
                squareHoldTimerRef.current = null;
                const prev = syllableReadMuteModeRef.current;
                const next: SyllableReadMuteMode =
                  prev !== 'off' ? 'off' : onlyAccentsRef.current ? 'full' : 'no_accent_sharp';
                syllableReadMuteModeRef.current = next;
                setSyllableReadMuteMode(next);
                squareHoldAteClickRef.current = true;
              }, 400);
            }}
            onPointerUp={() => {
              if (squareHoldTimerRef.current !== null) {
                window.clearTimeout(squareHoldTimerRef.current);
                squareHoldTimerRef.current = null;
              }
            }}
            onPointerLeave={() => {
              if (squareHoldTimerRef.current !== null) {
                window.clearTimeout(squareHoldTimerRef.current);
                squareHoldTimerRef.current = null;
              }
            }}
            onPointerCancel={() => {
              if (squareHoldTimerRef.current !== null) {
                window.clearTimeout(squareHoldTimerRef.current);
                squareHoldTimerRef.current = null;
              }
            }}
            onClick={() => {
              if (squareHoldAteClickRef.current) {
                squareHoldAteClickRef.current = false;
                return;
              }
              setOnlyAccents(!onlyAccents);
            }}
            onContextMenu={(e) => e.preventDefault()}
            className={`flex-1 rounded-xl flex justify-center items-center transition-all touch-none select-none relative bg-[#161f33] ${
              syllableReadMuteMode !== 'off'
                ? syllableReadMuteMode === 'full'
                  ? 'border border-amber-400/90 shadow-[0_0_14px_rgba(251,191,36,0.28)] text-amber-100'
                  : 'border border-purple-400 shadow-[0_0_15px_rgba(192,132,252,0.4)] text-purple-200'
                : onlyAccents
                  ? 'border border-purple-500/40 bg-purple-700/30 hover:bg-purple-700/40 active:bg-purple-700/20 text-purple-200'
                  : 'border border-[#23314f] hover:bg-[#1a253c] active:bg-[#131b2c] text-slate-400 hover:text-slate-200'
            }`}
            type="button"
            aria-label={
              syllableReadMuteMode === 'full'
                ? 'Тишина по щелчкам сетки (вкл. только акценты). Долгое — выключить'
                : syllableReadMuteMode === 'no_accent_sharp'
                  ? 'Пассивные как обычно; на акцентах звук как у пассивных. Долгое — выключить'
                  : onlyAccents
                    ? 'Только выделенные доли; долгое при вкл. — полная тишина по сетке'
                    : 'Все доли; долгое без «только акценты» — акценты со звуком пассивных'
            }
          >
            <span
              className={`block w-6 h-6 rounded-sm border-2 border-current transition-all duration-300 ${
                syllableReadMuteMode !== 'off' || onlyAccents
                  ? 'opacity-100 scale-110 bg-current/25'
                  : 'opacity-55 scale-100 bg-transparent'
              }`}
            />
          </button>
        </div>

        {clipboardToast ? (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute bottom-[5.5rem] left-1/2 z-[60] max-w-[min(92%,22rem)] -translate-x-1/2 rounded-xl bg-[#1e2a45] px-3.5 py-2.5 text-center text-[13px] font-medium leading-snug text-slate-100 shadow-lg ring-1 ring-[#3a5080]"
          >
            {clipboardToast}
          </div>
        ) : null}

        {/* Play Button */}
        <div className="shrink-0 mb-2">
          <button 
            onClick={togglePlayback}
            className={`w-full py-4 rounded-xl font-black text-lg tracking-[0.2em] flex items-center justify-center gap-2 shadow-[0_8px_20px_rgba(16,185,129,0.2)] transition-all transform active:scale-[0.98] ${
              isPlaying 
                ? 'bg-rose-500 hover:bg-rose-400 active:bg-rose-600 shadow-rose-500/20 text-white' 
                : 'bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-slate-950'
            }`}
          >
            {isPlaying ? (
              <>■ STOP</>
            ) : (
              <><Play fill="currentColor" size={22} className="-ml-2" /> PLAY</>
            )}
          </button>
        </div>

      </div>

      {snapshotClipMenu ? (
        <>
          <div
            className="fixed inset-0 z-[200] bg-black/50"
            aria-hidden
            onPointerDown={closeSnapshotClipMenu}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Preset: copy or paste"
            className="fixed z-[201] flex items-center gap-1 rounded-xl border border-[#2f4066] bg-[#161f33] p-1.5 shadow-2xl ring-1 ring-black/30"
            style={{
              left: snapshotClipMenu.x,
              top: snapshotClipMenu.y,
              transform: 'translate(-50%, 0)',
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#23314f] text-slate-200 transition-colors hover:bg-[#2c3d63] active:bg-[#1b253b] ring-1 ring-[#2f4066]/40"
              title="Copy slot preset to clipboard"
              aria-label="Copy slot preset to clipboard"
              onClick={() => void copySnapshotSlotToClipboard(snapshotClipMenu.slot)}
            >
              <Copy size={20} strokeWidth={2.25} />
            </button>
            <div className="h-8 w-px shrink-0 bg-[#2f4066]/70" aria-hidden />
            <button
              type="button"
              className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#23314f] text-slate-200 transition-colors hover:bg-[#2c3d63] active:bg-[#1b253b] ring-1 ring-[#2f4066]/40"
              title="Paste preset from clipboard into slot"
              aria-label="Paste preset from clipboard into slot"
              onClick={() => void pasteSnapshotFromClipboard(snapshotClipMenu.slot)}
            >
              <ClipboardPaste size={20} strokeWidth={2.25} />
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
