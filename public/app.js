/* ── Data Poller ── */
let dataPollLock = false;
let dataPoller = null;

function startDataPoller() {
  if (dataPoller) return;
  dataPoller = setInterval(async () => {
    if (!state.user || isModalOpen() || dataPollLock) return;
    dataPollLock = true;
    try {
      await withLoading(loadData);
      const currentView = state.view;
      if (currentView === 'dashboard') renderDashboard();
      else if (currentView === 'payroll') renderPayroll();
      else if (currentView === 'attendance') renderAttendance();
      else if (currentView === 'employees') renderEmployees();
      else if (currentView === 'cashAdvance') renderCashAdvance();
      else if (currentView === 'archive') renderArchive();
    } finally {
      dataPollLock = false;
    }
  }, 30000);
}

function stopDataPoller() {
  if (dataPoller) {
    clearInterval(dataPoller);
    dataPoller = null;
  }
}

/* ── Date Watcher ── */
let dateWatcher = null;

function startDateWatcher() {
  if (dateWatcher) return;
  dateWatcher = setInterval(async () => {
    if (isModalOpen()) return;
    const latestDate = todayInManila();
    if (state.user && latestDate !== state.currentDate) {
      const previousDate = state.currentDate;
      const previousWeek = payrollWeekStartOf(previousDate);
      const latestWeek = payrollWeekStartOf(latestDate);
      state.currentDate = latestDate;
      if (state.attendanceDate === previousDate) {
        state.attendanceDate = latestDate;
      }
      if (state.week === previousWeek && latestWeek !== previousWeek) {
        state.week = latestWeek;
        state.payrollWeek = latestWeek;
      }
      await refresh();
    }
  }, 60000);
}

/* ── Shell ── */
const app = document.querySelector('#app');

/* ── Loading Indicator ── */
let loadingCount = 0;

function showLoading() {
  loadingCount++;
  let overlay = document.querySelector('.loading-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><span>Loading data...</span></div>';
    document.body.appendChild(overlay);
  }
  overlay.classList.add('active');
}

function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount === 0) {
    const overlay = document.querySelector('.loading-overlay');
    if (overlay) overlay.classList.remove('active');
  }
}

async function withLoading(fn) {
  showLoading();
  try {
    return await fn();
  } finally {
    hideLoading();
  }
}

function shell(content) {
  const nav = [
    ['dashboard', 'Dashboard'],
    ['payroll', 'Payroll'],
    ['attendance', 'Attendance'],
    ['employees', 'Employees'],
    ['archive', 'Archive']
  ];
  app.innerHTML = `
    <section class="layout">
      <aside class="sidebar">
        <div class="brand">
          <span>Payroll</span>
          <small>Attendance & weekly pay</small>
        </div>
        <nav class="nav">
          ${nav.map(([id, label]) => `<button class="${state.view === id ? 'active' : ''}" data-view="${id}">${label}</button>`).join('')}
        </nav>
        <div class="userbox">
          <div><strong>${state.user.username}</strong><br><span class="role-badge role-${state.user.role}">${state.user.role.toUpperCase()}</span></div>
          <div class="permission-list">
            ${state.user.role === 'admin'
              ? '<span class="perm-item">✓ Full Access</span><span class="perm-item">✓ Delete Records</span><span class="perm-item">✓ Audit Trail</span>'
              : '<span class="perm-item">✓ Create & Edit</span><span class="perm-item">✓ View Reports</span><span class="perm-item perm-disabled">✗ Cannot Delete</span>'
            }
          </div>
          <div class="theme-toggle">
            <button class="ghost" id="darkModeToggle">Dark Mode</button>
          </div>
          <div class="session-info" id="sessionInfo">Session active</div>
          <div class="session-actions">
            <button class="ghost" id="switchUserBtn">Switch User</button>
            <button class="ghost" id="logoutBtn">Logout</button>
          </div>
        </div>
      </aside>
      <section class="content">
        <div class="topbar">
          <div class="page-title">
            <span class="page-kicker">${state.view.toUpperCase()}</span>
            <h1>${titleForView()}</h1>
            <p>Today: ${state.currentDate} | Week: ${state.week} to ${addDays(state.week, 6)}</p>
          </div>
          <span class="badge role-${state.user.role}">
            ${state.user.role === 'admin' ? 'Admin - Full Access' : 'HR - Manage Records'}
          </span>
        </div>
        ${content}
        ${state.showLogoutConfirm ? logoutConfirmModal() : ''}
        ${state.pendingDelete ? confirmDeleteModal() : ''}
        ${state.showAudit ? auditTrailModal() : ''}
      </section>
    </section>
  `;
  document.querySelectorAll('[data-view]').forEach(button => {
    button.addEventListener('click', async () => {
      state.view = button.dataset.view;
      state.editingEmployee = null;
      state.editingCashAdvance = null;
      if (state.view === 'attendance') {
        state.attendanceDate = todayInManila();
        state.week = payrollWeekStartOf(state.attendanceDate);
      } else if (state.view === 'payroll') {
        state.week = state.payrollWeek;
      }
      state.pages[state.view] = 1;
      saveUiState();
      await refresh();
    });
  });
  document.querySelector('#darkModeToggle')?.addEventListener('click', () => {
    const isDark = document.body.classList.toggle('dark-mode');
    localStorage.setItem('payrollDarkMode', isDark ? 'true' : '');
    document.querySelector('#darkModeToggle').textContent = isDark ? 'Light Mode' : 'Dark Mode';
  });
  document.querySelector('#logoutBtn').addEventListener('click', async () => {
    state.showLogoutConfirm = true;
    shell(content);
  });
  bindLogoutConfirmModal();
  bindConfirmDeleteModal();
  bindUserSwitcher();
  startSessionTimer();
  if (state.showAudit) bindAuditTrailModal();
}

/* ── Session Timer ── */
let sessionTimer = null;

function startSessionTimer() {
  if (sessionTimer) clearInterval(sessionTimer);
  sessionTimer = setInterval(() => {
    const el = document.querySelector('#sessionInfo');
    if (!el) return;
    if (!state.loggedInAt || !state.sessionTTL) {
      el.textContent = 'Session active';
      return;
    }
    const elapsed = Math.floor((Date.now() - state.loggedInAt) / 1000);
    const remaining = Math.max(0, state.sessionTTL - elapsed);
    if (remaining === 0) {
      el.textContent = 'Session expired — please re-login';
      return;
    }
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    el.textContent = `Session: ${mins}m ${String(secs).padStart(2, '0')}s`;
  }, 1000);
}

function bindUserSwitcher() {
  document.querySelector('#switchUserBtn')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    state.user = null;
    state.showLogoutConfirm = false;
    stopDataPoller();
    stopSessionTimer();
    renderLogin();
  });
}

function stopSessionTimer() {
  if (sessionTimer) {
    clearInterval(sessionTimer);
    sessionTimer = null;
  }
}

/* ── Refresh ── */
async function refresh() {
  saveUiState();
  await withLoading(loadData);
  const payrollRows = state.payroll?.rows || [];
  if (state.paymentEmployee) {
    const fresh = payrollRows.find(r => Number(r.employee_id) === Number(state.paymentEmployee.employee_id));
    if (fresh) state.paymentEmployee = fresh;
  }
  if (state.baleDeductionEmployee) {
    const fresh = payrollRows.find(r => Number(r.employee_id) === Number(state.baleDeductionEmployee.employee_id));
    if (fresh) state.baleDeductionEmployee = fresh;
  }
  if (state.cashEmployee) {
    const fresh = payrollRows.find(r => Number(r.employee_id) === Number(state.cashEmployee.employee_id));
    if (fresh) state.cashEmployee = fresh;
  }
  if (state.extraPaymentEmployee) {
    const fresh = payrollRows.find(r => Number(r.employee_id) === Number(state.extraPaymentEmployee.employee_id));
    if (fresh) state.extraPaymentEmployee = fresh;
  }
  if (state.view === 'dashboard') renderDashboard();
  if (state.view === 'payroll') renderPayroll();
  if (state.view === 'attendance') renderAttendance();
  if (state.view === 'employees') renderEmployees();
  if (state.view === 'cashAdvance') renderCashAdvance();
  if (state.view === 'archive') renderArchive();
  state._flash = null;
}

/* ── Global Keyboard Shortcuts ── */
document.addEventListener('keydown', event => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const viewKeys = { '1': 'dashboard', '2': 'payroll', '3': 'attendance', '4': 'employees', '5': 'archive' };
  const targetView = viewKeys[event.key];
  if (targetView && !event.ctrlKey && !event.metaKey && !event.altKey && !isModalOpen()) {
    if (state.view !== targetView) {
      event.preventDefault();
      state.view = targetView;
      state.editingEmployee = null;
      state.editingCashAdvance = null;
      if (targetView === 'attendance') {
        state.attendanceDate = todayInManila();
        state.week = payrollWeekStartOf(state.attendanceDate);
      } else if (targetView === 'payroll') {
        state.week = state.payrollWeek;
      }
      state.pages[targetView] = 1;
      saveUiState();
      refresh();
    }
    return;
  }
  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !isModalOpen() && !event.ctrlKey && !event.metaKey) {
    if (state.view === 'payroll' || state.view === 'dashboard') {
      event.preventDefault();
      state.week = addDays(state.week, event.key === 'ArrowLeft' ? -7 : 7);
      state.payrollWeek = state.week;
      saveUiState();
      refresh();
    }
  }
});

/* ── Unsaved Changes Warning ── */
window.addEventListener('beforeunload', event => {
  if (isModalOpen()) {
    event.preventDefault();
    event.returnValue = '';
  }
});

/* ── Boot ── */
async function boot() {
  if (localStorage.getItem('payrollDarkMode') === 'true') {
    document.body.classList.add('dark-mode');
  }
  await loadMe();
  if (!state.user) return renderLogin();
  await refresh();
  startDateWatcher();
  startDataPoller();
}

boot().catch(error => {
  app.innerHTML = `<section class="login-screen"><div class="login-panel"><h1>Error</h1><p>${error.message}</p></div></section>`;
});
