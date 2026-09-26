import test from 'node:test';
import assert from 'node:assert/strict';
import { Consensus } from '../src/server/Consensus.js';

const create = () => new Consensus({ alignWindow: 0.2, jointHold: 2, eventLeadTime: 0.2, maxPeakAge: 1 });

test('consensus pairs one peak from each player, consumes the pair and schedules from reception', () => {
  const consensus = create();
  assert.equal(consensus.peak(0, 10, 10.1), null);
  const first = consensus.peak(1, 10.1, 10.5);
  assert.deepEqual(first, { starting: true, start: 10.7, until: 12.7 });
  assert.equal(consensus.peak(0, 10.15, 10.6), null, 'an already consumed partner peak cannot align again');
  const refresh = consensus.peak(1, 10.2, 10.7);
  assert.equal(refresh.starting, false, 'continued agreement holds the existing layer');
  assert.ok(Math.abs(refresh.until - 12.9) < 1e-10);
});

test('alignment accepts the window boundary but rejects wider differences', () => {
  const boundary = create();
  boundary.peak(0, 20, 20);
  assert.ok(boundary.peak(1, 20.2, 20.2));
  const outside = create();
  outside.peak(0, 20, 20);
  assert.equal(outside.peak(1, 20.201, 20.201), null);
});

test('invalid, duplicate and out-of-order peaks cannot trigger or poison later valid alignment', () => {
  const consensus = create();
  for (const [index, time, now] of [[-1, 1, 1], [2, 1, 1], [0, NaN, 1], [0, 1, Infinity], [0, 2, 1], [0, 1, 2.1]]) {
    assert.equal(consensus.peak(index, time, now), null);
  }
  assert.equal(consensus.peak(0, 1, 1), null);
  assert.equal(consensus.peak(0, 1, 1.01), null);
  assert.equal(consensus.peak(0, 0.9, 1.02), null);
  assert.ok(consensus.peak(1, 1.1, 1.1));
  assert.equal(consensus.peak(0, 1, 1.15), null);
  assert.equal(consensus.peak(1, 1.1, 1.15), null);
});

test('a stale pending peak cannot pair with a delayed but still admissible partner peak', () => {
  const consensus = create();
  consensus.peak(0, 0, 0);
  assert.equal(consensus.peak(1, 0.125, 1.125), null);
});

test('hold expires once, refresh postpones it, and reset removes pending evidence', () => {
  const consensus = create();
  consensus.peak(0, 1, 1);
  const first = consensus.peak(1, 1.1, 1.1);
  assert.equal(consensus.expire(first.until - 0.01), false);
  consensus.peak(0, 2, 2);
  const refresh = consensus.peak(1, 2.1, 2.1);
  assert.equal(consensus.expire(first.until), false);
  assert.equal(consensus.expire(refresh.until), true);
  assert.equal(consensus.expire(refresh.until + 1), false);

  consensus.peak(0, 8, 8);
  consensus.reset();
  assert.equal(consensus.peak(1, 8.1, 8.1), null);
  assert.equal(consensus.peak(0, 8.15, 8.15).starting, true);
});
