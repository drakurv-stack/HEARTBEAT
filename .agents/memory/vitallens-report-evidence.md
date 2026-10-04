---
name: VitalLens report evidence
description: Product rules for what post-measurement reports may display and claim.
---

VitalLens reports describe one completed measurement at a time. Keep fingertip PPG and face-camera reports separate. Show only values returned or estimated by that modality for that session; omit unavailable metrics rather than filling them in. In the face-camera demo, prefer VitalLens HRV values when present; otherwise a local fallback may estimate SDNN/RMSSD from a quality-gated camera-colour waveform after at least 30 seconds of clean samples. Label those intervals as optical pulse-to-pulse data, not ECG R-R data. Never derive HRV from average heart rate or respiratory rate. Do not invent scores or claim stress, energy, health status, diagnosis, or population comparisons.

**Why:** The free VitalLens tier may omit HRV fields, while averaged heart and respiratory rates contain no beat-to-beat variation. The local waveform fallback preserves a usable signal source without implying ECG-equivalent measurements.

**How to apply:** Check report metrics, summaries, and stress baselines against the active session's source. Use API values before local estimates; keep source labels and quality gates, and avoid comparing baselines across sources. Withhold local HRV when the camera signal does not meet the estimator's quality requirements.