// Mock server for taking screenshots of the KVSK Payroll System
// This returns fake data so the UI renders properly without a real database

const express = require('express');
const path = require('path');
const session = require('express-session');
const app = express();
const PORT = 3001;

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Simple memory session
app.use(session({
  secret: 'mock-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Login required.' });
  next();
}

// Mock data
const employees = [
  { id: 1, emp_number: 'EMP-001', name: 'Juan Dela Cruz', phone: '09171234567', rate: 575, pay_period_days: 7, active: true, sss_number: '12-3456789-0', philhealth_number: '34-567890123-4', pagibig_number: '1234-5678-9012', tin_number: '123-456-789-012', photo_url: null, created_at: '2026-01-01' },
  { id: 2, emp_number: 'EMP-002', name: 'Maria Santos', phone: '09179876543', rate: 550, pay_period_days: 7, active: true, sss_number: '98-7654321-0', philhealth_number: '87-654321098-1', pagibig_number: '9876-5432-1098', tin_number: '987-654-321-098', photo_url: null, created_at: '2026-01-01' },
  { id: 3, emp_number: 'EMP-003', name: 'Pedro Reyes', phone: '09151112233', rate: 500, pay_period_days: 7, active: true, sss_number: '56-7890123-4', philhealth_number: '56-789012345-6', pagibig_number: '5678-9012-3456', tin_number: '567-890-123-456', photo_url: null, created_at: '2026-02-15' },
  { id: 4, emp_number: 'EMP-004', name: 'Ana Gonzales', phone: '09221112233', rate: 620, pay_period_days: 7, active: true, sss_number: '23-4567890-1', philhealth_number: '23-456789012-3', pagibig_number: '2345-6789-0123', tin_number: '234-567-890-123', photo_url: null, created_at: '2026-03-01' },
  { id: 5, emp_number: 'EMP-005', name: 'Jose Rizal', phone: '09331112233', rate: 580, pay_period_days: 7, active: true, sss_number: '45-6789012-3', philhealth_number: '45-678901234-5', pagibig_number: '4567-8901-2345', tin_number: '456-789-012-345', photo_url: null, created_at: '2026-03-15' },
  { id: 6, emp_number: 'EMP-006', name: 'Maria Clara', phone: '09441112233', rate: 530, pay_period_days: 7, active: false, sss_number: '67-8901234-5', philhealth_number: '67-890123456-7', pagibig_number: '6789-0123-4567', tin_number: '678-901-234-567', photo_url: null, created_at: '2026-04-01' },
];

const weekStart = '2026-07-27';
const weekEnd = '2026-08-02';

const attendanceRows = [
  { id: 1, employee_id: 1, work_date: '2026-07-27', time_in: null, time_out: null, rate_snapshot: 575, notes: '', emp_number: 'EMP-001', name: 'Juan Dela Cruz', pay_period_days: 7, locked: false },
  { id: 2, employee_id: 2, work_date: '2026-07-27', time_in: null, time_out: null, rate_snapshot: 550, notes: '', emp_number: 'EMP-002', name: 'Maria Santos', pay_period_days: 7, locked: false },
  { id: 3, employee_id: 3, work_date: '2026-07-27', time_in: null, time_out: null, rate_snapshot: 500, notes: '', emp_number: 'EMP-003', name: 'Pedro Reyes', pay_period_days: 7, locked: false },
  { id: 4, employee_id: 4, work_date: '2026-07-27', time_in: null, time_out: null, rate_snapshot: 620, notes: '', emp_number: 'EMP-004', name: 'Ana Gonzales', pay_period_days: 7, locked: false },
  { id: 5, employee_id: 5, work_date: '2026-07-27', time_in: null, time_out: null, rate_snapshot: 580, notes: '', emp_number: 'EMP-005', name: 'Jose Rizal', pay_period_days: 7, locked: false },
  { id: 6, employee_id: 6, work_date: '2026-07-26', time_in: null, time_out: null, rate_snapshot: 530, notes: '', emp_number: 'EMP-006', name: 'Maria Clara', pay_period_days: 7, locked: false },
];

const cashAdvances = [
  { id: 1, employee_id: 1, amount: 500, advance_date: '2026-07-27', notes: 'Pambaon', emp_number: 'EMP-001', name: 'Juan Dela Cruz', locked: false },
  { id: 2, employee_id: 3, amount: 300, advance_date: '2026-07-28', notes: 'Pantranspo', emp_number: 'EMP-003', name: 'Pedro Reyes', locked: false },
];

const salaryPayments = [
  { id: 1, employee_id: 1, amount: 2000, payment_date: '2026-07-28', notes: 'Partial payment', emp_number: 'EMP-001', name: 'Juan Dela Cruz' },
];

const extraPayments = [
  { id: 1, employee_id: 2, amount: 500, extra_date: '2026-07-28', notes: 'Performance bonus', emp_number: 'EMP-002', name: 'Maria Santos' },
];

const balePayments = [
  { id: 1, employee_id: 1, amount: 200, payment_date: '2026-07-28', notes: 'Bayad bale', emp_number: 'EMP-001', name: 'Juan Dela Cruz' },
];

const attendanceDates = ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'];

// Create payroll rows from employees
function getPayrollRows() {
  return employees.filter(e => e.active).map(e => {
    const days = [1,2,3,4,5].includes(e.id) ? 5 : e.id === 6 ? 4 : 5;
    const salary = days * e.rate;
    const ca = cashAdvances.filter(c => c.employee_id === e.id).reduce((s, c) => s + c.amount, 0);
    const extra = extraPayments.filter(x => x.employee_id === e.id).reduce((s, x) => s + x.amount, 0);
    const paid = salaryPayments.filter(p => p.employee_id === e.id).reduce((s, p) => s + p.amount, 0);
    const balePaid = balePayments.filter(b => b.employee_id === e.id).reduce((s, b) => s + b.amount, 0);
    const prevUnpaid = e.id === 3 ? 250 : 0;
    const prevBale = e.id === 1 ? 300 : e.id === 3 ? 150 : 0;
    const totalBale = prevBale + ca;
    const remainingBale = Math.max(0, totalBale - balePaid);
    const balance = Math.max(0, salary + extra + prevUnpaid - paid);
    const paymentStatus = paid >= salary + extra + prevUnpaid ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
    return {
      employee_id: e.id, emp_number: e.emp_number, name: e.name, rate: e.rate, days, salary,
      previous_unpaid_balance: prevUnpaid, previous_bale_balance: prevBale,
      cash_advance: ca, extra_payment_amount: extra, total_bale: totalBale,
      paid_amount: paid, balance, remaining_bale_balance: remainingBale,
      bale_paid_amount: balePaid, payment_status: paymentStatus,
      payroll_status: 'unpaid', pay_period_days: 7, locked_period_start: null,
      extra_payment_notes: extra > 0 ? 'Bonus' : '',
      isPeriodLocked: false
    };
  });
}

// ── API Routes ──

app.get('/api/me', (req, res) => {
  if (req.session.user) {
    const ttl = req.session.cookie.maxAge ? Math.floor(req.session.cookie.maxAge / 1000) : null;
    return res.json({ user: req.session.user, sessionTTL: ttl });
  }
  res.json({ user: null, sessionTTL: null });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const validUsers = {
    'admin': { id: 1, username: 'admin', role: 'admin' },
    'hr': { id: 2, username: 'hr', role: 'hr' }
  };
  const user = validUsers[username];
  if (!user || password !== (username === 'admin' ? 'kvsk@2018' : 'hr123')) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  req.session.user = user;
  res.json({ user, sessionTTL: 28800 });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/employees', requireAuth, (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  const active = req.query.active;
  let filtered = employees.filter(e => {
    if (active === 'true') return e.active === true;
    if (active === 'false') return e.active === false;
    if (active !== 'all') return e.active === true;
    return true;
  });
  if (search) {
    filtered = filtered.filter(e =>
      e.name.toLowerCase().includes(search) ||
      e.emp_number.toLowerCase().includes(search) ||
      e.sss_number.toLowerCase().includes(search)
    );
  }
  res.json(filtered);
});

app.post('/api/employees', requireAuth, (req, res) => {
  const newEmp = { id: employees.length + 1, emp_number: `EMP-${String(employees.length + 1).padStart(3, '0')}`, ...req.body, active: true, created_at: new Date().toISOString() };
  employees.push(newEmp);
  res.status(201).json(newEmp);
});

app.put('/api/employees/:id', requireAuth, (req, res) => {
  const idx = employees.findIndex(e => e.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  employees[idx] = { ...employees[idx], ...req.body };
  res.json(employees[idx]);
});

app.delete('/api/employees/:id', requireAuth, (req, res) => {
  const idx = employees.findIndex(e => e.id === Number(req.params.id));
  if (idx !== -1) employees[idx].active = false;
  res.json({ ok: true });
});

app.put('/api/employees/:id/restore', requireAuth, (req, res) => {
  const idx = employees.findIndex(e => e.id === Number(req.params.id));
  if (idx !== -1) employees[idx].active = true;
  res.json({ ok: true });
});

app.get('/api/attendance', requireAuth, (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  let rows = attendanceRows.filter(r => {
    if (search) return r.name.toLowerCase().includes(search) || r.emp_number.toLowerCase().includes(search);
    return true;
  });
  res.json({ weekStart, weekEnd, rows });
});

app.get('/api/attendance/calendar', requireAuth, (req, res) => {
  const month = req.query.month;
  if (!month) return res.json({ dates: [] });
  res.json({ dates: attendanceDates.filter(d => d.startsWith(month)) });
});

app.post('/api/attendance', requireAuth, (req, res) => {
  const { employee_id, work_date } = req.body;
  const emp = employees.find(e => e.id === Number(employee_id));
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  const exists = attendanceRows.find(r => r.employee_id === Number(employee_id) && r.work_date === work_date);
  if (exists) return res.json(exists);
  const newRow = {
    id: attendanceRows.length + 1, employee_id: Number(employee_id), work_date,
    time_in: null, time_out: null, rate_snapshot: emp.rate, notes: '',
    emp_number: emp.emp_number, name: emp.name, pay_period_days: 7, locked: false
  };
  attendanceRows.push(newRow);
  res.status(201).json(newRow);
});

app.delete('/api/attendance/:id', requireAuth, (req, res) => {
  const idx = attendanceRows.findIndex(r => r.id === Number(req.params.id));
  if (idx !== -1) attendanceRows.splice(idx, 1);
  res.json({ ok: true });
});

app.get('/api/payroll', requireAuth, (req, res) => {
  const rows = getPayrollRows();
  const summary = {
    employees: rows.length,
    workingDays: rows.reduce((a, r) => a + r.days, 0),
    totalSalary: rows.reduce((a, r) => a + r.salary, 0),
    totalCashAdvance: rows.reduce((a, r) => a + r.cash_advance, 0),
    totalPaidAmount: rows.reduce((a, r) => a + r.paid_amount, 0),
    totalBalance: rows.reduce((a, r) => a + r.balance, 0),
    totalBaleBalance: rows.reduce((a, r) => a + r.remaining_bale_balance, 0),
    totalPreviousUnpaid: rows.reduce((a, r) => a + r.previous_unpaid_balance, 0)
  };
  res.json({ weekStart, weekEnd, rows, summary, isPeriodLocked: false });
});

app.put('/api/payroll/payment', requireAuth, (req, res) => {
  res.json({ ok: true });
});

app.post('/api/payroll/:id/generate', requireAuth, (req, res) => {
  res.json({ ok: true, is_generated: true });
});

app.post('/api/payroll/:id/unlock', requireAuth, (req, res) => {
  res.json({ ok: true, is_generated: false });
});

app.get('/api/cash-advances', requireAuth, (req, res) => {
  res.json({ weekStart, weekEnd, rows: cashAdvances });
});

app.get('/api/cash-advances/calendar', requireAuth, (req, res) => {
  const month = req.query.month;
  if (!month) return res.json({ dates: [] });
  res.json({ dates: cashAdvances.map(c => c.advance_date).filter(d => d.startsWith(month)) });
});

app.post('/api/cash-advances', requireAuth, (req, res) => {
  const { employee_id, amount, advance_date, notes } = req.body;
  const emp = employees.find(e => e.id === Number(employee_id));
  const newCA = { id: cashAdvances.length + 1, employee_id: Number(employee_id), amount: Number(amount), advance_date, notes: notes || '', emp_number: emp?.emp_number || '', name: emp?.name || '', locked: false };
  cashAdvances.push(newCA);
  res.status(201).json(newCA);
});

app.put('/api/cash-advances/:id', requireAuth, (req, res) => {
  const idx = cashAdvances.findIndex(c => c.id === Number(req.params.id));
  if (idx !== -1) cashAdvances[idx] = { ...cashAdvances[idx], ...req.body };
  res.json(cashAdvances[idx]);
});

app.delete('/api/cash-advances/:id', requireAuth, (req, res) => {
  const idx = cashAdvances.findIndex(c => c.id === Number(req.params.id));
  if (idx !== -1) cashAdvances.splice(idx, 1);
  res.json({ ok: true });
});

app.get('/api/salary-payments', requireAuth, (req, res) => {
  res.json({ weekStart, weekEnd, rows: salaryPayments });
});

app.post('/api/salary-payments', requireAuth, (req, res) => {
  const { employee_id, amount, payment_date, notes } = req.body;
  const emp = employees.find(e => e.id === Number(employee_id));
  const newSP = { id: salaryPayments.length + 1, employee_id: Number(employee_id), amount: Number(amount), payment_date, notes: notes || '', emp_number: emp?.emp_number || '', name: emp?.name || '' };
  salaryPayments.push(newSP);
  res.status(201).json(newSP);
});

app.get('/api/extra-payments', requireAuth, (req, res) => {
  res.json({ weekStart, weekEnd, rows: extraPayments });
});

app.post('/api/extra-payments', requireAuth, (req, res) => {
  const { employee_id, amount, extra_date, notes } = req.body;
  const emp = employees.find(e => e.id === Number(employee_id));
  const newEP = { id: extraPayments.length + 1, employee_id: Number(employee_id), amount: Number(amount), extra_date, notes: notes || '', emp_number: emp?.emp_number || '', name: emp?.name || '' };
  extraPayments.push(newEP);
  res.status(201).json(newEP);
});

app.get('/api/bale-payments', requireAuth, (req, res) => {
  res.json({ weekStart, weekEnd, rows: balePayments });
});

app.post('/api/bale-payments', requireAuth, (req, res) => {
  const { employee_id, amount, payment_date, notes } = req.body;
  const emp = employees.find(e => e.id === Number(employee_id));
  const newBP = { id: balePayments.length + 1, employee_id: Number(employee_id), amount: Number(amount), payment_date, notes: notes || '', emp_number: emp?.emp_number || '', name: emp?.name || '' };
  balePayments.push(newBP);
  res.status(201).json(newBP);
});

app.get('/api/transactions/calendar', requireAuth, (req, res) => {
  const month = req.query.month;
  if (!month) return res.json({ dates: [] });
  const all = [...salaryPayments.map(p => p.payment_date), ...cashAdvances.map(c => c.advance_date), ...balePayments.map(b => b.payment_date), ...extraPayments.map(e => e.extra_date)];
  res.json({ dates: all.filter(d => d && d.startsWith(month)) });
});

app.get('/api/audit-logs', requireAuth, (req, res) => {
  res.json({ rows: [
    { id: 1, created_at: '2026-07-27T14:30:00Z', username: 'admin', action: 'create', entity: 'employee', entity_id: 1, details: { name: 'Juan Dela Cruz', emp_number: 'EMP-001' } },
    { id: 2, created_at: '2026-07-27T15:00:00Z', username: 'admin', action: 'update', entity: 'employee', entity_id: 1, details: { name: 'Juan Dela Cruz', rate: '575' } },
    { id: 3, created_at: '2026-07-28T09:00:00Z', username: 'hr', action: 'create', entity: 'attendance', entity_id: 1, details: { employee_id: 1, work_date: '2026-07-27' } },
  ], page: 1, totalPages: 1, total: 3 });
});

app.put('/api/password', requireAuth, (req, res) => {
  res.json({ ok: true });
});

// SPA fallback - must be last route
app.use((req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log(`Mock server running at http://localhost:${PORT}`);
  console.log('Login with admin/kvsk@2018 or hr/hr123');
});
