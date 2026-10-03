import type { PpgVariabilityEstimate } from './fingertip-ppg-signal';

export type PpgModePhase = 'idle' | 'starting' | 'warming' | 'live' | 'error';

export type PpgTorchStatus = 'idle' | 'checking' | 'on' | 'off' | 'unsupported' | 'unavailable';

export type PpgBreathingEvent = 'inhale' | 'exhale';

export interface PpgSample {
  elapsedSeconds: number;
  lumaMean: number;
  filteredSignal: number;
}

export interface PpgBreathingMarker {
  elapsedSeconds: number;
  event: PpgBreathingEvent;
}

export interface PpgModeProps {
  videoRef: (node: HTMLVideoElement | null) => void;
  phase: PpgModePhase;
  cameraActive: boolean;
  bpm: number | null;
  signalQuality: number | null;
  variability: PpgVariabilityEstimate | null;
  torchStatus: PpgTorchStatus;
  elapsedSeconds: number;
  cleanSignalSeconds: number;
  errorMessage: string | null;
  samples: readonly PpgSample[];
  sampleCount: number;
  markers: readonly PpgBreathingMarker[];
  recordedVideoUrl: string | null;
  recordedVideoName: string | null;
  videoRecordingActive: boolean;
  videoRecordingError: string | null;
  onStart: () => void;
  onStop: () => void;
  onMarkBreathing: (event: PpgBreathingEvent) => void;
  onExportCsv: () => void;
  onDownloadVideo: () => void;
}