class DesktopDisplayState {
  const DesktopDisplayState({
    required this.preventAutoLock,
    required this.dimmed,
    required this.brightnessAvailable,
    required this.displays,
    required this.pendingRestores,
    this.error,
  });

  factory DesktopDisplayState.fromJson(Map<String, dynamic> json) =>
      DesktopDisplayState(
        preventAutoLock: json['preventAutoLock'] as bool,
        dimmed: json['dimmed'] as bool,
        brightnessAvailable: json['brightnessAvailable'] as bool,
        displays: (json['displays'] as List)
            .map(
              (value) => (
                name: value['name'] as String,
                status: value['status'] as String,
                error: value['error'] as String?,
              ),
            )
            .toList(),
        pendingRestores: json['pendingRestores'] as int,
        error: [
          json['brightnessError'],
          json['error'],
        ].whereType<String>().join('\n').nullIfEmpty,
      );

  final bool preventAutoLock;
  final bool dimmed;
  final bool brightnessAvailable;
  final List<({String name, String status, String? error})> displays;
  final int pendingRestores;
  final String? error;
}

extension on String {
  String? get nullIfEmpty => isEmpty ? null : this;
}
