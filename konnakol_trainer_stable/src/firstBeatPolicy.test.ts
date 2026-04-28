import assert from 'node:assert/strict';
import {
	resolveFirstBeatHitRow,
	resolveRuntimeFirstBeatPolicy,
	type FirstBeatHitPolicy,
} from './firstBeatPolicy';

/**
 * §14 из TA_LOGIC_GUIDE.md: runtime first-beat policy не зависит от
 * `accentMapVersion`. Эти тесты фиксируют контракт helper'а и ловят
 * регрессии, если появится новый аргумент или скрытая зависимость.
 */

function testResolvePolicyMonoAlwaysLegacy() {
	assert.equal(resolveRuntimeFirstBeatPolicy(false, 0), 'legacy');
	assert.equal(resolveRuntimeFirstBeatPolicy(false, 1), 'legacy');
	assert.equal(resolveRuntimeFirstBeatPolicy(false, 2), 'legacy');
}

function testResolvePolicyPolyLaneRule() {
	assert.equal(resolveRuntimeFirstBeatPolicy(true, 0), 'legacy');
	assert.equal(resolveRuntimeFirstBeatPolicy(true, 1), 'explicit_ta_only');
	assert.equal(resolveRuntimeFirstBeatPolicy(true, 2), 'explicit_ta_only');
}

function testExplicitTaOnlyIgnoresAccentAndFlag() {
	/** 'explicit_ta_only': только `on0Ding` считается. */
	assert.equal(resolveFirstBeatHitRow('explicit_ta_only', true, false, true, false), false);
	assert.equal(resolveFirstBeatHitRow('explicit_ta_only', false, true, false, false), true);
	assert.equal(resolveFirstBeatHitRow('explicit_ta_only', false, false, true, false), false);
	/** suppressedRow не влияет: суппрессия учитывается только в legacy. */
	assert.equal(resolveFirstBeatHitRow('explicit_ta_only', true, true, true, true), true);
	assert.equal(resolveFirstBeatHitRow('explicit_ta_only', true, false, true, true), false);
}

function testExplicitAnyCombinesAccentAndDing() {
	/** 'explicit_any': `on0Accent || on0Ding`. firstBeatEnabled/suppressedRow игнорируются. */
	assert.equal(resolveFirstBeatHitRow('explicit_any', false, false, false, false), false);
	assert.equal(resolveFirstBeatHitRow('explicit_any', true, false, false, false), true);
	assert.equal(resolveFirstBeatHitRow('explicit_any', false, true, false, false), true);
	assert.equal(resolveFirstBeatHitRow('explicit_any', false, false, true, true), false);
}

function testLegacyRespectsSuppressionAndFirstBeatFlag() {
	/** legacy suppressed: только `on0Ding`. */
	assert.equal(resolveFirstBeatHitRow('legacy', true, false, true, true), false);
	assert.equal(resolveFirstBeatHitRow('legacy', false, true, true, true), true);
	/** legacy non-suppressed: accent OR ding OR firstBeat. */
	assert.equal(resolveFirstBeatHitRow('legacy', false, false, true, false), true);
	assert.equal(resolveFirstBeatHitRow('legacy', false, false, false, false), false);
	assert.equal(resolveFirstBeatHitRow('legacy', true, false, false, false), true);
}

/**
 * AGENT-14 incident regression: при `accentMapVersion=1, on0Ding=false, fa=true, supRow=false`
 * lane0 (policy='legacy') должен сыграть first-beat через `firstBeatEnabled`, а не
 * получить `false` через ложный переключатель на `explicit_ta_only`.
 */
function testLane0LegacyFirstBeatPlaysWithoutExplicitTa() {
	const policy: FirstBeatHitPolicy = resolveRuntimeFirstBeatPolicy(true, 0);
	assert.equal(policy, 'legacy');
	const result = resolveFirstBeatHitRow(policy, false, false, true, false);
	assert.equal(result, true, 'lane0 legacy должен дать hit при firstBeatEnabled=true');
}

/**
 * Polyrhythm ghost-Ta regression: lane>0 не должен получать Ta от accent на c0.
 */
function testLaneGtZeroExplicitTaOnlyIgnoresAccent() {
	const policy = resolveRuntimeFirstBeatPolicy(true, 1);
	assert.equal(policy, 'explicit_ta_only');
	const result = resolveFirstBeatHitRow(policy, true, false, true, false);
	assert.equal(result, false, 'lane>0 explicit_ta_only не должен играть Ta от accent');
}

/**
 * Contract-arity: `resolveFirstBeatHitRow` принимает ровно 5 аргументов.
 * Если в будущем к функции добавят 6-й аргумент (например, accentMapVersion) —
 * этот тест не упадёт, но typecheck CI выявит несоответствие.
 * Фиксируем arity через `function.length`.
 */
function testHelperArity() {
	assert.equal(resolveFirstBeatHitRow.length, 5, 'resolveFirstBeatHitRow должен принимать 5 аргументов');
	assert.equal(resolveRuntimeFirstBeatPolicy.length, 2, 'resolveRuntimeFirstBeatPolicy должен принимать 2 аргумента');
}

/**
 * Truth-table audio-UI parity: для одного и того же `(policy, on0Accent, on0Ding, fa, supRow)`
 * решение детерминированное и не зависит от порядка вызова или внешних факторов.
 */
function testDeterminism() {
	for (const policy of ['legacy', 'explicit_any', 'explicit_ta_only'] as FirstBeatHitPolicy[]) {
		for (const a of [false, true]) {
			for (const d of [false, true]) {
				for (const fb of [false, true]) {
					for (const s of [false, true]) {
						const r1 = resolveFirstBeatHitRow(policy, a, d, fb, s);
						const r2 = resolveFirstBeatHitRow(policy, a, d, fb, s);
						assert.equal(r1, r2);
					}
				}
			}
		}
	}
}

function run() {
	testResolvePolicyMonoAlwaysLegacy();
	testResolvePolicyPolyLaneRule();
	testExplicitTaOnlyIgnoresAccentAndFlag();
	testExplicitAnyCombinesAccentAndDing();
	testLegacyRespectsSuppressionAndFirstBeatFlag();
	testLane0LegacyFirstBeatPlaysWithoutExplicitTa();
	testLaneGtZeroExplicitTaOnlyIgnoresAccent();
	testHelperArity();
	testDeterminism();
	console.log('firstBeatPolicy tests passed');
}

run();
