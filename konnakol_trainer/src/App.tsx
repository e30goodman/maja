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

type PlayheadPosition = { r: number; c: number; absR: number; voice: number; step: number };
type PlayheadHighlightEvent = { t: number; pos: PlayheadPosition };

function buildPolyChunks(barCount: number, voiceCount: number): number[][] {
	const safeBars = Math.max(0, Math.floor(barCount));
	const safeVoices = voiceCount === 3 || voiceCount === 4 ? voiceCount : 2;
	const chunks: number[][] = [];
	for (let i = 0; i < safeBars; i += safeVoices) {
		const chunk: number[] = [];
		for (let v = 0; v < safeVoices; v++) {
			const barIdx = i + v;
			if (barIdx < safeBars) chunk.push(barIdx);
		}
		if (chunk.length > 0) chunks.push(chunk);
	}
	return chunks;
}

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
/** Random pulsation: пул по chaos; пульсации 1 и 2 (Ta) с сильно пониженным весом к 3–9. */
const RANDOM_PULSE_POOL_LE_30 = [1, 2, 3, 4, 5] as const;
const RANDOM_PULSE_POOL_LE_70 = [1, 2, 3, 4, 5, 6, 7] as const;
const RANDOM_PULSE_POOL_FULL = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
/** Вес пульсации 1 vs остальные (=1), кроме 2 — отдельно. */
const RANDOM_PULSE_1_WEIGHT = 0.06;
/** Вес пульсации 2 (Ta): как у 1 — редко относительно 3–9. */
const RANDOM_PULSE_2_WEIGHT = 0.06;

function pickRandomPulsationMeter(chaos: number): number {
	const c = Math.max(0, Math.min(CHAOS_SLIDER_MAX, chaos));
	const pool =
		c <= 30 ? RANDOM_PULSE_POOL_LE_30 : c <= 70 ? RANDOM_PULSE_POOL_LE_70 : RANDOM_PULSE_POOL_FULL;
	let sum = 0;
	const w: number[] = [];
	for (const v of pool) {
		const wi = v === 1 ? RANDOM_PULSE_1_WEIGHT : v === 2 ? RANDOM_PULSE_2_WEIGHT : 1;
		w.push(wi);
		sum += wi;
	}
	let r = Math.random() * sum;
	for (let i = 0; i < pool.length; i++) {
		r -= w[i]!;
		if (r <= 0) return pool[i]!;
	}
	return pool[pool.length - 1]!;
}

/** Доля акцентуемых долей: 0→0, 25→25%, 50→50%, 75→75%, 100→90% (кусочно-линейно). */
function accentFillRatioFromChaos(c: number): number {
	const x = Math.max(0, Math.min(CHAOS_SLIDER_MAX, c));
	if (x <= 25) return 0.25 * (x / 25);
	if (x <= 50) return 0.25 + (x - 25) * (0.25 / 25);
	if (x <= 75) return 0.5 + (x - 50) * (0.25 / 25);
	return 0.75 + (x - 75) * (0.15 / 25);
}

/** Random pulsation (длина такта / поддоли): chaos≤30 → 1–5; 31–70 → 1–7; >70 → 1–9; 1 и 2 редки. */
function pickWeightedMeter2to9(chaos: number): number {
	return pickRandomPulsationMeter(chaos);
}

const CELL_SPEED_RANDOM_POOL = [2, 3, 4] as const;

/** Random Speed (cell speed): только поддоли 2, 3 или 4. */
function pickRandomCellSpeedSubdiv(): number {
	return CELL_SPEED_RANDOM_POOL[Math.floor(Math.random() * CELL_SPEED_RANDOM_POOL.length)]!;
}

function parsePolyVoices(raw: unknown): 2 | 3 | 4 {
	const n = parseInt(String(raw), 10);
	return n === 3 || n === 4 ? n : 2;
}

/**
 * Доля долей такта, в которых random speed выставляет новую поддоль (остальные сбрасываются в дефолт).
 * Используется только при chaos > 25: chaos 26–33 → 33%; 34–66 → 66%; 67–89 → линейно 66%→100%; ≥90 → 100%.
 * При chaos 0–25 см. ветку в планировщике: не более одной ячейки на такт.
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

type BarRandomizerMutable = {
	customSyllables: Record<number, number>;
	accents: Set<string>;
	customSubdivisions: Record<string, number>;
	customMultipliers: Record<number, number>;
};

/** Одна итерация рандома на такт `prevBar` (как на границе такта в плеере). */
function applyRandomizerEffectsToBar(
	prevBar: number,
	chaos: number,
	randomPulsation: boolean,
	randomPattern: boolean,
	randomSpeed: boolean,
	randomBarSpeed: boolean,
	onlyAccents: boolean,
	syllablesDefault: number,
	m: BarRandomizerMutable,
): boolean {
	let didChange = false;

	if (randomPulsation) {
		m.customSyllables[prevBar] = pickWeightedMeter2to9(chaos);
		didChange = true;
	}

	const curSyl = m.customSyllables[prevBar] ?? syllablesDefault;

	if (randomPattern) {
		for (let i = 0; i < 9; i++) m.accents.delete(`${prevBar}-${i}`);
		const candidates = Array.from({ length: curSyl }, (_, i) => i).sort(() => Math.random() - 0.5);
		const fillCount = pickAccentCountForBar(chaos, curSyl);
		for (let i = 0; i < fillCount; i++) {
			m.accents.add(`${prevBar}-${candidates[i]}`);
		}
		didChange = true;
	}

	if (randomSpeed) {
		const curSylSpeed = m.customSyllables[prevBar] ?? syllablesDefault;
		const candidates = onlyAccents
			? Array.from({ length: curSylSpeed }, (_, i) => i).filter((i) => m.accents.has(`${prevBar}-${i}`))
			: Array.from({ length: curSylSpeed }, (_, i) => i);
		for (let i = 0; i < 9; i++) delete m.customSubdivisions[`${prevBar}-${i}`];
		if (chaos <= 25) {
			const pOne = chaos <= 0 ? 0 : chaos / 25;
			if (candidates.length > 0 && Math.random() < pOne) {
				const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
				m.customSubdivisions[`${prevBar}-${pick}`] = pickRandomCellSpeedSubdiv();
			}
		} else {
			const cellSpeedHitP = cellSpeedFillFractionFromChaos(chaos);
			candidates.forEach((i) => {
				if (Math.random() < cellSpeedHitP) {
					m.customSubdivisions[`${prevBar}-${i}`] = pickRandomCellSpeedSubdiv();
				}
			});
		}
		didChange = true;
	}

	if (randomBarSpeed) {
		m.customMultipliers[prevBar] = pickBarSpeedMultiplier(chaos);
		didChange = true;
	}

	return didChange;
}

const SNAPSHOT_SLOT_COUNT = 7;
const SNAPSHOT_STORAGE_KEY = 'konnakolTrainerSnapshotsV1';
const LITE_UI_STORAGE_KEY = 'konnakol_lite_ui';
const POLY_MODE_STORAGE_KEY = 'konnakol_poly_mode';
const POLY_VOICES_STORAGE_KEY = 'konnakol_poly_voices';
const APP_COMMIT_VERSION = (() => {
	const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_APP_COMMIT;
	if (typeof env === 'string' && env.length >= 7) return env.slice(0, 7);
	if (typeof __GIT_SHA7__ === 'string' && __GIT_SHA7__.length >= 7) return __GIT_SHA7__.slice(0, 7);
	return '43de007';
})();
const TEMPO_THROTTLE_MS = 56;
/** Clipboard export: kawaii magic marker for compact preset payload. */
const SNAPSHOT_CLIPBOARD_MARKER = '(⁠ʘ⁠ᴗ⁠ʘ⁠)⁠♪:';
/** Accept marker with/without zero-width separators from messengers. */
const SNAPSHOT_CLIPBOARD_MARKER_REGEX =
	/^\([\s\u200b\u200c\u200d\ufeff\u2060]*ʘ[\s\u200b\u200c\u200d\ufeff\u2060]*ᴗ[\s\u200b\u200c\u200d\ufeff\u2060]*ʘ[\s\u200b\u200c\u200d\ufeff\u2060]*\)[\s\u200b\u200c\u200d\ufeff\u2060]*♪[\s\u200b\u200c\u200d\ufeff\u2060]*:/;
/** Backward compatibility for previously shared compact snapshots. */
const SNAPSHOT_CLIPBOARD_PREFIX_LEGACY_COMPACT = 'METRONOME_CONFIG:';
/** Legacy prefix with raw JSON after colon — still accepted when pasting. */
const SNAPSHOT_CLIPBOARD_PREFIX_LEGACY = 'konnakolTrainerSnapshotV1:';
/** Hold snapshot slot to open Copy / Paste menu. */
const SNAPSHOT_MENU_HOLD_MS = 520;
/** Удерживание кнопки «кости»: префилл всех тактов по активным фичам Randomizer. */
const RANDOM_DICE_PREFILL_HOLD_MS = SNAPSHOT_MENU_HOLD_MS;

const SNAPSHOT_FLAG_RANDOM_MODE_ENABLED = 1 << 0;
const SNAPSHOT_FLAG_RANDOM_PULSATION = 1 << 1;
const SNAPSHOT_FLAG_RANDOM_PATTERN = 1 << 2;
const SNAPSHOT_FLAG_RANDOM_SPEED = 1 << 3;
const SNAPSHOT_FLAG_RANDOM_BAR_SPEED = 1 << 4;
const SNAPSHOT_FLAG_PANEL_EXPANDED = 1 << 5;
const SNAPSHOT_FLAG_ONLY_ACCENTS = 1 << 6;
const SNAPSHOT_FLAG_FIRST_BEAT_ACCENT = 1 << 7;
const SNAPSHOT_FLAG_POLY_MODE = 1 << 8;
const SNAPSHOT_FLAG_POLY_VOICES_3 = 1 << 9;
const SNAPSHOT_FLAG_POLY_VOICES_4 = 1 << 10;
const SNAPSHOT_SOUND_ID_CLASSIC = 0;
const SNAPSHOT_SOUND_ID_OLDSCHOOL = 1;

function buildSnapshotGridToken(s: ReturnType<typeof createEmptySnapshot>): string {
	const accents = s.accents instanceof Set ? s.accents : new Set(Array.isArray(s.accents) ? s.accents : []);
	let bits = '';
	for (let r = 0; r < s.bars; r++) {
		for (let c = 0; c < s.syllables; c++) {
			bits += accents.has(`${r}-${c}`) ? '1' : '0';
		}
	}
	if (!bits || /^0+$/.test(bits)) return '0';
	const fullHex = BigInt(`0b${bits}`).toString(16);
	const trailingZeros = bits.match(/0+$/)?.[0].length ?? 0;
	const coreLen = bits.length - trailingZeros;
	const coreBits = coreLen > 0 ? bits.slice(0, coreLen) : '0';
	const coreHex = BigInt(`0b${coreBits}`).toString(16);
	const compressed = trailingZeros > 0 ? `${coreHex}~${trailingZeros.toString(36)}` : coreHex;
	return compressed.length < fullHex.length ? compressed : fullHex;
}

function hydrateSnapshotAccentsFromGridToken(
	gridToken: string,
	bars: number,
	syllables: number,
	d: ReturnType<typeof createEmptySnapshot>,
) {
	const totalCells = bars * syllables;
	if (totalCells <= 0) {
		d.accents = new Set<string>();
		return;
	}
	const normalizedToken = gridToken.trim().toLowerCase();
	if (!normalizedToken) return;
	let normalizedHex = normalizedToken;
	let trailingZeros = 0;
	if (normalizedToken.includes('~')) {
		const [hexPart, tzPart] = normalizedToken.split('~');
		if (!hexPart || tzPart === undefined || tzPart.length === 0) return;
		if (!/^[0-9a-f]+$/.test(hexPart)) return;
		const tz = parseInt(tzPart, 36);
		if (!Number.isFinite(tz) || tz < 0 || tz > totalCells) return;
		normalizedHex = hexPart;
		trailingZeros = tz;
	} else {
		if (!/^[0-9a-f]+$/.test(normalizedHex)) return;
	}
	// BigInt is mandatory here to safely parse masks >53 bits.
	let bits = BigInt(`0x${normalizedHex}`).toString(2);
	if (trailingZeros > 0) {
		const coreLen = Math.max(0, totalCells - trailingZeros);
		if (bits.length < coreLen) bits = bits.padStart(coreLen, '0');
		if (bits.length > coreLen) bits = bits.slice(bits.length - coreLen);
		bits += '0'.repeat(trailingZeros);
	}
	if (bits.length < totalCells) bits = bits.padStart(totalCells, '0');
	if (bits.length > totalCells) bits = bits.slice(bits.length - totalCells);
	const nextAccents = new Set<string>();
	let idx = 0;
	for (let r = 0; r < bars; r++) {
		for (let c = 0; c < syllables; c++) {
			if (bits[idx] === '1') nextAccents.add(`${r}-${c}`);
			idx++;
		}
	}
	d.accents = nextAccents;
}

function encodeSparseRowNumberMap(
	map: Record<number, number>,
	isAllowed: (value: number) => boolean,
): string {
	const parts: string[] = [];
	for (const [k, raw] of Object.entries(map)) {
		const row = parseInt(k, 10);
		const value = parseInt(String(raw), 10);
		if (!Number.isFinite(row) || row < 0 || !Number.isFinite(value) || !isAllowed(value)) continue;
		parts.push(`${row.toString(36)}:${value.toString(36)}`);
	}
	if (parts.length === 0) return '0';
	parts.sort();
	return parts.join('_');
}

function decodeSparseRowNumberMap(
	token: string,
	isAllowed: (value: number) => boolean,
): Record<number, number> {
	if (!token || token === '0') return {};
	const out: Record<number, number> = {};
	for (const chunk of token.split('_')) {
		const [rowRaw, valueRaw] = chunk.split(':');
		if (!rowRaw || !valueRaw) continue;
		const row = parseInt(rowRaw, 36);
		const value = parseInt(valueRaw, 36);
		if (!Number.isFinite(row) || row < 0 || !Number.isFinite(value) || !isAllowed(value)) continue;
		out[row] = value;
	}
	return out;
}

function encodePulseUnlinkedRowsToken(rows: Record<number, boolean>): string {
	const out: string[] = [];
	for (const [k, raw] of Object.entries(rows)) {
		const row = parseInt(k, 10);
		if (!Number.isFinite(row) || row < 0 || raw !== true) continue;
		out.push(row.toString(36));
	}
	if (out.length === 0) return '0';
	out.sort();
	return out.join('_');
}

function decodePulseUnlinkedRowsToken(token: string): Record<number, boolean> {
	if (!token || token === '0') return {};
	const out: Record<number, boolean> = {};
	for (const piece of token.split('_')) {
		const row = parseInt(piece, 36);
		if (!Number.isFinite(row) || row < 0) continue;
		out[row] = true;
	}
	return out;
}

function buildCellIndexMapForSnapshot(
	bars: number,
	syllables: number,
	customSyllables: Record<number, number>,
): Array<{ key: string }> {
	const cells: Array<{ key: string }> = [];
	for (let r = 0; r < bars; r++) {
		const rowSylls = customSyllables[r] !== undefined ? customSyllables[r] : syllables;
		for (let c = 0; c < rowSylls; c++) {
			cells.push({ key: `${r}-${c}` });
		}
	}
	return cells;
}

function buildAccentTokenForVariableGrid(accents: Set<string>, cells: Array<{ key: string }>): string {
	if (cells.length === 0) return '0';
	let bits = '';
	for (const cell of cells) bits += accents.has(cell.key) ? '1' : '0';
	if (!bits || /^0+$/.test(bits)) return '0';
	const fullHex = BigInt(`0b${bits}`).toString(16);
	const trailingZeros = bits.match(/0+$/)?.[0].length ?? 0;
	const coreLen = bits.length - trailingZeros;
	const coreBits = coreLen > 0 ? bits.slice(0, coreLen) : '0';
	const coreHex = BigInt(`0b${coreBits}`).toString(16);
	return trailingZeros > 0 ? `${coreHex}~${trailingZeros.toString(36)}` : fullHex;
}

function hydrateAccentsFromVariableGridToken(token: string, cells: Array<{ key: string }>): Set<string> {
	const totalCells = cells.length;
	if (!token || token === '0' || totalCells === 0) return new Set<string>();
	const normalizedToken = token.toLowerCase();
	let normalizedHex = normalizedToken;
	let trailingZeros = 0;
	if (normalizedToken.includes('~')) {
		const [hexPart, tzPart] = normalizedToken.split('~');
		if (!hexPart || tzPart === undefined || tzPart.length === 0) return new Set<string>();
		if (!/^[0-9a-f]+$/.test(hexPart)) return new Set<string>();
		const tz = parseInt(tzPart, 36);
		if (!Number.isFinite(tz) || tz < 0 || tz > totalCells) return new Set<string>();
		normalizedHex = hexPart;
		trailingZeros = tz;
	} else if (!/^[0-9a-f]+$/.test(normalizedHex)) {
		return new Set<string>();
	}
	let bits = BigInt(`0x${normalizedHex}`).toString(2);
	if (trailingZeros > 0) {
		const coreLen = Math.max(0, totalCells - trailingZeros);
		if (bits.length < coreLen) bits = bits.padStart(coreLen, '0');
		if (bits.length > coreLen) bits = bits.slice(bits.length - coreLen);
		bits += '0'.repeat(trailingZeros);
	}
	if (bits.length < totalCells) bits = bits.padStart(totalCells, '0');
	if (bits.length > totalCells) bits = bits.slice(bits.length - totalCells);
	const out = new Set<string>();
	for (let i = 0; i < totalCells; i++) {
		if (bits[i] === '1') out.add(cells[i]!.key);
	}
	return out;
}

function encodeSubdivisionsToken(
	customSubdivisions: Record<string, number>,
	cells: Array<{ key: string }>,
): string {
	const out: string[] = [];
	for (let idx = 0; idx < cells.length; idx++) {
		const key = cells[idx]!.key;
		const val = customSubdivisions[key];
		if (typeof val !== 'number' || val < 1 || val > 9 || val === 1) continue;
		out.push(`${idx.toString(36)}:${val.toString(36)}`);
	}
	if (out.length === 0) return '0';
	return out.join('_');
}

function decodeSubdivisionsToken(token: string, cells: Array<{ key: string }>): Record<string, number> {
	if (!token || token === '0') return {};
	const out: Record<string, number> = {};
	for (const piece of token.split('_')) {
		const [idxRaw, valRaw] = piece.split(':');
		if (!idxRaw || !valRaw) continue;
		const idx = parseInt(idxRaw, 36);
		const val = parseInt(valRaw, 36);
		if (!Number.isFinite(idx) || idx < 0 || idx >= cells.length) continue;
		if (!Number.isFinite(val) || val < 1 || val > 9 || val === 1) continue;
		out[cells[idx]!.key] = val;
	}
	return out;
}

function toBase64Url(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(token: string): Uint8Array | null {
	const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
	const pad = (4 - (b64.length % 4)) % 4;
	const padded = b64 + '='.repeat(pad);
	try {
		const bin = atob(padded);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
		return out;
	} catch {
		return null;
	}
}

function pushU16(out: number[], value: number) {
	out.push((value >> 8) & 0xff, value & 0xff);
}

function readU16(bytes: Uint8Array, offset: number): number | null {
	if (offset + 1 >= bytes.length) return null;
	return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function packGridTokenPacked(
	snapshot: ReturnType<typeof createEmptySnapshot>,
	cells: Array<{ key: string }>,
	accents: Set<string>,
): string {
	const out: number[] = [];
	const bars = Math.max(1, Math.min(255, snapshot.bars));
	const syllables = Math.max(1, Math.min(9, snapshot.syllables));
	const useV2 = (snapshot.accentMapVersion ?? 0) >= 1;
	const gridVersion = useV2 ? 0x02 : 0x01;
	out.push(0x50, gridVersion, bars, syllables);

	const rowEntries = Object.entries(snapshot.customSyllables)
		.map(([k, v]) => [parseInt(k, 10), parseInt(String(v), 10)] as const)
		.filter(([r, v]) => Number.isFinite(r) && r >= 0 && r < bars && Number.isFinite(v) && v >= 1 && v <= 9)
		.sort((a, b) => a[0] - b[0]);
	out.push(Math.min(255, rowEntries.length));
	for (let i = 0; i < Math.min(255, rowEntries.length); i++) {
		const [r, v] = rowEntries[i]!;
		out.push(r & 0xff, v & 0xff);
	}

	pushU16(out, Math.min(65535, cells.length));
	let accByte = 0;
	let accBit = 0;
	for (let i = 0; i < cells.length; i++) {
		if (accents.has(cells[i]!.key)) accByte |= 1 << accBit;
		accBit++;
		if (accBit === 8) {
			out.push(accByte);
			accByte = 0;
			accBit = 0;
		}
	}
	if (accBit !== 0) out.push(accByte);

	const subEntries: Array<[number, number]> = [];
	for (let i = 0; i < cells.length; i++) {
		const v = snapshot.customSubdivisions[cells[i]!.key];
		if (typeof v === 'number' && v >= 2 && v <= 9) subEntries.push([i, v]);
	}
	pushU16(out, Math.min(65535, subEntries.length));
	for (let i = 0; i < Math.min(65535, subEntries.length); i++) {
		const [idx, v] = subEntries[i]!;
		pushU16(out, idx);
		out.push(v & 0xff);
	}

	const multEntries = Object.entries(snapshot.customMultipliers)
		.map(([k, v]) => [parseInt(k, 10), parseInt(String(v), 10)] as const)
		.filter(([r, v]) => Number.isFinite(r) && r >= 0 && r < bars && Number.isFinite(v) && v >= 2 && v <= 4)
		.sort((a, b) => a[0] - b[0]);
	out.push(Math.min(255, multEntries.length));
	for (let i = 0; i < Math.min(255, multEntries.length); i++) {
		const [r, v] = multEntries[i]!;
		out.push(r & 0xff, v & 0xff);
	}

	const pulseRows = Object.entries(snapshot.pulseMeterUnlinked || {})
		.map(([k, v]) => [parseInt(k, 10), Boolean(v)] as const)
		.filter(([r, v]) => Number.isFinite(r) && r >= 0 && r < bars && v)
		.map(([r]) => r)
		.sort((a, b) => a - b);
	out.push(Math.min(255, pulseRows.length));
	for (let i = 0; i < Math.min(255, pulseRows.length); i++) out.push(pulseRows[i]! & 0xff);

	if (useV2) {
		out.push(Math.min(255, Math.max(0, Math.floor(snapshot.accentMapVersion ?? 1))) & 0xff);
	}

	const prefix = useV2 ? 'p2' : 'p1';
	return `${prefix}${toBase64Url(new Uint8Array(out))}`;
}

function unpackGridTokenPacked(
	token: string,
	d: ReturnType<typeof createEmptySnapshot>,
): boolean {
	let b64 = token;
	if (token.startsWith('p2')) b64 = token.slice(2);
	else if (token.startsWith('p1')) b64 = token.slice(2);
	else return false;
	const bytes = fromBase64Url(b64);
	if (!bytes || bytes.length < 6) return false;
	let off = 0;
	const magic = bytes[off++]!;
	const version = bytes[off++]!;
	if (magic !== 0x50 || (version !== 0x01 && version !== 0x02)) return false;
	const bars = bytes[off++]!;
	const syllables = bytes[off++]!;
	if (bars < 1 || bars > 100 || syllables < 1 || syllables > 9) return false;
	d.bars = bars;
	d.syllables = syllables;

	const rowCount = bytes[off++]!;
	const nextCustomSyllables: Record<number, number> = {};
	for (let i = 0; i < rowCount; i++) {
		if (off + 1 >= bytes.length) return false;
		const r = bytes[off++]!;
		const v = bytes[off++]!;
		if (r < bars && v >= 1 && v <= 9) nextCustomSyllables[r] = v;
	}
	d.customSyllables = nextCustomSyllables;

	const cellCount = readU16(bytes, off);
	if (cellCount === null) return false;
	off += 2;
	const cells = buildCellIndexMapForSnapshot(d.bars, d.syllables, d.customSyllables);
	const cappedCellCount = Math.min(cellCount, cells.length);
	const accBytesLen = Math.ceil(cappedCellCount / 8);
	if (off + accBytesLen > bytes.length) return false;
	const nextAccents = new Set<string>();
	for (let i = 0; i < cappedCellCount; i++) {
		const byte = bytes[off + (i >> 3)]!;
		if (((byte >> (i & 7)) & 1) === 1) nextAccents.add(cells[i]!.key);
	}
	off += accBytesLen;
	d.accents = nextAccents;

	const subCount = readU16(bytes, off);
	if (subCount === null) return false;
	off += 2;
	const nextSub: Record<string, number> = {};
	for (let i = 0; i < subCount; i++) {
		const idx = readU16(bytes, off);
		if (idx === null) return false;
		off += 2;
		if (off >= bytes.length) return false;
		const v = bytes[off++]!;
		if (idx < cells.length && v >= 2 && v <= 9) nextSub[cells[idx]!.key] = v;
	}
	d.customSubdivisions = nextSub;

	if (off >= bytes.length) return false;
	const multCount = bytes[off++]!;
	const nextMult: Record<number, number> = {};
	for (let i = 0; i < multCount; i++) {
		if (off + 1 >= bytes.length) return false;
		const r = bytes[off++]!;
		const v = bytes[off++]!;
		if (r < bars && v >= 2 && v <= 4) nextMult[r] = v;
	}
	d.customMultipliers = nextMult;

	if (off >= bytes.length) return false;
	const pulseCount = bytes[off++]!;
	const nextPulse: Record<number, boolean> = {};
	for (let i = 0; i < pulseCount; i++) {
		if (off >= bytes.length) return false;
		const r = bytes[off++]!;
		if (r < bars) nextPulse[r] = true;
	}
	d.pulseMeterUnlinked = nextPulse;
	if (version === 0x02) {
		if (off < bytes.length) {
			const v = bytes[off++]!;
			d.accentMapVersion = v >= 1 ? 1 : 0;
		} else {
			d.accentMapVersion = 1;
		}
	}
	return true;
}

function buildSnapshotFlags(s: ReturnType<typeof createEmptySnapshot>): number {
	let flags = 0;
	if (s.randomModeEnabled) flags |= SNAPSHOT_FLAG_RANDOM_MODE_ENABLED;
	if (s.randomPulsation) flags |= SNAPSHOT_FLAG_RANDOM_PULSATION;
	if (s.randomPattern) flags |= SNAPSHOT_FLAG_RANDOM_PATTERN;
	if (s.randomSpeed) flags |= SNAPSHOT_FLAG_RANDOM_SPEED;
	if (s.randomBarSpeed) flags |= SNAPSHOT_FLAG_RANDOM_BAR_SPEED;
	if (s.panelExpanded) flags |= SNAPSHOT_FLAG_PANEL_EXPANDED;
	if (s.onlyAccents) flags |= SNAPSHOT_FLAG_ONLY_ACCENTS;
	if (s.firstBeatAccent) flags |= SNAPSHOT_FLAG_FIRST_BEAT_ACCENT;
	if (s.polyMode) flags |= SNAPSHOT_FLAG_POLY_MODE;
	if (s.polyVoices === 3) flags |= SNAPSHOT_FLAG_POLY_VOICES_3;
	if (s.polyVoices === 4) flags |= SNAPSHOT_FLAG_POLY_VOICES_4;
	return flags;
}

function applySnapshotFlags(flags: number, d: ReturnType<typeof createEmptySnapshot>) {
	d.randomModeEnabled = Boolean(flags & SNAPSHOT_FLAG_RANDOM_MODE_ENABLED);
	d.randomPulsation = Boolean(flags & SNAPSHOT_FLAG_RANDOM_PULSATION);
	d.randomPattern = Boolean(flags & SNAPSHOT_FLAG_RANDOM_PATTERN);
	d.randomSpeed = Boolean(flags & SNAPSHOT_FLAG_RANDOM_SPEED);
	d.randomBarSpeed = Boolean(flags & SNAPSHOT_FLAG_RANDOM_BAR_SPEED);
	d.panelExpanded = Boolean(flags & SNAPSHOT_FLAG_PANEL_EXPANDED);
	d.onlyAccents = Boolean(flags & SNAPSHOT_FLAG_ONLY_ACCENTS);
	d.firstBeatAccent = Boolean(flags & SNAPSHOT_FLAG_FIRST_BEAT_ACCENT);
	d.polyMode = Boolean(flags & SNAPSHOT_FLAG_POLY_MODE);
	d.polyVoices = (flags & SNAPSHOT_FLAG_POLY_VOICES_4)
		? 4
		: (flags & SNAPSHOT_FLAG_POLY_VOICES_3)
			? 3
			: 2;
}

function buildSnapshotSoundId(s: ReturnType<typeof createEmptySnapshot>): number {
	return s.clickSound === 'oldschool' ? SNAPSHOT_SOUND_ID_OLDSCHOOL : SNAPSHOT_SOUND_ID_CLASSIC;
}

function applySnapshotSoundId(soundId: number, d: ReturnType<typeof createEmptySnapshot>) {
	d.clickSound = soundId === SNAPSHOT_SOUND_ID_OLDSCHOOL ? 'oldschool' : 'classic';
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
		/** Classic = legacy maja без `konnakol_metronome`: акцент / пассив + Ta на первой доле. */
		clickSound: 'classic' as 'classic' | 'oldschool',
		/** Верхняя панель: темп + слайдеры (Chevron) развёрнута. */
		panelExpanded: false,
		/** Ряд r: длительность клетки от PULSE_METER_BASE_SYLLABLES, не от customSyllables[r]. */
		pulseMeterUnlinked: {} as Record<number, boolean>,
		/** Заморозка высоты ряда (число видимых тактов) или null. */
		frozenScale: null as number | null,
		polyMode: false,
		polyVoices: 2 as 2 | 3 | 4,
		onlyAccents: false,
		firstBeatAccent: true,
		/** 0 = legacy: первая доля Ta без явных ключей `r-0` считается включённой; 1 = карта `accents` для первых долей. */
		accentMapVersion: 0,
		syllableReadMuteMode: 'off' as SyllableReadMuteMode,
		/** Диктант: только первый слог такта с зелёным бегунком; пассивные щелчки выключены. */
		dictantMode: false,
		/** Звук 1 (Ta-динг): любые `r-c`, включая `r-0` (белая рамка в редакторе Ta без записи в `accents`). */
		taDingKeys: new Set<string>(),
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
	else d.clickSound = 'classic'; // default + legacy `modern`
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
	if (typeof o.dictantMode === 'boolean') d.dictantMode = o.dictantMode;
	if (typeof o.firstBeatAccent === 'boolean') d.firstBeatAccent = o.firstBeatAccent;
	if (o.accentMapVersion === true) d.accentMapVersion = 1;
	else {
		const amv = parseInt(String(o.accentMapVersion), 10);
		if (Number.isFinite(amv) && amv >= 1) d.accentMapVersion = 1;
	}
	d.syllableReadMuteMode = normalizeSyllableReadMuteModeFromSnapshot(o.syllableReadMuteMode, o.syllableReadMuteLatched);
	const fs = o.frozenScale;
	if (fs === null || fs === undefined) d.frozenScale = null;
	else {
		const fn = parseInt(String(fs), 10);
		d.frozenScale = Number.isFinite(fn) && fn >= 1 && fn <= 100 ? fn : null;
	}
	if (typeof o.polyMode === 'boolean') d.polyMode = o.polyMode;
	d.polyVoices = parsePolyVoices(o.polyVoices);
	const tdkIn = o.taDingKeys;
	if (Array.isArray(tdkIn)) {
		const next = new Set<string>();
		const nBars = d.bars;
		for (const x of tdkIn) {
			if (typeof x !== 'string') continue;
			const parts = x.split('-');
			if (parts.length !== 2) continue;
			const r = parseInt(parts[0], 10);
			const c = parseInt(parts[1], 10);
			if (!Number.isFinite(r) || !Number.isFinite(c) || r < 0 || r >= nBars || c < 0) continue;
			const rowSyl = d.customSyllables[r] !== undefined ? d.customSyllables[r] : d.syllables;
			if (c >= rowSyl) continue;
			next.add(x);
		}
		d.taDingKeys = next;
	}
	return d;
}

function snapSlotLooksUsed(s: ReturnType<typeof createEmptySnapshot>) {
	if (s.tempo !== 100 || s.bars !== 4 || s.syllables !== 4) return true;
	if (s.accents.size > 0) return true;
	if (s.taDingKeys.size > 0) return true;
	if (Object.keys(s.customSyllables).length > 0) return true;
	if (Object.keys(s.customMultipliers).length > 0) return true;
	if (Object.keys(s.customSubdivisions).length > 0) return true;
	if (s.randomModeEnabled || s.randomPulsation || !s.randomPattern || s.randomSpeed || s.randomBarSpeed) return true;
	if (s.chaosLevel !== 0) return true;
	if (s.clickSound !== 'classic') return true;
	if (s.panelExpanded === true) return true;
	if (s.pulseMeterUnlinked && Object.values(s.pulseMeterUnlinked).some(Boolean)) return true;
	if (s.onlyAccents) return true;
	if (s.firstBeatAccent === false) return true;
	if (s.frozenScale != null) return true;
	if (s.polyMode) return true;
	if (s.polyVoices !== 2) return true;
	if (s.syllableReadMuteMode !== 'off') return true;
	if ((s as { accentMapVersion?: number }).accentMapVersion === 1) return true;
	if ((s as { dictantMode?: boolean }).dictantMode === true) return true;
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
		polyMode: s.polyMode === true,
		polyVoices: parsePolyVoices(s.polyVoices),
		onlyAccents: s.onlyAccents,
		firstBeatAccent: s.firstBeatAccent,
		accentMapVersion: (s as { accentMapVersion?: number }).accentMapVersion === 1 ? 1 : 0,
		taEditorMode: false,
		syllableReadMuteMode: s.syllableReadMuteMode,
		dictantMode: s.dictantMode === true,
		taDingKeys: [...s.taDingKeys],
	};
}

function encodeSnapshotClipboard(s: ReturnType<typeof createEmptySnapshot>): string {
	const accents = s.accents instanceof Set ? s.accents : new Set(Array.isArray(s.accents) ? s.accents : []);
	const cells = buildCellIndexMapForSnapshot(s.bars, s.syllables, s.customSyllables);
	const gridToken = packGridTokenPacked(s, cells, accents);
	const flags = buildSnapshotFlags(s);
	const soundId = buildSnapshotSoundId(s);
	const compact = `${s.tempo}.${s.bars}.${s.syllables}.${gridToken}.${s.chaosLevel}.${flags}.${soundId}`;
	return SNAPSHOT_CLIPBOARD_MARKER + compact;
}

function tryDecodeSnapshotClipboard(text: string): ReturnType<typeof createEmptySnapshot> | null {
	const t = text.trim();
	const markerMatch = t.match(SNAPSHOT_CLIPBOARD_MARKER_REGEX);
	const hasNewMarker = markerMatch !== null;
	const hasLegacyCompactMarker = t.startsWith(SNAPSHOT_CLIPBOARD_PREFIX_LEGACY_COMPACT);
	if (hasNewMarker || hasLegacyCompactMarker) {
		const markerLength = hasNewMarker
			? markerMatch![0].length
			: SNAPSHOT_CLIPBOARD_PREFIX_LEGACY_COMPACT.length;
		const body = t.slice(markerLength).replace(/\s+/g, '');
		if (!body) return null;
		const compactParts = body.split('.');
		if (compactParts.length === 11) {
			const [
				tempoRaw,
				barsRaw,
				syllablesRaw,
				rowSyllablesToken,
				accentToken,
				subdivisionsToken,
				multipliersToken,
				pulseUnlinkedToken,
				chaosRaw,
				flagsRaw,
				soundRaw,
			] = compactParts;
			const d = createEmptySnapshot();
			const tempo = parseInt(tempoRaw, 10);
			const bars = parseInt(barsRaw, 10);
			const syllables = parseInt(syllablesRaw, 10);
			const chaosLevel = parseInt(chaosRaw, 10);
			const flags = parseInt(flagsRaw, 10);
			const soundId = parseInt(soundRaw, 10);
			if (!Number.isFinite(tempo) || tempo < 20 || tempo > 400) return null;
			if (!Number.isFinite(bars) || bars < 1 || bars > 100) return null;
			if (!Number.isFinite(syllables) || syllables < 1 || syllables > 9) return null;
			if (!Number.isFinite(chaosLevel) || chaosLevel < 0 || chaosLevel > 100) return null;
			if (!Number.isFinite(flags) || flags < 0) return null;
			if (!Number.isFinite(soundId)) return null;
			d.tempo = tempo;
			d.bars = bars;
			d.syllables = syllables;
			d.customSyllables = decodeSparseRowNumberMap(rowSyllablesToken, (value) => value >= 1 && value <= 9);
			const cells = buildCellIndexMapForSnapshot(d.bars, d.syllables, d.customSyllables);
			d.accents = hydrateAccentsFromVariableGridToken(accentToken, cells);
			d.customSubdivisions = decodeSubdivisionsToken(subdivisionsToken, cells);
			d.customMultipliers = decodeSparseRowNumberMap(
				multipliersToken,
				(value) => value >= 1 && value <= 4 && value !== 1,
			);
			d.pulseMeterUnlinked = decodePulseUnlinkedRowsToken(pulseUnlinkedToken);
			d.chaosLevel = chaosLevel;
			applySnapshotFlags(flags, d);
			applySnapshotSoundId(soundId, d);
			return d;
		}
		if (compactParts.length === 7) {
			const [tempoRaw, barsRaw, syllablesRaw, gridTokenRaw, chaosRaw, flagsRaw, soundRaw] = compactParts;
			const d = createEmptySnapshot();
			const tempo = parseInt(tempoRaw, 10);
			const bars = parseInt(barsRaw, 10);
			const syllables = parseInt(syllablesRaw, 10);
			const chaosLevel = parseInt(chaosRaw, 10);
			const flags = parseInt(flagsRaw, 10);
			const soundId = parseInt(soundRaw, 10);
			if (!Number.isFinite(tempo) || tempo < 20 || tempo > 400) return null;
			if (!Number.isFinite(bars) || bars < 1 || bars > 100) return null;
			if (!Number.isFinite(syllables) || syllables < 1 || syllables > 9) return null;
			if (!Number.isFinite(chaosLevel) || chaosLevel < 0 || chaosLevel > 100) return null;
			if (!Number.isFinite(flags) || flags < 0) return null;
			if (!Number.isFinite(soundId)) return null;
			d.tempo = tempo;
			d.bars = bars;
			d.syllables = syllables;
			d.chaosLevel = chaosLevel;
			applySnapshotFlags(flags, d);
			applySnapshotSoundId(soundId, d);
			if (gridTokenRaw.startsWith('p1') || gridTokenRaw.startsWith('p2')) {
				if (!unpackGridTokenPacked(gridTokenRaw, d)) return null;
			} else if (gridTokenRaw.includes('|')) {
				const [accentToken, rowSyllablesToken, subdivisionsToken, multipliersToken, pulseUnlinkedToken] =
					gridTokenRaw.split('|');
				d.customSyllables = decodeSparseRowNumberMap(
					rowSyllablesToken || '0',
					(value) => value >= 1 && value <= 9,
				);
				const cells = buildCellIndexMapForSnapshot(d.bars, d.syllables, d.customSyllables);
				d.accents = hydrateAccentsFromVariableGridToken(accentToken || '0', cells);
				d.customSubdivisions = decodeSubdivisionsToken(subdivisionsToken || '0', cells);
				d.customMultipliers = decodeSparseRowNumberMap(
					multipliersToken || '0',
					(value) => value >= 1 && value <= 4 && value !== 1,
				);
				d.pulseMeterUnlinked = decodePulseUnlinkedRowsToken(pulseUnlinkedToken || '0');
			} else {
				hydrateSnapshotAccentsFromGridToken(gridTokenRaw, bars, syllables, d);
			}
			return d;
		}
		return null;
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
		if (!raw) {
			for (let i = 1; i <= SNAPSHOT_SLOT_COUNT; i++) snapshots[i].randomModeEnabled = false;
			return { activeSnapshot, snapshots };
		}
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
  soundType: 'classic' | 'oldschool' = 'classic',
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
    /** Только акценты: слой пассива + акцента, суммарный пик как у одиночного classic-акцента (~0.34). */
    const decay = 0.04;
    const oscLo = ctx.createOscillator();
    const oscHi = ctx.createOscillator();
    const gLo = ctx.createGain();
    const gHi = ctx.createGain();
    oscLo.type = 'sine';
    oscHi.type = 'sine';
    oscLo.frequency.setValueAtTime(800, time);
    oscHi.frequency.setValueAtTime(920, time);
    const peakLo = 0.11;
    const peakHi = 0.23;
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
  /** Classic (legacy maja, не konnakol_metronome): акцент 920 / пассив 800. */
  osc.frequency.setValueAtTime(isChecked ? 920 : 800, time);
  const peak = isChecked ? 0.34 : 0.28;
  const decay = 0.04;
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(peak, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.001, time + decay);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(time);
  osc.stop(time + decay + 0.01);
};

const playBarFirstHighClick = (ctx: AudioContext, time: number, soundType: 'classic' | 'oldschool' = 'classic') => {
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

type StructuralSliderProps = {
  label: string;
  min: number;
  max: number;
  value: number;
  colorClass: string;
  onCommit: (next: number) => void;
  onLiveChange?: (next: number) => void;
  onBeginDrag?: () => void;
};

function StructuralSlider({
  label,
  min,
  max,
  value,
  colorClass,
  onCommit,
  onLiveChange,
  onBeginDrag,
}: StructuralSliderProps) {
  const [localValue, setLocalValue] = useState(value);
  const committedValueRef = useRef(value);
  const lastLiveValueRef = useRef(value);
  const pointerActiveRef = useRef(false);

  useEffect(() => {
    setLocalValue(value);
    committedValueRef.current = value;
    lastLiveValueRef.current = value;
  }, [value]);

  const normalizeValue = useCallback(
    (raw: string) => {
      const parsed = parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return localValue;
      return Math.min(max, Math.max(min, parsed));
    },
    [localValue, max, min],
  );

  const commitLocalValue = useCallback(
    (next: number) => {
      if (committedValueRef.current === next) return;
      committedValueRef.current = next;
      onCommit(next);
    },
    [onCommit],
  );

  const applyLiveValue = useCallback(
    (next: number) => {
      setLocalValue(next);
      if (lastLiveValueRef.current !== next) {
        lastLiveValueRef.current = next;
        onLiveChange?.(next);
      }
    },
    [onLiveChange],
  );

  return (
    <input
      aria-label={label}
      type="range"
      min={String(min)}
      max={String(max)}
      value={localValue}
      onPointerDown={() => {
        pointerActiveRef.current = true;
        onBeginDrag?.();
      }}
      onPointerUp={() => {
        if (pointerActiveRef.current) pointerActiveRef.current = false;
        commitLocalValue(localValue);
      }}
      onPointerCancel={() => {
        if (pointerActiveRef.current) pointerActiveRef.current = false;
        commitLocalValue(localValue);
      }}
      onBlur={() => {
        commitLocalValue(localValue);
      }}
      onInput={(e) => {
        applyLiveValue(normalizeValue(e.currentTarget.value));
      }}
      onChange={(e) => {
        applyLiveValue(normalizeValue(e.currentTarget.value));
      }}
      className={`flex-1 h-3 bg-[#0b101e] rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 ${colorClass} [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:scale-110`}
    />
  );
}

export default function App() {
  const initialBoot = useMemo(() => loadSnapshotStorage(), []);
  const seed = initialBoot.snapshots[initialBoot.activeSnapshot];

  const [tempo, setTempo] = useState(seed.tempo);
  const [tempoUi, setTempoUi] = useState(seed.tempo);
  const [bars, setBars] = useState(seed.bars);
  const [syllables, setSyllables] = useState(seed.syllables);

  // Metronome state
  const [isPlaying, setIsPlaying] = useState(false);
  const [accents, setAccents] = useState<Set<string>>(() => new Set(seed.accents));
  const [taDingKeys, setTaDingKeys] = useState<Set<string>>(() => new Set(seed.taDingKeys));
  const [activePos, setActivePos] = useState({ r: -1, c: -1, absR: -1 });
  const [activePositions, setActivePositions] = useState<PlayheadPosition[]>([]);
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
  const [dictantMode, setDictantMode] = useState(() => (seed as { dictantMode?: boolean }).dictantMode === true);
  const [firstBeatAccent, setFirstBeatAccent] = useState(() => seed.firstBeatAccent !== false);
  const [accentMapVersion, setAccentMapVersion] = useState(() =>
    (seed as { accentMapVersion?: number }).accentMapVersion === 1 ? 1 : 0,
  );
  const [isTaEditorMode, setIsTaEditorMode] = useState(false);
  /** В режиме Ta-редактора: строки, где пользователь снял дефолтную белую метку на первой доле (без ключа taDing). */
  const [firstBeatDingSuppressedRows, setFirstBeatDingSuppressedRows] = useState<Set<number>>(() => new Set());

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
  const [lowPerfMode, setLowPerfMode] = useState(() => {
    try {
      return localStorage.getItem(LITE_UI_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [polyMode, setPolyMode] = useState(() => {
    try {
      return localStorage.getItem(POLY_MODE_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [polyVoices, setPolyVoices] = useState<2 | 3 | 4>(() => {
    try {
      return parsePolyVoices(localStorage.getItem(POLY_VOICES_STORAGE_KEY));
    } catch {
      return 2;
    }
  });
  const randomSettingsPanelRef = useRef<HTMLDivElement | null>(null);
  const settingsGearButtonRef = useRef<HTMLButtonElement | null>(null);
  const coldStartRef = useRef(true);

  // Click Sound
  const [clickSound, setClickSound] = useState<'classic' | 'oldschool'>(seed.clickSound);

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
        polyMode: s.polyMode === true,
        polyVoices: parsePolyVoices(s.polyVoices),
        onlyAccents: s.onlyAccents === true,
        firstBeatAccent: s.firstBeatAccent !== false,
        accentMapVersion: (s as { accentMapVersion?: number }).accentMapVersion === 1 ? 1 : 0,
        syllableReadMuteMode: normalizeSyllableReadMuteModeFromSnapshot(
          s.syllableReadMuteMode,
          (s as { syllableReadMuteLatched?: boolean }).syllableReadMuteLatched,
        ),
        taDingKeys: (() => {
          const raw = (s as { taDingKeys?: unknown }).taDingKeys;
          if (raw instanceof Set) return new Set(raw as Set<string>);
          if (Array.isArray(raw))
            return new Set(raw.filter((x): x is string => typeof x === 'string'));
          return new Set<string>();
        })(),
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
  const tempoThrottleTimerRef = useRef<number | null>(null);
  const pendingTempoRef = useRef<number | null>(null);
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

  /** Закрыть окно Randomizer / Settings по клику вне панели (и вне кнопки-шестерёнки). */
  useEffect(() => {
    if (!showRandomSettings) return;
    const onPointerDown = (e: PointerEvent) => {
      const node = e.target as Node | null;
      if (!node) return;
      if (randomSettingsPanelRef.current?.contains(node)) return;
      if (settingsGearButtonRef.current?.contains(node)) return;
      setShowRandomSettings(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [showRandomSettings]);

  useEffect(() => {
    try {
      localStorage.setItem(LITE_UI_STORAGE_KEY, lowPerfMode ? '1' : '0');
    } catch {
      /* ignore localStorage errors */
    }
  }, [lowPerfMode]);

  useEffect(() => {
    try {
      localStorage.setItem(POLY_MODE_STORAGE_KEY, polyMode ? '1' : '0');
    } catch {
      /* ignore localStorage errors */
    }
  }, [polyMode]);

  useEffect(() => {
    try {
      localStorage.setItem(POLY_VOICES_STORAGE_KEY, String(polyVoices));
    } catch {
      /* ignore localStorage errors */
    }
  }, [polyVoices]);

  const potatoAutoFreezeArmedRef = useRef(true);
  const prevLowPerfModeRef = useRef(lowPerfMode);
  const normalizeBarsForMode = useCallback((raw: number) => {
    const rounded = Math.round(raw);
    const clamped = Math.max(1, Math.min(100, rounded));
    if (!polyModeRef.current) return clamped;
    const voices = polyVoicesRef.current;
    const minBars = voices;
    const constrained = Math.max(minBars, clamped);
    const down = Math.floor(constrained / voices) * voices;
    const up = Math.ceil(constrained / voices) * voices;
    let snapped = down;
    if (down < minBars) snapped = up;
    else if (up <= 100 && Math.abs(up - constrained) < Math.abs(constrained - down)) snapped = up;
    if (snapped > 100) {
      snapped = 100 - (100 % voices);
      if (snapped < minBars) snapped = minBars;
    }
    return snapped;
  }, []);
  useEffect(() => {
    const prev = prevLowPerfModeRef.current;
    prevLowPerfModeRef.current = lowPerfMode;
    if (prev === lowPerfMode) return;
    potatoAutoFreezeArmedRef.current = true;
    if (!lowPerfMode) return;
    if (bars >= 6) setFrozenScale(bars);
    else setFrozenScale(null);
  }, [lowPerfMode, bars]);

  const applyBarsWithPotatoFreeze = useCallback(
    (next: number) => {
      const normalizedNext = normalizeBarsForMode(next);
      const prevBars = barsRef.current;
      setBars(normalizedNext);
      barsRef.current = normalizedNext;
      if (!lowPerfMode) return;
      if (normalizedNext <= 5) {
        potatoAutoFreezeArmedRef.current = true;
        setFrozenScale(null);
        return;
      }
      const crossedUpFromLow = prevBars <= 5 && normalizedNext >= 6;
      if (potatoAutoFreezeArmedRef.current && crossedUpFromLow) {
        setFrozenScale(normalizedNext);
      }
    },
    [lowPerfMode, normalizeBarsForMode],
  );

  /** Long-press по клетке такта (поддоли). */
  const holdTimerRef = useRef<number | null>(null);
  /** Long-press по числу слогов в такте: gati / пульс от четвёрки (не смешивать с holdTimerRef клеток). */
  const pulseUnlinkHoldTimerRef = useRef<number | null>(null);
  const isHoldingRef = useRef(false);
  /** Long-press square: toggle «без щелчков по клеткам»; ding такта Ta не мьютится. */
  const squareHoldTimerRef = useRef<number | null>(null);
  const squareHoldAteClickRef = useRef(false);
  const randomDiceHoldTimerRef = useRef<number | null>(null);
  const randomDiceHoldAteClickRef = useRef(false);
  const taHoldTimerRef = useRef<number | null>(null);
  const taHoldAteClickRef = useRef(false);
  const [randomDiceMintFlash, setRandomDiceMintFlash] = useState(false);
  const randomDiceMintFlashClearRef = useRef<number | null>(null);
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
    const emptyTaDing = new Set<string>();
    setTaDingKeys(emptyTaDing);
    taDingKeysRef.current = emptyTaDing;
    setAccentMapVersion(0);
    setDictantMode(false);
    setIsTaEditorMode(false);
    setFirstBeatDingSuppressedRows(new Set());
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
  const polyClickSlotsRef = useRef<Set<number>>(new Set());
  const sequencerGridRowActionsRef = useRef<SequencerGridRowActions | null>(null);
  const nextNoteTimeRef = useRef(0);
  const currentStepRef = useRef(0);
  const isPlayingRef = useRef(false);
  const polyModeRef = useRef(polyMode);
  const polyVoicesRef = useRef<2 | 3 | 4>(polyVoices);

  const barsRef = useRef(bars);
  const syllablesRef = useRef(syllables);
  const tempoRef = useRef(tempo);
  const accentsRef = useRef<Set<string>>(accents);
  const taDingKeysRef = useRef<Set<string>>(taDingKeys);
  const customSyllablesRef = useRef(customSyllables);
  const customMultipliersRef = useRef(customMultipliers);
  const customSubdivisionsRef = useRef(customSubdivisions);
  const pulseMeterUnlinkedRef = useRef(pulseMeterUnlinked);
  const onlyAccentsRef = useRef(onlyAccents);
  const dictantModeRef = useRef(dictantMode);
  const firstBeatAccentRef = useRef(firstBeatAccent);
  const accentMapVersionRef = useRef(accentMapVersion);
  const isTaEditorModeRef = useRef(isTaEditorMode);
  const firstBeatDingSuppressedRowsRef = useRef(firstBeatDingSuppressedRows);
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
  useEffect(() => { setTempoUi(tempo); }, [tempo]);
  useEffect(() => { accentsRef.current = new Set(accents); }, [accents]);
  useEffect(() => { customMultipliersRef.current = { ...customMultipliers }; }, [customMultipliers]);
  useEffect(() => { customSubdivisionsRef.current = { ...customSubdivisions }; }, [customSubdivisions]);
  useEffect(() => {
    pulseMeterUnlinkedRef.current = { ...pulseMeterUnlinked };
  }, [pulseMeterUnlinked]);
  useEffect(() => { customSyllablesRef.current = { ...customSyllables }; }, [customSyllables]);
  useEffect(() => { onlyAccentsRef.current = onlyAccents; }, [onlyAccents]);
  useEffect(() => { firstBeatAccentRef.current = firstBeatAccent; }, [firstBeatAccent]);
  useEffect(() => {
    setFirstBeatDingSuppressedRows((prev) => {
      const next = new Set<number>();
      for (const r of prev) {
        if (r >= 0 && r < bars) next.add(r);
      }
      if (next.size === prev.size) {
        for (const r of prev) {
          if (!next.has(r)) return next;
        }
        return prev;
      }
      return next;
    });
  }, [bars]);
  useEffect(() => { randomModeEnabledRef.current = randomModeEnabled; }, [randomModeEnabled]);
  useEffect(() => { randomPulsationRef.current = randomPulsation; }, [randomPulsation]);
  useEffect(() => { randomPatternRef.current = randomPattern; }, [randomPattern]);
  useEffect(() => { randomSpeedRef.current = randomSpeed; }, [randomSpeed]);
  useEffect(() => { randomBarSpeedRef.current = randomBarSpeed; }, [randomBarSpeed]);
  useEffect(() => { chaosLevelRef.current = chaosLevel; }, [chaosLevel]);
  useEffect(() => { clickSoundRef.current = clickSound; }, [clickSound]);
  useEffect(() => { frozenScaleRef.current = frozenScale; }, [frozenScale]);
  useEffect(() => { polyModeRef.current = polyMode; }, [polyMode]);
  useEffect(() => { polyVoicesRef.current = polyVoices; }, [polyVoices]);
  useEffect(() => {
    if (!polyMode) return;
    const normalized = normalizeBarsForMode(barsRef.current);
    if (normalized !== barsRef.current) {
      applyBarsWithPotatoFreeze(normalized);
    }
  }, [polyMode, polyVoices, normalizeBarsForMode, applyBarsWithPotatoFreeze]);

  const clampTempo = useCallback((n: number) => Math.min(400, Math.max(20, Math.round(n))), []);

  const applyTempoImmediate = useCallback(
    (raw: number) => {
      const next = clampTempo(raw);
      setTempoUi(next);
      pendingTempoRef.current = null;
      if (tempoThrottleTimerRef.current !== null) {
        window.clearTimeout(tempoThrottleTimerRef.current);
        tempoThrottleTimerRef.current = null;
      }
      setTempo(next);
      tempoRef.current = next;
    },
    [clampTempo],
  );

  const scheduleTempoCommit = useCallback(
    (raw: number) => {
      const next = clampTempo(raw);
      setTempoUi(next);
      pendingTempoRef.current = next;
      if (tempoThrottleTimerRef.current !== null) return;
      tempoThrottleTimerRef.current = window.setTimeout(() => {
        tempoThrottleTimerRef.current = null;
        const pending = pendingTempoRef.current;
        pendingTempoRef.current = null;
        if (pending === null) return;
        setTempo(pending);
        tempoRef.current = pending;
      }, TEMPO_THROTTLE_MS);
    },
    [clampTempo],
  );

  const flushTempoCommit = useCallback(() => {
    const pending = pendingTempoRef.current;
    pendingTempoRef.current = null;
    if (tempoThrottleTimerRef.current !== null) {
      window.clearTimeout(tempoThrottleTimerRef.current);
      tempoThrottleTimerRef.current = null;
    }
    if (pending === null) return;
    setTempo(pending);
    tempoRef.current = pending;
  }, []);

  const buildLiveSnapshotFromRefs = (): ReturnType<typeof createEmptySnapshot> => ({
    tempo: tempoRef.current,
    bars: barsRef.current,
    syllables: syllablesRef.current,
    accents: new Set(accentsRef.current),
    taDingKeys: new Set(taDingKeysRef.current),
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
    polyMode: polyModeRef.current,
    polyVoices: polyVoicesRef.current,
    onlyAccents: onlyAccentsRef.current,
    firstBeatAccent: firstBeatAccentRef.current,
    accentMapVersion: accentMapVersionRef.current,
    syllableReadMuteMode: syllableReadMuteModeRef.current,
    dictantMode: dictantModeRef.current,
  });

  const prefillAllTactsRandomizer = useCallback(() => {
    const chaos = chaosLevelRef.current;
    const nBars = barsRef.current;
    const syllablesDefault = syllablesRef.current;
    const rp = randomPulsationRef.current;
    const rpat = randomPatternRef.current;
    const rs = randomSpeedRef.current;
    const rbs = randomBarSpeedRef.current;
    const oa = onlyAccentsRef.current;
    const hasAny = rp || rpat || rs || rbs;

    if (randomDiceMintFlashClearRef.current !== null) {
      window.clearTimeout(randomDiceMintFlashClearRef.current);
      randomDiceMintFlashClearRef.current = null;
    }
    setRandomDiceMintFlash(true);
    randomDiceMintFlashClearRef.current = window.setTimeout(() => {
      randomDiceMintFlashClearRef.current = null;
      setRandomDiceMintFlash(false);
    }, 320);

    if (!hasAny) return;

    const cs = { ...customSyllablesRef.current };
    const cd = { ...customSubdivisionsRef.current };
    const cm = { ...customMultipliersRef.current };
    const acc = new Set<string>(accentsRef.current);

    let any = false;
    for (let r = 0; r < nBars; r++) {
      if (
        applyRandomizerEffectsToBar(r, chaos, rp, rpat, rs, rbs, oa, syllablesDefault, {
          customSyllables: cs,
          accents: acc,
          customSubdivisions: cd,
          customMultipliers: cm,
        })
      ) {
        any = true;
      }
    }
    if (!any) return;

    customSyllablesRef.current = cs;
    customSubdivisionsRef.current = cd;
    customMultipliersRef.current = cm;
    accentsRef.current = acc;

    startTransition(() => {
      setCustomSyllables({ ...cs });
      setAccents(new Set(acc));
      setCustomSubdivisions({ ...cd });
      setCustomMultipliers({ ...cm });
    });
  }, []);

  const stableWindowPointerEnd = useCallback(() => {
    onWindowPointerEndCaptureRef.current();
  }, []);

  const attachSliderWindowListeners = useCallback(() => {
    if (sliderWindowListenersAttachedRef.current) return;
    sliderWindowListenersAttachedRef.current = true;
    window.addEventListener('pointerup', stableWindowPointerEnd, true);
    window.addEventListener('pointercancel', stableWindowPointerEnd, true);
  }, [stableWindowPointerEnd]);

  /** Глобальный Syllbs: общее число слогов + перестройка sequenceRef; акценты / поддоли / множители ряда сохраняются для оставшихся ячеек. */
  const applyGlobalSyllablesFromSlider = useCallback((raw: string) => {
    const next = parseInt(raw, 10);
    if (!Number.isFinite(next) || next < 1 || next > 9) {
      return;
    }

    const nBars = barsRef.current;

    setSyllables(next);
    syllablesRef.current = next;

    setCustomSyllables({});
    customSyllablesRef.current = {};

    const prunedAccents = new Set<string>();
    for (const k of accentsRef.current) {
      const parts = k.split('-');
      if (parts.length !== 2) continue;
      const r = parseInt(parts[0], 10);
      const c = parseInt(parts[1], 10);
      if (Number.isFinite(r) && Number.isFinite(c) && r >= 0 && r < nBars && c >= 0 && c < next) {
        prunedAccents.add(k);
      }
    }
    setAccents(prunedAccents);
    accentsRef.current = prunedAccents;

    const prunedTaDing = new Set<string>();
    for (const k of taDingKeysRef.current) {
      const parts = k.split('-');
      if (parts.length !== 2) continue;
      const r = parseInt(parts[0], 10);
      const c = parseInt(parts[1], 10);
      if (Number.isFinite(r) && Number.isFinite(c) && r >= 0 && r < nBars && c >= 0 && c < next) {
        prunedTaDing.add(k);
      }
    }
    setTaDingKeys(prunedTaDing);
    taDingKeysRef.current = prunedTaDing;

    const prevSub = customSubdivisionsRef.current;
    const nextSub: Record<string, number> = {};
    for (const [k, v] of Object.entries(prevSub)) {
      const parts = k.split('-');
      if (parts.length !== 2) continue;
      const r = parseInt(parts[0], 10);
      const c = parseInt(parts[1], 10);
      if (Number.isFinite(r) && Number.isFinite(c) && r >= 0 && r < nBars && c >= 0 && c < next) {
        const vn = typeof v === 'number' ? v : Number(v);
        if (Number.isFinite(vn)) nextSub[k] = vn;
      }
    }
    setCustomSubdivisions(nextSub);
    customSubdivisionsRef.current = { ...nextSub };

    const nextMult = { ...customMultipliersRef.current };
    for (const rk of Object.keys(nextMult)) {
      const r = Number(rk);
      if (!Number.isFinite(r) || r < 0 || r >= nBars) {
        delete nextMult[r];
      }
    }
    setCustomMultipliers(nextMult);
    customMultipliersRef.current = { ...nextMult };

    setActiveEditCell((prev) => {
      if (prev === null) return null;
      const parts = prev.split('-');
      if (parts.length !== 2) return null;
      const r = parseInt(parts[0], 10);
      const c = parseInt(parts[1], 10);
      if (!Number.isFinite(r) || !Number.isFinite(c) || r < 0 || r >= nBars || c < 0 || c >= next) {
        return null;
      }
      return prev;
    });

    const newSeq: { r: number; c: number; activeSyllables: number }[] = [];
    for (let r = 0; r < barsRef.current; r++) {
      for (let c = 0; c < next; c++) {
        newSeq.push({ r, c, activeSyllables: next });
      }
    }

    if (sequenceRef.current.length > 0 && newSeq.length > 0) {
      const oldItem = sequenceRef.current[currentStepRef.current];
      if (oldItem) {
        const targetC = Math.min(oldItem.c, next - 1);
        const newIdx = newSeq.findIndex((item) => item.r === oldItem.r && item.c === targetC);
        currentStepRef.current = newIdx !== -1 ? newIdx : 0;
      } else {
        currentStepRef.current = 0;
      }
    }

    sequenceRef.current = newSeq;
  }, []);

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
    const tdk = raw.taDingKeys;
    const taDingKeysArr =
      tdk instanceof Set
        ? [...tdk]
        : Array.isArray(tdk)
          ? tdk.filter((x): x is string => typeof x === 'string')
          : [];
    return parseSnapshotRow({
      tempo: raw.tempo,
      bars: raw.bars,
      syllables: raw.syllables,
      accents: accentsArr,
      taDingKeys: taDingKeysArr,
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
      polyMode: raw.polyMode,
      polyVoices: raw.polyVoices,
      onlyAccents: raw.onlyAccents,
      firstBeatAccent: raw.firstBeatAccent,
      accentMapVersion: (raw as { accentMapVersion?: number }).accentMapVersion,
      syllableReadMuteMode: raw.syllableReadMuteMode,
      syllableReadMuteLatched: raw.syllableReadMuteLatched,
      dictantMode: (raw as { dictantMode?: boolean }).dictantMode,
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

  /** Сколько тактов по высоте «влезает» при текущей шкале (freeze фиксирует делитель отдельно от `bars`). */
  const displayScaleBars = frozenScale !== null ? Math.min(frozenScale, 10) : Math.min(bars, 10);
  /** Все такты влезают в окно — без виртуальной ленты и без автопрокрутки (в т.ч. при включённом freeze). */
  const allBarsFitViewport = bars <= displayScaleBars;
  const disableMenuSmoothing = lowPerfMode || bars > 8 || syllables >= 9;

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
  const polyChunks = useMemo(() => buildPolyChunks(bars, polyVoices), [bars, polyVoices]);
  const polyChunksRef = useRef(polyChunks);
  polyChunksRef.current = polyChunks;

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
          taDingKeys,
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
          polyMode,
          polyVoices,
          onlyAccents,
          firstBeatAccent,
          accentMapVersion,
          syllableReadMuteMode,
          dictantMode,
        },
      }));
    });
  }, [
    tempo,
    bars,
    syllables,
    accents,
    taDingKeys,
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
    polyMode,
    polyVoices,
    onlyAccents,
    firstBeatAccent,
    accentMapVersion,
    syllableReadMuteMode,
    dictantMode,
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
    setTaDingKeys(
      new Set(
        Array.isArray(snap.taDingKeys)
          ? snap.taDingKeys
          : snap.taDingKeys instanceof Set
            ? [...snap.taDingKeys]
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
    setClickSound(snap.clickSound === 'oldschool' ? 'oldschool' : 'classic');
    setPulseMeterUnlinked(normalizePulseMeterUnlinked(snap.pulseMeterUnlinked));
    setOnlyAccents(snap.onlyAccents === true);
    setFirstBeatAccent(snap.firstBeatAccent !== false);
    setAccentMapVersion((snap as { accentMapVersion?: number }).accentMapVersion === 1 ? 1 : 0);
    setDictantMode((snap as { dictantMode?: boolean }).dictantMode === true);
    setIsTaEditorMode(false);
    setFirstBeatDingSuppressedRows(new Set());
    const nextMute = normalizeSyllableReadMuteModeFromSnapshot(
      snap.syllableReadMuteMode,
      (snap as { syllableReadMuteLatched?: boolean }).syllableReadMuteLatched,
    );
    setSyllableReadMuteMode(nextMute);
    syllableReadMuteModeRef.current = nextMute;
    setFrozenScale(
      typeof snap.frozenScale === 'number' && snap.frozenScale >= 1 ? snap.frozenScale : null,
    );
    setPolyMode(snap.polyMode === true);
    setPolyVoices(parsePolyVoices(snap.polyVoices));
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
    taDingKeys:
      s.taDingKeys instanceof Set ? new Set(s.taDingKeys) : new Set(Array.isArray(s.taDingKeys) ? s.taDingKeys : []),
    customSyllables: { ...s.customSyllables },
    customMultipliers: { ...s.customMultipliers },
    customSubdivisions: { ...s.customSubdivisions },
    panelExpanded: s.panelExpanded === true,
    pulseMeterUnlinked: { ...(s.pulseMeterUnlinked || {}) },
    frozenScale: typeof s.frozenScale === 'number' && s.frozenScale >= 1 ? s.frozenScale : null,
    polyMode: s.polyMode === true,
    polyVoices: parsePolyVoices(s.polyVoices),
    onlyAccents: s.onlyAccents === true,
    firstBeatAccent: s.firstBeatAccent !== false,
    accentMapVersion: (s as { accentMapVersion?: number }).accentMapVersion === 1 ? 1 : 0,
    syllableReadMuteMode: normalizeSyllableReadMuteModeFromSnapshot(s.syllableReadMuteMode, undefined),
    dictantMode: (s as { dictantMode?: boolean }).dictantMode === true,
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
      showClipboardToast('No snapshot marker found in clipboard');
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
    if (polyMode) {
      if (currentStepRef.current >= polyChunks.length) {
        currentStepRef.current = 0;
      }
      return;
    }
    if (currentStepRef.current >= sequence.length) {
      currentStepRef.current = 0;
    }
  }, [polyMode, polyChunks.length, sequence.length]);

  // Display metrics (displayScaleBars / allBarsFitViewport объявлены выше — общая шкала для сетки и скролла)
  const useFixedFlex = frozenScale !== null || bars > 10;
  
  // Create a scroll stride that overlaps by 1 row
  const scrollStride = Math.max(1, displayScaleBars - 1);

  const setRowElStable = useCallback((absR: number, el: HTMLDivElement | null) => {
    rowRefs.current[absR] = el;
  }, []);
  const primaryActivePos = useMemo(() => {
    if (!polyMode || activePositions.length === 0) return activePos;
    const master = activePositions.find((pos) => pos.voice === 0) ?? activePositions[0];
    return { r: master.r, c: master.c, absR: master.absR };
  }, [activePos, activePositions, polyMode]);

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
      if (primaryActivePos.absR >= 0) {
        const rowSylls =
          customSyllables[primaryActivePos.r] !== undefined ? customSyllables[primaryActivePos.r] : syllables;
        if (rowSylls >= 1 && primaryActivePos.c === rowSylls - 1) {
          tid = window.setTimeout(() => {
            tid = null;
            const nextAbs = primaryActivePos.absR + 1;
            const rowEl = rowRefs.current[nextAbs];
            if (rowEl) {
              rowEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }, 10);
        }
      }
      return cleanup;
    }

    if (bars <= displayScaleBars) {
      return cleanup;
    }

    if (primaryActivePos.absR >= 0 && gridRef.current) {
      let logicalPage = Math.floor(primaryActivePos.absR / scrollStride);
      
      if (primaryActivePos.absR > 0 && primaryActivePos.absR % scrollStride === 0) {
        const rIdx = primaryActivePos.absR % bars;
        const rowSylls = customSyllables[rIdx] !== undefined ? customSyllables[rIdx] : syllables;
        const isPastHalfway = primaryActivePos.c >= Math.floor(rowSylls / 2);
        
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
    primaryActivePos.absR,
    primaryActivePos.c,
    primaryActivePos.r,
    isPlaying,
    scrollStride,
    customSyllables,
    syllables,
    bars,
    displayScaleBars,
  ]);

  useEffect(() => {
    return () => {
      if (tempoThrottleTimerRef.current !== null) {
        window.clearTimeout(tempoThrottleTimerRef.current);
        tempoThrottleTimerRef.current = null;
      }
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
      if (randomDiceHoldTimerRef.current !== null) {
        window.clearTimeout(randomDiceHoldTimerRef.current);
        randomDiceHoldTimerRef.current = null;
      }
      if (taHoldTimerRef.current !== null) {
        window.clearTimeout(taHoldTimerRef.current);
        taHoldTimerRef.current = null;
      }
      if (randomDiceMintFlashClearRef.current !== null) {
        window.clearTimeout(randomDiceMintFlashClearRef.current);
        randomDiceMintFlashClearRef.current = null;
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
    let lastPos: PlayheadPosition | null = null;
    const polyLatestByVoice = new Map<number, PlayheadPosition>();
    while (q.length > 0 && q[0].t <= ctx.currentTime) {
      const due = q.shift()!.pos;
      if (polyModeRef.current) {
        polyLatestByVoice.set(due.voice, due);
      }
      lastPos = due;
    }
    if (polyModeRef.current) {
      const nextActive = Array.from(polyLatestByVoice.values()).sort((a, b) => a.voice - b.voice);
      if (nextActive.length > 0) {
        setActivePositions(nextActive);
        const primary = nextActive.find((pos) => pos.voice === 0) ?? nextActive[0];
        setActivePos({ r: primary.r, c: primary.c, absR: primary.absR });
      }
    } else if (lastPos !== null) {
      setActivePos({ r: lastPos.r, c: lastPos.c, absR: lastPos.absR });
      setActivePositions([]);
    }
    if (q.length === 0) return;
    const delayMs = Math.max(0, (q[0].t - ctx.currentTime) * 1000);
    playheadTimerRef.current = window.setTimeout(() => {
      playheadTimerRef.current = null;
      schedulePlayheadWake();
    }, delayMs);
  }

  const toggleAccent = useCallback((r: number, c: number) => {
    if (c === 0) setAccentMapVersion(1);
    const key = `${r}-${c}`;
    setAccents((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const toggleTaDing = useCallback((r: number, c: number) => {
    if (c < 0) return;
    const key = `${r}-${c}`;
    if (!isTaEditorModeRef.current || c !== 0) {
      setTaDingKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      return;
    }
    const hadKey = taDingKeysRef.current.has(key);
    const suppressed = firstBeatDingSuppressedRowsRef.current.has(r);
    const fa = firstBeatAccentRef.current;
    if (hadKey) {
      setTaDingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      /* Иначе при снятии явного taDing на первой доле снова показывается дефолтный белый от `firstBeatAccent`. */
      if (fa) {
        setFirstBeatDingSuppressedRows((prev) => new Set(prev).add(r));
      }
      return;
    }
    if (fa && !suppressed) {
      setFirstBeatDingSuppressedRows((prev) => new Set(prev).add(r));
      return;
    }
    if (suppressed) {
      setFirstBeatDingSuppressedRows((prev) => {
        const n = new Set(prev);
        n.delete(r);
        return n;
      });
    }
    setTaDingKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
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

          const chaos = chaosLevelRef.current;
          const m = {
            customSyllables: customSyllablesRef.current,
            accents: accentsRef.current,
            customSubdivisions: customSubdivisionsRef.current,
            customMultipliers: customMultipliersRef.current,
          };
          const didChange = applyRandomizerEffectsToBar(
            prevBar,
            chaos,
            randomPulsationRef.current,
            randomPatternRef.current,
            randomSpeedRef.current,
            randomBarSpeedRef.current,
            onlyAccentsRef.current,
            syllablesRef.current,
            m,
          );

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
              const dsb =
                frozenScaleRef.current !== null
                  ? Math.min(frozenScaleRef.current, 10)
                  : Math.min(barsRef.current, 10);
              const compact = barsRef.current <= dsb;
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

  const getLegacyNoteDurationSeconds = useCallback((rowIdx: number) => {
    const rowSyllables = customSyllablesRef.current[rowIdx] !== undefined ? customSyllablesRef.current[rowIdx] : syllablesRef.current;
    const pulseSyllables = pulseMeterUnlinkedRef.current[rowIdx] ? PULSE_METER_BASE_SYLLABLES : rowSyllables;
    const mult = customMultipliersRef.current[rowIdx] || 1;
    const effectiveBpm = tempoRef.current * (pulseSyllables / 4) * mult;
    if (effectiveBpm <= 0) return 0.5;
    return 60.0 / effectiveBpm;
  }, []);

  const getBarTimeWindowSeconds = useCallback((rowIdx: number) => {
    const noteDuration = getLegacyNoteDurationSeconds(rowIdx);
    const rowSyllables =
      customSyllablesRef.current[rowIdx] !== undefined ? customSyllablesRef.current[rowIdx] : syllablesRef.current;
    return noteDuration * Math.max(1, rowSyllables);
  }, [getLegacyNoteDurationSeconds]);

  const scheduleGridCellAtTime = useCallback(
    (rIdx: number, cIdx: number, absR: number, time: number, voice: number, step: number, noteDuration: number) => {
      if (!audioCtxRef.current) return;
      const isAccent = accentsRef.current.has(`${rIdx}-${cIdx}`);
      const subdivs = customSubdivisionsRef.current[`${rIdx}-${cIdx}`] || 1;
      const subDuration = Math.max(0.001, noteDuration / Math.max(1, subdivs));
      const muteMode = syllableReadMuteModeRef.current;
      const on0Accent = accentsRef.current.has(`${rIdx}-0`);
      const on0Ding = taDingKeysRef.current.has(`${rIdx}-0`);
      const supRow = firstBeatDingSuppressedRowsRef.current.has(rIdx);
      const fa = firstBeatAccentRef.current;
      const firstBeatCellHitRow = on0Accent || on0Ding || (fa && !supRow);
      for (let sub = 0; sub < subdivs; sub++) {
        const subTime = time + sub * subDuration;
        const polySlotKey = Math.round(subTime * 100000);
        const shouldDedupPolyClick = polyModeRef.current && polyClickSlotsRef.current.has(polySlotKey);
        const isFirstOfBar = cIdx === 0 && sub === 0;
        const shouldPlayFirstBeatTa =
          isFirstOfBar &&
          firstBeatAccentRef.current &&
          firstBeatCellHitRow &&
          (!polyModeRef.current || voice === 0);
        if (shouldPlayFirstBeatTa) {
          playBarFirstHighClick(audioCtxRef.current, subTime, clickSoundRef.current);
        }
        const mainAccentClick = isAccent && sub === 0;
        if (shouldDedupPolyClick) {
          continue;
        }
        if (muteMode === 'full') continue;
        const isTaDingCell = cIdx >= 1 && taDingKeysRef.current.has(`${rIdx}-${cIdx}`);
        const shouldPlayTaDingSound =
          sub === 0 && isTaDingCell && (!polyModeRef.current || voice === 0);
        if (shouldPlayTaDingSound) {
          playBarFirstHighClick(audioCtxRef.current, subTime, clickSoundRef.current);
        }
        const hasTaDingHere = taDingKeysRef.current.has(`${rIdx}-${cIdx}`);
        const accentLikePlayback =
          !onlyAccentsRef.current && !dictantModeRef.current;
        const shouldPlayBeat = accentLikePlayback || isAccent || hasTaDingHere;
        if (!shouldPlayBeat) continue;
        const isTaFirstBeatArticulation =
          cIdx === 0 && sub === 0 && firstBeatAccentRef.current && firstBeatCellHitRow;
        const sharpAsChecked =
          muteMode === 'no_accent_sharp' && mainAccentClick && !isTaFirstBeatArticulation
            ? false
            : mainAccentClick;
        playSharpClick(
          audioCtxRef.current,
          subTime,
          sharpAsChecked,
          clickSoundRef.current,
          onlyAccentsRef.current || dictantModeRef.current,
        );
        if (polyModeRef.current) {
          polyClickSlotsRef.current.add(polySlotKey);
        }
      }
      if (!dictantModeRef.current || cIdx === 0) {
        insertPlayheadSorted(playheadQueueRef.current, {
          t: time,
          pos: { r: rIdx, c: cIdx, absR, voice, step },
        });
        schedulePlayheadWake();
      }
    },
    [],
  );

  const scheduleNote = (stepIdx: number, absR: number, time: number) => {
    const seq = sequenceRef.current;
    const currentSeqItem = seq[stepIdx];
    if (!currentSeqItem) return;

    const { r: rIdx, c: cIdx } = currentSeqItem;
    const noteDuration = getLegacyNoteDurationSeconds(rIdx);
    scheduleGridCellAtTime(rIdx, cIdx, absR, time, 0, stepIdx, noteDuration);
  };

  const schedulePolyStep = useCallback((stepIdx: number, time: number) => {
    const chunks = polyChunksRef.current;
    if (chunks.length === 0) return 0.5;
    polyClickSlotsRef.current.clear();
    const safeStep = ((stepIdx % chunks.length) + chunks.length) % chunks.length;
    const chunk = chunks[safeStep];
    if (!chunk || chunk.length === 0) return 0.5;
    const masterBar = chunk[0]!;
    const windowDuration = getBarTimeWindowSeconds(masterBar);
    chunk.forEach((barIdx, voiceIdx) => {
      const rowSyllables =
        customSyllablesRef.current[barIdx] !== undefined ? customSyllablesRef.current[barIdx] : syllablesRef.current;
      const noteDuration = windowDuration / Math.max(1, rowSyllables);
      for (let cIdx = 0; cIdx < rowSyllables; cIdx++) {
        const noteTime = time + cIdx * noteDuration;
        const absR = safeStep * polyVoicesRef.current + voiceIdx;
        scheduleGridCellAtTime(barIdx, cIdx, absR, noteTime, voiceIdx, safeStep, noteDuration);
      }
    });
    return windowDuration;
  }, [getBarTimeWindowSeconds, scheduleGridCellAtTime]);

  const scheduler = () => {
    if (!isPlayingRef.current || !audioCtxRef.current) return;
    if (audioCtxRef.current.currentTime > nextNoteTimeRef.current + 0.5) {
      nextNoteTimeRef.current = audioCtxRef.current.currentTime + 0.05;
    }
    while (nextNoteTimeRef.current < audioCtxRef.current.currentTime + 0.1) {
      if (polyModeRef.current) {
        const stepDuration = schedulePolyStep(currentStepRef.current, nextNoteTimeRef.current);
        nextNoteTimeRef.current += stepDuration;
        const chunkCount = Math.max(1, polyChunksRef.current.length);
        currentStepRef.current = (currentStepRef.current + 1) % chunkCount;
      } else {
        scheduleNote(currentStepRef.current, playAbsBarRef.current, nextNoteTimeRef.current);
        nextNote();
      }
    }
    timerIDRef.current = window.setTimeout(scheduler, 25);
  };

  const togglePlayback = () => {
    if (isPlaying) {
      setIsPlaying(false);
      isPlayingRef.current = false;
      clearPlayheadScheduling();
      setActivePos({ r: -1, c: -1, absR: -1 });
      setActivePositions([]);
      polyClickSlotsRef.current.clear();
      currentStepRef.current = 0; // Reset pattern position to start
      if (timerIDRef.current) clearTimeout(timerIDRef.current);
      if (squareHoldTimerRef.current !== null) {
        window.clearTimeout(squareHoldTimerRef.current);
        squareHoldTimerRef.current = null;
      }
      if (randomDiceHoldTimerRef.current !== null) {
        window.clearTimeout(randomDiceHoldTimerRef.current);
        randomDiceHoldTimerRef.current = null;
      }
      if (taHoldTimerRef.current !== null) {
        window.clearTimeout(taHoldTimerRef.current);
        taHoldTimerRef.current = null;
      }
      if (randomDiceMintFlashClearRef.current !== null) {
        window.clearTimeout(randomDiceMintFlashClearRef.current);
        randomDiceMintFlashClearRef.current = null;
      }
      syllableReadMuteModeRef.current = 'off';
      setSyllableReadMuteMode('off');
      squareHoldAteClickRef.current = false;
      randomDiceHoldAteClickRef.current = false;
      taHoldAteClickRef.current = false;
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    } else {
      if (isTaEditorModeRef.current) return;
      setIsPanelExpanded(false);
      setShowRandomSettings(false);
      setIsPlaying(true);
      isPlayingRef.current = true;
      clearPlayheadScheduling();
      setActivePositions([]);
      coldStartRef.current = true; // Mark cold start
      if (polyModeRef.current) {
        const startChunk = polyChunksRef.current[currentStepRef.current];
        playAbsBarRef.current = startChunk?.[0] ?? 0;
      } else {
        const startSeqItem = sequenceRef.current[currentStepRef.current];
        playAbsBarRef.current = startSeqItem ? startSeqItem.r : 0;
      }
      
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContextClass();
      }
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }
      // Guarantee loop limits if grid resized
      if (polyModeRef.current) {
        if (currentStepRef.current >= polyChunksRef.current.length) {
          currentStepRef.current = 0;
        }
      } else if (currentStepRef.current >= sequenceRef.current.length) {
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
  taDingKeysRef.current = taDingKeys;
  customSyllablesRef.current = { ...customSyllables };
  customMultipliersRef.current = { ...customMultipliers };
  customSubdivisionsRef.current = { ...customSubdivisions };
  pulseMeterUnlinkedRef.current = { ...pulseMeterUnlinked };
  polyModeRef.current = polyMode;
  polyVoicesRef.current = polyVoices;
  accentMapVersionRef.current = accentMapVersion;
  isTaEditorModeRef.current = isTaEditorMode;
  firstBeatAccentRef.current = firstBeatAccent;
  dictantModeRef.current = dictantMode;
  firstBeatDingSuppressedRowsRef.current = firstBeatDingSuppressedRows;

  const firstBeatEditorSuppressedRowsSorted: number[] = [];
  for (const row of firstBeatDingSuppressedRows) firstBeatEditorSuppressedRowsSorted.push(row);
  firstBeatEditorSuppressedRowsSorted.sort((a, b) => a - b);
  const firstBeatEditorSuppressedSig = firstBeatEditorSuppressedRowsSorted.join(',');

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
    setCustomSubdivisions,
    setCustomSyllables,
    setPulseMeterUnlinked,
    toggleAccent,
    toggleTaDing,
    customSyllablesRef,
    pulseMeterUnlinkedRef,
  };

  return (
    <div className="min-h-screen bg-[#0b101e] sm:bg-black/95 text-slate-200 p-0 sm:p-6 font-sans flex flex-col items-center justify-center">
      {/* Phone emulator container */}
      <div className="w-full max-w-[390px] h-[100dvh] sm:h-[844px] sm:rounded-[2.5rem] sm:border-[6px] border-[#1e2a45] shadow-2xl bg-[#0b101e] flex flex-col gap-3 p-3 relative overflow-hidden shrink-0">
        
        {/* Top Header Controls */}
        <div className="flex gap-2 items-center">
          <button 
            ref={settingsGearButtonRef}
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
                onClick={() => applyTempoImmediate(tempoUi - 1)}
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
                    scheduleTempoCommit(Math.round(20 + percent * 380));
                  };
                  updateTempo(e.clientX);
                  const onMove = (moveEvt: PointerEvent) => {
                    updateTempo(moveEvt.clientX);
                  };
                  const onUp = () => {
                    flushTempoCommit();
                    el.removeEventListener('pointermove', onMove);
                    el.removeEventListener('pointerup', onUp);
                    el.removeEventListener('pointercancel', onUp);
                    el.releasePointerCapture(e.pointerId);
                  };
                  el.addEventListener('pointermove', onMove);
                  el.addEventListener('pointerup', onUp);
                  el.addEventListener('pointercancel', onUp);
                }}
              >
                <div className="absolute w-full h-1.5 bg-[#0b101e] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#364976]"
                    style={{ width: `calc(24px + ${((tempoUi - 20) / 380)} * calc(100% - 48px))` }}
                  />
                </div>
                <div
                  className="absolute z-10 bg-[#23314f] border border-[#2f4066] px-3 w-12 text-center py-1 rounded-full text-sm font-bold shadow-md -translate-x-1/2 flex items-center justify-center select-none"
                  style={{ left: `calc(24px + ${((tempoUi - 20) / 380)} * calc(100% - 48px))` }}
                >
                  {tempoUi}
                </div>
              </div>
              <button
                type="button"
                onClick={() => applyTempoImmediate(tempoUi + 1)}
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
            <div className={`grid ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${isPanelExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div
                ref={randomSettingsPanelRef}
                className={`overflow-hidden flex flex-col ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${isPanelExpanded ? 'px-2.5 py-4 gap-5' : 'px-2.5 py-0 gap-0'}`}
              >
                <div className="flex flex-col gap-4 px-1 pb-1">
                  <div className="flex justify-between items-center text-slate-300 font-bold text-[11px] uppercase tracking-wider">
                    <span className={`flex items-center gap-2 text-blue-300 ${lowPerfMode ? '' : 'drop-shadow-[0_0_8px_rgba(59,130,246,0.5)]'}`}>
                      <Dices size={14} /> Randomizer
                    </span>
                    <span className="text-[10px] font-medium normal-case tracking-normal text-slate-500">
                      {APP_COMMIT_VERSION}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                     <button 
                       onClick={() => toggleRandomFeature('pulsation')}
                       className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                         randomPulsation 
                           ? `bg-purple-600/20 border-purple-500/50 text-purple-300 ${lowPerfMode ? '' : 'shadow-[0_0_10px_rgba(168,85,247,0.15)]'}` 
                           : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                       }`}
                     >
                       Pulsation
                     </button>
                     <button 
                        onClick={() => toggleRandomFeature('pattern')}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                          randomPattern 
                            ? `bg-purple-600/20 border-purple-500/50 text-purple-300 ${lowPerfMode ? '' : 'shadow-[0_0_10px_rgba(168,85,247,0.15)]'}` 
                            : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                        }`}
                     >
                        Accents
                     </button>
                     <button 
                        onClick={() => toggleRandomFeature('speed')}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                          randomSpeed 
                            ? `bg-purple-600/20 border-purple-500/50 text-purple-300 ${lowPerfMode ? '' : 'shadow-[0_0_10px_rgba(168,85,247,0.15)]'}` 
                            : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-400 hover:bg-[#1a253c]/80'
                        }`}
                     >
                        Cell Speed
                     </button>
                     <button 
                        onClick={() => toggleRandomFeature('barSpeed')}
                        className={`flex items-center justify-center py-2 rounded-lg text-xs font-bold transition-all duration-200 border ${
                          randomBarSpeed 
                            ? `bg-purple-600/20 border-purple-500/50 text-purple-300 ${lowPerfMode ? '' : 'shadow-[0_0_10px_rgba(168,85,247,0.15)]'}` 
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
                    <span className={`text-[11px] font-bold tracking-wider uppercase text-blue-300 ${lowPerfMode ? '' : 'drop-shadow-[0_0_8px_rgba(59,130,246,0.5)]'}`}>Click Sound</span>
                    <div className="flex bg-[#0b101e] p-[3px] rounded-lg border border-[#2f4066]/50">
                       <button onClick={() => setClickSound('classic')} className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${clickSound === 'classic' ? 'bg-[#364976] text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}>Classic</button>
                       <button onClick={() => setClickSound('oldschool')} className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${clickSound === 'oldschool' ? 'bg-[#364976] text-white shadow-sm' : 'text-slate-500 hover:text-slate-300'}`}>Oldschool</button>
                    </div>
                  </div>

                  <div className="w-full h-px bg-[#1e2a45]/80 my-0.5"></div>
                  <button
                    type="button"
                    onClick={() => setLowPerfMode((v) => !v)}
                    className={`w-1/2 self-center flex items-center justify-center py-1.5 px-2 rounded-md text-[11px] font-bold transition-colors border ${
                      lowPerfMode
                        ? 'bg-emerald-500/20 border-emerald-300/70 text-emerald-200'
                        : 'bg-[#16332f]/35 border-emerald-700/50 text-emerald-300 hover:text-emerald-200 hover:bg-[#16332f]/60'
                    }`}
                  >
                    <span>Potato Mode</span>
                  </button>
                  <div className="w-full h-px bg-[#1e2a45]/80 my-0.5"></div>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold tracking-wider uppercase text-blue-300">Polyrhythm</span>
                      <button
                        type="button"
                        onClick={() => setPolyMode((prev) => !prev)}
                        className={`px-3 py-1.5 rounded-md text-[11px] font-bold border transition-colors ${
                          polyMode
                            ? 'bg-blue-500/20 border-blue-400/70 text-blue-200'
                            : 'bg-[#1a253c]/50 border-[#2f4066] text-slate-400 hover:text-slate-300'
                        }`}
                      >
                        {polyMode ? 'On' : 'Off'}
                      </button>
                    </div>
                    {polyMode ? (
                      <div className="grid grid-cols-3 gap-2">
                        {[2, 3, 4].map((voices) => (
                          <button
                            key={voices}
                            type="button"
                            onClick={() => setPolyVoices(parsePolyVoices(voices))}
                            className={`py-1.5 rounded-md text-xs font-bold border transition-colors ${
                              polyVoices === voices
                                ? 'bg-blue-600/25 border-blue-400/70 text-blue-200'
                                : 'bg-[#1a253c]/40 border-[#23314f] text-slate-500 hover:text-slate-300'
                            }`}
                          >
                            {voices} pulses
                          </button>
                        ))}
                      </div>
                    ) : null}
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
                      onClick={() => applyTempoImmediate(tempoUi - 1)}
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
                          scheduleTempoCommit(Math.round(20 + percent * 380));
                        };
                        updateTempo(e.clientX);
                        
                        const onMove = (moveEvt: PointerEvent) => {
                          updateTempo(moveEvt.clientX);
                        };
                        const onUp = () => {
                          flushTempoCommit();
                          el.removeEventListener('pointermove', onMove);
                          el.removeEventListener('pointerup', onUp);
                          el.removeEventListener('pointercancel', onUp);
                          el.releasePointerCapture(e.pointerId);
                        };
                        
                        el.addEventListener('pointermove', onMove);
                        el.addEventListener('pointerup', onUp);
                        el.addEventListener('pointercancel', onUp);
                      }}
                    >
                      <div className="absolute w-full h-1.5 bg-[#0b101e] rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-[#364976]" 
                          style={{ width: `calc(24px + ${((tempoUi - 20) / 380)} * calc(100% - 48px))` }}
                        />
                      </div>
                      <div 
                        className="absolute z-10 bg-[#23314f] border border-[#2f4066] px-3 w-12 text-center py-1 rounded-full text-sm font-bold shadow-md -translate-x-1/2 flex items-center justify-center select-none"
                        style={{ left: `calc(24px + ${((tempoUi - 20) / 380)} * calc(100% - 48px))` }}
                      >
                        {tempoUi}
                      </div>
                    </div>
                    <button 
                      type="button"
                      onClick={() => applyTempoImmediate(tempoUi + 1)}
                      className="p-2 bg-[#23314f] rounded-lg text-slate-300 hover:bg-[#2c3d63] active:bg-[#1b253b] transition-colors shrink-0"
                    >
                      <Plus size={18} strokeWidth={2.5} />
                    </button>
                  </div>
                </div>
              ) : null}
              <div
                className={`grid ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${isPanelExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
              >
                <div
                  className={`overflow-hidden flex flex-col ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${isPanelExpanded ? 'px-2.5 pb-2 pt-0' : 'px-2.5 py-0'}`}
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

          {/* Bars / Syllables: скрыты пока открыто окно Settings (Randomizer). */}
          {!showRandomSettings ? (
          <div className={`px-2.5 pt-1 pb-3 flex flex-col mb-2 ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${isPanelExpanded ? 'gap-4' : 'gap-0'}`}>
            <div className="flex items-center gap-2">
              <div className="flex items-center w-12 justify-between pr-1 shrink-0">
                <span className="text-[11px] uppercase tracking-wider text-slate-400 font-bold">Bars</span>
                <button 
                  onClick={() => {
                    setFrozenScale((prev) => {
                      const next = prev !== null ? null : bars;
                      if (lowPerfMode) {
                        if (bars >= 6) potatoAutoFreezeArmedRef.current = next !== null;
                        if (bars <= 5) potatoAutoFreezeArmedRef.current = true;
                      }
                      return next;
                    });
                  }}
                  className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-all duration-300 ${
                    frozenScale !== null 
                      ? `bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/50 ${lowPerfMode ? '' : 'shadow-[0_0_8px_rgba(59,130,246,0.3)]'}` 
                      : 'bg-[#1e2a45]/40 text-slate-400 hover:text-slate-200 hover:bg-[#1e2a45] ring-1 ring-[#2f4066]/30'
                  }`}
                  title={frozenScale !== null ? "Unfreeze row height" : "Freeze current row height"}
                >
                  <Snowflake size={12} />
                </button>
              </div>
              <StructuralSlider
                label="Bars"
                min={1}
                max={32}
                value={bars}
                colorClass="[&::-webkit-slider-thumb]:bg-blue-400"
                onBeginDrag={() => {
                  barsSliderDraggingRef.current = true;
                  attachSliderWindowListeners();
                }}
                onLiveChange={(next) => {
                  applyBarsWithPotatoFreeze(next);
                }}
                onCommit={(next) => {
                  applyBarsWithPotatoFreeze(next);
                }}
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
                    applyBarsWithPotatoFreeze(val);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                  className="w-full text-xs font-bold text-slate-300 text-right bg-transparent hover:bg-[#1e2a45] focus:bg-[#1e2a45] rounded outline-none transition-colors py-1 cursor-text select-text"
                  title="Click to type a number (up to 100)"
                />
              </div>
            </div>

            <div className={`grid ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${isPanelExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
              <div className="overflow-hidden">
                <div className="relative h-4 w-full">
                  {/* Global Syllables Slider */}
                  <div className={`absolute inset-0 flex items-center gap-2 ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${(activeEditCell !== null || activeEditRow !== null) ? 'opacity-0 pointer-events-none scale-y-50' : 'opacity-100 scale-y-100'}`}>
                    <span className="text-[11px] uppercase tracking-wider text-slate-400 font-bold w-12 shrink-0">Syllbs</span>
                    <StructuralSlider
                      label="Syllbs"
                      min={1}
                      max={9}
                      value={syllables}
                      colorClass="[&::-webkit-slider-thumb]:bg-emerald-400"
                      onBeginDrag={() => {
                        syllablesSliderDraggingRef.current = true;
                        attachSliderWindowListeners();
                      }}
                      onLiveChange={(next) => {
                        applyGlobalSyllablesFromSlider(String(next));
                      }}
                      onCommit={(next) => {
                        applyGlobalSyllablesFromSlider(String(next));
                      }}
                    />
                    <div className="w-5 shrink-0 flex justify-end">
                      <span className="w-full py-1 text-xs font-bold text-slate-300 text-right">{syllables}</span>
                    </div>
                  </div>

                  {/* Specific Bar Syllables Slider */}
                  <div className={`absolute inset-0 flex items-center gap-2 ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${activeEditRow !== null && activeEditCell === null ? 'opacity-100 scale-y-100 z-10' : 'opacity-0 pointer-events-none scale-y-50 translate-y-4'}`}>
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
                  <div className={`absolute inset-0 flex items-center gap-2 ${disableMenuSmoothing ? '' : 'transition-all duration-300'} ${activeEditCell !== null ? 'opacity-100 scale-y-100 z-20' : 'opacity-0 pointer-events-none scale-y-50 translate-y-4'}`}>
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
          ) : null}
          
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
          lowPerfMode={lowPerfMode}
          isTaEditorMode={isTaEditorMode}
          accentMapVersion={accentMapVersion}
          firstBeatAccent={firstBeatAccent}
          firstBeatEditorSuppressedSig={firstBeatEditorSuppressedSig}
          customSyllables={customSyllables}
          customSubdivisions={customSubdivisions}
          customMultipliers={customMultipliers}
          accents={accents}
          taDingKeys={taDingKeys}
          pulseMeterUnlinked={pulseMeterUnlinked}
          isPlaying={isPlaying}
          activePos={activePos}
          activePositions={activePositions}
          polyMode={polyMode}
          polyVoices={polyVoices}
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
          {/* Randomizer: tap — live random при PLAY; удерживание — префилл всех тактов по галочкам Settings. */}
                <button 
            type="button"
            title="Коротко: рандом при PLAY. Удерживай ~0,5 с: заполнить все такты (Pulsation / Accents / Cell / Bar Speed из настроек)."
            onPointerDown={() => {
              randomDiceHoldAteClickRef.current = false;
              if (randomDiceHoldTimerRef.current !== null) {
                window.clearTimeout(randomDiceHoldTimerRef.current);
                randomDiceHoldTimerRef.current = null;
              }
              randomDiceHoldTimerRef.current = window.setTimeout(() => {
                randomDiceHoldTimerRef.current = null;
                prefillAllTactsRandomizer();
                randomDiceHoldAteClickRef.current = true;
              }, RANDOM_DICE_PREFILL_HOLD_MS);
                  }}
                  onPointerUp={() => {
              if (randomDiceHoldTimerRef.current !== null) {
                window.clearTimeout(randomDiceHoldTimerRef.current);
                randomDiceHoldTimerRef.current = null;
              }
                  }}
                  onPointerLeave={() => {
              if (randomDiceHoldTimerRef.current !== null) {
                window.clearTimeout(randomDiceHoldTimerRef.current);
                randomDiceHoldTimerRef.current = null;
              }
            }}
            onPointerCancel={() => {
              if (randomDiceHoldTimerRef.current !== null) {
                window.clearTimeout(randomDiceHoldTimerRef.current);
                randomDiceHoldTimerRef.current = null;
              }
                      }}
                      onClick={() => {
              if (randomDiceHoldAteClickRef.current) {
                randomDiceHoldAteClickRef.current = false;
                return;
              }
              setRandomModeEnabled((prev) => !prev);
            }}
            className={`flex-1 rounded-xl border flex justify-center items-center transition-all duration-200 relative ${
              randomDiceMintFlash
                ? `bg-teal-500/25 border-teal-300/75 text-teal-100 ${lowPerfMode ? '' : 'shadow-[0_0_22px_rgba(45,212,191,0.55)]'} ring-2 ring-teal-300/70`
                : randomModeEnabled
                ? `bg-blue-600/30 border-blue-400/60 ${lowPerfMode ? '' : 'shadow-[0_0_15px_rgba(59,130,246,0.3)]'} text-blue-200`
                : 'bg-[#161f33] border-[#23314f] text-slate-400 hover:text-slate-200 hover:bg-[#1a253c]'
            }`}
          >
            <Dices size={24} />
          </button>
          
          {/* First Beat Accent ("Ta"): tap — глобальный Ta; удерживание — режим правки первых долей по сетке. */}
          <button
            type="button"
            onPointerDown={() => {
              taHoldAteClickRef.current = false;
              if (taHoldTimerRef.current !== null) {
                window.clearTimeout(taHoldTimerRef.current);
                taHoldTimerRef.current = null;
              }
              taHoldTimerRef.current = window.setTimeout(() => {
                taHoldTimerRef.current = null;
                taHoldAteClickRef.current = true;
                if (isTaEditorModeRef.current) {
                  setIsTaEditorMode(false);
                } else {
                  setIsTaEditorMode(true);
                }
              }, SNAPSHOT_MENU_HOLD_MS);
            }}
            onPointerUp={() => {
              if (taHoldTimerRef.current !== null) {
                window.clearTimeout(taHoldTimerRef.current);
                taHoldTimerRef.current = null;
              }
            }}
            onPointerLeave={() => {
              if (taHoldTimerRef.current !== null) {
                window.clearTimeout(taHoldTimerRef.current);
                taHoldTimerRef.current = null;
              }
            }}
            onPointerCancel={() => {
              if (taHoldTimerRef.current !== null) {
                window.clearTimeout(taHoldTimerRef.current);
                taHoldTimerRef.current = null;
              }
            }}
            onClick={() => {
              if (taHoldAteClickRef.current) {
                taHoldAteClickRef.current = false;
                return;
              }
              setFirstBeatAccent((prev) => !prev);
            }}
            className={`flex-1 rounded-xl flex justify-center items-center transition-all bg-[#161f33] ${
              isTaEditorMode
                ? `border-2 border-white/90 text-white ${lowPerfMode ? '' : 'shadow-[0_0_18px_rgba(255,255,255,0.25)]'}`
                : firstBeatAccent
                  ? `border border-purple-400 ${lowPerfMode ? '' : 'shadow-[0_0_15px_rgba(192,132,252,0.4)]'} text-purple-200`
                  : 'border border-[#23314f] text-slate-400 hover:text-slate-200 hover:bg-[#1a253c] active:bg-[#131b2c]'
            }`}
          >
            <span className="font-bold text-[22px] tracking-wide">Ta</span>
          </button>

          {/* All beats vs accent-only (square); долгое нажатие — режим диктант (бегунок только на 1-й доле; пассивные замьючены). */}
          <button
            type="button"
            title="Коротко: только выделенные доли / все доли. Удерживай ~0,4 с: диктант (бегунок только на первом слоге такта; пассивные щелчки выкл.). Повторное удержание — выход из диктанта."
            onPointerDown={() => {
              squareHoldAteClickRef.current = false;
              if (squareHoldTimerRef.current !== null) {
                window.clearTimeout(squareHoldTimerRef.current);
                squareHoldTimerRef.current = null;
              }
              squareHoldTimerRef.current = window.setTimeout(() => {
                squareHoldTimerRef.current = null;
                squareHoldAteClickRef.current = true;
                setDictantMode((d) => !d);
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
              dictantMode
                ? `border border-teal-400/90 ${lowPerfMode ? '' : 'shadow-[0_0_14px_rgba(45,212,191,0.28)]'} text-teal-100`
                : syllableReadMuteMode !== 'off'
                  ? syllableReadMuteMode === 'full'
                    ? `border border-amber-400/90 ${lowPerfMode ? '' : 'shadow-[0_0_14px_rgba(251,191,36,0.28)]'} text-amber-100`
                    : `border border-purple-400 ${lowPerfMode ? '' : 'shadow-[0_0_15px_rgba(192,132,252,0.4)]'} text-purple-200`
                  : onlyAccents
                    ? 'border border-purple-500/40 bg-purple-700/30 hover:bg-purple-700/40 active:bg-purple-700/20 text-purple-200'
                    : 'border border-[#23314f] hover:bg-[#1a253c] active:bg-[#131b2c] text-slate-400 hover:text-slate-200'
            }`}
            aria-label={
              dictantMode
                ? 'Режим диктант: бегунок только на первом слоге такта, пассивные щелчки выключены. Долгое удержание — выключить диктант'
                : syllableReadMuteMode === 'full'
                  ? 'Тишина по щелчкам сетки (из пресета). Короткое: только выделенные / все доли'
                  : syllableReadMuteMode === 'no_accent_sharp'
                    ? 'Акценты со звуком пассивных (из пресета). Короткое: только выделенные / все доли'
                    : onlyAccents
                      ? 'Только выделенные доли. Долгое удержание — режим диктант'
                      : 'Все доли. Долгое удержание — режим диктант'
            }
          >
            <span
              className={`block w-6 h-6 rounded-sm border-2 border-current ${lowPerfMode ? '' : 'transition-all duration-300'} ${
                dictantMode || syllableReadMuteMode !== 'off' || onlyAccents
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
            type="button"
            disabled={isTaEditorMode && !isPlaying}
            aria-disabled={isTaEditorMode && !isPlaying}
            onClick={togglePlayback}
            className={`w-full py-4 rounded-xl font-black text-lg tracking-[0.2em] flex items-center justify-center gap-2 ${lowPerfMode ? '' : 'shadow-[0_8px_20px_rgba(16,185,129,0.2)]'} transition-all transform ${
              isTaEditorMode && !isPlaying
                ? 'opacity-45 cursor-not-allowed bg-emerald-600/50 text-slate-800'
                : 'active:scale-[0.98] ' +
                  (isPlaying
                    ? 'bg-rose-500 hover:bg-rose-400 active:bg-rose-600 shadow-rose-500/20 text-white'
                    : 'bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-slate-950')
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