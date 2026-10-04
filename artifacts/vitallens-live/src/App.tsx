import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Aperture, ArrowUpRight, Check, ChevronRight, CircleAlert, CircleHelp, Clock3, Eye, EyeOff, HeartPulse, Info, LoaderCircle, LockKeyhole, Radio, RefreshCw, ShieldCheck, Square, Video, Wifi } from 'lucide-react';
import { useGetLiveDemoStatus, usePushLiveFrame, useStartLiveSession, useStopLiveSession } from '@workspace/api-client-react';
import type { LiveInferenceUpdate } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { MeasurementReport } from '@/components/measurement-report';
import { StressCheck } from '@/components/stress-check';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createMeasurementReport, type MeasurementReportReading } from '@/lib/measurement-report-data';
import { getRespiratoryRateRejectionReason } from '@/lib/respiratory-rate-quality.mjs';
import {
  estimateCameraHrv,
  extractSkinRgb,
  type OpticalPulseEstimate,
  type OpticalPulseSample,
} from '@/lib/hrv-signal.mjs';
import { computeHRV, type HrvMetrics } from '@/lib/hrv-compute.mjs';
import { MeasurementReportProvider, useMeasurementReport } from '@/lib/measurement-report-context';
import NotFound from '@/pages/not-found';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();
type Phase = 'idle' | 'camera' | 'starting' | 'no-face' | 'calibrating' | 'live' | 'stopping' | 'denied' | 'error';
type DisplayMetricValue = NonNullable<LiveInferenceUpdate['heartRate']> | null;
type HrvMetricKey =
  | 'sdnn' | 'rmssd' | 'sdsd' | 'pnn50' | 'pnn20' | 'meanIBI'
  | 'sd1' | 'sd2' | 'sd1sd2'
  | 'vlf' | 'lf' | 'hf' | 'tp' | 'lfhf' | 'lfNu' | 'hfNu';
type HrvReading = { metrics: HrvMetrics; durationSeconds: number };

const HRV_GROUPS: Array<{
  title: string;
  metrics: Array<{ label: string; key: HrvMetricKey; unit: string }>;
}> = [
  {
    title: 'Time domain',
    metrics: [
      { label: 'SDNN', key: 'sdnn', unit: 'ms' },
      { label: 'RMSSD', key: 'rmssd', unit: 'ms' },
      { label: 'SDSD', key: 'sdsd', unit: 'ms' },
      { label: 'pNN50', key: 'pnn50', unit: '%' },
      { label: 'pNN20', key: 'pnn20', unit: '%' },
      { label: 'Mean IBI', key: 'meanIBI', unit: 'ms' },
    ],
  },
  {
    title: 'Poincare',
    metrics: [
      { label: 'SD1', key: 'sd1', unit: 'ms' },
      { label: 'SD2', key: 'sd2', unit: 'ms' },
      { label: 'SD1/SD2', key: 'sd1sd2', unit: 'ratio' },
    ],
  },
  {
    title: 'Frequency domain',
    metrics: [
      { label: 'VLF', key: 'vlf', unit: 'ms²' },
      { label: 'LF', key: 'lf', unit: 'ms²' },
      { label: 'HF', key: 'hf', unit: 'ms²' },
      { label: 'Total power', key: 'tp', unit: 'ms²' },
      { label: 'LF/HF', key: 'lfhf', unit: 'ratio' },
      { label: 'LF (n.u.)', key: 'lfNu', unit: '%' },
      { label: 'HF (n.u.)', key: 'hfNu', unit: '%' },
    ],
  },
];

function HrvMetricCard({ label, value, unit }: {
  label: string;
  value: number | null | undefined;
  unit: string;
}) {
  const formattedValue = typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(1)
    : null;
  return (
    <article
      className={`hrv-metric-card ${formattedValue === null ? '' : 'hrv-metric-active'}`}
      data-testid={`metric-hrv-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
    >
      <span className="hrv-metric-label">{label}</span>
      <span className="hrv-metric-value">
        {formattedValue ?? <span className="metric-dash">--</span>}
        {formattedValue !== null && <small>{unit}</small>}
      </span>
    </article>
  );
}

function Metric({ label, symbol, metric, precision = 0, emptyLabel = 'WAITING', sourceLabel, qualityCheck }: {
  label: string;
  symbol: string;
  metric: DisplayMetricValue;
  precision?: number;
  emptyLabel?: string;
  sourceLabel?: string;
  qualityCheck?: typeof getRespiratoryRateRejectionReason;
}) {
  const rejectionReason = metric && qualityCheck ? qualityCheck(metric) : null;
  const isAvailable = Boolean(metric) && rejectionReason === null;
  const confidence = metric ? (metric.confidence <= 1 ? metric.confidence * 100 : metric.confidence) : 0;
  const rejectionLabel = rejectionReason === 'low-confidence'
    ? 'LOW'
    : rejectionReason === 'out-of-range'
      ? 'CHECK'
      : rejectionReason === 'invalid'
        ? 'UNRELIABLE'
        : null;
  return (
    <article className={`metric-card ${isAvailable ? 'metric-active' : ''}`} data-testid={`metric-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="metric-top">
        <span className="metric-symbol">{symbol}</span>
        {metric
          ? <span className={`metric-confidence ${rejectionReason ? 'metric-confidence-low' : ''}`}><span />{Math.round(confidence)}% signal{rejectionLabel ? ` · ${rejectionLabel}` : ''}</span>
          : <span className="metric-awaiting">{emptyLabel}</span>}
      </div>
      <div className="metric-value">
        {isAvailable && metric ? metric.value.toFixed(precision) : <span className="metric-dash">—</span>}
        {isAvailable && metric && <small>{metric.unit}</small>}
      </div>
      <div className="metric-label">{label}{isAvailable && sourceLabel && <span className="metric-source">{sourceLabel}</span>}</div>
      {rejectionReason && (
        <p className="metric-quality-note">
          {rejectionReason === 'low-confidence'
            ? 'Low signal; RR hidden. Hold still in steady light.'
            : rejectionReason === 'out-of-range'
              ? 'Outside display range; RR hidden.'
              : 'Unreliable estimate hidden.'}
        </p>
      )}
    </article>
  );
}

function SignalTrace({ active, windowReady }: { active: boolean; windowReady: boolean }) {
  return (
    <div className={`signal-trace ${active ? 'trace-active' : ''}`} aria-hidden="true">
      <div className="trace-caption"><span>LIVE SIGNAL</span><span>PPG / RGB</span></div>
      <svg viewBox="0 0 480 56" preserveAspectRatio="none">
        <path className="trace-grid" d="M0 28H480M0 8H480M0 48H480" />
        <path className="trace-path" d="M0 30 C12 30 13 28 19 30 S31 33 38 29 S48 23 55 30 S67 34 76 30 S88 28 95 30 S108 31 114 30 S120 28 125 30 L132 30 L138 21 L144 40 L151 9 L158 48 L165 28 L172 30 C184 30 189 27 197 30 S210 34 218 29 S232 25 240 30 S252 32 260 29 S275 27 282 30 S296 34 304 29 S318 24 326 30 S339 31 348 30 S360 27 368 30 L376 30 L382 22 L388 39 L395 10 L402 47 L408 29 L418 30 C429 30 435 27 443 30 S456 33 464 29 S474 28 480 30" />
      </svg>
      <div className="trace-foot"><span>LOCAL RGB WINDOW</span><span>{!active ? 'NO STREAM' : windowReady ? 'CLEAN WINDOW' : 'COLLECTING'}</span></div>
    </div>
  );
}

function AppHome() {
  const statusQuery = useGetLiveDemoStatus();
  const startSession = useStartLiveSession();
  const pushFrame = usePushLiveFrame();
  const stopSession = useStopLiveSession();
  const { setReport, clearReport } = useMeasurementReport();
  const [, setLocation] = useLocation();
  const [phase, setPhase] = useState<Phase>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [inference, setInference] = useState<LiveInferenceUpdate | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [errorText, setErrorText] = useState('');
  const [showPrivacy, setShowPrivacy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const signalCanvasRef = useRef<HTMLCanvasElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef(0);
  const frameBusyRef = useRef(false);
  const reportReadingsRef = useRef<MeasurementReportReading[]>([]);
  const localReportReadingsRef = useRef<Array<{ elapsedSeconds: number; estimate: OpticalPulseEstimate }>>([]);
  const lastReportSequenceRef = useRef(0);
  const lastLocalReportCaptureRef = useRef(0);
  const faceDetectedRef = useRef(false);
  const pulseSamplesRef = useRef<OpticalPulseSample[]>([]);
  const localPulseEstimateRef = useRef<OpticalPulseEstimate | null>(null);
  const [localPulseEstimate, setLocalPulseEstimate] = useState<OpticalPulseEstimate | null>(null);
  const [liveHrv, setLiveHrv] = useState<HrvReading | null>(null);
  const pushFrameRef = useRef(pushFrame.mutateAsync);
  pushFrameRef.current = pushFrame.mutateAsync;
  const stopMutateRef = useRef(stopSession.mutate);
  stopMutateRef.current = stopSession.mutate;
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => undefined);
    }
  }, [stream]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const endSession = useCallback(async () => {
    const activeId = sessionIdRef.current;
    setPhase('stopping');
    stopCamera();
    sessionIdRef.current = null;
    setSessionId(null);
    if (activeId) {
      try {
        await stopSession.mutateAsync({ sessionId: activeId });
      } catch {
        setErrorText('The camera is off, but the server could not confirm session release. Try again in a moment.');
        setPhase('error');
        return;
      }
    }
    const reportStartedAt = startedAtRef.current;
    const durationSeconds = reportStartedAt > 0
      ? (performance.now() - reportStartedAt) / 1000
      : elapsed;
    const localReadings: MeasurementReportReading[] = localReportReadingsRef.current.map(
      ({ elapsedSeconds, estimate }) => ({
        elapsedSeconds,
        heartRate: null,
        respiratoryRate: null,
        hrvSdnn: null,
        hrvRmssd: null,
        cameraPulseHeartRate: estimate.heartRate,
        cameraPulseHrvSdnn: estimate.hrvSdnn,
        cameraPulseHrvRmssd: estimate.hrvRmssd,
      }),
    );
    setReport(createMeasurementReport({
      durationSeconds,
      sampleCount: Math.max(reportReadingsRef.current.length, localReadings.length),
      readings: [...reportReadingsRef.current, ...localReadings],
    }));
    setInference(null);
    setLocalPulseEstimate(null);
    localPulseEstimateRef.current = null;
    setLiveHrv(null);
    pulseSamplesRef.current = [];
    faceDetectedRef.current = false;
    localReportReadingsRef.current = [];
    setPhase('idle');
    startedAtRef.current = 0;
    setLocation('/report');
  }, [setLocation, setReport, stopCamera, stopSession]);

  useEffect(() => {
    if (!sessionId || !stream || phase === 'stopping') return;
    let cancelled = false;
    const sendFrame = async () => {
      if (cancelled || frameBusyRef.current || !videoRef.current || !canvasRef.current) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
      frameBusyRef.current = true;
      try {
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Unable to prepare a camera frame.');
        const encodeFrame = (width: number, quality: number) => {
          const height = Math.round((video.videoHeight / video.videoWidth) * width);
          canvas.width = width;
          canvas.height = height;
          context.drawImage(video, 0, 0, width, height);
          return canvas.toDataURL('image/jpeg', quality).split(',')[1] ?? '';
        };
        const width = Math.min(video.videoWidth, 640);
        let jpegBase64 = '';
        for (const quality of [0.84, 0.76, 0.68, 0.6]) {
          jpegBase64 = encodeFrame(width, quality);
          if (jpegBase64.length <= 150000) break;
        }
        if (jpegBase64.length > 150000) {
          jpegBase64 = encodeFrame(Math.min(video.videoWidth, 480), 0.56);
        }
        if (!jpegBase64 || jpegBase64.length > 150000) throw new Error('Frame could not be compressed for the live demo.');
        const result = await pushFrameRef.current({
          sessionId,
          data: { jpegBase64, timestamp: (performance.now() - startedAtRef.current) / 1000 },
        });
        if (!cancelled) {
          faceDetectedRef.current = result.faceDetected;
          if (
            result.faceDetected &&
            result.resultSequence > 0 &&
            result.resultSequence > lastReportSequenceRef.current
          ) {
            reportReadingsRef.current.push({
              elapsedSeconds: Math.max(0, (performance.now() - startedAtRef.current) / 1000),
              heartRate: result.heartRate
                ? { value: result.heartRate.value, confidence: result.heartRate.confidence, unit: result.heartRate.unit }
                : null,
              respiratoryRate: result.respiratoryRate
                ? { value: result.respiratoryRate.value, confidence: result.respiratoryRate.confidence, unit: result.respiratoryRate.unit }
                : null,
              hrvSdnn: result.hrvSdnn
                ? { value: result.hrvSdnn.value, confidence: result.hrvSdnn.confidence, unit: result.hrvSdnn.unit }
                : null,
              hrvRmssd: result.hrvRmssd
                ? { value: result.hrvRmssd.value, confidence: result.hrvRmssd.confidence, unit: result.hrvRmssd.unit }
                : null,
            });
            lastReportSequenceRef.current = result.resultSequence;
          }
          if (!result.faceDetected) {
            pulseSamplesRef.current = [];
            setLocalPulseEstimate(null);
            localPulseEstimateRef.current = null;
            setLiveHrv(null);
            setInference(null);
            setPhase('no-face');
          } else {
            setInference(result);
            setPhase(result.heartRate || result.respiratoryRate || localPulseEstimateRef.current ? 'live' : 'calibrating');
          }
        }
      } catch (error) {
        if (!cancelled) {
          setErrorText(error instanceof Error ? error.message : 'A live frame could not be analyzed.');
          setLocalPulseEstimate(null);
          localPulseEstimateRef.current = null;
          setLiveHrv(null);
          pulseSamplesRef.current = [];
          setPhase('error');
          stopCamera();
          const failedSession = sessionIdRef.current;
          sessionIdRef.current = null;
          setSessionId(null);
          if (failedSession) stopMutateRef.current({ sessionId: failedSession });
        }
      } finally {
        frameBusyRef.current = false;
      }
    };
    void sendFrame();
    const timer = window.setInterval(() => void sendFrame(), 125);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId, stream, phase, stopCamera]);

  useEffect(() => {
    if (!sessionId || !stream) return;
    let cancelled = false;
    let lastAnalysisAt = 0;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      const canvas = signalCanvasRef.current;
      if (
        cancelled ||
        !faceDetectedRef.current ||
        !video ||
        !canvas ||
        video.readyState < 2 ||
        !video.videoWidth ||
        !video.videoHeight
      ) return;

      const timestampMs = performance.now();
      const width = 160;
      const height = Math.max(80, Math.round((video.videoHeight / video.videoWidth) * width));
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;

      try {
        context.drawImage(video, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height);
        const sample = extractSkinRgb(pixels.data, width, height, timestampMs);
        if (sample) {
          pulseSamplesRef.current.push(sample);
          const oldestAllowed = timestampMs - 60_000;
          while (
            pulseSamplesRef.current.length > 0 &&
            pulseSamplesRef.current[0].timestampMs < oldestAllowed
          ) pulseSamplesRef.current.shift();
        }
      } catch {
        pulseSamplesRef.current = [];
        setLocalPulseEstimate(null);
        localPulseEstimateRef.current = null;
        return;
      }

      if (timestampMs - lastAnalysisAt < 1000) return;
      lastAnalysisAt = timestampMs;
      const samples = pulseSamplesRef.current;
      const estimate = estimateCameraHrv(samples);
      setLocalPulseEstimate(estimate);
      localPulseEstimateRef.current = estimate;
      const signal = samples.map((sample) => sample.green);
      const timestamps = samples.map((sample) => sample.timestampMs / 1000);
      const durationSeconds = timestamps.length > 1
        ? Math.max(0, timestamps[timestamps.length - 1] - timestamps[0])
        : 0;
      const hasContinuousFreshSignal =
        timestamps.length > 1 &&
        timestampMs - samples[samples.length - 1].timestampMs <= 500 &&
        timestamps.every((time, index) =>
          Number.isFinite(time) &&
          (index === 0 || (time > timestamps[index - 1] && time - timestamps[index - 1] <= 0.45)),
        );
      let metrics: HrvMetrics;
      try {
        metrics = computeHRV(signal, timestamps);
      } catch {
        metrics = { ok: false, nBeats: 0 };
      }
      setLiveHrv({
        metrics: hasContinuousFreshSignal ? metrics : { ...metrics, ok: false },
        durationSeconds,
      });
      if (estimate) {
        setPhase('live');
        if (timestampMs - lastLocalReportCaptureRef.current >= 1000) {
          localReportReadingsRef.current.push({
            elapsedSeconds: Math.max(0, (timestampMs - startedAtRef.current) / 1000),
            estimate,
          });
          if (localReportReadingsRef.current.length > 1800) {
            localReportReadingsRef.current.shift();
          }
          lastLocalReportCaptureRef.current = timestampMs;
        }
      }
    }, 125);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId, stream]);

  useEffect(() => {
    if (!sessionId) return;
    const timer = window.setInterval(() => setElapsed(Math.floor((performance.now() - startedAtRef.current) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [sessionId]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const begin = async () => {
    setErrorText('');
    setInference(null);
    setLocalPulseEstimate(null);
    localPulseEstimateRef.current = null;
    setLiveHrv(null);
    clearReport();
    setElapsed(0);
    setPhase('camera');
    reportReadingsRef.current = [];
    localReportReadingsRef.current = [];
    pulseSamplesRef.current = [];
    faceDetectedRef.current = false;
    lastReportSequenceRef.current = 0;
    lastLocalReportCaptureRef.current = 0;
    let cameraStream: MediaStream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable here. Open this page in a secure browser context.');
      cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } },
      });
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError');
      setErrorText(denied
        ? 'Camera permission was declined. Allow camera access in your browser settings, then try again.'
        : error instanceof Error ? error.message : 'The camera could not be opened.');
      setPhase(denied ? 'denied' : 'error');
      return;
    }
    streamRef.current = cameraStream;
    setStream(cameraStream);
    setPhase('starting');
    try {
      const session = await startSession.mutateAsync();
      sessionIdRef.current = session.sessionId;
      startedAtRef.current = performance.now();
      setSessionId(session.sessionId);
      setPhase('calibrating');
    } catch (error) {
      cameraStream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStream(null);
      setErrorText(error instanceof Error ? error.message : 'VitalLens could not start a live session.');
      setPhase('error');
    }
  };

  const isRunning = Boolean(sessionId);
  const configured = statusQuery.data?.apiReady === true;
  const displayState = phase === 'camera' ? 'Requesting camera' : phase === 'starting' ? 'Opening session' :
    phase === 'no-face' ? 'Face not found' : phase === 'calibrating' ? 'Calibrating' :
      phase === 'live' ? 'Live estimates' : phase === 'stopping' ? 'Stopping stream' :
        phase === 'denied' ? 'Permission needed' : phase === 'error' ? 'Needs attention' : 'Ready when you are';
  const elapsedLabel = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  const visibleInference = phase === 'no-face' || !inference?.faceDetected ? null : inference;
  const emptyMetricLabel = phase === 'no-face' ? 'NO FACE' : 'WAITING';
  const visibleHeartRate = visibleInference?.heartRate ?? localPulseEstimate?.heartRate ?? null;
  const liveHrvReady = Boolean(
    liveHrv &&
    liveHrv.durationSeconds >= 30 &&
    liveHrv.metrics.ok,
  );
  const liveHrvDuration = Math.min(60, Math.floor(liveHrv?.durationSeconds ?? 0));

  return (
    <main className="page-shell grain min-h-[100dvh]">
      <header className="topbar">
        <a className="brand" href="/" aria-label="VitalLens Live home" data-testid="link-home">
          <span className="brand-mark"><Aperture size={19} strokeWidth={1.8} /></span>
          <span>vital<span>lens</span><sup>LIVE</sup></span>
        </a>
        <div className="topbar-right">
          <span className="demo-label"><span className="demo-dot" />BROWSER DEMO</span>
          <button className="about-link" type="button" onClick={() => setShowPrivacy((value) => !value)} data-testid="button-privacy">
            <CircleHelp size={16} /> How it works
          </button>
        </div>
      </header>

      <section className="intro enter">
        <div className="eyebrow"><span className="eyebrow-rule" />THE VITALLENS LIBRARY, LIVE</div>
        <div className="intro-row">
          <h1>See your signal<span className="title-period">.</span></h1>
          <div className="intro-copy">
            <p>A small, direct test of camera-based vital estimates. High-quality frames go to VitalLens; a short camera-colour window is analyzed locally in this tab.</p>
            <div className="wellness-note"><Info size={14} />For wellness exploration only. Not a medical device or diagnosis.</div>
          </div>
        </div>
      </section>

      <section className="workbench enter-delay" aria-label="Live VitalLens demo">
        <div className="camera-column">
          <div className="section-kicker"><span>01</span> CAMERA WINDOW <span className="kicker-line" /><span className="mono">{isRunning ? elapsedLabel : 'STANDBY'}</span></div>
          <div className={`camera-window ${isRunning ? 'camera-on' : ''}`} data-testid="status-camera-window">
            <video ref={videoRef} className={`camera-video ${stream ? 'visible' : ''}`} muted playsInline aria-label="Your live camera preview" />
            <canvas ref={canvasRef} className="capture-canvas" />
            <canvas ref={signalCanvasRef} className="capture-canvas" aria-hidden="true" />
            {!stream && <div className="camera-placeholder">
              <div className="lens-mark"><span /><span /><span /><Aperture size={34} strokeWidth={1.1} /></div>
              <div className="placeholder-title">{phase === 'denied' ? 'Camera permission needed' : phase === 'error' ? 'Stream paused' : 'Your camera stays yours'}</div>
              <p>{phase === 'denied' ? 'Allow camera access in your browser, then return here.' : phase === 'error' ? 'Resolve the issue below and start a fresh session.' : 'Frame your face and upper chest for respiratory rate. Frames are only sent while you run the test.'}</p>
              <div className="privacy-pills"><span><Eye size={13} />Local preview</span><span><LockKeyhole size={13} />No recording</span></div>
            </div>}
            {stream && <>
              <div className="camera-overlay-top"><span><span className="record-dot" /> CAMERA ACTIVE</span><span>LOCAL PREVIEW</span></div>
              <div className="viewfinder" aria-hidden="true"><i /><i /><i /><i /><div className="upper-body-guide"><span className="guide-head" /><span className="guide-torso" /></div></div>
              {(phase === 'no-face' || phase === 'calibrating' || phase === 'starting' || phase === 'live') && (
                <div className="camera-hint">
                  {phase === 'no-face' ? <><EyeOff size={15} /> Keep your face and upper chest in frame</> : phase === 'starting' ? <><LoaderCircle size={15} className="spin" /> Connecting to VitalLens</> : phase === 'live' ? <><span className="signal-pulse"><Radio size={14} /></span> Keep face and upper chest in frame for RR</> : <><span className="signal-pulse"><Radio size={14} /></span> Hold still; keep face and upper chest in frame</>}
                </div>
              )}
              <div className="camera-overlay-bottom"><span>LOCAL RGB WINDOW</span><span><span className="cam-led" /> FRAMES TO SERVER</span></div>
            </>}
            {phase === 'stopping' && <div className="camera-stopping"><LoaderCircle className="spin" size={20} /> Releasing camera session…</div>}
          </div>

          <div className="control-row">
            <div className={`connection-state ${isRunning ? 'connection-live' : configured ? 'connection-ready' : ''}`}>
              <span className="connection-indicator" />
              <span><strong data-testid="status-session">{displayState}</strong><small>{isRunning ? `SESSION ${sessionId?.slice(0, 8).toUpperCase()}` : statusQuery.isLoading ? 'CHECKING CONFIGURATION' : configured ? 'API READY' : 'AWAITING CONFIGURATION'}</small></span>
            </div>
            {!isRunning ? (
              <button className="start-button" type="button" onClick={begin} disabled={!configured || statusQuery.isLoading || phase === 'camera' || phase === 'starting' || phase === 'stopping'} data-testid="button-start-session">
                {phase === 'camera' || phase === 'starting' ? <LoaderCircle size={16} className="spin" /> : <Video size={16} />}
                {phase === 'camera' ? 'Allow camera…' : phase === 'starting' ? 'Connecting…' : 'Start live test'}
                {phase !== 'camera' && phase !== 'starting' && <ArrowUpRight size={15} />}
              </button>
            ) : (
              <button className="stop-button" type="button" onClick={() => void endSession()} disabled={phase === 'stopping'} data-testid="button-stop-session">
                <Square size={13} fill="currentColor" /> Stop session
              </button>
            )}
          </div>
          {statusQuery.isLoading && <div className="api-message skeleton-line"><span /> Checking VitalLens availability…</div>}
          {statusQuery.isError && <div className="inline-alert" role="alert"><CircleAlert size={16} /><span>We couldn’t check API readiness. Your camera won’t start until the service is available.</span><button type="button" onClick={() => void statusQuery.refetch()} data-testid="button-retry-status"><RefreshCw size={14} /> Retry</button></div>}
          {!statusQuery.isLoading && statusQuery.data && !statusQuery.data.apiReady && <div className="inline-alert" role="status"><CircleAlert size={16} /><span>{statusQuery.data.message || 'VitalLens is not configured yet. A server administrator must add the API key.'}</span><button type="button" onClick={() => void statusQuery.refetch()} data-testid="button-refresh-status"><RefreshCw size={14} /> Check again</button></div>}
          {(phase === 'denied' || phase === 'error') && errorText && <div className="inline-alert error-alert" role="alert"><CircleAlert size={16} /><span>{errorText}</span>{phase === 'denied' && <button type="button" onClick={() => void begin()} data-testid="button-retry-camera"><RefreshCw size={14} /> Try again</button>}</div>}

          <div className="transmission-note">
            <div className="transmission-icon"><ShieldCheck size={17} /></div>
            <div><strong>Before you start</strong><p>With your consent, temporary JPEG frames travel to our server for VitalLens analysis. In parallel, this tab keeps a rolling window of cheek-colour averages for optical pulse estimates. Neither video nor colour samples are saved; the API key stays on the server.</p></div>
            <button className="detail-toggle" type="button" aria-label="Toggle privacy details" onClick={() => setShowPrivacy((value) => !value)} data-testid="button-privacy-details"><ChevronRight size={17} /></button>
          </div>
          {showPrivacy && <div className="privacy-detail enter">
            <div><span>01</span><p><strong>You choose when.</strong> Camera access is requested only after you press Start. Stop ends the camera stream and asks the server to release the session.</p></div>
            <div><span>02</span><p><strong>Local analysis stays in this tab.</strong> A 60-second rolling window of colour averages is used for optical pulse intervals; those samples are not sent to the API or saved.</p></div>
            <div><span>03</span><p><strong>Frames are transient.</strong> Compressed still frames are sent only while the session is active. No video recording is created or retained by this demo.</p></div>
            <div><span>04</span><p><strong>Credentials stay server-side.</strong> The browser talks to this application server; it never receives the VitalLens API key.</p></div>
          </div>}
        </div>

        <aside className="readout-column">
          <div className="readout-header">
            <div className="section-kicker"><span>02</span> LIVE READOUT <span className="kicker-line" /></div>
            <div className={`readout-status ${phase === 'no-face' ? 'readout-warning' : isRunning ? 'readout-on' : ''}`}><span />{phase === 'no-face' ? 'NO FACE' : phase === 'live' ? 'READING' : isRunning ? 'WARMING UP' : 'IDLE'}</div>
          </div>
          <div className="metric-grid">
            <Metric label="Heart rate" symbol="HR" metric={visibleHeartRate} emptyLabel={emptyMetricLabel} sourceLabel={visibleInference?.heartRate ? 'VITALLENS' : localPulseEstimate ? 'LOCAL OPTICAL' : undefined} />
            <Metric label="Respiratory rate" symbol="RR" metric={visibleInference?.respiratoryRate ?? null} emptyLabel={emptyMetricLabel} qualityCheck={getRespiratoryRateRejectionReason} />
          </div>
          <section className="hrv-readout" aria-labelledby="hrv-readout-title" data-testid="section-camera-hrv">
            <div className="hrv-readout-header">
              <div>
                <span className="hrv-readout-kicker">CAMERA PULSE VARIABILITY</span>
                <h2 id="hrv-readout-title">HRV metrics</h2>
              </div>
              <span className={`hrv-readout-status ${liveHrvReady ? 'hrv-readout-ready' : ''}`}>
                {liveHrvReady ? 'ESTIMATE READY' : 'MEASURING'}
              </span>
            </div>
            {!liveHrvReady ? (
              <div className="hrv-measuring" role="status" data-testid="status-hrv-measuring">
                <LoaderCircle size={14} className={isRunning ? 'spin' : ''} />
                <span>Measuring... {liveHrvDuration}s</span>
              </div>
            ) : (
              <div className="hrv-groups">
                {HRV_GROUPS.map((group) => (
                  <section className="hrv-group" key={group.title} aria-label={group.title}>
                    <h3>{group.title}</h3>
                    <div className="hrv-metric-grid">
                      {group.metrics.map((metric) => (
                        <HrvMetricCard
                          key={metric.key}
                          label={metric.label}
                          value={liveHrv?.metrics[metric.key]}
                          unit={metric.unit}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
            <div className="metric-note" role="note">
              <Info size={13} />
              <span>These are camera-based estimates for wellness only, not medical measurements.</span>
            </div>
          </section>
          <StressCheck
            current={isRunning && phase === 'live' ? visibleInference : null}
            localEstimate={localPulseEstimate}
            sessionActive={isRunning}
            noFace={phase === 'no-face'}
            sessionId={sessionId}
          />
          <SignalTrace active={isRunning} windowReady={Boolean(localPulseEstimate)} />

          <div className={`guidance-panel ${phase === 'no-face' ? 'guidance-warn' : phase === 'live' ? 'guidance-live' : ''}`}>
            <div className="guidance-icon">
              {phase === 'no-face' ? <EyeOff size={17} /> : phase === 'live' ? <Check size={17} /> : phase === 'error' ? <CircleAlert size={17} /> : <HeartPulse size={17} />}
            </div>
            <div className="guidance-copy">
              <span className="guidance-label">{phase === 'no-face' ? 'FACE NOT DETECTED' : phase === 'live' ? 'SIGNAL ACQUIRED' : phase === 'error' ? 'SESSION INTERRUPTED' : 'WHAT TO EXPECT'}</span>
              <p>{phase === 'no-face' ? 'No face is tracked, so live values are hidden. Center your face in the guide, keep your upper chest visible, and use steady light.' : phase === 'live' ? 'For respiratory rate, keep your upper chest in frame as well as your face. Hold still in even lighting; vigorous movement can make camera readings unreliable.' : phase === 'error' ? 'The stream stopped safely. Check your connection and start a new session when ready.' : 'Frame your face and upper chest together, use even lighting, and hold still while the signal settles.'}</p>
            </div>
          </div>

          <div className="pipeline">
            <div className="pipeline-title"><span>SESSION PIPELINE</span><span>{isRunning ? 'ACTIVE' : 'READY'}</span></div>
            <div className="pipeline-steps">
              <div className={`pipeline-step ${isRunning ? 'step-done' : ''}`}><span className="step-marker">{isRunning ? <Check size={11} /> : '1'}</span><span>Camera</span></div>
              <div className={`pipeline-step ${inference?.faceDetected ? 'step-done' : ''}`}><span className="step-marker">{inference?.faceDetected ? <Check size={11} /> : '2'}</span><span>Face</span></div>
              <div className={`pipeline-step ${phase === 'live' ? 'step-done' : ''}`}><span className="step-marker">{phase === 'live' ? <Check size={11} /> : '3'}</span><span>Calibrate</span></div>
              <div className={`pipeline-step ${phase === 'live' ? 'step-done' : ''}`}><span className="step-marker">{phase === 'live' ? <Check size={11} /> : '4'}</span><span>Estimate</span></div>
            </div>
          </div>
          <div className="readout-foot"><Clock3 size={13} /><span>Latest frame</span><strong>{inference ? 'just now' : '—'}</strong><span className="foot-divider" /><Wifi size={13} /><span>Confidence shown per estimate</span></div>
        </aside>
      </section>

      <footer className="page-footer">
        <span><span className="footer-mark">V</span> VitalLens <span className="footer-sep">/</span> a direct library demo</span>
        <span><span className="footer-dot" /> WELLNESS ONLY <span className="footer-sep">·</span> NOT MEDICAL ADVICE</span>
        <span>Frames are transient <span className="footer-sep">·</span> No video retained</span>
      </footer>
    </main>
  );
}

function MeasurementReportPage() {
  const { report, clearReport } = useMeasurementReport();
  const [, setLocation] = useLocation();

  const continueToMeasurement = useCallback(() => {
    clearReport();
    setLocation('/');
  }, [clearReport, setLocation]);

  if (!report) {
    return (
      <main className="vl-report-missing" data-testid="status-report-unavailable">
        <div>
          <span className="vl-report-missing-mark" aria-hidden="true">V</span>
          <p className="vl-report-missing-eyebrow">VITALLENS LIVE</p>
          <h1>There’s no session report here.</h1>
          <p>Reports are available after a measurement and remain in this tab only.</p>
          <div className="vl-report-missing-links">
            <Link href="/">Start a face-camera session</Link>
          </div>
        </div>
      </main>
    );
  }

  return <MeasurementReport report={report} onClose={continueToMeasurement} />;
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={AppHome} />
        <Route path="/report" component={MeasurementReportPage} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <MeasurementReportProvider>
            <Router />
          </MeasurementReportProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;