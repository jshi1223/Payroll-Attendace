# Payroll System — User Manual

**Version:** 1.0  
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
- Weekly payroll computation
- Attendance logging with multi-week navigation
- Cash advance tracking
- Dark mode toggle
- Session timeout monitoring
- Keyboard shortcuts for power users
- Session-based authentication

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
    H --> H4[Delete Employee]

    I --> I1[Log Attendance]
    I --> I2[Navigate Weeks]

    J --> J1[Run Payroll]
    J --> J2[Mark Paid/Unpaid]

    L --> L1[Request Cash Advance]
    L --> L2[Deduct from Payroll]
```

### Data Flow for Payroll Run

```mermaid
sequenceDiagram
    User->>+UI: Click "Run Payroll"
    UI->>+Server: POST /api/payroll/run
    Server->>+DB: Calculate days worked
    Server->>+DB: Calculate deductions
    Server->>+DB: Calculate cash advances
    Server-->>-UI: Return payroll records
    UI-->>-User: Display computed payroll
    
    User->>+UI: Mark as Paid
    UI->>+Server: PATCH /api/payroll/:id
    Server-->>-UI: Confirm payment
    UI-->>-User: Show paid badge
```

### Login Flow

```mermaid
flowchart LR
    A[Login Page] --> B[Enter Credentials]
    B --> C[Server Validates]
    C -->|Success| D[Create Session]
    C -->|Fail| E[Show Error]
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

4. **Run the schema**
   ```bash
   psql -d payroll -f db/schema.sql
   ```

5. **Configure environment** — create a `.env` file:

   ```
   DATABASE_URL=postgresql://user:password@localhost:5432/payroll
   SESSION_SECRET=your-strong-secret-here
   PORT=3001
   ```

6. **Start the server**
   ```bash
   node server.js
   ```

7. **Open browser** → `http://localhost:3001`

### Initial Login

The first user must be inserted directly into the database:

```sql
INSERT INTO users (username, password_hash, role)
VALUES ('admin', '$2a$10$...hashed...password...', 'admin');
```

> **Screenshot placeholder:** Terminal showing `node server.js` running with "Payroll system running at http://localhost:3001"

---

## 4. Login & Access

### Login Screen

> **Screenshot placeholder:** Login page with username/password fields, Remember Me checkbox, and role badges

- Enter your **Username** and **Password**
- Check **Remember Me** to save your username locally
- **Caps Lock warning** appears automatically if Caps Lock is on
- **Role badges** (Admin/HR) are displayed on the login panel

### Role Permissions

| Feature | Admin | HR |
|---------|-------|----|
| View employees | ✓ | ✓ |
| Add / Edit employees | ✓ | ✓ |
| Delete employees | ✓ | ✗ |
| View audit trail | ✓ | ✗ |
| Run payroll | ✓ | ✓ |
| Mark as paid | ✓ | ✓ |
| Cash advance management | ✓ | ✓ |
| Archive access | ✓ | ✓ |

### Session Timeout

- Sessions expire after **8 hours** of inactivity
- A **countdown timer** is shown in the sidebar
- When the session expires, you are redirected to the login screen

---

## 5. Dashboard

> **Screenshot placeholder:** Dashboard view with summary cards (Total Employees, Pending Payroll, Cash Advances, Attendance Today)

The dashboard shows a weekly overview with:
- **Total Employees** — number of active employees
- **Pending Payroll** — unpaid payroll count
- **Cash Advances** — active cash advances
- **Attendance Today** — number of employees with logged attendance today

---

## 6. Employee Management

### Employee List

> **Screenshot placeholder:** Employee list table with photo thumbnails, name, role, rate, and action buttons

- Shows all employees in a paginated table
- Each row shows: photo, name, role, hourly rate, contact number
- **Action buttons:** Edit, Delete
- Click **+ New Employee** to open the add modal

### Add / Edit Employee

> **Screenshot placeholder:** Employee modal with form fields and photo upload

| Field | Description |
|-------|-------------|
| Full Name | Employee's full name |
| Role / Position | Job title |
| Hourly Rate | PHP per hour |
| Contact Number | Mobile/phone |
| Email | Email address |
| Address | Complete address |
| SSS / PhilHealth / Pag-IBIG | Government numbers |
| Photo | JPEG/PNG, max 2MB |

### Photo Upload

> **Screenshot placeholder:** Photo upload section inside employee modal

- Click the camera icon to upload a photo
- Accepted formats: JPEG, PNG
- Maximum size: **2MB**
- Photos are stored in `public/uploads/`

### Delete Employee

- **Admin only** — HR users cannot delete
- A confirmation prompt appears before deletion

---

## 7. Attendance

> **Screenshot placeholder:** Attendance view with week navigation and checkboxes

- Displays a **weekly calendar** (Monday–Sunday)
- Each employee has a checkbox for each day
- **Arrow keys** (← / →) or buttons navigate between weeks
- Attendance is saved immediately on toggle

### Week Navigation

- **Press `←`** to go to the previous week
- **Press `→`** to go to the next week
- Current date auto-selects today's week on load

---

## 8. Payroll

> **Screenshot placeholder:** Payroll view showing employee rows with days worked, gross pay, deductions, cash advance, and net pay

### Payroll Columns

| Column | Description |
|--------|-------------|
| Employee | Name and photo |
| Days Worked | Count of attended days in the week |
| Gross Pay | Days worked × hours per day × hourly rate |
| Deductions | Total SSS + PhilHealth + Pag-IBIG |
| Cash Advance | Deducted loan amount |
| Net Pay | Gross − Deductions − Cash Advance |
| Status | Paid / Unpaid / Partial badge |
| Actions | Mark paid, edit |

### Running Payroll

1. Navigate to the desired week in **Attendance** first
2. Switch to **Payroll** view (press `2`)
3. Click **Run Payroll** to compute all employees
4. Review the computed amounts
5. Click **Mark Paid** to finalize

### Payment Status Badges

- **Paid** — green badge
- **Unpaid** — yellow/amber badge  
- **Partial** — blue badge

---

## 9. Cash Advance

> **Screenshot placeholder:** Cash advance list with employee name, amount, date, and status

- Track cash advances given to employees
- Advances are **automatically deducted** from the next payroll run
- Add a new cash advance via the **+ New Advance** button

---

## 10. Archive

> **Screenshot placeholder:** Archived/deleted employees list

- Stores deleted employees for record-keeping
- Admin can view archived employees
- Not accessible to HR users for deletion (but viewable)

---

## 11. Dark Mode

> **Screenshot placeholder:** Sidebar showing "🌙 Dark Mode" toggle button  
> **Screenshot placeholder:** Same page in dark mode

- Click **🌙 Dark Mode** in the sidebar to switch
- Click **☀️ Light Mode** to switch back
- Preference is **saved in localStorage** — persists across sessions
- The login screen **always stays in light mode**

---

## 12. Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1` | Dashboard |
| `2` | Payroll |
| `3` | Attendance |
| `4` | Employees |
| `5` | Archive |
| `←` | Previous week |
| `→` | Next week |
| `Escape` | Close modal |
| `Tab` | Focus first input on modal open |

Shortcuts do **not** activate when typing in input fields.

---

## 13. API Reference

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/login` | Login (rate limited: 10/15min) |
| POST | `/api/logout` | Logout |
| GET | `/api/me` | Get current session user |

### Employees

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/employees` | List all employees |
| POST | `/api/employees` | Create employee |
| PATCH | `/api/employees/:id` | Update employee |
| DELETE | `/api/employees/:id` | Delete employee (Admin only) |
| POST | `/api/employees/:id/photo` | Upload employee photo |

### Attendance

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/attendance/:weekStart` | Get attendance for a week |
| POST | `/api/attendance` | Toggle attendance record |

### Payroll

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/payroll/:weekStart` | Get payroll for a week |
| POST | `/api/payroll/run` | Run payroll computation |
| PATCH | `/api/payroll/:id` | Update payroll status |

### Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard` | Get dashboard summary |

### Cash Advance

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/cash-advances` | List cash advances |
| POST | `/api/cash-advances` | Create cash advance |
| DELETE | `/api/cash-advances/:id` | Delete cash advance |

### Archive

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/archive` | List archived employees |

---

## 14. Troubleshooting

| Problem | Solution |
|---------|----------|
| **Cannot login** | Check caps lock; verify credentials with admin |
| **Session expired** | Login again — sessions expire after 8 hours |
| **Too many login attempts** | Wait 15 minutes before trying again |
| **Photo upload fails** | Ensure file is JPEG/PNG and under 2MB |
| **Payroll not showing** | Log attendance first for the target week |
| **Server won't start** | Check .env file for DATABASE_URL and SESSION_SECRET |
| **Database errors** | Run `db/schema.sql` against your PostgreSQL database |
| **Port conflict** | Change PORT in .env (default: 3001) |

---

*End of Manual*
