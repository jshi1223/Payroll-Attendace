from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Depends, Body, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi import BackgroundTasks
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
import cv2                  # FIX: moved from inside function to top-level
import numpy as np
import json
import os
import re
import shutil
import uuid
import anyio
import asyncio
import logging
import hashlib
import time
from itertools import groupby
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from passlib.context import CryptContext
import jwt
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.application import MIMEApplication
import base64
import random
import string
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from db import column_exists, get_db

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("attendance_system")

BASE_DIR = Path(__file__).resolve().parent
APP_RELEASE_FILE = BASE_DIR.parent / "app_release.json"


def _load_local_env() -> None:
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_local_env()


def _get_env(name: str, default: str) -> str:
    value = os.getenv(name, default).strip()
    return value or default


def _load_app_release() -> dict:
    if not APP_RELEASE_FILE.exists():
        return {}
    try:
        data = json.loads(APP_RELEASE_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        logger.warning("Invalid app_release.json; update metadata unavailable.")
        return {}
    public_keys = {
        "flutter_base_version",
        "latest_version",
        "min_supported_version",
        "force_update",
        "apk_url",
        "release_notes",
    }
    return {key: data.get(key) for key in public_keys if key in data}


APP_TIMEZONE = ZoneInfo(_get_env("APP_TIMEZONE", "Asia/Manila"))
PAYROLL_APP_URL = _get_env("PAYROLL_APP_URL", "http://localhost:3001")


def _local_now() -> datetime:
    return datetime.now(APP_TIMEZONE).replace(tzinfo=None)


app = FastAPI()


@app.middleware("http")
async def add_security_headers(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/admin-static/"):
        response.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    elif request.url.path.startswith("/face_images/"):
        response.headers.setdefault("Cache-Control", "public, max-age=604800")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.setdefault("Cross-Origin-Resource-Policy", "same-origin")
    if str(request.url.scheme).lower() == "https":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response

allowed_origins = [o.strip() for o in _get_env("CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins if allowed_origins != ["*"] else ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FACE_IMAGES_DIR = BASE_DIR / _get_env("FACE_IMAGES_DIR", "face_images")
FACE_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
FACE_THUMBNAILS_DIR = FACE_IMAGES_DIR / ".thumbnails"
FACE_THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/face_images", StaticFiles(directory=str(FACE_IMAGES_DIR)), name="face_images")
app.mount("/attendance-faces", StaticFiles(directory=str(FACE_IMAGES_DIR)), name="attendance_faces")

RATE_LIMIT_THRESHOLD = int(_get_env("RATE_LIMIT_THRESHOLD", "3"))
RATE_LIMIT_BASE_DELAY_MINUTES = int(_get_env("RATE_LIMIT_BASE_DELAY_MINUTES", "1"))
RATE_LIMIT_MAX_DELAY_MINUTES = int(_get_env("RATE_LIMIT_MAX_DELAY_MINUTES", "10"))
RATE_LIMIT_RESET_AFTER_MINUTES = int(_get_env("RATE_LIMIT_RESET_AFTER_MINUTES", "30"))


@app.get("/admin", include_in_schema=False)
def admin_redirect():
    return RedirectResponse(url=PAYROLL_APP_URL)


@app.get("/admin/", include_in_schema=False)
def admin_panel():
    return RedirectResponse(url=PAYROLL_APP_URL)


@app.get("/admin/attendance", include_in_schema=False)
def attendance_admin_redirect():
    return RedirectResponse(url=PAYROLL_APP_URL)


@app.get("/admin/attendance/", include_in_schema=False)
def attendance_admin_panel():
    return RedirectResponse(url=PAYROLL_APP_URL)


@app.get("/admin/payroll/", include_in_schema=False)
def payroll_admin_panel():
    return RedirectResponse(url=PAYROLL_APP_URL)


@app.get("/admin/payroll", include_in_schema=False)
def payroll_admin_panel_no_slash():
    return RedirectResponse(url=PAYROLL_APP_URL)


@app.get("/", include_in_schema=False)
async def root_redirect():
    return RedirectResponse(url=PAYROLL_APP_URL)

def _normalize_email(value: str) -> str:
    return value.strip().lower()


def _normalize_phone_digits(value: str) -> str:
    return "".join(ch for ch in value if ch.isdigit())


def _phone_candidates(value: str):
    digits = _normalize_phone_digits(value)
    candidates = {digits}
    if digits.startswith("63") and len(digits) > 2:
        candidates.add(digits[2:])
    if digits.startswith("0") and len(digits) > 1:
        candidates.add(digits[1:])
    return {c for c in candidates if c}


def _format_duration(start: datetime | None, end: datetime | None) -> str | None:
    if not start or not end:
        return None
    total_seconds = int((end - start).total_seconds())
    if total_seconds < 0:
        return None
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def _to_float(value, default: float = 0.0) -> float:
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _audit(cursor, admin_user: str, action: str, target_type: str, target_id: str = "", details: dict | None = None) -> None:
    cursor.execute(
        """
        INSERT INTO admin_audit_logs (admin_user, action, target_type, target_id, details)
        VALUES (%s, %s, %s, %s, %s)
        """,
        (
            admin_user,
            action,
            target_type,
            target_id or None,
            json.dumps(details or {}, default=str),
        ),
    )


def _log_payroll_audit(cursor, action: str, entity: str, entity_id=None, details: dict | None = None) -> None:
    """Writes an entry into the payroll admin panel's audit trail
    (public.audit_logs). user_id is NULL because the entry originates from the
    attendance backend, not a logged-in panel user (the panel renders it as
    'System')."""
    cursor.execute(
        """
        INSERT INTO public.audit_logs (user_id, action, entity, entity_id, details)
        VALUES (NULL, %s, %s, %s, %s::jsonb)
        """,
        (action, entity, entity_id, json.dumps(details or {}, default=str)),
    )


def _parse_audit_details(value) -> dict:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    except (TypeError, ValueError):
        return {"value": value}


def _locked_payroll_for_date(cursor, employee_id: str, work_date) -> dict | None:
    if not employee_id or not work_date:
        return None
    cursor.execute(
        """
        SELECT ps.week_start AS start_date,
               ps.week_start + COALESCE(pe.pay_period_days, 7) - 1 AS end_date,
               to_char(ps.week_start, 'YYYY-MM-DD') AS period_key,
               ps.status
        FROM public.payroll_statuses ps
        JOIN public.employees pe ON pe.id = ps.employee_id
        JOIN employees e ON e.payroll_employee_id = ps.employee_id
        WHERE e.employee_id = %s
          AND ps.status = 'generated'
          AND %s BETWEEN ps.week_start
                     AND ps.week_start + COALESCE(pe.pay_period_days, 7) - 1
        LIMIT 1
        """,
        (employee_id, work_date),
    )
    return cursor.fetchone()


def _raise_if_payroll_locked(cursor, employee_id: str, work_date) -> None:
    locked = _locked_payroll_for_date(cursor, employee_id, work_date)
    if locked:
        raise HTTPException(
            status_code=400,
            detail=f"Payroll is locked for this employee/date ({locked['period_key']}). Unlock is required before editing.",
        )


def _normalize_rate_limit_key(value: str) -> str:
    return " ".join(value.strip().lower().split())


def _rate_limit_storage_key(action_name: str, identifier: str) -> str:
    normalized = _normalize_rate_limit_key(identifier)
    raw_key = f"{action_name}:{normalized}"
    if len(raw_key) <= 220:
        return raw_key
    digest = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()
    return f"{action_name}:sha256:{digest}"


def _rate_limit_block_message(wait_seconds: int) -> str:
    wait_minutes = max(1, int((wait_seconds + 59) // 60))
    unit = "minute" if wait_minutes == 1 else "minutes"
    return f"Too many attempts. Please wait about {wait_minutes} {unit} before trying again."


def _ensure_rate_limit_schema() -> None:
    db = get_db()
    try:
        cursor = db.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS auth_rate_limits (
                id SERIAL PRIMARY KEY,
                limiter_key VARCHAR(255) NOT NULL,
                action_name VARCHAR(100) NOT NULL,
                failure_count INT NOT NULL DEFAULT 0,
                throttle_level INT NOT NULL DEFAULT 0,
                blocked_until TIMESTAMP NULL,
                last_attempt_at TIMESTAMP NULL,
                last_failure_at TIMESTAMP NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT uq_auth_rate_limits_key_action UNIQUE (limiter_key, action_name)
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_blocked_until ON auth_rate_limits (blocked_until)")
        db.commit()
    finally:
        db.close()


def _get_rate_limit_state(cursor, limiter_key: str, action_name: str) -> dict | None:
    cursor.execute("""
        SELECT id, failure_count, throttle_level, blocked_until, last_attempt_at, last_failure_at
        FROM auth_rate_limits
        WHERE limiter_key = %s AND action_name = %s
        LIMIT 1
    """, (limiter_key, action_name))
    return cursor.fetchone()


def _enforce_rate_limit(cursor, limiter_key: str, action_name: str) -> None:
    state = _get_rate_limit_state(cursor, limiter_key, action_name)
    if not state or not state.get("blocked_until"):
        return

    now = datetime.now()
    blocked_until = state["blocked_until"]
    if blocked_until <= now:
        return

    retry_after = max(1, int((blocked_until - now).total_seconds()))
    raise HTTPException(
        status_code=429,
        detail=_rate_limit_block_message(retry_after),
        headers={"Retry-After": str(retry_after)},
    )


def _clear_rate_limit(cursor, limiter_key: str, action_name: str) -> None:
    cursor.execute("""
        DELETE FROM auth_rate_limits
        WHERE limiter_key = %s AND action_name = %s
    """, (limiter_key, action_name))


def _register_rate_limit_failure(cursor, limiter_key: str, action_name: str) -> int | None:
    now = datetime.now()
    state = _get_rate_limit_state(cursor, limiter_key, action_name)
    if state and state.get("blocked_until") and state["blocked_until"] > now:
        remaining = int((state["blocked_until"] - now).total_seconds())
        return max(1, remaining)

    if state and state.get("last_attempt_at"):
        last_attempt_at = state["last_attempt_at"]
        if (now - last_attempt_at).total_seconds() >= RATE_LIMIT_RESET_AFTER_MINUTES * 60:
            state = None

    failure_count = 0 if state is None else int(state.get("failure_count") or 0)
    throttle_level = 0 if state is None else int(state.get("throttle_level") or 0)
    failure_count += 1

    if state is None:
        cursor.execute("""
            INSERT INTO auth_rate_limits (
                limiter_key, action_name, failure_count, throttle_level, blocked_until, last_attempt_at, last_failure_at
            ) VALUES (%s, %s, %s, %s, NULL, %s, %s)
        """, (limiter_key, action_name, failure_count, throttle_level, now, now))
    else:
        cursor.execute("""
            UPDATE auth_rate_limits
            SET failure_count = %s,
                throttle_level = %s,
                blocked_until = NULL,
                last_attempt_at = %s,
                last_failure_at = %s
            WHERE id = %s
        """, (failure_count, throttle_level, now, now, state["id"]))

    if failure_count > RATE_LIMIT_THRESHOLD:
        throttle_level = min(
            max(1, throttle_level + 1),
            RATE_LIMIT_MAX_DELAY_MINUTES
        )
        blocked_until = now + timedelta(minutes=throttle_level * RATE_LIMIT_BASE_DELAY_MINUTES)
        cursor.execute("""
            UPDATE auth_rate_limits
            SET failure_count = 0,
                throttle_level = %s,
                blocked_until = %s,
                last_attempt_at = %s,
                last_failure_at = %s
            WHERE limiter_key = %s AND action_name = %s
        """, (throttle_level, blocked_until, now, now, limiter_key, action_name))
        return throttle_level * RATE_LIMIT_BASE_DELAY_MINUTES * 60

    return None


# --- SMTP Configuration for Email Sending ---
SMTP_HOST = _get_env("SMTP_HOST", "") # Example: smtp.gmail.com
SMTP_PORT = int(_get_env("SMTP_PORT", "587"))
SMTP_USER = _get_env("SMTP_EMAIL", "") # Your email address
SMTP_PASSWORD = _get_env("SMTP_APP_PASSWORD", "") # Your email password or app password
SMTP_SENDER_EMAIL = _get_env("SMTP_EMAIL", "")
RESEND_API_KEY = _get_env("RESEND_API_KEY", "")
RESEND_FROM = _get_env("RESEND_FROM", "noreply@example.com")
APPROVAL_NOTIFY_EMAILS = [
    email.strip()
    for email in _get_env("APPROVAL_NOTIFY_EMAILS", "").split(",")
    if email.strip()
]
RESET_CODE_EXPIRE_MINUTES = int(_get_env("RESET_CODE_EXPIRE_MINUTES", "10"))
FCM_SERVICE_ACCOUNT_JSON = _get_env("FCM_SERVICE_ACCOUNT_JSON", "")
TIME_OUT_REMINDER_AFTER_MINUTES = int(_get_env("TIME_OUT_REMINDER_AFTER_MINUTES", "480"))
TIME_OUT_REMINDER_REPEAT_MINUTES = int(_get_env("TIME_OUT_REMINDER_REPEAT_MINUTES", "30"))
TIME_OUT_REMINDER_SCAN_SECONDS = int(_get_env("TIME_OUT_REMINDER_SCAN_SECONDS", "300"))
TIME_IN_REMINDER_START_HOUR = int(_get_env("TIME_IN_REMINDER_START_HOUR", "7"))
TIME_IN_REMINDER_END_HOUR = int(_get_env("TIME_IN_REMINDER_END_HOUR", "11"))
TIME_IN_REMINDER_SCAN_SECONDS = int(_get_env("TIME_IN_REMINDER_SCAN_SECONDS", "300"))
WEEKLY_DIGEST_WEEKDAY = int(_get_env("WEEKLY_DIGEST_WEEKDAY", "0"))  # 0 = Monday
WEEKLY_DIGEST_START_HOUR = int(_get_env("WEEKLY_DIGEST_START_HOUR", "8"))
WEEKLY_DIGEST_END_HOUR = int(_get_env("WEEKLY_DIGEST_END_HOUR", "10"))
WEEKLY_DIGEST_SCAN_SECONDS = int(_get_env("WEEKLY_DIGEST_SCAN_SECONDS", "600"))
PAYROLL_NOTIFY_URL = _get_env("PAYROLL_NOTIFY_URL", "http://127.0.0.1:3001/internal/notify").strip()
INTERNAL_NOTIFY_SECRET = _get_env("INTERNAL_NOTIFY_SECRET", "").strip()
_FCM_ACCESS_TOKEN = ""
_FCM_ACCESS_TOKEN_EXPIRES_AT = 0.0

def _generate_reset_code(length=6):
    characters = string.digits
    return ''.join(random.choice(characters) for i in range(length))

def _email_delivery_configured() -> bool:
    return bool(RESEND_API_KEY) or all([SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SENDER_EMAIL])

def _send_email(recipient_email: str, subject: str, body: str):
    if RESEND_API_KEY:
        payload = json.dumps({
            "from": RESEND_FROM,
            "to": [recipient_email],
            "subject": subject,
            "text": body,
        }).encode("utf-8")
        request = urllib.request.Request(
            "https://api.resend.com/emails",
            data=payload,
            headers={
                "Authorization": f"Bearer {RESEND_API_KEY}",
                "Content-Type": "application/json",
                "User-Agent": "kvsk-attendance-system/1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=12) as response:
                if 200 <= response.status < 300:
                    logger.info("Resend email sent to %s for subject: %s", recipient_email, subject)
                    return True
                logger.error("Resend returned status %s for %s", response.status, recipient_email)
                return False
        except urllib.error.HTTPError as exc:
            body_text = exc.read().decode("utf-8", errors="replace")
            logger.error("Resend failed for %s: HTTP %s %s", recipient_email, exc.code, body_text)
            return False
        except Exception as exc:
            logger.error("Resend failed for %s: %s", recipient_email, exc)
            return False

    if not all([SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SENDER_EMAIL]):
        logger.error("Email configuration is incomplete. Cannot send email.")
        return False
    msg = MIMEText(body)
    msg['Subject'] = subject
    msg['From'] = SMTP_SENDER_EMAIL
    msg['To'] = recipient_email
    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls(); server.login(SMTP_USER, SMTP_PASSWORD); server.send_message(msg)
        logger.info(f"Email sent to {recipient_email} for subject: {subject}")
        return True
    except Exception as e:
        logger.error(f"Failed to send email to {recipient_email}: {e}"); return False


def _send_emails(recipient_emails: list[str], subject: str, body: str) -> bool:
    recipients = []
    seen = set()
    for email in recipient_emails:
        clean = (email or "").strip()
        if clean and clean.lower() not in seen:
            seen.add(clean.lower())
            recipients.append(clean)
    if not recipients:
        return False
    results = [_send_email(email, subject, body) for email in recipients]
    return any(results)


def _fcm_service_account() -> dict | None:
    if not FCM_SERVICE_ACCOUNT_JSON:
        return None
    try:
        data = json.loads(FCM_SERVICE_ACCOUNT_JSON)
    except json.JSONDecodeError:
        logger.error("FCM_SERVICE_ACCOUNT_JSON is not valid JSON.")
        return None
    required = ["client_email", "private_key", "project_id"]
    if not all(data.get(key) for key in required):
        logger.error("FCM service account is missing required fields.")
        return None
    return data


def _get_fcm_access_token() -> str | None:
    global _FCM_ACCESS_TOKEN, _FCM_ACCESS_TOKEN_EXPIRES_AT
    account = _fcm_service_account()
    if not account:
        return None

    now = time.time()
    if _FCM_ACCESS_TOKEN and now < _FCM_ACCESS_TOKEN_EXPIRES_AT - 60:
        return _FCM_ACCESS_TOKEN

    token_uri = account.get("token_uri") or "https://oauth2.googleapis.com/token"
    payload = {
        "iss": account["client_email"],
        "scope": "https://www.googleapis.com/auth/firebase.messaging",
        "aud": token_uri,
        "iat": int(now),
        "exp": int(now) + 3600,
    }
    assertion = jwt.encode(payload, account["private_key"], algorithm="RS256")
    form_body = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": assertion,
    }).encode("utf-8")
    request = urllib.request.Request(
        token_uri,
        data=form_body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            token_data = json.loads(response.read().decode("utf-8"))
            _FCM_ACCESS_TOKEN = token_data.get("access_token", "")
            _FCM_ACCESS_TOKEN_EXPIRES_AT = now + int(token_data.get("expires_in", 3600))
            return _FCM_ACCESS_TOKEN or None
    except Exception as exc:
        logger.error("FCM token request failed: %s", exc)
        return None


def _send_fcm_to_employee(cursor, employee_id: str, title: str, body: str, data: dict | None = None) -> bool:
    token = _get_fcm_access_token()
    account = _fcm_service_account()
    if not token or not account or not employee_id:
        return False

    cursor.execute(
        """
        SELECT device_token
        FROM employee_device_tokens
        WHERE employee_id = %s
        ORDER BY updated_at DESC
        LIMIT 5
        """,
        (employee_id,),
    )
    device_tokens = [row["device_token"] for row in cursor.fetchall() if row.get("device_token")]
    if not device_tokens:
        return False

    sent = False
    endpoint = f"https://fcm.googleapis.com/v1/projects/{account['project_id']}/messages:send"
    for device_token in device_tokens:
        payload = {
            "message": {
                "token": device_token,
                "notification": {"title": title, "body": body},
                "data": {str(k): str(v) for k, v in (data or {}).items()},
                "android": {"priority": "high"},
            }
        }
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                sent = sent or 200 <= response.status < 300
        except urllib.error.HTTPError as exc:
            body_text = exc.read().decode("utf-8", errors="replace")
            logger.warning("FCM send failed for %s: HTTP %s %s", employee_id, exc.code, body_text)
        except Exception as exc:
            logger.warning("FCM send failed for %s: %s", employee_id, exc)
    return sent


def _notify_payroll_panel(event: str, payload: dict | None = None) -> None:
    """Tell the payroll admin server that data changed so open panels refresh
    instantly instead of polling on a timer."""
    if not PAYROLL_NOTIFY_URL:
        return
    try:
        body = json.dumps({
            "type": "data_changed",
            "source": "attendance",
            "event": event,
            **(payload or {}),
        }).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if INTERNAL_NOTIFY_SECRET:
            headers["X-Notify-Secret"] = INTERNAL_NOTIFY_SECRET
        request = urllib.request.Request(
            PAYROLL_NOTIFY_URL,
            data=body,
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=3) as response:
            response.read()
    except Exception as exc:
        logger.debug("Payroll panel notify failed (%s): %s", event, exc)


def _send_due_time_out_reminders() -> int:
    now = _local_now()
    due_before = now - timedelta(minutes=TIME_OUT_REMINDER_AFTER_MINUTES)
    repeat_before = now - timedelta(minutes=TIME_OUT_REMINDER_REPEAT_MINUTES)
    db = get_db()
    sent_count = 0
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT
                a.id AS time_in_id,
                a.employee_id,
                a.timestamp AS time_in_at,
                e.name,
                COALESCE(r.reminder_count, 0) AS reminder_count,
                r.last_sent_at
            FROM attendance a
            JOIN employees e ON e.employee_id = a.employee_id
            LEFT JOIN attendance_reminders r ON r.time_in_id = a.id
            WHERE a.type = 'time_in'
              AND a.timestamp <= %s
              AND NOT EXISTS (
                  SELECT 1
                  FROM attendance out_log
                  WHERE out_log.employee_id = a.employee_id
                    AND out_log.type = 'time_out'
                    AND out_log.timestamp > a.timestamp
              )
              AND (r.last_sent_at IS NULL OR r.last_sent_at <= %s)
            ORDER BY a.timestamp ASC
            LIMIT 50
            """,
            (due_before, repeat_before),
        )
        rows = cursor.fetchall()
        for row in rows:
            time_in_at = row.get("time_in_at")
            hours_open = (now - time_in_at).total_seconds() / 3600 if time_in_at else 0
            body = (
                f"You have been timed in for {hours_open:.1f} hours. "
                "Please time out when your shift is done."
            )
            sent = _send_fcm_to_employee(
                cursor,
                row["employee_id"],
                "Time out reminder",
                body,
                {
                    "type": "time_out_reminder",
                    "employee_id": row["employee_id"],
                    "time_in_id": row["time_in_id"],
                    "time_in_at": time_in_at.isoformat() if time_in_at else "",
                },
            )
            if not sent:
                continue
            cursor.execute(
                """
                INSERT INTO attendance_reminders (employee_id, time_in_id, reminder_count, last_sent_at)
                VALUES (%s, %s, 1, %s)
                ON CONFLICT (time_in_id)
                DO UPDATE SET
                    reminder_count = attendance_reminders.reminder_count + 1,
                    last_sent_at = EXCLUDED.last_sent_at
                """,
                (row["employee_id"], row["time_in_id"], now),
            )
            sent_count += 1
        db.commit()
        return sent_count
    finally:
        db.close()


async def _time_out_reminder_loop() -> None:
    while True:
        try:
            sent = await anyio.to_thread.run_sync(_send_due_time_out_reminders)
            if sent:
                logger.info("Sent %s time out reminder notification(s).", sent)
        except Exception as exc:
            logger.warning("Time out reminder scan failed: %s", exc)
        await asyncio.sleep(max(TIME_OUT_REMINDER_SCAN_SECONDS, 60))


def _send_due_time_in_reminders() -> int:
    """Reminds approved employees who have not marked attendance yet, but only
    within the configured morning window and on weekdays."""
    now = _local_now()
    if now.weekday() >= 5:
        return 0
    if now.hour < TIME_IN_REMINDER_START_HOUR or now.hour >= TIME_IN_REMINDER_END_HOUR:
        return 0
    db = get_db()
    sent_count = 0
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT e.employee_id, e.name
            FROM employees e
            WHERE e.status = 'approved'
              AND e.payroll_employee_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM attendance a
                  WHERE a.employee_id = e.employee_id
                    AND a.type IN ('present', 'time_in')
                    AND DATE(a.timestamp) = %s
              )
              AND NOT EXISTS (
                  SELECT 1 FROM time_in_reminders r
                  WHERE r.employee_id = e.employee_id AND r.remind_date = %s
              )
            LIMIT 50
            """,
            (now.date(), now.date()),
        )
        rows = cursor.fetchall()
        for row in rows:
            raw_name = str(row.get("name") or "").strip()
            first_name = raw_name.split()[0] if raw_name else "there"
            sent = _send_fcm_to_employee(
                cursor,
                row["employee_id"],
                "Time in reminder",
                f"Good morning {first_name}! Don't forget to mark your attendance today.",
                {
                    "type": "time_in_reminder",
                    "employee_id": row["employee_id"],
                    "screen": "attendance",
                },
            )
            if not sent:
                continue
            cursor.execute(
                """
                INSERT INTO time_in_reminders (employee_id, remind_date)
                VALUES (%s, %s)
                ON CONFLICT (employee_id, remind_date) DO NOTHING
                """,
                (row["employee_id"], now.date()),
            )
            sent_count += 1
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    return sent_count


async def _time_in_reminder_loop() -> None:
    while True:
        try:
            sent = await anyio.to_thread.run_sync(_send_due_time_in_reminders)
            if sent:
                logger.info("Sent %s time in reminder notification(s).", sent)
        except Exception as exc:
            logger.warning("Time in reminder scan failed: %s", exc)
        await asyncio.sleep(max(TIME_IN_REMINDER_SCAN_SECONDS, 60))


def _send_weekly_digests() -> int:
    """Monday-morning summary of the previous calendar week's attendance and
    earnings for each approved, payroll-linked employee."""
    now = _local_now()
    if now.weekday() != WEEKLY_DIGEST_WEEKDAY:
        return 0
    if now.hour < WEEKLY_DIGEST_START_HOUR or now.hour >= WEEKLY_DIGEST_END_HOUR:
        return 0
    this_monday = (now - timedelta(days=now.weekday())).date()
    prev_monday = this_monday - timedelta(days=7)
    prev_sunday = this_monday - timedelta(days=1)
    db = get_db()
    sent_count = 0
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT e.employee_id, e.name, e.payroll_employee_id
            FROM employees e
            WHERE e.status = 'approved' AND e.payroll_employee_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM weekly_digests d
                  WHERE d.employee_id = e.employee_id AND d.week_start = %s
              )
            LIMIT 100
            """,
            (prev_monday,),
        )
        rows = cursor.fetchall()
        for row in rows:
            cursor.execute(
                """
                SELECT COUNT(*) AS present_days,
                       COALESCE(SUM(rate_snapshot), 0) AS earnings
                FROM public.attendance_logs
                WHERE employee_id = %s AND work_date BETWEEN %s AND %s
                """,
                (row["payroll_employee_id"], prev_monday, prev_sunday),
            )
            stats = cursor.fetchone()
            present_days = int(stats["present_days"] or 0)
            earnings = float(stats["earnings"] or 0)
            if present_days == 0:
                continue
            sent = _send_fcm_to_employee(
                cursor,
                row["employee_id"],
                "Weekly summary",
                f"Last week you were present for {present_days} day(s) with attendance earnings of ₱{earnings:,.2f}.",
                {
                    "type": "weekly_digest",
                    "employee_id": row["employee_id"],
                    "screen": "payroll",
                    "week_start": str(prev_monday),
                },
            )
            if not sent:
                continue
            cursor.execute(
                """
                INSERT INTO weekly_digests (employee_id, week_start)
                VALUES (%s, %s)
                ON CONFLICT (employee_id, week_start) DO NOTHING
                """,
                (row["employee_id"], prev_monday),
            )
            sent_count += 1
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    return sent_count


async def _weekly_digest_loop() -> None:
    while True:
        try:
            sent = await anyio.to_thread.run_sync(_send_weekly_digests)
            if sent:
                logger.info("Sent %s weekly digest notification(s).", sent)
        except Exception as exc:
            logger.warning("Weekly digest scan failed: %s", exc)
        await asyncio.sleep(max(WEEKLY_DIGEST_SCAN_SECONDS, 60))


@app.on_event("startup")
async def start_background_notifications() -> None:
    asyncio.create_task(_time_out_reminder_loop())
    asyncio.create_task(_time_in_reminder_loop())
    asyncio.create_task(_weekly_digest_loop())


def _notify_admin_registration(name: str, email: str, phone: str) -> None:
    if not APPROVAL_NOTIFY_EMAILS:
        return
    subject = "New attendance registration pending approval"
    body = (
        "A new employee registration is waiting for admin review.\n\n"
        f"Name: {name}\n"
        f"Email: {email}\n"
        f"Phone: {phone}\n\n"
        "Open the admin dashboard and check Approvals."
    )
    _send_emails(APPROVAL_NOTIFY_EMAILS, subject, body)


def _notify_employee_approval(email: str, name: str, employee_id: str) -> None:
    if not email:
        return
    subject = "Your attendance account was approved"
    body = (
        f"Hi {name},\n\n"
        "Your attendance account has been approved.\n\n"
        f"Employee ID: {employee_id}\n\n"
        "You may now log in and use the attendance app."
    )
    _send_email(email, subject, body)


def _notify_employee_rejection(email: str, name: str, notes: str) -> None:
    if not email:
        return
    reason = notes.strip() or "No specific reason was provided."
    subject = "Your attendance registration was not approved"
    body = (
        f"Hi {name},\n\n"
        "Your attendance registration was reviewed but was not approved.\n\n"
        f"Reason: {reason}\n\n"
        "Please contact the administrator if you need help."
    )
    _send_email(email, subject, body)

def _pair_attendance_sessions(records: list[dict]) -> list[dict]:
    sessions: list[dict] = []
    open_session: dict | None = None

    for record in records:
        record_type = str(record.get("type") or "").strip().lower()
        timestamp = record.get("timestamp")
        if not record_type or not timestamp:
            continue

        if record_type == "time_in":
            if open_session:
                sessions.append(open_session)
            open_session = {
                "work_date": timestamp.date(),
                "time_in": timestamp,
                "time_out": None,
                "time_out_date": None,
                "duration": None,
                "daily_rate": record.get("rate_snapshot"),
            }
        elif record_type == "present":
            if open_session:
                sessions.append(open_session)
            open_session = {
                "work_date": timestamp.date(),
                "time_in": timestamp,
                "time_out": None,
                "time_out_date": None,
                "duration": None,
                "daily_rate": record.get("rate_snapshot"),
            }
        elif record_type == "time_out":
            if open_session and open_session.get("time_out") is None:
                open_session["time_out"] = timestamp
                open_session["time_out_date"] = timestamp.date()
                open_session["duration"] = _format_duration(open_session["time_in"], timestamp)
                sessions.append(open_session)
                open_session = None
            else:
                sessions.append({
                    "work_date": timestamp.date(),
                    "time_in": None,
                    "time_out": timestamp,
                    "time_out_date": timestamp.date(),
                    "duration": None,
                    "daily_rate": record.get("rate_snapshot"),
                })

    if open_session:
        sessions.append(open_session)

    return sessions


def _ensure_employee_auth_schema() -> None:
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        if not column_exists(cursor, "employees", "password_hash"):
            cursor.execute("ALTER TABLE employees ADD COLUMN password_hash VARCHAR(255) NULL")
            db.commit()
    finally:
        db.close()


def _ensure_attendance_schema() -> None:
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        if not column_exists(cursor, "employees", "daily_rate"):
            cursor.execute("ALTER TABLE employees ADD COLUMN daily_rate DECIMAL(10,2) NOT NULL DEFAULT 0")
        if not column_exists(cursor, "attendance", "rate_snapshot"):
            cursor.execute("ALTER TABLE attendance ADD COLUMN rate_snapshot DECIMAL(10,2) NULL")
        cursor.execute("""
            UPDATE attendance a
            SET rate_snapshot = e.daily_rate
            FROM employees e
            WHERE a.employee_id = e.employee_id
              AND a.type = 'time_in'
              AND a.rate_snapshot IS NULL
        """)
        for col, definition in {
            "first_name": "VARCHAR(80) NOT NULL DEFAULT ''",
            "last_name": "VARCHAR(80) NOT NULL DEFAULT ''",
            "sss_number": "VARCHAR(12) NOT NULL DEFAULT ''",
            "philhealth_number": "VARCHAR(14) NOT NULL DEFAULT ''",
            "pagibig_number": "VARCHAR(14) NOT NULL DEFAULT ''",
            "tin_number": "VARCHAR(15) NOT NULL DEFAULT ''",
            "payroll_employee_id": "INTEGER NULL",
            "session_key": "VARCHAR(64) NOT NULL DEFAULT ''",
            "device_id": "VARCHAR(64) NOT NULL DEFAULT ''",
        }.items():
            if not column_exists(cursor, "employees", col):
                cursor.execute(f"ALTER TABLE employees ADD COLUMN {col} {definition}")
        db.commit()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS admin_audit_logs (
                id SERIAL PRIMARY KEY,
                admin_user VARCHAR(100) NULL,
                action VARCHAR(100) NOT NULL,
                target_type VARCHAR(50) NOT NULL,
                target_id VARCHAR(100) NULL,
                details TEXT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_created_at ON admin_audit_logs (created_at)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_action ON admin_audit_logs (action)")
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS time_in_reminders (
                id SERIAL PRIMARY KEY,
                employee_id VARCHAR(50) NOT NULL,
                remind_date DATE NOT NULL,
                sent_count INT NOT NULL DEFAULT 1,
                last_sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT uq_time_in_reminder_date UNIQUE (employee_id, remind_date)
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_time_in_reminders_employee_date ON time_in_reminders (employee_id, remind_date)")
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS weekly_digests (
                id SERIAL PRIMARY KEY,
                employee_id VARCHAR(50) NOT NULL,
                week_start DATE NOT NULL,
                sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT uq_weekly_digest UNIQUE (employee_id, week_start)
            )
        """)
        db.commit()
    finally:
        db.close()


def _ensure_employee_reset_schema() -> None:
    db = get_db()
    try:
        cursor = db.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS employee_password_reset_requests (
                id SERIAL PRIMARY KEY,
                employee_id VARCHAR(50) NULL,
                email VARCHAR(255) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'pending',
                requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                processed_at TIMESTAMP NULL DEFAULT NULL,
                admin_notes TEXT NULL,
                CONSTRAINT fk_employee_reset_employee
                    FOREIGN KEY (employee_id) REFERENCES employees(employee_id)
                    ON DELETE SET NULL
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_employee_reset_employee_id ON employee_password_reset_requests (employee_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_employee_reset_email ON employee_password_reset_requests (email)")
        if not column_exists(cursor, "employee_password_reset_requests", "reset_code"):
            cursor.execute("ALTER TABLE employee_password_reset_requests ADD COLUMN reset_code VARCHAR(6) NULL")
        if not column_exists(cursor, "employee_password_reset_requests", "reset_code_expires_at"):
            cursor.execute("ALTER TABLE employee_password_reset_requests ADD COLUMN reset_code_expires_at TIMESTAMP NULL")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_employee_reset_code ON employee_password_reset_requests (reset_code)")
        db.commit()
    finally:
        db.close()


def _ensure_employee_device_token_schema() -> None:
    db = get_db()
    try:
        cursor = db.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS employee_device_tokens (
                id SERIAL PRIMARY KEY,
                employee_id VARCHAR(50) NOT NULL,
                device_token TEXT NOT NULL,
                platform VARCHAR(30) NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT uq_employee_device_token UNIQUE (employee_id, device_token),
                CONSTRAINT fk_employee_device_token_employee
                    FOREIGN KEY (employee_id) REFERENCES employees(employee_id)
                    ON DELETE CASCADE
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_employee_device_tokens_employee_id ON employee_device_tokens (employee_id)")
        db.commit()
    finally:
        db.close()


def _ensure_attendance_reminder_schema() -> None:
    db = get_db()
    try:
        cursor = db.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS attendance_reminders (
                id SERIAL PRIMARY KEY,
                employee_id VARCHAR(50) NOT NULL,
                time_in_id INT NOT NULL,
                reminder_count INT NOT NULL DEFAULT 0,
                last_sent_at TIMESTAMP NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT uq_attendance_reminder_time_in UNIQUE (time_in_id),
                CONSTRAINT fk_attendance_reminder_employee
                    FOREIGN KEY (employee_id) REFERENCES employees(employee_id)
                    ON DELETE CASCADE,
                CONSTRAINT fk_attendance_reminder_time_in
                    FOREIGN KEY (time_in_id) REFERENCES attendance(id)
                    ON DELETE CASCADE
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_attendance_reminders_employee_id ON attendance_reminders (employee_id)")
        db.commit()
    finally:
        db.close()


def _ensure_performance_indexes() -> None:
    db = get_db()
    try:
        cursor = db.cursor()
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_employees_status_registered ON employees (status, registered_at DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_employees_employee_id ON employees (employee_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_attendance_employee_timestamp ON attendance (employee_id, timestamp DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_attendance_type_timestamp ON attendance (type, timestamp DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_target ON admin_audit_logs (target_type, target_id)")
        db.commit()
    finally:
        db.close()

try:
    _ensure_employee_auth_schema()
    _ensure_attendance_schema()
    _ensure_employee_reset_schema()
    _ensure_employee_device_token_schema()
    _ensure_attendance_reminder_schema()
    _ensure_rate_limit_schema()
    _ensure_performance_indexes()
except Exception as exc:
    logger.warning("Could not ensure employee/payroll auth schema: %s", exc)


SECRET_KEY = _get_env("SECRET_KEY", "change-me-in-production")
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer(auto_error=False)

# Minimum minutes between time_in and time_out
MIN_WORK_MINUTES = int(_get_env("MIN_WORK_MINUTES", "30"))
WORK_HOURS_PER_DAY = float(_get_env("WORK_HOURS_PER_DAY", "8"))
MAX_UPLOAD_MB = int(_get_env("MAX_UPLOAD_MB", "10"))
TOKEN_EXPIRE_HOURS = int(_get_env("TOKEN_EXPIRE_HOURS", "12"))
OFFLINE_BACKFILL_MAX_DAYS = int(_get_env("OFFLINE_BACKFILL_MAX_DAYS", "7"))
REGISTRATION_FACE_TOLERANCE = float(_get_env("REGISTRATION_FACE_TOLERANCE", "0.42"))
FACE_MATCH_MIN_MARGIN = float(_get_env("FACE_MATCH_MIN_MARGIN", "0.08"))
FACE_REVIEW_TOLERANCE = float(_get_env("FACE_REVIEW_TOLERANCE", "0.48"))
MANUAL_REVIEW_EMPLOYEE_COUNT = int(_get_env("MANUAL_REVIEW_EMPLOYEE_COUNT", "20"))

def create_token(subject: str, role: str, session_id: str | None = None):
    now = datetime.utcnow()
    payload = {
        "sub": subject,
        "role": role,
        "iat": now,
        "exp": now + timedelta(hours=TOKEN_EXPIRE_HOURS),
    }
    if session_id:
        payload["sid"] = session_id
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")

def _decode_token(credentials: HTTPAuthorizationCredentials = Depends(bearer)) -> dict:
    if not credentials:
        raise HTTPException(status_code=401, detail="Missing token")
    try:
        return jwt.decode(credentials.credentials, SECRET_KEY, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")


def verify_admin_token(payload: dict = Depends(_decode_token)):
    subject = str(payload.get("sub") or "").strip()
    role = str(payload.get("role") or "admin").strip().lower()
    if not subject or role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute("SELECT username FROM public.users WHERE username = %s AND role = 'admin' LIMIT 1", (subject,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=403, detail="Admin access required")
        return row["username"]
    finally:
        db.close()


def verify_employee_token(payload: dict = Depends(_decode_token)):
    subject = str(payload.get("sub") or "").strip()
    role = str(payload.get("role") or "employee").strip().lower()
    if not subject or role != "employee":
        raise HTTPException(status_code=403, detail="Employee access required")

    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute("""
            SELECT employee_id, session_key
            FROM employees
            WHERE employee_id = %s AND status = 'approved'
            LIMIT 1
        """, (subject,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=403, detail="Employee access required")
        # Single-active-session enforcement: the token's session id must match
        # the session key currently on file. A mismatch (or a token issued
        # before the latest login) means the employee signed in on another
        # device, which ends this session immediately.
        token_sid = str(payload.get("sid") or "").strip()
        current_key = str(row.get("session_key") or "").strip()
        if current_key and token_sid != current_key:
            raise HTTPException(
                status_code=403,
                detail="Your session was ended because you signed in on another device. Please sign in again.",
            )
        return row["employee_id"]
    finally:
        db.close()


def _cleanup_files(*paths: str | None) -> None:
    for path in paths:
        if path and os.path.exists(path):
            try:
                os.remove(path)
            except OSError as exc:
                logger.warning("Failed to remove file %s: %s", path, exc)


def _is_image_bytes(data: bytes) -> bool:
    if not data or len(data) < 12:
        return False
    if data.startswith(b"\xFF\xD8\xFF"):
        return True
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return True
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return True
    return False


async def _save_face_upload(upload_file: UploadFile):
    if not upload_file:
        return None, None
    ext = os.path.splitext(upload_file.filename)[1].lower() if upload_file.filename else ".jpg"
    if ext not in [".jpg", ".jpeg", ".png", ".webp"]:
        ext = ".jpg"
    fname = f"{uuid.uuid4()}{ext}"
    fpath = FACE_IMAGES_DIR / fname
    content = await upload_file.read()
    if len(content) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File too large. Max {MAX_UPLOAD_MB} MB allowed.")
    if not _is_image_bytes(content):
        raise HTTPException(status_code=400, detail="Uploaded file must be an image.")
    with open(fpath, "wb") as f:
        f.write(content)
    _ensure_face_thumbnail(fname)
    return fname, str(fpath)


def _safe_face_filename(filename: str) -> str:
    clean = Path(filename or "").name
    if not clean or clean.startswith("."):
        raise HTTPException(status_code=404, detail="Image not found")
    return clean


def _ensure_face_thumbnail(filename: str) -> Path | None:
    clean = _safe_face_filename(filename)
    source = FACE_IMAGES_DIR / clean
    if not source.exists() or not source.is_file():
        return None
    thumb_name = f"{Path(clean).stem}.jpg"
    thumb_path = FACE_THUMBNAILS_DIR / thumb_name
    if thumb_path.exists() and thumb_path.stat().st_mtime >= source.stat().st_mtime:
        return thumb_path
    image = cv2.imread(str(source))
    if image is None:
        return None
    height, width = image.shape[:2]
    max_side = 160
    scale = min(max_side / max(width, height), 1)
    if scale < 1:
        image = cv2.resize(image, (max(1, int(width * scale)), max(1, int(height * scale))), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(thumb_path), image, [int(cv2.IMWRITE_JPEG_QUALITY), 72])
    return thumb_path


@app.get("/face_thumbnails/{filename}", include_in_schema=False)
def get_face_thumbnail(filename: str):
    thumb_path = _ensure_face_thumbnail(filename)
    if not thumb_path:
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(
        thumb_path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=604800"},
    )


@app.get("/status")
async def get_status():
    """Endpoint for the Flutter app to check if the server is reachable."""
    return {
        "status": "online",
        "timestamp": datetime.utcnow().isoformat(),
        "service": "attendance_system",
    }


@app.get("/app-release")
def get_app_release():
    release = _load_app_release()
    latest_version = str(release.get("latest_version") or release.get("flutter_base_version") or "1.0.0")
    min_supported = str(release.get("min_supported_version") or latest_version)
    return {
        "latest_version": latest_version,
        "min_supported_version": min_supported,
        "force_update": bool(release.get("force_update")),
        "apk_url": str(release.get("apk_url") or ""),
        "release_notes": str(release.get("release_notes") or ""),
    }


@app.get("/admin/status")
def get_admin_status(admin: str = Depends(verify_admin_token)):
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute("SELECT COUNT(*) AS count FROM public.users WHERE role = 'admin'")
        admin_count = int(cursor.fetchone()["count"])
        cursor.execute("SELECT COUNT(*) AS count FROM employees")
        employee_count = int(cursor.fetchone()["count"])
        cursor.execute("SELECT status, COUNT(*) AS count FROM employees GROUP BY status")
        employee_status = {
            str(row["status"] or "unknown"): int(row["count"])
            for row in cursor.fetchall()
        }
        cursor.execute("SELECT COUNT(*) AS count FROM attendance")
        attendance_count = int(cursor.fetchone()["count"])
        cursor.execute("""
            SELECT COUNT(*) AS count
            FROM public.users
            WHERE username = 'admin' AND role = 'admin'
        """)
        default_admin_count = int(cursor.fetchone()["count"])
        return {
            "status": "online",
            "database": "connected",
            "timestamp": datetime.utcnow().isoformat(),
            "schema": "ready",
            "counts": {
                "admins": admin_count,
                "employees": employee_count,
                "attendance": attendance_count,
            },
            "employee_status": employee_status,
            "storage": {
                "face_images_dir": str(FACE_IMAGES_DIR),
                "persistent": _get_env("FACE_IMAGES_PERSISTENT", "false").lower() in {"1", "true", "yes", "on"},
            },
            "warnings": {
                "default_admin_present": default_admin_count > 0,
                "secret_key_default": SECRET_KEY == "change-me-in-production",
            },
        }
    finally:
        db.close()


@app.get("/admin/dashboard-summary")
def get_admin_dashboard_summary(admin: str = Depends(verify_admin_token)):
    today = _local_now().date()
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute("SELECT status, COUNT(*) AS count FROM employees GROUP BY status")
        employee_status = {
            str(row["status"] or "unknown"): int(row["count"])
            for row in cursor.fetchall()
        }
        cursor.execute("SELECT COUNT(*) AS count FROM employees")
        employee_count = int(cursor.fetchone()["count"])
        cursor.execute("SELECT COUNT(*) AS count FROM attendance")
        attendance_count = int(cursor.fetchone()["count"])
        cursor.execute(
            """
            SELECT type, COUNT(*) AS count
            FROM attendance
            WHERE DATE(timestamp) = %s
            GROUP BY type
            """,
            (today,),
        )
        today_types = {
            str(row["type"] or ""): int(row["count"])
            for row in cursor.fetchall()
        }
        time_ins = today_types.get("time_in", 0)
        time_outs = today_types.get("time_out", 0)
        return {
            "status": "online",
            "database": "connected",
            "timestamp": datetime.utcnow().isoformat(),
            "counts": {
                "employees": employee_count,
                "attendance": attendance_count,
                "pending": int(employee_status.get("pending", 0)) + int(employee_status.get("review", 0)),
                "approved": int(employee_status.get("approved", 0)),
                "archived": int(employee_status.get("archived", 0)),
                "rejected": int(employee_status.get("rejected", 0)),
            },
            "employee_status": employee_status,
            "today": {
                "date": today.isoformat(),
                "time_ins": time_ins,
                "time_outs": time_outs,
                "complete": min(time_ins, time_outs),
                "incomplete": max(time_ins - time_outs, 0),
            },
        }
    finally:
        db.close()


@app.get("/admin/email-status")
def get_admin_email_status(admin: str = Depends(verify_admin_token)):
    provider = "resend" if RESEND_API_KEY else "smtp" if SMTP_USER and SMTP_PASSWORD else "none"
    sender = RESEND_FROM if provider == "resend" else SMTP_SENDER_EMAIL
    return {
        "provider": provider,
        "sender": sender,
        "resend_configured": bool(RESEND_API_KEY),
        "smtp_configured": bool(SMTP_USER and SMTP_PASSWORD),
    }

# â”€â”€â”€ AUTO GENERATE EMPLOYEE ID â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@app.get("/admin/data-health")
def get_admin_data_health(admin: str = Depends(verify_admin_token)):
    today = _local_now().date()
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute("""
            SELECT id, employee_id, name, status, face_image
            FROM employees
            WHERE status IN ('approved', 'pending', 'review')
              AND (face_image IS NULL OR face_image = '')
            ORDER BY status ASC, registered_at DESC, id DESC
            LIMIT 25
        """)
        missing_photos = cursor.fetchall()

        cursor.execute("""
            SELECT id, employee_id, name, status, daily_rate
            FROM employees
            WHERE status = 'approved'
              AND COALESCE(daily_rate, 0) <= 0
            ORDER BY approved_at DESC NULLS LAST, registered_at DESC, id DESC
            LIMIT 25
        """)
        missing_salary = cursor.fetchall()

        cursor.execute("""
            SELECT e.id, e.employee_id, e.name, e.status, COUNT(t.id) AS token_count
            FROM employees e
            LEFT JOIN employee_device_tokens t ON t.employee_id = e.employee_id
            WHERE e.status = 'approved'
            GROUP BY e.id, e.employee_id, e.name, e.status
            HAVING COUNT(t.id) = 0
            ORDER BY e.approved_at DESC NULLS LAST, e.registered_at DESC, e.id DESC
            LIMIT 25
        """)
        missing_tokens = cursor.fetchall()

        cursor.execute("""
            SELECT ti.id, ti.employee_id, e.id AS employee_row_id, e.name, ti.timestamp AS time_in
            FROM attendance ti
            JOIN employees e ON e.employee_id = ti.employee_id
            WHERE ti.type = 'time_in'
              AND DATE(ti.timestamp) = %s
              AND NOT EXISTS (
                SELECT 1
                FROM attendance tout
                WHERE tout.employee_id = ti.employee_id
                  AND tout.type = 'time_out'
                  AND tout.timestamp > ti.timestamp
                  AND DATE(tout.timestamp) = DATE(ti.timestamp)
              )
            ORDER BY ti.timestamp DESC
            LIMIT 25
        """, (today,))
        incomplete_timeouts = cursor.fetchall()

        cursor.execute("""
            SELECT e.id, e.employee_id, e.name, e.status, e.face_image, e.daily_rate
            FROM employees e
            WHERE e.status IN ('approved', 'pending', 'review')
            ORDER BY e.registered_at DESC, e.id DESC
            LIMIT 1
        """)
        latest_employee = cursor.fetchone()

        cursor.execute("""
            SELECT employee_id, COUNT(*) AS duplicate_count
            FROM employees
            WHERE employee_id IS NOT NULL AND employee_id != ''
            GROUP BY employee_id
            HAVING COUNT(*) > 1
            ORDER BY COUNT(*) DESC, employee_id ASC
            LIMIT 25
        """)
        duplicate_employee_ids = cursor.fetchall()

        cursor.execute("""
            SELECT a.employee_id, COUNT(*) AS log_count
            FROM attendance a
            LEFT JOIN employees e ON e.employee_id = a.employee_id
            WHERE e.employee_id IS NULL
            GROUP BY a.employee_id
            ORDER BY COUNT(*) DESC, a.employee_id ASC
            LIMIT 25
        """)
        orphan_attendance = cursor.fetchall()

        cursor.execute("""
            SELECT id, employee_id, name, status
            FROM employees
            WHERE status = 'approved'
              AND (face_encoding IS NULL OR face_encoding = '')
            ORDER BY approved_at DESC NULLS LAST, registered_at DESC, id DESC
            LIMIT 25
        """)
        missing_face_encoding = cursor.fetchall()

        sections = {
            "missing_photos": {
                "label": "Missing Photos",
                "count": len(missing_photos),
                "severity": "warn",
                "rows": missing_photos,
            },
            "missing_salary": {
                "label": "Missing Salary",
                "count": len(missing_salary),
                "severity": "danger",
                "rows": missing_salary,
            },
            "incomplete_timeouts": {
                "label": "Needs Time-out",
                "count": len(incomplete_timeouts),
                "severity": "danger",
                "rows": [{
                    **row,
                    "time_in": str(row["time_in"]) if row.get("time_in") else None,
                } for row in incomplete_timeouts],
            },
            "missing_tokens": {
                "label": "No Device Token",
                "count": len(missing_tokens),
                "severity": "info",
                "rows": missing_tokens,
            },
            "duplicate_employee_ids": {
                "label": "Duplicate IDs",
                "count": len(duplicate_employee_ids),
                "severity": "danger",
                "rows": duplicate_employee_ids,
            },
            "orphan_attendance": {
                "label": "Orphan Attendance",
                "count": len(orphan_attendance),
                "severity": "danger",
                "rows": orphan_attendance,
            },
            "missing_face_encoding": {
                "label": "Missing Face Encoding",
                "count": len(missing_face_encoding),
                "severity": "warn",
                "rows": missing_face_encoding,
            },
        }
        issue_count = sum(section["count"] for section in sections.values())
        return {
            "date": today.isoformat(),
            "issue_count": issue_count,
            "status": "clear" if issue_count == 0 else "needs_review",
            "sections": sections,
            "latest_employee": latest_employee,
        }
    finally:
        db.close()


def generate_employee_id(cursor):
    year = datetime.now().year
    cursor.execute("""
        SELECT employee_id FROM employees 
        WHERE employee_id LIKE %s 
        ORDER BY employee_id DESC LIMIT 1
    """, (f"EMP-{year}-%",))
    last = cursor.fetchone()
    if last and last["employee_id"]:
        try:
            last_num = int(last["employee_id"].split("-")[-1])
            new_num = last_num + 1
        except:
            new_num = 1
    else:
        new_num = 1
    return f"EMP-{year}-{str(new_num).zfill(4)}"

# â”€â”€â”€ ADMIN LOGIN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@app.post("/admin/login")
def admin_login(username: str = Form(...), password: str = Form(...)):
    clean_username = username.strip()
    limiter_key = _rate_limit_storage_key("admin_login", clean_username or username or "unknown")
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        _enforce_rate_limit(cursor, limiter_key, "admin_login")
        cursor.execute("SELECT username, password_hash FROM public.users WHERE username = %s AND role = 'admin' LIMIT 1", (clean_username,))
        admin = cursor.fetchone()
        if not admin or not pwd_context.verify(password, admin["password_hash"]):
            wait_seconds = _register_rate_limit_failure(cursor, limiter_key, "admin_login")
            db.commit()
            if wait_seconds:
                raise HTTPException(
                    status_code=429,
                    detail=_rate_limit_block_message(wait_seconds),
                    headers={"Retry-After": str(wait_seconds)},
                )
            raise HTTPException(status_code=401, detail="Invalid credentials")
        _clear_rate_limit(cursor, limiter_key, "admin_login")
        db.commit()
        return {"token": create_token(clean_username, "admin"), "message": "Login successful"}
    finally:
        db.close()


@app.post("/admin/change-password")
def change_admin_password(
    current_password: str = Form(...),
    new_password: str = Form(...),
    admin: str = Depends(verify_admin_token),
):
    if len(new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters.")
    if current_password == new_password:
        raise HTTPException(status_code=400, detail="New password must be different from the current password.")

    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute("SELECT id, username, password_hash FROM public.users WHERE username = %s AND role = 'admin' LIMIT 1", (admin,))
        row = cursor.fetchone()
        if not row or not pwd_context.verify(current_password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="Current password is incorrect.")

        hashed = pwd_context.hash(new_password)
        cursor.execute("UPDATE public.users SET password_hash = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s", (hashed, row["id"]))
        _audit(cursor, admin, "admin_password_changed", "admin", str(row["id"]), {"username": row["username"]})
        db.commit()
        return {"message": "Password changed successfully"}
    finally:
        db.close()


# â”€â”€â”€ REGISTER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
REGISTER_GOV_ID_VALIDATORS = {
    "sss_number": (r"^\d{2}-\d{7}-\d$", "SSS Number", "12-3456789-0 (10 digits)"),
    "philhealth_number": (r"^\d{2}-\d{9}-\d$", "PhilHealth Number", "12-345678901-2 (12 digits)"),
    "pagibig_number": (r"^\d{4}-\d{4}-\d{4}$", "Pag-IBIG Number", "1234-5678-9012 (12 digits)"),
    "tin_number": (r"^\d{3}-\d{3}-\d{3}-\d{3}$", "TIN Number", "123-456-789-012 (12 digits)"),
}


@app.post("/register")
async def register(
    background_tasks: BackgroundTasks,
    name: str = Form(""),
    email: str = Form(""),
    phone: str = Form(""),
    password: str = Form(...),
    government_id: str = Form(""),
    first_name: str = Form(""),
    last_name: str = Form(""),
    sss_number: str = Form(""),
    philhealth_number: str = Form(""),
    pagibig_number: str = Form(""),
    tin_number: str = Form(""),
    device_id: str = Form(""),
    photo: UploadFile = File(None),
):
    db = get_db()
    
    try:
        if not email.strip():
            raise HTTPException(status_code=400, detail="Email is required.")
        if not phone.strip():
            raise HTTPException(status_code=400, detail="Phone number is required.")
        if len(password.strip()) < 8:
            raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
        if not photo or not (photo.filename or "").strip():
            raise HTTPException(status_code=400, detail="A face photo is required for registration.")

        first_name_clean = first_name.strip()
        last_name_clean = last_name.strip()
        if first_name_clean or last_name_clean:
            if not first_name_clean:
                raise HTTPException(status_code=400, detail="First name is required.")
            if not last_name_clean:
                raise HTTPException(status_code=400, detail="Last name is required.")
            full_name = f"{first_name_clean} {last_name_clean}"
        else:
            if not name.strip():
                raise HTTPException(status_code=400, detail="First and last name are required.")
            full_name = name.strip()

        gov_inputs = {
            "sss_number": sss_number.strip(),
            "philhealth_number": philhealth_number.strip(),
            "pagibig_number": pagibig_number.strip(),
            "tin_number": tin_number.strip(),
        }
        legacy_gov_id = government_id.strip()
        if all(not value for value in gov_inputs.values()) and legacy_gov_id:
            gov_ids = {"government_id": legacy_gov_id}
        else:
            gov_ids = {}
            for field, (pattern, label, hint) in REGISTER_GOV_ID_VALIDATORS.items():
                value = gov_inputs[field]
                if not value:
                    raise HTTPException(status_code=400, detail=f"{label} is required.")
                if not re.fullmatch(pattern, value):
                    raise HTTPException(status_code=400, detail=f"{label} format is invalid. Format: {hint}.")
                gov_ids[field] = value

        email_check = _normalize_email(email)
        phone_check = _phone_candidates(phone)
        cursor = db.cursor(dictionary=True)
        cursor.execute("SELECT email, phone FROM employees WHERE email IS NOT NULL OR phone IS NOT NULL")
        existing_contacts = cursor.fetchall()

        email_taken = False
        phone_taken = False
        for row in existing_contacts:
            existing_email = _normalize_email(row.get("email") or "")
            existing_phone = _phone_candidates(row.get("phone") or "")
            if existing_email and existing_email == email_check:
                logger.warning(f"Registration conflict: Email {email_check} already exists.")
                email_taken = True
            if existing_phone and phone_check.intersection(existing_phone):
                logger.warning(f"Registration conflict: Phone match found for {phone_check}.")
                phone_taken = True
            if email_taken or phone_taken:
                break

        if email_taken or phone_taken:
            details = []
            if email_taken:
                details.append("Email already registered.")
            if phone_taken:
                details.append("Phone number already registered.")
            raise HTTPException(status_code=409, detail=" ".join(details))

        for field, value in gov_ids.items():
            if field == "government_id":
                continue
            cursor = db.cursor(dictionary=True)
            cursor.execute(
                f"SELECT id FROM employees WHERE {field} = %s AND {field} != ''",
                (value,),
            )
            if cursor.fetchone():
                label = REGISTER_GOV_ID_VALIDATORS[field][1]
                raise HTTPException(status_code=409, detail=f"{label} is already in use.")

        payroll_employee_id = None
        if "sss_number" in gov_ids:
            cursor = db.cursor(dictionary=True)
            cursor.execute(
                """
                SELECT id FROM public.employees
                WHERE sss_number = %s
                  AND philhealth_number = %s
                  AND pagibig_number = %s
                  AND tin_number = %s
                """,
                (gov_ids["sss_number"], gov_ids["philhealth_number"], gov_ids["pagibig_number"], gov_ids["tin_number"]),
            )
            matches = cursor.fetchall()
            if len(matches) == 1:
                payroll_employee_id = matches[0]["id"]

        face_image = ""
        if photo and (photo.filename or "").strip():
            face_image, _ = await _save_face_upload(photo)
            if not face_image:
                raise HTTPException(status_code=400, detail="Photo upload failed. Please try again.")

        cursor = db.cursor(dictionary=True)
        cursor.execute("""
            INSERT INTO employees (
                name, first_name, last_name, email, phone, password_hash,
                sss_number, philhealth_number, pagibig_number, tin_number,
                government_id, face_image, status, payroll_employee_id,
                device_id
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending', %s, %s)
        """, (
            full_name,
            first_name_clean,
            last_name_clean,
            email.strip(),
            phone.strip(),
            pwd_context.hash(password.strip()),
            gov_ids.get("sss_number", ""),
            gov_ids.get("philhealth_number", ""),
            gov_ids.get("pagibig_number", ""),
            gov_ids.get("tin_number", ""),
            gov_ids.get("government_id", ""),
            face_image,
            payroll_employee_id,
            device_id.strip(),
        ))
        db.commit()
        background_tasks.add_task(_notify_admin_registration, full_name, email.strip(), phone.strip())
        background_tasks.add_task(_notify_payroll_panel, "registration_pending", {
            "name": full_name,
            "email": email.strip(),
            "phone": phone.strip(),
        })

        return {
            "message": "Registration submitted. Waiting for admin approval.",
            "status": "pending",
        }

    finally:
        db.close()


@app.post("/register/check-availability")
def register_check_availability(
    email: str = Form(""),
    phone: str = Form(""),
    sss_number: str = Form(""),
    philhealth_number: str = Form(""),
    pagibig_number: str = Form(""),
    tin_number: str = Form(""),
):
    if not email.strip():
        raise HTTPException(status_code=400, detail="Email is required.")
    if not phone.strip():
        raise HTTPException(status_code=400, detail="Phone number is required.")

    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute("SELECT email, phone FROM employees WHERE email IS NOT NULL OR phone IS NOT NULL")
        existing_contacts = cursor.fetchall()

        email_check = _normalize_email(email)
        phone_check = _phone_candidates(phone)
        email_taken = False
        phone_taken = False
        for row in existing_contacts:
            existing_email = _normalize_email(row.get("email") or "")
            existing_phone = _phone_candidates(row.get("phone") or "")
            if existing_email and existing_email == email_check:
                email_taken = True
            if existing_phone and phone_check.intersection(existing_phone):
                phone_taken = True
            if email_taken or phone_taken:
                break

        gov_id_taken = None
        for field, value in {
            "sss_number": sss_number.strip(),
            "philhealth_number": philhealth_number.strip(),
            "pagibig_number": pagibig_number.strip(),
            "tin_number": tin_number.strip(),
        }.items():
            if not value:
                continue
            cursor = db.cursor(dictionary=True)
            cursor.execute(
                f"SELECT id FROM employees WHERE {field} = %s AND {field} != ''",
                (value,),
            )
            if cursor.fetchone():
                gov_id_taken = f"{REGISTER_GOV_ID_VALIDATORS[field][1]} already in use."
                break

        return {
            "available": not (email_taken or phone_taken) and gov_id_taken is None,
            "email_taken": email_taken,
            "phone_taken": phone_taken,
            "gov_id_taken": gov_id_taken,
        }
    finally:
        db.close()


@app.get("/register/status")
def register_status(email: str = "", phone: str = ""):
    if not email.strip():
        raise HTTPException(status_code=400, detail="Email is required.")
    if not phone.strip():
        raise HTTPException(status_code=400, detail="Phone number is required.")

    email_check = _normalize_email(email)
    phone_check = _phone_candidates(phone)
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT employee_id, name, email, phone, status, admin_notes, registered_at, approved_at
            FROM employees
            WHERE LOWER(email) = %s
            ORDER BY registered_at DESC
            LIMIT 10
            """,
            (email_check,),
        )
        rows = cursor.fetchall()
        matched = None
        for row in rows:
            if phone_check.intersection(_phone_candidates(row.get("phone") or "")):
                matched = row
                break

        if not matched:
            raise HTTPException(status_code=404, detail="No registration found for that email and phone.")

        status = str(matched.get("status") or "pending").lower()
        response = {
            "name": matched.get("name"),
            "email": matched.get("email"),
            "status": status,
            "registered_at": str(matched.get("registered_at")) if matched.get("registered_at") else None,
            "approved_at": str(matched.get("approved_at")) if matched.get("approved_at") else None,
            "employee_id": matched.get("employee_id") if status == "approved" else None,
        }
        if status == "rejected" and matched.get("admin_notes"):
            response["admin_notes"] = matched.get("admin_notes")
        return response
    finally:
        db.close()


def _parse_offline_timestamp(payload: dict | None) -> datetime | None:
    """Parses an optional client-supplied timestamp for offline queue backfill.
    Returns None when the payload has no timestamp (server time is used)."""
    if not payload or not isinstance(payload, dict):
        return None
    raw = str(payload.get("timestamp") or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", ""))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid timestamp format.")
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(APP_TIMEZONE).replace(tzinfo=None)
    now = _local_now()
    if parsed > now + timedelta(minutes=5):
        raise HTTPException(status_code=400, detail="Timestamp cannot be in the future.")
    if (now - parsed).days > OFFLINE_BACKFILL_MAX_DAYS:
        raise HTTPException(status_code=400, detail="Timestamp is too old to record offline attendance.")
    return parsed


def _validate_timeout_window(recorded: datetime, time_in_at: datetime, min_minutes: int) -> str | None:
    """Returns an error message when the time-out is earlier than the time-in or
    happens before the minimum work window, otherwise returns None."""
    if recorded < time_in_at:
        return "Time out cannot be earlier than your time in."
    elapsed_minutes = (recorded - time_in_at).total_seconds() / 60
    if elapsed_minutes < min_minutes:
        return f"You need to work at least {min_minutes} minutes before timing out."
    return None


@app.post("/present")
async def present(
    payload: dict | None = Body(default=None),
    employee: str = Depends(verify_employee_token),
):
    """Single 'present' attendance marker that writes directly into the shared
    payroll database (public.attendance_logs) plus the attendance-schema log.
    Identity comes from the signed-in employee token; the on-device fingerprint
    (biometrics) is the confirmation step.

    An optional JSON body {"timestamp": "..."} is accepted so the Flutter app can
    backfill an attendance that was queued while the device was offline."""
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)

        cursor.execute("""
            SELECT employee_id, name, email, daily_rate, payroll_employee_id
            FROM employees
            WHERE employee_id = %s AND status = 'approved'
            LIMIT 1
        """, (employee,))
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=403, detail="Employee access required")

        payroll_employee_id = emp.get("payroll_employee_id")
        if not payroll_employee_id:
            raise HTTPException(
                status_code=409,
                detail="Your account is not linked to payroll yet. Please ask the administrator to approve you.",
            )

        requested = _parse_offline_timestamp(payload)
        now = _local_now()
        recorded = requested if requested is not None else now
        today = recorded.date()

        cursor.execute("""
            SELECT rate FROM public.employees WHERE id = %s AND active = true
        """, (payroll_employee_id,))
        payroll_emp = cursor.fetchone()
        if not payroll_emp:
            raise HTTPException(
                status_code=409,
                detail="Your payroll account is inactive or missing. Please contact the administrator.",
            )
        rate = payroll_emp["rate"]

        if requested is not None:
            cursor.execute(
                "SELECT id FROM public.deleted_attendance_marks WHERE employee_id = %s AND work_date = %s",
                (payroll_employee_id, today),
            )
            if cursor.fetchone():
                raise HTTPException(
                    status_code=409,
                    detail="This attendance was removed by the administrator and will not be re-uploaded.",
                )

        cursor.execute("""
            INSERT INTO public.attendance_logs
                (employee_id, work_date, time_in, time_out, rate_snapshot, notes, created_by)
            VALUES (%s, %s, %s, NULL, %s, 'Marked present via biometrics', NULL)
            ON CONFLICT (employee_id, work_date) DO NOTHING
        """, (payroll_employee_id, today, recorded.time(), rate))
        if cursor.rowcount == 0:
            raise HTTPException(
                status_code=400,
                detail="You have already marked your attendance for today.",
            )

        cursor.execute("""
            INSERT INTO attendance (employee_id, type, rate_snapshot, timestamp)
            VALUES (%s, 'present', %s, %s)
        """, (emp["employee_id"], rate, recorded))
        db.commit()

        try:
            _send_fcm_to_employee(
                cursor,
                emp["employee_id"],
                "Attendance marked",
                f"You are marked present for {today.strftime('%B %d, %Y')}.",
                {
                    "type": "present",
                    "timestamp": recorded.isoformat(),
                    "employee_id": emp["employee_id"],
                },
            )
        except Exception:
            logger.exception("FCM notification failed after attendance was saved")
        _notify_payroll_panel("attendance_present", {"employee_id": emp["employee_id"], "name": emp["name"]})
        return {
            "matched": True,
            "employee_id": emp["employee_id"],
            "name": emp["name"],
            "type": "present",
            "timestamp": recorded.isoformat(),
            "payroll_employee_id": payroll_employee_id,
        }

    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@app.post("/timeout")
async def timeout(
    payload: dict | None = Body(default=None),
    employee: str = Depends(verify_employee_token),
):
    """Employee self-service time-out. Writes into the shared payroll database
    (public.attendance_logs.time_out) plus an attendance-schema 'time_out' log
    so the pairing logic can compute the session duration.

    An optional JSON body {"timestamp": "..."} is accepted for offline backfill."""
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)

        cursor.execute("""
            SELECT employee_id, name, email, daily_rate, payroll_employee_id
            FROM employees
            WHERE employee_id = %s AND status = 'approved'
            LIMIT 1
        """, (employee,))
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=403, detail="Employee access required")

        payroll_employee_id = emp.get("payroll_employee_id")
        if not payroll_employee_id:
            raise HTTPException(
                status_code=409,
                detail="Your account is not linked to payroll yet. Please ask the administrator to approve you.",
            )

        requested = _parse_offline_timestamp(payload)
        now = _local_now()
        recorded = requested if requested is not None else now
        work_date = recorded.date()

        _raise_if_payroll_locked(cursor, emp["employee_id"], work_date)

        cursor.execute(
            """
            SELECT id, timestamp
            FROM attendance
            WHERE employee_id = %s
              AND type IN ('present', 'time_in')
              AND DATE(timestamp) = %s
            ORDER BY timestamp ASC
            LIMIT 1
            """,
            (emp["employee_id"], work_date),
        )
        time_in_record = cursor.fetchone()
        if not time_in_record:
            raise HTTPException(
                status_code=400,
                detail="You need to mark your attendance before you can time out.",
            )

        cursor.execute(
            """
            SELECT id
            FROM attendance
            WHERE employee_id = %s
              AND type = 'time_out'
              AND DATE(timestamp) = %s
            ORDER BY timestamp DESC
            LIMIT 1
            """,
            (emp["employee_id"], work_date),
        )
        existing_time_out = cursor.fetchone()
        if existing_time_out:
            raise HTTPException(
                status_code=400,
                detail="You have already timed out for this day.",
            )

        # Anti-cheat rule: a time-out must be at least MIN_WORK_MINUTES after
        # the time-in. Prevents employees from timing out immediately after
        # marking present. Also rejects a time-out that precedes the time-in.
        # Rejected attempts are written to the admin panel's audit trail.
        time_in_at = time_in_record.get("timestamp")
        if time_in_at is not None:
            window_error = _validate_timeout_window(recorded, time_in_at, MIN_WORK_MINUTES)
            if window_error:
                _log_payroll_audit(
                    cursor,
                    "reject",
                    "attendance",
                    time_in_record.get("id"),
                    {
                        "employee_id": emp["employee_id"],
                        "name": emp["name"],
                        "work_date": str(work_date),
                        "time_in": str(time_in_at.time()) if hasattr(time_in_at, "time") else str(time_in_at),
                        "attempted_time_out": str(recorded.time()) if hasattr(recorded, "time") else str(recorded),
                        "reason": window_error,
                    },
                )
                db.commit()  # persist the audit entry before the 400 is raised
                raise HTTPException(status_code=400, detail=window_error)

        cursor.execute("SELECT rate FROM public.employees WHERE id = %s AND active = true", (payroll_employee_id,))
        payroll_emp = cursor.fetchone()
        if not payroll_emp:
            raise HTTPException(
                status_code=409,
                detail="Your payroll account is inactive or missing. Please contact the administrator.",
            )
        rate = payroll_emp["rate"]

        cursor.execute(
            """
            UPDATE public.attendance_logs
            SET time_out = %s
            WHERE employee_id = %s AND work_date = %s
            """,
            (recorded.time(), payroll_employee_id, work_date),
        )

        cursor.execute(
            """
            INSERT INTO attendance (employee_id, type, rate_snapshot, timestamp)
            VALUES (%s, 'time_out', %s, %s)
            """,
            (emp["employee_id"], rate, recorded),
        )
        db.commit()

        try:
            _send_fcm_to_employee(
                cursor,
                emp["employee_id"],
                "Attendance updated",
                f"You timed out for {work_date.strftime('%B %d, %Y')}.",
                {
                    "type": "time_out",
                    "timestamp": recorded.isoformat(),
                    "employee_id": emp["employee_id"],
                },
            )
        except Exception:
            logger.exception("FCM notification failed after time-out was saved")
        _notify_payroll_panel("attendance_timeout", {"employee_id": emp["employee_id"], "name": emp["name"]})
        return {
            "matched": True,
            "employee_id": emp["employee_id"],
            "name": emp["name"],
            "type": "time_out",
            "timestamp": recorded.isoformat(),
            "payroll_employee_id": payroll_employee_id,
        }

    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@app.post("/employee/photo")
async def upload_employee_photo(
    photo: UploadFile = File(...),
    employee: str = Depends(verify_employee_token),
):
    """Employee uploads their own profile photo. Saved into the shared
    face-images directory so the payroll app can serve it at /attendance-faces,
    and written to both the attendance account and the linked payroll record."""
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute("""
            SELECT employee_id, name, payroll_employee_id
            FROM employees
            WHERE employee_id = %s AND status = 'approved'
            LIMIT 1
        """, (employee,))
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=403, detail="Employee access required")

        filename, _filepath = await _save_face_upload(photo)
        if not filename:
            raise HTTPException(status_code=400, detail="Photo upload failed. Please try again.")

        payroll_employee_id = emp.get("payroll_employee_id")
        if payroll_employee_id:
            cursor.execute(
                "UPDATE public.employees SET photo_url = %s WHERE id = %s",
                (f"/attendance-faces/{filename}", payroll_employee_id),
            )

        cursor.execute(
            "UPDATE employees SET face_image = %s WHERE employee_id = %s",
            (filename, emp["employee_id"]),
        )
        db.commit()
        return {"message": "Photo uploaded successfully.", "photo_url": f"/attendance-faces/{filename}"}
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@app.put("/employee/profile")
def update_employee_profile(
    phone: str = Form(""),
    sss_number: str = Form(""),
    philhealth_number: str = Form(""),
    pagibig_number: str = Form(""),
    tin_number: str = Form(""),
    employee: str = Depends(verify_employee_token),
):
    """Employee self-service profile update: phone + government numbers.
    Values are mirrored to the linked payroll record (public.employees) so the
    payroll admin keeps the same contact and government-id details."""
    clean_phone = phone.strip()
    if not clean_phone:
        raise HTTPException(status_code=400, detail="Phone number is required.")
    if len(_normalize_phone_digits(clean_phone)) < 10:
        raise HTTPException(status_code=400, detail="Enter a valid phone number.")

    gov_fields = {
        "sss_number": sss_number.strip(),
        "philhealth_number": philhealth_number.strip(),
        "pagibig_number": pagibig_number.strip(),
        "tin_number": tin_number.strip(),
    }
    for field, value in gov_fields.items():
        if not value:
            continue
        pattern, label, example = REGISTER_GOV_ID_VALIDATORS[field]
        if not re.match(pattern, value):
            raise HTTPException(status_code=400, detail=f"Invalid {label}. Expected format: {example}")

    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute("""
            SELECT employee_id, name, payroll_employee_id
            FROM employees
            WHERE employee_id = %s AND status = 'approved'
            LIMIT 1
        """, (employee,))
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=403, detail="Employee access required")

        phone_check = _phone_candidates(clean_phone)
        cursor.execute(
            "SELECT employee_id, phone FROM employees WHERE employee_id <> %s AND phone IS NOT NULL",
            (employee,),
        )
        for row in cursor.fetchall():
            existing = _phone_candidates(row.get("phone") or "")
            if existing and phone_check.intersection(existing):
                raise HTTPException(status_code=409, detail="Phone number is already in use.")

        payroll_employee_id = emp.get("payroll_employee_id")
        if payroll_employee_id:
            cursor.execute(
                "SELECT id FROM public.employees WHERE id <> %s AND phone = %s",
                (payroll_employee_id, clean_phone),
            )
            if cursor.fetchone():
                raise HTTPException(status_code=409, detail="Phone number is already in use.")

        cursor.execute("""
            UPDATE employees SET
                phone = %s,
                sss_number = %s,
                philhealth_number = %s,
                pagibig_number = %s,
                tin_number = %s
            WHERE employee_id = %s
        """, (clean_phone, gov_fields["sss_number"], gov_fields["philhealth_number"],
              gov_fields["pagibig_number"], gov_fields["tin_number"], employee))

        if payroll_employee_id:
            cursor.execute("""
                UPDATE public.employees SET
                    phone = %s,
                    sss_number = %s,
                    philhealth_number = %s,
                    pagibig_number = %s,
                    tin_number = %s
                WHERE id = %s
            """, (clean_phone, gov_fields["sss_number"], gov_fields["philhealth_number"],
                  gov_fields["pagibig_number"], gov_fields["tin_number"], payroll_employee_id))
        db.commit()
        return {
            "message": "Profile updated successfully.",
            "phone": clean_phone,
            "sss_number": gov_fields["sss_number"],
            "philhealth_number": gov_fields["philhealth_number"],
            "pagibig_number": gov_fields["pagibig_number"],
            "tin_number": gov_fields["tin_number"],
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@app.post("/employee/login")
def employee_login(
    email: str = Form(...),
    password: str = Form(...),
    device_id: str = Form(""),
):
    # 'email' accepts either a registered email or a phone number in any
    # common Philippine format (09171234567, +639171234567, 639171234567).
    clean_email = email.strip()
    limiter_key = _rate_limit_storage_key("employee_login", clean_email or email or "unknown")
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        _enforce_rate_limit(cursor, limiter_key, "employee_login")
        phone_candidates = sorted(_phone_candidates(clean_email))
        cursor.execute("""
            SELECT employee_id, name, email, phone, government_id, password_hash, status, face_image,
                   sss_number, philhealth_number, pagibig_number, tin_number, device_id
            FROM employees
            WHERE LOWER(email) = LOWER(%s)
               OR phone = ANY(%s)
               OR REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = ANY(%s)
               OR REGEXP_REPLACE(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), '^63', '') = ANY(%s)
               OR REGEXP_REPLACE(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), '^0', '') = ANY(%s)
            ORDER BY registered_at DESC
            LIMIT 1
        """, (clean_email, phone_candidates, phone_candidates, phone_candidates, phone_candidates))
        emp = cursor.fetchone()
        if not emp:
            wait_seconds = _register_rate_limit_failure(cursor, limiter_key, "employee_login")
            db.commit()
            if wait_seconds:
                raise HTTPException(
                    status_code=429,
                    detail=_rate_limit_block_message(wait_seconds),
                    headers={"Retry-After": str(wait_seconds)},
                )
            raise HTTPException(status_code=401, detail="Invalid email or password")

        # Check status specifically to give better feedback to the user
        if emp["status"] == "pending":
            raise HTTPException(status_code=403, detail="Your account is still pending approval. Please wait for an admin.")
        elif emp["status"] == "rejected":
            raise HTTPException(status_code=403, detail="Your account has been rejected. Please contact the administrator.")
        elif emp["status"] == "archived":
            raise HTTPException(status_code=403, detail="Your account has been archived. Please contact the administrator.")

        # Only check password if the account is approved
        if not emp.get("password_hash") or not pwd_context.verify(password, emp["password_hash"]):
            wait_seconds = _register_rate_limit_failure(cursor, limiter_key, "employee_login")
            db.commit()
            if wait_seconds:
                raise HTTPException(
                    status_code=429,
                    detail=_rate_limit_block_message(wait_seconds),
                    headers={"Retry-After": str(wait_seconds)},
                )
            raise HTTPException(status_code=401, detail="Invalid email or password")
        _clear_rate_limit(cursor, limiter_key, "employee_login")
        # Device binding (GCash-style): the account is tied to the first device
        # that registers or logs in. Signing in from a different phone is
        # blocked until the administrator resets the device binding.
        clean_device_id = device_id.strip()
        if clean_device_id:
            bound_device = (emp.get("device_id") or "").strip()
            if bound_device and bound_device != clean_device_id:
                raise HTTPException(
                    status_code=403,
                    detail=(
                        "This account is bound to another device. "
                        "Ask the administrator to approve your new device."
                    ),
                )
            if not bound_device:
                cursor.execute(
                    "UPDATE employees SET device_id = %s WHERE employee_id = %s",
                    (clean_device_id, emp["employee_id"]),
                )
        # Single active session: every successful login rotates the session key.
        # Any previously issued token (e.g. the same account signed in on
        # another phone) becomes invalid the moment this login is saved.
        session_key = uuid.uuid4().hex
        cursor.execute(
            "UPDATE employees SET session_key = %s WHERE employee_id = %s",
            (session_key, emp["employee_id"]),
        )
        db.commit()
        return {
            "token": create_token(
                emp["employee_id"] or emp["email"], "employee", session_id=session_key
            ),
            "employee_id": emp["employee_id"],
            "name": emp["name"],
            "email": emp["email"],
            "phone": emp.get("phone") or "",
            "government_id": emp.get("government_id") or "",
            "sss_number": emp.get("sss_number") or "",
            "philhealth_number": emp.get("philhealth_number") or "",
            "pagibig_number": emp.get("pagibig_number") or "",
            "tin_number": emp.get("tin_number") or "",
            "status": emp["status"],
            "photo_url": f"/attendance-faces/{emp['face_image']}" if emp.get("face_image") else "",
            "message": "Login successful",
        }
    finally:
        db.close()


@app.get("/employee/session")
def employee_session(employee: str = Depends(verify_employee_token)):
    """Lightweight session validation for the Flutter app. The app calls this
    before offering "Login with Fingerprint" so an expired or archived session
    is detected up-front instead of failing after fingerprint verification."""
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute("""
            SELECT employee_id, name, email, phone, government_id, status, face_image,
                   sss_number, philhealth_number, pagibig_number, tin_number
            FROM employees
            WHERE employee_id = %s AND status = 'approved'
            LIMIT 1
        """, (employee,))
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=403, detail="Employee account not found or not approved")
        return {
            "employee_id": emp["employee_id"],
            "name": emp["name"],
            "email": emp["email"],
            "phone": emp.get("phone") or "",
            "government_id": emp.get("government_id") or "",
            "sss_number": emp.get("sss_number") or "",
            "philhealth_number": emp.get("philhealth_number") or "",
            "pagibig_number": emp.get("pagibig_number") or "",
            "tin_number": emp.get("tin_number") or "",
            "status": emp["status"],
            "photo_url": f"/attendance-faces/{emp['face_image']}" if emp.get("face_image") else "",
        }
    finally:
        db.close()


@app.post("/employee/device-token")
def save_employee_device_token(
    device_token: str = Form(...),
    platform: str = Form("android"),
    employee: str = Depends(verify_employee_token),
):
    clean_token = device_token.strip()
    clean_platform = platform.strip()[:30] or "android"
    if not clean_token:
        raise HTTPException(status_code=400, detail="Device token is required.")

    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT employee_id
            FROM employees
            WHERE status = 'approved'
              AND (LOWER(employee_id) = LOWER(%s) OR LOWER(email) = LOWER(%s))
            LIMIT 1
            """,
            (employee, employee),
        )
        emp = cursor.fetchone()
        if not emp or not emp.get("employee_id"):
            raise HTTPException(status_code=404, detail="Employee not found.")

        cursor.execute(
            """
            INSERT INTO employee_device_tokens (employee_id, device_token, platform, updated_at)
            VALUES (%s, %s, %s, NOW())
            ON CONFLICT (employee_id, device_token)
            DO UPDATE SET platform = EXCLUDED.platform, updated_at = NOW()
            """,
            (emp["employee_id"], clean_token, clean_platform),
        )
        db.commit()
        return {"message": "Device registered for notifications."}
    finally:
        db.close()


@app.get("/employee/notifications")
def employee_notifications(employee: str = Depends(verify_employee_token)):
    """Latest admin announcements + the signed-in employee's payroll
    notifications, for the in-app notification bell."""
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            "SELECT payroll_employee_id FROM employees WHERE employee_id = %s AND status = 'approved' LIMIT 1",
            (employee,),
        )
        emp = cursor.fetchone()
        payroll_employee_id = int(emp["payroll_employee_id"]) if emp and emp.get("payroll_employee_id") else None

        cursor.execute(
            """
            SELECT 'announcement' AS type, title, message AS body,
                   to_char(created_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
            FROM public.announcements
            ORDER BY created_at DESC
            LIMIT 20
            """
        )
        announcements = cursor.fetchall()

        notifications = []
        if payroll_employee_id:
            cursor.execute(
                """
                SELECT id, type, title, body, data,
                       read_at IS NOT NULL AS is_read,
                       to_char(created_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
                FROM public.notifications
                WHERE recipient_type = 'employee' AND recipient_id = %s
                ORDER BY created_at DESC
                LIMIT 100
                """,
                (payroll_employee_id,),
            )
            notifications = cursor.fetchall()

        return {
            "announcements": announcements,
            "notifications": notifications,
            "unread": sum(1 for n in notifications if not n["is_read"]),
        }
    finally:
        db.close()


@app.post("/employee/notifications/read")
def employee_notifications_read(
    employee: str = Depends(verify_employee_token),
    payload: dict = Body(default=None),
):
    """Mark the signed-in employee's notifications as read. Optionally pass
    {"ids": [...]} to mark only a subset; otherwise all are marked read."""
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            "SELECT payroll_employee_id FROM employees WHERE employee_id = %s AND status = 'approved' LIMIT 1",
            (employee,),
        )
        emp = cursor.fetchone()
        payroll_employee_id = int(emp["payroll_employee_id"]) if emp and emp.get("payroll_employee_id") else None
        if not payroll_employee_id:
            return {"ok": True}
        ids = [int(i) for i in ((payload or {}).get("ids") or []) if str(i).isdigit()]
        if ids:
            cursor.execute(
                """
                UPDATE public.notifications
                SET read_at = NOW()
                WHERE recipient_type = 'employee' AND recipient_id = %s AND id = ANY(%s) AND read_at IS NULL
                """,
                (payroll_employee_id, ids),
            )
        else:
            cursor.execute(
                """
                UPDATE public.notifications
                SET read_at = NOW()
                WHERE recipient_type = 'employee' AND recipient_id = %s AND read_at IS NULL
                """,
                (payroll_employee_id,),
            )
        db.commit()
        return {"ok": True}
    finally:
        db.close()


@app.post("/employee/forgot-password")
async def employee_forgot_password(email: str = Form(...)):
    clean_email = email.strip()
    limiter_key = _rate_limit_storage_key("employee_forgot_password", clean_email or email or "unknown")
    if not clean_email:
        raise HTTPException(status_code=400, detail="Email is required.")

    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        _enforce_rate_limit(cursor, limiter_key, "employee_forgot_password")
        cursor.execute("""
            SELECT employee_id, name, email
            FROM employees
            WHERE email = %s
            ORDER BY registered_at DESC
            LIMIT 1
        """, (clean_email,))
        emp = cursor.fetchone()
        if not emp:
            wait_seconds = _register_rate_limit_failure(cursor, limiter_key, "employee_forgot_password")
            db.commit()
            if wait_seconds:
                raise HTTPException(
                    status_code=429,
                    detail=_rate_limit_block_message(wait_seconds),
                    headers={"Retry-After": str(wait_seconds)},
                )
            raise HTTPException(status_code=404, detail="No account found for that email.")

        reset_code = _generate_reset_code()
        expires_at = datetime.now() + timedelta(minutes=RESET_CODE_EXPIRE_MINUTES)
        cursor.execute("""
            UPDATE employee_password_reset_requests
            SET status = 'expired'
            WHERE email = %s AND status IN ('pending', 'verified')
        """, (emp["email"],))
        cursor.execute("""
            INSERT INTO employee_password_reset_requests (employee_id, email, reset_code, reset_code_expires_at, status)
            VALUES (%s, %s, %s, %s, 'pending')
        """, (emp["employee_id"], emp["email"], reset_code, expires_at))
        db.commit()

        subject = "Employee Password Reset Code"
        body = (
            f"Hi {emp.get('name') or 'Employee'},\n\n"
            f"Your password reset code is: {reset_code}\n\n"
            f"This code is valid for {RESET_CODE_EXPIRE_MINUTES} minutes. "
            "If you did not request this, please ignore this email."
        )
        email_sent = await anyio.to_thread.run_sync(_send_email, emp["email"], subject, body)
        if not email_sent:
            raise HTTPException(status_code=500, detail="Failed to send verification code. Please check server logs.")

        _clear_rate_limit(cursor, limiter_key, "employee_forgot_password")
        db.commit()
        return {
            "message": "Verification code sent to your email.",
            "email": emp["email"],
            "employee_id": emp["employee_id"],
        }
    finally:
        db.close()


@app.post("/employee/verify-reset-code")
def employee_verify_reset_code(email: str = Form(...), code: str = Form(...)):
    clean_email = email.strip()
    clean_code = code.strip().upper()
    limiter_key = _rate_limit_storage_key("employee_reset_verify", clean_email or "unknown")
    if not clean_email:
        raise HTTPException(status_code=400, detail="Email is required.")
    if not clean_code:
        raise HTTPException(status_code=400, detail="Verification code is required.")

    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        _enforce_rate_limit(cursor, limiter_key, "employee_reset_verify")
        cursor.execute("""
            SELECT id, employee_id, email, reset_code_expires_at, status
            FROM employee_password_reset_requests
            WHERE email = %s AND reset_code = %s
            ORDER BY requested_at DESC, id DESC
            LIMIT 1
        """, (clean_email, clean_code))
        reset_request = cursor.fetchone()
        if not reset_request:
            wait_seconds = _register_rate_limit_failure(cursor, limiter_key, "employee_reset_verify")
            db.commit()
            if wait_seconds:
                raise HTTPException(
                    status_code=429,
                    detail=_rate_limit_block_message(wait_seconds),
                    headers={"Retry-After": str(wait_seconds)},
                )
            raise HTTPException(status_code=400, detail="Invalid verification code.")

        if reset_request["status"] not in {"pending", "verified"}:
            raise HTTPException(status_code=400, detail="No verification code found. Please request a new one.")
        if datetime.now() > reset_request["reset_code_expires_at"]:
            cursor.execute("UPDATE employee_password_reset_requests SET status = 'expired' WHERE id = %s", (reset_request["id"],))
            wait_seconds = _register_rate_limit_failure(cursor, limiter_key, "employee_reset_verify")
            db.commit()
            if wait_seconds:
                raise HTTPException(
                    status_code=429,
                    detail=_rate_limit_block_message(wait_seconds),
                    headers={"Retry-After": str(wait_seconds)},
                )
            raise HTTPException(status_code=400, detail="Verification code has expired.")

        cursor.execute("UPDATE employee_password_reset_requests SET status = 'verified' WHERE id = %s", (reset_request["id"],))
        _clear_rate_limit(cursor, limiter_key, "employee_reset_verify")
        db.commit()
        return {"message": "Code verified. You may now set a new password."}
    finally:
        db.close()


@app.post("/employee/reset-password")
def employee_reset_password(email: str = Form(...), code: str = Form(...), new_password: str = Form(...)):
    clean_email = email.strip()
    clean_code = code.strip().upper()
    clean_new_password = new_password.strip()
    limiter_key = _rate_limit_storage_key("employee_reset_password", clean_email or "unknown")
    if not clean_email:
        raise HTTPException(status_code=400, detail="Email is required.")
    if not clean_code:
        raise HTTPException(status_code=400, detail="Verification code is required.")
    if len(clean_new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")

    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        _enforce_rate_limit(cursor, limiter_key, "employee_reset_password")
        cursor.execute("""
            SELECT id, employee_id, reset_code_expires_at, status
            FROM employee_password_reset_requests
            WHERE email = %s AND reset_code = %s
            ORDER BY requested_at DESC, id DESC
            LIMIT 1
        """, (clean_email, clean_code))
        reset_request = cursor.fetchone()
        if not reset_request:
            wait_seconds = _register_rate_limit_failure(cursor, limiter_key, "employee_reset_password")
            db.commit()
            if wait_seconds:
                raise HTTPException(
                    status_code=429,
                    detail=_rate_limit_block_message(wait_seconds),
                    headers={"Retry-After": str(wait_seconds)},
                )
            raise HTTPException(status_code=400, detail="Invalid verification code.")
        if reset_request["status"] != "verified":
            raise HTTPException(status_code=400, detail="Invalid or unverified code for password reset.")
        if datetime.now() > reset_request["reset_code_expires_at"]:
            cursor.execute("UPDATE employee_password_reset_requests SET status = 'expired' WHERE id = %s", (reset_request["id"],))
            wait_seconds = _register_rate_limit_failure(cursor, limiter_key, "employee_reset_password")
            db.commit()
            if wait_seconds:
                raise HTTPException(
                    status_code=429,
                    detail=_rate_limit_block_message(wait_seconds),
                    headers={"Retry-After": str(wait_seconds)},
                )
            raise HTTPException(status_code=400, detail="Verification code has expired.")

        hashed_password = pwd_context.hash(clean_new_password)
        cursor.execute("UPDATE employees SET password_hash = %s WHERE employee_id = %s", (hashed_password, reset_request["employee_id"]))
        cursor.execute("""
            UPDATE employee_password_reset_requests
            SET status = 'completed', processed_at = CURRENT_TIMESTAMP
            WHERE id = %s
        """, (reset_request["id"],))
        _clear_rate_limit(cursor, limiter_key, "employee_reset_password")
        _audit(cursor, clean_email, "employee_password_reset", "employee", reset_request["employee_id"], {"email": clean_email})
        db.commit()
        return {"message": "Password updated successfully."}
    finally:
        db.close()


def _employee_daily_financials(cursor, payroll_employee_id) -> dict:
    """Per-day salary / extra pay / cash-advance totals for the employee's
    calendar day detail, keyed by 'YYYY-MM-DD'. Returns {} when the employee
    is not linked to a payroll record yet."""
    daily: dict[str, dict[str, float]] = {}
    if not payroll_employee_id:
        return daily

    def _add(date_value, key: str, amount) -> None:
        date_key = str(date_value)
        bucket = daily.setdefault(date_key, {"salary": 0.0, "extra": 0.0, "cash_advance": 0.0})
        bucket[key] = round(bucket[key] + float(amount or 0), 2)

    cursor.execute(
        "SELECT work_date, rate_snapshot FROM public.attendance_logs WHERE employee_id = %s",
        (payroll_employee_id,),
    )
    for row in cursor.fetchall():
        if row.get("rate_snapshot") is not None:
            _add(row["work_date"], "salary", row["rate_snapshot"])

    cursor.execute(
        "SELECT extra_date, amount FROM public.extra_payments WHERE employee_id = %s",
        (payroll_employee_id,),
    )
    for row in cursor.fetchall():
        _add(row["extra_date"], "extra", row["amount"])

    cursor.execute(
        "SELECT advance_date, amount FROM public.cash_advances WHERE employee_id = %s",
        (payroll_employee_id,),
    )
    for row in cursor.fetchall():
        _add(row["advance_date"], "cash_advance", row["amount"])

    return daily


@app.get("/employee/logs")
def employee_logs(employee: str = Depends(verify_employee_token)):
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute("""
            SELECT employee_id, name, email, phone, government_id, status, face_image,
                   sss_number, philhealth_number, pagibig_number, tin_number, payroll_employee_id
            FROM employees
            WHERE employee_id = %s AND status = 'approved'
            LIMIT 1
        """, (employee,))
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=403, detail="Employee account not found or not approved")

        cursor.execute("""
            SELECT id, type, timestamp
            FROM attendance
            WHERE employee_id = %s
            ORDER BY timestamp ASC, id ASC
        """, (employee,))
        grouped_rows = cursor.fetchall()

        cursor.execute("""
            SELECT type, timestamp
            FROM attendance
            WHERE employee_id = %s
            ORDER BY timestamp DESC, id DESC
        """, (employee,))
        raw = cursor.fetchall()

        grouped = _pair_attendance_sessions(grouped_rows)
        payroll = employee_payroll(employee=employee)

        daily = _employee_daily_financials(cursor, emp.get("payroll_employee_id"))

        return {
            "employee": {
                "employee_id": emp["employee_id"],
                "name": emp["name"],
                "email": emp["email"],
                "phone": emp.get("phone") or "",
                "government_id": emp.get("government_id") or "",
                "sss_number": emp.get("sss_number") or "",
                "philhealth_number": emp.get("philhealth_number") or "",
                "pagibig_number": emp.get("pagibig_number") or "",
                "tin_number": emp.get("tin_number") or "",
                "status": emp["status"],
                "photo_url": f"/attendance-faces/{emp['face_image']}" if emp.get("face_image") else "",
            },
            "grouped": [{
                "work_date": str(row["work_date"]) if row["work_date"] else None,
                "time_in": str(row["time_in"]) if row["time_in"] else None,
                "time_out": str(row["time_out"]) if row["time_out"] else None,
                "time_out_date": str(row["time_out_date"]) if row["time_out_date"] else None,
                "duration": row["duration"],
            } for row in grouped],
            "raw": raw,
            "payroll": payroll,
            "daily": daily,
        }
    finally:
        db.close()

# â”€â”€â”€ ADMIN: PENDING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@app.get("/admin/pending")
def get_pending(page: int = 1, limit: int = 50, search: str = "", admin: str = Depends(verify_admin_token)):
    safe_page = max(1, page)
    safe_limit = max(1, min(limit, 500))
    offset = (safe_page - 1) * safe_limit
    clean_search = search.strip()
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        where_sql = "status IN ('pending', 'review')"
        params: list[object] = []
        if clean_search:
            where_sql += " AND (name ILIKE %s OR employee_id ILIKE %s OR email ILIKE %s OR phone ILIKE %s)"
            term = f"%{clean_search}%"
            params.extend([term, term, term, term])
        cursor.execute(f"SELECT COUNT(*) AS count FROM employees WHERE {where_sql}", tuple(params))
        total = int(cursor.fetchone()["count"])
        cursor.execute(f"""
            SELECT id, employee_id, name, email, phone, face_image,
                   status, admin_notes, registered_at
            FROM employees
            WHERE {where_sql}
            ORDER BY CASE status WHEN 'review' THEN 0 ELSE 1 END, registered_at DESC
            LIMIT %s OFFSET %s
        """, (*params, safe_limit, offset))
        return {"rows": cursor.fetchall(), "page": safe_page, "limit": safe_limit, "total": total}
    finally:
        db.close()

# â”€â”€â”€ ADMIN: ALL EMPLOYEES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@app.get("/admin/employees")
def get_all_employees(page: int = 1, limit: int = 50, search: str = "", status: str = "", admin: str = Depends(verify_admin_token)):
    safe_page = max(1, page)
    safe_limit = max(1, min(limit, 100))
    offset = (safe_page - 1) * safe_limit
    clean_search = search.strip()
    clean_status = status.strip().lower()
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        where_sql = "status != 'rejected'"
        params: list[object] = []
        if clean_status and clean_status != "all":
            where_sql += " AND LOWER(status) = %s"
            params.append(clean_status)
        if clean_search:
            where_sql += " AND (name ILIKE %s OR employee_id ILIKE %s OR email ILIKE %s OR phone ILIKE %s)"
            term = f"%{clean_search}%"
            params.extend([term, term, term, term])
        cursor.execute(f"SELECT COUNT(*) AS count FROM employees WHERE {where_sql}", tuple(params))
        total = int(cursor.fetchone()["count"])
        cursor.execute(f"""
            SELECT id, employee_id, name, email, phone, face_image,
                   status, admin_notes, registered_at, approved_at, daily_rate
            FROM employees
            WHERE {where_sql}
            ORDER BY registered_at DESC
            LIMIT %s OFFSET %s
        """, (*params, safe_limit, offset))
        return {"rows": cursor.fetchall(), "page": safe_page, "limit": safe_limit, "total": total}
    finally:
        db.close()


@app.get("/admin/audit-logs")
def get_admin_audit_logs(admin: str = Depends(verify_admin_token), page: int = 1, limit: int = 50, search: str = ""):
    safe_page = max(1, page)
    safe_limit = max(1, min(int(limit or 50), 200))
    offset = (safe_page - 1) * safe_limit
    clean_search = search.strip()
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        where_sql = ""
        params: list[object] = []
        if clean_search:
            where_sql = """
            WHERE admin_user ILIKE %s
               OR action ILIKE %s
               OR target_type ILIKE %s
               OR target_id ILIKE %s
               OR details::text ILIKE %s
            """
            term = f"%{clean_search}%"
            params.extend([term, term, term, term, term])
        cursor.execute(f"SELECT COUNT(*) AS count FROM admin_audit_logs {where_sql}", tuple(params))
        total = int(cursor.fetchone()["count"])
        cursor.execute(
            f"""
            SELECT admin_user, action, target_type, target_id, details, created_at
            FROM admin_audit_logs
            {where_sql}
            ORDER BY created_at DESC, id DESC
            LIMIT %s OFFSET %s
            """,
            (*params, safe_limit, offset),
        )
        rows = [{
            **row,
            "details": _parse_audit_details(row.get("details")),
            "created_at": str(row["created_at"]) if row.get("created_at") else None,
        } for row in cursor.fetchall()]
        return {"rows": rows, "page": safe_page, "limit": safe_limit, "total": total}
    finally:
        db.close()


_PERIOD_ANCHOR = datetime(2020, 1, 6).date()


def _self_period_start(value, period_days: int) -> datetime.date:
    d = value.date() if isinstance(value, datetime) else value
    monday = d - timedelta(days=d.isoweekday() - 1)
    diff = (monday - _PERIOD_ANCHOR).days
    return _PERIOD_ANCHOR + timedelta(days=(diff // period_days) * period_days)


def _self_calc_week_state(
    previous_bale: float,
    previous_unpaid: float,
    salary: float,
    cash_advance: float,
    salary_paid_amount: float,
    deduct_bale: bool,
    bale_payment_amount: float,
    extra_payment: float,
) -> dict:
    """Port of server.js calculatePayrollWeekState."""
    payment_to_previous_unpaid = min(salary_paid_amount, previous_unpaid)
    current_salary_paid = min(max(salary_paid_amount - payment_to_previous_unpaid, 0), salary)
    total_bale = previous_bale + cash_advance

    if deduct_bale and salary == 0:
        after_previous_unpaid = max(salary_paid_amount - payment_to_previous_unpaid, 0)
        bale_deduction = min(total_bale, after_previous_unpaid)
        remaining_bale_balance = max(total_bale - bale_deduction - bale_payment_amount, 0)
        take_home = 0
        current_unpaid = max(take_home - current_salary_paid - bale_payment_amount, 0)
    else:
        bale_deduction = 0
        remaining_bale_balance = max(total_bale - bale_payment_amount, 0)
        take_home = max(salary, 0)
        current_unpaid = max(take_home - current_salary_paid, 0)

    # Any salary payment that exceeds salary goes towards extra pay
    # (mirrors server.js calculatePayrollWeekState)
    salary_excess_for_extra = max(salary_paid_amount - payment_to_previous_unpaid - current_salary_paid, 0)
    effective_extra_pay = max(extra_payment - salary_excess_for_extra, 0)

    balance = max(previous_unpaid - payment_to_previous_unpaid, 0) + current_unpaid + effective_extra_pay
    return {
        "total_bale": total_bale,
        "bale_deduction": bale_deduction,
        "remaining_bale_balance": remaining_bale_balance,
        "take_home": take_home,
        "balance": balance,
    }


def _period_type_label(period_days: int) -> str:
    """Human label for the employee's pay frequency (weekly / semi-monthly)."""
    return "weekly" if period_days <= 7 else "semi-monthly"


def _employee_payroll_periods(cursor, payroll_employee_id: int, period_days: int) -> list:
    """Computes every payroll period for an employee, bucketing salary,
    cash advances, extra pay, bale payments and salary payments into periods
    anchored by _self_period_start, then walking the running balance with
    _self_calc_week_state (the Python port of server.js logic)."""
    if not payroll_employee_id:
        return []

    def fetch_period_table(table: str, date_col: str, val_col: str) -> list:
        cursor.execute(
            f"SELECT {date_col} AS d, {val_col} AS v FROM public.{table} WHERE employee_id = %s ORDER BY {date_col}",
            (payroll_employee_id,),
        )
        return cursor.fetchall()

    attendance_rows = fetch_period_table("attendance_logs", "work_date", "rate_snapshot")
    advance_rows = fetch_period_table("cash_advances", "advance_date", "amount")
    extra_rows = fetch_period_table("extra_payments", "extra_date", "amount")
    bale_pay_rows = fetch_period_table("bale_payments", "payment_date", "amount")
    salary_pay_rows = fetch_period_table("salary_payments", "payment_date", "amount")
    cursor.execute(
        "SELECT week_start, paid_amount, bale_deducted, status FROM public.payroll_statuses WHERE employee_id = %s ORDER BY week_start",
        (payroll_employee_id,),
    )
    status_rows = cursor.fetchall()

    periods: dict = {}

    def ensure(period_start):
        if period_start not in periods:
            periods[period_start] = {
                "salary": 0.0,
                "cash_advance": 0.0,
                "extra": 0.0,
                "paid": 0.0,
                "bale_paid": 0.0,
                "deduct_bale": False,
                "generated": False,
                "attendance": [],
            }
        return periods[period_start]

    for row in attendance_rows:
        ps = _self_period_start(row["d"], period_days)
        bucket = ensure(ps)
        bucket["salary"] += _to_float(row["v"])
        bucket["attendance"].append({
            "work_date": str(row["d"]),
            "amount": round(_to_float(row["v"]), 2),
        })
    for row in advance_rows:
        ensure(_self_period_start(row["d"], period_days))["cash_advance"] += _to_float(row["v"])
    for row in extra_rows:
        ensure(_self_period_start(row["d"], period_days))["extra"] += _to_float(row["v"])
    for row in bale_pay_rows:
        ensure(_self_period_start(row["d"], period_days))["bale_paid"] += _to_float(row["v"])
    for row in salary_pay_rows:
        ensure(_self_period_start(row["d"], period_days))["paid"] += _to_float(row["v"])
    for row in status_rows:
        bucket = ensure(row["week_start"])
        bucket["paid"] = max(bucket["paid"], _to_float(row["paid_amount"]))
        bucket["deduct_bale"] = bool(row.get("bale_deducted"))
        if (row.get("status") or "").lower() == "generated":
            bucket["generated"] = True

    results = []
    carryover = {"bale": 0.0, "unpaid": 0.0}
    for period_start in sorted(periods.keys()):
        bucket = periods[period_start]
        state = _self_calc_week_state(
            carryover["bale"],
            carryover["unpaid"],
            bucket["salary"],
            bucket["cash_advance"],
            bucket["paid"],
            bucket["deduct_bale"],
            bucket["bale_paid"],
            bucket["extra"],
        )
        carryover["bale"] = state["remaining_bale_balance"]
        carryover["unpaid"] = state["balance"]

        if (bucket["salary"] <= 0 and bucket["cash_advance"] <= 0
                and bucket["paid"] <= 0 and bucket["extra"] <= 0
                and state["balance"] <= 0 and state["remaining_bale_balance"] <= 0):
            continue

        period_end = period_start + timedelta(days=period_days - 1)
        payment_history = [
            {"amount_paid": round(_to_float(row["v"]), 2), "created_at": str(row["d"])}
            for row in salary_pay_rows
            if _self_period_start(row["d"], period_days) == period_start
        ]
        payment_status = (
            "paid"
            if state["balance"] == 0 and state["remaining_bale_balance"] == 0
            else "generated" if bucket["generated"]
            else "partial" if bucket["paid"] > 0 else "unpaid"
        )
        results.append({
            "employee_id": payroll_employee_id,
            "period_key": str(period_start),
            "start_date": str(period_start),
            "end_date": str(period_end),
            "period_type": _period_type_label(period_days),
            "days": len(bucket["attendance"]),
            "amount": round(bucket["salary"], 2),
            "salary": round(bucket["salary"], 2),
            "cash_advance": round(bucket["cash_advance"], 2),
            "extra_payment": round(bucket["extra"], 2),
            "paid_amount": round(bucket["paid"], 2),
            "balance": round(state["balance"], 2),
            "remaining_bale_balance": round(state["remaining_bale_balance"], 2),
            "payment_status": payment_status,
            "payment_history": payment_history,
            "attendance": sorted(bucket["attendance"], key=lambda x: x["work_date"]),
        })

    results.sort(key=lambda row: row["period_key"], reverse=True)
    return results


@app.get("/employee/payroll")
def employee_payroll(
    start_date: str = "",
    end_date: str = "",
    employee: str = Depends(verify_employee_token),
):
    """Employee's own payroll, computed from the shared payroll database
    (public schema) via the payroll_employee_id link."""
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)

        cursor.execute(
            """
            SELECT employee_id, name, email, payroll_employee_id
            FROM employees
            WHERE employee_id = %s AND status = 'approved'
            LIMIT 1
            """,
            (employee,),
        )
        emp = cursor.fetchone()
        if not emp or not emp.get("payroll_employee_id"):
            return {
                "rows": [],
                "totals": [],
                "summary": {
                    "total_amount": 0,
                    "paid_amount": 0,
                    "balance": 0,
                    "days": 0,
                    "salary": 0,
                    "cash_advance": 0,
                    "remaining_bale_balance": 0,
                },
                "period_key": None,
                "linked": False,
            }
        payroll_employee_id = int(emp["payroll_employee_id"])

        cursor.execute(
            "SELECT rate, pay_period_days, name, emp_number FROM public.employees WHERE id = %s AND active = true",
            (payroll_employee_id,),
        )
        payroll_emp = cursor.fetchone()
        if not payroll_emp:
            return {
                "rows": [],
                "totals": [],
                "summary": {
                    "total_amount": 0,
                    "paid_amount": 0,
                    "balance": 0,
                    "days": 0,
                    "salary": 0,
                    "cash_advance": 0,
                    "remaining_bale_balance": 0,
                },
                "period_key": None,
                "linked": False,
            }
        period_days = max(1, int(payroll_emp.get("pay_period_days") or 7))
        results = _employee_payroll_periods(cursor, payroll_employee_id, period_days)

        start_filter = None
        end_filter = None
        if start_date.strip():
            try:
                start_filter = datetime.fromisoformat(start_date.strip()).date()
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid start_date format.")
        if end_date.strip():
            try:
                end_filter = datetime.fromisoformat(end_date.strip()).date()
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid end_date format.")

        if start_filter or end_filter:
            filtered = []
            for row in results:
                row_start = datetime.fromisoformat(row["period_key"]).date()
                row_end = datetime.fromisoformat(row["end_date"]).date()
                if start_filter and row_end < start_filter:
                    continue
                if end_filter and row_start > end_filter:
                    continue
                filtered.append(row)

            empty_payload = {
                "rows": [],
                "totals": [],
                "summary": {
                    "total_amount": 0,
                    "paid_amount": 0,
                    "balance": 0,
                    "days": 0,
                    "salary": 0,
                    "cash_advance": 0,
                    "extra_payment": 0,
                    "remaining_bale_balance": 0,
                },
                "period_key": None,
                "linked": True,
            }
            if not filtered:
                return empty_payload

            rows = sorted(
                (day for row in filtered for day in row["attendance"]
                 if (not start_filter or day["work_date"] >= str(start_filter))
                 and (not end_filter or day["work_date"] <= str(end_filter))),
                key=lambda day: day["work_date"],
            )
            totals = [{key: value for key, value in row.items() if key != "attendance"} for row in filtered]
            latest = filtered[0]
            return {
                "rows": rows,
                "totals": totals,
                "summary": {
                    "total_amount": round(sum(row["amount"] for row in filtered), 2),
                    "paid_amount": round(sum(row["paid_amount"] for row in filtered), 2),
                    "balance": latest["balance"],
                    "days": sum(row["days"] for row in filtered),
                    "salary": round(sum(row["salary"] for row in filtered), 2),
                    "cash_advance": round(sum(row["cash_advance"] for row in filtered), 2),
                    "extra_payment": round(sum(row["extra_payment"] for row in filtered), 2),
                    "remaining_bale_balance": latest["remaining_bale_balance"],
                },
                "period_key": None,
                "linked": True,
            }

        today = _local_now().date()
        current_period_key = str(_self_period_start(today, period_days))
        current = next((row for row in results if row["period_key"] == current_period_key), None)
        if current is None and results:
            current = results[0]

        if current is None:
            return {
                "rows": [],
                "totals": [],
                "summary": {
                    "total_amount": 0,
                    "paid_amount": 0,
                    "balance": 0,
                    "days": 0,
                    "salary": 0,
                    "cash_advance": 0,
                    "remaining_bale_balance": 0,
                },
                "period_key": None,
                "linked": True,
            }

        return {
            "rows": current["attendance"],
            "totals": [{key: value for key, value in current.items() if key != "attendance"}],
            "summary": {
                "total_amount": current["amount"],
                "paid_amount": current["paid_amount"],
                "balance": current["balance"],
                "days": current["days"],
                "salary": current["salary"],
                "cash_advance": current["cash_advance"],
                "extra_payment": current["extra_payment"],
                "remaining_bale_balance": current["remaining_bale_balance"],
            },
            "period_key": current["period_key"],
            "linked": True,
        }
    finally:
        db.close()


# ── PAYSLIP PDF + EMAIL HELPERS ────────────────────────────────────────────
def _escape_pdf_text(text: str) -> str:
    """Latin-1-safe text for the minimal PDF writer. Keeps printable ASCII plus
    common Latin-1 accents (é, ñ, á...); anything else becomes '?'."""
    out = []
    for ch in text:
        o = ord(ch)
        if ch in '()\\':
            out.append('\\' + ch)
        elif 32 <= o <= 126 or 161 <= o <= 255:
            out.append(ch)
        else:
            out.append('?')
    return ''.join(out)


def _build_payslip_pdf(
    employee_name: str,
    emp_number: str,
    period_type: str,
    period_start: str,
    period_end: str,
    days: int,
    salary: float,
    extra: float,
    cash_advance: float,
    paid: float,
    balance: float,
) -> bytes:
    """Minimal dependency-free PDF payslip (Helvetica text layout)."""
    total_earnings = salary + extra
    net_pay = total_earnings - cash_advance
    sections = [
        ('PAYSLIP', True, 16),
        ('', False, 8),
        ('Employee: %s (%s)' % (employee_name, emp_number), False, 10),
        ('Pay period: %s to %s' % (period_start, period_end), False, 10),
        ('Pay frequency: %s' % period_type.upper(), False, 10),
        ('', False, 8),
        ('EARNINGS', True, 11),
        ('  Days worked:  %d' % days, False, 10),
        ('  Salary:       PHP %s' % format(salary, ',.2f'), False, 10),
        ('  Extra pay:    PHP %s' % format(extra, ',.2f'), False, 10),
        ('  Total earnings: PHP %s' % format(total_earnings, ',.2f'), True, 11),
        ('', False, 8),
        ('DEDUCTIONS', True, 11),
        ('  Cash advance: PHP %s' % format(cash_advance, ',.2f'), False, 10),
        ('', False, 8),
        ('NET PAY:  PHP %s' % format(net_pay, ',.2f'), True, 14),
        ('', False, 8),
        ('Paid:     PHP %s' % format(paid, ',.2f'), False, 10),
        ('Balance:  PHP %s' % format(balance, ',.2f'), False, 10),
        ('', False, 8),
        ('Generated by the Payroll System.', False, 9),
    ]

    stream_parts = ['BT']
    y = 740
    for text, bold, size in sections:
        font = '/F2' if bold else '/F1'
        stream_parts.append('%s %s Tf' % (font, size))
        stream_parts.append('1 0 0 1 72 %s Tm' % y)
        stream_parts.append('(%s) Tj' % _escape_pdf_text(text))
        y -= size + 8
    stream_parts.append('ET')
    stream = '\n'.join(stream_parts)

    objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
        '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
        '<< /Length %d >>\nstream\n%s\nendstream' % (len(stream.encode('latin-1')), stream),
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    ]

    pdf = bytearray(b'%PDF-1.4\n')
    offsets = [0]
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf.extend(('%d 0 obj\n' % i).encode('latin-1'))
        pdf.extend(obj.encode('latin-1'))
        pdf.extend(b'\nendobj\n')
    xref_pos = len(pdf)
    pdf.extend(('xref\n0 %d\n' % (len(objects) + 1)).encode('latin-1'))
    pdf.extend(b'0000000000 65535 f \n')
    for off in offsets[1:]:
        pdf.extend(('%010d 00000 n \n' % off).encode('latin-1'))
    pdf.extend(('trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%EOF'
                % (len(objects) + 1, xref_pos)).encode('latin-1'))
    return bytes(pdf)


def _send_email_with_pdf(recipient_email: str, subject: str, body: str,
                         pdf_bytes: bytes, filename: str = "payslip.pdf") -> bool:
    """Send an email with a PDF attachment via Resend or SMTP."""
    if RESEND_API_KEY:
        payload = json.dumps({
            "from": RESEND_FROM,
            "to": [recipient_email],
            "subject": subject,
            "text": body,
            "attachments": [{
                "filename": filename,
                "content": base64.b64encode(pdf_bytes).decode("ascii"),
            }],
        }).encode("utf-8")
        request = urllib.request.Request(
            "https://api.resend.com/emails",
            data=payload,
            headers={
                "Authorization": "Bearer %s" % RESEND_API_KEY,
                "Content-Type": "application/json",
                "User-Agent": "kvsk-attendance-system/1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                if 200 <= response.status < 300:
                    logger.info("Resend payslip email sent to %s", recipient_email)
                    return True
                logger.error("Resend payslip returned status %s", response.status)
                return False
        except Exception as exc:
            logger.error("Resend payslip failed for %s: %s", recipient_email, exc)
            return False

    if not all([SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SENDER_EMAIL]):
        logger.error("Email configuration is incomplete. Cannot send payslip.")
        return False
    msg = MIMEMultipart()
    msg['Subject'] = subject
    msg['From'] = SMTP_SENDER_EMAIL
    msg['To'] = recipient_email
    msg.attach(MIMEText(body))
    part = MIMEApplication(pdf_bytes, _subtype="pdf")
    part.add_header('Content-Disposition', 'attachment', filename=filename)
    msg.attach(part)
    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.send_message(msg)
        logger.info("SMTP payslip email sent to %s", recipient_email)
        return True
    except Exception as exc:
        logger.error("SMTP payslip failed for %s: %s", recipient_email, exc)
        return False


# ── EMPLOYEE: PAYROLL PERIODS + PAYSLIP REQUESTS ────────────────────────────
@app.get("/employee/payroll/periods")
def employee_payroll_periods(employee: str = Depends(verify_employee_token)):
    """All payroll periods for the signed-in employee (weekly / semi-monthly),
    newest first, each with its payment status so the app can render a paged
    breakdown of paid periods only."""
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            "SELECT payroll_employee_id FROM employees WHERE employee_id = %s AND status = 'approved' LIMIT 1",
            (employee,),
        )
        emp = cursor.fetchone()
        if not emp or not emp.get("payroll_employee_id"):
            return {"periods": [], "period_type": None, "linked": False}
        payroll_employee_id = int(emp["payroll_employee_id"])
        cursor.execute(
            "SELECT pay_period_days FROM public.employees WHERE id = %s AND active = true",
            (payroll_employee_id,),
        )
        payroll_emp = cursor.fetchone()
        if not payroll_emp:
            return {"periods": [], "period_type": None, "linked": True}
        period_days = max(1, int(payroll_emp.get("pay_period_days") or 7))
        rows = _employee_payroll_periods(cursor, payroll_employee_id, period_days)
        periods = []
        for row in rows:
            periods.append({
                "period_key": row["period_key"],
                "start_date": row["start_date"],
                "end_date": row["end_date"],
                "period_type": row["period_type"],
                "payment_status": row["payment_status"],
                "days": row["days"],
                "salary": row["salary"],
                "extra_payment": row["extra_payment"],
                "cash_advance": row["cash_advance"],
                "paid_amount": row["paid_amount"],
                "balance": row["balance"],
                "remaining_bale_balance": row["remaining_bale_balance"],
                "total_earnings": round(row["salary"] + row["extra_payment"], 2),
                "net_pay": round(row["salary"] + row["extra_payment"], 2),
                "attendance": row["attendance"],
                "payment_history": row["payment_history"],
            })
        return {"periods": periods, "period_type": _period_type_label(period_days), "linked": True}
    finally:
        db.close()


@app.get("/employee/payslip/periods")
def employee_payslip_periods(employee: str = Depends(verify_employee_token)):
    """Periods available for a payslip request: only periods the admin has
    generated and the employee was fully paid for."""
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            "SELECT payroll_employee_id FROM employees WHERE employee_id = %s AND status = 'approved' LIMIT 1",
            (employee,),
        )
        emp = cursor.fetchone()
        if not emp or not emp.get("payroll_employee_id"):
            return {"periods": []}
        payroll_employee_id = int(emp["payroll_employee_id"])
        cursor.execute(
            "SELECT pay_period_days FROM public.employees WHERE id = %s AND active = true",
            (payroll_employee_id,),
        )
        payroll_emp = cursor.fetchone()
        if not payroll_emp:
            return {"periods": []}
        period_days = max(1, int(payroll_emp.get("pay_period_days") or 7))
        rows = _employee_payroll_periods(cursor, payroll_employee_id, period_days)
        periods = []
        for row in rows:
            if row["payment_status"] != "paid":
                continue
            periods.append({
                "period_key": row["period_key"],
                "start_date": row["start_date"],
                "end_date": row["end_date"],
                "period_type": row["period_type"],
                "days": row["days"],
                "salary": row["salary"],
                "extra_payment": row["extra_payment"],
                "cash_advance": row["cash_advance"],
                "paid_amount": row["paid_amount"],
                "net_pay": round(row["salary"] + row["extra_payment"] - row["cash_advance"], 2),
            })
        return {"periods": periods}
    finally:
        db.close()


@app.post("/employee/payslip/request")
def employee_payslip_request(
    payload: dict | None = Body(default=None),
    employee: str = Depends(verify_employee_token),
):
    """Employee requests a payslip for a specific paid period. The request
    waits for admin approval; on approval the payslip PDF is emailed."""
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT employee_id, name, email, payroll_employee_id
            FROM employees
            WHERE employee_id = %s AND status = 'approved'
            LIMIT 1
            """,
            (employee,),
        )
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=403, detail="Employee access required")
        payroll_employee_id = emp.get("payroll_employee_id")
        if not payroll_employee_id:
            raise HTTPException(
                status_code=409,
                detail="Your account is not linked to payroll yet. Please ask the administrator to approve you.",
            )
        if not _email_delivery_configured():
            raise HTTPException(
                status_code=409,
                detail="Payslip emailing is not configured yet. Please contact the administrator.",
            )

        body = payload or {}
        period_start = str(body.get("period_start") or "").strip()
        period_end = str(body.get("period_end") or "").strip()
        if not period_start or not period_end:
            raise HTTPException(status_code=400, detail="Period is required.")
        try:
            start_date = datetime.fromisoformat(period_start).date()
            end_date = datetime.fromisoformat(period_end).date()
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid period dates.")
        if end_date < start_date:
            raise HTTPException(status_code=400, detail="Invalid period dates.")

        cursor.execute(
            "SELECT pay_period_days FROM public.employees WHERE id = %s AND active = true",
            (payroll_employee_id,),
        )
        payroll_emp = cursor.fetchone()
        if not payroll_emp:
            raise HTTPException(status_code=409, detail="Payroll account is inactive or missing.")
        period_days = max(1, int(payroll_emp.get("pay_period_days") or 7))
        rows = _employee_payroll_periods(cursor, payroll_employee_id, period_days)
        match = next(
            (r for r in rows if r["start_date"] == str(start_date) and r["end_date"] == str(end_date)),
            None,
        )
        if not match or match["payment_status"] != "paid":
            raise HTTPException(
                status_code=400,
                detail="That period is not available for a payslip. Only generated and paid periods can be requested.",
            )

        cursor.execute(
            "SELECT id FROM public.payslip_requests WHERE employee_id = %s AND status = 'pending' LIMIT 1",
            (payroll_employee_id,),
        )
        if cursor.fetchone():
            raise HTTPException(
                status_code=409,
                detail="You already have a pending payslip request. Wait for the administrator's decision.",
            )

        email = (emp.get("email") or "").strip()
        cursor.execute(
            """
            INSERT INTO public.payslip_requests
                (employee_id, attendance_employee_id, name, email, period_start, period_end)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id, status, requested_at
            """,
            (payroll_employee_id, emp["employee_id"], emp["name"], email, start_date, end_date),
        )
        row = cursor.fetchone()
        db.commit()
        background_tasks.add_task(_notify_payroll_panel, "payslip_request", {
            "name": emp.get("name") or "",
            "period_start": str(start_date),
            "period_end": str(end_date),
        })
        return {
            "ok": True,
            "request": {
                "id": row["id"],
                "status": row["status"],
                "requested_at": str(row["requested_at"]),
            },
        }
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@app.get("/employee/payslip/requests")
def employee_payslip_requests(employee: str = Depends(verify_employee_token)):
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            "SELECT payroll_employee_id FROM employees WHERE employee_id = %s LIMIT 1",
            (employee,),
        )
        emp = cursor.fetchone()
        payroll_employee_id = (emp or {}).get("payroll_employee_id")
        if not payroll_employee_id:
            return {"rows": []}
        cursor.execute(
            """
            SELECT id, period_start, period_end, status, notes,
                   to_char(requested_at, 'YYYY-MM-DD HH24:MI:SS') AS requested_at,
                   to_char(reviewed_at, 'YYYY-MM-DD HH24:MI:SS') AS reviewed_at
            FROM public.payslip_requests
            WHERE employee_id = %s
            ORDER BY requested_at DESC
            LIMIT 10
            """,
            (payroll_employee_id,),
        )
        rows = cursor.fetchall()
        return {"rows": rows}
    finally:
        db.close()


@app.post("/internal/payslip-email")
def internal_payslip_email(
    payload: dict | None = Body(default=None),
    x_internal_secret: str = Header(default="", alias="X-Internal-Secret"),
):
    """Called by the payroll admin panel after approving a payslip request.
    Builds the payslip PDF from the shared payroll DB and emails it."""
    if not INTERNAL_NOTIFY_SECRET or x_internal_secret != INTERNAL_NOTIFY_SECRET:
        raise HTTPException(status_code=403, detail="Forbidden")
    body = payload or {}
    request_id = body.get("request_id")
    if not request_id:
        raise HTTPException(status_code=400, detail="request_id is required")
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT pr.id, pr.employee_id, pr.name, pr.email,
                   pr.period_start, pr.period_end, e.pay_period_days, e.emp_number
            FROM public.payslip_requests pr
            JOIN public.employees e ON e.id = pr.employee_id
            WHERE pr.id = %s
            """,
            (int(request_id),),
        )
        req = cursor.fetchone()
        if not req:
            raise HTTPException(status_code=404, detail="Request not found")
        period_days = max(1, int(req.get("pay_period_days") or 7))
        rows = _employee_payroll_periods(cursor, req["employee_id"], period_days)
        match = next(
            (r for r in rows
             if r["start_date"] == str(req["period_start"]) and r["end_date"] == str(req["period_end"])),
            None,
        )
        if not match:
            raise HTTPException(status_code=400, detail="Period data not found for this request.")

        pdf = _build_payslip_pdf(
            employee_name=req.get("name") or "",
            emp_number=req.get("emp_number") or "",
            period_type=match["period_type"],
            period_start=match["start_date"],
            period_end=match["end_date"],
            days=match["days"],
            salary=match["salary"],
            extra=match["extra_payment"],
            cash_advance=match["cash_advance"],
            paid=match["paid_amount"],
            balance=match["balance"],
        )
        subject = "Your Payslip for %s to %s" % (match["start_date"], match["end_date"])
        net_pay = match["salary"] + match["extra_payment"] - match["cash_advance"]
        email_body = (
            "Hi %s,\n\nYour payslip for the period %s to %s (%s) is attached.\n\n"
            "Net pay: PHP %s\nBalance: PHP %s\n\nThank you."
            % (req.get("name") or "there", match["start_date"], match["end_date"],
               match["period_type"], format(net_pay, ',.2f'), format(match["balance"], ',.2f'))
        )
        sent = _send_email_with_pdf(req.get("email") or "", subject, email_body, pdf)
        return {"sent": sent, "email": req.get("email") or ""}
    finally:
        db.close()


# ── EMPLOYEE: CASH ADVANCE REQUESTS ─────────────────────────────────────────
@app.post("/employee/cash-advance-request")
def employee_cash_advance_request(
    payload: dict | None = Body(default=None),
    employee: str = Depends(verify_employee_token),
):
    """Employee self-service cash advance request. The request lands in the
    payroll admin panel for approval; approving creates the cash_advances
    record automatically."""
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT employee_id, name, payroll_employee_id
            FROM employees
            WHERE employee_id = %s AND status = 'approved'
            LIMIT 1
            """,
            (employee,),
        )
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=403, detail="Employee access required")
        payroll_employee_id = emp.get("payroll_employee_id")
        if not payroll_employee_id:
            raise HTTPException(
                status_code=409,
                detail="Your account is not linked to payroll yet. Please ask the administrator to approve you.",
            )

        body = payload or {}
        amount_raw = body.get("amount")
        if amount_raw is None:
            raise HTTPException(status_code=400, detail="Amount is required.")
        try:
            amount = round(float(amount_raw), 2)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Invalid amount.")
        if amount <= 0 or amount > 1000000:
            raise HTTPException(
                status_code=400,
                detail="Amount must be between 0.01 and 1,000,000.",
            )

        reason = str(body.get("reason") or "").strip()[:500]

        pickup_date = None
        pickup_raw = str(body.get("pickup_date") or "").strip()
        if pickup_raw:
            try:
                pickup_date = datetime.strptime(pickup_raw, "%Y-%m-%d").date()
            except ValueError:
                raise HTTPException(
                    status_code=400,
                    detail="Pickup date must use the format YYYY-MM-DD.",
                )
            if pickup_date < _local_now().date():
                raise HTTPException(
                    status_code=400,
                    detail="Pickup date cannot be in the past.",
                )

        cursor.execute(
            """
            SELECT id FROM public.cash_advance_requests
            WHERE employee_id = %s AND status = 'pending'
            LIMIT 1
            """,
            (payroll_employee_id,),
        )
        if cursor.fetchone():
            raise HTTPException(
                status_code=409,
                detail="You already have a pending cash advance request. Wait for the administrator's decision.",
            )

        cursor.execute(
            """
            INSERT INTO public.cash_advance_requests (employee_id, amount, reason, pickup_date)
            VALUES (%s, %s, %s, %s)
            RETURNING id, amount, reason, pickup_date, status, created_at
            """,
            (payroll_employee_id, amount, reason, pickup_date),
        )
        row = cursor.fetchone()
        db.commit()
        _notify_payroll_panel("cash_advance_request", {
            "employee_id": payroll_employee_id,
            "name": emp.get("name") or "",
            "amount": round(float(row["amount"]), 2),
            "pickup_date": str(row.get("pickup_date")) if row.get("pickup_date") else None,
        })
        return {
            "ok": True,
            "request": {
                "id": row["id"],
                "amount": round(float(row["amount"]), 2),
                "reason": row.get("reason") or "",
                "pickup_date": str(row.get("pickup_date")) if row.get("pickup_date") else None,
                "status": row["status"],
                "created_at": str(row["created_at"]),
            },
        }
    finally:
        db.close()


@app.get("/employee/cash-advance-requests")
def employee_cash_advance_requests(
    employee: str = Depends(verify_employee_token),
):
    """The employee's own cash advance request history."""
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT payroll_employee_id
            FROM employees
            WHERE employee_id = %s AND status = 'approved'
            LIMIT 1
            """,
            (employee,),
        )
        emp = cursor.fetchone()
        payroll_employee_id = (emp or {}).get("payroll_employee_id")
        if not payroll_employee_id:
            return {"requests": []}
        cursor.execute(
            """
            SELECT id, amount, reason, pickup_date, status, created_at, reviewed_at
            FROM public.cash_advance_requests
            WHERE employee_id = %s
            ORDER BY created_at DESC
            LIMIT 20
            """,
            (payroll_employee_id,),
        )
        rows = cursor.fetchall()
        return {"requests": [
            {
                "id": row["id"],
                "amount": round(float(row["amount"]), 2),
                "reason": row.get("reason") or "",
                "pickup_date": str(row["pickup_date"]) if row.get("pickup_date") else None,
                "status": row["status"],
                "created_at": str(row["created_at"]),
                "reviewed_at": str(row["reviewed_at"]) if row.get("reviewed_at") else None,
            }
            for row in rows
        ]}
    finally:
        db.close()


@app.post("/employee/cash-advance-request/{request_id}/cancel")
def employee_cash_advance_request_cancel(
    request_id: int,
    employee: str = Depends(verify_employee_token),
):
    """Cancel (delete) the employee's own pending cash advance request."""
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT employee_id, name, payroll_employee_id
            FROM employees
            WHERE employee_id = %s AND status = 'approved'
            LIMIT 1
            """,
            (employee,),
        )
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=403, detail="Employee access required")
        payroll_employee_id = emp.get("payroll_employee_id")
        if not payroll_employee_id:
            raise HTTPException(
                status_code=409,
                detail="Your account is not linked to payroll yet. Please ask the administrator to approve you.",
            )

        cursor.execute(
            """
            SELECT id, status FROM public.cash_advance_requests
            WHERE id = %s AND employee_id = %s
            """,
            (request_id, payroll_employee_id),
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Cash advance request not found.")
        if row["status"] != "pending":
            raise HTTPException(
                status_code=409,
                detail="Only pending requests can be cancelled.",
            )

        cursor.execute(
            """
            DELETE FROM public.cash_advance_requests
            WHERE id = %s AND employee_id = %s AND status = 'pending'
            """,
            (request_id, payroll_employee_id),
        )
        db.commit()
        return {"ok": True}
    finally:
        db.close()


# â”€â”€â”€ ADMIN: ARCHIVE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@app.post("/admin/archive/{id}")
def archive_employee(id: int, admin: str = Depends(verify_admin_token)):
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute("SELECT name, email FROM employees WHERE id = %s", (id,))
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=404, detail="Employee not found")

        cursor.execute(
            "UPDATE employees SET status = 'archived' WHERE id = %s",
            (id,)
        )
        _audit(cursor, admin, "employee_archived", "employee", str(id), {"name": emp.get("name")})
        db.commit()
        return {"message": "Employee archived"}
    finally:
        db.close()

# â”€â”€â”€ ADMIN: REJECTED â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@app.get("/admin/rejected")
def get_rejected(page: int = 1, limit: int = 50, search: str = "", admin: str = Depends(verify_admin_token)):
    safe_page = max(1, page)
    safe_limit = max(1, min(limit, 100))
    offset = (safe_page - 1) * safe_limit
    clean_search = search.strip()
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        where_sql = "status = 'rejected'"
        params: list[object] = []
        if clean_search:
            where_sql += " AND (name ILIKE %s OR employee_id ILIKE %s OR email ILIKE %s OR phone ILIKE %s OR admin_notes ILIKE %s)"
            term = f"%{clean_search}%"
            params.extend([term, term, term, term, term])
        cursor.execute(f"SELECT COUNT(*) AS count FROM employees WHERE {where_sql}", tuple(params))
        total = int(cursor.fetchone()["count"])
        cursor.execute(f"""
            SELECT id, employee_id, name, email, phone, face_image, face_left, face_right,
                   status, admin_notes, registered_at, approved_at
            FROM employees
            WHERE {where_sql}
            ORDER BY registered_at DESC
            LIMIT %s OFFSET %s
        """, (*params, safe_limit, offset))
        return {"rows": cursor.fetchall(), "page": safe_page, "limit": safe_limit, "total": total}
    finally:
        db.close()

# â”€â”€â”€ ADMIN: RESTORE REJECTED â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@app.post("/admin/restore/{id}")
def restore_employee(id: int, admin: str = Depends(verify_admin_token)):
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute("SELECT name, email FROM employees WHERE id = %s", (id,))
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=404, detail="Employee not found")

        cursor.execute(
            "UPDATE employees SET status = 'pending', admin_notes = NULL WHERE id = %s",
            (id,)
        )
        _audit(cursor, admin, "employee_restored", "employee", str(id), {"name": emp.get("name")})
        db.commit()
        return {"message": "Employee restored to pending"}
    finally:
        db.close()

# â”€â”€â”€ ADMIN: UPDATE EMPLOYEE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@app.patch("/admin/employees/{id}")
def update_employee(
    id: int,
    name: str = Form(""),
    email: str = Form(""),
    phone: str = Form(""),
    notes: str = Form(""),
    admin: str = Depends(verify_admin_token),
):
    clean_name = name.strip()
    clean_email = email.strip()
    clean_phone = phone.strip()
    clean_notes = notes.strip()

    if not clean_name:
        raise HTTPException(status_code=400, detail="Name is required.")
    if not clean_email:
        raise HTTPException(status_code=400, detail="Email is required.")
    if not clean_phone:
        raise HTTPException(status_code=400, detail="Phone number is required.")

    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            "SELECT id, name, email, phone, admin_notes FROM employees WHERE id = %s",
            (id,),
        )
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=404, detail="Employee not found")

        normalized_email = _normalize_email(clean_email)
        normalized_phone = _phone_candidates(clean_phone)

        cursor.execute(
            """
            SELECT id, email, phone
            FROM employees
            WHERE id != %s
            """,
            (id,),
        )
        others = cursor.fetchall()
        for row in others:
            row_email = _normalize_email(row.get("email") or "")
            row_phone = _phone_candidates(row.get("phone") or "")
            if row_email and row_email == normalized_email:
                raise HTTPException(status_code=409, detail="Email already registered.")
            if row_phone and normalized_phone.intersection(row_phone):
                raise HTTPException(status_code=409, detail="Phone number already registered.")

        cursor.execute(
            """
            UPDATE employees
            SET name = %s,
                email = %s,
                phone = %s,
                admin_notes = %s
            WHERE id = %s
            """,
            (clean_name, clean_email, clean_phone, clean_notes or None, id),
        )
        _audit(cursor, admin, "employee_updated", "employee", str(id), {
            "old": {
                "name": emp.get("name"),
                "email": emp.get("email"),
                "phone": emp.get("phone"),
                "admin_notes": emp.get("admin_notes"),
            },
            "new": {
                "name": clean_name,
                "email": clean_email,
                "phone": clean_phone,
                "admin_notes": clean_notes or None,
            },
        })
        db.commit()
        return {"message": "Employee updated successfully"}
    finally:
        db.close()

# â”€â”€â”€ ADMIN: APPROVE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@app.post("/admin/approve/{id}")
def approve_employee(id: int, background_tasks: BackgroundTasks, admin: str = Depends(verify_admin_token)):
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        new_emp_id = generate_employee_id(cursor)
        
        cursor.execute("SELECT name, email FROM employees WHERE id = %s", (id,))
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=404, detail="Employee not found")

        cursor.execute("""
            UPDATE employees
            SET status = 'approved', employee_id = %s, approved_at = NOW(), admin_notes = NULL
            WHERE id = %s
        """, (new_emp_id, id))
        _audit(cursor, admin, "employee_approved", "employee", new_emp_id, {"name": emp.get("name")})
        _send_fcm_to_employee(
            cursor,
            new_emp_id,
            "Account approved",
            "Your attendance account has been approved. You can now log in.",
            {
                "type": "account_approved",
                "employee_id": new_emp_id,
            },
        )
        db.commit()
        background_tasks.add_task(
            _notify_employee_approval,
            emp.get("email") or "",
            emp.get("name") or "Employee",
            new_emp_id,
        )

        return {
            "message": "Employee approved",
            "employee_id": new_emp_id,
            "name": emp["name"] if emp else ""
        }
    finally:
        db.close()

# â”€â”€â”€ ADMIN: REJECT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@app.post("/admin/reject/{id}")
def reject_employee(
    id: int,
    background_tasks: BackgroundTasks,
    notes: str = Form(""),
    admin: str = Depends(verify_admin_token),
):
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        
        cursor.execute("SELECT name, email FROM employees WHERE id = %s", (id,))
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=404, detail="Employee not found")

        cursor.execute(
            "UPDATE employees SET status = 'rejected', admin_notes = %s WHERE id = %s",
            (notes, id)
        )
        _audit(cursor, admin, "employee_rejected", "employee", str(id), {
            "name": emp.get("name"),
            "notes": notes.strip()[:300],
        })
        db.commit()
        background_tasks.add_task(
            _notify_employee_rejection,
            emp.get("email") or "",
            emp.get("name") or "Employee",
            notes,
        )

        return {"message": "Employee rejected"}
    finally:
        db.close()

# â”€â”€â”€ ADMIN: DELETE EMPLOYEE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@app.delete("/admin/employees/{id}")
def delete_employee(id: int, admin: str = Depends(verify_admin_token)):
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute("SELECT face_image, face_left, face_right, employee_id, name FROM employees WHERE id = %s", (id,))
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=404, detail="Employee not found")
        if emp["employee_id"]:
            cursor.execute("DELETE FROM attendance WHERE employee_id = %s", (emp["employee_id"],))
        cursor.execute("DELETE FROM employees WHERE id = %s", (id,))
        _audit(cursor, admin, "employee_deleted", "employee", str(id), {
            "employee_id": emp.get("employee_id"),
            "name": emp.get("name"),
        })
        db.commit()
        
        # Burahin lahat ng images (Front, Left, Right)
        for img_field in ["face_image", "face_left", "face_right"]:
            if emp.get(img_field):
                img_path = FACE_IMAGES_DIR / emp[img_field]
                if img_path.exists():
                    try:
                        img_path.unlink()
                    except OSError as exc:
                        logger.warning("Failed to delete image %s: %s", img_path, exc)
                    
        return {"message": "Employee deleted successfully"}
    finally:
        db.close()

# â”€â”€â”€ ADMIN: ATTENDANCE RAW â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@app.get("/admin/api/attendance")
@app.get("/admin/attendance")
def get_attendance(
    work_date: str = "",
    employee_id: str = "",
    search: str = "",
    page: int = 1,
    limit: int = 200,
    admin: str = Depends(verify_admin_token),
):
    clean_date = work_date.strip()
    clean_employee_id = employee_id.strip()
    parsed_date = None
    if clean_date:
        try:
            parsed_date = datetime.fromisoformat(clean_date).date()
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid work date.")
    safe_limit = max(1, min(limit, 500))
    safe_page = max(1, page)
    offset = (safe_page - 1) * safe_limit
    clean_search = search.strip()
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        where_parts = []
        params: list[object] = []
        if parsed_date:
            where_parts.append("DATE(a.timestamp) = %s")
            params.append(parsed_date)
        if clean_employee_id:
            where_parts.append("a.employee_id = %s")
            params.append(clean_employee_id)
        if clean_search:
            where_parts.append("(e.name ILIKE %s OR a.employee_id ILIKE %s)")
            term = f"%{clean_search}%"
            params.extend([term, term])
        where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
        cursor.execute(f"""
            SELECT COUNT(*) AS count
            FROM attendance a
            JOIN employees e ON a.employee_id = e.employee_id
            {where_sql}
        """, tuple(params))
        total = int(cursor.fetchone()["count"])
        cursor.execute(f"""
            SELECT a.id, a.employee_id, e.name, e.face_image, a.type, a.timestamp
            FROM attendance a
            JOIN employees e ON a.employee_id = e.employee_id
            {where_sql}
            ORDER BY a.timestamp DESC
            LIMIT %s OFFSET %s
        """, (*params, safe_limit, offset))
        rows = [{
            **row,
            "timestamp": str(row["timestamp"]) if row.get("timestamp") else None,
        } for row in cursor.fetchall()]
        return {"rows": rows, "page": safe_page, "limit": safe_limit, "total": total}
    finally:
        db.close()

@app.patch("/admin/attendance/{id}")
def update_attendance(
    id: int,
    att_type: str = Form(""),
    timestamp: str = Form(""),
    admin: str = Depends(verify_admin_token),
):
    clean_type = att_type.strip().lower()
    clean_timestamp = timestamp.strip()

    if clean_type != "time_out":
        raise HTTPException(status_code=400, detail="Only time out can be edited here.")
    if not clean_timestamp:
        raise HTTPException(status_code=400, detail="Timestamp is required.")

    try:
        parsed_timestamp = datetime.fromisoformat(clean_timestamp.replace("Z", ""))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid timestamp format.")

    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            "SELECT id, employee_id, timestamp FROM attendance WHERE id = %s",
            (id,),
        )
        record = cursor.fetchone()
        if not record:
            raise HTTPException(status_code=404, detail="Attendance record not found")

        original_timestamp = record["timestamp"]
        if not original_timestamp:
            raise HTTPException(status_code=404, detail="Attendance record not found")

        # Keep the original day fixed so edits only change the time component.
        if hasattr(original_timestamp, "date") and hasattr(parsed_timestamp, "time"):
            parsed_timestamp = datetime.combine(original_timestamp.date(), parsed_timestamp.time())
        _raise_if_payroll_locked(cursor, record["employee_id"], original_timestamp.date())

        cursor.execute(
            """
            UPDATE attendance
            SET type = %s,
                timestamp = %s
            WHERE id = %s
            """,
            (clean_type, parsed_timestamp, id),
        )
        _audit(cursor, admin, "attendance_updated", "attendance", str(id), {
            "employee_id": record["employee_id"],
            "old": {"timestamp": original_timestamp},
            "new": {"timestamp": parsed_timestamp},
        })
        _send_fcm_to_employee(
            cursor,
            record["employee_id"],
            "Attendance updated",
            f"Your time-out for {parsed_timestamp.strftime('%b %d')} was updated to {parsed_timestamp.strftime('%I:%M %p')}.",
            {
                "type": "attendance_updated",
                "employee_id": record["employee_id"],
                "attendance_id": str(id),
                "timestamp": parsed_timestamp.isoformat(),
            },
        )
        db.commit()
        return {"message": "Attendance updated successfully"}
    finally:
        db.close()

@app.delete("/admin/attendance/{id}")
def delete_attendance(id: int, admin: str = Depends(verify_admin_token)):
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            "SELECT id, employee_id, type, timestamp FROM attendance WHERE id = %s",
            (id,),
        )
        record = cursor.fetchone()
        if not record:
            raise HTTPException(status_code=404, detail="Attendance record not found")
        if str(record["type"]).lower() != "time_out":
            raise HTTPException(status_code=400, detail="Only time out records can be deleted here.")
        if record.get("timestamp"):
            _raise_if_payroll_locked(cursor, record["employee_id"], record["timestamp"].date())

        cursor.execute("DELETE FROM attendance WHERE id = %s", (id,))
        _audit(cursor, admin, "attendance_deleted", "attendance", str(id), {
            "employee_id": record["employee_id"],
            "timestamp": record.get("timestamp"),
        })
        timestamp = record.get("timestamp")
        date_label = timestamp.strftime("%b %d") if timestamp else "your record"
        _send_fcm_to_employee(
            cursor,
            record["employee_id"],
            "Attendance updated",
            f"Your time-out for {date_label} was removed by admin.",
            {
                "type": "attendance_deleted",
                "employee_id": record["employee_id"],
                "attendance_id": str(id),
            },
        )
        db.commit()
        return {"message": "Attendance record deleted successfully"}
    finally:
        db.close()

@app.post("/admin/attendance/out")
def add_time_out(
    employee_id: str = Form(""),
    timestamp: str = Form(""),
    admin: str = Depends(verify_admin_token),
):
    clean_employee_id = employee_id.strip()
    clean_timestamp = timestamp.strip()

    if not clean_employee_id:
        raise HTTPException(status_code=400, detail="Employee ID is required.")
    if not clean_timestamp:
        raise HTTPException(status_code=400, detail="Timestamp is required.")

    try:
        parsed_timestamp = datetime.fromisoformat(clean_timestamp.replace("Z", ""))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid timestamp format.")

    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        cursor.execute(
            "SELECT employee_id, name FROM employees WHERE employee_id = %s LIMIT 1",
            (clean_employee_id,),
        )
        emp = cursor.fetchone()
        if not emp:
            raise HTTPException(status_code=404, detail="Employee not found")
        _raise_if_payroll_locked(cursor, clean_employee_id, parsed_timestamp.date())

        cursor.execute(
            """
            SELECT id
            FROM attendance
            WHERE employee_id = %s
              AND type = 'time_out'
              AND DATE(timestamp) = DATE(%s)
            ORDER BY timestamp DESC
            LIMIT 1
            """,
            (clean_employee_id, parsed_timestamp),
        )
        existing = cursor.fetchone()

        if existing:
            cursor.execute(
                """
                UPDATE attendance
                SET timestamp = %s
                WHERE id = %s
                """,
                (parsed_timestamp, existing["id"]),
            )
        else:
            cursor.execute(
                """
                INSERT INTO attendance (employee_id, type, timestamp)
                VALUES (%s, 'time_out', %s)
                """,
                (clean_employee_id, parsed_timestamp),
            )
        _audit(cursor, admin, "time_out_saved", "attendance", clean_employee_id, {
            "mode": "updated_existing" if existing else "inserted",
            "timestamp": parsed_timestamp,
        })
        _send_fcm_to_employee(
            cursor,
            clean_employee_id,
            "Attendance updated",
            f"Your time-out for {parsed_timestamp.strftime('%b %d')} was set to {parsed_timestamp.strftime('%I:%M %p')}.",
            {
                "type": "attendance_updated",
                "employee_id": clean_employee_id,
                "timestamp": parsed_timestamp.isoformat(),
            },
        )
        db.commit()
        return {"message": "Time out saved successfully"}
    finally:
        db.close()

# â”€â”€â”€ ADMIN: ATTENDANCE GROUPED â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
@app.get("/admin/attendance/grouped")
def get_attendance_grouped(
    work_date: str = "",
    employee_id: str = "",
    search: str = "",
    page: int = 1,
    limit: int = 100,
    admin: str = Depends(verify_admin_token),
):
    clean_date = work_date.strip()
    clean_employee_id = employee_id.strip()
    parsed_date = None
    if clean_date:
        try:
            parsed_date = datetime.fromisoformat(clean_date).date()
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid work date.")
    safe_limit = max(1, min(limit, 500))
    safe_page = max(1, page)
    offset = (safe_page - 1) * safe_limit
    clean_search = search.strip()
    db = get_db()
    try:
        cursor = db.cursor(dictionary=True)
        where_parts = []
        params: list[object] = []
        if parsed_date:
            where_parts.append("DATE(a.timestamp) BETWEEN %s AND %s")
            params.extend([parsed_date - timedelta(days=1), parsed_date + timedelta(days=1)])
        if clean_employee_id:
            where_parts.append("a.employee_id = %s")
            params.append(clean_employee_id)
        if clean_search:
            where_parts.append("(e.name ILIKE %s OR a.employee_id ILIKE %s)")
            term = f"%{clean_search}%"
            params.extend([term, term])
        where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
        cursor.execute(f"""
            SELECT 
                a.employee_id, e.name, e.face_image, a.type, a.timestamp, a.id
            FROM attendance a
            JOIN employees e ON a.employee_id = e.employee_id
            {where_sql}
            ORDER BY a.employee_id ASC, a.timestamp ASC, a.id ASC
        """, tuple(params))
        logs = cursor.fetchall()

        grouped_logs = []
        for employee_id, employee_rows_iter in groupby(logs, key=lambda row: row["employee_id"]):
            employee_rows = list(employee_rows_iter)
            if not employee_rows:
                continue
            meta = employee_rows[0]
            for session in _pair_attendance_sessions(employee_rows):
                grouped_logs.append({
                    "employee_id": employee_id,
                    "name": meta["name"],
                    "face_image": meta["face_image"],
                    "work_date": str(session["work_date"]) if session["work_date"] else None,
                    "time_in": str(session["time_in"]) if session["time_in"] else None,
                    "time_out": str(session["time_out"]) if session["time_out"] else None,
                    "time_out_date": str(session["time_out_date"]) if session["time_out_date"] else None,
                    "duration": session["duration"],
                })

        grouped_logs.sort(key=lambda row: (row["name"] or "", row["time_in"] or row["time_out"] or ""), reverse=False)
        grouped_logs.sort(key=lambda row: row["time_in"] or row["time_out"] or "", reverse=True)
        grouped_logs.sort(key=lambda row: row["work_date"] or "", reverse=True)

        if parsed_date:
            grouped_logs = [
                row for row in grouped_logs
                if row["work_date"] == parsed_date.isoformat()
                or row["time_out_date"] == parsed_date.isoformat()
            ]

        total = len(grouped_logs)
        return {"rows": grouped_logs[offset:offset + safe_limit], "page": safe_page, "limit": safe_limit, "total": total}
    finally:
        db.close()
