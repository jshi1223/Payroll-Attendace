/* ── Helpers ── */
function titleForView() {
  const pd = state.payPeriodDays || 7;
  return {
    dashboard: 'Dashboard',
    payroll: pd === 7 ? 'Weekly Payroll' : pd === 14 ? 'Semi-monthly Payroll' : `${pd}-Day Payroll`,
    attendance: 'Attendance Logs',
    employees: 'Employee Module',
    archive: 'Archive'
  }[state.view];
}

function weekToolbar(className = '') {
  const pd = state.payPeriodDays || 7;
  const periodStart = state.week;
  const isLocked = state.payroll?.isPeriodLocked;
  const nextLabel = (pd > 7 && isLocked) ? 'Next Period' : (pd > 7 ? 'Next Week' : 'Next →');
  const prevLabel = (pd > 7 && isLocked) ? 'Previous Period' : (pd > 7 ? 'Previous Week' : '← Previous');
  return `
    <div class="toolbar module-toolbar no-print${className ? ' ' + className : ''}">
      <label>Week Start<input type="date" id="weekInput" value="${periodStart}"></label>
      <label>Pay Period
        <select id="payPeriodSelect">
          <option value="7" ${pd === 7 ? 'selected' : ''}>Weekly (7 days)</option>
          <option value="14" ${pd === 14 ? 'selected' : ''}>Semi-monthly (14 days)</option>
          <option value="21" ${pd === 21 ? 'selected' : ''}>3 Weeks (21 days)</option>
          <option value="30" ${pd === 30 ? 'selected' : ''}>Monthly (30 days)</option>
          <option value="custom" ${![7,14,21,30].includes(pd) ? 'selected' : ''}>Custom...</option>
        </select>
      </label>
      <div id="customPeriodWrap" style="display:${[7,14,21,30].includes(pd) ? 'none' : 'inline-block'};">
        <label>Days<input type="number" id="customPeriodDays" min="1" value="${pd}" style="width:70px;"></label>
      </div>
      <label>Search<input id="searchInput" value="${state.searchPayroll}" placeholder="Type employee name or ID..."></label>
      <button class="ghost" id="prevPeriod">← ${prevLabel}</button>
      <button class="ghost" id="nextPeriod">${nextLabel} →</button>
    </div>
  `;
}

function bindWeekToolbar() {
  const pd = state.payPeriodDays || 7;
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
  document.querySelector('#payPeriodSelect')?.addEventListener('change', async event => {
    const val = event.target.value;
    if (val === 'custom') {
      document.querySelector('#customPeriodWrap').style.display = 'inline-block';
      const customInput = document.querySelector('#customPeriodDays');
      state.payPeriodDays = Math.max(1, Number(customInput?.value) || 7);
    } else {
      document.querySelector('#customPeriodWrap').style.display = 'none';
      state.payPeriodDays = Number(val);
    }
    /* Keep current week start — don't realign to period anchor */
    state.week = payrollWeekStartOf(state.week);
    state.payrollWeek = state.week;
    saveUiState();
    await refresh();
  });
  document.querySelector('#customPeriodDays')?.addEventListener('change', async event => {
    state.payPeriodDays = Math.max(1, Number(event.target.value) || 7);
    /* Keep current week start — don't realign to period anchor */
    state.week = payrollWeekStartOf(state.week);
    state.payrollWeek = state.week;
    saveUiState();
    await refresh();
  });
  document.querySelector('#prevPeriod')?.addEventListener('click', async () => {
    const step = (pd > 7 && state.payroll?.isPeriodLocked) ? pd : 7;
    state.week = addDays(state.week, -step);
    state.payrollWeek = state.week;
    saveUiState();
    await refresh();
  });
  document.querySelector('#nextPeriod')?.addEventListener('click', async () => {
    const step = (pd > 7 && state.payroll?.isPeriodLocked) ? pd : 7;
    state.week = addDays(state.week, step);
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
          <p>Mag-login para pamahalaan ang empleyado, attendance, at sahod</p>
        </div>
        <div class="form-grid">
          <label>Username<input name="username" id="loginUsername" autocomplete="username" value="${escapeHtml(savedUsername)}" required></label>
          <label>Password<div class="password-wrapper"><input name="password" id="loginPassword" type="password" autocomplete="current-password" required><button class="password-toggle" type="button" data-password-toggle aria-label="Show password" aria-pressed="false">${passwordToggleIcon()}</button></div><div class="caps-warning" id="capsWarning">Caps Lock is ON</div></label>
          <label class="checkbox-row"><input type="checkbox" id="rememberMe" ${savedUsername ? 'checked' : ''}> Remember username</label>
          <button class="primary" type="submit" id="loginBtn">Sign In</button>
          <div class="error">${error}</div>
        </div>
        <div class="login-footer">
          <span class="badge role-admin">Admin</span>
          <span class="badge role-hr">HR Staff</span>
        </div>
      </form>
    </section>
  `;

  const usernameInput = document.querySelector('#loginUsername');
  const passwordInput = document.querySelector('#loginPassword');
  const capsWarning = document.querySelector('#capsWarning');

  bindPasswordToggles();

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
        <span class="card-icon">E</span>
        <span>Aktibong Empleyado</span>
        <strong>${empCount}</strong>
      </div>
      <div class="summary-card" style="border-left-color: #b45309;">
        <span class="card-icon">P</span>
        <span>Pumasok Ngayon</span>
        <strong>${attendanceToday}</strong>
        <span class="card-sub">${state.currentDate}</span>
      </div>
      <div class="summary-card" style="border-left-color: #075985;">
        <span class="card-icon">S</span>
        <span>Sahod Ngayong Linggo</span>
        <strong>${summary ? formatMoney(summary.totalSalary) : '₱0.00'}</strong>
      </div>
      <div class="summary-card" style="border-left-color: #166534;">
        <span class="card-icon">P</span>
        <span>Natanggap na Sahod</span>
        <strong>${summary ? formatMoney(summary.totalPaidAmount) : '₱0.00'}</strong>
      </div>
      <div class="summary-card" style="border-left-color: #c2410c;">
        <span class="card-icon">B</span>
        <span>Natitira pang Balance</span>
        <strong>${summary ? formatMoney(summary.totalBalance) : '₱0.00'}</strong>
      </div>
      <div class="summary-card" style="border-left-color: #92400e;">
        <span class="card-icon">B</span>
        <span>BALENSA (utang)</span>
        <strong>${summary ? formatMoney(summary.totalBaleBalance) : '₱0.00'}</strong>
      </div>
    </section>
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Quick Actions</h2>
          <p>${state.currentDate} | Week: ${payroll ? payroll.weekStart : state.week}</p>
        </div>
        <span class="badge role-${state.user.role}">${isAdmin ? 'Admin' : 'HR'}</span>
      </div>
      <div class="quick-actions">
        <div class="quick-action-card" data-quick-view="payroll">
          <span class="qa-icon">$</span>
          <strong>Payroll</strong>
          <span>View and manage payroll, payments, and payslips.</span>
          <button class="primary">Go to Payroll</button>
        </div>
        <div class="quick-action-card" data-quick-view="attendance">
          <span class="qa-icon">A</span>
          <strong>Attendance</strong>
          <span>Record daily employee attendance logs.</span>
          <button class="ghost">Take Attendance</button>
        </div>
        <div class="quick-action-card" data-quick-view="employees">
          <span class="qa-icon">E</span>
          <strong>Employees</strong>
          <span>${isAdmin ? 'Add, edit, or archive employee profiles.' : 'Add and edit employee profiles.'}</span>
          <button class="ghost">Manage Employees</button>
        </div>
        <div class="quick-action-card" data-quick-view="archive">
          <span class="qa-icon">A</span>
          <strong>Archive</strong>
          <span>${isAdmin ? 'View archived employees, restore, or permanently delete.' : 'View archived employees (read-only).'}</span>
          <button class="ghost">${isAdmin ? 'Go to Archive' : 'View Archive'}</button>
        </div>
        ${isAdmin ? `
        <div class="quick-action-card" onclick="state.showAudit=true;refresh()">
          <span class="qa-icon">L</span>
          <strong>Audit Trail</strong>
          <span>View all system actions and changes (Admin only).</span>
          <button class="ghost">Open Audit Trail</button>
        </div>` : `
        <div class="quick-action-card" style="opacity:0.6;cursor:default;">
          <span class="qa-icon">L</span>
          <strong>Audit Trail</strong>
          <span>Admin-only feature. Request access from admin.</span>
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
  const generatedCount = state.payroll.rows.filter(row => row.payroll_status === 'generated').length;
  const totalCount = state.payroll.rows.length;
  const canBulkPrint = totalCount > 0 && generatedCount === totalCount;
  const pg = paginateRows(allRows, state.pages.payroll || 1);
  shell(`
    ${weekToolbar()}
    <section class="summary">
      <div class="summary-card" style="border-left-color:#0f766e;">
        <span class="card-icon">E</span>
        <span>Empleyado</span>
        <strong>${displaySummary.employees}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#2563eb;">
        <span class="card-icon">D</span>
        <span>Araw ng Pasok</span>
        <strong>${displaySummary.workingDays}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#166534;">
        <span class="card-icon">P</span>
        <span>Natanggap na Sahod</span>
        <strong>${formatMoney(displaySummary.totalPaidAmount)}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#075985;">
        <span class="card-icon">B</span>
        <span>NATITIRA (sa sahod)</span>
        <strong>${formatMoney(displaySummary.totalBalance)}</strong>
        <span class="card-sub">Natitira pang sahod pagkatapos ng mga bayad</span>
      </div>
      <div class="summary-card" style="border-left-color:#92400e;">
        <span class="card-icon">B</span>
        <span>BALENSA (utang)</span>
        <strong>${formatMoney(displaySummary.totalBaleBalance)}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#c2410c;">
        <span class="card-icon">U</span>
        <span>Natitira (Dati)</span>
        <strong>${formatMoney(displaySummary.totalPreviousUnpaid)}</strong>
      </div>
    </section>
    <section class="panel payroll-records-panel">
      <div class="panel-header">
        <div>
          <h2>Payroll Records</h2>
          <p>Payroll records, payments, and payslip actions.</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="ghost no-print" id="bulkPrintBtn" ${canBulkPrint ? '' : 'disabled'} title="${canBulkPrint ? 'Print all generated payslips' : `Generate every payslip before using Bulk Print (${generatedCount}/${totalCount} generated)`}">${canBulkPrint ? 'Bulk Print Payslips' : `Bulk Print (${generatedCount}/${totalCount})`}</button>
          <button class="ghost no-print" id="exportCSVBtn">Export CSV</button>
          ${state.user.role === 'admin' ? `<button class="ghost no-print" id="openAuditTrail">Audit Trail</button>` : ''}
        </div>
      </div>
      <div class="table-wrap">
        <table class="payroll-table">
          <thead><tr><th title="Unique employee identification number">Numero</th><th title="Full name of employee">Pangalan</th><th title="Daily rate in Philippine Pesos">Arawan</th><th title="Number of days worked this week">Araw</th><th title="Gross salary for this week (Days × Rate)">Sahod</th><th title="Unpaid salary balance carried over from previous weeks">Natitira</th><th title="Bale/cash advance balance carried over from previous weeks">Utang Dati</th><th title="Cash advance (bale) taken this week">Bale</th><th title="Extra payments or bonuses added this week">Dagdag</th><th title="Total bale/cash advance balance including previous">Kab. Utang</th><th title="Amount of salary paid this week">Natanggap</th><th class="col-balance-header" title="Remaining unpaid salary balance after payments">NATITIRA</th><th class="col-bale-header" title="Remaining bale/cash advance balance to repay">BALENSA</th><th title="Payment status: Paid, Partial, or Unpaid">Katayuan</th><th title="Actions available for this employee">Aksyon</th></tr></thead>
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
              <td><span class="badge ${row.payroll_status === 'generated' ? 'generated' : row.payment_status} status-badge">${row.payroll_status === 'generated' ? 'Generated' : row.payment_status === 'paid' ? 'Paid' : row.payment_status === 'partial' ? 'Partial' : 'Unpaid'}</span></td>
              <td class="actions">${row.payroll_status === 'generated'
                ? `<span class="badge badge-locked">Locked</span><button class="ghost" data-unlock-payroll="${row.employee_id}">Unlock</button>`
                : `<button class="ghost" data-manage-employee="${row.employee_id}">Manage</button>`}</td>
              </tr>
            `;
            }).join('') || `<tr><td colspan="15" class="empty-state"><span class="empty-icon">--</span><strong>No Payroll Data</strong><span>No records found for this week. Try changing the week or add attendance records first.</span></td></tr>`}
          </tbody>
        </table>
      </div>
      ${paginationHTML(pg, 'payroll')}
    </section>
    ${state.payrollModalEmployee ? payrollEntryModal(state.payrollModalEmployee) : ''}
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
  document.querySelector('#bulkPrintBtn')?.addEventListener('click', () => openBulkPayslipPrint(state.payroll.rows));
  bindPagination('payroll', refresh);
  bindWeekToolbar();
  document.querySelector('#openAuditTrail')?.addEventListener('click', () => {
    state.showAudit = true;
    renderPayroll();
  });
  document.querySelectorAll('[data-manage-employee]').forEach(button => {
    button.addEventListener('click', () => {
      state.payrollModalTab = 'pay';
      state.payrollTransactionModal = false;
      state.payrollModalEmployee = allRows.find(row => String(row.employee_id) === button.dataset.manageEmployee);
      renderPayroll();
    });
  });
  document.querySelectorAll('[data-unlock-payroll]').forEach(button => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/payroll/${button.dataset.unlockPayroll}/unlock`, {
          method: 'POST',
          body: JSON.stringify({ weekStart: state.week })
        });
        showToast('Payroll unlocked. You can manage transactions again.');
        await partialRefresh(['payroll', 'attendance', 'salaryPayments', 'advances', 'balePayments', 'extraPayments']);
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
  });
  bindPayrollEntryModal();
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
      <label>Search<input id="searchInput" value="${state.searchAttendance}" placeholder="Type employee name or ID..."></label>
      <button class="ghost" id="prevDay">Previous Day</button>
      <button class="ghost" id="nextDay">Next Day</button>
    </div>
    <section class="summary">
      <div class="summary-card" style="border-left-color:#0f766e;">
        <span class="card-icon">P</span>
        <span>Present Today</span>
        <strong>${dayRows.length}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#2563eb;">
        <span class="card-icon">D</span>
        <span>Date</span>
        <strong>${state.attendanceDate}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#b45309;">
        <span class="card-icon">#</span>
        <span>Workday No.</span>
        <strong>${payrollWorkdayNumber(state.attendanceDate)}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#075985;">
        <span class="card-icon">W</span>
        <span>Payroll Week</span>
        <strong>${state.week}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#92400e;">
        <span class="card-icon">E</span>
        <span>Week Ends</span>
        <strong>${addDays(state.week, 6)}</strong>
      </div>
    </section>
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>Daily Attendance</h2>
          <p>Record employees who attended for the selected date.</p>
        </div>
        <span class="badge" style="background:#eff6ff;color:#075985;">${dayRows.length} Present Today</span>
      </div>
      <form class="inline-form" id="attendanceForm">
        <label>Employee
          ${searchableSelectHTML('employee_id',
            availableEmployees.map(e => ({ value: e.id, label: `${e.emp_number} - ${e.name}` })),
            'Type to search employee...'
          )}
        </label>
        <label>Notes<input name="notes" placeholder="e.g. Present, Late 30min, OT 2hrs"></label>
        <button class="primary" ${availableEmployees.length ? '' : 'disabled'}>Add Attendance</button>
      </form>
      <div class="table-wrap">
        <table class="attendance-table">
          <thead>
            <tr>
              <th title="Date of attendance">Date</th>
              <th title="Unique employee identification number">Emp Number</th>
              <th title="Full name of employee">Name</th>
              <th title="Attendance status — always Present if recorded">Status</th>
              <th title="Daily rate at time of attendance">Rate</th>
              <th title="Payroll period start and end for this employee">Payroll Period</th>
              <th title="Optional notes about attendance (e.g., Late, OT)">Notes</th>
              <th title="Delete this attendance record">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${pg.rows.map(row => {
              const pd = row.pay_period_days || 7;
              const pStart = periodStartOf(row.work_date, pd);
              const pEnd = periodEndOf(row.work_date, pd);
              const isLocked = row.locked;
              return `
              <tr class="${isLocked ? 'row-locked' : ''}">
                <td>${row.work_date}</td>
                <td>${highlight(row.emp_number)}</td>
                <td>${highlight(row.name)}</td>
                <td><span class="badge paid">Present</span></td>
                <td>${peso.format(row.rate_snapshot)}</td>
                <td><span class="period-range">${formatShortDate(pStart)} – ${formatShortDate(pEnd)}</span>${isLocked ? ' <span class="badge badge-locked" title="Payroll generated for this period">Locked</span>' : ''}</td>
                <td>${row.notes ? escapeHtml(row.notes) : '<span class="muted">—</span>'}</td>
                <td class="actions">${isLocked ? '<span class="muted" title="Cannot delete — payroll is locked" style="font-size:12px;">🔒 Locked</span>' : deleteButton('attendance', row.id)}</td>
              </tr>`;
            }).join('') || `<tr><td colspan="8" class="empty-state"><span class="empty-icon">--</span><strong>No Attendance Records</strong><span>Select an employee from the dropdown above and click "Add Attendance" to record their attendance for this date.</span></td></tr>`}
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
    state.payrollWeek = state.week;
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
    state.payrollWeek = state.week;
    saveUiState();
    await refresh();
  });
  document.querySelector('#nextDay').addEventListener('click', async () => {
    state.attendanceDate = addDays(state.attendanceDate, 1);
    state.week = weekStartOf(state.attendanceDate);
    state.payrollWeek = state.week;
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
      state.week = weekStartOf(state.attendanceDate);
      state.payrollWeek = state.week;
      await partialRefresh(['attendance', 'payroll']);
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
      <label>Search<input id="employeeSearch" value="${state.searchEmployees}" placeholder="Pangalan, ID, SSS, PhilHealth, Pag-IBIG, TIN..."></label>
      <button class="primary" id="openEmployeeModal">Add Employee</button>
    </section>
    <section class="summary">
      <div class="summary-card" style="border-left-color:#0f766e;">
        <span class="card-icon">E</span>
        <span>Total Active</span>
        <strong>${activeCount}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#92400e;">
        <span class="card-icon">A</span>
        <span>Archived</span>
        <strong>${inactiveCount}</strong>
      </div>
      <div class="summary-card" style="border-left-color:#075985;">
        <span class="card-icon">R</span>
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
        <span class="badge" style="background:#dcfce7;color:#166534;">${activeCount} Active</span>
        ${inactiveCount > 0 ? `<span class="badge unpaid">${inactiveCount} Archived</span>` : ''}
      </div>
      <div class="table-wrap">
        <table class="employee-table">
          <thead><tr><th title="Employee profile photo">Avatar</th><th title="Unique employee identification number">Emp Number</th><th title="Full name of employee">Name</th><th title="Contact phone number (11 digits)">Phone</th><th title="SSS number: XX-XXXXXXX-X">SSS</th><th title="PhilHealth number: XX-XXXXXXXXX-X">PhilHealth</th><th title="Pag-IBIG number: XXXX-XXXX-XXXX">Pag-IBIG</th><th title="TIN number: XXX-XXX-XXX-XXX">TIN</th><th title="Daily rate in Philippine Pesos">Rate</th><th title="Whether employee is Active or Inactive (archived)">Status</th><th title="Edit employee profile or archive this employee">Actions</th></tr></thead>
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
                <td>${escapeHtml(row.sss_number || '-')}</td>
                <td>${escapeHtml(row.philhealth_number || '-')}</td>
                <td>${escapeHtml(row.pagibig_number || '-')}</td>
                <td>${escapeHtml(row.tin_number || '-')}</td>
                <td><strong>${peso.format(row.rate)}</strong>/day</td>
                <td><span class="badge ${row.active !== false ? 'paid' : 'unpaid'}" style="font-size:11px;">${row.active !== false ? 'Active' : 'Inactive'}</span></td>
                <td class="actions">
                  <button class="ghost" data-edit-employee="${row.id}">Edit</button>
                  ${deleteButton('employees', row.id)}
                </td>
              </tr>
            `            }).join('') || `<tr><td colspan="11" class="empty-state"><span class="empty-icon">--</span><strong>No Employees Yet</strong><span>Click the "Add Employee" button above to create your first employee record.</span></td></tr>`}
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
      <label>Search<input id="archiveSearch" value="${state.searchEmployees}" placeholder="Pangalan, ID, SSS, PhilHealth, Pag-IBIG, TIN..."></label>
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
          <thead><tr><th title="Unique employee identification number">Emp Number</th><th title="Full name of employee">Name</th><th title="Contact phone number">Phone</th><th title="SSS number: XX-XXXXXXX-X">SSS</th><th title="PhilHealth number: XX-XXXXXXXXX-X">PhilHealth</th><th title="Pag-IBIG number: XXXX-XXXX-XXXX">Pag-IBIG</th><th title="TIN number: XXX-XXX-XXX-XXX">TIN</th><th title="Previous daily rate when active">Rate</th><th title="Most recent week with payroll data">Last Payroll</th><th title="Total amount ever paid to this employee">Total Paid</th><th title="Total unpaid salary balance">Balance</th><th title="Restore, view payslip, or permanently delete">Actions</th></tr></thead>
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
                <td>${escapeHtml(row.sss_number || '-')}</td>
                <td>${escapeHtml(row.philhealth_number || '-')}</td>
                <td>${escapeHtml(row.pagibig_number || '-')}</td>
                <td>${escapeHtml(row.tin_number || '-')}</td>
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
            }).join('') || `<tr><td colspan="12" class="empty-state"><span class="empty-icon">--</span><strong>No Archived Employees</strong><span>Inactive employees appear here after you archive them from the Employees section. No employees have been archived yet.</span></td></tr>`}
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
        await partialRefresh(['employees', 'payroll']);
        reRenderCurrentView();
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
      reRenderCurrentView();
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
          <thead><tr><th title="Date the cash advance was taken">Date</th><th title="Unique employee identification number">Emp Number</th><th title="Full name of employee">Name</th><th title="Amount of cash advance in Pesos">Amount</th><th title="Reason or remarks for the cash advance">Notes</th><th title="Edit or delete this cash advance">Actions</th></tr></thead>
          <tbody>
            ${pg.rows.map(row => `
              <tr class="${row.locked ? 'row-locked' : ''}">
                <td>${row.advance_date.slice(0, 10)}</td><td>${highlight(row.emp_number)}</td><td>${highlight(row.name)}</td>
                <td>${peso.format(row.amount)}</td><td>${escapeHtml(row.notes || '-')}</td>
                <td class="actions">${row.locked
                  ? '<span class="muted" title="Cannot edit — payroll is locked" style="font-size:12px;">🔒 Locked</span>'
                  : `<button class="ghost" data-edit-cash="${row.id}">Edit</button> ${deleteButton('cash-advances', row.id)}`}</td>
              </tr>
            `).join('') || `<tr><td colspan="6" class="empty-state"><span class="empty-icon">--</span><strong>No Cash Advances</strong><span>No cash advances recorded this week. Select an employee and fill out the form above to add a C/A.</span></td></tr>`}
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
    await partialRefresh(['payroll', 'advances']);
    reRenderCurrentView();
  });
}

/* ── Payslip ── */
function openBulkPayslipPrint(rows) {
  if (!rows.length) {
    showToast('No payroll records available to print.', 'info');
    return;
  }

  const slips = rows.map(row => {
    const pd = state.payPeriodDays || row.pay_period_days || 7;
    const periodLabel = getPeriodLabel(pd);
    const periodStart = periodStartOf(state.week, pd);
    const periodEnd = addDays(periodStart, pd - 1);
    const attendanceDates = new Set(state.attendance.rows
      .filter(log => Number(log.employee_id) === Number(row.employee_id))
      .map(log => log.work_date));
    const cashByDate = state.advances.rows
      .filter(log => Number(log.employee_id) === Number(row.employee_id))
      .reduce((logs, log) => ({ ...logs, [log.advance_date]: log }), {});
    const days = Array.from({ length: pd }, (_, index) => {
      const date = addDays(periodStart, index);
      const cash = cashByDate[date];
      const present = attendanceDates.has(date);
      const earning = present ? Number(row.rate) : 0;
      const bale = cash ? Number(cash.amount) : 0;
      return `<tr><td>${workdayLabel(date)} - ${formatShortDate(date)}</td><td class="num">${present ? '1.00' : '-'}</td><td class="num">${earning ? peso.format(earning) : ''}</td><td class="num">${bale ? peso.format(bale) : ''}</td><td class="num">${earning ? peso.format(earning) : ''}</td></tr>`;
    }).join('');
    const extraPay = moneyValue(row.extra_payment_amount);
    const balance = moneyValue(row.balance);
    const prevUnpaid = moneyValue(row.previous_unpaid_balance);
    const extraPayNotes = row.extra_payment_notes || '';
    const balePaid = moneyValue(row.bale_paid_amount);
    const salaryPaid = moneyValue(row.paid_amount);
    const totalEarnings = row.salary || 0;
    const totalBale = row.total_bale || 0;
    return `
      <article class="bulk-payslip">
        <div class="payroll-slip">
          <div class="slip-header">
            <div class="slip-logo">
              <div class="logo-mark">K</div>
              <div>
                <strong>KVSK</strong>
                <span>KVSK CCTV & IT SOLUTIONS</span>
              </div>
            </div>
            <h2>PAYSLIP NG EMPLEYADO — ${periodLabel.toUpperCase()}</h2>
          </div>

          <div class="company-box">
            <div>
              <strong>KVSK CCTV & IT SOLUTIONS</strong><br>
              195 B. Laurena Poblacion, President Jose P. Laurel Hwy, Tanauan City<br>
              Email Address: kvsk.cctv.itsolutions@gmail.com<br>
              Contact No. 0917 846 6710
            </div>
            <div class="date-line">
              <span>Panahon:</span>
              <strong>${formatSlipDate(periodStart)} – ${formatSlipDate(periodEnd)}</strong>
            </div>
          </div>

          <div class="slip-line">
            <div><strong>Empleyado:</strong> ${escapeHtml(row.name)}</div>
            <div><strong>Arawan:</strong> ${peso.format(row.rate)}/araw</div>
            <div><strong>Katayuan:</strong> ${row.payroll_status === 'generated' ? 'Naka-lock' : row.payment_status === 'paid' ? 'Bayad' : row.payment_status === 'partial' ? 'Partial' : 'Hindi Bayad'}</div>
          </div>

          <table class="slip-table">
            <thead>
              <tr>
                <th>Araw</th>
                <th>Pumasok</th>
                <th>Kita</th>
                <th>Bale (Utang)</th>
                <th>Kabuuan</th>
              </tr>
            </thead>
            <tbody>
              ${days}
              <tr class="slip-total-row">
                <td colspan="2" class="center"><strong>KABUUAN</strong></td>
                <td class="num"><strong>${formatMoney(totalEarnings)}</strong></td>
                <td class="num"><strong>${formatMoney(totalBale)}</strong></td>
                <td class="num"><strong>${formatMoney(totalEarnings)}</strong></td>
              </tr>
            </tbody>
          </table>

          <table class="slip-table" style="border-top:0;">
            <tbody>
              ${totalBale > 0 ? `
              <tr>
                <td style="width:28%;" class="center">Cash Advance (Bale)</td>
                <td style="width:20%;" class="num">${formatMoney(totalBale)}</td>
                <td style="width:32%;">Bale Ngayon</td>
                <td style="width:20%;" class="num"></td>
              </tr>` : ''}
              ${prevUnpaid > 0 ? `
              <tr>
                <td class="center">Natitira (Dati)</td>
                <td class="num">${formatMoney(prevUnpaid)}</td>
                <td>Galing sa nakaraan</td>
                <td class="num">${formatMoney(prevUnpaid)}</td>
              </tr>` : ''}
              ${extraPay > 0 ? `
              <tr>
                <td class="center">Dagdag Sahod</td>
                <td class="num">${formatMoney(extraPay)}</td>
                <td>${escapeHtml(extraPayNotes || 'Bonus/Dagdag')}</td>
                <td class="num">+${formatMoney(extraPay)}</td>
              </tr>` : ''}
              ${balePaid > 0 ? `
              <tr>
                <td class="center">Bayad Bale</td>
                <td class="num" style="color:#166534;">-${formatMoney(balePaid)}</td>
                <td>Bayad sa utang ngayon</td>
                <td class="num" style="color:#166534;">-${formatMoney(balePaid)}</td>
              </tr>` : ''}
              ${salaryPaid > 0 ? `
              <tr>
                <td class="center">Sahod na Natanggap</td>
                <td class="num" style="color:#166534;">-${formatMoney(salaryPaid)}</td>
                <td>Natanggap na sahod ngayon</td>
                <td class="num" style="color:#166534;">-${formatMoney(salaryPaid)}</td>
              </tr>` : ''}
              <tr class="slip-total-row">
                <td colspan="2" class="center"><strong>NATITIRA PANG SAHOD</strong></td>
                <td></td>
                <td class="num"><strong>${formatMoney(balance)}</strong></td>
              </tr>
              <tr>
                <td colspan="4">Halaga sa Salita: <strong>${amountInWords(balance)}</strong></td>
              </tr>
            </tbody>
          </table>

          <div class="slip-summary-footer">
            <div><strong>BALENSA (Utang):</strong> ${formatMoney(row.remaining_bale_balance)}</div>
            <div><strong>Panahon:</strong> ${formatSlipDate(periodStart)} - ${formatSlipDate(periodEnd)}</div>
          </div>

          <div class="slip-signatures">
            <div>
              <strong>Inihanda ni:</strong>
              <div class="signature-name">KVSK</div>
              <span>May-ari</span>
            </div>
            <div></div>
          </div>

          <div class="acceptance">
            <div>PAGKILALA NG EMPLEYADO</div>
            <div class="signature-grid">
              <span>Pumirma:<br><em>(Lagda sa Itaas ng Pangalan)</em></span>
              <span><br><em>(Posisyon)</em></span>
              <span><br><em>(Petsa)</em></span>
            </div>
          </div>
        </div>
      </article>`;
  }).join('');

  const printWindow = window.open('', '_blank', 'width=900,height=700');
  if (!printWindow) {
    showToast('Please allow pop-ups to use Bulk Print.', 'error');
    return;
  }
  printWindow.document.write(`<!doctype html><html><head><title>Payslip ${state.week}</title><style>
    * { box-sizing: border-box; } body { margin: 0; color: #172033; font: 12px Arial, sans-serif; }
    .bulk-payslip { min-height: 260mm; page-break-after: always; }
    .bulk-payslip:last-child { page-break-after: auto; }
    .payroll-slip { width: 190mm; min-height: 135mm; margin: 0 auto; padding: 6mm 8mm; }
    .slip-header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; border-bottom: 2px solid #c62828; margin-bottom: 14px; }
    .slip-logo { display: flex; align-items: center; gap: 10px; }
    .logo-mark { width: 36px; height: 36px; background: #c62828; color: #fff; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 800; }
    .slip-logo strong { display: block; color: #c62828; font-size: 18px; }
    .slip-logo span { color: #64748b; font-size: 10px; }
    h2 { margin: 0; font-size: 15px; color: #172033; }
    .company-box { display: flex; justify-content: space-between; align-items: flex-start; padding: 10px 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; margin-bottom: 10px; font-size: 11px; line-height: 1.6; color: #374151; }
    .date-line { text-align: right; white-space: nowrap; }
    .date-line span { display: block; font-size: 10px; color: #64748b; }
    .slip-line { display: flex; flex-wrap: wrap; gap: 10px 24px; padding: 8px 0; font-size: 12px; margin-bottom: 10px; }
    .slip-table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
    .slip-table th, .slip-table td { border: 1px solid #cbd5e1; padding: 5px 7px; text-align: left; font-size: 11px; }
    .slip-table th { background: #f1f5f9; text-transform: uppercase; font-size: 10px; }
    .slip-table td.num { text-align: right; font-family: 'Courier New', monospace; }
    .slip-table td.center { text-align: center; }
    .slip-total-row td { font-weight: 700; background: #f8fafc; }
    .slip-summary-footer { display: flex; justify-content: space-between; padding: 8px 0; font-size: 11px; border-top: 1px dashed #cbd5e1; margin-top: 10px; }
    .slip-signatures { display: flex; gap: 40px; margin-top: 16px; padding-top: 10px; border-top: 1px solid #e2e8f0; }
    .slip-signatures > div { flex: 1; font-size: 11px; }
    .slip-signatures strong { display: block; margin-bottom: 4px; }
    .signature-name { width: 140px; border-bottom: 1px solid #172033; margin: 8px 0 4px; height: 24px; }
    .acceptance { margin-top: 16px; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 11px; }
    .acceptance > div:first-child { font-weight: 700; text-transform: uppercase; font-size: 11px; margin-bottom: 6px; }
    .signature-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; font-size: 10px; }
    .signature-grid em { color: #64748b; }
    @page { size: A4; margin: 0; }
    @media print { .bulk-payslip { page-break-after: always; } }
  </style></head><body>${slips}</body></html>`);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => printWindow.print(), 300);
}

function renderPayslip(row, { preview = false } = {}) {
  const pd = state.payPeriodDays || row.pay_period_days || 7;
  const periodLabel = getPeriodLabel(pd);
  const periodStart = periodStartOf(state.week, pd);
  const weekDates = Array.from({ length: pd }, (_, index) => addDays(periodStart, index));
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
          <h2>PAYSLIP NG EMPLEYADO — ${periodLabel.toUpperCase()}</h2>
        </div>

        <div class="company-box">
          <div>
            <strong>KVSK CCTV & IT SOLUTIONS</strong><br>
            195 B. Laurena Poblacion, President Jose P. Laurel Hwy, Tanauan City<br>
            Email Address: 
kvsk.cctv.itsolutions@gmail.com<br>
            Contact No. 0917 846 6710
          </div>
          <div class="date-line">
            <span>Panahon:</span>
            <strong>${formatSlipDate(periodStart)} – ${formatSlipDate(addDays(periodStart, pd - 1))}</strong>
          </div>
        </div>

        <div class="slip-line">
          <div><strong>Empleyado:</strong> ${escapeHtml(row.name)}</div>
          <div><strong>Arawan:</strong> ${peso.format(row.rate)}/araw</div>
          <div>            <strong>Katayuan:</strong> ${row.payroll_status === 'generated' ? 'Naka-lock' : row.payment_status === 'paid' ? 'Bayad' : row.payment_status === 'partial' ? 'Partial' : 'Hindi Bayad'}</div>
        </div>

        <table class="slip-table">
          <thead>
            <tr>
              <th>Araw</th>
              <th>Pumasok</th>
              <th>Kita</th>
              <th>Bale (Utang)</th>
              <th>Kabuuan</th>
            </tr>
          </thead>
          <tbody>
            ${dayData.map(d => `
              <tr>
                <td>${workdayLabel(d.date)} - ${formatShortDate(d.date)}</td>
                <td class="num">${d.present ? '1.00' : '-'}</td>
                <td class="num">${d.earning ? peso.format(d.earning) : ''}</td>
                <td class="num">${d.bale ? peso.format(d.bale) : ''}</td>
                <td class="num">${d.earning ? peso.format(d.earning) : ''}</td>
              </tr>
            `).join('')}
            <tr class="slip-total-row">
              <td colspan="2" class="center"><strong>KABUUAN</strong></td>
              <td class="num"><strong>${peso.format(totalEarnings)}</strong></td>
              <td class="num"><strong>${peso.format(totalBale)}</strong></td>
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
              <td style="width:32%;">Bale Ngayon</td>
              <td style="width:20%;" class="num"></td>
            </tr>` : ''}
            ${prevUnpaid > 0 ? `
            <tr>
              <td class="center">Natitira (Dati)</td>
              <td class="num">${peso.format(prevUnpaid)}</td>
              <td>Galing sa nakaraan</td>
              <td class="num">${peso.format(prevUnpaid)}</td>
            </tr>` : ''}
            ${extraPay > 0 ? `
            <tr>
              <td class="center">Dagdag Sahod</td>
              <td class="num">${peso.format(extraPay)}</td>
              <td>${escapeHtml(extraPayNotes || 'Bonus/Dagdag')}</td>
              <td class="num">+${peso.format(extraPay)}</td>
            </tr>` : ''}
            ${balePaid > 0 ? `
            <tr>
              <td class="center">Bayad Bale</td>
              <td class="num" style="color:#166534;">-${peso.format(balePaid)}</td>
              <td>Bayad sa utang ngayon</td>
              <td class="num" style="color:#166534;">-${peso.format(balePaid)}</td>
            </tr>` : ''}
            ${salaryPaid > 0 ? `
            <tr>
              <td class="center">Sahod na Natanggap</td>
              <td class="num" style="color:#166534;">-${peso.format(salaryPaid)}</td>
              <td>Natanggap na sahod ngayon</td>
              <td class="num" style="color:#166534;">-${peso.format(salaryPaid)}</td>
            </tr>` : ''}
            <tr class="slip-total-row">
              <td colspan="2" class="center"><strong>NATITIRA PANG SAHOD</strong></td>
              <td></td>
              <td class="num"><strong>${peso.format(balance)}</strong></td>
            </tr>
            <tr>
              <td colspan="4">Halaga sa Salita: <strong>${amountInWords(balance)}</strong></td>
            </tr>
          </tbody>
        </table>

        <div class="slip-summary-footer">
          <div><strong>BALENSA (Utang):</strong> ${peso.format(row.remaining_bale_balance)}</div>            <div><strong>Panahon:</strong> ${formatSlipDate(periodStart)} - ${formatSlipDate(addDays(periodStart, pd - 1))}</div>
        </div>

        <div class="slip-signatures">
          <div>
            <strong>Inihanda ni:</strong>
            <div class="signature-name">KVSK</div>
            <span>May-ari</span>
          </div>
          <div></div>
        </div>

        <div class="acceptance">
          <div>PAGKILALA NG EMPLEYADO</div>
          <div class="signature-grid">
            <span>Pumirma:<br><em>(Lagda sa Itaas ng Pangalan)</em></span>
            <span><br><em>(Posisyon)</em></span>
            <span><br><em>(Petsa)</em></span>
          </div>
        </div>
      </div>
      <div class="actions no-print" style="margin-top:16px; justify-content:center;">
        <button class="ghost" id="backPayroll">Back</button>
        ${preview ? '' : '<button class="primary" onclick="window.print()">Print</button><button class="primary" id="downloadPdfBtn">Download PDF</button>'}
      </div>
    </section>
  `);
  document.querySelector('#backPayroll').addEventListener('click', () => {
    if (preview && state._previewEmployee) {
      state.payrollModalEmployee = state._previewEmployee;
      state._previewEmployee = null;
      renderPayroll();
    } else {
      refresh();
    }
  });
  document.querySelector('#downloadPdfBtn')?.addEventListener('click', async () => {
    const btn = document.querySelector('#downloadPdfBtn');
    btn.textContent = 'Generating...';
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
    btn.textContent = 'Download PDF';
    btn.disabled = false;
  });
}
