import 'dart:convert';

String serverMessageFromBody(
  String body, {
  String fallback = 'Something went wrong.',
}) {
  return _messageFromText(body) ?? fallback;
}

String friendlyRegistrationError(String raw) {
  final msg = raw.toLowerCase();

  // Kung ang error ay tungkol sa face recognition (may match na nahanap),
  // ibalik ang raw message para makita ng user kung kaninong pangalan ito nag-match.
  if (msg.contains('face already') ||
      msg.contains('rejected as') ||
      msg.contains('submitted as')) {
    return raw;
  }

  if (msg.contains('phone number already registered') ||
      msg.contains('phone already registered') ||
      msg.contains('phone exists')) {
    return 'These contact details are already in use.';
  }
  if (msg.contains('email already registered') ||
      msg.contains('email exists') ||
      msg.contains('email already') ||
      msg.contains('duplicate') ||
      msg.contains('already exists') ||
      msg.contains('already exist') ||
      msg.contains('conflict') ||
      msg.contains('unique')) {
    return 'These details are already in use.';
  }
  if (msg.contains('front face capture is missing')) {
    return 'Face capture missing. Please scan again.';
  }
  if (msg.contains('could not see a face in the image') ||
      msg.contains('could not see a face') ||
      msg.contains('could not read the face clearly') ||
      msg.contains('multiple faces detected') ||
      msg.contains('face check failed') ||
      msg.contains('face image is required')) {
    return 'We could not read your face clearly. Please try again with better light and a steady pose.';
  }
  if (msg.contains('password')) {
    return 'Password was not accepted. Please try again.';
  }
  return raw;
}

String friendlyAttendanceError(String raw) {
  final msg = raw.toLowerCase();
  if (msg.contains('already timed in') ||
      msg.contains('already clocked in') ||
      msg.contains('duplicate time in')) {
    return 'You are already timed in today.';
  }
  if (msg.contains('already timed out') ||
      msg.contains('already clocked out') ||
      msg.contains('duplicate time out')) {
    return 'You are already timed out today.';
  }
  if (msg.contains('duplicate') || msg.contains('already registered')) {
    return 'This attendance has already been recorded.';
  }
  return raw;
}

bool isRetryableNetworkError(Object error) {
  final msg = error.toString().toLowerCase();
  return msg.contains('timed out') ||
      msg.contains('socketexception') ||
      msg.contains('connection refused') ||
      msg.contains('connection reset') ||
      msg.contains('503') ||
      msg.contains('502') ||
      msg.contains('504');
}

String? _messageFromText(String raw) {
  try {
    final decoded = jsonDecode(raw);
    if (decoded is! Map<String, dynamic>) return null;
    final detail = decoded['detail']?.toString().trim();
    if (detail != null && detail.isNotEmpty) return detail;
    final message = decoded['message']?.toString().trim();
    if (message != null && message.isNotEmpty) return message;
  } catch (_) {}
  return null;
}
