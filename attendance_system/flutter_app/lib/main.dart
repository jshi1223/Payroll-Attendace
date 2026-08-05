import 'package:flutter/material.dart';
import 'dart:ui';
import 'package:flutter/services.dart';
import 'dart:async';
import 'screen/employee_login_screen.dart';
import 'screen/registration_screen.dart';
import 'constants.dart';
import 'services/api_client.dart';
import 'services/app_update_service.dart';
import 'services/push_notification_service.dart';
import 'widgets/brand_logo.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await PushNotificationService.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
    ),
  );
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'KVSK CCTV & IT Solutions',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.light().copyWith(
        scaffoldBackgroundColor: BrandColors.bg,
        colorScheme: const ColorScheme.light(
          primary: BrandColors.cyan,
          secondary: BrandColors.violet,
          surface: BrandColors.surface,
          onPrimary: Colors.white,
          onSecondary: Colors.white,
          onSurface: BrandColors.text,
        ),
      ),
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with TickerProviderStateMixin {
  late AnimationController _fadeController;
  late AnimationController _pulseController;
  late Animation<double> _fadeAnim;
  late Animation<double> _pulseAnim;
  late final ScrollController _scrollController;

  bool _isServerOnline = false;
  bool _updateChecked = false;
  Timer? _statusTimer;

  @override
  void initState() {
    super.initState();
    _scrollController = ScrollController();
    _fadeController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    );
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 2),
    )..repeat(reverse: true);

    _fadeAnim = CurvedAnimation(parent: _fadeController, curve: Curves.easeOut);
    _pulseAnim = Tween<double>(begin: 0.95, end: 1.05).animate(
      CurvedAnimation(parent: _pulseController, curve: Curves.easeInOut),
    );

    _fadeController.forward();
    _checkServerStatus();
    WidgetsBinding.instance.addPostFrameCallback((_) => _checkForAppUpdate());
    // Check status every 10 seconds
    _statusTimer = Timer.periodic(
      const Duration(seconds: 10),
      (_) => _checkServerStatus(),
    );
  }

  Future<void> _checkServerStatus() async {
    try {
      final response = await ApiClient.get(
        '/status',
        timeout: const Duration(seconds: 3),
      );
      if (mounted) setState(() => _isServerOnline = response.statusCode == 200);
    } catch (e) {
      if (mounted) setState(() => _isServerOnline = false);
    }
  }

  Future<void> _checkForAppUpdate() async {
    if (_updateChecked || !mounted) return;
    _updateChecked = true;
    try {
      final info = await AppUpdateService.checkForUpdate();
      if (!mounted || info == null || !AppUpdateService.shouldShowUpdate(info)) {
        return;
      }
      final required = AppUpdateService.isRequired(info);
      await showDialog<void>(
        context: context,
        barrierDismissible: !required,
        builder: (dialogContext) {
          return PopScope(
            canPop: !required,
            child: AlertDialog(
              title: Text(required ? 'Update required' : 'Update available'),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Current: ${AppConstants.appVersion}'),
                  Text('Latest: ${info.latestVersion}'),
                  if (info.releaseNotes.trim().isNotEmpty) ...[
                    const SizedBox(height: 12),
                    Text(info.releaseNotes.trim()),
                  ],
                ],
              ),
              actions: [
                if (!required)
                  TextButton(
                    onPressed: () => Navigator.of(dialogContext).pop(),
                    child: const Text('Later'),
                  ),
                FilledButton(
                  onPressed: info.apkUrl.trim().isEmpty
                      ? null
                      : () => AppUpdateService.openUpdateUrl(info.apkUrl),
                  child: const Text('Update'),
                ),
              ],
            ),
          );
        },
      );
    } catch (_) {}
  }

  void _openSystemStatus() {
    Navigator.push(
      context,
      _slideRoute(
        SystemStatusScreen(initialOnline: _isServerOnline),
      ),
    ).then((_) => _checkServerStatus());
  }

  @override
  void dispose() {
    _scrollController.dispose();
    _fadeController.dispose();
    _pulseController.dispose();
    _statusTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Color(0xFFFDFDFE), Color(0xFFF1F3F5), Color(0xFFFDFDFE)],
          ),
        ),
        child: SafeArea(
          child: FadeTransition(
            opacity: _fadeAnim,
            child: Scrollbar(
              controller: _scrollController,
              thumbVisibility: true,
              child: SingleChildScrollView(
                controller: _scrollController,
                physics: const BouncingScrollPhysics(),
                padding: const EdgeInsets.symmetric(
                  horizontal: 28,
                  vertical: 20,
                ),
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    minHeight:
                        MediaQuery.sizeOf(context).height -
                        MediaQuery.paddingOf(context).vertical -
                        40,
                  ),
                  child: IntrinsicHeight(
                    child: Column(
                      children: [
                        const SizedBox(height: 28),

                        // HEADER
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  _getGreeting(),
                                  style: TextStyle(
                                    color: BrandColors.textMuted,
                                    fontSize: 13,
                                  ),
                                ),
                                const SizedBox(height: 6),
                                const BrandMark(
                                  compact: true,
                                  titleColor: BrandColors.text,
                                  subtitleColor: BrandColors.textMuted,
                                ),
                              ],
                            ),
                            GestureDetector(
                              onTap: _openSystemStatus,
                              child: Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 12,
                                  vertical: 6,
                                ),
                                decoration: BoxDecoration(
                                  color:
                                      (_isServerOnline
                                              ? const Color(0xFF00E676)
                                              : Colors.red)
                                          .withValues(alpha: 0.1),
                                  borderRadius: BorderRadius.circular(20),
                                  border: Border.all(
                                    color:
                                        (_isServerOnline
                                                ? const Color(0xFF00E676)
                                                : Colors.red)
                                            .withValues(alpha: 0.3),
                                  ),
                                ),
                                child: Row(
                                  children: [
                                    Container(
                                      width: 8,
                                      height: 8,
                                      decoration: BoxDecoration(
                                        color: _isServerOnline
                                            ? const Color(0xFF00E676)
                                            : Colors.red,
                                        shape: BoxShape.circle,
                                      ),
                                    ),
                                    const SizedBox(width: 6),
                                    Text(
                                      _isServerOnline ? 'Online' : 'Offline',
                                      style: TextStyle(
                                        color: _isServerOnline
                                            ? const Color(0xFF00E676)
                                            : Colors.red,
                                        fontSize: 12,
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                    const SizedBox(width: 4),
                                    Icon(
                                      Icons.settings_rounded,
                                      color: _isServerOnline
                                          ? const Color(0xFF00E676)
                                          : Colors.red,
                                      size: 14,
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ],
                        ),

                        const SizedBox(height: 48),

                        // HERO BRAND
                        ScaleTransition(
                          scale: _pulseAnim,
                          child: Container(
                            width: 260,
                            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 18),
                            decoration: BoxDecoration(
                              borderRadius: BorderRadius.circular(32),
                              gradient: const LinearGradient(
                                begin: Alignment.topLeft,
                                end: Alignment.bottomRight,
                                colors: [Color(0xFFFFFFFF), Color(0xFFF3ECE9)],
                              ),
                              border: Border.all(
                                color: const Color(0xFFD7CBC7).withValues(alpha: 0.95),
                              ),
                              boxShadow: [
                                BoxShadow(
                                  color: const Color(0xFFA03628).withValues(alpha: 0.18),
                                  blurRadius: 30,
                                  spreadRadius: 4,
                                ),
                              ],
                            ),
                            child: const Center(
                              child: BrandIdentity(
                                width: 220,
                              ),
                            ),
                          ),
                        ),

                        const SizedBox(height: 24),

                        const Text(
                          'Attendance Monitoring',
                          style: TextStyle(
                            color: Color(0xFF111111),
                            fontSize: 26,
                            fontWeight: FontWeight.bold,
                            letterSpacing: 0.5,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Secure & Fast Attendance Tracking',
                          style: TextStyle(
                            color: BrandColors.textMuted,
                            fontSize: 14,
                          ),
                        ),

                        const SizedBox(height: 48),

                        // ── DATE & TIME ──
                        _DateTimeCard(),

                        const SizedBox(height: 32),

                        // ── BUTTONS ──
                        _ActionButton(
                          label: 'Register Employee',
                          subtitle: 'New employee registration',
                          icon: Icons.person_add_alt_1,
                          gradient: const LinearGradient(
                            colors: [Color(0xFF2B2B2B), Color(0xFF1E1E1E)],
                          ),
                          onTap: () => Navigator.push(
                            context,
                            _slideRoute(const RegistrationScreen()),
                          ),
                        ),

                        const SizedBox(height: 16),

                        _ActionButton(
                          label: 'Employee Login',
                          subtitle: 'Approved account access',
                          icon: Icons.person_rounded,
                          gradient: const LinearGradient(
                            colors: [Color(0xFF1E1E1E), Color(0xFF0F0F0F)],
                          ),
                          onTap: () => Navigator.push(
                            context,
                            _slideRoute(const EmployeeLoginScreen()),
                          ),
                        ),

                        const SizedBox(height: 16),

                        _ActionButton(
                          label: 'Server & Registration Status',
                          subtitle: 'Check connection and approval result',
                          icon: Icons.fact_check_rounded,
                          gradient: const LinearGradient(
                            colors: [Color(0xFFB31D18), Color(0xFF73120F)],
                          ),
                          onTap: _openSystemStatus,
                        ),

                        const Spacer(),

                        // ── FOOTER ──
                        Padding(
                          padding: const EdgeInsets.only(top: 24, bottom: 12),
                          child: Text(
                            'Powered by KVSK CCTV & IT Solutions',
                            style: TextStyle(
                              color: Colors.white.withValues(alpha: 0.25),
                              fontSize: 12,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  String _getGreeting() {
    final hour = DateTime.now().hour;
    if (hour < 12) return 'Good Morning';
    if (hour < 17) return 'Good Afternoon';
    return 'Good Evening';
  }

  PageRouteBuilder _slideRoute(Widget page) {
    return PageRouteBuilder(
      pageBuilder: (_, _, _) => page,
      transitionsBuilder: (_, anim, _, child) {
        return SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(1, 0),
            end: Offset.zero,
          ).animate(CurvedAnimation(parent: anim, curve: Curves.easeOutCubic)),
          child: child,
        );
      },
      transitionDuration: const Duration(milliseconds: 300),
    );
  }
}

class SystemStatusScreen extends StatefulWidget {
  final bool initialOnline;

  const SystemStatusScreen({super.key, required this.initialOnline});

  @override
  State<SystemStatusScreen> createState() => _SystemStatusScreenState();
}

class _SystemStatusScreenState extends State<SystemStatusScreen> {
  final _emailController = TextEditingController();
  final _phoneController = TextEditingController();
  bool _checkingServer = false;
  bool _checkingRegistration = false;
  bool _serverOnline = false;
  String _serverMessage = 'Not checked yet.';
  Map<String, dynamic>? _registration;

  @override
  void initState() {
    super.initState();
    _serverOnline = widget.initialOnline;
    _serverMessage = widget.initialOnline
        ? 'Server is online.'
        : 'Server is offline or unreachable.';
    _testConnection();
  }

  @override
  void dispose() {
    _emailController.dispose();
    _phoneController.dispose();
    super.dispose();
  }

  Future<void> _testConnection() async {
    setState(() {
      _checkingServer = true;
      _serverMessage = 'Checking server...';
    });
    try {
      final response = await ApiClient.get(
        '/status',
        timeout: const Duration(seconds: 6),
      );
      final parsed = ApiClient.jsonObject(response.body);
      setState(() {
        _serverOnline = response.statusCode == 200;
        _serverMessage = _serverOnline
            ? 'Connected to ${parsed?['service'] ?? 'attendance system'}.'
            : ApiClient.messageFromBody(
                response.body,
                fallback: 'Server returned ${response.statusCode}.',
              );
      });
    } catch (error) {
      setState(() {
        _serverOnline = false;
        _serverMessage = ApiClient.friendlyNetworkError(error);
      });
    } finally {
      if (mounted) setState(() => _checkingServer = false);
    }
  }

  Future<void> _checkRegistration() async {
    final email = _emailController.text.trim();
    final phone = _phoneController.text.trim();
    if (email.isEmpty || phone.isEmpty) {
      setState(() {
        _registration = {
          'status': 'missing',
          'message': 'Enter the email and phone used during registration.',
        };
      });
      return;
    }

    setState(() {
      _checkingRegistration = true;
      _registration = null;
    });
    final path =
        '/register/status?email=${Uri.encodeQueryComponent(email)}&phone=${Uri.encodeQueryComponent(phone)}';
    try {
      final response = await ApiClient.get(
        path,
        timeout: const Duration(seconds: 10),
      );
      final parsed = ApiClient.jsonObject(response.body);
      setState(() {
        if (response.statusCode == 200 && parsed != null) {
          _registration = parsed;
        } else {
          _registration = {
            'status': 'error',
            'message': ApiClient.messageFromBody(response.body),
          };
        }
      });
    } catch (error) {
      setState(() {
        _registration = {
          'status': 'error',
          'message': ApiClient.friendlyNetworkError(error),
        };
      });
    } finally {
      if (mounted) setState(() => _checkingRegistration = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final statusColor =
        _serverOnline ? const Color(0xFF159947) : const Color(0xFFB31D18);
    return Scaffold(
      backgroundColor: BrandColors.bg,
      appBar: AppBar(
        backgroundColor: BrandColors.bg,
        foregroundColor: BrandColors.text,
        elevation: 0,
        title: const Text('Server & Status'),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
          children: [
            _StatusPanel(
              icon: Icons.cloud_done_rounded,
              title: 'Connection',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 10,
                        height: 10,
                        decoration: BoxDecoration(
                          color: statusColor,
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          _serverOnline ? 'Online' : 'Offline',
                          style: TextStyle(
                            color: statusColor,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ),
                      IconButton(
                        onPressed: _checkingServer ? null : _testConnection,
                        icon: _checkingServer
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Icon(Icons.refresh_rounded),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _serverMessage,
                    style: const TextStyle(color: BrandColors.textMuted),
                  ),
                  const SizedBox(height: 12),
                  _InfoLine(label: 'API URL', value: AppConstants.baseUrl),
                  _InfoLine(label: 'App Version', value: AppConstants.appVersion),
                ],
              ),
            ),
            const SizedBox(height: 16),
            _StatusPanel(
              icon: Icons.verified_user_rounded,
              title: 'Registration Approval',
              child: Column(
                children: [
                  TextField(
                    controller: _emailController,
                    keyboardType: TextInputType.emailAddress,
                    decoration: const InputDecoration(
                      labelText: 'Email',
                      prefixIcon: Icon(Icons.email_outlined),
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _phoneController,
                    keyboardType: TextInputType.phone,
                    decoration: const InputDecoration(
                      labelText: 'Phone',
                      prefixIcon: Icon(Icons.phone_outlined),
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 14),
                  SizedBox(
                    width: double.infinity,
                    height: 48,
                    child: ElevatedButton.icon(
                      onPressed:
                          _checkingRegistration ? null : _checkRegistration,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFFB31D18),
                        foregroundColor: Colors.white,
                      ),
                      icon: _checkingRegistration
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Icon(Icons.search_rounded),
                      label: const Text('Check Status'),
                    ),
                  ),
                  if (_registration != null) ...[
                    const SizedBox(height: 14),
                    _RegistrationResult(data: _registration!),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusPanel extends StatelessWidget {
  final IconData icon;
  final String title;
  final Widget child;

  const _StatusPanel({
    required this.icon,
    required this.title,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE7E1DF)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.05),
            blurRadius: 12,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, color: const Color(0xFFB31D18)),
              const SizedBox(width: 10),
              Text(
                title,
                style: const TextStyle(
                  color: BrandColors.text,
                  fontSize: 17,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          child,
        ],
      ),
    );
  }
}

class _InfoLine extends StatelessWidget {
  final String label;
  final String value;

  const _InfoLine({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 92,
            child: Text(
              label,
              style: const TextStyle(color: BrandColors.textMuted),
            ),
          ),
          Expanded(
            child: SelectableText(
              value,
              style: const TextStyle(
                color: BrandColors.text,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _RegistrationResult extends StatelessWidget {
  final Map<String, dynamic> data;

  const _RegistrationResult({required this.data});

  @override
  Widget build(BuildContext context) {
    final status = (data['status'] ?? 'unknown').toString().toLowerCase();
    final color = _statusColor(status);
    final title = _statusTitle(status);
    final message = data['message']?.toString() ??
        (status == 'approved'
            ? 'You can now login using your registered email and password.'
            : status == 'pending' || status == 'review'
                ? 'Please wait for admin approval. You will receive an email update.'
                : status == 'rejected'
                    ? 'Please contact admin for the next step.'
                    : 'No status details available.');

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.22)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
              color: color,
              fontWeight: FontWeight.w800,
              fontSize: 16,
            ),
          ),
          const SizedBox(height: 6),
          Text(message, style: const TextStyle(color: BrandColors.textMuted)),
          if (data['employee_id'] != null) ...[
            const SizedBox(height: 10),
            _InfoLine(label: 'Employee ID', value: data['employee_id'].toString()),
          ],
          if (data['registered_at'] != null)
            _InfoLine(label: 'Submitted', value: data['registered_at'].toString()),
          if (data['approved_at'] != null)
            _InfoLine(label: 'Approved', value: data['approved_at'].toString()),
          if (data['admin_notes'] != null)
            _InfoLine(label: 'Admin Note', value: data['admin_notes'].toString()),
        ],
      ),
    );
  }

  Color _statusColor(String status) {
    switch (status) {
      case 'approved':
        return const Color(0xFF159947);
      case 'pending':
      case 'review':
        return const Color(0xFFC47A11);
      case 'rejected':
      case 'error':
        return const Color(0xFFB31D18);
      default:
        return BrandColors.textMuted;
    }
  }

  String _statusTitle(String status) {
    switch (status) {
      case 'approved':
        return 'Approved';
      case 'pending':
        return 'Pending Approval';
      case 'review':
        return 'For Manual Review';
      case 'rejected':
        return 'Rejected';
      default:
        return 'Status';
    }
  }
}

// ── DATE TIME CARD ──
class _DateTimeCard extends StatefulWidget {
  @override
  State<_DateTimeCard> createState() => _DateTimeCardState();
}

class _DateTimeCardState extends State<_DateTimeCard> {
  late DateTime _now;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _now = DateTime.now();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _now = DateTime.now());
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 18),
      decoration: BoxDecoration(
        color: const Color(0xFF0D1012),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF2A2A2A)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.3),
            blurRadius: 10,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                _formatDate(_now),
                style: TextStyle(
                  color: Colors.white.withValues(alpha: 0.6),
                  fontSize: 13,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                _formatTime(_now),
                style: const TextStyle(
                  color: Color(0xFFB31D18),
                  fontSize: 28,
                  fontWeight: FontWeight.bold,
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: const Color(0xFFB31D18).withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(12),
            ),
            child: const Icon(
              Icons.access_time_rounded,
              color: Color(0xFFB31D18),
              size: 28,
            ),
          ),
        ],
      ),
    );
  }

  String _formatTime(DateTime dt) {
    final h = dt.hour > 12
        ? dt.hour - 12
        : dt.hour == 0
        ? 12
        : dt.hour;
    final m = dt.minute.toString().padLeft(2, '0');
    final s = dt.second.toString().padLeft(2, '0');
    final ampm = dt.hour >= 12 ? 'PM' : 'AM';
    return '$h:$m:$s $ampm';
  }

  String _formatDate(DateTime dt) {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
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
    return '${days[dt.weekday - 1]}, ${months[dt.month - 1]} ${dt.day}, ${dt.year}';
  }
}

// ── ACTION BUTTON ──
class _ActionButton extends StatelessWidget {
  final String label;
  final String subtitle;
  final IconData icon;
  final Gradient gradient;
  final VoidCallback onTap;

  const _ActionButton({
    required this.label,
    required this.subtitle,
    required this.icon,
    required this.gradient,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(18),
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 5, sigmaY: 5),
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  gradient.colors.first.withValues(alpha: 0.8),
                  gradient.colors.last.withValues(alpha: 0.9),
                ],
              ),
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: Colors.white.withValues(alpha: 0.1)),
              boxShadow: [
                BoxShadow(
                  color: gradient.colors.first.withValues(alpha: 0.2),
                  blurRadius: 15,
                  offset: const Offset(0, 6),
                ),
              ],
            ),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Icon(icon, color: Colors.white, size: 28),
                ),
                const SizedBox(width: 18),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        label,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 17,
                          fontWeight: FontWeight.bold,
                          letterSpacing: 0.5,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        subtitle,
                        style: TextStyle(
                          color: Colors.white.withValues(alpha: 0.6),
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
                Icon(
                  Icons.arrow_forward_ios_rounded,
                  color: Colors.white.withValues(alpha: 0.4),
                  size: 14,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
