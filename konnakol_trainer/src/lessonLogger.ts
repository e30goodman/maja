/**
 * Накопление снимка 32-тактового (и др.) Parent Mode урока для офлайн-оценки драматургии.
 */
import type { BarGenome, ParentGenome, PhraseRole } from './parentMode';
import { effectiveSyllableToken, MUTATION_LABEL, snapshotBarGenome } from './parentMode';
import { computeNps, type Gati } from './sequencerLabels';

export type BarLog = {
	index: number;
	variationType: string;
	syllables: string[];
	accents: number[];
	subdivision: number;
	/** Notes per second для такта: BPM × число живых долей / 60 (см. {@link computeNps}). */
	nps: number;
	isTihaiPart?: boolean;
	/** для группировки секций в текстовом дампе */
	phraseId?: number;
	mutationKind?: string;
	modeTag?: 'gati_mode' | 'jati_mode';
	deSyncJati?: boolean;
	localJati?: number;
	reSyncBridge?: boolean;
	bridgeKind?: 'resync' | 'de_sync_prep' | 'gati_prep';
	pulseOffsetBeforeBar?: number;
	gatiTargetSub?: number;
	intensityTarget?: number;
	totalCells?: number;
	subdivisionHits?: number;
	maxSubdivision?: number;
	auditCritical?: string;
	emotionalProfile?: 'tandava' | 'lasya' | 'yati';
	arudiReason?: 'symmetry_close' | 'phrase_cadence';
	prasaMaxEditDistance?: number;
};

export type LessonMeta = {
	seed: number;
	chaos: number;
	parentThemeLine: string;
	formPresetLabel: string;
	barCount: number;
};

/** Длина цикла для sam («раз») при Muktayi-check: пульсы слогов, 0-based sam @ …,8,16… */
export const MUKTAYI_ADI_PULSE_CYCLE = 8;

function barGati(g: BarGenome): Gati {
	return Math.max(1, Math.min(9, g.curSyl)) as Gati;
}

function npsForBar(tempoBpm: number, g: BarGenome): number {
	const gati = barGati(g);
	const raw = computeNps(tempoBpm, gati);
	return Math.round(raw * 1000) / 1000;
}

function normalizeSyllableToken(raw: string): string {
	return raw
		.trim()
		.replace(/\*+$/u, '')
		.replace(/\(.*?\)/gu, '')
		.trim();
}

function isTaOrThom(token: string): boolean {
	const s = normalizeSyllableToken(token).toLowerCase();
	return s === 'ta' || s === 'thom';
}

/**
 * Muktayi-check: последний слог урока — акцентированный Ta или Thom, и его глобальный пульс
 * (сумма длин тактов до него + индекс в такту) попадает на последнюю долю цикла ADI:
 * globalPulse % 8 === 7.
 */
export function computeMuktayiCheck(
	bars: readonly BarLog[],
	opts?: { adiCycle?: number },
): { ok: boolean; lines: string[] } {
	const cycle = opts?.adiCycle ?? MUKTAYI_ADI_PULSE_CYCLE;
	const lines: string[] = [];
	if (bars.length === 0) {
		lines.push('Muktayi-check: FAIL (no bars)');
		return { ok: false, lines };
	}
	const lastBar = bars[bars.length - 1]!;
	const n = lastBar.syllables.length;
	if (n < 1) {
		lines.push('Muktayi-check: FAIL (empty last bar)');
		return { ok: false, lines };
	}
	const isRestTok = (raw: string): boolean => {
		const s = normalizeSyllableToken(raw).toLowerCase();
		return s === '' || s === '-' || s === '—' || s === '.';
	};
	let lastIdx = n - 1;
	while (lastIdx >= 0 && isRestTok(lastBar.syllables[lastIdx] ?? '')) lastIdx--;
	if (lastIdx < 0) {
		lines.push('Muktayi-check: FAIL (last bar contains only rests)');
		return { ok: false, lines };
	}
	let pulsesBefore = 0;
	for (let i = 0; i < bars.length - 1; i++) {
		pulsesBefore += bars[i]!.syllables.length;
	}
	const globalPulse = pulsesBefore + lastIdx;
	const onSam = globalPulse % cycle === cycle - 1;
	const lastTok = lastBar.syllables[lastIdx] ?? '';
	const taThom = isTaOrThom(lastTok);
	const accented = lastBar.accents.includes(lastIdx);
	const ok = taThom && accented && onSam;
	const hadDeSync = bars.some((b) => b.deSyncJati === true);

	lines.push('---------------------------------------');
	lines.push(`Muktayi-check (ADI ${cycle} pulses/cycle; sam -> globalPulse ≡ ${cycle - 1} mod ${cycle}):`);
	lines.push(
		ok
			? `  PASS - last significant syllable "${lastTok}" (Ta/Thom), accented, globalPulse=${globalPulse}; ${globalPulse} % ${cycle} = ${cycle - 1} (last pulse of cycle).`
			: `  FAIL - last significant syllable "${lastTok}", idx=${lastIdx}, accent=${accented}, Ta/Thom=${taThom}, globalPulse=${globalPulse}, ${globalPulse} % ${cycle}=${globalPulse % cycle} (expected ${cycle - 1}).`,
	);
	if (!ok && hadDeSync && !onSam) {
		lines.push('  Re-sync Error: offset mismatch.');
	}
	return { ok, lines };
}

function syllableNamesForGenome(bpm: number, g: BarGenome): string[] {
	const parts: string[] = [];
	const dead = typeof g.deadStart === 'number' ? Math.max(0, Math.min(g.deadStart, g.curSyl)) : g.curSyl;
	for (let i = 0; i < g.curSyl; i++) {
		const ov = g.cellSyllables?.[i];
		if (typeof ov === 'string' && ov.length > 0) {
			parts.push(ov);
			continue;
		}
		parts.push(i >= dead ? '.' : effectiveSyllableToken(g, i, bpm));
	}
	return parts;
}

/** Человекочитаемая строка темы (1–2 такта parent). */
export function formatParentGenomeHumanLine(parent: ParentGenome, bpm: number): string {
	return parent.bars.map((g) => syllableNamesForGenome(bpm, g).join(' ')).join(' | ');
}

function intentionLabel(role: PhraseRole): {
	line: string;
	mutationKind: string;
	phraseId: number;
	isTihai: boolean;
	modeTag?: 'gati_mode' | 'jati_mode';
	deSyncJati?: boolean;
	localJati?: number;
	reSyncBridge?: boolean;
	bridgeKind?: 'resync' | 'de_sync_prep' | 'gati_prep';
	pulseOffsetBeforeBar?: number;
	gatiTargetSub?: number;
	intensityTarget?: number;
	emotionalProfile?: 'tandava' | 'lasya' | 'yati';
	arudiReason?: 'symmetry_close' | 'phrase_cadence';
	prasaMaxEditDistance?: number;
} {
	const phraseId = role.phraseId;
	if (role.type === 'parent') {
		return {
			line: '[Parent Mode] - Exposition',
			mutationKind: 'parent',
			phraseId,
			isTihai: false,
			emotionalProfile: role.emotionalProfile,
		};
	}
	if (role.type === 'free') {
		return {
			line: '[Free] - Free-random filler',
			mutationKind: 'free',
			phraseId,
			isTihai: false,
			emotionalProfile: role.emotionalProfile,
		};
	}
	if (role.type === 'resync_bridge') {
		const kind = role.bridgeKind ?? 'resync';
		const kindLabel = kind === 'de_sync_prep' ? '[De-sync Prep]' : kind === 'gati_prep' ? '[Gati Prep]' : '[Re-sync Bridge]';
		return {
			line: `${kindLabel} [Karvai] - Transition buffer · phrase#${phraseId}`,
			mutationKind: 'resync_bridge',
			phraseId,
			isTihai: false,
			// Bridge-фазы не должны автоматически маркироваться как Jati;
			// truth-режим вычисляется ниже из физики бара.
			modeTag: undefined,
			deSyncJati: false,
			localJati: undefined,
			reSyncBridge: kind === 'resync',
			bridgeKind: kind,
			pulseOffsetBeforeBar: role.pulseOffsetBeforeBar,
			emotionalProfile: role.emotionalProfile,
		};
	}
	const label = MUTATION_LABEL[role.type];
	const stepInfo = `Step ${role.phraseStep + 1}/${role.phraseLength}`;
	const isTihai = role.type === 'tihai';
	const localCycle =
		role.type !== 'parent' && role.type !== 'free' && role.type !== 'resync_bridge'
			? role.localCycleLength
			: undefined;
	const hasRealJatiCycle = localCycle === 5 || localCycle === 7 || localCycle === 9;
	const deSyncJati =
		role.type !== 'parent' && role.type !== 'free'
			? role.deSyncJati === true && hasRealJatiCycle
			: false;
	const modeTag: 'gati_mode' | 'jati_mode' | undefined = deSyncJati ? 'jati_mode' : 'gati_mode';
	const modeLabel = deSyncJati ? ' [Jati Mode (De-sync)]' : ' [Gati Mode]';
	const localJati = deSyncJati ? localCycle : undefined;
	// Re-sync bridge должен быть отдельной ролью ДО tihai, не внутри первого такта tihai.
	const reSyncBridge = false;
	let extra = '';
	if (isTihai) {
		extra = role.phraseStep === role.phraseLength - 1 ? ' (landing)' : ' (call / build)';
	}
	if (reSyncBridge) extra += ' [Re-sync Bridge]';
	return {
		line: `[${label}]${modeLabel} - ${stepInfo}${extra} · phrase#${phraseId}`,
		mutationKind: role.type,
		phraseId,
		isTihai,
		modeTag,
		deSyncJati,
		localJati,
		reSyncBridge,
		bridgeKind: reSyncBridge ? 'resync' : undefined,
		pulseOffsetBeforeBar: role.pulseOffsetBeforeBar,
		gatiTargetSub: role.gatiTargetSub,
		intensityTarget: role.intensityTarget,
		emotionalProfile: role.emotionalProfile,
		arudiReason: role.arudiReason,
		prasaMaxEditDistance: role.prasaMaxEditDistance,
	};
}

type ModeTruthInput = {
	modeTag?: 'gati_mode' | 'jati_mode';
	totalCells: number;
	subdivisionHits: number;
	maxSubdivision: number;
	pulseOffsetBeforeBar?: number;
	localJati?: number;
};

export function evaluateModeTruth(input: ModeTruthInput): {
	resolvedModeTag?: 'gati_mode' | 'jati_mode';
	critical?: string;
} {
	const modeTag = input.modeTag;
	if (!modeTag) return { resolvedModeTag: undefined };
	const totalCells = Math.max(0, Math.floor(input.totalCells));
	const localJati = typeof input.localJati === 'number' ? Math.max(1, Math.floor(input.localJati)) : totalCells;
	const hasDeclaredLocalJati = typeof input.localJati === 'number';
	const hasPhysicalOddCycle = totalCells === 5 || totalCells === 7 || totalCells === 9;
	// Жесткий инвариант: при декларированном Local Jati физический размер бара обязан совпадать.
	if (hasDeclaredLocalJati && hasPhysicalOddCycle && localJati !== totalCells) {
		return {
			resolvedModeTag: 'gati_mode',
			critical: `CRITICAL: Jati Size Mismatch (declared=${localJati}, physical=${totalCells}).`,
		};
	}
	const hasValidJatiCycle = localJati === 5 || localJati === 7 || localJati === 9;
	const hasPhysicalJatiCycle = hasPhysicalOddCycle;
	const hasSubdivisionDrive = input.subdivisionHits > 0 || input.maxSubdivision > 1;
	const hasDrift = typeof input.pulseOffsetBeforeBar === 'number' ? input.pulseOffsetBeforeBar % MUKTAYI_ADI_PULSE_CYCLE !== 0 : false;
	const trueGati = totalCells === MUKTAYI_ADI_PULSE_CYCLE && hasSubdivisionDrive;
	// Truth-контракт:
	// Jati считается истинным только при физическом цикле 5/7/9 в самом баре.
	// Это блокирует ложные промоуты в jati_mode для bridge/gati-контекстов с curSyl != 5|7|9.
	const trueJati = hasPhysicalJatiCycle && (hasDrift || hasValidJatiCycle);
	if (modeTag === 'jati_mode' && !trueJati) {
		return {
			resolvedModeTag: 'gati_mode',
			critical: 'CRITICAL: False Jati Mapping Detected (ImitationDetected).',
		};
	}
	if (modeTag === 'gati_mode' && trueJati) {
		return { resolvedModeTag: 'jati_mode' };
	}
	return { resolvedModeTag: modeTag };
}

/**
 * Снимок такта после `applyParentModeBar`: слоги/акценты из сетки + намерение из роли расписания.
 */
export function buildBarLogForParentRow(
	rowIndex: number,
	role: PhraseRole,
	tempoBpm: number,
	syllablesDefault: number,
	state: {
		customSyllables: Record<number, number>;
		accents: Set<string>;
		customSubdivisions: Record<string, number>;
		customCellSyllables?: Record<string, string>;
		deadCells: { [r: number]: { deadStart: number } | undefined };
	},
): BarLog {
	const g = snapshotBarGenome(rowIndex, syllablesDefault, state);
	let subdivisionHits = 0;
	let maxSubdivision = 1;
	for (let c = 0; c < g.curSyl; c++) {
		const s = state.customSubdivisions[`${rowIndex}-${c}`];
		if (typeof s === 'number' && s > 1) {
			subdivisionHits++;
			maxSubdivision = Math.max(maxSubdivision, Math.floor(s));
		}
	}
	const syllables = syllableNamesForGenome(tempoBpm, g);
	const accents = [...g.accents].sort((a, b) => a - b);
	const intent = intentionLabel(role);
	const bridgeLocalCycleRaw = role.type === 'resync_bridge' ? role.localCycleLength : undefined;
	const bridgeLocalCycle =
		typeof bridgeLocalCycleRaw === 'number' && (bridgeLocalCycleRaw === 5 || bridgeLocalCycleRaw === 7 || bridgeLocalCycleRaw === 9)
			? bridgeLocalCycleRaw
			: undefined;
	const bridgeHasDrift =
		role.type === 'resync_bridge' && typeof intent.pulseOffsetBeforeBar === 'number'
			? intent.pulseOffsetBeforeBar % MUKTAYI_ADI_PULSE_CYCLE !== 0
			: false;
	const bridgeHasPhysicalJati =
		role.type === 'resync_bridge' &&
		bridgeLocalCycle !== undefined &&
		(g.curSyl === 5 || g.curSyl === 7 || g.curSyl === 9) &&
		g.curSyl === bridgeLocalCycle;
	const bridgeModeTag: 'gati_mode' | 'jati_mode' | undefined =
		role.type === 'resync_bridge'
			? bridgeHasPhysicalJati && (bridgeHasDrift || g.curSyl === bridgeLocalCycle)
				? 'jati_mode'
				: 'gati_mode'
			: intent.modeTag;
	const modeTruth = evaluateModeTruth({
		modeTag: bridgeModeTag,
		totalCells: g.curSyl,
		subdivisionHits,
		maxSubdivision,
		pulseOffsetBeforeBar: intent.pulseOffsetBeforeBar,
		localJati: role.type === 'resync_bridge' ? bridgeLocalCycle : intent.localJati,
	});
	const resolvedModeTag = modeTruth.resolvedModeTag;
	const variationType =
		resolvedModeTag !== intent.modeTag
			? intent.line
				.replace(' [Jati Mode (De-sync)]', ' [Gati Mode]')
				.replace(' [Gati Mode]', ' [Jati Mode (De-sync)]')
			: intent.line;
	const nps = npsForBar(tempoBpm, g);
	// Truth over declaration: local jati must reflect physical bar size, not role intent.
	const localJatiPhysical =
		role.type === 'resync_bridge'
			? resolvedModeTag === 'jati_mode' && bridgeHasPhysicalJati
				? bridgeLocalCycle
				: undefined
			: resolvedModeTag === 'jati_mode' && (g.curSyl === 5 || g.curSyl === 7 || g.curSyl === 9)
				? Math.max(1, g.curSyl)
				: undefined;
	const deSyncJatiResolved =
		role.type === 'resync_bridge'
			? resolvedModeTag === 'jati_mode'
			: resolvedModeTag === 'jati_mode';
	return {
		index: rowIndex,
		variationType,
		syllables,
		accents,
		/** число живых долей в такте (как «Sub: 4» в примере) */
		subdivision: g.curSyl,
		nps,
		isTihaiPart: intent.isTihai ? true : undefined,
		phraseId: intent.phraseId,
		mutationKind: intent.mutationKind,
		modeTag: resolvedModeTag,
		deSyncJati: deSyncJatiResolved,
		localJati: localJatiPhysical,
		reSyncBridge: intent.reSyncBridge,
		bridgeKind: intent.bridgeKind,
		pulseOffsetBeforeBar: intent.pulseOffsetBeforeBar,
		gatiTargetSub: intent.gatiTargetSub,
		intensityTarget: intent.intensityTarget,
		totalCells: g.curSyl,
		subdivisionHits,
		maxSubdivision,
		auditCritical: modeTruth.critical,
		emotionalProfile: intent.emotionalProfile,
		arudiReason: intent.arudiReason,
		prasaMaxEditDistance: intent.prasaMaxEditDistance,
	};
}

export class LessonLogger {
	private meta: LessonMeta | null = null;
	private bars: BarLog[] = [];

	reset(meta: LessonMeta): void {
		this.meta = meta;
		this.bars = [];
	}

	addBar(bar: BarLog): void {
		this.bars.push(bar);
	}

	getMeta(): LessonMeta | null {
		return this.meta;
	}

	getBars(): readonly BarLog[] {
		return this.bars;
	}

	formatLessonLogText(): string {
		const m = this.meta;
		const lines: string[] = [];
		if (!m) {
			return 'LESSON LOG\n(no session — reset() was not called for this lesson)\n';
		}
		lines.push(`LESSON LOG (Seed: ${m.seed >>> 0}, Chaos: ${m.chaos})`);
		lines.push(`Parent: ${m.parentThemeLine}`);
		lines.push(`Preset: ${m.formPresetLabel} · Bars: ${m.barCount}`);
		lines.push('---------------------------------------');

		if (this.bars.length === 0) {
			lines.push('(no recorded bars - trigger Random/Dice in Parent mode)');
			return lines.join('\n');
		}
		const makeGridString = (syllables: string[]): string => {
			const cells = syllables.map((tok) => {
				const s = normalizeSyllableToken(tok).toLowerCase();
				if (s === '.' || s === 'dot') return '.';
				if (s === '-' || s === '—') return '-';
				if (s.length === 0) return '.';
				return 'x';
			});
			return `|${cells.join('')}|`;
		};
		const isArudiBar = (bar: BarLog): boolean => typeof bar.arudiReason === 'string';
		const isPulseShiftStart = (idx: number): boolean => {
			const cur = this.bars[idx];
			if (!cur || cur.deSyncJati !== true) return false;
			const prev = idx > 0 ? this.bars[idx - 1] : undefined;
			return prev?.deSyncJati !== true;
		};
		const isMuktayiBar = (idx: number): boolean => idx === this.bars.length - 1;

		let i = 0;
		while (i < this.bars.length) {
			const b0 = this.bars[i]!;
			const pid = b0.phraseId ?? i;
			const mk = b0.mutationKind ?? 'unknown';
			let j = i + 1;
			while (
				j < this.bars.length &&
				(this.bars[j]!.phraseId ?? j) === pid &&
				(this.bars[j]!.mutationKind ?? '') === mk
			) {
				j++;
			}
			lines.push('');
			const barFrom = this.bars[i]!.index + 1;
			const barTo = this.bars[j - 1]!.index + 1;
			const block = this.bars.slice(i, j);
			const subConst = block.every((bb) => bb.subdivision === b0.subdivision);
			const npsConst = block.every((bb) => Math.abs(bb.nps - b0.nps) < 1e-9);
			const blockSub = subConst ? ` | Sub: ${b0.subdivision}` : '';
			const blockNps = npsConst ? ` | NPS: ${b0.nps}` : '';
			lines.push(`Bars ${barFrom}-${barTo}: ${b0.variationType}${blockSub}${blockNps}`);
			for (let k = i; k < j; k++) {
				const b = this.bars[k]!;
				const acc = b.accents.length ? b.accents.join(', ') : '—';
				const tih = b.isTihaiPart ? ' | Tihai phrase' : '';
				const jatiInfo =
					b.deSyncJati && typeof b.localJati === 'number'
						? ` | Local Jati: ${Math.max(1, Math.round(b.localJati))}/8`
						: '';
				const bridge = b.reSyncBridge ? ' | [Re-sync Bridge]' : '';
				const bridgeKind = b.bridgeKind ? ` | Bridge: ${b.bridgeKind}` : '';
				const offsetInfo =
					typeof b.pulseOffsetBeforeBar === 'number' ? ` | PulseOffset: ${Math.max(0, Math.floor(b.pulseOffsetBeforeBar))}` : '';
				const gatiTarget = typeof b.gatiTargetSub === 'number' ? ` | GatiTarget: ${b.gatiTargetSub}` : '';
				const intensityInfo =
					typeof b.intensityTarget === 'number' ? ` | Intensity: ${b.intensityTarget.toFixed(2)}` : '';
				const profileInfo = typeof b.emotionalProfile === 'string' ? ` | Profile: ${b.emotionalProfile}` : '';
				const prasaInfo =
					typeof b.prasaMaxEditDistance === 'number' ? ` | PrasaMaxEdit: ${Math.max(0, Math.floor(b.prasaMaxEditDistance))}` : '';
				const cadenceInfo = b.arudiReason ? ` | Cadence: ${b.arudiReason}` : '';
				const barSub = subConst ? '' : ` | Sub: ${b.subdivision}`;
				const barNps = npsConst ? '' : ` | NPS: ${b.nps}`;
				const grid = makeGridString(b.syllables);
				const markers: string[] = [];
				if (isPulseShiftStart(k)) markers.push('[Pulse Shift]');
				if (isArudiBar(b)) markers.push('[Arudi]');
				if (isMuktayiBar(k)) markers.push('[Muktayi]');
				const markerInfo = markers.length > 0 ? ` | ${markers.join(' ')}` : '';
				lines.push(
					`Bar ${b.index + 1}: [${b.syllables.join(', ')}] | ${grid}${markerInfo} | Accents: [${acc}]${barSub}${jatiInfo}${barNps}${gatiTarget}${intensityInfo}${profileInfo}${prasaInfo}${cadenceInfo}${tih}${bridge}${bridgeKind}${offsetInfo}`,
				);
				if (typeof b.auditCritical === 'string' && b.auditCritical.length > 0) {
					lines.push(`  ${b.auditCritical}`);
				}
			}
			i = j;
		}
		lines.push(...computeMuktayiCheck(this.bars).lines);
		return lines.join('\n');
	}
}

export const lessonLogger = new LessonLogger();

export function downloadAestheticScore(): void {
	const text = lessonLogger.formatLessonLogText();
	const seed = lessonLogger.getMeta()?.seed ?? 0;
	const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `lesson-log-${(seed >>> 0).toString(16)}.txt`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
