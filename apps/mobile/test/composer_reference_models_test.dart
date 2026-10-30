import 'package:eco_mobile/core/models/composer_reference_models.dart';
import 'package:eco_mobile/core/models/integration_models.dart';
import 'package:eco_mobile/core/models/mcp_models.dart';
import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:eco_mobile/core/utils/composer_references.dart';
import 'package:flutter_test/flutter_test.dart';

class _Client extends EcoCenterClient {
  _Client() : super(store: CredentialStore());
  (String, String, List<dynamic>)? lastCall;
  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    lastCall = (desktopDeviceId, channel, args);
    return {
          'items': [
            {
              'kind': 'conversation',
              'id': 'thr-other',
              'label': '同名会话',
              'detail': '/other/project',
            },
          ],
          'hasMore': true,
        }
        as T;
  }
}

void main() {
  test(
    'RPC preserves category, search, cross-project identity and pagination hint',
    () async {
      final client = _Client();
      final result = await DesktopRpc(
        client,
        'my-desktop',
      ).searchComposerReferences(query: '同名', kind: 'conversation', limit: 8);
      expect(client.lastCall!.$1, 'my-desktop');
      expect(client.lastCall!.$2, 'composer-references:search');
      expect(client.lastCall!.$3, [
        {'query': '同名', 'kind': 'conversation', 'limit': 8},
      ]);
      expect(result.hasMore, isTrue);
      expect(
        parseComposerPrompt(result.items.single.token).single.id,
        'thr-other',
      );
      expect(result.items.single.detail, '/other/project');
      expect(
        () => ComposerReference.fromJson({
          'kind': 'unknown',
          'id': 'a',
          'label': '',
          'detail': '',
        }),
        throwsFormatException,
      );
    },
  );

  test(
    'capabilities exclude disabled/unavailable services and use exact durable IDs',
    () {
      final items = buildComposerCapabilityReferences(
        availability: const IntegrationAvailabilitySnapshot(
          integrations: [
            IntegrationAvailabilityItem(
              id: 'browser',
              enabled: true,
              available: true,
              activeProfileName: '默认',
            ),
            IntegrationAvailabilityItem(
              id: 'computerUse',
              enabled: true,
              available: false,
            ),
            IntegrationAvailabilityItem(
              id: 'imageGeneration',
              enabled: true,
              available: true,
            ),
          ],
        ),
        integrationsEnabled: {
          'browser': true,
          'computerUse': true,
          'imageGeneration': false,
        },
        mcpServers: const [
          McpServerConfigView(
            id: 'docs-id',
            name: 'Team Docs',
            transport: 'http',
            enabled: true,
          ),
          McpServerConfigView(
            id: 'off-id',
            name: 'Off',
            transport: 'stdio',
            enabled: false,
          ),
          McpServerConfigView(
            id: 'unused-id',
            name: 'Unused',
            transport: 'stdio',
            enabled: true,
          ),
        ],
        mcpServersEnabled: {'team-docs': true, 'off': true},
        agents: const [
          AgentInstanceConfig(
            agentKey: 'reviewer',
            templateId: 'review',
            displayName: '代码审查',
            modelRef: OrchestrationModelRef(providerId: 'p', modelId: 'model'),
            tools: ToolPolicy(),
          ),
          AgentInstanceConfig(
            agentKey: 'coder',
            templateId: 'code',
            enabled: false,
            modelRef: OrchestrationModelRef(providerId: 'p', modelId: 'model'),
            tools: ToolPolicy(),
          ),
        ],
        subagentEnabled: {'reviewer': true},
      );
      expect(items.map((item) => item.key), [
        'integration:browser',
        'subagent:reviewer',
        'mcp:docs-id',
      ]);
      expect(
        items.where((item) => item.matches('网页操作', 'integration')).single.id,
        'browser',
      );
      expect(
        items.where((item) => item.matches('team-docs', 'mcp')).single.id,
        'docs-id',
      );
      expect(
        items
            .where((item) => item.matches('reviewer', 'subagent'))
            .single
            .label,
        '代码审查',
      );
    },
  );
}
