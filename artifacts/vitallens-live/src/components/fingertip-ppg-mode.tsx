import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import type { PpgModeProps } from '../lib/fingertip-ppg-types';
import './fingertip-ppg-mode.css';

const ANDROID_SAMPLE_GATE = 256;

const formatTime = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safeSeconds / 60)).padStart(2, '0')}:${String(safeSeconds % 60).padStart(2, '0')}`;
};

function SignalPlot({
  samples,
  markers,
}: Pick<PpgModeProps, 'samples' | 'markers'>) {
  const plot = useMemo(() => {
    const recent = samples.slice(-100);
    if (!recent.length) return { path: '', ticks: [] as Array<{ y: number; label: string }>, markerPositions: [] as number[] };

    const values = recent.map((sample) => sample.lumaMean);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const range = high - low || 1;
    const path = values.map((value, index) => {
      const x = 39 + (index / Math.max(1, values.length - 1)) * 257;
      const y = 12 + ((high - value) / range) * 164;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    const ticks = Array.from({ length: 5 }, (_, index) => {
      const ratio = index / 4;
      return {
        y: 12 + ratio * 164,
        label: (high - ratio * range).toFixed(0),
      };
    });
    const start = recent[0]?.elapsedSeconds ?? 0;
    const end = recent[recent.length - 1]?.elapsedSeconds ?? start;
    const markerPositions = markers
      .filter((marker) => marker.elapsedSeconds >= start && marker.elapsedSeconds <= end)
      .map((marker) => 39 + ((marker.elapsedSeconds - start) / Math.max(0.01, end - start)) * 257);

    return { path, ticks, markerPositions };
  }, [markers, samples]);

  return (
    <div className="native-ppg-chart" role="img" aria-label="Live camera brightness signal">
      <svg viewBox="0 0 300 200" preserveAspectRatio="none" aria-hidden="true">
        {plot.ticks.map((tick, index) => (
          <g key={`${tick.y}-${index}`}>
            <text x="3" y={tick.y + 3}>{tick.label}</text>
            <line x1="35" x2="299" y1={tick.y} y2={tick.y} />
          </g>
        ))}
        {plot.markerPositions.map((x, index) => (
          <line className="native-ppg-marker" key={`${x}-${index}`} x1={x} x2={x} y1="10" y2="182" />
        ))}
        {plot.path && <path className="native-ppg-trace" d={plot.path} />}
      </svg>
    </div>
  );
}

export function FingertipPpgMode({
  videoRef,
  phase,
  cameraActive,
  bpm,
  signalQuality,
  torchStatus,
  elapsedSeconds,
  errorMessage,
  samples,
  sampleCount,
  markers,
  recordedVideoUrl,
  recordedVideoName,
  videoRecordingActive,
  videoRecordingError,
  onStart,
  onStop,
  onMarkBreathing,
  onExportCsv,
  onDownloadVideo,
}: PpgModeProps) {
  const [breathingIn, setBreathingIn] = useState(false);
  const active = cameraActive || phase === 'starting' || phase === 'warming' || phase === 'live';
  const canMarkBreathing = cameraActive && sampleCount >= ANDROID_SAMPLE_GATE;

  useEffect(() => {
    if (!cameraActive) setBreathingIn(false);
  }, [cameraActive]);

  const torchLabel = {
    idle: 'Not started',
    checking: 'Checking',
    on: 'On',
    off: 'Off',
    unsupported: 'Not supported by this browser',
    unavailable: 'Unavailable',
  }[torchStatus];

  const heartRateMessage = bpm !== null
    ? `HR: ${Math.round(bpm)} BPM`
    : sampleCount < ANDROID_SAMPLE_GATE
      ? `${ANDROID_SAMPLE_GATE - sampleCount} more samples`
      : signalQuality === 0
        ? 'Hold your fingertip still over the rear camera and flash'
        : 'Finding a steady pulse';

  const markBreathing = () => {
    const event = breathingIn ? 'exhale' : 'inhale';
    onMarkBreathing(event);
    setBreathingIn(!breathingIn);
  };

  return (
    <main className="native-ppg-page">
      <div className="native-ppg-shell">
        <header className="native-ppg-header">
          <Link href="/" aria-label="Back to VitalLens">‹ VitalLens</Link>
        </header>

        <h1>PPG Heart Rate Monitor Better</h1>

        <div className={`native-ppg-camera ${cameraActive ? 'is-active' : ''}`}>
          <video
            ref={videoRef}
            muted
            playsInline
            aria-label="Rear camera preview"
            data-testid="ppg-camera-preview"
          />
          {!cameraActive && (
            <div className="native-ppg-camera-placeholder">
              {phase === 'error' ? 'Camera stopped' : 'Camera preview'}
              <small>{active ? 'Waiting for camera permission…' : 'Start recording to open the rear camera'}</small>
            </div>
          )}
        </div>

        <p className="native-ppg-timer" data-testid="ppg-session-timer">{formatTime(elapsedSeconds)}</p>

        <div className="native-ppg-controls">
          {active ? (
            <button
              className="native-ppg-button"
              type="button"
              onClick={onStop}
              data-testid="button-stop-measurement"
            >
              Stop recording
            </button>
          ) : (
            <button
              className="native-ppg-button"
              type="button"
              onClick={onStart}
              data-testid="button-start-measurement"
              disabled={phase === 'starting'}
            >
              {phase === 'error' ? 'Try again' : 'Start recording'}
            </button>
          )}
          <button
            className="native-ppg-button"
            type="button"
            onClick={markBreathing}
            disabled={!canMarkBreathing}
            data-testid="button-toggle-breath"
          >
            {breathingIn ? 'Exhale' : 'Inhale'}
          </button>
        </div>

        <div className="native-ppg-local-note">
          <span className={active ? 'is-recording' : ''} />
          {active ? 'Recording locally on this device' : 'Camera and pulse data stay on this device'}
        </div>

        {errorMessage && <p className="native-ppg-error" role="alert">{errorMessage}</p>}
        {videoRecordingError && <p className="native-ppg-warning" role="status">{videoRecordingError}</p>}

        <p className="native-ppg-heart-rate" data-testid="metric-fingertip-bpm">
          {heartRateMessage}
        </p>
        <p className="native-ppg-guidance">
          Cover the rear camera lens and flash with a relaxed fingertip. Keep the phone and finger still.
        </p>

        <SignalPlot samples={samples} markers={markers} />

        <div className="native-ppg-recording-status" aria-live="polite">
          <span>Flash: {torchLabel}</span>
          <span>{videoRecordingActive ? 'Saving video…' : 'Video recording stays local'}</span>
        </div>

        {markers.length > 0 && (
          <div className="native-ppg-marker-log" aria-label="Breathing log">
            {markers.slice(-4).reverse().map((marker, index) => (
              <span key={`${marker.elapsedSeconds}-${marker.event}-${index}`}>
                {formatTime(marker.elapsedSeconds)} · {marker.event}
              </span>
            ))}
          </div>
        )}

        {!active && sampleCount > 0 && (
          <div className="native-ppg-downloads">
            {recordedVideoUrl && recordedVideoName && (
              <button className="native-ppg-download" type="button" onClick={onDownloadVideo}>
                Download video ({recordedVideoName.endsWith('.mp4') ? 'MP4' : 'WebM'})
              </button>
            )}
            {videoRecordingActive && <span>Finishing video file…</span>}
            <button className="native-ppg-download" type="button" onClick={onExportCsv}>
              Download local pulse log
            </button>
          </div>
        )}

        <p className="native-ppg-safety">
          Wellness use only. Stop if the phone or flash becomes hot. Browser video files are downloaded to your device when you choose.
        </p>
      </div>
    </main>
  );
}

export default FingertipPpgMode;