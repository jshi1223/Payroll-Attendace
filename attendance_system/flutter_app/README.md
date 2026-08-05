# Attendance System Flutter App

This app connects to the FastAPI backend for face registration and attendance marking.

## Run

```bash
flutter run --dart-define=API_BASE_URL=http://192.168.1.45:8000
```

## Branding

- Shared logo asset: `assets/brand/kvsk_cctv_it_solutions.jpg`
- Web branding and favicon are configured in `web/index.html`

## Notes

- If the backend IP changes, update `API_BASE_URL` when running the app.
- The admin web panel also supports `?baseUrl=http://YOUR_IP:8000`.
