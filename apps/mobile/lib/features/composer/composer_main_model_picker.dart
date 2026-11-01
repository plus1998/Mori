import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/git_models.dart';
import '../../core/models/thread_models.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/eco_action_sheet.dart';
import '../threads/thread_providers.dart';

typedef _PickerAccount = ({String id, String name});
typedef _PickerModel = ({
  String id,
  String name,
  String? candidateId,
  List<String>? efforts,
});

const _allEfforts = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

Future<void> showComposerMainModelPickerSheet(
  BuildContext context, {
  required OrchestrationModelRef? selectedModel,
  required String? coreKind,
  required FutureOr<void> Function(OrchestrationModelRef) onSelected,
}) async {
  await showEcoActionSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (context) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: _MainModelPicker(
        selectedModel: selectedModel,
        coreKind: coreKind,
        onSelected: onSelected,
      ),
    ),
  );
}

class _MainModelPicker extends ConsumerStatefulWidget {
  const _MainModelPicker({
    required this.selectedModel,
    required this.coreKind,
    required this.onSelected,
  });

  final OrchestrationModelRef? selectedModel;
  final String? coreKind;
  final FutureOr<void> Function(OrchestrationModelRef) onSelected;

  @override
  ConsumerState<_MainModelPicker> createState() => _MainModelPickerState();
}

class _MainModelPickerState extends ConsumerState<_MainModelPicker> {
  late OrchestrationModelRef? _selectedModel = widget.selectedModel;
  late String _source = switch (widget.selectedModel?.providerId) {
    'openai' => 'login',
    'eco-coding-chatgpt' => 'oauth',
    final id? => id,
    _ => '',
  };
  late String _accountId = widget.selectedModel?.accountId ?? '';
  late String _effort = widget.selectedModel?.thinkingEffort ?? 'low';
  String _query = '';
  List<_PickerAccount> _loginAccounts = [];
  List<_PickerAccount> _oauthAccounts = [];
  List<_PickerModel> _loginModels = [];
  List<_PickerModel> _oauthModels = [];
  final Set<String> _catalogPending = {
    'loginAccounts',
    'oauthAccounts',
    'loginModels',
  };
  final Map<String, Object> _catalogErrors = {};
  bool _oauthModelsLoading = false;
  bool _saving = false;
  Object? _error;
  int _oauthRequest = 0;
  final ScrollController _providersScroll = ScrollController();
  bool _initialProviderVisible = false;
  bool _initialEffortApplied = false;

  @override
  void initState() {
    super.initState();
    unawaited(_loadCatalog());
    if (_source == 'oauth' && _accountId.isNotEmpty) {
      unawaited(_loadOauthModels(_accountId));
    }
  }

  @override
  void dispose() {
    _providersScroll.dispose();
    super.dispose();
  }

  String _effortLabel(String effort) {
    final l10n = context.l10n;
    return switch (effort) {
      'off' => l10n.composerReasoningOff,
      'low' => l10n.composerReasoningLow,
      'medium' => l10n.composerReasoningMedium,
      'high' => l10n.composerReasoningHigh,
      'xhigh' => l10n.composerReasoningExtraHigh,
      'max' => l10n.composerReasoningMaximum,
      _ => effort,
    };
  }

  Future<void> _loadCatalog() async {
    final rpc = ref.read(desktopRpcProvider);
    if (rpc == null) {
      setState(() {
        for (final key in _catalogPending) {
          _catalogErrors[key] = StateError('桌面端未连接');
        }
        _catalogPending.clear();
      });
      return;
    }
    await Future.wait([
      _loadCatalogPart('loginAccounts', rpc.listCodexAccounts(), (accounts) {
        _loginAccounts = [
          for (final account in accounts)
            if (account.canUseCredentials) (id: account.id, name: account.name),
        ];
      }),
      _loadCatalogPart('oauthAccounts', rpc.listChatGptOauthAccounts(), (
        accounts,
      ) {
        _oauthAccounts = [
          for (final account in accounts)
            if (account['enabled'] == true && account['hasCredentials'] == true)
              (
                id: account['accountId'] as String,
                name:
                    account['displayName'] as String? ??
                    account['accountId'] as String,
              ),
        ];
      }),
      _loadCatalogPart('loginModels', rpc.listCodexAccountModels(), (models) {
        _loginModels = [
          for (final model in models)
            if (model['hidden'] != true)
              (
                id: model['modelId'] as String,
                name:
                    model['displayName'] as String? ??
                    model['modelId'] as String,
                candidateId: null,
                efforts: _parseEfforts(model['reasoningEfforts']),
              ),
        ];
      }),
    ]);
  }

  Future<void> _loadCatalogPart<T>(
    String key,
    Future<T> request,
    void Function(T) apply,
  ) async {
    try {
      final result = await request;
      if (mounted) {
        setState(() {
          apply(result);
          _catalogPending.remove(key);
        });
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          _catalogErrors[key] = error;
          _catalogPending.remove(key);
        });
      }
    }
  }

  Future<void> _loadOauthModels(String accountId) async {
    final request = ++_oauthRequest;
    setState(() {
      _oauthModels = [];
      _oauthModelsLoading = true;
      _error = null;
    });
    try {
      final rpc = ref.read(desktopRpcProvider);
      if (rpc == null) throw StateError('桌面端未连接');
      final models = await rpc.listChatGptOauthAccountModels(accountId);
      if (!mounted || request != _oauthRequest) return;
      setState(() {
        _oauthModels = [
          for (final model in models)
            (
              id: model['id'] as String,
              name: model['displayName'] as String? ?? model['id'] as String,
              candidateId: null,
              efforts: _parseEfforts(model['reasoningEfforts']),
            ),
        ];
        _oauthModelsLoading = false;
      });
    } catch (error) {
      if (mounted && request == _oauthRequest) {
        setState(() {
          _error = error;
          _oauthModelsLoading = false;
        });
      }
    }
  }

  static List<String>? _parseEfforts(Object? value) {
    if (value is! List) return null;
    return {
      for (final item in value)
        if (item is String &&
            _allEfforts.contains(item == 'none' ? 'off' : item))
          item == 'none' ? 'off' : item,
    }.toList();
  }

  void _changeSource(String source) {
    if (_source == source) return;
    setState(() {
      _source = source;
      _accountId = '';
      _oauthModels = [];
      _selectedModel = null;
      _oauthRequest++;
      _oauthModelsLoading = false;
      _error = null;
    });
  }

  List<String> _supportedEfforts(_PickerModel? model, bool? supportsReasoning) {
    if (model == null) return _allEfforts;
    if (supportsReasoning == false) return const [];
    return model.efforts ?? _allEfforts;
  }

  String? _normalizedEffort(List<String> supported) {
    if (supported.isEmpty) return null;
    if (supported.contains(_effort)) return _effort;
    return supported.contains('low') ? 'low' : supported.first;
  }

  Future<void> _selectModel(_PickerModel model, List<String> efforts) async {
    if (_saving ||
        ((_source == 'login' || _source == 'oauth') && _accountId.isEmpty)) {
      return;
    }
    final providerId = switch (_source) {
      'login' => 'openai',
      'oauth' => 'eco-coding-chatgpt',
      _ => _source,
    };
    final next = OrchestrationModelRef(
      providerId: providerId,
      modelId: model.id,
      candidateModelId: model.candidateId,
      accountId: _source == 'login' || _source == 'oauth' ? _accountId : null,
      thinkingEffort: _normalizedEffort(efforts),
    );
    await _save(next);
  }

  Future<void> _save(OrchestrationModelRef next) async {
    final previous = _selectedModel;
    setState(() {
      _selectedModel = next;
      _saving = true;
      _error = null;
    });
    try {
      await widget.onSelected(next);
      if (mounted) {
        setState(() {
          _effort = next.thinkingEffort ?? _effort;
          _saving = false;
        });
      }
    } catch (error) {
      if (mounted) {
        setState(() {
          _selectedModel = previous;
          _saving = false;
          _error = error;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final optionsAsync = ref.watch(auxiliaryModelOptionsProvider(''));
    final options = optionsAsync.valueOrNull ?? const <CommitModelOptionView>[];
    final providers = <String, String>{
      for (final option in options)
        if (option.providerId != 'openai' &&
            option.providerId != 'eco-coding-chatgpt')
          option.providerId: option.providerName,
      if (widget.coreKind == 'codex' || _source == 'login')
        'login': 'ChatGPT Login',
      'oauth': 'ChatGPT OAuth',
    };
    if (_source.isEmpty && providers.isNotEmpty) _source = providers.keys.first;
    final accountSource = _source == 'login' || _source == 'oauth';
    final accounts = _source == 'login' ? _loginAccounts : _oauthAccounts;
    final candidateAsync = !accountSource && _source.isNotEmpty
        ? ref.watch(candidateModelsProvider(_source))
        : const AsyncValue<List<CandidateModelView>>.data([]);
    final capabilities = {
      for (final entry
          in candidateAsync.valueOrNull ?? const <CandidateModelView>[])
        entry.id: entry,
    };
    final models = _source == 'login'
        ? _loginModels
        : _source == 'oauth'
        ? [
            for (final model in _oauthModels)
              (
                id: model.id,
                name: model.name,
                candidateId: null,
                efforts:
                    model.efforts ??
                    _loginModels
                        .where((entry) => entry.id == model.id)
                        .firstOrNull
                        ?.efforts,
              ),
          ]
        : [
            for (final option in options)
              if (option.providerId == _source)
                (
                  id: option.modelId,
                  name: option.modelLabel,
                  candidateId: option.candidateModelId,
                  efforts: null,
                ),
          ];
    final needle = _query.trim().toLowerCase();
    final visibleProviders = providers.entries
        .where(
          (entry) =>
              needle.isEmpty ||
              entry.key == _source ||
              entry.value.toLowerCase().contains(needle) ||
              options.any(
                (model) =>
                    model.providerId == entry.key &&
                    (model.modelLabel.toLowerCase().contains(needle) ||
                        model.modelId.toLowerCase().contains(needle)),
              ),
        )
        .toList();
    if (!_initialProviderVisible &&
        !optionsAsync.isLoading &&
        visibleProviders.isNotEmpty) {
      _initialProviderVisible = true;
      final index = visibleProviders.indexWhere(
        (entry) => entry.key == _source,
      );
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_providersScroll.hasClients || index < 0) return;
        _providersScroll.jumpTo(
          (index * 42.0).clamp(0.0, _providersScroll.position.maxScrollExtent),
        );
      });
    }
    final visibleModels = models
        .where(
          (model) =>
              needle.isEmpty ||
              model.name.toLowerCase().contains(needle) ||
              model.id.toLowerCase().contains(needle) ||
              (providers[_source]?.toLowerCase().contains(needle) ?? false),
        )
        .toList();
    final selectedEntry = models
        .where(
          (model) =>
              _selectedModel?.modelId == model.id &&
              (model.candidateId == null ||
                  model.candidateId == _selectedModel?.candidateModelId),
        )
        .firstOrNull;
    final supported = _supportedEfforts(
      selectedEntry,
      selectedEntry?.candidateId == null
          ? null
          : capabilities[selectedEntry!.candidateId]?.resolvedSupportsReasoning,
    );
    final effortOptions = supported.isEmpty ? _allEfforts : supported;
    final effortValue = _normalizedEffort(effortOptions) ?? 'low';
    final sliderIndex = effortOptions
        .indexOf(effortValue)
        .clamp(0, effortOptions.length - 1);
    final modelLoading =
        optionsAsync.isLoading ||
        candidateAsync.isLoading ||
        _source == 'login' &&
            (_catalogPending.contains('loginAccounts') ||
                _catalogPending.contains('loginModels')) ||
        _source == 'oauth' && _catalogPending.contains('oauthAccounts') ||
        _oauthModelsLoading;
    final error =
        _error ??
        optionsAsync.error ??
        candidateAsync.error ??
        (_source == 'login'
            ? _catalogErrors['loginAccounts'] ?? _catalogErrors['loginModels']
            : _source == 'oauth'
            ? _catalogErrors['oauthAccounts']
            : null);
    if (!_initialEffortApplied &&
        !modelLoading &&
        error == null &&
        selectedEntry != null &&
        _selectedModel != null) {
      _initialEffortApplied = true;
      final current = _selectedModel!;
      if (current.thinkingEffort == null && supported.isNotEmpty) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || _selectedModel != current || _saving) return;
          unawaited(
            _save(
              OrchestrationModelRef(
                providerId: current.providerId,
                modelId: current.modelId,
                accountId: current.accountId,
                candidateModelId: current.candidateModelId,
                thinkingEffort: supported.contains('low')
                    ? 'low'
                    : supported.first,
              ),
            ),
          );
        });
      }
    }

    return EcoSheetScaffold(
      title: context.l10n.composerMainModelPickerTitle,
      maxHeightFactor: 0.78,
      bottomPadding: 8,
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.66,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: TextField(
                onChanged: (value) => setState(() => _query = value),
                decoration: InputDecoration(
                  hintText: context.l10n.modelCascadeSearchHint,
                  prefixIcon: Icon(
                    EcoIcons.search,
                    size: 18,
                    color: eco.textMuted,
                  ),
                  isDense: true,
                  filled: true,
                  fillColor: eco.composerPillBg,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(10),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
            ),
            Expanded(
              child: Row(
                children: [
                  SizedBox(
                    width: 132,
                    child: ListView.builder(
                      controller: _providersScroll,
                      padding: const EdgeInsets.only(left: 8, right: 5),
                      itemCount: visibleProviders.length,
                      itemBuilder: (context, index) {
                        final provider = visibleProviders[index];
                        final selected = provider.key == _source;
                        return _PickerTile(
                          selected: selected,
                          icon: _providerIcon(provider.value),
                          title: provider.value,
                          onTap: _saving
                              ? null
                              : () => _changeSource(provider.key),
                        );
                      },
                    ),
                  ),
                  VerticalDivider(width: 1, color: eco.borderSubtle),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (accountSource) ...[
                          Padding(
                            padding: const EdgeInsets.fromLTRB(10, 4, 10, 2),
                            child: Text(
                              context.l10n.settingsAccount,
                              style: TextStyle(
                                fontSize: 12,
                                color: eco.textMuted,
                              ),
                            ),
                          ),
                          SizedBox(
                            height: 38,
                            child: ListView(
                              scrollDirection: Axis.horizontal,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                              ),
                              children: [
                                for (final account in accounts)
                                  Padding(
                                    padding: const EdgeInsets.only(right: 5),
                                    child: ChoiceChip(
                                      label: Text(account.name),
                                      selected: account.id == _accountId,
                                      onSelected: _saving
                                          ? null
                                          : (_) {
                                              setState(() {
                                                _accountId = account.id;
                                                _selectedModel = null;
                                              });
                                              if (_source == 'oauth') {
                                                unawaited(
                                                  _loadOauthModels(account.id),
                                                );
                                              }
                                            },
                                    ),
                                  ),
                              ],
                            ),
                          ),
                          Divider(height: 1, color: eco.borderSubtle),
                        ],
                        Padding(
                          padding: const EdgeInsets.fromLTRB(10, 8, 10, 4),
                          child: Text(
                            context.l10n.composerModel,
                            style: TextStyle(
                              fontSize: 12,
                              color: eco.textMuted,
                            ),
                          ),
                        ),
                        Expanded(
                          child: modelLoading
                              ? const Center(
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : accountSource && accounts.isEmpty
                              ? Center(
                                  child: Text(
                                    context
                                        .l10n
                                        .composerMainModelPickerNoAccounts,
                                    style: TextStyle(color: eco.textMuted),
                                  ),
                                )
                              : accountSource && _accountId.isEmpty
                              ? Center(
                                  child: Text(
                                    context
                                        .l10n
                                        .composerMainModelPickerSelectAccount,
                                    style: TextStyle(color: eco.textMuted),
                                  ),
                                )
                              : visibleModels.isEmpty
                              ? Center(
                                  child: Text(
                                    needle.isEmpty
                                        ? context.l10n.modelCascadeEmpty
                                        : context.l10n.modelCascadeNoMatch,
                                    style: TextStyle(color: eco.textMuted),
                                  ),
                                )
                              : ListView.builder(
                                  itemCount: visibleModels.length,
                                  itemBuilder: (context, index) {
                                    final model = visibleModels[index];
                                    final selected =
                                        _selectedModel?.modelId == model.id &&
                                        _selectedModel?.providerId ==
                                            (_source == 'login'
                                                ? 'openai'
                                                : _source == 'oauth'
                                                ? 'eco-coding-chatgpt'
                                                : _source) &&
                                        (!accountSource ||
                                            _selectedModel?.accountId ==
                                                _accountId) &&
                                        (model.candidateId == null ||
                                            _selectedModel?.candidateModelId ==
                                                model.candidateId);
                                    return _PickerTile(
                                      title: model.name,
                                      selected: selected,
                                      onTap: _saving || candidateAsync.hasError
                                          ? null
                                          : () => _selectModel(
                                              model,
                                              _supportedEfforts(
                                                model,
                                                model.candidateId == null
                                                    ? null
                                                    : capabilities[model
                                                              .candidateId]
                                                          ?.resolvedSupportsReasoning,
                                              ),
                                            ),
                                    );
                                  },
                                ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: eco.borderSubtle),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: Row(
                children: [
                  Text(
                    context.l10n.composerThinkingEffort,
                    style: TextStyle(fontSize: 12, color: eco.textMuted),
                  ),
                  const Spacer(),
                  Flexible(
                    child: Text(
                      supported.isEmpty && selectedEntry != null
                          ? context.l10n.composerReasoningUnsupported
                          : _effortLabel(effortValue),
                      style: TextStyle(
                        color: eco.accentText,
                        fontWeight: FontWeight.w600,
                      ),
                      textAlign: TextAlign.end,
                    ),
                  ),
                ],
              ),
            ),
            Slider.adaptive(
              value: sliderIndex.toDouble(),
              min: 0,
              max: (effortOptions.length - 1).toDouble(),
              divisions: effortOptions.length > 1
                  ? effortOptions.length - 1
                  : null,
              onChanged:
                  _saving ||
                      candidateAsync.hasError ||
                      supported.isEmpty ||
                      selectedEntry?.candidateId != null &&
                          candidateAsync.isLoading
                  ? null
                  : (value) =>
                        setState(() => _effort = effortOptions[value.round()]),
              onChangeEnd: (value) {
                final effort = effortOptions[value.round()];
                final current = _selectedModel;
                if (current != null && current.thinkingEffort != effort) {
                  unawaited(
                    _save(
                      OrchestrationModelRef(
                        providerId: current.providerId,
                        modelId: current.modelId,
                        candidateModelId: current.candidateModelId,
                        accountId: current.accountId,
                        thinkingEffort: effort,
                      ),
                    ),
                  );
                }
              },
            ),
            if (error != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 64),
                  child: SingleChildScrollView(
                    child: Text(
                      error.toString(),
                      style: TextStyle(color: eco.statusDenyText, fontSize: 12),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _PickerTile extends StatelessWidget {
  const _PickerTile({
    required this.title,
    required this.selected,
    required this.onTap,
    this.icon,
  });

  final String title;
  final bool selected;
  final VoidCallback? onTap;
  final String? icon;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return InkWell(
      borderRadius: BorderRadius.circular(9),
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 38),
        margin: const EdgeInsets.symmetric(vertical: 2, horizontal: 2),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
        decoration: BoxDecoration(
          color: selected ? eco.composerPillBg : null,
          borderRadius: BorderRadius.circular(9),
        ),
        child: Row(
          children: [
            if (icon != null) ...[
              Image.asset(
                icon!,
                width: 18,
                height: 18,
                filterQuality: FilterQuality.medium,
              ),
              const SizedBox(width: 7),
            ],
            Expanded(
              child: Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 13, color: eco.textPrimary),
              ),
            ),
            if (selected) Icon(EcoIcons.check, size: 15, color: eco.accentText),
          ],
        ),
      ),
    );
  }
}

String? _providerIcon(String name) {
  final value = name.toLowerCase();
  final brand = switch (value) {
    _ when RegExp(r'grok|xai|x-ai').hasMatch(value) => 'grok',
    _ when RegExp(r'google|gemini|gemma|deepmind').hasMatch(value) => 'google',
    _ when RegExp(r'anthropic|claude|sonnet|opus|haiku').hasMatch(value) =>
      'anthropic',
    _ when RegExp(r'deepseek|深度求索').hasMatch(value) => 'deepseek',
    _ when RegExp(r'doubao|豆包|volcengine|方舟').hasMatch(value) => 'doubao',
    _
        when RegExp(
          r'bailian|百炼|dashscope|qwen|通义|aliyun|alibaba',
        ).hasMatch(value) =>
      'bailian',
    _ when RegExp(r'kimi|moonshot|月之暗面').hasMatch(value) => 'kimi',
    _ when RegExp(r'minimax|abab|海螺').hasMatch(value) => 'minimax',
    _ when RegExp(r'hunyuan|混元|tencent').hasMatch(value) => 'hunyuan',
    _ when RegExp(r'xiaomi|mimo|小米').hasMatch(value) => 'xiaomi',
    _ when value.contains('opencode') => 'opencode',
    _ when value.contains('openrouter') => 'openrouter',
    _ when RegExp(r'typesafe|system-?one').hasMatch(value) => 'system-one',
    _ when RegExp(r'openai|chatgpt|gpt').hasMatch(value) => 'openai',
    _ => null,
  };
  return brand == null ? null : 'assets/provider-icons/$brand.png';
}
