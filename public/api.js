async function api(url, options = {}) {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(url, {
    headers: isFormData ? { ...(options.headers || {}) } : { 'Content-Type': 'application/json', ...(options.headers || {}) },
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
}

async function loadData() {
  if (!state.user) return;
  state.currentDate = todayInManila();
  const payrollQs = new URLSearchParams({ week: state.payrollWeek, today: state.currentDate });
  const attendanceQs = new URLSearchParams({ week: state.week, search: state.searchAttendance, today: state.currentDate });
  const promises = [
    api(`/api/employees?search=${encodeURIComponent(state.searchEmployees)}&active=${state.view === 'archive' ? 'false' : 'true'}`),
    api(`/api/payroll?${payrollQs}`),
    api(`/api/attendance?${attendanceQs}`),
    api(`/api/cash-advances?week=${state.payrollWeek}`),
    api(`/api/extra-payments?week=${state.payrollWeek}`),
    api(`/api/bale-payments?week=${state.payrollWeek}`),
    api(`/api/salary-payments?week=${state.payrollWeek}`)
  ];
  promises.push(Promise.resolve({ rows: [] }));

  const [employees, payroll, attendance, advances, extraPayments, balePayments, salaryPayments, auditLogs] = await Promise.all(promises);
  state.employees = employees;
  state.payroll = payroll;
  state.attendance = attendance;
  state.advances = advances;
  state.extraPayments = extraPayments;
  state.balePayments = balePayments;
  state.salaryPayments = salaryPayments;
  state.auditLogs = auditLogs;
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
