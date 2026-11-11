import 'thread_models.dart';

const todoMaxImages = 5;
const todoMaxImageBytes = 5 * 1024 * 1024;
const todoPageSize = 20;

enum ProjectTodoStatus {
  pending('pending'),
  inProgress('in_progress'),
  completed('completed');

  const ProjectTodoStatus(this.wireValue);
  final String wireValue;

  static ProjectTodoStatus fromWireValue(Object? value) => switch (value) {
    'pending' => pending,
    'in_progress' => inProgress,
    'completed' => completed,
    _ => throw FormatException('Invalid project todo status: $value'),
  };
}

typedef ProjectTodosQuery = ({
  bool completed,
  String projectPath,
  String search,
});

class ProjectTodoCursor {
  const ProjectTodoCursor({required this.createdAt, required this.id});
  factory ProjectTodoCursor.fromJson(Map<String, dynamic> json) =>
      ProjectTodoCursor(
        createdAt: json['createdAt'] as String,
        id: json['id'] as String,
      );
  final String createdAt;
  final String id;
  Map<String, dynamic> toJson() => {'createdAt': createdAt, 'id': id};
}

class ProjectTodoPage {
  const ProjectTodoPage({
    required this.items,
    required this.nextCursor,
    required this.pendingCount,
    required this.completedCount,
    required this.projectPaths,
    this.loadingMore = false,
    this.loadMoreError,
  });

  factory ProjectTodoPage.fromJson(Map<String, dynamic> json) {
    final counts = Map<String, dynamic>.from(json['counts'] as Map);
    return ProjectTodoPage(
      items: (json['items'] as List)
          .map(
            (row) =>
                ProjectTodo.fromJson(Map<String, dynamic>.from(row as Map)),
          )
          .toList(),
      nextCursor: json['nextCursor'] == null
          ? null
          : ProjectTodoCursor.fromJson(
              Map<String, dynamic>.from(json['nextCursor'] as Map),
            ),
      pendingCount: counts['pending'] as int,
      completedCount: counts['completed'] as int,
      projectPaths: List<String>.from(json['projectPaths'] as List),
    );
  }

  final List<ProjectTodo> items;
  final ProjectTodoCursor? nextCursor;
  final int pendingCount;
  final int completedCount;
  final List<String> projectPaths;
  final bool loadingMore;
  final Object? loadMoreError;

  ProjectTodoPage withLoadMore({bool loading = false, Object? error}) =>
      ProjectTodoPage(
        items: items,
        nextCursor: nextCursor,
        pendingCount: pendingCount,
        completedCount: completedCount,
        projectPaths: projectPaths,
        loadingMore: loading,
        loadMoreError: error,
      );
}

class ProjectTodoImage {
  const ProjectTodoImage({
    required this.id,
    required this.mediaType,
    required this.thumbnail,
    this.data,
    this.contentRef,
  });

  factory ProjectTodoImage.fromJson(Map<String, dynamic> json) =>
      ProjectTodoImage(
        id: json['id'] as String,
        mediaType: json['mediaType'] as String,
        thumbnail: json['thumbnail'] as String,
        data: json['data'] as String?,
      );

  final String id;
  final String mediaType;
  final String thumbnail;
  final String? data;
  final String? contentRef;

  Map<String, dynamic> toSaveJson() => {
    'id': id,
    'mediaType': mediaType,
    'thumbnail': thumbnail,
    if (contentRef != null) 'contentRef': contentRef,
    if (data != null && contentRef == null) 'data': data,
  };

  PromptImageAttachment toAttachment(String original) =>
      PromptImageAttachment(id: id, mediaType: mediaType, data: original);
}

class ProjectTodoHandoff {
  const ProjectTodoHandoff({
    required this.contextKey,
    required this.composedAt,
    this.threadId,
    this.messageId,
  });
  factory ProjectTodoHandoff.fromJson(Map<String, dynamic> json) =>
      ProjectTodoHandoff(
        contextKey: json['contextKey'] as String,
        composedAt: json['composedAt'] as String,
        threadId: json['threadId'] as String?,
        messageId: json['messageId'] as String?,
      );
  final String contextKey, composedAt;
  final String? threadId, messageId;
}

class ProjectTodo {
  const ProjectTodo({
    required this.id,
    required this.revision,
    required this.projectPath,
    required this.text,
    required this.images,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    this.composedAt,
    this.handoffs = const [],
  });

  factory ProjectTodo.fromJson(Map<String, dynamic> json) {
    final completed = json['completed'] as bool;
    // Desktops predating three-state todos return only the completion flag.
    final status = json.containsKey('status')
        ? ProjectTodoStatus.fromWireValue(json['status'])
        : completed
        ? ProjectTodoStatus.completed
        : ProjectTodoStatus.pending;
    if ((status == ProjectTodoStatus.completed) != completed) {
      throw const FormatException(
        'Project todo status conflicts with completed',
      );
    }
    return ProjectTodo(
      id: json['id'] as String,
      revision: json['revision'] as int,
      projectPath: json['projectPath'] as String,
      text: json['text'] as String,
      images: (json['images'] as List)
          .map(
            (image) => ProjectTodoImage.fromJson(
              Map<String, dynamic>.from(image as Map),
            ),
          )
          .toList(),
      status: status,
      createdAt: json['createdAt'] as String,
      updatedAt: json['updatedAt'] as String,
      composedAt: json['composedAt'] as String?,
      handoffs: (json['handoffs'] as List? ?? const [])
          .map(
            (h) => ProjectTodoHandoff.fromJson(
              Map<String, dynamic>.from(h as Map),
            ),
          )
          .toList(),
    );
  }

  final String id;
  final int revision;
  final String projectPath;
  final String text;
  final List<ProjectTodoImage> images;
  final ProjectTodoStatus status;
  bool get completed => status == ProjectTodoStatus.completed;
  final String createdAt;
  final String updatedAt;
  final String? composedAt;
  final List<ProjectTodoHandoff> handoffs;

  Map<String, dynamic> toSaveJson({bool? completed}) {
    final nextStatus = completed == null || completed == this.completed
        ? status
        : completed
        ? ProjectTodoStatus.completed
        : ProjectTodoStatus.pending;
    return {
      'id': id,
      'revision': revision,
      'projectPath': projectPath,
      'text': text,
      'images': images.map((image) => image.toSaveJson()).toList(),
      'completed': nextStatus == ProjectTodoStatus.completed,
      'status': nextStatus.wireValue,
    };
  }
}
