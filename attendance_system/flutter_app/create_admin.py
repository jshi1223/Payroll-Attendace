import os
import sys
from pathlib import Path

import psycopg2
from passlib.context import CryptContext

sys.path.append(str(Path(__file__).resolve().parents[1] / "backend"))
from db import DB_CONFIG  # noqa: E402


password = os.getenv("ADMIN_NEW_PASSWORD", "").strip()
if not password:
    print("Error: ADMIN_NEW_PASSWORD environment variable is required.")
    sys.exit(1)

pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
hashed = pwd.hash(password)

db = psycopg2.connect(DB_CONFIG) if isinstance(DB_CONFIG, str) else psycopg2.connect(**DB_CONFIG)
cursor = db.cursor()
cursor.execute("SELECT COUNT(*) FROM admins")
if cursor.fetchone()[0] == 0:
    cursor.execute(
        "INSERT INTO admins (username, password, email) VALUES (%s, %s, %s)",
        ("admin", hashed, "admin@example.com"),
    )
    db.commit()
    print("Admin created!")
else:
    print("Admin already exists")

db.close()
