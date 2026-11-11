import 'package:eco_mobile/core/utils/local_file_link.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('parses eco-file links and line anchors', () {
    final link = parseLocalFileLink(
      'eco-file:%7B%22path%22%3A%22%2Frepo%2Fsrc%2Fmain.ts%22%2C%22line%22%3A12%7D',
    );
    expect(link?.path, '/repo/src/main.ts');
    expect(link?.line, 12);
  });

  test('parses file urls and rejects web urls', () {
    expect(parseLocalFileLink('file:///repo/README.md#L4')?.line, 4);
    expect(parseLocalFileLink('https://example.com/a.md'), isNull);
    expect(parseLocalFileLink('javascript:alert(1)'), isNull);
  });
}
