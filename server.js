require('dotenv').config();

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const crypto = require('crypto');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable is required.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET environment variable is required.');
  process.exit(1);
}


const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const PORT = process.env.PORT || 3001;

const uploadsDir = path.join(__dirname, 'attendance_system', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

/* Shared face/photo directory (same folder the attendance system uses) */
const attendanceFaceDir = process.env.ATTENDANCE_FACE_DIR || path.join(__dirname, 'attendance_system', 'backend', 'face_images');
if (!fs.existsSync(attendanceFaceDir)) fs.mkdirSync(attendanceFaceDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, attendanceFaceDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `emp_${req.params.id}_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files allowed.'));
    cb(null, true);
  }
});

app.use('/uploads', express.static(uploadsDir));

/* Attendance system face images (served to admin panel for approval review) */
app.use('/attendance-faces', express.static(attendanceFaceDir));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new pgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8
  }
}));
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again later.' }
});

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(c => {
    const [key, ...val] = c.split('=');
    if (key) cookies[key.trim()] = decodeURIComponent(val.join('='));
  });
  return cookies;
}

function csrfProtection(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  if (!req.session?.user) return next();
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies.csrf_token;
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Invalid CSRF token.' });
  }
  next();
}

app.use(csrfProtection);

app.use(express.static(path.join(__dirname, 'attendance_system', 'public')));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Login required.' });
  next();
}

async function isWeekLocked(employeeId, weekStart) {
  const result = await pool.query(
    `SELECT status FROM payroll_statuses WHERE employee_id = $1 AND week_start = $2 AND status = 'generated'`,
    [employeeId, weekStart]
  );
  return result.rowCount > 0;
}

async function isDateLockedForEmployee(employeeId, date) {
  const emp = await pool.query('SELECT pay_period_days FROM employees WHERE id = $1', [employeeId]);
  if (!emp.rowCount) return false;
  const periodDays = getPeriodDays(emp.rows[0].pay_period_days);
  const periodStart = periodStartOf(date, periodDays);
  return isWeekLocked(employeeId, periodStart);
}

function requireAdmin(req, res, next) {
  if (req.session.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

function validateIdParam(req, res, next) {
  if (!/^\d+$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid ID parameter.' });
  }
  next();
}

function parseDateOnly(dateInput) {
  if (dateInput instanceof Date) return new Date(Date.UTC(dateInput.getFullYear(), dateInput.getMonth(), dateInput.getDate()));
  if (typeof dateInput === 'string' && dateInput.includes('T')) {
    const d = new Date(dateInput);
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }
  const value = typeof dateInput === 'string' ? dateInput.slice(0, 10) : todayInManila();
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateOnly(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function todayInManila() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function weekStartOf(dateInput) {
  const date = parseDateOnly(dateInput);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - day);
  return formatDateOnly(date);
}

function payrollWeekStartOf(dateInput) {
  const date = parseDateOnly(dateInput);
  const day = date.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + offset);
  return formatDateOnly(date);
}

function addDays(dateInput, days) {
  const date = parseDateOnly(dateInput);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateOnly(date);
}

function daysBetween(dateA, dateB) {
  const a = parseDateOnly(dateA);
  const b = parseDateOnly(dateB);
  return Math.round((b - a) / 86400000);
}

const PERIOD_ANCHOR = '2020-01-06';

function periodStartOf(dateInput, periodDays = 7) {
  const monday = payrollWeekStartOf(dateInput);
  const diff = daysBetween(PERIOD_ANCHOR, monday);
  const periodIndex = Math.floor(diff / periodDays);
  return addDays(PERIOD_ANCHOR, periodIndex * periodDays);
}

function periodEndOf(dateInput, periodDays = 7) {
  return addDays(periodStartOf(dateInput, periodDays), periodDays - 1);
}

function getPeriodDays(periodDays) {
  return Math.max(1, Math.floor(Number(periodDays) || 7));
}

function money(value) {
  return Number(value || 0);
}

/* Government ID format validation */
const GOV_ID_VALIDATORS = {
  sss_number: {
    regex: /^\d{2}-\d{7}-\d$/,
    label: 'SSS Number',
    hint: 'Format: 12-3456789-0 (10 digits)'
  },
  philhealth_number: {
    regex: /^\d{2}-\d{9}-\d$/,
    label: 'PhilHealth Number',
    hint: 'Format: 12-345678901-2 (12 digits)'
  },
  pagibig_number: {
    regex: /^\d{4}-\d{4}-\d{4}$/,
    label: 'Pag-IBIG Number',
    hint: 'Format: 1234-5678-9012 (12 digits)'
  },
  tin_number: {
    regex: /^\d{3}-\d{3}-\d{3}-\d{3}$/,
    label: 'TIN Number',
    hint: 'Format: 123-456-789-012 (12 digits)'
  }
};

function validateGovIds(body) {
  for (const [field, validator] of Object.entries(GOV_ID_VALIDATORS)) {
    const value = (body[field] || '').trim();
    if (value && !validator.regex.test(value)) {
      return { valid: false, message: `${validator.label} format is invalid. ${validator.hint}` };
    }
  }
  return { valid: true };
}

function calculatePayrollWeekState({ previousBaleBalance = 0, previousUnpaidBalance = 0, salary = 0, cashAdvance = 0, salaryPaidAmount = 0, deductBale = false, balePaymentAmount = 0, extraPayment = 0 }) {
  const paymentToPreviousUnpaid = Math.min(salaryPaidAmount, previousUnpaidBalance);
  const currentSalaryPaidAmount = Math.min(Math.max(salaryPaidAmount - paymentToPreviousUnpaid, 0), salary);
  const totalBale = previousBaleBalance + cashAdvance;

  let baleDeduction, remainingBaleBalance, takeHome, currentUnpaidBalance;
  if (deductBale && salary === 0) {
    // When no work (no salary), payment goes directly to reduce bale
    const afterPreviousUnpaid = Math.max(salaryPaidAmount - paymentToPreviousUnpaid, 0);
    baleDeduction = Math.min(totalBale, afterPreviousUnpaid);
    remainingBaleBalance = Math.max(totalBale - baleDeduction - balePaymentAmount, 0);
    takeHome = 0;
    currentUnpaidBalance = Math.max(takeHome - currentSalaryPaidAmount - balePaymentAmount, 0);

  } else {
    // Cash advance (bale) increases bale balance (debt tracking)
    // Bale payments only reduce bale balance, NOT salary balance
    baleDeduction = 0;
    remainingBaleBalance = Math.max(totalBale - balePaymentAmount, 0);
    takeHome = Math.max(salary, 0);
    currentUnpaidBalance = Math.max(takeHome - currentSalaryPaidAmount, 0);
  }

  // Any salary payment that exceeds salary goes towards extra pay
  const salaryExcessForExtra = Math.max(salaryPaidAmount - paymentToPreviousUnpaid - currentSalaryPaidAmount, 0);
  const effectiveExtraPay = Math.max(extraPayment - salaryExcessForExtra, 0);

  const balance = Math.max(previousUnpaidBalance - paymentToPreviousUnpaid, 0) + currentUnpaidBalance;
  const paymentLimit = Math.max(0, previousUnpaidBalance + Math.max(salary, 0) + extraPayment) + (deductBale && salary === 0 ? totalBale : 0);

  return {
    totalBale,
    baleDeduction,
    remainingBaleBalance,
    takeHome,
    balance,
    paymentLimit,
    currentSalaryPaidAmount,
    paymentToPreviousUnpaid,
    effectiveExtraPay
  };
}

async function assertPaymentWithinBalance(employee_id, paymentDate, newAmount, type, excludeId) {
  const empResult = await pool.query('SELECT pay_period_days FROM employees WHERE id = $1', [employee_id]);
  const empPeriodDays = getPeriodDays(empResult.rows[0]?.pay_period_days);
  const weekStart = periodStartOf(paymentDate, empPeriodDays);
  const weekEnd = addDays(weekStart, empPeriodDays - 1);

  const salaryParams = [employee_id, weekStart, weekEnd];
  const salaryExclude = (type === 'salary' && excludeId) ? ` AND id != $4` : '';
  if (salaryExclude) salaryParams.push(Number(excludeId));

  const baleParams = [employee_id, weekStart, weekEnd];
  const baleExclude = (type === 'bale' && excludeId) ? ` AND id != $4` : '';
  if (baleExclude) baleParams.push(Number(excludeId));

  const [totals, carryovers, payStatus, salaryPays, balePays, extraPays] = await Promise.all([
    pool.query(`
      WITH attendance AS (
        SELECT COALESCE(SUM(rate_snapshot), 0)::numeric(12,2) AS salary
        FROM attendance_logs
        WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3
      ),
      advances AS (
        SELECT COALESCE(SUM(amount), 0)::numeric(12,2) AS cash_advance
        FROM cash_advances
        WHERE employee_id = $1 AND advance_date BETWEEN $2 AND $3
      )
      SELECT attendance.salary, advances.cash_advance
      FROM attendance, advances`,
      [employee_id, weekStart, weekEnd]),
    getPayrollCarryoversBefore(employee_id, weekStart, empPeriodDays),
    pool.query(`SELECT COALESCE(paid_amount, 0)::numeric(12,2) AS paid_amount
      FROM payroll_statuses WHERE employee_id = $1 AND week_start = $2`,
      [employee_id, weekStart]),
    pool.query(`SELECT COALESCE(SUM(amount), 0)::numeric(12,2) AS total
      FROM salary_payments
      WHERE employee_id = $1 AND payment_date BETWEEN $2 AND $3${salaryExclude}`,
      salaryParams),
    pool.query(`SELECT COALESCE(SUM(amount), 0)::numeric(12,2) AS total
      FROM bale_payments
      WHERE employee_id = $1 AND payment_date BETWEEN $2 AND $3${baleExclude}`,
      baleParams),
    pool.query(`SELECT COALESCE(SUM(amount), 0)::numeric(12,2) AS total
      FROM extra_payments
      WHERE employee_id = $1 AND extra_date BETWEEN $2 AND $3`,
      [employee_id, weekStart, weekEnd])
  ]);

  const salary = money(totals.rows[0]?.salary);
  const cashAdvance = money(totals.rows[0]?.cash_advance);
  const existingSalaryPaid = money(salaryPays.rows[0]?.total) + money(payStatus.rows[0]?.paid_amount);
  const existingBalePaid = money(balePays.rows[0]?.total);
  const existingExtraPaid = money(extraPays.rows[0]?.total);

  /* Compute available balance using EXISTING payments only */
  const weekState = calculatePayrollWeekState({
    previousBaleBalance: carryovers.baleBalance,
    previousUnpaidBalance: carryovers.unpaidBalance,
    salary,
    cashAdvance,
    salaryPaidAmount: existingSalaryPaid,
    balePaymentAmount: existingBalePaid,
    extraPayment: existingExtraPaid
  });

  if (type === 'bale') {
    if (Number(newAmount) > weekState.remainingBaleBalance) {
      throw new Error('Insufficient advance balance for this payment.');
    }
    if (Number(newAmount) > weekState.balance) {
      throw new Error('Insufficient salary balance for advance payment.');
    }
  } else {
    if (Number(newAmount) > weekState.balance) {
      throw new Error('Insufficient balance for this payment.');
    }
  }
}

async function getPayrollCarryoversBefore(employeeId, weekStart, periodDays = 7) {
  const pd = getPeriodDays(periodDays);
  const result = await pool.query(
    `WITH
     salary_weeks AS (
       SELECT (DATE '2020-01-06' + FLOOR(((work_date + (CASE WHEN EXTRACT(DOW FROM work_date) = 0 THEN -6 ELSE 1 - EXTRACT(DOW FROM work_date) END)::int)::date - DATE '2020-01-06')::float / ($3)::int)::int * ($3)::int)::date AS period_start,
         SUM(rate_snapshot)::numeric(12,2) AS salary
       FROM attendance_logs
       WHERE employee_id = $1 AND work_date < $2
       GROUP BY 1
     ),
     advance_weeks AS (
       SELECT (DATE '2020-01-06' + FLOOR(((advance_date + (CASE WHEN EXTRACT(DOW FROM advance_date) = 0 THEN -6 ELSE 1 - EXTRACT(DOW FROM advance_date) END)::int)::date - DATE '2020-01-06')::float / ($3)::int)::int * ($3)::int)::date AS period_start,
         SUM(amount)::numeric(12,2) AS advance
       FROM cash_advances
       WHERE employee_id = $1 AND advance_date < $2
       GROUP BY 1
     ),
     extra_weeks AS (
       SELECT (DATE '2020-01-06' + FLOOR(((extra_date + (CASE WHEN EXTRACT(DOW FROM extra_date) = 0 THEN -6 ELSE 1 - EXTRACT(DOW FROM extra_date) END)::int)::date - DATE '2020-01-06')::float / ($3)::int)::int * ($3)::int)::date AS period_start,
         SUM(amount)::numeric(12,2) AS extra
       FROM extra_payments
       WHERE employee_id = $1 AND extra_date < $2
       GROUP BY 1
     ),
     payment_weeks AS (
       SELECT week_start AS period_start,
         SUM(paid_amount)::numeric(12,2) AS payment,
         bool_or(bale_deducted) AS bale_deducted
       FROM payroll_statuses
       WHERE employee_id = $1 AND week_start < $2
       GROUP BY week_start
     ),
     bale_payment_weeks AS (
       SELECT (DATE '2020-01-06' + FLOOR(((payment_date + (CASE WHEN EXTRACT(DOW FROM payment_date) = 0 THEN -6 ELSE 1 - EXTRACT(DOW FROM payment_date) END)::int)::date - DATE '2020-01-06')::float / ($3)::int)::int * ($3)::int)::date AS period_start,
         SUM(amount)::numeric(12,2) AS bale_paid
       FROM bale_payments
       WHERE employee_id = $1 AND payment_date < $2
       GROUP BY 1
     ),
     salary_pay_weeks AS (
       SELECT (DATE '2020-01-06' + FLOOR(((payment_date + (CASE WHEN EXTRACT(DOW FROM payment_date) = 0 THEN -6 ELSE 1 - EXTRACT(DOW FROM payment_date) END)::int)::date - DATE '2020-01-06')::float / ($3)::int)::int * ($3)::int)::date AS period_start,
         SUM(amount)::numeric(12,2) AS salary_pay
       FROM salary_payments
       WHERE employee_id = $1 AND payment_date < $2
       GROUP BY 1
     ),
     periods AS (
       SELECT period_start FROM salary_weeks
       UNION
       SELECT period_start FROM advance_weeks
       UNION
       SELECT period_start FROM extra_weeks
       UNION
       SELECT period_start FROM payment_weeks
       UNION
       SELECT period_start FROM bale_payment_weeks
       UNION
       SELECT period_start FROM salary_pay_weeks
     )
     SELECT w.period_start,
       COALESCE(s.salary, 0)::numeric(12,2) AS salary,
       COALESCE(a.advance, 0)::numeric(12,2) AS advance,
       COALESCE(ex.extra, 0)::numeric(12,2) AS extra,
       (COALESCE(p.payment, 0) + COALESCE(sp.salary_pay, 0))::numeric(12,2) AS payment,
       COALESCE(p.bale_deducted, false) AS bale_deducted,
       COALESCE(bp.bale_paid, 0)::numeric(12,2) AS bale_paid
     FROM periods w
     LEFT JOIN salary_weeks s ON s.period_start = w.period_start
     LEFT JOIN advance_weeks a ON a.period_start = w.period_start
     LEFT JOIN extra_weeks ex ON ex.period_start = w.period_start
     LEFT JOIN payment_weeks p ON p.period_start = w.period_start
     LEFT JOIN bale_payment_weeks bp ON bp.period_start = w.period_start
     LEFT JOIN salary_pay_weeks sp ON sp.period_start = w.period_start
     ORDER BY w.period_start ASC`,
    [employeeId, weekStart, pd]
  );

  return result.rows.reduce((state, row) => {
    const weekState = calculatePayrollWeekState({
      previousBaleBalance: state.baleBalance,
      previousUnpaidBalance: state.unpaidBalance,
      salary: money(row.salary),
      cashAdvance: money(row.advance),
      salaryPaidAmount: money(row.payment),
      deductBale: row.bale_deducted,
      balePaymentAmount: money(row.bale_paid),
      extraPayment: money(row.extra)
    });
    return {
      baleBalance: weekState.remainingBaleBalance,
      unpaidBalance: weekState.balance
    };
  }, { baleBalance: 0, unpaidBalance: 0 });
}

async function getPayrollCarryoversBulk(employeeIds, weekStart, periodDays = 7) {
  if (!employeeIds.length) return new Map();
  const pd = getPeriodDays(periodDays);
  const result = await pool.query(
    `WITH
     salary_weeks AS (
       SELECT employee_id,
         (DATE '2020-01-06' + FLOOR(((work_date + (CASE WHEN EXTRACT(DOW FROM work_date) = 0 THEN -6 ELSE 1 - EXTRACT(DOW FROM work_date) END)::int)::date - DATE '2020-01-06')::float / ($2)::int)::int * ($2)::int)::date AS period_start,
         SUM(rate_snapshot)::numeric(12,2) AS salary
       FROM attendance_logs
       WHERE employee_id = ANY($3) AND work_date < $1
       GROUP BY 1, 2
     ),
     advance_weeks AS (
       SELECT employee_id,
         (DATE '2020-01-06' + FLOOR(((advance_date + (CASE WHEN EXTRACT(DOW FROM advance_date) = 0 THEN -6 ELSE 1 - EXTRACT(DOW FROM advance_date) END)::int)::date - DATE '2020-01-06')::float / ($2)::int)::int * ($2)::int)::date AS period_start,
         SUM(amount)::numeric(12,2) AS advance
       FROM cash_advances
       WHERE employee_id = ANY($3) AND advance_date < $1
       GROUP BY 1, 2
     ),
     extra_weeks AS (
       SELECT employee_id,
         (DATE '2020-01-06' + FLOOR(((extra_date + (CASE WHEN EXTRACT(DOW FROM extra_date) = 0 THEN -6 ELSE 1 - EXTRACT(DOW FROM extra_date) END)::int)::date - DATE '2020-01-06')::float / ($2)::int)::int * ($2)::int)::date AS period_start,
         SUM(amount)::numeric(12,2) AS extra
       FROM extra_payments
       WHERE employee_id = ANY($3) AND extra_date < $1
       GROUP BY 1, 2
     ),
     payment_weeks AS (
       SELECT employee_id,
         week_start AS period_start,
         SUM(paid_amount)::numeric(12,2) AS payment,
         bool_or(bale_deducted) AS bale_deducted
       FROM payroll_statuses
       WHERE employee_id = ANY($3) AND week_start < $1
       GROUP BY employee_id, week_start
     ),
     bale_payment_weeks AS (
       SELECT employee_id,
         (DATE '2020-01-06' + FLOOR(((payment_date + (CASE WHEN EXTRACT(DOW FROM payment_date) = 0 THEN -6 ELSE 1 - EXTRACT(DOW FROM payment_date) END)::int)::date - DATE '2020-01-06')::float / ($2)::int)::int * ($2)::int)::date AS period_start,
         SUM(amount)::numeric(12,2) AS bale_paid
       FROM bale_payments
       WHERE employee_id = ANY($3) AND payment_date < $1
       GROUP BY 1, 2
     ),
     salary_pay_weeks AS (
       SELECT employee_id,
         (DATE '2020-01-06' + FLOOR(((payment_date + (CASE WHEN EXTRACT(DOW FROM payment_date) = 0 THEN -6 ELSE 1 - EXTRACT(DOW FROM payment_date) END)::int)::date - DATE '2020-01-06')::float / ($2)::int)::int * ($2)::int)::date AS period_start,
         SUM(amount)::numeric(12,2) AS salary_pay
       FROM salary_payments
       WHERE employee_id = ANY($3) AND payment_date < $1
       GROUP BY 1, 2
     ),
     all_period_data AS (
       SELECT employee_id, period_start FROM salary_weeks
       UNION SELECT employee_id, period_start FROM advance_weeks
       UNION SELECT employee_id, period_start FROM extra_weeks
       UNION SELECT employee_id, period_start FROM payment_weeks
       UNION SELECT employee_id, period_start FROM bale_payment_weeks
       UNION SELECT employee_id, period_start FROM salary_pay_weeks
     )
     SELECT apd.employee_id, apd.period_start,
       COALESCE(s.salary, 0)::numeric(12,2) AS salary,
       COALESCE(a.advance, 0)::numeric(12,2) AS advance,
       COALESCE(ex.extra, 0)::numeric(12,2) AS extra,
       (COALESCE(p.payment, 0) + COALESCE(sp.salary_pay, 0))::numeric(12,2) AS payment,
       COALESCE(p.bale_deducted, false) AS bale_deducted,
       COALESCE(bp.bale_paid, 0)::numeric(12,2) AS bale_paid
     FROM all_period_data apd
     LEFT JOIN salary_weeks s ON s.employee_id = apd.employee_id AND s.period_start = apd.period_start
     LEFT JOIN advance_weeks a ON a.employee_id = apd.employee_id AND a.period_start = apd.period_start
     LEFT JOIN extra_weeks ex ON ex.employee_id = apd.employee_id AND ex.period_start = apd.period_start
     LEFT JOIN payment_weeks p ON p.employee_id = apd.employee_id AND p.period_start = apd.period_start
     LEFT JOIN bale_payment_weeks bp ON bp.employee_id = apd.employee_id AND bp.period_start = apd.period_start
     LEFT JOIN salary_pay_weeks sp ON sp.employee_id = apd.employee_id AND sp.period_start = apd.period_start
     ORDER BY apd.employee_id, apd.period_start ASC`,
    [weekStart, pd, employeeIds]
  );

  const carryoverMap = new Map();
  for (const empId of employeeIds) {
    carryoverMap.set(empId, { baleBalance: 0, unpaidBalance: 0 });
  }

  const grouped = {};
  for (const row of result.rows) {
    if (!grouped[row.employee_id]) grouped[row.employee_id] = [];
    grouped[row.employee_id].push(row);
  }

  for (const [empId, rows] of Object.entries(grouped)) {
    const state = rows.reduce((s, row) => {
      const weekState = calculatePayrollWeekState({
        previousBaleBalance: s.baleBalance,
        previousUnpaidBalance: s.unpaidBalance,
        salary: money(row.salary),
        cashAdvance: money(row.advance),
        salaryPaidAmount: money(row.payment),
        deductBale: row.bale_deducted,
        balePaymentAmount: money(row.bale_paid),
        extraPayment: money(row.extra)
      });
      return {
        baleBalance: weekState.remainingBaleBalance,
        unpaidBalance: weekState.balance
      };
    }, { baleBalance: 0, unpaidBalance: 0 });
    carryoverMap.set(Number(empId), state);
  }

  return carryoverMap;
}

function workingDaysInPeriod(periodStart, periodDays = 7, currentDate = todayInManila()) {
  const today = currentDate.slice(0, 10);
  const periodEnd = addDays(periodStart, periodDays - 1);

  if (today < periodStart) return 0;

  const cutoff = today > periodEnd ? periodEnd : today;
  return Array.from({ length: periodDays }, (_, index) => addDays(periodStart, index))
    .filter(date => date >= periodStart && date <= cutoff)
    .length;
}

async function initDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
  /* Migration for databases created before users.updated_at was introduced. */
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false`);
  await pool.query('ALTER TABLE attendance_logs ALTER COLUMN time_in DROP NOT NULL');
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500)`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS first_name VARCHAR(80) NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_name VARCHAR(80) NOT NULL DEFAULT ''`);
  /* Migrate existing name data into first_name/last_name */
  await pool.query(`
    UPDATE employees SET
      first_name = CASE WHEN position(' ' IN TRIM(name)) > 0 THEN substring(TRIM(name) FROM 1 FOR position(' ' IN TRIM(name)) - 1) ELSE TRIM(name) END,
      last_name = CASE WHEN position(' ' IN TRIM(name)) > 0 THEN substring(TRIM(name) FROM position(' ' IN TRIM(name)) + 1) ELSE '' END
    WHERE first_name = '' OR last_name = ''
  `);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS sss_number VARCHAR(12) NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS philhealth_number VARCHAR(14) NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS pagibig_number VARCHAR(14) NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS tin_number VARCHAR(15) NOT NULL DEFAULT ''`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll_statuses (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      week_start DATE NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'unpaid' CHECK (status IN ('paid', 'unpaid', 'generated')),
      paid_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
      extra_payment_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (extra_payment_amount >= 0),
      extra_payment_notes TEXT DEFAULT '',
      paid_at TIMESTAMPTZ,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (employee_id, week_start)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_statuses_week ON payroll_statuses(week_start);
    ALTER TABLE payroll_statuses
    ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0);
    ALTER TABLE payroll_statuses
    ADD COLUMN IF NOT EXISTS extra_payment_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (extra_payment_amount >= 0);
    ALTER TABLE payroll_statuses
    ADD COLUMN IF NOT EXISTS extra_payment_notes TEXT DEFAULT '';
    ALTER TABLE payroll_statuses
    ADD COLUMN IF NOT EXISTS bale_deducted BOOLEAN NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(80) NOT NULL,
      entity VARCHAR(80) NOT NULL,
      entity_id INTEGER,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entity_id);
    CREATE TABLE IF NOT EXISTS extra_payments (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
      extra_date DATE NOT NULL,
      notes TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_extra_payments_date ON extra_payments(extra_date);
    CREATE TABLE IF NOT EXISTS bale_payments (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
      payment_date DATE NOT NULL,
      notes TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bale_payments_date ON bale_payments(payment_date);
    CREATE TABLE IF NOT EXISTS salary_payments (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
      payment_date DATE NOT NULL,
      notes TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_salary_payments_date ON salary_payments(payment_date);
  `);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone VARCHAR(20) NOT NULL DEFAULT ''`);
  /* Ensure no duplicates before adding unique constraint on phone */
  await pool.query(`
    UPDATE employees SET phone = CONCAT('0000000000', id)
    WHERE phone = '' OR phone IS NULL;
  `);
  /* Fix any remaining duplicate phone numbers */
  await pool.query(`
    UPDATE employees e
    SET phone = CONCAT(e.phone, '_', e.id)
    FROM (
      SELECT phone FROM employees
      GROUP BY phone HAVING COUNT(*) > 1
    ) dup
    WHERE e.phone = dup.phone AND e.phone !~ '_';
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'employees' AND indexname = 'idx_employees_phone_unique'
      ) THEN
        CREATE UNIQUE INDEX idx_employees_phone_unique ON employees(phone);
      END IF;
    END $$;
  `);
  await pool.query(`
    /* Reset auto-generated phone numbers back to proper 11-digit format */
    UPDATE employees SET phone = LPAD(FLOOR(RANDOM() * 100000000000)::text, 11, '1')
    WHERE phone ~ '^0000000000' OR phone ~ '_';
  `);
  /* Ensure no duplicates before adding unique indexes on government IDs */
  const govIdIndexes = [
    { col: 'sss_number', name: 'idx_employees_sss_unique' },
    { col: 'philhealth_number', name: 'idx_employees_philhealth_unique' },
    { col: 'pagibig_number', name: 'idx_employees_pagibig_unique' },
    { col: 'tin_number', name: 'idx_employees_tin_unique' }
  ];
  for (const idx of govIdIndexes) {
    /* Deduplicate by keeping only the earliest employee per duplicate value */
    await pool.query(`
      WITH dupes AS (
        SELECT ${idx.col}, MIN(id) AS keep_id
        FROM employees
        WHERE ${idx.col} != ''
        GROUP BY ${idx.col}
        HAVING COUNT(*) > 1
      )
      UPDATE employees e
      SET ${idx.col} = CONCAT(e.${idx.col}, '_DUP_', e.id)
      FROM dupes
      WHERE e.${idx.col} = dupes.${idx.col}
        AND e.id != dupes.keep_id
        AND POSITION('_DUP_' IN e.${idx.col}) = 0
    `);
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE tablename = 'employees' AND indexname = '${idx.name}'
        ) THEN
          CREATE UNIQUE INDEX ${idx.name} ON employees(${idx.col}) WHERE ${idx.col} != '';
        END IF;
      END $$;
    `);
  }

  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'attendance_logs_employee_id_fkey'
        AND confdeltype <> 'c'
      ) THEN
        ALTER TABLE attendance_logs
          DROP CONSTRAINT attendance_logs_employee_id_fkey,
          ADD CONSTRAINT attendance_logs_employee_id_fkey
            FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'cash_advances_employee_id_fkey'
        AND confdeltype <> 'c'
      ) THEN
        ALTER TABLE cash_advances
          DROP CONSTRAINT cash_advances_employee_id_fkey,
          ADD CONSTRAINT cash_advances_employee_id_fkey
            FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `);
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS employee_number_seq START 1;
    ALTER TABLE employees
    ALTER COLUMN emp_number SET DEFAULT ('EMP-' || LPAD(nextval('employee_number_seq')::text, 5, '0'));
    WITH last_number AS (
      SELECT COALESCE(MAX((regexp_match(emp_number, '[0-9]+$'))[1]::int), 0) AS value
      FROM employees
      WHERE emp_number ~ '[0-9]+$'
    )
    SELECT setval(
      'employee_number_seq',
      CASE WHEN value < 1 THEN 1 ELSE value END,
      value >= 1
    )
    FROM last_number;
  `);
  /* Allow 'generated' status in payroll_statuses for payslip lock */
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'payroll_statuses_status_check'
      ) THEN
        ALTER TABLE payroll_statuses DROP CONSTRAINT payroll_statuses_status_check;
      END IF;
      ALTER TABLE payroll_statuses ADD CONSTRAINT payroll_statuses_status_check CHECK (status IN ('paid', 'unpaid', 'generated'));
    END $$;
  `);

  /* ── Attendance system integration (shared DB, `attendance` schema) ── */
  await pool.query(`CREATE SCHEMA IF NOT EXISTS attendance`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance.employees (
      id SERIAL PRIMARY KEY,
      employee_id VARCHAR(50) NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NULL,
      phone VARCHAR(50) NULL,
      password_hash VARCHAR(255) NULL,
      daily_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
      face_image VARCHAR(255) NULL,
      face_left VARCHAR(255) NULL,
      face_right VARCHAR(255) NULL,
      face_encoding TEXT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      admin_notes TEXT NULL,
      registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_at TIMESTAMP NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance.attendance (
      id SERIAL PRIMARY KEY,
      employee_id VARCHAR(50) NOT NULL,
      type VARCHAR(20) NOT NULL,
      rate_snapshot DECIMAL(10,2) NULL,
      timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_attendance_employee
        FOREIGN KEY (employee_id) REFERENCES attendance.employees(employee_id) ON DELETE CASCADE
    )
  `);
  await pool.query(`ALTER TABLE attendance.employees ADD COLUMN IF NOT EXISTS payroll_employee_id INTEGER`);
  await pool.query(`ALTER TABLE attendance.employees ADD COLUMN IF NOT EXISTS government_id VARCHAR(50) NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL`);

  /* Payroll review/acceptance step before bulk printing */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll_reviews (
      period_key VARCHAR(20) PRIMARY KEY,
      period_days INTEGER NOT NULL DEFAULT 7,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  const defaultUsers = [];
  const bootstrapAdmin = { username: process.env.BOOTSTRAP_USERNAME || 'admin', password: process.env.BOOTSTRAP_PASSWORD, role: process.env.BOOTSTRAP_ROLE || 'admin' };
  const bootstrapHr = { username: process.env.BOOTSTRAP_HR_USERNAME || 'hr', password: process.env.BOOTSTRAP_HR_PASSWORD, role: process.env.BOOTSTRAP_HR_ROLE || 'hr' };
  if (bootstrapAdmin.password) defaultUsers.push(bootstrapAdmin);
  else console.log('  Skip creating admin: BOOTSTRAP_PASSWORD is not set.');
  if (bootstrapHr.password) defaultUsers.push(bootstrapHr);
  else console.log('  Skip creating HR user: BOOTSTRAP_HR_PASSWORD is not set.');

  for (const u of defaultUsers) {
    const exists = await pool.query('SELECT id, role, must_change_password FROM users WHERE username = $1', [u.username]);
    if (!exists.rowCount) {
      const hash = await bcrypt.hash(u.password, 10);
      await pool.query(
        'INSERT INTO users (username, password_hash, role, must_change_password) VALUES ($1, $2, $3, false)',
        [u.username, hash, u.role]
      );
      console.log(`  Created user: ${u.username} (${u.role})`);
    } else {
      const existing = exists.rows[0];
      if (existing.role !== u.role || existing.must_change_password) {
        await pool.query('UPDATE users SET role = $1, must_change_password = false, updated_at = NOW() WHERE id = $2', [u.role, existing.id]);
        console.log(`  Updated user: ${u.username} (${u.role})`);
      }
    }
  }

}

async function logAudit(userId, action, entity, entityId, details = {}) {
  await pool.query(
    `INSERT INTO audit_logs (user_id, action, entity, entity_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId || null, action, entity, entityId || null, details]
  );
}

app.get('/api/me', async (req, res) => {
  let sessionTTL = null;
  if (req.session?.cookie?._expires) {
    sessionTTL = Math.max(0, Math.floor((new Date(req.session.cookie._expires) - new Date()) / 1000));
  }
  let lastLogin = null;
  if (req.session?.user?.id) {
    try {
      const lr = await pool.query(
        `SELECT created_at FROM audit_logs WHERE user_id = $1 AND action = 'login' ORDER BY created_at DESC LIMIT 1 OFFSET 1`,
        [req.session.user.id]
      );
      if (lr.rowCount > 0) lastLogin = lr.rows[0].created_at;
    } catch (_) { /* ignore */ }
  }
  res.json({ user: req.session.user || null, sessionTTL, csrfToken: req.session?.csrfToken || null, lastLogin });
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const sessionUser = { id: user.id, username: user.username, role: user.role, must_change_password: user.must_change_password || false };
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error.' });
    req.session.user = sessionUser;
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: 'Session error.' });
      const sessionTTL = req.session?.cookie?.maxAge ? Math.floor(req.session.cookie.maxAge / 1000) : null;
      const csrfToken = generateCsrfToken();
      req.session.csrfToken = csrfToken;
      res.cookie('csrf_token', csrfToken, {
        httpOnly: false,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 8
      });
      logAudit(user.id, 'login', 'session', user.id, { username: user.username });
      res.json({ user: req.session.user, sessionTTL, csrfToken });
    });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/employees', requireAuth, async (req, res) => {
  const search = `%${req.query.search || ''}%`;
  const active = req.query.active;
  const params = [search];
  let where = 'WHERE (emp_number ILIKE $1 OR name ILIKE $1 OR email ILIKE $1 OR sss_number ILIKE $1 OR philhealth_number ILIKE $1 OR pagibig_number ILIKE $1 OR tin_number ILIKE $1)';
  if (active === 'true' || active === 'false') {
    params.push(active === 'true');
    where += ` AND active = $${params.length}`;
  } else if (active !== 'all') {
    where += ' AND active = true';
  }
  const result = await pool.query(
    `SELECT * FROM employees ${where} ORDER BY name ASC`,
    params
  );
  res.json(result.rows);
});

app.post('/api/employees', requireAuth, async (req, res) => {
  const { first_name, last_name, name, phone, rate, active = true, pay_period_days = 7 } = req.body;
  const empFirstName = (first_name || '').trim();
  const empLastName = (last_name || '').trim();
  const empName = empFirstName && empLastName ? `${empFirstName} ${empLastName}` : (name || '').trim();
  if (!empName) return res.status(400).json({ error: 'Employee first and last name are required.' });
  if (!phone?.trim()) return res.status(400).json({ error: 'Phone number is required.' });
  if (!/^[0-9]{11}$/.test(phone.trim())) {
    return res.status(400).json({ error: 'Phone number must be exactly 11 digits (numbers only).' });
  }
  if (rate === undefined || rate === '' || Number(rate) < 500) {
    return res.status(400).json({ error: 'Daily rate must be at least ₱500.00.' });
  }

  /* Validate government ID formats */
  const govIdResult = validateGovIds(req.body);
  if (!govIdResult.valid) {
    return res.status(400).json({ error: govIdResult.message });
  }

  /* Check government ID uniqueness */
  const govIdFields = ['sss_number', 'philhealth_number', 'pagibig_number', 'tin_number'];
  const govIdLabels = { sss_number: 'SSS Number', philhealth_number: 'PhilHealth Number', pagibig_number: 'Pag-IBIG Number', tin_number: 'TIN Number' };
  for (const field of govIdFields) {
    const value = (req.body[field] || '').trim();
    if (value) {
      const existing = await pool.query(`SELECT id FROM employees WHERE ${field} = $1 AND ${field} != ''`, [value]);
      if (existing.rowCount > 0) {
        return res.status(409).json({ error: `${govIdLabels[field]} is already in use by another employee.` });
      }
    }
  }

  const periodDays = Math.max(1, Math.floor(Number(pay_period_days) || 7));

  /* Check phone uniqueness */
  const existingPhone = await pool.query(
    'SELECT id FROM employees WHERE phone = $1',
    [phone.trim()]
  );
  if (existingPhone.rowCount > 0) {
    return res.status(409).json({ error: 'Phone number is already in use by another employee.' });
  }

  const email = String(req.body.email || '').trim().toLowerCase();
  const tempPassword = String(req.body.password || '');
  if (tempPassword && !email) {
    return res.status(400).json({ error: 'Email is required to create a mobile login for the employee.' });
  }
  if (tempPassword && tempPassword.length < 8) {
    return res.status(400).json({ error: 'Temporary password must be at least 8 characters.' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (email) {
    const emailCheck = await pool.query(
      'SELECT id FROM attendance.employees WHERE LOWER(email) = $1',
      [email]
    );
    if (emailCheck.rowCount > 0) {
      return res.status(409).json({ error: 'Email is already in use by another mobile account.' });
    }
  }

  const empNumber = await pool.query(
    `SELECT ('EMP-' || LPAD(nextval('employee_number_seq')::text, 5, '0')) AS emp_number`
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO employees (emp_number, first_name, last_name, name, phone, email, rate, pay_period_days, active, sss_number, philhealth_number, pagibig_number, tin_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [empNumber.rows[0].emp_number, empFirstName, empLastName, empName, phone.trim(), email, rate, periodDays, active,
       req.body.sss_number || '', req.body.philhealth_number || '', req.body.pagibig_number || '', req.body.tin_number || '']
    );
    const newEmployeeId = result.rows[0].id;

    let attendanceAccount = null;
    if (email && tempPassword) {
      const attendanceEmpId = await client.query(
        `SELECT (
           'EMP-' || EXTRACT(YEAR FROM CURRENT_DATE)::int || '-' ||
           LPAD(COALESCE(MAX(NULLIF(split_part(employee_id, '-', 4), '')::int), 0) + 1, 4, '0')
         ) AS emp_id
         FROM attendance.employees
         WHERE employee_id LIKE 'EMP-' || EXTRACT(YEAR FROM CURRENT_DATE)::int || '-%'`
      );
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      await client.query(
        `INSERT INTO attendance.employees
           (employee_id, name, email, phone, password_hash, daily_rate, status, approved_at, payroll_employee_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'approved', NOW(), $7)`,
        [attendanceEmpId.rows[0].emp_id, empName, email, phone.trim(), passwordHash, Number(rate), newEmployeeId]
      );
      attendanceAccount = attendanceEmpId.rows[0].emp_id;
    }

    await client.query('COMMIT');
    await logAudit(req.session.user.id, 'create', 'employee', newEmployeeId, {
      name: empName,
      phone,
      email,
      rate,
      pay_period_days: periodDays,
      emp_number: empNumber.rows[0].emp_number,
      mobile_account: attendanceAccount || null
    });
    res.status(201).json({ ...result.rows[0], mobile_account: attendanceAccount });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.put('/api/employees/:id', requireAuth, validateIdParam, async (req, res) => {
  const { first_name, last_name, name, phone, rate, active = true, pay_period_days = 7 } = req.body;
  const empFirstName = (first_name || '').trim();
  const empLastName = (last_name || '').trim();
  const empName = empFirstName && empLastName ? `${empFirstName} ${empLastName}` : (name || '').trim();
  if (!empName) return res.status(400).json({ error: 'Employee first and last name are required.' });
  if (!phone?.trim()) return res.status(400).json({ error: 'Phone number is required.' });
  if (!/^[0-9]{11}$/.test(phone.trim())) {
    return res.status(400).json({ error: 'Phone number must be exactly 11 digits (numbers only).' });
  }
  if (rate === undefined || rate === '' || Number(rate) < 500) {
    return res.status(400).json({ error: 'Daily rate must be at least ₱500.00.' });
  }

  /* Validate government ID formats */
  const govIdResult = validateGovIds(req.body);
  if (!govIdResult.valid) {
    return res.status(400).json({ error: govIdResult.message });
  }

  /* Check government ID uniqueness (exclude current employee) */
  const govIdFields = ['sss_number', 'philhealth_number', 'pagibig_number', 'tin_number'];
  const govIdLabels = { sss_number: 'SSS Number', philhealth_number: 'PhilHealth Number', pagibig_number: 'Pag-IBIG Number', tin_number: 'TIN Number' };
  for (const field of govIdFields) {
    const value = (req.body[field] || '').trim();
    if (value) {
      const existing = await pool.query(`SELECT id FROM employees WHERE ${field} = $1 AND ${field} != '' AND id != $2`, [value, req.params.id]);
      if (existing.rowCount > 0) {
        return res.status(409).json({ error: `${govIdLabels[field]} is already in use by another employee.` });
      }
    }
  }

  const periodDays = Math.max(1, Math.floor(Number(pay_period_days) || 7));

  /* Check phone uniqueness (exclude current employee) */
  const existingPhone = await pool.query(
    'SELECT id FROM employees WHERE phone = $1 AND id != $2',
    [phone.trim(), req.params.id]
  );
  if (existingPhone.rowCount > 0) {
    return res.status(409).json({ error: 'Phone number is already in use by another employee.' });
  }

  const before = await pool.query('SELECT * FROM employees WHERE id = $1', [req.params.id]);
  const result = await pool.query(
    `UPDATE employees
     SET first_name = $1, last_name = $2, name = $3, phone = $4, rate = $5, pay_period_days = $6, active = $7,
         sss_number = $8, philhealth_number = $9, pagibig_number = $10, tin_number = $11, email = $12,
         updated_at = NOW()
     WHERE id = $13
     RETURNING *`,
    [empFirstName, empLastName, empName, phone.trim(), rate, periodDays, active,
     req.body.sss_number || '', req.body.philhealth_number || '', req.body.pagibig_number || '', req.body.tin_number || '',
     String(req.body.email || '').trim().toLowerCase(), req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Employee not found.' });

  /* Upsert mobile (attendance app) account when email + temp password provided */
  const email = String(req.body.email || '').trim().toLowerCase();
  const tempPassword = String(req.body.password || '');
  let mobileAccount = null;
  if (tempPassword) {
    if (!email) {
      return res.status(400).json({ error: 'Email is required to reset the mobile login.' });
    }
    if (tempPassword.length < 8) {
      return res.status(400).json({ error: 'Temporary password must be at least 8 characters.' });
    }
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    const existingAccount = await pool.query(
      'SELECT id, employee_id FROM attendance.employees WHERE payroll_employee_id = $1',
      [req.params.id]
    );
    if (existingAccount.rowCount > 0) {
      await pool.query(
        `UPDATE attendance.employees
         SET email = $1, password_hash = $2, name = $3, phone = $4, daily_rate = $5, status = 'approved'
         WHERE id = $6`,
        [email, passwordHash, empName, phone.trim(), rate, existingAccount.rows[0].id]
      );
      mobileAccount = existingAccount.rows[0].employee_id;
    } else {
      const attendanceEmpId = await pool.query(
        `SELECT (
           'EMP-' || EXTRACT(YEAR FROM CURRENT_DATE)::int || '-' ||
           LPAD(COALESCE(MAX(NULLIF(split_part(employee_id, '-', 4), '')::int), 0) + 1, 4, '0')
         ) AS emp_id
         FROM attendance.employees
         WHERE employee_id LIKE 'EMP-' || EXTRACT(YEAR FROM CURRENT_DATE)::int || '-%'`
      );
      await pool.query(
        `INSERT INTO attendance.employees
           (employee_id, name, email, phone, password_hash, daily_rate, status, approved_at, payroll_employee_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'approved', NOW(), $7)`,
        [attendanceEmpId.rows[0].emp_id, empName, email, phone.trim(), passwordHash, Number(rate), req.params.id]
      );
      mobileAccount = attendanceEmpId.rows[0].emp_id;
    }
  }

  await logAudit(req.session.user.id, 'update', 'employee', Number(req.params.id), {
    before: before.rows[0] || null,
    after: result.rows[0],
    mobile_account: mobileAccount
  });
  res.json({ ...result.rows[0], mobile_account: mobileAccount });
});

app.delete('/api/employees/:id', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  await pool.query('UPDATE employees SET active = false WHERE id = $1', [req.params.id]);
  await logAudit(req.session.user.id, 'archive', 'employee', Number(req.params.id), {});
  res.json({ ok: true });
});

app.post('/api/employees/:id/photo', requireAuth, validateIdParam, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const photoUrl = '/attendance-faces/' + req.file.filename;
  const result = await pool.query(
    'UPDATE employees SET photo_url = $1 WHERE id = $2 RETURNING photo_url',
    [photoUrl, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Employee not found.' });
  res.json({ photo_url: result.rows[0].photo_url });
});

app.delete('/api/employees/:id/photo', requireAuth, validateIdParam, async (req, res) => {
  const result = await pool.query(
    `UPDATE employees SET photo_url = NULL WHERE id = $1 RETURNING photo_url`,
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Employee not found.' });
  res.json({ photo_url: null });
});

app.put('/api/employees/:id/restore', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const result = await pool.query(
    'UPDATE employees SET active = true WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Employee not found.' });
  await logAudit(req.session.user.id, 'restore', 'employee', Number(req.params.id), {});
  res.json(result.rows[0]);
});

app.delete('/api/employees/:id/permanent', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const empId = Number(req.params.id);
  const existing = await pool.query('SELECT * FROM employees WHERE id = $1', [empId]);
  if (!existing.rowCount) return res.status(404).json({ error: 'Employee not found.' });
  const employee = existing.rows[0];
  await pool.query('DELETE FROM payroll_statuses WHERE employee_id = $1', [empId]);
  // attendance_logs & cash_advances are auto-deleted via ON DELETE CASCADE
  await pool.query('DELETE FROM employees WHERE id = $1', [empId]);
  await logAudit(req.session.user.id, 'permanent_delete', 'employee', empId, {
    name: employee.name,
    emp_number: employee.emp_number
  });
  res.json({ ok: true });
});

app.get('/api/attendance', requireAuth, async (req, res) => {
  const pd = getPeriodDays(req.query.periodDays);
  let weekStart, weekEnd;
  if (req.query.periodDays) {
    /* Use payroll period alignment when periodDays is specified */
    weekStart = periodStartOf(req.query.week || todayInManila(), pd);
    weekEnd = addDays(weekStart, pd - 1);
  } else {
    /* Default: Sunday-to-Saturday for attendance view navigation */
    weekStart = weekStartOf(req.query.week || todayInManila());
    weekEnd = addDays(weekStart, 6);
  }
  const search = `%${req.query.search || ''}%`;
  const result = await pool.query(
    `SELECT a.id, a.employee_id, to_char(a.work_date, 'YYYY-MM-DD') AS work_date,
       a.time_in, a.time_out, a.rate_snapshot, a.notes, a.created_by, a.created_at, a.updated_at,
       e.emp_number, e.name, e.pay_period_days,
       CASE WHEN ps.status = 'generated' THEN true ELSE false END AS locked
     FROM attendance_logs a
     JOIN employees e ON e.id = a.employee_id
      LEFT JOIN LATERAL (
        SELECT status FROM payroll_statuses ps2
        WHERE ps2.employee_id = a.employee_id
          AND ps2.status = 'generated'
          AND a.work_date >= ps2.week_start
          AND a.work_date < ps2.week_start + (e.pay_period_days || ' days')::interval
        ORDER BY ps2.week_start DESC
        LIMIT 1
      ) ps ON true
     WHERE a.work_date BETWEEN $1 AND $2
       AND (e.emp_number ILIKE $3 OR e.name ILIKE $3)
     ORDER BY a.work_date DESC, e.name ASC`,
     [weekStart, weekEnd, search]
  );
  res.json({ weekStart, weekEnd, rows: result.rows });
});

app.get('/api/attendance/calendar', requireAuth, async (req, res) => {
  const month = req.query.month;
  if (!month) return res.json({ dates: [] });
  const monthStart = month + '-01';
  const parts = month.split('-');
  const yr = parseInt(parts[0], 10);
  const mo = parseInt(parts[1], 10);
  const lastDay = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
  const monthEnd = month + '-' + String(lastDay).padStart(2, '0');
  const result = await pool.query(
    `SELECT DISTINCT to_char(work_date, 'YYYY-MM-DD') AS work_date FROM attendance_logs WHERE work_date BETWEEN $1 AND $2`,
    [monthStart, monthEnd]
  );
  res.json({ dates: result.rows.map(r => r.work_date) });
});

app.get('/api/payroll/calendar', requireAuth, async (req, res) => {
  const month = req.query.month;
  if (!month) return res.json({ dates: [] });
  const monthStart = month + '-01';
  const parts = month.split('-');
  const yr = parseInt(parts[0], 10);
  const mo = parseInt(parts[1], 10);
  const lastDay = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
  const monthEnd = month + '-' + String(lastDay).padStart(2, '0');
  const result = await pool.query(
    `SELECT DISTINCT to_char(week_start, 'YYYY-MM-DD') AS date FROM payroll_statuses WHERE week_start BETWEEN $1 AND $2`,
    [monthStart, monthEnd]
  );
  res.json({ dates: result.rows.map(r => r.date) });
});

app.get('/api/cash-advances/calendar', requireAuth, async (req, res) => {
  const month = req.query.month;
  if (!month) return res.json({ dates: [] });
  const monthStart = month + '-01';
  const parts = month.split('-');
  const yr = parseInt(parts[0], 10);
  const mo = parseInt(parts[1], 10);
  const lastDay = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
  const monthEnd = month + '-' + String(lastDay).padStart(2, '0');
  const result = await pool.query(
    `SELECT DISTINCT to_char(advance_date, 'YYYY-MM-DD') AS date FROM cash_advances WHERE advance_date BETWEEN $1 AND $2`,
    [monthStart, monthEnd]
  );
  res.json({ dates: result.rows.map(r => r.date) });
});

app.get('/api/transactions/calendar', requireAuth, async (req, res) => {
  const month = req.query.month;
  const employeeId = req.query.employee_id;
  if (!month) return res.json({ dates: [] });
  const monthStart = month + '-01';
  const parts = month.split('-');
  const yr = parseInt(parts[0], 10);
  const mo = parseInt(parts[1], 10);
  const lastDay = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
  const monthEnd = month + '-' + String(lastDay).padStart(2, '0');
  const params = [monthStart, monthEnd];
  const empFilter = employeeId ? ` AND employee_id = $3` : '';
  if (employeeId) params.push(Number(employeeId));
  const result = await pool.query(
    `SELECT date FROM (
      SELECT employee_id, payment_date AS date FROM salary_payments WHERE payment_date BETWEEN $1 AND $2${empFilter}
      UNION ALL
      SELECT employee_id, advance_date AS date FROM cash_advances WHERE advance_date BETWEEN $1 AND $2${empFilter}
      UNION ALL
      SELECT employee_id, payment_date AS date FROM bale_payments WHERE payment_date BETWEEN $1 AND $2${empFilter}
      UNION ALL
      SELECT employee_id, extra_date AS date FROM extra_payments WHERE extra_date BETWEEN $1 AND $2${empFilter}
     ) sub GROUP BY date`,
    params
  );
  res.json({ dates: result.rows.map(r => {
    const d = r.date;
    return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  })});
});

app.post('/api/attendance', requireAuth, async (req, res) => {
  const { employee_id, work_date, time_in = null, time_out = null, notes = '' } = req.body;
  const employee = await pool.query('SELECT rate FROM employees WHERE id = $1', [employee_id]);
  if (!employee.rowCount) return res.status(404).json({ error: 'Employee not found.' });
  if (await isDateLockedForEmployee(employee_id, work_date)) {
    return res.status(403).json({ error: 'Cannot modify: payroll period is locked. Unlock the payslip first.' });
  }

  const result = await pool.query(
    `INSERT INTO attendance_logs (employee_id, work_date, time_in, time_out, rate_snapshot, notes, created_by)
     VALUES ($1, $2, NULLIF($3, '')::time, NULLIF($4, '')::time, $5, $6, $7)
     ON CONFLICT (employee_id, work_date)
     DO UPDATE SET time_in = EXCLUDED.time_in,
       time_out = EXCLUDED.time_out,
       notes = EXCLUDED.notes,
       updated_at = NOW()
     RETURNING *`,
    [employee_id, work_date, time_in, time_out || null, employee.rows[0].rate, notes, req.session.user.id]
  );
  res.status(201).json(result.rows[0]);
});

app.post('/api/attendance/bulk', requireAuth, async (req, res) => {
  const { weekStart, employeeIds = [], present = [] } = req.body;
  const start = payrollWeekStartOf(weekStart || todayInManila());
  const end = addDays(start, 6);
  const presentSet = new Set(present.map(item => `${item.employee_id}:${item.work_date}`));
  for (const employeeId of employeeIds) {
    if (await isDateLockedForEmployee(employeeId, start)) {
      return res.status(403).json({ error: `Cannot modify attendance: payroll period is locked for employee ${employeeId}. Unlock the payslip first.` });
    }
  }
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    for (const employeeId of employeeIds) {
      const employee = await client.query('SELECT rate FROM employees WHERE id = $1', [employeeId]);
      if (!employee.rowCount) continue;

      for (let day = 0; day < 7; day += 1) {
        const workDate = addDays(start, day);
        const key = `${employeeId}:${workDate}`;
        if (presentSet.has(key)) {
          await client.query(
            `INSERT INTO attendance_logs (employee_id, work_date, rate_snapshot, notes, created_by)
             VALUES ($1, $2, $3, 'Present', $4)
             ON CONFLICT (employee_id, work_date) DO NOTHING`,
            [employeeId, workDate, employee.rows[0].rate, req.session.user.id]
          );
        } else {
          await client.query(
            `DELETE FROM attendance_logs
             WHERE employee_id = $1 AND work_date = $2 AND work_date BETWEEN $3 AND $4`,
            [employeeId, workDate, start, end]
          );
        }
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.post('/api/attendance/mark-all', requireAuth, async (req, res) => {
  const { work_date, employeeIds = [] } = req.body;
  if (!work_date) return res.status(400).json({ error: 'work_date is required.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let count = 0;
    for (const employeeId of employeeIds) {
      if (await isDateLockedForEmployee(employeeId, work_date)) continue;
      const emp = await client.query('SELECT rate FROM employees WHERE id = $1 AND active = true', [employeeId]);
      if (!emp.rowCount) continue;
      await client.query(
        `INSERT INTO attendance_logs (employee_id, work_date, rate_snapshot, notes, created_by)
         VALUES ($1, $2, $3, 'Present', $4)
         ON CONFLICT (employee_id, work_date) DO NOTHING`,
        [employeeId, work_date, emp.rows[0].rate, req.session.user.id]
      );
      count++;
    }
    await client.query('COMMIT');
    res.json({ ok: true, count });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.put('/api/attendance/:id', requireAuth, validateIdParam, async (req, res) => {
  const { work_date, time_in = null, time_out = null, notes = '' } = req.body;
  const existing = await pool.query('SELECT employee_id, work_date FROM attendance_logs WHERE id = $1', [req.params.id]);
  if (existing.rowCount && await isDateLockedForEmployee(existing.rows[0].employee_id, existing.rows[0].work_date)) {
    return res.status(403).json({ error: 'Cannot modify: payroll period is locked. Unlock the payslip first.' });
  }
  const result = await pool.query(
    `UPDATE attendance_logs
     SET work_date = $1, time_in = NULLIF($2, '')::time, time_out = NULLIF($3, '')::time, notes = $4, updated_at = NOW()
     WHERE id = $5
     RETURNING *`,
    [work_date, time_in, time_out || null, notes, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Attendance log not found.' });
  res.json(result.rows[0]);
});

app.delete('/api/attendance/:id', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const existing = await pool.query('SELECT * FROM attendance_logs WHERE id = $1', [req.params.id]);
  if (!existing.rowCount) return res.status(404).json({ error: 'Attendance record not found.' });
  const rec = existing.rows[0];
  const weekOf = payrollWeekStartOf(rec.work_date);
  if (await isWeekLocked(rec.employee_id, weekOf)) {
    return res.status(403).json({ error: 'Cannot delete: payroll week is locked.' });
  }
  await pool.query('DELETE FROM attendance_logs WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/cash-advances/:id', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const existing = await pool.query('SELECT * FROM cash_advances WHERE id = $1', [req.params.id]);
  if (!existing.rowCount) return res.status(404).json({ error: 'C/A record not found.' });
  const rec = existing.rows[0];
  if (await isDateLockedForEmployee(rec.employee_id, rec.advance_date)) {
    return res.status(403).json({ error: 'Cannot delete: payroll week is locked.' });
  }
  await pool.query('DELETE FROM cash_advances WHERE id = $1', [req.params.id]);
  await logAudit(req.session.user.id, 'delete', 'cash_advance', req.params.id, rec);
  res.json({ ok: true });
});

/* ── Extra Payments API (no daily limit) ── */
app.get('/api/extra-payments', requireAuth, async (req, res) => {
  const pd = getPeriodDays(req.query.periodDays);
  const weekStart = periodStartOf(req.query.week || todayInManila(), pd);
  const weekEnd = addDays(weekStart, pd - 1);
  const employeeId = req.query.employee_id;
  const params = [weekStart, weekEnd];
  let employeeFilter = '';
  if (employeeId) {
    params.push(employeeId);
    employeeFilter = `AND ep.employee_id = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT ep.id, ep.employee_id, ep.amount, to_char(ep.extra_date, 'YYYY-MM-DD') AS extra_date,
       ep.notes, ep.created_by, ep.created_at, e.emp_number, e.name
     FROM extra_payments ep
     JOIN employees e ON e.id = ep.employee_id
     WHERE ep.extra_date BETWEEN $1 AND $2
       ${employeeFilter}
     ORDER BY ep.extra_date DESC, e.name ASC`,
    params
  );
  res.json({ weekStart, weekEnd, rows: result.rows });
});

app.post('/api/extra-payments', requireAuth, async (req, res) => {
  const { employee_id, amount, extra_date, notes = '' } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'Employee is required.' });
  if (amount === undefined || amount === '' || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than zero.' });
  }
  if (await isDateLockedForEmployee(employee_id, extra_date)) {
    return res.status(403).json({ error: 'Cannot add extra payment: payroll period is locked. Unlock the payslip first.' });
  }
  const existingAdvance = await pool.query(
    'SELECT id FROM extra_payments WHERE employee_id = $1 AND extra_date = $2',
    [employee_id, extra_date]
  );
  if (existingAdvance.rowCount) {
    return res.status(409).json({ error: 'Only one extra payment is allowed per employee per day.' });
  }
  const result = await pool.query(
    `INSERT INTO extra_payments (employee_id, amount, extra_date, notes, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [employee_id, amount, extra_date, notes, req.session.user.id]
  );
  await logAudit(req.session.user.id, 'create', 'extra_payment', result.rows[0].id, {
    employee_id,
    amount,
    extra_date,
    notes
  });
  res.status(201).json(result.rows[0]);
});

app.put('/api/extra-payments/:id', requireAuth, validateIdParam, async (req, res) => {
  const { employee_id, amount, extra_date, notes = '' } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'Employee is required.' });
  if (amount === undefined || amount === '' || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than zero.' });
  }
  if (await isDateLockedForEmployee(employee_id, extra_date)) {
    return res.status(403).json({ error: 'Cannot modify extra payment: payroll period is locked. Unlock the payslip first.' });
  }
  const before = await pool.query('SELECT * FROM extra_payments WHERE id = $1', [req.params.id]);
  const result = await pool.query(
    `UPDATE extra_payments
     SET employee_id = $1, amount = $2, extra_date = $3, notes = $4
     WHERE id = $5
     RETURNING *`,
    [employee_id, amount, extra_date, notes, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Extra payment not found.' });
  await logAudit(req.session.user.id, 'update', 'extra_payment', req.params.id, {
    before: before.rows[0] || null,
    after: result.rows[0]
  });
  res.json(result.rows[0]);
});

app.delete('/api/extra-payments/:id', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const existing = await pool.query('SELECT * FROM extra_payments WHERE id = $1', [req.params.id]);
  if (!existing.rowCount) return res.status(404).json({ error: 'Extra payment not found.' });
  const rec = existing.rows[0];
  if (await isDateLockedForEmployee(rec.employee_id, rec.extra_date)) {
    return res.status(403).json({ error: 'Cannot delete: payroll week is locked.' });
  }
  await pool.query('DELETE FROM extra_payments WHERE id = $1', [req.params.id]);
  await logAudit(req.session.user.id, 'delete', 'extra_payment', req.params.id, rec);
  res.json({ ok: true });
});

/* ── Salary Payments API ── */
app.get('/api/salary-payments', requireAuth, async (req, res) => {
  const pd = getPeriodDays(req.query.periodDays);
  const weekStart = periodStartOf(req.query.week || todayInManila(), pd);
  const weekEnd = addDays(weekStart, pd - 1);
  const employeeId = req.query.employee_id;
  const params = [weekStart, weekEnd];
  let employeeFilter = '';
  if (employeeId) {
    params.push(employeeId);
    employeeFilter = `AND sp.employee_id = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT sp.id, sp.employee_id, sp.amount,
       to_char(sp.payment_date, 'YYYY-MM-DD') AS payment_date,
       sp.notes, sp.created_by, sp.created_at,
       e.emp_number, e.name
     FROM salary_payments sp
     JOIN employees e ON e.id = sp.employee_id
     WHERE sp.payment_date BETWEEN $1 AND $2
       ${employeeFilter}
     ORDER BY sp.payment_date DESC, e.name ASC`,
    params
  );
  res.json({ weekStart, weekEnd, rows: result.rows });
});

app.post('/api/salary-payments', requireAuth, async (req, res) => {
  const { employee_id, amount, payment_date, notes = '' } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'Employee is required.' });
  if (amount === undefined || amount === '' || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than zero.' });
  }
  if (await isDateLockedForEmployee(employee_id, payment_date || todayInManila())) {
    return res.status(403).json({ error: 'Cannot add salary payment: payroll period is locked. Unlock the payslip first.' });
  }
  try {
    await assertPaymentWithinBalance(employee_id, payment_date || todayInManila(), amount, 'salary');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const result = await pool.query(
    `INSERT INTO salary_payments (employee_id, amount, payment_date, notes, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [employee_id, amount, payment_date || todayInManila(), notes, req.session.user.id]
  );
  await logAudit(req.session.user.id, 'create', 'salary_payment', result.rows[0].id, {
    employee_id,
    amount,
    payment_date,
    notes
  });
  res.status(201).json(result.rows[0]);
});

app.put('/api/salary-payments/:id', requireAuth, validateIdParam, async (req, res) => {
  const { employee_id, amount, payment_date = todayInManila(), notes = '' } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'Employee is required.' });
  if (amount === undefined || amount === '' || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than zero.' });
  }
  if (await isDateLockedForEmployee(employee_id, payment_date || todayInManila())) {
    return res.status(403).json({ error: 'Cannot modify salary payment: payroll period is locked. Unlock the payslip first.' });
  }
  const before = await pool.query('SELECT * FROM salary_payments WHERE id = $1', [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: 'Salary payment not found.' });
  try {
    await assertPaymentWithinBalance(employee_id, payment_date || todayInManila(), amount, 'salary', req.params.id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const result = await pool.query(
    `UPDATE salary_payments SET amount = $1, payment_date = $2, notes = $3 WHERE id = $4 RETURNING *`,
    [amount, payment_date, notes, req.params.id]
  );
  await logAudit(req.session.user.id, 'update', 'salary_payment', req.params.id, {
    before: before.rows[0] || null,
    after: result.rows[0]
  });
  res.json(result.rows[0]);
});

app.delete('/api/salary-payments/:id', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const existing = await pool.query('SELECT * FROM salary_payments WHERE id = $1', [req.params.id]);
  if (!existing.rowCount) return res.status(404).json({ error: 'Salary payment not found.' });
  const rec = existing.rows[0];
  if (await isDateLockedForEmployee(rec.employee_id, rec.payment_date)) {
    return res.status(403).json({ error: 'Cannot delete: payroll week is locked.' });
  }
  await pool.query('DELETE FROM salary_payments WHERE id = $1', [req.params.id]);
  await logAudit(req.session.user.id, 'delete', 'salary_payment', req.params.id, rec);
  res.json({ ok: true });
});

/* ── Bale Payments API ── */
app.get('/api/bale-payments', requireAuth, async (req, res) => {
  const pd = getPeriodDays(req.query.periodDays);
  const weekStart = periodStartOf(req.query.week || todayInManila(), pd);
  const weekEnd = addDays(weekStart, pd - 1);
  const employeeId = req.query.employee_id;
  const params = [weekStart, weekEnd];
  let employeeFilter = '';
  if (employeeId) {
    params.push(employeeId);
    employeeFilter = `AND bp.employee_id = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT bp.id, bp.employee_id, bp.amount,
       to_char(bp.payment_date, 'YYYY-MM-DD') AS payment_date,
       bp.notes, bp.created_by, bp.created_at,
       e.emp_number, e.name
     FROM bale_payments bp
     JOIN employees e ON e.id = bp.employee_id
     WHERE bp.payment_date BETWEEN $1 AND $2
       ${employeeFilter}
     ORDER BY bp.payment_date DESC, e.name ASC`,
    params
  );
  res.json({ weekStart, weekEnd, rows: result.rows });
});

app.post('/api/bale-payments', requireAuth, async (req, res) => {
  const { employee_id, amount, payment_date, notes = '' } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'Employee is required.' });
  if (amount === undefined || amount === '' || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than zero.' });
  }
  if (await isDateLockedForEmployee(employee_id, payment_date || todayInManila())) {
    return res.status(403).json({ error: 'Cannot add bale payment: payroll period is locked. Unlock the payslip first.' });
  }
  try {
    await assertPaymentWithinBalance(employee_id, payment_date || todayInManila(), amount, 'bale');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const result = await pool.query(
    `INSERT INTO bale_payments (employee_id, amount, payment_date, notes, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [employee_id, amount, payment_date || todayInManila(), notes, req.session.user.id]
  );
  await logAudit(req.session.user.id, 'create', 'bale_payment', result.rows[0].id, {
    employee_id,
    amount,
    payment_date,
    notes
  });
  res.status(201).json(result.rows[0]);
});

app.put('/api/bale-payments/:id', requireAuth, validateIdParam, async (req, res) => {
  const { employee_id, amount, payment_date = todayInManila(), notes = '' } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'Employee is required.' });
  if (amount === undefined || amount === '' || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than zero.' });
  }
  if (await isDateLockedForEmployee(employee_id, payment_date || todayInManila())) {
    return res.status(403).json({ error: 'Cannot modify bale payment: payroll period is locked. Unlock the payslip first.' });
  }
  const before = await pool.query('SELECT * FROM bale_payments WHERE id = $1', [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: 'Bale payment not found.' });
  try {
    await assertPaymentWithinBalance(employee_id, payment_date || todayInManila(), amount, 'bale', req.params.id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const result = await pool.query(
    `UPDATE bale_payments SET amount = $1, payment_date = $2, notes = $3 WHERE id = $4 RETURNING *`,
    [amount, payment_date, notes, req.params.id]
  );
  await logAudit(req.session.user.id, 'update', 'bale_payment', req.params.id, {
    before: before.rows[0] || null,
    after: result.rows[0]
  });
  res.json(result.rows[0]);
});

app.delete('/api/bale-payments/:id', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const existing = await pool.query('SELECT * FROM bale_payments WHERE id = $1', [req.params.id]);
  if (!existing.rowCount) return res.status(404).json({ error: 'Bale payment not found.' });
  const rec = existing.rows[0];
  if (await isDateLockedForEmployee(rec.employee_id, rec.payment_date)) {
    return res.status(403).json({ error: 'Cannot delete: payroll week is locked.' });
  }
  await pool.query('DELETE FROM bale_payments WHERE id = $1', [req.params.id]);
  await logAudit(req.session.user.id, 'delete', 'bale_payment', req.params.id, rec);
  res.json({ ok: true });
});



app.get('/api/cash-advances', requireAuth, async (req, res) => {
  const pd = getPeriodDays(req.query.periodDays);
  const weekStart = periodStartOf(req.query.week || todayInManila(), pd);
  const weekEnd = addDays(weekStart, pd - 1);
  const employeeId = req.query.employee_id;
  const params = [weekStart, weekEnd];
  let employeeFilter = '';
  if (employeeId) {
    params.push(employeeId);
    employeeFilter = `AND c.employee_id = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT c.id, c.employee_id, c.amount, to_char(c.advance_date, 'YYYY-MM-DD') AS advance_date,
       c.notes, c.created_by, c.created_at, e.emp_number, e.name, e.pay_period_days,
       CASE WHEN ps.status = 'generated' THEN true ELSE false END AS locked
     FROM cash_advances c
     JOIN employees e ON e.id = c.employee_id
      LEFT JOIN LATERAL (
        SELECT status FROM payroll_statuses ps2
        WHERE ps2.employee_id = c.employee_id
          AND ps2.status = 'generated'
          AND c.advance_date >= ps2.week_start
          AND c.advance_date < ps2.week_start + (e.pay_period_days || ' days')::interval
        ORDER BY ps2.week_start DESC
        LIMIT 1
      ) ps ON true
     WHERE c.advance_date BETWEEN $1 AND $2
       ${employeeFilter}
     ORDER BY c.advance_date DESC, e.name ASC`,
    params
  );
  res.json({ weekStart, weekEnd, rows: result.rows });
});

app.post('/api/cash-advances', requireAuth, async (req, res) => {
  const { employee_id, amount, advance_date, notes = '' } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'Employee is required.' });
  if (amount === undefined || amount === '' || Number(amount) <= 0) {
    return res.status(400).json({ error: 'C/A amount must be greater than zero.' });
  }
  if (await isDateLockedForEmployee(employee_id, advance_date)) {
    return res.status(403).json({ error: 'Cannot add C/A: payroll period is locked. Unlock the payslip first.' });
  }
  const existingAdvance = await pool.query(
    'SELECT id FROM cash_advances WHERE employee_id = $1 AND advance_date = $2',
    [employee_id, advance_date]
  );
  if (existingAdvance.rowCount) {
    return res.status(409).json({ error: 'Only one C/A is allowed per employee per day.' });
  }
  const result = await pool.query(
    `INSERT INTO cash_advances (employee_id, amount, advance_date, notes, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [employee_id, amount, advance_date, notes, req.session.user.id]
  );
  await logAudit(req.session.user.id, 'create', 'cash_advance', result.rows[0].id, {
    employee_id,
    amount,
    advance_date,
    notes
  });
  res.status(201).json(result.rows[0]);
});

app.put('/api/cash-advances/:id', requireAuth, async (req, res) => {
  const { employee_id, amount, advance_date, notes = '' } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'Employee is required.' });
  if (amount === undefined || amount === '' || Number(amount) <= 0) {
    return res.status(400).json({ error: 'C/A amount must be greater than zero.' });
  }
  if (await isDateLockedForEmployee(employee_id, advance_date)) {
    return res.status(403).json({ error: 'Cannot modify C/A: payroll period is locked. Unlock the payslip first.' });
  }
  const existingAdvance = await pool.query(
    'SELECT id FROM cash_advances WHERE employee_id = $1 AND advance_date = $2 AND id <> $3',
    [employee_id, advance_date, req.params.id]
  );
  if (existingAdvance.rowCount) {
    return res.status(409).json({ error: 'Only one C/A is allowed per employee per day.' });
  }

  const before = await pool.query('SELECT * FROM cash_advances WHERE id = $1', [req.params.id]);
  const result = await pool.query(
    `UPDATE cash_advances
     SET employee_id = $1, amount = $2, advance_date = $3, notes = $4
     WHERE id = $5
     RETURNING *`,
    [employee_id, amount, advance_date, notes, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'C/A record not found.' });
  await logAudit(req.session.user.id, 'update', 'cash_advance', req.params.id, {
    before: before.rows[0] || null,
    after: result.rows[0]
  });
  res.json(result.rows[0]);
});



app.get('/api/payroll', requireAuth, async (req, res) => {
  const periodDays = getPeriodDays(req.query.periodDays);
  /* Trust the provided week — don't realign to period anchor */
  const weekStart = req.query.week
    ? payrollWeekStartOf(req.query.week)
    : periodStartOf(todayInManila(), periodDays);
  const weekEnd = addDays(weekStart, periodDays - 1);
  const currentDate = req.query.today || todayInManila();
  const search = `%${req.query.search || ''}%`;
  const includeInactive = req.query.include_inactive === 'true';
  const result = await pool.query(
    `WITH attendance AS (
       SELECT employee_id,
         COUNT(*)::int AS days,
         SUM(rate_snapshot)::numeric(12,2) AS gross_salary,
         MAX(rate_snapshot)::numeric(12,2) AS displayed_rate
       FROM attendance_logs
       WHERE work_date BETWEEN $1 AND $2
       GROUP BY employee_id
     ),
     advances AS (
       SELECT employee_id, SUM(amount)::numeric(12,2) AS cash_advance
       FROM cash_advances
       WHERE advance_date BETWEEN $1 AND $2
       GROUP BY employee_id
     ),
     extras AS (
       SELECT employee_id, SUM(amount)::numeric(12,2) AS extra_total
       FROM extra_payments
       WHERE extra_date BETWEEN $1 AND $2
       GROUP BY employee_id
     ),
     bale_payments_cte AS (
       SELECT employee_id, SUM(amount)::numeric(12,2) AS bale_paid
       FROM bale_payments
       WHERE payment_date BETWEEN $1 AND $2
       GROUP BY employee_id
     ),
     salary_pay_cte AS (
       SELECT employee_id, SUM(amount)::numeric(12,2) AS total_paid
       FROM salary_payments
       WHERE payment_date BETWEEN $1 AND $2
       GROUP BY employee_id
     )
     SELECT e.id AS employee_id, e.emp_number, e.name,
       e.pay_period_days, e.photo_url,
       COALESCE(a.displayed_rate, e.rate)::numeric(12,2) AS rate,
       COALESCE(a.days, 0) AS days,
       COALESCE(ad.cash_advance, 0)::numeric(12,2) AS cash_advance,
       COALESCE(a.gross_salary, 0)::numeric(12,2) AS gross_salary,
       COALESCE(a.gross_salary, 0)::numeric(12,2) AS salary,
       (COALESCE(ps.paid_amount, 0) + COALESCE(sp.total_paid, 0))::numeric(12,2) AS salary_paid_amount,
       COALESCE(ex.extra_total, 0)::numeric(12,2) AS extra_payment_amount,
       '' AS extra_payment_notes,
       COALESCE(ps.bale_deducted, false) AS bale_deducted,
       (COALESCE(ps.paid_amount, 0) + COALESCE(sp.total_paid, 0))::numeric(12,2) AS paid_amount,
       COALESCE(ps.paid_amount, 0)::numeric(12,2) AS legacy_paid_amount,
       COALESCE(bp.bale_paid, 0)::numeric(12,2) AS bale_paid_amount,
       ps.paid_at,
       ps.status AS payroll_status,
       ps.week_start::text AS locked_period_start
     FROM employees e
     LEFT JOIN attendance a ON a.employee_id = e.id
     LEFT JOIN advances ad ON ad.employee_id = e.id
     LEFT JOIN extras ex ON ex.employee_id = e.id
     LEFT JOIN bale_payments_cte bp ON bp.employee_id = e.id
     LEFT JOIN salary_pay_cte sp ON sp.employee_id = e.id
      LEFT JOIN LATERAL (
        SELECT * FROM payroll_statuses ps2
        WHERE ps2.employee_id = e.id
          AND ps2.week_start <= $1
          AND $1 < ps2.week_start + (e.pay_period_days || ' days')::interval
        ORDER BY ps2.week_start DESC
        LIMIT 1
      ) ps ON true
     WHERE (e.emp_number ILIKE $3 OR e.name ILIKE $3)
       ${includeInactive ? '' : 'AND e.active = true'}
     ORDER BY e.name ASC`,
    [weekStart, weekEnd, search]
  );

  const allEmployeeIds = result.rows.map(r => r.employee_id);
  const carryoverMap = await getPayrollCarryoversBulk(allEmployeeIds, weekStart, getPeriodDays(result.rows[0]?.pay_period_days || 7));

  const rows = result.rows.map(row => {
    const salary = money(row.salary);
    const cashAdvance = money(row.cash_advance);
    const salaryPaidAmount = money(row.salary_paid_amount);
    const extraPaymentAmount = money(row.extra_payment_amount);
    const balePaymentAmount = money(row.bale_paid_amount);
    const legacyPaidAmount = money(row.legacy_paid_amount);
    const empPeriodDays = getPeriodDays(row.pay_period_days);
    const carryovers = carryoverMap.get(row.employee_id) || { baleBalance: 0, unpaidBalance: 0 };
    const previousBaleBalance = carryovers.baleBalance;
    const previousUnpaidBalance = carryovers.unpaidBalance;
    const weekState = calculatePayrollWeekState({
      previousBaleBalance,
      previousUnpaidBalance,
      salary,
      cashAdvance,
      salaryPaidAmount,
      deductBale: row.bale_deducted,
      balePaymentAmount,
      extraPayment: extraPaymentAmount
    });
    const totalDue = weekState.paymentLimit;
    const paidAmount = salaryPaidAmount;
    /* Balance now includes extra pay via calculatePayrollWeekState */
    const balance = weekState.balance;
    const paymentStatus = balance === 0 && weekState.remainingBaleBalance === 0 && (totalDue > 0 || salary > 0)
      ? 'paid'
      : (paidAmount > 0 || extraPaymentAmount > 0) && (balance > 0 || previousUnpaidBalance > 0 || weekState.remainingBaleBalance > 0)
        ? 'partial'
        : 'unpaid';

    return {
      ...row,
      pay_period_days: empPeriodDays,
      rate: money(row.rate),
      days: Number(row.days),
      cash_advance: cashAdvance,
      previous_bale_balance: previousBaleBalance,
      previous_unpaid_balance: previousUnpaidBalance,
      total_bale: weekState.totalBale,
      bale_deduction: weekState.baleDeduction,
      remaining_bale_balance: weekState.remainingBaleBalance,
      take_home: weekState.takeHome,
      total_due: totalDue,
      payment_limit: weekState.paymentLimit,
      salary_payment_limit: Math.max(weekState.paymentLimit, 0),
      extra_payment_limit: Math.max(weekState.paymentLimit - salaryPaidAmount, 0),
      gross_salary: money(row.gross_salary),
      salary,
      salary_paid_amount: salaryPaidAmount,
      extra_payment_amount: extraPaymentAmount,
      extra_payment_notes: row.extra_payment_notes || '',
      paid_amount: paidAmount,
      legacy_paid_amount: legacyPaidAmount,
      balance,
      payment_status: paymentStatus,
      paid_at: row.paid_at,
      payroll_status: row.payroll_status || null
    };
  }).filter(row =>
    includeInactive ||
    row.days > 0 ||
    row.cash_advance > 0 ||
    row.salary_paid_amount > 0 ||
    row.extra_payment_amount > 0 ||
    row.previous_bale_balance > 0 ||
    row.remaining_bale_balance > 0 ||
    row.previous_unpaid_balance > 0
  );

  const reviewResult = await pool.query(
    `SELECT r.accepted_at, r.accepted_by, u.username AS accepted_by_username
     FROM payroll_reviews r
     LEFT JOIN users u ON u.id = r.accepted_by
     WHERE r.period_key = $1`,
    [weekStart]
  );
  const review = reviewResult.rowCount
    ? { accepted: true, accepted_at: reviewResult.rows[0].accepted_at, accepted_by: reviewResult.rows[0].accepted_by, accepted_by_username: reviewResult.rows[0].accepted_by_username }
    : { accepted: false };

  res.json({
    weekStart,
    weekEnd,
    periodDays,
    rows,
    review,
    isPeriodLocked: rows.some(r => r.payroll_status === 'generated'),
    summary: {
      employees: rows.length,
      workingDays: workingDaysInPeriod(weekStart, periodDays, currentDate),
      totalCashAdvance: rows.reduce((sum, row) => sum + row.cash_advance, 0),
      totalPaidAmount: rows.reduce((sum, row) => sum + row.paid_amount, 0),
      totalSalary: rows.reduce((sum, row) => sum + row.salary, 0),
      totalBalance: rows.reduce((sum, row) => sum + row.balance, 0),
      totalBaleBalance: rows.reduce((sum, row) => sum + row.remaining_bale_balance, 0),
      totalPreviousUnpaid: rows.reduce((sum, row) => sum + row.previous_unpaid_balance, 0)
    }
  });
});

/* Accept a payroll period after review — required before Bulk Print. */
app.post('/api/payroll/review', requireAuth, requireAdmin, async (req, res) => {
  const periodDays = getPeriodDays(req.body.periodDays);
  const weekStart = req.body.week
    ? payrollWeekStartOf(req.body.week)
    : periodStartOf(todayInManila(), periodDays);
  await pool.query(
    `INSERT INTO payroll_reviews (period_key, period_days, accepted_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (period_key) DO UPDATE SET accepted_at = NOW(), accepted_by = $3`,
    [weekStart, periodDays, req.session.user.id]
  );
  await logAudit(req.session.user.id, 'review_accept', 'payroll', null, { period_key: weekStart, period_days: periodDays });
  res.json({ ok: true, accepted: true, period_key: weekStart });
});

/* Generating a payslip finalizes this employee's selected payroll period. */
app.post('/api/payroll/:employeeId/generate', requireAuth, async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const employee = await pool.query('SELECT pay_period_days FROM employees WHERE id = $1', [employeeId]);
  if (!employee.rowCount) return res.status(404).json({ error: 'Employee not found.' });
  const periodDays = getPeriodDays(req.body.payPeriodDays || employee.rows[0].pay_period_days);
  const weekStart = periodStartOf(req.body.weekStart || todayInManila(), periodDays);
  const weekEnd = addDays(weekStart, periodDays - 1);
  if (periodDays !== getPeriodDays(employee.rows[0].pay_period_days)) {
    await pool.query('UPDATE employees SET pay_period_days = $1 WHERE id = $2', [periodDays, employeeId]);
  }
  const hasData = await pool.query(
    `SELECT EXISTS(SELECT 1 FROM attendance_logs WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3) AS has_attendance,
            EXISTS(SELECT 1 FROM salary_payments WHERE employee_id = $1 AND payment_date BETWEEN $2 AND $3) AS has_salary,
            EXISTS(SELECT 1 FROM cash_advances WHERE employee_id = $1 AND advance_date BETWEEN $2 AND $3) AS has_ca,
            EXISTS(SELECT 1 FROM bale_payments WHERE employee_id = $1 AND payment_date BETWEEN $2 AND $3) AS has_bale,
            EXISTS(SELECT 1 FROM extra_payments WHERE employee_id = $1 AND extra_date BETWEEN $2 AND $3) AS has_extra`,
    [employeeId, weekStart, weekEnd]
  );
  const d = hasData.rows[0];
  if (!d.has_attendance && !d.has_bale && !d.has_extra) {
    return res.status(400).json({ error: 'Cannot generate payslip: no attendance or transactions found for this period.' });
  }

  /* Calculate salary based on attendance × rate + extra pay */
  const earningsResult = await pool.query(
    `SELECT COALESCE(SUM(al.rate_snapshot), 0)::numeric(12,2) AS salary,
            COALESCE(MAX(ep.extra_total), 0)::numeric(12,2) AS extra_pay
     FROM (SELECT $1::int AS employee_id) e
     LEFT JOIN attendance_logs al ON al.employee_id = e.employee_id AND al.work_date BETWEEN $2 AND $3
     LEFT JOIN (
       SELECT employee_id, SUM(amount)::numeric(12,2) AS extra_total
       FROM extra_payments
       WHERE employee_id = $1 AND extra_date BETWEEN $2 AND $3
       GROUP BY employee_id
     ) ep ON ep.employee_id = e.employee_id`,
    [employeeId, weekStart, weekEnd]
  );
  const salaryAmount = money(earningsResult.rows[0]?.salary || 0);
  const extraAmount = money(earningsResult.rows[0]?.extra_pay || 0);
  const totalEarnings = salaryAmount + extraAmount;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (totalEarnings > 0 && !d.has_salary) {
      /* Auto-insert salary payment for earnings (only if none exists) */
      await client.query(
        `INSERT INTO salary_payments (employee_id, amount, payment_date, notes, created_by)
         VALUES ($1, $2, $3, 'Auto-paid via payslip generation', $4)`,
        [employeeId, totalEarnings, weekEnd, req.session.user.id]
      );
    }

    const result = await client.query(
      `INSERT INTO payroll_statuses (employee_id, week_start, status, updated_by, updated_at)
       VALUES ($1, $2, 'generated', $3, NOW())
       ON CONFLICT (employee_id, week_start)
       DO UPDATE SET status = 'generated', updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING *`,
      [employeeId, weekStart, req.session.user.id]
    );

    await client.query('COMMIT');
    await logAudit(req.session.user.id, 'generate', 'payslip', result.rows[0].id, { employee_id: employeeId, week_start: weekStart, auto_paid: totalEarnings });
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/payroll/:employeeId/unlock', requireAuth, async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const employee = await pool.query('SELECT pay_period_days FROM employees WHERE id = $1', [employeeId]);
  if (!employee.rowCount) return res.status(404).json({ error: 'Employee not found.' });
  const periodDays = getPeriodDays(employee.rows[0].pay_period_days);
  const weekStart = periodStartOf(req.body.weekStart || todayInManila(), periodDays);
  const weekEnd = addDays(weekStart, periodDays - 1);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    /* Remove auto-created salary payment from payslip generation */
    await client.query(
      `DELETE FROM salary_payments
       WHERE employee_id = $1 AND payment_date BETWEEN $2 AND $3 AND notes = 'Auto-paid via payslip generation'`,
      [employeeId, weekStart, weekEnd]
    );
    const result = await client.query(
      `UPDATE payroll_statuses SET status = 'unpaid', updated_by = $1, updated_at = NOW()
       WHERE employee_id = $2 AND week_start = $3 RETURNING *`,
      [req.session.user.id, employeeId, weekStart]
    );
    if (!result.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Generated payslip not found.' }); }
    await client.query('COMMIT');
    await logAudit(req.session.user.id, 'unlock', 'payslip', result.rows[0].id, { employee_id: employeeId, week_start: weekStart });
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/payroll/payment', requireAuth, async (req, res) => {
  const { employee_id, weekStart, paid_amount } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'Employee is required.' });
  if (paid_amount === undefined || paid_amount === '' || Number(paid_amount) < 0) {
    return res.status(400).json({ error: 'Valid paid amount is required.' });
  }
  const empResult = await pool.query('SELECT pay_period_days FROM employees WHERE id = $1', [employee_id]);
  if (!empResult.rowCount) return res.status(404).json({ error: 'Employee not found.' });
  const empPeriodDays = getPeriodDays(empResult.rows[0]?.pay_period_days);
  if (await isWeekLocked(employee_id, periodStartOf(weekStart || todayInManila(), empPeriodDays))) {
    return res.status(403).json({ error: 'Cannot update payment: payroll period is locked. Unlock the payslip first.' });
  }

  const start = periodStartOf(weekStart || todayInManila(), empPeriodDays);
  const end = addDays(start, empPeriodDays - 1);
  const [totals, carryovers, baleResult] = await Promise.all([
    pool.query(
      `WITH attendance AS (
         SELECT COALESCE(SUM(rate_snapshot), 0)::numeric(12,2) AS salary
         FROM attendance_logs
         WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3
       ),
       advances AS (
         SELECT COALESCE(SUM(amount), 0)::numeric(12,2) AS cash_advance
         FROM cash_advances
         WHERE employee_id = $1 AND advance_date BETWEEN $2 AND $3
       )
       SELECT attendance.salary, advances.cash_advance
       FROM attendance, advances`,
      [employee_id, start, end]
    ),
    getPayrollCarryoversBefore(employee_id, start, empPeriodDays),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric(12,2) AS total FROM bale_payments
       WHERE employee_id = $1 AND payment_date BETWEEN $2 AND $3`,
      [employee_id, start, end]
    )
  ]);
  const previousBaleBalance = carryovers.baleBalance;
  const previousUnpaidBalance = carryovers.unpaidBalance;
  const salary = money(totals.rows[0]?.salary);
  const cashAdvance = money(totals.rows[0]?.cash_advance);
  const existingBalePaid = money(baleResult.rows[0]?.total);
  const [extraResult] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric(12,2) AS total FROM extra_payments
       WHERE employee_id = $1 AND extra_date BETWEEN $2 AND $3`,
      [employee_id, start, end]
    )
  ]);
  const existingExtraPaid = money(extraResult?.rows?.[0]?.total);
  const weekState = calculatePayrollWeekState({
    previousBaleBalance,
    previousUnpaidBalance,
    salary,
    cashAdvance,
    salaryPaidAmount: Number(paid_amount),
    balePaymentAmount: existingBalePaid,
    extraPayment: existingExtraPaid
  });
  if (Number(paid_amount) + existingBalePaid > weekState.paymentLimit) {
    return res.status(400).json({ error: 'Salary payment cannot exceed previous unpaid plus current salary.' });
  }

  const result = await pool.query(
    `INSERT INTO payroll_statuses (employee_id, week_start, status, paid_amount, paid_at, updated_by, updated_at)
     VALUES ($1, $2, 'unpaid', $3, CASE WHEN $3::numeric > 0 THEN NOW() ELSE NULL END, $4, NOW())
     ON CONFLICT (employee_id, week_start)
     DO UPDATE SET paid_amount = EXCLUDED.paid_amount,
       paid_at = EXCLUDED.paid_at,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING *`,
    [employee_id, start, paid_amount, req.session.user.id]
  );
  await logAudit(req.session.user.id, 'update', 'payroll_payment', result.rows[0].id, {
    employee_id,
    week_start: start,
    paid_amount
  });

  res.json(result.rows[0]);
});

app.delete('/api/payroll/payment', requireAuth, requireAdmin, async (req, res) => {
  const { employee_id, weekStart } = req.body;
  if (!employee_id || !weekStart) {
    return res.status(400).json({ error: 'Employee ID and week start are required.' });
  }
  const empResult = await pool.query('SELECT pay_period_days FROM employees WHERE id = $1', [employee_id]);
  if (!empResult.rowCount) return res.status(404).json({ error: 'Employee not found.' });
  const empPeriodDays = getPeriodDays(empResult.rows[0]?.pay_period_days);
  const start = periodStartOf(weekStart, empPeriodDays);
  if (await isWeekLocked(employee_id, start)) {
    return res.status(403).json({ error: 'Cannot delete payment: payroll period is locked. Unlock the payslip first.' });
  }
  const result = await pool.query(
    `UPDATE payroll_statuses
     SET paid_amount = 0, paid_at = NULL, updated_by = $1, updated_at = NOW()
     WHERE employee_id = $2 AND week_start = $3
     RETURNING *`,
    [req.session.user.id, employee_id, start]
  );
  await logAudit(req.session.user.id, 'delete', 'payroll_payment', result.rows[0]?.id || null, {
    employee_id,
    week_start: start
  });
  res.json(result.rows[0] || { ok: true });
});

app.get('/api/audit-logs', requireAuth, requireAdmin, async (req, res) => {
  const { entity, action, search, date_from, date_to, page = 1, pageSize = 50 } = req.query;
  const params = [];
  const conditions = [];
  let paramIndex = 0;

  if (entity) {
    paramIndex++;
    params.push(entity);
    conditions.push(`a.entity = $${paramIndex}`);
  }
  if (action) {
    paramIndex++;
    params.push(action);
    conditions.push(`a.action = $${paramIndex}`);
  }
  if (search) {
    paramIndex++;
    params.push(`%${search}%`);
    conditions.push(`(a.details::text ILIKE $${paramIndex} OR u.username ILIKE $${paramIndex})`);
  }
  if (date_from) {
    paramIndex++;
    params.push(date_from);
    conditions.push(`a.created_at >= $${paramIndex}`);
  }
  if (date_to) {
    paramIndex++;
    params.push(date_to + ' 23:59:59');
    conditions.push(`a.created_at <= $${paramIndex}`);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const countResult = await pool.query(
    `SELECT COUNT(*) AS total FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);
  const totalPages = Math.ceil(total / Number(pageSize)) || 1;
  const safePage = Math.min(Math.max(1, Number(page)), totalPages);
  const offset = (safePage - 1) * Number(pageSize);

  const result = await pool.query(
    `SELECT a.*, u.username
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     ${whereClause}
     ORDER BY a.created_at DESC
     LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2}`,
    [...params, String(pageSize), String(offset)]
  );
  res.json({ rows: result.rows, total, page: safePage, totalPages });
});

app.put('/api/password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password are required.' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  const userResult = await pool.query('SELECT id, password_hash, must_change_password FROM users WHERE id = $1', [req.session.user.id]);
  if (!userResult.rowCount) return res.status(404).json({ error: 'User not found.' });
  const user = userResult.rows[0];
  if (!user.must_change_password) {
    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (current_password === new_password && !user.must_change_password) {
    return res.status(400).json({ error: 'New password must be different from current password.' });
  }
  const newHash = await bcrypt.hash(new_password, 12);
  await pool.query('UPDATE users SET password_hash = $1, must_change_password = false, updated_at = NOW() WHERE id = $2', [newHash, user.id]);
  await logAudit(user.id, 'update', 'user', user.id, { action: 'password_change', forced: user.must_change_password });
  res.json({ ok: true });
});

/* ── Attendance Registrations (Flutter app approvals) ── */
function registrationStatusParam(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (['pending', 'review', 'approved', 'rejected', 'archived'].includes(s)) return s;
  return 'pending';
}

app.get('/api/registrations', requireAuth, async (req, res) => {
  const status = registrationStatusParam(req.query.status);
  const search = `%${req.query.search || ''}%`;
  let where;
  if (status === 'approved' || status === 'rejected') {
    where = `status = $2`;
  } else {
    where = `status IN ('pending', 'review')`;
  }
  const params = [search, ...(status === 'approved' || status === 'rejected' ? [status] : [])];
  const result = await pool.query(
    `SELECT id, employee_id, name, email, phone, face_image,
            status, admin_notes, registered_at, approved_at, payroll_employee_id
     FROM attendance.employees
     WHERE ${where} AND (name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR employee_id ILIKE $1)
     ORDER BY CASE status WHEN 'review' THEN 0 ELSE 1 END, registered_at DESC`,
    params
  );
  const countsResult = await pool.query(
    `SELECT status, COUNT(*)::int AS count FROM attendance.employees GROUP BY status`
  );
  const counts = { pending: 0, review: 0, approved: 0, rejected: 0, archived: 0 };
  for (const row of countsResult.rows) {
    const key = registrationStatusParam(row.status);
    if (key in counts) counts[key] = row.count;
  }
  res.json({ rows: result.rows, counts });
});

app.post('/api/registrations/:id/approve', requireAuth, validateIdParam, async (req, res) => {
  const { rate, pay_period_days = 7 } = req.body;
  const existing = await pool.query(
    `SELECT * FROM attendance.employees WHERE id = $1 AND status IN ('pending', 'review')`,
    [req.params.id]
  );
  if (!existing.rowCount) return res.status(404).json({ error: 'Registration not found or already reviewed.' });
  const reg = existing.rows[0];

  if (rate === undefined || rate === '' || Number(rate) < 500) {
    return res.status(400).json({ error: 'Daily rate must be at least ₱500.00.' });
  }
  const periodDays = Math.max(1, Math.floor(Number(pay_period_days) || 7));

  const phone = String(reg.phone || '').trim();
  if (!/^[0-9]{11}$/.test(phone)) {
    return res.status(400).json({ error: 'Registration phone must be exactly 11 digits (numbers only).' });
  }
  const phoneCheck = await pool.query('SELECT id, name FROM employees WHERE phone = $1', [phone]);
  let linkExisting = null;
  if (phoneCheck.rowCount > 0) {
    linkExisting = phoneCheck.rows[0];
  } else {
    const email = String(reg.email || '').trim();
    if (email) {
      const emailCheck = await pool.query('SELECT id, name FROM employees WHERE LOWER(email) = LOWER($1)', [email]);
      if (emailCheck.rowCount > 0) linkExisting = emailCheck.rows[0];
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const name = (reg.name || '').trim();
    let payrollEmployeeId;
    const faceFilename = String(reg.face_image || '').trim();
    const photoUrl = faceFilename ? `/attendance-faces/${encodeURIComponent(faceFilename)}` : null;
    if (linkExisting) {
      payrollEmployeeId = linkExisting.id;
      await client.query(
        `UPDATE employees
         SET rate = $1, pay_period_days = $2,
             photo_url = CASE WHEN photo_url IS NULL OR photo_url = '' THEN $3 ELSE photo_url END
         WHERE id = $4`,
        [Number(rate), periodDays, photoUrl, payrollEmployeeId]
      );
    } else {
      const empNumber = await client.query(
        `SELECT ('EMP-' || LPAD(nextval('employee_number_seq')::text, 5, '0')) AS emp_number`
      );
      const parts = name.split(/\s+/);
      const first = parts[0] || '';
      const last = parts.slice(1).join(' ') || '';

      const empInsert = await client.query(
        `INSERT INTO employees (emp_number, first_name, last_name, name, phone, rate, pay_period_days, active, photo_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
         RETURNING id`,
        [empNumber.rows[0].emp_number, first, last, name, phone, Number(rate), periodDays, photoUrl]
      );
      payrollEmployeeId = empInsert.rows[0].id;
    }

    const newEmpId = await client.query(
      `SELECT (
         'EMP-' || EXTRACT(YEAR FROM CURRENT_DATE)::int || '-' ||
         LPAD((COALESCE(MAX(NULLIF(split_part(employee_id, '-', 4), '')::int), 0) + 1)::text, 4, '0')
       ) AS emp_id
       FROM attendance.employees
       WHERE employee_id LIKE 'EMP-' || EXTRACT(YEAR FROM CURRENT_DATE)::int || '-%'`
    );
    const attendanceEmpId = newEmpId.rows[0].emp_id;

    await client.query(
      `UPDATE attendance.employees
       SET status = 'approved', employee_id = $1, approved_at = NOW(), admin_notes = NULL, payroll_employee_id = $2
       WHERE id = $3`,
      [attendanceEmpId, payrollEmployeeId, req.params.id]
    );

    await client.query('COMMIT');
    await logAudit(req.session.user.id, 'approve', 'registration', Number(req.params.id), {
      name,
      phone,
      rate: Number(rate),
      attendance_employee_id: attendanceEmpId,
      payroll_employee_id: payrollEmployeeId
    });
    res.status(201).json({
      ok: true,
      attendance_employee_id: attendanceEmpId,
      payroll_employee_id: payrollEmployeeId
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.post('/api/registrations/:id/reject', requireAuth, validateIdParam, async (req, res) => {
  const notes = String(req.body.notes || '').trim().slice(0, 300);
  const result = await pool.query(
    `UPDATE attendance.employees SET status = 'rejected', admin_notes = $1
     WHERE id = $2 AND status IN ('pending', 'review') RETURNING id`,
    [notes, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Registration not found or already reviewed.' });
  await logAudit(req.session.user.id, 'reject', 'registration', Number(req.params.id), { notes });
  res.json({ ok: true });
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', uptime: process.uptime(), db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'attendance_system', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Payroll system running at http://localhost:${PORT}`);
    });
    ensureAttendanceBackend();
  })
  .catch(error => {
    console.error('Failed to start app:', error);
    process.exit(1);
  });

/* ---- Attendance backend (FastAPI) auto-start ---- */
let attendanceBackend = null;
const ATTENDANCE_BACKEND_AUTOSTART = String(process.env.ATTENDANCE_BACKEND_AUTOSTART ?? 'true').toLowerCase() !== 'false';
const ATTENDANCE_PORT = Number(process.env.ATTENDANCE_PORT) || 8000;
const ATTENDANCE_PYTHON_CANDIDATES = [
  process.env.ATTENDANCE_BACKEND_PYTHON,
  'python',
  'py',
].filter(Boolean);

function attendancePortInUse() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
    socket.connect(ATTENDANCE_PORT, '127.0.0.1');
  });
}

function spawnAttendanceBackend(pythonCmd) {
  const backendDir = path.join(__dirname, 'attendance_system', 'backend');
  const child = spawn(pythonCmd, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(ATTENDANCE_PORT)], {
    cwd: backendDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let spawnFailed = false;
  child.stdout.on('data', (data) => process.stdout.write(`[attendance] ${data}`));
  child.stderr.on('data', (data) => process.stderr.write(`[attendance] ${data}`));
  child.on('error', (err) => {
    spawnFailed = true;
    const nextIndex = ATTENDANCE_PYTHON_CANDIDATES.indexOf(pythonCmd) + 1;
    if (nextIndex < ATTENDANCE_PYTHON_CANDIDATES.length) {
      console.log(`[attendance] '${pythonCmd}' not available, trying '${ATTENDANCE_PYTHON_CANDIDATES[nextIndex]}'.`);
      spawnAttendanceBackend(ATTENDANCE_PYTHON_CANDIDATES[nextIndex]);
    } else {
      console.error(`[attendance] Could not start attendance backend (${pythonCmd}): ${err.message}`);
      attendanceBackend = null;
    }
  });
  child.on('exit', (code) => {
    if (!spawnFailed) {
      console.log(`[attendance] Attendance backend exited (code=${code}).`);
      attendanceBackend = null;
    }
  });
  attendanceBackend = child;
}

async function ensureAttendanceBackend() {
  if (!ATTENDANCE_BACKEND_AUTOSTART) {
    console.log('[attendance] Auto-start disabled (ATTENDANCE_BACKEND_AUTOSTART=false).');
    return;
  }
  if (await attendancePortInUse()) {
    console.log(`[attendance] Already running on port ${ATTENDANCE_PORT}.`);
    return;
  }
  console.log(`[attendance] Starting backend on port ${ATTENDANCE_PORT}...`);
  spawnAttendanceBackend(ATTENDANCE_PYTHON_CANDIDATES[0]);
}

function stopAttendanceBackend() {
  if (attendanceBackend) {
    try { attendanceBackend.kill(); } catch (e) { /* already gone */ }
    attendanceBackend = null;
  }
}

process.on('exit', stopAttendanceBackend);
process.on('SIGINT', () => { stopAttendanceBackend(); process.exit(0); });
process.on('SIGTERM', () => { stopAttendanceBackend(); process.exit(0); });
