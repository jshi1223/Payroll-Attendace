/* ── Realtime Data Watcher ── */
let realtimeWatcher = null;
let eventSource = null;
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

/* ── Realtime Data Watcher ── */
function startRealtimeWatcher() {
  if (eventSource) return;

  const dataByView = {
    dashboard: ['employees', 'payroll', 'attendance', 'advances', 'extraPayments', 'balePayments', 'salaryPayments', 'registrations', 'cashAdvanceRequests', 'payslipRequests'],
    employees: ['employees'],
    archive: ['employees'],
    attendance: ['employees', 'attendance'],
    payroll: ['employees', 'payroll', 'advances', 'extraPayments', 'balePayments', 'salaryPayments'],
    cashAdvance: ['employees', 'advances'],
    approvals: ['registrations', 'cashAdvanceRequests', 'payslipRequests']
  };

  const scheduleRefresh = debounce(() => {
    if (!state.user || isModalOpen() || document.hidden) return;
    const activeTag = document.activeElement?.tagName;
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;
    const types = dataByView[state.view];
    if (!types) return;
    partialRefresh(types).catch(() => {
      // A later refresh will retry; do not interrupt an admin who is working.
    });
  }, 150);

  const connect = () => {
    const es = new EventSource('/api/events');
    eventSource = es;
    es.onmessage = (event) => {
      let data = null;
      try { data = JSON.parse(event.data); } catch (_) { /* ignore malformed frames */ }
      if (data && data.event) handleSseEvent(data);
      scheduleRefresh();
    };
    es.onerror = () => {
      es.close();
      if (eventSource === es) eventSource = null;
      if (state.user) realtimeWatcher = setTimeout(connect, 3000);
    };
  };
  connect();
}

/* ── Notification center (bell + popup toasts) ── */
const NOTIF_STORAGE_KEY = 'payrollNotifications';
let payrollNotifications = loadNotifications();
let notifPanelOpen = false;
let notifToastTimer = null;

function loadNotifications() {
  try {
    const list = JSON.parse(localStorage.getItem(NOTIF_STORAGE_KEY));
    return Array.isArray(list) ? list.slice(0, 30) : [];
  } catch {
    return [];
  }
}

function saveNotifications() {
  try {
    localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(payrollNotifications.slice(0, 30)));
  } catch (_) { /* storage unavailable */ }
}

function unreadNotificationCount() {
  return payrollNotifications.filter(n => !n.read).length;
}

function notifTimeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

const NOTIFICATION_EVENTS = {
  cash_advance_request: {
    title: 'Cash advance request',
    view: 'approvals',
    tab: 'cashAdvance',
    toast: true,
    message: d => {
      const amount = d.amount ? formatMoney(d.amount) : '';
      const pickup = d.pickup_date ? ` (pickup ${d.pickup_date})` : '';
      return `${d.name || 'An employee'} requested ${amount || 'a cash advance'}${pickup}.`;
    }
  },
  attendance_present: {
    title: 'Employee time in',
    view: 'attendance',
    toast: true,
    message: d => `${d.name || 'An employee'} clocked in.`
  },
  attendance_timeout: {
    title: 'Employee time out',
    view: 'attendance',
    toast: true,
    message: d => `${d.name || 'An employee'} clocked out.`
  },
  registration_pending: {
    title: 'New registration',
    view: 'approvals',
    tab: 'registrations',
    toast: true,
    message: d => `${d.name || 'An employee'} registered for approval.`
  },
  payslip_request: {
    title: 'Payslip request',
    view: 'approvals',
    tab: 'payslip',
    toast: true,
    message: d => {
      const period = d.period_start && d.period_end ? ` for ${d.period_start} → ${d.period_end}` : '';
      return `${d.name || 'An employee'} requested a payslip${period}.`;
    }
  }
};

function handleSseEvent(data) {
  if (!data || !data.event) return;
  const meta = NOTIFICATION_EVENTS[data.event];
  if (!meta) return;
  const message = typeof meta.message === 'function' ? meta.message(data) : meta.message;
  payrollNotifications.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    event: data.event,
    title: meta.title,
    message,
    view: meta.view,
    tab: meta.tab || '',
    ts: Date.now(),
    read: false
  });
  payrollNotifications = payrollNotifications.slice(0, 30);
  saveNotifications();
  updateNotifBell();
  if (meta.toast) showNotifToast(data.event, meta.title, message);
  // Keep the sidebar Approvals badge fresh no matter which view is open.
  if (data.event === 'registration_pending') loadRegistrations().catch(() => {});
  else if (data.event === 'cash_advance_request') loadCashAdvanceRequests().catch(() => {});
  else if (data.event === 'payslip_request') loadPayslipRequests().catch(() => {});
}

function showNotifToast(event, title, message) {
  document.querySelectorAll('.notif-toast').forEach(t => t.remove());
  const toast = document.createElement('div');
  toast.className = 'notif-toast';
  toast.innerHTML = `
    <div class="notif-toast-title">${escapeHtml(title)}</div>
    <div class="notif-toast-msg">${escapeHtml(message)}</div>
    <button class="notif-toast-close" title="Dismiss" aria-label="Dismiss">×</button>`;
  document.body.appendChild(toast);
  const close = () => toast.remove();
  toast.querySelector('.notif-toast-close').addEventListener('click', (e) => {
    e.stopPropagation();
    close();
  });
  if (notifToastTimer) clearTimeout(notifToastTimer);
  notifToastTimer = setTimeout(close, 6000);
  requestAnimationFrame(() => toast.classList.add('visible'));
  const meta = NOTIFICATION_EVENTS[event];
  if (meta && meta.view) {
    toast.addEventListener('click', () => {
      if (meta.tab) state.approvalsTab = meta.tab;
      navigateToView(meta.view);
      close();
    });
  }
}

function navigateToView(view) {
  const btn = document.querySelector(`.sidebar-nav button[data-view="${view}"]`);
  if (btn) {
    btn.click();
    return;
  }
  state.view = view;
  state.pages[view] = 1;
  saveUiState();
  refresh();
}

function updateNotifBell() {
  const slot = document.querySelector('#notifBellSlot');
  if (!slot) return;
  const count = unreadNotificationCount();
  slot.innerHTML = `
    <button class="notif-bell" id="notifBell" title="Notifications" aria-label="Notifications">
      <span class="notif-bell-icon">${count > 0 ? '🔔' : '🔕'}</span>
      ${count > 0 ? `<span class="notif-bell-badge">${count > 99 ? '99+' : count}</span>` : ''}
    </button>`;
  const bell = document.querySelector('#notifBell');
  if (bell) bell.addEventListener('click', toggleNotifPanel);
}

function renderNotifPanel() {
  let panel = document.querySelector('#notifPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'notifPanel';
    panel.className = 'notif-panel';
    const slot = document.querySelector('#notifBellSlot');
    (slot || document.body).appendChild(panel);
    document.addEventListener('click', (e) => {
      if (notifPanelOpen && !e.target.closest('#notifPanel') && !e.target.closest('#notifBell')) {
        notifPanelOpen = false;
        panel.classList.remove('open');
      }
    });
  }
  if (!notifPanelOpen) return;
  const list = payrollNotifications.slice(0, 15);
  panel.innerHTML = `
    <div class="notif-panel-head">
      <strong>Notifications</strong>
      ${payrollNotifications.length ? '<button class="ghost" id="notifClearAll">Clear all</button>' : ''}
    </div>
    <div class="notif-panel-list">
      ${list.length ? list.map(n => `
        <div class="notif-item${n.read ? '' : ' unread'}" data-notif-id="${n.id}" data-view="${n.view}" data-tab="${n.tab || ''}">
          <span class="notif-dot"></span>
          <div>
            <div class="notif-item-title">${escapeHtml(n.title)}</div>
            <div class="notif-item-msg">${escapeHtml(n.message)}</div>
            <div class="notif-item-time">${notifTimeAgo(n.ts)}</div>
          </div>
        </div>`).join('')
      : '<div class="notif-empty">No notifications yet.</div>'}
    </div>`;
  document.querySelector('#notifClearAll')?.addEventListener('click', () => {
    payrollNotifications = [];
    saveNotifications();
    renderNotifPanel();
    updateNotifBell();
  });
  panel.querySelectorAll('.notif-item').forEach(item => {
    item.addEventListener('click', () => {
      const notif = payrollNotifications.find(n => n.id === item.dataset.notifId);
      if (notif) notif.read = true;
      saveNotifications();
      notifPanelOpen = false;
      panel.classList.remove('open');
      updateNotifBell();
      if (item.dataset.view) {
        if (item.dataset.view === 'approvals' && item.dataset.tab) state.approvalsTab = item.dataset.tab;
        navigateToView(item.dataset.view);
      }
    });
  });
}

function toggleNotifPanel() {
  notifPanelOpen = !notifPanelOpen;
  if (notifPanelOpen) renderNotifPanel();
  const panel = document.querySelector('#notifPanel');
  if (!panel) return;
  panel.classList.toggle('open', notifPanelOpen);
}

function renderNotificationBell() {
  updateNotifBell();
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
      ${summaryCards3()}
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
          ${navItems.map(({ id, label, icon }) => {
            const pending = id === 'approvals'
              ? (state.cashAdvanceRequestCounts?.pending || 0) + (state.payslipRequestCounts?.pending || 0) + (state.registrationCounts?.pending || 0) + (state.registrationCounts?.review || 0)
              : 0;
            const badge = pending > 0
              ? `<span class="nav-badge">${pending > 99 ? '99+' : pending}</span>` : '';
            return `
            <button class="${state.view === id ? 'active' : ''}" data-view="${id}" title="${label}">
              ${icon ? `<span class="nav-icon">${icon}</span>` : ''}
              <span class="nav-label">${label}</span>
              ${badge}
            </button>`;
          }).join('')}
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
          <button class="mobile-action-btn mobile-menu-btn" id="mobileMenuBtn" type="button" title="Open menu" aria-label="Open menu">☰</button>
          <div class="page-title">
            <span class="page-kicker">${state.view.toUpperCase()}</span>
            <h1>${titleForView()}</h1>
            <p>Today: ${state.currentDate} | Week: ${state.week} to ${addDays(state.week, (state.payPeriodDays || 7) - 1)}</p>
          </div>
          <span class="badge role-${state.user.role} topbar-role-badge">
            ${state.user.role === 'admin' ? 'Admin' : 'HR'}
          </span>
          <div class="mobile-actions">
            <button class="mobile-action-btn" id="mobileSettingsBtn" title="Settings">Set</button>
            <button class="mobile-action-btn" id="mobileSwitchUser" title="Switch user">Usr</button>
            <button class="mobile-action-btn" id="mobileLogoutBtn" title="Logout">X</button>
          </div>
          <span id="notifBellSlot" class="notif-bell-slot"></span>
        </div>
        ${content}
${state.showSettings ? settingsModal() : ''}
${state.showManagePayroll ? managePayrollModal() : ''}
${state.showLogoutConfirm ? logoutConfirmModal() : ''}
${state.showChangePassword ? changePasswordModal() : ''}
${state.showCloseConfirm ? closeConfirmModal() : ''}
        ${state.pendingDelete ? confirmDeleteModal() : ''}
${state.editingAttendance ? editAttendanceModal(state.editingAttendance) : ''}
${state.showBroadcast ? broadcastModal() : ''}
${state.showAudit ? auditTrailModal() : ''}
${state._generatedPayslip ? payslipGeneratedModal() : ''}
      </section>
    </section>
  `;
  state._flash = null;
  document.querySelectorAll('[data-view]').forEach(button => {
    button.addEventListener('click', async () => {
      state.view = button.dataset.view;
      state.editingEmployee = null;
      state.editingCashAdvance = null;
      state.editingAttendance = null;
      state.showBroadcast = false;
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
  bindAttendanceEditButtons();
  if (state.editingAttendance) bindEditAttendanceModal();
  if (state.showBroadcast) bindBroadcastModal();
  bindChangePasswordModal();
  bindCloseConfirmModal();
  bindUserSwitcher();
  bindSettingsModal();
  bindManagePayrollModal();
  startSessionTimer();
  if (state.showAudit) bindAuditTrailModal();
  if (state._generatedPayslip) bindPayslipGeneratedModal();
  renderNotificationBell();

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
  syncNavBadge();
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
    registrations: api(`/api/registrations?${new URLSearchParams({ status: state.registrationsStatus || 'pending', search: state._registrationsSearch })}`),
    cashAdvanceRequests: api(`/api/cash-advance-requests`),
    payslipRequests: api('/api/payslip-requests')
  };

  const promises = types.map(t => fetchers[t]);
  const results = await Promise.allSettled(promises);

  types.forEach((t, i) => {
    if (results[i].status === 'fulfilled') {
      if (t === 'registrations') {
        state.registrations = results[i].value.rows || results[i].value || [];
        state.registrationCounts = results[i].value.counts || {};
      } else if (t === 'cashAdvanceRequests') {
        state.cashAdvanceRequests = results[i].value.rows || results[i].value || [];
        state.cashAdvanceRequestCounts = results[i].value.counts || {};
      } else if (t === 'payslipRequests') {
        state.payslipRequests = results[i].value.rows || results[i].value || [];
        state.payslipRequestCounts = results[i].value.counts || {};
      } else {
        state[t] = results[i].value;
      }
    }
  });

  reRenderCurrentView();
  syncNavBadge();
}

/* ── Re-render current view ── */
function syncNavBadge() {
  const views = [
    { view: 'approvals', pending: (state.cashAdvanceRequestCounts?.pending || 0) + (state.payslipRequestCounts?.pending || 0) + (state.registrationCounts?.pending || 0) + (state.registrationCounts?.review || 0) }
  ];
  for (const { view, pending } of views) {
    const btn = document.querySelector(`.sidebar-nav button[data-view="${view}"]`);
    if (!btn) continue;
    let badge = btn.querySelector('.nav-badge');
    if (pending > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-badge';
        btn.appendChild(badge);
      }
      badge.textContent = pending > 99 ? '99+' : String(pending);
    } else if (badge) {
      badge.remove();
    }
  }
}

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
  if (state.view === 'approvals') {
    if (state.approvalsTab === 'cashAdvance') renderCashAdvanceRequests();
    else if (state.approvalsTab === 'payslip') renderPayslipRequests();
    else renderApprovals();
  }
  if (state.view === 'archive') renderArchive();
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
  startRealtimeWatcher();
}

boot().catch(error => {
  const sw = document.getElementById('splashWrapper');
  if (sw) sw.classList.add('fade-out');
  app.innerHTML = `<section class="login-screen"><div class="login-panel"><h1>Error</h1><p>${escapeHtml(error.message)}</p></div></section>`;
});
