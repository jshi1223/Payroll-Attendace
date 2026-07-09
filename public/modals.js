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
    state.pendingDelete = null;
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
      state.pendingDelete = null;
      reRenderCurrentView();

      /* Background refresh */
      if (isPermanent || resource === 'employees') {
        partialRefresh(['employees']).catch(() => {});
      } else {
        const partialMap = {
          'salary-payments': ['payroll', 'salaryPayments'],
          'bale-payments': ['payroll', 'balePayments'],
          'cash-advances': ['payroll', 'advances'],
          'extra-payments': ['payroll', 'extraPayments']
        };
        partialRefresh(partialMap[resource] || ['payroll', 'salaryPayments', 'balePayments', 'advances', 'extraPayments']).catch(() => {});
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
    stopDataPoller();
    stopSessionTimer();
    renderLogin();
  });
}

/* ── Payment Modal ── */
function paymentModal(employee) {
  const logs = state.salaryPayments.rows.filter(row => Number(row.employee_id) === Number(employee.employee_id));
  const legacyAmount = moneyValue(employee.legacy_paid_amount);
  const editing = state.editingSalaryPayment && Number(state.editingSalaryPayment.employee_id) === Number(employee.employee_id)
    ? state.editingSalaryPayment
    : null;
  return `
    <div class="modal-backdrop" id="paymentModal">
      <section class="modal">
        <div class="modal-head">
          <div>
            <h2>Salary Payment</h2>
            <p>${escapeHtml(employee.emp_number)} - ${escapeHtml(employee.name)} | ${state.week} to ${addDays(state.week, 6)}</p>
          </div>
          <button class="icon-btn" id="closePaymentModal" aria-label="Close">x</button>
        </div>
        <div class="payment-summary">
          <div><span>Salary This Week</span><strong>${formatMoney(employee.salary)}</strong></div>
          <div><span>Extra Payment</span><strong>${formatMoney(employee.extra_payment_amount || 0)}</strong></div>
          <div><span>Prev Unpaid (Salary)</span><strong>${formatMoney(employee.previous_unpaid_balance)}</strong></div>
          <div class="balance-card balance-due-card"><span class="balance-label">Salary Balance Due</span><strong class="balance-amount">${formatMoney(employee.balance)}</strong><span class="card-sub">Salary + Extras - Payment</span></div>
          <div class="balance-card bale-due-card"><span class="balance-label">Bale Balance</span><strong class="bale-amount">${formatMoney(employee.remaining_bale_balance)}</strong><span class="card-sub">Total Bale - Bale Payments</span></div>
          <div><span>Total Paid (Salary)</span><strong>${formatMoney(employee.paid_amount)}</strong></div>
          <div><span>C/A This Week</span><strong>${formatMoney(employee.cash_advance)}</strong></div>
          <div><span>Prev Bale Balance</span><strong>${formatMoney(employee.previous_bale_balance)}</strong></div>
          <div><span>Total Bale</span><strong>${formatMoney(employee.total_bale)}</strong></div>
        </div>
        <form class="form-grid" id="paymentForm">
          <input type="hidden" name="id" value="${editing?.id || ''}">
          <input type="hidden" name="employee_id" value="${employee.employee_id}">
          <label>Amount<input name="amount" type="number" min="0.01" step="0.01" max="${moneyValue(employee.balance) + (editing ? moneyValue(editing.amount) : 0)}" value="${editing?.amount || ''}" required placeholder="Enter payment amount"><span class="field-hint">Max: ${formatMoney(employee.balance)}</span></label>
          <label>Date<input name="payment_date" type="date" value="${editing?.payment_date || todayInManila()}" required></label>
          <label>Notes<input name="notes" value="${escapeHtml(editing?.notes || '')}" placeholder="Any remarks or notes"></label>
          <div class="error error-box" id="paymentFormError"></div>
          <div class="modal-actions">
            ${editing ? '<button class="ghost" type="button" id="clearPaymentEdit">New Payment</button>' : ''}
            <button class="ghost" type="button" id="cancelPaymentModal">Cancel</button>
            <button class="primary" type="submit">${editing ? 'Update Payment' : 'Save Payment'}</button>
          </div>
        </form>
        <div class="log-list">
          <h3>Weekly Payment Logs</h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Amount</th><th>Notes</th><th>Action</th></tr></thead>
              <tbody>
                ${legacyAmount > 0 ? `
                  <tr style="background:#f0fdf4;">
                    <td>${employee.paid_at ? new Date(employee.paid_at).toLocaleDateString() : '<em>Previous</em>'}</td>
                    <td><strong>${peso.format(legacyAmount)}</strong></td>
                    <td><span class="muted">Bulk payment</span></td>
                    <td class="actions">
                      ${state.user.role === 'admin' ? `<button class="danger" data-delete-legacy-payment="${employee.employee_id}">Delete</button>` : `<span class="badge paid" style="font-size:10px;">Recorded</span>`}
                    </td>
                  </tr>
                ` : ''}
                ${logs.map(log => `
                  <tr>
                    <td>${log.payment_date}</td>
                    <td>${peso.format(log.amount)}</td>
                    <td>${escapeHtml(log.notes || '-')}</td>
                    <td class="actions">
                      <button class="ghost" data-edit-payment="${log.id}">Edit</button>
                      <button class="danger" data-delete-payment="${log.id}">Delete</button>
                    </td>
                  </tr>
                `).join('') || (legacyAmount === 0 ? `<tr><td colspan="4" class="empty-state" style="padding:24px;"><span class="empty-icon">--</span><strong>No Salary Payments</strong><span>No payments recorded this week. Use the form above to record one.</span></td></tr>` : '')}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  `;
}

function bindPaymentModal() {
  const modal = document.querySelector('#paymentModal');
  if (!modal) return;

  const close = () => {
    state.paymentEmployee = null;
    state.editingSalaryPayment = null;
    renderPayroll();
  };

  setupModalKeyboard('#paymentModal', close);
  document.querySelector('#closePaymentModal').addEventListener('click', close);
  document.querySelector('#cancelPaymentModal').addEventListener('click', close);
  document.querySelector('#clearPaymentEdit')?.addEventListener('click', () => {
    state.editingSalaryPayment = null;
    renderPayroll();
  });
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });
  document.querySelectorAll('[data-edit-payment]').forEach(button => {
    button.addEventListener('click', () => {
      state.editingSalaryPayment = state.salaryPayments.rows.find(row => String(row.id) === button.dataset.editPayment);
      renderPayroll();
    });
  });
  document.querySelectorAll('[data-delete-payment]').forEach(button => {
    button.addEventListener('click', () => {
      state.pendingDelete = {
        resource: 'salary-payments',
        id: button.dataset.deletePayment
      };
      reRenderCurrentView();
    });
  });
  document.querySelector('[data-delete-legacy-payment]')?.addEventListener('click', async () => {
    const empId = Number(document.querySelector('[data-delete-legacy-payment]').dataset.deleteLegacyPayment);
    state.pendingDelete = {
      resource: 'legacy-payment',
      id: empId
    };
    reRenderCurrentView();
  });
  document.querySelector('#paymentForm').addEventListener('submit', async event => {
    event.preventDefault();
    const errorBox = document.querySelector('#paymentFormError');
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    const id = payload.id;
    delete payload.id;
    errorBox.textContent = '';
    try {
      await api(id ? `/api/salary-payments/${id}` : '/api/salary-payments', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify({
          ...payload,
          employee_id: Number(state.paymentEmployee.employee_id)
        })
      });
      state.editingSalaryPayment = null;
      state._flash = { id: Number(state.paymentEmployee.employee_id), type: 'payroll' };
      showToast(id ? 'Payment updated.' : 'Payment saved.');
      state.paymentEmployee = null;
      reRenderCurrentView();
      partialRefresh(['payroll', 'salaryPayments']).catch(() => {});
    } catch (error) {
      errorBox.textContent = error.message;
    }
  });
}

/* ── Bale Payment Modal ── */
function baleDeductionModal(employee) {
  const logs = state.balePayments.rows.filter(row => Number(row.employee_id) === Number(employee.employee_id));
  const editing = state.editingBalePayment && Number(state.editingBalePayment.employee_id) === Number(employee.employee_id)
    ? state.editingBalePayment
    : null;
  return `
    <div class="modal-backdrop" id="baleDeductionModal">
      <section class="modal">
        <div class="modal-head">
          <div>
            <h2>Bale Payment</h2>
            <p>${escapeHtml(employee.emp_number)} - ${escapeHtml(employee.name)} | ${state.week} to ${addDays(state.week, 6)}</p>
          </div>
          <button class="icon-btn" id="closeBaleDeductionModal" aria-label="Close">x</button>
        </div>
        <div class="payment-summary">
          <div><span>Salary This Week</span><strong>${formatMoney(employee.salary)}</strong></div>
          <div><span>Extra Payment</span><strong>${formatMoney(employee.extra_payment_amount || 0)}</strong></div>
          <div><span>Prev Unpaid (Salary)</span><strong>${formatMoney(employee.previous_unpaid_balance)}</strong></div>
          <div class="balance-card balance-due-card"><span class="balance-label">Salary Balance</span><strong class="balance-amount">${formatMoney(employee.balance)}</strong><span class="card-sub">Unpaid salary this week</span></div>
          <div class="balance-card bale-due-card"><span class="balance-label">Bale Balance</span><strong class="bale-amount">${formatMoney(employee.remaining_bale_balance)}</strong><span class="card-sub">Total Bale - Bale Payments</span></div>
          <div><span>Total Bale</span><strong>${formatMoney(employee.total_bale)}</strong></div>
          <div><span>C/A This Week</span><strong>${formatMoney(employee.cash_advance)}</strong></div>
          <div><span>Prev Bale Balance</span><strong>${formatMoney(employee.previous_bale_balance)}</strong></div>
        </div>
        <form class="form-grid" id="baleDeductionForm">
          <input type="hidden" name="id" value="${editing?.id || ''}">
          <input type="hidden" name="employee_id" value="${employee.employee_id}">
          <label>Amount<input name="amount" type="number" min="0.01" step="0.01" max="${moneyValue(employee.remaining_bale_balance) + (editing ? moneyValue(editing.amount) : 0)}" value="${editing?.amount || ''}" required placeholder="Enter payment amount"><span class="field-hint">Max: ${formatMoney(employee.remaining_bale_balance)}</span></label>
          <label>Date<input name="payment_date" type="date" value="${editing?.payment_date || todayInManila()}" required></label>
          <label>Notes<input name="notes" value="${escapeHtml(editing?.notes || '')}" placeholder="Any remarks or notes"></label>
          <div class="error error-box" id="baleDeductionFormError"></div>
          <div class="modal-actions">
            ${editing ? '<button class="ghost" type="button" id="clearBaleEdit">New Bale</button>' : ''}
            <button class="ghost" type="button" id="cancelBaleDeductionModal">Cancel</button>
            <button class="primary" type="submit">${editing ? 'Update Bale Payment' : 'Save Bale Payment'}</button>
          </div>
        </form>
        <div class="log-list">
          <h3>Weekly Bale Payment Logs</h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Amount</th><th>Notes</th><th>Action</th></tr></thead>
              <tbody>
                ${logs.map(log => `
                  <tr>
                    <td>${log.payment_date}</td>
                    <td>${peso.format(log.amount)}</td>
                    <td>${escapeHtml(log.notes || '-')}</td>
                    <td class="actions">
                      <button class="ghost" data-edit-bale="${log.id}">Edit</button>
                      <button class="danger" data-bale-delete="${log.id}">Delete</button>
                    </td>
                  </tr>
                `).join('') || `<tr><td colspan="4" class="empty-state" style="padding:24px;"><span class="empty-icon">--</span><strong>No Bale Payments</strong><span>No bale payments recorded this week. Use the form above to record one.</span></td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  `;
}

function bindBaleDeductionModal() {
  const modal = document.querySelector('#baleDeductionModal');
  if (!modal) return;

  const close = () => {
    state.baleDeductionEmployee = null;
    state.editingBalePayment = null;
    renderPayroll();
  };

  setupModalKeyboard('#baleDeductionModal', close);
  document.querySelector('#closeBaleDeductionModal').addEventListener('click', close);
  document.querySelector('#cancelBaleDeductionModal').addEventListener('click', close);
  document.querySelector('#clearBaleEdit')?.addEventListener('click', () => {
    state.editingBalePayment = null;
    renderPayroll();
  });
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });
  document.querySelectorAll('[data-edit-bale]').forEach(button => {
    button.addEventListener('click', () => {
      state.editingBalePayment = state.balePayments.rows.find(row => String(row.id) === button.dataset.editBale);
      renderPayroll();
    });
  });
  document.querySelector('#baleDeductionForm').addEventListener('submit', async event => {
    event.preventDefault();
    const errorBox = document.querySelector('#baleDeductionFormError');
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    const id = payload.id;
    delete payload.id;
    errorBox.textContent = '';
    try {
      await api(id ? `/api/bale-payments/${id}` : '/api/bale-payments', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify({
          ...payload,
          employee_id: Number(state.baleDeductionEmployee.employee_id)
        })
      });
      state.editingBalePayment = null;
      state._flash = { id: Number(state.baleDeductionEmployee.employee_id), type: 'payroll' };
      showToast(id ? 'Bale payment updated.' : 'Bale payment saved.');
      state.baleDeductionEmployee = null;
      reRenderCurrentView();
      partialRefresh(['payroll', 'balePayments']).catch(() => {});
    } catch (error) {
      errorBox.textContent = error.message;
    }
  });
  document.querySelectorAll('[data-bale-delete]').forEach(button => {
    button.addEventListener('click', () => {
      state.pendingDelete = {
        resource: 'bale-payments',
        id: button.dataset.baleDelete
      };
      reRenderCurrentView();
    });
  });
}

/* ── Cash Advance Modal ── */
function cashAdvanceModal(employee) {
  const logs = state.advances.rows.filter(row => Number(row.employee_id) === Number(employee.employee_id));
  const editing = state.editingCashAdvance && Number(state.editingCashAdvance.employee_id) === Number(employee.employee_id)
    ? state.editingCashAdvance
    : null;
  return `
    <div class="modal-backdrop" id="cashModal">
      <section class="modal">
        <div class="modal-head">
          <div>
            <h2>${editing ? 'Edit C/A' : 'Add C/A'}</h2>
            <p>${escapeHtml(employee.emp_number)} - ${escapeHtml(employee.name)} | ${state.week} to ${addDays(state.week, 6)}</p>
          </div>
          <button class="icon-btn" id="closeCashModal" aria-label="Close">x</button>
        </div>
        <div class="payment-summary">
          <div><span>Salary This Week</span><strong>${formatMoney(employee.salary)}</strong></div>
          <div><span>Extra Payment</span><strong>${formatMoney(employee.extra_payment_amount || 0)}</strong></div>
          <div><span>Prev Unpaid (Salary)</span><strong>${formatMoney(employee.previous_unpaid_balance)}</strong></div>
          <div class="balance-card balance-due-card"><span class="balance-label">Salary Balance</span><strong class="balance-amount">${formatMoney(employee.balance)}</strong><span class="card-sub">Salary + Extras - C/A - Payment</span></div>
          <div class="balance-card bale-due-card"><span class="balance-label">Bale Balance</span><strong class="bale-amount">${formatMoney(employee.remaining_bale_balance)}</strong><span class="card-sub">Total Bale - Bale Payments</span></div>
          <div><span>Total Bale</span><strong>${formatMoney(employee.total_bale)}</strong></div>
          <div><span>C/A This Week</span><strong>${formatMoney(employee.cash_advance)}</strong></div>
          <div><span>Previous Bale</span><strong>${formatMoney(employee.previous_bale_balance)}</strong></div>
        </div>
        <form class="form-grid" id="cashPayrollForm">
          <input type="hidden" name="id" value="${editing?.id || ''}">
          <input type="hidden" name="employee_id" value="${employee.employee_id}">
          <label>Amount<input name="amount" type="number" min="0.01" step="0.01" value="${editing?.amount || ''}" required></label>
          <label>Date<input name="advance_date" type="date" value="${editing?.advance_date || todayInManila()}" required></label>
          <label>Notes<input name="notes" value="${escapeHtml(editing?.notes || '')}" placeholder="Reason or remarks"></label>
          <div class="error error-box" id="cashFormError"></div>
          <div class="modal-actions">
            ${editing ? '<button class="ghost" type="button" id="clearCashEdit">New C/A</button>' : ''}
            <button class="ghost" type="button" id="cancelCashModal">Cancel</button>
            <button class="primary" type="submit">${editing ? 'Update C/A' : 'Add C/A'}</button>
          </div>
        </form>
        <div class="log-list">
          <h3>Weekly C/A Logs</h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Amount</th><th>Notes</th><th>Action</th></tr></thead>
              <tbody>
                ${logs.map(log => `
                  <tr>
                    <td>${log.advance_date}</td>
                    <td>${peso.format(log.amount)}</td>
                    <td>${escapeHtml(log.notes || '-')}</td>
                    <td class="actions">
                      <button class="ghost" data-edit-cash="${log.id}">Edit</button>
                      ${deleteButton('cash-advances', log.id)}
                    </td>
                  </tr>
                `).join('') || `<tr><td colspan="4" class="empty-state" style="padding:24px;"><span class="empty-icon">--</span><strong>No Cash Advances</strong><span>No C/A records this week. Use the form above to add one.</span></td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  `;
}

function bindCashAdvanceModal() {
  const modal = document.querySelector('#cashModal');
  if (!modal) return;

  const close = () => {
    state.cashEmployee = null;
    state.editingCashAdvance = null;
    renderPayroll();
  };

  setupModalKeyboard('#cashModal', close);
  document.querySelector('#closeCashModal').addEventListener('click', close);
  document.querySelector('#cancelCashModal').addEventListener('click', close);
  document.querySelector('#clearCashEdit')?.addEventListener('click', () => {
    state.editingCashAdvance = null;
    renderPayroll();
  });
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });
  document.querySelectorAll('[data-edit-cash]').forEach(button => {
    button.addEventListener('click', () => {
      state.editingCashAdvance = state.advances.rows.find(row => String(row.id) === button.dataset.editCash);
      renderPayroll();
    });
  });
  document.querySelector('#cashPayrollForm').addEventListener('submit', async event => {
    event.preventDefault();
    const errorBox = document.querySelector('#cashFormError');
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    const id = payload.id;
    delete payload.id;
    errorBox.textContent = '';
    try {
      await api(id ? `/api/cash-advances/${id}` : '/api/cash-advances', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });
      state.editingCashAdvance = null;
      state._flash = { id: Number(state.cashEmployee.employee_id), type: 'payroll' };
      showToast(id ? 'C/A updated successfully.' : 'C/A added successfully.');
      state.cashEmployee = null;
      reRenderCurrentView();
      partialRefresh(['payroll', 'advances']).catch(() => {});
    } catch (error) {
      errorBox.textContent = error.message;
    }
  });
}

/* ── Extra Payment Modal ── */
function extraPaymentModal(employee) {
  const logs = state.extraPayments.rows.filter(row => Number(row.employee_id) === Number(employee.employee_id));
  const editing = state.editingExtraPayment && Number(state.editingExtraPayment.employee_id) === Number(employee.employee_id)
    ? state.editingExtraPayment
    : null;
  return `
    <div class="modal-backdrop" id="extraPaymentModal">
      <section class="modal">
        <div class="modal-head">
          <div>
            <h2>${editing ? 'Edit Extra Payment' : 'Add Extra Payment'}</h2>
            <p>${escapeHtml(employee.emp_number)} - ${escapeHtml(employee.name)} | ${state.week} to ${addDays(state.week, 6)}</p>
          </div>
          <button class="icon-btn" id="closeExtraPaymentModal" aria-label="Close">x</button>
        </div>
        <div class="payment-summary">
          <div><span>Salary This Week</span><strong>${formatMoney(employee.salary)}</strong></div>
          <div><span>Salary Payment</span><strong>${formatMoney(employee.salary_paid_amount)}</strong></div>
          <div><span>Total Extra</span><strong>${formatMoney(employee.extra_payment_amount)}</strong></div>
          <div class="balance-card balance-due-card"><span class="balance-label">Salary Balance</span><strong class="balance-amount">${formatMoney(employee.balance)}</strong></div>
          <div class="balance-card bale-due-card"><span class="balance-label">Bale Balance</span><strong class="bale-amount">${formatMoney(employee.remaining_bale_balance)}</strong></div>
        </div>
        <form class="form-grid" id="extraPaymentForm">
          <input type="hidden" name="id" value="${editing?.id || ''}">
          <input type="hidden" name="employee_id" value="${employee.employee_id}">
          <label>Amount<input name="amount" type="number" min="0.01" step="0.01" value="${editing?.amount || ''}" required></label>
          <label>Date<input name="extra_date" type="date" value="${editing?.extra_date || todayInManila()}" required></label>
          <label>Notes<input name="notes" value="${escapeHtml(editing?.notes || '')}" placeholder="Reason or remarks"></label>
          <div class="error error-box" id="extraPaymentFormError"></div>
          <div class="modal-actions">
            ${editing ? '<button class="ghost" type="button" id="clearExtraEdit">New Extra</button>' : ''}
            <button class="ghost" type="button" id="cancelExtraPaymentModal">Cancel</button>
            <button class="primary" type="submit">${editing ? 'Update Extra' : 'Add Extra Payment'}</button>
          </div>
        </form>
        <div class="log-list">
          <h3>Weekly Extra Payment Logs</h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Amount</th><th>Notes</th><th>Action</th></tr></thead>
              <tbody>
                ${logs.map(log => `
                  <tr>
                    <td>${log.extra_date}</td>
                    <td>${peso.format(log.amount)}</td>
                    <td>${escapeHtml(log.notes || '-')}</td>
                    <td class="actions">
                      <button class="ghost" data-edit-extra="${log.id}">Edit</button>
                      ${deleteButton('extra-payments', log.id)}
                    </td>
                  </tr>
                `).join('') || `<tr><td colspan="4" class="empty-state" style="padding:24px;"><span class="empty-icon">--</span><strong>No Extra Payments</strong><span>No extra payments recorded this week. Use the form above to add one.</span></td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  `;
}

function bindExtraPaymentModal() {
  const modal = document.querySelector('#extraPaymentModal');
  if (!modal) return;

  const close = () => {
    state.extraPaymentEmployee = null;
    state.editingExtraPayment = null;
    renderPayroll();
  };

  setupModalKeyboard('#extraPaymentModal', close);
  document.querySelector('#closeExtraPaymentModal').addEventListener('click', close);
  document.querySelector('#cancelExtraPaymentModal').addEventListener('click', close);
  document.querySelector('#clearExtraEdit')?.addEventListener('click', () => {
    state.editingExtraPayment = null;
    renderPayroll();
  });
  document.querySelectorAll('[data-edit-extra]').forEach(button => {
    button.addEventListener('click', () => {
      state.editingExtraPayment = state.extraPayments.rows.find(row => String(row.id) === button.dataset.editExtra);
      renderPayroll();
    });
  });
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });
  document.querySelector('#extraPaymentForm').addEventListener('submit', async event => {
    event.preventDefault();
    const errorBox = document.querySelector('#extraPaymentFormError');
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    const id = payload.id;
    delete payload.id;
    errorBox.textContent = '';
    try {
      await api(id ? `/api/extra-payments/${id}` : '/api/extra-payments', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });
      state.editingExtraPayment = null;
      state._flash = { id: Number(state.extraPaymentEmployee.employee_id), type: 'payroll' };
      showToast(id ? 'Extra payment updated.' : 'Extra payment added.');
      state.extraPaymentEmployee = null;
      reRenderCurrentView();
      partialRefresh(['payroll', 'extraPayments']).catch(() => {});
    } catch (error) {
      errorBox.textContent = error.message;
    }
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
          <label>Phone Number<input name="phone" type="tel" value="${escapeHtml(employee.phone || '')}" placeholder="09171234567" pattern="[0-9]{11}" minlength="11" maxlength="11" inputmode="numeric" id="phoneInput" required><span class="field-hint">Must be exactly 11 digits. Numbers only.</span></label>
          <div class="section-title">Payroll Settings</div>
          <label>Daily Rate (₱)<input name="rate" type="number" min="0" step="0.01" value="${employee.rate || ''}" placeholder="0.00" required></label>
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
    formData.delete('photo');
    const payload = Object.fromEntries(formData);
    const id = payload.id;
    delete payload.id;
    delete payload.emp_number;
    payload.active = payload.active === 'true';
    try {
      const result = await api(id ? `/api/employees/${id}` : '/api/employees', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });
      const employeeId = id || result.id;
      if (photoFile && employeeId) {
        const photoForm = new FormData();
        photoForm.append('photo', photoFile);
        const photoResult = await api(`/api/employees/${employeeId}/photo`, {
          method: 'POST',
          body: photoForm
        });
        /* Sync photo_url to local state */
        const empInState = state.employees.find(e => String(e.id) === String(employeeId));
        if (empInState) empInState.photo_url = photoResult.photo_url;
      } else if (removePhoto && employeeId) {
        await api(`/api/employees/${employeeId}/photo`, { method: 'DELETE' });
        /* Sync photo removal to local state */
        const empInState = state.employees.find(e => String(e.id) === String(employeeId));
        if (empInState) empInState.photo_url = null;
      }
      state.editingEmployee = null;
      state._flash = { id: Number(employeeId), type: 'employees' };
      showToast(id ? 'Employee updated successfully.' : 'Employee added successfully.');

      /* Instant update: add/edit directly in local state, no refresh needed */
      if (id) {
        const idx = state.employees.findIndex(e => String(e.id) === String(id));
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
