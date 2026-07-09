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

/* ── Skeleton Loading ── */
function skeletonViewHTML(view) {
  const summaryCards = () => `
    <div class="sk-summary-grid">
      ${Array.from({ length: 6 }, () => '<div class="skeleton sk-card"></div>').join('')}
    </div>`;

  const summaryCards3 = () => `
    <div class="sk-summary-grid">
      ${Array.from({ length: 3 }, () => '<div class="skeleton sk-card"></div>').join('')}
    </div>`;

  const summaryCards5 = () => `
    <div class="sk-summary-grid">
      ${Array.from({ length: 5 }, () => '<div class="skeleton sk-card"></div>').join('')}
    </div>`;

  const tableSkeleton = (rows = 5) => `
    <div class="sk-panel">
      <div class="sk-panel-header">
        <div class="skeleton" style="width:180px;height:16px"></div>
        <div class="skeleton" style="width:100px;height:16px;margin-left:auto"></div>
      </div>
      <div class="table-wrap">
        ${Array.from({ length: rows }, () => `
          <div class="sk-row">
            <div class="skeleton sk-cell-sm"></div>
            <div class="skeleton sk-cell-lg"></div>
            <div class="skeleton sk-cell"></div>
            <div class="skeleton sk-cell"></div>
            <div class="skeleton sk-cell"></div>
            <div class="skeleton sk-cell"></div>
            <div class="skeleton sk-badge"></div>
            <div class="sk-actions">
              <div class="skeleton"></div>
              <div class="skeleton"></div>
              <div class="skeleton"></div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>`;

  const quickActions = () => `
    <div class="sk-panel">
      <div class="sk-panel-header">
        <div class="skeleton" style="width:140px;height:16px"></div>
        <div class="skeleton" style="width:70px;height:22px;border-radius:999px;margin-left:auto"></div>
      </div>
      <div class="sk-quick-actions">
        ${Array.from({ length: 5 }, () => '<div class="skeleton sk-quick-card"></div>').join('')}
      </div>
    </div>`;

  const toolbarSkeleton = () => `<div class="skeleton sk-toolbar"></div>`;

  const views = {
    dashboard: `${summaryCards()}${quickActions()}`,
    payroll: `
      <div style="display:flex;justify-content:flex-end"><div class="skeleton" style="width:120px;height:38px;border-radius:6px"></div></div>
      ${toolbarSkeleton()}
      ${summaryCards()}
      ${tableSkeleton(6)}`,
    attendance: `
      ${toolbarSkeleton()}
      ${summaryCards5()}
      <div class="sk-panel">
        <div class="sk-panel-header">
          <div class="skeleton" style="width:140px;height:16px"></div>
          <div class="skeleton" style="width:100px;height:22px;border-radius:999px;margin-left:auto"></div>
        </div>
        <div class="inline-form" style="display:grid;grid-template-columns:repeat(5,1fr);gap:14px;padding:18px 20px;border-bottom:1px solid var(--line)">
          ${Array.from({ length: 5 }, () => '<div class="skeleton" style="height:38px;border-radius:6px"></div>').join('')}
        </div>
        ${Array.from({ length: 4 }, () => `
          <div class="sk-row">
            <div class="skeleton sk-cell-sm"></div>
            <div class="skeleton sk-cell-sm"></div>
            <div class="skeleton sk-cell-lg"></div>
            <div class="skeleton sk-badge"></div>
            <div class="skeleton sk-cell"></div>
            <div class="skeleton sk-cell"></div>
            <div class="skeleton sk-cell-sm"></div>
          </div>
        `).join('')}
      </div>`,
    employees: `
      ${toolbarSkeleton()}
      ${summaryCards3()}
      ${tableSkeleton(4)}`,
    archive: `
      ${toolbarSkeleton()}
      ${tableSkeleton(4)}`,
    cashAdvance: `
      ${toolbarSkeleton()}
      ${tableSkeleton(4)}`
  };
  return views[view] || views.dashboard;
}

function showSkeleton() {
  const content = skeletonViewHTML(state.view);
  shell(content);
}

/* ── Loading Overlay (for modals, kept as fallback) ── */
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
  showSkeleton();
  try {
    return await fn();
  } finally {
    // Skeleton is replaced by real content in refresh() via render*() calls
  }
}

function shell(content) {
  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: 'D' },
    { id: 'payroll', label: 'Payroll', icon: '$' },
    { id: 'attendance', label: 'Attendance', icon: 'A' },
    { id: 'employees', label: 'Employees', icon: 'E' },
    { id: 'archive', label: 'Archive', icon: '📦' }
  ];
  const collapsed = state.sidebarCollapsed;
  const userInitials = state.user.username.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'U';
  app.innerHTML = `
    <section class="layout${collapsed ? ' sidebar-collapsed' : ''}">
      <aside class="sidebar${collapsed ? ' collapsed' : ''}">
        <button class="sidebar-toggle" id="sidebarToggle" title="${collapsed ? 'Expand sidebar' : 'Collapse sidebar'}">
          <span class="toggle-label">${collapsed ? 'Expand' : 'Collapse'}</span>
          <span class="toggle-icon">◀</span>
        </button>
        <div class="sidebar-brand">
          <div class="sidebar-brand-icon">P</div>
          <div class="sidebar-brand-text">
            <strong>Payroll</strong>
            <small>Attendance & weekly pay</small>
          </div>
        </div>
        <nav class="sidebar-nav">
          <div class="nav-section-label">Main Menu</div>
          ${navItems.map(({ id, label, icon }) => `
            <button class="${state.view === id ? 'active' : ''}" data-view="${id}" title="${label}">
              <span class="nav-icon">${icon}</span>
              <span class="nav-label">${label}</span>
            </button>
          `).join('')}
        </nav>
        <div class="sidebar-user">
          <div class="sidebar-user-info">
            <div class="sidebar-user-avatar">${userInitials}</div>
            <div class="sidebar-user-details">
              <strong>${state.user.username}</strong>
              <span class="role-badge role-${state.user.role}">${state.user.role === 'admin' ? 'Admin' : 'HR Staff'}</span>
            </div>
          </div>
          <div class="sidebar-user-perms">
            ${state.user.role === 'admin'
              ? '<span class="perm-item">Full Access</span><span class="perm-item">Delete Records</span><span class="perm-item">Audit Trail</span>'
              : '<span class="perm-item">Create & Edit</span><span class="perm-item">View Reports</span><span class="perm-item perm-disabled">Cannot Delete</span>'
            }
          </div>
          <div class="sidebar-actions">
            <button class="theme-toggle-btn" id="darkModeToggle">${document.body.classList.contains('dark-mode') ? '☀' : '🌙'} <span>${document.body.classList.contains('dark-mode') ? 'Light Mode' : 'Dark Mode'}</span></button>
            <button id="switchUserBtn">🔄 <span>Switch User</span></button>
            <button id="logoutBtn">🚪 <span>Logout</span></button>
          </div>
          <div class="session-info" id="sessionInfo">Session active</div>
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
            ${state.user.role === 'admin' ? 'Admin' : 'HR'}
          </span>
          <div class="mobile-actions">
            <button class="mobile-action-btn" id="mobileDarkToggle" title="Toggle dark mode">${document.body.classList.contains('dark-mode') ? '☀' : '🌙'}</button>
            <button class="mobile-action-btn" id="mobileSwitchUser" title="Switch user">🔄</button>
            <button class="mobile-action-btn" id="mobileLogoutBtn" title="Logout">🚪</button>
          </div>
        </div>
        ${content}
        ${state.showLogoutConfirm ? logoutConfirmModal() : ''}
        ${state.pendingDelete ? confirmDeleteModal() : ''}
        ${state.showAudit ? auditTrailModal() : ''}
      </section>
      <nav class="bottom-nav">
        ${navItems.map(({ id, label, icon }) => `
          <button class="bottom-nav-item${state.view === id ? ' active' : ''}" data-view="${id}">
            <span class="bottom-nav-icon">${icon === '📦' ? '📦' : icon}</span>
            <span class="bottom-nav-label">${label}</span>
          </button>
        `).join('')}
      </nav>
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
  document.querySelector('#sidebarToggle')?.addEventListener('click', () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    saveUiState();
    /* Toggle CSS classes directly so CSS transitions animate smoothly */
    const layout = document.querySelector('.layout');
    const sidebar = document.querySelector('.sidebar');
    const toggle = document.querySelector('#sidebarToggle');
    if (layout) layout.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
    if (sidebar) sidebar.classList.toggle('collapsed', state.sidebarCollapsed);
    if (toggle) {
      toggle.title = state.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
      const label = toggle.querySelector('.toggle-label');
      if (label) label.textContent = state.sidebarCollapsed ? 'Expand' : 'Collapse';
    }
  });
  document.querySelector('#darkModeToggle')?.addEventListener('click', () => {
    const isDark = document.body.classList.toggle('dark-mode');
    localStorage.setItem('payrollDarkMode', isDark ? 'true' : '');
    document.querySelector('#darkModeToggle').innerHTML = isDark ? '☀ <span>Light Mode</span>' : '🌙 <span>Dark Mode</span>';
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

  /* Mobile action buttons */
  document.querySelector('#mobileDarkToggle')?.addEventListener('click', () => {
    const isDark = document.body.classList.toggle('dark-mode');
    localStorage.setItem('payrollDarkMode', isDark ? 'true' : '');
    document.querySelector('#mobileDarkToggle').textContent = isDark ? '☀' : '🌙';
    /* Also sync main toggle if visible */
    const mainToggle = document.querySelector('#darkModeToggle');
    if (mainToggle) {
      mainToggle.innerHTML = isDark ? '☀ <span>Light Mode</span>' : '🌙 <span>Dark Mode</span>';
    }
  });
  document.querySelector('#mobileSwitchUser')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    state.user = null;
    state.showLogoutConfirm = false;
    stopDataPoller();
    stopSessionTimer();
    renderLogin();
  });
  document.querySelector('#mobileLogoutBtn')?.addEventListener('click', async () => {
    state.showLogoutConfirm = true;
    shell(content);
  });
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

/* ── Refresh (with skeleton) ── */
async function refresh() {
  saveUiState();
  await withLoading(loadData);
  reRenderCurrentView();
}

/* ── Targeted Partial Refresh (only reload what changed) ── */
async function partialRefresh(types) {
  saveUiState();
  const payrollQs = new URLSearchParams({ week: state.payrollWeek, today: state.currentDate });
  if (state.view === 'archive') payrollQs.set('include_inactive', 'true');
  const attendanceQs = new URLSearchParams({ week: state.week, search: state.searchAttendance, today: state.currentDate });
  state.currentDate = todayInManila();

  const fetchers = {
    employees: api(`/api/employees?search=${encodeURIComponent(state.searchEmployees)}&active=${state.view === 'archive' ? 'false' : 'true'}`),
    payroll: api(`/api/payroll?${payrollQs}`),
    attendance: api(`/api/attendance?${attendanceQs}`),
    advances: api(`/api/cash-advances?week=${state.payrollWeek}`),
    extraPayments: api(`/api/extra-payments?week=${state.payrollWeek}`),
    balePayments: api(`/api/bale-payments?week=${state.payrollWeek}`),
    salaryPayments: api(`/api/salary-payments?week=${state.payrollWeek}`)
  };

  const promises = types.map(t => fetchers[t]);
  const results = await Promise.allSettled(promises);

  types.forEach((t, i) => {
    if (results[i].status === 'fulfilled') {
      state[t] = results[i].value;
    }
  });

  reRenderCurrentView();
}

/* ── Re-render current view ── */
function reRenderCurrentView() {
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
