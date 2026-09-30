import test from 'node:test';
import assert from 'node:assert/strict';
import params from '../src/shared/params.js';
import { computeVoiceParams } from '../src/shared/mapping.js';
import { playerRules } from '../src/shared/rules.js';

const still = { tilt: 0.5, intensity: 0 };
const moved = { tilt: 1, intensity: 1 };
// Does this actor's gesture change my voice's parameter in the mapping?
function changes(phase, me, actor, key, global = {}) {
  const own = actor === 'you' ? moved : still;
  const partner = actor === 'partner' ? moved : still;
  return computeVoiceParams(phase, me, own, partner, global)[key]
    !== computeVoiceParams(phase, me, still, still, global)[key];
}
const KEYS = { pitch: 'midi', rhythm: 'density', brightness: 'cutoff' };

test('every rehearsed phase has a rule for both players; idle and latency test do not', () => {
  for (const phase of params.phaseOrder) {
    for (const me of [0, 1]) {
      assert.ok(playerRules(phase, me)?.rows.length >= 2);
    }
  }
  assert.equal(playerRules('idle', 0), null);
  assert.equal(playerRules('latency-test', 1), null);
});

test('each shown rule matches the mapping, including the division swap', () => {
  for (const phase of params.phaseOrder) {
    for (const me of [0, 1]) {
      for (const divisionSwap of [false, true]) {
        for (const { actor, effect } of playerRules(phase, me, divisionSwap).rows) {
          if (effect in KEYS) {
            assert.ok(changes(phase, me, actor, KEYS[effect], { divisionSwap }), `${phase} ${me} ${actor} ${effect}`);
          }
        }
      }
    }
  }
});

test('division tells exactly one player to tilt and the other to shake', () => {
  for (const divisionSwap of [false, true]) {
    const actors = [0, 1].map(me => playerRules('division', me, divisionSwap).rows.find(row => row.actor === 'you').gesture);
    assert.deepEqual(actors.toSorted(), ['shake', 'tilt']);
    assert.equal(actors[divisionSwap ? 1 : 0], 'tilt');
  }
});
