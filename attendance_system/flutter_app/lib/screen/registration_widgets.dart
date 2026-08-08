part of 'registration_screen.dart';

class _FacePhotoField extends StatelessWidget {
  final String photoPath;
  final bool error;
  final VoidCallback onTakePhoto;
  final VoidCallback onChoosePhoto;

  const _FacePhotoField({
    required this.photoPath,
    required this.error,
    required this.onTakePhoto,
    required this.onChoosePhoto,
  });

  @override
  Widget build(BuildContext context) {
    final hasPhoto = photoPath.isNotEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              context.tr('Face Photo', 'Larawan ng Mukha'),
              style: const TextStyle(
                color: BrandColors.text,
                fontSize: 13,
                fontWeight: FontWeight.w700,
              ),
            ),
            const Text(
              ' *',
              style: TextStyle(
                color: Color(0xFFB31D18),
                fontSize: 13,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Center(
          child: InkWell(
            onTap: () => _showSourcePicker(context),
            borderRadius: BorderRadius.circular(28),
            child: Container(
              width: 168,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: BrandColors.surface,
                borderRadius: BorderRadius.circular(28),
                border: Border.all(
                  color: error && !hasPhoto
                      ? const Color(0xFFB31D18)
                      : BrandColors.border,
                  width: error && !hasPhoto ? 1.6 : 1.4,
                ),
              ),
              child: Column(
                children: [
                  Stack(
                    clipBehavior: Clip.none,
                    children: [
                      Container(
                        width: 120,
                        height: 120,
                        decoration: const BoxDecoration(
                          shape: BoxShape.circle,
                          color: BrandColors.bg,
                        ),
                        clipBehavior: Clip.antiAlias,
                        child: hasPhoto
                            ? Image.file(
                                File(photoPath),
                                fit: BoxFit.cover,
                                errorBuilder: (_, _, _) => _photoPlaceholder(),
                              )
                            : _photoPlaceholder(),
                      ),
                      Positioned(
                        right: 0,
                        bottom: 0,
                        child: Container(
                          width: 38,
                          height: 38,
                          decoration: const BoxDecoration(
                            shape: BoxShape.circle,
                            color: BrandColors.cyan,
                          ),
                          child: Icon(
                            hasPhoto
                                ? Icons.edit_rounded
                                : Icons.photo_camera_rounded,
                            size: 19,
                            color: Colors.white,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Text(
                    hasPhoto
                        ? context.tr('Tap to change photo', 'I-tap para palitan ang larawan')
                        : context.tr('Tap to add face photo', 'I-tap para magdagdag ng larawan ng mukha'),
                    style: const TextStyle(
                      color: BrandColors.cyan,
                      fontSize: 13,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          context.tr(
            'Take a clear photo of your face so the admin can identify you when approving your registration.',
            'Kumuha ng malinaw na larawan ng iyong mukha upang makilala ka ng admin sa pag-apruba ng iyong rehistrasyon.',
          ),
          textAlign: TextAlign.center,
          style: const TextStyle(
            color: BrandColors.textMuted,
            fontSize: 12,
            height: 1.4,
            fontWeight: FontWeight.w600,
          ),
        ),
        if (error && !hasPhoto) ...[
          const SizedBox(height: 8),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(
                Icons.error_rounded,
                size: 15,
                color: Color(0xFFB31D18),
              ),
              const SizedBox(width: 5),
              Text(
                context.tr(
                  'A face photo is required.',
                  'Kinakailangan ang larawan ng mukha.',
                ),
                style: const TextStyle(
                  color: Color(0xFFB31D18),
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ],
      ],
    );
  }

  Future<void> _showSourcePicker(BuildContext context) async {
    final result = await showModalBottomSheet<_PhotoSource>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (sheetContext) => Container(
        margin: const EdgeInsets.symmetric(horizontal: 12),
        decoration: const BoxDecoration(
          color: BrandColors.surface,
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
        child: SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(height: 10),
              Container(
                width: 44,
                height: 4,
                decoration: BoxDecoration(
                  color: BrandColors.border,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(height: 12),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Text(
                  context.tr(
                    'Choose a face photo',
                    'Pumili ng larawan ng mukha',
                  ),
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: BrandColors.text,
                    fontSize: 16,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              const SizedBox(height: 12),
              ListTile(
                leading: const CircleAvatar(
                  radius: 22,
                  backgroundColor: Color(0x14A03628),
                  child: Icon(
                    Icons.photo_camera_rounded,
                    color: BrandColors.cyan,
                    size: 22,
                  ),
                ),
                title: Text(
                  context.tr('Take a selfie', 'Kumuha ng selfie'),
                  style: const TextStyle(
                    color: BrandColors.text,
                    fontSize: 14.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                subtitle: Text(
                  context.tr('Open the camera', 'Buksan ang camera'),
                  style: const TextStyle(
                    color: BrandColors.textMuted,
                    fontSize: 12,
                  ),
                ),
                onTap: () => Navigator.pop(sheetContext, _PhotoSource.camera),
              ),
              ListTile(
                leading: const CircleAvatar(
                  radius: 22,
                  backgroundColor: Color(0x14A03628),
                  child: Icon(
                    Icons.photo_library_rounded,
                    color: BrandColors.cyan,
                    size: 22,
                  ),
                ),
                title: Text(
                  context.tr('Choose from gallery', 'Pumili mula sa gallery'),
                  style: const TextStyle(
                    color: BrandColors.text,
                    fontSize: 14.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                subtitle: Text(
                  context.tr('Pick an existing photo', 'Pumili ng umiiral na larawan'),
                  style: const TextStyle(
                    color: BrandColors.textMuted,
                    fontSize: 12,
                  ),
                ),
                onTap: () => Navigator.pop(sheetContext, _PhotoSource.gallery),
              ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
    );
    switch (result) {
      case _PhotoSource.camera:
        onTakePhoto();
      case _PhotoSource.gallery:
        onChoosePhoto();
      case null:
        break;
    }
  }

  Widget _photoPlaceholder() {
    return const Center(
      child: Icon(
        Icons.person_rounded,
        size: 48,
        color: BrandColors.textMuted,
      ),
    );
  }
}

enum _PhotoSource { camera, gallery }

class _GovIdInputFormatter extends TextInputFormatter {
  final List<int> segmentLengths;
  const _GovIdInputFormatter(this.segmentLengths);

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final digits = newValue.text.replaceAll(RegExp(r'[^0-9]'), '');
    final buffer = StringBuffer();
    var index = 0;
    for (var i = 0; i < segmentLengths.length && index < digits.length; i++) {
      final segLen = segmentLengths[i];
      final end = (index + segLen).clamp(0, digits.length);
      buffer.write(digits.substring(index, end));
      index = end;
      if (index < digits.length && i < segmentLengths.length - 1) {
        buffer.write('-');
      }
    }
    final formatted = buffer.toString();

    final typedDigits = newValue.text
        .substring(0, newValue.selection.baseOffset.clamp(0, newValue.text.length))
        .replaceAll(RegExp(r'[^0-9]'), '')
        .length;
    var seen = 0;
    var cursor = formatted.length;
    for (var i = 0; i < formatted.length; i++) {
      final isDigit = formatted.codeUnitAt(i) >= 48 && formatted.codeUnitAt(i) <= 57;
      if (isDigit) {
        if (seen == typedDigits) {
          cursor = i;
          break;
        }
        seen++;
      }
    }

    return TextEditingValue(
      text: formatted,
      selection: TextSelection.collapsed(offset: cursor),
    );
  }
}


class _ResponsiveFormPair extends StatelessWidget {
  final Widget first;
  final Widget second;

  const _ResponsiveFormPair({required this.first, required this.second});

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < 620) {
          return Column(
            children: [first, const SizedBox(height: 14), second],
          );
        }
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: first),
            const SizedBox(width: 14),
            Expanded(child: second),
          ],
        );
      },
    );
  }
}

class _ResponsiveGovIdGrid extends StatelessWidget {
  final Widget first;
  final Widget second;
  final Widget third;
  final Widget fourth;

  const _ResponsiveGovIdGrid({
    required this.first,
    required this.second,
    required this.third,
    required this.fourth,
  });

  @override
  Widget build(BuildContext context) {
    const gap = SizedBox(height: 14);
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < 620) {
          return Column(
            children: [first, gap, second, gap, third, gap, fourth],
          );
        }

        return Column(
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: first),
                const SizedBox(width: 14),
                Expanded(child: second),
              ],
            ),
            gap,
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: third),
                const SizedBox(width: 14),
                Expanded(child: fourth),
              ],
            ),
          ],
        );
      },
    );
  }
}

class _AppField extends StatelessWidget {
  final TextEditingController ctrl;
  final String label;
  final String hint;
  final IconData icon;
  final bool required;
  final TextInputType keyboardType;
  final bool obscureText;
  final Widget? prefixWidget;
  final Widget? suffixWidget;
  final List<TextInputFormatter>? inputFormatters;
  final TextInputAction? textInputAction;
  final List<String>? autofillHints;
  final TextCapitalization textCapitalization;
  final String? Function(String?)? validator;

  const _AppField({
    required this.ctrl,
    required this.label,
    required this.hint,
    required this.icon,
    required this.required,
    this.keyboardType = TextInputType.text,
    this.obscureText = false,
    this.prefixWidget,
    this.suffixWidget,
    this.inputFormatters,
    this.textInputAction,
    this.autofillHints,
    this.textCapitalization = TextCapitalization.none,
    this.validator,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              label,
              style: const TextStyle(
                color: BrandColors.text,
                fontSize: 13,
                fontWeight: FontWeight.w700,
              ),
            ),
            if (required)
              const Text(
                ' *',
                style: TextStyle(
                  color: Color(0xFFB31D18),
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                ),
              ),
          ],
        ),
        const SizedBox(height: 8),
        TextFormField(
          controller: ctrl,
          keyboardType: keyboardType,
          textInputAction: textInputAction,
          autofillHints: autofillHints,
          textCapitalization: textCapitalization,
          obscureText: obscureText,
          enableSuggestions: !obscureText,
          autocorrect: !obscureText,
          inputFormatters: inputFormatters,
          style: const TextStyle(color: BrandColors.text, fontSize: 15),
          cursorColor: BrandColors.cyan,
          validator: validator,
          autovalidateMode: AutovalidateMode.onUserInteraction,
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: const TextStyle(
              color: BrandColors.textMuted,
              fontSize: 14,
            ),
            prefixIcon: Icon(icon, color: BrandColors.cyan, size: 20),
            prefixIconConstraints: const BoxConstraints(
              minWidth: 50,
              minHeight: 48,
            ),
            prefix: prefixWidget,
            suffixIcon: suffixWidget,
            filled: true,
            fillColor: BrandColors.surface,
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 16,
              vertical: 16,
            ),
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

class _NoticeBox extends StatelessWidget {
  final String title;
  final String message;
  final IconData icon;
  final Color accentColor;

  const _NoticeBox({
    required this.title,
    required this.message,
    required this.icon,
    required this.accentColor,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.96),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: accentColor.withValues(alpha: 0.22)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.08),
            blurRadius: 18,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: accentColor.withValues(alpha: 0.14),
            ),
            child: Icon(icon, color: accentColor, size: 20),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    color: accentColor,
                    fontSize: 13,
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  message,
                  style: const TextStyle(
                    color: BrandColors.textMuted,
                    fontSize: 12,
                    height: 1.35,
                    fontWeight: FontWeight.w600,
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
