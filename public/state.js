const savedState = loadSavedState();
const savedView = ['dashboard', 'payroll', 'attendance', 'employees', 'archive'].includes(savedState.view) ? savedState.view : 'dashboard';
const currentDay = todayInManila();
const currentWeek = payrollWeekStartOf(currentDay);
const savedWeek = payrollWeekStartOf(savedState.week || currentDay);

const initialStateWeek = savedView === 'attendance' ? currentWeek : (savedWeek < currentWeek ? currentWeek : savedWeek);

const state = {
  user: null,
  view: savedView,
  week: initialStateWeek,
  payrollWeek: initialStateWeek,
  attendanceDate: currentDay,
  currentDate: currentDay,
  search: '',
  searchPayroll: savedState.search || '',
  searchAttendance: '',
  searchEmployees: '',
  employees: [],
  payroll: null,
  attendance: null,
  advances: null,
  extraPayments: [],
  balePayments: [],
  salaryPayments: [],
  auditLogs: [],
  editingEmployee: null,
  editingCashAdvance: null,
  editingExtraPayment: null,
  editingSalaryPayment: null,
  editingBalePayment: null,
  cashEmployee: null,
  paymentEmployee: null,
  baleDeductionEmployee: null,
  extraPaymentEmployee: null,
  showLogoutConfirm: false,
  showAudit: false,
  pendingDelete: null,
  archivedEmployees: [],
  pages: { payroll: 1, attendance: 1, employees: 1, archive: 1 },
  _flash: null,
  sidebarCollapsed: savedState.sidebarCollapsed || false
};

function loadSavedState() {
  try {
    return JSON.parse(localStorage.getItem('payrollUiState')) || {};
  } catch {
    return {};
  }
}

function saveUiState() {
  localStorage.setItem('payrollUiState', JSON.stringify({
    view: state.view,
    week: state.view === 'payroll' ? state.week : state.payrollWeek,
    search: state.searchPayroll,
    sidebarCollapsed: state.sidebarCollapsed
  }));
}

function isModalOpen() {
  return state.editingEmployee || state.cashEmployee || state.paymentEmployee ||
    state.extraPaymentEmployee || state.pendingDelete || state.showAudit || state.showLogoutConfirm;
}
