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

function toggleDarkMode() {
  const isDark = document.body.classList.toggle('dark-mode');
  localStorage.setItem('payrollDarkMode', isDark ? 'true' : '');
}

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
      ${tableSkeleton(4)}`,
    approvals: `
      ${toolbarSkeleton()}
      ${summaryCards3()}
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
    { id: 'dashboard', label: 'Dashboard', icon: '' },
    { id: 'employees', label: 'Employees', icon: '' },
    { id: 'attendance', label: 'Attendance', icon: '' },
    { id: 'approvals', label: 'Approvals', icon: '' },
    { id: 'cashAdvance', label: 'Cash Advance', icon: '' },
    { id: 'payroll', label: 'Payroll', icon: '' },
    { id: 'archive', label: 'Archive', icon: '' }
  ];
  const collapsed = state.sidebarCollapsed;
  const searchValue = state.view === 'payroll' ? state.searchPayroll
    : state.view === 'attendance' ? state.searchAttendance
    : (state.view === 'employees' || state.view === 'archive') ? state.searchEmployees
    : state.view === 'approvals' ? state._registrationsSearch
    : '';
  const activeSearch = String(searchValue || '').trim().length > 0;
  const userInitials = state.user.username.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'U';
  app.innerHTML = `
    <section class="layout${collapsed ? ' sidebar-collapsed' : ''}">
      <div class="sidebar-overlay" id="sidebarOverlay"></div>
      <aside class="sidebar${collapsed ? ' collapsed' : ''} mobile-hidden">
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
              ${icon ? `<span class="nav-icon">${icon}</span>` : ''}
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
              ? '<span class="perm-item">Full Access</span><span class="perm-item">Delete Records</span><span class="perm-item">System Logs</span>'
              : '<span class="perm-item">Create & Edit</span><span class="perm-item">View Reports</span><span class="perm-item perm-disabled">Cannot Delete</span>'
            }
          </div>
          <div class="sidebar-actions">
            <button id="settingsBtn" data-short="Set"><span>Settings</span></button>
            <button id="switchUserBtn" data-short="User"><span>Switch User</span></button>
            <button id="logoutBtn" data-short="Exit"><span>Logout</span></button>
          </div>
          <div class="session-info" id="sessionInfo">Session active</div>
        </div>
      </aside>
      <section class="content${activeSearch ? ' search-active' : ''}">
        <div class="topbar">
          <div class="page-title">
            <span class="page-kicker">${state.view.toUpperCase()}</span>
            <h1>${titleForView()}</h1>
            <p>Today: ${state.currentDate} | Week: ${state.week} to ${addDays(state.week, (state.payPeriodDays || 7) - 1)}</p>
          </div>
          <span class="badge role-${state.user.role}">
            ${state.user.role === 'admin' ? 'Admin' : 'HR'}
          </span>
          <div class="mobile-actions">
            <button class="mobile-action-btn menu-btn" id="mobileMenuBtn" title="Menu">M</button>
            <button class="mobile-action-btn" id="mobileSettingsBtn" title="Settings">Set</button>
            <button class="mobile-action-btn" id="mobileSwitchUser" title="Switch user">Usr</button>
            <button class="mobile-action-btn" id="mobileLogoutBtn" title="Logout">X</button>
          </div>
        </div>
        ${content}
${state.showSettings ? settingsModal() : ''}
${state.showManagePayroll ? managePayrollModal() : ''}
${state.showLogoutConfirm ? logoutConfirmModal() : ''}
${state.showChangePassword ? changePasswordModal() : ''}
${state.showCloseConfirm ? closeConfirmModal() : ''}
        ${state.pendingDelete ? confirmDeleteModal() : ''}
        ${state.showAudit ? auditTrailModal() : ''}
      </section>
      <nav class="bottom-nav">
        ${navItems.map(({ id, label, icon }) => `
          <button class="bottom-nav-item${state.view === id ? ' active' : ''}" data-view="${id}">
            ${icon ? `<span class="bottom-nav-icon">${icon === '📦' ? '📦' : icon}</span>` : ''}
            <span class="bottom-nav-label">${label}</span>
          </button>
        `).join('')}
      </nav>
    </section>
  `;
  state._flash = null;
  document.querySelectorAll('[data-view]').forEach(button => {
    button.addEventListener('click', async () => {
      state.view = button.dataset.view;
      state.editingEmployee = null;
      state.editingCashAdvance = null;
      state.searchPayroll = '';
      state.searchEmployees = '';
      state.searchAttendance = '';
      if (state.view === 'attendance') {
        state.attendanceDate = todayInManila();
        state.week = payrollWeekStartOf(state.attendanceDate);
      } else if (state.view === 'payroll' || state.view === 'cashAdvance') {
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
  document.querySelector('#settingsBtn')?.addEventListener('click', () => {
    state.showSettings = true;
    shell(content);
  });
  document.querySelector('#logoutBtn').addEventListener('click', async () => {
    state.showLogoutConfirm = true;
    shell(content);
  });
  bindLogoutConfirmModal();
  bindConfirmDeleteModal();
  bindChangePasswordModal();
  bindCloseConfirmModal();
  bindUserSwitcher();
  bindSettingsModal();
  bindManagePayrollModal();
  startSessionTimer();
  if (state.showAudit) bindAuditTrailModal();

  /* Mobile action buttons */
  document.querySelector('#mobileSettingsBtn')?.addEventListener('click', () => {
    state.showSettings = true;
    shell(content);
  });
  document.querySelector('#mobileSwitchUser')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    state.user = null;
    state.showLogoutConfirm = false;
    stopSessionTimer();
    renderLogin();
  });
  document.querySelector('#mobileLogoutBtn')?.addEventListener('click', async () => {
    state.showLogoutConfirm = true;
    shell(content);
  });

  /* Mobile sidebar: hamburger menu toggle */
  document.querySelector('#mobileMenuBtn')?.addEventListener('click', () => {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('#sidebarOverlay');
    if (sidebar) {
      sidebar.classList.toggle('mobile-open');
      if (sidebar.classList.contains('mobile-open')) {
        sidebar.classList.remove('mobile-hidden');
      } else {
        sidebar.classList.add('mobile-hidden');
      }
    }
    if (overlay) overlay.classList.toggle('active');
  });
  document.querySelector('#sidebarOverlay')?.addEventListener('click', () => {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('#sidebarOverlay');
    if (sidebar) {
      sidebar.classList.remove('mobile-open');
      sidebar.classList.add('mobile-hidden');
    }
    if (overlay) overlay.classList.remove('active');
  });
  /* Close sidebar when a nav button is clicked on mobile */
  document.querySelectorAll('.sidebar-nav button[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const sidebar = document.querySelector('.sidebar');
      const overlay = document.querySelector('#sidebarOverlay');
      if (window.innerWidth < 1024 && sidebar) {
        sidebar.classList.remove('mobile-open');
        sidebar.classList.add('mobile-hidden');
      }
      if (overlay) overlay.classList.remove('active');
    });
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
      el.className = 'session-info';
      return;
    }
    const elapsed = Math.floor((Date.now() - state.loggedInAt) / 1000);
    const remaining = Math.max(0, state.sessionTTL - elapsed);
    if (remaining === 0) {
      el.textContent = 'Session expired — please re-login';
      el.className = 'session-info session-expired';
      return;
    }
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    el.textContent = `Session: ${mins}m ${String(secs).padStart(2, '0')}s remaining`;
    if (remaining <= 120) el.className = 'session-info session-critical';
    else if (remaining <= 300) el.className = 'session-info session-warning';
    else el.className = 'session-info';
  }, 1000);
}

function bindUserSwitcher() {
  document.querySelector('#switchUserBtn')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    state.user = null;
    state.showLogoutConfirm = false;
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
  await reRenderCurrentView();
}

/* ── Targeted Partial Refresh (only reload what changed) ── */
async function partialRefresh(types) {
  saveUiState();
  state.currentDate = todayInManila();
  const pd = state.payPeriodDays || 7;
  const payrollQs = new URLSearchParams({ week: state.payrollWeek, today: state.currentDate, periodDays: pd });
  if (state.view === 'archive') payrollQs.set('include_inactive', 'true');
  const attendanceQs = new URLSearchParams({ week: state.week, search: state.searchAttendance, today: state.currentDate, periodDays: pd });
  const fetchers = {
    employees: api(`/api/employees?search=${encodeURIComponent(state.searchEmployees)}&active=${state.view === 'archive' ? 'false' : 'true'}`),
    payroll: api(`/api/payroll?${payrollQs}`),
    attendance: api(`/api/attendance?${attendanceQs}`),
    advances: api(`/api/cash-advances?week=${state.payrollWeek}&periodDays=${pd}`),
    extraPayments: api(`/api/extra-payments?week=${state.payrollWeek}&periodDays=${pd}`),
    balePayments: api(`/api/bale-payments?week=${state.payrollWeek}&periodDays=${pd}`),
    salaryPayments: api(`/api/salary-payments?week=${state.payrollWeek}&periodDays=${pd}`),
    registrations: api(`/api/registrations?${new URLSearchParams({ status: state.registrationsStatus || 'pending', search: state._registrationsSearch })}`)
  };

  const promises = types.map(t => fetchers[t]);
  const results = await Promise.allSettled(promises);

  types.forEach((t, i) => {
    if (results[i].status === 'fulfilled') {
      if (t === 'registrations') {
        state.registrations = results[i].value.rows || results[i].value || [];
        state.registrationCounts = results[i].value.counts || {};
      } else {
        state[t] = results[i].value;
      }
    }
  });

  reRenderCurrentView();
}

/* ── Re-render current view ── */
async function reRenderCurrentView() {
  const payrollRows = state.payroll?.rows || [];
  if (state.payrollModalEmployee) {
    const fresh = payrollRows.find(r => Number(r.employee_id) === Number(state.payrollModalEmployee.employee_id));
    if (fresh) state.payrollModalEmployee = fresh;
  }
  if (state.view === 'dashboard') renderDashboard();
  if (state.view === 'payroll') await renderPayroll();
  if (state.view === 'attendance') await renderAttendance();
  if (state.view === 'employees') renderEmployees();
  if (state.view === 'cashAdvance') await renderCashAdvance();
  if (state.view === 'archive') renderArchive();
  if (state.view === 'approvals') renderApprovals();
}

/* ── Keyboard Shortcuts Help Modal ── */
function showShortcutHelp() {
  const existing = document.querySelector('#shortcutHelpModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'shortcutHelpModal';
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <section class="modal" style="max-width:420px;">
      <div class="modal-head">
        <div><h2>Keyboard Shortcuts</h2></div>
        <button class="icon-btn" id="closeShortcutHelp" aria-label="Close">x</button>
      </div>
      <div style="padding:16px 20px;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr><td style="padding:6px 0;"><kbd>1</kbd> – <kbd>5</kbd></td><td>Switch views (1=Dashboard, 2=Payroll, 3=Attendance, 4=Employees, 5=Archive)</td></tr>
          <tr><td style="padding:6px 0;"><kbd>/</kbd></td><td>Focus search input</td></tr>
          <tr><td style="padding:6px 0;"><kbd>←</kbd> <kbd>→</kbd></td><td>Navigate previous/next payroll period</td></tr>
          <tr><td style="padding:6px 0;"><kbd>?</kbd></td><td>Show this help</td></tr>
          <tr><td style="padding:6px 0;"><kbd>Esc</kbd></td><td>Close modal / Cancel</td></tr>
        </table>
      </div>
    </section>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.querySelector('#closeShortcutHelp')?.addEventListener('click', () => modal.remove());
}

/* ── Global Keyboard Shortcuts ── */
document.addEventListener('keydown', event => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (event.key === 'Escape') {
      event.target.blur();
    }
    return;
  }
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    event.preventDefault();
    const search = document.querySelector('#searchInput') || document.querySelector('#employeeSearch') || document.querySelector('#archiveSearch');
    if (search) search.focus();
    return;
  }
  const viewKeys = { '1': 'dashboard', '2': 'payroll', '3': 'attendance', '4': 'employees', '5': 'archive' };
  const targetView = viewKeys[event.key];
  if (targetView && !event.ctrlKey && !event.metaKey && !event.altKey && !isModalOpen()) {
    if (state.view !== targetView) {
      event.preventDefault();
      state.view = targetView;
      state.editingEmployee = null;
      state.editingCashAdvance = null;
      state.searchPayroll = '';
      state.searchEmployees = '';
      state.searchAttendance = '';
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
  if (event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    showShortcutHelp();
    return;
  }
  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !isModalOpen() && !event.ctrlKey && !event.metaKey) {
    if (state.view === 'payroll' || state.view === 'dashboard') {
      event.preventDefault();
      const pd = state.payPeriodDays || 7;
      const step = pd;
      state.week = addDays(state.week, event.key === 'ArrowLeft' ? -step : step);
      state.payrollWeek = state.week;
      saveUiState();
      refresh();
    } else if (state.view === 'attendance') {
      event.preventDefault();
      state.attendanceDate = addDays(state.attendanceDate, event.key === 'ArrowLeft' ? -1 : 1);
      state.week = payrollWeekStartOf(state.attendanceDate);
      state.payrollWeek = state.week;
      saveUiState();
      refresh();
    }
  }
});



/* ── Boot ── */
async function boot() {
  const splashBar = document.getElementById('splashBar');
  const splashWrapper = document.getElementById('splashWrapper');
  function setSplash(pct) {
    if (splashBar) splashBar.style.width = pct + '%';
  }

  setSplash(15);
  if (localStorage.getItem('payrollDarkMode') === 'true') {
    document.body.classList.add('dark-mode');
  }
  if (window.electronAPI) {
    window.electronAPI.onCloseRequest(() => {
      if (state.user) {
        state.showCloseConfirm = true;
        reRenderCurrentView();
      } else {
        window.electronAPI.closeResponse('logout-and-close');
      }
    });
  }

  setSplash(35);
  await loadMe();

  if (!state.user) {
    setSplash(100);
    await new Promise(r => setTimeout(r, 80));
    if (splashWrapper) splashWrapper.classList.add('fade-out');
    return renderLogin();
  }

  setSplash(55);
  await refresh();

  setSplash(85);
  await new Promise(r => setTimeout(r, 80));

  setSplash(100);
  await new Promise(r => setTimeout(r, 100));
  if (splashWrapper) splashWrapper.classList.add('fade-out');
  startDateWatcher();
}

boot().catch(error => {
  const sw = document.getElementById('splashWrapper');
  if (sw) sw.classList.add('fade-out');
  app.innerHTML = `<section class="login-screen"><div class="login-panel"><h1>Error</h1><p>${escapeHtml(error.message)}</p></div></section>`;
});
