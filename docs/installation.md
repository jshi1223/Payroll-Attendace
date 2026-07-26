# Installation Guide

Version: 1.1 | Last Updated: July 2026

## Prerequisites

- Node.js 18+ (https://nodejs.org)
- PostgreSQL 14+ (https://postgresql.org)
- npm 9+ (comes with Node.js)
- Git (optional, for version control)

## Quick Start (Development)

### 1. Clone or Copy Project Files

```bash
git clone <repository-url>
cd payroll-system
```

Or simply copy the project files to your desired location.

### 2. Create PostgreSQL Database

Open a PostgreSQL client (psql, pgAdmin, etc.) and create the database:

```sql
CREATE DATABASE payroll_attendance;
```

### 3. Configure Environment

Copy the environment template and edit it:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
DATABASE_URL=postgresql://username:password@localhost:5432/payroll_attendance
SESSION_SECRET=your-strong-random-secret-here-minimum-32-chars
BOOTSTRAP_USERNAME=admin
BOOTSTRAP_PASSWORD=your-secure-admin-password
BOOTSTRAP_ROLE=admin
PORT=3001
```

### 4. Install Dependencies

```bash
npm install
```

### 5. Start the Server

```bash
npm start
```

The database schema initializes automatically on first run.
The bootstrap admin user is created from .env variables.

### 6. Open the Application

Navigate to: http://localhost:3001

Login with the credentials set in BOOTSTRAP_USERNAME and BOOTSTRAP_PASSWORD.

## Docker Deployment

### Prerequisites

- Docker Engine 24+
- Docker Compose V2

### Setup

1. Create a `.env` file in the project root:

```env
POSTGRES_DB=payroll_attendance
POSTGRES_USER=payroll_admin
POSTGRES_PASSWORD=your-db-password
SESSION_SECRET=your-random-secret-here
BOOTSTRAP_USERNAME=admin
BOOTSTRAP_PASSWORD=your-admin-password
BOOTSTRAP_ROLE=admin
```

2. Build and start:

```bash
docker compose up -d --build
```

3. Access the app: http://localhost:3001

### Stopping Docker

```bash
docker compose down
```

To remove volumes (deletes data):
```bash
docker compose down -v
```

## Windows Deployment (Production)

Run the batch deployment script:

```bash
deploy.bat
```

This script:
- Checks for Node.js and PostgreSQL
- Creates the database if not exists
- Installs dependencies
- Configures environment
- Starts the server

## Linux/NAS Deployment

Run the shell deployment script:

```bash
chmod +x deploy.sh
./deploy.sh
```

## Electron Desktop App

### Building

```bash
npm run electron:build
```

This produces a portable Windows executable in the `dist/` folder.

### Running in Development

```bash
npm run electron
```

## Configuration Reference

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| DATABASE_URL | Yes | - | PostgreSQL connection string |
| SESSION_SECRET | Yes | - | Random string for session encryption |
| PORT | No | 3001 | HTTP server port |
| BOOTSTRAP_USERNAME | No | - | Initial admin username |
| BOOTSTRAP_PASSWORD | No | - | Initial admin password |
| BOOTSTRAP_ROLE | No | admin | Initial admin role |
| PG_DUMP_PATH | No | auto-detect | Path to pg_dump executable |
| NODE_ENV | No | development | Environment mode |

### Database URL Format

```
postgresql://user:password@host:port/database
```

Examples:
- Local: postgresql://postgres:secret@localhost:5432/payroll_attendance
- Docker: postgresql://payroll_admin:pass@db:5432/payroll_attendance

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Server won't start | Check .env for DATABASE_URL and SESSION_SECRET |
| Database connection fails | Ensure PostgreSQL is running and credentials are correct |
| Port conflict | Change PORT in .env |
| Bootstrap user not created | Ensure all BOOTSTRAP_* vars are set in .env |
| Docker build fails | Check Docker and Docker Compose versions |
| Photo upload fails | Check public/uploads directory permissions |
| Backup fails | Set PG_DUMP_PATH in .env to your pg_dump location |

---

*End of Installation Guide*
