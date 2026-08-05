import sys
from pathlib import Path

import psycopg2

sys.path.append(str(Path(__file__).resolve().parents[1] / "backend"))
from db import DB_CONFIG  # noqa: E402


db = psycopg2.connect(DB_CONFIG) if isinstance(DB_CONFIG, str) else psycopg2.connect(**DB_CONFIG)
cursor = db.cursor()
cursor.execute("SELECT COUNT(*) FROM admins")
if cursor.fetchone()[0] == 0:
    cursor.execute(
        """
        INSERT INTO admins (username, password, email)
        VALUES ('admin', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5GyYzS.xJ5W3u', 'admin@example.com')
        """
    )
    db.commit()
    print("Admin created!")
else:
    print("Admin already exists")

db.close()
