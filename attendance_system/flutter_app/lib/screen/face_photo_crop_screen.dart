import 'dart:io';
import 'dart:typed_data';

import 'package:crop_your_image/crop_your_image.dart';
import 'package:flutter/material.dart';

import '../services/app_locale.dart';
import '../widgets/brand_logo.dart';

class FacePhotoCropScreen extends StatefulWidget {
  final String imagePath;
  const FacePhotoCropScreen({super.key, required this.imagePath});

  @override
  State<FacePhotoCropScreen> createState() => _FacePhotoCropScreenState();
}

class _FacePhotoCropScreenState extends State<FacePhotoCropScreen> {
  final CropController _controller = CropController();
  Uint8List? _imageBytes;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadImage();
  }

  Future<void> _loadImage() async {
    try {
      final bytes = await File(widget.imagePath).readAsBytes();
      if (!mounted) return;
      setState(() => _imageBytes = bytes);
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = 'Could not load the selected image.');
    }
  }

  Future<void> _cropAndSave() async {
    _controller.crop();
  }

  Future<void> _onCropped(CropResult result) async {
    switch (result) {
      case CropSuccess(:final croppedImage):
        try {
          final tempFile = File(
            '${Directory.systemTemp.path}/face_photo_${DateTime.now().millisecondsSinceEpoch}.jpg',
          );
          await tempFile.writeAsBytes(croppedImage, flush: true);
          if (!mounted) return;
          Navigator.of(context).pop(tempFile.path);
        } catch (_) {
          if (!mounted) return;
          _showError(context.tr(
            'Failed to save the cropped photo. Please try again.',
            'Hindi nai-save ang na-crop na larawan. Subukan muli.',
          ));
        }
      case CropFailure():
        if (!mounted) return;
        _showError(context.tr(
          'Cropping failed. Please try again.',
          'Hindi nagtagumpay ang pag-crop. Subukan muli.',
        ));
    }
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: const Color(0xFFB31D18),
        behavior: SnackBarBehavior.floating,
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
        leading: IconButton(
          icon: const Icon(
            Icons.arrow_back_ios_new_rounded,
            color: BrandColors.text,
            size: 20,
          ),
          onPressed: () => Navigator.pop(context),
        ),
        title: const BrandMark(
          compact: true,
          titleColor: BrandColors.text,
          subtitleColor: BrandColors.textMuted,
        ),
        centerTitle: false,
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Container(height: 1, color: BrandColors.border),
        ),
      ),
      body: SafeArea(
        child: Column(
          children: [
            const SizedBox(height: 14),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Column(
                children: [
                  Text(
                    context.tr('Crop Face Photo', 'I-crop ang Larawan ng Mukha'),
                    style: const TextStyle(
                      color: BrandColors.text,
                      fontSize: 18,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    context.tr(
                      'Move and resize the circle to frame your face.',
                      'Ilipat at i-resize ang bilog upang ma-frame ang iyong mukha.',
                    ),
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: BrandColors.textMuted,
                      fontSize: 13,
                      height: 1.4,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Expanded(
              child: Container(
                width: double.infinity,
                margin: const EdgeInsets.symmetric(horizontal: 20),
                decoration: BoxDecoration(
                  color: BrandColors.surface,
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: BrandColors.border),
                ),
                child: _buildCropEditor(),
              ),
            ),
            const SizedBox(height: 16),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: SizedBox(
                width: double.infinity,
                height: 52,
                child: FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: BrandColors.cyan,
                    foregroundColor: Colors.white,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                    ),
                  ),
                  onPressed: _imageBytes == null ? null : _cropAndSave,
                  child: Text(
                    context.tr('Use Photo', 'Gamitin ang Larawan'),
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 20),
          ],
        ),
      ),
    );
  }

  Widget _buildCropEditor() {
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.broken_image_rounded,
                size: 48,
                color: BrandColors.textMuted,
              ),
              const SizedBox(height: 12),
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  color: BrandColors.text,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      );
    }
    final bytes = _imageBytes;
    if (bytes == null) {
      return const Center(
        child: CircularProgressIndicator(color: BrandColors.cyan),
      );
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(24),
      child: Crop(
        image: bytes,
        controller: _controller,
        withCircleUi: true,
        onCropped: _onCropped,
        maskColor: BrandColors.bg.withValues(alpha: 0.65),
        baseColor: BrandColors.surface,
        progressIndicator: const Center(
          child: CircularProgressIndicator(color: BrandColors.cyan),
        ),
      ),
    );
  }
}
