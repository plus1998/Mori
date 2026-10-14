import 'package:flutter_test/flutter_test.dart';

import 'package:eco_mobile/core/utils/model_id.dart';
import 'package:eco_mobile/features/composer/composer_controls.dart';

void main() {
  test('formatModelDisplayName drops well-known vendor prefixes', () {
    expect(formatModelDisplayName('gpt-6.1-sol'), '6.1 Sol');
    expect(formatModelDisplayName('openai/gpt-6.1-sol'), '6.1 Sol');
    expect(formatModelDisplayName('claude-opus-5_5'), 'Opus 5.5');
  });

  test('formatModelDisplayName capitalizes dash separated tokens', () {
    expect(formatModelDisplayName('qwen3.8-flash-next'), 'Qwen3.8 Flash Next');
    expect(formatModelDisplayName('deepseek-r1-distill'), 'Deepseek R1 Distill');
  });

  test('formatModelDisplayName only turns digit-digit underscores into dots', () {
    expect(formatModelDisplayName('gpt-5_6'), '5.6');
    expect(formatModelDisplayName('vendor_x-model_next'), 'Vendor_x Model_next');
  });

  test('formatModelDisplayName joins single-digit version tokens with a dot', () {
    expect(formatModelDisplayName('claude-opus-4-6'), 'Opus 4.6');
    expect(formatModelDisplayName('llama-3.3-70b-instruct'), 'Llama 3.3 70b Instruct');
  });

  test('composerModelDisplayName keeps long ids compact', () {
    expect(composerModelDisplayName('gpt-5.6-sol'), '5.6 Sol');
    expect(composerModelDisplayName('claude-haiku-4-5-20251001'), 'Haiku 4.5 20251001');
    expect(composerModelDisplayName('qwen3.8-flash-next-20260101-preview'), 'Qwen3.8 Fla…01 Preview');
  });
}
