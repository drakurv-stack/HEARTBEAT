const DEFAULT_WINDOW_SECONDS = 60;

function latestContinuousSegment(samples, sampleRate) {
  if (samples.length < 2) return samples;
  const maximumGapSeconds = Math.max(0.06, 2.25 / sampleRate);
  let segmentStart = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].timestamp - samples[index - 1].timestamp > maximumGapSeconds) {
      segmentStart = index;
    }
  }
  return samples.slice(segmentStart);
}

/**
 * Append a VitalLens PPG chunk without duplicating overlapping timestamps.
 * A discontinuity starts a new segment rather than synthesizing missing pulses.
 */
export function appendPpgChunk(existing, waveform, windowSeconds = DEFAULT_WINDOW_SECONDS) {
  if (
    !waveform ||
    !Array.isArray(waveform.data) ||
    !Array.isArray(waveform.timestamps) ||
    waveform.data.length !== waveform.timestamps.length ||
    !Number.isFinite(waveform.sampleRate) ||
    waveform.sampleRate <= 0
  ) {
    return { samples: existing, added: 0, resetForGap: false };
  }

  const confidence = Array.isArray(waveform.confidence)
    ? waveform.confidence
    : [];
  const incoming = waveform.data
    .map((value, index) => ({
      timestamp: waveform.timestamps[index],
      value,
      confidence: confidence[index] ?? null,
    }))
    .filter((sample) =>
      Number.isFinite(sample.timestamp) &&
      Number.isFinite(sample.value),
    )
    .sort((left, right) => left.timestamp - right.timestamp);

  if (incoming.length < 2) {
    return { samples: existing, added: 0, resetForGap: false };
  }

  const additions = [];
  let previousTimestamp = existing.length
    ? existing[existing.length - 1].timestamp
    : -Infinity;
  for (const sample of incoming) {
    if (sample.timestamp <= previousTimestamp + 1e-6) continue;
    additions.push(sample);
    previousTimestamp = sample.timestamp;
  }
  if (!additions.length) {
    return { samples: existing, added: 0, resetForGap: false };
  }

  const expectedGapSeconds = 1 / waveform.sampleRate;
  const maxGapSeconds = Math.max(0.06, 2.25 * expectedGapSeconds);
  const startsAfterGap =
    existing.length > 0 &&
    additions[0].timestamp - existing[existing.length - 1].timestamp > maxGapSeconds;
  const joined = startsAfterGap
    ? additions
    : [...existing, ...additions];
  const continuous = latestContinuousSegment(joined, waveform.sampleRate);
  const latestTimestamp = continuous[continuous.length - 1]?.timestamp;
  const oldestAllowed = latestTimestamp == null
    ? -Infinity
    : latestTimestamp - windowSeconds;
  const samples = continuous.filter((sample) => sample.timestamp >= oldestAllowed);

  return {
    samples,
    added: additions.length,
    resetForGap: startsAfterGap || continuous.length !== joined.length,
  };
}

export function toSignalArrays(samples) {
  return {
    signal: samples.map((sample) => sample.value),
    timestamps: samples.map((sample) => sample.timestamp),
  };
}