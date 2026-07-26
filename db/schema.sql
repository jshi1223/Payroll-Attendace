CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(80) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'hr')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS employee_number_seq START 1;

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  emp_number VARCHAR(40) UNIQUE NOT NULL DEFAULT ('EMP-' || LPAD(nextval('employee_number_seq')::text, 5, '0')),
  name VARCHAR(160) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  rate NUMERIC(12, 2) NOT NULL CHECK (rate >= 0),
  pay_period_days INT NOT NULL DEFAULT 7 CHECK (pay_period_days >= 1),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sss_number VARCHAR(12) DEFAULT '',
  philhealth_number VARCHAR(14) DEFAULT '',
  pagibig_number VARCHAR(14) DEFAULT '',
  tin_number VARCHAR(15) DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance_logs (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  work_date DATE NOT NULL,
  time_in TIME,
  time_out TIME,
  rate_snapshot NUMERIC(12, 2) NOT NULL CHECK (rate_snapshot >= 0),
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS cash_advances (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  advance_date DATE NOT NULL,
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  entity VARCHAR(80) NOT NULL,
  entity_id INTEGER,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS extra_payments (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  extra_date DATE NOT NULL,
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attendance_logs_work_date ON attendance_logs(work_date);
CREATE INDEX IF NOT EXISTS idx_cash_advances_date ON cash_advances(advance_date);
CREATE INDEX IF NOT EXISTS idx_employees_name ON employees(name);
CREATE INDEX IF NOT EXISTS idx_payroll_statuses_week ON payroll_statuses(week_start);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_extra_payments_date ON extra_payments(extra_date);
