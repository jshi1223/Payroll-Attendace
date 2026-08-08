import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../services/app_locale.dart';
import '../services/notification_settings.dart';
import '../widgets/brand_logo.dart';
import '../widgets/empty_state.dart';

class EmployeeNotificationsScreen extends StatefulWidget {
  final String token;
  final void Function(String? period) onOpenPayroll;
  final VoidCallback onChanged;

  const EmployeeNotificationsScreen({
    super.key,
    required this.token,
    required this.onOpenPayroll,
    required this.onChanged,
  });

  @override
  State<EmployeeNotificationsScreen> createState() =>
      _EmployeeNotificationsScreenState();
}

class _EmployeeNotificationsScreenState extends State<EmployeeNotificationsScreen> {
  bool _loading = true;
  bool _markingRead = false;
  String? _error;
  List<Map<String, dynamic>> _announcements = const [];
  List<Map<String, dynamic>> _notifications = const [];

  @override
  void initState() {
    super.initState();
    unawaited(NotificationSettings.snapshot());
    _load();
  }

  Future<void> _load() async {
    if (widget.token.isEmpty) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final res = await ApiClient.get(
        '/employee/notifications',
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (!mounted) return;
      final body = ApiClient.jsonObject(res.body);
      setState(() {
        _announcements = _asList(body?['announcements']);
        _notifications = _asList(body?['notifications']);
      });
      final hasUnread = _notifications.any((n) => n['is_read'] == false);
      if (hasUnread && !_markingRead) {
        _markingRead = true;
        unawaited(_markAllRead());
      }
    } catch (e) {
      if (mounted) {
        setState(() => _error = ApiClient.friendlyNetworkError(e));
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  List<Map<String, dynamic>> _asList(dynamic value) {
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
  }

  Future<void> _markAllRead() async {
    try {
      await ApiClient.postJson(
        '/employee/notifications/read',
        body: const {},
        headers: {'Authorization': 'Bearer ${widget.token}'},
      );
      if (!mounted) return;
      setState(() {
        for (final n in _notifications) {
          n['is_read'] = true;
        }
      });
      widget.onChanged();
    } catch (_) {
      // keep local state as-is; not critical
    } finally {
      _markingRead = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: BrandColors.bg,
      appBar: AppBar(
        backgroundColor: BrandColors.surface,
        elevation: 0,
        toolbarHeight: 72,
        leading: IconButton(
          icon: const Icon(
            Icons.arrow_back_ios_new_rounded,
            color: BrandColors.text,
            size: 20,
          ),
          onPressed: () => Navigator.pop(context),
        ),
        title: Text(
          context.tr('Notifications', 'Mga Notifikasyon'),
          style: const TextStyle(
            color: BrandColors.text,
            fontSize: 18,
            fontWeight: FontWeight.w800,
          ),
        ),
        actions: [
          IconButton(
            tooltip: context.tr('Notification settings', 'Mga setting ng notifikasyon'),
            icon: const Icon(
              Icons.tune_rounded,
              color: BrandColors.textMuted,
              size: 22,
            ),
            onPressed: () => _showSettings(),
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(height: 1, color: BrandColors.border),
        ),
      ),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _load,
          child: _buildBody(context),
        ),
      ),
    );
  }

  List<Map<String, dynamic>> get _visibleAnnouncements =>
      _announcements.where((a) {
        final type = a['type']?.toString() ?? 'announcement';
        return NotificationSettings.isEnabled(type);
      }).toList();

  List<Map<String, dynamic>> get _visibleNotifications =>
      _notifications.where((n) {
        final type = n['type']?.toString() ?? '';
        return NotificationSettings.isEnabled(type);
      }).toList();

  Widget _buildBody(BuildContext context) {
    final visibleAnnouncements = _visibleAnnouncements;
    final visibleNotifications = _visibleNotifications;
    if (_loading && _announcements.isEmpty && _notifications.isEmpty) {
      return const Center(
        child: CircularProgressIndicator(color: BrandColors.cyan),
      );
    }
    if (visibleAnnouncements.isEmpty && visibleNotifications.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          _error != null
              ? Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    children: [
                      Text(
                        _error!,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          color: BrandColors.textMuted,
                          fontSize: 13,
                        ),
                      ),
                      const SizedBox(height: 16),
                      OutlinedButton.icon(
                        onPressed: _load,
                        icon: const Icon(Icons.refresh_rounded, size: 18),
                        label: Text(context.tr('Retry', 'Subukan ulit')),
                      ),
                    ],
                  ),
                )
              : const Padding(
                  padding: EdgeInsets.only(top: 120),
                  child: EmptyState(
                    icon: Icons.notifications_off_rounded,
                    title: 'No notifications yet',
                    subtitle: 'Announcements and payroll updates will appear here.',
                  ),
                ),
        ],
      );
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: [
        if (visibleAnnouncements.isNotEmpty) ...[
          _sectionHeader(
            context,
            context.tr('Announcements', 'Mga Anunsyo'),
            Icons.campaign_rounded,
          ),
          ...visibleAnnouncements.map((a) => _announcementTile(context, a)),
          const SizedBox(height: 20),
        ],
        if (visibleNotifications.isNotEmpty) ...[
          _sectionHeader(
            context,
            context.tr('Your updates', 'Iyong mga update'),
            Icons.notifications_active_rounded,
          ),
          ...visibleNotifications.map((n) => _notificationTile(context, n)),
        ],
      ],
    );
  }

  Widget _sectionHeader(BuildContext context, String title, IconData icon) {
    return Padding(
      padding: const EdgeInsets.only(left: 4, bottom: 8),
      child: Row(
        children: [
          Icon(icon, color: BrandColors.cyan, size: 17),
          const SizedBox(width: 6),
          Text(
            title,
            style: const TextStyle(
              color: BrandColors.text,
              fontSize: 14,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }

  String _shortDate(String? raw) {
    if (raw == null || raw.isEmpty) return '';
    // created_at is "YYYY-MM-DDTHH:MM:SS" in Asia/Manila
    final parts = raw.split('T');
    final date = parts.isNotEmpty ? parts[0] : raw;
    final time = parts.length > 1 ? parts[1] : '';
    final label = time.isNotEmpty
        ? '$date  ${time.substring(0, time.length >= 5 ? 5 : time.length)}'
        : date;
    return label;
  }

  Widget _announcementTile(BuildContext context, Map<String, dynamic> item) {
    final title = item['title']?.toString() ?? '';
    final body = item['body']?.toString() ?? '';
    final created = item['created_at']?.toString() ?? '';
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: BrandColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: BrandColors.border.withValues(alpha: 0.8)),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () => _showFull(context, title, body),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  color: BrandColors.cyan.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(11),
                ),
                child: const Icon(
                  Icons.campaign_rounded,
                  color: BrandColors.cyan,
                  size: 20,
                ),
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
                    if (body.isNotEmpty) ...[
                      const SizedBox(height: 3),
                      Text(
                        body,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: BrandColors.textMuted,
                          fontSize: 12.5,
                          height: 1.35,
                        ),
                      ),
                    ],
                    if (created.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Text(
                        _shortDate(created),
                        style: const TextStyle(
                          color: BrandColors.textMuted,
                          fontSize: 11,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _notificationTile(BuildContext context, Map<String, dynamic> item) {
    final type = item['type']?.toString() ?? '';
    final title = item['title']?.toString() ?? '';
    final body = item['body']?.toString() ?? '';
    final created = item['created_at']?.toString() ?? '';
    final isRead = item['is_read'] == true;
    final payrollRelated = const [
      'payslip_ready',
      'payslip_unlocked',
      'payslip_approved',
      'payslip_rejected',
      'payroll_accepted',
      'salary_paid',
      'bale_payment',
      'extra_pay_added',
      'payday_reminder',
      'ca_overdue_reminder',
    ].contains(type);
    final icon = _iconForType(type);
    final period = _dataFor(item)['period']?.toString();

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: BrandColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: isRead
              ? BrandColors.border.withValues(alpha: 0.7)
              : BrandColors.cyan.withValues(alpha: 0.55),
        ),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: payrollRelated
            ? () {
                Navigator.of(context).pop();
                widget.onOpenPayroll(period);
              }
            : () => _showFull(context, title, body),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  color: BrandColors.cyan.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(11),
                ),
                child: Icon(icon, color: BrandColors.cyan, size: 20),
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
                            title,
                            style: TextStyle(
                              color: BrandColors.text,
                              fontSize: 14,
                              fontWeight:
                                  isRead ? FontWeight.w700 : FontWeight.w900,
                            ),
                          ),
                        ),
                        if (!isRead) ...[
                          const SizedBox(width: 8),
                          Container(
                            width: 8,
                            height: 8,
                            decoration: const BoxDecoration(
                              color: BrandColors.cyan,
                              shape: BoxShape.circle,
                            ),
                          ),
                        ],
                      ],
                    ),
                    if (body.isNotEmpty) ...[
                      const SizedBox(height: 3),
                      Text(
                        body,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: BrandColors.textMuted,
                          fontSize: 12.5,
                          height: 1.35,
                        ),
                      ),
                    ],
                    if (created.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Text(
                        _shortDate(created),
                        style: const TextStyle(
                          color: BrandColors.textMuted,
                          fontSize: 11,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  IconData _iconForType(String type) {
    switch (type) {
      case 'payslip_ready':
      case 'payslip_unlocked':
      case 'payslip_approved':
      case 'payroll_accepted':
        return Icons.receipt_long_rounded;
      case 'payslip_rejected':
        return Icons.receipt_rounded;
      case 'salary_paid':
        return Icons.payments_rounded;
      case 'cash_advance_approved':
        return Icons.check_circle_rounded;
      case 'cash_advance_rejected':
        return Icons.cancel_rounded;
      case 'bale_payment':
        return Icons.savings_rounded;
      case 'extra_pay_added':
        return Icons.add_card_rounded;
      case 'payday_reminder':
        return Icons.event_available_rounded;
      case 'ca_overdue_reminder':
        return Icons.warning_amber_rounded;
      default:
        return Icons.notifications_rounded;
    }
  }

  Map<String, dynamic> _dataFor(Map<String, dynamic> item) {
    final data = item['data'];
    if (data is Map) {
      return data.map(
        (k, v) => MapEntry(k.toString(), v),
      );
    }
    if (data is String && data.isNotEmpty) {
      try {
        final decoded = jsonDecode(data);
        if (decoded is Map) {
          return decoded.map(
            (k, v) => MapEntry(k.toString(), v),
          );
        }
      } catch (_) {}
    }
    return const {};
  }

  void _showSettings() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: BrandColors.surface,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      builder: (sheetContext) {
        return SafeArea(
          child: StatefulBuilder(
            builder: (sheetContext, setSheetState) {
              return SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(20, 24, 20, 32),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            context.tr(
                              'Notification settings',
                              'Mga setting ng notifikasyon',
                            ),
                            style: const TextStyle(
                              color: BrandColors.text,
                              fontSize: 18,
                              fontWeight: FontWeight.w900,
                            ),
                          ),
                        ),
                        IconButton(
                          onPressed: () => Navigator.of(sheetContext).pop(),
                          icon: const Icon(
                            Icons.close_rounded,
                            color: BrandColors.textMuted,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      context.tr(
                        'Choose which notifications you want to see.',
                        'Piliin kung anong mga notifikasyon ang gusto mong makita.',
                      ),
                      style: const TextStyle(
                        color: BrandColors.textMuted,
                        fontSize: 13,
                        height: 1.4,
                      ),
                    ),
                    const SizedBox(height: 16),
                    for (final category in NotificationSettings.allCategories) ...[
                      SwitchListTile(
                        value: NotificationSettings.isCategoryEnabled(category),
                        activeTrackColor: BrandColors.cyan,
                        contentPadding: EdgeInsets.zero,
                        onChanged: (value) async {
                          await NotificationSettings.setCategoryEnabled(
                            category,
                            value,
                          );
                          setSheetState(() {});
                          setState(() {});
                        },
                        title: Text(
                          context.tr(
                            NotificationSettings.categoryLabelsEn[category] ?? category,
                            NotificationSettings.categoryLabelsFil[category] ?? category,
                          ),
                          style: const TextStyle(
                            color: BrandColors.text,
                            fontSize: 14,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                      const Divider(height: 1, color: BrandColors.border),
                    ],
                  ],
                ),
              );
            },
          ),
        );
      },
    );
  }

  void _showFull(BuildContext context, String title, String body) {
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
            padding: const EdgeInsets.fromLTRB(24, 24, 24, 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        title,
                        style: const TextStyle(
                          color: BrandColors.text,
                          fontSize: 18,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ),
                    IconButton(
                      onPressed: () => Navigator.of(sheetContext).pop(),
                      icon: const Icon(
                        Icons.close_rounded,
                        color: BrandColors.textMuted,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  body.isEmpty ? '—' : body,
                  style: const TextStyle(
                    color: BrandColors.textMuted,
                    fontSize: 14,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}
