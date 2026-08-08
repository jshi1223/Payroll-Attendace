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
const http = require('http');

/* Fall back to the attendance backend's .env so FCM + schema config is shared */
(function loadAttendanceEnv() {
  const envPath = path.join(__dirname, 'attendance_system', 'backend', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    if (key in process.env) continue;
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    process.env[key] = value;
  }
})();

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

/* Anti-cheat rule shared with the attendance backend: a time-out must be at
   least MIN_WORK_MINUTES after the time-in. Loaded from the attendance .env
   (loadAttendanceEnv above) so one value controls both apps. */
const MIN_WORK_MINUTES = Number(process.env.MIN_WORK_MINUTES || 30);

function validateTimeRange(timeIn, timeOut) {
  if (!timeIn || !timeOut) return null;
  const inParts = String(timeIn).split(':').map(Number);
  const outParts = String(timeOut).split(':').map(Number);
  if (inParts.length < 2 || outParts.length < 2 || isNaN(inParts[0]) || isNaN(outParts[0])) return null;
  const inMinutes = inParts[0] * 60 + (inParts[1] || 0);
  const outMinutes = outParts[0] * 60 + (outParts[1] || 0);
  const diff = outMinutes - inMinutes;
  if (diff < 0) return 'Time out cannot be earlier than time in.';
  if (diff < MIN_WORK_MINUTES) return `Time out must be at least ${MIN_WORK_MINUTES} minutes after time in.`;
  return null;
}

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

/* Broadcast to connected admin panels whenever data changes (only on success) */
const MUTATION_PATTERNS = [
  { method: 'POST', pattern: /^\/api\/employees$/ },
  { method: 'PUT', pattern: /^\/api\/employees\/\d+$/ },
  { method: 'DELETE', pattern: /^\/api\/employees\/\d+$/ },
  { method: 'POST', pattern: /^\/api\/employees\/\d+\/photo$/ },
  { method: 'DELETE', pattern: /^\/api\/employees\/\d+\/photo$/ },
  { method: 'PUT', pattern: /^\/api\/employees\/\d+\/restore$/ },
  { method: 'DELETE', pattern: /^\/api\/employees\/\d+\/permanent$/ },
  { method: 'POST', pattern: /^\/api\/attendance$/ },
  { method: 'POST', pattern: /^\/api\/attendance\/bulk$/ },
  { method: 'POST', pattern: /^\/api\/attendance\/mark-all$/ },
  { method: 'PUT', pattern: /^\/api\/attendance\/\d+$/ },
  { method: 'DELETE', pattern: /^\/api\/attendance\/\d+$/ },
  { method: 'POST', pattern: /^\/api\/extra-payments$/ },
  { method: 'PUT', pattern: /^\/api\/extra-payments\/\d+$/ },
  { method: 'DELETE', pattern: /^\/api\/extra-payments\/\d+$/ },
  { method: 'POST', pattern: /^\/api\/salary-payments$/ },
  { method: 'PUT', pattern: /^\/api\/salary-payments\/\d+$/ },
  { method: 'DELETE', pattern: /^\/api\/salary-payments\/\d+$/ },
  { method: 'POST', pattern: /^\/api\/bale-payments$/ },
  { method: 'PUT', pattern: /^\/api\/bale-payments\/\d+$/ },
  { method: 'DELETE', pattern: /^\/api\/bale-payments\/\d+$/ },
  { method: 'POST', pattern: /^\/api\/cash-advances$/ },
  { method: 'PUT', pattern: /^\/api\/cash-advances\/\d+$/ },
  { method: 'DELETE', pattern: /^\/api\/cash-advances\/\d+$/ },
  { method: 'POST', pattern: /^\/api\/cash-advance-requests\/\d+\/(approve|reject)$/ },
  { method: 'POST', pattern: /^\/api\/payslip-requests\/\d+\/(approve|reject)$/ },
  { method: 'POST', pattern: /^\/api\/payroll\/review$/ },
  { method: 'POST', pattern: /^\/api\/payroll\/submit-review$/ },
  { method: 'POST', pattern: /^\/api\/payroll\/\d+\/generate$/ },
  { method: 'POST', pattern: /^\/api\/payroll\/\d+\/unlock$/ },
  { method: 'PUT', pattern: /^\/api\/payroll\/payment$/ },
  { method: 'DELETE', pattern: /^\/api\/payroll\/payment$/ },
  { method: 'POST', pattern: /^\/api\/registrations\/\d+\/approve$/ },
  { method: 'POST', pattern: /^\/api\/registrations\/\d+\/reject$/ }
];

app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    for (const rule of MUTATION_PATTERNS) {
      if (rule.method === req.method && rule.pattern.test(req.path)) {
        notifyDataChanged({ type: 'data_changed' });
        break;
      }
    }
  });
  next();
});

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

/* PostgreSQL DATE values can arrive through node-postgres as a JavaScript Date.
   Do not read those with UTC getters: a Manila midnight can then become the
   previous calendar day. This is used only for database date values that must
   stay aligned with the employee app's Manila calendar. */
function databaseDateOnly(value) {
  if (typeof value === 'string') return value.slice(0, 10);
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return String(value || '').slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
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

/* ── Realtime: server-sent events broadcast to connected admin panels ── */
const sseClients = new Set();

function notifyDataChanged(payload = {}) {
  const message = JSON.stringify({ ...payload, ts: Date.now() });
  for (const client of sseClients) {
    try { client.write(`data: ${message}\n\n`); } catch (_) { sseClients.delete(client); }
  }
}

/* ── FCM push notifications to employee devices ── */
let _fcmAccessToken = '';
let _fcmAccessTokenExpiresAt = 0;

function fcmServiceAccount() {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_CREDENTIALS || '';
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data.client_email || !data.private_key || !data.project_id) return null;
    return data;
  } catch (_) { return null; }
}

async function getFcmAccessToken() {
  const account = fcmServiceAccount();
  if (!account) return null;
  const now = Math.floor(Date.now() / 1000);
  if (_fcmAccessToken && now < _fcmAccessTokenExpiresAt - 60) return _fcmAccessToken;
  const tokenUri = account.token_uri || 'https://oauth2.googleapis.com/token';
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: tokenUri,
    iat: now,
    exp: now + 3600
  })).toString('base64url');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const assertion = `${header}.${payload}.${signer.sign(account.private_key, 'base64url')}`;
  try {
    const resp = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      }).toString()
    });
    const data = await resp.json();
    if (!data.access_token) return null;
    _fcmAccessToken = data.access_token;
    _fcmAccessTokenExpiresAt = now + (data.expires_in || 3600);
    return _fcmAccessToken;
  } catch (_) { return null; }
}

function attendanceSchemaName() {
  const schema = (process.env.DB_SCHEMA || 'attendance').trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(schema) ? schema : 'attendance';
}

async function sendFcmToEmployee(payrollEmployeeId, title, body, data = {}) {
  if (!payrollEmployeeId) return false;
  const token = await getFcmAccessToken();
  const account = fcmServiceAccount();
  if (!token || !account) return false;
  try {
    const schema = attendanceSchemaName();
    const result = await pool.query(
      `SELECT edt.device_token
       FROM ${schema}.employee_device_tokens edt
       JOIN ${schema}.employees e ON e.employee_id = edt.employee_id
       WHERE e.payroll_employee_id = $1
       ORDER BY edt.updated_at DESC
       LIMIT 5`,
      [Number(payrollEmployeeId)]
    );
    const deviceTokens = result.rows.map(r => r.device_token).filter(Boolean);
    if (!deviceTokens.length) return false;
    let sent = false;
    const endpoint = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
    for (const deviceToken of deviceTokens) {
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8'
          },
          body: JSON.stringify({
            message: {
              token: deviceToken,
              notification: { title, body },
              data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
              android: { priority: 'high' }
            }
          })
        });
        if (resp.ok) sent = true;
      } catch (_) { /* fire and forget */ }
    }
    return sent;
  } catch (_) { return false; }
}

async function sendFcmBroadcast(title, body, data = {}) {
  const token = await getFcmAccessToken();
  const account = fcmServiceAccount();
  if (!token || !account) return 0;
  try {
    const schema = attendanceSchemaName();
    const result = await pool.query(
      `SELECT DISTINCT edt.device_token
       FROM ${schema}.employee_device_tokens edt
       JOIN ${schema}.employees e ON e.employee_id = edt.employee_id
       WHERE e.status = 'approved' AND edt.device_token IS NOT NULL AND edt.device_token <> ''`
    );
    const deviceTokens = result.rows.map(r => r.device_token).filter(Boolean);
    if (!deviceTokens.length) return 0;
    const endpoint = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
    let sent = 0;
    for (const deviceToken of deviceTokens) {
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8'
          },
          body: JSON.stringify({
            message: {
              token: deviceToken,
              notification: { title, body },
              data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
              android: { priority: 'high' }
            }
          })
        });
        if (resp.ok) sent++;
      } catch (_) { /* fire and forget */ }
    }
    return sent;
  } catch (_) { return 0; }
}

async function sendPayrollUpdatedPush(employeeId, label = '') {
  await sendFcmToEmployee(employeeId, 'Payroll updated', label
    ? `Your payroll record was updated (${label}).`
    : 'Your payroll record was updated.', { type: 'payroll_updated', employee_id: String(employeeId), screen: 'payroll' });
}

/* Money-informing push notifications for payroll transactions */
async function sendBalePaymentPush(employeeId, amount) {
  try {
    const ca = await pool.query('SELECT COALESCE(SUM(amount),0)::numeric(12,2) AS total FROM cash_advances WHERE employee_id = $1', [employeeId]);
    const bp = await pool.query('SELECT COALESCE(SUM(amount),0)::numeric(12,2) AS total FROM bale_payments WHERE employee_id = $1', [employeeId]);
    const balance = Math.max(Number(ca.rows[0].total) - Number(bp.rows[0].total), 0);
    await createNotification({ recipientType: 'employee', recipientId: employeeId, type: 'bale_payment',
      title: 'Cash advance payment',
      body: 'A cash advance payment was recorded for you. View the details in your Payroll tab.',
      data: { amount: money(amount), balance } });
    await sendFcmToEmployee(employeeId, 'Cash advance payment',
      'A cash advance payment was recorded for you. View the details in your Payroll tab.',
      { type: 'bale_payment', screen: 'payroll', employee_id: String(employeeId) });
  } catch (_) { /* fire and forget */ }
}

async function sendExtraPayPush(employeeId, amount, date) {
  await createNotification({ recipientType: 'employee', recipientId: employeeId, type: 'extra_pay_added',
    title: 'Extra pay added',
    body: 'Extra pay was added to your payroll. View the details in your Payroll tab.',
    data: { amount: money(amount), date } });
  await sendFcmToEmployee(employeeId, 'Extra pay added',
    'Extra pay was added to your payroll. View the details in your Payroll tab.',
    { type: 'extra_pay_added', screen: 'payroll', employee_id: String(employeeId) });
}

async function sendSalaryPaidPush(employeeId, amount) {
  await createNotification({ recipientType: 'employee', recipientId: employeeId, type: 'salary_paid',
    title: 'Salary paid',
    body: 'Your salary payment was recorded. View the details in your Payroll tab.',
    data: { amount: money(amount) } });
  await sendFcmToEmployee(employeeId, 'Salary paid',
    'Your salary payment was recorded. View the details in your Payroll tab.',
    { type: 'salary_paid', screen: 'payroll', employee_id: String(employeeId) });
}

/* In-app notification rows (works without FCM so the bell always shows
   announcements and payroll events). recipientType 'all-employees' fans out
   one row per approved attendance employee that has a payroll record. */
async function createNotification({ recipientType = 'employee', recipientId = null, type, title, body = '', data = {} }) {
  try {
    if (recipientType === 'all-employees') {
      const schema = attendanceSchemaName();
      const result = await pool.query(
        `SELECT e.payroll_employee_id
         FROM ${schema}.employees e
         WHERE e.status = 'approved' AND e.payroll_employee_id IS NOT NULL`
      );
      for (const r of result.rows) {
        await pool.query(
          `INSERT INTO notifications (recipient_type, recipient_id, type, title, body, data)
           VALUES ('employee', $1, $2, $3, $4, $5)`,
          [r.payroll_employee_id, type, title, body, JSON.stringify(data)]
        );
      }
      return result.rowCount;
    }
    const r = await pool.query(
      `INSERT INTO notifications (recipient_type, recipient_id, type, title, body, data)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [recipientType, recipientId, type, title, body, JSON.stringify(data)]
    );
    return r.rowCount;
  } catch (_) { return 0; }
}

/* ── Scheduled reminder notifications (payday + overdue cash advance) ── */
let _lastReminderDate = '';

function manilaTomorrow() {
  const today = todayInManila();
  const d = parseDateOnly(today);
  d.setUTCDate(d.getUTCDate() + 1);
  return formatDateOnly(d);
}

/* Deduplicate scheduled reminders so a server restart does not re-send the
   same reminder twice on the same calendar day. */
async function reminderAlreadySentToday(type) {
  try {
    const r = await pool.query(
      `SELECT 1 FROM notifications
       WHERE type = $1 AND created_at::date = CURRENT_DATE
       LIMIT 1`,
      [type]
    );
    return r.rowCount > 0;
  } catch (_) { return true; }
}

async function runScheduledReminders() {
  const today = todayInManila();
  if (_lastReminderDate === today) return;
  try {
    const tomorrow = manilaTomorrow();
    const periodDaysResult = await pool.query(
      `SELECT DISTINCT COALESCE(pay_period_days, 7) AS pd FROM employees WHERE active`
    );
    let paydayTomorrow = false;
    for (const row of periodDaysResult.rows) {
      const pd = getPeriodDays(row.pd);
      if (periodEndOf(tomorrow, pd) === tomorrow) { paydayTomorrow = true; break; }
    }
    if (paydayTomorrow && !(await reminderAlreadySentToday('payday_reminder'))) {
      const upcoming = periodStartOf(tomorrow, 7);
      await createNotification({
        recipientType: 'all-employees', type: 'payday_reminder',
        title: 'Payday tomorrow',
        body: 'Your salary will be available tomorrow. Check your Payroll tab for the updated payslip.',
        data: { period: upcoming }
      });
      await sendFcmBroadcast('Payday tomorrow',
        'Your salary will be available tomorrow. Check your Payroll tab for the updated payslip.',
        { type: 'payday_reminder', screen: 'payroll', period: upcoming });
    }
    /* Cash advance overdue reminder: weekly (skip if one was sent in the last 7 days). */
    const weekly = await pool.query(
      `SELECT 1 FROM notifications
       WHERE type = 'ca_overdue_reminder' AND created_at > CURRENT_DATE - INTERVAL '7 days'
       LIMIT 1`
    );
    if (weekly.rowCount > 0) { _lastReminderDate = today; return; }
    const overdueResult = await pool.query(
      `SELECT e.id,
              COALESCE((SELECT SUM(amount) FROM cash_advances ca WHERE ca.employee_id = e.id), 0) AS ca_total,
              COALESCE((SELECT SUM(amount) FROM bale_payments bp WHERE bp.employee_id = e.id), 0) AS bp_total
       FROM employees e
       WHERE e.active`
    );
    const schema = attendanceSchemaName();
    for (const row of overdueResult.rows) {
      const balance = Math.max(money(row.ca_total) - money(row.bp_total), 0);
      if (balance <= 0) continue;
      const link = await pool.query(
        `SELECT payroll_employee_id FROM ${schema}.employees WHERE employee_id = $1 LIMIT 1`,
        [row.id]
      );
      const payrollEmployeeId = link.rows[0]?.payroll_employee_id;
      if (!payrollEmployeeId) continue;
      await createNotification({
        recipientType: 'employee', recipientId: payrollEmployeeId, type: 'ca_overdue_reminder',
        title: 'Cash advance balance',
        body: 'You still have a pending cash advance balance. Check your Payroll tab for details.',
        data: { balance }
      });
      await sendFcmToEmployee(payrollEmployeeId, 'Cash advance balance',
        'You still have a pending cash advance balance. Check your Payroll tab for details.',
        { type: 'ca_overdue_reminder', screen: 'payroll', employee_id: String(payrollEmployeeId) });
    }
    _lastReminderDate = today;
  } catch (_) { /* reminders are best-effort */ }
}

/* Check hourly; each type is only sent once per calendar day. */
setInterval(runScheduledReminders, 60 * 60 * 1000);

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

  const balance = Math.max(previousUnpaidBalance - paymentToPreviousUnpaid, 0) + currentUnpaidBalance + effectiveExtraPay;
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
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      title VARCHAR(160) NOT NULL,
      message TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      recipient_type VARCHAR(20) NOT NULL DEFAULT 'employee' CHECK (recipient_type IN ('employee', 'admin')),
      recipient_id INTEGER,
      type VARCHAR(50) NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_recipient
      ON notifications(recipient_type, recipient_id, created_at DESC);
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
    CREATE TABLE IF NOT EXISTS cash_advance_requests (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
      reason TEXT NOT NULL DEFAULT '',
      pickup_date DATE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_cash_advance_requests_status ON cash_advance_requests(status);
    CREATE INDEX IF NOT EXISTS idx_cash_advance_requests_employee ON cash_advance_requests(employee_id);
    CREATE TABLE IF NOT EXISTS deleted_attendance_marks (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      work_date DATE NOT NULL,
      deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (employee_id, work_date)
    );
    CREATE TABLE IF NOT EXISTS payslip_requests (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      attendance_employee_id VARCHAR(50),
      name VARCHAR(255) NOT NULL DEFAULT '',
      email VARCHAR(255) NOT NULL DEFAULT '',
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      notes TEXT DEFAULT '',
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_payslip_requests_status ON payslip_requests(status);
    CREATE INDEX IF NOT EXISTS idx_payslip_requests_employee ON payslip_requests(employee_id);
  `);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone VARCHAR(20) NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE cash_advance_requests ADD COLUMN IF NOT EXISTS pickup_date DATE`);
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
  await pool.query(`ALTER TABLE attendance.employees ADD COLUMN IF NOT EXISTS first_name VARCHAR(80) NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE attendance.employees ADD COLUMN IF NOT EXISTS last_name VARCHAR(80) NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE attendance.employees ADD COLUMN IF NOT EXISTS sss_number VARCHAR(12) NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE attendance.employees ADD COLUMN IF NOT EXISTS philhealth_number VARCHAR(14) NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE attendance.employees ADD COLUMN IF NOT EXISTS pagibig_number VARCHAR(14) NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE attendance.employees ADD COLUMN IF NOT EXISTS tin_number VARCHAR(15) NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL`);

  /* Mirror government IDs from the payroll table into the attendance/mobile
     accounts so the employee's app profile shows the same SSS, PhilHealth,
     Pag-IBIG, and TIN the admin sees in the web app. This is idempotent and
     also backfills any accounts created before the mirror was added. */
  await pool.query(`
    UPDATE attendance.employees a
    SET sss_number = e.sss_number,
        philhealth_number = e.philhealth_number,
        pagibig_number = e.pagibig_number,
        tin_number = e.tin_number
    FROM employees e
    WHERE a.payroll_employee_id = e.id
  `);

  /* Payroll review/acceptance step before bulk printing */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll_reviews (
      period_key VARCHAR(20) PRIMARY KEY,
      period_days INTEGER NOT NULL DEFAULT 7,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL
    )
  `);
  /* HR "submit for review" step (optional) before admin acceptance */
  await pool.query(`ALTER TABLE payroll_reviews ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE payroll_reviews ADD COLUMN IF NOT EXISTS submitted_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL`);

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
  const isActive = active !== false && String(active).toLowerCase() !== 'false';
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
      [empNumber.rows[0].emp_number, empFirstName, empLastName, empName, phone.trim(), email, rate, periodDays, isActive,
       req.body.sss_number || '', req.body.philhealth_number || '', req.body.pagibig_number || '', req.body.tin_number || '']
    );
    const newEmployeeId = result.rows[0].id;

    // Every payroll employee has a matching attendance/mobile record.  An
    // account without credentials remains archived until an admin assigns an
    // email and temporary password through Edit Employee.
    const attendanceEmpId = await client.query(
      `SELECT (
         'EMP-' || EXTRACT(YEAR FROM CURRENT_DATE)::int || '-' ||
         LPAD((COALESCE(MAX(NULLIF(split_part(employee_id, '-', 3), '')::int), 0) + 1)::text, 4, '0')
       ) AS emp_id
       FROM attendance.employees
       WHERE employee_id LIKE 'EMP-' || EXTRACT(YEAR FROM CURRENT_DATE)::int || '-%'`
    );
    const attendanceAccount = attendanceEmpId.rows[0].emp_id;
    const mobileIsReady = Boolean(email && tempPassword && isActive);
    const passwordHash = mobileIsReady ? await bcrypt.hash(tempPassword, 10) : null;
    await client.query(
      `INSERT INTO attendance.employees
         (employee_id, name, email, phone, password_hash, daily_rate, status, approved_at, payroll_employee_id,
          sss_number, philhealth_number, pagibig_number, tin_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 = 'approved' THEN NOW() ELSE NULL END, $8, $9, $10, $11, $12)`,
      [
        attendanceAccount,
        empName,
        email || null,
        phone.trim(),
        passwordHash,
        Number(rate),
        mobileIsReady ? 'approved' : 'archived',
        newEmployeeId,
        req.body.sss_number || '',
        req.body.philhealth_number || '',
        req.body.pagibig_number || '',
        req.body.tin_number || ''
      ]
    );

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

  const before = await pool.query('SELECT * FROM employees WHERE id = $1', [req.params.id]);
  if (!before.rowCount) return res.status(404).json({ error: 'Employee not found.' });

  /* Government identification numbers are sensitive payroll data. HR staff
     may keep editing regular employee details, but only an admin can change
     any of these IDs. */
  const protectedGovIdFields = ['sss_number', 'philhealth_number', 'pagibig_number', 'tin_number'];
  const governmentIdChanged = protectedGovIdFields.some(field =>
    String(req.body[field] || '').trim() !== String(before.rows[0][field] || '').trim()
  );
  if (governmentIdChanged && req.session.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Only an admin can change SSS, PhilHealth, Pag-IBIG, or TIN details.' });
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
         SET email = $1, password_hash = $2, name = $3, phone = $4, daily_rate = $5, status = 'approved',
             sss_number = $6, philhealth_number = $7, pagibig_number = $8, tin_number = $9
         WHERE id = $10`,
        [email, passwordHash, empName, phone.trim(), rate,
         req.body.sss_number || '', req.body.philhealth_number || '', req.body.pagibig_number || '', req.body.tin_number || '',
         existingAccount.rows[0].id]
      );
      mobileAccount = existingAccount.rows[0].employee_id;
    } else {
      const attendanceEmpId = await pool.query(
        `SELECT (
           'EMP-' || EXTRACT(YEAR FROM CURRENT_DATE)::int || '-' ||
       LPAD((COALESCE(MAX(NULLIF(split_part(employee_id, '-', 3), '')::int), 0) + 1)::text, 4, '0')
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

  // Keep manual Active/Inactive edits in sync with the separate mobile account.
  // This also prevents a password reset from re-enabling an archived account.
  await pool.query(
    `UPDATE attendance.employees
     SET status = CASE WHEN $2::boolean THEN 'approved' ELSE 'archived' END
     WHERE payroll_employee_id = $1 AND status IN ('approved', 'archived')`,
    [req.params.id, result.rows[0].active]
  );

  // Mirror government IDs into the mobile account (any status) so the
  // employee's app profile always shows the same SSS / PhilHealth / Pag-IBIG /
  // TIN the admin sees in the web app.
  await pool.query(
    `UPDATE attendance.employees
     SET sss_number = $2, philhealth_number = $3, pagibig_number = $4, tin_number = $5
     WHERE payroll_employee_id = $1`,
    [req.params.id,
     req.body.sss_number || '', req.body.philhealth_number || '', req.body.pagibig_number || '', req.body.tin_number || '']
  );

  await logAudit(req.session.user.id, 'update', 'employee', Number(req.params.id), {
    before: before.rows[0] || null,
    after: result.rows[0],
    mobile_account: mobileAccount
  });
  res.json({ ...result.rows[0], mobile_account: mobileAccount });
});

app.delete('/api/employees/:id', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const employeeId = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const employee = await client.query(
      'UPDATE employees SET active = false WHERE id = $1 RETURNING id, name',
      [employeeId]
    );
    if (!employee.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found.' });
    }

    // The mobile attendance account is separate from the payroll employee.
    // Archive it too so it cannot log in or use an existing app session.
    const mobileAccount = await client.query(
      `UPDATE attendance.employees
       SET status = 'archived'
       WHERE payroll_employee_id = $1`,
      [employeeId]
    );
    await client.query('COMMIT');
    await logAudit(req.session.user.id, 'archive', 'employee', employeeId, {
      name: employee.rows[0].name,
      mobile_account_archived: mobileAccount.rowCount > 0
    });
    res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.post('/api/employees/:id/photo', requireAuth, validateIdParam, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const photoUrl = '/attendance-faces/' + req.file.filename;
  const employeeId = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'UPDATE employees SET photo_url = $1 WHERE id = $2 RETURNING photo_url',
      [photoUrl, employeeId]
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found.' });
    }
    await client.query(
      'UPDATE attendance.employees SET face_image = $1 WHERE payroll_employee_id = $2',
      [req.file.filename, employeeId]
    );
    await client.query('COMMIT');
    res.json({ photo_url: result.rows[0].photo_url });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.delete('/api/employees/:id/photo', requireAuth, validateIdParam, async (req, res) => {
  const employeeId = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE employees SET photo_url = NULL WHERE id = $1 RETURNING photo_url`,
      [employeeId]
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found.' });
    }
    await client.query(
      'UPDATE attendance.employees SET face_image = NULL WHERE payroll_employee_id = $1',
      [employeeId]
    );
    await client.query('COMMIT');
    res.json({ photo_url: null });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.put('/api/employees/:id/restore', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const employeeId = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'UPDATE employees SET active = true WHERE id = $1 RETURNING *',
      [employeeId]
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found.' });
    }

    // Only re-enable accounts that this archive action previously archived.
    const mobileAccount = await client.query(
      `UPDATE attendance.employees
       SET status = 'approved'
       WHERE payroll_employee_id = $1 AND status = 'archived'`,
      [employeeId]
    );
    await client.query('COMMIT');
    await logAudit(req.session.user.id, 'restore', 'employee', employeeId, {
      mobile_account_restored: mobileAccount.rowCount > 0
    });
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.delete('/api/employees/:id/permanent', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const empId = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM employees WHERE id = $1', [empId]);
    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found.' });
    }
    const employee = existing.rows[0];

    // The mobile account lives in a separate schema and has no foreign key to
    // public.employees, so explicitly delete it before removing payroll data.
    // Its attendance logs, device tokens, and reminders cascade from this row.
    const mobileAccount = await client.query(
      'DELETE FROM attendance.employees WHERE payroll_employee_id = $1 RETURNING employee_id',
      [empId]
    );
    await client.query('DELETE FROM payroll_statuses WHERE employee_id = $1', [empId]);
    // attendance_logs & cash_advances are auto-deleted via ON DELETE CASCADE
    await client.query('DELETE FROM employees WHERE id = $1', [empId]);
    await client.query('COMMIT');

    await logAudit(req.session.user.id, 'permanent_delete', 'employee', empId, {
      name: employee.name,
      emp_number: employee.emp_number,
      mobile_accounts_deleted: mobileAccount.rowCount
    });
    res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

/* ── Mobile (Flutter) attendance history mirror ─────────────────────────────
   Admin web edits live in public.attendance_logs, while the employee's app
   history is built from events in attendance.attendance.  These helpers keep
   the two in sync so whatever the admin records also shows up in the app.
   Payroll employees without a linked mobile account are skipped. */

async function clearMobileAttendanceLog(executor, payrollEmployeeId, workDate) {
  const mobile = await executor.query(
    'SELECT employee_id FROM attendance.employees WHERE payroll_employee_id = $1',
    [payrollEmployeeId]
  );
  if (!mobile.rowCount) return;
  await executor.query(
    `DELETE FROM attendance.attendance
     WHERE employee_id = $1 AND DATE(timestamp) = $2::date`,
    [mobile.rows[0].employee_id, workDate]
  );
}

async function syncMobileAttendanceLog(executor, payrollEmployeeId, workDate, { timeIn = null, timeOut = null, rate = null } = {}) {
  const mobile = await executor.query(
    'SELECT employee_id FROM attendance.employees WHERE payroll_employee_id = $1',
    [payrollEmployeeId]
  );
  if (!mobile.rowCount) return;
  const mobileEmployeeId = mobile.rows[0].employee_id;

  /* Replace whatever the app had for that date so admin edits stay authoritative. */
  await executor.query(
    `DELETE FROM attendance.attendance
     WHERE employee_id = $1 AND DATE(timestamp) = $2::date`,
    [mobileEmployeeId, workDate]
  );

  if (timeIn || timeOut) {
    if (timeIn) {
      await executor.query(
        `INSERT INTO attendance.attendance (employee_id, type, rate_snapshot, timestamp)
         VALUES ($1, 'present', $2, ($3::date + $4::time))`,
        [mobileEmployeeId, rate, workDate, timeIn]
      );
    }
    if (timeOut) {
      await executor.query(
        `INSERT INTO attendance.attendance (employee_id, type, rate_snapshot, timestamp)
         VALUES ($1, 'time_out', $2, ($3::date + $4::time))`,
        [mobileEmployeeId, rate, workDate, timeOut]
      );
    }
  } else {
    /* Presence-only mark (no clock times, e.g. bulk / mark-all): use the
       current Manila time-of-day so the day still registers as Present. */
    const timeNow = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: 'Asia/Manila',
    }).format(new Date());
    await executor.query(
      `INSERT INTO attendance.attendance (employee_id, type, rate_snapshot, timestamp)
       VALUES ($1, 'present', $2, ($3::date + $4::time))`,
      [mobileEmployeeId, rate, workDate, timeNow]
    );
  }
}

/* Records that an admin removed an attendance day.  The employee app replays
   offline-queued marks through /present; the guard in main.py uses this so a
   deleted day is not resurrected by a stale offline replay. */
async function tombstoneAttendanceDeletion(executor, payrollEmployeeId, workDate, deletedBy = null) {
  const wd = databaseDateOnly(workDate);
  await executor.query(
    `INSERT INTO deleted_attendance_marks (employee_id, work_date, deleted_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (employee_id, work_date) DO NOTHING`,
    [payrollEmployeeId, wd, deletedBy]
  );
}

app.post('/api/attendance', requireAuth, async (req, res) => {
  const { employee_id, work_date, time_in = null, time_out = null, notes = '' } = req.body;
  const timeRangeError = validateTimeRange(time_in, time_out);
  if (timeRangeError) return res.status(400).json({ error: timeRangeError });
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
  await syncMobileAttendanceLog(pool, employee_id, work_date, {
    timeIn: result.rows[0].time_in,
    timeOut: result.rows[0].time_out,
    rate: result.rows[0].rate_snapshot,
  });
  sendFcmToEmployee(employee_id, 'Attendance updated', 'Your attendance record was updated.', { type: 'attendance_updated', employee_id: String(employee_id) });
  res.status(201).json(result.rows[0]);
});

app.post('/api/attendance/bulk', requireAuth, async (req, res) => {
  const { weekStart, employeeIds = [], present = [], deleteConfirmation, deleteReason } = req.body;
  const start = payrollWeekStartOf(weekStart || todayInManila());
  const end = addDays(start, 6);
  const presentSet = new Set(present.map(item => `${item.employee_id}:${item.work_date}`));
  const existingRows = employeeIds.length
    ? await pool.query(
      `SELECT id, employee_id, work_date, to_char(work_date, 'YYYY-MM-DD') AS work_date_text, notes
       FROM attendance_logs
       WHERE employee_id = ANY($1) AND work_date BETWEEN $2 AND $3`,
      [employeeIds, start, end]
    )
    : { rows: [] };
  const recordsToDelete = existingRows.rows.filter(row =>
    !presentSet.has(`${row.employee_id}:${row.work_date_text}`)
  );
  const bulkDeleteReason = String(deleteReason || '').trim();
  if (recordsToDelete.length) {
    if (req.session.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can remove attendance records.' });
    }
    if (String(deleteConfirmation || '').trim().toUpperCase() !== 'DELETE') {
      return res.status(400).json({ error: 'Type DELETE to confirm bulk attendance deletion.' });
    }
    if (!bulkDeleteReason || bulkDeleteReason.length > 500) {
      return res.status(400).json({ error: 'A deletion reason of 500 characters or fewer is required.' });
    }
  }
  for (const employeeId of employeeIds) {
    if (await isDateLockedForEmployee(employeeId, start)) {
      return res.status(403).json({ error: `Cannot modify attendance: payroll period is locked for employee ${employeeId}. Unlock the payslip first.` });
    }
  }
  const client = await pool.connect();
  const deletedRecords = [];

  try {
    await client.query('BEGIN');
    for (const employeeId of employeeIds) {
      const employee = await client.query('SELECT rate FROM employees WHERE id = $1', [employeeId]);
      if (!employee.rowCount) continue;

      for (let day = 0; day < 7; day += 1) {
        const workDate = addDays(start, day);
        const key = `${employeeId}:${workDate}`;
        if (presentSet.has(key)) {
          const ins = await client.query(
            `INSERT INTO attendance_logs (employee_id, work_date, rate_snapshot, notes, created_by)
             VALUES ($1, $2, $3, 'Present', $4)
             ON CONFLICT (employee_id, work_date) DO NOTHING`,
            [employeeId, workDate, employee.rows[0].rate, req.session.user.id]
          );
          /* Mirror newly-created records into the app history.  Days the
             employee already marked from the app keep their real times. */
          if (ins.rowCount > 0) {
            await syncMobileAttendanceLog(client, employeeId, workDate, { rate: employee.rows[0].rate });
          }
        } else {
          const deleted = await client.query(
            `DELETE FROM attendance_logs
             WHERE employee_id = $1 AND work_date = $2 AND work_date BETWEEN $3 AND $4`,
            [employeeId, workDate, start, end]
          );
          if (deleted.rowCount > 0) {
            const rec = recordsToDelete.find(row =>
              Number(row.employee_id) === Number(employeeId) && row.work_date_text === workDate
            );
            deletedRecords.push({ employeeId, workDate, notes: rec?.notes || '' });
            await clearMobileAttendanceLog(client, employeeId, workDate);
            await tombstoneAttendanceDeletion(client, employeeId, workDate, req.session.user.id);
          }
        }
      }
    }
    await client.query('COMMIT');
    for (const rec of deletedRecords) {
      await logAudit(req.session.user.id, 'delete', 'attendance', null, {
        employee_id: rec.employeeId,
        work_date: rec.workDate,
        notes: rec.notes,
        source: /biometric|app/i.test(rec.notes) ? 'employee_app' : 'admin_web',
        reason: bulkDeleteReason,
        bulk: true
      });
    }
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
      const ins = await client.query(
        `INSERT INTO attendance_logs (employee_id, work_date, rate_snapshot, notes, created_by)
         VALUES ($1, $2, $3, 'Present', $4)
         ON CONFLICT (employee_id, work_date) DO NOTHING`,
        [employeeId, work_date, emp.rows[0].rate, req.session.user.id]
      );
      if (ins.rowCount > 0) {
        await syncMobileAttendanceLog(client, employeeId, work_date, { rate: emp.rows[0].rate });
      }
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
  const timeRangeError = validateTimeRange(time_in, time_out);
  if (timeRangeError) return res.status(400).json({ error: timeRangeError });
  const existing = await pool.query('SELECT employee_id, work_date, rate_snapshot FROM attendance_logs WHERE id = $1', [req.params.id]);
  if (existing.rowCount) {
    const employeeId = existing.rows[0].employee_id;
    const oldWorkDate = databaseDateOnly(existing.rows[0].work_date);
    if (await isDateLockedForEmployee(employeeId, oldWorkDate)) {
      return res.status(403).json({ error: 'Cannot modify: the current payroll period is locked. Unlock the payslip first.' });
    }
    /* A record can be moved to another date. Check the destination too so a
       generated period cannot be modified indirectly by moving attendance in. */
    if (work_date && work_date !== oldWorkDate && await isDateLockedForEmployee(employeeId, work_date)) {
      return res.status(403).json({ error: 'Cannot move attendance into a locked payroll period. Unlock the payslip first.' });
    }
  }
  const result = await pool.query(
    `UPDATE attendance_logs
     SET work_date = $1, time_in = NULLIF($2, '')::time, time_out = NULLIF($3, '')::time, notes = $4, updated_at = NOW()
     WHERE id = $5
     RETURNING *`,
    [work_date, time_in, time_out || null, notes, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Attendance log not found.' });
  /* If the record moved to a new date, clear the old date's mobile events. */
  if (existing.rowCount) {
    const oldDate = databaseDateOnly(existing.rows[0].work_date);
    if (oldDate !== work_date) {
      await clearMobileAttendanceLog(pool, existing.rows[0].employee_id, oldDate);
      await tombstoneAttendanceDeletion(pool, existing.rows[0].employee_id, oldDate, req.session.user.id);
    }
  }
  await syncMobileAttendanceLog(pool, existing.rows[0].employee_id, work_date, {
    timeIn: result.rows[0].time_in,
    timeOut: result.rows[0].time_out,
    rate: result.rows[0].rate_snapshot,
  });
  sendFcmToEmployee(existing.rows[0].employee_id, 'Attendance updated', 'Your attendance record was updated.', { type: 'attendance_updated', employee_id: String(existing.rows[0].employee_id) });
  res.json(result.rows[0]);
});

app.delete('/api/attendance/:id', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const { confirmation, reason } = req.body || {};
  const deleteReason = String(reason || '').trim();
  if (String(confirmation || '').trim().toUpperCase() !== 'DELETE') {
    return res.status(400).json({ error: 'Type DELETE to confirm attendance deletion.' });
  }
  if (!deleteReason) {
    return res.status(400).json({ error: 'A reason is required before deleting attendance.' });
  }
  if (deleteReason.length > 500) {
    return res.status(400).json({ error: 'Deletion reason must be 500 characters or fewer.' });
  }
  /* Request the date as text from PostgreSQL. A DATE parsed as JavaScript Date
     can cross a timezone boundary and target the previous Flutter calendar day. */
  const existing = await pool.query(
    `SELECT *, to_char(work_date, 'YYYY-MM-DD') AS work_date_text
     FROM attendance_logs WHERE id = $1`,
    [req.params.id]
  );
  if (!existing.rowCount) return res.status(404).json({ error: 'Attendance record not found.' });
  const rec = existing.rows[0];
  const workDate = rec.work_date_text;
  if (await isDateLockedForEmployee(rec.employee_id, workDate)) {
    return res.status(403).json({ error: 'Cannot delete: payroll period is locked.' });
  }
  await pool.query('DELETE FROM attendance_logs WHERE id = $1', [req.params.id]);
  await clearMobileAttendanceLog(pool, rec.employee_id, workDate);
  await tombstoneAttendanceDeletion(pool, rec.employee_id, workDate, req.session.user.id);
  await logAudit(req.session.user.id, 'delete', 'attendance', rec.id, {
    employee_id: rec.employee_id,
    work_date: workDate,
    notes: rec.notes || '',
    source: /biometric|app/i.test(rec.notes || '') ? 'employee_app' : 'admin_web',
    reason: deleteReason
  });
  sendFcmToEmployee(rec.employee_id, 'Attendance updated', 'Your attendance record was updated.', { type: 'attendance_updated', employee_id: String(rec.employee_id) });
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
  sendPayrollUpdatedPush(rec.employee_id, 'cash advance');
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
  sendExtraPayPush(employee_id, amount, extra_date);
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
  sendExtraPayPush(employee_id, amount, extra_date);
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
  sendExtraPayPush(rec.employee_id, rec.amount, rec.extra_date);
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
  /* Salary payments are recorded whenever the admin actually pays the employee,
     so they are allowed even after the payslip is generated (locked). The
     balance check below still prevents overpayment. */
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
  sendSalaryPaidPush(employee_id, amount);
  res.status(201).json(result.rows[0]);
});

app.put('/api/salary-payments/:id', requireAuth, validateIdParam, async (req, res) => {
  const { employee_id, amount, payment_date = todayInManila(), notes = '' } = req.body;
  if (!employee_id) return res.status(400).json({ error: 'Employee is required.' });
  if (amount === undefined || amount === '' || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than zero.' });
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
  sendSalaryPaidPush(employee_id, amount);
  res.json(result.rows[0]);
});

app.delete('/api/salary-payments/:id', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const existing = await pool.query('SELECT * FROM salary_payments WHERE id = $1', [req.params.id]);
  if (!existing.rowCount) return res.status(404).json({ error: 'Salary payment not found.' });
  const rec = existing.rows[0];
  await pool.query('DELETE FROM salary_payments WHERE id = $1', [req.params.id]);
  await logAudit(req.session.user.id, 'delete', 'salary_payment', req.params.id, rec);
  sendSalaryPaidPush(rec.employee_id, rec.amount);
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
  sendBalePaymentPush(employee_id, amount);
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
  sendBalePaymentPush(employee_id, amount);
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
  sendBalePaymentPush(rec.employee_id, rec.amount);
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
  sendPayrollUpdatedPush(employee_id, 'cash advance');
  res.status(201).json(result.rows[0]);
});

/* ── Cash advance requests (from the employee app) ── */
app.get('/api/cash-advance-requests', requireAuth, async (req, res) => {
  const status = req.query.status || '';
  const search = req.query.search || '';
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where += ` AND r.status = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (e.name ILIKE $${params.length} OR e.emp_number ILIKE $${params.length})`;
  }
  const result = await pool.query(
    `SELECT r.id, r.employee_id, r.amount, r.reason, r.pickup_date, r.status,
       to_char(r.created_at, 'YYYY-MM-DD HH24:MI:SS') AS requested_at,
       to_char(r.reviewed_at, 'YYYY-MM-DD HH24:MI:SS') AS reviewed_at,
       e.emp_number, e.name
     FROM cash_advance_requests r
     JOIN employees e ON e.id = r.employee_id
     WHERE 1=1 ${where}
     ORDER BY
       CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
       r.created_at DESC`,
    params
  );
  const counts = await pool.query(
    `SELECT status, COUNT(*)::int AS count
     FROM cash_advance_requests GROUP BY status`
  );
  const countMap = { pending: 0, approved: 0, rejected: 0 };
  for (const row of counts.rows) countMap[row.status] = Number(row.count);
  res.json({ rows: result.rows, counts: countMap });
});

app.post('/api/cash-advance-requests/:id/approve', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const existing = await pool.query(
    `SELECT r.*, e.name
     FROM cash_advance_requests r
     JOIN employees e ON e.id = r.employee_id
     WHERE r.id = $1`,
    [req.params.id]
  );
  if (!existing.rowCount) return res.status(404).json({ error: 'Cash advance request not found.' });
  const rec = existing.rows[0];
  if (rec.status !== 'pending') {
    return res.status(409).json({ error: `Request is already ${rec.status}.` });
  }
  const advanceDate = todayInManila();
  const duplicate = await pool.query(
    'SELECT id FROM cash_advances WHERE employee_id = $1 AND advance_date = $2',
    [rec.employee_id, advanceDate]
  );
  if (duplicate.rowCount) {
    return res.status(409).json({ error: 'A cash advance already exists for this employee today.' });
  }

  const created = await pool.query(
    `INSERT INTO cash_advances (employee_id, amount, advance_date, notes, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [rec.employee_id, rec.amount, advanceDate, rec.reason || 'Cash advance request (approved)', req.session.user.id]
  );
  await pool.query(
    `UPDATE cash_advance_requests
     SET status = 'approved', reviewed_by = $1, reviewed_at = NOW()
     WHERE id = $2`,
    [req.session.user.id, rec.id]
  );
  await logAudit(req.session.user.id, 'approve', 'cash_advance_request', rec.id, {
    request_id: rec.id,
    cash_advance_id: created.rows[0].id,
    employee_id: rec.employee_id,
    amount: rec.amount
  });
  await createNotification({ recipientType: 'employee', recipientId: rec.employee_id, type: 'cash_advance_approved',
    title: 'Cash advance approved',
    body: `Your cash advance request of ₱${Number(rec.amount).toFixed(2)} was approved.`,
    data: { amount: rec.amount } });
  sendFcmToEmployee(rec.employee_id, 'Cash advance approved', `Your cash advance request of ₱${Number(rec.amount).toFixed(2)} was approved.`, { type: 'cash_advance_approved', screen: 'payroll', employee_id: String(rec.employee_id) });
  sendPayrollUpdatedPush(rec.employee_id, 'cash advance approved');
  res.json({ ok: true, cash_advance: created.rows[0] });
});

app.post('/api/cash-advance-requests/:id/reject', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const existing = await pool.query(
    `SELECT r.*, e.name
     FROM cash_advance_requests r
     JOIN employees e ON e.id = r.employee_id
     WHERE r.id = $1`,
    [req.params.id]
  );
  if (!existing.rowCount) return res.status(404).json({ error: 'Cash advance request not found.' });
  const rec = existing.rows[0];
  if (rec.status !== 'pending') {
    return res.status(409).json({ error: `Request is already ${rec.status}.` });
  }
  await pool.query(
    `UPDATE cash_advance_requests
     SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW()
     WHERE id = $2`,
    [req.session.user.id, rec.id]
  );
  await logAudit(req.session.user.id, 'reject', 'cash_advance_request', rec.id, {
    request_id: rec.id,
    employee_id: rec.employee_id,
    amount: rec.amount
  });
  await createNotification({ recipientType: 'employee', recipientId: rec.employee_id, type: 'cash_advance_rejected',
    title: 'Cash advance rejected',
    body: `Your cash advance request of ₱${Number(rec.amount).toFixed(2)} was declined.`,
    data: { amount: rec.amount } });
  sendFcmToEmployee(rec.employee_id, 'Cash advance rejected', `Your cash advance request of ₱${Number(rec.amount).toFixed(2)} was declined.`, { type: 'cash_advance_rejected', screen: 'payroll', employee_id: String(rec.employee_id) });
  res.json({ ok: true });
});

/* ── Payslip requests (from the employee app) ── */
app.get('/api/payslip-requests', requireAuth, async (req, res) => {
  const clean = String(req.query.status || '').toLowerCase();
  const where = clean && clean !== 'all' ? 'WHERE r.status = $1' : '';
  const params = clean && clean !== 'all' ? [clean] : [];
  const result = await pool.query(
    `SELECT r.id, r.employee_id, r.attendance_employee_id, r.name, r.email,
            to_char(r.period_start, 'YYYY-MM-DD') AS period_start,
            to_char(r.period_end, 'YYYY-MM-DD') AS period_end,
            r.status, r.notes, r.requested_at, r.reviewed_at,
            e.emp_number
     FROM payslip_requests r
     LEFT JOIN employees e ON e.id = r.employee_id
     ${where}
     ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.requested_at DESC`,
    params
  );
  const countsResult = await pool.query(
    `SELECT status, COUNT(*)::int AS count FROM payslip_requests GROUP BY status`
  );
  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const row of countsResult.rows) counts[row.status] = row.count;
  res.json({ rows: result.rows, counts });
});

app.post('/api/payslip-requests/:id/approve', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const existing = await pool.query(
    `SELECT r.* FROM payslip_requests r WHERE r.id = $1`,
    [req.params.id]
  );
  if (!existing.rowCount) return res.status(404).json({ error: 'Payslip request not found.' });
  const rec = existing.rows[0];
  if (rec.status !== 'pending') {
    return res.status(409).json({ error: `Request is already ${rec.status}.` });
  }
  await pool.query(
    `UPDATE payslip_requests SET status = 'approved', reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`,
    [req.session.user.id, rec.id]
  );
  await logAudit(req.session.user.id, 'approve', 'payslip_request', rec.id, {
    request_id: rec.id, employee_id: rec.employee_id,
    period_start: rec.period_start, period_end: rec.period_end
  });

  // Ask the attendance backend to build the payslip PDF and email it.
  let emailSent = false;
  try {
    const attendancePort = Number(process.env.ATTENDANCE_PORT) || 8000;
    const notifyUrl = `http://127.0.0.1:${attendancePort}/internal/payslip-email`;
    const notifyRes = await fetch(notifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': process.env.INTERNAL_NOTIFY_SECRET || '',
      },
      body: JSON.stringify({ request_id: rec.id }),
      signal: AbortSignal.timeout(20000),
    });
    emailSent = notifyRes.ok;
  } catch (err) {
    console.error('[payslip] Failed to trigger payslip email:', err);
  }

  const targetId = rec.attendance_employee_id || String(rec.employee_id);
  await createNotification({ recipientType: 'employee', recipientId: rec.employee_id, type: 'payslip_approved',
    title: 'Payslip approved',
    body: emailSent
      ? `Your payslip for ${rec.period_start} to ${rec.period_end} was sent to ${rec.email}.`
      : `Your payslip for ${rec.period_start} to ${rec.period_end} is ready (email pending configuration).`,
    data: { period: rec.period_start, period_start: rec.period_start, period_end: rec.period_end } });
  sendFcmToEmployee(targetId, 'Payslip approved',
    emailSent
      ? `Your payslip for ${rec.period_start} to ${rec.period_end} was sent to ${rec.email}.`
      : `Your payslip for ${rec.period_start} to ${rec.period_end} is ready (email pending configuration).`,
    { type: 'payslip_approved', screen: 'payroll', employee_id: targetId, period: rec.period_start });
  sendPayrollUpdatedPush(targetId, 'payslip approved');
  res.json({ ok: true, email_sent: emailSent });
});

app.post('/api/payslip-requests/:id/reject', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  const existing = await pool.query(
    `SELECT r.* FROM payslip_requests r WHERE r.id = $1`,
    [req.params.id]
  );
  if (!existing.rowCount) return res.status(404).json({ error: 'Payslip request not found.' });
  const rec = existing.rows[0];
  if (rec.status !== 'pending') {
    return res.status(409).json({ error: `Request is already ${rec.status}.` });
  }
  await pool.query(
    `UPDATE payslip_requests SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`,
    [req.session.user.id, rec.id]
  );
  await logAudit(req.session.user.id, 'reject', 'payslip_request', rec.id, {
    request_id: rec.id, employee_id: rec.employee_id,
    period_start: rec.period_start, period_end: rec.period_end
  });
  const targetId = rec.attendance_employee_id || String(rec.employee_id);
  await createNotification({ recipientType: 'employee', recipientId: rec.employee_id, type: 'payslip_rejected',
    title: 'Payslip request declined',
    body: `Your payslip request for ${rec.period_start} to ${rec.period_end} was declined.`,
    data: { period: rec.period_start, period_start: rec.period_start, period_end: rec.period_end } });
  sendFcmToEmployee(targetId, 'Payslip request declined',
    `Your payslip request for ${rec.period_start} to ${rec.period_end} was declined.`,
    { type: 'payslip_rejected', screen: 'payroll', employee_id: targetId, period: rec.period_start });
  res.json({ ok: true });
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
  sendPayrollUpdatedPush(employee_id, 'cash advance');
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
       (CASE
          WHEN COALESCE(ps.paid_amount, 0) > 0
           AND COALESCE(sp.total_paid, 0) >= COALESCE(a.gross_salary, 0) + COALESCE(ex.extra_total, 0)
          THEN COALESCE(sp.total_paid, 0)
          ELSE COALESCE(ps.paid_amount, 0) + COALESCE(sp.total_paid, 0)
        END)::numeric(12,2) AS salary_paid_amount,
       COALESCE(ex.extra_total, 0)::numeric(12,2) AS extra_payment_amount,
       '' AS extra_payment_notes,
       COALESCE(ps.bale_deducted, false) AS bale_deducted,
       (CASE
          WHEN COALESCE(ps.paid_amount, 0) > 0
           AND COALESCE(sp.total_paid, 0) >= COALESCE(a.gross_salary, 0) + COALESCE(ex.extra_total, 0)
          THEN COALESCE(sp.total_paid, 0)
          ELSE COALESCE(ps.paid_amount, 0) + COALESCE(sp.total_paid, 0)
        END)::numeric(12,2) AS paid_amount,
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

  /* Carry-overs must use each employee's own pay period. Grouping prevents a
     weekly employee from being calculated with the first semi-monthly
     employee's period (or vice versa). */
  const carryoverGroups = new Map();
  for (const row of result.rows) {
    const employeePeriodDays = getPeriodDays(row.pay_period_days);
    const employeePeriodStart = periodStartOf(weekStart, employeePeriodDays);
    const key = `${employeePeriodDays}:${employeePeriodStart}`;
    if (!carryoverGroups.has(key)) {
      carryoverGroups.set(key, {
        employeeIds: [],
        periodDays: employeePeriodDays,
        periodStart: employeePeriodStart
      });
    }
    carryoverGroups.get(key).employeeIds.push(row.employee_id);
  }
  const carryoverMaps = await Promise.all(
    [...carryoverGroups.values()].map(group =>
      getPayrollCarryoversBulk(group.employeeIds, group.periodStart, group.periodDays)
    )
  );
  const carryoverMap = new Map(carryoverMaps.flatMap(map => [...map.entries()]));

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
    `SELECT r.accepted_at, r.accepted_by, u.username AS accepted_by_username,
            r.submitted_at, su.username AS submitted_by_username
     FROM payroll_reviews r
     LEFT JOIN users u ON u.id = r.accepted_by
     LEFT JOIN users su ON su.id = r.submitted_by
     WHERE r.period_key = $1`,
    [weekStart]
  );
  const review = reviewResult.rowCount
    ? {
        accepted: true,
        accepted_at: reviewResult.rows[0].accepted_at,
        accepted_by: reviewResult.rows[0].accepted_by,
        accepted_by_username: reviewResult.rows[0].accepted_by_username,
        submitted: !!reviewResult.rows[0].submitted_at,
        submitted_at: reviewResult.rows[0].submitted_at,
        submitted_by_username: reviewResult.rows[0].submitted_by_username
      }
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

/* Dashboard analytics: weekly salary trend over the last N periods. */
app.get('/api/payroll/trend', requireAuth, async (req, res) => {
  const periodDays = getPeriodDays(req.query.periodDays);
  const weeks = Math.min(Math.max(parseInt(req.query.weeks) || 8, 2), 16);
  const endWeek = periodStartOf(todayInManila(), periodDays);
  const startWeek = addDays(endWeek, -(weeks - 1) * periodDays);
  const rangeEnd = addDays(endWeek, periodDays - 1);

  const [attendanceResult, paidResult, baleResult] = await Promise.all([
    pool.query(
      `SELECT to_char(work_date, 'YYYY-MM-DD') AS work_date, rate_snapshot
       FROM attendance_logs
       WHERE work_date BETWEEN $1 AND $2`,
      [startWeek, rangeEnd]
    ),
    pool.query(
      `SELECT to_char(payment_date, 'YYYY-MM-DD') AS payment_date, amount
       FROM salary_payments
       WHERE payment_date BETWEEN $1 AND $2`,
      [startWeek, rangeEnd]
    ),
    pool.query(
      `SELECT to_char(advance_date, 'YYYY-MM-DD') AS advance_date, amount
       FROM cash_advances
       WHERE advance_date BETWEEN $1 AND $2`,
      [startWeek, rangeEnd]
    )
  ]);

  const buckets = [];
  for (let i = 0; i < weeks; i++) {
    const weekStart = addDays(startWeek, i * periodDays);
    const weekEnd = addDays(weekStart, periodDays - 1);
    buckets.push({ weekStart, weekEnd, days: 0, salary: 0, paid: 0, bale: 0 });
  }

  const bucketFor = (dateStr, field) => {
    const idx = buckets.findIndex(b => dateStr >= b.weekStart && dateStr <= b.weekEnd);
    return idx >= 0 ? buckets[idx] : null;
  };

  attendanceResult.rows.forEach(row => {
    const b = bucketFor(row.work_date);
    if (b) { b.days += 1; b.salary += money(row.rate_snapshot); }
  });
  paidResult.rows.forEach(row => {
    const b = bucketFor(row.payment_date);
    if (b) b.paid += money(row.amount);
  });
  baleResult.rows.forEach(row => {
    const b = bucketFor(row.advance_date);
    if (b) b.bale += money(row.amount);
  });

  res.json({
    periodDays,
    rows: buckets.map(b => ({
      weekStart: b.weekStart,
      weekEnd: b.weekEnd,
      days: b.days,
      salary: Math.round(b.salary * 100) / 100,
      paid: Math.round(b.paid * 100) / 100,
      bale: Math.round(b.bale * 100) / 100
    }))
  });
});

/* HR/Admin: submit the fully generated payroll for admin review. */
app.post('/api/payroll/submit-review', requireAuth, async (req, res) => {
  const periodDays = getPeriodDays(req.body.periodDays);
  const weekStart = req.body.week
    ? payrollWeekStartOf(req.body.week)
    : periodStartOf(todayInManila(), periodDays);
  const counts = await pool.query(
    `SELECT (SELECT COUNT(*) FROM employees WHERE active)::int AS total,
            (SELECT COUNT(*) FROM payroll_statuses WHERE week_start = $1 AND status = 'generated')::int AS generated`,
    [weekStart]
  );
  const { total, generated } = counts.rows[0];
  if (generated < total) {
    return res.status(400).json({ error: `Submit for review requires every payslip to be generated (${generated}/${total}).` });
  }
  await pool.query(
    `INSERT INTO payroll_reviews (period_key, period_days, submitted_by, submitted_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (period_key) DO UPDATE SET submitted_by = $3, submitted_at = NOW()`,
    [weekStart, periodDays, req.session.user.id]
  );
  await logAudit(req.session.user.id, 'submit_review', 'payroll', null, { period_key: weekStart, period_days: periodDays });
  /* Notify connected admin panels (bell + toast) that the payroll is ready to review. */
  notifyDataChanged({
    event: 'payroll_submitted',
    period_key: weekStart,
    period_days: periodDays,
    submitted_by: req.session.user.username || 'HR'
  });
  res.json({ ok: true, submitted: true, period_key: weekStart });
});

/* Accept a payroll period after review. Accepting releases payment for every
   generated payslip at once (auto-pay) and notifies all employees with the
   period breakdown. It is also required before Bulk Print. */
app.post('/api/payroll/review', requireAuth, requireAdmin, async (req, res) => {
  const periodDays = getPeriodDays(req.body.periodDays);
  const weekStart = req.body.week
    ? payrollWeekStartOf(req.body.week)
    : periodStartOf(todayInManila(), periodDays);
  const weekEnd = addDays(weekStart, periodDays - 1);

  const client = await pool.connect();
  let autoPaidCount = 0;
  let autoPaidTotal = 0;
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO payroll_reviews (period_key, period_days, accepted_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (period_key) DO UPDATE SET accepted_at = NOW(), accepted_by = $3`,
      [weekStart, periodDays, req.session.user.id]
    );

    /* Release payment for every generated payslip in the period (only if no
       manual salary payment already exists), so the boss only reviews once. */
    const generated = await client.query(
      `SELECT ps.employee_id,
              COALESCE(att.salary, 0)::numeric(12,2) AS salary,
              COALESCE(ep.extra_total, 0)::numeric(12,2) AS extra_pay,
              EXISTS(SELECT 1 FROM salary_payments sp
                     WHERE sp.employee_id = ps.employee_id
                       AND sp.payment_date BETWEEN $1 AND $2) AS has_salary
       FROM payroll_statuses ps
       LEFT JOIN (SELECT employee_id, SUM(rate_snapshot)::numeric(12,2) AS salary
                  FROM attendance_logs WHERE work_date BETWEEN $1 AND $2 GROUP BY employee_id) att
         ON att.employee_id = ps.employee_id
       LEFT JOIN (SELECT employee_id, SUM(amount)::numeric(12,2) AS extra_total
                  FROM extra_payments WHERE extra_date BETWEEN $1 AND $2 GROUP BY employee_id) ep
         ON ep.employee_id = ps.employee_id
       WHERE ps.week_start = $3 AND ps.status = 'generated'`,
      [weekStart, weekEnd, weekStart]
    );
    for (const emp of generated.rows) {
      const totalEarnings = money(Number(emp.salary) + Number(emp.extra_pay));
      if (totalEarnings > 0 && !emp.has_salary) {
        await client.query(
          `INSERT INTO salary_payments (employee_id, amount, payment_date, notes, created_by)
           VALUES ($1, $2, $3, 'Auto-paid via payroll acceptance', $4)`,
          [emp.employee_id, totalEarnings, weekEnd, req.session.user.id]
        );
        autoPaidCount++;
        autoPaidTotal += totalEarnings;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit(req.session.user.id, 'review_accept', 'payroll', null, {
    period_key: weekStart, period_days: periodDays,
    auto_paid: autoPaidCount, auto_paid_amount: autoPaidTotal
  });
  /* Fan-out: every approved employee gets the accepted-payroll notification at
     once, with the period key so the app can open the exact breakdown. */
  await createNotification({
    recipientType: 'all-employees', type: 'payroll_accepted',
    title: 'Payroll accepted',
    body: `Your payroll for ${weekStart} to ${weekEnd} was accepted and paid by the admin. Check your Payroll tab.`,
    data: { period: weekStart, week_start: weekStart, week_end: weekEnd }
  });
  await sendFcmBroadcast('Payroll accepted',
    `Your payroll for ${weekStart} to ${weekEnd} was accepted and paid by the admin. Check your Payroll tab.`,
    { type: 'payroll_accepted', screen: 'payroll', period: weekStart });
  notifyDataChanged({ event: 'payroll_accepted', period_key: weekStart, period_days: periodDays });
  res.json({ ok: true, accepted: true, period_key: weekStart, auto_paid: autoPaidCount });
});

/* Generating a payslip finalizes this employee's selected payroll period. */
app.post('/api/payroll/:employeeId/generate', requireAuth, async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const employee = await pool.query('SELECT pay_period_days FROM employees WHERE id = $1', [employeeId]);
  if (!employee.rowCount) return res.status(404).json({ error: 'Employee not found.' });
  /* The payslip always follows the employee's own pay-period setting so the
     global view (Weekly/Semi-monthly) never silently rewrites employee config. */
  const periodDays = getPeriodDays(employee.rows[0].pay_period_days);
  const weekStart = periodStartOf(req.body.weekStart || todayInManila(), periodDays);
  const weekEnd = addDays(weekStart, periodDays - 1);
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* Generating a payslip locks the period for review. Payment is released
       later when the admin accepts the payroll (see /api/payroll/review). */
    const result = await client.query(
      `INSERT INTO payroll_statuses (employee_id, week_start, status, updated_by, updated_at)
       VALUES ($1, $2, 'generated', $3, NOW())
       ON CONFLICT (employee_id, week_start)
       DO UPDATE SET status = 'generated', updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING *`,
      [employeeId, weekStart, req.session.user.id]
    );

    await client.query('COMMIT');
    await logAudit(req.session.user.id, 'generate', 'payslip', result.rows[0].id, { employee_id: employeeId, week_start: weekStart });
    await createNotification({ recipientType: 'employee', recipientId: employeeId, type: 'payslip_ready',
      title: 'Payslip ready for review',
      body: `Your payslip for ${weekStart} to ${weekEnd} is ready. It will be paid once the admin accepts the payroll.`,
      data: { period: weekStart, week_start: weekStart, week_end: weekEnd } });
    sendFcmToEmployee(employeeId, 'Payslip ready for review',
      `Your payslip for ${weekStart} to ${weekEnd} is ready. Check your Payroll tab.`,
      { type: 'payslip_ready', screen: 'payroll', employee_id: String(employeeId), period: weekStart });
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
    await createNotification({ recipientType: 'employee', recipientId: employeeId, type: 'payslip_unlocked',
      title: 'Payslip unlocked',
      body: `Your payslip for ${weekStart} to ${weekEnd} was unlocked by the admin.`,
      data: { period: weekStart, week_start: weekStart, week_end: weekEnd } });
    sendPayrollUpdatedPush(employeeId, 'payslip unlocked');
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
  sendPayrollUpdatedPush(employee_id, 'salary paid');
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
  sendPayrollUpdatedPush(employee_id, 'payment removed');
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

app.get('/api/announcements', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, title, message, to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at
     FROM announcements ORDER BY created_at DESC LIMIT 20`
  );
  res.json({ rows: result.rows });
});

app.post('/api/announcements', requireAuth, requireAdmin, async (req, res) => {
  const cleanTitle = String(req.body.title || '').trim();
  const cleanMessage = String(req.body.message || '').trim();
  if (!cleanTitle || !cleanMessage) {
    return res.status(400).json({ error: 'Title and message are required.' });
  }
  if (cleanTitle.length > 160) return res.status(400).json({ error: 'Title is too long (max 160 characters).' });
  if (cleanMessage.length > 2000) return res.status(400).json({ error: 'Message is too long (max 2000 characters).' });
  const result = await pool.query(
    `INSERT INTO announcements (title, message, created_by) VALUES ($1, $2, $3) RETURNING *`,
    [cleanTitle, cleanMessage, req.session.user.id]
  );
  await logAudit(req.session.user.id, 'create', 'announcement', result.rows[0].id, { title: cleanTitle });
  const sent = await sendFcmBroadcast(cleanTitle, cleanMessage, { type: 'announcement', screen: 'dashboard' });
  res.status(201).json({ ...result.rows[0], sent });
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
    `SELECT id, employee_id, name, first_name, last_name, email, phone, face_image,
            sss_number, philhealth_number, pagibig_number, tin_number,
            status, admin_notes, registered_at, approved_at, payroll_employee_id, device_id
     FROM attendance.employees
     WHERE ${where} AND (name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR employee_id ILIKE $1
            OR sss_number ILIKE $1 OR philhealth_number ILIKE $1 OR pagibig_number ILIKE $1 OR tin_number ILIKE $1)
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

  let phone = String(reg.phone || '').trim();
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('63') && digits.length > 11) digits = digits.slice(2);
  if (digits.length === 10 && digits.startsWith('9')) digits = '0' + digits;
  phone = digits;
  if (!/^0[0-9]{10}$/.test(phone)) {
    return res.status(400).json({ error: 'Registration phone must be exactly 11 digits (numbers only).' });
  }
  const email = String(reg.email || '').trim();
  let linkExisting = null;
  if (reg.payroll_employee_id) {
    const payrollLink = await pool.query('SELECT id, name FROM employees WHERE id = $1', [reg.payroll_employee_id]);
    if (payrollLink.rowCount > 0) linkExisting = payrollLink.rows[0];
  }
  if (!linkExisting) {
    const phoneCheck = await pool.query('SELECT id, name FROM employees WHERE phone = $1', [phone]);
    if (phoneCheck.rowCount > 0) {
      linkExisting = phoneCheck.rows[0];
    } else {
      if (email) {
        const emailCheck = await pool.query('SELECT id, name FROM employees WHERE LOWER(email) = LOWER($1)', [email]);
        if (emailCheck.rowCount > 0) linkExisting = emailCheck.rows[0];
      }
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
             email = CASE WHEN $3 <> '' THEN $3 ELSE email END,
             photo_url = CASE WHEN photo_url IS NULL OR photo_url = '' THEN $4 ELSE photo_url END
         WHERE id = $5`,
        [Number(rate), periodDays, email, photoUrl, payrollEmployeeId]
      );
    } else {
      const empNumber = await client.query(
        `SELECT ('EMP-' || LPAD(nextval('employee_number_seq')::text, 5, '0')) AS emp_number`
      );
      const parts = name.split(/\s+/);
      const first = (reg.first_name || '').trim() || parts[0] || '';
      const last = (reg.last_name || '').trim() || parts.slice(1).join(' ') || '';

      const govCols = [];
      const govVals = [];
      for (const f of ['sss_number', 'philhealth_number', 'pagibig_number', 'tin_number']) {
        const v = String(reg[f] || '').trim();
        if (!v) continue;
        const taken = await client.query(`SELECT id FROM employees WHERE ${f} = $1 AND ${f} != ''`, [v]);
        if (taken.rowCount === 0) {
          govCols.push(f);
          govVals.push(v);
        }
      }
      const govSql = govCols.length ? `, ${govCols.join(', ')}` : '';
      const govPlaceholders = govCols.length ? `, ${govCols.map((_, i) => `$${10 + i}`).join(', ')}` : '';

      const empInsert = await client.query(
        `INSERT INTO employees (emp_number, first_name, last_name, name, phone, email, rate, pay_period_days, active, photo_url${govSql})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9${govPlaceholders})
         RETURNING id`,
        [empNumber.rows[0].emp_number, first, last, name, phone, email, Number(rate), periodDays, photoUrl, ...govVals]
      );
      payrollEmployeeId = empInsert.rows[0].id;
    }

    const newEmpId = await client.query(
      `SELECT (
         'EMP-' || EXTRACT(YEAR FROM CURRENT_DATE)::int || '-' ||
         LPAD((COALESCE(MAX(NULLIF(split_part(employee_id, '-', 3), '')::int), 0) + 1)::text, 4, '0')
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
  const existing = await pool.query(
    `SELECT id, name, email, phone FROM attendance.employees
     WHERE id = $1 AND status IN ('pending', 'review')`,
    [req.params.id]
  );
  if (!existing.rowCount) return res.status(404).json({ error: 'Registration not found or already reviewed.' });
  const reg = existing.rows[0];
  await pool.query(`DELETE FROM attendance.employees WHERE id = $1`, [req.params.id]);
  await logAudit(req.session.user.id, 'reject', 'registration', Number(req.params.id), {
    notes,
    name: reg.name,
    email: reg.email,
    phone: reg.phone,
    deleted: true
  });
  res.json({ ok: true, deleted: true });
});

app.post('/api/registrations/:id/reset-device', requireAuth, requireAdmin, validateIdParam, async (req, res) => {
  // Recovery path for the device binding: clears the bound device so the
  // employee can sign in from their new phone (or from another phone).
  const existing = await pool.query(
    `SELECT id, name, employee_id FROM attendance.employees
     WHERE id = $1 AND status = 'approved'`,
    [req.params.id]
  );
  if (!existing.rowCount) return res.status(404).json({ error: 'Approved registration not found.' });
  const reg = existing.rows[0];
  await pool.query(`UPDATE attendance.employees SET device_id = '' WHERE id = $1`, [req.params.id]);
  await logAudit(req.session.user.id, 'reset-device', 'registration', Number(req.params.id), {
    name: reg.name,
    employee_id: reg.employee_id || null,
    note: 'Device binding cleared so the employee can sign in from a new device.'
  });
  res.json({ ok: true, name: reg.name });
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', uptime: process.uptime(), db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

/* ── Realtime event stream: admin panels refresh only when data changes ── */
app.get('/api/events', requireAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

/* ── Internal webhook for the attendance backend to notify the admin panel ── */
app.post('/internal/notify', (req, res) => {
  const secret = process.env.INTERNAL_NOTIFY_SECRET || '';
  const provided = req.headers['x-notify-secret'] || '';
  const remote = req.socket.remoteAddress || '';
  const fromLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (secret ? provided !== secret : !fromLocal) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  const { type = 'data_changed', source = 'attendance' } = req.body || {};
  notifyDataChanged({ ...(req.body || {}), type, source });
  res.json({ ok: true });
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
    // Start the watchdog only after the initial spawn attempt, so the first
    // tick cannot race a slow initial backend boot (avoid duplicate spawns).
    scheduleAttendanceWatchdog();
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

/* Health check: does the attendance backend actually respond? A process that
   is alive but hung (port bound, no replies) must also be restarted, otherwise
   the Flutter app still sees silent failures. */
function attendanceBackendHealthy() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: ATTENDANCE_PORT, path: '/status', timeout: 2000 },
      (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 500); }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function spawnAttendanceBackend(pythonCmd) {
  const backendDir = path.join(__dirname, 'attendance_system', 'backend');
  const child = spawn(pythonCmd, ['-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', String(ATTENDANCE_PORT)], {
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

/* Watchdog: if the attendance backend dies (crash, kill, manual stop), the
   admin panel keeps serving but the Flutter app loses all attendance + push
   features. Auto-restart it every 30s so 'nothing appears in Flutter'
   problems never linger. Only one restarter runs at a time. */
let attendanceRestarting = false;
const ATTENDANCE_WATCHDOG_MS = Number(process.env.ATTENDANCE_WATCHDOG_MS || 30000);
function scheduleAttendanceWatchdog() {
  setInterval(async () => {
    if (!ATTENDANCE_BACKEND_AUTOSTART || attendanceRestarting) return;
    // Healthy check also covers a hung-but-listening backend.
    if (await attendanceBackendHealthy()) return;
    attendanceRestarting = true;
    console.log('[attendance] Backend not responding - restarting...');
    spawnAttendanceBackend(ATTENDANCE_PYTHON_CANDIDATES[0]);
    // Give the child a moment to bind, then clear the flag so the next tick
    // can restart again if it failed.
    setTimeout(() => { attendanceRestarting = false; }, 5000);
  }, ATTENDANCE_WATCHDOG_MS);
}
process.on('exit', stopAttendanceBackend);
process.on('SIGINT', () => { stopAttendanceBackend(); process.exit(0); });
process.on('SIGTERM', () => { stopAttendanceBackend(); process.exit(0); });
