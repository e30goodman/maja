#!/usr/bin/env node
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const useStaged = args.includes('--staged');
const rangeIdx = args.indexOf('--range');
const rangeRaw = rangeIdx >= 0 ? args[rangeIdx + 1] : '';
const range = rangeRaw && !/^0+\.\./.test(rangeRaw) ? rangeRaw : '';

const UI_FILE_RE = /\.(tsx|jsx|css|scss|sass|less)$/i;
const FORBIDDEN_PATTERNS = [
	{ re: /\btranslateX\s*\(/, reason: 'translateX is forbidden for UI geometry fixes' },
	{ re: /\btranslateY\s*\(/, reason: 'translateY is forbidden for UI geometry fixes' },
	{ re: /\bright\s*:\s*-\d/, reason: 'negative right offset is forbidden for UI geometry fixes' },
	{
		re: /\babsolute\b.*\binset-(x|y)-0\b|\binset-(x|y)-0\b.*\babsolute\b/,
		reason: 'suspicious absolute overlay pattern detected',
	},
];

const CATEGORY_RULES = [
	{
		name: 'margin',
		re: /\b(?:-?m[trblxy]?-\[?[^\s'"]+\]?|margin(?:-(?:top|right|bottom|left|inline|block|x|y))?\s*:)/i,
	},
	{
		name: 'padding',
		re: /\b(?:p[trblxy]?-\[?[^\s'"]+\]?|padding(?:-(?:top|right|bottom|left|inline|block|x|y))?\s*:)/i,
	},
	{
		name: 'width',
		re: /\b(?:w-\[?[^\s'"]+\]?|max-w-\[?[^\s'"]+\]?|min-w-\[?[^\s'"]+\]?|width\s*:)/i,
	},
];

function run(command) {
	return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function getChangedFiles() {
	const baseCmd = useStaged
		? 'git diff --cached --name-only --diff-filter=ACMR'
		: range
			? `git diff --name-only --diff-filter=ACMR ${range}`
			: 'git diff --name-only --diff-filter=ACMR HEAD~1..HEAD';
	const out = run(baseCmd).trim();
	if (!out) return [];
	return out
		.split(/\r?\n/)
		.map((x) => x.trim())
		.filter((x) => x.length > 0 && UI_FILE_RE.test(x));
}

function getPatch(file) {
	if (useStaged) return run(`git diff --cached -U0 -- "${file}"`);
	if (range) return run(`git diff -U0 ${range} -- "${file}"`);
	return run(`git diff -U0 HEAD~1..HEAD -- "${file}"`);
}

function getAddedLines(patchText) {
	const lines = patchText.split(/\r?\n/);
	return lines
		.filter((line) => line.startsWith('+') && !line.startsWith('+++'))
		.map((line) => line.slice(1));
}

function detectCategories(line) {
	const hits = new Set();
	for (const rule of CATEGORY_RULES) {
		if (rule.re.test(line)) hits.add(rule.name);
	}
	return hits;
}

function main() {
	let failed = false;
	const files = getChangedFiles();
	if (files.length === 0) {
		console.log('[ui-geometry-guard] no UI file changes detected');
		return;
	}

	for (const file of files) {
		const patch = getPatch(file);
		const added = getAddedLines(patch);
		if (added.length === 0) continue;

		const categories = new Set();
		for (const line of added) {
			for (const c of detectCategories(line)) categories.add(c);
			for (const rule of FORBIDDEN_PATTERNS) {
				if (rule.re.test(line)) {
					failed = true;
					console.error(`[ui-geometry-guard] ${file}: ${rule.reason}`);
					console.error(`  > ${line.trim()}`);
				}
			}
		}

		if (categories.size > 1) {
			failed = true;
			console.error(
				`[ui-geometry-guard] ${file}: one-variable-per-iteration violated (found ${Array.from(categories).join(', ')})`,
			);
		}
	}

	if (failed) {
		console.error(
			'[ui-geometry-guard] blocked: keep one geometry variable per iteration (margin OR padding OR width), avoid forbidden UI hacks.',
		);
		process.exit(1);
	}
	console.log('[ui-geometry-guard] passed');
}

main();
