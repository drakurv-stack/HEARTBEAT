import assert from 'node:assert/strict';
import test from 'node:test';
import { computeHRV } from './hrv-compute.mjs';

function makePulseSignal(seconds = 40, sampleRate = 8) {
  const signal = [];
  const timestamps = [];
  let phase = 0;
  const count = Math.floor(seconds * sampleRate) + 1;

  for (let index = 0; index < count; index += 1) {
    const time = index / sampleRate;
    const heartRate = 74 + 4 * Math.sin(2 * Math.PI * 0.1 * time);
    phase += 2 * Math.PI * heartRate / 60 / sampleRate;
    signal.push(120 + 2 * Math.sin(phase));
    timestamps.push(time);
  }

  return { signal, timestamps };
}

test('calculates finite time and frequency metrics from a clean pulse waveform', () => {
  const { signal, timestamps } = makePulseSignal();
  const result = computeHRV(signal, timestamps);

  assert.equal(result.ok, true);
  assert.ok(result.nBeats >= 20);
  for (const key of [
    'meanIBI', 'sdnn', 'rmssd', 'sdsd', 'pnn50', 'pnn20',
    'sd1', 'sd2', 'sd1sd2', 'vlf', 'lf', 'hf', 'tp', 'lfhf', 'lfNu', 'hfNu',
  ]) {
    assert.ok(Number.isFinite(result[key]), `${key} should be finite`);
  }
});

test('returns an unsuccessful result for a signal with too few samples', () => {
  const result = computeHRV([1, 2, 3], [0, 0.1, 0.2]);
  assert.equal(result.ok, false);
});

test('returns an unsuccessful result for mismatched timestamps', () => {
  const { signal, timestamps } = makePulseSignal();
  const result = computeHRV(signal, timestamps.slice(1));
  assert.equal(result.ok, false);
});