import 'dart:ui' show Color;

import '../../l10n/generated/app_localizations.dart';
import '../models/thread_models.dart';
import '../models/thread_runtime_config.dart';
import '../models/conversation_v2_projection_models.dart';
import '../theme/subagent_theme.dart' as subagent_theme;
import 'agent_mission.dart';
import 'feed_action_kind.dart';
import 'file_change.dart';
import 'subagent_session_timing.dart';

const subagentDisplayRoles = {
  'vision',
  'explore',
  'architect',
  'coder',
  'reviewer',
  'tester',
};

const _nonAgentActivityRoles = {
  'assistant',
  'main',
  'planner',
  'system',
  'thinking',
  'tool',
  'user',
};

const _chineseRoleToId = {
  '看图': 'vision',
  '探索': 'explore',
  '架构': 'architect',
  '编码': 'coder',
  '审查': 'reviewer',
  '测试': 'tester',
};

final _subagentBracketPrefix = RegExp(r'^【[^】]+】\s*');

// Chinese alternatives match historical Desktop event text, not mobile UI.
final _activityNoisePattern = RegExp(
  r'^(?:Tool:|Running tool:|Requesting model|Compacting context|API retry |Usage recorded|Run finished|Agent session started|Agent run completed|Claude Agent SDK ready|状态已更新|已从异常退出恢复|【\d+/\d+】|Creating isolated worktree|Isolated worktree ready:|Local model router ready:|Working in project directory:|已清理隔离工作树|工具调用被拒绝|Permission denied for )',
  caseSensitive: false,
);

final _internalActivityMessagePattern = RegExp(
  r'^(?:标题已更新|标题更新|运行投影已更新|运行投影更新|执行完成。|执行完成，变更已写入项目目录。|执行完成，工作树内无相对基线的文件变更。|执行已结束，但无法确认文件变更。|ACP\s*已完成|等待工具读取确认|等待 Bash 执行确认|读取已确认，继续执行|读取已拒绝，等待 Agent 调整|Bash 已确认，继续执行|Bash 已拒绝，等待 Agent 调整|模型路由已变更|模型请求(?:完成|失败|已取消))',
);

final _usageBadgePattern = RegExp(r'^[↑↓⊙][↑↓⊙\d\s.,kKmM\$%·+()-]*$');

final _usageNoisePattern = RegExp(
  r'^(?:Usage recorded|Run finished)',
  caseSensitive: false,
);

final _activityStatusNoisePattern = RegExp(r'^状态已更新\s*');

final _threadOperationalStatusPatterns = [
  RegExp(r'^正在停止(?:当前步骤|…)'),
  RegExp(r'^已停止'),
  RegExp(r'^正在继续执行'),
  RegExp(r'^正在按计划执行'),
  RegExp(r'^正在回答'),
  RegExp(r'^正在分析并制定计划'),
  RegExp(r'^正在交给主代理处理'),
  RegExp(r'^正在启动'),
  RegExp(r'^正在继续 Codex 会话'),
  RegExp(r'^正在继续处理'),
  RegExp(r'^Codex 已连接'),
  RegExp(r'^PI 已就绪'),
  RegExp(r'^Local model router ready:', caseSensitive: false),
  RegExp(r'^Working in project directory:'),
  RegExp(r'^已开始处理排队的后续消息。'),
  RegExp(r'^已取消排队的后续消息。'),
  RegExp(r'^已记录后续消息，并标记为需要立即处理。'),
  RegExp(r'^后续消息处理失败：'),
];

final _toolLinePattern = RegExp(
  r'^Tool:\s*([A-Za-z0-9_]+)(?:\s*·\s*(.+?)|\s+(\(\d+(?:\.\d+)?s\)))?\s*$',
);

final _mcpToolLinePattern = RegExp(r'^mcp__([^_]+(?:_[^_]+)*)__(.+)$');

const _mcpToolDisplayLabels = <String, String>{
  'mcp__eco_plan__finalize_plan': 'finalize_plan',
  'mcp__eco_image_generation__create_image': 'create_image',
  'mcp__eco_image_display__display_image': 'display_image',
  'mcp__eco_html_host__publish_html': 'publish_html',
  'mcp__eco_image_view__view_image': 'view_image',
  'mcp__eco_computer_use__click': 'computer_use',
  'mcp__eco_agent_browser__agent_browser_open': 'agent_browser_open',
  'mcp__eco_agent_browser__agent_browser_snapshot': 'agent_browser_snapshot',
  'mcp__eco_agent_browser__agent_browser_click': 'agent_browser_click',
  'mcp__eco_agent_browser__agent_browser_fill': 'agent_browser_fill',
  'mcp__eco_agent_browser__agent_browser_screenshot': 'agent_browser_screenshot',
  'mcp__eco_agent_browser__agent_browser_get_url': 'agent_browser_get_url',
  'mcp__eco_agent_browser__agent_browser_tab_list': 'agent_browser_tab_list',
  'mcp__eco_agent_browser__agent_browser_tab_new': 'agent_browser_tab_new',
  'mcp__eco_agent_browser__agent_browser_tab_switch': 'agent_browser_tab_switch',
};

const _namedEcoToolSuffixes = <String>{
  'finalize_plan',
  'create_image',
  'computer_use',
  'view_image',
  'display_image',
  'publish_html',
  'web_search',
  'agent_browser_open',
  'agent_browser_snapshot',
  'agent_browser_click',
  'agent_browser_fill',
  'agent_browser_screenshot',
  'agent_browser_get_url',
  'agent_browser_tab_list',
  'agent_browser_tab_new',
  'agent_browser_tab_switch',
};

bool isMcpToolName(String tool) {
  return tool.startsWith('mcp__') || tool == 'mcp_tool';
}

bool isEcoImageGenerationToolName(String? value) {
  final name = value?.trim().toLowerCase() ?? '';
  return name.contains('eco_image_generation') || name.endsWith('create_image');
}

bool isEcoImageViewToolName(String? value) {
  final name = value?.trim().toLowerCase() ?? '';
  if (name.isEmpty) return false;
  return name.contains('eco_image_view') ||
      name == 'view_image' ||
      name.endsWith('__view_image');
}

bool isEcoImageDisplayToolName(String? value) {
  final name = value?.trim().toLowerCase() ?? '';
  if (name.isEmpty) return false;
  return name.contains('eco_image_display') ||
      name == 'display_image' ||
      name.endsWith('__display_image');
}

bool isEcoHtmlHostToolName(String? value) {
  final name = value?.trim().toLowerCase() ?? '';
  if (name.isEmpty) return false;
  return name.contains('eco_html_host') ||
      name == 'publish_html' ||
      name.endsWith('__publish_html');
}

bool isEcoWebSearchToolName(String? value) {
  final name = value?.trim().toLowerCase() ?? '';
  if (name.isEmpty) return false;
  return name.contains('eco_web_search');
}

bool isEcoAgentBrowserToolName(String? toolName) {
  final name = toolName?.trim().toLowerCase() ?? '';
  if (name.isEmpty) return false;
  return name.contains('eco_agent_browser') ||
      name.contains('mcp__eco_agent_browser') ||
      name.contains('mcp__eco_ab_') ||
      name.contains('agent_browser_');
}

bool isEcoComputerUseToolName(String? value) {
  final name = value?.trim().toLowerCase() ?? '';
  if (name.isEmpty) return false;
  return name.contains('eco_computer_use') ||
      name.contains('open_computer_use') ||
      name.contains('mcp__eco_computer_use') ||
      name.contains('mcp__eco-computer-use');
}

String? ecoAgentBrowserToolSuffix(String toolName) {
  final name = toolName.trim();
  if (name.isEmpty) return null;
  final match = RegExp(
    r'^mcp__(?:[^_]+(?:_[^_]+)*)__(.+)$',
    caseSensitive: false,
  ).firstMatch(name);
  var suffix = (match?.group(1) ?? name).trim().toLowerCase();
  // Pi proxy form `eco_agent_browser_agent_browser_open` → short tool name.
  if (!suffix.startsWith('agent_browser') &&
      suffix.startsWith('eco_agent_browser_')) {
    suffix = suffix.substring('eco_agent_browser_'.length);
  }
  if (!suffix.contains('agent_browser')) return null;
  return suffix;
}

String? resolveNamedEcoToolSuffix(String tool) {
  if (isEcoImageGenerationToolName(tool)) return 'create_image';
  if (isEcoComputerUseToolName(tool)) return 'computer_use';
  if (isEcoImageViewToolName(tool)) return 'view_image';
  if (isEcoImageDisplayToolName(tool)) return 'display_image';
  if (isEcoHtmlHostToolName(tool)) return 'publish_html';
  if (isEcoWebSearchToolName(tool)) return 'web_search';
  final browserSuffix = ecoAgentBrowserToolSuffix(tool);
  if (browserSuffix != null) {
    return _namedEcoToolSuffixes.contains(browserSuffix)
        ? browserSuffix
        : 'browser';
  }
  final match = _mcpToolLinePattern.firstMatch(tool);
  if (match != null) {
    final suffix = match.group(2)?.trim().toLowerCase();
    if (suffix != null && _namedEcoToolSuffixes.contains(suffix)) {
      return suffix;
    }
  }
  final bare = tool.trim().toLowerCase();
  if (_namedEcoToolSuffixes.contains(bare)) return bare;
  final mapped = _mcpToolDisplayLabels[tool];
  if (mapped != null) return mapped;
  return null;
}

String _namedEcoToolLabel(String suffix, AppLocalizations l10n) {
  return switch (suffix) {
    'finalize_plan' => l10n.activityNamedFinalizePlan,
    'create_image' => l10n.activityNamedCreateImage,
    'computer_use' => l10n.activityNamedComputerUse,
    'view_image' => l10n.activityNamedViewImage,
    'display_image' => l10n.activityNamedDisplayImage,
    'publish_html' => l10n.activityNamedPublishHtml,
    'agent_browser_open' => l10n.activityNamedAgentBrowserOpen,
    'agent_browser_snapshot' => l10n.activityNamedAgentBrowserSnapshot,
    'agent_browser_click' => l10n.activityNamedAgentBrowserClick,
    'agent_browser_fill' => l10n.activityNamedAgentBrowserFill,
    'agent_browser_screenshot' => l10n.activityNamedAgentBrowserScreenshot,
    'agent_browser_get_url' => l10n.activityNamedAgentBrowserGetUrl,
    'agent_browser_tab_list' => l10n.activityNamedAgentBrowserTabList,
    'agent_browser_tab_new' => l10n.activityNamedAgentBrowserTabNew,
    'agent_browser_tab_switch' => l10n.activityNamedAgentBrowserTabSwitch,
    'browser' => l10n.activityNamedBrowser,
    'web_search' => l10n.activityNamedWebSearch,
    'web_fetch' => l10n.activityNamedWebFetch,
    _ => suffix,
  };
}

String formatMcpToolDisplayName(String tool, AppLocalizations l10n) {
  final named = resolveNamedEcoToolSuffix(tool);
  if (named != null) return _namedEcoToolLabel(named, l10n);
  final lower = tool.trim().toLowerCase();
  if (lower == 'mcp' || lower == 'mcpscript' || lower == 'mcp_tool') {
    return formatActionLine(
      resolved: resolveActionKind(toolName: tool),
      phase: ActionLinePhase.done,
      l10n: l10n,
    );
  }
  final match = _mcpToolLinePattern.firstMatch(tool);
  if (match != null) {
    final server = match.group(1)!.replaceAll('_', ' ');
    final toolName = match.group(2)!.replaceAll('_', ' ');
    return '$server · $toolName';
  }
  return tool
      .replaceFirst(RegExp(r'^mcp__'), '')
      .replaceAll('__', ' · ')
      .replaceAll('_', ' ');
}

enum _ProgressKind { read, write, edit, search, command }

final _progressPatterns = <({RegExp pattern, _ProgressKind kind})>[
  (
    pattern: RegExp(
      r'^Reading\s+(.+?)(?:\s*·\s*Read)?\s*$',
      caseSensitive: false,
    ),
    kind: _ProgressKind.read,
  ),
  (
    pattern: RegExp(
      r'^Writing\s+(.+?)(?:\s*·\s*Write)?\s*$',
      caseSensitive: false,
    ),
    kind: _ProgressKind.write,
  ),
  (
    pattern: RegExp(
      r'^Editing\s+(.+?)(?:\s*·\s*Edit)?\s*$',
      caseSensitive: false,
    ),
    kind: _ProgressKind.edit,
  ),
  (
    pattern: RegExp(
      r'^Searching\s+(.+?)(?:\s*·\s*Grep)?\s*$',
      caseSensitive: false,
    ),
    kind: _ProgressKind.search,
  ),
  (
    pattern: RegExp(
      r'^Running\s+(.+?)(?:\s*·\s*Bash)?\s*$',
      caseSensitive: false,
    ),
    kind: _ProgressKind.command,
  ),
];

final _connectionFailedPattern = RegExp(r'^【连接失败】\s*([\s\S]*)$');

enum ActivityActionIcon {
  search,
  file,
  read,
  edit,
  terminal,
  agent,
  context,
  network,
  image,
  images,
  browser,
  computer,
  tool,
}

enum ToolActionLifecycle {
  approvalPending,
  approvalApproved,
  approvalRejected,
  running,
  completed,
  failed,
}

class ThreadRunBashApprovalMetadata {
  const ThreadRunBashApprovalMetadata({
    required this.toolUseId,
    required this.toolName,
    this.phase,
    this.detail,
    this.description,
  });

  final String toolUseId;
  final String toolName;
  final String? phase;
  final String? detail;
  final String? description;
}

ToolActionLifecycle? bashApprovalPhaseToLifecycle(String? phase) {
  switch (phase) {
    case 'requested':
      return ToolActionLifecycle.approvalPending;
    case 'approved':
      return ToolActionLifecycle.approvalApproved;
    case 'rejected':
    case 'denied':
      return ToolActionLifecycle.approvalRejected;
    default:
      return null;
  }
}

ToolActionLifecycle toolLifecycleFromMetadata(ThreadRunToolMetadata tool) {
  switch (tool.status) {
    case 'completed':
      return ToolActionLifecycle.completed;
    case 'failed':
      return ToolActionLifecycle.failed;
    case 'running':
      return ToolActionLifecycle.running;
    default:
      return ToolActionLifecycle.running;
  }
}

ThreadRunBashApprovalMetadata? readBashApprovalMetadata(
  Map<String, dynamic>? metadata,
) {
  final raw = metadata?['bashApproval'];
  if (raw is! Map<String, dynamic>) return null;
  final toolUseId = (raw['toolUseId'] as String?)?.trim() ?? '';
  final toolName = (raw['toolName'] as String?)?.trim() ?? '';
  if (toolUseId.isEmpty || toolName.isEmpty) return null;
  final phase = (raw['phase'] as String?)?.trim();
  final detail = (raw['detail'] as String?)?.trim();
  final description = (raw['description'] as String?)?.trim();
  return ThreadRunBashApprovalMetadata(
    toolUseId: toolUseId,
    toolName: toolName,
    phase: phase?.isNotEmpty == true ? phase : null,
    detail: detail?.isNotEmpty == true ? detail : null,
    description: description?.isNotEmpty == true ? description : null,
  );
}

Map<String, ThreadRunBashApprovalMetadata> buildBashApprovalIndexByToolUseId(
  ThreadRunProjectionSnapshot? projection,
) {
  final index = <String, ThreadRunBashApprovalMetadata>{};
  if (projection == null) return index;
  void scan(Iterable<ThreadRunProjectionTimelineItem> items) {
    for (final item in items) {
      final approval = readBashApprovalMetadata(item.metadata);
      if (approval != null) {
        index[approval.toolUseId] = approval;
      }
    }
  }

  scan(projection.timeline);
  for (final agent in projection.agents) {
    scan(agent.timeline);
  }
  return index;
}

Map<String, ThreadRunToolMetadata> buildToolIndexByToolUseId(
  ThreadRunProjectionSnapshot? projection,
) {
  final index = <String, ThreadRunToolMetadata>{};
  if (projection == null) return index;
  void scan(Iterable<ThreadRunProjectionTimelineItem> items) {
    for (final item in items) {
      final tool = readProjectionToolMetadata(item.metadata);
      final toolUseId = tool?.toolUseId?.trim();
      if (tool == null || toolUseId == null || toolUseId.isEmpty) continue;
      index[toolUseId] = tool;
    }
  }

  scan(projection.timeline);
  for (final agent in projection.agents) {
    scan(agent.timeline);
  }
  return index;
}

ThreadRunToolMetadata? findProjectionToolForInvocation(
  ParsedActivityToolInvocation invocation,
  Map<String, ThreadRunToolMetadata> toolIndex,
) {
  final normalizedDetail = invocation.detail?.trim();
  ThreadRunToolMetadata? fallback;
  for (final tool in toolIndex.values) {
    if (tool.name != invocation.toolName) continue;
    if (normalizedDetail == null || normalizedDetail.isEmpty) {
      fallback ??= tool;
      continue;
    }
    final toolDetail = tool.detail?.trim();
    if (toolDetail == normalizedDetail) return tool;
    if (tool.name == 'Bash' &&
        toolDetail != null &&
        normalizeBashCommandKey(toolDetail) ==
            normalizeBashCommandKey(normalizedDetail)) {
      return tool;
    }
  }
  return fallback;
}

String normalizeBashCommandKey(String command) {
  return command.trim().replaceAll(RegExp(r'\s+'), ' ');
}

ThreadRunToolMetadata? threadRunToolMetadataFromJson(
  Map<String, dynamic>? json, {
  bool includeOutputPreview = true,
}) {
  if (json == null) return null;
  final name = (json['name'] as String?)?.trim() ?? '';
  if (name.isEmpty) return null;
  final detail = (json['detail'] as String?)?.trim();
  final toolUseId = (json['toolUseId'] as String?)?.trim();
  final description = (json['description'] as String?)?.trim();
  final outputPreview = includeOutputPreview
      ? (json['outputPreview'] as String?)?.trim()
      : null;
  final durationMs = json['durationMs'];
  final status = (json['status'] as String?)?.trim();
  return ThreadRunToolMetadata(
    name: name,
    detail: detail?.isNotEmpty == true ? detail : null,
    toolUseId: toolUseId?.isNotEmpty == true ? toolUseId : null,
    description: description?.isNotEmpty == true ? description : null,
    outputPreview: outputPreview?.isNotEmpty == true ? outputPreview : null,
    outputPreviewTruncated:
        outputPreview?.isNotEmpty == true &&
        json['outputPreviewTruncated'] == true,
    durationMs: durationMs is int ? durationMs : null,
    status: status?.isNotEmpty == true ? status : null,
    readTargetPath: _readToolTargetPath(json['readTarget']),
    readTargetLineRange: _readToolTargetLineRange(
      json['readTarget'],
      detail: detail,
    ),
    grepPattern: _grepToolTargetPattern(json['grepTarget']),
    fileChange: parseThreadRunFileChangeMetadata(json['fileChange']),
    webSearch: _readWebSearchMetadata(json['webSearch']),
    imageView: _readImageViewMetadata(json['imageView']),
    imageDisplay: _readImageDisplayMetadata(json['imageDisplay']),
    htmlHost: _readHtmlHostMetadata(json['htmlHost']),
    mcpDiscovery: _readMcpDiscoveryMetadata(json['mcpDiscovery']),
  );
}

ThreadRunMcpDiscoveryMetadata? _readMcpDiscoveryMetadata(dynamic value) {
  if (value is! Map) return null;
  if (value['kind'] != 'search') return null;
  return const ThreadRunMcpDiscoveryMetadata(kind: 'search');
}

ImageViewDisplay? _readImageViewMetadata(dynamic value) {
  if (value is! Map<String, dynamic>) return null;
  final path = (value['path'] as String?)?.trim();
  if (path == null || path.isEmpty) return null;
  return ImageViewDisplay(path: path);
}

ImageDisplayDisplay? _readImageDisplayMetadata(dynamic value) {
  if (value is! Map) return null;
  final artifactId = (value['artifactId'] as String?)?.trim();
  if (artifactId == null || artifactId.isEmpty) return null;
  final title = (value['title'] as String?)?.trim();
  return ImageDisplayDisplay(
    artifactId: artifactId,
    title: title?.isNotEmpty == true ? title : null,
  );
}

HtmlHostDisplay? _readHtmlHostMetadata(dynamic value) {
  if (value is! Map) return null;
  final pageId = (value['pageId'] as String?)?.trim();
  final publicUrl = (value['publicUrl'] as String?)?.trim();
  if (pageId == null ||
      pageId.isEmpty ||
      publicUrl == null ||
      publicUrl.isEmpty) {
    return null;
  }
  final title = (value['title'] as String?)?.trim();
  final expiresAt = (value['expiresAt'] as String?)?.trim();
  final canExtend = value['canExtend'];
  return HtmlHostDisplay(
    pageId: pageId,
    publicUrl: publicUrl,
    title: title?.isNotEmpty == true ? title : null,
    expiresAt: expiresAt?.isNotEmpty == true ? expiresAt : null,
    canExtend: canExtend is bool ? canExtend : null,
  );
}

ThreadRunWebSearchMetadata? _readWebSearchMetadata(dynamic value) {
  if (value is! Map<String, dynamic>) return null;
  final query = (value['query'] as String?)?.trim();
  final url = (value['url'] as String?)?.trim();
  final pattern = (value['pattern'] as String?)?.trim();
  final queries = value['queries'] is List
      ? (value['queries'] as List)
            .whereType<String>()
            .map((entry) => entry.trim())
            .where((entry) => entry.isNotEmpty)
            .take(12)
            .toList(growable: false)
      : const <String>[];
  final actionType = switch (value['actionType']) {
    'search' ||
    'openPage' ||
    'findInPage' ||
    'other' => value['actionType'] as String,
    _ => null,
  };
  final mode = switch (value['mode']) {
    'search' || 'fetch' => value['mode'] as String,
    _ => null,
  };
  if ((query == null || query.isEmpty) &&
      (url == null || url.isEmpty) &&
      (pattern == null || pattern.isEmpty) &&
      queries.isEmpty &&
      actionType == null &&
      mode == null) {
    return null;
  }
  return ThreadRunWebSearchMetadata(
    query: query?.isNotEmpty == true ? query : null,
    url: url?.isNotEmpty == true ? url : null,
    pattern: pattern?.isNotEmpty == true ? pattern : null,
    queries: queries,
    actionType: actionType,
    mode: mode,
  );
}

String? _readToolTargetPath(dynamic value) {
  if (value is! Map<String, dynamic>) return null;
  final path = (value['filePath'] as String?)?.trim();
  return path?.isNotEmpty == true ? path : null;
}

String? _grepToolTargetPattern(dynamic value) {
  if (value is! Map<String, dynamic>) return null;
  final pattern = (value['pattern'] as String?)?.trim();
  return pattern?.isNotEmpty == true ? pattern : null;
}

/// Mirrors desktop `formatReadLineRange`: `L12`, `L12-40`.
String? formatReadLineRange(int? offset, int? limit) {
  if (offset == null || offset < 1) return null;
  if (limit == null || limit < 1) return 'L$offset';
  final end = offset + limit - 1;
  return end <= offset ? 'L$offset' : 'L$offset-$end';
}

String? _readToolTargetLineRange(dynamic value, {String? detail}) {
  if (value is Map) {
    final range = formatReadLineRange(
      _positiveInt(value['offset']),
      _positiveInt(value['limit']),
    );
    if (range != null) return range;
  }
  // Legacy runtimes stored the range inside the detail as `path:L12-40`.
  final match = RegExp(
    r':L(\d+)(?:-(\d+))?$',
  ).firstMatch(detail?.trim() ?? '');
  if (match == null) return null;
  final offset = int.tryParse(match.group(1) ?? '');
  final end = int.tryParse(match.group(2) ?? '');
  if (offset == null) return null;
  return formatReadLineRange(
    offset,
    end == null ? null : (end - offset + 1).clamp(1, 1 << 31),
  );
}

int? _positiveInt(dynamic value) {
  if (value is! num) return null;
  final rounded = value.truncate();
  return rounded >= 1 ? rounded : null;
}

String? resolveStructuredBashDescription({
  ThreadRunToolMetadata? tool,
  ThreadRunBashApprovalMetadata? bashApproval,
}) {
  final fromTool = isCommandToolName(tool?.name) ? tool?.description?.trim() : null;
  if (fromTool != null && fromTool.isNotEmpty) {
    return fromTool;
  }
  final fromApproval = bashApproval?.description?.trim();
  if (fromApproval != null && fromApproval.isNotEmpty) {
    return fromApproval;
  }
  return null;
}

String formatStructuredToolActionLabel(
  ThreadRunToolMetadata tool, {
  ThreadRunBashApprovalMetadata? bashApproval,
  required AppLocalizations l10n,
}) {
  if (isCommandToolName(tool.name)) {
    final description = resolveStructuredBashDescription(
      tool: tool,
      bashApproval: bashApproval,
    );
    if (description != null) {
      return description;
    }
  }
  return formatToolDisplayLabel(
    bashApproval?.toolName ?? tool.name,
    bashApproval?.detail ??
        // Structured targets survive even when the runtime did not send a
        // display detail; the desktop `formatThreadRunToolDetailLabel` also
        // prefers the read target over the raw detail.
        structuredToolTargetDetail(tool) ??
        tool.detail,
    l10n,
  );
}

/// `fileName:L12-40` / `pattern · scope` for tools whose runtime metadata
/// carries a structured target instead of a display detail.
String? structuredToolTargetDetail(ThreadRunToolMetadata tool) {
  final path = tool.readTargetPath?.trim();
  if (path != null && path.isNotEmpty) {
    final name = pathBasename(path);
    final range = tool.readTargetLineRange?.trim();
    return range == null || range.isEmpty ? name : '$name:$range';
  }
  final pattern = tool.grepPattern?.trim();
  if (pattern != null && pattern.isNotEmpty) return pattern;
  return null;
}

ThreadRunToolMetadata? toolMetadataFromBashApproval(
  BashApprovalRequest request, {
  String? status,
}) {
  final toolUseId = request.toolUseId.trim();
  if (toolUseId.isEmpty) return null;
  final toolName = request.filesystemTool?.trim().isNotEmpty == true
      ? request.filesystemTool!.trim()
      : 'Bash';
  final detail = request.filesystemPath?.trim().isNotEmpty == true
      ? request.filesystemPath!.trim()
      : request.command.trim();
  final description = request.description?.trim();
  return ThreadRunToolMetadata(
    name: toolName,
    detail: detail.isNotEmpty ? detail : null,
    toolUseId: toolUseId,
    description: description?.isNotEmpty == true ? description : null,
    status: status,
  );
}

String? bashApprovalLiveTypeToToolStatus(String liveType) {
  if (liveType == 'bash_approval.rejected' ||
      liveType == 'bash_approval.denied') {
    return 'failed';
  }
  if (liveType.startsWith('bash_approval.')) {
    return 'running';
  }
  return null;
}

BashRunCardDisplay? resolveBashRunCardDisplayFromTool(
  ThreadRunToolMetadata tool,
) {
  if (!isCommandToolName(tool.name)) return null;
  return resolveBashRunCardDisplay(
    toolName: tool.name,
    command: tool.detail,
    output: tool.outputPreview,
    durationMs: tool.durationMs,
    description: tool.description,
  );
}

class ThreadRunToolMetadata {
  const ThreadRunToolMetadata({
    required this.name,
    this.detail,
    this.toolUseId,
    this.description,
    this.outputPreview,
    this.outputPreviewTruncated = false,
    this.durationMs,
    this.status,
    this.readTargetPath,
    this.readTargetLineRange,
    this.grepPattern,
    this.fileChange,
    this.webSearch,
    this.imageView,
    this.imageDisplay,
    this.htmlHost,
    this.mcpDiscovery,
  });

  final String name;
  final String? detail;
  final String? toolUseId;
  final String? description;
  final String? outputPreview;
  final bool outputPreviewTruncated;
  final int? durationMs;
  final String? status;
  final String? readTargetPath;

  /// `L12-40` style range parsed from the read target `offset`/`limit` (or from
  /// the legacy `path:L12-40` detail). Desktop renders the same suffix.
  final String? readTargetLineRange;
  final String? grepPattern;
  final ThreadRunFileChangeMetadata? fileChange;
  final ThreadRunWebSearchMetadata? webSearch;
  final ImageViewDisplay? imageView;
  final ImageDisplayDisplay? imageDisplay;
  final HtmlHostDisplay? htmlHost;
  final ThreadRunMcpDiscoveryMetadata? mcpDiscovery;
}

class ThreadRunMcpDiscoveryMetadata {
  const ThreadRunMcpDiscoveryMetadata({this.kind});
  final String? kind;
}

class ImageViewDisplay {
  const ImageViewDisplay({required this.path, this.eventId});

  final String path;
  final String? eventId;
}

class ImageDisplayDisplay {
  const ImageDisplayDisplay({required this.artifactId, this.eventId, this.title});

  final String artifactId;
  final String? eventId;
  final String? title;
}

class HtmlHostDisplay {
  const HtmlHostDisplay({
    required this.pageId,
    required this.publicUrl,
    this.eventId,
    this.title,
    this.expiresAt,
    this.canExtend,
  });

  final String pageId;
  final String publicUrl;
  final String? eventId;
  final String? title;
  final String? expiresAt;
  final bool? canExtend;
}

class ThreadRunWebSearchMetadata {
  const ThreadRunWebSearchMetadata({
    this.query,
    this.actionType,
    this.url,
    this.pattern,
    this.queries = const [],
    this.mode,
  });

  final String? query;
  final String? actionType;
  final String? url;
  final String? pattern;
  final List<String> queries;
  final String? mode;
}

ThreadRunToolMetadata? readProjectionToolMetadata(
  Map<String, dynamic>? metadata,
) {
  final raw = metadata?['tool'];
  if (raw is! Map<String, dynamic>) return null;
  return threadRunToolMetadataFromJson(raw);
}

String resolveBashApprovalTitle({
  String? description,
  required String reason,
  String? filesystemTool,
  required AppLocalizations l10n,
}) {
  final normalizedDescription = description?.trim();
  if (normalizedDescription != null && normalizedDescription.isNotEmpty) {
    return normalizedDescription;
  }
  final normalizedReason = reason.trim();
  if (normalizedReason.isNotEmpty) return normalizedReason;
  if (filesystemTool != null && filesystemTool.trim().isNotEmpty) {
    return l10n.activityAllowOutsideWorkspace(filesystemTool);
  }
  return l10n.activityToolPermissionRequired;
}

String activityActionKey({
  String? subagent,
  required String label,
  ActivityActionIcon? icon,
}) {
  return '${subagent ?? ''}\x00${icon?.name ?? ''}\x00${normalizeActivityActionLabel(label)}';
}

String normalizeActivityActionLabel(String raw) {
  return stripSubagentBracketPrefix(raw.trim());
}

bool isGenericToolActionLabel(String label, AppLocalizations l10n) {
  final trimmed = label.trim();
  if (trimmed.isEmpty) return true;
  return <String>{
    l10n.toolRead,
    l10n.toolWrite,
    l10n.toolEdit,
    l10n.toolSearch,
    l10n.toolFind,
    l10n.toolRunCommand,
    l10n.toolCall,
    l10n.toolUpdateTasks,
    l10n.toolCreateTask,
    l10n.toolListTasks,
    l10n.toolReadTaskOutput,
    l10n.toolClarify,
    l10n.toolWebSearch,
    l10n.toolWebFetch,
    l10n.activityReadSkill,
  }.contains(trimmed);
}

String resolveMergedToolActionLabel(
  String existing,
  String incoming,
  AppLocalizations l10n,
) {
  if (!isGenericToolActionLabel(existing, l10n) &&
      isGenericToolActionLabel(incoming, l10n)) {
    return existing;
  }
  return incoming;
}

int compareToolActionLifecyclePriority(
  ToolActionLifecycle left,
  ToolActionLifecycle right,
) {
  const rank = {
    ToolActionLifecycle.approvalRejected: 1,
    ToolActionLifecycle.approvalPending: 2,
    ToolActionLifecycle.approvalApproved: 3,
    ToolActionLifecycle.running: 4,
    ToolActionLifecycle.completed: 5,
    ToolActionLifecycle.failed: 5,
  };
  return (rank[left] ?? 0) - (rank[right] ?? 0);
}

String stripSubagentBracketPrefix(String text) {
  return text.replaceFirst(_subagentBracketPrefix, '').trim();
}

String stripActivityStatusNoise(String text) {
  return text.replaceFirst(_activityStatusNoisePattern, '').trim();
}

bool isActivityStatusNoise(String message) {
  final trimmed = message.trim();
  return trimmed == '状态已更新' || _activityStatusNoisePattern.hasMatch(trimmed);
}

bool isUsageNoiseMessage(String message) {
  final text = stripSubagentBracketPrefix(message.trim());
  return _usageNoisePattern.hasMatch(text);
}

bool isActivityNoiseMessage(String message) {
  final text = stripSubagentBracketPrefix(message.trim());
  return text.isEmpty ||
      _activityNoisePattern.hasMatch(text) ||
      isInternalActivityMessage(text);
}

bool isInternalActivityMessage(String message) {
  final trimmed = message.trim();
  if (trimmed.isEmpty) return true;
  if (_internalActivityMessagePattern.hasMatch(trimmed)) return true;
  if (trimmed.startsWith('__eco_worktree_merge__')) return true;
  return false;
}

bool isUsageBadgeText(String message) {
  return _usageBadgePattern.hasMatch(message.trim());
}

bool isSubagentDisplayRole(String? role) {
  final normalized = normalizeAgentDisplayRole(role);
  return normalized != null && subagentDisplayRoles.contains(normalized);
}

bool isInternalAgentActivityRole(String? role) {
  final normalized = normalizeAgentDisplayRole(role);
  return normalized != null && !subagentDisplayRoles.contains(normalized);
}

bool isThreadFollowUpActivityMessage(String message) {
  final trimmed = message.trim();
  if (trimmed.isEmpty) return false;
  return _threadOperationalStatusPatterns.any(
    (pattern) => pattern.hasMatch(trimmed),
  );
}

/// Desktop-side approval transition lines (bash/filesystem/browser/image
/// approvals, including auxiliary-model auto-approvals). Structured
/// `bashApproval` metadata owns their display; raw text variants must never
/// surface as assistant activity in the Feed.
final _bashApprovalTransitionTextPattern = RegExp(
  r'^(?:'
  r'(?:辅助模型|审批模型)已允许'
  r'|已允许(?:本次(?:\s*[A-Za-z][A-Za-z0-9_]*|图片创建)|打开(?:内置)?浏览器)?'
  r'|已拒绝'
  r'|等待确认'
  r')(?:\s+[A-Za-z][A-Za-z0-9_]*)?(?:[：:]\s*\S.*)?$',
);

/// Legacy activity-line bash/filesystem approval transitions; projection owns display.
bool isLegacyBashApprovalActivityText(String message) {
  final trimmed = message.trim();
  if (trimmed.isEmpty) return false;
  if (trimmed.startsWith('Bash 已拒绝：')) return true;
  return _bashApprovalTransitionTextPattern.hasMatch(trimmed);
}

bool isRecordedUserPromptLiveEvent(String? liveType) {
  return liveType == 'thread.user_prompt';
}

const clarificationAnswerPrefix = '澄清回答：';

class ClarificationAnswerRow {
  const ClarificationAnswerRow({required this.question, required this.answer});

  final String question;
  final String answer;
}

List<ClarificationAnswerRow>? parseClarificationAnswersSummary(String text) {
  final trimmed = text.trim();
  if (!trimmed.startsWith(clarificationAnswerPrefix)) {
    return null;
  }

  final rest = trimmed.substring(clarificationAnswerPrefix.length).trim();
  if (rest.isEmpty) {
    return const [];
  }

  final parts = rest
      .split('；')
      .map((part) => part.trim())
      .where((part) => part.isNotEmpty);

  return parts.map((part) {
    final segments = part.split(RegExp(r'\s*→\s*'));
    final question = segments.first.trim().isEmpty
        ? part.trim()
        : segments.first.trim();
    final answer = segments.skip(1).join(' → ').trim();
    return ClarificationAnswerRow(question: question, answer: answer);
  }).toList();
}

bool isUserPromptActivityLine({required String role, required String message}) {
  if (role != 'user') return false;
  final text = message.trim();
  return text.isNotEmpty && !isThreadFollowUpActivityMessage(text);
}

String? normalizeAgentDisplayRole(String? role) {
  if (role == null || role.trim().isEmpty) return null;
  final trimmed = role.trim();
  final fromChinese = _chineseRoleToId[trimmed];
  if (fromChinese != null) return fromChinese;
  if (subagentDisplayRoles.contains(trimmed)) return trimmed;

  final withoutEco = trimmed.startsWith('eco_')
      ? trimmed.substring(4)
      : trimmed;
  if (withoutEco.isEmpty || _nonAgentActivityRoles.contains(withoutEco)) {
    return null;
  }
  if (!RegExp(r'^[a-zA-Z][a-zA-Z0-9_-]*$').hasMatch(withoutEco)) {
    return null;
  }
  return withoutEco;
}

bool isAgentDisplayRole(String role) {
  return normalizeAgentDisplayRole(role) != null;
}

bool shouldShowLineInMainFeed({required String role}) {
  if (role == 'user') return true;
  if (role == 'planner' || role == 'thinking') return true;
  if (isAgentDisplayRole(role)) return false;
  return true;
}

String pathBasename(String filePath) {
  final normalized = filePath.replaceAll('\\', '/');
  final segments = normalized.split('/').where((part) => part.isNotEmpty);
  final list = segments.toList();
  if (list.isEmpty) return filePath;
  return list.last;
}

/// Mirrors the runtime `isReadToolName` used by the desktop read-target parser.
bool isReadToolName(String? toolName) {
  final name = toolName?.trim().toLowerCase() ?? '';
  return name == 'read' || name == 'notebookread';
}

bool _isPath(String token) {
  return token.startsWith('/') ||
      token.startsWith('./') ||
      token.startsWith('~/');
}

String clampActivityPreviewLine(String text, [int max = 56]) {
  final oneLine = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (oneLine.isEmpty || oneLine.length <= max) return oneLine;
  return '${oneLine.substring(0, max - 1)}…';
}

bool isToolElapsedDuration(String value) {
  return RegExp(r'\(\d+(?:\.\d+)?s\)\s*$').hasMatch(value.trim());
}

class ParsedActivityToolInvocation {
  const ParsedActivityToolInvocation({
    required this.toolName,
    this.detail,
    this.durationMs,
    required this.rawMessage,
  });

  final String toolName;
  final String? detail;
  final int? durationMs;
  final String rawMessage;
}

class BashRunCardDisplay {
  const BashRunCardDisplay({
    required this.title,
    this.meta,
    this.command,
    this.output,
  });

  final String title;
  final String? meta;
  final String? command;
  final String? output;
}

int? parseToolDurationMsFromMessage(String message) {
  final match = RegExp(r'\((\d+(?:\.\d+)?)s\)\s*$').firstMatch(message.trim());
  if (match == null) return null;
  final seconds = double.tryParse(match.group(1) ?? '');
  if (seconds == null) return null;
  return (seconds * 1000).round();
}

ParsedActivityToolInvocation? parseActivityToolInvocation(String raw) {
  final text = stripSubagentBracketPrefix(raw.trim());
  if (text.isEmpty) return null;

  for (final item in _progressPatterns) {
    if (item.kind != _ProgressKind.command) continue;
    final match = item.pattern.firstMatch(text);
    if (match != null) {
      final detail = match.group(1)?.trim();
      return ParsedActivityToolInvocation(
        toolName: 'Bash',
        detail: detail?.isEmpty == true ? null : detail,
        durationMs: parseToolDurationMsFromMessage(text),
        rawMessage: text,
      );
    }
  }

  final toolMatch = _toolLinePattern.firstMatch(text);
  if (toolMatch != null) {
    final toolName = toolMatch.group(1) ?? '';
    var detail = toolMatch.group(2)?.trim() ?? toolMatch.group(3)?.trim();
    if (detail != null && RegExp(r'^\(\d+(?:\.\d+)?s\)$').hasMatch(detail)) {
      detail = null;
    } else if (detail != null) {
      detail = detail
          .replaceFirst(RegExp(r'\s+\(\d+(?:\.\d+)?s\)\s*$'), '')
          .trim();
      if (detail.isEmpty) detail = null;
    }
    return ParsedActivityToolInvocation(
      toolName: toolName,
      detail: detail,
      durationMs: parseToolDurationMsFromMessage(text),
      rawMessage: text,
    );
  }

  final bareMatch = RegExp(
    r'^([A-Za-z][A-Za-z0-9_]*)\s*·\s*(.+)$',
  ).firstMatch(text);
  if (bareMatch != null) {
    final toolName = bareMatch.group(1)!;
    final detail = bareMatch
        .group(2)!
        .replaceFirst(RegExp(r'\s+\(\d+(?:\.\d+)?s\)\s*$'), '')
        .trim();
    return ParsedActivityToolInvocation(
      toolName: toolName,
      detail: detail.isEmpty ? null : detail,
      durationMs: parseToolDurationMsFromMessage(text),
      rawMessage: text,
    );
  }

  return null;
}

String formatBashRunMeta(String command, {int? durationMs}) {
  final trimmed = command.trim();
  if (trimmed.isEmpty) {
    if (durationMs == null || durationMs <= 0) return '';
    final seconds = durationMs / 1000;
    return seconds < 60
        ? '${seconds.toStringAsFixed(1)}s'
        : formatDurationMs(durationMs);
  }
  final segments = trimmed.split(RegExp(r'\s*(?:&&|\|\||;)\s*'));
  final firstToken = segments.first.trim().split(RegExp(r'\s+')).first;
  final metaToken = _isPath(firstToken) ? pathBasename(firstToken) : firstToken;
  final parts = <String>[];
  if (metaToken.isNotEmpty) parts.add(metaToken);
  if (segments.length > 1) parts.add('${segments.length - 1}+');
  if (durationMs != null && durationMs > 0) {
    final seconds = durationMs / 1000;
    parts.add(
      seconds < 60
          ? '${seconds.toStringAsFixed(1)}s'
          : formatDurationMs(durationMs),
    );
  }
  return parts.join(', ');
}

String formatBashRunTitle(String? description) {
  final normalizedDescription = description?.trim();
  if (normalizedDescription != null && normalizedDescription.isNotEmpty) {
    return clampActivityPreviewLine(normalizedDescription, 48);
  }
  return 'Shell';
}

BashRunCardDisplay? resolveBashRunCardDisplay({
  String? toolName,
  String? command,
  String? output,
  int? durationMs,
  String? description,
}) {
  if (!isCommandToolName(toolName)) return null;
  final normalizedCommand = command?.trim();
  final normalizedOutput = output?.trim();
  final title = formatBashRunTitle(description);
  final meta = normalizedCommand == null || normalizedCommand.isEmpty
      ? null
      : formatBashRunMeta(normalizedCommand, durationMs: durationMs);
  return BashRunCardDisplay(
    title: title,
    meta: meta?.isEmpty == true ? null : meta,
    command: normalizedCommand?.isEmpty == true ? null : normalizedCommand,
    output: normalizedOutput?.isEmpty == true ? null : normalizedOutput,
  );
}

String formatToolDisplayLabel(
  String toolName,
  String? detail,
  AppLocalizations l10n,
) {
  final normalizedDetail = detail?.trim();
  final lowerName = toolName.trim().toLowerCase();
  if (lowerName == 'skill' ||
      lowerName == 'skills' ||
      lowerName == 'readskill' ||
      (normalizedDetail != null && normalizedDetail.endsWith(' 技能'))) {
    return normalizedDetail ??
        formatActionLine(
          resolved: resolveActionKind(toolName: toolName),
          phase: ActionLinePhase.done,
          l10n: l10n,
        );
  }
  if (lowerName == 'mcp_tool' &&
      normalizedDetail != null &&
      normalizedDetail.startsWith('mcp__')) {
    return formatMcpToolDisplayName(normalizedDetail, l10n);
  }
  if (isMcpToolName(toolName) ||
      lowerName == 'mcp' ||
      lowerName == 'mcpscript') {
    return formatMcpToolDisplayName(toolName, l10n);
  }
  if (lowerName == 'agent' || lowerName == 'task') {
    return normalizedDetail ??
        formatActionLine(
          resolved: resolveActionKind(toolName: toolName),
          phase: ActionLinePhase.done,
          l10n: l10n,
        );
  }
  if (lowerName == 'websearch' || lowerName == 'webfetch') {
    final verb = lowerName == 'websearch'
        ? l10n.activityNamedWebSearch
        : l10n.activityNamedWebFetch;
    return normalizedDetail != null && normalizedDetail.isNotEmpty
        ? '$verb · $normalizedDetail'
        : verb;
  }
  if (normalizedDetail != null && normalizedDetail.isNotEmpty) {
    return normalizedDetail;
  }
  return formatActionLine(
    resolved: resolveActionKind(toolName: toolName),
    phase: ActionLinePhase.done,
    l10n: l10n,
  );
}

class WebSearchCardDisplay {
  const WebSearchCardDisplay({
    required this.kind,
    required this.title,
    required this.query,
    this.meta,
    this.status,
    this.actionType,
    this.actionLabel,
    this.url,
    this.pattern,
    this.queries = const [],
  });

  final String kind;
  final String title;
  final String query;
  final String? meta;
  final String? status;
  final String? actionType;
  final String? actionLabel;
  final String? url;
  final String? pattern;
  final List<String> queries;
}

WebSearchCardDisplay? resolveWebSearchCardDisplayFromTool(
  ThreadRunToolMetadata tool,
  AppLocalizations l10n,
) {
  final isNativeWeb =
      tool.name == 'WebSearch' || tool.name == 'WebFetch';
  if (!isNativeWeb && !isEcoWebSearchToolName(tool.name)) return null;
  final structured = tool.webSearch;
  final kind = tool.name == 'WebFetch' || structured?.mode == 'fetch'
      ? 'fetch'
      : 'search';
  final query = structured?.query?.trim().isNotEmpty == true
      ? structured!.query!.trim()
      : kind == 'fetch' && structured?.url?.trim().isNotEmpty == true
      ? structured!.url!.trim()
      : tool.detail?.trim() ?? '';
  final queryCandidate = query.isNotEmpty
      ? query
      : structured?.queries.firstOrNull ?? structured?.url ?? '';
  final displayQuery = queryCandidate.isNotEmpty
      ? queryCandidate
      : kind == 'fetch'
      ? l10n.activityWebSearchFetch
      : l10n.activityWebSearch;
  final actionType =
      structured?.actionType ?? (kind == 'fetch' ? 'fetch' : 'search');
  final url = structured?.url?.trim().isNotEmpty == true
      ? structured!.url!.trim()
      : kind == 'fetch' && queryCandidate.startsWith('http')
      ? queryCandidate
      : null;
  final pattern = structured?.pattern?.trim();
  final queries = structured?.queries ?? const <String>[];
  final actionLabel = _formatWebSearchActionLabel(
    actionType: actionType,
    url: url,
    pattern: pattern,
    queries: queries,
    l10n: l10n,
  );
  return WebSearchCardDisplay(
    kind: kind,
    title: formatToolDisplayLabel(
      tool.name,
      queryCandidate.isNotEmpty ? queryCandidate : null,
      l10n,
    ),
    query: displayQuery,
    meta: tool.durationMs != null && tool.durationMs! >= 0
        ? '${(tool.durationMs! / 1000).toStringAsFixed(1)}s'
        : null,
    status: tool.status,
    actionType: actionType,
    actionLabel: actionLabel,
    url: url,
    pattern: pattern?.isNotEmpty == true ? pattern : null,
    queries: queries,
  );
}

String? _formatWebSearchActionLabel({
  required String actionType,
  required String? url,
  required String? pattern,
  required List<String> queries,
  required AppLocalizations l10n,
}) {
  if (actionType == 'openPage') {
    return url == null
        ? l10n.activityWebSearchOpenPage
        : '${l10n.activityWebSearchOpenPage} · $url';
  }
  if (actionType == 'findInPage') {
    final target = [
      if (pattern != null && pattern.isNotEmpty) '"$pattern"',
      if (url != null && url.isNotEmpty) url,
    ].join(' · ');
    return target.isEmpty
        ? l10n.activityWebSearchFindInPage
        : '${l10n.activityWebSearchFindInPage} · $target';
  }
  if (actionType == 'fetch') {
    return url == null
        ? l10n.activityWebSearchFetch
        : '${l10n.activityWebSearchFetch} · $url';
  }
  return queries.length > 1
      ? '${queries.length} ${l10n.activityWebSearchQueries}'
      : null;
}

String parseToolActionDisplayLabel(String raw, AppLocalizations l10n) {
  final text = stripSubagentBracketPrefix(raw.trim());
  if (text.isEmpty) return raw.trim();

  for (final item in _progressPatterns) {
    final match = item.pattern.firstMatch(text);
    if (match != null && match.groupCount >= 1) {
      final target = match.group(1)?.trim();
      if (target != null && target.isNotEmpty) {
        return pathBasename(target);
      }
    }
  }

  final toolMatch = _toolLinePattern.firstMatch(text);
  if (toolMatch != null) {
    final tool = toolMatch.group(1) ?? '';
    var detail = toolMatch.group(2)?.trim() ?? toolMatch.group(3)?.trim();
    if (detail != null && RegExp(r'^\(\d+(?:\.\d+)?s\)$').hasMatch(detail)) {
      detail = null;
    } else if (detail != null) {
      detail = detail
          .replaceFirst(RegExp(r'\s+\(\d+(?:\.\d+)?s\)\s*$'), '')
          .trim();
      if (detail.isEmpty) detail = null;
    }
    return formatToolDisplayLabel(tool, detail, l10n);
  }

  final bareMatch = RegExp(
    r'^([A-Za-z][A-Za-z0-9_]*)\s*·\s*(.+)$',
  ).firstMatch(text);
  if (bareMatch != null) {
    final tool = bareMatch.group(1)!;
    final detail = bareMatch
        .group(2)!
        .replaceFirst(RegExp(r'\s+\(\d+(?:\.\d+)?s\)\s*$'), '')
        .trim();
    return formatToolDisplayLabel(tool, detail, l10n);
  }

  if (isMcpToolName(text)) {
    return formatMcpToolDisplayName(text, l10n);
  }

  return text;
}

ActivityActionIcon iconForToolName(String toolName) {
  return resolveActionKind(toolName: toolName).icon;
}

bool looksLikeToolActionMessage(String message) {
  final stripped = stripSubagentBracketPrefix(message.trim());
  if (stripped.startsWith('Tool:')) return true;
  for (final item in _progressPatterns) {
    if (item.pattern.hasMatch(stripped)) return true;
  }
  return RegExp(r'^[A-Za-z][A-Za-z0-9_]*\s*·\s*.+$').hasMatch(stripped);
}

ActivityActionIcon iconForActivityMessage(String message) {
  final stripped = stripSubagentBracketPrefix(message.trim());
  final toolMatch = _toolLinePattern.firstMatch(stripped);
  if (toolMatch != null) {
    return iconForToolName(toolMatch.group(1) ?? '');
  }
  for (final item in _progressPatterns) {
    if (item.pattern.hasMatch(stripped)) {
      switch (item.kind) {
        case _ProgressKind.search:
          return ActivityActionIcon.search;
        case _ProgressKind.edit:
        case _ProgressKind.write:
          return ActivityActionIcon.edit;
        case _ProgressKind.command:
          return ActivityActionIcon.terminal;
        case _ProgressKind.read:
          return ActivityActionIcon.read;
      }
    }
  }
  return ActivityActionIcon.file;
}

ParsedReconnectActivity? parseReconnectActivityMessage(
  String message,
  AppLocalizations l10n,
) {
  final trimmed = message.trim();

  final connectionFailed = _connectionFailedPattern.firstMatch(trimmed);
  if (connectionFailed != null) {
    final body = connectionFailed.group(1)?.trim() ?? '';
    final httpMatch = RegExp(
      r'^HTTP\s*(\d{3})\s*(?:[：:]\s*([\s\S]*))?$',
    ).firstMatch(body);
    if (httpMatch != null) {
      final detail = httpMatch.group(2)?.trim();
      return ParsedReconnectActivity(
        summary: l10n.activityConnectionFailedHttp(httpMatch.group(1)!),
        detail: detail == null || detail.isEmpty ? null : detail,
      );
    }
    return ParsedReconnectActivity(
      summary: l10n.activityConnectionFailed,
      detail: body.isEmpty ? null : body,
    );
  }

  return null;
}

ParsedReconnectActivity? resolveReconnectPhaseDisplay({
  required String text,
  Map<String, dynamic>? metadata,
  int? apiErrorStatusCode,
  required AppLocalizations l10n,
}) {
  final origin = metadata?['activityOrigin'];
  if (origin == 'sdk.api_retry') {
    final retry = metadata?['retry'];
    if (retry is Map) {
      final attempt = retry['attempt'];
      final maxRetries = retry['maxRetries'];
      if (attempt is num && maxRetries is num) {
        return ParsedReconnectActivity(
          summary: l10n.activityReconnectAttempt(
            attempt.toInt(),
            maxRetries.toInt(),
          ),
        );
      }
    }
  }
  if (origin == 'proxy.connection_error' && apiErrorStatusCode != null) {
    return ParsedReconnectActivity(
      summary: l10n.activityConnectionFailedHttp(apiErrorStatusCode),
    );
  }
  return parseReconnectActivityMessage(text, l10n);
}

bool isReconnectActivityOrigin(String? origin) {
  return origin == 'sdk.api_retry' || origin == 'proxy.connection_error';
}

bool isReconnectActivityMessage(String message) {
  return _connectionFailedPattern.hasMatch(message.trim());
}

final _reconnectClearSystemNoise = <RegExp>[
  RegExp(r'^Local model router ready:', caseSensitive: false),
  RegExp(r'^Claude Agent SDK ready', caseSensitive: false),
  RegExp(r'^Agent session started', caseSensitive: false),
  RegExp(r'^Agent run completed', caseSensitive: false),
  RegExp(r'^Compacting context', caseSensitive: false),
  RegExp(r'^API retry ', caseSensitive: false),
  RegExp(r'^Usage recorded', caseSensitive: false),
  RegExp(r'^Run finished', caseSensitive: false),
  RegExp(r'^已从异常退出恢复'),
];

final _reconnectInProgressPatterns = <RegExp>[
  RegExp(r'^Requesting model', caseSensitive: false),
  RegExp(r'^API error', caseSensitive: false),
];

bool shouldClearReconnectActivity({required String message, String role = ''}) {
  if (isReconnectActivityMessage(message)) {
    return false;
  }

  final trimmed = message.trim();
  if (trimmed.isEmpty ||
      trimmed == '状态已更新' ||
      RegExp(r'^状态已更新\s').hasMatch(trimmed)) {
    return false;
  }
  if (_reconnectClearSystemNoise.any((pattern) => pattern.hasMatch(trimmed))) {
    return false;
  }
  if (_reconnectInProgressPatterns.any(
    (pattern) => pattern.hasMatch(trimmed),
  )) {
    return false;
  }

  if (isSubagentMissionEnvelope(trimmed)) {
    return true;
  }
  if (RegExp(r'^正在刷新上下文用量').hasMatch(trimmed)) {
    return false;
  }
  if (RegExp(r'^Tool:', caseSensitive: false).hasMatch(trimmed) &&
      !RegExp(r'^Tool failed:', caseSensitive: false).hasMatch(trimmed)) {
    return true;
  }
  if (RegExp(r'^【\d+/\d+】').hasMatch(trimmed)) {
    return true;
  }
  if (RegExp(
    r'^(Reading|Writing|Editing|Searching|Running)\s+',
    caseSensitive: false,
  ).hasMatch(trimmed)) {
    return true;
  }
  if (role == 'thinking' && trimmed.isNotEmpty) {
    return true;
  }

  return false;
}

class ParsedReconnectActivity {
  const ParsedReconnectActivity({required this.summary, this.detail});

  final String summary;
  final String? detail;
}

String resolveSubagentRunDisplayTitle(String role, AppLocalizations l10n) {
  final normalized = normalizeAgentDisplayRole(role) ?? role;
  return switch (normalized) {
    'vision' => l10n.roleVision,
    'explore' => l10n.roleExplore,
    'architect' => l10n.roleArchitect,
    'coder' => l10n.roleCoder,
    'reviewer' => l10n.roleReviewer,
    'tester' => l10n.roleTester,
    _ => normalized,
  };
}

/// Format Codex `task_name`: split `_`, capitalize each word's first letter.
String formatSubagentTaskNameLabel(String taskName) {
  final trimmed = taskName.trim();
  if (trimmed.isEmpty) return '';
  return trimmed
      .split('_')
      .map((part) => part.trim())
      .where((part) => part.isNotEmpty)
      .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
      .join(' ');
}

String resolveSubagentActivityTitle(String roleLabel, String? taskName) {
  final formatted = taskName == null || taskName.trim().isEmpty
      ? ''
      : formatSubagentTaskNameLabel(taskName);
  return formatted.isEmpty ? roleLabel : '$roleLabel $formatted';
}

String resolveSubagentDetailTitle({
  required String roleLabel,
  String? nickname,
  String? taskName,
}) {
  final name = nickname?.trim().isNotEmpty == true
      ? nickname!.trim()
      : roleLabel;
  final formattedTaskName = taskName == null || taskName.trim().isEmpty
      ? ''
      : formatSubagentTaskNameLabel(taskName);
  return formattedTaskName.isEmpty ? name : '$name · $formattedTaskName';
}

Color subagentMissionBorderColor(
  String role, {
  SubagentThemeSource? themeSource,
}) {
  return subagent_theme.subagentMissionBorderColor(
    role,
    agents: themeSource?.agents ?? const [],
  );
}
