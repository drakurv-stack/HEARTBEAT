const DEFAULT_MIN_BEATS = 30;
const MIN_SIGNAL_SECONDS = 45;
const UPSAMPLE_RATE = 250;

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const mean = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const standardDeviation = (values) => {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1),
  );
};

function emptyResult(overrides = {}) {
  return {
    ok: false,
    nBeats: 0,
    rejectedBeatCount: 0,
    totalBeatIntervals: 0,
    rejectedBeatFraction: 0,
    ...overrides,
  };
}

function linearResample(signal, timestamps, sampleRate) {
  const first = timestamps[0];
  const last = timestamps[timestamps.length - 1];
  const count = Math.floor((last - first) * sampleRate) + 1;
  const output = new Array(count);
  let sourceIndex = 0;

  for (let index = 0; index < count; index += 1) {
    const time = first + index / sampleRate;
    while (
      sourceIndex < timestamps.length - 2 &&
      timestamps[sourceIndex + 1] < time
    ) sourceIndex += 1;
    const span = timestamps[sourceIndex + 1] - timestamps[sourceIndex];
    const ratio = span > 0 ? (time - timestamps[sourceIndex]) / span : 0;
    output[index] =
      signal[sourceIndex] +
      ratio * (signal[sourceIndex + 1] - signal[sourceIndex]);
  }
  return output;
}

function cubicResample(signal, sourceRate, targetRate) {
  const count = Math.floor(((signal.length - 1) / sourceRate) * targetRate) + 1;
  const output = new Array(count);

  for (let index = 0; index < count; index += 1) {
    const position = index * sourceRate / targetRate;
    const center = Math.floor(position);
    const t = position - center;
    const p0 = signal[Math.max(0, center - 1)];
    const p1 = signal[center];
    const p2 = signal[Math.min(signal.length - 1, center + 1)];
    const p3 = signal[Math.min(signal.length - 1, center + 2)];
    output[index] = 0.5 * (
      2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t
    );
  }
  return output;
}

function biquad(type, cutoff, sampleRate) {
  const omega = 2 * Math.PI * cutoff / sampleRate;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const raw = type === 'lowpass'
    ? [(1 - cosine) / 2, 1 - cosine, (1 - cosine) / 2]
    : [(1 + cosine) / 2, -(1 + cosine), (1 + cosine) / 2];
  return {
    b0: raw[0] / a0,
    b1: raw[1] / a0,
    b2: raw[2] / a0,
    a1: (-2 * cosine) / a0,
    a2: (1 - alpha) / a0,
  };
}

function runBiquad(input, coefficients) {
  const { b0, b1, b2, a1, a2 } = coefficients;
  const output = new Array(input.length);
  const first = input[0];
  const steadyOutput =
    first * (b0 + b1 + b2) / (1 + a1 + a2);
  let z1 = steadyOutput - b0 * first;
  let z2 = b2 * first - a2 * steadyOutput;

  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    const filtered = b0 * value + z1;
    z1 = b1 * value - a1 * filtered + z2;
    z2 = b2 * value - a2 * filtered;
    output[index] = filtered;
  }
  return output;
}

function zeroPhaseBandpass(signal, sampleRate) {
  const sections = [
    biquad('highpass', 0.7, sampleRate),
    biquad('lowpass', 3, sampleRate),
  ];
  let output = signal;
  for (const section of sections) output = runBiquad(output, section);
  output = output.reverse();
  for (const section of sections) output = runBiquad(output, section);
  return output.reverse();
}

function integrateBand(powerSpectrum, sampleRate, minFrequency, maxFrequency) {
  const points = [];
  for (let index = 1; index < powerSpectrum.length; index += 1) {
    const frequency = index * sampleRate / (2 * (powerSpectrum.length - 1));
    if (frequency >= minFrequency && frequency <= maxFrequency) {
      points.push({ frequency, power: powerSpectrum[index] });
    }
  }
  let area = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    area +=
      (current.frequency - previous.frequency) *
      (previous.power + current.power) / 2;
  }
  return area;
}

function frequencyMetrics(intervals, intervalTimes, durationSeconds) {
  const result = {
    vlf: null,
    lf: null,
    hf: null,
    tp: null,
    lfhf: null,
    lfNu: null,
    hfNu: null,
    breathingRate: null,
  };
  if (intervals.length < 3 || intervalTimes.length !== intervals.length) return result;

  const start = intervalTimes[0];
  const end = intervalTimes[intervalTimes.length - 1];
  const sampleRate = 4;
  const count = Math.floor((end - start) * sampleRate);
  if (count < 16) return result;

  const resampled = new Array(count);
  let intervalIndex = 0;
  for (let index = 0; index < count; index += 1) {
    const time = start + index / sampleRate;
    while (
      intervalIndex < intervalTimes.length - 2 &&
      intervalTimes[intervalIndex + 1] < time
    ) intervalIndex += 1;
    const span = intervalTimes[intervalIndex + 1] - intervalTimes[intervalIndex];
    const ratio = span > 0
      ? (time - intervalTimes[intervalIndex]) / span
      : 0;
    resampled[index] =
      intervals[intervalIndex] +
      ratio * (intervals[intervalIndex + 1] - intervals[intervalIndex]);
  }

  const average = mean(resampled);
  const hann = resampled.map((_, index) =>
    0.5 - 0.5 * Math.cos(2 * Math.PI * index / (count - 1)),
  );
  const windowPower = hann.reduce((sum, value) => sum + value * value, 0);
  const spectrum = new Array(Math.floor(count / 2) + 1);
  for (let bin = 0; bin < spectrum.length; bin += 1) {
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < count; index += 1) {
      const centered = (resampled[index] - average) * hann[index];
      const angle = 2 * Math.PI * bin * index / count;
      real += centered * Math.cos(angle);
      imaginary -= centered * Math.sin(angle);
    }
    const oneSidedScale = bin === 0 || (count % 2 === 0 && bin === count / 2)
      ? 1
      : 2;
    spectrum[bin] =
      oneSidedScale * (real * real + imaginary * imaginary) /
      (sampleRate * windowPower);
  }

  const lf = integrateBand(spectrum, sampleRate, 0.04, 0.15);
  const hf = integrateBand(spectrum, sampleRate, 0.15, 0.4);
  const vlf = durationSeconds >= 300
    ? integrateBand(spectrum, sampleRate, 0.0033, 0.04)
    : null;
  const total = lf + hf + (vlf ?? 0);
  const normalized = lf + hf;
  let peakPower = 0;
  let peakFrequency = null;
  for (let bin = 1; bin < spectrum.length; bin += 1) {
    const frequency = bin * sampleRate / count;
    if (frequency >= 0.1 && frequency <= 0.4 && spectrum[bin] > peakPower) {
      peakPower = spectrum[bin];
      peakFrequency = frequency;
    }
  }
  return {
    vlf,
    lf,
    hf,
    tp: total,
    lfhf: hf > 0 ? lf / hf : null,
    lfNu: normalized > 0 ? 100 * lf / normalized : null,
    hfNu: normalized > 0 ? 100 * hf / normalized : null,
    breathingRate: peakFrequency == null ? null : peakFrequency * 60,
  };
}

export function computeHRV(signal, timestamps, opts = {}) {
  const minBeats = Math.max(DEFAULT_MIN_BEATS, opts.minBeats ?? DEFAULT_MIN_BEATS);
  const length = signal.length;
  const times = typeof timestamps === 'number'
    ? Array.from({ length }, (_, index) => index / timestamps)
    : timestamps;
  if (
    length < 3 ||
    !Array.isArray(times) ||
    times.length !== length ||
    !Number.isFinite(minBeats) ||
    minBeats < 3
  ) return emptyResult();

  for (let index = 0; index < length; index += 1) {
    if (
      !Number.isFinite(signal[index]) ||
      !Number.isFinite(times[index]) ||
      (index > 0 && times[index] <= times[index - 1])
    ) return emptyResult();
  }

  const durationSeconds = times[length - 1] - times[0];
  if (durationSeconds < MIN_SIGNAL_SECONDS) {
    return emptyResult({ signalDurationSeconds: durationSeconds });
  }

  const gaps = times.slice(1).map((time, index) => time - times[index]);
  const inputRate = 1 / median(gaps);
  if (!Number.isFinite(inputRate) || inputRate < 3 || inputRate > 120) {
    return emptyResult({ signalDurationSeconds: durationSeconds });
  }
  const largestAllowedGap = Math.max(0.06, 1.75 / inputRate);
  if (gaps.some((gap) => gap > largestAllowedGap)) {
    return emptyResult({ signalDurationSeconds: durationSeconds, hasGap: true });
  }

  const uniform = linearResample(signal, times, inputRate);
  const upsampled = cubicResample(uniform, inputRate, UPSAMPLE_RATE);
  const filtered = zeroPhaseBandpass(upsampled, UPSAMPLE_RATE);
  const peakSearchStart = UPSAMPLE_RATE;
  const peakSearchEnd = filtered.length - UPSAMPLE_RATE;
  if (peakSearchEnd <= peakSearchStart) {
    return emptyResult({ signalDurationSeconds: durationSeconds });
  }

  const center = median(filtered.slice(peakSearchStart, peakSearchEnd)) ?? 0;
  const absoluteDeviation = filtered
    .slice(peakSearchStart, peakSearchEnd)
    .map((value) => Math.abs(value - center));
  const amplitudeThreshold = median(absoluteDeviation) * 2.2;
  const minPeakDistance = Math.floor(UPSAMPLE_RATE / 3);
  const peaks = [];
  for (let index = peakSearchStart + 1; index < peakSearchEnd - 1; index += 1) {
    if (
      filtered[index] <= filtered[index - 1] ||
      filtered[index] < filtered[index + 1] ||
      filtered[index] - center <= amplitudeThreshold
    ) continue;
    const previous = peaks[peaks.length - 1];
    if (previous && index - previous.index < minPeakDistance) {
      if (filtered[index] > previous.value) {
        peaks[peaks.length - 1] = { index, value: filtered[index] };
      }
      continue;
    }
    peaks.push({ index, value: filtered[index] });
  }

  const peakTimes = peaks.map(({ index }) => {
    const before = filtered[index - 1];
    const peak = filtered[index];
    const after = filtered[index + 1];
    const denominator = before - 2 * peak + after;
    const offset = denominator === 0
      ? 0
      : Math.max(-0.5, Math.min(0.5, 0.5 * (before - after) / denominator));
    return times[0] + (index + offset) / UPSAMPLE_RATE;
  });

  const intervals = [];
  const rollingReference = [];
  for (let index = 1; index < peakTimes.length; index += 1) {
    const interval = (peakTimes[index] - peakTimes[index - 1]) * 1000;
    let valid = interval >= 400 && interval <= 1500;
    const reference = median(rollingReference.slice(-5));
    if (
      valid &&
      reference !== null &&
      Math.abs(interval - reference) > 0.2 * reference
    ) valid = false;
    intervals.push({ value: interval, valid });
    if (valid) rollingReference.push(interval);
  }

  const cleanIntervals = intervals
    .filter((interval) => interval.valid)
    .map((interval) => interval.value);
  const rejectedBeatCount = intervals.length - cleanIntervals.length;
  const rejectedBeatFraction = intervals.length
    ? rejectedBeatCount / intervals.length
    : 0;
  const resultBase = {
    nBeats: cleanIntervals.length,
    rejectedBeatCount,
    totalBeatIntervals: intervals.length,
    rejectedBeatFraction,
    signalDurationSeconds: durationSeconds,
    sampleRate: inputRate,
    rawIntervals: intervals.map(({ value, valid }) => ({
      value,
      valid,
    })),
  };
  if (cleanIntervals.length < minBeats) return emptyResult(resultBase);

  const averageInterval = mean(cleanIntervals);
  const sdnn = standardDeviation(cleanIntervals);
  const adjacentDifferences = [];
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index - 1].valid && intervals[index].valid) {
      adjacentDifferences.push(intervals[index].value - intervals[index - 1].value);
    }
  }
  if (!adjacentDifferences.length) return emptyResult(resultBase);
  const rmssd = Math.sqrt(mean(adjacentDifferences.map((value) => value ** 2)));
  const differenceMean = mean(adjacentDifferences);
  const sdsd = standardDeviation(adjacentDifferences);
  const pnn = (threshold) =>
    100 * adjacentDifferences.filter((value) => Math.abs(value) > threshold).length /
    adjacentDifferences.length;
  const sd1 = sdsd / Math.SQRT2;
  const sd2 = Math.sqrt(Math.max(0, 2 * sdnn ** 2 - 0.5 * sdsd ** 2));
  let longestRun = [];
  let currentRun = [];
  intervals.forEach((interval, index) => {
    if (interval.valid) {
      currentRun.push({ value: interval.value, time: peakTimes[index + 1] });
      if (currentRun.length > longestRun.length) longestRun = [...currentRun];
    } else {
      currentRun = [];
    }
  });
  const frequency = frequencyMetrics(
    longestRun.map(({ value }) => value),
    longestRun.map(({ time }) => time),
    durationSeconds,
  );

  return {
    ok: true,
    ...resultBase,
    confidence: 1 - rejectedBeatFraction,
    meanHR: 60_000 / averageInterval,
    meanIBI: averageInterval,
    sdnn,
    rmssd,
    sdsd,
    pnn50: pnn(50),
    pnn20: pnn(20),
    sd1,
    sd2,
    sd1sd2: sd2 > 0 ? sd1 / sd2 : null,
    differenceMean,
    ...frequency,
  };
}