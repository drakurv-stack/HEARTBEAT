import assert from 'node:assert/strict';
import test from 'node:test';
import { appendPpgChunk } from './hrv-stream.mjs';

test('stitches overlapping waveform chunks without duplicate samples', () => {
  const first = appendPpgChunk([], {
    data: [0, 1, 2],
    timestamps: [0, 1 / 30, 2 / 30],
    confidence: [0.9, 0.9, 0.9],
    sampleRate: 30,
  });
  const second = appendPpgChunk(first.samples, {
    data: [1, 2, 3, 4],
    timestamps: [1 / 30, 2 / 30, 3 / 30, 4 / 30],
    confidence: [0.9, 0.9, 0.9, 0.9],
    sampleRate: 30,
  });

  assert.equal(second.added, 2);
  assert.deepEqual(
    second.samples.map((sample) => sample.timestamp),
    [0, 1 / 30, 2 / 30, 3 / 30, 4 / 30],
  );
});

test('starts a fresh contiguous segment after a timestamp gap', () => {
  const first = appendPpgChunk([], {
    data: [0, 1, 2],
    timestamps: [0, 1 / 30, 2 / 30],
    sampleRate: 30,
  });
  const second = appendPpgChunk(first.samples, {
    data: [3, 4, 5],
    timestamps: [1, 1 + 1 / 30, 1 + 2 / 30],
    sampleRate: 30,
  });

  assert.equal(second.resetForGap, true);
  assert.equal(second.samples.length, 3);
  assert.equal(second.samples[0].timestamp, 1);
});