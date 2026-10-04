"""JSON-lines worker used by the VitalLens Live browser demo."""

import base64
import binascii
import io
import json
import math
import os
import sys
import threading
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from vitallens import VitalLens


OUTPUT_LOCK = threading.Lock()
UPDATE_LOCK = threading.Lock()
def empty_update(result_sequence=0):
    return {
        "resultSequence": result_sequence,
        "faceDetected": False,
        "heartRate": None,
        "respiratoryRate": None,
        "hrvSdnn": None,
        "hrvRmssd": None,
        "ppgWaveform": None,
        "requestsRemaining": None,
        "apiError": None,
    }


latest_update = empty_update()


def emit(payload):
    with OUTPUT_LOCK:
        sys.stdout.write(json.dumps(payload, separators=(",", ":"), allow_nan=False))
        sys.stdout.write("\n")
        sys.stdout.flush()


def scalar(value):
    values = np.asarray(value).reshape(-1)
    if values.size == 0:
        return None
    number = float(values[-1])
    return number if math.isfinite(number) else None


def metric(vitals, key):
    vital = vitals.get(key)
    if not isinstance(vital, dict):
        return None
    value = scalar(vital.get("value"))
    confidence = scalar(vital.get("confidence"))
    if value is None or confidence is None:
        return None
    return {
        "value": value,
        "unit": str(vital.get("unit", "")),
        "confidence": confidence,
    }


def make_update(result):
    face = result.get("face", {})
    coordinates = face.get("coordinates", [])
    try:
        face_detected = np.asarray(coordinates).size > 0
    except (TypeError, ValueError):
        face_detected = False

    vitals = result.get("vitals", {})
    waveform = result.get("waveforms", {}).get("ppg_waveform")
    waveform_update = None
    if isinstance(waveform, dict):
        data = np.asarray(waveform.get("data", [])).reshape(-1)
        timestamps = np.asarray(result.get("time", [])).reshape(-1)
        confidence_values = waveform.get("confidence")
        confidence = (
            np.asarray(confidence_values).reshape(-1)
            if confidence_values is not None
            else None
        )
        fps = scalar(result.get("fps"))
        if (
            data.size > 1
            and timestamps.size == data.size
            and fps is not None
            and fps > 0
        ):
            valid = np.isfinite(data) & np.isfinite(timestamps)
            waveform_update = {
                "data": data[valid].astype(float).tolist(),
                "timestamps": timestamps[valid].astype(float).tolist(),
                "sampleRate": fps,
                "confidence": (
                    confidence[valid].astype(float).tolist()
                    if confidence is not None and confidence.size == data.size
                    else None
                ),
            }
    return {
        "faceDetected": bool(face_detected),
        "heartRate": metric(vitals, "heart_rate"),
        "respiratoryRate": metric(vitals, "respiratory_rate"),
        "hrvSdnn": metric(vitals, "hrv_sdnn"),
        "hrvRmssd": metric(vitals, "hrv_rmssd"),
        "ppgWaveform": waveform_update,
        "requestsRemaining": None,
        "apiError": None,
    }


def main():
    api_key = os.environ.get("VITALLENS_API_KEY")
    if not api_key:
        emit({"type": "error", "error": "VitalLens API key is not configured."})
        return 1

    try:
        client = VitalLens(method="vitallens", api_key=api_key)
        client.rppg.fps_target = 30.0
        api_state = {"error": None, "requestsRemaining": None}

        def observe_api_response(response, **_kwargs):
            remaining = None
            for header, value in response.headers.items():
                normalized = header.lower().replace("_", "-")
                if "remaining" not in normalized:
                    continue
                if not any(token in normalized for token in ("request", "quota", "rate")):
                    continue
                try:
                    candidate = int(value)
                except (TypeError, ValueError):
                    continue
                if candidate >= 0:
                    remaining = candidate
                    break

            api_state["requestsRemaining"] = remaining
            if response.status_code == 429:
                api_state["error"] = (
                    "VitalLens rate limit or monthly quota reached. "
                    "Wait before retrying or check your VitalLens plan."
                )
            elif response.status_code >= 400:
                api_state["error"] = (
                    "VitalLens could not process this measurement. "
                    "Check the API key, request limit, and connection."
                )
            else:
                api_state["error"] = None
            return response

        client.rppg.http_session.hooks.setdefault("response", []).append(
            observe_api_response
        )
        session = None
        result_sequence = 0

        def on_result(results):
            nonlocal result_sequence
            if not results:
                return
            update = make_update(results[0])
            update["requestsRemaining"] = api_state["requestsRemaining"]
            update["apiError"] = api_state["error"]
            with UPDATE_LOCK:
                if session is None or session.current_face is None or not update["faceDetected"]:
                    update = empty_update(result_sequence)
                else:
                    result_sequence += 1
                    update["resultSequence"] = result_sequence
                latest_update.update(update)
            emit({"type": "result", "update": update})

        session = client.stream(on_result=on_result)
    except Exception:
        emit({"type": "error", "error": "VitalLens could not initialize the live stream."})
        return 1

    emit({"type": "ready"})

    try:
        for line in sys.stdin:
            try:
                command = json.loads(line)
            except json.JSONDecodeError:
                emit({"type": "error", "error": "Invalid worker message."})
                continue

            if command.get("type") == "close":
                break
            if command.get("type") != "frame":
                emit({"type": "error", "error": "Unsupported worker message."})
                continue

            request_id = command.get("requestId")
            encoded = command.get("jpegBase64")
            timestamp = command.get("timestamp")
            if (
                not isinstance(request_id, str)
                or not isinstance(encoded, str)
                or len(encoded) > 150_000
                or not isinstance(timestamp, (int, float))
                or not math.isfinite(timestamp)
                or timestamp < 0
            ):
                emit(
                    {
                        "type": "frame-error",
                        "requestId": request_id,
                        "error": "Invalid camera frame.",
                    }
                )
                continue

            try:
                image_bytes = base64.b64decode(encoded, validate=True)
                with Image.open(io.BytesIO(image_bytes)) as image:
                    if image.format != "JPEG" or image.width * image.height > 640 * 480:
                        raise ValueError("Unsupported image size or format")
                    frame = np.asarray(image.convert("RGB"))
                session.push(frame, float(timestamp))
            except (binascii.Error, OSError, ValueError):
                emit(
                    {
                        "type": "frame-error",
                        "requestId": request_id,
                        "error": "The camera frame could not be decoded.",
                    }
                )
                continue
            except Exception:
                emit(
                    {
                        "type": "frame-error",
                        "requestId": request_id,
                        "error": "VitalLens could not process this camera frame.",
                    }
                )
                continue

            face_detected = session.current_face is not None
            with UPDATE_LOCK:
                if face_detected:
                    update = dict(latest_update)
                else:
                    update = empty_update(result_sequence)
                    latest_update.update(update)
                update["requestsRemaining"] = api_state["requestsRemaining"]
                update["apiError"] = api_state["error"]
            update["faceDetected"] = face_detected
            emit({"type": "frame", "requestId": request_id, "update": update})
    finally:
        session.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())