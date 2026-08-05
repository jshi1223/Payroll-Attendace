import os
import sys

from passlib.context import CryptContext
import psycopg2

from db import DB_CONFIG


TARGET_USERNAME = os.getenv("ADMIN_RESET_USERNAME", "admin")
NEW_PASSWORD = os.getenv("ADMIN_NEW_PASSWORD", "").strip()
NEW_EMAIL = os.getenv("ADMIN_NEW_EMAIL", "vaness098a@gmail.com")

if not NEW_PASSWORD:
    print("Error: ADMIN_NEW_PASSWORD environment variable is required.")
    sys.exit(1)

pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
hashed = pwd.hash(NEW_PASSWORD)

db = psycopg2.connect(DB_CONFIG) if isinstance(DB_CONFIG, str) else psycopg2.connect(**DB_CONFIG)
cursor = db.cursor()
cursor.execute(
    "UPDATE admins SET password = %s, email = %s WHERE username = %s",
    (hashed, NEW_EMAIL, TARGET_USERNAME),
)
db.commit()

if cursor.rowcount == 0:
    print(f'Error: Walang nahanap na record para sa username na "{TARGET_USERNAME}". Siguraduhin na tama ang username.')
else:
    print(f'Password at Email para sa admin user na "{TARGET_USERNAME}" ay matagumpay na na-update!')

db.close()
