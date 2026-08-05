import 'package:flutter/material.dart';

import 'brand_logo.dart';

class ResultDialogDetail {
  final IconData icon;
  final String label;
  final String value;
  final Color? valueColor;

  const ResultDialogDetail({
    required this.icon,
    required this.label,
    required this.value,
    this.valueColor,
  });
}

class ResultDialog {
  static Future<void> show(
    BuildContext context, {
    required String title,
    required String message,
    required Color accentColor,
    required IconData icon,
    required String buttonText,
    required VoidCallback onConfirm,
    List<ResultDialogDetail> details = const [],
    Color? iconForeground,
  }) {
    return showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => Dialog(
        backgroundColor: Colors.transparent,
        child: Container(
          padding: const EdgeInsets.all(28),
          decoration: BoxDecoration(
            color: BrandColors.surface,
            borderRadius: BorderRadius.circular(24),
            border: Border.all(color: accentColor.withValues(alpha: 0.35)),
            boxShadow: [
              BoxShadow(
                color: accentColor.withValues(alpha: 0.16),
                blurRadius: 30,
                spreadRadius: 5,
              ),
            ],
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 80,
                height: 80,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: LinearGradient(
                    colors: [
                      accentColor,
                      Color.lerp(accentColor, Colors.black, 0.38) ?? accentColor,
                    ],
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: accentColor.withValues(alpha: 0.35),
                      blurRadius: 20,
                    ),
                  ],
                ),
                child: Icon(
                  icon,
                  color: iconForeground ?? Colors.white,
                  size: 38,
                ),
              ),
              const SizedBox(height: 16),
              Text(
                title,
                style: TextStyle(
                  color: accentColor,
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                message,
                style: const TextStyle(
                  color: BrandColors.textMuted,
                  fontSize: 14,
                ),
                textAlign: TextAlign.center,
              ),
              if (details.isNotEmpty) ...[
                const SizedBox(height: 16),
                ...details.map(
                  (detail) => Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: _DetailRow(detail: detail),
                  ),
                ),
              ],
              const SizedBox(height: 24),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: () {
                    Navigator.of(dialogContext, rootNavigator: true).pop();
                    onConfirm();
                  },
                  style: ElevatedButton.styleFrom(
                    backgroundColor: accentColor,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  child: Text(
                    buttonText,
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  final ResultDialogDetail detail;

  const _DetailRow({required this.detail});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: const Color(0xFFF8FAFC),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: BrandColors.border),
      ),
      child: Row(
        children: [
          Icon(detail.icon, color: BrandColors.cyan, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              detail.label,
              style: const TextStyle(
                color: BrandColors.textMuted,
                fontSize: 12,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Flexible(
            child: Text(
              detail.value,
              textAlign: TextAlign.right,
              style: TextStyle(
                color: detail.valueColor ?? BrandColors.text,
                fontSize: 13,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
