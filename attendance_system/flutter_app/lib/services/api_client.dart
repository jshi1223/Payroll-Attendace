import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../constants.dart';

class ApiResponse {
  final int statusCode;
  final String body;

  const ApiResponse({
    required this.statusCode,
    required this.body,
  });
}

class ApiClient {
  static const String authMessage =
      'Session expired. Please sign in again to continue.';

  static Uri url(String path) => Uri.parse('${AppConstants.baseUrl}$path');

  static Future<http.Response> get(
    String path, {
    Map<String, String>? headers,
    Duration timeout = const Duration(seconds: 10),
  }) {
    return http
        .get(
          url(path),
          headers: headers,
        )
        .timeout(
          timeout,
          onTimeout: () => throw const SocketException('Request timed out.'),
        );
  }

  static Future<http.Response> postForm(
    String path, {
    required Map<String, String> body,
    Map<String, String>? headers,
    Duration timeout = const Duration(seconds: 15),
  }) {
    return http
        .post(
          url(path),
          headers: headers,
          body: body,
        )
        .timeout(
          timeout,
          onTimeout: () => throw const SocketException('Request timed out.'),
        );
  }

  static Future<http.Response> putForm(
    String path, {
    required Map<String, String> body,
    Map<String, String>? headers,
    Duration timeout = const Duration(seconds: 15),
  }) {
    return http
        .put(
          url(path),
          headers: headers,
          body: body,
        )
        .timeout(
          timeout,
          onTimeout: () => throw const SocketException('Request timed out.'),
        );
  }

  static Future<ApiResponse> sendMultipart(
    String path, {
    required Map<String, String> fields,
    required Map<String, String> filePaths,
    Map<String, String>? headers,
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final request = http.MultipartRequest('POST', url(path));
    request.fields.addAll(fields);
    if (headers != null) request.headers.addAll(headers);

    for (final entry in filePaths.entries) {
      request.files.add(
        await http.MultipartFile.fromPath(entry.key, entry.value),
      );
    }

    final streamed = await request.send().timeout(
      timeout,
      onTimeout: () => throw const SocketException('Request timed out.'),
    );
    final body = await streamed.stream.bytesToString();
    return ApiResponse(statusCode: streamed.statusCode, body: body);
  }

  static Map<String, dynamic>? jsonObject(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map<String, dynamic>) return decoded;
    } catch (_) {}
    return null;
  }

  static String messageFromBody(
    String body, {
    String fallback = 'Request failed. Please try again.',
  }) {
    final parsed = jsonObject(body);
    final detail = parsed?['detail'] ?? parsed?['message'];
    if (detail is String && detail.trim().isNotEmpty) return detail.trim();
    return fallback;
  }

  static String friendlyNetworkError(Object error) {
    final raw = error.toString().toLowerCase();
    if (error is SocketException ||
        raw.contains('socketexception') ||
        raw.contains('connection refused') ||
        raw.contains('failed host lookup') ||
        raw.contains('network is unreachable')) {
      return 'Cannot connect to server. Check internet connection or server URL.';
    }
    if (raw.contains('timed out') || raw.contains('timeout')) {
      return 'Request timed out. Check your connection and try again.';
    }
    return 'Connection failed. Please try again.';
  }

  static bool isAuthExpiredStatus(int statusCode) =>
      statusCode == 401 || statusCode == 403;

  static bool isRetryableStatus(int statusCode) =>
      statusCode == 408 || statusCode == 429 || statusCode >= 500;
}
