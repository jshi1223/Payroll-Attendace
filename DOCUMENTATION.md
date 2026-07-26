# Payroll System — User Manual

**Version:** 1.1  
**Last Updated:** July 2026  

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture & Flow](#2-architecture--flow)
3. [Installation & Deployment](#3-installation--deployment)
4. [Login & Access](#4-login--access)
5. [Dashboard](#5-dashboard)
6. [Employee Management](#6-employee-management)
7. [Attendance](#7-attendance)
8. [Payroll](#8-payroll)
9. [Cash Advance](#9-cash-advance)
10. [Archive](#10-archive)
11. [Dark Mode](#11-dark-mode)
12. [Keyboard Shortcuts](#12-keyboard-shortcuts)
13. [API Reference](#13-api-reference)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. System Overview

A web-based payroll management system built for small to medium businesses. Supports employee management, attendance tracking, payroll computation, cash advances, and user role management.

**Key Features:**
- Role-based access (Admin / HR)
- Employee photo upload
- Weekly and semi-monthly payroll computation
- Attendance logging with week/month navigation
- Cash advance tracking
- Extra payments / bonuses
- Salary and bale (debt) payment tracking
- Dark mode toggle
- Session timeout monitoring
- Keyboard shortcuts for power users
- Session-based authentication
- Audit trail for all operations
- Auto-backup system

**Tech Stack:** Node.js, Express, PostgreSQL, Vanilla JS frontend

---

## 2. Architecture & Flow

### System Flowchart

```mermaid
flowchart TB
    A[User opens browser] --> B{Logged in?}
    B -->|No| C[Login Screen]
    B -->|Yes| D[Dashboard]
    C --> E[Enter username/password]
    E --> F{Valid?}
    F -->|No| C
    F -->|Yes| D

    D --> G[Navigate via Sidebar]
    
    G --> H[Employees]
    G --> I[Attendance]
    G --> J[Payroll]
    G --> K[Dashboard]
    G --> L[Cash Advance]
    G --> M[Archive]

    H --> H1[Add Employee]
    H --> H2[Edit Employee]
    H --> H3[Upload Photo]
    H --> H4[Archive Employee]

    I --> I1[Log Attendance]
    I --> I2[Navigate Weeks/Months]

    J --> J1[View Payroll]
    J --> J2[Mark Paid/Unpaid]
    J --> J3[Generate Payslip]

    L --> L1[Request Cash Advance]
    L --> L2[Deduct from Payroll]
```

### Login Flow

```mermaid
flowchart LR
    A[Login Page] --> B[Enter Credentials]
    B --> C[Server Validates]
    C -->|Success| D[Create Session]
    C -->|Fail| E[Show Error / Lockout]
    D --> F[Load Dashboard]
    E --> B
```

---

## 3. Installation & Deployment

### Requirements

| Requirement | Version |
|-------------|---------|
| Node.js     | 18+ |
| PostgreSQL  | 14+ |
| npm         | 9+ |

### Setup Steps

1. **Clone or copy the project files**

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create a PostgreSQL database**
   ```sql
   CREATE DATABASE payroll;
   ```

4. **Configure environment** — copy `.env.example` to `.env` and fill in your values:
   ```
   DATABASE_URL=postgresql://user:password@localhost:5432/payroll
   SESSION_SECRET=your-strong-random-secret-here
   BOOTSTRAP_USERNAME=admin
   BOOTSTRAP_PASSWORD=your-secure-password
   BOOTSTRAP_ROLE=admin
   ```

5. **Start the server**
   ```bash
   node server.js
   ```

6. **Open browser** → `http://localhost:3001`

### Bootstrap User

The first admin user is automatically created on first run using the `BOOTSTRAP_*` environment variables in `.env`. No manual SQL insertion needed.

### Docker Deployment

```bash
docker compose up -d --build
```

See `deploy.bat` (Windows) or `deploy.sh` (Linux/NAS) for deployment scripts.

### Electron Desktop App

```bash
npm run electron:build
```

Outputs a portable `.exe` in the `dist/` folder.

---

## 4. Login & Access

### Login Screen

- Enter your **Username** and **Password**
- **Caps Lock warning** appears automatically if Caps Lock is on
- **Role badges** (Admin/HR) are displayed on the login panel

### Role Permissions

| Feature | Admin | HR |
|---------|-------|----|
| View employees | ✓ | ✓ |
| Add / Edit employees | ✓ | ✓ |
| Archive employees | ✓ | ✗ |
| Permanent delete | ✓ | ✗ |
| View audit trail | ✓ | ✗ |
| View/Manage payroll | ✓ | ✓ |
| Mark as paid | ✓ | ✓ |
| Generate payslip | ✓ | ✓ |
| Cash advance management | ✓ | ✓ |
| Extra payments | ✓ | ✓ |
| Salary/Bale payments | ✓ | ✓ |
| Backup management | ✓ | ✗ |

### Session Timeout

- Sessions expire after **8 hours** of inactivity
- A **countdown timer** is shown in the sidebar
- When the session expires, you are redirected to the login screen
- Single-session enforcement: logging in elsewhere destroys previous sessions

### Login Lockout

After 5 failed login attempts, the account is temporarily locked with escalating durations (1, 3, 5, 10, 15, 30 minutes).

---

## 5. Dashboard

The dashboard shows a weekly overview with:
- **Active Employees** — number of active employees
- **Present Today** — employees with logged attendance today
- **This Week's Salary** — total salary for the current period
- **Salary Payment** — total payments made this period
- **Outstanding Balance** — total unpaid balances
- **Bale Balance** — total outstanding cash advance debt

---

## 6. Employee Management

### Employee List

- Shows all employees in a paginated table
- Each row shows: photo, employee number, name, rate, phone, government IDs
- **Action buttons:** Edit, Archive (Admin only)
- Click **+ New Employee** to open the add modal

### Add / Edit Employee

| Field | Description |
|-------|-------------|
| Full Name | Employee's full name |
| Phone Number | Exactly 11 digits, unique per employee |
| Daily Rate | PHP per day |
| SSS Number | Format: XX-XXXXXXX-X |
| PhilHealth Number | Format: XX-XXXXXXXXX-X |
| Pag-IBIG Number | Format: XXXX-XXXX-XXXX |
| TIN Number | Format: XXX-XXX-XXX-XXX |
| Photo | JPEG/PNG, max 5MB |

### Photo Upload

- Click the camera icon to upload a photo
- Accepted formats: JPEG, PNG
- Maximum size: **5MB**
- Photos are stored in `public/uploads/`

### Archive Employee

- **Admin only** — HR users cannot archive
- Archived employees are moved to the Archive view
- Can be restored by Admin

### Permanent Delete

- **Admin only**
- Permanently removes employee and all related data
- Remaining employees are renumbered sequentially

---

## 7. Attendance

- Displays a **weekly calendar** (Monday–Sunday) or **monthly calendar**
- Each employee has attendance records for each day
- **Arrow keys** (← →) or buttons navigate between weeks
- Click a day cell to log/edit attendance

### Navigation

- **Weekly mode:** Navigate by week (Mon–Sun)
- **Monthly mode:** Navigate by month (select month in dropdown)
- Current date auto-selects today's week on load

### Bulk Attendance

Use the bulk attendance feature to mark multiple employees as present for a week.

---

## 8. Payroll

### Period Modes

- **Weekly:** Monday–Sunday 7-day periods
- **Semi-monthly:** Rolling 14-day periods (Monday + 13 days)

Toggle between modes using the period type selector.

### Payroll Columns

| Column | Description |
|--------|-------------|
| Employee | Name, employee number, and photo |
| Rate | Daily rate |
| Days Worked | Count of attended days in the period |
| Gross Pay | Days worked × daily rate |
| Cash Advance | Outstanding debt carried over + new advances |
| Extra Payment | Bonuses/adjustments this period |
| Total Due | Gross + Extras |
| Paid | Amount already paid |
| Balance | Remaining unpaid amount |
| Bale Balance | Outstanding cash advance debt |
| Status | Paid / Unpaid / Partial / Generated badge |

### Payment Statuses

- **Unpaid** — no payment recorded or not yet generated
- **Partial** — some payment made but balance remains
- **Paid** — fully paid
- **Generated** — payslip has been generated (locked)

### Generating a Payslip

1. Navigate to the desired period in **Payroll**
2. Click **Generate** to finalize the payslip
3. Once generated, the period is **locked** — no changes allowed
4. Admin can unlock if corrections are needed

### Running Payroll

1. Navigate to the desired week in **Attendance** first
2. Switch to **Payroll** view (press `2`)
3. Review the computed amounts for each employee
4. Click **Payment** to record salary payments
5. Click **Bale Payment** to record debt payments
6. Click **Generate** to finalize and lock the period

---

## 9. Cash Advance

- Track cash advances given to employees
- Advances are added to the employee's bale (debt) balance
- Add a new cash advance via the **+ New Advance** button
- One advance per employee per day maximum
- Cannot modify during a locked payroll period

---

## 10. Extra Payments

- Record bonuses, adjustments, or additional payments
- One extra payment per employee per day maximum
- Added to total earnings for the period
- Cannot modify during a locked payroll period

---

## 11. Salary & Bale Payments

### Salary Payments
- Record salary payments made outside the payroll system
- Validated against available balance
- Cannot exceed total due for the period

### Bale Payments
- Record debt repayment payments
- Reduces the employee's outstanding bale balance
- Cannot exceed current bale balance

---

## 12. Archive

- Stores archived employees for record-keeping
- Admin can view and restore archived employees
- Permanent delete removes all data permanently

---

## 13. Dark Mode

- Click **Dark Mode** in the sidebar to switch
- Click **Light Mode** to switch back
- Preference is **saved in localStorage** — persists across sessions
- The login screen **always stays in light mode**

---

## 14. Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1` | Dashboard |
| `2` | Payroll |
| `3` | Attendance |
| `4` | Employees |
| `5` | Archive |
| `←` | Previous period |
| `→` | Next period |
| `Escape` | Close modal |
| `Tab` | Focus first input on modal open |

Shortcuts do **not** activate when typing in input fields.

---

## 15. API Reference

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/login` | Login (with progressive lockout) |
| POST | `/api/logout` | Logout |
| GET | `/api/me` | Get current session user |

### Employees

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/employees` | List employees (supports `?search=`, `?active=`) |
| POST | `/api/employees` | Create employee |
| PUT | `/api/employees/:id` | Update employee |
| DELETE | `/api/employees/:id` | Archive employee (Admin only) |
| POST | `/api/employees/:id/photo` | Upload employee photo |
| DELETE | `/api/employees/:id/photo` | Remove employee photo |
| PUT | `/api/employees/:id/restore` | Restore archived employee (Admin only) |
| DELETE | `/api/employees/:id/permanent` | Permanent delete (Admin only) |

### Attendance

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/attendance` | Get attendance (supports `?week=`, `?month=`, `?period_type=`, `?search=`) |
| POST | `/api/attendance` | Create/update attendance record |
| POST | `/api/attendance/bulk` | Bulk attendance marking |
| PUT | `/api/attendance/:id` | Update attendance record |
| DELETE | `/api/attendance/:id` | Delete attendance (Admin only) |

### Payroll

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/payroll` | Get payroll data (supports `?week=`, `?period_type=`, `?search=`) |
| PUT | `/api/payroll/payment` | Record salary payment |
| DELETE | `/api/payroll/payment` | Remove salary payment (Admin only) |
| POST | `/api/payroll/generate` | Generate/finalize payslip (locks period) |
| POST | `/api/payroll/unlock` | Unlock payslip (Admin only) |

### Cash Advances

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/cash-advances` | List cash advances |
| POST | `/api/cash-advances` | Create cash advance |
| PUT | `/api/cash-advances/:id` | Update cash advance |
| DELETE | `/api/cash-advances/:id` | Delete cash advance (Admin only) |

### Extra Payments

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/extra-payments` | List extra payments |
| POST | `/api/extra-payments` | Create extra payment |
| PUT | `/api/extra-payments/:id` | Update extra payment |
| DELETE | `/api/extra-payments/:id` | Delete extra payment (Admin only) |

### Salary Payments

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/salary-payments` | List salary payments |
| POST | `/api/salary-payments` | Create salary payment |
| PUT | `/api/salary-payments/:id` | Update salary payment |
| DELETE | `/api/salary-payments/:id` | Delete salary payment (Admin only) |

### Bale Payments

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/bale-payments` | List bale payments |
| POST | `/api/bale-payments` | Create bale payment |
| PUT | `/api/bale-payments/:id` | Update bale payment |
| DELETE | `/api/bale-payments/:id` | Delete bale payment (Admin only) |

### Audit Trail

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/audit-logs` | List audit logs (Admin only, supports `?entity=`, `?action=`, `?search=`, `?date_from=`, `?date_to=`, `?page=`) |

### Backup

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/backup` | Create manual backup (Admin only) |
| GET | `/api/backup/list` | List available backups (Admin only) |

---

## 16. Backup System

- Auto-backup runs daily at 11 PM (Manila time)
- Maximum 30 backups retained (oldest auto-deleted)
- Manual backup via API or Admin panel
- Backups stored in `backups/` directory
- Configure `PG_DUMP_PATH` in `.env` if auto-detection fails

---

## 17. Troubleshooting

| Problem | Solution |
|---------|----------|
| **Cannot login** | Check caps lock; verify credentials with admin |
| **Session expired** | Login again — sessions expire after 8 hours |
| **Too many login attempts** | Wait for the lockout period to expire |
| **Photo upload fails** | Ensure file is JPEG/PNG and under 5MB |
| **Payroll not showing** | Log attendance first for the target period |
| **Server won't start** | Check `.env` file for `DATABASE_URL` and `SESSION_SECRET` |
| **Database errors** | Schema auto-initializes on startup; check PostgreSQL is running |
| **Port conflict** | Change `PORT` in `.env` (default: 3001) |
| **Backup fails** | Set `PG_DUMP_PATH` in `.env` to your pg_dump location |
| **Period locked** | Admin can unlock via the payroll interface |

---

*End of Manual*
