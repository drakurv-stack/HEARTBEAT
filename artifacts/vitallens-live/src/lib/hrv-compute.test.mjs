import assert from 'node:assert/strict';
import test from 'node:test';
import { computeHRV } from './hrv-compute.mjs';

function makeKnownIntervalSignal(seconds = 60, sampleRate = 30) {
  const intervals = [];
  const peakTimes = [1];
  while (peakTimes[peakTimes.length - 1] < seconds - 1) {
    const beat = intervals.length;
    const interval =
      850 +
      75 * Math.sin((2 * Math.PI * beat) / 7) +
      22 * Math.sin((2 * Math.PI * beat) / 3);
    intervals.push(interval);
    peakTimes.push(peakTimes[peakTimes.length - 1] + interval / 1000);
  }

  const signal = [];
  const timestamps = [];
  const count = Math.floor(seconds * sampleRate) + 1;
  for (let index = 0; index < count; index += 1) {
    const time = index / sampleRate;
    let pulse = 0;
    for (const peakTime of peakTimes) {
      const distance = time - peakTime;
      if (Math.abs(distance) > 0.2) continue;
      pulse += Math.exp(-(distance * distance) / (2 * 0.05 ** 2));
    }
    signal.push(pulse + 0.12 * Math.sin(2 * Math.PI * 0.2 * time));
    timestamps.push(time);
  }

  const measuredIntervals = peakTimes
    .slice(1)
    .map((time, index) => (time - peakTimes[index]) * 1000);
  const average = measuredIntervals.reduce((sum, value) => sum + value, 0) /
    measuredIntervals.length;
  const trueSdnn = Math.sqrt(
    measuredIntervals.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (measuredIntervals.length - 1),
  );
  const differences = measuredIntervals.slice(1)
    .map((value, index) => value - measuredIntervals[index]);
  const trueRmssd = Math.sqrt(
    differences.reduce((sum, value) => sum + value ** 2, 0) / differences.length,
  );
  return { signal, timestamps, trueSdnn, trueRmssd };
}

test('recovers known SDNN and RMSSD from a synthetic 60-second PPG waveform', () => {
  const { signal, timestamps, trueSdnn, trueRmssd } = makeKnownIntervalSignal();
  const result = computeHRV(signal, timestamps);

  assert.equal(result.ok, true);
  assert.ok(result.nBeats >= 30);
  for (const key of ['meanIBI', 'sdnn', 'rmssd', 'sdsd', 'pnn50', 'pnn20', 'lf', 'hf', 'tp']) {
    assert.ok(Number.isFinite(result[key]), `${key} should be finite`);
  }
  assert.equal(result.vlf, null, 'VLF is withheld for a window under five minutes');
  assert.ok(Math.abs(result.sdnn - trueSdnn) / trueSdnn <= 0.1);
  assert.ok(Math.abs(result.rmssd - trueRmssd) / trueRmssd <= 0.1);
});

test('returns an unsuccessful result for a signal shorter than 45 seconds', () => {
  const result = computeHRV([1, 2, 3], [0, 0.1, 0.2]);
  assert.equal(result.ok, false);
});

test('rejects non-uniform input with a missing timestamp segment', () => {
  const { signal, timestamps } = makeKnownIntervalSignal();
  signal.splice(800, 1);
  timestamps.splice(800, 1);
  const result = computeHRV(signal, timestamps);
  assert.equal(result.ok, false);
  assert.equal(result.hasGap, true);
});

test('returns an unsuccessful result for mismatched timestamps', () => {
  const { signal, timestamps } = makeKnownIntervalSignal();
  const result = computeHRV(signal, timestamps.slice(1));
  assert.equal(result.ok, false);
});