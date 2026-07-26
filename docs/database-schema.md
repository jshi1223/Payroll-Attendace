# Database Schema

Version: 1.1 | Last Updated: July 2026

## Overview

The database uses PostgreSQL 16 and is initialized automatically on server startup. The schema includes 8 main tables with appropriate indexes and constraints.

## Entity Relationship Diagram

```
users
  |--- created_by (audit_logs)
  |--- created_by (attendance_logs)
  |--- created_by (cash_advances)
  |--- created_by (extra_payments)
  |--- created_by (salary_payments)
  |--- created_by (bale_payments)
  |--- updated_by (payroll_statuses)

audit_logs
  |--- user_id -> users.id
  |--- entity (string), entity_id (number)

employees
  |--- id referenced by:
  |    +-- attendance_logs.employee_id
  |    +-- cash_advances.employee_id
  |    +-- payroll_statuses.employee_id
  |    +-- extra_payments.employee_id
  |    +-- salary_payments.employee_id
  |    +-- bale_payments.employee_id

attendance_logs
  employee_id -> employees.id (CASCADE)
  work_date (unique per employee)

cash_advances
  employee_id -> employees.id (CASCADE)

payroll_statuses
  employee_id -> employees.id (CASCADE)
  week_start (unique per employee)

extra_payments
  employee_id -> employees.id (CASCADE)

salary_payments
  employee_id -> employees.id (CASCADE)

bale_payments
  employee_id -> employees.id (CASCADE)
```

---

## Tables

### users

Stores system user accounts for authentication.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing ID |
| username | VARCHAR(80) | UNIQUE, NOT NULL | Login username |
| password_hash | TEXT | NOT NULL | bcrypt hashed password |
| role | VARCHAR(20) | NOT NULL, CHECK IN ('admin', 'hr') | User role |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Creation timestamp |

### employees

Stores employee profiles and government IDs.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing ID |
| emp_number | VARCHAR(40) | UNIQUE, NOT NULL | Auto-generated (EMP-XXXXX) |
| name | VARCHAR(160) | NOT NULL | Full name |
| phone | VARCHAR(20) | NOT NULL, DEFAULT '' | 11-digit phone, unique |
| rate | NUMERIC(12,2) | NOT NULL, CHECK >= 0 | Daily rate |
| active | BOOLEAN | NOT NULL, DEFAULT TRUE | Active/archived status |
| photo_url | VARCHAR(500) | | Photo file path |
| sss_number | VARCHAR(30) | NOT NULL, DEFAULT '' | SSS government ID |
| philhealth_number | VARCHAR(30) | NOT NULL, DEFAULT '' | PhilHealth ID |
| pagibig_number | VARCHAR(30) | NOT NULL, DEFAULT '' | Pag-IBIG ID |
| tin_number | VARCHAR(30) | NOT NULL, DEFAULT '' | TIN ID |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Last update timestamp |

Indexes:
- idx_employees_phone_unique: UNIQUE on phone
- idx_employees_name: on name

Employee Number Format: EMP-00001 (auto-generated via sequence)

### attendance_logs

Stores daily attendance records per employee.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing ID |
| employee_id | INTEGER | NOT NULL, FK -> employees.id CASCADE | Employee reference |
| work_date | DATE | NOT NULL | Attendance date |
| time_in | TIME | | Time in |
| time_out | TIME | | Time out |
| rate_snapshot | NUMERIC(12,2) | NOT NULL, CHECK >= 0 | Rate at time of logging |
| notes | TEXT | DEFAULT '' | Additional notes |
| created_by | INTEGER | FK -> users.id SET NULL | User who created |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Last update timestamp |

Constraints:
- UNIQUE (employee_id, work_date): One record per employee per day

Indexes:
- idx_attendance_logs_work_date: on work_date
- idx_attendance_logs_employee: on employee_id

### cash_advances

Records cash advances given to employees.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing ID |
| employee_id | INTEGER | NOT NULL, FK -> employees.id CASCADE | Employee reference |
| amount | NUMERIC(12,2) | NOT NULL, CHECK >= 0 | Advance amount |
| advance_date | DATE | NOT NULL | Date of advance |
| notes | TEXT | DEFAULT '' | Additional notes |
| created_by | INTEGER | FK -> users.id SET NULL | User who created |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Creation timestamp |

Indexes:
- idx_cash_advances_date: on advance_date
- idx_cash_advances_employee: on employee_id

### payroll_statuses

Tracks payroll payment status per employee per period.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing ID |
| employee_id | INTEGER | NOT NULL, FK -> employees.id CASCADE | Employee reference |
| week_start | DATE | NOT NULL | Period start date |
| status | VARCHAR(20) | NOT NULL, DEFAULT 'unpaid', CHECK IN ('paid', 'unpaid') | Payment status |
| paid_amount | NUMERIC(12,2) | NOT NULL, DEFAULT 0, CHECK >= 0 | Amount paid |
| extra_payment_amount | NUMERIC(12,2) | NOT NULL, DEFAULT 0, CHECK >= 0 | Extra payment amount |
| extra_payment_notes | TEXT | DEFAULT '' | Notes for extra payment |
| bale_deducted | BOOLEAN | NOT NULL, DEFAULT false | Whether bale was deducted |
| is_generated | BOOLEAN | NOT NULL, DEFAULT false | Payslip generated status |
| period_type | VARCHAR(20) | NOT NULL, DEFAULT 'weekly' | Period type |
| paid_at | TIMESTAMPTZ | | When payment was made |
| updated_by | INTEGER | FK -> users.id SET NULL | User who last updated |
| updated_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Last update timestamp |

Constraints:
- UNIQUE (employee_id, week_start): One record per employee per period

Indexes:
- idx_payroll_statuses_week: on week_start

### extra_payments

Records bonus/adjustment payments for employees.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing ID |
| employee_id | INTEGER | NOT NULL, FK -> employees.id CASCADE | Employee reference |
| amount | NUMERIC(12,2) | NOT NULL, CHECK >= 0 | Extra payment amount |
| extra_date | DATE | NOT NULL | Date of extra payment |
| notes | TEXT | DEFAULT '' | Additional notes |
| created_by | INTEGER | FK -> users.id SET NULL | User who created |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Creation timestamp |

Indexes:
- idx_extra_payments_date: on extra_date
- idx_extra_payments_employee: on employee_id

### salary_payments

Records salary payments made to employees.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing ID |
| employee_id | INTEGER | NOT NULL, FK -> employees.id CASCADE | Employee reference |
| amount | NUMERIC(12,2) | NOT NULL, CHECK >= 0 | Payment amount |
| payment_date | DATE | NOT NULL | Payment date |
| notes | TEXT | DEFAULT '' | Additional notes |
| created_by | INTEGER | FK -> users.id SET NULL | User who created |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Creation timestamp |

Indexes:
- idx_salary_payments_date: on payment_date
- idx_salary_payments_employee: on employee_id

### bale_payments

Records debt (bale) repayment payments from employees.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | SERIAL | PRIMARY KEY | Auto-incrementing ID |
| employee_id | INTEGER | NOT NULL, FK -> employees.id CASCADE | Employee reference |
| amount | NUMERIC(12,2) | NOT NULL, CHECK >= 0 | Payment amount |
| payment_date | DATE | NOT NULL | Payment date |
| notes | TEXT | DEFAULT '' | Additional notes |
| created_by | INTEGER | FK -> users.id SET NULL | User who created |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Creation timestamp |

Indexes:
- idx_bale_payments_date: on payment_date
- idx_bale_payments_employee: on employee_id

### audit_logs

Records all actions for audit trail.

| Column | Type | Constraints | Description |
