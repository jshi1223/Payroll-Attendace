# Attendance System

An end-to-end attendance system built for face-based employee registration, attendance logging, and admin management.

## What It Does

- Face registration for new employees
- Face-based time in and time out
- Employee login and personal attendance history
- Admin approval flow for pending registrations
- Admin management for approved, rejected, and archived records
- Attendance log editing and deletion from the admin panel
- Duplicate/availability checks during registration
- Suspicious face-match auditing for manual review
- Password reset and username recovery flows
- Dockerized backend and PostgreSQL deployment

## Project Structure

- `flutter_app/` - Flutter mobile app for registration, attendance, and employee login
- `backend/` - FastAPI backend, database bootstrap, and API endpoints
- `admin_panel/` - Admin dashboard UI
- `docker-compose.yml` - Local backend + PostgreSQL stack
- `docker-compose.nas.yml` - NAS-friendly deployment stack

## Tech Stack

### Mobile App

- Flutter
- Dart
- `camera`
- `image_picker`
- `google_mlkit_face_detection`
- `http`
- `shared_preferences`
- `permission_handler`
- `path_provider`
- `path`

### Backend

- Python 3.11
- FastAPI
- Uvicorn
- PostgreSQL
- `psycopg2-binary`
- `face_recognition`
- OpenCV
- NumPy
- `python-multipart`
- JWT authentication
- Passlib bcrypt hashing
- CORS middleware

### Admin Panel

- HTML
- CSS
- Vanilla JavaScript

### Infrastructure

- Docker
- Docker Compose
- PowerShell helper scripts

## Main Features

### Flutter App

- Employee face registration
- Liveness/face capture flow
- Attendance capture for time in and time out
- Employee authentication
- Attendance history and logs
- Persistent base URL configuration

### Admin Dashboard

- Login and password recovery
- Pending employee approval
- Reject, restore, archive, and delete employee records
- View all employees and rejected records
- Attendance log editing
- CSV export
- Face audit and suspicious match review
- Notification badge for pending items

### Backend API

- `/register`
- `/timein`
- `/timeout`
- `/employee/login`
- `/employee/logs`
- `/admin/login`
- `/admin/pending`
- `/admin/employees`
- `/admin/attendance`
- `/admin/rejected`
- `/admin/face-audit/suspicious`

## Versioning

Versioning is split:

- App release versioning: `app_release.json`
- Admin release versioning: `admin_release.json`

For the Flutter APK release flow, use:

```powershell
.\scripts\build-app-release.ps1
```

That script generates the app build number at build time and passes the version into Flutter automatically.

## Security Notes

- Do not commit real secrets in `.env` files.
- Change default admin credentials after setup.
- Keep the backend and database accessible only to trusted devices or networks.
- Treat face images and attendance data as sensitive user data.
- `app_release.json` and `admin_release.json` are for versioning only, not for secrets.

## Quick Start

### Flutter App

```bash
cd flutter_app
flutter run --dart-define=API_BASE_URL=http://YOUR_BACKEND_IP:8000
```

### Backend + PostgreSQL

```bash
docker compose up --build
```

### NAS Deployment

```bash
docker compose -f docker-compose.nas.yml up --build -d
```

### Render + Supabase

This repo includes `render.yaml` for deploying the FastAPI backend to Render with Supabase PostgreSQL. In Render, set:

```env
DB_HOST=YOUR_SUPABASE_DB_HOST
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=YOUR_SUPABASE_PASSWORD
DB_NAME=postgres
DB_SSLMODE=require
```

Then point Flutter to the Render URL:

```bash
flutter run --dart-define=API_BASE_URL=https://YOUR_RENDER_APP.onrender.com
```

## Notes

- The backend serves the admin panel from the same API host.
- Hosted app instances use temporary local storage unless a persistent disk is attached. For Sevalla, create a disk mounted at `/app/backend/face_images`, then set `FACE_IMAGES_DIR=face_images` and `FACE_IMAGES_PERSISTENT=true`.
- If older face files are already missing after a redeploy, use Admin > Employees > Edit > Replace face photo to restore the employee photo and face matching data without deleting attendance records.
- Free push notifications use Firebase Cloud Messaging. Set backend `FCM_SERVICE_ACCOUNT_JSON`, then build Flutter with `FIREBASE_API_KEY`, `FIREBASE_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID`, and `FIREBASE_PROJECT_ID` dart defines.
- Time-out reminders are sent after 8 hours by default and repeat every 30 minutes while the employee still has an open time-in. Tune with `TIME_OUT_REMINDER_AFTER_MINUTES`, `TIME_OUT_REMINDER_REPEAT_MINUTES`, and `TIME_OUT_REMINDER_SCAN_SECONDS`.
- The app and admin versioning are intentionally separate.
- Update the base API URL in `app_release.json` when the backend host changes.
