---
name: Live camera vitals scope
description: Preserve existing heart-rate and respiratory-rate behavior when extending the camera demo.
---

The live-camera demo already measures heart rate and respiratory rate successfully. New live camera metrics should be added without changing or replacing those existing behaviors.

**Why:** The user confirmed both measurements already work and requested that HRV be added without breaking them.

**How to apply:** Keep existing heart-rate and respiratory-rate calculations and display paths intact when extending the live camera demo.