import '../utils/conversation_v2_hash.dart';
import 'conversation_v2_projection_models.dart';
import 'thread_usage_models.dart';

typedef ConversationJson = Map<String, dynamic>;

/// The presentation facts that are persisted alongside the V2 event stream.
///
/// This is intentionally a read model: the mobile Feed still derives its
/// timeline from the V2 message/run/tool tables, while billing, context and
/// request timing use the same V2 projection snapshot as desktop. The legacy
/// usage/projection RPCs must not be consulted once this model is available.
class ConversationV2ProjectionExtras {
  const ConversationV2ProjectionExtras({
    this.requestSpans = const [],
    this.billing,
    this.context,
    this.subagentTimings = const [],
  });

  factory ConversationV2ProjectionExtras.fromJson(dynamic value) {
    final json = _map(value);
    final requestSpans = json['requestSpans'];
    final subagentTimings = json['subagentTimings'];
    return ConversationV2ProjectionExtras(
      requestSpans: requestSpans is List
          ? requestSpans
                .whereType<Map>()
                .map(
                  (entry) => ThreadRunProjectionRequestSpan.fromJson(
                    Map<String, dynamic>.from(entry),
                  ),
                )
                .toList(growable: false)
          : const [],
      billing: json['billing'] is Map
          ? ThreadBillingSnapshot.fromJson(
              Map<String, dynamic>.from(json['billing'] as Map),
            )
          : null,
      context: json['context'] is Map
          ? ThreadContextSnapshot.fromJson(
              Map<String, dynamic>.from(json['context'] as Map),
            )
          : null,
      subagentTimings: subagentTimings is List
          ? subagentTimings
                .whereType<Map>()
                .map(
                  (entry) => ThreadSubagentSessionTiming.fromJson(
                    Map<String, dynamic>.from(entry),
                  ),
                )
                .toList(growable: false)
          : const [],
    );
  }

  final List<ThreadRunProjectionRequestSpan> requestSpans;
  final ThreadBillingSnapshot? billing;
  final ThreadContextSnapshot? context;
  final List<ThreadSubagentSessionTiming> subagentTimings;
}

/// Effect types understood by the V2 cache reducer.
///
/// Keep this list explicit: an effect with an unknown type must stop sync and
/// put the client in the incompatible state. In particular, it must not be
/// skipped merely because its sequence is covered by a bootstrap snapshot.
const conversationV2SupportedEffectTypes = <String>{
  'message.create',
  'message.append',
  'message.replace',
  'message.finalize',
  'message.tombstone',
  'message.history_target',
  'run.upsert',
  'tool.summary.upsert',
  'agent.upsert',
  'todo.list.replace',
  'detail.upsert',
  'detail.invalidation',
  'history.invalidation',
  'noop',
};

enum ConversationV2MessageStatus {
  queued,
  streaming,
  finalised,
  failed,
  cancelled,
  deleted,
}

enum ConversationV2SyncState {
  uninitialized,
  bootstrapping,
  catchingUp,
  live,
  offline,
  error,
  incompatible,
}

class ConversationV2Capabilities {
  const ConversationV2Capabilities({
    required this.protocolVersion,
    required this.eventSchemaVersion,
    required this.effectVersion,
    required this.maxEvents,
    required this.maxBytes,
    required this.storeEpoch,
  });

  final int protocolVersion;
  final int eventSchemaVersion;
  final int effectVersion;
  final int maxEvents;
  final int maxBytes;
  final String storeEpoch;

  factory ConversationV2Capabilities.fromJson(dynamic value) {
    final json = _map(value);
    return ConversationV2Capabilities(
      protocolVersion: _int(json['protocolVersion'], 'protocolVersion'),
      eventSchemaVersion: _int(
        json['eventSchemaVersion'],
        'eventSchemaVersion',
      ),
      effectVersion: _int(json['effectVersion'], 'effectVersion'),
      maxEvents: _int(json['maxEvents'], 'maxEvents'),
      maxBytes: _int(json['maxBytes'], 'maxBytes'),
      storeEpoch: _string(json['storeEpoch'], 'storeEpoch'),
    );
  }
}

/// Immutable provider/history identity carried with a V2 user message.
///
/// A prompt without [userMessageId] remains readable but cannot be used for a
/// destructive Claude rewind. The UI must keep that distinction explicit.
class ConversationV2HistoryTarget {
  const ConversationV2HistoryTarget({
    required this.activityLineId,
    this.userMessageId,
  });

  factory ConversationV2HistoryTarget.fromJson(dynamic value) {
    final json = _map(value);
    final activityLineId = _string(
      json['activityLineId'],
      'historyTarget.activityLineId',
    );
    final userMessageId = _optionalString(
      json['userMessageId'],
      'historyTarget.userMessageId',
    );
    return ConversationV2HistoryTarget(
      activityLineId: activityLineId,
      userMessageId: userMessageId,
    );
  }

  final String activityLineId;
  final String? userMessageId;

  ConversationJson toJson() => {
    'activityLineId': activityLineId,
    if (userMessageId != null) 'userMessageId': userMessageId,
  };
}

class ConversationV2Message {
  const ConversationV2Message({
    required this.messageId,
    required this.conversationId,
    required this.turnId,
    required this.role,
    required this.channel,
    required this.createdSeq,
    required this.versionSeq,
    required this.contentVersion,
    required this.body,
    required this.status,
    required this.isDeleted,
    this.runId,
    this.agentId,
    this.agentInstanceId,
    this.occurredAt,
    this.providerRole,
    this.attachments,
    this.historyTarget,
  });

  final String messageId;
  final String conversationId;
  final String turnId;
  final String? runId;
  final String role;
  final String channel;
  final int createdSeq;
  final int versionSeq;
  final int contentVersion;
  final String body;
  final ConversationV2MessageStatus status;
  final bool isDeleted;

  /// Owning agent instance, null for the main agent. A subagent's narration
  /// carries the same identity its tool rows do, which is what keeps subagent
  /// output out of the main Feed instead of merging it in.
  final String? agentId;
  final String? agentInstanceId;

  /// When the row happened, from the event that produced it. [createdSeq] says when
  /// this client learned about the row, so a Feed that only has the sequence cannot
  /// place a message between the two tools of its own turn.
  final String? occurredAt;

  /// The provider's own label for the row (`main`, `coder`, ...), kept separate from
  /// [role]. `role` is the normalized channel role; this is the fact the Feed uses to
  /// pick a turn's final output.
  final String? providerRole;
  final List<dynamic>? attachments;
  final ConversationV2HistoryTarget? historyTarget;

  ConversationV2Message copyWith({
    String? runId,
    String? body,
    int? versionSeq,
    int? contentVersion,
    ConversationV2MessageStatus? status,
    bool? isDeleted,
    String? agentId,
    String? agentInstanceId,
    String? occurredAt,
    List<dynamic>? attachments,
    ConversationV2HistoryTarget? historyTarget,
    bool clearAttachments = false,
  }) {
    return ConversationV2Message(
      messageId: messageId,
      conversationId: conversationId,
      turnId: turnId,
      runId: runId ?? this.runId,
      role: role,
      channel: channel,
      createdSeq: createdSeq,
      versionSeq: versionSeq ?? this.versionSeq,
      contentVersion: contentVersion ?? this.contentVersion,
      body: body ?? this.body,
      status: status ?? this.status,
      isDeleted: isDeleted ?? this.isDeleted,
      agentId: agentId ?? this.agentId,
      agentInstanceId: agentInstanceId ?? this.agentInstanceId,
      occurredAt: occurredAt ?? this.occurredAt,
      providerRole: providerRole,
      attachments: clearAttachments ? null : (attachments ?? this.attachments),
      historyTarget: historyTarget ?? this.historyTarget,
    );
  }

  factory ConversationV2Message.fromJson(dynamic value) {
    final json = _map(value);
    return ConversationV2Message(
      messageId: _string(json['messageId'], 'messageId'),
      conversationId: _string(json['conversationId'], 'conversationId'),
      turnId: _string(json['turnId'], 'turnId'),
      runId: _optionalString(json['runId'], 'runId'),
      role: _messageRole(json['role']),
      channel: _messageChannel(json['channel']),
      createdSeq: _int(json['createdSeq'], 'createdSeq'),
      versionSeq: _int(json['versionSeq'], 'versionSeq'),
      contentVersion: _int(json['contentVersion'], 'contentVersion'),
      body: _text(json['body'], 'body'),
      status: _messageStatus(json['status']),
      isDeleted: _bool(json['isDeleted'], 'isDeleted'),
      agentId: _optionalString(json['agentId'], 'agentId'),
      agentInstanceId: _optionalString(
        json['agentInstanceId'],
        'agentInstanceId',
      ),
      occurredAt: _optionalString(json['occurredAt'], 'occurredAt'),
      providerRole: _optionalString(json['providerRole'], 'providerRole'),
      attachments: json['attachments'] == null
          ? null
          : _list(json['attachments'], 'attachments'),
      historyTarget: json['historyTarget'] == null
          ? null
          : ConversationV2HistoryTarget.fromJson(json['historyTarget']),
    );
  }

  ConversationJson toJson() => {
    'messageId': messageId,
    'conversationId': conversationId,
    'turnId': turnId,
    if (runId != null) 'runId': runId,
    'role': role,
    'channel': channel,
    'createdSeq': createdSeq,
    'versionSeq': versionSeq,
    'contentVersion': contentVersion,
    'body': body,
    'status': status.name == 'finalised' ? 'final' : status.name,
    'isDeleted': isDeleted,
    if (agentId != null) 'agentId': agentId,
    if (agentInstanceId != null) 'agentInstanceId': agentInstanceId,
    if (occurredAt != null) 'occurredAt': occurredAt,
    if (providerRole != null) 'providerRole': providerRole,
    if (attachments != null) 'attachments': attachments,
    if (historyTarget != null) 'historyTarget': historyTarget!.toJson(),
  };
}

class ConversationV2Run {
  const ConversationV2Run({
    required this.runId,
    required this.conversationId,
    required this.turnId,
    required this.status,
    required this.versionSeq,
    required this.timingQuality,
    this.startedAt,
    this.endedAt,
    this.retryOfRunId,
    this.regenerationOfRunId,
  });

  final String runId;
  final String conversationId;
  final String turnId;
  final String status;
  final int versionSeq;
  final String timingQuality;
  final String? startedAt;
  final String? endedAt;
  final String? retryOfRunId;
  final String? regenerationOfRunId;

  factory ConversationV2Run.fromJson(dynamic value) {
    final json = _map(value);
    return ConversationV2Run(
      runId: _string(json['runId'], 'runId'),
      conversationId: _string(json['conversationId'], 'conversationId'),
      turnId: _string(json['turnId'], 'turnId'),
      status: _string(json['status'], 'status'),
      versionSeq: _int(json['versionSeq'], 'versionSeq'),
      timingQuality: _string(json['timingQuality'], 'timingQuality'),
      startedAt: _optionalString(json['startedAt'], 'startedAt'),
      endedAt: _optionalString(json['endedAt'], 'endedAt'),
      retryOfRunId: _optionalString(json['retryOfRunId'], 'retryOfRunId'),
      regenerationOfRunId: _optionalString(
        json['regenerationOfRunId'],
        'regenerationOfRunId',
      ),
    );
  }

  ConversationJson toJson() => {
    'runId': runId,
    'conversationId': conversationId,
    'turnId': turnId,
    'status': status,
    'versionSeq': versionSeq,
    'timingQuality': timingQuality,
    if (startedAt != null) 'startedAt': startedAt,
    if (endedAt != null) 'endedAt': endedAt,
    if (retryOfRunId != null) 'retryOfRunId': retryOfRunId,
    if (regenerationOfRunId != null) 'regenerationOfRunId': regenerationOfRunId,
  };
}

class ConversationV2Tool {
  const ConversationV2Tool({
    required this.toolCallId,
    required this.conversationId,
    required this.runId,
    required this.name,
    required this.status,
    required this.createdSeq,
    required this.versionSeq,
    this.agentId,
    this.agentInstanceId,
    this.parentAgentInstanceId,
    this.parentToolCallId,
    this.occurredAt,
    this.providerRole,
    this.input,
    this.output,
  });

  final String toolCallId;
  final String conversationId;
  final String runId;
  final String? agentId;
  final String? agentInstanceId;
  final String? parentAgentInstanceId;
  final String? parentToolCallId;
  final String name;
  final String status;
  final int createdSeq;
  final int versionSeq;

  /// See [ConversationV2Message.occurredAt]: the call's own time, not its sequence.
  final String? occurredAt;

  /// See [ConversationV2Message.providerRole].
  final String? providerRole;
  final dynamic input;
  final dynamic output;

  factory ConversationV2Tool.fromJson(dynamic value) {
    final json = _map(value);
    return ConversationV2Tool(
      toolCallId: _string(json['toolCallId'], 'toolCallId'),
      conversationId: _string(json['conversationId'], 'conversationId'),
      runId: _string(json['runId'], 'runId'),
      agentId: _optionalString(json['agentId'], 'agentId'),
      agentInstanceId: _optionalString(
        json['agentInstanceId'],
        'agentInstanceId',
      ),
      parentAgentInstanceId: _optionalString(
        json['parentAgentInstanceId'],
        'parentAgentInstanceId',
      ),
      parentToolCallId: _optionalString(
        json['parentToolCallId'],
        'parentToolCallId',
      ),
      name: _string(json['name'], 'name'),
      status: _string(json['status'], 'status'),
      createdSeq: _int(json['createdSeq'], 'createdSeq'),
      versionSeq: _int(json['versionSeq'], 'versionSeq'),
      occurredAt: _optionalString(json['occurredAt'], 'occurredAt'),
      providerRole: _optionalString(json['providerRole'], 'providerRole'),
      input: json['input'],
      output: json['output'],
    );
  }

  ConversationJson toJson() => {
    'toolCallId': toolCallId,
    'conversationId': conversationId,
    'runId': runId,
    if (agentId != null) 'agentId': agentId,
    if (agentInstanceId != null) 'agentInstanceId': agentInstanceId,
    if (parentAgentInstanceId != null)
      'parentAgentInstanceId': parentAgentInstanceId,
    if (parentToolCallId != null) 'parentToolCallId': parentToolCallId,
    'name': name,
    'status': status,
    'createdSeq': createdSeq,
    'versionSeq': versionSeq,
    if (occurredAt != null) 'occurredAt': occurredAt,
    if (providerRole != null) 'providerRole': providerRole,
    if (input != null) 'input': input,
    if (output != null) 'output': output,
  };
}

/// One agent the conversation ran, as the desktop registry records it.
///
/// A client that only has messages and tools can infer agent identity from a tool row's
/// owner, which loses the role, the mission text and the parent link, and cannot tell an
/// agent whose narration never called a tool from a row of the main agent. The registry is
/// the authority for "is this row an agent's card", the same way it is on the desktop.
class ConversationV2Agent {
  const ConversationV2Agent({
    required this.agentId,
    required this.conversationId,
    required this.role,
    required this.kind,
    required this.status,
    required this.versionSeq,
    this.runId,
    this.parentAgentInstanceId,
    this.parentToolCallId,
    this.startedAt,
    this.endedAt,
    this.mission,
    this.taskName,
    this.delegationSummary,
    this.delegationPrompt,
    this.todoId,
  });

  final String agentId;
  final String conversationId;
  final String role;
  final String kind;
  final String status;
  final int versionSeq;
  final String? runId;
  final String? parentAgentInstanceId;
  final String? parentToolCallId;
  final String? startedAt;
  final String? endedAt;
  final String? mission;

  /// The label the provider gave this agent's task, shown as the card's own title.
  final String? taskName;

  /// What the agent was asked to do, in the words the delegating model used.
  final String? delegationSummary;
  final String? delegationPrompt;
  final String? todoId;

  factory ConversationV2Agent.fromJson(dynamic value) {
    final json = _map(value);
    return ConversationV2Agent(
      agentId: _string(json['agentId'], 'agentId'),
      conversationId: _string(json['conversationId'], 'conversationId'),
      role: _string(json['role'], 'role'),
      kind: _string(json['kind'], 'kind'),
      status: _string(json['status'], 'status'),
      versionSeq: _int(json['versionSeq'], 'versionSeq'),
      runId: _optionalString(json['runId'], 'runId'),
      parentAgentInstanceId: _optionalString(
        json['parentAgentInstanceId'],
        'parentAgentInstanceId',
      ),
      parentToolCallId: _optionalString(
        json['parentToolCallId'],
        'parentToolCallId',
      ),
      startedAt: _optionalString(json['startedAt'], 'startedAt'),
      endedAt: _optionalString(json['endedAt'], 'endedAt'),
      mission: json['mission'] == null
          ? null
          : _text(json['mission'], 'mission'),
      taskName: _optionalString(json['taskName'], 'taskName'),
      delegationSummary: _optionalString(
        json['delegationSummary'],
        'delegationSummary',
      ),
      delegationPrompt: _optionalString(
        json['delegationPrompt'],
        'delegationPrompt',
      ),
      todoId: _optionalString(json['todoId'], 'todoId'),
    );
  }

  ConversationJson toJson() => {
    'agentId': agentId,
    'conversationId': conversationId,
    'role': role,
    'kind': kind,
    'status': status,
    'versionSeq': versionSeq,
    if (runId != null) 'runId': runId,
    if (parentAgentInstanceId != null)
      'parentAgentInstanceId': parentAgentInstanceId,
    if (parentToolCallId != null) 'parentToolCallId': parentToolCallId,
    if (startedAt != null) 'startedAt': startedAt,
    if (endedAt != null) 'endedAt': endedAt,
    if (mission != null) 'mission': mission,
    if (taskName != null) 'taskName': taskName,
    if (delegationSummary != null) 'delegationSummary': delegationSummary,
    if (delegationPrompt != null) 'delegationPrompt': delegationPrompt,
    if (todoId != null) 'todoId': todoId,
  };
}

class ConversationV2Todo {
  const ConversationV2Todo({
    required this.todoId,
    required this.conversationId,
    required this.title,
    required this.detail,
    required this.status,
    required this.position,
    required this.updatedAt,
    required this.versionSeq,
  });

  final String todoId;
  final String conversationId;
  final String title;
  final String detail;
  final String status;
  final int position;
  final String updatedAt;
  final int versionSeq;

  factory ConversationV2Todo.fromJson(dynamic value) {
    final json = _map(value);
    final status = _string(json['status'], 'status');
    if (!const {
      'pending',
      'running',
      'completed',
      'blocked',
      'cancelled',
    }.contains(status)) {
      throw const FormatException('Conversation V2 todo status is invalid.');
    }
    final position = _int(json['position'], 'position');
    final versionSeq = _int(json['versionSeq'], 'versionSeq');
    if (position < 0 || versionSeq < 1) {
      throw const FormatException('Conversation V2 todo metadata is invalid.');
    }
    return ConversationV2Todo(
      todoId: _string(json['todoId'], 'todoId'),
      conversationId: _string(json['conversationId'], 'conversationId'),
      title: _text(json['title'], 'title'),
      detail: _text(json['detail'], 'detail'),
      status: status,
      position: position,
      updatedAt: _string(json['updatedAt'], 'updatedAt'),
      versionSeq: versionSeq,
    );
  }

  ConversationJson toJson() => {
    'todoId': todoId,
    'conversationId': conversationId,
    'title': title,
    'detail': detail,
    'status': status,
    'position': position,
    'updatedAt': updatedAt,
    'versionSeq': versionSeq,
  };
}

class ConversationV2Bootstrap {
  const ConversationV2Bootstrap({
    required this.protocolVersion,
    required this.storeEpoch,
    required this.conversationId,
    required this.snapshotSeq,
    required this.historyRevision,
    required this.messages,
    required this.runs,
    required this.tools,
    required this.olderCursor,
    required this.hasOlder,
    this.agents = const [],
    this.todos = const [],
    this.toolSummaryCounts = const {},
  });

  final int protocolVersion;
  final String storeEpoch;
  final String conversationId;
  final int snapshotSeq;
  final int historyRevision;
  final List<ConversationV2Message> messages;
  final List<ConversationV2Run> runs;
  final List<ConversationV2Tool> tools;

  /// The agents of the visible window (see [ConversationV2Agent]).
  final List<ConversationV2Agent> agents;
  final List<ConversationV2Todo> todos;
  final Map<String, int> toolSummaryCounts;
  final String? olderCursor;
  final bool hasOlder;

  factory ConversationV2Bootstrap.fromJson(dynamic value) {
    final json = _map(value);
    return ConversationV2Bootstrap(
      protocolVersion: _int(json['protocolVersion'], 'protocolVersion'),
      storeEpoch: _string(json['storeEpoch'], 'storeEpoch'),
      conversationId: _string(json['conversationId'], 'conversationId'),
      snapshotSeq: _int(json['snapshotSeq'], 'snapshotSeq'),
      historyRevision: _int(json['historyRevision'], 'historyRevision'),
      messages: _list(
        json['messages'],
        'messages',
      ).map(ConversationV2Message.fromJson).toList(growable: false),
      runs: _optionalList(
        json['runs'],
        'runs',
      ).map(ConversationV2Run.fromJson).toList(growable: false),
      tools: _optionalList(
        json['tools'],
        'tools',
      ).map(ConversationV2Tool.fromJson).toList(growable: false),
      olderCursor: _optionalString(json['olderCursor'], 'olderCursor'),
      hasOlder: _bool(json['hasOlder'], 'hasOlder'),
      agents: _optionalList(
        json['agents'],
        'agents',
      ).map(ConversationV2Agent.fromJson).toList(growable: false),
      todos: _optionalList(
        json['todos'],
        'todos',
      ).map(ConversationV2Todo.fromJson).toList(growable: false),
      toolSummaryCounts: _optionalIntMap(json['toolSummaryCounts']),
    );
  }
}

class ConversationV2MessagePage {
  const ConversationV2MessagePage({
    required this.protocolVersion,
    required this.storeEpoch,
    required this.conversationId,
    required this.readSeq,
    required this.historyRevision,
    required this.messages,
    required this.nextCursor,
    required this.hasMore,
    this.runs = const [],
    this.tools = const [],
    this.agents = const [],
    this.toolSummaryCounts = const {},
  });

  final int protocolVersion;
  final String storeEpoch;
  final String conversationId;
  final int readSeq;
  final int historyRevision;
  final List<ConversationV2Message> messages;
  final List<ConversationV2Run> runs;
  final List<ConversationV2Tool> tools;
  final List<ConversationV2Agent> agents;
  final Map<String, int> toolSummaryCounts;
  final String? nextCursor;
  final bool hasMore;

  factory ConversationV2MessagePage.fromJson(dynamic value) {
    final json = _map(value);
    return ConversationV2MessagePage(
      protocolVersion: _int(json['protocolVersion'], 'protocolVersion'),
      storeEpoch: _string(json['storeEpoch'], 'storeEpoch'),
      conversationId: _string(json['conversationId'], 'conversationId'),
      readSeq: _int(json['readSeq'], 'readSeq'),
      historyRevision: _int(json['historyRevision'], 'historyRevision'),
      messages: _list(
        json['messages'],
        'messages',
      ).map(ConversationV2Message.fromJson).toList(growable: false),
      runs: _optionalList(
        json['runs'],
        'runs',
      ).map(ConversationV2Run.fromJson).toList(growable: false),
      tools: _optionalList(
        json['tools'],
        'tools',
      ).map(ConversationV2Tool.fromJson).toList(growable: false),
      agents: _optionalList(
        json['agents'],
        'agents',
      ).map(ConversationV2Agent.fromJson).toList(growable: false),
      toolSummaryCounts: _optionalIntMap(json['toolSummaryCounts']),
      nextCursor: _optionalString(json['nextCursor'], 'nextCursor'),
      hasMore: _bool(json['hasMore'], 'hasMore'),
    );
  }
}

class ConversationV2Effect {
  const ConversationV2Effect({
    required this.seq,
    required this.effectVersion,
    required this.effectHash,
    required this.type,
    required this.payload,
  });

  final int seq;
  final int effectVersion;
  final String effectHash;
  final String type;
  final ConversationJson payload;

  factory ConversationV2Effect.fromJson(dynamic value) {
    final json = _map(value);
    final effect = _map(json['effect']);
    final parsed = ConversationV2Effect(
      seq: _int(json['seq'], 'seq'),
      effectVersion: _int(json['effectVersion'], 'effectVersion'),
      effectHash: _string(json['effectHash'], 'effectHash'),
      type: _string(effect['type'], 'effect.type'),
      payload: effect,
    );
    if (parsed.effectHash != conversationV2StableHash(parsed.payload)) {
      throw const FormatException('Conversation V2 effect hash is invalid.');
    }
    return parsed;
  }
}

class ConversationV2Detail {
  const ConversationV2Detail({
    required this.itemId,
    required this.conversationId,
    required this.runId,
    required this.type,
    required this.createdSeq,
    required this.versionSeq,
    this.agentId,
    this.agentInstanceId,
    this.parentAgentInstanceId,
    this.parentAgentId,
    this.parentToolCallId,
    this.toolCallId,
    this.content,
    this.ref,
  });

  final String itemId;
  final String conversationId;
  final String runId;
  final String? agentId;
  final String? agentInstanceId;
  final String? parentAgentInstanceId;
  final String? parentAgentId;
  final String? parentToolCallId;
  final String? toolCallId;
  final String type;
  final int createdSeq;
  final int versionSeq;
  final String? content;
  final String? ref;

  factory ConversationV2Detail.fromJson(dynamic value) {
    final json = _map(value);
    return ConversationV2Detail(
      itemId: _string(json['itemId'], 'itemId'),
      conversationId: _string(json['conversationId'], 'conversationId'),
      runId: _string(json['runId'], 'runId'),
      agentId: _optionalString(json['agentId'], 'agentId'),
      agentInstanceId: _optionalString(
        json['agentInstanceId'],
        'agentInstanceId',
      ),
      parentAgentInstanceId: _optionalString(
        json['parentAgentInstanceId'],
        'parentAgentInstanceId',
      ),
      parentAgentId: _optionalString(json['parentAgentId'], 'parentAgentId'),
      parentToolCallId: _optionalString(
        json['parentToolCallId'],
        'parentToolCallId',
      ),
      toolCallId: _optionalString(json['toolCallId'], 'toolCallId'),
      type: _string(json['type'], 'type'),
      createdSeq: _int(json['createdSeq'], 'createdSeq'),
      versionSeq: _int(json['versionSeq'], 'versionSeq'),
      content: json['content'] == null
          ? null
          : _text(json['content'], 'content'),
      ref: json['ref'] == null ? null : _text(json['ref'], 'ref'),
    );
  }

  ConversationJson toJson() => {
    'itemId': itemId,
    'conversationId': conversationId,
    'runId': runId,
    if (agentId != null) 'agentId': agentId,
    if (agentInstanceId != null) 'agentInstanceId': agentInstanceId,
    if (parentAgentInstanceId != null)
      'parentAgentInstanceId': parentAgentInstanceId,
    if (parentAgentId != null) 'parentAgentId': parentAgentId,
    if (parentToolCallId != null) 'parentToolCallId': parentToolCallId,
    if (toolCallId != null) 'toolCallId': toolCallId,
    'type': type,
    'createdSeq': createdSeq,
    'versionSeq': versionSeq,
    if (content != null) 'content': content,
    if (ref != null) 'ref': ref,
  };
}

class ConversationV2DetailPage {
  const ConversationV2DetailPage({
    required this.protocolVersion,
    required this.storeEpoch,
    required this.conversationId,
    required this.readSeq,
    required this.historyRevision,
    required this.items,
    required this.nextCursor,
    required this.hasMore,
  });

  final int protocolVersion;
  final String storeEpoch;
  final String conversationId;
  final int readSeq;
  final int historyRevision;
  final List<ConversationV2Detail> items;
  final String? nextCursor;
  final bool hasMore;

  factory ConversationV2DetailPage.fromJson(dynamic value) {
    final json = _map(value);
    return ConversationV2DetailPage(
      protocolVersion: _int(json['protocolVersion'], 'protocolVersion'),
      storeEpoch: _string(json['storeEpoch'], 'storeEpoch'),
      conversationId: _string(json['conversationId'], 'conversationId'),
      readSeq: _int(json['readSeq'], 'readSeq'),
      historyRevision: _int(json['historyRevision'], 'historyRevision'),
      items: _list(
        json['items'],
        'items',
      ).map(ConversationV2Detail.fromJson).toList(growable: false),
      nextCursor: _optionalString(json['nextCursor'], 'nextCursor'),
      hasMore: _bool(json['hasMore'], 'hasMore'),
    );
  }
}

class ConversationV2ToolsPage {
  const ConversationV2ToolsPage({
    required this.protocolVersion,
    required this.storeEpoch,
    required this.conversationId,
    required this.runId,
    required this.readSeq,
    required this.historyRevision,
    required this.tools,
    required this.totalCount,
    required this.nextCursor,
    required this.hasMore,
  });

  final int protocolVersion;
  final String storeEpoch;
  final String conversationId;
  final String runId;
  final int readSeq;
  final int historyRevision;
  final List<ConversationV2Tool> tools;
  final int totalCount;
  final String? nextCursor;
  final bool hasMore;

  factory ConversationV2ToolsPage.fromJson(dynamic value) {
    final json = _map(value);
    final readSeq = _int(json['readSeq'], 'readSeq');
    final historyRevision = _int(json['historyRevision'], 'historyRevision');
    final tools = _list(
      json['tools'],
      'tools',
    ).map(ConversationV2Tool.fromJson).toList(growable: false);
    final totalCount = _int(json['totalCount'], 'totalCount');
    final nextCursor = _optionalString(json['nextCursor'], 'nextCursor');
    final hasMore = _bool(json['hasMore'], 'hasMore');
    if (readSeq < 0 || historyRevision < 0 || totalCount < tools.length) {
      throw const FormatException(
        'Conversation V2 tool page metadata is invalid.',
      );
    }
    if ((hasMore && nextCursor == null) || (!hasMore && nextCursor != null)) {
      throw const FormatException(
        'Conversation V2 tool page cursor metadata is invalid.',
      );
    }
    return ConversationV2ToolsPage(
      protocolVersion: _int(json['protocolVersion'], 'protocolVersion'),
      storeEpoch: _string(json['storeEpoch'], 'storeEpoch'),
      conversationId: _string(json['conversationId'], 'conversationId'),
      runId: _string(json['runId'], 'runId'),
      readSeq: readSeq,
      historyRevision: historyRevision,
      tools: tools,
      totalCount: totalCount,
      nextCursor: nextCursor,
      hasMore: hasMore,
    );
  }
}

class ConversationV2SyncPage {
  const ConversationV2SyncPage({
    required this.protocolVersion,
    required this.storeEpoch,
    required this.conversationId,
    required this.fromSeq,
    required this.throughSeq,
    required this.headSeq,
    required this.hasMore,
    required this.effects,
  });

  final int protocolVersion;
  final String storeEpoch;
  final String conversationId;
  final int fromSeq;
  final int throughSeq;
  final int headSeq;
  final bool hasMore;
  final List<ConversationV2Effect> effects;

  factory ConversationV2SyncPage.fromJson(dynamic value) {
    final json = _map(value);
    return ConversationV2SyncPage(
      protocolVersion: _int(json['protocolVersion'], 'protocolVersion'),
      storeEpoch: _string(json['storeEpoch'], 'storeEpoch'),
      conversationId: _string(json['conversationId'], 'conversationId'),
      fromSeq: _int(json['fromSeq'], 'fromSeq'),
      throughSeq: _int(json['throughSeq'], 'throughSeq'),
      headSeq: _int(json['headSeq'], 'headSeq'),
      hasMore: _bool(json['hasMore'], 'hasMore'),
      effects: _list(
        json['effects'],
        'effects',
      ).map(ConversationV2Effect.fromJson).toList(growable: false),
    );
  }
}

class ConversationV2Head {
  const ConversationV2Head({
    required this.protocolVersion,
    required this.storeEpoch,
    required this.conversationId,
    required this.lastSeq,
    required this.historyRevision,
  });

  final int protocolVersion;
  final String storeEpoch;
  final String conversationId;
  final int lastSeq;
  final int historyRevision;

  factory ConversationV2Head.fromJson(dynamic value) {
    final json = _map(value);
    return ConversationV2Head(
      protocolVersion: _int(json['protocolVersion'], 'protocolVersion'),
      storeEpoch: _string(json['storeEpoch'], 'storeEpoch'),
      conversationId: _string(json['conversationId'], 'conversationId'),
      lastSeq: _int(json['lastSeq'], 'lastSeq'),
      historyRevision: _int(json['historyRevision'], 'historyRevision'),
    );
  }
}

class ConversationV2PendingCommand {
  const ConversationV2PendingCommand({
    required this.clientCommandId,
    required this.conversationId,
    required this.text,
    required this.createdAt,
    this.attachments,
  });

  final String clientCommandId;
  final String conversationId;
  final String text;
  final String createdAt;
  final List<dynamic>? attachments;
}

class ConversationV2SendMessageResult {
  const ConversationV2SendMessageResult({
    required this.protocolVersion,
    required this.conversationId,
    required this.clientCommandId,
    required this.messageId,
    required this.turnId,
    required this.acceptedSeq,
    required this.status,
  });

  final int protocolVersion;
  final String conversationId;
  final String clientCommandId;
  final String messageId;
  final String turnId;
  final int acceptedSeq;
  final String status;

  factory ConversationV2SendMessageResult.fromJson(dynamic value) {
    final json = _map(value);
    return ConversationV2SendMessageResult(
      protocolVersion: _int(json['protocolVersion'], 'protocolVersion'),
      conversationId: _string(json['conversationId'], 'conversationId'),
      clientCommandId: _string(json['clientCommandId'], 'clientCommandId'),
      messageId: _string(json['messageId'], 'messageId'),
      turnId: _string(json['turnId'], 'turnId'),
      acceptedSeq: _int(json['acceptedSeq'], 'acceptedSeq'),
      status: _string(json['status'], 'status'),
    );
  }
}

ConversationJson _map(dynamic value) {
  if (value is Map) return Map<String, dynamic>.from(value);
  throw const FormatException('Conversation V2 response must be an object.');
}

List<dynamic> _list(dynamic value, String name) {
  if (value is List) return value;
  throw FormatException(
    'Conversation V2 $name must be a list, got ${value.runtimeType}.',
  );
}

List<dynamic> _optionalList(dynamic value, String name) {
  if (value == null) return const [];
  return _list(value, name);
}

Map<String, int> _optionalIntMap(dynamic value) {
  if (value == null) return const {};
  if (value is! Map) {
    throw const FormatException(
      'Conversation V2 toolSummaryCounts is invalid.',
    );
  }
  final result = <String, int>{};
  for (final entry in value.entries) {
    if (entry.key is! String ||
        entry.value is! int ||
        (entry.value as int) < 0) {
      throw const FormatException(
        'Conversation V2 toolSummaryCounts is invalid.',
      );
    }
    result[entry.key as String] = entry.value as int;
  }
  return result;
}

String _string(dynamic value, String name) {
  if (value is String && value.trim().isNotEmpty) return value;
  throw FormatException('Conversation V2 $name is invalid.');
}

String _text(dynamic value, String name) {
  if (value is String) return value;
  throw FormatException('Conversation V2 $name is invalid.');
}

String? _optionalString(dynamic value, String name) {
  if (value == null) return null;
  if (value is! String) {
    throw FormatException('Conversation V2 $name is invalid.');
  }
  return value.trim().isNotEmpty ? value : null;
}

bool _bool(dynamic value, String name) {
  if (value is bool) return value;
  throw FormatException('Conversation V2 $name is invalid.');
}

int _int(dynamic value, String name) {
  if (value is int && value.abs() <= _maxSafeInteger) return value;
  throw FormatException('Conversation V2 $name is invalid.');
}

const _maxSafeInteger = 9007199254740991;

ConversationV2MessageStatus _messageStatus(dynamic value) {
  switch (value) {
    case 'queued':
      return ConversationV2MessageStatus.queued;
    case 'streaming':
      return ConversationV2MessageStatus.streaming;
    case 'final':
      return ConversationV2MessageStatus.finalised;
    case 'failed':
      return ConversationV2MessageStatus.failed;
    case 'cancelled':
      return ConversationV2MessageStatus.cancelled;
    case 'deleted':
      return ConversationV2MessageStatus.deleted;
    default:
      throw const FormatException('Conversation V2 message status is invalid.');
  }
}

String _messageRole(dynamic value) {
  switch (value) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'tool':
      return value;
    default:
      throw const FormatException('Conversation V2 message role is invalid.');
  }
}

String _messageChannel(dynamic value) {
  switch (value) {
    case 'answer':
    case 'commentary':
    case 'thinking':
    case 'system':
    case 'tool':
      return value;
    default:
      throw const FormatException(
        'Conversation V2 message channel is invalid.',
      );
  }
}
