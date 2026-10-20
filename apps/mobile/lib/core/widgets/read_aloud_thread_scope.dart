import 'package:flutter/widgets.dart';

class ReadAloudThreadScope extends InheritedWidget {
  const ReadAloudThreadScope({
    super.key,
    required this.threadId,
    required super.child,
  });
  final String threadId;
  static String? of(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<ReadAloudThreadScope>()
      ?.threadId;
  @override
  bool updateShouldNotify(ReadAloudThreadScope oldWidget) =>
      oldWidget.threadId != threadId;
}
