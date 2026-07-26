# User Guide

Version: 1.1 | Last Updated: July 2026

## Table of Contents

1. Login and Access
2. Dashboard
3. Employee Management
4. Attendance
5. Payroll
6. Cash Advance (Bale)
7. Extra Payments
8. Salary and Bale Payments
9. Archive
10. Audit Trail
11. Backup Management
12. Dark Mode
13. Keyboard Shortcuts

---

## 1. Login and Access

### Login Screen

- Enter your **Username** and **Password**
- **Caps Lock warning** appears automatically if Caps Lock is on
- **Password show/hide toggle** for easy verification
- Click **Login** to access the system

### Login Lockout

After 5 failed login attempts, the account is temporarily locked:
- First lockout: 1 minute
- Second: 3 minutes
- Third: 5 minutes
- Fourth: 10 minutes
- Fifth: 15 minutes
- Sixth+: 30 minutes

### Session Timeout

- Sessions expire after **8 hours** of inactivity
- A **countdown timer** is shown in the sidebar
- When the session expires, you are redirected to the login screen
- **Single-session enforcement**: logging in elsewhere destroys previous sessions

### Role Permissions

| Feature | Admin | HR |
|---------|-------|----|
| View employees | Yes | Yes |
| Add / Edit employees | Yes | Yes |
| Archive employees | Yes | No |
| Permanent delete | Yes | No |
| View audit trail | Yes | No |
| View/Manage payroll | Yes | Yes |
| Mark as paid | Yes | Yes |
| Generate payslip | Yes | Yes |
| Cash advance management | Yes | Yes |
| Extra payments | Yes | Yes |
| Salary/Bale payments | Yes | Yes |
| Backup management | Yes | No |

---

## 2. Dashboard

The dashboard shows a real-time overview of key metrics:

### Summary Cards

- **Active Employees** — Number of currently active employees
- **Present Today** — Employees with logged attendance today
- **This Week's Salary** — Total salary for the current period
- **Salary Payment** — Total payments made this period
- **Outstanding Balance** — Total unpaid balances
- **Bale Balance** — Total outstanding cash advance debt

### Quick Actions

- **Payroll** — Navigate to payroll management
- **Attendance** — Log daily attendance
- **Employees** — Manage employee records
- **Archive** — View archived employees

---

## 3. Employee Management

### Employee List

- Shows all active employees in a table
- Each row displays: photo, employee number, name, daily rate, phone, government IDs
- Search employees by name or employee number
- Click **+ New Employee** to add

### Add / Edit Employee

| Field | Required | Format | Description |
|-------|----------|--------|-------------|
| Full Name | Yes | Text | Employee's complete name |
| Phone Number | Yes | 11 digits | Unique per employee |
| Daily Rate | Yes | Number | PHP per day |
| SSS Number | Yes | XX-XXXXXXX-X | Government ID |
| PhilHealth Number | Yes | XX-XXXXXXXXX-X | Government ID |
| Pag-IBIG Number | Yes | XXXX-XXXX-XXXX | Government ID |
| TIN Number | Yes | XXX-XXX-XXX-XXX | Tax ID |
| Photo | No | JPEG/PNG | Max 5MB |

### Photo Upload

- Click the camera icon to upload a photo
- Accepted formats: JPEG, PNG
- Maximum size: **5MB**
- Click the photo to view in full size (lightbox)

### Archive Employee (Admin Only)

- Click the archive button on an employee row
- Archived employees move to the Archive view
- Can be restored by Admin

### Permanent Delete (Admin Only)

- Permanently removes employee and all related data
- Remaining employees are renumbered sequentially

---

## 4. Attendance

### Views

- **Weekly View**: Monday to Sunday calendar
- **Monthly View**: Full month calendar with dropdown selector

### Logging Attendance

1. Navigate to the desired week or month
2. Click a day cell to open the attendance form
3. Select employee and mark as present
4. Optionally add time-in, time-out, and notes
5. Save the record

### Navigation

- **Arrow Keys**: Left arrow for previous period, right arrow for next period
- **Week Selector**: Use the date picker to jump to a specific week
- **Period Type**: Toggle between weekly and semi-monthly
- **Search**: Filter employees by name or employee number

### Bulk Attendance

1. Click the **Bulk Attendance** button
2. Select employees to mark
3. Choose the days of the week they were present
4. Click **Save** to mark all selected employees

---

## 5. Payroll

### Period Modes

- **Weekly**: Monday to Sunday 7-day periods
- **Semi-monthly**: Rolling 14-day periods (Monday + 13 days)

Toggle between modes using the period type selector at the top of the payroll view.

### Payroll Table Columns

| Column | Description |
|--------|-------------|
| Employee | Name, employee number, and photo |
| Rate | Daily rate |
| Days Worked | Count of attended days in the period |
| Gross Pay | Days worked x daily rate |
| Cash Advance | Outstanding debt carried over + new advances |
| Extra Payment | Bonuses/adjustments this period |
| Total Due | Gross + Extras |
| Paid | Amount already paid |
| Balance | Remaining unpaid amount |
| Bale Balance | Outstanding cash advance debt |
| Status | Paid / Unpaid / Partial / Generated badge |

### Payment Statuses

- **Unpaid** — No payment recorded or not yet generated
- **Partial** — Some payment made but balance remains
- **Paid** — Fully paid
- **Generated** — Payslip has been generated and period is locked

### Recording Payments

1. Navigate to the desired period
2. Click **Payment** on an employee row
3. Enter the payment amount
4. Amount cannot exceed the total due

### Recording Bale Payments

1. Click **Bale Payment** on an employee row
2. Enter the payment amount
3. Amount cannot exceed the current bale balance

### Generating a Payslip

1. Click **Generate** on an employee row
2. The payslip is finalized and the period is locked
3. **Locked** means no changes can be made to the period
4. Admin can unlock if corrections are needed

---

## 6. Cash Advance (Bale)

- Track cash advances given to employees
- Advances are added to the employee's bale (debt) balance
- One advance per employee per day maximum
- Cannot modify during a locked payroll period

### Adding a Cash Advance

1. Navigate to **Cash Advance** view
2. Click **+ New Advance**
3. Select the employee
4. Enter the amount and date
5. Add optional notes
6. Click **Save**

---

## 7. Extra Payments

- Record bonuses, adjustments, or additional payments
- One extra payment per employee per day maximum
- Added to total earnings for the period
- Cannot modify during a locked payroll period

---

## 8. Salary and Bale Payments

### Salary Payments

- Record salary payments made through the system
- Validated against available balance
- Cannot exceed total due for the period

### Bale Payments

- Record debt repayment payments
- Reduces the employee's outstanding bale balance
- Cannot exceed current bale balance

---

## 9. Archive

- Stores archived employees for record-keeping
- Admin can view and restore archived employees
- Permanent delete removes all data permanently
- HR users can view archives but cannot delete

---

## 10. Audit Trail

- Admin-only comprehensive action log
- Tracks: create, update, delete, archive, restore, permanent delete
- Filter by entity type, action, date range, and search term
- View who performed each action and when

---

## 11. Backup Management

- Auto-backup runs daily at 11 PM (Manila time)
- Maximum 30 backups retained (oldest auto-deleted)
- Manual backup via Admin panel
- Backups stored in backups/ directory
- Configure PG_DUMP_PATH in .env if auto-detection fails

---

## 12. Dark Mode

- Click **Dark Mode** in the sidebar to switch
- Click **Light Mode** to switch back
- Preference is saved in localStorage and persists across sessions
- The login screen always stays in light mode

---

## 13. Keyboard Shortcuts

| Key | Action |
|-----|--------|
| 1 | Dashboard |
| 2 | Payroll |
| 3 | Attendance |
| 4 | Employees |
| 5 | Archive |
| Left Arrow | Previous period |
| Right Arrow | Next period |
| Escape | Close modal |
| Tab | Focus first input on modal open |

Shortcuts do **not** activate when typing in input fields.

---

*End of User Guide*
