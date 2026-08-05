import 'dart:math' as math;

import 'package:flutter/material.dart';

class BrandColors {
  static const bg = Color(0xFFF4F1EF);
  static const surface = Color(0xFFFFFFFF);
  static const border = Color(0xFFD7CBC7);
  static const cyan = Color(0xFFA03628);
  static const violet = Color(0xFF161616);
  static const text = Color(0xFF151515);
  static const textMuted = Color(0xFF5E5452);
}

class BrandLogo extends StatelessWidget {
  final double size;
  final double radius;
  final bool withFrame;
  final EdgeInsetsGeometry padding;

  const BrandLogo({
    super.key,
    this.size = 56,
    this.radius = 16,
    this.withFrame = true,
    this.padding = const EdgeInsets.all(10),
  });

  @override
  Widget build(BuildContext context) {
    final logo = ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: CustomPaint(
        size: Size.square(size),
        painter: _ShieldCameraLogoPainter(
          shieldColor: BrandColors.violet,
          accentColor: BrandColors.cyan,
          backgroundColor: BrandColors.surface,
        ),
      ),
    );

    if (!withFrame) return logo;

    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: BrandColors.surface,
        borderRadius: BorderRadius.circular(radius + 6),
        border: Border.all(color: BrandColors.border.withValues(alpha: 0.9)),
        boxShadow: [
          BoxShadow(
            color: BrandColors.cyan.withValues(alpha: 0.12),
            blurRadius: 22,
            spreadRadius: 1,
          ),
        ],
      ),
      child: logo,
    );
  }
}

class _ShieldCameraLogoPainter extends CustomPainter {
  final Color shieldColor;
  final Color accentColor;
  final Color backgroundColor;

  _ShieldCameraLogoPainter({
    required this.shieldColor,
    required this.accentColor,
    required this.backgroundColor,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final stroke = math.max(2.2, math.min(w, h) * 0.085).toDouble();

    canvas.drawRect(
      Offset.zero & size,
      Paint()..color = backgroundColor,
    );

    final shield = Path()
      ..moveTo(w * 0.50, h * 0.10)
      ..lineTo(w * 0.82, h * 0.21)
      ..lineTo(w * 0.82, h * 0.56)
      ..lineTo(w * 0.69, h * 0.81)
      ..lineTo(w * 0.50, h * 0.94)
      ..lineTo(w * 0.31, h * 0.81)
      ..lineTo(w * 0.18, h * 0.56)
      ..lineTo(w * 0.18, h * 0.21)
      ..close();

    canvas.drawPath(
      shield,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = stroke
        ..strokeJoin = StrokeJoin.round
        ..strokeCap = StrokeCap.round
        ..color = shieldColor,
    );

    canvas.save();
    canvas.translate(w * 0.50, h * 0.47);
    canvas.rotate(-0.18);

    final top = RRect.fromRectAndRadius(
      Rect.fromCenter(
        center: Offset(0, -h * 0.10),
        width: w * 0.56,
        height: h * 0.18,
      ),
      Radius.circular(math.max(4, w * 0.06).toDouble()),
    );
    canvas.drawRRect(top, Paint()..color = accentColor);

    final body = RRect.fromRectAndRadius(
      Rect.fromCenter(
        center: Offset(0, h * 0.03),
        width: w * 0.60,
        height: h * 0.16,
      ),
      Radius.circular(math.max(4, w * 0.06).toDouble()),
    );
    canvas.drawRRect(body, Paint()..color = shieldColor);

    final mount = RRect.fromRectAndRadius(
      Rect.fromCenter(
        center: Offset(w * 0.23, h * 0.07),
        width: w * 0.10,
        height: h * 0.12,
      ),
      Radius.circular(math.max(2, w * 0.03).toDouble()),
    );
    canvas.drawRRect(mount, Paint()..color = shieldColor);

    canvas.drawCircle(
      Offset(-w * 0.12, -h * 0.01),
      math.max(1.4, w * 0.018).toDouble(),
      Paint()..color = Colors.white.withValues(alpha: 0.94),
    );

    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _ShieldCameraLogoPainter oldDelegate) {
    return oldDelegate.shieldColor != shieldColor ||
        oldDelegate.accentColor != accentColor ||
        oldDelegate.backgroundColor != backgroundColor;
  }
}

class BrandMark extends StatelessWidget {
  final bool compact;
  final MainAxisAlignment alignment;
  final Color? titleColor;
  final Color? subtitleColor;

  const BrandMark({
    super.key,
    this.compact = false,
    this.alignment = MainAxisAlignment.start,
    this.titleColor,
    this.subtitleColor,
  });

  @override
  Widget build(BuildContext context) {
    final titleStyle = TextStyle(
      color: titleColor ?? BrandColors.text,
      fontSize: compact ? 15 : 18,
      fontWeight: FontWeight.w800,
      letterSpacing: compact ? 0.2 : 0.6,
      height: 1.05,
    );
    final subtitleStyle = TextStyle(
      color: subtitleColor ?? BrandColors.textMuted,
      fontSize: compact ? 11 : 12,
      fontWeight: FontWeight.w500,
      height: 1.2,
    );

    return Row(
      mainAxisAlignment: alignment,
      mainAxisSize: MainAxisSize.min,
      children: [
        BrandLogo(
          size: compact ? 34 : 48,
          radius: 12,
          padding: EdgeInsets.all(compact ? 6 : 8),
        ),
        const SizedBox(width: 12),
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('KVSK CCTV', style: titleStyle),
            Text('& IT Solutions', style: subtitleStyle),
          ],
        ),
      ],
    );
  }
}

class BrandIdentity extends StatelessWidget {
  final double width;
  final bool compact;

  const BrandIdentity({
    super.key,
    this.width = 260,
    this.compact = false,
  });

  @override
  Widget build(BuildContext context) {
    final shieldSize = compact ? 92.0 : 114.0;
    final titleSize = compact ? 24.0 : 30.0;
    final subtitleSize = compact ? 20.0 : 24.0;

    return ConstrainedBox(
      constraints: BoxConstraints(maxWidth: width),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: shieldSize,
            height: shieldSize,
            padding: EdgeInsets.all(compact ? 8 : 10),
            decoration: BoxDecoration(
              color: BrandColors.surface,
              borderRadius: BorderRadius.circular(compact ? 22 : 26),
              border: Border.all(color: BrandColors.border.withValues(alpha: 0.95)),
              boxShadow: [
                BoxShadow(
                  color: BrandColors.cyan.withValues(alpha: 0.12),
                  blurRadius: 24,
                  spreadRadius: 1,
                ),
              ],
            ),
            child: BrandLogo(
              size: shieldSize - (compact ? 16 : 20),
              radius: compact ? 18 : 20,
              withFrame: false,
              padding: EdgeInsets.zero,
            ),
          ),
          const SizedBox(height: 14),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              'KVSK CCTV',
              style: TextStyle(
                color: BrandColors.cyan,
                fontSize: titleSize,
                fontWeight: FontWeight.w900,
                fontStyle: FontStyle.italic,
                letterSpacing: 0.6,
                height: 1.0,
              ),
            ),
          ),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              '& IT SOLUTIONS',
              style: TextStyle(
                color: BrandColors.violet,
                fontSize: subtitleSize,
                fontWeight: FontWeight.w900,
                fontStyle: FontStyle.italic,
                letterSpacing: 0.9,
                height: 1.0,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

