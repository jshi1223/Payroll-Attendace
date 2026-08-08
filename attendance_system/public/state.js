const savedState = loadSavedState();
const savedViewSource = savedState.view;
const savedViewRaw = savedViewSource === 'cashAdvanceRequests' ? 'approvals' : savedViewSource;
const savedApprovalsTab = ['cashAdvance', 'payslip'].includes(savedState.approvalsTab) ||
  savedViewSource === 'cashAdvanceRequests' ||
  (savedViewRaw === 'cashAdvance' && savedState.cashAdvanceTab !== 'records')
  ? (['cashAdvance', 'payslip'].includes(savedState.approvalsTab) ? savedState.approvalsTab : 'cashAdvance')
  : 'registrations';
const savedView = savedApprovalsTab === 'cashAdvance' && savedViewRaw === 'cashAdvance'
  ? 'approvals'
  : (['dashboard', 'payroll', 'attendance', 'employees', 'archive', 'approvals', 'cashAdvance'].includes(savedViewRaw) ? savedViewRaw : 'dashboard');
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
  editingAttendance: null,
  _cashAdvSearch: '',
  payrollModalEmployee: null,
  payrollModalTab: 'bale',
  payrollModalStep: 1,
  payrollTransactionModal: false,
  showLogoutConfirm: false,
  showChangePassword: false,
  showCloseConfirm: false,
  showAudit: false,
  showBroadcast: false,
  showSettings: false,
  showManagePayroll: false,
  managePayrollSelected: null,
  managePayrollTransModal: false,
  _managePayrollSearch: '',
  pendingDelete: null,
  _generatedPayslip: null,
  archivedEmployees: [],
  calendarDates: [],
  registrations: [],
  registrationCounts: {},
  _registrationsSearch: '',
  registrationsStatus: '',
  cashAdvanceRequests: [],
  cashAdvanceRequestCounts: {},
  _caRequestsSearch: '',
  cashAdvanceRequestStatus: '',
  payslipRequests: [],
  payslipRequestCounts: {},
  _payslipRequestsSearch: '',
  payslipRequestsStatus: '',
  approvalsTab: savedApprovalsTab,
  pages: { payroll: 1, attendance: 1, employees: 1, cashAdvance: 1, cashAdvanceRequests: 1, payslipRequests: 1, archive: 1, approvals: 1 },
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
    approvalsTab: state.approvalsTab,
    week: state.view === 'payroll' ? state.week : state.payrollWeek,
    search: state.searchPayroll,
    payPeriodDays: state.payPeriodDays,
    sidebarCollapsed: state.sidebarCollapsed
  }));
}

function isModalOpen() {
  return state.editingEmployee || state.payrollModalEmployee || state.payrollTransactionModal ||
    state.pendingDelete || state._generatedPayslip || state.showAudit || state.showLogoutConfirm || state.showChangePassword || state.showCloseConfirm || state.showSettings || state.showManagePayroll;
}
