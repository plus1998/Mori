import 'dart:convert';
import 'dart:typed_data';

import 'package:uuid/uuid.dart';

import '../models/acp_models.dart';
import '../models/codex_account_models.dart';
import '../models/asr_models.dart';
import '../models/tts_models.dart';
import '../models/eco_types.dart';
import '../models/conversation_v2_models.dart';
import '../models/git_models.dart';
import '../models/html_host_models.dart';
import '../models/image_display_models.dart';
import '../models/image_generation_models.dart';
import '../models/image_view_models.dart';
import '../models/integration_models.dart';
import '../models/mcp_models.dart';
import '../models/project_orchestration_settings.dart';
import '../models/skill_models.dart';
import '../models/thread_models.dart';
import '../models/scheduling_models.dart';
import '../models/project_todo_models.dart';
import '../network/eco_center_client.dart';
import '../storage/conversation_v2_cache.dart';
import '../utils/conversation_v2_hash.dart';

class PromptImageUploadResult {
  const PromptImageUploadResult({
    required this.path,
    required this.contentRef,
    required this.byteLength,
  });

  final String path;
  final String contentRef;
  final int byteLength;
}

class DesktopRpc implements ReadAloudRemote {
  Future<List<CodexAccount>> listCodexAccounts() async {
    final result = await _client.invoke<List<dynamic>>(
      desktopDeviceId,
      'openai-accounts:list',
      [],
    );
    return result
        .map(
          (row) => CodexAccount.fromJson(Map<String, dynamic>.from(row as Map)),
        )
        .toList();
  }

  Future<CodexActiveAccount> getActiveCodexAccount() async =>
      CodexActiveAccount.fromJson(
        await _client.invoke<Map<String, dynamic>>(
          desktopDeviceId,
          'openai-accounts:get-active',
          [],
        ),
      );

  Future<CodexAccountQuota> queryCodexAccountQuota(String accountId) async =>
      CodexAccountQuota.fromJson(
        await _client.invoke<Map<String, dynamic>>(
          desktopDeviceId,
          'openai-accounts:query-quota',
          [
            {'accountId': accountId},
          ],
        ),
      );

  Future<bool> setActiveCodexAccount(String accountId) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'openai-accounts:set-active',
      [
        {'accountId': accountId},
      ],
    );
    if (result['success'] != true) {
      throw StateError('Codex account switch failed');
    }
    return result['pending'] == true;
  }

  Future<String> resetCodexAccountQuota(
    String accountId,
    String idempotencyKey,
  ) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'openai-accounts:reset-quota',
      [
        {'accountId': accountId, 'idempotencyKey': idempotencyKey},
      ],
    );
    final outcome = result['outcome'];
    if (!const [
      'reset',
      'alreadyRedeemed',
      'nothingToReset',
      'noCredit',
    ].contains(outcome)) {
      throw const FormatException('Unknown Codex reset outcome');
    }
    return outcome as String;
  }

  Future<List<ProjectTodo>> listProjectTodos() async {
    final result = await _client.invoke<List<dynamic>>(desktopDeviceId, 'project-todo:list', []);
    return result.map((row) => ProjectTodo.fromJson(Map<String, dynamic>.from(row as Map))).toList();
  }

  Future<ProjectTodo> getProjectTodo(String id) async {
    final result = await _client.invoke<Map<String, dynamic>>(desktopDeviceId, 'project-todo:get', [id, false]);
    return ProjectTodo.fromJson(result);
  }

  Future<ProjectTodo> saveProjectTodo(Map<String, dynamic> input) async {
    final result = await _client.invoke<Map<String, dynamic>>(desktopDeviceId, 'project-todo:save', [input]);
    return ProjectTodo.fromJson(result);
  }

  Future<int> trashProjectTodo({required String id, required int revision, required bool deleted}) =>
      _client.invoke<int>(desktopDeviceId, 'project-todo:trash', [{'id': id, 'revision': revision, 'deleted': deleted}]);

  Future<String> downloadProjectTodoImage(ProjectTodo todo, ProjectTodoImage image) async {
    final bytes = BytesBuilder(copy: false);
    int? total;
    var offset = 0;
    do {
      final result = await _client.invoke<Map<String, dynamic>>(desktopDeviceId, 'project-todo:image-read', [{
        'id': todo.id, 'revision': todo.revision, 'imageId': image.id, 'offset': offset,
      }]);
      final chunk = base64Decode(result['data'] as String);
      final next = result['nextOffset'] as int;
      final size = result['totalBytes'] as int;
      if (size <= 0 || size > todoMaxImageBytes || (total != null && total != size) ||
          next != offset + chunk.length || next <= offset || next > size) {
        throw const FormatException('Invalid todo image chunk.');
      }
      total = size;
      offset = next;
      bytes.add(chunk);
    } while (offset < total);
    return base64Encode(bytes.takeBytes());
  }

  Future<SchedulingSnapshot> listSchedules() async =>
      SchedulingSnapshot.fromJson(
        Map<String, dynamic>.from(
          await _client.invoke<dynamic>(desktopDeviceId, 'scheduling:list', [])
              as Map,
        ),
      );

  Future<void> createSchedule(Map<String, dynamic> input) async {
    await _client.invoke<dynamic>(desktopDeviceId, 'scheduling:create', [
      input,
    ]);
  }

  Future<void> updateSchedule(Map<String, dynamic> input) async {
    await _client.invoke<dynamic>(desktopDeviceId, 'scheduling:update', [
      input,
    ]);
  }

  Future<void> deleteSchedule(String id) async {
    await _client.invoke<dynamic>(desktopDeviceId, 'scheduling:delete', [id]);
  }

  Future<void> runScheduleNow(String id, String requestId) async {
    await _client.invoke<dynamic>(desktopDeviceId, 'scheduling:run-now', [
      {'id': id, 'requestId': requestId},
    ]);
  }

  Future<List<String>> previewSchedule(Map<String, dynamic> trigger) async =>
      (await _client.invoke<dynamic>(desktopDeviceId, 'scheduling:preview', [
                trigger,
              ])
              as List)
          .cast<String>();

  DesktopRpc(
    this._client,
    this.desktopDeviceId, {
    ConversationV2ThreadDeleteCommandStore? threadDeleteCommandStore,
  }) : _threadDeleteCommandStore = threadDeleteCommandStore;

  final EcoCenterClient _client;
  final String desktopDeviceId;
  final ConversationV2ThreadDeleteCommandStore? _threadDeleteCommandStore;
  final Map<String, ConversationV2PendingThreadDelete>
  _pendingThreadDeleteCommands = {};

  Future<dynamic> _readAloudInvoke(
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    try {
      return await _client.invoke<dynamic>(
        desktopDeviceId,
        channel,
        args,
        deadlineMs: deadlineMs,
      );
    } on EcoCenterException catch (error) {
      if (error.code == EcoRpcConstants.methodNotFound ||
          RegExp(
            r'Unknown (?:desktop command )?channel|not remote-enabled|not registered',
            caseSensitive: false,
          ).hasMatch(error.message)) {
        throw const ReadAloudException('已连接的电脑版本不支持正文朗读，请升级 Eco。');
      }
      if (error.code == EcoRpcConstants.targetOffline ||
          error.kind == EcoCenterErrorKind.websocketDisconnected) {
        throw const ReadAloudException('已连接的电脑当前离线或连接已中断，请连接后重试。');
      }
      if (error.code == EcoRpcConstants.timeout ||
          error.kind == EcoCenterErrorKind.rpcTimeout) {
        throw const ReadAloudException('朗读请求超时，请重试。');
      }
      rethrow;
    }
  }

  @override
  Future<ReadAloudStatus> getReadAloudStatus() async =>
      ReadAloudStatus.fromJson(
        await _readAloudInvoke('tts-read-aloud:status', []),
      );

  @override
  Future<ReadAloudStartResult> startReadAloud({
    required String requestId,
    required String threadId,
    required String entryId,
    required String sourceText,
  }) async {
    final result = await _readAloudInvoke('tts-read-aloud:start', [
      {
        'requestId': requestId,
        'threadId': threadId,
        'entryId': entryId,
        'sourceText': sourceText,
      },
    ]);
    if (result is! Map ||
        result['requestId'] != requestId ||
        result['segmentCount'] is! int ||
        (result['segmentCount'] as int) < 1) {
      throw const ReadAloudException('朗读任务响应无效。');
    }
    return ReadAloudStartResult(requestId, result['segmentCount'] as int);
  }

  @override
  Future<ReadAloudSegmentResult> synthesizeReadAloudSegment(
    String requestId,
    int index,
  ) async {
    final result = await _readAloudInvoke('tts-read-aloud:segment', [
      {'requestId': requestId, 'index': index},
    ], deadlineMs: 660000);
    if (result is! Map ||
        result['totalBytes'] is! int ||
        (result['totalBytes'] as int) <= 0 ||
        (result['totalBytes'] as int) > 64 * 1024 * 1024 ||
        !['audio/mpeg', 'audio/wav'].contains(result['mimeType'])) {
      throw const ReadAloudException('朗读音频响应无效。');
    }
    return ReadAloudSegmentResult(
      result['mimeType'] as String,
      result['totalBytes'] as int,
    );
  }

  @override
  Future<ReadAloudChunk> readReadAloudChunk(
    String requestId,
    int index,
    int offset,
    int length,
  ) async {
    final result = await _readAloudInvoke('tts-read-aloud:read', [
      {
        'requestId': requestId,
        'index': index,
        'offset': offset,
        'length': length,
      },
    ]);
    if (result is! Map ||
        result['dataBase64'] is! String ||
        result['offset'] != offset ||
        result['chunkBytes'] is! int ||
        result['totalBytes'] is! int ||
        result['mimeType'] is! String) {
      throw const ReadAloudException('朗读音频分块响应无效。');
    }
    final bytes = base64Decode(result['dataBase64'] as String);
    if (bytes.isEmpty ||
        bytes.length > length ||
        bytes.length != result['chunkBytes']) {
      throw const ReadAloudException('朗读音频分块长度无效。');
    }
    return ReadAloudChunk(
      bytes: bytes,
      offset: offset,
      totalBytes: result['totalBytes'] as int,
      mimeType: result['mimeType'] as String,
    );
  }

  @override
  Future<void> cancelReadAloud(String requestId) async {
    await _readAloudInvoke('tts-read-aloud:cancel', [
      {'requestId': requestId},
    ]);
  }

  Future<AsrStatus> getAsrStatus() async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'asr-settings:get-status',
      [],
    );
    return AsrStatus.fromJson(result);
  }

  Future<String> transcribeAsr({
    required String audioWavBase64,
    required String profileId,
  }) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'asr:transcribe',
      [
        {'audioWavBase64': audioWavBase64, 'profileId': profileId},
      ],
      deadlineMs: 240000,
    );
    return AsrTranscriptResponse.fromJson(
      result,
      apiMode: AsrApiMode.audioTranscriptions,
    ).text;
  }

  Future<ImageViewReadData> readImageView(String path) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'image-view:read',
      [
        {'path': path},
      ],
    );
    if (result is! Map<String, dynamic>) {
      throw const ImageViewReadException(
        ImageViewReadFailureCode.invalidResponse,
      );
    }
    if (result['ok'] != true) {
      throw ImageViewReadException(
        imageViewReadFailureCodeFromWire(result['code']),
      );
    }

    final dataBase64 = result['dataBase64'];
    final mimeType = result['mimeType'];
    final imagePath = result['path'];
    final fileName = result['fileName'];
    final bytes = result['bytes'];
    final width = result['width'];
    final height = result['height'];
    if (dataBase64 is! String ||
        mimeType is! String ||
        imagePath is! String ||
        fileName is! String ||
        bytes is! num ||
        width is! num ||
        height is! num) {
      throw const ImageViewReadException(
        ImageViewReadFailureCode.invalidResponse,
      );
    }

    try {
      final decoded = base64Decode(dataBase64);
      final byteLength = bytes.toInt();
      final imageWidth = width.toInt();
      final imageHeight = height.toInt();
      final supportedMimeType =
          mimeType == 'image/png' ||
          mimeType == 'image/jpeg' ||
          mimeType == 'image/gif' ||
          mimeType == 'image/webp';
      if (!supportedMimeType ||
          imagePath.trim().isEmpty ||
          fileName.trim().isEmpty ||
          decoded.isEmpty ||
          decoded.length != byteLength ||
          byteLength <= 0 ||
          imageWidth <= 0 ||
          imageHeight <= 0) {
        throw const ImageViewReadException(
          ImageViewReadFailureCode.invalidResponse,
        );
      }
      return ImageViewReadData(
        bytes: decoded,
        mimeType: mimeType,
        path: imagePath,
        fileName: fileName,
        byteLength: byteLength,
        width: imageWidth,
        height: imageHeight,
      );
    } on ImageViewReadException {
      rethrow;
    } on FormatException catch (error) {
      throw ImageViewReadException(
        ImageViewReadFailureCode.invalidResponse,
        detail: error.message,
      );
    }
  }

  /// Reads a displayed-image artifact via chunked Desktop RPC so large
  /// screenshots can report progress. Falls back to a single full payload when
  /// the desktop build ignores `offset`/`length` (legacy).
  Future<ImageViewReadData> readImageDisplay(
    String artifactId, {
    void Function(int receivedBytes, int totalBytes)? onProgress,
  }) async {
    // Keep chunks small so progress ticks frequently over the Center bridge.
    const chunkBytes = 64 * 1024;
    final builder = BytesBuilder(copy: false);
    var offset = 0;
    var totalBytes = 0;
    var width = 0;
    var height = 0;
    late String mimeType;
    late String imagePath;
    late String fileName;

    Future<Map<String, dynamic>> readSlice({
      required int sliceOffset,
      required int sliceLength,
    }) async {
      final result = await _client.invoke<dynamic>(
        desktopDeviceId,
        'image-display:read',
        [
          {
            'artifactId': artifactId,
            'offset': sliceOffset,
            'length': sliceLength,
          },
        ],
        deadlineMs: 60000,
      );
      if (result is! Map) {
        throw const ImageViewReadException(
          ImageViewReadFailureCode.invalidResponse,
        );
      }
      final payload = Map<String, dynamic>.from(result);
      if (payload['ok'] != true) {
        throw ImageViewReadException(
          imageViewReadFailureCodeFromWire(payload['code']),
        );
      }
      return payload;
    }

    while (true) {
      final payload = await readSlice(
        sliceOffset: offset,
        sliceLength: chunkBytes,
      );
      final dataBase64 = payload['dataBase64'];
      final nextMimeType = payload['mimeType'];
      final nextPath = payload['path'];
      final nextFileName = payload['fileName'];
      final reportedTotal = payload['totalBytes'] ?? payload['bytes'];
      if (dataBase64 is! String ||
          nextMimeType is! String ||
          nextPath is! String ||
          nextFileName is! String ||
          reportedTotal is! num) {
        throw const ImageViewReadException(
          ImageViewReadFailureCode.invalidResponse,
        );
      }

      final hasChunkFields =
          payload.containsKey('chunkBytes') && payload.containsKey('offset');

      if (offset == 0) {
        mimeType = nextMimeType;
        imagePath = nextPath;
        fileName = nextFileName;
        totalBytes = reportedTotal.toInt();
        width = payload['width'] is num ? (payload['width'] as num).toInt() : 0;
        height = payload['height'] is num
            ? (payload['height'] as num).toInt()
            : 0;
      }

      final decoded = base64Decode(dataBase64);

      // Legacy desktop ignored range and returned the whole file once.
      final isLegacyFull =
          !hasChunkFields ||
          (offset == 0 &&
              totalBytes > 0 &&
              decoded.length >= totalBytes &&
              decoded.length > chunkBytes);

      if (isLegacyFull) {
        onProgress?.call(decoded.length, decoded.length);
        return ImageViewReadData(
          bytes: decoded,
          mimeType: mimeType,
          path: imagePath,
          fileName: fileName,
          byteLength: decoded.length,
          width: width,
          height: height,
        );
      }

      if (hasChunkFields) {
        final chunkOffset = payload['offset'];
        final expectedOffset = chunkOffset is num
            ? chunkOffset.toInt()
            : offset;
        if (expectedOffset != offset) {
          throw const ImageViewReadException(
            ImageViewReadFailureCode.invalidResponse,
          );
        }
        final chunkLen = payload['chunkBytes'];
        if (chunkLen is num && chunkLen.toInt() != decoded.length) {
          throw const ImageViewReadException(
            ImageViewReadFailureCode.invalidResponse,
          );
        }
      }

      if (decoded.isEmpty) break;
      builder.add(decoded);
      offset += decoded.length;
      onProgress?.call(offset, totalBytes > 0 ? totalBytes : offset);

      if (totalBytes > 0 && offset >= totalBytes) break;
      if (decoded.length < chunkBytes) break;
      if (offset > 20 * 1024 * 1024) {
        throw const ImageViewReadException(ImageViewReadFailureCode.tooLarge);
      }
    }

    final bytes = builder.takeBytes();
    if (bytes.isEmpty) {
      throw const ImageViewReadException(
        ImageViewReadFailureCode.invalidResponse,
      );
    }
    return ImageViewReadData(
      bytes: bytes,
      mimeType: mimeType,
      path: imagePath,
      fileName: fileName,
      byteLength: totalBytes > 0 ? totalBytes : bytes.length,
      width: width,
      height: height,
    );
  }

  Future<List<ImageDisplayArtifact>> listImageDisplayArtifacts(
    String threadId,
  ) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'image-display-artifacts:list',
      [
        {'threadId': threadId},
      ],
    );
    if (result is! List) {
      throw const FormatException('Invalid image display artifact list.');
    }
    return result
        .whereType<Map>()
        .map(
          (entry) =>
              ImageDisplayArtifact.fromJson(Map<String, dynamic>.from(entry)),
        )
        .where((artifact) => artifact.id.isNotEmpty)
        .toList(growable: false);
  }

  Future<List<ImageGenerationArtifact>> listImageGenerationArtifacts(
    String threadId,
  ) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'image-generation-artifacts:list',
      [
        {'threadId': threadId},
      ],
    );
    if (result is! List) {
      throw const FormatException('Invalid image generation artifact list.');
    }
    return result
        .whereType<Map>()
        .map(
          (entry) => ImageGenerationArtifact.fromJson(
            Map<String, dynamic>.from(entry),
          ),
        )
        .where((artifact) => artifact.id.isNotEmpty)
        .toList(growable: false);
  }

  Future<ImageGenerationArtifactReadResult> readImageGenerationArtifact({
    required String artifactId,
    required int imageIndex,
  }) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'image-generation-artifact:read',
      [
        {'artifactId': artifactId, 'imageIndex': imageIndex},
      ],
      deadlineMs: 60000,
    );
    if (result is! Map) {
      throw const FormatException('Invalid image generation artifact read.');
    }
    final payload = Map<String, dynamic>.from(result);
    final dataBase64 = (payload['dataBase64'] as String?)?.trim() ?? '';
    final mimeType = (payload['mimeType'] as String?)?.trim() ?? 'image/png';
    final path = (payload['path'] as String?)?.trim() ?? '';
    if (dataBase64.isEmpty) {
      throw const FormatException('Empty image generation artifact payload.');
    }
    return ImageGenerationArtifactReadResult(
      bytes: base64Decode(dataBase64),
      mimeType: mimeType.isEmpty ? 'image/png' : mimeType,
      path: path,
    );
  }

  Future<List<HtmlHostArtifact>> listHtmlHostArtifacts(String threadId) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'html-host-artifacts:list',
      [
        {'threadId': threadId},
      ],
    );
    if (result is! List) {
      throw const FormatException('Invalid html host artifact list.');
    }
    return result
        .whereType<Map>()
        .map(
          (entry) =>
              HtmlHostArtifact.fromJson(Map<String, dynamic>.from(entry)),
        )
        .where(
          (artifact) => artifact.id.isNotEmpty || artifact.pageId.isNotEmpty,
        )
        .toList(growable: false);
  }

  Future<List<ThreadSummary>> listThreads() async {
    final result = await _client.invoke<List<dynamic>>(
      desktopDeviceId,
      'thread:list',
      [],
    );
    return result
        .map((e) => ThreadSummary.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<ConversationV2Capabilities> conversationV2Capabilities() async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'conversation:capabilities',
      const [],
    );
    return ConversationV2Capabilities.fromJson(result);
  }

  Future<ConversationV2Bootstrap> conversationV2Bootstrap(
    String conversationId, {
    int pageSize = 30,
    int maxBytes = 512 * 1024,
  }) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'conversation:bootstrap',
      [
        {
          'conversationId': conversationId,
          'pageSize': pageSize,
          'maxBytes': maxBytes,
        },
      ],
    );
    return ConversationV2Bootstrap.fromJson(result);
  }

  Future<ConversationV2ProjectionExtras> conversationV2Projection(
    String conversationId,
  ) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'conversation:projection',
      [
        {'conversationId': conversationId},
      ],
    );
    return ConversationV2ProjectionExtras.fromJson(result);
  }

  Future<ConversationV2MessagePage> conversationV2MessagesPage(
    String conversationId, {
    String? beforeCursor,
    int limit = 30,
    int maxBytes = 512 * 1024,
  }) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'conversation:messages-page',
      [
        {
          'conversationId': conversationId,
          ...?(beforeCursor == null ? null : {'beforeCursor': beforeCursor}),
          'limit': limit,
          'maxBytes': maxBytes,
        },
      ],
    );
    return ConversationV2MessagePage.fromJson(result);
  }

  Future<ConversationV2DetailPage> conversationV2DetailsPage(
    String conversationId,
    String runId, {
    String? cursor,
    String? toolCallId,
    String? agentInstanceId,
    int limit = 50,
    int maxBytes = 512 * 1024,
  }) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'conversation:details-page',
      [
        {
          'conversationId': conversationId,
          'runId': runId,
          ...?(cursor == null ? null : {'cursor': cursor}),
          ...?(toolCallId == null ? null : {'toolCallId': toolCallId}),
          ...?(agentInstanceId == null
              ? null
              : {'agentInstanceId': agentInstanceId}),
          'limit': limit,
          'maxBytes': maxBytes,
        },
      ],
    );
    return ConversationV2DetailPage.fromJson(result);
  }

  Future<ConversationV2ToolsPage> conversationV2ToolsPage(
    String conversationId,
    String runId, {
    String? cursor,
    String? toolCallId,
    String? agentInstanceId,
    int limit = 50,
    int maxBytes = 512 * 1024,
  }) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'conversation:tools-page',
      [
        {
          'conversationId': conversationId,
          'runId': runId,
          ...?(cursor == null ? null : {'cursor': cursor}),
          ...?(toolCallId == null ? null : {'toolCallId': toolCallId}),
          ...?(agentInstanceId == null
              ? null
              : {'agentInstanceId': agentInstanceId}),
          'limit': limit,
          'maxBytes': maxBytes,
        },
      ],
    );
    return ConversationV2ToolsPage.fromJson(result);
  }

  Future<ConversationV2Head> conversationV2Head(String conversationId) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'conversation:head',
      [conversationId],
    );
    return ConversationV2Head.fromJson(result);
  }

  Future<dynamic> conversationV2MessageGet(
    String conversationId,
    String messageId,
  ) async {
    return _client.invoke<dynamic>(
      desktopDeviceId,
      'conversation:message-get',
      [
        {'conversationId': conversationId, 'messageId': messageId},
      ],
    );
  }

  Future<dynamic> conversationV2RunGet(
    String conversationId,
    String runId,
  ) async {
    return _client.invoke<dynamic>(desktopDeviceId, 'conversation:run-get', [
      {'conversationId': conversationId, 'runId': runId},
    ]);
  }

  Future<dynamic> conversationV2DetailGet(
    String conversationId,
    String itemId,
  ) async {
    return _client.invoke<dynamic>(desktopDeviceId, 'conversation:detail-get', [
      {'conversationId': conversationId, 'itemId': itemId},
    ]);
  }

  Future<ConversationV2SyncPage> conversationV2Sync(
    String conversationId,
    String storeEpoch,
    int afterSeq, {
    int? throughSeq,
    int maxEvents = 200,
    int maxBytes = 512 * 1024,
  }) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'conversation:sync',
      [
        {
          'conversationId': conversationId,
          'storeEpoch': storeEpoch,
          'afterSeq': afterSeq,
          ...?(throughSeq == null ? null : {'throughSeq': throughSeq}),
          'maxEvents': maxEvents,
          'maxBytes': maxBytes,
        },
      ],
    );
    return ConversationV2SyncPage.fromJson(result);
  }

  Future<dynamic> conversationV2SendMessage({
    required String principalId,
    required String conversationId,
    required String clientCommandId,
    required String text,
    String? turnId,
    String? messageId,
    List<dynamic>? attachments,
  }) async {
    return _client.invoke<dynamic>(
      desktopDeviceId,
      'conversation:send-message',
      [
        {
          'principalId': principalId,
          'conversationId': conversationId,
          'clientCommandId': clientCommandId,
          'text': text,
          ...?(turnId == null ? null : {'turnId': turnId}),
          ...?(messageId == null ? null : {'messageId': messageId}),
          ...?(attachments == null ? null : {'attachments': attachments}),
        },
      ],
    );
  }

  Future<ThreadListInitialResult> listInitialThreads() async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'thread:list-initial',
      [],
    );
    if (result is! Map) {
      throw const FormatException('Invalid initial thread list response.');
    }
    return ThreadListInitialResult.fromJson(Map<String, dynamic>.from(result));
  }

  Future<ThreadListPage> listMoreThreads({
    required String workspacePath,
    required ThreadListCursor cursor,
    int limit = 20,
  }) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'thread:list-more',
      [
        {
          'workspacePath': workspacePath,
          'cursor': cursor.toJson(),
          'limit': limit,
        },
      ],
    );
    if (result is! Map) {
      throw const FormatException('Invalid more thread list response.');
    }
    return ThreadListPage.fromJson(Map<String, dynamic>.from(result));
  }

  Future<ThreadSummary?> getThread(String threadId) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'thread:get',
      [threadId],
    );
    if (result is! Map<String, dynamic>) return null;
    return ThreadSummary.fromJson(result);
  }

  Future<ThreadSessionBootstrapResult> sessionBootstrap(String threadId) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'thread:session-bootstrap',
      [threadId],
    );
    return ThreadSessionBootstrapResult.fromJson(result);
  }

  Future<ComposerDraftRecord?> getComposerDraft(String contextKey) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'composer-draft:get',
      [contextKey],
    );
    if (result is! Map) return null;
    return ComposerDraftRecord.fromJson(Map<String, dynamic>.from(result));
  }

  Future<bool> deleteComposerDraft({
    required String contextKey,
    required String expectedRevision,
  }) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'composer-draft:delete',
      [
        {'contextKey': contextKey, 'expectedRevision': expectedRevision},
      ],
    );
    return result['deleted'] == true;
  }

  /// Stages a prompt image via 64 KiB chunks with resume from `receivedBytes`.
  Future<String> uploadPromptImageChunked({
    required String contextKey,
    required String imageId,
    required String mediaType,
    required Uint8List bytes,
    void Function(int sentBytes, int totalBytes)? onProgress,
    int maxChunkAttempts = 3,
  }) async {
    final result = await uploadPromptImageChunkedWithMetadata(
      contextKey: contextKey,
      imageId: imageId,
      mediaType: mediaType,
      bytes: bytes,
      onProgress: onProgress,
      maxChunkAttempts: maxChunkAttempts,
      allowLegacyResponse: true,
    );
    return result.path;
  }

  Future<PromptImageUploadResult> uploadPromptImageChunkedWithMetadata({
    required String contextKey,
    required String imageId,
    required String mediaType,
    required Uint8List bytes,
    void Function(int sentBytes, int totalBytes)? onProgress,
    int maxChunkAttempts = 3,
    bool allowLegacyResponse = false,
  }) async {
    if (bytes.isEmpty) {
      throw StateError('Prompt image bytes are empty.');
    }
    if (bytes.length > 20 * 1024 * 1024) {
      throw StateError('Prompt image exceeds 20 MB.');
    }
    const chunkBytes = 64 * 1024;
    final totalBytes = bytes.length;

    Future<Map<String, dynamic>> begin() async {
      final result = await _client.invoke<dynamic>(
        desktopDeviceId,
        'prompt-image:upload-begin',
        [
          {
            'contextKey': contextKey,
            'imageId': imageId,
            'mediaType': mediaType,
            'totalBytes': totalBytes,
          },
        ],
        deadlineMs: 60000,
      );
      if (result is! Map) {
        throw StateError('Invalid prompt image upload begin response.');
      }
      return Map<String, dynamic>.from(result);
    }

    var beginResult = await begin();
    if (beginResult['complete'] == true && beginResult['path'] is String) {
      if (beginResult['contentRef'] is! String ||
          beginResult['byteLength'] is! num) {
        if (!allowLegacyResponse) {
          throw StateError('Invalid prompt image upload begin metadata.');
        }
        onProgress?.call(totalBytes, totalBytes);
        return PromptImageUploadResult(
          path: beginResult['path'] as String,
          contentRef: '',
          byteLength: totalBytes,
        );
      }
      onProgress?.call(totalBytes, totalBytes);
      return PromptImageUploadResult(
        path: beginResult['path'] as String,
        contentRef: beginResult['contentRef'] as String,
        byteLength: (beginResult['byteLength'] as num).toInt(),
      );
    }

    var offset = beginResult['receivedBytes'] is num
        ? (beginResult['receivedBytes'] as num).toInt()
        : 0;
    if (offset < 0 || offset > totalBytes) {
      throw StateError('Invalid prompt image upload resume offset.');
    }
    onProgress?.call(offset, totalBytes);

    while (offset < totalBytes) {
      final end = (offset + chunkBytes).clamp(0, totalBytes);
      final slice = bytes.sublist(offset, end);
      final chunkB64 = base64Encode(slice);
      var attempt = 0;
      while (true) {
        attempt += 1;
        try {
          final result = await _client.invoke<dynamic>(
            desktopDeviceId,
            'prompt-image:upload-chunk',
            [
              {
                'contextKey': contextKey,
                'imageId': imageId,
                'mediaType': mediaType,
                'offset': offset,
                'data': chunkB64,
              },
            ],
            deadlineMs: 60000,
          );
          if (result is! Map) {
            throw StateError('Invalid prompt image upload chunk response.');
          }
          final payload = Map<String, dynamic>.from(result);
          final received = payload['receivedBytes'];
          if (received is! num) {
            throw StateError(
              'Prompt image upload chunk missing receivedBytes.',
            );
          }
          offset = received.toInt();
          onProgress?.call(offset, totalBytes);
          break;
        } catch (error) {
          if (attempt >= maxChunkAttempts) rethrow;
          // Re-sync offset from desktop before retrying (breakpoint resume).
          beginResult = await begin();
          if (beginResult['complete'] == true &&
              beginResult['path'] is String) {
            if (beginResult['contentRef'] is! String ||
                beginResult['byteLength'] is! num) {
              if (!allowLegacyResponse) {
                throw StateError('Invalid prompt image upload begin metadata.');
              }
              onProgress?.call(totalBytes, totalBytes);
              return PromptImageUploadResult(
                path: beginResult['path'] as String,
                contentRef: '',
                byteLength: totalBytes,
              );
            }
            onProgress?.call(totalBytes, totalBytes);
            return PromptImageUploadResult(
              path: beginResult['path'] as String,
              contentRef: beginResult['contentRef'] as String,
              byteLength: (beginResult['byteLength'] as num).toInt(),
            );
          }
          offset = beginResult['receivedBytes'] is num
              ? (beginResult['receivedBytes'] as num).toInt()
              : offset;
          onProgress?.call(offset, totalBytes);
        }
      }
    }

    final finish = await _client.invoke<dynamic>(
      desktopDeviceId,
      'prompt-image:upload-finish',
      [
        {
          'contextKey': contextKey,
          'imageId': imageId,
          'mediaType': mediaType,
          'totalBytes': totalBytes,
        },
      ],
      deadlineMs: 60000,
    );
    if (finish is! Map || finish['path'] is! String) {
      throw StateError('Invalid prompt image upload finish response.');
    }
    if (finish['contentRef'] is! String || finish['byteLength'] is! num) {
      if (!allowLegacyResponse) {
        throw StateError('Invalid prompt image upload finish metadata.');
      }
      onProgress?.call(totalBytes, totalBytes);
      return PromptImageUploadResult(
        path: finish['path'] as String,
        contentRef: '',
        byteLength: totalBytes,
      );
    }
    onProgress?.call(totalBytes, totalBytes);
    return PromptImageUploadResult(
      path: finish['path'] as String,
      contentRef: finish['contentRef'] as String,
      byteLength: (finish['byteLength'] as num).toInt(),
    );
  }

  Future<Uint8List> downloadPromptImage({
    required String contextKey,
    required String contentRef,
    required String mediaType,
    int maxChunkBytes = 64 * 1024,
  }) async {
    if (contentRef.trim().isEmpty) {
      throw StateError('Prompt image contentRef is empty.');
    }
    var offset = 0;
    var totalBytes = -1;
    final chunks = <int>[];
    while (totalBytes < 0 || offset < totalBytes) {
      final result = await _client.invoke<dynamic>(
        desktopDeviceId,
        'prompt-image:read-chunk',
        [
          {
            'contextKey': contextKey,
            'contentRef': contentRef,
            'mediaType': mediaType,
            'offset': offset,
            'maxBytes': maxChunkBytes,
          },
        ],
        deadlineMs: 60000,
      );
      if (result is! Map) {
        throw StateError('Invalid prompt image read response.');
      }
      final payload = Map<String, dynamic>.from(result);
      if (payload['contentRef'] != contentRef ||
          payload['mediaType'] != mediaType) {
        throw StateError('Prompt image read response identity mismatch.');
      }
      final responseOffset = payload['offset'];
      final nextOffset = payload['nextOffset'];
      final responseTotal = payload['totalBytes'];
      final data = payload['data'];
      if (responseOffset is! num ||
          nextOffset is! num ||
          responseTotal is! num ||
          data is! String ||
          responseOffset.toInt() != offset) {
        throw StateError('Prompt image read response is malformed.');
      }
      final bytes = base64Decode(data);
      final next = nextOffset.toInt();
      final total = responseTotal.toInt();
      if (total <= 0 ||
          next < offset ||
          next > total ||
          bytes.length != next - offset) {
        throw StateError('Prompt image read response has invalid bounds.');
      }
      chunks.addAll(bytes);
      offset = next;
      totalBytes = total;
      if (payload['complete'] == true && offset != totalBytes) {
        throw StateError('Prompt image read marked complete before EOF.');
      }
      if (bytes.isEmpty && offset < totalBytes) {
        throw StateError('Prompt image read made no progress.');
      }
    }
    return Uint8List.fromList(chunks);
  }

  Future<ThreadSummary> startThread({
    required String workspacePath,
    required String prompt,
    required ThreadRuntimeConfigInput runtimeConfig,
    String? coreKind,
    List<PromptImageAttachment>? attachments,
  }) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'thread:start',
      [
        {
          'workspacePath': workspacePath,
          'prompt': prompt,
          'coreKind': ?coreKind,
          if (attachments != null && attachments.isNotEmpty)
            'attachments': attachments.map((a) => a.toWireJson()).toList(),
          'runtimeConfig': runtimeConfig.toJson(),
        },
      ],
    );
    return ThreadSummary.fromJson(result['thread'] as Map<String, dynamic>);
  }

  Future<void> cancelThread(String threadId) async {
    final normalizedThreadId = threadId.trim();
    if (normalizedThreadId.isEmpty) {
      throw ArgumentError.value(threadId, 'threadId', 'Thread id is required.');
    }
    final principalId = _client.credentials.userId?.trim() ?? '';
    if (principalId.isEmpty) {
      throw StateError('Authenticated user id is required to cancel a thread.');
    }
    final head = await conversationV2Head(normalizedThreadId);
    final expectedHistoryRevision = head.historyRevision;
    await _client.invoke(desktopDeviceId, 'thread:cancel', [
      {
        'principalId': principalId,
        'clientCommandId': 'run_cancel_${const Uuid().v4()}',
        'threadId': normalizedThreadId,
        'expectedHistoryRevision': expectedHistoryRevision,
      },
    ]);
  }

  Future<void> deleteThread(String threadId) async {
    final normalizedThreadId = threadId.trim();
    if (normalizedThreadId.isEmpty) {
      throw ArgumentError.value(threadId, 'threadId', 'Thread id is required.');
    }
    final principalId = _client.credentials.userId?.trim() ?? '';
    if (principalId.isEmpty) {
      throw StateError('Authenticated user id is required to delete a thread.');
    }
    var command =
        _pendingThreadDeleteCommands[normalizedThreadId] ??
        await _threadDeleteCommandStore?.pendingThreadDelete(
          normalizedThreadId,
        );
    if (command != null && command.principalId != principalId) {
      throw StateError(
        'Pending thread delete belongs to a different authenticated user.',
      );
    }
    if (command == null) {
      final head = await conversationV2Head(normalizedThreadId);
      final expectedHistoryRevision = head.historyRevision;
      command = ConversationV2PendingThreadDelete(
        principalId: principalId,
        clientCommandId:
            'thread_delete_${conversationV2StableHash({'threadId': normalizedThreadId, 'expectedHistoryRevision': expectedHistoryRevision})}',
        threadId: normalizedThreadId,
        expectedHistoryRevision: expectedHistoryRevision,
        createdAt: DateTime.now().toUtc().toIso8601String(),
      );
      await _threadDeleteCommandStore?.putPendingThreadDelete(command);
      _pendingThreadDeleteCommands[normalizedThreadId] = command;
    } else {
      _pendingThreadDeleteCommands[normalizedThreadId] = command;
    }
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'thread:delete',
      [
        {
          'principalId': command.principalId,
          'clientCommandId': command.clientCommandId,
          'threadId': normalizedThreadId,
          'expectedHistoryRevision': command.expectedHistoryRevision,
        },
      ],
    );
    if (result['ok'] != true) {
      throw StateError('Desktop rejected the thread delete command.');
    }
    await _threadDeleteCommandStore?.removePendingThreadDelete(
      normalizedThreadId,
      command.clientCommandId,
    );
    if (_pendingThreadDeleteCommands[normalizedThreadId] == command) {
      _pendingThreadDeleteCommands.remove(normalizedThreadId);
    }
  }

  Future<({bool ok, bool regenerated})> regenerateThreadTitle(
    String threadId,
  ) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'thread:regenerate-title',
      [threadId],
    );
    return (
      ok: result['ok'] == true,
      regenerated: result['regenerated'] == true,
    );
  }

  Future<ThreadUserMessageEditGetResult> getUserMessageEdit({
    required String threadId,
    required String activityLineId,
  }) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'thread:user-message-edit-get',
      [
        {'threadId': threadId, 'activityLineId': activityLineId},
      ],
    );
    if (result is! Map<String, dynamic>) {
      throw StateError('Desktop returned an invalid user message edit result.');
    }
    return ThreadUserMessageEditGetResult.fromJson(result);
  }

  Future<ThreadSummary> rewriteThreadFromMessage({
    required String principalId,
    required String clientCommandId,
    required String threadId,
    required String activityLineId,
    required String prompt,
    required List<PromptImageAttachment> attachments,
    required int expectedHistoryRevision,
    ThreadRuntimeConfigInput? runtimeConfig,
  }) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'thread:rewrite-from-message',
      [
        {
          'principalId': principalId,
          'clientCommandId': clientCommandId,
          'threadId': threadId,
          'activityLineId': activityLineId,
          'prompt': prompt,
          'attachments': attachments
              .map((attachment) => attachment.toWireJson())
              .toList(),
          'expectedHistoryRevision': expectedHistoryRevision,
          if (runtimeConfig != null) 'runtimeConfig': runtimeConfig.toJson(),
        },
      ],
    );
    if (result is! Map<String, dynamic>) {
      throw StateError(
        'Desktop returned an invalid user message rewrite result.',
      );
    }
    final thread = result['thread'];
    if (thread is! Map<String, dynamic>) {
      throw StateError('Desktop returned no rewritten thread.');
    }
    return ThreadSummary.fromJson(thread);
  }

  Future<ThreadSummary> retryThreadFromMessage({
    required String principalId,
    required String clientCommandId,
    required String threadId,
    required String prompt,
    required int expectedHistoryRevision,
    String? activityLineId,
    bool hasImages = false,
    ThreadRuntimeConfigInput? runtimeConfig,
  }) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'thread:retry-from-message',
      [
        {
          'principalId': principalId,
          'clientCommandId': clientCommandId,
          'threadId': threadId,
          'prompt': prompt,
          'expectedHistoryRevision': expectedHistoryRevision,
          'activityLineId': ?activityLineId,
          'hasImages': hasImages,
          if (runtimeConfig != null) 'runtimeConfig': runtimeConfig.toJson(),
        },
      ],
    );
    if (result is! Map<String, dynamic>) {
      throw StateError('Desktop returned an invalid retry result.');
    }
    final thread = result['thread'];
    if (thread is! Map<String, dynamic>) {
      throw StateError('Desktop returned no retried thread.');
    }
    return ThreadSummary.fromJson(thread);
  }

  Future<ThreadPendingPlan?> getPendingPlan(String threadId) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'thread:get-pending-plan',
      [threadId],
    );
    if (result == null) return null;
    return ThreadPendingPlan.fromJson(result as Map<String, dynamic>);
  }

  Future<ThreadPendingPlan?> getApprovedPlan(String threadId) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'thread:get-approved-plan',
      [threadId],
    );
    if (result == null) return null;
    return ThreadPendingPlan.fromJson(result as Map<String, dynamic>);
  }

  Future<void> approvePlan({
    required String principalId,
    required String clientCommandId,
    required String threadId,
    required int expectedHistoryRevision,
  }) async {
    await _client.invoke(desktopDeviceId, 'thread:approve-plan', [
      {
        'principalId': principalId,
        'clientCommandId': clientCommandId,
        'threadId': threadId,
        'expectedHistoryRevision': expectedHistoryRevision,
      },
    ]);
  }

  Future<void> dismissPlan({
    required String principalId,
    required String clientCommandId,
    required String threadId,
    required int expectedHistoryRevision,
  }) async {
    await _client.invoke(desktopDeviceId, 'thread:dismiss-plan', [
      {
        'principalId': principalId,
        'clientCommandId': clientCommandId,
        'threadId': threadId,
        'expectedHistoryRevision': expectedHistoryRevision,
      },
    ]);
  }

  Future<BashApprovalRequest?> getPendingBashApproval(String threadId) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'bash-approval:get-pending',
      [threadId],
    );
    if (result == null) return null;
    return BashApprovalRequest.fromJson(result as Map<String, dynamic>);
  }

  Future<void> resolveBashApproval({
    required String principalId,
    required String clientCommandId,
    required String threadId,
    required String toolUseId,
    required String decision,
    required int expectedHistoryRevision,
    String? feedback,
  }) async {
    await _client.invoke(desktopDeviceId, 'bash-approval:resolve', [
      {
        'principalId': principalId,
        'clientCommandId': clientCommandId,
        'threadId': threadId,
        'toolUseId': toolUseId,
        'decision': decision,
        if (feedback != null && feedback.trim().isNotEmpty)
          'feedback': feedback.trim(),
        'expectedHistoryRevision': expectedHistoryRevision,
      },
    ]);
  }

  Future<ClarificationRequest?> getPendingClarification(String threadId) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'clarification:get-pending',
      [threadId],
    );
    if (result == null) return null;
    return ClarificationRequest.fromJson(result as Map<String, dynamic>);
  }

  Future<void> submitClarification({
    required String principalId,
    required String clientCommandId,
    required String threadId,
    required String toolUseId,
    required List<List<String>> selections,
    required int expectedHistoryRevision,
    List<int>? customInputIndices,
  }) async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'clarification:submit',
      [
        {
          'principalId': principalId,
          'clientCommandId': clientCommandId,
          'threadId': threadId,
          'toolUseId': toolUseId,
          'selections': selections,
          if (customInputIndices?.isNotEmpty == true)
            'customInputIndices': customInputIndices,
          'expectedHistoryRevision': expectedHistoryRevision,
        },
      ],
    );
    if (result is Map && result['delivery'] is Map) {
      final delivery = result['delivery'] as Map;
      if (delivery['state'] == 'unknown') {
        throw StateError(
          '回答已记录，但未能确认送达：${delivery['message'] ?? '原因未知'}。可重新提交或关闭问题。',
        );
      }
    }
  }

  Future<void> dismissClarification({
    required String principalId,
    required String clientCommandId,
    required String threadId,
    required String toolUseId,
    required int expectedHistoryRevision,
  }) async {
    await _client.invoke(desktopDeviceId, 'clarification:dismiss', [
      {
        'principalId': principalId,
        'clientCommandId': clientCommandId,
        'threadId': threadId,
        'toolUseId': toolUseId,
        'expectedHistoryRevision': expectedHistoryRevision,
      },
    ]);
  }

  Future<List<ThreadPendingFollowUp>> followUpList(String threadId) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'thread:follow-up-list',
      [threadId],
    );
    final followUps = result['followUps'] as List<dynamic>? ?? [];
    return followUps
        .map((e) => ThreadPendingFollowUp.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<Map<String, dynamic>> _v2CommandEnvelope({
    required String threadId,
    required String operation,
    required Map<String, dynamic> payload,
  }) async {
    final normalizedThreadId = threadId.trim();
    if (normalizedThreadId.isEmpty) {
      throw ArgumentError.value(threadId, 'threadId', 'Thread id is required.');
    }
    final principalId = _client.credentials.userId?.trim() ?? '';
    if (principalId.isEmpty) {
      throw StateError('Authenticated user id is required for V2 mutations.');
    }
    final clientCommandId = 'command_${operation}_${const Uuid().v4()}';
    final head = await conversationV2Head(normalizedThreadId);
    return {
      'principalId': principalId,
      // Each user action owns a fresh identity; transport retries reuse this request.
      'clientCommandId': clientCommandId,
      'threadId': normalizedThreadId,
      ...payload,
      'expectedHistoryRevision': head.historyRevision,
    };
  }

  Future<void> followUpEnqueue({
    required String threadId,
    required String prompt,
    List<PromptImageAttachment>? attachments,
    FollowUpDeliveryMode? deliveryMode,
  }) async {
    final request = await _v2CommandEnvelope(
      threadId: threadId,
      operation: 'enqueue',
      payload: {
        'prompt': prompt,
        if (deliveryMode != null) 'followUpDeliveryMode': deliveryMode.name,
        if (attachments != null && attachments.isNotEmpty)
          'attachments': attachments
              .map((attachment) => attachment.toWireJson())
              .toList(),
      },
    );
    await _client.invoke(desktopDeviceId, 'thread:follow-up-enqueue', [
      request,
    ]);
  }

  Future<void> followUpCancel({
    required String threadId,
    required String followUpId,
  }) async {
    final request = await _v2CommandEnvelope(
      threadId: threadId,
      operation: 'cancel',
      payload: {'followUpId': followUpId},
    );
    await _client.invoke(desktopDeviceId, 'thread:follow-up-cancel', [request]);
  }

  Future<void> followUpEscalate({
    required String threadId,
    required String followUpId,
  }) async {
    final request = await _v2CommandEnvelope(
      threadId: threadId,
      operation: 'escalate',
      payload: {'followUpId': followUpId},
    );
    await _client.invoke(desktopDeviceId, 'thread:follow-up-escalate', [
      request,
    ]);
  }

  Future<List<ThreadPendingFollowUp>> followUpReorder({
    required String threadId,
    required List<String> followUpIds,
  }) async {
    final request = await _v2CommandEnvelope(
      threadId: threadId,
      operation: 'reorder',
      payload: {'followUpIds': followUpIds},
    );
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'thread:follow-up-reorder',
      [request],
    );
    final followUps = result['followUps'] as List<dynamic>? ?? [];
    return followUps
        .map(
          (entry) =>
              ThreadPendingFollowUp.fromJson(entry as Map<String, dynamic>),
        )
        .toList();
  }

  Future<void> followUpUpdate({
    required String threadId,
    required String followUpId,
    required String prompt,
    List<PromptImageAttachment>? attachments,
  }) async {
    final request = await _v2CommandEnvelope(
      threadId: threadId,
      operation: 'update',
      payload: {
        'followUpId': followUpId,
        'prompt': prompt,
        if (attachments != null && attachments.isNotEmpty)
          'attachments': attachments
              .map((attachment) => attachment.toWireJson())
              .toList(),
      },
    );
    await _client.invoke(desktopDeviceId, 'thread:follow-up-update', [request]);
  }

  Future<bool> followUpSetEditing({
    required String threadId,
    String? followUpId,
  }) async {
    final request = await _v2CommandEnvelope(
      threadId: threadId,
      operation: followUpId == null ? 'editing-release' : 'editing-acquire',
      payload: {
        ...?followUpId == null ? null : {'followUpId': followUpId},
      },
    );
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'thread:follow-up-editing',
      [request],
    );
    return result['editing'] as bool? ?? false;
  }

  Future<ThreadSummary> followUpSetQueuePaused({
    required String threadId,
    required bool paused,
  }) async {
    final request = await _v2CommandEnvelope(
      threadId: threadId,
      operation: 'queue-paused',
      payload: {'paused': paused},
    );
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'thread:follow-up-queue-paused',
      [request],
    );
    return ThreadSummary.fromJson(result['thread'] as Map<String, dynamic>);
  }

  Future<ThreadSummary> updateRuntimeConfig({
    required String threadId,
    required ThreadRuntimeConfigInput runtimeConfig,
  }) async {
    final request = await _v2CommandEnvelope(
      threadId: threadId,
      operation: 'runtime-config',
      payload: {'runtimeConfig': runtimeConfig.toJson()},
    );
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'thread:update-runtime-config',
      [request],
    );
    return ThreadSummary.fromJson(result['thread'] as Map<String, dynamic>);
  }

  Future<WorkspaceInfo?> getCurrentWorkspace() async {
    final result = await _client.invoke<dynamic>(
      desktopDeviceId,
      'workspace:get-current',
      [],
    );
    if (result == null) return null;
    return WorkspaceInfo.fromJson(result as Map<String, dynamic>);
  }

  Future<WorkspaceInfo> openWorkspacePath(String workspacePath) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'workspace:open-path',
      [workspacePath],
    );
    return WorkspaceInfo.fromJson(result);
  }

  Future<String> getHomeProjectPath() async {
    return await _client.invoke<String>(
      desktopDeviceId,
      'workspace:get-home-path',
      [],
    );
  }

  Future<String> getUserHomePath() async {
    return await _client.invoke<String>(
      desktopDeviceId,
      'workspace:get-user-home-path',
      [],
    );
  }

  Future<WorkspaceDirectoryListing> listWorkspaceDirectories(
    String directoryPath,
  ) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'workspace:list-directories',
      [directoryPath],
    );
    return WorkspaceDirectoryListing.fromJson(result);
  }

  Future<WorkspaceInfo> inspectWorkspace(String workspacePath) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'workspace:inspect',
      [workspacePath],
    );
    return WorkspaceInfo.fromJson(result);
  }

  Future<ModelSettingsSnapshot> getModelSettings() async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'model-settings:get',
      [],
    );
    return ModelSettingsSnapshot.fromJson(result);
  }

  Future<GlobalSettingsDigest> getSettingsDigest() async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'settings:digest',
      [],
    );
    return GlobalSettingsDigest.fromJson(result);
  }

  Future<List<CursorModelOption>> listCursorModels() async {
    final result = await _client.invoke<List<dynamic>>(
      desktopDeviceId,
      'cursor:models-list',
      [],
    );
    return result
        .map(
          (entry) => CursorModelOption.fromJson(
            Map<String, dynamic>.from(entry as Map),
          ),
        )
        .toList(growable: false);
  }

  Future<List<CandidateModelView>> listCandidateModels(
    String providerId,
  ) async {
    final result = await _client.invoke<List<dynamic>>(
      desktopDeviceId,
      'candidate-model:list',
      [providerId],
    );
    return result
        .map(
          (entry) => CandidateModelView.fromJson(entry as Map<String, dynamic>),
        )
        .toList();
  }

  Future<WorkflowSettingsSnapshot> getWorkflowSettings() async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'workflow-settings:get',
      [],
    );
    return WorkflowSettingsSnapshot.fromJson(result);
  }

  Future<WorkflowSettingsSnapshot> saveWorkflowSettings(
    WorkflowSettingsSnapshot settings,
  ) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'workflow-settings:save',
      [settings.toJson()],
    );
    return WorkflowSettingsSnapshot.fromJson(result);
  }

  Future<IntegrationAvailabilitySnapshot> getIntegrationAvailability() async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'integration-availability:get',
      [],
    );
    return IntegrationAvailabilitySnapshot.fromJson(result);
  }

  Future<ProjectIntegrationsSettingsSnapshot> getProjectIntegrationsSettings(
    String workspacePath,
  ) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'project-integrations-settings:get',
      [workspacePath],
    );
    return ProjectIntegrationsSettingsSnapshot.fromJson(result);
  }

  Future<ProjectIntegrationsSettingsSnapshot> saveProjectIntegrationsSettings(
    ProjectIntegrationsSettingsSnapshot settings,
  ) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'project-integrations-settings:save',
      [settings.toJson()],
    );
    return ProjectIntegrationsSettingsSnapshot.fromJson(result);
  }

  Future<ProjectOrchestrationSettingsSnapshot> getProjectOrchestrationSettings(
    String workspacePath,
  ) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'project-orchestration-settings:get',
      [workspacePath],
    );
    return ProjectOrchestrationSettingsSnapshot.fromJson(result);
  }

  Future<ProjectOrchestrationSettingsSnapshot> saveProjectOrchestrationSettings(
    ProjectOrchestrationSettingsSnapshot settings,
  ) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'project-orchestration-settings:save',
      [settings.toJson()],
    );
    return ProjectOrchestrationSettingsSnapshot.fromJson(result);
  }

  Future<McpSettingsSnapshot> getMcpSettings() async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'mcp-settings:get',
      [],
    );
    return McpSettingsSnapshot.fromJson(result);
  }

  Future<SkillsListResult> listSkills(String workspacePath) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'skills:list',
      [workspacePath],
    );
    return SkillsListResult.fromJson(result);
  }

  Future<ProjectSkillsSettingsSnapshot> getProjectSkillsSettings(
    String workspacePath,
  ) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'project-skills-settings:get',
      [workspacePath],
    );
    return ProjectSkillsSettingsSnapshot.fromJson(result);
  }

  Future<ProjectSkillsSettingsSnapshot> saveProjectSkillsSettings(
    ProjectSkillsSettingsSnapshot settings,
  ) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'project-skills-settings:save',
      [settings.toJson()],
    );
    return ProjectSkillsSettingsSnapshot.fromJson(result);
  }

  Future<GitWorkingTreeStatus> getGitStatus(String workspacePath) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'git:get-status',
      [workspacePath],
    );
    return GitWorkingTreeStatus.fromJson(result);
  }

  Future<WorkspaceDiffResult> getWorkspaceDiff(String workspacePath) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'git:get-workspace-diff',
      [workspacePath],
    );
    return WorkspaceDiffResult.fromJson(result);
  }

  Future<WorkspaceFileDiffResult> getWorkspaceFileDiff({
    required String workspacePath,
    required String path,
  }) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'git:get-workspace-file-diff',
      [
        {'workspacePath': workspacePath, 'path': path},
      ],
    );
    return WorkspaceFileDiffResult.fromJson(result);
  }

  Future<GitWorkingTreeStatus> checkoutGitBranch({
    required String workspacePath,
    required String branch,
  }) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'git:checkout-branch',
      [
        {'workspacePath': workspacePath, 'branch': branch},
      ],
    );
    return GitWorkingTreeStatus.fromJson(result);
  }

  Future<GitWorkingTreeStatus> createGitBranch({
    required String workspacePath,
    required String branch,
  }) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'git:create-branch',
      [
        {'workspacePath': workspacePath, 'branch': branch},
      ],
    );
    return GitWorkingTreeStatus.fromJson(result);
  }

  Future<GitListCommitModelOptionsResult> listCommitModelOptions({
    String? mainAgentConfigId,
  }) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'git:list-commit-model-options',
      [
        {
          if (mainAgentConfigId != null && mainAgentConfigId.trim().isNotEmpty)
            'mainAgentConfigId': mainAgentConfigId.trim(),
        },
      ],
    );
    return GitListCommitModelOptionsResult.fromJson(result);
  }

  Future<GitListCommitModelOptionsResult> listApprovalModelOptions({
    String? mainAgentConfigId,
  }) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'approval:list-model-options',
      [
        {
          if (mainAgentConfigId != null && mainAgentConfigId.trim().isNotEmpty)
            'mainAgentConfigId': mainAgentConfigId.trim(),
        },
      ],
    );
    return GitListCommitModelOptionsResult.fromJson(result);
  }

  Future<void> saveCommitModelPreference({
    required String candidateModelId,
    String? mainAgentConfigId,
  }) async {
    await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'git:save-commit-model-preference',
      [
        {
          'candidateModelId': candidateModelId,
          if (mainAgentConfigId != null && mainAgentConfigId.trim().isNotEmpty)
            'mainAgentConfigId': mainAgentConfigId.trim(),
        },
      ],
    );
  }

  Future<GitGenerateCommitMessageResult> generateCommitMessage({
    required String workspacePath,
    String? mainAgentConfigId,
    bool includeUnstaged = true,
    String? candidateModelId,
  }) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'git:generate-commit-message',
      [
        {
          'workspacePath': workspacePath,
          'includeUnstaged': includeUnstaged,
          if (mainAgentConfigId != null && mainAgentConfigId.trim().isNotEmpty)
            'mainAgentConfigId': mainAgentConfigId.trim(),
          if (candidateModelId != null && candidateModelId.isNotEmpty)
            'candidateModelId': candidateModelId,
        },
      ],
      deadlineMs: 120000,
    );
    return GitGenerateCommitMessageResult.fromJson(result);
  }

  Future<GitCommitResult> commitChanges({
    required String workspacePath,
    String? mainAgentConfigId,
    bool includeUnstaged = true,
    String? message,
    String? candidateModelId,
  }) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'git:commit',
      [
        {
          'workspacePath': workspacePath,
          'includeUnstaged': includeUnstaged,
          if (mainAgentConfigId != null && mainAgentConfigId.trim().isNotEmpty)
            'mainAgentConfigId': mainAgentConfigId.trim(),
          if (message != null && message.isNotEmpty) 'message': message,
          if (candidateModelId != null && candidateModelId.isNotEmpty)
            'candidateModelId': candidateModelId,
        },
      ],
      deadlineMs: 120000,
    );
    return GitCommitResult.fromJson(result);
  }

  Future<GitPushResult> pushChanges({
    required String workspacePath,
    String? branch,
  }) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'git:push',
      [
        {
          'workspacePath': workspacePath,
          if (branch != null && branch.isNotEmpty) 'branch': branch,
        },
      ],
      deadlineMs: 120000,
    );
    return GitPushResult.fromJson(result);
  }

  Future<GitPullResult> pullChanges({
    required String workspacePath,
    String? branch,
  }) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'git:pull',
      [
        {
          'workspacePath': workspacePath,
          if (branch != null && branch.isNotEmpty) 'branch': branch,
        },
      ],
      deadlineMs: 120000,
    );
    return GitPullResult.fromJson(result);
  }

  Future<GitFetchResult> fetchChanges({required String workspacePath}) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'git:fetch',
      [
        {'workspacePath': workspacePath},
      ],
      deadlineMs: 120000,
    );
    return GitFetchResult.fromJson(result);
  }

  Future<PackageScriptsListResult> listPackageScripts(
    String workspacePath,
  ) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'workspace:list-package-scripts',
      [workspacePath],
    );
    return PackageScriptsListResult.fromJson(result);
  }

  Future<PackageScriptOverridesResult> savePackageScriptArgs({
    required String workspacePath,
    required String script,
    String? args,
    String? prefix,
  }) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'workspace:save-package-script-args',
      [
        {
          'workspacePath': workspacePath,
          'script': script,
          'args': ?args,
          'prefix': ?prefix,
        },
      ],
    );
    return PackageScriptOverridesResult.fromJson(result);
  }

  Future<StartPackageScriptResult> startPackageScript({
    required String workspacePath,
    required String script,
    String? args,
    String? prefix,
  }) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'workspace:start-package-script',
      [
        {
          'workspacePath': workspacePath,
          'script': script,
          if (args != null && args.isNotEmpty) 'args': args,
          if (prefix != null && prefix.isNotEmpty) 'prefix': prefix,
        },
      ],
      deadlineMs: 120000,
    );
    return StartPackageScriptResult.fromJson(result);
  }

  Future<BackgroundTerminalTask> getBackgroundTerminalTask(
    String taskId,
  ) async {
    final result = await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'background-terminal:open',
      [
        {'taskId': taskId},
      ],
    );
    return BackgroundTerminalTask.fromJson(result);
  }

  Future<void> stopBackgroundTerminalTask(String taskId) async {
    await _client.invoke<Map<String, dynamic>>(
      desktopDeviceId,
      'background-terminal:stop',
      [
        {'taskId': taskId},
      ],
    );
  }
}
