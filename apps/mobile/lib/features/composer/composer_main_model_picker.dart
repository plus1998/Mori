import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart' hide TextDirection;

import '../../core/locale/app_localizations_ext.dart';
import '../../core/models/codex_account_models.dart';
import '../../core/models/git_models.dart';
import '../../core/models/thread_models.dart';
import '../../core/theme/eco_icons.dart';
import '../../core/theme/eco_theme.dart';
import '../../core/widgets/eco_action_sheet.dart';
import '../threads/thread_providers.dart';

class _PickerAccount {
  const _PickerAccount({required this.id, required this.name, this.quota});

  final String id;
  final String name;
  final CodexAccountQuota? quota;
}

typedef _PickerModel = ({
  String id,
  String name,
  String? candidateId,
  List<String>? efforts,
  bool supportsFast,
});

const _allEfforts = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

String _quotaNumber(num value) => (value * 10).round() % 10 == 0
    ? value.toStringAsFixed(0)
    : value.toStringAsFixed(1);

String _quotaWindowShortLabel(CodexQuotaWindow window) {
  if (window.seconds >= 86400 && window.seconds % 86400 == 0) {
    return '${_quotaNumber(window.seconds / 86400)}d';
  }
  if (window.seconds >= 3600 && window.seconds % 3600 == 0) {
    return '${_quotaNumber(window.seconds / 3600)}h';
  }
  return '';
}

String? _quotaResetTime(
  BuildContext context,
  CodexQuotaWindow window,
  int fetchedAt,
) {
  final resetAt = window.resetsAt(fetchedAt);
  if (resetAt == null) return null;
  return DateFormat.Md(
    Localizations.localeOf(context).toLanguageTag(),
  ).add_Hm().format(resetAt);
}

String _pickerAccountQuotaText(BuildContext context, CodexAccountQuota? quota) {
  if (quota == null) return context.l10n.codexQuotaIdle;
  final windows = quota.windows.where((window) => window.valid).toList();
  if (windows.isEmpty) return context.l10n.codexQuotaIdle;
  final remaining = windows
      .map(
        (window) => [
          if (_quotaWindowShortLabel(window).isNotEmpty)
            _quotaWindowShortLabel(window),
          '${_quotaNumber(window.remaining)}%',
        ].join(' '),
      )
      .join(' / ');
  final resetTimes = windows
      .map((window) => _quotaResetTime(context, window, quota.fetchedAt))
      .whereType<String>()
      .join(' / ');
  return resetTimes.isEmpty ? remaining : '$remaining · ↻ $resetTimes';
}

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

/// API models can be selected directly; OAuth models require an explicit account.
class ComposerStatelessModelPicker extends StatelessWidget {
  const ComposerStatelessModelPicker({
    super.key,
    required this.selectedModel,
    required this.onSelected,
    required this.enabled,
    this.mainAgentConfigId = '',
    this.approval = false,
  });

  final OrchestrationModelRef? selectedModel;
  final ValueChanged<OrchestrationModelRef> onSelected;
  final bool enabled;
  final String mainAgentConfigId;
  final bool approval;

  @override
  Widget build(BuildContext context) => _MainModelPicker(
    selectedModel: selectedModel,
    coreKind: null,
    onSelected: onSelected,
    stateless: true,
    enabled: enabled,
    approval: approval,
    mainAgentConfigId: mainAgentConfigId,
  );
}

class _MainModelPicker extends ConsumerStatefulWidget {
  const _MainModelPicker({
    required this.selectedModel,
    required this.coreKind,
    required this.onSelected,
    this.stateless = false,
    this.enabled = true,
    this.approval = false,
    this.mainAgentConfigId = '',
  });

  final bool stateless;
  final bool enabled;
  final bool approval;
  final String mainAgentConfigId;
  final OrchestrationModelRef? selectedModel;
  final String? coreKind;
  final FutureOr<void> Function(OrchestrationModelRef) onSelected;

  @override
  ConsumerState<_MainModelPicker> createState() => _MainModelPickerState();
}

class _MainModelPickerState extends ConsumerState<_MainModelPicker> {
  late OrchestrationModelRef? _selectedModel = widget.selectedModel;
  late String _source = switch (widget.selectedModel?.providerId) {
    'openai' => widget.stateless ? '' : 'login',
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
  late final Set<String> _catalogPending = {
    if (!widget.stateless) 'loginAccounts',
    'oauthAccounts',
    if (!widget.stateless) 'loginModels',
  };
  final Map<String, Object> _catalogErrors = {};
  bool _oauthModelsLoading = false;
  bool _saving = false;
  Object? _error;
  int _oauthRequest = 0;
  final TextEditingController _queryController = TextEditingController();
  final ScrollController _providersScroll = ScrollController();
  final GlobalKey _selectedProviderKey = GlobalKey();
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
  void didUpdateWidget(covariant _MainModelPicker oldWidget) {
    super.didUpdateWidget(oldWidget);
    final previous = oldWidget.selectedModel;
    final next = widget.selectedModel;
    if ((
          previous?.providerId,
          previous?.accountId,
          previous?.modelId,
          previous?.candidateModelId,
        ) ==
        (
          next?.providerId,
          next?.accountId,
          next?.modelId,
          next?.candidateModelId,
        )) {
      return;
    }
    _selectedModel = next;
    _source = switch (next?.providerId) {
      'openai' => widget.stateless ? '' : 'login',
      'eco-coding-chatgpt' => 'oauth',
      final id? => id,
      _ => '',
    };
    final accountChanged = _accountId != (next?.accountId ?? '');
    _accountId = next?.accountId ?? '';
    if (accountChanged) {
      _oauthRequest++;
      _oauthModels = [];
      _oauthModelsLoading = false;
      _error = null;
      if (_source == 'oauth' && _accountId.isNotEmpty) {
        unawaited(_loadOauthModels(_accountId));
      }
    }
  }

  @override
  void dispose() {
    _queryController.dispose();
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
      if (!widget.stateless)
        _loadCatalogPart('loginAccounts', rpc.listCodexAccounts(), (accounts) {
          _loginAccounts = [
            for (final account in accounts)
              if (account.canUseCredentials)
                _PickerAccount(
                  id: account.id,
                  name: account.name,
                  quota: account.quota,
                ),
          ];
        }),
      _loadCatalogPart('oauthAccounts', rpc.listChatGptOauthAccounts(), (
        accounts,
      ) {
        _oauthAccounts = [
          for (final account in accounts)
            if (account['enabled'] == true && account['hasCredentials'] == true)
              _PickerAccount(
                id: account['accountId'] as String,
                name:
                    account['displayName'] as String? ??
                    account['accountId'] as String,
              ),
        ];
      }),
      if (!widget.stateless)
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
                  supportsFast: model['supportsFast'] == true,
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
              candidateId: widget.stateless
                  ? 'account:eco-coding-chatgpt:${Uri.encodeComponent(model['id'] as String)}'
                  : null,
              efforts: _parseEfforts(model['reasoningEfforts']),
              supportsFast: false,
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

  Future<void> _chooseAccount(List<_PickerAccount> accounts) async {
    if (!widget.enabled || _saving || accounts.isEmpty) return;
    final nextAccountId = await showEcoActionSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (context) => _AccountPickerSheet(
        accounts: accounts,
        selectedAccountId: _accountId,
        showQuota: _source == 'login',
      ),
    );
    if (!mounted ||
        nextAccountId == null ||
        nextAccountId == _accountId ||
        _saving) {
      return;
    }
    setState(() {
      _accountId = nextAccountId;
      _selectedModel = null;
    });
    if (_source == 'oauth') {
      unawaited(_loadOauthModels(nextAccountId));
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
      _queryController.clear();
      _query = '';
      _selectedModel = null;
      _oauthRequest++;
      _oauthModelsLoading = false;
      _error = null;
      _initialProviderVisible = false;
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
    final accounts = _source == 'login' ? _loginAccounts : _oauthAccounts;
    if (!widget.enabled ||
        _saving ||
        ((_source == 'login' || _source == 'oauth') &&
            !accounts.any((account) => account.id == _accountId))) {
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
      thinkingEffort: widget.stateless ? null : _normalizedEffort(efforts),
      serviceTier: _source == 'login'
          ? model.supportsFast && _selectedModel?.serviceTier == 'fast'
                ? 'fast'
                : 'default'
          : null,
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
    final optionsAsync = ref.watch(
      widget.approval
          ? approvalModelOptionsProvider(widget.mainAgentConfigId)
          : auxiliaryModelOptionsProvider(widget.mainAgentConfigId),
    );
    final options = optionsAsync.valueOrNull ?? const <CommitModelOptionView>[];
    final providers = <String, String>{
      for (final option in options)
        if (option.providerId != 'openai' &&
            option.providerId != 'eco-coding-chatgpt')
          option.providerId: option.providerName,
      if (!widget.stateless &&
          (widget.coreKind == 'codex' || _source == 'login'))
        'login': 'ChatGPT Login',
      'oauth': 'ChatGPT OAuth',
    };
    if (_source.isEmpty && providers.isNotEmpty) _source = providers.keys.first;
    final accountSource = _source == 'login' || _source == 'oauth';
    final accounts = _source == 'login' ? _loginAccounts : _oauthAccounts;
    final selectedAccount = accounts
        .where((account) => account.id == _accountId)
        .firstOrNull;
    final candidateAsync =
        !widget.stateless && !accountSource && _source.isNotEmpty
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
                candidateId: model.candidateId,
                supportsFast: false,
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
                  supportsFast: false,
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
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final providerContext = _selectedProviderKey.currentContext;
        if (!mounted || providerContext == null) return;
        Scrollable.ensureVisible(
          providerContext,
          alignment: 0.5,
          duration: Duration.zero,
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
    if (!widget.stateless &&
        widget.enabled &&
        !_initialEffortApplied &&
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
                serviceTier: current.serviceTier,
                thinkingEffort: supported.contains('low')
                    ? 'low'
                    : supported.first,
              ),
            ),
          );
        });
      }
    }

    final picker = LayoutBuilder(
      builder: (context, constraints) {
        final desiredHeight = MediaQuery.sizeOf(context).height * 0.66;
        final contentHeight = constraints.maxHeight.isFinite
            ? constraints.maxHeight.clamp(0.0, desiredHeight).toDouble()
            : desiredHeight;
        return SizedBox(
          height: contentHeight,
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
                child: TextField(
                  controller: _queryController,
                  onChanged: (value) => setState(() => _query = value),
                  decoration: InputDecoration(
                    hintText: context.l10n.modelCascadeSearchHint,
                    prefixIcon: Icon(
                      EcoIcons.search,
                      size: 18,
                      color: eco.textMuted,
                    ),
                    suffixIcon: _query.isEmpty
                        ? null
                        : IconButton(
                            tooltip: MaterialLocalizations.of(
                              context,
                            ).clearButtonTooltip,
                            onPressed: () {
                              _queryController.clear();
                              setState(() {
                                _query = '';
                              });
                            },
                            icon: const Icon(EcoIcons.close, size: 17),
                          ),
                    isDense: true,
                    filled: true,
                    fillColor: eco.composerPillBg,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide.none,
                    ),
                  ),
                ),
              ),
              Expanded(
                child: CustomScrollView(
                  slivers: [
                    SliverToBoxAdapter(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          _PickerSectionLabel(
                            title: context.l10n.composerMainModelPickerProvider,
                          ),
                          SizedBox(
                            height: 44,
                            child: SingleChildScrollView(
                              controller: _providersScroll,
                              scrollDirection: Axis.horizontal,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 12,
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  for (final provider in visibleProviders)
                                    Padding(
                                      padding: const EdgeInsets.only(right: 7),
                                      child: ConstrainedBox(
                                        constraints: const BoxConstraints(
                                          maxWidth: 196,
                                        ),
                                        child: _PickerChoice(
                                          key: provider.key == _source
                                              ? _selectedProviderKey
                                              : null,
                                          title: provider.value,
                                          selected: provider.key == _source,
                                          icon: _providerIcon(provider.value),
                                          onTap: !widget.enabled || _saving
                                              ? null
                                              : () =>
                                                    _changeSource(provider.key),
                                        ),
                                      ),
                                    ),
                                ],
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (accountSource)
                      SliverToBoxAdapter(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            _PickerSectionLabel(
                              title: context.l10n.settingsAccount,
                            ),
                            Padding(
                              padding: const EdgeInsets.fromLTRB(12, 6, 12, 12),
                              child: _SelectedAccountSummary(
                                account: selectedAccount,
                                showQuota: _source == 'login',
                                enabled:
                                    widget.enabled &&
                                    !_saving &&
                                    accounts.isNotEmpty,
                                onTap: accounts.isEmpty
                                    ? null
                                    : () => _chooseAccount(accounts),
                              ),
                            ),
                            Divider(height: 1, color: eco.borderSubtle),
                          ],
                        ),
                      ),
                    SliverToBoxAdapter(
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                        child: Row(
                          children: [
                            Text(
                              context.l10n.composerModel,
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                                color: eco.textMuted,
                              ),
                            ),
                            const Spacer(),
                            if (visibleModels.isNotEmpty && !modelLoading)
                              Text(
                                '${visibleModels.length}',
                                style: TextStyle(
                                  fontSize: 12,
                                  color: eco.textMuted,
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                    if (modelLoading)
                      const SliverFillRemaining(
                        hasScrollBody: false,
                        child: Center(
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    else if (accountSource && accounts.isEmpty)
                      SliverFillRemaining(
                        hasScrollBody: false,
                        child: Center(
                          child: Text(
                            context.l10n.composerMainModelPickerNoAccounts,
                            style: TextStyle(color: eco.textMuted),
                          ),
                        ),
                      )
                    else if (accountSource && _accountId.isEmpty)
                      SliverFillRemaining(
                        hasScrollBody: false,
                        child: Center(
                          child: Text(
                            context.l10n.composerMainModelPickerSelectAccount,
                            style: TextStyle(color: eco.textMuted),
                          ),
                        ),
                      )
                    else if (visibleModels.isEmpty)
                      SliverFillRemaining(
                        hasScrollBody: false,
                        child: Center(
                          child: Text(
                            needle.isEmpty
                                ? context.l10n.modelCascadeEmpty
                                : context.l10n.modelCascadeNoMatch,
                            style: TextStyle(color: eco.textMuted),
                          ),
                        ),
                      )
                    else
                      SliverPadding(
                        padding: const EdgeInsets.symmetric(horizontal: 10),
                        sliver: SliverGrid(
                          gridDelegate:
                              const SliverGridDelegateWithFixedCrossAxisCount(
                                crossAxisCount: 2,
                                mainAxisExtent: 46,
                                mainAxisSpacing: 6,
                                crossAxisSpacing: 7,
                              ),
                          delegate: SliverChildBuilderDelegate((
                            context,
                            index,
                          ) {
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
                                    _selectedModel?.accountId == _accountId) &&
                                (model.candidateId == null ||
                                    _selectedModel?.candidateModelId ==
                                        model.candidateId);
                            return _PickerTile(
                              title: model.name,
                              selected: selected,
                              onTap:
                                  !widget.enabled ||
                                      _saving ||
                                      candidateAsync.hasError ||
                                      (accountSource && selectedAccount == null)
                                  ? null
                                  : () => _selectModel(
                                      model,
                                      _supportedEfforts(
                                        model,
                                        model.candidateId == null
                                            ? null
                                            : capabilities[model.candidateId]
                                                  ?.resolvedSupportsReasoning,
                                      ),
                                    ),
                            );
                          }, childCount: visibleModels.length),
                        ),
                      ),
                  ],
                ),
              ),
              Divider(height: 1, color: eco.borderSubtle),
              if (!widget.stateless &&
                  _source == 'login' &&
                  selectedEntry != null &&
                  _selectedModel != null)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: Row(
                    children: [
                      const Text('Fast', style: TextStyle(fontSize: 12)),
                      const SizedBox(width: 6),
                      Tooltip(
                        message: selectedEntry.supportsFast
                            ? context.l10n.composerFastHint
                            : context.l10n.composerFastUnavailable,
                        child: Icon(
                          Icons.info_outline,
                          size: 14,
                          color: eco.textMuted,
                        ),
                      ),
                      const Spacer(),
                      Switch.adaptive(
                        value: _selectedModel?.serviceTier == 'fast',
                        onChanged:
                            !widget.enabled ||
                                _saving ||
                                (!selectedEntry.supportsFast &&
                                    _selectedModel?.serviceTier != 'fast')
                            ? null
                            : (enabled) {
                                final current = _selectedModel!;
                                unawaited(
                                  _save(
                                    OrchestrationModelRef(
                                      providerId: current.providerId,
                                      modelId: current.modelId,
                                      accountId: current.accountId,
                                      candidateModelId:
                                          current.candidateModelId,
                                      thinkingEffort: current.thinkingEffort,
                                      serviceTier: enabled ? 'fast' : 'default',
                                    ),
                                  ),
                                );
                              },
                      ),
                    ],
                  ),
                ),
              if (!widget.stateless)
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
                  child: Column(
                    children: [
                      Text(
                        context.l10n.composerThinkingEffort,
                        style: TextStyle(fontSize: 11, color: eco.textMuted),
                      ),
                      const SizedBox(height: 1),
                      Text(
                        selectedEntry == null
                            ? '—'
                            : supported.isEmpty
                            ? context.l10n.composerReasoningUnsupported
                            : _effortLabel(effortValue),
                        style: TextStyle(
                          color: eco.accentText,
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        textAlign: TextAlign.center,
                      ),
                    ],
                  ),
                ),
              if (!widget.stateless)
                SliderTheme(
                  data: SliderTheme.of(context).copyWith(
                    trackHeight: 22,
                    trackShape: _EffortSliderTrackShape(
                      tickCount: effortOptions.length,
                      inactiveDotColor: eco.textMuted.withValues(alpha: 0.72),
                      activeDotColor: Colors.white.withValues(alpha: 0.78),
                    ),
                    thumbShape: const RoundSliderThumbShape(
                      enabledThumbRadius: 14,
                      disabledThumbRadius: 14,
                      elevation: 1,
                      pressedElevation: 2,
                    ),
                    overlayShape: const RoundSliderOverlayShape(
                      overlayRadius: 22,
                    ),
                    activeTrackColor: eco.accent,
                    inactiveTrackColor: eco.composerPillBg,
                    disabledActiveTrackColor: eco.accent.withValues(
                      alpha: 0.42,
                    ),
                    disabledInactiveTrackColor: eco.composerPillBg,
                    thumbColor: Colors.white,
                    disabledThumbColor: Colors.white.withValues(alpha: 0.8),
                    overlayColor: eco.accent.withValues(alpha: 0.14),
                    activeTickMarkColor: Colors.transparent,
                    inactiveTickMarkColor: Colors.transparent,
                  ),
                  child: Slider(
                    value: sliderIndex.toDouble(),
                    min: 0,
                    max: (effortOptions.length - 1).toDouble(),
                    divisions: effortOptions.length > 1
                        ? effortOptions.length - 1
                        : null,
                    semanticFormatterCallback: (value) => _effortLabel(
                      effortOptions[value.round().clamp(
                        0,
                        effortOptions.length - 1,
                      )],
                    ),
                    onChanged:
                        _saving ||
                            candidateAsync.hasError ||
                            selectedEntry == null ||
                            supported.isEmpty ||
                            selectedEntry.candidateId != null &&
                                candidateAsync.isLoading
                        ? null
                        : (value) => setState(
                            () => _effort = effortOptions[value.round()],
                          ),
                    onChangeEnd: (value) {
                      final effort = effortOptions[value.round()];
                      final current = _selectedModel;
                      if (selectedEntry != null &&
                          current != null &&
                          current.thinkingEffort != effort) {
                        unawaited(
                          _save(
                            OrchestrationModelRef(
                              providerId: current.providerId,
                              modelId: current.modelId,
                              candidateModelId: current.candidateModelId,
                              serviceTier: current.serviceTier,
                              accountId: current.accountId,
                              thinkingEffort: effort,
                            ),
                          ),
                        );
                      }
                    },
                  ),
                ),
              if (error != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 64),
                    child: SingleChildScrollView(
                      child: Text(
                        error.toString(),
                        style: TextStyle(
                          color: eco.statusDenyText,
                          fontSize: 12,
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
    return widget.stateless
        ? SizedBox(height: 360, child: picker)
        : EcoSheetScaffold(
            title: context.l10n.composerMainModelPickerTitle,
            maxHeightFactor: 0.78,
            bottomPadding: 8,
            child: picker,
          );
  }
}

class _SelectedAccountSummary extends StatelessWidget {
  const _SelectedAccountSummary({
    required this.account,
    required this.showQuota,
    required this.enabled,
    required this.onTap,
  });

  final _PickerAccount? account;
  final bool showQuota;
  final bool enabled;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final l10n = context.l10n;
    final title =
        account?.name ??
        (enabled
            ? l10n.composerMainModelPickerSelectAccount
            : l10n.composerMainModelPickerNoAccounts);
    return Semantics(
      button: true,
      enabled: enabled,
      label: title,
      child: Material(
        color: enabled
            ? eco.composerPillBg
            : eco.composerPillBg.withValues(alpha: 0.45),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: eco.borderSubtle),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: enabled ? onTap : null,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 9, 10, 9),
            child: Row(
              children: [
                Container(
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    color: eco.cardSurface,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(
                    EcoIcons.user,
                    size: 17,
                    color: enabled ? eco.accentText : eco.textMuted,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: eco.textPrimary,
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      if (showQuota && account != null) ...[
                        const SizedBox(height: 3),
                        _AccountQuotaDetails(
                          quota: account!.quota,
                          showProgress: false,
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Icon(
                  EcoIcons.chevronRight,
                  size: 18,
                  color: enabled
                      ? eco.textMuted
                      : eco.textMuted.withValues(alpha: 0.55),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _AccountPickerSheet extends StatelessWidget {
  const _AccountPickerSheet({
    required this.accounts,
    required this.selectedAccountId,
    required this.showQuota,
  });

  final List<_PickerAccount> accounts;
  final String selectedAccountId;
  final bool showQuota;

  @override
  Widget build(BuildContext context) {
    return EcoSheetScaffold(
      title: context.l10n.settingsAccount,
      maxHeightFactor: 0.72,
      bottomPadding: 8,
      child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
        itemCount: accounts.length,
        separatorBuilder: (_, _) => const SizedBox(height: 8),
        itemBuilder: (context, index) {
          final account = accounts[index];
          final selected = account.id == selectedAccountId;
          return _AccountOptionTile(
            account: account,
            selected: selected,
            showQuota: showQuota,
            onTap: () => Navigator.of(context).pop(account.id),
          );
        },
      ),
    );
  }
}

class _AccountOptionTile extends StatelessWidget {
  const _AccountOptionTile({
    required this.account,
    required this.selected,
    required this.showQuota,
    required this.onTap,
  });

  final _PickerAccount account;
  final bool selected;
  final bool showQuota;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: selected ? eco.composerPillBg : eco.cardSurface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(
            color: selected
                ? eco.accent.withValues(alpha: 0.58)
                : eco.borderSubtle,
          ),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 11, 12, 11),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        account.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: eco.textPrimary,
                          fontSize: 14,
                          fontWeight: selected
                              ? FontWeight.w600
                              : FontWeight.w500,
                        ),
                      ),
                      if (showQuota) ...[
                        const SizedBox(height: 7),
                        _AccountQuotaDetails(
                          quota: account.quota,
                          showProgress: true,
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                Icon(
                  selected ? EcoIcons.checkCircle : EcoIcons.chevronRight,
                  size: selected ? 19 : 18,
                  color: selected ? eco.accentText : eco.textMuted,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _AccountQuotaDetails extends StatelessWidget {
  const _AccountQuotaDetails({required this.quota, required this.showProgress});

  final CodexAccountQuota? quota;
  final bool showProgress;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final l10n = context.l10n;
    if (quota == null) {
      return Text(
        l10n.codexQuotaIdle,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: eco.textMuted, fontSize: 11),
      );
    }
    final windows = quota!.windows.where((window) => window.valid).toList();
    if (windows.isEmpty) {
      return Text(
        l10n.codexQuotaIdle,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: eco.textMuted, fontSize: 11),
      );
    }
    if (!showProgress) {
      return Tooltip(
        message: _pickerAccountQuotaText(context, quota),
        child: Text(
          _pickerAccountQuotaText(context, quota),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(color: eco.textMuted, fontSize: 11),
        ),
      );
    }
    return Semantics(
      label: _pickerAccountQuotaText(context, quota),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var index = 0; index < windows.length; index++) ...[
            if (index > 0) const SizedBox(height: 8),
            _AccountQuotaWindow(
              window: windows[index],
              fetchedAt: quota!.fetchedAt,
            ),
          ],
        ],
      ),
    );
  }
}

class _AccountQuotaWindow extends StatelessWidget {
  const _AccountQuotaWindow({required this.window, required this.fetchedAt});

  final CodexQuotaWindow window;
  final int fetchedAt;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    final l10n = context.l10n;
    final remaining = window.remaining.clamp(0, 100).toDouble();
    final label = _quotaWindowShortLabel(window);
    final reset = _quotaResetTime(context, window, fetchedAt);
    final color = remaining <= 10
        ? eco.danger
        : remaining <= 25
        ? eco.statusWarnText
        : eco.accent;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                label.isEmpty
                    ? l10n.codexQuotaRemaining(_quotaNumber(remaining))
                    : '$label · ${_quotaNumber(remaining)}%',
                style: TextStyle(color: eco.textMuted, fontSize: 10),
              ),
            ),
            if (reset != null)
              Text(
                '↻ $reset',
                style: TextStyle(color: eco.textMuted, fontSize: 10),
              ),
          ],
        ),
        const SizedBox(height: 4),
        ClipRRect(
          borderRadius: BorderRadius.circular(99),
          child: LinearProgressIndicator(
            value: remaining / 100,
            minHeight: 4,
            backgroundColor: eco.borderSubtle,
            color: color,
          ),
        ),
      ],
    );
  }
}

class _PickerSectionLabel extends StatelessWidget {
  const _PickerSectionLabel({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 0),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Text(
          title,
          style: TextStyle(
            color: eco.textMuted,
            fontSize: 12,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}

class _PickerChoice extends StatelessWidget {
  const _PickerChoice({
    super.key,
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
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: selected ? eco.composerPillBg : Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(999),
          side: BorderSide(
            color: selected
                ? eco.accent.withValues(alpha: 0.58)
                : eco.borderSubtle,
          ),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(999),
          onTap: onTap,
          child: SizedBox(
            height: 34,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (icon != null) ...[
                    Image.asset(
                      icon!,
                      width: 16,
                      height: 16,
                      filterQuality: FilterQuality.medium,
                    ),
                    const SizedBox(width: 7),
                  ],
                  Flexible(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: eco.textPrimary,
                        fontSize: 13,
                        fontWeight: selected
                            ? FontWeight.w600
                            : FontWeight.w500,
                      ),
                    ),
                  ),
                  if (selected) ...[
                    const SizedBox(width: 6),
                    Icon(EcoIcons.check, size: 14, color: eco.accentText),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _EffortSliderTrackShape extends RoundedRectSliderTrackShape {
  const _EffortSliderTrackShape({
    required this.tickCount,
    required this.inactiveDotColor,
    required this.activeDotColor,
  });

  final int tickCount;
  final Color inactiveDotColor;
  final Color activeDotColor;

  @override
  void paint(
    PaintingContext context,
    Offset offset, {
    required RenderBox parentBox,
    required SliderThemeData sliderTheme,
    required Animation<double> enableAnimation,
    required TextDirection textDirection,
    required Offset thumbCenter,
    Offset? secondaryOffset,
    bool isDiscrete = false,
    bool isEnabled = false,
    double additionalActiveTrackHeight = 0,
  }) {
    super.paint(
      context,
      offset,
      parentBox: parentBox,
      sliderTheme: sliderTheme,
      enableAnimation: enableAnimation,
      textDirection: textDirection,
      thumbCenter: thumbCenter,
      secondaryOffset: secondaryOffset,
      isDiscrete: isDiscrete,
      isEnabled: isEnabled,
      additionalActiveTrackHeight: additionalActiveTrackHeight,
    );
    if (tickCount < 2) return;

    final trackRect = getPreferredRect(
      parentBox: parentBox,
      offset: offset,
      sliderTheme: sliderTheme,
      isEnabled: isEnabled,
      isDiscrete: isDiscrete,
    );
    final paint = Paint()..style = PaintingStyle.fill;
    final inset = trackRect.width < 26 ? trackRect.width / 2 : 13.0;
    final dotTrackWidth = trackRect.width - inset * 2;
    for (var index = 0; index < tickCount; index++) {
      final progress = index / (tickCount - 1);
      final x = trackRect.left + inset + dotTrackWidth * progress;
      final active = textDirection == TextDirection.ltr
          ? x <= thumbCenter.dx
          : x >= thumbCenter.dx;
      paint.color = active ? activeDotColor : inactiveDotColor;
      context.canvas.drawCircle(Offset(x, trackRect.center.dy), 2.5, paint);
    }
  }
}

class _PickerTile extends StatelessWidget {
  const _PickerTile({
    required this.title,
    required this.selected,
    required this.onTap,
  });

  final String title;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final eco = ecoColors(context);
    return Semantics(
      button: true,
      selected: selected,
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 42),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          decoration: BoxDecoration(
            color: selected ? eco.composerPillBg : null,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: selected
                  ? eco.accent.withValues(alpha: 0.46)
                  : Colors.transparent,
            ),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                    color: eco.textPrimary,
                  ),
                ),
              ),
              if (selected)
                Icon(EcoIcons.check, size: 17, color: eco.accentText),
            ],
          ),
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
