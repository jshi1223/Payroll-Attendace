# Weekly Payroll and Attendance System

Node.js + PostgreSQL app for weekly Monday-to-Sunday payroll, attendance logs, cash advances, employee rates, payslips, search/filtering, summary cards, and role access.

## Setup

1. Create the database:

   ```powershell
   createdb -U postgres payroll_attendance
   ```

2. Copy `.env.example` to `.env` and update `DATABASE_URL`.

3. Install dependencies:

   ```powershell
   npm install
   ```

4. Initialize tables:

   ```powershell
   npm run db:init
   ```

5. Run:

   ```powershell
   npm start
   ```

Open `http://localhost:3001` after starting the app.

User accounts are stored in the PostgreSQL `users` table. The login form does not prefill credentials.

HR can create, read, and update. Admin can create, read, update, and delete.
