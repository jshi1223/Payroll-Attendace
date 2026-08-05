const savedState = loadSavedState();
const savedView = ['dashboard', 'payroll', 'attendance', 'employees', 'archive', 'approvals'].includes(savedState.view) ? savedState.view : 'dashboard';
const currentDay = todayInManila();
const currentWeek = payrollWeekStartOf(currentDay);
const savedWeek = payrollWeekStartOf(savedState.week || currentDay);

const initialStateWeek = savedView === 'attendance' ? currentWeek : (savedWeek < currentWeek ? currentWeek : savedWeek);

const state = {
  user: null,
  view: savedView,
  week: initialStateWeek,
  payrollWeek: initialStateWeek,
  payPeriodDays: savedState.payPeriodDays || 7,
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
  _cashAdvSearch: '',
  payrollModalEmployee: null,
  payrollModalTab: 'pay',
  payrollModalStep: 1,
  payrollTransactionModal: false,
  showLogoutConfirm: false,
  showChangePassword: false,
  showCloseConfirm: false,
  showAudit: false,
  showSettings: false,
  showManagePayroll: false,
  managePayrollSelected: null,
  managePayrollTransModal: false,
  _managePayrollSearch: '',
  pendingDelete: null,
  archivedEmployees: [],
  calendarDates: [],
  registrations: [],
  registrationCounts: {},
  _registrationsSearch: '',
  registrationsStatus: '',
  pages: { payroll: 1, attendance: 1, employees: 1, cashAdvance: 1, archive: 1, approvals: 1 },
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
    payPeriodDays: state.payPeriodDays,
    sidebarCollapsed: state.sidebarCollapsed
  }));
}

function isModalOpen() {
  return state.editingEmployee || state.payrollModalEmployee || state.payrollTransactionModal ||
    state.pendingDelete || state.showAudit || state.showLogoutConfirm || state.showChangePassword || state.showCloseConfirm || state.showSettings || state.showManagePayroll;
}
