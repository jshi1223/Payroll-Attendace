import time

import psycopg2
from passlib.context import CryptContext
from psycopg2 import OperationalError
from psycopg2 import sql

from db import DB_CONFIG, DB_SCHEMA, DB_SSLMODE


pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _get_env(name: str, default: str) -> str:
    import os

    value = os.getenv(name, default).strip()
    return value or default


def _connect_with_retry(max_attempts: int = 30, delay_seconds: float = 2.0):
    last_error: Exception | None = None
    for _ in range(max_attempts):
        try:
            if isinstance(DB_CONFIG, str):
                kwargs = {"sslmode": DB_SSLMODE} if DB_SSLMODE else {}
                return psycopg2.connect(DB_CONFIG, **kwargs)
            return psycopg2.connect(**DB_CONFIG)
        except OperationalError as exc:
            last_error = exc
            time.sleep(delay_seconds)
    raise RuntimeError(f"Could not connect to PostgreSQL after retries: {last_error}")


def _ensure_tables(cursor) -> None:
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS admins (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            email VARCHAR(255) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS employees (
            id SERIAL PRIMARY KEY,
            employee_id VARCHAR(50) NULL UNIQUE,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255) NULL,
            phone VARCHAR(50) NULL,
            password_hash VARCHAR(255) NULL,
            session_key VARCHAR(64) NOT NULL DEFAULT '',
            device_id VARCHAR(64) NOT NULL DEFAULT '',
            daily_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
            face_image VARCHAR(255) NULL,
            face_left VARCHAR(255) NULL,
            face_right VARCHAR(255) NULL,
            face_encoding TEXT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            government_id VARCHAR(50) NOT NULL DEFAULT '',
            admin_notes TEXT NULL,
            registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            approved_at TIMESTAMP NULL
        )
        """
    )
    cursor.execute("ALTER TABLE employees ADD COLUMN IF NOT EXISTS government_id VARCHAR(50) NOT NULL DEFAULT ''")
    cursor.execute("ALTER TABLE employees ADD COLUMN IF NOT EXISTS session_key VARCHAR(64) NOT NULL DEFAULT ''")
    cursor.execute("ALTER TABLE employees ADD COLUMN IF NOT EXISTS device_id VARCHAR(64) NOT NULL DEFAULT ''")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_employees_status ON employees (status)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_employees_email ON employees (email)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_employees_phone ON employees (phone)")

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS attendance (
            id SERIAL PRIMARY KEY,
            employee_id VARCHAR(50) NOT NULL,
            type VARCHAR(20) NOT NULL,
            rate_snapshot DECIMAL(10,2) NULL,
            timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_attendance_employee
                FOREIGN KEY (employee_id) REFERENCES employees(employee_id)
                ON DELETE CASCADE
        )
        """
    )
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_attendance_employee_id ON attendance (employee_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_attendance_timestamp ON attendance (timestamp)")

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS admin_audit_logs (
            id SERIAL PRIMARY KEY,
            admin_user VARCHAR(100) NULL,
            action VARCHAR(100) NOT NULL,
            target_type VARCHAR(50) NOT NULL,
            target_id VARCHAR(100) NULL,
            details TEXT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_created_at ON admin_audit_logs (created_at)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_action ON admin_audit_logs (action)")

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS time_in_reminders (
            id SERIAL PRIMARY KEY,
            employee_id VARCHAR(50) NOT NULL,
            remind_date DATE NOT NULL,
            sent_count INT NOT NULL DEFAULT 1,
            last_sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uq_time_in_reminder_date UNIQUE (employee_id, remind_date)
        )
        """
    )
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_time_in_reminders_employee_date ON time_in_reminders (employee_id, remind_date)")

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS weekly_digests (
            id SERIAL PRIMARY KEY,
            employee_id VARCHAR(50) NOT NULL,
            week_start DATE NOT NULL,
            sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT uq_weekly_digest UNIQUE (employee_id, week_start)
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS employee_password_reset_requests (
            id SERIAL PRIMARY KEY,
            employee_id VARCHAR(50) NULL,
            email VARCHAR(255) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            reset_code VARCHAR(6) NULL,
            reset_code_expires_at TIMESTAMP NULL,
            requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            processed_at TIMESTAMP NULL DEFAULT NULL,
            admin_notes TEXT NULL,
            CONSTRAINT fk_employee_reset_employee
                FOREIGN KEY (employee_id) REFERENCES employees(employee_id)
                ON DELETE SET NULL
        )
        """
    )
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_employee_reset_employee_id ON employee_password_reset_requests (employee_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_employee_reset_email ON employee_password_reset_requests (email)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_employee_reset_code ON employee_password_reset_requests (reset_code)")

    cursor.execute(
        """
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
        """
    )
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_employee_device_tokens_employee_id ON employee_device_tokens (employee_id)")

    cursor.execute(
        """
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
        """
    )
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_attendance_reminders_employee_id ON attendance_reminders (employee_id)")

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS admin_reset_requests (
            id SERIAL PRIMARY KEY,
            admin_id INT NULL,
            admin_username VARCHAR(50) NULL,
            admin_email VARCHAR(255) NULL,
            request_type VARCHAR(20) NOT NULL,
            reset_code VARCHAR(6) NULL,
            reset_code_expires_at TIMESTAMP NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_admin_reset_admin
                FOREIGN KEY (admin_id) REFERENCES admins(id)
                ON DELETE CASCADE
        )
        """
    )
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_admin_reset_admin_id ON admin_reset_requests (admin_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_admin_reset_username ON admin_reset_requests (admin_username)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_admin_reset_email ON admin_reset_requests (admin_email)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_admin_reset_code ON admin_reset_requests (reset_code)")

    cursor.execute(
        """
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
        """
    )
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_blocked_until ON auth_rate_limits (blocked_until)")


def _seed_default_admin(cursor) -> None:
    cursor.execute("SELECT COUNT(*) FROM admins")
    row = cursor.fetchone()
    if row and row[0] > 0:
        return

    username = _get_env("DEFAULT_ADMIN_USERNAME", "admin")
    password = _get_env("DEFAULT_ADMIN_PASSWORD", "")
    email = _get_env("DEFAULT_ADMIN_EMAIL", "")
    if not password:
        print("Skip seeding default admin: DEFAULT_ADMIN_PASSWORD is not set.")
        return
    hashed = pwd_context.hash(password)

    cursor.execute(
        "INSERT INTO admins (username, password, email) VALUES (%s, %s, %s)",
        (username, hashed, email),
    )


def main() -> None:
    db = _connect_with_retry()
    try:
        cursor = db.cursor()
        cursor.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(sql.Identifier(DB_SCHEMA)))
        cursor.execute(sql.SQL("SET search_path TO {}, public").format(sql.Identifier(DB_SCHEMA)))
        _ensure_tables(cursor)
        _seed_default_admin(cursor)
        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
