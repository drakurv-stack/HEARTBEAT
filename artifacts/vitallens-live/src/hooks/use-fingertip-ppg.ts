import { useCallback, useEffect, useRef, useState } from 'react';
import {
  estimatePpgHeartRate,
  estimatePpgVariability,
  type PpgEstimate,
  type PpgVariabilityEstimate,
} from '../lib/fingertip-ppg-signal';
import { createMeasurementReport, type MeasurementReportReading } from '../lib/measurement-report-data';
import type { MeasurementReportData } from '../components/measurement-report';
import type {
  PpgBreathingEvent,
  PpgBreathingMarker,
  PpgModePhase,
  PpgSample,
  PpgTorchStatus,
} from '../lib/fingertip-ppg-types';

const SAMPLE_INTERVAL_MS = 32;
const BASELINE_WINDOW_SECONDS = 2.4;
const FILTER_ALPHA = 0.72;
const SIGNAL_WINDOW_SECONDS = 75;
const PUBLISH_INTERVAL_MS = 250;
const DISPLAY_SAMPLE_LIMIT = 180;
const NO_SIGNAL_TIMEOUT_SECONDS = 20;

type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

function describeCameraError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access was declined. Allow camera access for this site, then try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No rear camera was found. Try this mode on a phone with a rear camera.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The camera is busy or unavailable. Close other camera apps and try again.';
  }
  if (error instanceof Error && error.message.startsWith('PPG:')) {
    return error.message.slice(4);
  }
  if (error instanceof Error && error.message) return error.message;
  return 'The camera measurement could not start. Check camera permissions and try again.';
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (sorted.length % 2 === 0 && lower !== undefined && upper !== undefined) {
    return (lower + upper) / 2;
  }
  return upper ?? null;
}

function csvNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(5) : '';
}

export function useFingertipPpg() {
  const [phase, setPhase] = useState<PpgModePhase>('idle');
  const [cameraActive, setCameraActive] = useState(false);
  const [bpm, setBpm] = useState<number | null>(null);
  const [signalQuality, setSignalQuality] = useState<number | null>(null);
  const [variability, setVariability] = useState<PpgVariabilityEstimate | null>(null);
  const [torchStatus, setTorchStatus] = useState<PpgTorchStatus>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [cleanSignalSeconds, setCleanSignalSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [samples, setSamples] = useState<PpgSample[]>([]);
  const [sampleCount, setSampleCount] = useState(0);
  const [markers, setMarkers] = useState<PpgBreathingMarker[]>([]);
  const [report, setReport] = useState<MeasurementReportData | null>(null);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
  const [recordedVideoName, setRecordedVideoName] = useState<string | null>(null);
  const [videoRecordingActive, setVideoRecordingActive] = useState(false);
  const [videoRecordingError, setVideoRecordingError] = useState<string | null>(null);

  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const videoChunksRef = useRef<Blob[]>([]);
  const cameraActiveRef = useRef(false);
  const runTokenRef = useRef(0);
  const startedAtRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);
  const publishTimerRef = useRef<number | null>(null);
  const recordingSamplesRef = useRef<PpgSample[]>([]);
  const signalWindowRef = useRef<PpgSample[]>([]);
  const rawBaselineWindowRef = useRef<Array<{ elapsedSeconds: number; value: number }>>([]);
  const breathingMarkersRef = useRef<PpgBreathingMarker[]>([]);
  const lastFilteredSignalRef = useRef<number | null>(null);
  const lastCapturedVideoTimeRef = useRef(-1);
  const lastSampleAtRef = useRef(0);
  const latestGoodEstimateAtRef = useRef(0);
  const bpmHistoryRef = useRef<number[]>([]);
  const reportReadingsRef = useRef<MeasurementReportReading[]>([]);
  const reportSignalQualityRef = useRef<number[]>([]);
  const lastReportReadingAtRef = useRef(Number.NEGATIVE_INFINITY);
  const cleanSignalSecondsRef = useRef(0);
  const lastSignalQualityAtRef = useRef(0);

  const videoRef = useCallback((node: HTMLVideoElement | null) => {
    videoElementRef.current = node;
    const stream = streamRef.current;
    if (node && stream && node.srcObject !== stream) {
      node.srcObject = stream;
      void node.play().catch(() => undefined);
    }
  }, []);

  const publishFinalState = useCallback(() => {
    const startedAt = startedAtRef.current;
    if (startedAt > 0) setElapsedSeconds((performance.now() - startedAt) / 1000);
    setSamples(recordingSamplesRef.current.slice(-DISPLAY_SAMPLE_LIMIT));
    setSampleCount(recordingSamplesRef.current.length);
    setMarkers([...breathingMarkersRef.current]);
  }, []);

  const releaseCamera = useCallback(() => {
    cameraActiveRef.current = false;

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (publishTimerRef.current !== null) {
      window.clearInterval(publishTimerRef.current);
      publishTimerRef.current = null;
    }

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // The recorder may already be stopping as the camera track ends.
      }
    }
    mediaRecorderRef.current = null;

    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getVideoTracks()) {
        const capabilities = track.getCapabilities?.() as TorchCapabilities | undefined;
        if (capabilities?.torch && typeof track.applyConstraints === 'function') {
          const torchOff = { advanced: [{ torch: false } as MediaTrackConstraintSet] };
          void track.applyConstraints(torchOff).catch(() => undefined);
        }
      }
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    const video = videoElementRef.current;
    if (video && video.srcObject === stream) {
      video.pause();
      video.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (!cameraActive) return;
    const video = videoElementRef.current;
    const stream = streamRef.current;
    if (video && stream && video.srcObject !== stream) {
      video.srcObject = stream;
      void video.play().catch(() => undefined);
    }
  }, [cameraActive]);

  useEffect(() => () => {
    runTokenRef.current += 1;
    releaseCamera();
  }, [releaseCamera]);

  useEffect(() => () => {
    if (recordedVideoUrl) URL.revokeObjectURL(recordedVideoUrl);
  }, [recordedVideoUrl]);

  const stop = useCallback(() => {
    runTokenRef.current += 1;
    publishFinalState();
    if (startedAtRef.current > 0) {
      const durationSeconds = (performance.now() - startedAtRef.current) / 1000;
      const finalVariability = estimatePpgVariability(recordingSamplesRef.current);
      setVariability(finalVariability);
      if (
        finalVariability.sdnnMs !== null &&
        finalVariability.rmssdMs !== null &&
        finalVariability.pnn50Percent !== null &&
        finalVariability.meanPpiMs !== null
      ) {
        reportReadingsRef.current.push({
          elapsedSeconds: durationSeconds,
          signalQualityPercent: median(reportSignalQualityRef.current),
          heartRate: null,
          respiratoryRate: null,
          hrvSdnn: { value: finalVariability.sdnnMs, confidence: null, unit: 'ms' },
          hrvRmssd: { value: finalVariability.rmssdMs, confidence: null, unit: 'ms' },
          hrvPnn50: { value: finalVariability.pnn50Percent, confidence: null, unit: '%' },
          meanPulseInterval: { value: finalVariability.meanPpiMs, confidence: null, unit: 'ms' },
        });
      }
      setReport(createMeasurementReport({
        source: 'fingertip',
        durationSeconds,
        sampleCount: recordingSamplesRef.current.length,
        readings: reportReadingsRef.current,
        signalQualityPercent: median(reportSignalQualityRef.current),
      }));
    }
    releaseCamera();
    setCameraActive(false);
    setTorchStatus('off');
    setPhase('idle');
    setErrorMessage(null);
    startedAtRef.current = 0;
  }, [publishFinalState, releaseCamera]);

  const start = useCallback(async () => {
    if (cameraActiveRef.current) return;

    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    cameraActiveRef.current = true;
    setPhase('starting');
    setCameraActive(false);
    setErrorMessage(null);
    setBpm(null);
    setSignalQuality(null);
    setVariability(null);
    setTorchStatus('checking');
    setElapsedSeconds(0);
    setCleanSignalSeconds(0);
    setSamples([]);
    setSampleCount(0);
    setMarkers([]);
    setRecordedVideoUrl(null);
    setRecordedVideoName(null);
    setVideoRecordingActive(false);
    setVideoRecordingError(null);
    videoChunksRef.current = [];
    setReport(null);
    startedAtRef.current = 0;
    recordingSamplesRef.current = [];
    signalWindowRef.current = [];
    rawBaselineWindowRef.current = [];
    breathingMarkersRef.current = [];
    lastFilteredSignalRef.current = null;
    lastCapturedVideoTimeRef.current = -1;
    lastSampleAtRef.current = 0;
    latestGoodEstimateAtRef.current = 0;
    bpmHistoryRef.current = [];
    reportReadingsRef.current = [];
    reportSignalQualityRef.current = [];
    lastReportReadingAtRef.current = Number.NEGATIVE_INFINITY;
    cleanSignalSecondsRef.current = 0;
    lastSignalQualityAtRef.current = 0;

    let stream: MediaStream | null = null;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('PPG:Open this page in a secure browser and allow camera access.');
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30, max: 30 },
        },
      });

      if (runToken !== runTokenRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('PPG:No camera video track was available.');

      const facingMode = videoTrack.getSettings().facingMode;
      if (facingMode === 'user') {
        throw new Error('PPG:This browser opened the front camera. Choose the rear camera to measure a fingertip.');
      }

      streamRef.current = stream;
      startedAtRef.current = performance.now();
      setCameraActive(true);
      setPhase('warming');

      let nextTorchStatus: PpgTorchStatus = 'unsupported';
      const capabilities = videoTrack.getCapabilities?.() as TorchCapabilities | undefined;
      if (capabilities?.torch) {
        try {
          await videoTrack.applyConstraints({
            advanced: [{ torch: true } as MediaTrackConstraintSet],
          });
          nextTorchStatus = 'on';
        } catch {
          nextTorchStatus = 'unavailable';
        }
      }
      if (runToken !== runTokenRef.current) return;
      setTorchStatus(nextTorchStatus);

      let video: HTMLVideoElement | null = null;
      const videoDeadline = Date.now() + 7000;
      while (!video && Date.now() < videoDeadline) {
        if (runToken !== runTokenRef.current) return;
        const candidate = videoElementRef.current;
        if (candidate) {
          if (candidate.srcObject !== stream) candidate.srcObject = stream;
          try {
            if (candidate.paused) await candidate.play();
          } catch {
            // The explicit readiness check below will show a useful timeout if autoplay is blocked.
          }
          if (candidate.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && candidate.videoWidth > 0) {
            video = candidate;
            break;
          }
        }
        await sleep(80);
      }
      if (runToken !== runTokenRef.current) return;
      if (!video) throw new Error('PPG:The camera preview did not start. Allow camera access and try again.');

      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('PPG:This browser could not prepare the local camera signal.');

      if (typeof MediaRecorder === 'undefined') {
        setVideoRecordingError('This browser cannot save camera video. Pulse measurement will still work.');
      } else {
        try {
          const mimeType = [
            'video/mp4;codecs=avc1.42E01E',
            'video/mp4',
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm',
          ].find((type) => MediaRecorder.isTypeSupported(type));
          const options: MediaRecorderOptions = { videoBitsPerSecond: 4_000_000 };
          if (mimeType) options.mimeType = mimeType;
          const recorder = new MediaRecorder(stream, options);
          videoChunksRef.current = [];
          recorder.ondataavailable = (event) => {
            if (event.data.size > 0) videoChunksRef.current.push(event.data);
          };
          recorder.onstop = () => {
            const chunks = videoChunksRef.current;
            videoChunksRef.current = [];
            setVideoRecordingActive(false);
            if (chunks.length === 0) return;

            const contentType = recorder.mimeType || 'video/webm';
            const blob = new Blob(chunks, { type: contentType });
            if (blob.size === 0) return;
            const extension = contentType.includes('mp4') ? 'mp4' : 'webm';
            const timestamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19);
            setRecordedVideoName(`ppg_better_${timestamp}.${extension}`);
            setRecordedVideoUrl(URL.createObjectURL(blob));
          };
          recorder.onerror = () => {
            setVideoRecordingActive(false);
            setVideoRecordingError('The browser could not finish saving this video. Pulse measurements remain available.');
          };
          recorder.start(1000);
          mediaRecorderRef.current = recorder;
          setVideoRecordingActive(true);
        } catch {
          setVideoRecordingError('Video recording is unavailable in this browser. Pulse measurement will still work.');
        }
      }

      const captureFrame = () => {
        if (runToken !== runTokenRef.current || !cameraActiveRef.current) return;

        try {
          const currentVideo = videoElementRef.current;
          const now = performance.now();
          if (
            currentVideo &&
            currentVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            currentVideo.videoWidth > 0 &&
            currentVideo.currentTime !== lastCapturedVideoTimeRef.current &&
            now - lastSampleAtRef.current >= SAMPLE_INTERVAL_MS
          ) {
            lastCapturedVideoTimeRef.current = currentVideo.currentTime;
            lastSampleAtRef.current = now;
            context.drawImage(currentVideo, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let lumaTotal = 0;
            let pixelCount = 0;
            for (let index = 0; index < pixels.length; index += 4) {
              const red = pixels[index] ?? 0;
              const green = pixels[index + 1] ?? 0;
              const blue = pixels[index + 2] ?? 0;
              lumaTotal += 0.299 * red + 0.587 * green + 0.114 * blue;
              pixelCount += 1;
            }

            if (pixelCount > 0) {
              const elapsed = (now - startedAtRef.current) / 1000;
              const lumaMean = lumaTotal / pixelCount;
              const baselineWindow = rawBaselineWindowRef.current;
              baselineWindow.push({ elapsedSeconds: elapsed, value: lumaMean });
              while (
                baselineWindow.length > 0 &&
                elapsed - (baselineWindow[0]?.elapsedSeconds ?? elapsed) > BASELINE_WINDOW_SECONDS
              ) {
                baselineWindow.shift();
              }

              const baseline =
                baselineWindow.reduce((sum, sample) => sum + sample.value, 0) /
                Math.max(1, baselineWindow.length);
              const centered = lumaMean - baseline;
              const previousFiltered = lastFilteredSignalRef.current;
              const filteredSignal =
                previousFiltered === null
                  ? centered
                  : FILTER_ALPHA * centered + (1 - FILTER_ALPHA) * previousFiltered;
              lastFilteredSignalRef.current = filteredSignal;

              const sample: PpgSample = { elapsedSeconds: elapsed, lumaMean, filteredSignal };
              recordingSamplesRef.current.push(sample);
              const signalWindow = signalWindowRef.current;
              signalWindow.push(sample);
              while (
                signalWindow.length > 0 &&
                elapsed - (signalWindow[0]?.elapsedSeconds ?? elapsed) > SIGNAL_WINDOW_SECONDS
              ) {
                signalWindow.shift();
              }
            }
          }
        } catch {
          if (runToken !== runTokenRef.current) return;
          runTokenRef.current += 1;
          publishFinalState();
          releaseCamera();
          setCameraActive(false);
          setTorchStatus('off');
          setPhase('error');
          setErrorMessage('The camera signal could not be read locally. Restart the measurement and try again.');
          return;
        }

        animationFrameRef.current = window.requestAnimationFrame(captureFrame);
      };

      animationFrameRef.current = window.requestAnimationFrame(captureFrame);
      publishTimerRef.current = window.setInterval(() => {
        if (runToken !== runTokenRef.current || !cameraActiveRef.current) return;
        const elapsed = (performance.now() - startedAtRef.current) / 1000;
        const estimate: PpgEstimate = estimatePpgHeartRate(signalWindowRef.current);
        const variabilityEstimate = estimatePpgVariability(signalWindowRef.current);
        const evaluatedAt = performance.now();
        if (estimate.bpm !== null && lastSignalQualityAtRef.current > 0) {
          const elapsedSinceEvaluation = Math.min(
            0.5,
            Math.max(0, (evaluatedAt - lastSignalQualityAtRef.current) / 1000),
          );
          cleanSignalSecondsRef.current = Math.min(
            60,
            cleanSignalSecondsRef.current + elapsedSinceEvaluation,
          );
          setCleanSignalSeconds(cleanSignalSecondsRef.current);
        }
        lastSignalQualityAtRef.current = evaluatedAt;
        setVariability(variabilityEstimate);
        setElapsedSeconds(elapsed);
        setSignalQuality(estimate.quality);
        setSampleCount(recordingSamplesRef.current.length);
        setSamples(recordingSamplesRef.current.slice(-DISPLAY_SAMPLE_LIMIT));

        if (estimate.bpm !== null) {
          const history = bpmHistoryRef.current;
          history.push(estimate.bpm);
          if (history.length > 3) history.shift();
          latestGoodEstimateAtRef.current = performance.now();
          setBpm(median(history));
          setPhase('live');
        } else if (
          latestGoodEstimateAtRef.current === 0 &&
          elapsed >= NO_SIGNAL_TIMEOUT_SECONDS
        ) {
          runTokenRef.current += 1;
          publishFinalState();
          releaseCamera();
          setCameraActive(false);
          setTorchStatus('off');
          setPhase('error');
          setErrorMessage(
            'No clean pulse was detected within 20 seconds, so the camera and flash were stopped to limit heating. Let the phone cool, then cover the rear lens and flash with your fingertip before trying again.',
          );
          return;
        } else if (performance.now() - latestGoodEstimateAtRef.current > 2500) {
          setBpm(null);
          setPhase('warming');
        }
        if (elapsed - lastReportReadingAtRef.current >= 1) {
          if (estimate.quality !== null && Number.isFinite(estimate.quality)) {
            reportSignalQualityRef.current.push(estimate.quality);
          }
          if (estimate.bpm !== null) {
            reportReadingsRef.current.push({
              elapsedSeconds: elapsed,
              signalQualityPercent: estimate.quality,
              heartRate: { value: estimate.bpm, confidence: null, unit: 'bpm' },
              respiratoryRate: null,
              hrvSdnn: variabilityEstimate.sdnnMs === null
                ? null
                : { value: variabilityEstimate.sdnnMs, confidence: null, unit: 'ms' },
              hrvRmssd: variabilityEstimate.rmssdMs === null
                ? null
                : { value: variabilityEstimate.rmssdMs, confidence: null, unit: 'ms' },
              hrvPnn50: variabilityEstimate.pnn50Percent === null
                ? null
                : { value: variabilityEstimate.pnn50Percent, confidence: null, unit: '%' },
              meanPulseInterval: variabilityEstimate.meanPpiMs === null
                ? null
                : { value: variabilityEstimate.meanPpiMs, confidence: null, unit: 'ms' },
            });
          }
          lastReportReadingAtRef.current = elapsed;
        }
      }, PUBLISH_INTERVAL_MS);

      videoTrack.addEventListener('ended', () => {
        if (runToken !== runTokenRef.current) return;
        runTokenRef.current += 1;
        publishFinalState();
        releaseCamera();
        setCameraActive(false);
        setTorchStatus('off');
        setPhase('error');
        setErrorMessage('The camera stopped unexpectedly. Start a new measurement to continue.');
      }, { once: true });
    } catch (error) {
      if (runToken !== runTokenRef.current) {
        if (stream && stream !== streamRef.current) {
          stream.getTracks().forEach((track) => track.stop());
        }
        return;
      }

      runTokenRef.current += 1;
      releaseCamera();
      if (stream && stream !== streamRef.current) {
        stream.getTracks().forEach((track) => track.stop());
      }
      setCameraActive(false);
      setTorchStatus('off');
      setPhase('error');
      setErrorMessage(describeCameraError(error));
    }
  }, [publishFinalState, releaseCamera]);

  const markBreathing = useCallback((event: PpgBreathingEvent) => {
    if (!cameraActiveRef.current || startedAtRef.current <= 0) return;
    const marker: PpgBreathingMarker = {
      elapsedSeconds: (performance.now() - startedAtRef.current) / 1000,
      event,
    };
    breathingMarkersRef.current.push(marker);
    setMarkers([...breathingMarkersRef.current]);
  }, []);

  const exportCsv = useCallback(() => {
    const recordedSamples = recordingSamplesRef.current;
    if (recordedSamples.length === 0) return;

    const header =
      'record_type,elapsed_seconds,luma_mean,filtered_signal,breathing_event,heart_rate_bpm,signal_quality_percent,sdnn_ms,rmssd_ms,pnn50_percent,mean_pulse_interval_ms';
    const rows = [
      ...recordedSamples.map((sample) => ({
        time: sample.elapsedSeconds,
        row: [
          'sample',
          sample.elapsedSeconds.toFixed(3),
          csvNumber(sample.lumaMean),
          csvNumber(sample.filteredSignal),
          '',
          '',
          '',
          '',
          '',
          '',
          '',
        ].join(','),
      })),
      ...reportReadingsRef.current.map((reading) => ({
        time: reading.elapsedSeconds,
        row: [
          'estimate',
          reading.elapsedSeconds.toFixed(3),
          '',
          '',
          '',
          reading.heartRate?.value === null || !reading.heartRate
            ? ''
            : csvNumber(reading.heartRate.value),
          reading.signalQualityPercent == null
            ? ''
            : csvNumber(reading.signalQualityPercent),
          reading.hrvSdnn?.value == null ? '' : csvNumber(reading.hrvSdnn.value),
          reading.hrvRmssd?.value == null ? '' : csvNumber(reading.hrvRmssd.value),
          reading.hrvPnn50?.value == null ? '' : csvNumber(reading.hrvPnn50.value),
          reading.meanPulseInterval?.value == null
            ? ''
            : csvNumber(reading.meanPulseInterval.value),
        ].join(','),
      })),
      ...breathingMarkersRef.current.map((marker) => ({
        time: marker.elapsedSeconds,
        row: [
          'marker',
          marker.elapsedSeconds.toFixed(3),
          '',
          '',
          marker.event,
          '',
          '',
          '',
          '',
          '',
          '',
        ].join(','),
      })),
    ];
    const csv = [
      header,
      ...rows
        .sort((left, right) => left.time - right.time)
        .map((entry) => entry.row),
    ].join('\r\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ppg_better_${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const downloadVideo = useCallback(() => {
    if (!recordedVideoUrl || !recordedVideoName) return;
    const anchor = document.createElement('a');
    anchor.href = recordedVideoUrl;
    anchor.download = recordedVideoName;
    anchor.rel = 'noopener';
    anchor.click();
  }, [recordedVideoName, recordedVideoUrl]);

  return {
    videoRef,
    phase,
    cameraActive,
    bpm,
    signalQuality,
    variability,
    torchStatus,
    elapsedSeconds,
    cleanSignalSeconds,
    errorMessage,
    samples,
    sampleCount,
    markers,
    recordedVideoUrl,
    recordedVideoName,
    videoRecordingActive,
    videoRecordingError,
    report,
    onStart: start,
    onStop: stop,
    onMarkBreathing: markBreathing,
    onExportCsv: exportCsv,
    onDownloadVideo: downloadVideo,
  };
}