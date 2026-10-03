---
name: Fingertip PPG source
description: User's source-of-truth and expected behavior for fingertip PPG.
---

The user identifies the uploaded PPGbetter Android app as the main reference for fingertip PPG and expects the feature to work and show a measured heart-rate reading. Preserve the distinction between a real signal and a fabricated or noise-derived estimate.

**Why:** The user explicitly said this is the main project file for fingertip PPG and asked why the heart-rate reading was not appearing.

**How to apply:** For fingertip PPG changes, compare camera illumination and signal extraction with the PPGbetter source; validate readings from sufficiently illuminated, stable samples and withhold results when the signal is too dark or unreliable.