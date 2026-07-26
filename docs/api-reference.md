# API Reference

Version: 1.1 | Last Updated: July 2026

## Overview

All API endpoints return JSON responses. Authentication is session-based using HTTP-only cookies.

### Base URL

http://localhost:3001/api

### Authentication

- Login establishes a session stored server-side
- Session cookie is automatically sent with each request
- CSRF token required for all mutation endpoints (POST, PUT, DELETE, PATCH)

### CSRF Protection

GET /api/csrf-token

Response: { csrfToken: "string" }

Include the token in the X-CSRF-Token header for all mutation requests.

### Rate Limiting

- Global: 120 requests per minute
- Write endpoints: 40 requests per minute (payroll, employees, attendance, cash-advances, extra-payments, salary-payments, bale-payments)

### Error Responses

{ error: "Description of the error" }

---

## Authentication Endpoints

### POST /api/login

Login with username and password.

Request Body:
{ username: "string", password: "string" }

Response: { user: { id, username, role }, sessionTTL: number, csrfToken: string }

Errors:
- 401: Invalid username or password
- 429: Too many login attempts (with retryAfter in seconds)

### POST /api/logout

Destroy the current session.

Response: { ok: true }

### GET /api/me

Get current session user info and remaining session time.

Response: { user: { id, username, role } | null, sessionTTL: number | null }

---

## Employee Endpoints

### GET /api/employees

List employees with search and filter.

Query Parameters:
- search (string, optional): Search by name or employee number
- active (string, optional): "true", "false", or "all" (default: true)

Response: Array of employee objects

### POST /api/employees

Create a new employee.

Request Body:
{
  name: string (required),
  phone: string (required, exactly 11 digits),
  rate: number (required, >= 0),
  active: boolean (optional, default: true),
  sss_number: string (optional, format: XX-XXXXXXX-X),
  philhealth_number: string (optional, format: XX-XXXXXXXXX-X),
  pagibig_number: string (optional, format: XXXX-XXXX-XXXX),
  tin_number: string (optional, format: XXX-XXX-XXX-XXX)
}

Response: Created employee object (201)

Errors:
- 400: Validation error
- 409: Phone number already in use

### PUT /api/employees/:id

Update an existing employee.

Request Body: Same as POST

Response: Updated employee object

### DELETE /api/employees/:id

Archive an employee (soft delete). Admin only.

Response: { ok: true }

### POST /api/employees/:id/photo

Upload employee photo.

Content-Type: multipart/form-data
Field: photo (file, JPEG/PNG, max 5MB)

Response: { photo_url: string }

### DELETE /api/employees/:id/photo

Remove employee photo.

Response: { photo_url: null }

### PUT /api/employees/:id/restore

Restore an archived employee. Admin only.

Response: Restored employee object

### DELETE /api/employees/:id/permanent

Permanently delete an employee and renumber remaining employees. Admin only.

Response: { ok: true }

---

## Attendance Endpoints

### GET /api/attendance

Get attendance records for a period.

Query Parameters:
- week (string, optional): Week start date (YYYY-MM-DD)
- month (string, optional): Month (YYYY-MM) - overrides week
- period_type (string, optional): "weekly" or "semimonthly"
- search (string, optional): Search by employee name or number

Response:
{ weekStart: string, weekEnd: string, rows: Array of attendance objects }

### POST /api/attendance

Create or update an attendance record.

Request Body:
{
  employee_id: number (required),
  work_date: string (required, YYYY-MM-DD),
  time_in: string (optional, HH:MM),
  time_out: string (optional, HH:MM),
  notes: string (optional)
}

Response: Created/updated attendance object (201)

### POST /api/attendance/bulk

Bulk attendance marking for a week.

Request Body:
{
  weekStart: string (optional, YYYY-MM-DD),
  employeeIds: Array of number,
  present: Array of { employee_id: number, work_date: string }
}

Response: { ok: true }

### PUT /api/attendance/:id

Update an attendance record.

Request Body: Same fields as POST

Response: Updated attendance object

### DELETE /api/attendance/:id

Delete an attendance record. Admin only.

Response: { ok: true }

---

## Payroll Endpoints

### GET /api/payroll

Get payroll data for a period.

Query Parameters:
- week (string, optional): Start date (YYYY-MM-DD)
- period_type (string, optional): "weekly" or "semimonthly"
- search (string, optional): Search by employee name or number
- include_inactive (boolean, optional): Include archived employees
- today (string, optional): Override current date for working days calc

Response:
{
  weekStart: string,
  weekEnd: string,
  rows: Array of payroll row objects with computed fields,
  summary: {
    employees: number,
    workingDays: number,
    totalCashAdvance: number,
    totalPaidAmount: number,
    totalSalary: number,
    totalBalance: number,
    totalBaleBalance: number,
    totalPreviousUnpaid: number
  }
}

### PUT /api/payroll/payment

Record a salary payment.

Request Body:
{
  employee_id: number (required),
  weekStart: string (required, YYYY-MM-DD),
  paid_amount: number (required, >= 0),
  period_type: string (optional)
}

Response: Updated payroll_statuses record

### DELETE /api/payroll/payment

Remove a salary payment. Admin only.

Request Body:
{ employee_id: number, weekStart: string }

Response: { ok: true }

### POST /api/payroll/generate

Generate/finalize a payslip (locks the period).

Request Body:
{
  employee_id: number (required),
  weekStart: string (required),
  period_type: string (optional)
}

Response: { ok: true, is_generated: true }

### POST /api/payroll/unlock

Unlock a generated payslip. Admin only.

Request Body:
{
  employee_id: number (required),
  weekStart: string (required),
  period_type: string (optional)
}

Response: { ok: true, is_generated: false }

Errors:
- 403: If overlapping with locked semi-monthly period

---

## Cash Advance Endpoints

### GET /api/cash-advances

List cash advances for a period.

Query Parameters:
- week (string, optional): Start date
- period_type (string, optional): "weekly" or "semimonthly"
- employee_id (number, optional): Filter by employee

Response: { weekStart, weekEnd, rows: Array of cash advance objects }

### POST /api/cash-advances

Create a cash advance.

Request Body:
{
  employee_id: number (required),
  amount: number (required, > 0),
  advance_date: string (required, YYYY-MM-DD),
  notes: string (optional)
}

Response: Created cash advance object (201)

Errors:
- 403: Period is locked/generated
- 409: Only one advance per employee per day

### PUT /api/cash-advances/:id

Update a cash advance.

Request Body: Same as POST

Response: Updated cash advance object

### DELETE /api/cash-advances/:id

Delete a cash advance. Admin only.

Response: { ok: true }

---

## Extra Payment Endpoints

### GET /api/extra-payments

List extra payments for a period.

Query Parameters:
- week (string, optional)
- period_type (string, optional)
- employee_id (number, optional)

Response: { weekStart, weekEnd, rows: Array of extra payment objects }

### POST /api/extra-payments

Create an extra payment.

Request Body:
{
  employee_id: number (required),
  amount: number (required, > 0),
  extra_date: string (required, YYYY-MM-DD),
  notes: string (optional)
}

Response: Created extra payment object (201)

Errors:
- 403: Period is locked
- 409: Only one extra payment per employee per day

### PUT /api/extra-payments/:id

Update an extra payment.

### DELETE /api/extra-payments/:id

Delete an extra payment. Admin only.

---

## Salary Payment Endpoints

### GET /api/salary-payments

List salary payments for a period.

Query Parameters:
- week (string, optional)
- period_type (string, optional)
- employee_id (number, optional)

Response: { weekStart, weekEnd, rows: Array of salary payment objects }

### POST /api/salary-payments

Create a salary payment.

Request Body:
{
  employee_id: number (required),
  amount: number (required, > 0),
  payment_date: string (required, YYYY-MM-DD),
  notes: string (optional),
  period_type: string (optional)
}

Response: Created sala
