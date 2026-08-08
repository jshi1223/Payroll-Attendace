/* ── Confirm Delete Modal ── */
function confirmDeleteModal() {
  if (!state.pendingDelete) return '';
  const resource = state.pendingDelete.resource;
  const isPermanent = resource === 'employees-permanent';
  const isArchive = resource === 'employees';
  const isSalaryPayment = resource === 'salary-payments';
  const isBalePayment = resource === 'bale-payments';
  const isExtraPayment = resource === 'extra-payments';
  const isCashAdvance = resource === 'cash-advances';
  const isAttendance = resource === 'attendance';
  const isAppMarkedAttendance = isAttendance && !!state.pendingDelete.appMarked;
  let title = 'Delete Record';
  let message = `Are you sure you want to delete this ${escapeHtml(resource.replace('-', ' '))}? This action cannot be undone.`;
  let confirmText = 'Delete';

  if (isPermanent) {
    title = 'Permanently Delete Employee';
    message = '⚠️ This will permanently delete the employee and ALL their records (attendance, cash advances, payroll). This CANNOT be undone!';
    confirmText = 'Delete Forever';
  } else if (isArchive) {
    title = 'Archive Employee';
    message = 'This employee will be archived and can be restored later from the Archive section.';
    confirmText = 'Archive';
  } else if (isSalaryPayment) {
    title = 'Delete Salary Payment';
    message = 'Delete this salary payment record? The salary balance will adjust accordingly.';
  } else if (isBalePayment) {
    title = 'Delete Bale Payment';
    message = 'Delete this bale payment record? The bale balance will adjust accordingly.';
  } else if (isExtraPayment) {
    title = 'Delete Extra Payment';
    message = 'Delete this extra payment record? This action cannot be undone.';
  } else if (isCashAdvance) {
    title = 'Delete Cash Advance';
    message = 'Delete this cash advance record? This action cannot be undone.';
  } else if (isAttendance) {
    title = isAppMarkedAttendance ? 'Delete App-Marked Attendance' : 'Delete Attendance';
    message = isAppMarkedAttendance
      ? 'This attendance was marked by the employee through the attendance app (biometric verification).'
      : 'This attendance record will be removed.';
    message += ' Type <strong>DELETE</strong> and enter a reason. This will be recorded in the audit trail and synced to the employee app.';
  }

  return `
    <div class="modal-backdrop" id="confirmDeleteModal">
      <section class="modal confirm-modal">
        <div class="modal-head">
          <div>
            <h2>${title}</h2>
            <p>${message}</p>
          </div>
          <button class="icon-btn" id="closeDeleteModal" aria-label="Close">x</button>
        </div>
        ${isPermanent || isAttendance ? `<div class="modal-body">
          <label>Type <strong>DELETE</strong> to confirm:<input id="typedDeleteConfirm" type="text" placeholder="DELETE" autocomplete="off" style="margin-top:4px;"></label>
          ${isAttendance ? '<label style="margin-top:12px;display:block;">Reason for deletion:<textarea id="attendanceDeleteReason" rows="3" maxlength="500" placeholder="Explain why this attendance must be deleted" style="margin-top:4px;resize:vertical;"></textarea></label>' : ''}
        </div>` : ''}
        <div class="modal-actions">
          <button class="ghost" type="button" id="cancelDelete">Cancel</button>
          <button class="danger" type="button" id="confirmDelete" ${isPermanent || isAttendance ? 'disabled' : ''}>${confirmText}</button>
        </div>
      </section>
    </div>
  `;
}

function bindConfirmDeleteModal() {
  const modal = document.querySelector('#confirmDeleteModal');
  if (!modal) return;

  const confirmInput = document.querySelector('#typedDeleteConfirm');
  const reasonInput = document.querySelector('#attendanceDeleteReason');
  const confirmBtn = document.querySelector('#confirmDelete');
  const updateDeleteButton = () => {
    if (!confirmBtn || !state.pendingDelete) return;
    const isAttendance = state.pendingDelete.resource === 'attendance';
    const confirmed = (confirmInput?.value.trim().toUpperCase() || '') === 'DELETE';
    const hasReason = !isAttendance || Boolean(reasonInput?.value.trim());
    confirmBtn.disabled = !confirmed || !hasReason;
  };
  if (confirmInput) {
    confirmInput.addEventListener('input', updateDeleteButton);
  }
  if (reasonInput) reasonInput.addEventListener('input', updateDeleteButton);

  const close = () => {
    const modalEmployeeId = state.pendingDelete?._modalEmployeeId;
    state.pendingDelete = null;
    if (modalEmployeeId) {
      const freshRow = (state.payroll?.rows || []).find(r => Number(r.employee_id) === Number(modalEmployeeId));
      if (freshRow) state.payrollModalEmployee = freshRow;
    }
    reRenderCurrentView();
  };

  setupModalKeyboard('#confirmDeleteModal', close);
  document.querySelector('#closeDeleteModal')?.addEventListener('click', close);
  document.querySelector('#cancelDelete')?.addEventListener('click', close);
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });
  document.querySelector('#confirmDelete')?.addEventListener('click', async () => {
    if (!state.pendingDelete) return close();
    const btn = document.querySelector('#confirmDelete');
    loadingButton(btn, true);
    try {
      const resource = state.pendingDelete.resource;
      const isPermanent = resource === 'employees-permanent';
      const isLegacyPayment = resource === 'legacy-payment';
      const isAttendance = resource === 'attendance';
      const needsTypedConfirm = isPermanent || isAttendance;
      if (needsTypedConfirm && (document.querySelector('#typedDeleteConfirm')?.value.trim().toUpperCase() || '') !== 'DELETE') {
        return close();
      }
      const deleteReason = document.querySelector('#attendanceDeleteReason')?.value.trim() || '';
      if (isAttendance && !deleteReason) {
        showToast('A deletion reason is required for attendance.', 'error');
        loadingButton(btn, false);
        return;
      }

      let url, method, body;
      if (isPermanent) {
        url = `/api/employees/${state.pendingDelete.id}/permanent`;
        method = 'DELETE';
      } else if (isLegacyPayment) {
        url = '/api/payroll/payment';
        method = 'DELETE';
        body = JSON.stringify({ employee_id: Number(state.pendingDelete.id), weekStart: state.week });
      } else {
        url = `/api/${resource}/${state.pendingDelete.id}`;
        method = 'DELETE';
        if (isAttendance) body = JSON.stringify({ confirmation: 'DELETE', reason: deleteReason });
      }

      await api(url, { method, body });

      const resourceName = resource.replace('-', ' ');
      if (isPermanent) {
        showToast('Employee permanently deleted.');
      } else if (resource === 'employees') {
        showToast('Employee archived.');
      } else if (isLegacyPayment) {
        showToast('Legacy payment cleared.');
      } else {
        showToast(`${resourceName.charAt(0).toUpperCase() + resourceName.slice(1)} deleted.`);
      }
      const modalEmployeeId = state.pendingDelete._modalEmployeeId;
      state.pendingDelete = null;

      /* Refresh after delete */
      if (isPermanent || resource === 'employees') {
        await partialRefresh(['employees']);
        reRenderCurrentView();
      } else {
        const partialMap = {
          'attendance': ['attendance', 'payroll'],
          'salary-payments': ['payroll', 'salaryPayments'],
          'bale-payments': ['payroll', 'balePayments'],
          'cash-advances': ['payroll', 'advances'],
          'extra-payments': ['payroll', 'extraPayments']
        };
        await partialRefresh(partialMap[resource] || ['payroll', 'salaryPayments', 'balePayments', 'advances', 'extraPayments']);
        /* Restore payroll modal if we came from one */
        if (modalEmployeeId) {
          const freshRow = (state.payroll?.rows || []).find(r => Number(r.employee_id) === Number(modalEmployeeId));
          if (freshRow) state.payrollModalEmployee = freshRow;
        }
        reRenderCurrentView();
      }
    } catch (error) {
      showToast(error.message, 'error');
      loadingButton(btn, false);
    }
  });
}

/* ── Logout Confirm Modal ── */
function logoutConfirmModal() {
  return `
    <div class="modal-backdrop" id="logoutModal">
      <section class="modal confirm-modal">
        <div class="modal-head">
          <div>
            <h2>Logout?</h2>
            <p>End your current payroll session.</p>
          </div>
          <button class="icon-btn" id="closeLogoutModal" aria-label="Close">x</button>
        </div>
        <div class="modal-actions">
          <button class="ghost" type="button" id="cancelLogout">Cancel</button>
          <button class="danger" type="button" id="confirmLogout">Logout</button>
        </div>
      </section>
    </div>
  `;
}

function bindLogoutConfirmModal() {
  const modal = document.querySelector('#logoutModal');
  if (!modal) return;

  const close = () => {
    state.showLogoutConfirm = false;
    reRenderCurrentView();
  };

  setupModalKeyboard('#logoutModal', close);
  document.querySelector('#closeLogoutModal').addEventListener('click', close);
  document.querySelector('#cancelLogout').addEventListener('click', close);
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });
  document.querySelector('#confirmLogout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    state.user = null;
    state.showLogoutConfirm = false;
    stopSessionTimer();
    renderLogin();
  });
}

/* ── Manage Payroll ── */
function payrollTransactionTypes(emp) {
  return [
    { key: 'bale', label: 'C/A Payment', endpoint: '/api/bale-payments', dateField: 'payment_date', maxAmt: emp.remaining_bale_balance },
    { key: 'extra', label: 'Extra Pay', endpoint: '/api/extra-payments', dateField: 'extra_date', maxAmt: null }
  ];
}

function payrollEntryModal(employee, transCalDates) {
  const emp = employee;
  const pd = state.payPeriodDays || emp.pay_period_days || 7;

  const baleLogs = state.balePayments.rows.filter(r => Number(r.employee_id) === Number(emp.employee_id));
  const extraLogs = state.extraPayments.rows.filter(r => Number(r.employee_id) === Number(emp.employee_id));
  const attLogs = state.attendance.rows.filter(r => Number(r.employee_id) === Number(emp.employee_id));

  const allLogs = [
    ...attLogs.map(l => ({ ...l, type: 'Attendance', date: l.work_date, amount: l.rate_snapshot, notes: 'Present' })),
    ...baleLogs.map(l => ({ ...l, type: 'C/A Payment', date: l.payment_date })),
    ...extraLogs.map(l => ({ ...l, type: 'Extra Pay', date: l.extra_date })),
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const transactionTypes = payrollTransactionTypes(emp);
  const today = todayInManila();
  const defaultTransactionDate = today >= state.week && today <= addDays(state.week, pd - 1) ? today : state.week;
  const transactionModal = state.payrollTransactionModal ? `
    <div class="modal-backdrop pe-transaction-backdrop" id="payrollTransactionModal">
      <section class="modal pe-transaction-modal" role="dialog" aria-modal="true" aria-labelledby="peTransactionTitle">
        <div class="modal-head">          <h2 id="peTransactionTitle">Add Transaction</h2><button class="icon-btn" id="closePayrollTransactionModal" aria-label="Close">x</button></div>
        <form id="peTransForm" class="pe-transaction-form" novalidate>
          <input type="hidden" name="employee_id" value="${emp.employee_id}">
          <label>Type<select name="type" id="peTransactionType">${transactionTypes.map(t => `<option value="${t.key}"${state.payrollModalTab === t.key ? ' selected' : ''}>${t.label}</option>`).join('')}</select></label>
          <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00"></label>
          <label>Date${miniDatePickerHTML('peTransDate', '', defaultTransactionDate, { inputName: 'transaction_date', highlightDates: transCalDates, calendarUrl: '/api/transactions/calendar' })}</label>
          <label>Notes<input name="notes" placeholder="Optional remarks"></label>
          <div class="pe-transaction-limits" id="peTransactionLimits"></div>
          <div class="error error-box" id="peTransError"></div>
          <div class="modal-actions"><button class="ghost" type="button" id="cancelPayrollTransaction">Cancel</button><button class="primary" type="submit" id="peTransSubmit">Save</button></div>
        </form>
      </section>
    </div>` : '';

  return `
    <div class="modal-backdrop" id="payrollEntryModal">
      <section class="modal wide-modal payroll-entry-modal">
        <div class="modal-head">
          <div>
            <h2>Manage Payroll</h2>
            <p><strong>${escapeHtml(emp.name)}</strong> · ${formatShortDate(state.week)} — ${formatShortDate(addDays(state.week, pd - 1))}</p>
          </div>
          <button class="icon-btn" id="closePayrollEntryModal" aria-label="Close">x</button>
        </div>
        <div class="pe-overview-grid">
          <div><span>Days Worked</span><strong>${emp.days}</strong></div><div><span>Daily Rate</span><strong>${formatMoney(emp.rate)}</strong></div><div><span>Total Salary</span><strong>${formatMoney(emp.salary)}</strong></div><div><span>Extra Pay</span><strong>${formatMoney(emp.extra_payment_amount || 0)}</strong></div>
          <div><span>Previous Unpaid</span><strong>${formatMoney(emp.previous_unpaid_balance)}</strong></div><div><span>Previous C/A</span><strong>${formatMoney(emp.previous_bale_balance)}</strong></div><div><span>BALANCE</span><strong class="balance-amount">${formatMoney(emp.balance)}</strong></div><div><span>C/A BAL.</span><strong>${formatMoney(emp.remaining_bale_balance)}</strong></div>
        </div>
        <button class="primary pe-add-transaction-btn" id="openPayrollTransactionModal">+ Add Transaction</button>
        <div class="pe-history"><div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Notes</th><th>Actions</th></tr></thead><tbody>         ${allLogs.map(log => {
          const logType = log.type;
          if (logType === 'Attendance') {
            return `<tr><td>${log.date}</td><td>${log.type}</td><td><strong>${formatMoney(log.amount)}</strong></td><td>${escapeHtml(log.notes || '-')}</td><td class="actions">—</td></tr>`;
          }
          const resType = logType === 'C/A Payment' || logType === 'Bayad Bale' ? 'bale-payments'
            : 'extra-payments';
          return `<tr><td>${log.date}</td><td>${log.type}</td><td><strong>${formatMoney(log.amount)}</strong></td><td>${escapeHtml(log.notes || '-')}</td><td class="actions"><button class="danger pe-delete-log" data-res="${resType}" data-id="${log.id}">Delete</button></td></tr>`;
        }).join('') || '<tr><td colspan="5" class="empty-state"><em>No transactions yet</em></td></tr>'}</tbody></table></div></div>
        <div class="pe-totals"><div><span>Total Earnings</span><strong>${formatMoney(Number(emp.salary || 0) + Number(emp.extra_payment_amount || 0))}</strong></div><div><span>Total Received</span><strong>${formatMoney(emp.paid_amount)}</strong></div><div><span>Total C/A Payments</span><strong>${formatMoney((emp.total_bale || 0) - (emp.remaining_bale_balance || 0))}</strong></div><div class="pe-net-balance"><span>Remaining Balance</span><strong>${formatMoney(emp.balance)}</strong></div></div>

        <div class="pe-footer"><button class="ghost" type="button" id="cancelPayrollEntry">Cancel</button><div><button class="ghost" type="button" id="pePreviewPayslip">Preview Payslip</button><button class="primary" type="button" id="peGeneratePayslip">Generate Payslip</button></div></div>
      </section>
      ${transactionModal}
    </div>
  `;
}

function bindPayrollEntryModal() {
  const modal = document.querySelector('#payrollEntryModal');
  if (!modal) return;
  const emp = state.payrollModalEmployee;
  if (!emp) return;
  const pd = state.payPeriodDays || emp.pay_period_days || 7;
  const transactionTypes = payrollTransactionTypes(emp);

  const close = () => {
    state.payrollModalEmployee = null;
    state.payrollTransactionModal = false;
    renderPayroll();
  };

  setupModalKeyboard('#payrollEntryModal', close);
  document.querySelector('#closePayrollEntryModal').addEventListener('click', close);
  modal.addEventListener('click', event => { if (event.target === modal) close(); });

  document.querySelector('#cancelPayrollEntry')?.addEventListener('click', close);
  document.querySelector('#openPayrollTransactionModal')?.addEventListener('click', () => { state.payrollTransactionModal = true; renderPayroll(); });
  const closeTransaction = () => { state.payrollTransactionModal = false; renderPayroll(); };
  document.querySelector('#closePayrollTransactionModal')?.addEventListener('click', closeTransaction);
  document.querySelector('#cancelPayrollTransaction')?.addEventListener('click', closeTransaction);
  document.querySelector('#payrollTransactionModal')?.addEventListener('click', event => { if (event.target === event.currentTarget) closeTransaction(); });
  bindMiniCalendar('peTransDate', () => {});

  const setTransactionLimit = () => {
    const option = transactionTypes.find(t => t.key === document.querySelector('#peTransactionType')?.value);
    const max = option?.maxAmt;
    const amount = document.querySelector('#peTransForm [name="amount"]');
    const pendingAmount = Math.max(0, Number(amount?.value) || 0);
    if (amount) amount.max = max || '';
    const limits = document.querySelector('#peTransactionLimits');
    const summaries = {
      pay: [
        ['Remaining', formatMoney(Math.max(0, Number(emp.balance || 0) - pendingAmount))]
      ],
      ca: [
        ['Bale Balance Now', formatMoney(emp.remaining_bale_balance)],
        ['New Bale Balance (Preview)', formatMoney(Number(emp.remaining_bale_balance || 0) + pendingAmount)]
      ],
      bale: [
        ['Remaining on Salary', formatMoney(Math.max(0, Number(emp.balance || 0) - pendingAmount))],
        ['Remaining Bale (debt)', formatMoney(Math.max(0, Number(emp.remaining_bale_balance || 0) - pendingAmount))]
      ],
      extra: [
        ['Extra Pay Now', formatMoney(Number(emp.extra_payment_amount || 0))],
        ['New Extra Pay', formatMoney(Number(emp.extra_payment_amount || 0) + pendingAmount)]
      ]
    };
    if (limits) {
      limits.innerHTML = (summaries[option?.key] || []).map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('');
    }
  };
  document.querySelector('#peTransactionType')?.addEventListener('change', setTransactionLimit);
  document.querySelector('#peTransForm [name="amount"]')?.addEventListener('input', setTransactionLimit);
  setTransactionLimit();

  /* Form submit (step 2) */
  document.querySelector('#peTransForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const errorBox = document.querySelector('#peTransError');
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form));
    const transaction = transactionTypes.find(t => t.key === payload.type) || transactionTypes[0];
    const endpoint = transaction.endpoint;
    const amount = Number(payload.amount);
    const maximum = transaction.maxAmt == null ? null : Number(transaction.maxAmt);
    errorBox.textContent = '';
    if (!Number.isFinite(amount) || amount <= 0) {
      errorBox.textContent = 'Please enter an amount greater than ₱0.00.';
      return;
    }
    if (maximum != null && amount > maximum) {
      errorBox.textContent = `${transaction.label} cannot exceed ${formatMoney(maximum)}.`;
      return;
    }
    const transactionDate = payload.transaction_date;
    delete payload.type;
    delete payload.transaction_date;
    payload.employee_id = Number(payload.employee_id);
    payload[transaction.dateField] = transactionDate;
    const submitBtn = document.querySelector('#peTransSubmit');
    submitBtn.disabled = true;
    loadingButton(submitBtn, true);
    try {
      await api(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      state._flash = { id: payload.employee_id, type: 'payroll' };
      showToast(`${transaction.label} saved.`);
      await partialRefresh(['payroll', 'salaryPayments', 'advances', 'balePayments', 'extraPayments']);
      // Re-find the employee from fresh data
      const freshRow = state.payroll.rows.find(r => Number(r.employee_id) === Number(payload.employee_id));
      if (freshRow) state.payrollModalEmployee = freshRow;
      state.payrollTransactionModal = false;
      renderPayroll();
    } catch (error) {
      errorBox.textContent = error.message;
    }
    submitBtn.disabled = false;
    loadingButton(submitBtn, false);
  });

  /* Delete logs (step 3) */
  document.querySelectorAll('.pe-delete-log').forEach(btn => {
    btn.addEventListener('click', () => {
      state.pendingDelete = {
        resource: btn.dataset.res,
        id: btn.dataset.id,
        _modalEmployeeId: state.payrollModalEmployee?.employee_id
      };
      state.payrollModalEmployee = null;
      reRenderCurrentView();
    });
  });

  /* Generate payslip (step 4) — locks the payroll */
  const generatePayslip = async () => {
    const confirmed = await new Promise(resolve => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.id = 'generateConfirmModal';
      backdrop.innerHTML = `
        <section class="modal confirm-modal" style="max-width:380px;">
          <div class="modal-head">
            <div><h2>Generate Payslip?</h2><p>This will <strong>LOCK</strong> this payroll period and auto-record the salary as <strong>paid</strong>. No more changes allowed.</p></div>
            <button class="icon-btn" id="closeGenerateConfirm" aria-label="Close">x</button>
          </div>
          <div class="modal-actions">
            <button class="ghost" id="cancelGenerate">Cancel</button>
            <button class="primary" id="confirmGenerate">Generate & Lock</button>
          </div>
        </section>`;
      document.body.appendChild(backdrop);
      const cleanup = (result) => { backdrop.remove(); resolve(result); };
      backdrop.querySelector('#closeGenerateConfirm').addEventListener('click', () => cleanup(false));
      backdrop.querySelector('#cancelGenerate').addEventListener('click', () => cleanup(false));
      backdrop.querySelector('#confirmGenerate').addEventListener('click', () => cleanup(true));
      backdrop.addEventListener('click', e => { if (e.target === backdrop) cleanup(false); });
    });
    if (!confirmed) return;
    const selectedEmployee = state.payrollModalEmployee;
    const row = state.payroll?.rows?.find(r => Number(r.employee_id) === Number(selectedEmployee?.employee_id)) || selectedEmployee;
    if (row?.employee_id) {
      try {
        await api(`/api/payroll/${row.employee_id}/generate`, {
          method: 'POST',
          body: JSON.stringify({ weekStart: state.week, payPeriodDays: state.payPeriodDays })
        });
        const pd = state.payPeriodDays || 7;
        const payrollQs = new URLSearchParams({ week: state.payrollWeek, today: state.currentDate, periodDays: pd });
        if (state.view === 'archive') payrollQs.set('include_inactive', 'true');
        const [freshPayroll] = await Promise.all([
          api(`/api/payroll?${payrollQs}`),
        ]);
        state.payroll = freshPayroll;
        const generatedRow = state.payroll.rows.find(item => Number(item.employee_id) === Number(row.employee_id)) || row;
        state.payrollModalEmployee = null;
        state.payrollTransactionModal = false;
        showToast('Payslip generated and salary auto-paid.');
        state._generatedPayslip = generatedRow;
        renderPayroll();
      } catch (error) {
        state.payrollModalEmployee = selectedEmployee;
        renderPayroll();
        showToast(`Could not generate payslip: ${error.message}`, 'error');
      }
    } else {
      showToast('No payroll data available for this employee.', 'error');
    }
  };

  /* Preview payslip — read-only, does NOT lock */
  const previewPayslip = () => {
    const row = state.payroll?.rows?.find(r => Number(r.employee_id) === Number(state.payrollModalEmployee?.employee_id)) || state.payrollModalEmployee;
    if (row?.employee_id) {
      state._previewEmployee = { ...state.payrollModalEmployee };
      state.payrollModalEmployee = null;
      state.payrollTransactionModal = false;
      renderPayslip(row, { preview: true });
    } else {
      showToast('No payroll data available for this employee.', 'error');
    }
  };

  document.querySelector('#pePreviewPayslip')?.addEventListener('click', previewPayslip);
  document.querySelector('#peGeneratePayslip')?.addEventListener('click', generatePayslip);
}

/* ── Payslip Generated Success Modal ── */
function payslipGeneratedModal() {
  const row = state._generatedPayslip;
  if (!row) return '';
  const pd = state.payPeriodDays || row.pay_period_days || 7;
  const periodStart = state.week;
  const periodEnd = addDays(periodStart, pd - 1);
  const totalEarnings = Number(row.salary || 0) + Number(row.extra_payment_amount || 0) + Number(row.previous_unpaid_balance || 0);
  const netPay = Math.max(totalEarnings - Number(row.bale_paid_amount || 0), 0);
  const initials = row.name ? row.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() : '?';
  return `
    <div class="modal-backdrop pg-success-backdrop" id="payslipGeneratedModal">
      <section class="modal confirm-modal pg-success-modal" role="dialog" aria-modal="true" aria-labelledby="pgSuccessTitle">
        <div class="modal-head">
          <div class="pg-success-icon">✓</div>
          <div>
            <h2 id="pgSuccessTitle">Payslip Generated</h2>
            <p>This payroll period is now <strong>LOCKED</strong>. No more changes allowed.</p>
          </div>
          <button class="icon-btn" id="closePayslipGenerated" aria-label="Close">x</button>
        </div>
        <div class="pg-success-body">
          <div class="pg-success-employee">
            <div class="pg-success-avatar" style="background:var(--brand);">${escapeHtml(initials)}</div>
            <div>
              <strong>${escapeHtml(row.name)}</strong>
              <span>${escapeHtml(row.emp_number || '')} · ${getPeriodLabel(pd)}</span>
            </div>
          </div>
          <div class="pg-success-grid">
            <div><span>Period</span><strong>${formatShortDate(periodStart)} – ${formatShortDate(periodEnd)}</strong></div>
            <div><span>Days Worked</span><strong>${row.days}</strong></div>
            <div><span>Gross Pay</span><strong>${formatMoney(totalEarnings)}</strong></div>
            <div><span>NET PAY</span><strong class="pg-net-pay">${formatMoney(netPay)}</strong></div>
          </div>
        </div>
        <div class="modal-actions">
          <button class="ghost" id="closePayslipGenerated">Close</button>
          <button class="primary" id="viewPayslipGenerated">View / Print Payslip</button>
        </div>
      </section>
    </div>
  `;
}

function bindPayslipGeneratedModal() {
  const modal = document.querySelector('#payslipGeneratedModal');
  if (!modal) return;
  const row = state._generatedPayslip;
  if (!row) return;

  const close = () => {
    state._generatedPayslip = null;
    reRenderCurrentView();
  };

  setupModalKeyboard('#payslipGeneratedModal', close);
  document.querySelector('#closePayslipGenerated')?.addEventListener('click', close);
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });
  document.querySelector('#viewPayslipGenerated')?.addEventListener('click', () => {
    const payslipRow = state._generatedPayslip;
    state._generatedPayslip = null;
    if (payslipRow) renderPayslip(payslipRow);
    else reRenderCurrentView();
  });
}

/* ── Employee Modal ── */
function employeeModal(employee = {}) {
  const isEdit = Boolean(employee.id);
  const initials = employee.name ? employee.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() : '?';
  const hasPhoto = Boolean(employee.photo_url);
  const photoStyle = hasPhoto
    ? `background-image:url('${employee.photo_url}');background-size:cover;background-position:center;`
    : `background:#dc2626;`;
  const photoContent = hasPhoto ? '' : `<span style="font-size:28px;font-weight:800;color:white;">${initials}</span>`;
  return `
    <div class="modal-backdrop" id="employeeModal">
      <section class="modal wide-modal">
        <div class="modal-head">
          <div style="display:flex;align-items:center;gap:14px;">
            <div>
              <h2 id="employeeModalTitle">${isEdit ? 'Edit Employee' : 'Employee Details'}</h2>
              <p id="employeeModalDescription">${isEdit ? 'Update employee details.' : 'Fill in the employee details first.'}</p>
            </div>
          </div>
          <button class="icon-btn" id="closeEmployeeModal" aria-label="Close">x</button>
        </div>
        ${isEdit ? '' : `
        <div class="wizard-steps" id="employeeWizardSteps">
          <div class="wizard-step active" data-step="1"><span class="wizard-step-num">1</span> Employee Details</div>
          <div class="wizard-step" data-step="2"><span class="wizard-step-num">2</span> Temporary Password</div>
        </div>`}
        <form class="form-grid" id="employeeForm" enctype="multipart/form-data">
          <input type="hidden" name="id" value="${employee.id || ''}">
          <input type="hidden" name="pay_period_days" value="${employee.pay_period_days || 7}">
          ${isEdit ? '' : '<div class="wizard-panel" id="employeeStep1">'}
            <div class="profile-photo-wrap" style="cursor:default;">
              <div class="profile-photo" id="profilePhotoPreview" style="${photoStyle}">${photoContent}</div>
              ${hasPhoto ? '<div class="profile-photo-label">Photo uploaded by employee</div>' : '<div class="profile-photo-label">No photo uploaded by employee</div>'}
            </div>
            <div class="section-title">Basic Information</div>
            ${isEdit ? `<label>Emp Number<div class="readonly-field">${employee.emp_number}</div></label>` : ''}
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
              <label>First Name<input name="first_name" value="${escapeHtml(employee.first_name || '')}" placeholder="Enter first name" required></label>
              <label>Last Name<input name="last_name" value="${escapeHtml(employee.last_name || employee.name?.split(' ').slice(1).join(' ') || '')}" placeholder="Enter last name" required></label>
            </div>
            <input type="hidden" name="name" value="${escapeHtml(employee.name || '')}">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
              <label>Phone Number<input name="phone" type="tel" value="${escapeHtml(employee.phone || '')}" placeholder="09171234567" pattern="[0-9]{11}" minlength="11" maxlength="11" inputmode="numeric" id="phoneInput" required><span class="field-hint">Must be 11 digits. Numbers only.</span></label>
              <label>Email<input name="email" type="email" value="${escapeHtml(employee.email || '')}" placeholder="employee@email.com" autocomplete="off" required><span class="field-hint">Used as the employee's login in the attendance app.</span></label>
            </div>
            <div class="section-title">Government IDs <span style="font-weight:400;font-size:12px;color:var(--muted);">(type digits, dashes auto-inserted)</span></div>
            <div class="gov-id-grid">
              <label>SSS Number<input name="sss_number" type="text" value="${escapeHtml(employee.sss_number || '')}" placeholder="__-_______-_" maxlength="12" class="gov-id-input" data-format="sss" inputmode="numeric" autocomplete="off" required></label>
              <label>PhilHealth<input name="philhealth_number" type="text" value="${escapeHtml(employee.philhealth_number || '')}" placeholder="__-_________-_" maxlength="14" class="gov-id-input" data-format="philhealth" inputmode="numeric" autocomplete="off" required></label>
              <label>Pag-IBIG<input name="pagibig_number" type="text" value="${escapeHtml(employee.pagibig_number || '')}" placeholder="____-____-____" maxlength="14" class="gov-id-input" data-format="pagibig" inputmode="numeric" autocomplete="off" required></label>
              <label>TIN Number<input name="tin_number" type="text" value="${escapeHtml(employee.tin_number || '')}" placeholder="___-___-___-___" maxlength="15" class="gov-id-input" data-format="tin" inputmode="numeric" autocomplete="off" required></label>
            </div>
            <div class="section-title">Payroll Settings</div>
            <label>Daily Rate (₱)<input name="rate" type="number" min="500" step="0.01" value="${employee.rate || ''}" placeholder="500.00" required><span class="field-hint">Minimum rate is ₱500.00</span></label>
            <label>Status<select name="active"><option value="true" ${employee.active !== false ? 'selected' : ''}>Active</option><option value="false" ${employee.active === false ? 'selected' : ''}>Inactive (Archive)</option></select></label>
          ${isEdit ? '' : '</div>'}
          ${isEdit ? '' : `
          <div class="wizard-panel" id="employeeStep2" hidden>
            <div class="section-title">Temporary Password <span style="font-weight:400;font-size:12px;color:var(--muted);">(para sa attendance app login)</span></div>
            <label>Temporary Password<input name="password" type="text" value="" placeholder="Min 8 characters" minlength="8" required autocomplete="new-password"><span class="field-hint">The employee will use this password to sign in to the app.</span></label>
            <label>Confirm Temporary Password<input name="password_confirm" type="text" value="" placeholder="Repeat the temporary password" minlength="8" required autocomplete="new-password"></label>
          </div>`}
          <div class="error error-box" id="employeeFormError"></div>
          <div class="modal-actions">
            <button class="ghost" type="button" id="cancelEmployeeModal">Cancel</button>
            ${isEdit ? '' : `<button class="ghost" type="button" id="employeeBackBtn" hidden style="display:none;">Back</button>`}
            ${isEdit ? '' : `<button class="primary" type="button" id="employeeNextBtn">Next</button>`}
            <button class="primary" type="submit" id="employeeSubmitBtn" ${isEdit ? '' : 'hidden style="display:none;"'}>${isEdit ? 'Update Employee' : 'Add Employee'}</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function bindEmployeeModal() {
  const modal = document.querySelector('#employeeModal');
  if (!modal) return;

  const close = () => {
    state.editingEmployee = null;
    renderEmployees();
  };

  /* Block non-numeric input on phone field */
  const phoneInputEl = document.querySelector('#phoneInput');
  phoneInputEl?.addEventListener('input', () => {
    phoneInputEl.value = phoneInputEl.value.replace(/\D/g, '');
  });

  /* Wizard: navigate between Step 1 (Details) and Step 2 (Mobile Login) */
  const step1Panel = document.querySelector('#employeeStep1');
  const step2Panel = document.querySelector('#employeeStep2');
  const nextBtn = document.querySelector('#employeeNextBtn');
  const backBtn = document.querySelector('#employeeBackBtn');
  const submitBtn = document.querySelector('#employeeSubmitBtn');
  const stepEls = Array.from(document.querySelectorAll('#employeeWizardSteps .wizard-step'));

  const setStep = (step) => {
    step1Panel.hidden = step !== 1;
    step2Panel.hidden = step !== 2;
    nextBtn.hidden = step === 2;
    backBtn.hidden = step !== 2;
    submitBtn.hidden = step !== 2;
    nextBtn.style.display = step === 2 ? 'none' : '';
    backBtn.style.display = step === 2 ? '' : 'none';
    submitBtn.style.display = step === 2 ? '' : 'none';
    stepEls.forEach(el => el.classList.toggle('active', Number(el.dataset.step) === step));
    const title = document.querySelector('#employeeModalTitle');
    const description = document.querySelector('#employeeModalDescription');
    if (title) title.textContent = step === 1 ? 'Employee Details' : 'Temporary Password';
    if (description) description.textContent = step === 1
      ? 'Fill in the employee details first.'
      : 'Set the employee’s temporary password before adding the employee.';
    const modalEl = document.querySelector('#employeeModal section.modal');
    if (modalEl) modalEl.scrollTop = 0;
  };

  const goToStep2 = () => {
    const formEl2 = document.querySelector('#employeeForm');
    const firstInvalid = formEl2?.querySelector('#employeeStep1 [required]:invalid');
    if (firstInvalid) {
      firstInvalid.reportValidity();
      firstInvalid.focus();
      return;
    }
    setStep(2);
  };

  nextBtn?.addEventListener('click', goToStep2);
  backBtn?.addEventListener('click', () => setStep(1));

  /* Auto-format Government ID inputs */
  document.querySelectorAll('.gov-id-input').forEach(input => {
    input.addEventListener('input', function() {
      const format = this.dataset.format;
      let digits = this.value.replace(/\D/g, '');
      let formatted = '';
      if (format === 'sss') {
        digits = digits.slice(0, 10);
        formatted = digits.slice(0, 2);
        if (digits.length > 2) formatted += '-' + digits.slice(2, 9);
        if (digits.length > 9) formatted += '-' + digits.slice(9, 10);
      } else if (format === 'philhealth') {
        digits = digits.slice(0, 12);
        formatted = digits.slice(0, 2);
        if (digits.length > 2) formatted += '-' + digits.slice(2, 11);
        if (digits.length > 11) formatted += '-' + digits.slice(11, 12);
      } else if (format === 'pagibig') {
        digits = digits.slice(0, 12);
        formatted = digits.slice(0, 4);
        if (digits.length > 4) formatted += '-' + digits.slice(4, 8);
        if (digits.length > 8) formatted += '-' + digits.slice(8, 12);
      } else if (format === 'tin') {
        digits = digits.slice(0, 12);
        formatted = digits.slice(0, 3);
        if (digits.length > 3) formatted += '-' + digits.slice(3, 6);
        if (digits.length > 6) formatted += '-' + digits.slice(6, 9);
        if (digits.length > 9) formatted += '-' + digits.slice(9, 12);
      }
      this.value = formatted;
    });
  });

  setupModalKeyboard('#employeeModal', close);
  document.querySelector('#closeEmployeeModal').addEventListener('click', close);
  document.querySelector('#cancelEmployeeModal').addEventListener('click', close);
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });
  document.querySelector('#employeeForm').addEventListener('submit', async event => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const employeeId = formData.get('id');
    if (!employeeId && step2Panel?.hidden) {
      goToStep2();
      return;
    }
    const errorBox = document.querySelector('#employeeFormError');
    const submitButton = event.currentTarget.querySelector('button[type="submit"]');
    errorBox.textContent = '';

    /* Validate phone: exactly 11 digits */
    const phoneInput = document.querySelector('input[name="phone"]');
    const phone = phoneInput?.value?.trim() || '';
    if (!/^[0-9]{11}$/.test(phone)) {
      phoneInput?.classList.add('field-error');
      errorBox.textContent = 'Phone number must be exactly 11 digits (numbers only). Example: 09171234567';
      submitButton.disabled = false;
      phoneInput?.focus();
      return;
    } else {
      phoneInput?.classList.remove('field-error');
      phoneInput?.classList.add('field-valid');
    }

    /* Step 2 validation: email format + temporary password rules */
    const emailInput = document.querySelector('input[name="email"]');
    const email = emailInput?.value?.trim() || '';
    const passwordInput = document.querySelector('input[name="password"]');
    const password = passwordInput?.value || '';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      emailInput?.classList.add('field-error');
      errorBox.textContent = 'Please enter a valid email address.';
      submitButton.disabled = false;
      emailInput?.focus();
      return;
    }
    emailInput?.classList.remove('field-error');
    if (!employeeId && email && !password) {
      passwordInput?.classList.add('field-error');
      errorBox.textContent = 'Temporary password is required to create the mobile login.';
      submitButton.disabled = false;
      passwordInput?.focus();
      return;
    }
    if (!employeeId && email && password.length < 8) {
      passwordInput?.classList.add('field-error');
      errorBox.textContent = 'Temporary password must be at least 8 characters.';
      submitButton.disabled = false;
      passwordInput?.focus();
      return;
    }
    passwordInput?.classList.remove('field-error');

    submitButton.disabled = true;
    loadingButton(submitButton, true);
    formData.delete('photo');
    const payload = Object.fromEntries(formData);
    delete payload.id;
    delete payload.emp_number;
    payload.active = payload.active === 'true';
    try {
      const result = await api(employeeId ? `/api/employees/${employeeId}` : '/api/employees', {
        method: employeeId ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });
      const employeeIdResult = employeeId || result.id;
      /* Instant update: add/edit directly in local state */
      if (employeeId) {
        const idx = state.employees.findIndex(e => String(e.id) === String(employeeId));
        if (idx !== -1) state.employees[idx] = { ...state.employees[idx], ...result };
      } else {
        state.employees.push(result);
        state.employees.sort((a, b) => a.name.localeCompare(b.name));
      }
      state.editingEmployee = null;
      state._flash = { id: Number(employeeIdResult), type: 'employees' };
      showToast(employeeId ? 'Employee updated successfully.' : 'Employee added successfully.');
      reRenderCurrentView();
    } catch (error) {
      errorBox.textContent = error.message;
      submitButton.disabled = false;
      loadingButton(submitButton, false);
    }
  });
}

/* ── System Logs Modal ── */
let auditFilterState = { entity: '', action: '', search: '', date_from: '', date_to: '', page: 1 };

function auditTrailModal() {
  return `
    <div class="modal-backdrop" id="auditModal">
      <section class="modal wide-modal" style="max-height:90vh;display:flex;flex-direction:column;">
        <div class="modal-head">
          <div>
            <h2>System Logs</h2>
            <p>Complete history of actions in the system.</p>
          </div>
          <button class="icon-btn" id="closeAuditModal" aria-label="Close">x</button>
        </div>
        <div class="audit-filters">
          <select id="auditEntityFilter"><option value="">All Entities</option><option value="employee">Employee</option><option value="attendance">Attendance</option><option value="cash_advance">Cash Advance</option><option value="extra_payment">Extra Payment</option><option value="payroll_payment">Payroll Payment</option><option value="payroll_extra_payment">Extra Payment (old)</option></select>
          <select id="auditActionFilter"><option value="">All Actions</option><option value="create">Create</option><option value="update">Update</option><option value="delete">Delete</option><option value="archive">Archive</option><option value="restore">Restore</option><option value="permanent_delete">Permanent Delete</option><option value="reject">Reject</option><option value="reset-device">Reset Device</option></select>
          <input id="auditSearch" placeholder="Search details..." value="${escapeHtml(auditFilterState.search)}">
          ${miniDatePickerHTML('auditDateFrom', 'From', auditFilterState.date_from || todayInManila(), { hideLabel: true })}
          ${miniDatePickerHTML('auditDateTo', 'To', auditFilterState.date_to || todayInManila(), { hideLabel: true })}
          <button class="ghost" id="auditFilterBtn">Filter</button>
          <button class="ghost" id="auditResetBtn">Reset</button>
          <button class="ghost" id="auditExportBtn">Export CSV</button>
        </div>
        <div class="table-wrap" style="flex:1;overflow:auto;">
          <table>
            <thead><tr><th>Date/Time</th><th>User</th><th>Action</th><th>Entity</th><th>Entity ID</th><th>Details</th></tr></thead>
            <tbody id="auditTableBody">
              <tr><td colspan="6" style="text-align:center;padding:24px;color:var(--muted);">Loading...</td></tr>
            </tbody>
          </table>
        </div>
        <div class="audit-pagination" id="auditPagination"></div>
      </section>
    </div>
  `;
}

async function renderAuditTable() {
  const tbody = document.querySelector('#auditTableBody');
  const pagination = document.querySelector('#auditPagination');
  if (!tbody) return;
  try {
    const data = await loadAuditLogs();
    if (!data.rows || data.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><span class="empty-icon">--</span><strong>No Audit Logs</strong><span>No records match your filters.</span></td></tr>';
      pagination.innerHTML = '';
      return;
    }
    tbody.innerHTML = data.rows.map(log => {
      let detailsHtml = '';
      const details = log.details || {};
      if (typeof details === 'object' && details !== null) {
        const parts = [];
        if (details.amount) parts.push('Amount: ' + formatMoney(details.amount));
        if (details.emp_number) parts.push('Emp: ' + escapeHtml(details.emp_number));
        if (details.name) parts.push('Name: ' + escapeHtml(details.name));
        if (details.employee_id) parts.push('Emp ID: ' + details.employee_id);
        if (details.week_start) parts.push('Week: ' + details.week_start);
        if (details.work_date) parts.push('Date: ' + escapeHtml(details.work_date));
        if (details.time_in) parts.push('Time In: ' + escapeHtml(details.time_in));
        if (details.attempted_time_out) parts.push('Attempted Out: ' + escapeHtml(details.attempted_time_out));
        if (details.reason) parts.push('Reason: ' + escapeHtml(details.reason));
        if (details.paid_amount) parts.push('Paid: ' + formatMoney(details.paid_amount));
        if (details.extra_payment_amount) parts.push('Extra: ' + formatMoney(details.extra_payment_amount));
        if (details.notes) parts.push('Notes: ' + escapeHtml(details.notes));
        detailsHtml = parts.length > 0 ? parts.join(' | ') : '<span class="muted">—</span>';
      } else {
        detailsHtml = escapeHtml(String(details));
      }
      return `
        <tr>
          <td class="audit-date">${new Date(log.created_at).toLocaleString('en-PH')}</td>
          <td><strong>${escapeHtml(log.username || 'System')}</strong></td>
          <td><span class="audit-action audit-action-${log.action}">${escapeHtml(log.action.replace(/_/g, ' '))}</span></td>
          <td><span class="badge">${escapeHtml(log.entity.replace(/_/g, ' '))}</span></td>
          <td>${log.entity_id || '-'}</td>
          <td style="white-space:normal;min-width:200px;font-size:12px;">${detailsHtml}</td>
        </tr>
      `;
    }).join('');
    pagination.innerHTML = data.totalPages > 1
      ? '<div class="pagination">' +
        `<button class="ghost" ${data.page <= 1 ? 'disabled' : ''} id="auditPrevPage">← Previous</button>` +
        `<span>Page ${data.page} of ${data.totalPages} (${data.total} records)</span>` +
        `<button class="ghost" ${data.page >= data.totalPages ? 'disabled' : ''} id="auditNextPage">Next →</button>`
        + '</div>'
      : `<div class="pagination-info"><span>${data.total} records</span></div>`;

    document.querySelector('#auditPrevPage')?.addEventListener('click', () => {
      if (auditFilterState.page > 1) {
        auditFilterState.page--;
        renderAuditTable();
      }
    });
    document.querySelector('#auditNextPage')?.addEventListener('click', () => {
      auditFilterState.page++;
      renderAuditTable();
    });
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--danger);">Error: ${escapeHtml(error.message)}</td></tr>`;
  }
}

function bindAuditTrailModal() {
  const modal = document.querySelector('#auditModal');
  if (!modal) return;
  const close = () => {
    state.showAudit = false;
    auditFilterState = { entity: '', action: '', search: '', date_from: '', date_to: '', page: 1 };
    renderPayroll();
  };
  setupModalKeyboard('#auditModal', close);
  document.querySelector('#closeAuditModal').addEventListener('click', close);
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });

  if (auditFilterState.entity) document.querySelector('#auditEntityFilter').value = auditFilterState.entity;
  if (auditFilterState.action) document.querySelector('#auditActionFilter').value = auditFilterState.action;
  bindMiniCalendar('auditDateFrom', () => {});
  bindMiniCalendar('auditDateTo', () => {});

  document.querySelector('#auditFilterBtn').addEventListener('click', async () => {
    auditFilterState = {
      entity: document.querySelector('#auditEntityFilter').value,
      action: document.querySelector('#auditActionFilter').value,
      search: document.querySelector('#auditSearch').value,
      date_from: document.querySelector('#auditDateFrom').value,
      date_to: document.querySelector('#auditDateTo').value,
      page: 1
    };
    await renderAuditTable();
  });
  document.querySelector('#auditResetBtn').addEventListener('click', async () => {
    auditFilterState = { entity: '', action: '', search: '', date_from: '', date_to: '', page: 1 };
    document.querySelector('#auditEntityFilter').value = '';
    document.querySelector('#auditActionFilter').value = '';
    document.querySelector('#auditSearch').value = '';
    ['auditDateFrom', 'auditDateTo'].forEach(id => {
      const wrap = document.querySelector(`[data-mc-id="${id}"]`);
      if (wrap) {
        const input = wrap.querySelector('input');
        const valEl = wrap.querySelector('.att-date-value');
        const titleEl = wrap.querySelector(`[data-mc-title="${id}"]`);
        const grid = wrap.querySelector(`[data-mc-grid="${id}"]`);
        if (input) input.value = '';
        if (valEl) valEl.textContent = todayInManila();
        if (titleEl) titleEl.textContent = new Date(todayInManila() + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        if (grid) grid.innerHTML = miniCalendarGridHTML(todayInManila(), null, todayInManila());
      }
    });
    await renderAuditTable();
  });
  document.querySelector('#auditExportBtn').addEventListener('click', async () => {
    const data = await loadAuditLogs();
    if (!data.rows || !data.rows.length) {
      showToast('No data to export.', 'error');
      return;
    }
    const exportData = data.rows.map(log => ({
      'Date': new Date(log.created_at).toLocaleString('en-PH'),
      'User': log.username || 'System',
      'Action': log.action,
      'Entity': log.entity,
      'Entity ID': log.entity_id || '',
      'Details': JSON.stringify(log.details)
    }));
    exportCSV(exportData, `system_logs_${new Date().toISOString().slice(0, 10)}.csv`);
  });

  renderAuditTable();
}

/* ── Settings Modal ── */
function settingsModal() {
  const isDark = document.body.classList.contains('dark-mode');
  return `
    <div class="modal-backdrop" id="settingsModal">
      <section class="modal confirm-modal" style="max-width:420px;">
        <div class="modal-head">
          <div>
            <h2>Settings</h2>
            <p>Theme and account settings.</p>
          </div>
          <button class="icon-btn" id="closeSettings" aria-label="Close">x</button>
        </div>
        <div style="padding:0 24px 20px;display:flex;flex-direction:column;gap:12px;">
          <div class="settings-option" id="settingsDarkMode" style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border:1px solid var(--line);border-radius:var(--radius-lg);cursor:pointer;">
            <span style="font-weight:600;font-size:15px;">Dark Mode</span>
            <span style="font-size:14px;color:var(--muted);" id="settingsDarkLabel">${isDark ? 'On' : 'Off'}</span>
          </div>
          <div class="settings-option" id="settingsChangePassword" style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border:1px solid var(--line);border-radius:var(--radius-lg);cursor:pointer;">
            <span style="font-weight:600;font-size:15px;">Change Password</span>
            <span style="font-size:14px;color:var(--muted);">Update</span>
          </div>
        </div>
      </section>
    </div>
  `;
}

function bindSettingsModal() {
  const modal = document.querySelector('#settingsModal');
  if (!modal) return;

  const close = () => {
    state.showSettings = false;
    reRenderCurrentView();
  };

  setupModalKeyboard('#settingsModal', close);
  document.querySelector('#closeSettings').addEventListener('click', close);
  modal.addEventListener('click', event => { if (event.target === modal) close(); });

  document.querySelector('#settingsDarkMode')?.addEventListener('click', () => {
    toggleDarkMode();
    const label = document.querySelector('#settingsDarkLabel');
    if (label) label.textContent = document.body.classList.contains('dark-mode') ? 'On' : 'Off';
  });

  document.querySelector('#settingsChangePassword')?.addEventListener('click', () => {
    state.showSettings = false;
    state.showChangePassword = true;
    reRenderCurrentView();
  });
}

/* ── Change Password Modal ── */
function changePasswordModal() {
  return `
    <div class="modal-backdrop" id="changePasswordModal">
      <section class="modal confirm-modal" style="max-width:440px;">
        <div class="modal-head">
          <div>
            <h2>Change Password</h2>
            <p>Enter your current password and set a new one.</p>
          </div>
          <button class="icon-btn" id="closeChangePassword" aria-label="Close">x</button>
        </div>
        <form id="changePasswordForm" style="padding:0 24px 20px;display:flex;flex-direction:column;gap:14px;">
          <label>Current Password
            <div class="password-wrapper">
              <input name="current_password" type="password" required placeholder="Enter current password" autocomplete="current-password">
              <button class="password-toggle" type="button" data-password-toggle aria-label="Show password" aria-pressed="false">${passwordToggleIcon()}</button>
            </div>
          </label>
          <label>New Password
            <div class="password-wrapper">
              <input name="new_password" type="password" required minlength="6" placeholder="Min 6 characters" autocomplete="new-password">
              <button class="password-toggle" type="button" data-password-toggle aria-label="Show password" aria-pressed="false">${passwordToggleIcon()}</button>
            </div>
          </label>
          <label>Confirm New Password
            <div class="password-wrapper">
              <input name="confirm_password" type="password" required minlength="6" placeholder="Re-type new password" autocomplete="new-password">
              <button class="password-toggle" type="button" data-password-toggle aria-label="Show password" aria-pressed="false">${passwordToggleIcon()}</button>
            </div>
          </label>
          <div class="error error-box" id="changePasswordError"></div>
          <div class="modal-actions">
            <button class="ghost" type="button" id="cancelChangePassword">Cancel</button>
            <button class="primary" type="submit" id="submitChangePassword">Change Password</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function bindChangePasswordModal() {
  const modal = document.querySelector('#changePasswordModal');
  if (!modal) return;

  const close = () => {
    state.showChangePassword = false;
    reRenderCurrentView();
  };

  setupModalKeyboard('#changePasswordModal', close);
  document.querySelector('#closeChangePassword').addEventListener('click', close);
  document.querySelector('#cancelChangePassword').addEventListener('click', close);
  modal.addEventListener('click', event => { if (event.target === modal) close(); });
  bindPasswordToggles(modal);

  document.querySelector('#changePasswordForm').addEventListener('submit', async event => {
    event.preventDefault();
    const errorBox = document.querySelector('#changePasswordError');
    const submitBtn = document.querySelector('#submitChangePassword');
    const form = new FormData(event.currentTarget);
    const currentPassword = form.get('current_password');
    const newPassword = form.get('new_password');
    const confirmPassword = form.get('confirm_password');

    errorBox.textContent = '';

    if (newPassword !== confirmPassword) {
      errorBox.textContent = 'New passwords do not match.';
      return;
    }
    if (newPassword.length < 6) {
      errorBox.textContent = 'New password must be at least 6 characters.';
      return;
    }
    if (currentPassword === newPassword) {
      errorBox.textContent = 'New password must be different from current password.';
      return;
    }

    submitBtn.disabled = true;
    loadingButton(submitBtn, true);
    try {
      await api('/api/password', {
        method: 'PUT',
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
      });
      showToast('Password changed successfully.');
      state.showChangePassword = false;
      reRenderCurrentView();
    } catch (error) {
      errorBox.textContent = error.message;
    }
    submitBtn.disabled = false;
    loadingButton(submitBtn, false);
  });
}

/* ── Close Confirmation Modal (Electron X button) ── */
function closeConfirmModal() {
  return `
    <div class="modal-backdrop" id="closeConfirmModal">
      <section class="modal confirm-modal">
        <div class="modal-head">
          <div>
            <h2>Exit Application?</h2>
            <p>Choose an option before closing.</p>
          </div>
        </div>
        <div class="modal-actions" style="justify-content:center;gap:12px;">
          <button class="ghost" type="button" id="stayLoggedIn">Stay Logged In</button>
          <button class="danger" type="button" id="logoutAndClose">Logout & Close</button>
        </div>
      </section>
    </div>
  `;
}

function bindCloseConfirmModal() {
  const modal = document.querySelector('#closeConfirmModal');
  if (!modal) return;

  document.querySelector('#stayLoggedIn')?.addEventListener('click', () => {
    state.showCloseConfirm = false;
    if (window.electronAPI) {
      window.electronAPI.closeResponse('stay');
    }
    reRenderCurrentView();
  });

  document.querySelector('#logoutAndClose')?.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch {}
    state.user = null;
    state.showCloseConfirm = false;
    stopSessionTimer();
    if (window.electronAPI) {
      window.electronAPI.closeResponse('logout-and-close');
    } else {
      renderLogin();
    }
  });
}

function confirmDialog(title, message, confirmText = 'Confirm', confirmClass = 'primary') {
  return new Promise(resolve => {
    const id = 'confirmDialog_' + Date.now();
    const wrap = document.createElement('div');
    wrap.id = id;
    wrap.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);';
    wrap.innerHTML = `
      <div style="background:var(--panel);border-radius:var(--radius-xl);padding:28px;max-width:380px;width:90%;box-shadow:var(--shadow-xl);border:1px solid var(--line);">
        <h3 style="margin:0 0 8px;font-size:16px;">${escapeHtml(title)}</h3>
        <p style="margin:0 0 20px;color:var(--muted);font-size:14px;">${message}</p>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="ghost" id="${id}_cancel">Cancel</button>
          <button class="${confirmClass}" id="${id}_confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const cleanup = (result) => { wrap.remove(); resolve(result); };
    wrap.querySelector(`#${id}_cancel`).addEventListener('click', () => cleanup(false));
    wrap.querySelector(`#${id}_confirm`).addEventListener('click', () => cleanup(true));
  });
}

/* ── Manage Payroll Modal ── */
function managePayrollModalBody(emp, pd) {
  const hasEmp = Boolean(emp);
  const isLocked = hasEmp && emp.payroll_status === 'generated';
  const baleLogs = hasEmp ? state.balePayments.rows.filter(r => Number(r.employee_id) === Number(emp.employee_id)) : [];
  const extraLogs = hasEmp ? state.extraPayments.rows.filter(r => Number(r.employee_id) === Number(emp.employee_id)) : [];
  const attLogs = hasEmp ? state.attendance.rows.filter(r => Number(r.employee_id) === Number(emp.employee_id)) : [];
  const allLogs = hasEmp ? [
    ...attLogs.map(l => ({ ...l, type: 'Attendance', date: l.work_date, amount: l.rate_snapshot, notes: 'Present' })),
    ...baleLogs.map(l => ({ ...l, type: 'C/A Payment', date: l.payment_date })),
    ...extraLogs.map(l => ({ ...l, type: 'Extra Pay', date: l.extra_date })),
  ].sort((a, b) => (b.date || '').localeCompare(a.date || '')) : [];

  const logRows = allLogs.map(log => {
    const logType = log.type;
    if (logType === 'Attendance') {
      return `<tr><td>${log.date}</td><td>${log.type}</td><td><strong>${formatMoney(log.amount)}</strong></td><td>${escapeHtml(log.notes || '-')}</td><td class="actions">—</td></tr>`;
    }
    const resType = logType === 'C/A Payment' || logType === 'Bayad Bale' ? 'bale-payments'
      : 'extra-payments';
    const deleteAction = isLocked
      ? '<span class="muted" title="Cannot delete — payroll is locked" style="font-size:12px;">🔒</span>'
      : `<button class="danger mp-delete-log" data-res="${resType}" data-id="${log.id}">Delete</button>`;
    return `<tr><td>${log.date}</td><td>${log.type}</td><td><strong>${formatMoney(log.amount)}</strong></td><td>${escapeHtml(log.notes || '-')}</td><td class="actions">${deleteAction}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="empty-state"><em>No transactions yet</em></td></tr>';

  const overviewHTML = hasEmp ? `
    <div><span>Days Worked</span><strong>${emp.days}</strong></div><div><span>Daily Rate</span><strong>${formatMoney(emp.rate)}</strong></div><div><span>Total Salary</span><strong>${formatMoney(emp.salary)}</strong></div><div><span>Extra Pay</span><strong>${formatMoney(emp.extra_payment_amount || 0)}</strong></div>
    <div><span>Previous Unpaid</span><strong>${formatMoney(emp.previous_unpaid_balance)}</strong></div><div><span>Previous C/A</span><strong>${formatMoney(emp.previous_bale_balance)}</strong></div><div><span>BALANCE</span><strong class="balance-amount">${formatMoney(emp.balance)}</strong></div><div><span>C/A BAL.</span><strong>${formatMoney(emp.remaining_bale_balance)}</strong></div>
  ` : '<div style="grid-column:1/-1;text-align:center;color:var(--muted);padding:24px 0;">Search and select an employee to view payroll details.</div>';

  const lockBanner = isLocked ? `
    <div class="mp-locked-banner">
      <span class="mp-locked-icon">🔒</span>
      <div><strong>Payroll locked</strong><p>This payroll period was already generated. Unlock to make changes.</p></div>
    </div>` : '';

  return `
    ${lockBanner}
    <div class="pe-overview-grid" id="mpOverviewGrid" style="${hasEmp ? '' : 'border:0;padding:0;'}">${overviewHTML}</div>
    ${hasEmp && !isLocked ? '<button class="primary pe-add-transaction-btn" id="mpAddTransaction">+ Add Transaction</button>' : ''}
    ${hasEmp ? `<div class="pe-history" id="mpHistory"><div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Notes</th><th>Actions</th></tr></thead><tbody>${logRows}</tbody></table></div></div>` : ''}
    <div class="pe-footer" id="mpFooter"><button class="ghost" type="button" id="cancelManagePayroll">Close</button>${hasEmp ? `<div><button class="ghost" type="button" id="mpPreviewPayslip">Preview Payslip</button>${isLocked ? '<button class="primary" type="button" id="mpUnlockPayroll">Unlock Payroll</button>' : '<button class="primary" type="button" id="mpGeneratePayslip">Generate Payslip</button>'}</div>` : ''}</div>
  `;
}

function managePayrollModal() {
  const rows = state.payroll?.rows || [];
  const pd = state.payPeriodDays || 7;
  const emp = state.managePayrollSelected;

  if (!rows.length) return '';

  const today = todayInManila();
  const defaultTransactionDate = emp ? (today >= state.week && today <= addDays(state.week, pd - 1) ? today : state.week) : state.week;
  const transactionTypes = emp ? payrollTransactionTypes(emp) : [];

  return `
    <div class="modal-backdrop" id="managePayrollModal">
      <section class="modal wide-modal payroll-entry-modal">
        <div class="modal-head">
          <div>
            <h2>Manage Payroll</h2>
            <p>${formatShortDate(state.week)} — ${formatShortDate(addDays(state.week, pd - 1))}</p>
          </div>
          <button class="icon-btn" id="closeManagePayrollModal" aria-label="Close">x</button>
        </div>
        <div style="position:relative;margin-bottom:12px;">
          <input id="managePayrollSearch" value="${escapeHtml(state._managePayrollSearch || '')}" placeholder="Search employee..." style="width:100%;box-sizing:border-box;padding:8px 10px;font-size:14px;background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);color:var(--ink);" autocomplete="off">
          <div id="managePayrollDropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--panel);border:1px solid var(--line);max-height:200px;overflow-y:auto;z-index:100;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.15);"></div>
        </div>
        <div id="managePayrollBody">${managePayrollModalBody(emp, pd)}</div>
      </section>
    </div>
  `;
}

function bindManagePayrollModal() {
  const modal = document.querySelector('#managePayrollModal');
  if (!modal) return;

  const close = () => {
    state.showManagePayroll = false;
    state.managePayrollSelected = null;
    state.managePayrollTransModal = false;
    state._managePayrollSearch = '';
    reRenderCurrentView();
  };
  setupModalKeyboard('#managePayrollModal', close);

  const searchInput = document.querySelector('#managePayrollSearch');
  const dropdown = document.querySelector('#managePayrollDropdown');

  const showDropdown = (query) => {
    const rows = state.payroll?.rows || [];
    const q = query.trim().toLowerCase();
    if (!q) { dropdown.style.display = 'none'; return; }
    const matches = rows.filter(r => (r.name || '').toLowerCase().includes(q) || (r.emp_number || '').toLowerCase().includes(q));
    if (!matches.length) { dropdown.style.display = 'none'; return; }
    dropdown.innerHTML = matches.map(r =>
      `<div class="mp-dropdown-item" data-id="${r.employee_id}" style="padding:6px 8px;cursor:pointer;border-bottom:1px solid var(--line);font-size:13px;background:var(--panel);">${escapeHtml(r.name)}${r.emp_number ? ' <span style="color:var(--muted);">(' + escapeHtml(r.emp_number) + ')</span>' : ''}</div>`
    ).join('');
    dropdown.style.display = 'block';
  };

  searchInput?.addEventListener('input', function () {
    if (!this.value.trim()) {
      state.managePayrollSelected = null;
      state._managePayrollSearch = '';
      const body = document.querySelector('#managePayrollBody');
      if (body) body.innerHTML = managePayrollModalBody(null, state.payPeriodDays || 7);
      showDropdown('');
      return;
    }
    showDropdown(this.value);
  });
  searchInput?.addEventListener('keydown', function (e) {
    const items = dropdown.querySelectorAll('.mp-dropdown-item');
    if (!items.length) return;
    let idx = Array.from(items).findIndex(el => el.classList.contains('mp-kb-highlight'));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      idx = idx < items.length - 1 ? idx + 1 : 0;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      idx = idx > 0 ? idx - 1 : items.length - 1;
    } else if (e.key === 'Enter') {
      if (idx >= 0) { e.preventDefault(); items[idx].click(); }
      else if (items.length > 0) { e.preventDefault(); items[0].click(); }
      return;
    } else return;
    items.forEach(el => el.classList.remove('mp-kb-highlight'));
    items[idx].classList.add('mp-kb-highlight');
    items[idx].scrollIntoView({ block: 'nearest' });
  });
  searchInput?.addEventListener('blur', function () {
    setTimeout(() => { dropdown.style.display = 'none'; }, 150);
  });
  searchInput?.addEventListener('focus', function () {
    if (this.value.trim()) showDropdown(this.value);
  });

  dropdown?.addEventListener('mouseover', function (e) {
    const item = e.target.closest('.mp-dropdown-item');
    if (item) { item.style.background = 'var(--soft)'; }
  });
  dropdown?.addEventListener('mouseout', function (e) {
    const item = e.target.closest('.mp-dropdown-item');
    if (item) { item.style.background = 'transparent'; }
  });

  /* ── Event delegation on modal backdrop ── */
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
    const target = event.target;

    /* Close buttons */
    if (target.id === 'closeManagePayrollModal' || target.id === 'cancelManagePayroll') {
      close();
      return;
    }

    /* Transaction modal close */
    if (target.id === 'closeMpTransaction' || target.id === 'cancelMpTransaction' || target.id === 'mpTransactionModal') {
      state.managePayrollTransModal = false;
      document.querySelector('#mpTransactionModal')?.remove();
      const body = document.querySelector('#managePayrollBody');
      if (body) body.innerHTML = managePayrollModalBody(state.managePayrollSelected, state.payPeriodDays || 7);
      return;
    }

    /* Delete log */
    const deleteBtn = target.closest('.mp-delete-log');
    if (deleteBtn) {
      const empId = state.managePayrollSelected?.employee_id;
      if (!empId) return;
      (async () => {
        const confirmed = await confirmDialog('Delete this transaction?', 'This will remove the transaction permanently.', 'Delete', 'danger');
        if (!confirmed) return;
        try {
          const url = `/api/${deleteBtn.dataset.res}/${deleteBtn.dataset.id}`;
          console.log('DELETE request:', url);
          const res = await api(url, { method: 'DELETE' });
          console.log('DELETE response:', res);
          if (res.error) { console.error('Delete returned error:', res.error); showToast(res.error, 'error'); return; }
          const pd = state.payPeriodDays || 7;
          const [payData, extraData, baleData] = await Promise.all([
            api(`/api/payroll?week=${state.payrollWeek}&today=${state.currentDate}&periodDays=${pd}`),
            api(`/api/extra-payments?week=${state.payrollWeek}&periodDays=${pd}`),
            api(`/api/bale-payments?week=${state.payrollWeek}&periodDays=${pd}`)
          ]);
          state.payroll = payData;
          state.extraPayments = extraData;
          state.balePayments = baleData;
          const fresh = (state.payroll?.rows || []).find(r => Number(r.employee_id) === Number(empId));
          if (fresh) state.managePayrollSelected = fresh;
          const name = state._managePayrollSearch;
          const body = document.querySelector('#managePayrollBody');
          if (body) body.innerHTML = managePayrollModalBody(fresh || state.managePayrollSelected, pd);
          const inp = document.querySelector('#managePayrollSearch');
          if (inp) { inp.value = name; }
          showToast('Transaction deleted.', 'success');
        } catch (e) { console.error('Delete error:', e); showToast(e.message, 'error'); }
      })();
      return;
    }

    /* Preview Payslip (direct, no navigation) */
    if (target.id === 'mpPreviewPayslip') {
      const emp = state.managePayrollSelected;
      if (!emp) return;
      const row = state.payroll?.rows?.find(r => Number(r.employee_id) === Number(emp.employee_id)) || emp;
      if (row?.employee_id) {
        state._previewFromManagePayroll = true;
        state._previewEmployee = { ...emp };
        state.showManagePayroll = false;
        state.managePayrollSelected = null;
        state.managePayrollTransModal = false;
        renderPayslip(row, { preview: true });
      } else {
        showToast('No payroll data available for this employee.', 'error');
      }
      return;
    }

    /* Generate Payslip (direct, no navigation) */
    if (target.id === 'mpGeneratePayslip') {
      (async () => {
        const emp = state.managePayrollSelected;
        if (!emp) return;
        const confirmed = await new Promise(resolve => {
          const backdrop = document.createElement('div');
          backdrop.className = 'modal-backdrop';
          backdrop.id = 'mpGenerateConfirmModal';
          backdrop.innerHTML = `
            <section class="modal confirm-modal" style="max-width:380px;">
              <div class="modal-head">
                <div><h2>Generate Payslip?</h2><p>This will <strong>LOCK</strong> this payroll period and auto-record salary as paid. No more changes allowed.</p></div>
                <button class="icon-btn" id="mpCloseGenerateConfirm" aria-label="Close">x</button>
              </div>
              <div class="modal-actions">
                <button class="ghost" id="mpCancelGenerate">Cancel</button>
                <button class="primary" id="mpConfirmGenerate">Generate & Lock</button>
              </div>
            </section>`;
          document.body.appendChild(backdrop);
          const cleanup = (result) => { backdrop.remove(); resolve(result); };
          backdrop.querySelector('#mpCloseGenerateConfirm').addEventListener('click', () => cleanup(false));
          backdrop.querySelector('#mpCancelGenerate').addEventListener('click', () => cleanup(false));
          backdrop.querySelector('#mpConfirmGenerate').addEventListener('click', () => cleanup(true));
          backdrop.addEventListener('click', e => { if (e.target === backdrop) cleanup(false); });
        });
        if (!confirmed) return;
        try {
          const res = await api(`/api/payroll/${emp.employee_id}/generate`, {
            method: 'POST',
            body: JSON.stringify({ weekStart: state.week, payPeriodDays: state.payPeriodDays })
          });
          if (res.error) { alert(res.error); return; }
          await refresh();
          const fresh = (state.payroll?.rows || []).find(r => Number(r.employee_id) === Number(emp.employee_id)) || emp;
          state.showManagePayroll = false;
          state.managePayrollSelected = null;
          state.managePayrollTransModal = false;
          state._managePayrollSearch = '';
          state._generatedPayslip = fresh;
          showToast('Payslip generated and salary auto-paid.');
          reRenderCurrentView();
        } catch (e) {
          showToast(e.message, 'error');
        }
      })();
      return;
    }

    /* Add Transaction */
    if (target.id === 'mpAddTransaction') {
      state.managePayrollTransModal = true;
      const existing = document.querySelector('#mpTransactionModal');
      if (existing) existing.remove();
      modal.insertAdjacentHTML('beforeend', managePayrollTransModalHTML(state.managePayrollSelected));
      bindMiniCalendar('mpTransDate', () => {});
      updateMpTransactionLimits();
      return;
    }

    /* Unlock Payroll (direct, no navigation) */
    if (target.id === 'mpUnlockPayroll') {
      (async () => {
        const emp = state.managePayrollSelected;
        if (!emp) return;
        const confirmed = await confirmDialog(
          'Unlock this payroll?',
          'This will allow changes again and remove the auto-paid salary for this period.',
          'Unlock',
          'primary'
        );
        if (!confirmed) return;
        try {
          const res = await api(`/api/payroll/${emp.employee_id}/unlock`, {
            method: 'POST',
            body: JSON.stringify({ weekStart: state.week })
          });
          if (res.error) { showToast(res.error, 'error'); return; }
          showToast('Payroll unlocked. You can manage transactions again.');
          await refresh();
          const fresh = (state.payroll?.rows || []).find(r => Number(r.employee_id) === Number(emp.employee_id));
          if (fresh) state.managePayrollSelected = fresh;
          const body = document.querySelector('#managePayrollBody');
          if (body) body.innerHTML = managePayrollModalBody(fresh || emp, state.payPeriodDays || 7);
        } catch (e) {
          showToast(e.message, 'error');
        }
      })();
      return;
    }
  });

  /* ── Dropdown item selection via mousedown on modal (fires before blur) ── */
  modal.addEventListener('mousedown', function (e) {
    const item = e.target.closest('.mp-dropdown-item');
    if (!item) return;
    e.preventDefault();
    const id = item.dataset.id;
    const found = state.payroll?.rows?.find(r => Number(r.employee_id) === Number(id));
    if (!found) return;
    state.managePayrollSelected = found;
    state._managePayrollSearch = found.name;
    dropdown.style.display = 'none';
    searchInput.value = found.name;
    searchInput.blur();
    const body = document.querySelector('#managePayrollBody');
    if (body) body.innerHTML = managePayrollModalBody(found, state.payPeriodDays || 7);
  });

  /* ── Transaction form submit (delegation on modal) ── */
  modal.addEventListener('submit', async event => {
    const form = event.target.closest('#mpTransForm');
    if (!form) return;
    event.preventDefault();
    const emp = state.managePayrollSelected;
    if (!emp) return;
    const transactionTypes = payrollTransactionTypes(emp);
    const errorBox = document.querySelector('#mpTransError');
    const submitButton = form.querySelector('button[type="submit"]');
    errorBox.textContent = '';
    const formData = new FormData(form);
    const type = formData.get('type');
    const option = transactionTypes.find(t => t.key === type);
    if (!option) return;
    const amount = Number(formData.get('amount'));
    if (option.maxAmt !== null && amount > Number(option.maxAmt)) {
      errorBox.textContent = `Amount exceeds maximum (${formatMoney(option.maxAmt)})`;
      return;
    }
    const payload = { employee_id: formData.get('employee_id'), amount, notes: formData.get('notes') };
    payload[option.dateField] = formData.get('transaction_date');
    submitButton.disabled = true;
    try {
      const res = await api(option.endpoint, { method: 'POST', body: JSON.stringify(payload) });
      if (res.error) { errorBox.textContent = res.error; submitButton.disabled = false; return; }
      state.managePayrollTransModal = false;
      document.querySelector('#mpTransactionModal')?.remove();
      showToast('Transaction saved.', 'success');
      const pd = state.payPeriodDays || 7;
      const [payData, extraData, baleData] = await Promise.all([
        api(`/api/payroll?week=${state.payrollWeek}&today=${state.currentDate}&periodDays=${pd}`),
        api(`/api/extra-payments?week=${state.payrollWeek}&periodDays=${pd}`),
        api(`/api/bale-payments?week=${state.payrollWeek}&periodDays=${pd}`)
      ]);
      state.payroll = payData;
      state.extraPayments = extraData;
      state.balePayments = baleData;
      const fresh = (state.payroll?.rows || []).find(r => Number(r.employee_id) === Number(emp.employee_id));
      if (fresh) state.managePayrollSelected = fresh;
      const body = document.querySelector('#managePayrollBody');
      if (body) body.innerHTML = managePayrollModalBody(fresh || emp, pd);
      const inp = document.querySelector('#managePayrollSearch');
      if (inp) inp.value = state._managePayrollSearch || '';
    } catch (e) { errorBox.textContent = e.message; submitButton.disabled = false; }
  });

  /* ── Transaction type/amount change limits (delegation on document) ── */
  document.addEventListener('change', event => {
    if (event.target.id === 'mpTransactionType') updateMpTransactionLimits();
  });
  document.addEventListener('input', event => {
    if (event.target.closest('#mpTransForm') && event.target.name === 'amount') updateMpTransactionLimits();
  });
}

function updateMpTransactionLimits() {
  const emp = state.managePayrollSelected;
  if (!emp) return;
  const transactionTypes = payrollTransactionTypes(emp);
  const option = transactionTypes.find(t => t.key === document.querySelector('#mpTransactionType')?.value);
  const max = option?.maxAmt;
  const amount = document.querySelector('#mpTransForm [name="amount"]');
  const pendingAmount = Math.max(0, Number(amount?.value) || 0);
  if (amount) amount.max = max || '';
  const limits = document.querySelector('#mpTransactionLimits');
  const summaries = {
    pay: [['Remaining', formatMoney(Math.max(0, Number(emp.balance || 0) - pendingAmount))]],
    ca: [['Bale Balance Now', formatMoney(emp.remaining_bale_balance)], ['New Bale Balance (Preview)', formatMoney(Number(emp.remaining_bale_balance || 0) + pendingAmount)]],
    bale: [['Remaining on Salary', formatMoney(Math.max(0, Number(emp.balance || 0) - pendingAmount))], ['Remaining Bale (debt)', formatMoney(Math.max(0, Number(emp.remaining_bale_balance || 0) - pendingAmount))]],
    extra: [['Extra Pay Now', formatMoney(Number(emp.extra_payment_amount || 0))], ['New Extra Pay', formatMoney(Number(emp.extra_payment_amount || 0) + pendingAmount)]]
  };
  if (limits) limits.innerHTML = (summaries[option?.key] || []).map(([l, v]) => `<div><span>${l}</span><strong>${v}</strong></div>`).join('');
}

function managePayrollTransModalHTML(emp) {
  if (!emp) return '';
  const pd = state.payPeriodDays || emp.pay_period_days || 7;
  const today = todayInManila();
  const defaultTransactionDate = today >= state.week && today <= addDays(state.week, pd - 1) ? today : state.week;
  const transactionTypes = payrollTransactionTypes(emp);
  return `
    <div class="modal-backdrop pe-transaction-backdrop" id="mpTransactionModal">
      <section class="modal pe-transaction-modal" role="dialog" aria-modal="true" aria-labelledby="mpTransTitle">
        <div class="modal-head">          <h2 id="mpTransTitle">Add Transaction</h2><button class="icon-btn" id="closeMpTransaction" aria-label="Close">x</button></div>
        <form id="mpTransForm" class="pe-transaction-form" novalidate>
          <input type="hidden" name="employee_id" value="${emp.employee_id}">
          <label>Type<select name="type" id="mpTransactionType">${transactionTypes.map(t => `<option value="${t.key}">${t.label}</option>`).join('')}</select></label>
          <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00"></label>
          <label>Date${miniDatePickerHTML('mpTransDate', '', defaultTransactionDate, { inputName: 'transaction_date' })}</label>
          <label>Notes<input name="notes" placeholder="Optional remarks"></label>
          <div class="pe-transaction-limits" id="mpTransactionLimits"></div>
          <div class="error error-box" id="mpTransError"></div>
          <div class="modal-actions"><button class="ghost" type="button" id="cancelMpTransaction">Cancel</button><button class="primary" type="submit" id="mpTransSubmit">Save</button></div>
        </form>
      </section>
    </div>`;
}

/* ── Registration Approval Modals ── */
function approveRegistrationModal() {
  const reg = state._approveRegistration;
  if (!reg) return '';
  const faceUrl = reg.face_image ? `/attendance-faces/${encodeURIComponent(reg.face_image)}` : '';
  return `
    <div class="modal-backdrop" id="approveRegistrationModal">
      <section class="modal confirm-modal">
        <div class="modal-head">
          <div>
            <h2>Approve Registration</h2>
            <p>Approve <strong>${escapeHtml(reg.name)}</strong> to create their payroll employee record.</p>
          </div>
          <button class="icon-btn" id="closeApproveRegistration" aria-label="Close">x</button>
        </div>
        <div class="modal-body">
          ${faceUrl ? `<div style="text-align:center;margin-bottom:12px;"><img src="${faceUrl}" alt="photo" class="reg-face-thumb" style="width:96px;height:96px;" onerror="this.style.display='none'"></div>` : ''}
          <div class="reg-info-grid">
            <span>Name</span><strong>${escapeHtml(reg.name)}</strong>
            <span>Email</span><strong>${escapeHtml(reg.email || '—')}</strong>
            <span>Phone</span><strong>${escapeHtml(reg.phone || '—')}</strong>
            <span>Registered</span><strong>${formatShortDate(reg.registered_at)}</strong>
          </div>
          <form id="approveRegistrationForm" novalidate>
            <label>Daily Rate (₱)<input name="rate" type="number" min="500" step="0.01" required placeholder="e.g. 650"></label>
            <div class="error error-box" id="approveRegError"></div>
            <div class="modal-actions">
              <button class="ghost" type="button" id="cancelApproveRegistration">Cancel</button>
              <button class="primary" type="submit" id="confirmApproveRegistration">Approve & Create Employee</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

function bindApproveRegistrationModal() {
  const modal = document.querySelector('#approveRegistrationModal');
  if (!modal) return;
  const close = () => {
    state._approveRegistration = null;
    reRenderCurrentView();
  };
  setupModalKeyboard('#approveRegistrationModal', close);
  document.querySelector('#closeApproveRegistration')?.addEventListener('click', close);
  document.querySelector('#cancelApproveRegistration')?.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.querySelector('#approveRegistrationForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const reg = state._approveRegistration;
    if (!reg) return close();
    const form = e.target;
    const rate = form.elements.rate.value;
    const btn = document.querySelector('#confirmApproveRegistration');
    const errEl = document.querySelector('#approveRegError');
    loadingButton(btn, true);
    try {
      await api(`/api/registrations/${reg.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ rate })
      });
      state._approveRegistration = null;
      await loadRegistrations();
      reRenderCurrentView();
      showToast(`${reg.name} approved and added to employees.`);
    } catch (error) {
      if (errEl) errEl.textContent = error.message;
    } finally {
      loadingButton(btn, false);
    }
  });
}

function rejectRegistrationModal() {
  const reg = state._rejectRegistration;
  if (!reg) return '';
  return `
    <div class="modal-backdrop" id="rejectRegistrationModal">
      <section class="modal confirm-modal">
        <div class="modal-head">
          <div>
            <h2>Reject Registration</h2>
            <p>Reject <strong>${escapeHtml(reg.name)}</strong>? They will be notified in the app.</p>
          </div>
          <button class="icon-btn" id="closeRejectRegistration" aria-label="Close">x</button>
        </div>
        <div class="modal-body">
          <form id="rejectRegistrationForm" novalidate>
            <label>Reason (sent to the employee)<textarea name="notes" rows="3" maxlength="300" placeholder="e.g. Duplicate registration, invalid details..."></textarea></label>
            <div class="modal-actions">
              <button class="ghost" type="button" id="cancelRejectRegistration">Cancel</button>
              <button class="danger" type="submit" id="confirmRejectRegistration">Reject</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

function bindRejectRegistrationModal() {
  const modal = document.querySelector('#rejectRegistrationModal');
  if (!modal) return;
  const close = () => {
    state._rejectRegistration = null;
    reRenderCurrentView();
  };
  setupModalKeyboard('#rejectRegistrationModal', close);
  document.querySelector('#closeRejectRegistration')?.addEventListener('click', close);
  document.querySelector('#cancelRejectRegistration')?.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.querySelector('#rejectRegistrationForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const reg = state._rejectRegistration;
    if (!reg) return close();
    const notes = e.target.elements.notes.value;
    const btn = document.querySelector('#confirmRejectRegistration');
    loadingButton(btn, true);
    try {
      await api(`/api/registrations/${reg.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ notes })
      });
      state._rejectRegistration = null;
      await loadRegistrations();
      reRenderCurrentView();
      showToast(`${reg.name} rejected.`);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      loadingButton(btn, false);
    }
  });
}

function resetDeviceModal() {
  const reg = state._resetDeviceRegistration;
  if (!reg) return '';
  return `
    <div class="modal-backdrop" id="resetDeviceModal">
      <section class="modal confirm-modal">
        <div class="modal-head">
          <div>
            <h2>Reset Device Binding</h2>
            <p>Unbind the phone of <strong>${escapeHtml(reg.name)}</strong>?</p>
          </div>
          <button class="icon-btn" id="closeResetDevice" aria-label="Close">x</button>
        </div>
        <form id="resetDeviceForm">
          <div class="modal-body">
            <p class="muted">
              The account is currently bound to the device that registered it
              (GCash-style). Resetting lets the employee sign in from a new
              phone — the <em>next device that signs in</em> becomes the new
              bound device.
            </p>
          </div>
          <div class="modal-foot">
            <button type="button" class="ghost" id="cancelResetDevice">Cancel</button>
            <button type="submit" class="btn danger" id="confirmResetDevice">Reset Device</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function bindResetDeviceModal() {
  const modal = document.querySelector('#resetDeviceModal');
  if (!modal) return;
  const close = () => {
    state._resetDeviceRegistration = null;
    reRenderCurrentView();
  };
  setupModalKeyboard('#resetDeviceModal', close);
  document.querySelector('#closeResetDevice')?.addEventListener('click', close);
  document.querySelector('#cancelResetDevice')?.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.querySelector('#resetDeviceForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const reg = state._resetDeviceRegistration;
    if (!reg) return close();
    const btn = document.querySelector('#confirmResetDevice');
    loadingButton(btn, true);
    try {
      await api(`/api/registrations/${reg.id}/reset-device`, {
        method: 'POST',
        body: JSON.stringify({})
      });
      state._resetDeviceRegistration = null;
      await loadRegistrations();
      reRenderCurrentView();
      showToast(`Device binding cleared for ${reg.name}.`);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      loadingButton(btn, false);
    }
  });
}

/* ── Payroll Review & Accept Modal ── */
function payrollReviewModal() {
  const summary = state.payroll?.summary || {};
  const review = state.payroll?.review || { accepted: false };
  const rows = state.payroll?.rows || [];
  const generatedCount = rows.filter(r => r.payroll_status === 'generated').length;
  const totalCount = rows.length;
  const isAdmin = state.user.role === 'admin';
  const allGenerated = totalCount > 0 && generatedCount === totalCount;
  const pd = state.payPeriodDays || 7;
  const statusLabel = (row) => row.payroll_status === 'generated'
    ? (row.payment_status === 'paid' ? 'Paid/Generated' : row.payment_status === 'partial' ? 'Partial/Generated' : 'Locked')
    : row.payment_status === 'paid' ? 'Paid' : row.payment_status === 'partial' ? 'Partial' : 'Unpaid';
  const statusClass = (row) => row.payroll_status === 'generated' ? 'generated' : row.payment_status;
  const previewHTML = (row) => `
    <div class="review-preview">
      <div class="review-preview-head">
        <strong>${escapeHtml(row.name)}</strong>
        <span>No.: ${escapeHtml(row.emp_number || '')}</span>
        <span>Rate: ${formatMoney(row.rate)}/day</span>
        <span>Days: ${row.days ?? 0}</span>
      </div>
      <div class="review-preview-grid">
        <span>Salary</span><strong>${formatMoney(row.salary)}</strong>
        <span>Extra Pay</span><strong>${formatMoney(row.extra_payment_amount || 0)}</strong>
        <span>Total Earnings</span><strong>${formatMoney(Number(row.salary || 0) + Number(row.extra_payment_amount || 0))}</strong>
        <span>Paid</span><strong>${formatMoney(row.paid_amount)}</strong>
        <span>Balance</span><strong>${formatMoney(row.balance)}</strong>
        <span>C/A Balance</span><strong>${formatMoney(row.remaining_bale_balance)}</strong>
        <span>Total C/A</span><strong>${formatMoney(row.total_bale)}</strong>
        <span>Status</span><strong>${statusLabel(row)}</strong>
      </div>
    </div>`;
  return `
    <div class="modal-backdrop" id="payrollReviewModal">
      <section class="modal wide-modal review-payroll-modal">
        <div class="modal-head">
          <div>
            <h2>Review & Accept Payroll</h2>
            <p>${state.week} to ${addDays(state.week, pd - 1)} — review each payslip below, then accept to release payment and enable Bulk Print.</p>
          </div>
          <button class="icon-btn" id="closePayrollReview" aria-label="Close">x</button>
        </div>
        <div class="reg-info-grid">
          <span>Employees</span><strong>${summary.employees ?? rows.length}</strong>
          <span>Payslips Generated</span><strong>${generatedCount}/${totalCount}</strong>
          <span>Total Salary</span><strong>${formatMoney(summary.totalSalary)}</strong>
          <span>Total Paid</span><strong>${formatMoney(summary.totalPaidAmount)}</strong>
          <span>Total Balance</span><strong>${formatMoney(summary.totalBalance)}</strong>
          <span>Total C/A</span><strong>${formatMoney(summary.totalBaleBalance)}</strong>
        </div>
        ${review.accepted ? `<div class="review-banner review-banner-ok" style="margin:12px 0 0;"><span>Already accepted by ${escapeHtml(review.accepted_by_username || 'admin')} · ${formatShortDate(review.accepted_at)}.</span></div>` : ''}
        ${!allGenerated ? `<div class="error-box" style="margin-top:12px;">Not all payslips are generated yet (${generatedCount}/${totalCount}). Generate every payslip first.</div>` : ''}
        <div class="review-table-wrap">
          <table class="payroll-table review-table">
            <thead>
              <tr>
                <th>No.</th><th>Name</th><th>Days</th><th>Salary</th><th>Extra</th><th>Paid</th><th>Balance</th><th>C/A Bal.</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(row => `
                <tr class="review-row status-${row.payment_status}">
                  <td>${escapeHtml(row.emp_number || '')}</td>
                  <td>${escapeHtml(row.name)}</td>
                  <td>${row.days ?? 0}</td>
                  <td><strong>${formatMoney(row.salary)}</strong></td>
                  <td>${formatMoney(row.extra_payment_amount || 0)}</td>
                  <td>${formatMoney(row.paid_amount)}</td>
                  <td>${formatMoney(row.balance)}</td>
                  <td>${formatMoney(row.remaining_bale_balance)}</td>
                  <td><span class="badge ${statusClass(row)} status-badge">${statusLabel(row)}</span></td>
                  <td><button class="ghost review-preview-btn" type="button" data-review-preview="${row.employee_id}">Preview</button></td>
                </tr>
                <tr class="review-preview-row" data-review-preview-body="${row.employee_id}" hidden>
                  <td colspan="10">${previewHTML(row)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="modal-actions">
          <button class="ghost" type="button" id="cancelPayrollReview">Cancel</button>
          <button class="primary" type="button" id="confirmPayrollReview" ${allGenerated && isAdmin ? '' : 'disabled'}>${review.accepted ? 'Re-accept & Release Payments' : 'Accept All & Release Payments'}</button>
        </div>
      </section>
    </div>
  `;
}

function bindPayrollReviewModal() {
  const modal = document.querySelector('#payrollReviewModal');
  if (!modal) return;
  const close = () => {
    state._payrollReview = null;
    reRenderCurrentView();
  };
  setupModalKeyboard('#payrollReviewModal', close);
  document.querySelector('#closePayrollReview')?.addEventListener('click', close);
  document.querySelector('#cancelPayrollReview')?.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.querySelectorAll('.review-preview-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.reviewPreview;
      const body = modal.querySelector(`[data-review-preview-body="${id}"]`);
      if (body) {
        body.hidden = !body.hidden;
        btn.textContent = body.hidden ? 'Preview' : 'Hide';
      }
    });
  });
  document.querySelector('#confirmPayrollReview')?.addEventListener('click', async () => {
    const btn = document.querySelector('#confirmPayrollReview');
    loadingButton(btn, true);
    try {
      const resp = await api('/api/payroll/review', {
        method: 'POST',
        body: JSON.stringify({ week: state.week, periodDays: state.payPeriodDays || 7 })
      });
      state._payrollReview = null;
      await refresh();
      showToast(resp.auto_paid > 0
        ? `Payroll accepted — ${resp.auto_paid} payslip${resp.auto_paid === 1 ? '' : 's'} paid, Bulk Print enabled.`
        : 'Payroll accepted — Bulk Print is now enabled.');
    } catch (error) {
      showToast(error.message, 'error');
      loadingButton(btn, false);
    }
  });
}

/* ── Edit Attendance Times (admin) ── */
function editAttendanceModal(row) {
  if (!row) return '';
  return `
    <div class="modal-backdrop" id="editAttendanceModal">
      <section class="modal confirm-modal">
        <div class="modal-head">
          <div>
            <h2>Edit Attendance Times</h2>
            <p>${escapeHtml(row.employee)} — ${escapeHtml(row.workDate)}</p>
          </div>
          <button class="icon-btn" id="closeEditAttendance" aria-label="Close">x</button>
        </div>
        <div class="modal-body">
          <label style="display:block;">Time In<input type="time" id="editAttendanceTimeIn" value="${escapeHtml(row.timeIn || '')}" style="margin-top:4px;"></label>
          <label style="display:block;margin-top:12px;">Time Out<input type="time" id="editAttendanceTimeOut" value="${escapeHtml(row.timeOut || '')}" style="margin-top:4px;"></label>
          <p class="muted" style="margin-top:10px;font-size:12px;">Leave a field empty to clear that time. Changes are synced to the employee app.</p>
        </div>
        <div class="modal-actions">
          <button class="ghost" type="button" id="cancelEditAttendance">Cancel</button>
          <button class="primary" type="button" id="saveEditAttendance">Save Times</button>
        </div>
      </section>
    </div>
  `;
}

function bindEditAttendanceModal() {
  const modal = document.querySelector('#editAttendanceModal');
  if (!modal) return;

  const close = () => {
    state.editingAttendance = null;
    reRenderCurrentView();
  };

  setupModalKeyboard('#editAttendanceModal', close);
  document.querySelector('#closeEditAttendance').addEventListener('click', close);
  document.querySelector('#cancelEditAttendance').addEventListener('click', close);
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });
  document.querySelector('#saveEditAttendance').addEventListener('click', async () => {
    const timeIn = document.querySelector('#editAttendanceTimeIn').value;
    const timeOut = document.querySelector('#editAttendanceTimeOut').value;
    const saveBtn = document.querySelector('#saveEditAttendance');
    loadingButton(saveBtn, true);
    try {
      await api(`/api/attendance/${state.editingAttendance.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          work_date: state.editingAttendance.workDate,
          time_in: timeIn,
          time_out: timeOut
        })
      });
      showToast('Attendance times updated.');
      state.editingAttendance = null;
      await partialRefresh(['attendance', 'payroll']);
    } catch (error) {
      showToast(error.message || 'Failed to update attendance times.', 'error');
      loadingButton(saveBtn, false);
    }
  });
}

/* ── Broadcast Announcement (admin → all employees) ── */
function broadcastModal() {
  return `
    <div class="modal-backdrop" id="broadcastModal">
      <section class="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="broadcastTitle">
        <div class="modal-head">
          <div>
            <h2 id="broadcastTitle">Send Announcement</h2>
            <p>Broadcast a push notification to all employees with the app installed.</p>
          </div>
          <button class="icon-btn" id="closeBroadcastModal" aria-label="Close">x</button>
        </div>
        <div class="form-grid">
          <label>Title<input id="broadcastTitleInput" maxlength="160" placeholder="e.g. Payday tomorrow"></label>
          <label>Message<textarea id="broadcastMessage" rows="4" maxlength="2000" placeholder="Type your announcement..."></textarea></label>
        </div>
        <p class="field-hint" style="margin-top:14px;">Ito ay ipapadala bilang push notification sa lahat ng employees na may naka-install na app.</p>
        <div class="modal-actions">
          <button class="ghost" type="button" id="cancelBroadcast">Cancel</button>
          <button class="primary" type="button" id="sendBroadcast">Send to All</button>
        </div>
      </section>
    </div>
  `;
}

function bindBroadcastModal() {
  const modal = document.querySelector('#broadcastModal');
  if (!modal) return;

  const close = () => {
    state.showBroadcast = false;
    reRenderCurrentView();
  };

  setupModalKeyboard('#broadcastModal', close);
  document.querySelector('#closeBroadcastModal').addEventListener('click', close);
  document.querySelector('#cancelBroadcast').addEventListener('click', close);
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });
  document.querySelector('#sendBroadcast').addEventListener('click', async () => {
    const title = document.querySelector('#broadcastTitleInput').value.trim();
    const message = document.querySelector('#broadcastMessage').value.trim();
    if (!title || !message) {
      showToast('Title and message are required.', 'error');
      return;
    }
    const btn = document.querySelector('#sendBroadcast');
    loadingButton(btn, true);
    try {
      const resp = await api('/api/announcements', {
        method: 'POST',
        body: JSON.stringify({ title, message })
      });
      const sent = Number(resp.sent || 0);
      showToast(sent > 0
        ? `Announcement sent to ${sent} device${sent === 1 ? '' : 's'}.`
        : 'Announcement saved (no devices online right now).');
      state.showBroadcast = false;
      await refresh();
    } catch (error) {
      showToast(error.message || 'Failed to send announcement.', 'error');
      loadingButton(btn, false);
    }
  });
}
