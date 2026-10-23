import '../utils/activity_display.dart';
import '../constants/session_mode.dart';
import 'acp_host_ui_features.dart';
import 'integration_models.dart';
import 'agent_orchestration.dart';
import 'composer_mcp.dart';
import 'mcp_models.dart';
import 'conversation_v2_projection_models.dart';
import 'thread_usage_models.dart';

export 'agent_orchestration.dart';

enum FollowUpDeliveryMode { queue, steer }

const subagentRoles = ['explore', 'architect', 'coder', 'reviewer', 'tester'];

Map<String, bool> defaultSubagentAvailability() {
  return {for (final role in subagentRoles) role: true};
}

Map<String, bool> normalizeSubagentAvailability(Map<String, bool>? input) {
  final availability = defaultSubagentAvailability();
  if (input == null) return availability;
  for (final role in subagentRoles) {
    if (input.containsKey(role)) {
      availability[role] = input[role] ?? true;
    }
  }
  return availability;
}

typedef BashReviewMode = String;
const bashReviewModes = ['always', 'auto', 'allow_all'];

String normalizeBashReviewMode(String? value) {
  if (value != null && bashReviewModes.contains(value)) {
    return value;
  }
  return 'always';
}

const mainAgentThinkingEfforts = {
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
};

class MainAgentModelOverride {
  const MainAgentModelOverride({
    required this.providerId,
    required this.modelId,
    this.thinkingEffort,
    this.candidateModelId,
  });

  factory MainAgentModelOverride.fromJson(Map<String, dynamic> json) {
    final providerId = _requiredMainAgentOverrideString(json, 'providerId');
    final modelId = _requiredMainAgentOverrideString(json, 'modelId');
    final thinkingEffort = json.containsKey('thinkingEffort')
        ? _requiredMainAgentOverrideString(json, 'thinkingEffort')
        : null;
    if (thinkingEffort != null &&
        !mainAgentThinkingEfforts.contains(thinkingEffort)) {
      throw FormatException(
        'Invalid mainAgentModelOverride.thinkingEffort: $thinkingEffort',
      );
    }
    final candidateModelId = json.containsKey('candidateModelId')
        ? _requiredMainAgentOverrideString(json, 'candidateModelId')
        : null;
    return MainAgentModelOverride(
      providerId: providerId,
      modelId: modelId,
      thinkingEffort: thinkingEffort,
      candidateModelId: candidateModelId,
    );
  }

  Map<String, dynamic> toJson() => {
    'providerId': providerId,
    'modelId': modelId,
    if (thinkingEffort != null) 'thinkingEffort': thinkingEffort,
    if (candidateModelId != null) 'candidateModelId': candidateModelId,
  };

  final String providerId;
  final String modelId;
  final String? thinkingEffort;
  final String? candidateModelId;
}

class AuxiliaryModelSelection {
  const AuxiliaryModelSelection({
    required this.providerId,
    required this.modelId,
    required this.candidateModelId,
  });

  factory AuxiliaryModelSelection.fromJson(Map<String, dynamic> json) {
    return AuxiliaryModelSelection(
      providerId: _requiredCandidateModelString(
        json,
        'providerId',
        'auxiliaryModel',
      ),
      modelId: _requiredCandidateModelString(json, 'modelId', 'auxiliaryModel'),
      candidateModelId: _requiredCandidateModelString(
        json,
        'candidateModelId',
        'auxiliaryModel',
      ),
    );
  }

  Map<String, dynamic> toJson() => {
    'providerId': providerId,
    'modelId': modelId,
    'candidateModelId': candidateModelId,
  };

  final String providerId;
  final String modelId;
  final String candidateModelId;
}

class ApprovalModelSelection {
  const ApprovalModelSelection({
    required this.providerId,
    required this.modelId,
    required this.candidateModelId,
  });

  factory ApprovalModelSelection.fromJson(Map<String, dynamic> json) {
    return ApprovalModelSelection(
      providerId: _requiredCandidateModelString(
        json,
        'providerId',
        'approvalModel',
      ),
      modelId: _requiredCandidateModelString(json, 'modelId', 'approvalModel'),
      candidateModelId: _requiredCandidateModelString(
        json,
        'candidateModelId',
        'approvalModel',
      ),
    );
  }

  Map<String, dynamic> toJson() => {
    'providerId': providerId,
    'modelId': modelId,
    'candidateModelId': candidateModelId,
  };

  final String providerId;
  final String modelId;
  final String candidateModelId;
}

class VisionModelSelection {
  const VisionModelSelection({
    required this.providerId,
    required this.modelId,
    required this.candidateModelId,
  });

  factory VisionModelSelection.fromJson(Map<String, dynamic> json) {
    return VisionModelSelection(
      providerId: _requiredCandidateModelString(
        json,
        'providerId',
        'visionModel',
      ),
      modelId: _requiredCandidateModelString(json, 'modelId', 'visionModel'),
      candidateModelId: _requiredCandidateModelString(
        json,
        'candidateModelId',
        'visionModel',
      ),
    );
  }

  Map<String, dynamic> toJson() => {
    'providerId': providerId,
    'modelId': modelId,
    'candidateModelId': candidateModelId,
  };

  final String providerId;
  final String modelId;
  final String candidateModelId;
}

class ThreadRuntimeConfig {
  const ThreadRuntimeConfig({
    this.cursorModelId,
    this.orchestrationSelection,
    this.resolvedOrchestrationSnapshot,
    required this.subagentEnabled,
    this.mcpServersEnabled,
    this.integrationsEnabled,
    this.skillsEnabled,
    this.mainAgentModelOverride,
    this.auxiliaryModel,
    this.approvalModel,
    this.visionModel,
    required this.sessionMode,
    required this.bashReviewMode,
  });

  factory ThreadRuntimeConfig.fromJson(Map<String, dynamic> json) {
    for (final key in const [
      'routeProfileId',
      'agentProfileId',
      'mainAgentConfigId',
      'mainPrompt',
      'subagentOrchestrationId',
      'resolvedProfileSnapshot',
    ]) {
      if (json.containsKey(key)) {
        throw FormatException('Unsupported legacy thread runtime field: $key');
      }
    }
    final rawCursorModelId = json['cursorModelId'];
    if (rawCursorModelId != null &&
        (rawCursorModelId is! String ||
            rawCursorModelId.trim().isEmpty ||
            rawCursorModelId.trim().length > 256)) {
      throw FormatException('Invalid cursorModelId');
    }
    final cursorModelId = (rawCursorModelId as String?)?.trim();
    final rawSubagents = json['subagentEnabled'];
    Map<String, bool>? parsedSubagents;
    if (rawSubagents is Map) {
      parsedSubagents = {
        for (final role in subagentRoles)
          role: rawSubagents[role] as bool? ?? true,
      };
    }
    final rawMcp = json['mcpServersEnabled'];
    Map<String, bool>? parsedMcp;
    if (rawMcp is Map) {
      parsedMcp = normalizeMcpServersEnabled(
        rawMcp.map((key, value) => MapEntry(key.toString(), value)),
      );
    }
    final legacyBrowserEnabled = parsedMcp?['eco_agent_browser'];
    parsedMcp?.remove('eco_agent_browser');
    final parsedIntegrations =
        normalizeIntegrationsEnabled(json['integrationsEnabled']) ??
        (legacyBrowserEnabled is bool
            ? <String, bool>{'browser': legacyBrowserEnabled}
            : null);
    final rawSkills = json['skillsEnabled'];
    Map<String, bool>? parsedSkills;
    if (rawSkills is Map) {
      parsedSkills = _normalizeBooleanSettings(rawSkills);
    }
    MainAgentModelOverride? mainAgentModelOverride;
    if (json.containsKey('mainAgentModelOverride')) {
      mainAgentModelOverride = MainAgentModelOverride.fromJson(
        _requiredJsonObject(
          json['mainAgentModelOverride'],
          'mainAgentModelOverride',
        ),
      );
    }
    AuxiliaryModelSelection? auxiliaryModel;
    if (json.containsKey('auxiliaryModel')) {
      auxiliaryModel = AuxiliaryModelSelection.fromJson(
        _requiredJsonObject(json['auxiliaryModel'], 'auxiliaryModel'),
      );
    }
    ApprovalModelSelection? approvalModel;
    if (json.containsKey('approvalModel')) {
      approvalModel = ApprovalModelSelection.fromJson(
        _requiredJsonObject(json['approvalModel'], 'approvalModel'),
      );
    }
    VisionModelSelection? visionModel;
    if (json.containsKey('visionModel')) {
      visionModel = VisionModelSelection.fromJson(
        _requiredJsonObject(json['visionModel'], 'visionModel'),
      );
    }
    OrchestrationSelection? orchestrationSelection;
    if (json.containsKey('orchestrationSelection')) {
      orchestrationSelection = OrchestrationSelection.fromJson(
        _requiredJsonObject(
          json['orchestrationSelection'],
          'orchestrationSelection',
        ),
      );
    }
    ResolvedOrchestrationSnapshot? resolvedOrchestrationSnapshot;
    if (json.containsKey('resolvedOrchestrationSnapshot')) {
      resolvedOrchestrationSnapshot = ResolvedOrchestrationSnapshot.fromJson(
        _requiredJsonObject(
          json['resolvedOrchestrationSnapshot'],
          'resolvedOrchestrationSnapshot',
        ),
      );
    }
    final sessionMode = normalizeSessionMode(json['sessionMode'] as String?);
    return ThreadRuntimeConfig(
      cursorModelId: cursorModelId,
      orchestrationSelection: orchestrationSelection,
      resolvedOrchestrationSnapshot: resolvedOrchestrationSnapshot,
      subagentEnabled: normalizeSubagentAvailability(parsedSubagents),
      mcpServersEnabled: parsedMcp,
      integrationsEnabled: parsedIntegrations,
      skillsEnabled: parsedSkills,
      mainAgentModelOverride: mainAgentModelOverride,
      auxiliaryModel: auxiliaryModel,
      approvalModel: approvalModel,
      visionModel: visionModel,
      sessionMode: sessionMode,
      bashReviewMode: json['bashReviewMode'] as String? ?? 'always',
    );
  }

  Map<String, dynamic> toJson() => {
    if (cursorModelId != null && cursorModelId!.trim().isNotEmpty)
      'cursorModelId': cursorModelId!.trim(),
    if (orchestrationSelection != null)
      'orchestrationSelection': orchestrationSelection!.toJson(),
    if (resolvedOrchestrationSnapshot != null)
      'resolvedOrchestrationSnapshot': resolvedOrchestrationSnapshot!.toJson(),
    'subagentEnabled': subagentEnabled,
    if (mcpServersEnabled != null) 'mcpServersEnabled': mcpServersEnabled,
    if (integrationsEnabled != null) 'integrationsEnabled': integrationsEnabled,
    if (skillsEnabled != null) 'skillsEnabled': skillsEnabled,
    if (mainAgentModelOverride != null)
      'mainAgentModelOverride': mainAgentModelOverride!.toJson(),
    if (auxiliaryModel != null) 'auxiliaryModel': auxiliaryModel!.toJson(),
    if (approvalModel != null) 'approvalModel': approvalModel!.toJson(),
    if (visionModel != null) 'visionModel': visionModel!.toJson(),
    'sessionMode': sessionMode,
    'bashReviewMode': bashReviewMode,
  };

  ThreadRuntimeConfig copyWith({
    String? cursorModelId,
    bool clearCursorModelId = false,
    OrchestrationSelection? orchestrationSelection,
    ResolvedOrchestrationSnapshot? resolvedOrchestrationSnapshot,
    bool clearOrchestrationSnapshot = false,
    Map<String, bool>? subagentEnabled,
    Map<String, bool>? mcpServersEnabled,
    Map<String, bool>? integrationsEnabled,
    Map<String, bool>? skillsEnabled,
    MainAgentModelOverride? mainAgentModelOverride,
    bool clearMainAgentModelOverride = false,
    AuxiliaryModelSelection? auxiliaryModel,
    ApprovalModelSelection? approvalModel,
    bool clearAuxiliaryModel = false,
    bool clearApprovalModel = false,
    VisionModelSelection? visionModel,
    bool clearVisionModel = false,
    SessionMode? sessionMode,
    String? bashReviewMode,
  }) {
    return ThreadRuntimeConfig(
      cursorModelId: clearCursorModelId
          ? null
          : (cursorModelId ?? this.cursorModelId),
      orchestrationSelection:
          orchestrationSelection ?? this.orchestrationSelection,
      resolvedOrchestrationSnapshot: clearOrchestrationSnapshot
          ? null
          : (resolvedOrchestrationSnapshot ??
                this.resolvedOrchestrationSnapshot),
      subagentEnabled: subagentEnabled ?? this.subagentEnabled,
      mcpServersEnabled: mcpServersEnabled ?? this.mcpServersEnabled,
      integrationsEnabled: integrationsEnabled ?? this.integrationsEnabled,
      skillsEnabled: skillsEnabled ?? this.skillsEnabled,
      mainAgentModelOverride: clearMainAgentModelOverride
          ? null
          : (mainAgentModelOverride ?? this.mainAgentModelOverride),
      auxiliaryModel: clearAuxiliaryModel
          ? null
          : (auxiliaryModel ?? this.auxiliaryModel),
      approvalModel: clearApprovalModel
          ? null
          : (approvalModel ?? this.approvalModel),
      visionModel: clearVisionModel ? null : (visionModel ?? this.visionModel),
      sessionMode: sessionMode ?? this.sessionMode,
      bashReviewMode: bashReviewMode ?? this.bashReviewMode,
    );
  }

  final String? cursorModelId;
  final OrchestrationSelection? orchestrationSelection;
  final ResolvedOrchestrationSnapshot? resolvedOrchestrationSnapshot;
  final Map<String, bool> subagentEnabled;
  final Map<String, bool>? mcpServersEnabled;
  final Map<String, bool>? integrationsEnabled;
  final Map<String, bool>? skillsEnabled;
  final MainAgentModelOverride? mainAgentModelOverride;
  final AuxiliaryModelSelection? auxiliaryModel;
  final ApprovalModelSelection? approvalModel;
  final VisionModelSelection? visionModel;
  final SessionMode sessionMode;
  final String bashReviewMode;
}

String _requiredMainAgentOverrideString(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! String || value.trim().isEmpty) {
    throw FormatException('Invalid mainAgentModelOverride.$key');
  }
  return value.trim();
}

String? _optionalTrimmedString(Object? value) {
  if (value == null) return null;
  if (value is! String) {
    throw const FormatException('Expected a string');
  }
  final trimmed = value.trim();
  return trimmed.isEmpty ? null : trimmed;
}

String _requiredCandidateModelString(
  Map<String, dynamic> json,
  String key,
  String field,
) {
  final value = json[key];
  if (value is! String || value.trim().isEmpty) {
    throw FormatException('Invalid $field.$key');
  }
  return value.trim();
}

Map<String, bool>? _normalizeBooleanSettings(Map<dynamic, dynamic> value) {
  final result = <String, bool>{};
  for (final entry in value.entries) {
    final key = entry.key.toString().trim();
    if (key.isNotEmpty && entry.value is bool) {
      result[key] = entry.value as bool;
    }
  }
  return result.isEmpty ? null : result;
}

Map<String, dynamic> _requiredJsonObject(Object? value, String field) {
  if (value is! Map) {
    throw FormatException('Invalid $field');
  }
  final result = <String, dynamic>{};
  for (final entry in value.entries) {
    if (entry.key is! String) {
      throw FormatException('Invalid $field');
    }
    result[entry.key as String] = entry.value;
  }
  return result;
}

Map<String, dynamic>? _optionalJsonObject(Object? value) {
  if (value is! Map) return null;
  return Map<String, dynamic>.from(value);
}

typedef ThreadRuntimeConfigInput = ThreadRuntimeConfig;

const defaultContextWindowLimitTokens = 262144;
const contextWindowLimitMin = 32768;
const contextWindowLimitMax = 1048576;
const contextWindowLimitPresets = <int>[131072, 262144, 524288, 1048576];

const defaultMaxOutputLimitTokens = 'dynamic';
const maxOutputLimitMin = 8192;
const maxOutputLimitMax = 262144;
Object normalizeMaxOutputLimitTokens(Object? value) =>
    value == defaultMaxOutputLimitTokens
    ? defaultMaxOutputLimitTokens
    : (_optionalLimitInRange(value, maxOutputLimitMin, maxOutputLimitMax) ??
          defaultMaxOutputLimitTokens);

const maxOutputLimitPresets = <int>[8192, 16384, 32768, 65536, 131072, 262144];

int? _optionalLimitInRange(Object? value, int min, int max) =>
    value is int && value >= min && value <= max ? value : null;

class GlobalSettingsDigest {
  const GlobalSettingsDigest({required this.digest});

  factory GlobalSettingsDigest.fromJson(Map<String, dynamic> json) {
    final digest = json['digest'];
    if (digest is! String || digest.trim().isEmpty) {
      throw const FormatException('Invalid settings digest');
    }
    return GlobalSettingsDigest(digest: digest.trim());
  }

  final String digest;
}

class WorkflowSettingsSnapshot {
  const WorkflowSettingsSnapshot({
    required this.sessionMode,
    this.defaultCoreKind,
    this.acpCursorModelId,
    this.showBilling = true,
    this.defaultBashReviewMode = 'always',
    this.contextWindowLimitTokens = defaultContextWindowLimitTokens,
    this.maxOutputLimitTokens = defaultMaxOutputLimitTokens,
    this.defaultOrchestrationSelection,
    this.defaultAuxiliaryModel,
    this.defaultApprovalModel,
    this.defaultVisionModel,
    this.mcpServersEnabled,
    this.integrationsEnabled,
  });

  factory WorkflowSettingsSnapshot.fromJson(Map<String, dynamic> json) {
    final rawMcp = json['mcpServersEnabled'];
    Map<String, bool>? parsedMcp;
    if (rawMcp is Map) {
      parsedMcp = normalizeMcpServersEnabled(
        rawMcp.map((key, value) => MapEntry(key.toString(), value)),
      );
    }
    final sessionMode = normalizeSessionMode(json['sessionMode'] as String?);
    final integrationsEnabled = normalizeIntegrationsEnabled(
      json['integrationsEnabled'],
    );
    OrchestrationSelection? defaultOrchestrationSelection;
    final rawOrchestration = _optionalJsonObject(
      json['defaultOrchestrationSelection'],
    );
    if (rawOrchestration != null) {
      try {
        defaultOrchestrationSelection = OrchestrationSelection.fromJson(
          rawOrchestration,
        );
      } on FormatException {
        // Desktop may omit / partially migrate selection; don't fail the
        // whole workflow snapshot and blank the settings UI.
        defaultOrchestrationSelection = null;
      }
    }
    AuxiliaryModelSelection? defaultAuxiliaryModel;
    if (json.containsKey('defaultAuxiliaryModel')) {
      defaultAuxiliaryModel = AuxiliaryModelSelection.fromJson(
        _requiredJsonObject(
          json['defaultAuxiliaryModel'],
          'defaultAuxiliaryModel',
        ),
      );
    }
    ApprovalModelSelection? defaultApprovalModel;
    if (json.containsKey('defaultApprovalModel')) {
      defaultApprovalModel = ApprovalModelSelection.fromJson(
        _requiredJsonObject(
          json['defaultApprovalModel'],
          'defaultApprovalModel',
        ),
      );
    }
    VisionModelSelection? defaultVisionModel;
    if (json.containsKey('defaultVisionModel')) {
      defaultVisionModel = VisionModelSelection.fromJson(
        _requiredJsonObject(json['defaultVisionModel'], 'defaultVisionModel'),
      );
    }
    return WorkflowSettingsSnapshot(
      sessionMode: sessionMode,
      defaultCoreKind: json['defaultCoreKind'] as String?,
      acpCursorModelId: _optionalTrimmedString(json['acpCursorModelId']),
      showBilling: json['showBilling'] != false,
      defaultBashReviewMode: normalizeBashReviewMode(
        json['defaultBashReviewMode'] as String?,
      ),
      contextWindowLimitTokens:
          _optionalLimitInRange(
            json['contextWindowLimitTokens'],
            contextWindowLimitMin,
            contextWindowLimitMax,
          ) ??
          defaultContextWindowLimitTokens,
      maxOutputLimitTokens: normalizeMaxOutputLimitTokens(
        json['maxOutputLimitTokens'],
      ),
      defaultOrchestrationSelection: defaultOrchestrationSelection,
      defaultAuxiliaryModel: defaultAuxiliaryModel,
      defaultApprovalModel: defaultApprovalModel,
      defaultVisionModel: defaultVisionModel,
      mcpServersEnabled: parsedMcp,
      integrationsEnabled: integrationsEnabled,
    );
  }

  Map<String, dynamic> toJson() => {
    'sessionMode': sessionMode,
    'planModelEnabled': sessionMode == 'plan',
    if (defaultCoreKind != null) 'defaultCoreKind': defaultCoreKind,
    if (acpCursorModelId != null && acpCursorModelId!.isNotEmpty)
      'acpCursorModelId': acpCursorModelId,
    'showBilling': showBilling,
    'defaultBashReviewMode': defaultBashReviewMode,
    'contextWindowLimitTokens': contextWindowLimitTokens,
    'maxOutputLimitTokens': maxOutputLimitTokens,
    if (defaultOrchestrationSelection != null)
      'defaultOrchestrationSelection': defaultOrchestrationSelection!.toJson(),
    if (defaultAuxiliaryModel != null)
      'defaultAuxiliaryModel': defaultAuxiliaryModel!.toJson(),
    if (defaultApprovalModel != null)
      'defaultApprovalModel': defaultApprovalModel!.toJson(),
    if (defaultVisionModel != null)
      'defaultVisionModel': defaultVisionModel!.toJson(),
    if (mcpServersEnabled != null) 'mcpServersEnabled': mcpServersEnabled,
    if (integrationsEnabled != null) 'integrationsEnabled': integrationsEnabled,
  };

  final SessionMode sessionMode;
  final String? defaultCoreKind;
  final String? acpCursorModelId;
  final bool showBilling;
  final String defaultBashReviewMode;
  final int contextWindowLimitTokens;
  // Either a fixed token count or the dynamic mode persisted by desktop.
  final Object maxOutputLimitTokens;
  final OrchestrationSelection? defaultOrchestrationSelection;
  final AuxiliaryModelSelection? defaultAuxiliaryModel;
  final ApprovalModelSelection? defaultApprovalModel;
  final VisionModelSelection? defaultVisionModel;
  final Map<String, bool>? mcpServersEnabled;
  final Map<String, bool>? integrationsEnabled;
}

class PromptImageAttachment {
  const PromptImageAttachment({
    required this.mediaType,
    required this.data,
    this.id,
    this.path,
    this.contentRef,
    this.byteLength,
    this.uploadProgress,
    this.uploadFailed = false,
  });

  factory PromptImageAttachment.fromJson(Map<String, dynamic> json) =>
      PromptImageAttachment(
        id: json['id'] as String?,
        mediaType: json['mediaType'] as String? ?? 'image/jpeg',
        data: json['data'] as String? ?? '',
        path: json['path'] as String?,
        contentRef: json['contentRef'] as String?,
        byteLength: (json['byteLength'] as num?)?.toInt(),
      );

  /// Local preview / UI copy. Wire payloads use [toWireJson].
  Map<String, dynamic> toJson() => {
    'mediaType': mediaType,
    if (id != null && id!.isNotEmpty) 'id': id,
    if (data.isNotEmpty) 'data': data,
    if (path != null && path!.isNotEmpty) 'path': path,
    if (contentRef != null && contentRef!.isNotEmpty) 'contentRef': contentRef,
    if (byteLength != null) 'byteLength': byteLength,
  };

  /// Desktop thread RPC payload: prefer staged path so large base64 is not
  /// shipped again through Center.
  Map<String, dynamic> toWireJson() {
    final staged = path?.trim() ?? '';
    if (staged.isNotEmpty) {
      return {
        'mediaType': mediaType,
        'path': staged,
        if (contentRef != null && contentRef!.isNotEmpty)
          'contentRef': contentRef,
        if (byteLength != null) 'byteLength': byteLength,
      };
    }
    if (contentRef != null && contentRef!.isNotEmpty) {
      return {
        'mediaType': mediaType,
        'contentRef': contentRef,
        if (data.isNotEmpty) 'data': data,
        if (byteLength != null) 'byteLength': byteLength,
      };
    }
    return {'mediaType': mediaType, 'data': data};
  }

  PromptImageAttachment copyWith({
    String? id,
    String? mediaType,
    String? data,
    String? path,
    String? contentRef,
    int? byteLength,
    double? uploadProgress,
    bool clearUploadProgress = false,
    bool? uploadFailed,
  }) {
    return PromptImageAttachment(
      id: id ?? this.id,
      mediaType: mediaType ?? this.mediaType,
      data: data ?? this.data,
      path: path ?? this.path,
      contentRef: contentRef ?? this.contentRef,
      byteLength: byteLength ?? this.byteLength,
      uploadProgress: clearUploadProgress
          ? null
          : (uploadProgress ?? this.uploadProgress),
      uploadFailed: uploadFailed ?? this.uploadFailed,
    );
  }

  final String? id;
  final String mediaType;
  final String data;
  final String? path;
  final String? contentRef;
  final int? byteLength;

  /// 0..1 while uploading; null when idle / finished.
  final double? uploadProgress;
  final bool uploadFailed;
}

class ComposerDraftRecord {
  const ComposerDraftRecord({
    required this.contextKey,
    required this.prompt,
    required this.revision,
    required this.updatedAt,
    this.attachments = const [],
    this.recoveryReason,
  });

  factory ComposerDraftRecord.fromJson(Map<String, dynamic> json) {
    final rawAttachments = json['attachments'];
    return ComposerDraftRecord(
      contextKey: json['contextKey'] as String? ?? '',
      prompt: json['prompt'] as String? ?? '',
      revision: json['revision'] as String? ?? '',
      updatedAt: json['updatedAt'] as String? ?? '',
      recoveryReason: json['recoveryReason'] as String?,
      attachments: rawAttachments is List
          ? rawAttachments
                .whereType<Map>()
                .map(
                  (entry) => PromptImageAttachment.fromJson(
                    Map<String, dynamic>.from(entry),
                  ),
                )
                .where(
                  (attachment) =>
                      (attachment.data.isNotEmpty ||
                          (attachment.path?.isNotEmpty ?? false) ||
                          (attachment.contentRef?.isNotEmpty ?? false)) &&
                      _isSupportedPromptImageMediaType(attachment.mediaType),
                )
                .toList(growable: false)
          : const [],
    );
  }

  final String contextKey;
  final String prompt;
  final List<PromptImageAttachment> attachments;
  final String? recoveryReason;
  final String revision;
  final String updatedAt;
}

class ComposerRestore {
  const ComposerRestore({
    required this.prompt,
    required this.attachments,
    required this.revision,
    this.reason,
  });

  factory ComposerRestore.fromJson(Map<String, dynamic> json) {
    final rawAttachments = json['attachments'];
    return ComposerRestore(
      prompt: json['prompt'] as String? ?? '',
      attachments: rawAttachments is List
          ? rawAttachments
                .whereType<Map>()
                .map(
                  (entry) => PromptImageAttachment.fromJson(
                    Map<String, dynamic>.from(entry),
                  ),
                )
                .where(
                  (attachment) =>
                      (attachment.data.isNotEmpty ||
                          (attachment.path?.isNotEmpty ?? false) ||
                          (attachment.contentRef?.isNotEmpty ?? false)) &&
                      _isSupportedPromptImageMediaType(attachment.mediaType),
                )
                .toList(growable: false)
          : const [],
      revision: json['revision'] as String? ?? '',
      reason: json['reason'] as String?,
    );
  }

  final String prompt;
  final List<PromptImageAttachment> attachments;
  final String revision;
  final String? reason;
}

bool _isSupportedPromptImageMediaType(String value) =>
    value == 'image/jpeg' ||
    value == 'image/png' ||
    value == 'image/gif' ||
    value == 'image/webp';

typedef ThreadStatus = String;

class ThreadSummary {
  const ThreadSummary({
    required this.id,
    required this.title,
    required this.prompt,
    required this.workspacePath,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    required this.message,
    this.coreKind,
    this.runtimeConfig,
    this.hostUiFeatures = AcpHostUiFeatures.showAll,
    this.cancelling = false,
    this.titleGenerating = false,
    this.followUpQueuePaused = false,
  });

  factory ThreadSummary.fromJson(Map<String, dynamic> json) => ThreadSummary(
    id: json['id'] as String? ?? '',
    title: json['title'] as String? ?? '',
    prompt: json['prompt'] as String? ?? '',
    workspacePath: json['workspacePath'] as String? ?? '',
    status: json['status'] as String? ?? 'idle',
    createdAt: json['createdAt'] as String? ?? '',
    updatedAt: json['updatedAt'] as String? ?? '',
    message: json['message'] as String? ?? '',
    coreKind: json['coreKind'] as String?,
    runtimeConfig: json['runtimeConfig'] != null
        ? ThreadRuntimeConfig.fromJson(
            json['runtimeConfig'] as Map<String, dynamic>,
          )
        : null,
    hostUiFeatures: AcpHostUiFeatures.fromJson(json['hostUiFeatures']),
    cancelling: json['cancelling'] == true,
    titleGenerating: json['titleGenerating'] == true,
    followUpQueuePaused: json['followUpQueuePaused'] == true,
  );

  ThreadSummary copyWith({
    String? title,
    String? prompt,
    String? workspacePath,
    String? status,
    String? createdAt,
    String? updatedAt,
    String? message,
    String? coreKind,
    ThreadRuntimeConfig? runtimeConfig,
    AcpHostUiFeatures? hostUiFeatures,
    bool? cancelling,
    bool? titleGenerating,
    bool? followUpQueuePaused,
  }) {
    return ThreadSummary(
      id: id,
      title: title ?? this.title,
      prompt: prompt ?? this.prompt,
      workspacePath: workspacePath ?? this.workspacePath,
      status: status ?? this.status,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      message: message ?? this.message,
      coreKind: coreKind ?? this.coreKind,
      runtimeConfig: runtimeConfig ?? this.runtimeConfig,
      hostUiFeatures: hostUiFeatures ?? this.hostUiFeatures,
      cancelling: cancelling ?? this.cancelling,
      titleGenerating: titleGenerating ?? this.titleGenerating,
      followUpQueuePaused: followUpQueuePaused ?? this.followUpQueuePaused,
    );
  }

  final String id;
  final String title;
  final String prompt;
  final String workspacePath;
  final String status;
  final String createdAt;
  final String updatedAt;
  final String message;
  final String? coreKind;
  final ThreadRuntimeConfig? runtimeConfig;
  final AcpHostUiFeatures hostUiFeatures;
  final bool cancelling;

  /// Live-only: desktop is currently auto-generating this thread's title.
  final bool titleGenerating;
  final bool followUpQueuePaused;
}

class ThreadListCursor {
  const ThreadListCursor({
    required this.updatedAt,
    required this.createdAt,
    required this.id,
  });

  factory ThreadListCursor.fromJson(Map<String, dynamic> json) =>
      ThreadListCursor(
        updatedAt: json['updatedAt'] as String? ?? '',
        createdAt: json['createdAt'] as String? ?? '',
        id: json['id'] as String? ?? '',
      );

  Map<String, dynamic> toJson() => {
    'updatedAt': updatedAt,
    'createdAt': createdAt,
    'id': id,
  };

  final String updatedAt;
  final String createdAt;
  final String id;
}

class ThreadListPageMetadata {
  const ThreadListPageMetadata({
    required this.hasMore,
    required this.totalCount,
    this.nextCursor,
  });

  factory ThreadListPageMetadata.fromJson(Map<String, dynamic> json) =>
      ThreadListPageMetadata(
        hasMore: json['hasMore'] == true,
        totalCount: (json['totalCount'] as num?)?.toInt() ?? 0,
        nextCursor: json['nextCursor'] is Map
            ? ThreadListCursor.fromJson(
                Map<String, dynamic>.from(json['nextCursor'] as Map),
              )
            : null,
      );

  final bool hasMore;
  final int totalCount;
  final ThreadListCursor? nextCursor;
}

class ThreadListPage extends ThreadListPageMetadata {
  const ThreadListPage({
    required this.threads,
    required super.hasMore,
    required super.totalCount,
    super.nextCursor,
  });

  factory ThreadListPage.fromJson(Map<String, dynamic> json) {
    final rawThreads = json['threads'];
    return ThreadListPage(
      threads: rawThreads is List
          ? rawThreads
                .whereType<Map>()
                .map(
                  (entry) =>
                      ThreadSummary.fromJson(Map<String, dynamic>.from(entry)),
                )
                .toList()
          : const [],
      hasMore: json['hasMore'] == true,
      totalCount: (json['totalCount'] as num?)?.toInt() ?? 0,
      nextCursor: json['nextCursor'] is Map
          ? ThreadListCursor.fromJson(
              Map<String, dynamic>.from(json['nextCursor'] as Map),
            )
          : null,
    );
  }

  final List<ThreadSummary> threads;
}

class ThreadListInitialResult {
  const ThreadListInitialResult({required this.threads, required this.pages});

  factory ThreadListInitialResult.fromJson(Map<String, dynamic> json) {
    final rawThreads = json['threads'];
    final rawPages = json['pages'];
    final pages = <String, ThreadListPageMetadata>{};
    if (rawPages is Map) {
      for (final entry in rawPages.entries) {
        if (entry.key is! String || entry.value is! Map) continue;
        pages[entry.key as String] = ThreadListPageMetadata.fromJson(
          Map<String, dynamic>.from(entry.value as Map),
        );
      }
    }
    return ThreadListInitialResult(
      threads: rawThreads is List
          ? rawThreads
                .whereType<Map>()
                .map(
                  (entry) =>
                      ThreadSummary.fromJson(Map<String, dynamic>.from(entry)),
                )
                .toList()
          : const [],
      pages: pages,
    );
  }

  final List<ThreadSummary> threads;
  final Map<String, ThreadListPageMetadata> pages;
}

/// Remote `thread:list` omits `runtimeConfig`. Keep the session-locked copy.
ThreadSummary mergeThreadSummaryFromRemoteList({
  required ThreadSummary current,
  required ThreadSummary listed,
}) {
  return ThreadSummary(
    id: listed.id,
    title: listed.title,
    prompt: listed.prompt,
    workspacePath: listed.workspacePath,
    status: listed.status,
    createdAt: listed.createdAt,
    updatedAt: listed.updatedAt,
    message: listed.message,
    coreKind: listed.coreKind ?? current.coreKind,
    runtimeConfig: listed.runtimeConfig ?? current.runtimeConfig,
    hostUiFeatures: listed.hostUiFeatures,
    cancelling: listed.cancelling,
    followUpQueuePaused: listed.followUpQueuePaused,
  );
}

class CoderTodoItem {
  const CoderTodoItem({
    required this.id,
    required this.threadId,
    required this.title,
    required this.detail,
    required this.status,
    required this.position,
    required this.updatedAt,
  });

  factory CoderTodoItem.fromJson(Map<String, dynamic> json) => CoderTodoItem(
    id: json['id'] as String? ?? '',
    threadId: json['threadId'] as String? ?? '',
    title: json['title'] as String? ?? '',
    detail: json['detail'] as String? ?? '',
    status: json['status'] as String? ?? 'pending',
    position: (json['position'] as num?)?.toInt() ?? 0,
    updatedAt: json['updatedAt'] as String? ?? '',
  );

  final String id;
  final String threadId;
  final String title;
  final String detail;
  final String status;
  final int position;
  final String updatedAt;
}

class ThreadApiErrorInfo {
  const ThreadApiErrorInfo({
    required this.message,
    this.statusCode,
    this.code,
    this.model,
  });

  factory ThreadApiErrorInfo.fromJson(Map<String, dynamic> json) =>
      ThreadApiErrorInfo(
        message: json['message'] as String? ?? '',
        statusCode: json['statusCode'] as int?,
        code: json['code'] as String?,
        model: json['model'] as String?,
      );

  final String message;
  final int? statusCode;
  final String? code;
  final String? model;
}

class ThreadActivityLine {
  const ThreadActivityLine({
    required this.id,
    required this.role,
    required this.message,
    this.stream,
    this.rewindTarget,
    this.agentId,
    this.apiError,
  });

  factory ThreadActivityLine.fromJson(Map<String, dynamic> json) =>
      ThreadActivityLine(
        id: json['id'] as String? ?? '',
        role: json['role'] as String? ?? 'assistant',
        message: json['message'] as String? ?? '',
        stream: json['stream'] as bool?,
        rewindTarget: _readThreadActivityRewindTarget(json['rewindTarget']),
        agentId: json['agentId'] as String?,
        apiError: json['apiError'] is Map<String, dynamic>
            ? ThreadApiErrorInfo.fromJson(
                json['apiError'] as Map<String, dynamic>,
              )
            : null,
      );

  final String id;
  final String role;
  final String message;
  final bool? stream;
  final ThreadActivityRewindTarget? rewindTarget;
  final String? agentId;
  final ThreadApiErrorInfo? apiError;
}

ThreadActivityRewindTarget? _readThreadActivityRewindTarget(dynamic value) {
  if (value is! Map<String, dynamic>) return null;
  final activityLineId = value['activityLineId'];
  if (activityLineId is! String || activityLineId.trim().isEmpty) return null;
  return ThreadActivityRewindTarget.fromJson(value);
}

class ThreadActivityRewindTarget {
  const ThreadActivityRewindTarget({
    required this.activityLineId,
    this.userMessageId,
  });

  factory ThreadActivityRewindTarget.fromJson(Map<String, dynamic> json) {
    final activityLineId = json['activityLineId'] as String? ?? '';
    if (activityLineId.trim().isEmpty) {
      throw const FormatException('Missing activityLineId in rewind target.');
    }
    final userMessageId = json['userMessageId'] as String?;
    return ThreadActivityRewindTarget(
      activityLineId: activityLineId,
      userMessageId: userMessageId?.trim().isEmpty == true
          ? null
          : userMessageId?.trim(),
    );
  }

  Map<String, dynamic> toJson() => {
    'activityLineId': activityLineId,
    if (userMessageId != null) 'userMessageId': userMessageId,
  };

  final String activityLineId;
  final String? userMessageId;
}

class ThreadUserMessageEditCapability {
  const ThreadUserMessageEditCapability({
    required this.status,
    this.reasonCode,
    this.reason,
  });

  factory ThreadUserMessageEditCapability.fromJson(Map<String, dynamic> json) =>
      ThreadUserMessageEditCapability(
        status: json['status'] == 'ready' ? 'ready' : 'unavailable',
        reasonCode: json['reasonCode'] as String?,
        reason: json['reason'] as String?,
      );

  final String status;
  final String? reasonCode;
  final String? reason;

  bool get isReady => status == 'ready';
}

class ThreadUserMessageEditGetResult {
  const ThreadUserMessageEditGetResult({
    required this.threadId,
    required this.activityLineId,
    required this.text,
    required this.attachments,
    required this.capability,
    required this.historyRevision,
    this.upstreamMessageId,
  });

  factory ThreadUserMessageEditGetResult.fromJson(Map<String, dynamic> json) {
    final attachments = (json['attachments'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(PromptImageAttachment.fromJson)
        .where(
          (attachment) =>
              attachment.data.trim().isNotEmpty ||
              (attachment.contentRef?.isNotEmpty ?? false),
        )
        .toList(growable: false);
    final capabilityJson = json['capability'];
    return ThreadUserMessageEditGetResult(
      threadId: json['threadId'] as String? ?? '',
      activityLineId: json['activityLineId'] as String? ?? '',
      upstreamMessageId: json['upstreamMessageId'] as String?,
      text: json['text'] as String? ?? '',
      attachments: attachments,
      capability: capabilityJson is Map<String, dynamic>
          ? ThreadUserMessageEditCapability.fromJson(capabilityJson)
          : const ThreadUserMessageEditCapability(status: 'unavailable'),
      historyRevision: (json['historyRevision'] as num?)?.toInt() ?? 0,
    );
  }

  final String threadId;
  final String activityLineId;
  final String? upstreamMessageId;
  final String text;
  final List<PromptImageAttachment> attachments;
  final ThreadUserMessageEditCapability capability;
  final int historyRevision;
}

class ThreadPendingPlan {
  const ThreadPendingPlan({
    required this.threadId,
    required this.userPrompt,
    required this.analysis,
    required this.plan,
    required this.workspacePath,
    required this.worktreePath,
    this.planFilePath,
  });

  factory ThreadPendingPlan.fromJson(Map<String, dynamic> json) =>
      ThreadPendingPlan(
        threadId: json['threadId'] as String? ?? '',
        userPrompt: json['userPrompt'] as String? ?? '',
        analysis: json['analysis'] as String? ?? '',
        plan: json['plan'] as String? ?? '',
        workspacePath: json['workspacePath'] as String? ?? '',
        worktreePath: json['worktreePath'] as String? ?? '',
        planFilePath: json['planFilePath'] as String?,
      );

  final String threadId;
  final String userPrompt;
  final String analysis;
  final String plan;
  final String workspacePath;
  final String worktreePath;
  final String? planFilePath;
}

class ClarificationQuestionOption {
  const ClarificationQuestionOption({
    required this.label,
    this.description,
    this.recommended,
  });

  factory ClarificationQuestionOption.fromJson(Map<String, dynamic> json) =>
      ClarificationQuestionOption(
        label: json['label'] as String? ?? '',
        description: json['description'] as String?,
        recommended: json['recommended'] as bool?,
      );

  final String label;
  final String? description;
  final bool? recommended;
}

class ClarificationQuestion {
  const ClarificationQuestion({
    required this.question,
    this.header,
    required this.options,
    this.multiSelect,
    this.allowCustom,
    this.preserveCustomText,
  });

  factory ClarificationQuestion.fromJson(Map<String, dynamic> json) =>
      ClarificationQuestion(
        question: json['question'] as String? ?? '',
        header: json['header'] as String?,
        options: (json['options'] as List<dynamic>? ?? [])
            .map(
              (e) => ClarificationQuestionOption.fromJson(
                e as Map<String, dynamic>,
              ),
            )
            .toList(),
        multiSelect: json['multiSelect'] as bool?,
        allowCustom: json['allowCustom'] as bool?,
        preserveCustomText: json['preserveCustomText'] as bool?,
      );

  final String question;
  final String? header;
  final List<ClarificationQuestionOption> options;
  final bool? multiSelect;
  final bool? allowCustom;
  final bool? preserveCustomText;
}

class ClarificationRequest {
  const ClarificationRequest({
    required this.toolUseId,
    required this.threadId,
    required this.questions,
  });

  factory ClarificationRequest.fromJson(Map<String, dynamic> json) =>
      ClarificationRequest(
        toolUseId: json['toolUseId'] as String? ?? '',
        threadId: json['threadId'] as String? ?? '',
        questions: (json['questions'] as List<dynamic>? ?? [])
            .map(
              (e) => ClarificationQuestion.fromJson(e as Map<String, dynamic>),
            )
            .toList(),
      );

  final String toolUseId;
  final String threadId;
  final List<ClarificationQuestion> questions;
}

class BashApprovalRequest {
  const BashApprovalRequest({
    required this.toolUseId,
    required this.threadId,
    required this.command,
    required this.cwd,
    required this.reason,
    required this.riskScore,
    required this.riskLevel,
    this.description,
    this.reviewRationale,
    this.filesystemTool,
    this.filesystemPath,
    this.agentId,
    this.defaultToNo = false,
    this.suppressAlwaysAllowRule = false,
    this.mcpToolServerName,
    this.mcpToolName,
  });

  factory BashApprovalRequest.fromJson(Map<String, dynamic> json) =>
      BashApprovalRequest(
        toolUseId: json['toolUseId'] as String? ?? '',
        threadId: json['threadId'] as String? ?? '',
        command: json['command'] as String? ?? '',
        cwd: json['cwd'] as String? ?? '',
        reason: json['reason'] as String? ?? '',
        riskScore: (json['riskScore'] as num?)?.toInt() ?? 0,
        riskLevel: json['riskLevel'] as String? ?? 'medium',
        description: json['description'] as String?,
        reviewRationale: json['reviewRationale'] as String?,
        filesystemTool: json['filesystemTool'] as String?,
        filesystemPath: json['filesystemPath'] as String?,
        agentId: json['agentId'] as String?,
        defaultToNo: json['defaultToNo'] == true,
        suppressAlwaysAllowRule: json['suppressAlwaysAllowRule'] == true,
        mcpToolServerName:
            (json['mcpToolApproval'] as Map<String, dynamic>?)?['serverName']
                as String?,
        mcpToolName:
            (json['mcpToolApproval'] as Map<String, dynamic>?)?['toolName']
                as String?,
      );

  final String toolUseId;
  final String threadId;
  final String command;
  final String cwd;
  final String reason;
  final int riskScore;
  final String riskLevel;
  final String? description;
  final String? reviewRationale;
  final String? filesystemTool;
  final String? filesystemPath;
  final String? agentId;
  final bool defaultToNo;
  final bool suppressAlwaysAllowRule;
  final String? mcpToolServerName;
  final String? mcpToolName;
}

class ThreadPendingFollowUp {
  const ThreadPendingFollowUp({
    required this.id,
    required this.threadId,
    required this.prompt,
    required this.status,
    required this.createdAt,
    this.priority = 'normal',
    this.updatedAt = '',
    this.queuePosition,
    this.attachments = const [],
  });

  factory ThreadPendingFollowUp.fromJson(Map<String, dynamic> json) =>
      ThreadPendingFollowUp(
        id: json['id'] as String? ?? '',
        threadId: json['threadId'] as String? ?? '',
        prompt: json['prompt'] as String? ?? '',
        status: json['status'] as String? ?? 'queued',
        createdAt: json['createdAt'] as String? ?? '',
        updatedAt: json['updatedAt'] as String? ?? '',
        priority: json['priority'] as String? ?? 'normal',
        queuePosition: (json['queuePosition'] as num?)?.toInt(),
        attachments: (json['attachments'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(PromptImageAttachment.fromJson)
            .where(
              (attachment) =>
                  attachment.data.isNotEmpty ||
                  (attachment.path?.isNotEmpty ?? false) ||
                  (attachment.contentRef?.isNotEmpty ?? false),
            )
            .toList(),
      );

  final String id;
  final String threadId;
  final String prompt;
  final String status;
  final String createdAt;
  final String updatedAt;
  final String priority;
  final int? queuePosition;
  final List<PromptImageAttachment> attachments;
}

class ThreadSessionBootstrapResult {
  const ThreadSessionBootstrapResult({
    this.thread,
    this.followUps = const [],
    this.pendingPlan,
    this.pendingBash,
    this.pendingClarification,
  });

  factory ThreadSessionBootstrapResult.fromJson(Map<String, dynamic> json) {
    final followUpsRaw = json['followUps'] as List<dynamic>? ?? const [];
    return ThreadSessionBootstrapResult(
      thread: json['thread'] is Map<String, dynamic>
          ? ThreadSummary.fromJson(json['thread'] as Map<String, dynamic>)
          : null,
      followUps: followUpsRaw
          .map(
            (entry) =>
                ThreadPendingFollowUp.fromJson(entry as Map<String, dynamic>),
          )
          .toList(),
      pendingPlan: json['pendingPlan'] is Map<String, dynamic>
          ? ThreadPendingPlan.fromJson(
              json['pendingPlan'] as Map<String, dynamic>,
            )
          : null,
      pendingBash: json['pendingBash'] is Map<String, dynamic>
          ? BashApprovalRequest.fromJson(
              json['pendingBash'] as Map<String, dynamic>,
            )
          : null,
      pendingClarification: json['pendingClarification'] is Map<String, dynamic>
          ? ClarificationRequest.fromJson(
              json['pendingClarification'] as Map<String, dynamic>,
            )
          : null,
    );
  }

  final ThreadSummary? thread;
  final List<ThreadPendingFollowUp> followUps;
  final ThreadPendingPlan? pendingPlan;
  final BashApprovalRequest? pendingBash;
  final ClarificationRequest? pendingClarification;
}

class ThreadLiveEvent {
  const ThreadLiveEvent({
    required this.threadId,
    required this.type,
    required this.message,
    this.role,
    this.stream,
    this.activityLine,
    this.plan,
    this.clarification,
    this.bashApproval,
    this.followUp,
    this.runtimeConfig,
    this.projection,
    this.subagentSessions,
    this.billing,
    this.contextSnapshot,
    this.title,
    this.titleGenerating,
    this.tool,
    this.cancelling,
    this.settingsDigest,
    this.composerRestore,
    this.followUpQueuePaused,
  });

  factory ThreadLiveEvent.fromJson(Map<String, dynamic> json) {
    final projectionRaw = json['projection'];
    final sessionsRaw = json['subagentSessions'];
    final settingsDigestRaw = json['settingsDigest'];
    return ThreadLiveEvent(
      threadId: json['threadId'] as String? ?? '',
      type: json['type'] as String? ?? '',
      message: json['message'] as String? ?? '',
      role: json['role'] as String?,
      stream: json['stream'] as bool?,
      activityLine: json['activityLine'] != null
          ? ThreadActivityLine.fromJson(
              json['activityLine'] as Map<String, dynamic>,
            )
          : null,
      plan: json['plan'] != null
          ? ThreadPendingPlan.fromJson({
              ...json['plan'] as Map<String, dynamic>,
              'threadId': json['threadId'],
            })
          : null,
      clarification: json['clarification'] != null
          ? ClarificationRequest.fromJson(
              json['clarification'] as Map<String, dynamic>,
            )
          : null,
      bashApproval: json['bashApproval'] != null
          ? BashApprovalRequest.fromJson(
              json['bashApproval'] as Map<String, dynamic>,
            )
          : null,
      followUp: json['followUp'] != null
          ? ThreadPendingFollowUp.fromJson(
              json['followUp'] as Map<String, dynamic>,
            )
          : null,
      runtimeConfig: json['runtimeConfig'] != null
          ? ThreadRuntimeConfig.fromJson(
              json['runtimeConfig'] as Map<String, dynamic>,
            )
          : null,
      projection: projectionRaw is Map<String, dynamic>
          ? ThreadRunProjectionSnapshot.fromJson(
              projectionRaw,
              includeToolOutputPreview: false,
            )
          : null,
      subagentSessions: sessionsRaw is List
          ? sessionsRaw
                .map(
                  (entry) => ThreadSubagentSessionTiming.fromJson(
                    entry as Map<String, dynamic>,
                  ),
                )
                .toList()
          : null,
      billing: json['billing'] is Map<String, dynamic>
          ? ThreadBillingSnapshot.fromJson(
              json['billing'] as Map<String, dynamic>,
            )
          : null,
      contextSnapshot: json['context'] is Map<String, dynamic>
          ? ThreadContextSnapshot.fromJson(
              json['context'] as Map<String, dynamic>,
            )
          : null,
      title: json['title'] as String?,
      titleGenerating: json['titleGenerating'] as bool?,
      tool: json['tool'] is Map<String, dynamic>
          ? threadRunToolMetadataFromJson(
              json['tool'] as Map<String, dynamic>,
              includeOutputPreview: false,
            )
          : null,
      cancelling: json['cancelling'] as bool?,
      settingsDigest:
          settingsDigestRaw is String && settingsDigestRaw.trim().isNotEmpty
          ? settingsDigestRaw.trim()
          : null,
      composerRestore: json['composerRestore'] is Map
          ? ComposerRestore.fromJson({
              ...Map<String, dynamic>.from(json['composerRestore'] as Map),
              'reason': json['message'],
            })
          : null,
      followUpQueuePaused: json['followUpQueuePaused'] as bool?,
    );
  }

  final String threadId;
  final String type;
  final String message;
  final String? role;
  final bool? stream;
  final ThreadActivityLine? activityLine;
  final ThreadPendingPlan? plan;
  final ClarificationRequest? clarification;
  final BashApprovalRequest? bashApproval;
  final ThreadPendingFollowUp? followUp;
  final ThreadRuntimeConfig? runtimeConfig;
  final ThreadRunProjectionSnapshot? projection;
  final List<ThreadSubagentSessionTiming>? subagentSessions;
  final ThreadBillingSnapshot? billing;
  final ThreadContextSnapshot? contextSnapshot;
  final String? title;
  final bool? titleGenerating;
  final ThreadRunToolMetadata? tool;
  final bool? cancelling;
  final String? settingsDigest;
  final ComposerRestore? composerRestore;
  final bool? followUpQueuePaused;
}

class WorkspaceInfo {
  const WorkspaceInfo({
    required this.path,
    required this.name,
    required this.isGitRepository,
    this.branch,
    this.dirtyFileCount = 0,
  });

  factory WorkspaceInfo.fromJson(Map<String, dynamic> json) => WorkspaceInfo(
    path: json['path'] as String? ?? '',
    name: json['name'] as String? ?? '',
    isGitRepository: json['isGitRepository'] as bool? ?? false,
    branch: json['branch'] as String?,
    dirtyFileCount: (json['dirtyFileCount'] as num?)?.toInt() ?? 0,
  );

  final String path;
  final String name;
  final bool isGitRepository;
  final String? branch;
  final int dirtyFileCount;
}

class WorkspaceDirectoryEntry {
  const WorkspaceDirectoryEntry({required this.name, required this.path});

  factory WorkspaceDirectoryEntry.fromJson(Map<String, dynamic> json) =>
      WorkspaceDirectoryEntry(
        name: json['name'] as String? ?? '',
        path: json['path'] as String? ?? '',
      );

  final String name;
  final String path;
}

class WorkspaceDirectoryListing {
  const WorkspaceDirectoryListing({
    required this.path,
    required this.directories,
    this.parentPath,
  });

  factory WorkspaceDirectoryListing.fromJson(Map<String, dynamic> json) =>
      WorkspaceDirectoryListing(
        path: json['path'] as String? ?? '',
        parentPath: json['parentPath'] as String?,
        directories: (json['directories'] as List<dynamic>? ?? const [])
            .map(
              (entry) => WorkspaceDirectoryEntry.fromJson(
                entry as Map<String, dynamic>,
              ),
            )
            .toList(),
      );

  final String path;
  final String? parentPath;
  final List<WorkspaceDirectoryEntry> directories;
}

class RouteProfileSummary {
  const RouteProfileSummary({required this.id, required this.name});

  factory RouteProfileSummary.fromJson(Map<String, dynamic> json) =>
      RouteProfileSummary(
        id: json['id'] as String? ?? '',
        name: json['name'] as String? ?? json['id'] as String? ?? '',
      );

  final String id;
  final String name;
}

class ModelSettingsSnapshot {
  const ModelSettingsSnapshot({
    required this.mainAgentConfigs,
    this.mainAgentPrompts = const [],
    this.subagentOrchestrations = const [],
    this.providers = const [],
    this.mcpSettings,
  });

  factory ModelSettingsSnapshot.fromJson(Map<String, dynamic> json) {
    final rawMcpSettings = json['mcpSettings'];
    return ModelSettingsSnapshot(
      mainAgentConfigs: (json['mainAgentConfigs'] as List<dynamic>? ?? [])
          .map(
            (entry) => MainAgentConfigResource.fromJson(
              _requiredJsonObject(entry, 'mainAgentConfigs[]'),
            ),
          )
          .toList(growable: false),
      mainAgentPrompts: (json['mainAgentPrompts'] as List<dynamic>? ?? [])
          .map(
            (entry) => MainAgentPromptResource.fromJson(
              _requiredJsonObject(entry, 'mainAgentPrompts[]'),
            ),
          )
          .toList(growable: false),
      subagentOrchestrations:
          (json['subagentOrchestrations'] as List<dynamic>? ?? [])
              .map(
                (entry) => SubagentOrchestrationResource.fromJson(
                  _requiredJsonObject(entry, 'subagentOrchestrations[]'),
                ),
              )
              .toList(growable: false),
      providers: (json['providers'] as List<dynamic>? ?? [])
          .map(
            (e) => ModelProviderView.fromJson(
              _requiredJsonObject(e, 'providers[]'),
            ),
          )
          .toList(),
      mcpSettings: rawMcpSettings is Map
          ? McpSettingsSnapshot.fromJson(
              Map<String, dynamic>.from(rawMcpSettings),
            )
          : null,
    );
  }

  final List<MainAgentConfigResource> mainAgentConfigs;
  final List<MainAgentPromptResource> mainAgentPrompts;
  final List<SubagentOrchestrationResource> subagentOrchestrations;
  final List<ModelProviderView> providers;
  final McpSettingsSnapshot? mcpSettings;
}

class ModelProviderView {
  const ModelProviderView({
    required this.id,
    required this.name,
    required this.defaultModel,
    required this.enabled,
  });

  factory ModelProviderView.fromJson(Map<String, dynamic> json) =>
      ModelProviderView(
        id: json['id'] as String? ?? '',
        name: json['name'] as String? ?? '',
        defaultModel: json['defaultModel'] as String? ?? '',
        enabled: json['enabled'] as bool? ?? false,
      );

  final String id;
  final String name;
  final String defaultModel;
  final bool enabled;
}

class CandidateModelView {
  const CandidateModelView({
    required this.id,
    required this.providerId,
    required this.modelId,
    this.displayName,
    this.resolvedSupportsReasoning,
  });

  factory CandidateModelView.fromJson(Map<String, dynamic> json) =>
      CandidateModelView(
        id: json['id'] as String? ?? '',
        providerId: json['providerId'] as String? ?? '',
        modelId: json['modelId'] as String? ?? '',
        displayName: json['displayName'] as String?,
        resolvedSupportsReasoning: json['resolvedSupportsReasoning'] as bool?,
      );

  final String id;
  final String providerId;
  final String modelId;
  final String? displayName;
  final bool? resolvedSupportsReasoning;
}
