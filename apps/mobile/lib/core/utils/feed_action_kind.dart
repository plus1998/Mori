import '../../l10n/generated/app_localizations.dart';
import 'activity_display.dart';

enum ActionLinePhase { running, done }

enum ActionKind {
  read,
  write,
  edit,
  search,
  webSearch,
  webFetch,
  command,
  agent,
  taskCreate,
  taskUpdate,
  skill,
  mcp,
  mcpSearch,
  imageView,
  imageDisplay,
  htmlHost,
  imageCreate,
  browser,
  computerUse,
  tool,
}

enum ActionGroupBucket {
  readFiles,
  writtenFiles,
  editedFiles,
  searches,
  web,
  commands,
  taskCreates,
  taskUpdates,
  agents,
  skills,
  mcpTools,
  images,
  browser,
  computerUse,
  otherTools,
}

class ActionKindFileChange {
  const ActionKindFileChange({this.path, this.fileName});
  final String? path;
  final String? fileName;
}

class ActionKindReadTarget {
  const ActionKindReadTarget({this.filePath, this.fileName, this.lineRange});
  final String? filePath;
  final String? fileName;
  final String? lineRange;
}

class ActionKindGrepTarget {
  const ActionKindGrepTarget({this.path, this.pattern});
  final String? path;
  final String? pattern;
}

class ActionKindWebSearch {
  const ActionKindWebSearch({this.mode, this.query, this.url});
  final String? mode;
  final String? query;
  final String? url;
}

class ActionKindMcpDiscovery {
  const ActionKindMcpDiscovery({this.kind});
  final String? kind;
}

class ActionKindImageView {
  const ActionKindImageView({this.path});
  final String? path;
}

class ActionKindImageDisplay {
  const ActionKindImageDisplay({this.artifactId});
  final String? artifactId;
}

class ActionKindHtmlHost {
  const ActionKindHtmlHost({this.pageId, this.publicUrl, this.title});
  final String? pageId;
  final String? publicUrl;
  final String? title;
}

class ActionKindBashRun {
  const ActionKindBashRun({this.command});
  final String? command;
}

class ActionKindPayload {
  const ActionKindPayload({
    this.fileChange,
    this.readTarget,
    this.grepTarget,
    this.webSearch,
    this.mcpDiscovery,
    this.imageView,
    this.imageDisplay,
    this.htmlHost,
    this.bashRun,
  });

  final ActionKindFileChange? fileChange;
  final ActionKindReadTarget? readTarget;
  final ActionKindGrepTarget? grepTarget;
  final ActionKindWebSearch? webSearch;
  final ActionKindMcpDiscovery? mcpDiscovery;
  final ActionKindImageView? imageView;
  final ActionKindImageDisplay? imageDisplay;
  final ActionKindHtmlHost? htmlHost;
  final ActionKindBashRun? bashRun;
}

class ResolvedAction {
  const ResolvedAction({
    required this.kind,
    required this.icon,
    required this.bucket,
    this.namedSuffix,
  });

  final ActionKind kind;
  final ActivityActionIcon icon;
  final ActionGroupBucket bucket;
  final String? namedSuffix;
}

const _aliases = <String, ActionKind>{
  'read': ActionKind.read,
  'notebookread': ActionKind.read,
  'write': ActionKind.write,
  'edit': ActionKind.edit,
  'multiedit': ActionKind.edit,
  'notebookedit': ActionKind.edit,
  'grep': ActionKind.search,
  'glob': ActionKind.search,
  'find': ActionKind.search,
  'ls': ActionKind.search,
  'websearch': ActionKind.webSearch,
  'webfetch': ActionKind.webFetch,
  'bash': ActionKind.command,
  'shell': ActionKind.command,
  'cmd': ActionKind.command,
  'powershell': ActionKind.command,
  'agent': ActionKind.agent,
  'task': ActionKind.agent,
  'tasklist': ActionKind.agent,
  'taskoutput': ActionKind.agent,
  'taskcreate': ActionKind.taskCreate,
  'taskupdate': ActionKind.taskUpdate,
  'todowrite': ActionKind.taskUpdate,
  'skill': ActionKind.skill,
  'skills': ActionKind.skill,
  'readskill': ActionKind.skill,
  'mcp': ActionKind.mcp,
  'mcp_tool': ActionKind.mcp,
  'mcpscript': ActionKind.mcp,
  'viewimage': ActionKind.imageView,
  'view_image': ActionKind.imageView,
  'displayimage': ActionKind.imageDisplay,
  'display_image': ActionKind.imageDisplay,
  'show_media_to_user': ActionKind.imageDisplay,
  'publishhtml': ActionKind.htmlHost,
  'publish_html': ActionKind.htmlHost,
};

const _kindIcon = <ActionKind, ActivityActionIcon>{
  ActionKind.read: ActivityActionIcon.read,
  ActionKind.write: ActivityActionIcon.edit,
  ActionKind.edit: ActivityActionIcon.edit,
  ActionKind.search: ActivityActionIcon.search,
  ActionKind.webSearch: ActivityActionIcon.network,
  ActionKind.webFetch: ActivityActionIcon.network,
  ActionKind.command: ActivityActionIcon.terminal,
  ActionKind.agent: ActivityActionIcon.agent,
  ActionKind.taskCreate: ActivityActionIcon.edit,
  ActionKind.taskUpdate: ActivityActionIcon.edit,
  ActionKind.skill: ActivityActionIcon.file,
  ActionKind.mcp: ActivityActionIcon.network,
  ActionKind.mcpSearch: ActivityActionIcon.network,
  ActionKind.imageView: ActivityActionIcon.images,
  ActionKind.imageDisplay: ActivityActionIcon.images,
  ActionKind.htmlHost: ActivityActionIcon.browser,
  ActionKind.imageCreate: ActivityActionIcon.image,
  ActionKind.browser: ActivityActionIcon.browser,
  ActionKind.computerUse: ActivityActionIcon.computer,
  ActionKind.tool: ActivityActionIcon.tool,
};

const _kindBucket = <ActionKind, ActionGroupBucket>{
  ActionKind.read: ActionGroupBucket.readFiles,
  ActionKind.write: ActionGroupBucket.writtenFiles,
  ActionKind.edit: ActionGroupBucket.editedFiles,
  ActionKind.search: ActionGroupBucket.searches,
  ActionKind.webSearch: ActionGroupBucket.web,
  ActionKind.webFetch: ActionGroupBucket.web,
  ActionKind.command: ActionGroupBucket.commands,
  ActionKind.agent: ActionGroupBucket.agents,
  ActionKind.taskCreate: ActionGroupBucket.taskCreates,
  ActionKind.taskUpdate: ActionGroupBucket.taskUpdates,
  ActionKind.skill: ActionGroupBucket.skills,
  ActionKind.mcp: ActionGroupBucket.mcpTools,
  ActionKind.mcpSearch: ActionGroupBucket.mcpTools,
  ActionKind.imageView: ActionGroupBucket.images,
  ActionKind.imageDisplay: ActionGroupBucket.images,
  ActionKind.htmlHost: ActionGroupBucket.browser,
  ActionKind.imageCreate: ActionGroupBucket.images,
  ActionKind.browser: ActionGroupBucket.browser,
  ActionKind.computerUse: ActionGroupBucket.computerUse,
  ActionKind.tool: ActionGroupBucket.otherTools,
};

const _actionGroupIconPriority = <ActivityActionIcon>[
  ActivityActionIcon.edit,
  ActivityActionIcon.read,
  ActivityActionIcon.file,
  ActivityActionIcon.search,
  ActivityActionIcon.network,
  ActivityActionIcon.terminal,
  ActivityActionIcon.browser,
  ActivityActionIcon.computer,
  ActivityActionIcon.images,
  ActivityActionIcon.image,
  ActivityActionIcon.agent,
  ActivityActionIcon.tool,
];

const _summaryBucketOrder = <ActionGroupBucket>[
  ActionGroupBucket.readFiles,
  ActionGroupBucket.writtenFiles,
  ActionGroupBucket.editedFiles,
  ActionGroupBucket.searches,
  ActionGroupBucket.web,
  ActionGroupBucket.commands,
  ActionGroupBucket.taskCreates,
  ActionGroupBucket.taskUpdates,
  ActionGroupBucket.agents,
  ActionGroupBucket.skills,
  ActionGroupBucket.mcpTools,
  ActionGroupBucket.images,
  ActionGroupBucket.browser,
  ActionGroupBucket.computerUse,
  ActionGroupBucket.otherTools,
];

ResolvedAction _resolved(ActionKind kind, [String? namedSuffix]) {
  return ResolvedAction(
    kind: kind,
    icon: _kindIcon[kind]!,
    bucket: _kindBucket[kind]!,
    namedSuffix: namedSuffix,
  );
}

ActionKind? _kindFromPayload(ActionKindPayload? payload) {
  if (payload == null) return null;
  if (payload.fileChange != null) return ActionKind.edit;
  if (payload.readTarget != null) return ActionKind.read;
  if (payload.grepTarget != null) return ActionKind.search;
  if (payload.webSearch != null) {
    return payload.webSearch!.mode == 'fetch'
        ? ActionKind.webFetch
        : ActionKind.webSearch;
  }
  if (payload.imageView != null) return ActionKind.imageView;
  if (payload.imageDisplay != null) return ActionKind.imageDisplay;
  if (payload.htmlHost != null) return ActionKind.htmlHost;
  if (payload.bashRun != null) return ActionKind.command;
  return null;
}

bool isCommandToolName(String? toolName) {
  final name = toolName?.trim().toLowerCase() ?? '';
  if (name.isEmpty) return false;
  return _aliases[name] == ActionKind.command;
}

ResolvedAction resolveActionKind({
  String? toolName,
  ActionKindPayload? payload,
}) {
  final rawName = toolName ?? '';
  final name = rawName.trim().toLowerCase();

  if (payload?.mcpDiscovery?.kind == 'search') {
    return _resolved(ActionKind.mcpSearch);
  }

  final aliasKind = name.isEmpty ? null : _aliases[name];
  if (aliasKind != null) {
    if (aliasKind == ActionKind.webSearch &&
        payload?.webSearch?.mode == 'fetch') {
      return _resolved(ActionKind.webFetch);
    }
    return _resolved(aliasKind);
  }

  final payloadKind = _kindFromPayload(payload);
  if (payloadKind != null) {
    return _resolved(payloadKind);
  }

  if (isEcoAgentBrowserToolName(toolName)) {
    return _resolved(ActionKind.browser, ecoAgentBrowserToolSuffix(rawName));
  }
  if (isEcoComputerUseToolName(toolName)) {
    return _resolved(ActionKind.computerUse);
  }
  if (isEcoImageGenerationToolName(toolName)) {
    return _resolved(ActionKind.imageCreate);
  }
  if (isEcoImageViewToolName(toolName)) {
    return _resolved(ActionKind.imageView);
  }
  if (isEcoImageDisplayToolName(toolName)) {
    return _resolved(ActionKind.imageDisplay);
  }
  if (isEcoHtmlHostToolName(toolName)) {
    return _resolved(ActionKind.htmlHost);
  }
  if (isEcoWebSearchToolName(toolName)) {
    return _resolved(ActionKind.webSearch);
  }

  if (name.startsWith('mcp__')) {
    return _resolved(ActionKind.mcp);
  }

  if (name.contains('skill')) {
    return _resolved(ActionKind.skill);
  }

  return _resolved(ActionKind.tool);
}

String _clamp64(String value) {
  return value.length <= 64 ? value : value.substring(0, 64);
}

String _hostFromUrl(String value) {
  final host = Uri.tryParse(value)?.host;
  if (host != null && host.isNotEmpty) return host;
  return value;
}

String? resolveActionTarget(
  ResolvedAction resolved, {
  ActionKindPayload? payload,
  String? rawTarget,
}) {
  final raw = rawTarget?.trim();
  final normalizedRaw = (raw == null || raw.isEmpty) ? null : raw;

  switch (resolved.kind) {
    case ActionKind.read:
      final path =
          payload?.readTarget?.fileName ??
          payload?.readTarget?.filePath ??
          normalizedRaw;
      if (path == null) return null;
      final name = pathBasename(path);
      final range = payload?.readTarget?.lineRange?.trim();
      return range == null || range.isEmpty ? name : '$name $range';
    case ActionKind.write:
    case ActionKind.edit:
      final path =
          payload?.fileChange?.fileName ??
          payload?.fileChange?.path ??
          normalizedRaw;
      return path == null ? null : pathBasename(path);
    case ActionKind.search:
      return payload?.grepTarget?.pattern ??
          payload?.grepTarget?.path ??
          normalizedRaw;
    case ActionKind.webSearch:
      return payload?.webSearch?.query ?? normalizedRaw;
    case ActionKind.webFetch:
      final value = payload?.webSearch?.url ?? normalizedRaw;
      return value == null ? null : _hostFromUrl(value);
    case ActionKind.command:
      return payload?.bashRun?.command ?? normalizedRaw;
    case ActionKind.browser:
      if (resolved.namedSuffix == 'agent_browser_open' ||
          resolved.namedSuffix == 'agent_browser_get_url') {
        final value = payload?.webSearch?.url ?? normalizedRaw;
        return value == null ? null : _hostFromUrl(value);
      }
      return null;
    case ActionKind.agent:
    case ActionKind.skill:
    case ActionKind.mcp:
    case ActionKind.taskCreate:
    case ActionKind.taskUpdate:
    case ActionKind.tool:
      return normalizedRaw;
    case ActionKind.mcpSearch:
    case ActionKind.imageView:
    case ActionKind.imageDisplay:
    case ActionKind.htmlHost:
    case ActionKind.imageCreate:
    case ActionKind.computerUse:
      return null;
  }
}

String? _namedLabel(String suffix, AppLocalizations l10n) {
  return switch (suffix) {
    'finalize_plan' => l10n.activityNamedFinalizePlan,
    'create_image' => l10n.activityNamedCreateImage,
    'computer_use' => l10n.activityNamedComputerUse,
    'view_image' => l10n.activityNamedViewImage,
    'display_image' => l10n.activityNamedDisplayImage,
    'show_media_to_user' => l10n.activityNamedShowMediaToUser,
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
    _ => null,
  };
}

String _runningLine(ActionKind kind, String suffix, AppLocalizations l10n) {
  return switch (kind) {
    ActionKind.read => l10n.activityRunningRead(suffix),
    ActionKind.write => l10n.activityRunningWrite(suffix),
    ActionKind.edit => l10n.activityRunningEdit(suffix),
    ActionKind.search => l10n.activityRunningSearch(suffix),
    ActionKind.webSearch => l10n.activityRunningWebSearch(suffix),
    ActionKind.webFetch => l10n.activityRunningWebFetch(suffix),
    ActionKind.command => l10n.activityRunningCommand(suffix),
    ActionKind.agent => l10n.activityRunningAgent(suffix),
    ActionKind.taskCreate => l10n.activityRunningTaskCreate(suffix),
    ActionKind.taskUpdate => l10n.activityRunningTaskUpdate(suffix),
    ActionKind.skill => l10n.activityRunningSkill(suffix),
    ActionKind.mcp => l10n.activityRunningMcp(suffix),
    ActionKind.tool => l10n.activityRunningTool(suffix),
    ActionKind.mcpSearch => l10n.activityRunningMcpSearch,
    ActionKind.imageView => l10n.activityImageViewViewing,
    ActionKind.imageDisplay => l10n.activityImageDisplayViewing,
    ActionKind.htmlHost => l10n.activityHtmlHostPublishing,
    ActionKind.imageCreate => l10n.activityRunningImageCreate,
    ActionKind.browser => l10n.activityRunningBrowserOpen(suffix),
    ActionKind.computerUse => l10n.activityRunningComputerUse,
  };
}

String _doneLine(ActionKind kind, String suffix, AppLocalizations l10n) {
  return switch (kind) {
    ActionKind.read => l10n.activityDoneRead(suffix),
    ActionKind.write => l10n.activityDoneWrite(suffix),
    ActionKind.edit => l10n.activityDoneEdit(suffix),
    ActionKind.search => l10n.activityDoneSearch(suffix),
    ActionKind.webSearch => l10n.activityDoneWebSearch(suffix),
    ActionKind.webFetch => l10n.activityDoneWebFetch(suffix),
    ActionKind.command => l10n.activityDoneCommand(suffix),
    ActionKind.agent => l10n.activityDoneAgent(suffix),
    ActionKind.taskCreate => l10n.activityDoneTaskCreate(suffix),
    ActionKind.taskUpdate => l10n.activityDoneTaskUpdate(suffix),
    ActionKind.skill => l10n.activityDoneSkill(suffix),
    ActionKind.mcp => l10n.activityDoneMcp(suffix),
    ActionKind.tool => l10n.activityDoneTool(suffix),
    ActionKind.mcpSearch => l10n.activityDoneMcpSearch,
    ActionKind.imageView => l10n.activityImageViewViewed,
    ActionKind.imageDisplay => l10n.activityImageDisplayViewed,
    ActionKind.htmlHost => l10n.activityHtmlHostPublished,
    ActionKind.imageCreate => l10n.activityDoneImageCreate,
    ActionKind.browser => l10n.activityDoneBrowserOpen(suffix),
    ActionKind.computerUse => l10n.activityDoneComputerUse,
  };
}

String _doneFallback(ActionKind kind, AppLocalizations l10n) {
  return switch (kind) {
    ActionKind.read => l10n.activityDoneReadFallback,
    ActionKind.write => l10n.activityDoneWriteFallback,
    ActionKind.edit => l10n.activityDoneEditFallback,
    ActionKind.search => l10n.activityDoneSearchFallback,
    ActionKind.webSearch => l10n.activityDoneWebSearchFallback,
    ActionKind.webFetch => l10n.activityDoneWebFetchFallback,
    ActionKind.command => l10n.activityDoneCommandFallback,
    ActionKind.agent => l10n.activityDoneAgentFallback,
    ActionKind.taskCreate => l10n.activityDoneTaskCreateFallback,
    ActionKind.taskUpdate => l10n.activityDoneTaskUpdateFallback,
    ActionKind.skill => l10n.activityDoneSkillFallback,
    ActionKind.mcp => l10n.activityDoneMcpFallback,
    ActionKind.tool => l10n.activityDoneToolFallback,
    ActionKind.mcpSearch => l10n.activityDoneMcpSearch,
    ActionKind.imageView => l10n.activityImageViewViewed,
    ActionKind.imageDisplay => l10n.activityImageDisplayViewed,
    ActionKind.htmlHost => l10n.activityHtmlHostPublished,
    ActionKind.imageCreate => l10n.activityDoneImageCreate,
    ActionKind.browser => l10n.activityDoneToolFallback,
    ActionKind.computerUse => l10n.activityDoneComputerUse,
  };
}

String formatActionLine({
  required ResolvedAction resolved,
  required ActionLinePhase phase,
  String? rawTarget,
  ActionKindPayload? payload,
  required AppLocalizations l10n,
}) {
  final kind = resolved.kind;

  if (kind == ActionKind.imageView) {
    return phase == ActionLinePhase.running
        ? l10n.activityImageViewViewing
        : l10n.activityImageViewViewed;
  }
  if (kind == ActionKind.imageDisplay) {
    return phase == ActionLinePhase.running
        ? l10n.activityImageDisplayViewing
        : l10n.activityImageDisplayViewed;
  }
  if (kind == ActionKind.htmlHost) {
    return phase == ActionLinePhase.running
        ? l10n.activityHtmlHostPublishing
        : l10n.activityHtmlHostPublished;
  }
  if (kind == ActionKind.imageCreate) {
    return phase == ActionLinePhase.running
        ? l10n.activityRunningImageCreate
        : l10n.activityDoneImageCreate;
  }
  if (kind == ActionKind.computerUse) {
    return phase == ActionLinePhase.running
        ? l10n.activityRunningComputerUse
        : l10n.activityDoneComputerUse;
  }
  if (kind == ActionKind.mcpSearch) {
    return phase == ActionLinePhase.running
        ? l10n.activityRunningMcpSearch
        : l10n.activityDoneMcpSearch;
  }
  if (kind == ActionKind.browser) {
    final target = resolveActionTarget(
      resolved,
      payload: payload,
      rawTarget: rawTarget,
    );
    if ((resolved.namedSuffix == 'agent_browser_open' ||
            resolved.namedSuffix == 'agent_browser_get_url') &&
        target != null) {
      final suffix = ' ${_clamp64(target)}';
      return phase == ActionLinePhase.running
          ? l10n.activityRunningBrowserOpen(suffix)
          : l10n.activityDoneBrowserOpen(suffix);
    }
    final namedSuffix = resolved.namedSuffix;
    if (namedSuffix != null && namedSuffix.isNotEmpty) {
      final named = _namedLabel(namedSuffix, l10n);
      if (named != null) return named;
      return namedSuffix;
    }
    return l10n.activityDoneToolFallback;
  }

  final target = resolveActionTarget(
    resolved,
    payload: payload,
    rawTarget: rawTarget,
  );
  if (target != null) {
    final suffix = ' ${_clamp64(target)}';
    return phase == ActionLinePhase.running
        ? _runningLine(kind, suffix, l10n)
        : _doneLine(kind, suffix, l10n);
  }
  if (phase == ActionLinePhase.done) {
    return _doneFallback(kind, l10n);
  }
  return _runningLine(kind, '', l10n);
}

String _summaryClause(
  ActionGroupBucket bucket,
  int count,
  AppLocalizations l10n,
) {
  return switch (bucket) {
    ActionGroupBucket.readFiles => l10n.activityReadFiles(count),
    ActionGroupBucket.writtenFiles => l10n.activityWroteFiles(count),
    ActionGroupBucket.editedFiles => l10n.activityEditedFiles(count),
    ActionGroupBucket.searches => l10n.activitySearchedCodeTimes(count),
    ActionGroupBucket.web => l10n.activitySummaryWeb(count),
    ActionGroupBucket.commands => l10n.activityRanCommands(count),
    ActionGroupBucket.taskCreates => l10n.activitySummaryCreatedTasks(count),
    ActionGroupBucket.taskUpdates => l10n.activitySummaryUpdatedTasks(count),
    ActionGroupBucket.agents => l10n.activityCalledSubagents(count),
    ActionGroupBucket.skills => l10n.activitySummarySkills(count),
    ActionGroupBucket.mcpTools => l10n.activitySummaryMcpTools(count),
    ActionGroupBucket.images => l10n.activitySummaryImages(count),
    ActionGroupBucket.browser => l10n.activitySummaryBrowser(count),
    ActionGroupBucket.computerUse => l10n.activitySummaryComputerUse(count),
    ActionGroupBucket.otherTools => l10n.activityRanTools(count),
  };
}

({String label, ActivityActionIcon icon}) summarizeActionGroup(
  List<ResolvedAction> items,
  AppLocalizations l10n,
) {
  final clauses = <String>[];
  for (final bucket in _summaryBucketOrder) {
    final count = items.where((item) => item.bucket == bucket).length;
    if (count > 0) {
      clauses.add(_summaryClause(bucket, count, l10n));
    }
  }

  var label = clauses.isEmpty ? '' : clauses.first;
  if (clauses.length == 2) {
    label = l10n.activityListPair(clauses[0], clauses[1]);
  } else if (clauses.length > 2) {
    label = l10n.activityListEnd(
      clauses.sublist(0, clauses.length - 1).join(l10n.activityJoinSeparator),
      clauses.last,
    );
  }

  var icon = ActivityActionIcon.tool;
  for (final candidate in _actionGroupIconPriority) {
    if (items.any((item) => item.icon == candidate)) {
      icon = candidate;
      break;
    }
  }

  return (label: label, icon: icon);
}
