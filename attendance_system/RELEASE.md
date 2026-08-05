# Release Workflow

Use separate release files for the app and admin.

## App Release

Use `app_release.json`.

### What to update

- `api_base_url`
- `flutter_base_version`

### How to release

1. Edit `app_release.json`.
2. Run `scripts/build-app-release.ps1`.
3. Build and test the Flutter app.
4. Tag the release in git if you want a permanent history marker, for example `app-v1.0.1`.

## Admin Release

Use `admin_release.json`.

### What to update

- `admin_panel_version`
- `admin_asset_version`

### How to release

1. Edit `admin_release.json`.
2. Restart or redeploy the backend/admin service.
3. Optionally tag the release in git, for example `admin-v1.0.1`.

## Notes

- The app version is generated at build time from the current time, so every release build gets a new build number.
- The backend reads admin version values from `admin_release.json` at startup.
