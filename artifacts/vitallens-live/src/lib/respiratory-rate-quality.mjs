export const RESPIRATORY_RATE_MIN_CONFIDENCE_PERCENT = 40;
export const RESPIRATORY_RATE_MIN_DISPLAY_BPM = 6;
export const RESPIRATORY_RATE_MAX_DISPLAY_BPM = 60;

export function getRespiratoryRateRejectionReason(metric) {
  if (!metric) return null;
  if (!Number.isFinite(metric.value) || !Number.isFinite(metric.confidence)) {
    return 'invalid';
  }

  const confidencePercent = metric.confidence <= 1
    ? metric.confidence * 100
    : metric.confidence;
  if (confidencePercent < 0 || confidencePercent > 100) return 'invalid';
  if (confidencePercent < RESPIRATORY_RATE_MIN_CONFIDENCE_PERCENT) {
    return 'low-confidence';
  }
  if (
    metric.value < RESPIRATORY_RATE_MIN_DISPLAY_BPM ||
    metric.value > RESPIRATORY_RATE_MAX_DISPLAY_BPM
  ) {
    return 'out-of-range';
  }
  return null;
}

export function isUsableRespiratoryRate(metric) {
  return Boolean(metric) && getRespiratoryRateRejectionReason(metric) === null;
}