import 'package:flutter/material.dart';
import 'dart:ui';
import 'package:flutter/services.dart';
import 'dart:async';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'screen/employee_login_screen.dart';
import 'screen/registration_screen.dart';
import 'constants.dart';
import 'services/api_client.dart';
import 'services/app_locale.dart';
import 'services/app_lock_service.dart';
import 'services/app_settings.dart';
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
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<AppLocale>(
          create: (_) => AppLocale()..load(),
        ),
        ChangeNotifierProvider<AppLockService>(
          create: (_) => AppLockService()..load(),
        ),
        ChangeNotifierProvider<AppSettings>(
          create: (_) => AppSettings()..load(),
        ),
      ],
      child: Consumer<AppSettings>(
        builder: (context, settings, _) {
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
            builder: (context, child) {
              final system = MediaQuery.textScalerOf(context);
              final scaled = TextScaler.linear(
                settings.textScaleFactor * system.scale(1.0),
              );
              return MediaQuery(
                data: MediaQuery.of(context).copyWith(
                  textScaler: scaled.clamp(
                    minScaleFactor: 0.85,
                    maxScaleFactor: 1.3,
                  ),
                ),
                child: child!,
              );
            },
            home: const HomeScreen(),
          );
        },
      ),
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
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _checkForAppUpdate();
      _maybeShowTutorial();
    });
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
      final locale = context.appLocale;
      await showDialog<void>(
        context: context,
        barrierDismissible: !required,
        builder: (dialogContext) {
          return PopScope(
            canPop: !required,
            child: AlertDialog(
              title: Text(
                required
                    ? locale.t('Update required', 'Kinakailangan ang Update')
                    : locale.t('Update available', 'May available na Update'),
              ),
              content: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('${locale.t('Current', 'Kasalukuyan')}: ${AppConstants.appVersion}'),
                  Text('${locale.t('Latest', 'Pinakabago')}: ${info.latestVersion}'),
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
                    child: Text(locale.t('Later', 'Mamaya')),
                  ),
                FilledButton(
                  onPressed: info.apkUrl.trim().isEmpty
                      ? null
                      : () => AppUpdateService.openUpdateUrl(info.apkUrl),
                  child: Text(locale.t('Update', 'I-update')),
                ),
              ],
            ),
          );
        },
      );
    } catch (_) {}
  }

  Future<void> _maybeShowTutorial() async {
    const prefKey = 'app_tutorial_seen_v1';
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(prefKey) ?? false) return;
    await prefs.setBool(prefKey, true);
    if (!mounted) return;
    _showTutorial();
  }

  void _showTutorial() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: BrandColors.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      builder: (sheetContext) {
        final locale = sheetContext.appLocale;
        return SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 24, 24, 28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Text(
                      locale.t('Quick Guide', 'Mabilis na Gabay'),
                      style: const TextStyle(
                        color: BrandColors.text,
                        fontSize: 20,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const Spacer(),
                    IconButton(
                      onPressed: () => Navigator.of(sheetContext).pop(),
                      icon: const Icon(
                        Icons.close_rounded,
                        color: BrandColors.textMuted,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                _TutorialStep(
                  icon: Icons.person_add_alt_1_rounded,
                  title: locale.t(
                    'Register or sign in',
                    'Mag-register o mag-sign in',
                  ),
                  subtitle: locale.t(
                    'Tap "Register Employee" for a new account, or "Employee Login" if your account is already approved.',
                    'Pindutin ang "Register Employee" para sa bagong account, o "Employee Login" kung naaprubahan na ang account mo.',
                  ),
                ),
                const SizedBox(height: 14),
                _TutorialStep(
                  icon: Icons.wifi_rounded,
                  title: locale.t(
                    'Online / Offline indicator',
                    'Indicator ng Online / Offline',
                  ),
                  subtitle: locale.t(
                    'Green means the app is connected to the server. Red means you are offline.',
                    'Berde ang ibig sabihin konektado ang app sa server. Pula ang ibig sabihin offline ka.',
                  ),
                ),
                const SizedBox(height: 14),
                _TutorialStep(
                  icon: Icons.fingerprint_rounded,
                  title: locale.t(
                    'Fingerprint stays private',
                    'Pribado ang fingerprint',
                  ),
                  subtitle: locale.t(
                    'Fingerprints are only used on your phone. They are never uploaded to the server.',
                    'Ang fingerprint ay ginagamit lang sa iyong telepono. Hindi ito ina-upload sa server.',
                  ),
                ),
                const SizedBox(height: 14),
                _TutorialStep(
                  icon: Icons.language_rounded,
                  title: locale.t(
                    'Switch language',
                    'Palitan ang wika',
                  ),
                  subtitle: locale.t(
                    'Use the menu button at the top to switch between English and Filipino.',
                    'Gamitin ang menu button sa taas para lumipat sa English o Filipino.',
                  ),
                ),
                const SizedBox(height: 22),
                SizedBox(
                  height: 52,
                  child: ElevatedButton(
                    onPressed: () => Navigator.of(sheetContext).pop(),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: BrandColors.cyan,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14),
                      ),
                    ),
                    child: Text(
                      locale.t('Got it', 'Sige, gets ko'),
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  void _openSettingsSheet() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: BrandColors.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      builder: (sheetContext) {
        return SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 24, 24, 28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  sheetContext.tr('Settings', 'Mga Setting'),
                  style: const TextStyle(
                    color: BrandColors.text,
                    fontSize: 20,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 18),
                Text(
                  sheetContext.tr('Language', 'Wika'),
                  style: const TextStyle(
                    color: BrandColors.text,
                    fontSize: 14,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 8),
                Consumer<AppLocale>(
                  builder: (context, locale, _) {
                    return SegmentedButton<String>(
                      segments: const [
                        ButtonSegment(
                          value: 'en',
                          label: Text('English'),
                        ),
                        ButtonSegment(
                          value: 'tl',
                          label: Text('Filipino'),
                        ),
                      ],
                      selected: {locale.language},
                      onSelectionChanged: (selection) {
                        locale.setLanguage(selection.first);
                      },
                    );
                  },
                ),
                const SizedBox(height: 20),
                Text(
                  sheetContext.tr('Text Size', 'Laki ng Letra'),
                  style: const TextStyle(
                    color: BrandColors.text,
                    fontSize: 14,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 8),
                Consumer<AppSettings>(
                  builder: (context, settings, _) {
                    return SegmentedButton<AppTextScale>(
                      segments: [
                        ButtonSegment(
                          value: AppTextScale.small,
                          label: Text(sheetContext.tr('Small', 'Maliit')),
                        ),
                        ButtonSegment(
                          value: AppTextScale.normal,
                          label: Text(sheetContext.tr('Normal', 'Normal')),
                        ),
                        ButtonSegment(
                          value: AppTextScale.large,
                          label: Text(sheetContext.tr('Large', 'Malaki')),
                        ),
                      ],
                      selected: {settings.textScale},
                      onSelectionChanged: (selection) {
                        settings.setTextScale(selection.first);
                      },
                    );
                  },
                ),
                const SizedBox(height: 22),
                SizedBox(
                  height: 52,
                  child: OutlinedButton.icon(
                    onPressed: () {
                      Navigator.of(sheetContext).pop();
                      _showTutorial();
                    },
                    style: OutlinedButton.styleFrom(
                      foregroundColor: BrandColors.cyan,
                      side: const BorderSide(color: BrandColors.cyan),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14),
                      ),
                    ),
                    icon: const Icon(Icons.help_rounded),
                    label: Text(
                      sheetContext.tr('Show Quick Guide', 'Ipakita ang Gabay'),
                      style: const TextStyle(fontWeight: FontWeight.w800),
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
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
    final locale = context.watch<AppLocale>();
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
                                  _getGreeting(locale),
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
                            Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Container(
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
                                    mainAxisSize: MainAxisSize.min,
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
                                        _isServerOnline
                                            ? locale.t('Online', 'Online')
                                            : locale.t('Offline', 'Offline'),
                                        style: TextStyle(
                                          color: _isServerOnline
                                              ? const Color(0xFF00E676)
                                              : Colors.red,
                                          fontSize: 12,
                                          fontWeight: FontWeight.w600,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(width: 6),
                                IconButton(
                                  onPressed: _openSettingsSheet,
                                  tooltip: 'Settings',
                                  icon: const Icon(
                                    Icons.settings_rounded,
                                    color: BrandColors.textMuted,
                                  ),
                                ),
                              ],
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

                        Text(
                          locale.t(
                            'Attendance Monitoring',
                            'Pagmomonitor ng Attendance',
                          ),
                          style: const TextStyle(
                            color: Color(0xFF111111),
                            fontSize: 26,
                            fontWeight: FontWeight.bold,
                            letterSpacing: 0.5,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          locale.t(
                            'Secure & Fast Attendance Tracking',
                            'Mabilis at Ligtas na Pagtala ng Attendance',
                          ),
                          style: TextStyle(
                            color: BrandColors.textMuted,
                            fontSize: 14,
                          ),
                        ),

                        const SizedBox(height: 48),

                        // â”€â”€ DATE & TIME â”€â”€
                        _DateTimeCard(),

                        const SizedBox(height: 32),

                        // â”€â”€ BUTTONS â”€â”€
                        _ActionButton(
                          label: locale.t(
                            'Register Employee',
                            'Mag-register ng Empleyado',
                          ),
                          subtitle: locale.t(
                            'New employee registration',
                            'Para sa bagong empleyado',
                          ),
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
                          label: locale.t(
                            'Employee Login',
                            'Login ng Empleyado',
                          ),
                          subtitle: locale.t(
                            'Approved account access',
                            'Para sa naaprubahang account',
                          ),
                          icon: Icons.person_rounded,
                          gradient: const LinearGradient(
                            colors: [Color(0xFF1E1E1E), Color(0xFF0F0F0F)],
                          ),
                          onTap: () => Navigator.push(
                            context,
                            _slideRoute(const EmployeeLoginScreen()),
                          ),
                        ),

                        const Spacer(),

                        // â”€â”€ FOOTER â”€â”€
                        Padding(
                          padding: const EdgeInsets.only(top: 24, bottom: 12),
                          child: Text(
                            locale.t(
                              'Powered by KVSK CCTV & IT Solutions',
                              'Pinatatakbo ng KVSK CCTV & IT Solutions',
                            ),
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

  String _getGreeting(AppLocale locale) {
    final hour = DateTime.now().hour;
    if (hour < 12) return locale.t('Good Morning', 'Magandang Umaga');
    if (hour < 17) return locale.t('Good Afternoon', 'Magandang Hapon');
    return locale.t('Good Evening', 'Magandang Gabi');
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

// â”€â”€ DATE TIME CARD â”€â”€
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

// â”€â”€ ACTION BUTTON â”€â”€
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

class _TutorialStep extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;

  const _TutorialStep({
    required this.icon,
    required this.title,
    required this.subtitle,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: BrandColors.bg,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: BrandColors.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: BrandColors.cyan.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(icon, color: BrandColors.cyan, size: 22),
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
                const SizedBox(height: 3),
                Text(
                  subtitle,
                  style: const TextStyle(
                    color: BrandColors.textMuted,
                    fontSize: 12.5,
                    height: 1.35,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
