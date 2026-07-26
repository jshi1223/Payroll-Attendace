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
        <div class="modal-actions">
          <button class="ghost" type="button" id="cancelDelete">Cancel</button>
          <button class="danger" type="button" id="confirmDelete">${confirmText}</button>
        </div>
      </section>
    </div>
  `;
}

function bindConfirmDeleteModal() {
  const modal = document.querySelector('#confirmDeleteModal');
  if (!modal) return;

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
    { key: 'pay', label: 'Bayad Sahod', endpoint: '/api/salary-payments', dateField: 'payment_date', maxAmt: emp.balance },
    { key: 'ca', label: 'Bale', endpoint: '/api/cash-advances', dateField: 'advance_date', maxAmt: null },
    { key: 'bale', label: 'Bayad Bale', endpoint: '/api/bale-payments', dateField: 'payment_date', maxAmt: emp.remaining_bale_balance },
    { key: 'extra', label: 'Dagdag Sahod', endpoint: '/api/extra-payments', dateField: 'extra_date', maxAmt: null }
  ];
}

function payrollEntryModal(employee) {
  const emp = employee;
  const pd = emp.pay_period_days || state.payPeriodDays || 7;

  const salaryLogs = state.salaryPayments.rows.filter(r => Number(r.employee_id) === Number(emp.employee_id));
  const caLogs = state.advances.rows.filter(r => Number(r.employee_id) === Number(emp.employee_id));
  const baleLogs = state.balePayments.rows.filter(r => Number(r.employee_id) === Number(emp.employee_id));
  const extraLogs = state.extraPayments.rows.filter(r => Number(r.employee_id) === Number(emp.employee_id));

  const allLogs = [
    ...salaryLogs.map(l => ({ ...l, type: 'Bayad Sahod', date: l.payment_date })),
    ...caLogs.map(l => ({ ...l, type: 'Bale', date: l.advance_date })),
    ...baleLogs.map(l => ({ ...l, type: 'Bayad Bale', date: l.payment_date })),
    ...extraLogs.map(l => ({ ...l, type: 'Dagdag Sahod', date: l.extra_date })),
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const transactionTypes = payrollTransactionTypes(emp);
  const today = todayInManila();
  const defaultTransactionDate = today >= state.week && today <= addDays(state.week, pd - 1) ? today : state.week;
  const transactionModal = state.payrollTransactionModal ? `
    <div class="modal-backdrop pe-transaction-backdrop" id="payrollTransactionModal">
      <section class="modal pe-transaction-modal" role="dialog" aria-modal="true" aria-labelledby="peTransactionTitle">
        <div class="modal-head"><h2 id="peTransactionTitle">Magdagdag ng Transaction</h2><button class="icon-btn" id="closePayrollTransactionModal" aria-label="Close">x</button></div>
        <form id="peTransForm" class="pe-transaction-form" novalidate>
          <input type="hidden" name="employee_id" value="${emp.employee_id}">
          <label>Uri<select name="type" id="peTransactionType">${transactionTypes.map(t => `<option value="${t.key}">${t.key === 'ca' ? 'Cash Advance (Bale/Utang)' : t.label}</option>`).join('')}</select></label>
          <label>Halaga<input name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00"></label>
          <label>Petsa<input name="transaction_date" type="date" value="${defaultTransactionDate}" min="${state.week}" max="${addDays(state.week, pd - 1)}" required></label>
          <label>Puna<input name="notes" placeholder="Optional na remarks"></label>
          <div class="pe-transaction-limits" id="peTransactionLimits"></div>
          <div class="error error-box" id="peTransError"></div>
          <div class="modal-actions"><button class="ghost" type="button" id="cancelPayrollTransaction">Kanselahin</button><button class="primary" type="submit" id="peTransSubmit">I-save</button></div>
        </form>
      </section>
    </div>` : '';

  return `
    <div class="modal-backdrop" id="payrollEntryModal">
      <section class="modal wide-modal payroll-entry-modal">
        <div class="modal-head">
          <div>
            <h2>Pamahalaan ang Sahod</h2>
            <p><strong>${escapeHtml(emp.name)}</strong> · ${formatShortDate(state.week)} — ${formatShortDate(addDays(state.week, pd - 1))}</p>
          </div>
          <button class="icon-btn" id="closePayrollEntryModal" aria-label="Close">x</button>
        </div>
        <div class="pe-overview-grid">
          <div><span>Araw ng Pasok</span><strong>${emp.days}</strong></div><div><span>Arawan</span><strong>${formatMoney(emp.rate)}</strong></div><div><span>Kabuuang Sahod</span><strong>${formatMoney(emp.salary)}</strong></div><div><span>Dagdag Sahod</span><strong>${formatMoney(emp.extra_payment_amount || 0)}</strong></div>
          <div><span>Natitira (Dati)</span><strong>${formatMoney(emp.previous_unpaid_balance)}</strong></div><div><span>Utang (Dati)</span><strong>${formatMoney(emp.previous_bale_balance)}</strong></div><div><span>NATITIRA</span><strong class="balance-amount">${formatMoney(emp.balance)}</strong></div><div><span>BALENSA</span><strong>${formatMoney(emp.remaining_bale_balance)}</strong></div>
        </div>
        <button class="primary pe-add-transaction-btn" id="openPayrollTransactionModal">+ Magdagdag</button>
        <div class="pe-history"><div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Notes</th><th>Actions</th></tr></thead><tbody>${allLogs.map(log => {
          const resType = log.type === 'Bayad Sahod' ? 'salary-payments' : log.type === 'Bale' ? 'cash-advances' : log.type === 'Bayad Bale' ? 'bale-payments' : 'extra-payments';
          return `<tr><td>${log.date}</td><td>${log.type === 'Bale' ? 'Cash Advance (Bale/Utang)' : log.type}</td><td><strong>${formatMoney(log.amount)}</strong></td><td>${escapeHtml(log.notes || '-')}</td><td class="actions"><button class="danger pe-delete-log" data-res="${resType}" data-id="${log.id}">Burahin</button></td></tr>`;
        }).join('') || '<tr><td colspan="5" class="empty-state"><em>Wala pang transactions</em></td></tr>'}</tbody></table></div></div>
        <div class="pe-totals"><div><span>Kabuuang Kita</span><strong>${formatMoney(Number(emp.salary || 0) + Number(emp.extra_payment_amount || 0))}</strong></div><div><span>Kabuuang Natanggap</span><strong>${formatMoney(emp.paid_amount)}</strong></div><div><span>Kabuuang Bayad Bale</span><strong>${formatMoney((emp.total_bale || 0) - (emp.remaining_bale_balance || 0))}</strong></div><div class="pe-net-balance"><span>Natitira Pang Balance</span><strong>${formatMoney(emp.balance)}</strong></div></div>
        <div class="pe-footer"><button class="ghost" type="button" id="cancelPayrollEntry">Kanselahin</button><div><button class="ghost" type="button" id="pePreviewPayslip">Tingnan Payslip</button><button class="primary" type="button" id="peGeneratePayslip">Gumawa ng Payslip</button></div></div>
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
  const pd = emp.pay_period_days || state.payPeriodDays || 7;
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

  const setTransactionLimit = () => {
    const option = transactionTypes.find(t => t.key === document.querySelector('#peTransactionType')?.value);
    const max = option?.maxAmt;
    const amount = document.querySelector('#peTransForm [name="amount"]');
    const pendingAmount = Math.max(0, Number(amount?.value) || 0);
    if (amount) amount.max = max || '';
    const limits = document.querySelector('#peTransactionLimits');
    const summaries = {
      pay: [
        ['Natitira', formatMoney(Math.max(0, Number(emp.balance || 0) - pendingAmount))]
      ],
      ca: [
        ['BALENSA Ngayon', formatMoney(emp.remaining_bale_balance)],
        ['Bagong BALENSA (Preview)', formatMoney(Number(emp.remaining_bale_balance || 0) + pendingAmount)]
      ],
      bale: [
        ['Natitira sa Sahod', formatMoney(Math.max(0, Number(emp.balance || 0) - pendingAmount))],
        ['BALENSA (utang)', formatMoney(Math.max(0, Number(emp.remaining_bale_balance || 0) - pendingAmount))]
      ],
      extra: [
        ['Dagdag Sahod Ngayon', formatMoney(Number(emp.extra_payment_amount || 0))],
        ['Bagong Dagdag Sahod', formatMoney(Number(emp.extra_payment_amount || 0) + pendingAmount)]
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
    const selectedEmployee = state.payrollModalEmployee;
    const row = state.payroll?.rows?.find(r => Number(r.employee_id) === Number(selectedEmployee?.employee_id)) || selectedEmployee;
    if (row?.employee_id) {
      try {
        await api(`/api/payroll/${row.employee_id}/generate`, {
          method: 'POST',
          body: JSON.stringify({ weekStart: state.week })
        });
        await partialRefresh(['payroll', 'attendance', 'salaryPayments', 'advances', 'balePayments', 'extraPayments']);
        const generatedRow = state.payroll.rows.find(item => Number(item.employee_id) === Number(row.employee_id)) || row;
        state.payrollModalEmployee = null;
        state.payrollTransactionModal = false;
        showToast('Payslip generated and payroll locked.');
        renderPayslip(generatedRow);
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
              <h2>${isEdit ? 'Edit Employee' : 'Add Employee'}</h2>
              <p>${isEdit ? 'Update employee details and current rate.' : 'Create a new employee record.'}</p>
            </div>
          </div>
          <button class="icon-btn" id="closeEmployeeModal" aria-label="Close">x</button>
        </div>
        <form class="form-grid" id="employeeForm" enctype="multipart/form-data">
          <input type="hidden" name="id" value="${employee.id || ''}">
          <div class="profile-photo-wrap">
            <div class="profile-photo" id="profilePhotoPreview" style="${photoStyle}">${photoContent}</div>
            <div class="profile-photo-overlay">+</div>
            <input name="photo" type="file" accept="image/*" id="photoInput" hidden>
            <div class="profile-photo-label">Click to ${hasPhoto ? 'change' : 'add'} photo</div>
            ${isEdit && hasPhoto ? '<button type="button" class="profile-photo-remove" id="removePhotoBtn">Remove Photo</button>' : ''}
          </div>
          <div class="section-title">Basic Information</div>
          ${isEdit ? `<label>Emp Number<div class="readonly-field">${employee.emp_number}</div></label>` : ''}
          <label>Full Name<input name="name" value="${escapeHtml(employee.name || '')}" placeholder="Enter full name" required></label>
          <label>Phone Number<input name="phone" type="tel" value="${escapeHtml(employee.phone || '')}" placeholder="09171234567" pattern="[0-9]{11}" minlength="11" maxlength="11" inputmode="numeric" id="phoneInput" required><span class="field-hint">Dapat 11 digits. Numero lang.</span></label>
          <div class="section-title">Government IDs</div>
          <label>SSS Number<input name="sss_number" type="text" value="${escapeHtml(employee.sss_number || '')}" placeholder="XX-XXXXXXX-X" maxlength="12" class="gov-id-input" data-format="sss" inputmode="numeric"><span class="field-hint">Format: 12-3456789-0 (10 digits)</span></label>
          <label>PhilHealth Number<input name="philhealth_number" type="text" value="${escapeHtml(employee.philhealth_number || '')}" placeholder="XX-XXXXXXXXX-X" maxlength="14" class="gov-id-input" data-format="philhealth" inputmode="numeric"><span class="field-hint">Format: 12-345678901-2 (12 digits)</span></label>
          <label>Pag-IBIG Number<input name="pagibig_number" type="text" value="${escapeHtml(employee.pagibig_number || '')}" placeholder="XXXX-XXXX-XXXX" maxlength="14" class="gov-id-input" data-format="pagibig" inputmode="numeric"><span class="field-hint">Format: 1234-5678-9012 (12 digits)</span></label>
          <label>TIN Number<input name="tin_number" type="text" value="${escapeHtml(employee.tin_number || '')}" placeholder="XXX-XXX-XXX-XXX" maxlength="15" class="gov-id-input" data-format="tin" inputmode="numeric"><span class="field-hint">Format: 123-456-789-012 (12 digits)</span></label>
          <div class="section-title">Payroll Settings</div>
          <label>Daily Rate (₱)<input name="rate" type="number" min="0" step="0.01" value="${employee.rate || ''}" placeholder="0.00" required></label>
          <label>Pay Period
            <select name="pay_period_days">
              <option value="7" ${(employee.pay_period_days || 7) === 7 ? 'selected' : ''}>Weekly (7 days)</option>
              <option value="14" ${employee.pay_period_days === 14 ? 'selected' : ''}>Semi-monthly (14 days)</option>
              <option value="21" ${employee.pay_period_days === 21 ? 'selected' : ''}>3 Weeks (21 days)</option>
              <option value="30" ${employee.pay_period_days === 30 ? 'selected' : ''}>Monthly (30 days)</option>
            </select>
          </label>
          <label>Status<select name="active"><option value="true" ${employee.active !== false ? 'selected' : ''}>Active</option><option value="false" ${employee.active === false ? 'selected' : ''}>Inactive (Archive)</option></select></label>
          <div class="error error-box" id="employeeFormError"></div>
          <div class="modal-actions">
            <button class="ghost" type="button" id="cancelEmployeeModal">Cancel</button>
            <button class="primary" type="submit">${isEdit ? 'Update Employee' : 'Add Employee'}</button>
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

  /* Profile photo click → file picker */
  const photoWrap = document.querySelector('.profile-photo-wrap');
  const photoInput = document.querySelector('#photoInput');
  const photoPreview = document.querySelector('#profilePhotoPreview');
  photoWrap?.addEventListener('click', () => photoInput?.click());
  photoInput?.addEventListener('change', () => {
    const file = photoInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      photoPreview.style.backgroundImage = `url('${e.target.result}')`;
      photoPreview.style.backgroundSize = 'cover';
      photoPreview.style.backgroundPosition = 'center';
      photoPreview.style.background = '';
      photoPreview.innerHTML = '';
    };
    reader.readAsDataURL(file);
  });

  /* Remove photo on save */
  const removeBtn = document.querySelector('#removePhotoBtn');
  let removePhoto = false;
  removeBtn?.addEventListener('click', event => {
    event.stopPropagation();
    removePhoto = true;
    const emp = state.editingEmployee;
    const initials = emp?.name ? emp.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() : '?';
    photoPreview.style.backgroundImage = '';
    photoPreview.style.background = '#dc2626';
    photoPreview.innerHTML = `<span style="font-size:28px;font-weight:800;color:white;">${initials}</span>`;
    removeBtn.style.display = 'none';
  });

  /* Block non-numeric input on phone field */
  const phoneInputEl = document.querySelector('#phoneInput');
  phoneInputEl?.addEventListener('input', () => {
    phoneInputEl.value = phoneInputEl.value.replace(/\D/g, '');
  });

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
    const errorBox = document.querySelector('#employeeFormError');
    const submitButton = event.currentTarget.querySelector('button[type="submit"]');
    const photoInput = document.querySelector('#photoInput');
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

    submitButton.disabled = true;
    const formData = new FormData(event.currentTarget);
    const photoFile = photoInput?.files?.[0];
    const employeeId = formData.get('id');
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
      if (photoFile && employeeIdResult) {
        const photoForm = new FormData();
        photoForm.append('photo', photoFile);
        const photoResult = await api(`/api/employees/${employeeIdResult}/photo`, {
          method: 'POST',
          body: photoForm
        });
        /* Sync photo_url to local state */
        const empInState = state.employees.find(e => String(e.id) === String(employeeIdResult));
        if (empInState) empInState.photo_url = photoResult.photo_url;
      } else if (removePhoto && employeeIdResult) {
        await api(`/api/employees/${employeeIdResult}/photo`, { method: 'DELETE' });
        /* Sync photo removal to local state */
        const empInState = state.employees.find(e => String(e.id) === String(employeeIdResult));
        if (empInState) empInState.photo_url = null;
      }
      state.editingEmployee = null;
      state._flash = { id: Number(employeeIdResult), type: 'employees' };
      showToast(employeeId ? 'Employee updated successfully.' : 'Employee added successfully.');

      /* Instant update: add/edit directly in local state, no refresh needed */
      if (employeeId) {
        const idx = state.employees.findIndex(e => String(e.id) === String(employeeId));
        if (idx !== -1) state.employees[idx] = result;
      } else {
        state.employees.push(result);
        state.employees.sort((a, b) => a.name.localeCompare(b.name));
      }
      reRenderCurrentView();
    } catch (error) {
      errorBox.textContent = error.message;
      submitButton.disabled = false;
    }
  });
}

/* ── Audit Trail Modal ── */
let auditFilterState = { entity: '', action: '', search: '', date_from: '', date_to: '', page: 1 };

function auditTrailModal() {
  return `
    <div class="modal-backdrop" id="auditModal">
      <section class="modal wide-modal" style="max-height:90vh;display:flex;flex-direction:column;">
        <div class="modal-head">
          <div>
            <h2>Audit Trail</h2>
            <p>Complete history of actions in the system.</p>
          </div>
          <button class="icon-btn" id="closeAuditModal" aria-label="Close">x</button>
        </div>
        <div class="audit-filters">
          <select id="auditEntityFilter"><option value="">All Entities</option><option value="employee">Employee</option><option value="cash_advance">Cash Advance</option><option value="extra_payment">Extra Payment</option><option value="payroll_payment">Payroll Payment</option><option value="payroll_extra_payment">Extra Payment (old)</option></select>
          <select id="auditActionFilter"><option value="">All Actions</option><option value="create">Create</option><option value="update">Update</option><option value="delete">Delete</option><option value="archive">Archive</option><option value="restore">Restore</option><option value="permanent_delete">Permanent Delete</option></select>
          <input id="auditSearch" placeholder="Search details..." value="${escapeHtml(auditFilterState.search)}">
          <input id="auditDateFrom" type="date" value="${auditFilterState.date_from}">
          <input id="auditDateTo" type="date" value="${auditFilterState.date_to}">
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
    document.querySelector('#auditDateFrom').value = '';
    document.querySelector('#auditDateTo').value = '';
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
    exportCSV(exportData, `audit_trail_${new Date().toISOString().slice(0, 10)}.csv`);
  });

  renderAuditTable();
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
