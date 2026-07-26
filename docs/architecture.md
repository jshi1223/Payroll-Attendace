# System Architecture

Version: 1.1 | Last Updated: July 2026

## Overview

The KVSK Payroll System follows a client-server architecture with a PostgreSQL database backend. The application is built as a Single Page Application (SPA) with a RESTful API backend.

## Architecture Diagram

```
+-------------------+       +-------------------+       +------------------+
|   Client (SPA)    |       |   Express Server   |       |   PostgreSQL DB  |
|   Vanilla JS      | HTTP  |   Node.js 18+      | SQL   |   16 Alpine      |
|   Browser-based   |<----->|   Port 3001        |<----->|   Port 5432      |
+-------------------+       +-------------------+       +------------------+
        |                           |                           |
        | localStorage              | Sessions                  |
        | Dark Mode, UI State       | user_sessions table       |
        +---------------------------+---------------------------+
```

## Tech Stack

### Backend

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Runtime | Node.js 18+ | JavaScript runtime |
| Framework | Express 5 | HTTP server and routing |
| Database Driver | pg (node-postgres) | PostgreSQL client |
| Session Store | connect-pg-simple | Server-side sessions in DB |
| Password Hashing | bcryptjs | Secure password storage |
| File Upload | multer | Employee photo uploads |
| Security | helmet | HTTP security headers |
| Rate Limiting | express-rate-limit | API rate protection |
| Environment | dotenv | Configuration management |

### Frontend

| Component | Technology | Purpose |
|-----------|-----------|---------|
| UI Framework | Vanilla JavaScript | No framework overhead |
| Styling | CSS Custom Properties | Dark/light mode theming |
| State Management | Custom state.js | Centralized app state |
| Routing | Client-side SPA | View switching without reload |
| Icons | Unicode/Emoji | Lightweight icon system |

### Desktop

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Desktop Wrapper | Electron | Native Windows app |
| Builder | electron-builder | Portable .exe packaging |

### DevOps

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Containerization | Docker + Compose | Easy deployment |
| Database | PostgreSQL 16 Alpine | Production database |
| Backup | pg_dump | Automated backups |

## Application Flow

### Request Lifecycle

1. Client makes HTTP request to Express server
2. Request passes through middleware chain:
   - Helmet (security headers)
   - JSON body parser
   - Session middleware
   - Static file serving
   - Request logging
   - CSRF protection (for mutations)
   - Rate limiter
   - Route handler
3. Route handler processes request with database queries
4. Response returned as JSON to client
5. Client updates UI based on response

### Authentication Flow

1. User submits credentials via login form
2. Server validates against bcrypt hash in database
3. On success: Create session, generate CSRF token
4. On failure: Increment failed login counter, apply lockout if needed
5. Existing sessions for same user are destroyed (single-session enforcement)

### Payroll Computation Flow

1. Attendance records are fetched for the period (weekly or semi-monthly)
2. Gross salary = sum of daily rate snapshots for attended days
3. Cash advances in the period are added to bale balance
4. Previous unpaid balances and bale balances are carried forward
5. Extra payments (bonuses) are added to total earnings
6. Salary and bale payments are deducted from total due
7. Remaining balance carries forward to next period

## Directory Structure

```
Project Root/
+-- server.js              # Entry point, middleware setup, route mounting
+-- config/
|   +-- index.js           # Database pool, multer config, app constants
+-- db/
|   +-- schema.sql         # Database table definitions
|   +-- init.js            # Schema initialization and bootstrap
+-- middleware/
|   +-- auth.js            # Authentication and authorization middleware
|   +-- loginLimiter.js    # Progressive login lockout
|   +-- requestLogger.js   # HTTP request logging
+-- routes/
|   +-- auth.js            # Login/logout/session endpoints
|   +-- employees.js       # Employee CRUD
|   +-- attendance.js      # Attendance tracking
|   +-- payroll.js         # Payroll computation and payments
|   +-- cashAdvances.js    # Cash advance management
|   +-- extraPayments.js   # Bonus/adjustment management
|   +-- salaryPayments.js  # Salary payment recording
|   +-- balePayments.js    # Bale (debt) payment recording
|   +-- auditLogs.js       # Audit trail access
|   +-- backup.js          # Backup management
+-- utils/
|   +-- date.js            # Date utilities (Manila timezone)
|   +-- money.js           # Payroll calculation engine
|   +-- validation.js      # Input validation (gov IDs, phone)
|   +-- logger.js          # Logging system with rotation
|   +-- backup.js          # Database backup functions
+-- public/
|   +-- index.html         # SPA entry point
|   +-- app.js             # Main application shell
|   +-- api.js             # API client helper
|   +-- state.js           # Central state management
|   +-- views.js           # View renderers
|   +-- modals.js          # Modal dialogs
|   +-- utils.js           # Frontend utilities
|   +-- styles.css         # Global styles with theming
|   +-- components/
|   |   +-- searchable-select.js  # Custom dropdown component
|   +-- fonts/             # Inter and JetBrains Mono fonts
|   +-- uploads/           # Employee photo uploads
|   +-- vendor/            # Third-party libraries
+-- docs/                  # Documentation (this folder)
+-- backups/               # Database backups
+-- logs/                  # Server logs
+-- electron-main.js       # Electron desktop wrapper
+-- Dockerfile             # Docker image definition
+-- docker-compose.yml     # Docker service configuration
+-- .env.example           # Environment variable template
```

## Data Flow for Payroll

The payroll computation engine (utils/money.js) processes each employee's period data:

1. Previous bale balance is carried forward
2. Cash advances in current period are added to bale
3. Gross salary is computed from attendance rate snapshots
4. Extra payments are added to total earnings
5. Salary payments and bale payments are validated against balances
6. Remaining unpaid balance carries to next period
7. Payslip generation locks the period

## Key Design Decisions

1. **Vanilla JS Frontend**: No framework overhead; faster load times; full control
2. **Server-side Sessions**: More secure than JWT for internal business app
3. **Manila Timezone**: All date operations use Asia/Manila timezone
4. **Rate Snapshot**: Attendance logs store the employee's rate at time of logging
5. **Soft Delete**: Employees are archived (active=false) not permanently deleted
6. **Progressive Lockout**: Login lockout durations escalate with repeated failures
7. **Auto-schema Init**: Database schema initializes automatically on startup

---

*End of Architecture Document*
