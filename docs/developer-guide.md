# Developer Guide

Version: 1.1 | Last Updated: July 2026

## Development Setup

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- npm 9+
- Git

### Initial Setup

1. Clone the repository
2. Copy .env.example to .env and configure
3. Create the PostgreSQL database
4. Run npm install
5. Run npm start (schema initializes automatically)

### Development Mode

For automatic server restart on file changes:

```bash
npm run dev
```

This uses Node's built-in --watch flag (Node 18+).

---

## Project Structure

```
Project Root/
+-- server.js                    # Express server entry point
+-- config/index.js              # DB pool, multer, constants
+-- db/
|   +-- schema.sql               # Database DDL
|   +-- init.js                  # Schema init + bootstrap user
+-- middleware/
|   +-- auth.js                  # requireAuth, requireAdmin, logAudit
|   +-- loginLimiter.js          # Progressive login lockout
|   +-- requestLogger.js          # HTTP request logging
+-- routes/                      # API route handlers
+-- utils/                       # Utility functions
+-- public/                      # Frontend SPA
+-- docs/                        # Documentation
+-- backups/                     # DB backups (auto-created)
+-- logs/                        # Server logs (auto-created)
```

---

## Backend Architecture

### Middleware Stack (in order)

1. helmet - Security headers
2. express.json - JSON body parsing
3. express.urlencoded - URL-encoded body parsing
4. express-session (connect-pg-simple) - Session management
5. express.static - Static file serving
6. requestLogger - HTTP request logging
7. csrfProtection - CSRF token validation
8. rateLimit - Global rate limiting
9. writeLimiter - Stricter rate limiting for mutation endpoints
10. Route handlers

### Key Design Patterns

**Route Handlers**: Each route file exports an Express Router with middleware chains.
Example: router.get('/', requireAuth, async (req, res) => { ... });

**Middleware**: Custom auth middleware in middleware/auth.js:
- requireAuth: Returns 401 if no session
- requireAdmin: Returns 403 if not admin role
- logAudit: Asynchronously logs actions to audit_logs table

**Error Handling**: Routes use try/catch with centralized error logging via utils/logger.js.

---

## Frontend Architecture

### SPA Structure

The frontend is a Single Page Application built with Vanilla JavaScript:

- **app.js**: Main shell, skeleton loading, session timer, view routing
- **api.js**: API client with CSRF token management
- **state.js**: Central state object with UI state persistence
- **views.js**: View renderers for each page
- **modals.js**: Modal dialog handlers
- **utils.js**: Date/time formatting, payroll calculations

### State Management

The state object (state.js) holds all application state:
- User session (user, loggedInAt, sessionTTL)
- Current view (view, week, payrollWeek)
- Data cache (employees, payroll, attendance, etc.)
- UI state (sidebarCollapsed, search terms, pagination)
- Modal state (editingEmployee, paymentModal, etc.)

State is persisted to localStorage on changes and restored on page load.

### API Client

The api() function in api.js:
- Fetches CSRF token on login
- Automatically includes CSRF token in mutation headers
- Handles 401 responses by redirecting to login
- Returns parsed JSON or throws on error

### Theming

Dark mode is implemented with CSS custom properties:
- :root defines light theme colors
- .dark-mode class overrides custom properties
- Preference stored in localStorage
- Login screen always stays in light mode

---

## Payroll Calculation Engine

The payroll calculation logic is in utils/money.js.

### calculatePayrollWeekState()

This function computes all payroll fields for an employee in a period:

Input:
- previousBaleBalance: Outstanding debt from prior periods
- previousUnpaidBalance: Unpaid salary from prior periods
- salary: Gross salary for this period
- cashAdvance: New cash advances in this period
- salaryPaidAmount: Amount already paid
- deductBale: Whether to deduct bale from earnings
- balePaymentAmount: Debt payments made
- extraPaymentAmount: Bonus/adjustment payments

Output:
- totalBale: previousBaleBalance + cashAdvance
- baleDeduction: Deducted from earnings if deductBale is true
- remainingBaleBalance: Remaining debt after payments
- takeHome: Available earnings after deductions
- balance: Remaining unpaid amount
- paymentLimit: Maximum allowed payment

### Carryover Logic

Payroll carryovers are computed by getPayrollCarryoversBefore() in routes/payroll.js:
- Iterates through all prior periods
- Computes running balance of unpaid salary and bale
- Returns current baleBalance, unpaidBalance, and unpaidWeeks history

---

## Date Utilities

Located in utils/date.js, all date functions operate in Asia/Manila timezone:

| Function | Description |
|----------|-------------|
| todayInManila() | Get current date in Manila timezone |
| payrollWeekStartOf() | Get Monday of the week for a date |
| addDays() | Add/subtract days from a date |
| semiMonthStart() | Start of semi-monthly period |
| semiMonthEnd() | End of semi-monthly period (+13 days) |
| getPeriodRange() | Get start/end based on period type |
| workingDaysInWeek() | Count working days up to today |

---

## Validation

Located in utils/validation.js:

- **Employee Input Validation**: Name required, phone must be 11 digits, rate must be >= 0
- **Government ID Validation**: Pattern matching for SSS, PhilHealth, Pag-IBIG, and TIN formats
- **Payment Validation**: Balance checking via assertPaymentWithinBalance() in payroll route

---

## Logging System

Located in utils/logger.js:

- Logs to logs/server.log with auto-rotation
- Maximum log size: 5MB before rotation
- Keeps last 5 rotated logs
- Log format: [timestamp] [LEVEL] message | {json details}

---

## Backup System

Located in utils/backup.js:

- Uses pg_dump for database backups
- Auto-backup runs hourly, but only creates backup at 11 PM Manila time
- Maximum 30 backups retained
- Manual backup via API endpoint
- Supports Windows and Linux pg_dump paths

---

## Testing

Currently, the project does not have automated tests. Manual testing is done through:
- Browser-based interaction testing
- API endpoint testing with curl or Postman
- Database query verification

---

## Building for Production

### Docker

docker compose up -d --build

### Electron Desktop

npm run electron:build

This creates a portable Windows executable in dist/.

### Scripts

- deploy.bat: Windows deployment script
- deploy.sh: Linux/NAS deployment script

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| DATABASE_URL | Yes | PostgreSQL connection string |
| SESSION_SECRET | Yes | Session encryption secret |
| PORT | No | HTTP port (default: 3001) |
| BOOTSTRAP_USERNAME | No | First admin username |
| BOOTSTRAP_PASSWORD | No | First admin password |
| BOOTSTRAP_ROLE | No | First admin role (default: admin) |
| PG_DUMP_PATH | No | pg_dump executable path |
| NODE_ENV | No | Environment (development/production) |

---

## Common Development Tasks

### Adding a New Route

1. Create route file in routes/ (e.g., routes/example.js)
2. Add route mounting in server.js:
   app.use('/api/example', require('./routes/example'));
3. Add write limiter if needed:
   app.use('/api/example', writeLimiter);

### Adding a New Database Table

1. Add CREATE TABLE statement in db/schema.sql
2. Add indexes as needed
3. Server auto-runs schema.sql on startup
4. If table already exists, CREATE IF NOT EXISTS skips it

### Adding Frontend View

1. Add navigation item in app.js shell() function
2. Add view ID to state.js
3. Add skeleton loading template in app.js skeletonViewHTML()
4. Add render handler in views.js
5. Add data fetching to loadData() in state.js

---

*End of Developer Guide*
