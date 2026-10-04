/**
 * Dependency-free camera pulse HRV implementation adapted from the user's
 * uploaded hrv.js. Timestamps are seconds; time-domain results are in ms and
 * frequency powers are in ms².
 */
export function computeHRV(signal, timestamps, opts = {}) {
  const minBeats = opts.minBeats ?? 20;
  const n = signal.length;
  const ts = typeof timestamps === 'number'
    ? Array.from({ length: n }, (_, index) => index / timestamps)
    : timestamps;
  const fail = { ok: false, nBeats: 0 };
  if (n < 30 || ts.length !== n) return fail;

  const elapsed = ts[n - 1] - ts[0];
  const fps = (n - 1) / elapsed;
  if (!Number.isFinite(fps) || fps <= 0) return fail;

  const movingAverage = (values, width) => {
    const output = new Array(values.length);
    const halfWindow = Math.max(1, Math.floor(width / 2));
    let sum = 0;
    let count = 0;
    let low = 0;
    let high = -1;
    for (let index = 0; index < values.length; index += 1) {
      while (high < Math.min(values.length - 1, index + halfWindow)) {
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

  const fast = movingAverage(signal, Math.round(fps / 3));
  const slow = movingAverage(signal, Math.round(fps / 0.7));
  const filtered = fast.map((value, index) => value - slow[index]);

  const deviation = Math.sqrt(filtered.reduce((sum, value) => sum + value * value, 0) / n);
  const minimumPeakDistance = Math.round(0.33 * fps);
  const peaks = [];
  for (let index = 1; index < n - 1; index += 1) {
    if (
      filtered[index] > filtered[index - 1] &&
      filtered[index] >= filtered[index + 1] &&
      filtered[index] > 0.2 * deviation
    ) {
      const previous = peaks[peaks.length - 1];
      if (previous && index - previous.index < minimumPeakDistance) {
        if (filtered[index] > previous.value) {
          peaks[peaks.length - 1] = { index, value: filtered[index] };
        }
      } else {
        peaks.push({ index, value: filtered[index] });
      }
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
    return ts[index] + offset * (ts[index + 1] - ts[index]);
  });

  let intervals = [];
  for (let index = 1; index < peakTimes.length; index += 1) {
    intervals.push((peakTimes[index] - peakTimes[index - 1]) * 1000);
  }
  intervals = intervals.filter((interval) => interval >= 300 && interval <= 1500);
  if (!intervals.length) return fail;

  const sortedIntervals = [...intervals].sort((left, right) => left - right);
  const medianInterval = sortedIntervals[Math.floor(sortedIntervals.length / 2)];
  const isClean = (interval) => Math.abs(interval - medianInterval) <= 0.25 * medianInterval;
  const cleanIntervals = intervals.filter(isClean);
  if (cleanIntervals.length < minBeats) {
    return { ...fail, nBeats: cleanIntervals.length };
  }

  const mean = cleanIntervals.reduce((sum, interval) => sum + interval, 0) / cleanIntervals.length;
  const sdnn = Math.sqrt(
    cleanIntervals.reduce((sum, interval) => sum + (interval - mean) ** 2, 0) /
      (cleanIntervals.length - 1),
  );
  const differences = [];
  for (let index = 1; index < intervals.length; index += 1) {
    if (isClean(intervals[index]) && isClean(intervals[index - 1])) {
      differences.push(intervals[index] - intervals[index - 1]);
    }
  }
  const differenceMean = differences.length
    ? differences.reduce((sum, difference) => sum + difference, 0) / differences.length
    : 0;
  const rmssd = differences.length
    ? Math.sqrt(differences.reduce((sum, difference) => sum + difference ** 2, 0) / differences.length)
    : null;
  const sdsd = differences.length > 1
    ? Math.sqrt(differences.reduce((sum, difference) => sum + (difference - differenceMean) ** 2, 0) / (differences.length - 1))
    : null;
  const percentage = (threshold) => differences.length
    ? 100 * differences.filter((difference) => Math.abs(difference) > threshold).length / differences.length
    : null;
  const sd1 = sdsd == null ? null : sdsd / Math.SQRT2;
  const sd2 = sdsd == null ? null : Math.sqrt(Math.max(0, 2 * sdnn ** 2 - 0.5 * sdsd ** 2));

  let frequency = {
    vlf: null,
    lf: null,
    hf: null,
    tp: null,
    lfhf: null,
    lfNu: null,
    hfNu: null,
    breathingRate: null,
  };
  const beatTimes = [];
  const beatIntervals = [];
  for (let index = 1; index < peakTimes.length; index += 1) {
    const interval = (peakTimes[index] - peakTimes[index - 1]) * 1000;
    if (interval >= 300 && interval <= 1500 && isClean(interval)) {
      beatTimes.push(peakTimes[index]);
      beatIntervals.push(interval);
    }
  }

  if (
    beatTimes.length >= 20 &&
    beatTimes[beatTimes.length - 1] - beatTimes[0] >= 30
  ) {
    const sampleRate = 4;
    const count = Math.floor((beatTimes[beatTimes.length - 1] - beatTimes[0]) * sampleRate);
    const resampled = new Array(count);
    let intervalIndex = 0;
    for (let index = 0; index < count; index += 1) {
      const time = beatTimes[0] + index / sampleRate;
      while (intervalIndex < beatTimes.length - 2 && beatTimes[intervalIndex + 1] < time) {
        intervalIndex += 1;
      }
      const weight =
        (time - beatTimes[intervalIndex]) /
        (beatTimes[intervalIndex + 1] - beatTimes[intervalIndex]);
      resampled[index] =
        beatIntervals[intervalIndex] +
        weight * (beatIntervals[intervalIndex + 1] - beatIntervals[intervalIndex]);
    }

    const resampledMean = resampled.reduce((sum, value) => sum + value, 0) / count;
    const windowed = resampled.map((value, index) =>
      (value - resampledMean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / (count - 1))),
    );
    const windowPower = resampled.reduce(
      (sum, _value, index) => sum + (0.5 - 0.5 * Math.cos(2 * Math.PI * index / (count - 1))) ** 2,
      0,
    );
    const band = { vlf: 0, lf: 0, hf: 0 };
    let peakPower = 0;
    let peakFrequency = null;
    for (let frequencyHz = 0.0033; frequencyHz < 0.4; frequencyHz += 0.005) {
      let real = 0;
      let imaginary = 0;
      for (let index = 0; index < count; index += 1) {
        const angle = 2 * Math.PI * frequencyHz * index / sampleRate;
        real += windowed[index] * Math.cos(angle);
        imaginary -= windowed[index] * Math.sin(angle);
      }
      const power = (real * real + imaginary * imaginary) / (sampleRate * windowPower) * 0.005;
      if (frequencyHz < 0.04) band.vlf += power;
      else if (frequencyHz < 0.15) band.lf += power;
      else band.hf += power;
      if (frequencyHz >= 0.1 && power > peakPower) {
        peakPower = power;
        peakFrequency = frequencyHz;
      }
    }
    const totalPower = band.vlf + band.lf + band.hf;
    const normalizedPower = band.lf + band.hf;
    frequency = {
      vlf: band.vlf,
      lf: band.lf,
      hf: band.hf,
      tp: totalPower,
      lfhf: band.hf ? band.lf / band.hf : null,
      lfNu: normalizedPower ? 100 * band.lf / normalizedPower : null,
      hfNu: normalizedPower ? 100 * band.hf / normalizedPower : null,
      breathingRate: peakFrequency ? peakFrequency * 60 : null,
    };
  }

  return {
    ok: true,
    nBeats: cleanIntervals.length,
    meanHR: 60000 / mean,
    meanIBI: mean,
    sdnn,
    rmssd,
    sdsd,
    pnn50: percentage(50),
    pnn20: percentage(20),
    sd1,
    sd2,
    sd1sd2: sd2 ? sd1 / sd2 : null,
    ...frequency,
  };
}