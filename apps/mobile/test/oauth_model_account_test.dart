import 'package:eco_mobile/core/models/thread_models.dart';
import 'package:eco_mobile/core/models/thread_runtime_config.dart';
import 'package:eco_mobile/core/network/desktop_rpc.dart';
import 'package:eco_mobile/core/network/eco_center_client.dart';
import 'package:eco_mobile/core/storage/credential_store.dart';
import 'package:flutter_test/flutter_test.dart';

const _auxiliary = AuxiliaryModelSelection(
  providerId: 'eco-coding-chatgpt',
  modelId: 'gpt-test',
  candidateModelId: 'account:eco-coding-chatgpt:gpt-test',
  accountId: 'oauth-title',
);
const _approval = ApprovalModelSelection(
  providerId: 'eco-coding-chatgpt',
  modelId: 'gpt-test',
  candidateModelId: 'account:eco-coding-chatgpt:gpt-test',
  accountId: 'oauth-approval',
);
const _vision = VisionModelSelection(
  providerId: 'eco-coding-chatgpt',
  modelId: 'gpt-test',
  candidateModelId: 'account:eco-coding-chatgpt:gpt-test',
  accountId: 'oauth-vision',
);
const _workflow = WorkflowSettingsSnapshot(
  sessionMode: 'agent',
  defaultAuxiliaryModel: _auxiliary,
  defaultApprovalModel: _approval,
  defaultVisionModel: _vision,
);

class _Client extends EcoCenterClient {
  _Client() : super(store: CredentialStore());
  @override
  AppCredentials get credentials =>
      AppCredentials(supabaseUrl: '', userId: 'user-1');
  String? channel;
  List<dynamic>? args;
  @override
  Future<T> invoke<T>(
    String desktopDeviceId,
    String channel,
    List<dynamic> args, {
    int? deadlineMs,
  }) async {
    this.channel = channel;
    this.args = args;
    final Object result = switch (channel) {
      'chatgpt-subscription:accounts-list' => [
        {'accountId': 'oauth-title', 'displayName': 'Title account'},
      ],
      'chatgpt-subscription:account-models-list' => [
        {'id': 'gpt-test'},
      ],
      'workflow-settings:get' => _workflow.toJson(),
      'workflow-settings:save' => args.single as Map<String, dynamic>,
      'git:generate-commit-message' => {'message': 'Fix OAuth accounts'},
      'git:commit' => {'message': 'Fix OAuth accounts', 'commitSha': 'abc'},
      'conversation:head' => {
        'protocolVersion': 2,
        'storeEpoch': 'epoch-1',
        'conversationId': 'thr-1',
        'lastSeq': 0,
        'historyRevision': 0,
      },
      'thread:update-runtime-config' => {
        'thread': {
          'id': 'thr-1',
          'title': 'Thread',
          'prompt': '',
          'workspacePath': '/workspace',
          'status': 'idle',
          'createdAt': '2026-11-07',
          'updatedAt': '2026-11-07',
          'runtimeConfig': (args.single as Map)['runtimeConfig'],
        },
      },
      _ => throw StateError('Unexpected RPC: $channel'),
    };
    return result as T;
  }
}

void main() {
  test(
    'mobile OAuth RPC addresses the chosen account catalog explicitly',
    () async {
      final client = _Client();
      final rpc = DesktopRpc(client, 'desktop-1');
      expect(
        (await rpc.listChatGptOauthAccounts()).single['accountId'],
        'oauth-title',
      );
      expect(client.channel, 'chatgpt-subscription:accounts-list');
      expect(client.args, isEmpty);
      expect(
        (await rpc.listChatGptOauthAccountModels('oauth-vision')).single['id'],
        'gpt-test',
      );
      expect(client.channel, 'chatgpt-subscription:account-models-list');
      expect(client.args, ['oauth-vision']);
    },
  );

  test(
    'workflow and conversation round trips keep independent OAuth account bindings',
    () async {
      final client = _Client();
      final rpc = DesktopRpc(client, 'desktop-1');
      final received = await rpc.getWorkflowSettings();
      final saved = await rpc.saveWorkflowSettings(received);
      expect(saved.toJson(), _workflow.toJson());
      expect(saved.defaultAuxiliaryModel?.accountId, 'oauth-title');
      expect(saved.defaultApprovalModel?.accountId, 'oauth-approval');
      expect(saved.defaultVisionModel?.accountId, 'oauth-vision');
      final config = buildDefaultRuntimeConfig(workflow: saved);
      final restored = ThreadRuntimeConfig.fromJson(config.toJson());
      final updated = await rpc.updateRuntimeConfig(
        threadId: 'thr-1',
        runtimeConfig: restored,
      );
      expect(updated.runtimeConfig?.auxiliaryModel?.accountId, 'oauth-title');
      expect(updated.runtimeConfig?.approvalModel?.accountId, 'oauth-approval');
      expect(updated.runtimeConfig?.visionModel?.accountId, 'oauth-vision');
      final cleared = restored.copyWith(
        clearAuxiliaryModel: true,
        clearApprovalModel: true,
        clearVisionModel: true,
      );
      expect(cleared.toJson().keys, isNot(contains('auxiliaryModel')));
      expect(cleared.toJson().keys, isNot(contains('approvalModel')));
      expect(cleared.toJson().keys, isNot(contains('visionModel')));
    },
  );

  test(
    'Git generation and automatic commit carry the complete OAuth selection',
    () async {
      final client = _Client();
      final rpc = DesktopRpc(client, 'desktop-1');
      await rpc.generateCommitMessage(
        workspacePath: '/workspace',
        modelSelection: _auxiliary,
      );
      expect(client.channel, 'git:generate-commit-message');
      expect(
        (client.args!.single as Map)['modelSelection'],
        _auxiliary.toJson(),
      );
      await rpc.commitChanges(
        workspacePath: '/workspace',
        modelSelection: _auxiliary,
      );
      expect(client.channel, 'git:commit');
      expect(
        (client.args!.single as Map)['modelSelection'],
        _auxiliary.toJson(),
      );
      await rpc.commitChanges(
        workspacePath: '/workspace',
        message: 'Manual message',
      );
      expect(
        (client.args!.single as Map).containsKey('modelSelection'),
        isFalse,
      );
    },
  );

  test('API selections remain compatible without an account', () {
    const data = {
      'providerId': 'custom',
      'modelId': 'api-model',
      'candidateModelId': 'api-model',
    };
    expect(AuxiliaryModelSelection.fromJson(data).toJson(), data);
    expect(ApprovalModelSelection.fromJson(data).toJson(), data);
    expect(VisionModelSelection.fromJson(data).toJson(), data);
  });
}
