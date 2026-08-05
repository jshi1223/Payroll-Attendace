import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_app/utils/api_errors.dart';

void main() {
  test('serverMessageFromBody prefers detail field', () {
    expect(
      serverMessageFromBody(
        '{"detail":"Email already exists."}',
        fallback: 'Fallback',
      ),
      'Email already exists.',
    );
  });

  test('friendlyRegistrationError collapses duplicate messages', () {
    expect(
      friendlyRegistrationError('duplicate key value violates unique constraint'),
      'Email already registered.',
    );
  });

  test('friendlyAttendanceError collapses duplicate attendance messages', () {
    expect(
      friendlyAttendanceError('already timed in today'),
      'You are already timed in today.',
    );
  });

  test('isRetryableNetworkError matches transient failures', () {
    expect(isRetryableNetworkError(const SocketException('Connection refused')), isTrue);
    expect(isRetryableNetworkError(Exception('Validation failed')), isFalse);
  });
}
