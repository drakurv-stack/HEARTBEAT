export interface HrvMetrics {
  ok: boolean;
  nBeats: number;
  meanHR?: number;
  meanIBI?: number;
  sdnn?: number | null;
  rmssd?: number | null;
  sdsd?: number | null;
  pnn50?: number | null;
  pnn20?: number | null;
  sd1?: number | null;
  sd2?: number | null;
  sd1sd2?: number | null;
  vlf?: number | null;
  lf?: number | null;
  hf?: number | null;
  tp?: number | null;
  lfhf?: number | null;
  lfNu?: number | null;
  hfNu?: number | null;
  breathingRate?: number | null;
}

export function computeHRV(
  signal: number[],
  timestamps: number[] | number,
  opts?: { minBeats?: number },
): HrvMetrics;