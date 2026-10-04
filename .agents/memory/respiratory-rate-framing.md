---
name: Respiratory-rate camera framing
description: Capture and user guidance constraints for reliable VitalLens respiratory-rate estimates.
---

The VitalLens camera demo must frame both the face and upper chest for respiratory-rate estimates. Avoid heavy JPEG compression because it can discard the small color changes used by remote photoplethysmography. Preserve the frame-size limit while using the highest practical source resolution and image quality.

**Why:** VitalLens's official accuracy guidance says face-only framing is sufficient for heart rate, while face plus upper chest is required for respiratory rate. The same guidance warns that low-bitrate compression reduces signal quality.

**How to apply:** Keep face-and-upper-chest instructions visible before and during live measurement. When changing frame transport, prefer higher-quality camera images while preserving the server payload limit; never lower the RR confidence gate simply to show more readings.