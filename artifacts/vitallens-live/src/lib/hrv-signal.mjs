import { computeHRV } from './hrv-compute.mjs';

const MIN_CAPTURE_SECONDS = 45;
const MAX_CAPTURE_SECONDS = 60;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1),
  );
}

/**
 * Read average RGB values from a central cheek region. Pixel data is examined
 * locally and only these short-lived means should be retained in memory.
 */
export function extractSkinRgb(rgba, width, height, timestampMs) {
  if (
    !rgba ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 8 ||
    height < 8 ||
    rgba.length < width * height * 4 ||
    !Number.isFinite(timestampMs)
  ) return null;

  const left = Math.floor(width * 0.32);
  const right = Math.ceil(width * 0.68);
  const top = Math.floor(height * 0.36);
  const bottom = Math.ceil(height * 0.66);
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  let inspected = 0;

  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      const offset = (y * width + x) * 4;
      const r = rgba[offset];
      const g = rgba[offset + 1];
      const b = rgba[offset + 2];
      inspected += 1;
      if (
        r < 35 ||
        g < 25 ||
        b < 15 ||
        r > 245 ||
        g > 245 ||
        b > 245 ||
        r < g * 0.82 ||
        g < b * 0.72 ||
        r - b < 5
      ) continue;
      red += r;
      green += g;
      blue += b;
      count += 1;
    }
  }

  const skinCoverage = inspected ? count / inspected : 0;
  if (count < 12 || skinCoverage < 0.04) return null;
  return {
    timestampMs,
    red: red / count,
    green: green / count,
    blue: blue / count,
    skinCoverage,
  };
}

/**
 * Calculate time-domain HRV from a pulse waveform and its sample timestamps.
 * The implementation follows the uploaded no-dependency browser algorithm:
 * band-pass with moving averages, peak detection, then pulse-to-pulse intervals.
 */
export function computeHrvFromWaveform(signal, timestampsSeconds, minBeats = 20) {
  const length = signal.length;
  if (
    length < 80 ||
    timestampsSeconds.length !== length ||
    !Number.isFinite(minBeats) ||
    minBeats < 3
  ) return null;

  const elapsedSeconds = timestampsSeconds[length - 1] - timestampsSeconds[0];
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < MIN_CAPTURE_SECONDS) return null;
  const fps = (length - 1) / elapsedSeconds;
  if (!Number.isFinite(fps) || fps < 4 || fps > 30) return null;

  const sampleGaps = timestampsSeconds.slice(1).map((time, index) =>
    time - timestampsSeconds[index],
  );
  const medianGap = median(sampleGaps);
  if (
    medianGap === null ||
    sampleGaps.some((gap) => !Number.isFinite(gap) || gap <= 0 || gap > 0.45)
  ) return null;

  const movingAverage = (values, width) => {
    const output = new Array(values.length);
    const halfWindow = Math.max(1, Math.floor(width / 2));
    let sum = 0;
    let count = 0;
    let low = 0;
    let high = -1;
    for (let index = 0; index < values.length; index += 1) {
      const desiredHigh = Math.min(values.length - 1, index + halfWindow);
      while (high < desiredHigh) {
        high += 1;
        sum += values[high];
        count += 1;
      }
      while (low < index - halfWindow) {
        sum -= values[low];
        low += 1;
        count -= 1;
      }
      output[index] = sum / count;
    }
    return output;
  };

  const fast = movingAverage(signal, Math.max(2, Math.round(fps / 3)));
  const slow = movingAverage(signal, Math.max(3, Math.round(fps / 0.7)));
  const filtered = fast.map((value, index) => value - slow[index]);
  const amplitude = Math.sqrt(mean(filtered.map((value) => value ** 2)));
  if (!Number.isFinite(amplitude) || amplitude < 0.00001) return null;

  const minimumPeakDistance = Math.round(0.33 * fps);
  const peaks = [];
  for (let index = 1; index < length - 1; index += 1) {
    if (
      filtered[index] <= 0.2 * amplitude ||
      filtered[index] <= filtered[index - 1] ||
      filtered[index] < filtered[index + 1]
    ) continue;
    const previous = peaks[peaks.length - 1];
    if (previous && index - previous.index < minimumPeakDistance) {
      if (filtered[index] > previous.value) {
        peaks[peaks.length - 1] = { index, value: filtered[index] };
      }
    } else {
      peaks.push({ index, value: filtered[index] });
    }
  }

  const peakTimes = peaks.map(({ index }) => {
    const before = filtered[index - 1];
    const peak = filtered[index];
    const after = filtered[index + 1];
    const denominator = before - 2 * peak + after;
    const offset = denominator !== 0
      ? 0.5 * (before - after) / denominator
      : 0;
    const sampleGap = timestampsSeconds[index + 1] - timestampsSeconds[index];
    return timestampsSeconds[index] + offset * sampleGap;
  });

  const intervals = [];
  for (let index = 1; index < peakTimes.length; index += 1) {
    const interval = (peakTimes[index] - peakTimes[index - 1]) * 1000;
    if (interval >= 300 && interval <= 1500) intervals.push(interval);
  }
  const medianInterval = median(intervals);
  if (medianInterval === null) return null;

  const cleanIntervals = intervals.filter((interval) =>
    Math.abs(interval - medianInterval) <= 0.25 * medianInterval,
  );
  if (
    cleanIntervals.length < minBeats ||
    cleanIntervals.length / intervals.length < 0.65
  ) return null;

  const averageInterval = mean(cleanIntervals);
  const sdnn = standardDeviation(cleanIntervals);
  const differences = [];
  for (let index = 1; index < intervals.length; index += 1) {
    const previous = intervals[index - 1];
    const current = intervals[index];
    if (
      Math.abs(previous - medianInterval) <= 0.25 * medianInterval &&
      Math.abs(current - medianInterval) <= 0.25 * medianInterval
    ) differences.push(current - previous);
  }
  if (!differences.length) return null;

  const rmssd = Math.sqrt(mean(differences.map((difference) => difference ** 2)));
  const variation = sdnn / averageInterval;
  const cleanRatio = cleanIntervals.length / intervals.length;
  const confidence = Math.max(0, Math.min(1, cleanRatio * (1 - variation * 2)));
  if (
    !Number.isFinite(sdnn) ||
    !Number.isFinite(rmssd) ||
    !Number.isFinite(confidence) ||
    confidence < 0.65
  ) return null;

  return {
    meanHeartRate: 60_000 / averageInterval,
    meanIntervalMs: averageInterval,
    sdnn,
    rmssd,
    confidence,
    beatCount: cleanIntervals.length,
  };
}

/**
 * Estimate optical pulse-to-pulse variability from local camera colour samples.
 * Returns null until at least 30 seconds of clean data and enough detected beats
 * are available. The values are not ECG R-R measurements.
 */
export function estimateCameraHrv(inputSamples) {
  if (!Array.isArray(inputSamples) || inputSamples.length < 80) return null;
  const latest = inputSamples[inputSamples.length - 1]?.timestampMs;
  if (!Number.isFinite(latest)) return null;

  const samples = inputSamples.filter((sample) =>
    Number.isFinite(sample.timestampMs) &&
    sample.timestampMs >= latest - MAX_CAPTURE_SECONDS * 1000,
  );
  if (
    samples.length < 80 ||
    samples.some((sample) =>
      !Number.isFinite(sample.red) ||
      !Number.isFinite(sample.green) ||
      !Number.isFinite(sample.blue) ||
      !Number.isFinite(sample.skinCoverage) ||
      sample.skinCoverage < 0.04
    )
  ) return null;

  const durationSeconds =
    (samples[samples.length - 1].timestampMs - samples[0].timestampMs) / 1000;
  if (durationSeconds < MIN_CAPTURE_SECONDS) return null;

  const brightness = samples.map((sample) =>
    (sample.red + sample.green + sample.blue) / 3,
  );
  for (let index = 0; index < brightness.length; index += 1) {
    const current = brightness[index];
    if (current < 35 || current > 245) return null;
    if (index > 0) {
      const previous = brightness[index - 1];
      if (Math.abs(current - previous) / previous > 0.35) return null;
    }
  }

  const averageRed = mean(samples.map((sample) => sample.red));
  const averageGreen = mean(samples.map((sample) => sample.green));
  const averageBlue = mean(samples.map((sample) => sample.blue));
  if (averageRed < 1 || averageGreen < 1 || averageBlue < 1) return null;

  const x = samples.map((sample) =>
    3 * ((sample.red - averageRed) / averageRed) -
    2 * ((sample.green - averageGreen) / averageGreen),
  );
  const y = samples.map((sample) =>
    1.5 * ((sample.red - averageRed) / averageRed) +
    ((sample.green - averageGreen) / averageGreen) -
    1.5 * ((sample.blue - averageBlue) / averageBlue),
  );
  const yDeviation = standardDeviation(y);
  if (yDeviation < 0.00001) return null;
  const alpha = standardDeviation(x) / yDeviation;
  const waveform = x.map((value, index) => value - alpha * y[index]);
  const result = computeHRV(
    waveform,
    samples.map((sample) => sample.timestampMs / 1000),
  );
  if (!result.ok) return null;

  return {
    heartRate: {
      value: result.meanHeartRate,
      confidence: result.confidence,
      unit: 'bpm',
    },
    hrvSdnn: {
      value: result.sdnn,
      confidence: result.confidence,
      unit: 'ms',
    },
    hrvRmssd: {
      value: result.rmssd,
      confidence: result.confidence,
      unit: 'ms',
    },
    updatedAtMs: latest,
    sampleDurationSeconds: durationSeconds,
    beatCount: result.nBeats,
    metrics: result,
    source: 'camera-colour',
  };
}