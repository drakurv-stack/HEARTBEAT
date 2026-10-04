"""Live webcam rPPG: HR, SQI and ALL HRV metrics (open-rppg).

Run:  python live_hrv.py      Keys: q = quit
Every metric returned by the library is shown on screen and saved to hrv_log.csv.
"""
import csv
import time

import cv2
import numpy as np
import rppg

CAMERA = 0
WINDOW_S = 60       # analysis window in seconds
MIN_S = 30          # wait this long before showing HRV
UPDATE_EVERY = 1.0
LOG_FILE = "hrv_log.csv"

model = rppg.Model()
res = None
last = 0.0
writer = None


def scalar(v):
    """Turn numpy scalars into floats; skip arrays/lists (like the raw ibi list)."""
    if isinstance(v, (int, float, np.integer, np.floating)):
        return float(v)
    return None


with open(LOG_FILE, "w", newline="") as f, model.video_capture(CAMERA):
    for frame, box in model.preview:
        frame = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
        t = model.now

        if time.time() - last > UPDATE_EVERY and t >= 10:
            last = time.time()
            r = model.hr(start=-WINDOW_S)
            if r and r["hr"]:
                res = r
                row = {"time_s": round(t, 1), "hr_fft": res["hr"], "SQI": res["SQI"]}
                if t >= MIN_S:
                    for k, v in (res["hrv"] or {}).items():
                        if scalar(v) is not None:
                            row[k] = scalar(v)
                if writer is None and len(row) > 3:
                    writer = csv.DictWriter(f, fieldnames=list(row.keys()), extrasaction="ignore")
                    writer.writeheader()
                if writer:
                    writer.writerow(row)
                    f.flush()

        if box is not None:
            (y1, y2), (x1, x2) = box
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)

        lines = [f"Time {t:.0f}s (HRV after {MIN_S}s)"]
        if res:
            lines.append(f"HR (fft): {res['hr']:.1f}")
            lines.append(f"SQI: {res['SQI']:.2f}")
            if t >= MIN_S:
                for k, v in (res["hrv"] or {}).items():
                    if scalar(v) is not None:
                        lines.append(f"{k}: {scalar(v):.2f}")
        for i, text in enumerate(lines):
            cv2.putText(frame, text, (10, 24 + 22 * i),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 1)

        cv2.imshow("rPPG HRV", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

cv2.destroyAllWindows()
