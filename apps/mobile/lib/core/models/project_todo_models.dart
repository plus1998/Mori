import 'thread_models.dart';

const todoMaxImages = 5;
const todoMaxImageBytes = 5 * 1024 * 1024;

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

class ProjectTodo {
  const ProjectTodo({
    required this.id,
    required this.revision,
    required this.projectPath,
    required this.text,
    required this.images,
    required this.completed,
    required this.createdAt,
    required this.updatedAt,
  });

  factory ProjectTodo.fromJson(Map<String, dynamic> json) => ProjectTodo(
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
    completed: json['completed'] as bool,
    createdAt: json['createdAt'] as String,
    updatedAt: json['updatedAt'] as String,
  );

  final String id;
  final int revision;
  final String projectPath;
  final String text;
  final List<ProjectTodoImage> images;
  final bool completed;
  final String createdAt;
  final String updatedAt;

  Map<String, dynamic> toSaveJson({bool? completed}) => {
    'id': id,
    'revision': revision,
    'projectPath': projectPath,
    'text': text,
    'images': images.map((image) => image.toSaveJson()).toList(),
    'completed': completed ?? this.completed,
  };
}
