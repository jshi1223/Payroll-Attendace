/* ── Helpers ── */
function titleForView() {
  return {
    dashboard: 'Dashboard',
    payroll: 'Weekly Payroll',
    attendance: 'Attendance Logs',
    employees: 'Employee Module',
    archive: 'Archive'
  }[state.view];
}

function weekToolbar(className = '') {
  return `
    <div class="toolbar module-toolbar no-print${className ? ' ' + className : ''}">
      <label>Week Start<input type="date" id="weekInput" value="${state.week}"></label>
      <label>Search<input id="searchInput" value="${state.searchPayroll}" placeholder="Emp no. or name"></label>
      <button class="ghost" id="prevWeek">Previous Week</button>
      <button class="ghost" id="nextWeek">Next Week</button>
    </div>
  `;
}

function bindWeekToolbar() {
  document.querySelector('#weekInput')?.addEventListener('change', async event => {
    state.week = payrollWeekStartOf(event.target.value);
    state.payrollWeek = state.week;
    saveUiState();
    await refresh();
  });
  document.querySelector('#searchInput')?.addEventListener('input', debounce(async event => {
    state.searchPayroll = event.target.value;
    saveUiState();
    await refresh();
    const restored = document.querySelector('#searchInput');
    if (restored) {
      restored.focus();
      restored.setSelectionRange(restored.value.length, restored.value.length);
    }
  }, 250));
  document.querySelector('#prevWeek')?.addEventListener('click', async () => {
    state.week = addDays(state.week, -7);
    state.payrollWeek = state.week;
    saveUiState();
    await refresh();
  });
  document.querySelector('#nextWeek')?.addEventListener('click', async () => {
    state.week = addDays(state.week, 7);
    state.payrollWeek = state.week;
    saveUiState();
    await refresh();
  });
}

function bindSearchWithFocus(selector) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.addEventListener('input', debounce(async () => {
    saveUiState();
    await refresh();
    const restored = document.querySelector(selector);
    if (restored) {
      restored.focus();
      restored.setSelectionRange(restored.value.length, restored.value.length);
    }
  }, 250));
}

function employeeOptions() {
  return state.employees.map(employee => `<option value="${employee.id}">${employee.emp_number} - ${employee.name}</option>`).join('');
}

/* ── Login ── */
function renderLogin(error = '') {
  const savedUsername = localStorage.getItem('payrollUsername') || '';
  app.innerHTML = `
    <section class="login-screen">
      <form class="login-panel" id="loginForm">
        <div class="login-brand">
          <div class="login-logo"><span>P</span></div>
          <h1>Payroll System</h1>
          <p>Sign in to manage employees, attendance, and payroll</p>
        </div>
        <div class="form-grid">
          <label>Username<input name="username" id="loginUsername" autocomplete="username" value="${escapeHtml(savedUsername)}" required></label>
          <label>Password<div class="password-wrapper"><input name="password" id="loginPassword" type="password" autocomplete="current-password" required><button type="button" class="password-toggle" onclick="togglePassword(this)" tabindex="-1">👁</button></div><div class="caps-warning" id="capsWarning">⇪ Caps Lock is ON</div></label>
          <label class="checkbox-row"><input type="checkbox" id="rememberMe" ${savedUsername ? 'checked' : ''}> Remember username</label>
          <button class="primary" type="submit" id="loginBtn">Sign In</button>
          <div class="error">${error}</div>
        </div>
        <div class="login-footer">
          <span class="badge role-admin">👑 Admin</span>
          <span class="badge role-hr">👤 HR Staff</span>
        </div>
      </form>
    </section>
  `;

  const usernameInput = document.querySelector('#loginUsername');
  const passwordInput = document.querySelector('#loginPassword');
  const capsWarning = document.querySelector('#capsWarning');

  if (usernameInput && !savedUsername) setTimeout(() => usernameInput.focus(), 50);

  passwordInput?.addEventListener('keydown', event => {
    capsWarning.classList.toggle('visible', event.getModifierState('CapsLock'));
  });
  passwordInput?.addEventListener('keyup', event => {
    capsWarning.classList.toggle('visible', event.getModifierState('CapsLock'));
  });

  document.querySelector('#loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const btn = document.querySelector('#loginBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-sm"></span> Signing in…';
    const form = new FormData(event.currentTarget);
    const username = form.get('username');
    if (document.querySelector('#rememberMe').checked) {
      localStorage.setItem('payrollUsername', username);
    } else {
      localStorage.removeItem('payrollUsername');
    }
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(form))
      });
      state.user = data.user;
      state.sessionTTL = data.sessionTTL;
      state.loggedInAt = Date.now();
      showToast('Welcome, ' + username + '!');
      startDateWatcher();
      startDataPoller();
      startSessionTimer();
      await refresh();
    } catch (err) {
      showToast(err.message, 'error');
      renderLogin(err.message);
    }
  });
}

/* ── Dashboard ── */
function renderDashboard() {
  const payroll = state.payroll;
  const empCount = state.employees.filter(e => e.active !== false).length;
  const attendanceToday = state.attendance.rows.filter(r => r.work_date === state.currentDate).length;
  const summary = payroll ? payroll.summary : null;
  const isAdmin = state.user.role === 'admin';
  shell(`
    <section class="summary">
      <div class="summary-card" style="border-left-color: #0f766e;">
        <span class="card-icon">👥</span>
        <span>Active Employees</span>
        <strong>${empCount}</strong>
      </div>
      <div class="summary-card" style="border-left-color: #b45309;">
        <span class="card-icon">📋</span>
        <span>Present Today</span>
        <strong>${attendanceToday}</strong>
        <span class="card-sub">${state.currentDate}</span>
      </div>
      <div class="summary-card" style="border-left-color: #075985;">
        <span class="card-icon">💰</span>
        <span>This Week's Salary</span>
        <strong>${summary ? formatMoney(summary.totalSalary) : '₱0.00'}</strong>
      </div>
      <div class="summary-card" style="border-left-color: #166534;">
        <span class="card-icon">💵</span>
        <span>Salary Payment</span>
        <strong>${summary ? formatMoney(summary.totalPaidAmount) : '₱0.00'}</strong>
      </div>
      <div class="summary-card" style="border-left-color: #c2410c;">
        <span class="card-icon">📊</span>
        <span>Outstanding Balance</span>
        <strong>${summary ? formatMoney(summary.totalBalance) : '₱0.00'}</strong>
      </div>
      <div class="summary-card" style="border-left-color: #92400e;">
        <span class="card-icon">📦</span>
        <span>Bale Balance</span>
        <strong>${summary ? formatMoney(summary.totalBaleBalance) : '₱0.00'}</strong>
      </div>
    </section>
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Quick Actions</h2>
          <p>${state.currentDate} | Week: ${payroll ? payroll.weekStart : state.week}</p>
        </div>
        <span class="badge role-${state.user.role}">${isAdmin ? '👑 Admin' : '👤 HR'}</span>
      </div>
      <div class="quick-actions">
        <div class="quick-action-card" data-quick-view="payroll">
          <span class="qa-icon">📊</span>
          <strong>Payroll</strong>
          <span>View and manage weekly payroll, payments, and payslips.</span>
          <button class="primary">Go to Payroll</button>
        </div>
        <div class="quick-action-card" data-quick-view="attendance">
          <span class="qa-icon">📋</span>
          <strong>Attendance</strong>
          <span>Record daily employee attendance logs.</span>
          <button class="ghost">Take Attendance</button>
        </div>
        <div class="quick-action-card" data-quick-view="employees">
          <span class="qa-icon">👥</span>
          <strong>Employees</strong>
          <span>${isAdmin ? 'Add, edit, or archive employee profiles.' : 'Add and edit employee profiles.'}</span>
          <button class="ghost">Manage Employees</button>
        </div>
        <div class="quick-action-card" data-quick-view="archive">
          <span class="qa-icon">📦</span>
          <strong>Archive</strong>
          <span>${isAdmin ? 'View archived employees, restore, or permanently delete.' : 'View archived employees (read-only).'}</span>
          <button class="ghost">${isAdmin ? 'Go to Archive' : 'View Archive'}</button>
        </div>
        ${isAdmin ? `
        <div class="quick-action-card" onclick="state.showAudit=true;refresh()">
          <span class="qa-icon">📋</span>
          <strong>Audit Trail 🔒</strong>
          <span>View all system actions and changes (Admin only).</span>
          <button class="ghost">Open Audit Trail</button>
        </div>` : `
        <div class="quick-action-card" style="opacity:0.6;cursor:default;">
          <span class="qa-icon">🔒</span>
          <strong>Audit Trail</strong>
          <span>🔒 Admin-only feature. Request access from admin.</span>
          <button class="ghost" disabled style="cursor:not-allowed;">Admin Only</button>
        </div>`}
      </div>
    </section>
  `);
  document.querySelectorAll('.quick-action-card').forEach(card => {
    card.addEventListener('click', async (e) => {
      const view = card.dataset.quickView;
      if (view) {
        state.view = view;
        saveUiState();
        await refresh();
      }
    });
  });
}

/* ── Payroll ── */
function renderPayroll() {
  const allRows = state.searchPayroll
    ? state.payroll.rows.filter(r => {
        const s = state.searchPayroll.toLowerCase();
        return (r.name && r.name.toLowerCase().includes(s)) || (r.emp_number && r.emp_number.toLowerCase().includes(s));
      })
    : state.payroll.rows;
  const summary = state.payroll.summary;
  const filteredSummary = {
    employees: allRows.length,
    workingDays: allRows.reduce((a, r) => a + (r.days || 0), 0),
    totalPaidAmount: allRows.reduce((a, r) => a + Number(r.paid_amount || 0), 0),
    totalBalance: allRows.reduce((a, r) => a + Number(r.balance || 0), 0),
    totalBaleBalance: allRows.reduce((a, r) => a + Number(r.remaining_bale_balance || 0), 0),
    totalPreviousUnpaid: allRows.reduce((a, r) => a + Number(r.previous_unpaid_balance || 0), 0)
  };
  const displaySummary = state.searchPayroll ? filteredSummary : summary;
  const pg = paginateRows(allRows, state.pages.payroll || 1);
  shell(`
    <div class="toolbar module-toolbar" style="display:flex; justify-content:space-between;">
      <div></div>
      <button class="ghost" id="exportCSVBtn">Export CSV</button>
    </div>
    ${weekToolbar()}
    <section class="summary">
      <div class="summary-card" style="border-left-color:#0f766e;">
        <span class="card-icon">👥</span>
        <span>Employee Records</span>
        <strong>${displaySummary.employees}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#2563eb;">
        <span class="card-icon">📅</span>
        <span>Working Days</span>
        <strong>${displaySummary.workingDays}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#166534;">
        <span class="card-icon">💵</span>
        <span>Salary Payment</span>
        <strong>${formatMoney(displaySummary.totalPaidAmount)}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#075985;">
        <span class="card-icon">💰</span>
        <span>Current Balance (Unpaid)</span>
        <strong>${formatMoney(displaySummary.totalBalance)}</strong>
        <span class="card-sub">Outstanding salary balance after payments</span>
      </div>
      <div class="summary-card" style="border-left-color:#92400e;">
        <span class="card-icon">📦</span>
        <span>Bale Balance</span>
        <strong>${formatMoney(displaySummary.totalBaleBalance)}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#c2410c;">
        <span class="card-icon">📋</span>
        <span>Prev Unpaid</span>
        <strong>${formatMoney(displaySummary.totalPreviousUnpaid)}</strong>
      </div>
    </section>
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Payroll Records</h2>
          <p>Weekly salary, C/A, payment, and payslip actions.</p>
        </div>
        ${state.user.role === 'admin' ? `<button class="ghost no-print" id="openAuditTrail">Audit Trail</button>` : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Emp Number</th><th>Name</th><th>Rate</th><th>No. of Days </th><th>Salary</th>              <th>Prev Unpaid</th><th>Prev Bale</th><th>C/A</th><th>Extra Payment</th><th>Total Bale</th><th>Salary Payment</th><th class="col-balance-header">Salary Balance</th><th class="col-bale-header">Bale Balance</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            ${pg.rows.map(row => {
              const flash = state._flash && state._flash.type === 'payroll' && Number(state._flash.id) === Number(row.employee_id);
              return `
              <tr class="status-${row.payment_status}${flash ? ' flash' : ''}" data-employee-id="${row.employee_id}">
                <td>${highlight(row.emp_number)}</td>
                <td>${highlight(row.name)}</td>
                <td>${formatMoney(row.rate)}</td>
                <td>${row.days}</td>
                <td><strong>${formatMoney(row.salary)}</strong></td>
                <td>${formatMoney(row.previous_unpaid_balance)}</td>
                <td>${formatMoney(row.previous_bale_balance)}</td>
                <td>${formatMoney(row.cash_advance)}</td>
                <td>${formatMoney(row.extra_payment_amount || 0)}</td>
                <td>${formatMoney(row.total_bale)}</td>
                <td>${formatMoney(row.paid_amount)}</td>
                <td class="col-balance"><strong class="balance-amount">${formatMoney(row.balance)}</strong></td>
                <td class="col-bale"><strong class="bale-amount">${formatMoney(row.remaining_bale_balance)}</strong></td>
              <td><span class="badge ${row.payment_status} status-badge">${row.payment_status === 'paid' ? 'Paid' : row.payment_status === 'partial' ? 'Partial' : 'Unpaid'}</span></td>
              <td class="actions">
                <button class="ghost" data-payslip="${row.employee_id}">Payslip</button>
                <button class="ghost" data-cash-employee="${row.employee_id}">C/A</button>
                <button class="ghost" data-payment-employee="${row.employee_id}">${row.paid_amount > 0 ? 'Edit' : 'Pay'}</button>
                <button class="ghost" data-bale-employee="${row.employee_id}">Bale</button>
                <button class="ghost" data-extra-payment-employee="${row.employee_id}">Extra</button>
              </td>
              </tr>
            `;
            }).join('') || `<tr><td colspan="15" class="empty-state"><span class="empty-icon">📋</span><strong>No Payroll Data</strong><span>No payroll records found for this week.</span></td></tr>`}
          </tbody>
        </table>
      </div>
      ${paginationHTML(pg, 'payroll')}
    </section>
    ${state.cashEmployee ? cashAdvanceModal(state.cashEmployee) : ''}
    ${state.paymentEmployee ? paymentModal(state.paymentEmployee) : ''}
    ${state.baleDeductionEmployee ? baleDeductionModal(state.baleDeductionEmployee) : ''}
    ${state.extraPaymentEmployee ? extraPaymentModal(state.extraPaymentEmployee) : ''}
  `);
  document.querySelector('#exportCSVBtn')?.addEventListener('click', () => {
    const exportData = allRows.map(row => ({
      'Emp Number': row.emp_number,
      'Name': row.name,
      'Rate': row.rate,
      'Days': row.days,
      'Salary': row.salary,
      'Previous Unpaid': row.previous_unpaid_balance,
      'Previous Bale': row.previous_bale_balance,
      'Cash Advance': row.cash_advance,
      'Extra Payment': row.extra_payment_amount || 0,
      'Total Bale': row.total_bale,
      'Salary Payment': row.paid_amount,
      'Balance': row.balance,
      'Bale Balance': row.remaining_bale_balance,
      'Status': row.payment_status
    }));
    exportCSV(exportData, `payroll_${state.week}.csv`);
  });
  bindPagination('payroll', refresh);
  bindWeekToolbar();
  document.querySelector('#openAuditTrail')?.addEventListener('click', () => {
    state.showAudit = true;
    renderPayroll();
  });
  document.querySelectorAll('[data-payslip]').forEach(button => {
    button.addEventListener('click', () => renderPayslip(allRows.find(row => String(row.employee_id) === button.dataset.payslip)));
  });
  document.querySelectorAll('[data-cash-employee]').forEach(button => {
    button.addEventListener('click', () => {
      state.cashEmployee = allRows.find(row => String(row.employee_id) === button.dataset.cashEmployee);
      renderPayroll();
    });
  });
  document.querySelectorAll('[data-payment-employee]').forEach(button => {
    button.addEventListener('click', () => {
      state.paymentEmployee = allRows.find(row => String(row.employee_id) === button.dataset.paymentEmployee);
      renderPayroll();
    });
  });
  document.querySelectorAll('[data-bale-employee]').forEach(button => {
    button.addEventListener('click', () => {
      state.baleDeductionEmployee = allRows.find(row => String(row.employee_id) === button.dataset.baleEmployee);
      renderPayroll();
    });
  });
  document.querySelectorAll('[data-extra-payment-employee]').forEach(button => {
    button.addEventListener('click', () => {
      state.extraPaymentEmployee = allRows.find(row => String(row.employee_id) === button.dataset.extraPaymentEmployee);
      renderPayroll();
    });
  });
  bindCashAdvanceModal();
  bindPaymentModal();
  bindBaleDeductionModal();
  bindExtraPaymentModal();
  bindDeletes();
}

/* ── Attendance ── */
function renderAttendance() {
  const dayRows = state.attendance.rows.filter(row => row.work_date === state.attendanceDate);
  const pg = paginateRows(dayRows, state.pages.attendance || 1);
  const presentEmployeeIds = new Set(dayRows.map(row => Number(row.employee_id)));
  const availableEmployees = state.employees.filter(employee => !presentEmployeeIds.has(Number(employee.id)));
  shell(`
    <div class="toolbar module-toolbar no-print toolbar-end">
      <label>Date<input type="date" id="attendanceDate" value="${state.attendanceDate}"></label>
      <label>Search<input id="searchInput" value="${state.searchAttendance}" placeholder="Emp no. or name"></label>
      <button class="ghost" id="prevDay">Previous Day</button>
      <button class="ghost" id="nextDay">Next Day</button>
    </div>
    <section class="summary">
      <div class="summary-card" style="border-left-color:#0f766e;">
        <span class="card-icon">📋</span>
        <span>Present Today</span>
        <strong>${dayRows.length}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#2563eb;">
        <span class="card-icon">📅</span>
        <span>Date</span>
        <strong>${state.attendanceDate}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#b45309;">
        <span class="card-icon">🔢</span>
        <span>Workday No.</span>
        <strong>${payrollWorkdayNumber(state.attendanceDate)}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#075985;">
        <span class="card-icon">📆</span>
        <span>Payroll Week</span>
        <strong>${state.week}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#92400e;">
        <span class="card-icon">🏁</span>
        <span>Week Ends</span>
        <strong>${addDays(state.week, 6)}</strong>
      </div>
    </section>
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>📋 Daily Attendance</h2>
          <p>Record employees who attended for the selected date.</p>
        </div>
        <span class="badge" style="background:#eff6ff;color:#075985;">${dayRows.length} Present Today</span>
      </div>
      <form class="inline-form" id="attendanceForm">
        <label>Employee
          ${searchableSelectHTML('employee_id',
            availableEmployees.map(e => ({ value: e.id, label: `${e.emp_number} - ${e.name}` })),
            '🔍 Type to search employee...'
          )}
        </label>
        <label>Notes<input name="notes" placeholder="Present, Late, etc."></label>
        <button class="primary" ${availableEmployees.length ? '' : 'disabled'}>Add Attendance</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Emp Number</th>
              <th>Name</th>
              <th>Status</th>
              <th>Rate</th>
              <th>Notes</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${pg.rows.map(row => `
              <tr>
                <td>${row.work_date}</td>
                <td>${highlight(row.emp_number)}</td>
                <td>${highlight(row.name)}</td>
                <td><span class="badge paid">✓ Present</span></td>
                <td>${peso.format(row.rate_snapshot)}</td>
                <td>${row.notes ? escapeHtml(row.notes) : '<span class="muted">—</span>'}</td>
                <td class="actions">${deleteButton('attendance', row.id)}</td>
              </tr>
            `).join('') || `<tr><td colspan="7" class="empty-state"><span class="empty-icon">📋</span><strong>No Attendance Records</strong><span>No attendance recorded for this date yet.</span></td></tr>`}
          </tbody>
        </table>
      </div>
      ${paginationHTML(pg, 'attendance')}
    </section>
  `);
  bindPagination('attendance', refresh);
  document.querySelector('#attendanceDate').addEventListener('change', async event => {
    state.attendanceDate = event.target.value;
    state.week = weekStartOf(state.attendanceDate);
    saveUiState();
    await refresh();
  });
  document.querySelector('#searchInput').addEventListener('input', debounce(async event => {
    state.searchAttendance = event.target.value;
    saveUiState();
    await refresh();
    const restored = document.querySelector('#searchInput');
    if (restored) {
      restored.focus();
      restored.setSelectionRange(restored.value.length, restored.value.length);
    }
  }, 250));
  document.querySelector('#prevDay').addEventListener('click', async () => {
    state.attendanceDate = addDays(state.attendanceDate, -1);
    state.week = weekStartOf(state.attendanceDate);
    saveUiState();
    await refresh();
  });
  document.querySelector('#nextDay').addEventListener('click', async () => {
    state.attendanceDate = addDays(state.attendanceDate, 1);
    state.week = weekStartOf(state.attendanceDate);
    saveUiState();
    await refresh();
  });
  document.querySelector('#attendanceForm').addEventListener('submit', async event => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    const submitBtn = event.currentTarget.querySelector('button[type="submit"]');

    if (!payload.employee_id) {
      showToast('Please select an employee.', 'error');
      return;
    }

    loadingButton(submitBtn, true);
    try {
      await api('/api/attendance', {
        method: 'POST',
        body: JSON.stringify({
          employee_id: payload.employee_id,
          work_date: state.attendanceDate,
          notes: payload.notes || 'Present'
        })
      });
      showToast('Attendance recorded.');
      await refresh();
    } catch (error) {
      showToast(error.message, 'error');
      loadingButton(submitBtn, false);
    }
  });
  bindSearchableSelect(document.querySelector('#attendanceForm'));
  bindDeletes();
}

/* ── Employees ── */
function renderEmployees() {
  const editing = state.editingEmployee;
  const pg = paginateRows(state.employees, state.pages.employees || 1);
  const activeCount = state.employees.filter(e => e.active !== false).length;
  const inactiveCount = state.employees.length - activeCount;
  shell(`
    <section class="toolbar module-toolbar toolbar-end">
      <label>Search<input id="employeeSearch" value="${state.searchEmployees}" placeholder="Emp no. or name"></label>
      <button class="primary" id="openEmployeeModal">➕ Add Employee</button>
    </section>
    <section class="summary">
      <div class="summary-card" style="border-left-color:#0f766e;">
        <span class="card-icon">👥</span>
        <span>Total Active</span>
        <strong>${activeCount}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#92400e;">
        <span class="card-icon">📦</span>
        <span>Archived</span>
        <strong>${inactiveCount}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#075985;">
        <span class="card-icon">💰</span>
        <span>Avg. Rate</span>
        <strong>${activeCount > 0 ? formatMoney(state.employees.filter(e => e.active !== false).reduce((s, e) => s + Number(e.rate), 0) / activeCount) : '₱0.00'}</strong>
      </div>
    </section>
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Employee List</h2>
          <p>Manage employee profiles, status, and daily rates.</p>
        </div>
        <span class="badge" style="background:#dcfce7;color:#166534;">🟢 ${activeCount} Active</span>
        ${inactiveCount > 0 ? `<span class="badge unpaid">📦 ${inactiveCount} Archived</span>` : ''}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Avatar</th><th>Emp Number</th><th>Name</th><th>Phone</th><th>Rate</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${pg.rows.map(row => {
              const initials = row.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
              const flash = state._flash && state._flash.type === 'employees' && Number(state._flash.id) === Number(row.id);
              const avatarHtml = row.photo_url
                ? `<div class="emp-avatar-sm clickable-photo" data-photo="${row.photo_url}" data-name="${escapeHtml(row.name)}"><img src="${row.photo_url}" alt="${escapeHtml(row.name)}"></div>`
                : `<div class="emp-avatar-sm" style="background:#dc2626;">${initials}</div>`;
              return `
              <tr class="${row.active !== false ? '' : 'inactive-row'}${flash ? ' flash' : ''}">
                <td>${avatarHtml}</td>
                <td>${highlight(row.emp_number)}</td>
                <td><strong>${highlight(row.name)}</strong></td>
                <td>${escapeHtml(row.phone || '-')}</td>
                <td><strong>${peso.format(row.rate)}</strong>/day</td>
                <td><span class="badge ${row.active !== false ? 'paid' : 'unpaid'}" style="font-size:11px;">${row.active !== false ? '🟢 Active' : '🔴 Inactive'}</span></td>
                <td class="actions">
                  <button class="ghost" data-edit-employee="${row.id}">✏️ Edit</button>
                  ${deleteButton('employees', row.id)}
                </td>
              </tr>
            `}).join('') || `<tr><td colspan="7" class="empty-state"><span class="empty-icon">👥</span><strong>No Employees</strong><span>Add your first employee to get started.</span></td></tr>`}
          </tbody>
        </table>
      </div>
      ${paginationHTML(pg, 'employees')}
    </section>
    ${editing ? employeeModal(editing) : ''}
  `);
  document.querySelector('#employeeSearch').addEventListener('input', debounce(async event => {
    state.searchEmployees = event.target.value;
    saveUiState();
    await refresh();
    const restored = document.querySelector('#employeeSearch');
    if (restored) {
      restored.focus();
      restored.setSelectionRange(restored.value.length, restored.value.length);
    }
  }, 250));
  document.querySelector('#openEmployeeModal').addEventListener('click', () => {
    state.editingEmployee = {};
    renderEmployees();
  });
  document.querySelectorAll('[data-edit-employee]').forEach(button => {
    button.addEventListener('click', () => {
      state.editingEmployee = state.employees.find(row => String(row.id) === button.dataset.editEmployee);
      renderEmployees();
    });
  });
  /* Click avatar → show photo lightbox */
  document.querySelectorAll('.clickable-photo').forEach(el => {
    el.addEventListener('click', () => {
      const photoUrl = el.dataset.photo;
      const name = el.dataset.name;
      const lightbox = document.createElement('div');
      lightbox.className = 'photo-lightbox';
      lightbox.innerHTML = `<div class="photo-lightbox-bg"></div><div class="photo-lightbox-content"><button class="photo-lightbox-close">&times;</button><img src="${photoUrl}" alt="${name}"></div>`;
      document.body.appendChild(lightbox);
      const close = () => lightbox.remove();
      lightbox.querySelector('.photo-lightbox-bg').addEventListener('click', close);
      lightbox.querySelector('.photo-lightbox-close').addEventListener('click', close);
      document.addEventListener('keydown', close, { once: true });
    });
  });
  bindPagination('employees', refresh);
  bindEmployeeModal();
  bindDeletes();
}

/* ── Archive ── */
function renderArchive() {
  const rows = state.employees;
  const pg = paginateRows(rows, state.pages.archive || 1);
  shell(`
    <section class="toolbar module-toolbar toolbar-end">
      <label>Search<input id="archiveSearch" value="${state.searchEmployees}" placeholder="Emp no. or name"></label>
      <span class="badge unpaid">${rows.length} Archived</span>
    </section>
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Archived Employees</h2>
          <p>Inactive employees. Restore to reactivate or permanently delete all records.</p>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Emp Number</th><th>Name</th><th>Phone</th><th>Rate</th><th>Last Payroll</th><th>Total Paid</th><th>Balance</th><th>Actions</th></tr></thead>
          <tbody>
            ${pg.rows.map(row => {
              const empPayroll = state.payroll ? state.payroll.rows.filter(r => Number(r.employee_id) === Number(row.id)) : [];
              const lastPayroll = empPayroll.length > 0 ? empPayroll[0].weekStart || state.week : '-';
              const totalPaid = empPayroll.reduce((sum, r) => sum + Number(r.paid_amount || 0), 0);
              const balance = empPayroll.reduce((sum, r) => sum + Number(r.balance || 0), 0);
              return `
              <tr>
                <td>${highlight(row.emp_number)}</td>
                <td>${highlight(row.name)}</td>
                <td>${escapeHtml(row.phone || '-')}</td>
                <td>${peso.format(row.rate)}</td>
                <td>${lastPayroll}</td>
                <td>${peso.format(totalPaid)}</td>
                <td>${peso.format(balance)}</td>
                <td class="actions">
                  <button class="ghost" data-restore-employee="${row.id}">Restore</button>
                  <button class="ghost" data-archive-payslip="${row.id}">Payslip</button>
                  <button class="danger" data-permanent-delete="${row.id}">Delete Forever</button>
                </td>
              </tr>
              `;
            }).join('') || `<tr><td colspan="8" class="empty-state"><span class="empty-icon">📦</span><strong>No Archived Employees</strong><span>No employees are archived. Archive inactive employees from the Employees section.</span></td></tr>`}
          </tbody>
        </table>
      </div>
      ${paginationHTML(pg, 'archive')}
    </section>
  `);
  document.querySelector('#archiveSearch')?.addEventListener('input', debounce(async event => {
    state.searchEmployees = event.target.value;
    saveUiState();
    await refresh();
    const restored = document.querySelector('#archiveSearch');
    if (restored) {
      restored.focus();
      restored.setSelectionRange(restored.value.length, restored.value.length);
    }
  }, 250));
  document.querySelectorAll('[data-restore-employee]').forEach(button => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/employees/${button.dataset.restoreEmployee}/restore`, { method: 'PUT' });
        showToast('Employee restored successfully.');
        await refresh();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
  document.querySelectorAll('[data-archive-payslip]').forEach(button => {
    button.addEventListener('click', () => {
      const emp = rows.find(r => String(r.id) === button.dataset.archivePayslip);
      if (emp) {
        const payrollRow = state.payroll ? state.payroll.rows.find(r => Number(r.employee_id) === Number(emp.id)) : null;
        if (payrollRow) {
          renderPayslip(payrollRow);
        } else {
          showToast('No payroll data available for this employee.', 'info');
        }
      }
    });
  });
  document.querySelectorAll('[data-permanent-delete]').forEach(button => {
    button.addEventListener('click', () => {
      state.pendingDelete = {
        resource: 'employees-permanent',
        id: button.dataset.permanentDelete
      };
      refresh();
    });
  });
  bindPagination('archive', refresh);
}

/* ── Cash Advance standalone view ── */
function renderCashAdvance() {
  const editing = state.editingCashAdvance;
  const pg = paginateRows(state.advances.rows, state.pages.cashAdvance || 1);
  shell(`
    ${weekToolbar('toolbar-end')}
    <section class="panel">
      <form class="inline-form" id="cashForm">
        <input type="hidden" name="id" value="${editing?.id || ''}">
        <label>Employee
          <select name="employee_id" required>
            ${state.employees.map(employee => `<option value="${employee.id}" ${Number(editing?.employee_id) === Number(employee.id) ? 'selected' : ''}>${employee.emp_number} - ${employee.name}</option>`).join('')}
          </select>
        </label>
        <label>Amount<input name="amount" type="number" min="0.01" step="0.01" value="${editing?.amount || ''}" required></label>
        <label>Date<input name="advance_date" type="date" value="${editing?.advance_date || todayInManila()}" required></label>
        <label>Notes<input name="notes" value="${escapeHtml(editing?.notes || '')}"></label>
        ${editing ? '<button class="ghost" type="button" id="cancelCashEdit">Cancel Edit</button>' : ''}
        <button class="primary">${editing ? 'Update C/A' : 'Add C/A'}</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Emp Number</th><th>Name</th><th>Amount</th><th>Notes</th><th>Actions</th></tr></thead>
          <tbody>
            ${pg.rows.map(row => `
              <tr>
                <td>${row.advance_date.slice(0, 10)}</td><td>${highlight(row.emp_number)}</td><td>${highlight(row.name)}</td>
                <td>${peso.format(row.amount)}</td><td>${escapeHtml(row.notes || '-')}</td>
                <td class="actions">
                  <button class="ghost" data-edit-cash="${row.id}">Edit</button>
                  ${deleteButton('cash-advances', row.id)}
                </td>
              </tr>
            `).join('') || `<tr><td colspan="6" class="empty-state"><span class="empty-icon">💰</span><strong>No Cash Advances</strong><span>No C/A records this week. Use the form above to add one.</span></td></tr>`}
          </tbody>
        </table>
      </div>
      ${paginationHTML(pg, 'cashAdvance')}
    </section>
  `);
  bindPagination('cashAdvance', refresh);
  bindWeekToolbar();
  document.querySelector('#cancelCashEdit')?.addEventListener('click', () => {
    state.editingCashAdvance = null;
    renderCashAdvance();
  });
  document.querySelectorAll('[data-edit-cash]').forEach(button => {
    button.addEventListener('click', () => {
      state.editingCashAdvance = state.advances.rows.find(row => String(row.id) === button.dataset.editCash);
      renderCashAdvance();
    });
  });
  bindCashAdvanceForm('#cashForm');
  bindDeletes();
}

function bindCashAdvanceForm(selector) {
  document.querySelector(selector)?.addEventListener('submit', async event => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    const id = payload.id;
    delete payload.id;
    await api(id ? `/api/cash-advances/${id}` : '/api/cash-advances', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    state.editingCashAdvance = null;
    state._flash = { id: Number(payload.employee_id), type: 'payroll' };
    showToast(id ? 'C/A updated successfully.' : 'C/A added successfully.');
    await refresh();
  });
}

/* ── Payslip ── */
function renderPayslip(row) {
  const weekDates = Array.from({ length: 7 }, (_, index) => addDays(state.week, index));
  const attendanceSet = new Set(
    state.attendance.rows
      .filter(log => Number(log.employee_id) === Number(row.employee_id))
      .map(log => log.work_date)
  );
  const cashLogs = state.advances.rows.filter(log => Number(log.employee_id) === Number(row.employee_id));
  const cashByDate = cashLogs.reduce((map, log) => {
    map[log.advance_date] = log;
    return map;
  }, {});
  const dayData = weekDates.map(date => {
    const present = attendanceSet.has(date);
    const cashLog = cashByDate[date];
    const earning = present ? Number(row.rate) : 0;
    const bale = cashLog ? Number(cashLog.amount) : 0;
    return { date, present, cashLog, earning, bale };
  });
  const totalEarnings = dayData.reduce((sum, d) => sum + d.earning, 0);
  const totalBale = dayData.reduce((sum, d) => sum + d.bale, 0);
  const netSalary = totalEarnings;
  const extraPay = moneyValue(row.extra_payment_amount);
  const balance = moneyValue(row.balance);
  const prevUnpaid = moneyValue(row.previous_unpaid_balance);
  const extraPayNotes = row.extra_payment_notes || '';
  const balePaid = moneyValue(row.bale_paid_amount);
  const salaryPaid = moneyValue(row.paid_amount);
  shell(`
    <section class="payslip-page">
      <div class="payroll-slip">
        <div class="slip-header">
          <div class="slip-logo">
            <div class="logo-mark">K</div>
            <div>
              <strong>KVSK</strong>
              <span>KVSK CCTV & IT SOLUTIONS</span>
            </div>
          </div>
          <h2>EMPLOYEE PAYROLL</h2>
        </div>

        <div class="company-box">
          <div>
            <strong>KVSK CCTV & IT SOLUTIONS</strong><br>
            353 Brgy. San Felix, Sto. Tomas City<br>
            Email Address: 
kvsk.cctv.itsolutions@gmail.com<br>
            Contact No. 0917 846 6710
          </div>
          <div class="date-line">
            <span>Date:</span>
            <strong>${formatSlipDate(addDays(state.week, 6))}</strong>
          </div>
        </div>

        <div class="slip-line">
          <div><strong>Employee:</strong> ${escapeHtml(row.name)}</div>
          <div><strong>Rate:</strong> ${peso.format(row.rate)}/day</div>
          <div><strong>Status:</strong> ${row.payment_status === 'paid' ? 'Paid' : row.payment_status === 'partial' ? 'Partial' : 'Unpaid'}</div>
        </div>

        <table class="slip-table">
          <thead>
            <tr>
              <th>Workday</th>
              <th>Attendance</th>
              <th>Earnings</th>
              <th>C/A (Bale)</th>
              <th>Notes</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            ${dayData.map(d => `
              <tr>
                <td>${workdayLabel(d.date)} - ${formatShortDate(d.date)}</td>
                <td class="num">${d.present ? '1.00' : '-'}</td>
                <td class="num">${d.earning ? peso.format(d.earning) : ''}</td>
                <td class="num">${d.bale ? peso.format(d.bale) : ''}</td>
                <td>${d.cashLog ? escapeHtml(d.cashLog.notes || 'C/A') : ''}</td>
                <td class="num">${d.earning ? peso.format(d.earning) : ''}</td>
              </tr>
            `).join('')}
            <tr class="slip-total-row">
              <td colspan="2" class="center"><strong>TOTALS</strong></td>
              <td class="num"><strong>${peso.format(totalEarnings)}</strong></td>
              <td class="num"><strong>${peso.format(totalBale)}</strong></td>
              <td></td>
              <td class="num"><strong>${peso.format(netSalary)}</strong></td>
            </tr>
          </tbody>
        </table>

        <table class="slip-table" style="border-top:0;">
          <tbody>
            ${totalBale > 0 ? `
            <tr>
              <td style="width:28%;" class="center">Cash Advance (Bale)</td>
              <td style="width:20%;" class="num">${peso.format(totalBale)}</td>
              <td style="width:32%;">This week C/A</td>
              <td style="width:20%;" class="num"></td>
            </tr>` : ''}
            ${prevUnpaid > 0 ? `
            <tr>
              <td class="center">Previous Unpaid</td>
              <td class="num">${peso.format(prevUnpaid)}</td>
              <td>From prior weeks</td>
              <td class="num">${peso.format(prevUnpaid)}</td>
            </tr>` : ''}
            ${extraPay > 0 ? `
            <tr>
              <td class="center">Extra Payment</td>
              <td class="num">${peso.format(extraPay)}</td>
              <td>${escapeHtml(extraPayNotes || 'Extra pay')}</td>
              <td class="num">+${peso.format(extraPay)}</td>
            </tr>` : ''}
            ${balePaid > 0 ? `
            <tr>
              <td class="center">Bale Payment</td>
              <td class="num" style="color:#166534;">-${peso.format(balePaid)}</td>
              <td>Bale repaid this week</td>
              <td class="num" style="color:#166534;">-${peso.format(balePaid)}</td>
            </tr>` : ''}
            ${salaryPaid > 0 ? `
            <tr>
              <td class="center">Salary Payment</td>
              <td class="num" style="color:#166534;">-${peso.format(salaryPaid)}</td>
              <td>Cash received this week</td>
              <td class="num" style="color:#166534;">-${peso.format(salaryPaid)}</td>
            </tr>` : ''}
            <tr class="slip-total-row">
              <td colspan="2" class="center"><strong>BALANCE DUE</strong></td>
              <td></td>
              <td class="num"><strong>${peso.format(balance)}</strong></td>
            </tr>
            <tr>
              <td colspan="4">Amount in Words: <strong>${amountInWords(balance)}</strong></td>
            </tr>
          </tbody>
        </table>

        <div class="slip-summary-footer">
          <div><strong>Bale Balance:</strong> ${peso.format(row.remaining_bale_balance)}</div>
          <div><strong>Period:</strong> ${formatSlipDate(state.week)} - ${formatSlipDate(addDays(state.week, 6))}</div>
        </div>

        <div class="slip-signatures">
          <div>
            <strong>Prepared by:</strong>
            <div class="signature-name">KVSK</div>
            <span>Business Owner</span>
          </div>
          <div>
            <strong>Remarks:</strong>
            <div class="remarks-line"></div>
          </div>
        </div>

        <div class="acceptance">
          <div>EMPLOYEE'S ACCEPTANCE</div>
          <div class="signature-grid">
            <span>Authorized Signatory:<br><em>(Signature over Printed Name)</em></span>
            <span><br><em>(Designation)</em></span>
            <span><br><em>(Date)</em></span>
          </div>
        </div>
      </div>
      <div class="actions no-print" style="margin-top:16px; justify-content:center;">
        <button class="ghost" id="backPayroll">Back</button>
        <button class="primary" onclick="window.print()">🖨 Print</button>
        <button class="primary" id="downloadPdfBtn">⬇ Download PDF</button>
      </div>
    </section>
  `);
  document.querySelector('#backPayroll').addEventListener('click', refresh);
  document.querySelector('#downloadPdfBtn')?.addEventListener('click', async () => {
    const btn = document.querySelector('#downloadPdfBtn');
    btn.textContent = '⏳ Generating...';
    btn.disabled = true;
    try {
      const { jsPDF } = window.jspdf;
      const el = document.querySelector('.payroll-slip');
      const canvas = await html2canvas(el, { scale: 2, useCORS: true });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
      pdf.save(`Payslip_${row.emp_number}_${state.week}.pdf`);
    } catch (err) {
      showToast('PDF generation failed. Try Print instead.');
    }
    btn.textContent = '⬇ Download PDF';
    btn.disabled = false;
  });
}
