import os
import re
from contextlib import contextmanager
from pathlib import Path

from psycopg2 import OperationalError, InterfaceError, pool
from psycopg2.extras import RealDictCursor
from psycopg2 import sql


def _load_env_file(env_path) -> None:
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _load_local_env() -> None:
    _load_env_file(Path(__file__).resolve().parent / ".env")
    _load_env_file(Path(__file__).resolve().parent.parent.parent / ".env")


_load_local_env()


def _get_env(name: str, default: str) -> str:
    value = os.getenv(name, default).strip()
    return value or default


DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
DB_CONFIG = DATABASE_URL or {
    "host": _get_env("DB_HOST", "localhost"),
    "user": _get_env("DB_USER", "attendance_user"),
    "password": os.getenv("DB_PASSWORD", ""),
    "dbname": _get_env("DB_NAME", "attendance_db"),
    "port": int(_get_env("DB_PORT", "5432")),
}

DB_SSLMODE = os.getenv("DB_SSLMODE", "").strip()
if DB_SSLMODE and isinstance(DB_CONFIG, dict):
    DB_CONFIG["sslmode"] = DB_SSLMODE

DB_SCHEMA = _get_env("DB_SCHEMA", "public")
if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", DB_SCHEMA):
    raise ValueError("DB_SCHEMA must be a valid PostgreSQL identifier.")


class PostgresConnection:
    def __init__(self, connection, connection_pool):
        self._connection = connection
        self._pool = connection_pool

    def cursor(self, dictionary: bool = False):
        if dictionary:
            return self._connection.cursor(cursor_factory=RealDictCursor)
        return self._connection.cursor()

    def commit(self):
        return self._connection.commit()

    def rollback(self):
        return self._connection.rollback()

    def close(self):
        try:
            self._pool.putconn(self._connection, close=bool(self._connection.closed))
        except Exception:
            pass


class PostgresPool:
    def __init__(self, minconn: int = 1, maxconn: int = 10):
        if isinstance(DB_CONFIG, str):
            kwargs = {"sslmode": DB_SSLMODE} if DB_SSLMODE else {}
            self._pool = pool.ThreadedConnectionPool(minconn, maxconn, dsn=DB_CONFIG, **kwargs)
        else:
            self._pool = pool.ThreadedConnectionPool(minconn, maxconn, **DB_CONFIG)

    def get_connection(self):
        last_error = None
        for _ in range(2):
            connection = self._pool.getconn()
            try:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT 1")
                    cursor.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(sql.Identifier(DB_SCHEMA)))
                    cursor.execute(sql.SQL("SET search_path TO {}, public").format(sql.Identifier(DB_SCHEMA)))
                return PostgresConnection(connection, self._pool)
            except (OperationalError, InterfaceError) as exc:
                last_error = exc
                try:
                    self._pool.putconn(connection, close=True)
                except Exception:
                    pass

        if last_error:
            raise last_error
        raise OperationalError("Unable to acquire database connection.")

    def close_all(self):
        self._pool.closeall()


db_pool: PostgresPool | None = None


def get_db():
    global db_pool
    if db_pool is None:
        db_pool = PostgresPool()
    try:
        return db_pool.get_connection()
    except (OperationalError, InterfaceError):
        try:
            db_pool.close_all()
        except Exception:
            pass
        db_pool = PostgresPool()
        return db_pool.get_connection()


def column_exists(cursor, table_name: str, column_name: str) -> bool:
    cursor.execute(
        """
        SELECT COUNT(*) AS cnt
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = %s
          AND column_name = %s
        """,
        (table_name, column_name),
    )
    row = cursor.fetchone()
    if isinstance(row, dict):
        return int(row["cnt"]) > 0
    return int(row[0]) > 0


@contextmanager
def managed_cursor(dictionary: bool = False):
    db = get_db()
    try:
        cursor = db.cursor(dictionary=dictionary)
        yield db, cursor
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
