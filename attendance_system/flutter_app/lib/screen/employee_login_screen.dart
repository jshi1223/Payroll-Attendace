import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:local_auth/local_auth.dart';

import '../constants.dart';
import '../services/api_client.dart';
import '../services/push_notification_service.dart';
import '../utils/api_errors.dart';
import 'attendance_screen.dart';
import '../widgets/brand_logo.dart';

enum EmployeeSection {
  dashboard,
  attendanceLogs,
  payroll,
  rawLogs,
  profile,
}

class EmployeeLoginScreen extends StatefulWidget {
  const EmployeeLoginScreen({super.key});

  @override
  State<EmployeeLoginScreen> createState() => _EmployeeLoginScreenState();
}

class _EmployeeLoginScreenState extends State<EmployeeLoginScreen>
    with WidgetsBindingObserver {
  static const Duration _presentDayMinimum = Duration(hours: 8);

  final _loginFormKey = GlobalKey<FormState>();
  final _emailCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _logSearchCtrl = TextEditingController();

  final LocalAuthentication _localAuth = LocalAuthentication();
  final ImagePicker _imagePicker = ImagePicker();

  bool _isLoading = false;
  bool _isLogsLoading = false;
  bool _isSignedIn = false;
  bool _isPasswordHidden = true;
  bool _isPhotoUploading = false;
  bool _isVerifyingBiometrics = false;
  bool _hasBiometrics = false;
  String _logSearchQuery = '';
  String _dashboardStatFilter = 'month';

  String _statusMsg = '';
  String _logsMsg = '';
  String _token = '';
  String _name = '';
  String _employeeId = '';
  String _email = '';
  String _phone = '';
  String _governmentId = '';
  String _status = '';
  String _photoUrl = '';
  PushNotificationStatus _pushStatus = PushNotificationService.status;
  EmployeeSection _selectedSection = EmployeeSection.dashboard;
  DateTime _calendarMonth = DateTime(DateTime.now().year, DateTime.now().month);
  DateTime _selectedCalendarDate = DateTime.now();
  DateTime _lastDashboardRefreshAt = DateTime.now();
  Timer? _dashboardRefreshTimer;
  Timer? _dashboardClockTimer;

  List<dynamic> _groupedLogs = const [];
  List<dynamic> _rawLogs = const [];
  List<dynamic> _payrollTotals = const [];
  List<dynamic> _payrollRows = const [];
  Map<String, dynamic> _payrollSummary = const {};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _checkBiometrics();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _dashboardRefreshTimer?.cancel();
    _dashboardClockTimer?.cancel();
    _emailCtrl.dispose();
    _passwordCtrl.dispose();
    _logSearchCtrl.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _isSignedIn && _token.isNotEmpty) {
      _loadLogs();
    }
  }

  void _startDashboardRefreshTimer() {
    _dashboardRefreshTimer?.cancel();
    _dashboardClockTimer?.cancel();
    if (!_isSignedIn || _token.isEmpty) return;
    _dashboardRefreshTimer = Timer.periodic(const Duration(seconds: 20), (_) {
      if (mounted && _isSignedIn && _token.isNotEmpty) {
        _loadLogs();
      }
    });
    _dashboardClockTimer = Timer.periodic(const Duration(minutes: 1), (_) {
      if (mounted && _isSignedIn) setState(() {});
    });
  }

  void _togglePasswordVisibility() {
    setState(() => _isPasswordHidden = !_isPasswordHidden);
  }

  Future<void> _checkBiometrics() async {
    bool available = false;
    try {
      available = await _localAuth.canCheckBiometrics;
      final isSupported = await _localAuth.isDeviceSupported();
      available = available && isSupported;
    } catch (_) {
      available = false;
    }
    if (mounted) setState(() => _hasBiometrics = available);
  }

  Future<void> _pickAndUploadPhoto() async {
    if (_isPhotoUploading || _token.isEmpty) return;

    final picked = await _imagePicker.pickImage(
      source: ImageSource.gallery,
      maxWidth: 1200,
      maxHeight: 1200,
      imageQuality: 85,
    );
    if (picked == null) return;

    setState(() => _isPhotoUploading = true);
    try {
      final res = await ApiClient.sendMultipart(
        '/employee/photo',
        headers: {'Authorization': 'Bearer $_token'},
        fields: const {},
        filePaths: {'photo': picked.path},
        timeout: const Duration(seconds: 30),
      );

      if (!mounted) return;
      if (ApiClient.isAuthExpiredStatus(res.statusCode)) {
        _expireSession();
        return;
      }

      final data = ApiClient.jsonObject(res.body);
      if (res.statusCode == 200) {
        final photoUrl = data?['photo_url']?.toString() ?? '';
        setState(() {
          _photoUrl = photoUrl;
          _statusMsg = '';
        });
        _showProfileSnack(
          'Profile photo updated.',
          error: false,
        );
      } else {
        _showProfileSnack(
          ApiClient.messageFromBody(res.body, fallback: 'Unable to upload photo.'),
          error: true,
        );
      }
    } catch (error) {
      if (mounted) {
        _showProfileSnack(
          ApiClient.friendlyNetworkError(error),
          error: true,
        );
      }
    } finally {
      if (mounted) setState(() => _isPhotoUploading = false);
    }
  }

  Future<void> _editGovernmentId() async {
    if (_token.isEmpty) return;

    final ctrl = TextEditingController(text: _governmentId);
    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        return AlertDialog(
          backgroundColor: BrandColors.surface,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
          title: const Text(
            'Edit Government ID',
            style: TextStyle(
              color: BrandColors.text,
              fontSize: 17,
              fontWeight: FontWeight.w800,
            ),
          ),
          content: TextFormField(
            controller: ctrl,
            autofocus: true,
            cursorColor: BrandColors.cyan,
            style: const TextStyle(color: BrandColors.text),
            decoration: InputDecoration(
              labelText: 'Government ID',
              hintText: 'e.g. SSS / UMID / Driver\u2019s License no.',
              labelStyle: const TextStyle(color: BrandColors.textMuted),
              hintStyle: const TextStyle(color: BrandColors.textMuted),
              prefixIcon: const Icon(Icons.badge_rounded, color: BrandColors.cyan),
              filled: true,
              fillColor: BrandColors.bg,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: const BorderSide(color: BrandColors.border),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: const BorderSide(color: BrandColors.border),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: const BorderSide(color: BrandColors.cyan, width: 1.4),
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              style: FilledButton.styleFrom(backgroundColor: BrandColors.cyan),
              child: const Text('Save'),
            ),
          ],
        );
      },
    );

    ctrl.dispose();
    if (saved != true) return;

    final value = ctrl.text.trim();
    if (value.isEmpty) {
      _showProfileSnack('Government ID cannot be empty.', error: true);
      return;
    }

    try {
      final res = await ApiClient.putForm(
        '/employee/government-id',
        headers: {'Authorization': 'Bearer $_token'},
        body: {'government_id': value},
      );

      if (!mounted) return;
      if (ApiClient.isAuthExpiredStatus(res.statusCode)) {
        _expireSession();
        return;
      }

      if (res.statusCode == 200) {
        setState(() => _governmentId = value);
        _showProfileSnack('Government ID updated.', error: false);
      } else {
        _showProfileSnack(
          ApiClient.messageFromBody(res.body, fallback: 'Unable to update Government ID.'),
          error: true,
        );
      }
    } catch (error) {
      if (mounted) {
        _showProfileSnack(ApiClient.friendlyNetworkError(error), error: true);
      }
    }
  }

  Future<void> _verifyBiometrics() async {
    if (_isVerifyingBiometrics) return;

    setState(() => _isVerifyingBiometrics = true);
    bool authenticated = false;
    try {
      authenticated = await _localAuth.authenticate(
        localizedReason:
            'Confirm your fingerprint to finish setting up biometrics.',
        options: const AuthenticationOptions(
          biometricOnly: true,
          stickyAuth: true,
        ),
      );
    } catch (_) {
      authenticated = false;
    }
    if (!mounted) return;

    setState(() => _isVerifyingBiometrics = false);
    _showProfileSnack(
      authenticated
          ? 'Biometrics verified successfully.'
          : 'Biometrics verification failed or cancelled.',
      error: !authenticated,
    );
  }

  void _showProfileSnack(String message, {required bool error}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(message),
          backgroundColor: error ? const Color(0xFFB3261E) : const Color(0xFF147A3A),
          behavior: SnackBarBehavior.floating,
        ),
      );
  }

  void _expireSession([String message = ApiClient.authMessage]) {
    _dashboardRefreshTimer?.cancel();
    if (!mounted) return;
    setState(() {
      _isSignedIn = false;
      _token = '';
      _name = '';
      _employeeId = '';
      _email = '';
      _phone = '';
      _status = '';
      _photoUrl = '';
      _groupedLogs = const [];
      _rawLogs = const [];
      _payrollTotals = const [];
      _payrollRows = const [];
      _payrollSummary = const {};
      _lastDashboardRefreshAt = DateTime.now();
      _selectedSection = EmployeeSection.dashboard;
      _statusMsg = message;
      _logsMsg = '';
    });
    unawaited(PushNotificationService.clearEmployee());
  }

  Future<void> _login() async {
    if (!(_loginFormKey.currentState?.validate() ?? false)) {
      return;
    }

    final email = _emailCtrl.text.trim();
    final password = _passwordCtrl.text;

    setState(() {
      _isLoading = true;
      _statusMsg = '';
    });

    try {
      final res = await ApiClient.postForm(
        '/employee/login',
        body: {'email': email, 'password': password},
      );
      final body = json.decode(res.body);

      if (res.statusCode == 200 && body is Map<String, dynamic>) {
        setState(() {
          _isSignedIn = true;
          _token = body['token']?.toString() ?? '';
          _name = body['name']?.toString() ?? '';
          _employeeId = body['employee_id']?.toString() ?? '';
          _email = body['email']?.toString() ?? '';
          _phone = body['phone']?.toString() ?? '';
          _governmentId = body['government_id']?.toString() ?? '';
          _status = body['status']?.toString() ?? '';
          _photoUrl = body['photo_url']?.toString() ?? '';
        });
        unawaited(_registerPushNotifications());
        await _loadLogs();
        _startDashboardRefreshTimer();
        return;
      }

      setState(() {
        _statusMsg = body is Map<String, dynamic>
            ? serverMessageFromBody(res.body, fallback: 'Login failed.')
            : 'Login failed.';
      });
    } catch (error) {
      setState(() => _statusMsg = ApiClient.friendlyNetworkError(error));
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _registerPushNotifications() async {
    await PushNotificationService.registerForEmployee(_token);
    if (!mounted) return;
    setState(() => _pushStatus = PushNotificationService.status);
  }

  Future<void> _loadLogs() async {
    if (_token.isEmpty) return;

    setState(() {
      _isLogsLoading = true;
      _logsMsg = '';
    });

    try {
      final res = await ApiClient.get(
        '/employee/logs',
        headers: {'Authorization': 'Bearer $_token'},
      );
      final body = json.decode(res.body);

      if (ApiClient.isAuthExpiredStatus(res.statusCode)) {
        _expireSession();
        return;
      }

      if (res.statusCode == 200 && body is Map<String, dynamic>) {
        setState(() {
          _groupedLogs = (body['grouped'] as List?) ?? const [];
          _rawLogs = (body['raw'] as List?) ?? const [];
          final payroll = body['payroll'];
          if (payroll is Map<String, dynamic>) {
            _payrollTotals = (payroll['totals'] as List?) ?? const [];
            _payrollRows = (payroll['rows'] as List?) ?? const [];
            _payrollSummary = Map<String, dynamic>.from(payroll['summary'] as Map? ?? const {});
          }
          _logsMsg = _groupedLogs.isEmpty ? 'No attendance logs yet.' : '';
          _lastDashboardRefreshAt = DateTime.now();
          final emp = body['employee'];
          if (emp is Map<String, dynamic>) {
            _name = emp['name']?.toString() ?? _name;
            _employeeId = emp['employee_id']?.toString() ?? _employeeId;
            _email = emp['email']?.toString() ?? _email;
            _phone = emp['phone']?.toString() ?? _phone;
            _status = emp['status']?.toString() ?? _status;
            _photoUrl = emp['photo_url']?.toString() ?? _photoUrl;
          }
        });
        return;
      }

      setState(() {
        _logsMsg = body is Map<String, dynamic>
            ? body['detail']?.toString() ?? 'Unable to load logs.'
            : 'Unable to load logs.';
      });
    } catch (error) {
      setState(() => _logsMsg = ApiClient.friendlyNetworkError(error));
    } finally {
      if (mounted) setState(() => _isLogsLoading = false);
    }
  }

  void _onLogSearchChanged(String value) {
    setState(() => _logSearchQuery = value.trim().toLowerCase());
  }

  void _clearLogSearch() {
    _logSearchCtrl.clear();
    setState(() => _logSearchQuery = '');
  }

  Future<void> _showForgotPasswordForm() async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => _ForgotPasswordPage(
          initialEmail: _emailCtrl.text.trim(),
        ),
      ),
    );
  }

  Future<void> _logout() async {
    final shouldLogout = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) {
        return AlertDialog(
          title: const Text('Confirm Logout'),
          content: const Text('Are you sure you want to log out?'),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('Cancel'),
            ),
            ElevatedButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('Logout'),
            ),
          ],
        );
      },
    );

    if (shouldLogout != true || !mounted) return;

    setState(() {
      _isSignedIn = false;
      _selectedSection = EmployeeSection.dashboard;
      _token = '';
      _name = '';
      _employeeId = '';
      _email = '';
      _phone = '';
      _status = '';
      _groupedLogs = const [];
      _rawLogs = const [];
      _payrollTotals = const [];
      _payrollRows = const [];
      _payrollSummary = const {};
      _logsMsg = '';
      _statusMsg = '';
      _emailCtrl.clear();
      _passwordCtrl.clear();
    });
    _dashboardRefreshTimer?.cancel();
    unawaited(PushNotificationService.clearEmployee());
  }

  void _changeCalendarMonth(int offset) {
    setState(() {
      _calendarMonth = DateTime(
        _calendarMonth.year,
        _calendarMonth.month + offset,
        1,
      );
      if (_selectedCalendarDate.year != _calendarMonth.year ||
          _selectedCalendarDate.month != _calendarMonth.month) {
        _selectedCalendarDate = DateTime(
          _calendarMonth.year,
          _calendarMonth.month,
          1,
        );
      }
    });
  }

  bool _isSameDay(DateTime a, DateTime b) {
    return a.year == b.year && a.month == b.month && a.day == b.day;
  }

  String _monthLabel(DateTime date) {
    const months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    return '${months[date.month - 1]} ${date.year}';
  }

  Set<String> _attendanceDaysForMonth(DateTime month) {
    return _sortedGroupedLogs()
        .where((row) {
          final day = _dateFromWorkDate(row['work_date']);
          return _isPresentDay(row) &&
              day.year == month.year &&
              day.month == month.month;
        })
        .map((row) {
          final day = _dateFromWorkDate(row['work_date']);
          return '${day.year}-${day.month.toString().padLeft(2, '0')}-${day.day.toString().padLeft(2, '0')}';
        })
        .toSet();
  }

  List<DateTime?> _calendarDays(DateTime month) {
    final firstDay = DateTime(month.year, month.month, 1);
    final daysInMonth = DateTime(month.year, month.month + 1, 0).day;
    final leading = (firstDay.weekday + 6) % 7;
    final days = <DateTime?>[
      for (var i = 0; i < leading; i++) null,
      for (var day = 1; day <= daysInMonth; day++)
        DateTime(month.year, month.month, day),
    ];
    while (days.length % 7 != 0) {
      days.add(null);
    }
    return days;
  }

  List<Map<String, dynamic>> _selectedCalendarLogs() {
    final selected = _selectedCalendarDate;
    return _sortedGroupedLogs()
        .where((row) {
          final workDate = _dateFromWorkDate(row['work_date']);
          return workDate.year == selected.year &&
              workDate.month == selected.month &&
              workDate.day == selected.day;
        })
        .toList();
  }

  Widget _employeeDrawer(BuildContext context) {
    return Drawer(
      backgroundColor: BrandColors.bg,
      child: SafeArea(
        child: Column(
          children: [
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(18, 20, 18, 18),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [
                    const Color(0xFF0F172A),
                    BrandColors.cyan.withValues(alpha: 0.95),
                  ],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                border: const Border(
                  bottom: BorderSide(color: BrandColors.border),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const BrandLogo(
                    size: 50,
                    radius: 16,
                    withFrame: false,
                    padding: EdgeInsets.zero,
                  ),
                  const SizedBox(height: 14),
                  Text(
                    _name.isNotEmpty ? _name : 'Employee',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 18,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    _employeeId.isNotEmpty ? _employeeId : 'Attendance',
                    style: const TextStyle(
                      color: Colors.white70,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'Navigation',
                    style: TextStyle(
                      color: Colors.white70,
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.4,
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(12, 14, 12, 12),
                children: [
                  ListTile(
                    selected: _selectedSection == EmployeeSection.dashboard,
                    selectedTileColor: const Color(0xFFE9F7FB),
                    leading: const Icon(Icons.dashboard_rounded, color: BrandColors.cyan),
                    title: const Text(
                      'Dashboard',
                      style: TextStyle(
                        color: BrandColors.text,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    subtitle: const Text('Main actions', style: TextStyle(color: BrandColors.textMuted, fontSize: 12)),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    onTap: () {
                      setState(() => _selectedSection = EmployeeSection.dashboard);
                      Navigator.of(context).pop();
                    },
                  ),
                  ListTile(
                    selected: _selectedSection == EmployeeSection.attendanceLogs,
                    selectedTileColor: const Color(0xFFE9F7FB),
                    leading: const Icon(Icons.badge_rounded, color: BrandColors.cyan),
                    title: const Text(
                      'Attendance',
                      style: TextStyle(
                        color: BrandColors.text,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    subtitle: const Text('Open logs', style: TextStyle(color: BrandColors.textMuted, fontSize: 12)),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    onTap: () {
                      setState(() => _selectedSection = EmployeeSection.attendanceLogs);
                      Navigator.of(context).pop();
                    },
                  ),
                  ListTile(
                    selected: _selectedSection == EmployeeSection.rawLogs,
                    selectedTileColor: const Color(0xFFE9F7FB),
                    leading: const Icon(Icons.receipt_long_rounded, color: BrandColors.cyan),
                    title: const Text(
                      'Raw Logs',
                      style: TextStyle(
                        color: BrandColors.text,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    subtitle: const Text('Separate form', style: TextStyle(color: BrandColors.textMuted, fontSize: 12)),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    onTap: () {
                      setState(() => _selectedSection = EmployeeSection.rawLogs);
                      Navigator.of(context).pop();
                    },
                  ),
                  ListTile(
                    selected: _selectedSection == EmployeeSection.payroll,
                    selectedTileColor: const Color(0xFFE9F7FB),
                    leading: const Icon(Icons.payments_rounded, color: BrandColors.cyan),
                    title: const Text(
                      'Payroll',
                      style: TextStyle(
                        color: BrandColors.text,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    subtitle: const Text('Pay and balance', style: TextStyle(color: BrandColors.textMuted, fontSize: 12)),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    onTap: () {
                      setState(() => _selectedSection = EmployeeSection.payroll);
                      Navigator.of(context).pop();
                    },
                  ),
                  ListTile(
                    selected: _selectedSection == EmployeeSection.profile,
                    selectedTileColor: const Color(0xFFE9F7FB),
                    leading: const Icon(Icons.person_rounded, color: BrandColors.cyan),
                    title: const Text(
                      'Profile',
                      style: TextStyle(
                        color: BrandColors.text,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    subtitle: const Text('Account details', style: TextStyle(color: BrandColors.textMuted, fontSize: 12)),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    onTap: () {
                      setState(() => _selectedSection = EmployeeSection.profile);
                      Navigator.of(context).pop();
                    },
                  ),
                  const SizedBox(height: 10),
                  const Divider(height: 1, color: BrandColors.border),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 14),
              child: SizedBox(
                width: double.infinity,
                height: 50,
                child: OutlinedButton(
                  onPressed: _logout,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: BrandColors.text,
                    side: const BorderSide(color: BrandColors.border),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                  ),
                  child: const Text('Logout'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  DateTime? _parseFlexibleDateTime(dynamic value) {
    if (value is DateTime) return value;
    final raw = value?.toString().trim() ?? '';
    if (raw.isEmpty) return null;
    final normalized = raw.contains('T')
        ? raw
        : raw.contains(' ')
            ? raw.replaceFirst(' ', 'T')
            : '${raw}T00:00:00';
    return DateTime.tryParse(normalized) ?? DateTime.tryParse(raw);
  }

  String _fmtDate(dynamic value) {
    final dt = _parseFlexibleDateTime(value);
    if (dt == null) return value?.toString() ?? '-';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${months[dt.month - 1]} ${dt.day}, ${dt.year}';
  }

  String _fmtTime(dynamic value) {
    final dt = _parseFlexibleDateTime(value);
    if (dt == null) return value?.toString() ?? '-';
    final hour = dt.hour % 12 == 0 ? 12 : dt.hour % 12;
    final minute = dt.minute.toString().padLeft(2, '0');
    final ampm = dt.hour >= 12 ? 'PM' : 'AM';
    return '$hour:$minute $ampm';
  }

  DateTime _dateFromWorkDate(dynamic value) {
    final dt = _parseFlexibleDateTime(value);
    return dt ?? DateTime.fromMillisecondsSinceEpoch(0);
  }

  Widget _searchBar() {
    return TextField(
      controller: _logSearchCtrl,
      onChanged: _onLogSearchChanged,
      textInputAction: TextInputAction.search,
      decoration: InputDecoration(
        hintText: 'Search logs by date, time, or status',
        prefixIcon: const Icon(Icons.search_rounded, color: BrandColors.cyan),
        suffixIcon: _logSearchQuery.isNotEmpty
            ? IconButton(
                onPressed: _clearLogSearch,
                icon: const Icon(Icons.close_rounded),
                tooltip: 'Clear search',
              )
            : null,
        filled: true,
        fillColor: const Color(0xFFF8FAFC),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: const BorderSide(color: BrandColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: const BorderSide(color: BrandColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(16),
          borderSide: const BorderSide(color: BrandColors.cyan, width: 1.4),
        ),
      ),
    );
  }

  List<Map<String, dynamic>> _sortedGroupedLogs() {
    final list = _groupedLogs
        .map((entry) => Map<String, dynamic>.from(entry as Map))
        .toList();
    list.sort((a, b) => _dateFromWorkDate(b['work_date']).compareTo(_dateFromWorkDate(a['work_date'])));
    return list;
  }

  bool _matchesRawQuery(Map<String, dynamic> row, String query) {
    if (query.isEmpty) return true;
    final text = [
      row['timestamp'],
      row['type'],
      row['employee_id'],
      row['name'],
    ].where((value) => value != null).join(' ').toLowerCase();
    return text.contains(query);
  }

  List<Map<String, dynamic>> _sortedRawLogs() {
    final list = _rawLogs
        .map((entry) => Map<String, dynamic>.from(entry as Map))
        .toList();
    list.sort((a, b) {
      final aTs = DateTime.tryParse(a['timestamp']?.toString() ?? '') ?? DateTime.fromMillisecondsSinceEpoch(0);
      final bTs = DateTime.tryParse(b['timestamp']?.toString() ?? '') ?? DateTime.fromMillisecondsSinceEpoch(0);
      return bTs.compareTo(aTs);
    });
    return list;
  }

  List<Map<String, dynamic>> _filteredRawLogs() {
    final list = _sortedRawLogs();
    if (_logSearchQuery.isEmpty) return list;
    return list.where((row) => _matchesRawQuery(row, _logSearchQuery)).toList();
  }

  String _fmtDuration(dynamic value) {
    if (value == null) return '-';

    Duration? duration;
    final raw = value.toString().trim();

    if (raw.isEmpty || raw == '-') return '-';

    final numeric = int.tryParse(raw);
    if (numeric != null) {
      duration = Duration(seconds: numeric);
    } else {
      final parts = raw.split(':').map((part) => int.tryParse(part.trim())).toList();
      if (parts.length >= 2 && parts.every((part) => part != null)) {
        final safe = parts.cast<int>();
        if (safe.length == 2) {
          duration = Duration(minutes: safe[0], seconds: safe[1]);
        } else if (safe.length >= 3) {
          duration = Duration(hours: safe[0], minutes: safe[1], seconds: safe[2]);
        }
      }
    }

    if (duration == null) return raw;

    final hours = duration.inHours;
    final minutes = duration.inMinutes.remainder(60);
    final seconds = duration.inSeconds.remainder(60);
    return 'Duration: ${hours}h ${minutes.toString().padLeft(2, '0')}m ${seconds.toString().padLeft(2, '0')}s';
  }

  String _fmtMoney(dynamic value) {
    final amount = double.tryParse(value?.toString() ?? '') ?? 0;
    return 'PHP ${amount.toStringAsFixed(2)}';
  }

  Duration? _durationFromLog(dynamic value) {
    if (value == null) return null;
    final raw = value.toString().trim();
    if (raw.isEmpty || raw == '-') return null;

    final numeric = int.tryParse(raw);
    if (numeric != null) {
      return Duration(seconds: numeric);
    }

    final parts = raw.split(':').map((part) => int.tryParse(part.trim())).toList();
    if (parts.length < 2 || parts.any((part) => part == null)) {
      return null;
    }

    final safe = parts.cast<int>();
    if (safe.length == 2) {
      return Duration(minutes: safe[0], seconds: safe[1]);
    }
    return Duration(hours: safe[0], minutes: safe[1], seconds: safe[2]);
  }

  bool _isPresentDay(Map<String, dynamic> row) {
    final hasCompletedSession = row['time_in'] != null && row['time_out'] != null;
    if (!hasCompletedSession) return false;
    final duration = _durationFromLog(row['duration']);
    return duration != null && duration >= _presentDayMinimum;
  }

  int _dashboardPresentDaysCount(String filter) {
    final now = DateTime.now();
    final days = <String>{};
    Iterable<Map<String, dynamic>> rows = _sortedGroupedLogs();
    switch (filter) {
      case '7d':
        final since = now.subtract(const Duration(days: 7));
        rows = rows.where((row) {
          final timeIn = _dateFromWorkDate(row['time_in']?.toString() ?? row['work_date']?.toString() ?? '');
          return _isPresentDay(row) && !timeIn.isBefore(DateTime(since.year, since.month, since.day));
        });
        break;
      case 'all':
        rows = rows.where(_isPresentDay);
        break;
      case 'month':
      default:
        rows = rows.where((row) {
          final timeIn = _dateFromWorkDate(row['time_in']?.toString() ?? row['work_date']?.toString() ?? '');
          return _isPresentDay(row) && timeIn.year == now.year && timeIn.month == now.month;
        });
        break;
    }
    for (final row in rows) {
      final day = _dateFromWorkDate(row['work_date']);
      days.add('${day.year}-${day.month.toString().padLeft(2, '0')}-${day.day.toString().padLeft(2, '0')}');
    }
    return days.length;
  }

  Map<String, dynamic>? _todayLog() {
    final today = DateTime.now();
    for (final row in _sortedGroupedLogs()) {
      final workDate = _dateFromWorkDate(row['work_date']);
      if (_isSameDay(workDate, today)) return row;
    }
    return null;
  }

  String _todayStatusTitle(Map<String, dynamic>? todayLog) {
    if (todayLog == null) return 'Ready to mark present';
    return 'Present today';
  }

  String _todayStatusCaption(Map<String, dynamic>? todayLog) {
    if (todayLog == null) return 'No attendance record yet for today.';
    final markedAt = todayLog['time_in'];
    return 'Marked present at ${markedAt == null ? 'today' : _fmtTime(markedAt)}.';
  }

  Color _todayStatusColor(Map<String, dynamic>? todayLog) {
    if (todayLog == null) return BrandColors.cyan;
    return const Color(0xFF147A3A);
  }

  String _todayActionLabel(Map<String, dynamic>? todayLog) {
    if (todayLog != null) return 'View Logs';
    return 'Mark Present';
  }

  VoidCallback _todayAction(Map<String, dynamic>? todayLog) {
    if (todayLog != null) {
      return () => setState(() => _selectedSection = EmployeeSection.attendanceLogs);
    }
    return () => _openAttendance('present');
  }

  String _pushCompactLabel() {
    if (_pushStatus.uploaded) return 'Push notifications active';
    if (_pushStatus.initialized && _pushStatus.tokenGenerated) return 'Push token ready';
    if (_pushStatus.configured) return 'Push setup pending';
    return 'Push unavailable';
  }

  String _dashboardUpdatedLabel() {
    final elapsed = DateTime.now().difference(_lastDashboardRefreshAt);
    if (elapsed.inSeconds < 45) return 'Updated just now';
    if (elapsed.inMinutes < 60) return 'Updated ${elapsed.inMinutes}m ago';
    return 'Updated ${elapsed.inHours}h ago';
  }

  bool _hasPayrollData(Map<String, dynamic> total) {
    return _toMoneyValue(_payrollSummary['total_amount'] ?? total['amount']) > 0 ||
        _toMoneyValue(_payrollSummary['paid_amount'] ?? total['paid_amount']) > 0 ||
        _toMoneyValue(_payrollSummary['balance'] ?? total['balance']) > 0;
  }

  double _toMoneyValue(dynamic value) {
    return double.tryParse(value?.toString() ?? '') ?? 0;
  }

  Widget _filterChip(String value, String label) {
    final selected = _dashboardStatFilter == value;
    return ChoiceChip(
      label: Text(label),
      selected: selected,
      onSelected: (_) {
        setState(() => _dashboardStatFilter = value);
      },
      labelStyle: TextStyle(
        color: selected ? Colors.white : BrandColors.textMuted,
        fontWeight: FontWeight.w700,
        fontSize: 11,
      ),
      selectedColor: BrandColors.cyan,
      backgroundColor: const Color(0xFFF8FAFC),
      side: BorderSide(color: selected ? BrandColors.cyan : BrandColors.border),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
      visualDensity: VisualDensity.compact,
      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      labelPadding: const EdgeInsets.symmetric(horizontal: 8),
    );
  }

  Widget _monthNavButton({
    required IconData icon,
    required VoidCallback onPressed,
  }) {
    return Material(
      color: const Color(0xFFF8FAFC),
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          width: 44,
          height: 44,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: BrandColors.border),
          ),
          child: Icon(
            icon,
            color: BrandColors.textMuted,
            size: 22,
          ),
        ),
      ),
    );
  }

  int _attendanceCountForDay(DateTime day) {
    return _sortedGroupedLogs().where((row) {
      final workDate = _dateFromWorkDate(row['work_date']);
      return _isPresentDay(row) && _isSameDay(workDate, day);
    }).length;
  }

  Widget _sectionHeader(String title, IconData icon) {
    return Row(
      children: [
        Icon(icon, color: BrandColors.cyan, size: 20),
        const SizedBox(width: 8),
        Text(
          title,
          style: const TextStyle(
            color: BrandColors.text,
            fontSize: 15,
            fontWeight: FontWeight.w900,
          ),
        ),
      ],
    );
  }

  Widget _miniStat(String label, String value, IconData icon, Color accent) {
    return Container(
      constraints: const BoxConstraints(minHeight: 92),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: accent.withValues(alpha: 0.16)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: accent, size: 21),
          const SizedBox(height: 10),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: accent,
              fontSize: 16,
              fontWeight: FontWeight.w900,
            ),
          ),
          const SizedBox(height: 3),
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: BrandColors.textMuted,
              fontSize: 11,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }

  Widget _payrollStrip(Map<String, dynamic> total) {
    final hasPayroll = _hasPayrollData(total);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: BrandColors.border),
      ),
      child: hasPayroll
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _sectionHeader('Payroll', Icons.account_balance_wallet_rounded),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: _payrollMetric('Salary', _fmtMoney(_payrollSummary['total_amount'] ?? total['amount'])),
                    ),
                    Expanded(
                      child: _payrollMetric('Paid', _fmtMoney(_payrollSummary['paid_amount'] ?? total['paid_amount'])),
                    ),
                    Expanded(
                      child: _payrollMetric('Balance', _fmtMoney(_payrollSummary['balance'] ?? total['balance'])),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: _payrollMetric('C/A Balance', _fmtMoney(total['remaining_bale_balance'] ?? _payrollSummary['remaining_bale_balance'])),
                    ),
                  ],
                ),
              ],
            )
          : const Row(
              children: [
                Icon(Icons.account_balance_wallet_outlined, color: BrandColors.textMuted, size: 22),
                SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Payroll not available yet',
                    style: TextStyle(
                      color: BrandColors.textMuted,
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
    );
  }

  Widget _payrollMetric(String label, String value) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            color: BrandColors.textMuted,
            fontSize: 11,
            fontWeight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          value,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(
            color: BrandColors.text,
            fontSize: 13,
            fontWeight: FontWeight.w900,
          ),
        ),
      ],
    );
  }

  Widget _compactAttendanceRow(Map<String, dynamic> row) {
    final complete = row['time_in'] != null && row['time_out'] != null;
    final label = complete ? 'Complete' : row['time_in'] != null ? 'Missing time-out' : 'Pending';
    final color = complete ? const Color(0xFF147A3A) : const Color(0xFFC46A18);
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: BrandColors.border),
      ),
      child: Row(
        children: [
          Container(
            width: 10,
            height: 10,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _fmtDate(row['work_date']),
                  style: const TextStyle(
                    color: BrandColors.text,
                    fontSize: 13,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  '${_fmtTime(row['time_in'])} - ${row['time_out'] == null ? 'No time-out' : _fmtTime(row['time_out'])}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: BrandColors.textMuted,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
          _pill(
            label.toUpperCase(),
            complete ? const Color(0xFFEAF8EF) : const Color(0xFFFFF4E8),
            color,
          ),
        ],
      ),
    );
  }

  Future<void> _openAttendance(String type) async {
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => AttendanceScreen(
          initialType: type,
          employeeToken: _token,
        ),
      ),
    );
    if (mounted && _isSignedIn && _token.isNotEmpty) {
      await _loadLogs();
      final now = DateTime.now();
      setState(() {
        _calendarMonth = DateTime(now.year, now.month, 1);
        _selectedCalendarDate = DateTime(now.year, now.month, now.day);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isSignedIn) {
      return PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) {
            _logout();
          }
        },
        child: Scaffold(
          backgroundColor: BrandColors.bg,
          drawer: _employeeDrawer(context),
          appBar: AppBar(
            backgroundColor: BrandColors.surface,
            elevation: 0,
            toolbarHeight: 72,
            title: const BrandMark(
              compact: true,
              titleColor: BrandColors.text,
              subtitleColor: BrandColors.textMuted,
            ),
            bottom: PreferredSize(
              preferredSize: const Size.fromHeight(1),
              child: Container(height: 1, color: BrandColors.border),
            ),
          ),
          body: _selectedSection == EmployeeSection.dashboard
              ? _buildEmployeeDashboard()
              : _selectedSection == EmployeeSection.attendanceLogs
                  ? _buildEmployeeLogs()
                  : _selectedSection == EmployeeSection.rawLogs
                      ? _buildRawLogsPage()
                      : _selectedSection == EmployeeSection.payroll
                          ? _buildPayrollPage()
                          : _buildEmployeeProfile(),
        ),
      );
    }

    return Scaffold(
      backgroundColor: BrandColors.bg,
      appBar: AppBar(
        backgroundColor: BrandColors.surface,
        elevation: 0,
        toolbarHeight: 72,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, color: BrandColors.text, size: 20),
          onPressed: () => Navigator.pop(context),
        ),
        title: const BrandMark(
          compact: true,
          titleColor: BrandColors.text,
          subtitleColor: BrandColors.textMuted,
        ),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(height: 1, color: BrandColors.border),
        ),
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: _card(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const BrandLogo(size: 84, radius: 18, withFrame: false, padding: EdgeInsets.zero),
                  const SizedBox(height: 16),
                  const Text('Employee Login', style: TextStyle(color: BrandColors.text, fontSize: 22, fontWeight: FontWeight.w900)),
                  const SizedBox(height: 6),
                  const Text(
                    'Sign in to see only your own attendance logs.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: BrandColors.textMuted, fontSize: 13, height: 1.4),
                  ),
                  const SizedBox(height: 20),
                  Form(
                    key: _loginFormKey,
                    autovalidateMode: AutovalidateMode.onUserInteraction,
                    child: Column(
                      children: [
                        _field(
                          controller: _emailCtrl,
                          label: 'Email',
                          icon: Icons.email_rounded,
                          keyboardType: TextInputType.emailAddress,
                          validator: (value) {
                            final text = value?.trim() ?? '';
                            if (text.isEmpty) return 'Email is required.';
                            if (!text.contains('@') || !text.contains('.')) {
                              return 'Enter a valid email.';
                            }
                            return null;
                          },
                        ),
                        const SizedBox(height: 14),
                        _field(
                          controller: _passwordCtrl,
                          label: 'Password',
                          icon: Icons.lock_rounded,
                          obscureText: _isPasswordHidden,
                          suffixIcon: IconButton(
                            onPressed: _togglePasswordVisibility,
                            icon: Icon(
                              _isPasswordHidden
                                  ? Icons.visibility_rounded
                                  : Icons.visibility_off_rounded,
                              color: BrandColors.textMuted,
                            ),
                            tooltip: _isPasswordHidden ? 'Show password' : 'Hide password',
                          ),
                          validator: (value) {
                            if ((value ?? '').isEmpty) return 'Password is required.';
                            return null;
                          },
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 18),
                  if (_statusMsg.isNotEmpty) ...[
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: const Color(0xFFFFEFEF),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: const Color(0xFFE2B0B0)),
                      ),
                      child: Text(
                        _statusMsg,
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Color(0xFF8E1F1F), fontSize: 13, height: 1.35, fontWeight: FontWeight.w600),
                      ),
                    ),
                    const SizedBox(height: 14),
                  ],
                  SizedBox(
                    width: double.infinity,
                    height: 54,
                    child: ElevatedButton(
                      onPressed: _isLoading ? null : _login,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: BrandColors.cyan,
                        foregroundColor: Colors.white,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                      ),
                      child: _isLoading
                          ? const SizedBox(
                              width: 22,
                              height: 22,
                              child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white),
                            )
                          : const Text('Sign In', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextButton(
                    onPressed: _showForgotPasswordForm,
                    child: const Text('Forgot Password?'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildEmployeeDashboard() {
    final todayLog = _todayLog();
    final statusColor = _todayStatusColor(todayLog);
    final total = _payrollTotals.isNotEmpty
        ? Map<String, dynamic>.from(_payrollTotals.first as Map)
        : <String, dynamic>{};
    final recentLogs = _sortedGroupedLogs().take(3).toList();

    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 54,
                        height: 54,
                        decoration: BoxDecoration(
                          color: statusColor.withValues(alpha: 0.13),
                          borderRadius: BorderRadius.circular(16),
                        ),
                        child: Icon(Icons.badge_rounded, color: statusColor, size: 28),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    _name.isNotEmpty ? _name : 'Employee',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      color: BrandColors.text,
                                      fontSize: 21,
                                      fontWeight: FontWeight.w900,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 3),
                            Text(
                              _employeeId.isNotEmpty ? _employeeId : (_email.isNotEmpty ? _email : 'Approved account'),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: BrandColors.textMuted,
                                fontSize: 12,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                        ),
                      ),
                      if (_status.isNotEmpty)
                        _pill(_status.toUpperCase(), const Color(0xFFEAF8EF), const Color(0xFF147A3A)),
                    ],
                  ),
                  const SizedBox(height: 18),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: statusColor.withValues(alpha: 0.08),
                      borderRadius: BorderRadius.circular(18),
                      border: Border.all(color: statusColor.withValues(alpha: 0.18)),
                    ),
                    child: Row(
                      children: [
                        Icon(Icons.today_rounded, color: statusColor, size: 24),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                _todayStatusTitle(todayLog),
                                style: const TextStyle(
                                  color: BrandColors.text,
                                  fontSize: 16,
                                  fontWeight: FontWeight.w900,
                                ),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                _todayStatusCaption(todayLog),
                                style: const TextStyle(
                                  color: BrandColors.textMuted,
                                  fontSize: 12,
                                  height: 1.3,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      Expanded(
                        child: ElevatedButton.icon(
                          onPressed: _todayAction(todayLog),
                          icon: Icon(
                            _todayActionLabel(todayLog) == 'Time Out'
                                ? Icons.logout_rounded
                                : _todayActionLabel(todayLog) == 'View Logs'
                                    ? Icons.list_alt_rounded
                                    : Icons.login_rounded,
                            size: 18,
                          ),
                          label: Text(_todayActionLabel(todayLog)),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: statusColor,
                            foregroundColor: Colors.white,
                            minimumSize: const Size.fromHeight(52),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: ElevatedButton.icon(
                          onPressed: () => setState(() => _selectedSection = EmployeeSection.payroll),
                          icon: const Icon(Icons.payments_rounded, size: 18),
                          label: const Text('Payroll'),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color(0xFF364152),
                            foregroundColor: Colors.white,
                            minimumSize: const Size.fromHeight(52),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(child: _sectionHeader('Overview', Icons.dashboard_rounded)),
                      Text(
                        _dashboardUpdatedLabel(),
                        style: const TextStyle(
                          color: BrandColors.textMuted,
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: _miniStat(
                          'Present',
                          '${_dashboardPresentDaysCount(_dashboardStatFilter)}',
                          Icons.event_available_rounded,
                          BrandColors.cyan,
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: _miniStat(
                          'Completed',
                          '${_sortedGroupedLogs().where((row) => row['time_in'] != null && row['time_out'] != null).length}',
                          Icons.task_alt_rounded,
                          const Color(0xFF147A3A),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: _miniStat(
                          'Open',
                          '${_sortedGroupedLogs().where((row) => row['time_in'] != null && row['time_out'] == null).length}',
                          Icons.pending_actions_rounded,
                          const Color(0xFFC46A18),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      _filterChip('month', 'Month'),
                      _filterChip('7d', '7 Days'),
                      _filterChip('all', 'All Time'),
                    ],
                  ),
                  const SizedBox(height: 14),
                  _payrollStrip(total),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _sectionHeader('Recent Attendance', Icons.history_rounded),
                  const SizedBox(height: 10),
                  if (recentLogs.isEmpty)
                    const Text(
                      'No attendance logs yet.',
                      style: TextStyle(color: BrandColors.textMuted, fontSize: 13),
                    )
                  else
                    ...recentLogs.map((row) => _compactAttendanceRow(row)),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _card(
              child: Row(
                children: [
                  Icon(
                    _pushStatus.uploaded ? Icons.notifications_active_rounded : Icons.notifications_off_rounded,
                    color: _pushStatus.uploaded ? const Color(0xFF147A3A) : BrandColors.textMuted,
                    size: 22,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      _pushCompactLabel(),
                      style: const TextStyle(
                        color: BrandColors.text,
                        fontWeight: FontWeight.w800,
                        fontSize: 13,
                      ),
                    ),
                  ),
                  if (!_pushStatus.uploaded)
                    TextButton(
                      onPressed: _token.isEmpty ? null : _registerPushNotifications,
                      child: const Text('Fix'),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _calendarCard() {
    final today = DateTime.now();
    final visibleDays = _calendarDays(_calendarMonth);
    final monthAttendanceDays = _attendanceDaysForMonth(_calendarMonth);
    final monthAttendanceCount = monthAttendanceDays.length;
    final selectedLogs = _selectedCalendarLogs();
    final selectedLog = selectedLogs.isNotEmpty ? selectedLogs.first : null;
    final hasRecord = selectedLog != null;
    final isComplete = selectedLog == null
        ? false
        : selectedLog['time_in'] != null && selectedLog['time_out'] != null;
    const weekdays = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

    return _card(
      child: LayoutBuilder(
        builder: (context, constraints) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Container(
                    width: 46,
                    height: 46,
                    decoration: BoxDecoration(
                      color: const Color(0xFFE9F7FB),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: const Icon(Icons.calendar_month_rounded, color: BrandColors.cyan, size: 24),
                  ),
                  const SizedBox(width: 12),
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Calendar',
                          style: TextStyle(
                            color: BrandColors.text,
                            fontSize: 18,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                        SizedBox(height: 4),
                        Text(
                          'Quick date view for your attendance logs.',
                          style: TextStyle(
                            color: BrandColors.textMuted,
                            fontSize: 12,
                            height: 1.35,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  _monthNavButton(
                    icon: Icons.chevron_left_rounded,
                    onPressed: () => _changeCalendarMonth(-1),
                  ),
                  Expanded(
                    child: Column(
                      children: [
                        Text(
                          _monthLabel(_calendarMonth),
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            color: BrandColors.text,
                            fontSize: 15,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          'Tap arrows to switch months',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            color: BrandColors.textMuted.withValues(alpha: 0.85),
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ),
                  _monthNavButton(
                    icon: Icons.chevron_right_rounded,
                    onPressed: () => _changeCalendarMonth(1),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                decoration: BoxDecoration(
                  color: const Color(0xFFF8FAFC),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: BrandColors.border),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(
                        color: const Color(0xFFEAF8EF),
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: const Icon(
                        Icons.event_available_rounded,
                        color: Color(0xFF147A3A),
                        size: 22,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Text(
                            'Days Present',
                            style: TextStyle(
                              color: BrandColors.textMuted,
                              fontSize: 11,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 0.6,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            '$monthAttendanceCount day${monthAttendanceCount == 1 ? '' : 's'}',
                            style: const TextStyle(
                              color: BrandColors.text,
                              fontSize: 20,
                              fontWeight: FontWeight.w900,
                              height: 1.0,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      decoration: BoxDecoration(
                        color: const Color(0xFFEAF8EF),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: const Color(0xFF34A853).withValues(alpha: 0.22)),
                      ),
                      child: Text(
                        _monthLabel(_calendarMonth),
                        style: const TextStyle(
                          color: Color(0xFF147A3A),
                          fontSize: 11,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: weekdays
                    .map(
                      (day) => Expanded(
                        child: Center(
                          child: Text(
                            day,
                            style: const TextStyle(
                              color: BrandColors.textMuted,
                              fontSize: 11,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 0.8,
                            ),
                          ),
                        ),
                      ),
                    )
                    .toList(),
              ),
              const SizedBox(height: 10),
              GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: visibleDays.length,
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 7,
                  mainAxisSpacing: 8,
                  crossAxisSpacing: 8,
                  childAspectRatio: 1,
                ),
                itemBuilder: (context, index) {
                  final day = visibleDays[index];
                  if (day == null) {
                    return const SizedBox.shrink();
                  }

                  final isToday = _isSameDay(day, today);
                  final isSelected = _isSameDay(day, _selectedCalendarDate);
                  final attendanceCount = _attendanceCountForDay(day);
                  final hasAttendance = attendanceCount > 0;
                  return InkWell(
                    onTap: () {
                      setState(() => _selectedCalendarDate = day);
                    },
                    borderRadius: BorderRadius.circular(12),
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 180),
                      decoration: BoxDecoration(
                        color: isSelected
                            ? BrandColors.cyan
                            : hasAttendance
                                ? const Color(0xFFEAF8EF)
                                : isToday
                                    ? const Color(0xFFE9F7FB)
                                    : const Color(0xFFF8FAFC),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                          color: isSelected
                              ? BrandColors.cyan
                              : hasAttendance
                                  ? const Color(0xFF34A853).withValues(alpha: 0.45)
                                  : isToday
                                      ? BrandColors.cyan.withValues(alpha: 0.35)
                                      : BrandColors.border,
                        ),
                        boxShadow: isSelected
                            ? [
                                BoxShadow(
                                  color: BrandColors.cyan.withValues(alpha: 0.18),
                                  blurRadius: 14,
                                  offset: const Offset(0, 6),
                                ),
                              ]
                            : null,
                      ),
                      child: Stack(
                        fit: StackFit.expand,
                        children: [
                          Center(
                            child: Text(
                              '${day.day}',
                              style: TextStyle(
                                color: isSelected
                                    ? Colors.white
                                    : hasAttendance
                                        ? const Color(0xFF147A3A)
                                        : isToday
                                            ? BrandColors.cyan
                                            : BrandColors.text,
                                fontSize: 13,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                          ),
                          if (hasAttendance && !isSelected)
                            Positioned(
                              top: 3,
                              right: 3,
                              child: Container(
                                width: 16,
                                height: 16,
                                decoration: BoxDecoration(
                                  color: const Color(0xFF34A853),
                                  shape: BoxShape.circle,
                                  boxShadow: [
                                    BoxShadow(
                                      color: const Color(0xFF34A853).withValues(alpha: 0.16),
                                      blurRadius: 6,
                                      offset: const Offset(0, 2),
                                    ),
                                  ],
                                ),
                                alignment: Alignment.center,
                                child: Text(
                                  attendanceCount > 9 ? '9+' : '$attendanceCount',
                                  style: const TextStyle(
                                    color: Colors.white,
                                    fontSize: 8,
                                    fontWeight: FontWeight.w900,
                                    height: 1,
                                  ),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  );
                },
              ),
              const SizedBox(height: 12),
              Text(
                'Selected: ${dayName(_selectedCalendarDate)}',
                style: const TextStyle(
                  color: BrandColors.textMuted,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: const Color(0xFFF8FAFC),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: BrandColors.border),
                ),
                child: hasRecord
                    ? Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (constraints.maxWidth < 420) ...[
                            _calendarStat(
                              label: 'Status',
                              value: isComplete ? 'Complete' : 'Open',
                              accent: isComplete ? const Color(0xFF147A3A) : const Color(0xFFB45309),
                              fullWidth: true,
                            ),
                            const SizedBox(height: 10),
                            _calendarStat(
                              label: 'Time In',
                              value: _fmtTime(selectedLog['time_in']),
                              accent: BrandColors.cyan,
                              fullWidth: true,
                            ),
                            const SizedBox(height: 10),
                            _calendarStat(
                              label: 'Time Out',
                              value: _fmtTime(selectedLog['time_out']),
                              accent: const Color(0xFF364152),
                              fullWidth: true,
                            ),
                            const SizedBox(height: 10),
                            _calendarStat(
                              label: 'Duration',
                              value: _fmtDuration(selectedLog['duration']),
                              accent: const Color(0xFF7C3AED),
                              fullWidth: true,
                            ),
                          ] else ...[
                            Row(
                              children: [
                                _calendarStat(
                                  label: 'Status',
                                  value: isComplete ? 'Complete' : 'Open',
                                  accent: isComplete ? const Color(0xFF147A3A) : const Color(0xFFB45309),
                                ),
                                const SizedBox(width: 10),
                                _calendarStat(
                                  label: 'Time In',
                                  value: _fmtTime(selectedLog['time_in']),
                                  accent: BrandColors.cyan,
                                ),
                              ],
                            ),
                            const SizedBox(height: 10),
                            Row(
                              children: [
                                _calendarStat(
                                  label: 'Time Out',
                                  value: _fmtTime(selectedLog['time_out']),
                                  accent: const Color(0xFF364152),
                                ),
                                const SizedBox(width: 10),
                                _calendarStat(
                                  label: 'Duration',
                                  value: _fmtDuration(selectedLog['duration']),
                                  accent: const Color(0xFF7C3AED),
                                ),
                              ],
                            ),
                          ],
                        ],
                      )
                    : const Text(
                        'No attendance record for the selected date.',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: BrandColors.textMuted,
                          fontSize: 12,
                          height: 1.4,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _calendarStat({
    required String label,
    required String value,
    required Color accent,
    bool fullWidth = false,
  }) {
    final stat = Container(
      width: fullWidth ? double.infinity : null,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: accent.withValues(alpha: 0.18)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: TextStyle(
              color: accent,
              fontSize: 11,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.6,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            value.isEmpty ? '-' : value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: BrandColors.text,
              fontSize: 13,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
    return fullWidth ? stat : Expanded(child: stat);
  }

  String dayName(DateTime date) {
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return '${months[date.month - 1]} ${date.day}, ${date.year}';
  }

  Widget _buildEmployeeLogs() {
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _card(
              child: Row(
                children: [
                  Container(
                    width: 48,
                    height: 48,
                    decoration: BoxDecoration(
                      color: const Color(0xFFE9F7FB),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: const Icon(Icons.badge_rounded, color: BrandColors.cyan, size: 24),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Attendance Logs',
                          style: TextStyle(
                            color: BrandColors.text,
                            fontSize: 18,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          'Your attendance records are listed here.',
                          style: const TextStyle(
                            color: BrandColors.textMuted,
                            fontSize: 12,
                            height: 1.35,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _calendarCard(),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: ElevatedButton.icon(
                    onPressed: _isLogsLoading ? null : () { HapticFeedback.lightImpact(); _loadLogs(); },
                    icon: _isLogsLoading
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                          )
                        : const Icon(Icons.refresh_rounded, size: 18),
                    label: const Text('Refresh'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: BrandColors.cyan,
                      foregroundColor: Colors.white,
                      minimumSize: const Size.fromHeight(48),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            if (_logsMsg.isNotEmpty) ...[
              _card(
                child: Text(
                  _logsMsg,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: BrandColors.textMuted, fontSize: 13, height: 1.35),
                ),
              ),
              const SizedBox(height: 12),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildRawLogsPage() {
    final rawLogs = _filteredRawLogs();

    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _card(
              child: Row(
                children: [
                  Container(
                    width: 48,
                    height: 48,
                    decoration: BoxDecoration(
                      color: const Color(0xFFFFF7E6),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: const Icon(Icons.receipt_long_rounded, color: Color(0xFFB45309), size: 24),
                  ),
                  const SizedBox(width: 12),
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Raw Logs',
                          style: TextStyle(
                            color: BrandColors.text,
                            fontSize: 18,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                        SizedBox(height: 4),
                        Text(
                          'Each time entry is shown as its own record.',
                          style: TextStyle(
                            color: BrandColors.textMuted,
                            fontSize: 12,
                            height: 1.35,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: ElevatedButton.icon(
                    onPressed: _isLogsLoading ? null : () { HapticFeedback.lightImpact(); _loadLogs(); },
                    icon: _isLogsLoading
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                          )
                        : const Icon(Icons.refresh_rounded, size: 18),
                    label: const Text('Refresh'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: BrandColors.cyan,
                      foregroundColor: Colors.white,
                      minimumSize: const Size.fromHeight(48),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            _searchBar(),
            const SizedBox(height: 14),
            if (_logsMsg.isNotEmpty) ...[
              _card(
                child: Text(
                  _logsMsg,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: BrandColors.textMuted, fontSize: 13, height: 1.35),
                ),
              ),
              const SizedBox(height: 12),
            ],
            if (rawLogs.isEmpty)
              _card(
                child: const Text(
                  'No raw logs available.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: BrandColors.textMuted, fontSize: 13, height: 1.35),
                ),
              )
            else
              ...rawLogs.map((row) {
                final type = row['type']?.toString().toLowerCase() ?? '';
                final isIn = type == 'time_in';
                final title = isIn ? 'Time In' : 'Time Out';
                final icon = isIn ? Icons.login_rounded : Icons.logout_rounded;
                final accent = isIn ? BrandColors.cyan : const Color(0xFF364152);
                return Container(
                  margin: const EdgeInsets.only(bottom: 10),
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF8FAFC),
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: BrandColors.border),
                  ),
                  child: Row(
                    children: [
                      Container(
                        width: 42,
                        height: 42,
                        decoration: BoxDecoration(
                          color: accent.withValues(alpha: 0.10),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Icon(icon, color: accent, size: 20),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              title,
                              style: const TextStyle(
                                color: BrandColors.text,
                                fontSize: 14,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              '${_fmtDate(row['timestamp'])} • ${_fmtTime(row['timestamp'])}',
                              style: const TextStyle(
                                color: BrandColors.textMuted,
                                fontSize: 12,
                                height: 1.35,
                              ),
                            ),
                          ],
                        ),
                      ),
                      _pill(
                        isIn ? 'IN' : 'OUT',
                        isIn ? const Color(0xFFEAF8EF) : const Color(0xFFF1F5F9),
                        accent,
                      ),
                    ],
                  ),
                );
              }),
          ],
        ),
      ),
    );
  }

  Widget _buildPayrollPage() {
    final total = _payrollTotals.isNotEmpty
        ? Map<String, dynamic>.from(_payrollTotals.first as Map)
        : <String, dynamic>{};
    final history = (total['payment_history'] as List?) ?? const [];
    return RefreshIndicator(
      onRefresh: _loadLogs,
      color: BrandColors.cyan,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 28),
        children: [
          _card(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Payroll',
                  style: TextStyle(
                    color: BrandColors.text,
                    fontSize: 22,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 6),
                const Text(
                  'Your pay summary from the payroll system.',
                  style: TextStyle(color: BrandColors.textMuted, fontSize: 13),
                ),
                const SizedBox(height: 18),
                _infoRow('Total Pay', _fmtMoney(_payrollSummary['total_amount'] ?? total['amount'])),
                const SizedBox(height: 10),
                _infoRow('Paid', _fmtMoney(_payrollSummary['paid_amount'] ?? total['paid_amount'])),
                const SizedBox(height: 10),
                _infoRow('Balance', _fmtMoney(_payrollSummary['balance'] ?? total['balance'])),
                const SizedBox(height: 10),
                _infoRow('C/A Balance', _fmtMoney(total['remaining_bale_balance'] ?? _payrollSummary['remaining_bale_balance'])),
                const SizedBox(height: 10),
                _infoRow('Status', (total['payment_status']?.toString().toUpperCase() ?? 'UNPAID')),
              ],
            ),
          ),
          const SizedBox(height: 14),
          _card(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Payment History',
                  style: TextStyle(color: BrandColors.text, fontSize: 16, fontWeight: FontWeight.w900),
                ),
                const SizedBox(height: 12),
                if (history.isEmpty)
                  const Text('No payment history yet.', style: TextStyle(color: BrandColors.textMuted))
                else
                  ...history.map((entry) {
                    final row = Map<String, dynamic>.from(entry as Map);
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: _infoRow(
                        _fmtMoney(row['amount_paid']),
                        row['created_at']?.toString() ?? '-',
                      ),
                    );
                  }),
              ],
            ),
          ),
          const SizedBox(height: 14),
          _card(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Payable Days',
                  style: TextStyle(color: BrandColors.text, fontSize: 16, fontWeight: FontWeight.w900),
                ),
                const SizedBox(height: 12),
                if (_payrollRows.isEmpty)
                  const Text('No payable days yet.', style: TextStyle(color: BrandColors.textMuted))
                else
                  ..._payrollRows.take(8).map((entry) {
                    final row = Map<String, dynamic>.from(entry as Map);
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: _infoRow(
                        row['work_date']?.toString() ?? '-',
                        _fmtMoney(row['amount']),
                      ),
                    );
                  }),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildEmployeeProfile() {
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _card(
              child: Column(
                children: [
                  GestureDetector(
                    onTap: _isPhotoUploading ? null : _pickAndUploadPhoto,
                    child: Stack(
                      alignment: Alignment.center,
                      children: [
                        Container(
                          width: 82,
                          height: 82,
                          decoration: BoxDecoration(
                            color: const Color(0xFF00E676),
                            shape: BoxShape.circle,
                            border: Border.all(
                              color: BrandColors.border,
                              width: 2,
                            ),
                            image: _photoUrl.isNotEmpty
                                ? DecorationImage(
                                    image: NetworkImage(
                                      '${AppConstants.baseUrl}$_photoUrl',
                                    ),
                                    fit: BoxFit.cover,
                                  )
                                : null,
                          ),
                          child: _photoUrl.isNotEmpty
                              ? null
                              : const Icon(
                                  Icons.person_rounded,
                                  color: Colors.white,
                                  size: 42,
                                ),
                        ),
                        Positioned(
                          right: 0,
                          bottom: 0,
                          child: Container(
                            width: 28,
                            height: 28,
                            decoration: BoxDecoration(
                              color: BrandColors.surface,
                              shape: BoxShape.circle,
                              border: Border.all(color: BrandColors.border),
                            ),
                            child: _isPhotoUploading
                                ? const Padding(
                                    padding: EdgeInsets.all(6),
                                    child: CircularProgressIndicator(strokeWidth: 2),
                                  )
                                : const Icon(
                                    Icons.camera_alt_rounded,
                                    color: BrandColors.text,
                                    size: 15,
                                  ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    _photoUrl.isNotEmpty ? 'Tap photo to change' : 'Tap to upload your photo',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: BrandColors.textMuted,
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 14),
                  Text(
                    _name.isNotEmpty ? _name : 'Employee',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: BrandColors.text,
                      fontSize: 22,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    _employeeId.isNotEmpty ? _employeeId : 'No employee ID',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: BrandColors.textMuted,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 10),
                  if (_status.isNotEmpty)
                    _pill(_status.toUpperCase(), const Color(0xFFEAF8EF), const Color(0xFF147A3A)),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Account Info',
                    style: TextStyle(
                      color: BrandColors.text,
                      fontSize: 15,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 12),
                  _infoRow('Name', _name.isNotEmpty ? _name : '-'),
                  const SizedBox(height: 10),
                  _infoRow('Employee ID', _employeeId.isNotEmpty ? _employeeId : '-'),
                  const SizedBox(height: 10),
                  _infoRow('Email', _email.isNotEmpty ? _email : '-'),
                  const SizedBox(height: 10),
                  _infoRow('Phone', _phone.isNotEmpty ? _phone : '-'),
                  const SizedBox(height: 10),
                  _infoRow(
                    'Government ID',
                    _governmentId.isNotEmpty ? _governmentId : '-',
                    trailing: IconButton(
                      onPressed: _editGovernmentId,
                      icon: const Icon(Icons.edit_rounded, size: 17),
                      color: BrandColors.cyan,
                      visualDensity: VisualDensity.compact,
                      tooltip: 'Edit Government ID',
                    ),
                  ),
                  const SizedBox(height: 10),
                  _infoRow('Status', _status.isNotEmpty ? _status : '-'),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Biometrics',
                    style: TextStyle(
                      color: BrandColors.text,
                      fontSize: 15,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _hasBiometrics
                        ? 'Fingerprint is available on this device. It stays on your device and is never uploaded.'
                        : 'No fingerprint is available on this device. You can still mark your attendance without it.',
                    style: const TextStyle(
                      color: BrandColors.textMuted,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      height: 1.4,
                    ),
                  ),
                  const SizedBox(height: 14),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(
                      onPressed: _isVerifyingBiometrics || !_hasBiometrics
                          ? null
                          : _verifyBiometrics,
                      style: FilledButton.styleFrom(
                        backgroundColor: BrandColors.surface,
                        foregroundColor: BrandColors.text,
                        side: const BorderSide(color: BrandColors.border),
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(16),
                        ),
                      ),
                      icon: _isVerifyingBiometrics
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.fingerprint_rounded),
                      label: Text(
                        _isVerifyingBiometrics
                            ? 'Verifying...'
                            : 'Verify Fingerprint',
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _card({required Widget child, EdgeInsets margin = EdgeInsets.zero}) {
    return Container(
      margin: margin,
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: BrandColors.surface,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: BrandColors.border),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.06),
            blurRadius: 24,
            offset: const Offset(0, 14),
          ),
        ],
      ),
      child: child,
    );
  }

  Widget _pill(String text, Color bg, Color fg) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: fg.withValues(alpha: 0.18)),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: fg,
          fontSize: 11,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.5,
        ),
      ),
    );
  }

  Widget _infoRow(String label, String value, {Widget? trailing}) {
    return Row(
      children: [
        SizedBox(
          width: 94,
          child: Text(
            label,
            style: const TextStyle(
              color: BrandColors.textMuted,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(
              color: BrandColors.text,
              fontSize: 13,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        ?trailing,
      ],
    );
  }


  Widget _field({
    required TextEditingController controller,
    required String label,
    required IconData icon,
    bool obscureText = false,
    TextInputType keyboardType = TextInputType.text,
    Widget? suffixIcon,
    String? Function(String?)? validator,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(color: BrandColors.text, fontSize: 13, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 8),
        TextFormField(
          controller: controller,
          keyboardType: keyboardType,
          obscureText: obscureText,
          enableSuggestions: !obscureText,
          autocorrect: !obscureText,
          cursorColor: BrandColors.cyan,
          validator: validator,
          autovalidateMode: AutovalidateMode.onUserInteraction,
          decoration: InputDecoration(
            prefixIcon: Icon(icon, color: BrandColors.cyan),
            suffixIcon: suffixIcon,
            hintText: 'Enter $label',
            filled: true,
            fillColor: BrandColors.surface,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(color: BrandColors.border),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(color: BrandColors.border),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(color: BrandColors.cyan, width: 1.4),
            ),
          ),
        ),
      ],
    );
  }
}

class _ForgotPasswordPage extends StatefulWidget {
  final String initialEmail;

  const _ForgotPasswordPage({
    required this.initialEmail,
  });

  @override
  State<_ForgotPasswordPage> createState() => _ForgotPasswordPageState();
}

class _ForgotPasswordPageState extends State<_ForgotPasswordPage> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _emailCtrl;
  late final TextEditingController _newPasswordCtrl;
  late final TextEditingController _confirmPasswordCtrl;
  late final FocusNode _emailFocusNode;
  late final FocusNode _newPasswordFocusNode;
  late final FocusNode _confirmPasswordFocusNode;
  final List<TextEditingController> _codeCtrls =
      List.generate(6, (_) => TextEditingController());
  final List<FocusNode> _codeFocusNodes = List.generate(6, (_) => FocusNode());
  bool _isSending = false;
  bool _codeSent = false;
  bool _codeVerified = false;
  bool _newPasswordHidden = true;
  bool _confirmPasswordHidden = true;
  String _message = '';
  int _codeExpiryRemainingSeconds = 0;
  int _resendRemainingSeconds = 0;
  Timer? _resetTimer;
  static const int _codeExpiryTotalSeconds = 20 * 60;
  static const int _resendCooldownSeconds = 30;

  @override
  void initState() {
    super.initState();
    _emailCtrl = TextEditingController(text: widget.initialEmail);
    _newPasswordCtrl = TextEditingController();
    _confirmPasswordCtrl = TextEditingController();
    _emailFocusNode = FocusNode();
    _newPasswordFocusNode = FocusNode();
    _confirmPasswordFocusNode = FocusNode();
  }

  @override
  void dispose() {
    _resetTimer?.cancel();
    _emailCtrl.dispose();
    _newPasswordCtrl.dispose();
    _confirmPasswordCtrl.dispose();
    _emailFocusNode.dispose();
    _newPasswordFocusNode.dispose();
    _confirmPasswordFocusNode.dispose();
    for (final ctrl in _codeCtrls) {
      ctrl.dispose();
    }
    for (final node in _codeFocusNodes) {
      node.dispose();
    }
    super.dispose();
  }

  String get _otpCode => _codeCtrls.map((ctrl) => ctrl.text.trim()).join();

  String _formatCountdown(int totalSeconds) {
    final safe = totalSeconds < 0 ? 0 : totalSeconds;
    final minutes = safe ~/ 60;
    final seconds = safe % 60;
    return '${minutes.toString().padLeft(2, '0')}:${seconds.toString().padLeft(2, '0')}';
  }

  void _clearOtpFields() {
    for (final ctrl in _codeCtrls) {
      ctrl.clear();
    }
  }

  void _startResetTimers() {
    _resetTimer?.cancel();
    _codeExpiryRemainingSeconds = _codeExpiryTotalSeconds;
    _resendRemainingSeconds = _resendCooldownSeconds;
    _resetTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      final hasExpiry = _codeExpiryRemainingSeconds > 0;
      final hasResend = _resendRemainingSeconds > 0;
      if (!hasExpiry && !hasResend) {
        timer.cancel();
        return;
      }
      setState(() {
        if (_codeExpiryRemainingSeconds > 0) {
          _codeExpiryRemainingSeconds--;
        }
        if (_resendRemainingSeconds > 0) {
          _resendRemainingSeconds--;
        }
        if (_codeExpiryRemainingSeconds <= 0) {
          _codeVerified = false;
        }
      });
    });
  }

  void _stopResetTimers() {
    _resetTimer?.cancel();
    _resetTimer = null;
    _codeExpiryRemainingSeconds = 0;
    _resendRemainingSeconds = 0;
  }

  void _focusCodeField(int index) {
    if (index < 0 || index >= _codeFocusNodes.length) return;
    FocusScope.of(context).requestFocus(_codeFocusNodes[index]);
  }

  void _applyOtpValue(String value, int index) {
    final digits = value.replaceAll(RegExp(r'\D'), '');
    if (digits.isEmpty) {
      if (_codeVerified) setState(() => _codeVerified = false);
      return;
    }

    if (digits.length > 1) {
      for (var i = 0; i < _codeCtrls.length; i++) {
        final next = i < digits.length ? digits[i] : '';
        _codeCtrls[i].text = next;
      }
      if (_codeVerified) _codeVerified = false;
      setState(() {});
      final nextFocus = digits.length >= _codeCtrls.length
          ? _codeCtrls.length - 1
          : digits.length;
      _focusCodeField(nextFocus);
      if (digits.length >= _codeCtrls.length) {
        FocusScope.of(context).unfocus();
      }
      return;
    }

    if (_codeCtrls[index].text != digits) {
      _codeCtrls[index].text = digits;
      _codeCtrls[index].selection = TextSelection.collapsed(offset: digits.length);
    }
    if (_codeVerified) setState(() => _codeVerified = false);
    if (index < _codeCtrls.length - 1) {
      _focusCodeField(index + 1);
    } else {
      FocusScope.of(context).unfocus();
    }
  }

  Future<void> _sendResetCode() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() {
      _isSending = true;
      _message = '';
    });

    try {
      final res = await ApiClient.postForm(
        '/employee/forgot-password',
        body: {'email': _emailCtrl.text.trim()},
      );
      final body = json.decode(res.body);

      if (!mounted) return;

      if (res.statusCode == 200 && body is Map<String, dynamic>) {
        setState(() {
          _codeSent = true;
          _codeVerified = false;
          _clearOtpFields();
          _newPasswordCtrl.clear();
          _confirmPasswordCtrl.clear();
          _message = body['message']?.toString() ?? 'Verification code sent to your email.';
        });
        if (mounted) {
          _startResetTimers();
          _focusCodeField(0);
        }
        return;
      }

      setState(() {
        _message = body is Map<String, dynamic>
            ? _friendlyResetMessage(
                serverMessageFromBody(
                  res.body,
                  fallback: 'Unable to send verification code.',
                ),
                fallback: 'Unable to send verification code.',
              )
            : 'Unable to send verification code.';
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _message = ApiClient.friendlyNetworkError(error);
      });
    } finally {
      if (mounted) {
        setState(() => _isSending = false);
      }
    }
  }

  Future<void> _verifyResetCode() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    if (_otpCode.length != 6) {
      setState(() {
        _codeVerified = false;
        _message = 'Enter the full 6-digit code.';
      });
      return;
    }
    if (_codeExpiryRemainingSeconds <= 0) {
      setState(() {
        _codeVerified = false;
        _message = 'That code has expired. Please request a new one.';
      });
      return;
    }
    setState(() {
      _isSending = true;
      _message = '';
    });

    try {
      final res = await ApiClient.postForm(
        '/employee/verify-reset-code',
        body: {
          'email': _emailCtrl.text.trim(),
          'code': _otpCode,
        },
      );
      final body = json.decode(res.body);

      if (!mounted) return;

      if (res.statusCode == 200 && body is Map<String, dynamic>) {
        setState(() {
          _codeVerified = true;
          _newPasswordCtrl.clear();
          _confirmPasswordCtrl.clear();
          _message = body['message']?.toString() ?? 'Code verified. You may now set a new password.';
        });
        if (mounted) {
          FocusScope.of(context).requestFocus(_newPasswordFocusNode);
        }
        return;
      }

      setState(() {
        _codeVerified = false;
        _message = body is Map<String, dynamic>
            ? _friendlyResetMessage(
                serverMessageFromBody(
                  res.body,
                  fallback: 'Unable to verify code.',
                ),
                fallback: 'Unable to verify code.',
              )
            : 'Unable to verify code.';
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _codeVerified = false;
        _message = ApiClient.friendlyNetworkError(error);
      });
    } finally {
      if (mounted) {
        setState(() => _isSending = false);
      }
    }
  }

  void _resetToEmailStep() {
    _stopResetTimers();
    setState(() {
      _codeSent = false;
      _codeVerified = false;
      _newPasswordHidden = true;
      _confirmPasswordHidden = true;
      _message = '';
      _clearOtpFields();
      _newPasswordCtrl.clear();
      _confirmPasswordCtrl.clear();
    });
    FocusScope.of(context).requestFocus(_emailFocusNode);
  }

  String _friendlyResetMessage(String raw, {String fallback = 'Something went wrong.'}) {
    final msg = raw.toLowerCase();
    if (msg.contains('expired')) {
      return 'That code has expired. Please request a new one.';
    }
    if (msg.contains('invalid verification code') || msg.contains('verification code is not valid')) {
      return 'The code you entered is incorrect. Please try again.';
    }
    if (msg.contains('no verification code found')) {
      return 'No code is available yet. Please send a new code first.';
    }
    if (msg.contains('no account found')) {
      return 'We could not find an account for that email.';
    }
    if (msg.contains('email is required')) {
      return 'Email is required.';
    }
    if (msg.contains('verification code is required')) {
      return 'Verification code is required.';
    }
    if (msg.contains('password must be at least 8 characters')) {
      return 'Password must be at least 8 characters.';
    }
    return raw.isNotEmpty ? raw : fallback;
  }

  Future<void> _resendCode() async {
    if (_isSending || (_resendRemainingSeconds > 0 && _codeSent)) return;
    setState(() {
      _codeVerified = false;
      _newPasswordHidden = true;
      _confirmPasswordHidden = true;
      _message = '';
      _clearOtpFields();
    });
    await _sendResetCode();
  }

  Future<void> _submitNewPassword() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    if (!_codeVerified) {
      setState(() {
        _message = 'Please verify the code first.';
      });
      return;
    }
    if (_otpCode.length != 6) {
      setState(() {
        _codeVerified = false;
        _message = 'Enter the full 6-digit code.';
      });
      return;
    }
    if (_codeExpiryRemainingSeconds <= 0) {
      setState(() {
        _codeVerified = false;
        _message = 'That code has expired. Please request a new one.';
      });
      return;
    }
    if (_newPasswordCtrl.text.trim() != _confirmPasswordCtrl.text.trim()) {
      setState(() {
        _message = 'Passwords do not match.';
      });
      return;
    }

    setState(() {
      _isSending = true;
      _message = '';
    });

    try {
      final res = await ApiClient.postForm(
        '/employee/reset-password',
        body: {
          'email': _emailCtrl.text.trim(),
          'code': _otpCode,
          'new_password': _newPasswordCtrl.text,
        },
      );
      final body = json.decode(res.body);

      if (!mounted) return;

      if (res.statusCode == 200 && body is Map<String, dynamic>) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              body['message']?.toString() ?? 'Password updated successfully.',
            ),
            backgroundColor: const Color(0xFF1D2939),
          ),
        );
        Navigator.of(context).pop();
        return;
      }

      setState(() {
        _message = body is Map<String, dynamic>
            ? _friendlyResetMessage(
                serverMessageFromBody(
                  res.body,
                  fallback: 'Unable to update password.',
                ),
                fallback: 'Unable to update password.',
              )
            : 'Unable to update password.';
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _message = ApiClient.friendlyNetworkError(error);
      });
    } finally {
      if (mounted) {
        setState(() => _isSending = false);
      }
    }
  }

  Widget _statusChip({
    required IconData icon,
    required String label,
    required Color bg,
    required Color fg,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: fg.withValues(alpha: 0.16)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: fg),
          const SizedBox(width: 6),
          Text(
            label,
            style: TextStyle(
              color: fg,
              fontSize: 11,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }

  Widget _otpDigitField(int index) {
    return SizedBox(
      width: 44,
      child: TextFormField(
        controller: _codeCtrls[index],
        focusNode: _codeFocusNodes[index],
        enabled: !_isSending && _codeSent,
        textAlign: TextAlign.center,
        keyboardType: TextInputType.number,
        textInputAction: index == _codeCtrls.length - 1
            ? TextInputAction.done
            : TextInputAction.next,
        autofillHints: const [AutofillHints.oneTimeCode],
        maxLength: 6,
        inputFormatters: [
          FilteringTextInputFormatter.digitsOnly,
          LengthLimitingTextInputFormatter(6),
        ],
        onChanged: (value) {
          _applyOtpValue(value, index);
        },
        onTap: () {
          if (_codeVerified) {
            setState(() => _codeVerified = false);
          }
        },
        decoration: InputDecoration(
          counterText: '',
          filled: true,
          fillColor: const Color(0xFFF7FAFC),
          contentPadding: const EdgeInsets.symmetric(vertical: 14),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: BrandColors.border),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: BrandColors.border),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(color: BrandColors.cyan, width: 1.4),
          ),
        ),
        validator: (_) => null,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: BrandColors.bg,
      appBar: AppBar(
        backgroundColor: BrandColors.surface,
        elevation: 0,
        toolbarHeight: 72,
        title: const BrandMark(
          compact: true,
          titleColor: BrandColors.text,
          subtitleColor: BrandColors.textMuted,
        ),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(height: 1, color: BrandColors.border),
        ),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Container(
                padding: const EdgeInsets.all(22),
                decoration: BoxDecoration(
                  color: BrandColors.surface,
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: BrandColors.border),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.12),
                      blurRadius: 24,
                      offset: const Offset(0, 14),
                    ),
                  ],
                ),
                child: Form(
                  key: _formKey,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        children: [
                          Container(
                            width: 48,
                            height: 48,
                            decoration: BoxDecoration(
                              color: const Color(0xFFE9F7FB),
                              borderRadius: BorderRadius.circular(14),
                            ),
                            child: const Icon(Icons.lock_reset_rounded, color: BrandColors.cyan),
                          ),
                          const SizedBox(width: 12),
                          const Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Forgot Password',
                                  style: TextStyle(
                                    color: BrandColors.text,
                                    fontSize: 18,
                                    fontWeight: FontWeight.w900,
                                  ),
                                ),
                                SizedBox(height: 4),
                                Text(
                                  'Use your registered email so we can route the reset request.',
                                  style: TextStyle(
                                    color: BrandColors.textMuted,
                                    fontSize: 12,
                                    height: 1.35,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 18),
                      TextFormField(
                        controller: _emailCtrl,
                        enabled: !_codeSent,
                        focusNode: _emailFocusNode,
                        keyboardType: TextInputType.emailAddress,
                        decoration: InputDecoration(
                          labelText: 'Registered email',
                          prefixIcon: const Icon(Icons.email_rounded, color: BrandColors.cyan),
                          filled: true,
                          fillColor: const Color(0xFFF7FAFC),
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(14),
                            borderSide: const BorderSide(color: BrandColors.border),
                          ),
                          enabledBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(14),
                            borderSide: const BorderSide(color: BrandColors.border),
                          ),
                          focusedBorder: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(14),
                            borderSide: const BorderSide(color: BrandColors.cyan, width: 1.4),
                          ),
                        ),
                        validator: (value) {
                          final text = value?.trim() ?? '';
                          if (text.isEmpty) return 'Email is required.';
                          if (!text.contains('@')) return 'Enter a valid email.';
                          return null;
                        },
                      ),
                      if (_codeSent) ...[
                        const SizedBox(height: 12),
                        Row(
                          children: [
                            Expanded(
                              child: TextButton(
                                onPressed: _isSending ? null : _resetToEmailStep,
                                child: const Text('Use a different email'),
                              ),
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: TextButton(
                                onPressed: (_isSending || _resendRemainingSeconds > 0)
                                    ? null
                                    : _resendCode,
                                child: Text(
                                  _resendRemainingSeconds > 0
                                      ? 'Resend in ${_formatCountdown(_resendRemainingSeconds)}'
                                      : 'Resend code',
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        LayoutBuilder(
                          builder: (context, constraints) {
                            final gap = constraints.maxWidth < 420 ? 6.0 : 8.0;
                            final fieldWidth =
                                ((constraints.maxWidth - (gap * 5)) / 6).clamp(40.0, 48.0);
                            final children = <Widget>[];
                            for (var index = 0; index < _codeCtrls.length; index++) {
                              if (index > 0) {
                                children.add(SizedBox(width: gap));
                              }
                              children.add(SizedBox(
                                width: fieldWidth,
                                child: _otpDigitField(index),
                              ));
                            }
                            return Row(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: children,
                            );
                          },
                        ),
                        const SizedBox(height: 10),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            _statusChip(
                              icon: Icons.schedule_rounded,
                              label: _codeExpiryRemainingSeconds > 0
                                  ? 'Expires in ${_formatCountdown(_codeExpiryRemainingSeconds)}'
                                  : 'Code expired',
                              bg: const Color(0xFFFDF2F2),
                              fg: const Color(0xFFB42318),
                            ),
                            _statusChip(
                              icon: Icons.refresh_rounded,
                              label: _resendRemainingSeconds > 0
                                  ? 'Resend in ${_formatCountdown(_resendRemainingSeconds)}'
                                  : 'Resend ready',
                              bg: const Color(0xFFF8FAFC),
                              fg: BrandColors.textMuted,
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        if (_codeExpiryRemainingSeconds <= 0) ...[
                          Container(
                            padding: const EdgeInsets.all(14),
                            decoration: BoxDecoration(
                              color: const Color(0xFFFDF2F2),
                              borderRadius: BorderRadius.circular(14),
                              border: Border.all(color: const Color(0xFFFECACA)),
                            ),
                            child: const Text(
                              'That code has expired. Request a new one to continue.',
                              style: TextStyle(
                                color: Color(0xFFB42318),
                                fontSize: 12,
                                height: 1.45,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ] else if (_codeVerified) ...[
                          const SizedBox(height: 12),
                          TextFormField(
                            controller: _newPasswordCtrl,
                            focusNode: _newPasswordFocusNode,
                            obscureText: _newPasswordHidden,
                            decoration: InputDecoration(
                              labelText: 'New password',
                              prefixIcon: const Icon(Icons.lock_rounded, color: BrandColors.cyan),
                              suffixIcon: IconButton(
                                onPressed: () {
                                  setState(() => _newPasswordHidden = !_newPasswordHidden);
                                },
                                icon: Icon(
                                  _newPasswordHidden ? Icons.visibility_off_rounded : Icons.visibility_rounded,
                                  color: BrandColors.textMuted,
                                ),
                              ),
                              filled: true,
                              fillColor: const Color(0xFFF7FAFC),
                              border: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(14),
                                borderSide: const BorderSide(color: BrandColors.border),
                              ),
                              enabledBorder: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(14),
                                borderSide: const BorderSide(color: BrandColors.border),
                              ),
                              focusedBorder: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(14),
                                borderSide: const BorderSide(color: BrandColors.cyan, width: 1.4),
                              ),
                            ),
                            validator: (value) {
                              final text = value?.trim() ?? '';
                              if (text.isEmpty) return 'New password is required.';
                              if (text.length < 8) return 'Password must be at least 8 characters.';
                              return null;
                            },
                          ),
                          const SizedBox(height: 12),
                          TextFormField(
                            controller: _confirmPasswordCtrl,
                            focusNode: _confirmPasswordFocusNode,
                            obscureText: _confirmPasswordHidden,
                            decoration: InputDecoration(
                              labelText: 'Confirm password',
                              prefixIcon: const Icon(Icons.lock_outline_rounded, color: BrandColors.cyan),
                              suffixIcon: IconButton(
                                onPressed: () {
                                  setState(() => _confirmPasswordHidden = !_confirmPasswordHidden);
                                },
                                icon: Icon(
                                  _confirmPasswordHidden ? Icons.visibility_off_rounded : Icons.visibility_rounded,
                                  color: BrandColors.textMuted,
                                ),
                              ),
                              filled: true,
                              fillColor: const Color(0xFFF7FAFC),
                              border: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(14),
                                borderSide: const BorderSide(color: BrandColors.border),
                              ),
                              enabledBorder: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(14),
                                borderSide: const BorderSide(color: BrandColors.border),
                              ),
                              focusedBorder: OutlineInputBorder(
                                borderRadius: BorderRadius.circular(14),
                                borderSide: const BorderSide(color: BrandColors.cyan, width: 1.4),
                              ),
                            ),
                            validator: (value) {
                              final text = value?.trim() ?? '';
                              if (text.isEmpty) return 'Please confirm your password.';
                              return null;
                            },
                          ),
                          const SizedBox(height: 14),
                          Container(
                            padding: const EdgeInsets.all(14),
                            decoration: BoxDecoration(
                              color: const Color(0xFFF8FAFC),
                              borderRadius: BorderRadius.circular(14),
                              border: Border.all(color: BrandColors.border),
                            ),
                            child: Text(
                              'Code verified. You can now create your new password.',
                              style: const TextStyle(
                                color: BrandColors.textMuted,
                                fontSize: 12,
                                height: 1.45,
                              ),
                            ),
                          ),
                        ] else ...[
                          Container(
                            padding: const EdgeInsets.all(14),
                            decoration: BoxDecoration(
                              color: const Color(0xFFF8FAFC),
                              borderRadius: BorderRadius.circular(14),
                              border: Border.all(color: BrandColors.border),
                            ),
                            child: Text(
                              'Enter the 6-digit code sent to your email, then tap Verify Code.',
                              style: const TextStyle(
                                color: BrandColors.textMuted,
                                fontSize: 12,
                                height: 1.45,
                              ),
                            ),
                          ),
                        ],
                      ],
                      if (_message.isNotEmpty) ...[
                        const SizedBox(height: 12),
                        Text(
                          _message,
                          style: const TextStyle(
                            color: Color(0xFF8E1F1F),
                            fontSize: 12,
                            height: 1.35,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                      const SizedBox(height: 18),
                      Row(
                        children: [
                          Expanded(
                            child: TextButton(
                              onPressed: _isSending ? null : () => Navigator.pop(context),
                              child: const Text('Cancel'),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: ElevatedButton(
                              onPressed: _isSending
                                  ? null
                                  : !_codeSent
                                      ? _sendResetCode
                                      : !_codeVerified
                                          ? _verifyResetCode
                                          : _submitNewPassword,
                              style: ElevatedButton.styleFrom(
                                backgroundColor: BrandColors.cyan,
                                foregroundColor: Colors.white,
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(14),
                                ),
                              ),
                              child: _isSending
                                  ? const SizedBox(
                                      width: 18,
                                      height: 18,
                                  child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: Colors.white,
                                      ),
                                    )
                                  : Text(
                                      !_codeSent
                                          ? 'Send Code'
                                          : !_codeVerified
                                              ? 'Verify Code'
                                              : 'Reset Password',
                                    ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
