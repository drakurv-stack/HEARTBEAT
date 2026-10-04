export type OpticalMetric = {
  value: number;
  confidence: number;
  unit: 'bpm' | 'ms';
};

export type OpticalPulseSample = {
  timestampMs: number;
  red: number;
  green: number;
  blue: number;
  skinCoverage: number;
};

export type OpticalPulseEstimate = {
  heartRate: OpticalMetric;
  hrvSdnn: OpticalMetric;
  hrvRmssd: OpticalMetric;
  updatedAtMs: number;
  sampleDurationSeconds: number;
  beatCount: number;
};

export function extractSkinRgb(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  timestampMs: number,
): OpticalPulseSample | null;

export function computeHrvFromWaveform(
  signal: readonly number[],
  timestampsSeconds: readonly number[],
  minBeats?: number,
): {
  meanHeartRate: number;
  meanIntervalMs: number;
  sdnn: number;
  rmssd: number;
  confidence: number;
  beatCount: number;
} | null;

export function estimateCameraHrv(
  samples: readonly OpticalPulseSample[],
): OpticalPulseEstimate | null;