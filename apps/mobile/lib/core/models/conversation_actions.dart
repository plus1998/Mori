import 'thread_models.dart';

class ConversationShare {
  const ConversationShare({required this.url, required this.expiresAt});
  factory ConversationShare.fromJson(Map<String, dynamic> json) {
    final url = Uri.parse(json['publicUrl'] as String);
    if (!url.hasAuthority || !const ['https', 'http'].contains(url.scheme)) {
      throw const FormatException('Invalid conversation share URL');
    }
    return ConversationShare(
      url: url.toString(),
      expiresAt: DateTime.parse(json['expiresAt'] as String),
    );
  }
  final String url;
  final DateTime expiresAt;
}

class ForkedConversation {
  const ForkedConversation({
    required this.thread,
    required this.prompt,
    required this.attachments,
  });
  factory ForkedConversation.fromJson(Map<String, dynamic> json) {
    final draft = Map<String, dynamic>.from(json['draft'] as Map);
    return ForkedConversation(
      thread: ThreadSummary.fromJson(
        Map<String, dynamic>.from(json['thread'] as Map),
      ),
      prompt: draft['prompt'] as String,
      attachments: (draft['attachments'] as List)
          .map(
            (value) => PromptImageAttachment.fromJson(
              Map<String, dynamic>.from(value as Map),
            ),
          )
          .toList(),
    );
  }
  final ThreadSummary thread;
  final String prompt;
  final List<PromptImageAttachment> attachments;
}

class PlanExecutionLink {
  const PlanExecutionLink({
    required this.id,
    required this.version,
    required this.planTitle,
    required this.sourceThreadId,
    required this.sourceTitle,
    required this.sourceDeleted,
    required this.executionThreadId,
    required this.executionTitle,
    required this.executionDeleted,
    required this.status,
    required this.message,
  });
  factory PlanExecutionLink.fromJson(Map<String, dynamic> json) =>
      PlanExecutionLink(
        id: json['id'] as String,
        version: json['version'] as int,
        planTitle: json['planTitle'] as String,
        sourceThreadId: json['sourceThreadId'] as String,
        sourceTitle: json['sourceTitle'] as String,
        sourceDeleted: json['sourceDeleted'] as bool,
        executionThreadId: json['executionThreadId'] as String,
        executionTitle: json['executionTitle'] as String,
        executionDeleted: json['executionDeleted'] as bool,
        status: json['status'] as String,
        message: json['message'] as String,
      );
  final String id,
      planTitle,
      sourceThreadId,
      sourceTitle,
      executionThreadId,
      executionTitle,
      status,
      message;
  final int version;
  final bool sourceDeleted, executionDeleted;
}
