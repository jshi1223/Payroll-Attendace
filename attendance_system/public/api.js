let csrfToken = null;

function setCsrfToken(token) {
  csrfToken = token;
}

async function api(url, options = {}) {
  const isFormData = options.body instanceof FormData;
  const method = (options.method || 'GET').toUpperCase();
  const headers = isFormData ? { ...(options.headers || {}) } : { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (csrfToken && method !== 'GET' && method !== 'HEAD') {
    headers['X-CSRF-Token'] = csrfToken;
  }
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers,
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

async function loadMe() {
  const data = await api('/api/me');
  state.user = data.user;
  if (data.sessionTTL != null) {
    state.sessionTTL = data.sessionTTL;
    state.loggedInAt = Date.now();
  }
  if (data.lastLogin) {
    state.lastLogin = data.lastLogin;
  }
  if (data.csrfToken) {
    setCsrfToken(data.csrfToken);
  }
}

async function loadData() {
  if (!state.user) return;
  state.currentDate = todayInManila();
  const pd = state.payPeriodDays || 7;
  const payrollQs = new URLSearchParams({ week: state.payrollWeek, today: state.currentDate, periodDays: pd });
  if (state.view === 'archive') payrollQs.set('include_inactive', 'true');
  const attendanceQs = new URLSearchParams({ week: state.week, search: state.searchAttendance, today: state.currentDate, periodDays: pd });
  const regQs = new URLSearchParams({ status: state.registrationsStatus || 'pending', search: state._registrationsSearch });
  const promises = [
    api(`/api/employees?search=${encodeURIComponent(state.searchEmployees)}&active=${state.view === 'archive' ? 'false' : 'true'}`),
    api(`/api/payroll?${payrollQs}`),
    api(`/api/attendance?${attendanceQs}`),
    api(`/api/cash-advances?week=${state.payrollWeek}&periodDays=${pd}`),
    api(`/api/extra-payments?week=${state.payrollWeek}&periodDays=${pd}`),
    api(`/api/bale-payments?week=${state.payrollWeek}&periodDays=${pd}`),
    api(`/api/salary-payments?week=${state.payrollWeek}&periodDays=${pd}`),
    api(`/api/registrations?${regQs}`),
    api('/api/cash-advance-requests'),
    api('/api/payslip-requests')
  ];

  const [employees, payroll, attendance, advances, extraPayments, balePayments, salaryPayments, registrations, cashAdvanceRequests, payslipRequests] = await Promise.all(promises);
  state.payslipRequests = payslipRequests?.rows || [];
  state.payslipRequestCounts = payslipRequests?.counts || {};
  state.employees = employees;
  state.payroll = payroll;
  state.attendance = attendance;
  state.advances = advances;
  state.extraPayments = extraPayments;
  state.balePayments = balePayments;
  state.salaryPayments = salaryPayments;
  state.registrations = registrations.rows || registrations;
  state.registrationCounts = registrations.counts || {};
  state.cashAdvanceRequests = cashAdvanceRequests.rows || [];
  state.cashAdvanceRequestCounts = cashAdvanceRequests.counts || {};
}

async function loadRegistrations() {
  const regQs = new URLSearchParams({ status: state.registrationsStatus || 'pending', search: state._registrationsSearch });
  const data = await api(`/api/registrations?${regQs}`);
  state.registrations = data.rows || [];
  state.registrationCounts = data.counts || {};
  syncNavBadge();
}

async function loadCashAdvanceRequests() {
  const qs = new URLSearchParams({
    status: state.cashAdvanceRequestStatus || '',
    search: state._caRequestsSearch || ''
  });
  const data = await api(`/api/cash-advance-requests?${qs}`);
  state.cashAdvanceRequests = data.rows || [];
  state.cashAdvanceRequestCounts = data.counts || {};
  syncNavBadge();
}

async function loadPayslipRequests() {
  const qs = new URLSearchParams({
    status: state.payslipRequestsStatus || '',
    search: state._payslipRequestsSearch || ''
  });
  const data = await api(`/api/payslip-requests?${qs}`);
  state.payslipRequests = data.rows || [];
  state.payslipRequestCounts = data.counts || {};
  syncNavBadge();
}

async function loadAuditLogs() {
  const params = new URLSearchParams();
  if (auditFilterState.entity) params.set('entity', auditFilterState.entity);
  if (auditFilterState.action) params.set('action', auditFilterState.action);
  if (auditFilterState.search) params.set('search', auditFilterState.search);
  if (auditFilterState.date_from) params.set('date_from', auditFilterState.date_from);
  if (auditFilterState.date_to) params.set('date_to', auditFilterState.date_to);
  params.set('page', auditFilterState.page);
  params.set('pageSize', '30');
  return api(`/api/audit-logs?${params}`);
}
