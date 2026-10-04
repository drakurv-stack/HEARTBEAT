export type RespiratoryRateRejectionReason =
  | 'low-confidence'
  | 'out-of-range'
  | 'invalid';

export interface RespiratoryRateQualityInput {
  value: number | null;
  confidence: number | null;
}

export declare const RESPIRATORY_RATE_MIN_CONFIDENCE_PERCENT: number;
export declare const RESPIRATORY_RATE_MIN_DISPLAY_BPM: number;
export declare const RESPIRATORY_RATE_MAX_DISPLAY_BPM: number;

export declare function getRespiratoryRateRejectionReason(
  metric: RespiratoryRateQualityInput | null | undefined,
): RespiratoryRateRejectionReason | null;

export declare function isUsableRespiratoryRate(
  metric: RespiratoryRateQualityInput | null | undefined,
): boolean;