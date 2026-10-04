import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateCameraHrv, extractSkinRgb } from './hrv-signal.mjs';

function makeSamples({
  seconds = 30,
  sampleRate = 8,
  coverage = 0.45,
  baseHeartRate = 75,
  amplitude = 2,
  gap = null,
} = {}) {
  const samples = [];
  let phase = 0;
  const count = Math.floor(seconds * sampleRate) + 1;
  for (let index = 0; index < count; index += 1) {
    const time = index / sampleRate;
    const currentHeartRate = baseHeartRate + 3 * Math.sin(2 * Math.PI * 0.08 * time);
    phase += 2 * Math.PI * (currentHeartRate / 60) / sampleRate;
    if (gap && index >= gap.start && index <= gap.end) continue;
    samples.push({
      timestampMs: 100_000 + time * 1000,
      red: 130,
      green: 120 + amplitude * Math.sin(phase),
      blue: 100,
      skinCoverage: coverage,
    });
  }
  return samples;
}

test('calculates camera pulse rate, SDNN, and RMSSD from a clean waveform', () => {
  const estimate = estimateCameraHrv(makeSamples());
  assert.ok(estimate);
  assert.ok(estimate.heartRate.value >= 65 && estimate.heartRate.value <= 85);
  assert.ok(estimate.hrvSdnn.value > 0);
  assert.ok(Number.isFinite(estimate.hrvRmssd.value));
  assert.equal(estimate.hrvSdnn.unit, 'ms');
  assert.ok(estimate.beatCount >= 20);
});

test('waits for the minimum clean capture duration', () => {
  assert.equal(estimateCameraHrv(makeSamples({ seconds: 12 })), null);
});

test('rejects a window with a long missing-frame gap', () => {
  assert.equal(
    estimateCameraHrv(makeSamples({ gap: { start: 75, end: 80 } })),
    null,
  );
});

test('rejects a flat signal without measurable pulse peaks', () => {
  assert.equal(estimateCameraHrv(makeSamples({ amplitude: 0 })), null);
});

test('rejects low skin coverage and extracts local cheek-colour samples', () => {
  assert.equal(estimateCameraHrv(makeSamples({ coverage: 0.02 })), null);

  const width = 80;
  const height = 60;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < rgba.length; index += 4) {
    rgba[index] = 130;
    rgba[index + 1] = 95;
    rgba[index + 2] = 65;
    rgba[index + 3] = 255;
  }
  const sample = extractSkinRgb(rgba, width, height, 1000);
  assert.ok(sample);
  assert.ok(sample.skinCoverage >= 0.04);
  assert.equal(sample.timestampMs, 1000);
});