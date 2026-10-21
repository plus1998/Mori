// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Chinese (`zh`).
class AppLocalizationsZh extends AppLocalizations {
  AppLocalizationsZh([String locale = 'zh']) : super(locale);

  @override
  String get readAloudTitle => '正文朗读';

  @override
  String get readAloudEngine => '朗读引擎（此设备）';

  @override
  String get readAloudOnline => '在线 TTS';

  @override
  String get readAloudOnlineHint => '使用已连接电脑的 TTS 配置，电脑需要在线。';

  @override
  String get readAloudSystem => '系统 TTS';

  @override
  String get readAloudSystemHint => '使用此设备的系统音色。';

  @override
  String get readAloudDesktopConfig => '电脑上的朗读配置';

  @override
  String get readAloudVoice => '音色';

  @override
  String get readAloudConfigHint => '音色、风格和供应商请在电脑的语音生成设置中修改。';

  @override
  String get appTitle => 'Eco';

  @override
  String get navSessions => '会话';

  @override
  String get navSettings => '设置';

  @override
  String get connectionReconnecting => '正在连接 Center Server…';

  @override
  String get connectionConnected => '连接成功';

  @override
  String get connectionLostReconnecting => '连接断开，正在连接…';

  @override
  String get connectionLiveChannelDisconnected => '实时通道已断开';

  @override
  String get connectionStillUnreachable => '暂时无法连接 Center Server，请检查网络后重试';

  @override
  String get connectionReconnectBanner => '正在连接…';

  @override
  String get connectionLostBanner => '连接已断开';

  @override
  String get settingsTitle => '设置';

  @override
  String get settingsNotSignedIn => '未登录';

  @override
  String get settingsConnectPcFirst => '请先完成 PC 连接';

  @override
  String get settingsAppearance => '外观';

  @override
  String get settingsTheme => '主题';

  @override
  String get settingsLanguage => '语言';

  @override
  String get settingsLanguageSystem => '跟随系统';

  @override
  String get settingsLanguageChinese => '简体中文';

  @override
  String get settingsLanguageEnglish => 'English';

  @override
  String get settingsShowBilling => '显示计费';

  @override
  String get settingsShowBillingSubtitle => '在 Composer 中显示会话累计用量和费用。';

  @override
  String get settingsThinkingContent => '思考内容';

  @override
  String get settingsThinkingContentEphemeral => '阅后即焚';

  @override
  String get settingsThinkingContentEphemeralHint => '生成时显示，完成后自动隐藏。';

  @override
  String get settingsThinkingContentCollapsed => '折叠';

  @override
  String get settingsThinkingContentCollapsedHint => '完成后默认收起，可随时展开。';

  @override
  String get settingsThinkingContentExpanded => '展开';

  @override
  String get settingsThinkingContentExpandedHint => '完成后默认展开，可随时收起。';

  @override
  String get settingsThemeSystem => '跟随';

  @override
  String get settingsThemeDark => '深色';

  @override
  String get settingsThemeLight => '浅色';

  @override
  String get settingsDefaultMode => '默认模式';

  @override
  String get settingsDefaultModeCaption => '新建会话时的 Composer 模式';

  @override
  String get settingsDefaultBashReviewMode => '默认审批模式';

  @override
  String get settingsDefaultBashReviewModeCaption =>
      '新建会话时 Composer 默认使用的执行审批档位';

  @override
  String get settingsContextWindow => '上下文';

  @override
  String get settingsContextWindowCaption => '全局限制所有会话；模型窗口更小时以模型自身为准';

  @override
  String settingsContextWindowTokens(int tokens) {
    return '$tokens tokens';
  }

  @override
  String get settingsMaxOutputDynamic => '动态计算';

  @override
  String get settingsMaxOutputDynamicCaption =>
      '每次请求按实际窗口 − 本次完整输入 tokens − 1 计算，且不超过模型输出上限。输入计数遵循提供商设置；本地估算并非精确值。';

  @override
  String get settingsMaxOutput => '最大输出';

  @override
  String get settingsMaxOutputCaption =>
      '硬顶：实际请求的 max_tokens 为 min(模型配置, 该上限)，未配置时用此默认值，且不超过上下文减 1';

  @override
  String settingsMaxOutputTokens(int tokens) {
    return '$tokens tokens';
  }

  @override
  String get settingsSessionDefaults => '会话默认';

  @override
  String get settingsRuntimeConfig => '运行配置';

  @override
  String get settingsModels => '更多模型';

  @override
  String get settingsModelsCaption => '新建会话的默认辅助模型、审批模型与视觉模型';

  @override
  String get settingsAccount => '账户';

  @override
  String get settingsSwitchPc => '切换 PC';

  @override
  String get settingsSwitchPcSubtitle => '选择或绑定其他 Desktop 设备';

  @override
  String get setupUnpairPc => '删除 PC';

  @override
  String setupUnpairPcTitle(String name) {
    return '从账号中删除 $name？';
  }

  @override
  String get setupUnpairPcMessage =>
      '将解除该电脑与云端的连接，之后无法再从手机控制它。丢失或找不到的电脑也可以在此清理。';

  @override
  String get setupUnpairPcPasswordHint => '输入与 Desktop 相同的账号密码';

  @override
  String get setupUnpairPcWrongPassword => '密码不正确，请重试。';

  @override
  String get setupUnpairPcPasswordRequired => '请输入密码。';

  @override
  String setupUnpairPcDone(String name) {
    return '已从账号中删除 $name';
  }

  @override
  String get authInvalidCredentials => '邮箱或密码不正确。';

  @override
  String get settingsSignOut => '退出登录';

  @override
  String get settingsSignedOut => '已退出登录';

  @override
  String get settingsRealtimeStatus => '实时通道';

  @override
  String get settingsRealtimeConnected => '已连接';

  @override
  String get settingsRealtimeConnecting => '连接中…';

  @override
  String get settingsRealtimeDisconnected => '未连接';

  @override
  String get settingsRealtimeError => '连接异常';

  @override
  String get sessionModeAgentDescription => '代理直接处理任务，并按需要调用已启用的子代理。';

  @override
  String get sessionModePlanDescription => '先生成计划并等待确认，批准后再进入执行。';

  @override
  String get sessionModeAskDescription => '只读回答与代码探索，不修改文件、不执行命令。';

  @override
  String get composerSessionModePrompt => '想以何种方式工作？';

  @override
  String get composerSessionModeLocked => '当前对话进行中，工作模式不可修改';

  @override
  String get relativeTimeJustNow => '刚刚';

  @override
  String relativeTimeMinutes(int count) {
    return '$count 分钟';
  }

  @override
  String relativeTimeHours(int count) {
    return '$count 小时';
  }

  @override
  String relativeTimeDays(int count) {
    return '$count 天';
  }

  @override
  String relativeTimeWeeks(int count) {
    return '$count 周';
  }

  @override
  String relativeTimeMonths(int count) {
    return '$count 月';
  }

  @override
  String relativeTimeYears(int count) {
    return '$count 年';
  }

  @override
  String get commonCancel => '取消';

  @override
  String get commonSave => '保存';

  @override
  String get commonClose => '关闭';

  @override
  String get commonRetry => '重试';

  @override
  String get commonSubmit => '提交';

  @override
  String get commonProcessing => '处理中…';

  @override
  String get commonExpand => '展开';

  @override
  String get commonCollapse => '收起';

  @override
  String get commonBack => '返回';

  @override
  String get commonRefresh => '刷新状态';

  @override
  String get commonDelete => '删除';

  @override
  String get commonEnable => '启用';

  @override
  String get commonEnabled => '已启用';

  @override
  String get commonDisabled => '已停用';

  @override
  String get commonNotConfigured => '未配置';

  @override
  String get commonUnavailable => '未提供';

  @override
  String get commonLoading => '加载中…';

  @override
  String get commonOnline => '在线';

  @override
  String get commonOffline => '离线';

  @override
  String get commonChecking => '检测中';

  @override
  String get commonNotSelected => '未选择';

  @override
  String get toolbarSearch => '搜索会话和项目';

  @override
  String get toolbarOpenProject => '打开项目';

  @override
  String get toolbarSwitchPc => '切换 PC';

  @override
  String get threadsTitle => '会话';

  @override
  String get threadNew => '新建会话';

  @override
  String get threadTitleGenerating => '正在生成标题…';

  @override
  String get threadMore => '更多';

  @override
  String get threadAttentionTitle => '需要关注';

  @override
  String get threadAttentionEmpty => '暂无需要处理的会话';

  @override
  String get threadAttentionPlan => '等待计划审批';

  @override
  String get threadAttentionBash => '等待操作审批';

  @override
  String get threadBackToBottom => '回到底部';

  @override
  String get threadWorkspaceCopied => '工作目录已复制';

  @override
  String get threadNoSessions => '暂无会话';

  @override
  String get threadsLoadFailedTitle => '无法加载会话列表';

  @override
  String get threadSearchHint => '搜索会话标题或项目';

  @override
  String get threadSearchClear => '清除';

  @override
  String get threadSearchRunning => '正在运行';

  @override
  String get threadSearchSessions => '会话';

  @override
  String get threadSearchProjects => '项目';

  @override
  String get threadSearchNoResults => '没有匹配的会话或项目';

  @override
  String get projectFallbackName => '项目';

  @override
  String get projectNoProjects => '还没有项目';

  @override
  String get projectNoProjectsHint => '点右上角打开项目，输入 Desktop 上的路径即可开始。';

  @override
  String get projectOpen => '打开项目';

  @override
  String get projectOpening => '正在读取 Desktop 文件夹…';

  @override
  String get projectOpenCurrentFolder => '打开当前文件夹';

  @override
  String get projectNoSubfolders => '此文件夹没有子文件夹';

  @override
  String get projectParentFolder => '上一级';

  @override
  String get projectOpened => '项目已打开';

  @override
  String get projectPin => '置顶';

  @override
  String get projectUnpin => '取消置顶';

  @override
  String get projectRemove => '移除项目';

  @override
  String get projectNoPcSelected => '未选择 PC';

  @override
  String get approvalReject => '拒绝';

  @override
  String get approvalApprove => '批准';

  @override
  String get approvalApproveExecution => '批准执行';

  @override
  String get approvalPlanTitle => '计划审批';

  @override
  String get approvalUserRequest => '用户请求';

  @override
  String get approvalAnalysis => '分析';

  @override
  String get approvalPlan => '计划';

  @override
  String get approvalToolReadTitle => '工具读取确认';

  @override
  String get approvalBashTitle => 'Bash 执行确认';

  @override
  String get approvalNeedsClarification => '需要澄清';

  @override
  String get approvalClarificationPrevious => '上一题';

  @override
  String get approvalClarificationNext => '下一题';

  @override
  String get approvalClarificationRecommended => '推荐';

  @override
  String get approvalClarificationCompleteSelection => '完成选择';

  @override
  String get approvalSeverityCritical => '严重';

  @override
  String get approvalSeverityHigh => '高';

  @override
  String get approvalSeverityMedium => '中';

  @override
  String get approvalSeverityLow => '低';

  @override
  String get approvalSkip => '跳过';

  @override
  String get approvalYes => '是';

  @override
  String get approvalImplementPlan => '实施计划';

  @override
  String get approvalPlanExpand => '展开计划';

  @override
  String get approvalPlanCollapse => '收起计划';

  @override
  String get approvalLastRunFailed => '上次执行失败';

  @override
  String get approvalIgnore => '忽略';

  @override
  String get approvalExecutePlan => '执行计划 ↵';

  @override
  String get approvalSubmitEnter => '提交 ↵';

  @override
  String get approvalAutoReviewFailedTitle => '自动审批未通过';

  @override
  String get approvalAutoReviewFailedHint => '请先阅读审批模型给出的风险说明，再决定是否放行。';

  @override
  String get approvalAutoReviewErrorTitle => '自动审批请求失败';

  @override
  String get approvalAutoReviewErrorHint => '审批模型未返回有效审批结果，已转人工审批。下方为原始错误信息。';

  @override
  String get composerAddImage => '添加图片';

  @override
  String get composerImage => '图片';

  @override
  String get composerPlusMenu => '更多';

  @override
  String composerExitSessionMode(String mode) {
    return '退出$mode';
  }

  @override
  String get composerMcpServers => 'MCP 服务器';

  @override
  String get composerVoiceInput => '语音输入';

  @override
  String get composerVoiceInputFailed => '语音识别失败';

  @override
  String get composerStopVoiceInput => '停止语音输入';

  @override
  String get composerNoSpeech => '未识别到语音内容';

  @override
  String get composerSendHint => '发送消息…';

  @override
  String get composerFollowUp => '跟进';

  @override
  String get composerRequestChanges => '要求后续变更';

  @override
  String composerPendingImage(int index) {
    return '待发送图片 $index';
  }

  @override
  String composerRemoveImage(int index) {
    return '移除图片 $index';
  }

  @override
  String get voiceListening => '正在聆听';

  @override
  String get voiceTapToStop => '说完后轻触任意处停止';

  @override
  String get voiceStop => '停止';

  @override
  String get setupConnectPc => '互联';

  @override
  String get setupPrevious => '上一步';

  @override
  String get setupNext => '下一步';

  @override
  String get setupEnterApp => '进入应用';

  @override
  String get setupTestConnection => '测试连接';

  @override
  String get setupRetestConnection => '重新测试';

  @override
  String get setupConnectionError => '连接异常';

  @override
  String get setupRetryConnection => '重试连接';

  @override
  String get setupCompleteServerFirst => '请先完成服务器配置';

  @override
  String get setupLogin => '登录';

  @override
  String get setupRegister => '注册';

  @override
  String get setupEmail => '邮箱';

  @override
  String get setupPassword => '密码';

  @override
  String get setupRegisterAndLogin => '注册并登录';

  @override
  String get setupPairingCode => '配对码';

  @override
  String get setupPairingCodeHint => '8 位';

  @override
  String get setupScan => '扫码';

  @override
  String get setupBind => '绑定';

  @override
  String get setupCompleteLoginFirst => '请先完成登录';

  @override
  String get setupBindPcFirst => '请先登录账号';

  @override
  String get setupNoBoundDevices => '暂无已注册的 PC';

  @override
  String get setupNoRegisteredPcs => '账号下还没有已登录的 PC。请先在 Desktop 登录同一账号。';

  @override
  String get setupScanPcCode => '扫描服务器二维码';

  @override
  String get setupScanPcCodeHint => '扫描 Desktop 连接页二维码以连接服务器；仍需账号密码登录';

  @override
  String get setupManualConfiguration => '手动配置';

  @override
  String get setupSelectPc => '选择 PC';

  @override
  String get setupSelectPcHint => '选中一台已登录的 Desktop 进入应用。扫码仅用于连接服务器。';

  @override
  String get setupCurrent => '当前';

  @override
  String get setupBound => '已连接';

  @override
  String get setupSelectOnlinePcFirst => '请选择一台在线 PC 后再进入应用';

  @override
  String get setupBindNewPc => '扫码连接';

  @override
  String get pairingScanTitle => '扫描连接码';

  @override
  String get pairingScanHint => '将 Desktop 连接页的二维码放入框内';

  @override
  String get pairingTorchOn => '打开灯光';

  @override
  String get pairingTorchOff => '关闭灯光';

  @override
  String get setupWizardServerTitle => '配置 Supabase';

  @override
  String get setupWizardLoginTitle => '注册 / 登录';

  @override
  String get setupWizardBindTitle => '发现 PC';

  @override
  String get setupWizardSelectTitle => '选择 PC';

  @override
  String get setupWizardServerSubtitle => '填写 Supabase 项目 URL 与 anon key';

  @override
  String get setupWizardLoginSubtitle => '登录账号并注册本机为移动设备';

  @override
  String get setupWizardBindSubtitle => '登录后自动发现同一账号下的 PC';

  @override
  String get setupWizardSelectSubtitle => '选择要远程操控的 PC';

  @override
  String get setupWizardServerShort => 'Supabase';

  @override
  String get setupWizardAccountShort => '账号';

  @override
  String get setupWizardPairShort => '发现';

  @override
  String get setupStatusServerReachable => 'Supabase 可达';

  @override
  String get setupStatusServerHelp => '请检查项目 URL、anon key 与网络';

  @override
  String get setupStatusAccountDevice => '账号与手机设备';

  @override
  String get setupStatusRegisteringDevice => '正在注册本机设备…';

  @override
  String get setupStatusLiveChannel => '实时通道 (Realtime)';

  @override
  String get setupStatusCenterConnected => '已连接 Supabase';

  @override
  String get setupSupabaseUrlLabel => 'Supabase URL';

  @override
  String get setupSupabaseUrlHint => 'https://xxxx.supabase.co';

  @override
  String get setupAnonKeyLabel => 'Anon key';

  @override
  String get setupAnonKeyHint => '公开 anon key（不要填 service_role）';

  @override
  String get setupAnonKeyKeep => '留空则保留已保存的 anon key';

  @override
  String get setupStatusConnecting => '正在连接…';

  @override
  String get setupStatusPairPc => '发现 PC';

  @override
  String setupStatusBoundCount(int count) {
    return '已绑定 $count 台';
  }

  @override
  String get setupStatusPairHint => '登录后自动发现同一账号下的 PC';

  @override
  String get setupStatusSelectControlledPc => '选择操控的 PC';

  @override
  String setupStatusCheckingDevice(Object name) {
    return '$name · 检测中…';
  }

  @override
  String setupStatusDeviceOnline(Object name) {
    return '$name · 在线';
  }

  @override
  String setupStatusDeviceOffline(Object name) {
    return '$name · 离线';
  }

  @override
  String get setupStatusDesktopOfflineHelp =>
      'Desktop 当前离线，请确认 Desktop 已连接同一 Server';

  @override
  String get setupStatusWebSocketDisconnected => 'WebSocket 未连接，请重新登录或下拉刷新';

  @override
  String get setupProgressTitle => '连接进度';

  @override
  String get setupConnectedReady => '已连接，选择 PC 后可进入主界面';

  @override
  String setupOpenedDevice(Object name) {
    return '已打开 $name';
  }

  @override
  String setupBoundDevice(Object name) {
    return '已绑定 $name';
  }

  @override
  String setupSelectedDevice(Object name) {
    return '已选择 $name';
  }

  @override
  String setupSelectedDeviceOffline(Object name) {
    return '$name 已选择，但当前离线';
  }

  @override
  String setupDeviceOfflineServerHelp(Object name) {
    return '$name 当前离线，请确认 Desktop 已连接 Server';
  }

  @override
  String setupBoundDeviceOffline(Object name) {
    return '$name 已绑定，但当前离线';
  }

  @override
  String get setupScanNeedsLogin =>
      '已写入服务器信息。请使用与 Desktop 相同的账号密码登录，然后选择要控制的 PC。';

  @override
  String get setupScanServerConfigured => '服务器已配置。请选择要控制的 PC。';

  @override
  String get setupLegacyQr => '二维码缺少服务器信息。请先手动填写 Supabase URL 与 anon key，再登录。';

  @override
  String get setupServerReachable => '服务器可达';

  @override
  String get setupServerUnreachable => '无法访问服务器，请检查地址与网络';

  @override
  String get setupServerRequired => '请先完成服务器配置';

  @override
  String get setupLoginSuccess => '登录成功，请选择要控制的 PC';

  @override
  String get setupReconnectAttempted => '已尝试重新连接 WebSocket';

  @override
  String get setupBoundPcFallback => '已连接 PC';

  @override
  String get composerWorkMode => '工作模式';

  @override
  String get composerWorkModeSubtitle => '选择当前会话的运行方式';

  @override
  String get composerMode => '模式';

  @override
  String get composerBashApproval => 'Bash 审批';

  @override
  String get composerBashApprovalSubtitle => '控制命令执行前的确认方式';

  @override
  String get bashReviewAlways => '请求批准';

  @override
  String get bashReviewAlwaysDescription => '编辑工作区外文件或访问互联网时始终询问';

  @override
  String get bashReviewAuto => '替我审批';

  @override
  String get bashReviewAutoDescription => '由审批模型审批；检测到风险或审批失败时请求人工批准';

  @override
  String get bashReviewAllowAll => '完全访问';

  @override
  String get bashReviewAllowAllDescription => '可不受限制地访问互联网和您电脑上的任何文件';

  @override
  String get bashReviewAllowAllConfirm =>
      '开启「完全访问」后，将尽量自动放行对互联网和本机文件的操作，且不再逐条请求你批准。确定继续？';

  @override
  String get composerSettings => 'Composer 设置';

  @override
  String get composerUnsupportedImage => '仅支持 JPEG、PNG、GIF 和 WebP 图片';

  @override
  String get composerImageTooLarge => '图片不能超过 20 MB';

  @override
  String get composerOrchestrationSelection => '编排组合';

  @override
  String activityToolIncomplete(Object text) {
    return '工具未完成 · $text';
  }

  @override
  String activityReadFiles(Object count) {
    return '已读取 $count 个文件';
  }

  @override
  String activityWroteFiles(Object count) {
    return '已写入 $count 个文件';
  }

  @override
  String activityEditedFiles(Object count) {
    return '已编辑 $count 个文件';
  }

  @override
  String get activitySearchedCode => '已搜索代码';

  @override
  String activitySearchedCodeTimes(Object count) {
    return '已搜索代码 $count 次';
  }

  @override
  String activityRanCommands(Object count) {
    return '已运行 $count 条命令';
  }

  @override
  String activityCalledSubagents(Object count) {
    return '已调用 $count 个子代理';
  }

  @override
  String activityRanTools(Object count) {
    return '已执行 $count 个工具';
  }

  @override
  String activityDetailCreateTask(Object suffix) {
    return '创建了任务$suffix';
  }

  @override
  String activityDetailUpdateTask(Object suffix) {
    return '更新了任务$suffix';
  }

  @override
  String activityDetailWrite(Object suffix) {
    return '写入了$suffix';
  }

  @override
  String activityDetailEdit(Object suffix) {
    return '编辑了$suffix';
  }

  @override
  String activityDetailRead(Object suffix) {
    return '读取了$suffix';
  }

  @override
  String activityDetailSearch(Object suffix) {
    return '搜索了$suffix';
  }

  @override
  String activityDetailWebSearch(Object suffix) {
    return '联网搜索$suffix';
  }

  @override
  String activityDetailAgent(Object suffix) {
    return '调用了子代理$suffix';
  }

  @override
  String activityDetailTool(Object suffix) {
    return '执行了$suffix';
  }

  @override
  String activityWebSearches(Object count) {
    return '已联网搜索 $count 次';
  }

  @override
  String activitySummaryWeb(Object count) {
    return '已联网 $count 次';
  }

  @override
  String activitySummaryCreatedTasks(Object count) {
    return '已创建 $count 个任务';
  }

  @override
  String activitySummaryUpdatedTasks(Object count) {
    return '已更新任务 $count 次';
  }

  @override
  String activitySummarySkills(Object count) {
    return '已读取 $count 个技能';
  }

  @override
  String activitySummaryMcpTools(Object count) {
    return '已调用 $count 个 MCP 工具';
  }

  @override
  String activitySummaryImages(Object count) {
    return '已处理 $count 张图像';
  }

  @override
  String activitySummaryBrowser(Object count) {
    return '已操作浏览器 $count 次';
  }

  @override
  String activitySummaryComputerUse(Object count) {
    return '电脑操控 $count 次';
  }

  @override
  String activityRunningRead(Object suffix) {
    return '正在读取$suffix';
  }

  @override
  String activityRunningWrite(Object suffix) {
    return '正在写入$suffix';
  }

  @override
  String activityRunningEdit(Object suffix) {
    return '正在编辑$suffix';
  }

  @override
  String activityRunningSearch(Object suffix) {
    return '正在搜索$suffix';
  }

  @override
  String activityRunningWebSearch(Object suffix) {
    return '正在联网搜索$suffix';
  }

  @override
  String activityRunningWebFetch(Object suffix) {
    return '正在获取$suffix';
  }

  @override
  String activityRunningCommand(Object suffix) {
    return '正在运行$suffix';
  }

  @override
  String activityRunningAgent(Object suffix) {
    return '正在调用子代理$suffix';
  }

  @override
  String activityRunningTool(Object suffix) {
    return '正在执行$suffix';
  }

  @override
  String activityRunningSkill(Object suffix) {
    return '正在读取技能$suffix';
  }

  @override
  String activityRunningMcp(Object suffix) {
    return '正在调用 MCP$suffix';
  }

  @override
  String get activityRunningMcpSearch => '正在查找 MCP 工具';

  @override
  String get activityRunningImageCreate => '正在生成图片';

  @override
  String get activityRunningComputerUse => '正在操控电脑';

  @override
  String activityRunningBrowserOpen(Object suffix) {
    return '正在打开$suffix';
  }

  @override
  String activityRunningTaskCreate(Object suffix) {
    return '正在创建任务$suffix';
  }

  @override
  String activityRunningTaskUpdate(Object suffix) {
    return '正在更新任务$suffix';
  }

  @override
  String activityDoneRead(Object suffix) {
    return '读取了$suffix';
  }

  @override
  String get activityDoneReadFallback => '读取了文件';

  @override
  String activityDoneWrite(Object suffix) {
    return '写入了$suffix';
  }

  @override
  String get activityDoneWriteFallback => '写入了文件';

  @override
  String activityDoneEdit(Object suffix) {
    return '编辑了$suffix';
  }

  @override
  String get activityDoneEditFallback => '编辑了文件';

  @override
  String activityDoneSearch(Object suffix) {
    return '搜索了$suffix';
  }

  @override
  String get activityDoneSearchFallback => '搜索了代码';

  @override
  String activityDoneWebSearch(Object suffix) {
    return '联网搜索了$suffix';
  }

  @override
  String get activityDoneWebSearchFallback => '联网搜索了';

  @override
  String activityDoneWebFetch(Object suffix) {
    return '获取了$suffix';
  }

  @override
  String get activityDoneWebFetchFallback => '获取了网页';

  @override
  String activityDoneCommand(Object suffix) {
    return '运行了$suffix';
  }

  @override
  String get activityDoneCommandFallback => '运行了命令';

  @override
  String activityDoneAgent(Object suffix) {
    return '调用了子代理$suffix';
  }

  @override
  String get activityDoneAgentFallback => '调用了子代理';

  @override
  String activityDoneTaskCreate(Object suffix) {
    return '创建了任务$suffix';
  }

  @override
  String get activityDoneTaskCreateFallback => '创建了任务';

  @override
  String activityDoneTaskUpdate(Object suffix) {
    return '更新了任务$suffix';
  }

  @override
  String get activityDoneTaskUpdateFallback => '更新了任务';

  @override
  String activityDoneSkill(Object suffix) {
    return '读取了技能$suffix';
  }

  @override
  String get activityDoneSkillFallback => '读取了技能';

  @override
  String activityDoneMcp(Object suffix) {
    return '调用了 MCP$suffix';
  }

  @override
  String get activityDoneMcpFallback => '调用了 MCP 工具';

  @override
  String get activityDoneMcpSearch => '查找 MCP 工具';

  @override
  String activityDoneTool(Object suffix) {
    return '执行了$suffix';
  }

  @override
  String get activityDoneToolFallback => '执行了工具';

  @override
  String get activityDoneImageCreate => '生成了图片';

  @override
  String get activityDoneComputerUse => '操控了电脑';

  @override
  String activityDoneBrowserOpen(Object suffix) {
    return '打开了$suffix';
  }

  @override
  String get activityNamedFinalizePlan => '提交计划';

  @override
  String get activityNamedCreateImage => '生成图片';

  @override
  String get activityNamedComputerUse => '电脑操控';

  @override
  String get activityNamedViewImage => '查看图像';

  @override
  String get activityNamedDisplayImage => '展示图像';

  @override
  String get activityNamedPublishHtml => '发布 HTML 页面';

  @override
  String get activityNamedAgentBrowserOpen => '打开网页';

  @override
  String get activityNamedAgentBrowserSnapshot => '页面快照';

  @override
  String get activityNamedAgentBrowserClick => '浏览器点击';

  @override
  String get activityNamedAgentBrowserFill => '填写表单';

  @override
  String get activityNamedAgentBrowserScreenshot => '网页截图';

  @override
  String get activityNamedAgentBrowserGetUrl => '读取网址';

  @override
  String get activityNamedAgentBrowserTabList => '列出标签页';

  @override
  String get activityNamedAgentBrowserTabNew => '新建标签页';

  @override
  String get activityNamedAgentBrowserTabSwitch => '切换标签页';

  @override
  String get activityNamedBrowser => '浏览器操作';

  @override
  String get activityNamedWebSearch => '联网搜索';

  @override
  String get activityNamedWebFetch => '获取网页';

  @override
  String get activityCreatingTask => '正在创建任务';

  @override
  String get activityCreatedTask => '已创建任务';

  @override
  String get activityUpdatingTask => '正在更新任务';

  @override
  String get activityUpdatedTask => '已更新任务';

  @override
  String get activityWriting => '正在写入';

  @override
  String activityWritingFileTarget(Object target) {
    return '正在写入 $target';
  }

  @override
  String get activityWritingFile => '正在准备写入文件';

  @override
  String activityWritingReadTarget(Object target) {
    return '正在读取 $target';
  }

  @override
  String get activityWritingRead => '正在准备读取文件';

  @override
  String activityWritingCommandTarget(Object target) {
    return '正在调用 $target';
  }

  @override
  String get activityWritingCommand => '正在准备写入命令';

  @override
  String activityWritingTool(Object tool) {
    return '正在调用 $tool';
  }

  @override
  String get activityWritingUnknown => '正在准备调用工具';

  @override
  String get activityWrote => '已写入';

  @override
  String get activityEditing => '正在编辑';

  @override
  String get activityEdited => '已编辑';

  @override
  String get activityEditedFile => '编辑了文件';

  @override
  String get activityReading => '正在读取';

  @override
  String get activityRead => '已读取';

  @override
  String get activitySearching => '正在搜索';

  @override
  String get activitySearched => '已搜索';

  @override
  String get activityRunning => '正在运行';

  @override
  String get activityRan => '已运行';

  @override
  String get activityRanCommand => '运行了命令';

  @override
  String activityViewImages(Object count) {
    return '查看 $count 张图片';
  }

  @override
  String get activityImageViewViewing => '正在查看 1 张图像';

  @override
  String get activityImageViewViewed => '已查看 1 张图像';

  @override
  String get activityImageDisplayViewing => '正在展示 1 张图像';

  @override
  String get activityImageDisplayViewed => '已展示 1 张图像';

  @override
  String get activityImageDisplayErrorReadFailed => '加载展示图片失败。';

  @override
  String get activityImageDisplayTapToRetry => '点击重试';

  @override
  String activityImageDisplayLoadingPercent(int percent) {
    return '$percent%';
  }

  @override
  String get taskImageDisplayHistory => '展示图片';

  @override
  String get taskImageGenerationHistory => '绘画任务';

  @override
  String get taskHtmlHostHistory => 'HTML 页面';

  @override
  String get taskImageGenerationEmpty => '暂无绘画任务';

  @override
  String get taskHtmlHostEmpty => '暂无 HTML 页面';

  @override
  String get taskHtmlHostOpenFailed => '无法打开页面';

  @override
  String get taskImageGenerationStatusRunning => '进行中';

  @override
  String get taskImageGenerationStatusCompleted => '已完成';

  @override
  String get taskImageGenerationStatusFailed => '失败';

  @override
  String get taskHtmlHostStatusCompleted => '已完成';

  @override
  String get taskHtmlHostStatusFailed => '失败';

  @override
  String get activityHtmlHostPublishing => '正在发布 HTML 页面';

  @override
  String get activityHtmlHostPublished => '已发布 HTML 页面';

  @override
  String get activityImageViewLoading => '正在读取本地图片…';

  @override
  String get activityImageViewLocalPath => '本地路径';

  @override
  String activityImageViewPreviewAlt(String name) {
    return '已查看的图片：$name';
  }

  @override
  String activityImageViewOpen(String name) {
    return '放大查看 $name';
  }

  @override
  String get activityImageViewErrorInvalidPath => '图片路径不是有效的绝对路径。';

  @override
  String get activityImageViewErrorNotFound =>
      '文件不存在，或该路径属于远程执行环境，Desktop 无法直接读取。';

  @override
  String get activityImageViewErrorSymbolicLink => '为避免读取目标不明确，图片预览不接受符号链接。';

  @override
  String get activityImageViewErrorNotFile => '该路径不是常规文件。';

  @override
  String get activityImageViewErrorTooLarge => '图片超过 20 MB，无法在 Feed 中预览。';

  @override
  String get activityImageViewErrorUnsupportedType =>
      '文件内容不是受支持的 PNG、JPEG、GIF 或 WebP 图片。';

  @override
  String get activityImageViewErrorBridgeUnavailable => 'Desktop 图片读取通道不可用。';

  @override
  String get activityImageViewErrorReadFailed => '读取图片失败。';

  @override
  String get activityCallingSubagent => '正在调用子代理';

  @override
  String get activityCalledSubagent => '已调用子代理';

  @override
  String get activityExecuting => '正在执行';

  @override
  String get activityExecuted => '已执行';

  @override
  String activityListPair(Object first, Object second) {
    return '$first和$second';
  }

  @override
  String activityListEnd(Object head, Object last) {
    return '$head和$last';
  }

  @override
  String get activityJoinSeparator => '、';

  @override
  String get activityProcessing => '处理中';

  @override
  String get activityProcessed => '已处理';

  @override
  String get activityStoppedByYou => '你停止了';

  @override
  String activityStoppedByYouAfter(String duration) {
    return '你在 $duration 后停止了';
  }

  @override
  String get activityStoppedUnexpectedly => '运行停止了';

  @override
  String activityStoppedUnexpectedlyAfter(String duration) {
    return '运行 $duration 后停止了';
  }

  @override
  String get activityExecutionProcess => '执行过程';

  @override
  String get activityExecutionResult => '本轮执行结果';

  @override
  String get activityFinalOutput => '最终输出';

  @override
  String get activityExpandFull => '展开全文';

  @override
  String get activityCopyMessage => '复制消息';

  @override
  String get activitySpeakMessage => '朗诵消息';

  @override
  String get activityStopSpeaking => '停止朗诵';

  @override
  String get ttsUnavailable => '当前设备不支持语音合成';

  @override
  String get activityMessageCopied => '已复制';

  @override
  String get activityClarificationAnswer => '询问回答';

  @override
  String get activityNoneSelected => '（未选择）';

  @override
  String get activityThinking => '正在思考';

  @override
  String get activityDeepThinkingDone => '已思考';

  @override
  String activityRunFailed(Object suffix) {
    return '运行失败$suffix';
  }

  @override
  String activityRunningSuffix(Object suffix) {
    return '正在运行$suffix';
  }

  @override
  String activityRanSuffix(Object suffix) {
    return '已运行$suffix';
  }

  @override
  String get activityFailed => '失败';

  @override
  String activitySubagentTask(Object title) {
    return '$title 子代理任务';
  }

  @override
  String get activityTaskGoal => '任务目标';

  @override
  String get activityWaitingMission => '等待任务说明…';

  @override
  String get activityWaitingEvents => '等待执行事件…';

  @override
  String get activityWorking => '工作中';

  @override
  String get activityCompressingContext => '正在自动压缩上下文';

  @override
  String get activityContextCompressed => '上下文已自动压缩';

  @override
  String get activityContextCompressionFailed => '上下文压缩失败';

  @override
  String get activityContextCompressionPaused => '自动上下文压缩已暂停';

  @override
  String get activityWebSearch => '联网搜索';

  @override
  String get activityWebSearchFetch => '获取网页';

  @override
  String get activityWebSearchSearching => '搜索中…';

  @override
  String get activityWebSearchFetching => '获取中…';

  @override
  String get activityWebSearchFailed => '失败';

  @override
  String get activityWebSearchCompleted => '已完成';

  @override
  String get activityWebSearchQuery => '查询';

  @override
  String get activityWebSearchStatus => '状态';

  @override
  String get activityWebSearchAction => '动作';

  @override
  String get activityWebSearchPattern => '匹配';

  @override
  String get activityWebSearchQueries => '查询集';

  @override
  String get activityWebSearchDuration => '耗时';

  @override
  String get activityWebSearchOpenPage => '打开页面';

  @override
  String get activityWebSearchFindInPage => '页内查找';

  @override
  String get activityPromptCacheDrop => 'Prompt cache 命中率大幅下降';

  @override
  String get activityPreparingRetry => '准备重试';

  @override
  String get activityRunDiagnostics => '运行诊断';

  @override
  String activityAllowOutsideWorkspace(Object tool) {
    return '允许在工作区外执行 $tool？';
  }

  @override
  String get activityToolPermissionRequired => '需要确认工具权限';

  @override
  String get activityReadSkill => '读取技能';

  @override
  String get activityStartSubagent => '启动子代理';

  @override
  String get activityConnectionFailed => '连接失败';

  @override
  String activityConnectionFailedHttp(Object status) {
    return '连接失败 · HTTP $status';
  }

  @override
  String activityReconnectAttempt(Object attempt, Object max) {
    return '重连 $attempt/$max';
  }

  @override
  String get roleVision => '看图';

  @override
  String get roleExplore => '探索';

  @override
  String get roleArchitect => '架构';

  @override
  String get roleCoder => '编码';

  @override
  String get roleReviewer => '审查';

  @override
  String get roleTester => '测试';

  @override
  String get toolRead => '读取';

  @override
  String get toolWrite => '写入';

  @override
  String get toolEdit => '编辑';

  @override
  String get toolSearch => '搜索';

  @override
  String get toolFind => '查找';

  @override
  String get toolRunCommand => '运行命令';

  @override
  String get toolCall => '调用';

  @override
  String get toolUpdateTasks => '更新任务';

  @override
  String get toolCreateTask => '创建任务';

  @override
  String get toolListTasks => '列出任务';

  @override
  String get toolReadTaskOutput => '读取任务输出';

  @override
  String get toolClarify => '澄清问题';

  @override
  String get toolWebSearch => '联网搜索';

  @override
  String get toolWebFetch => '获取网页';

  @override
  String get threadTasks => '任务进度';

  @override
  String get threadAutoRead => '自动朗读';

  @override
  String get threadPlan => '计划';

  @override
  String get threadPlanEmpty => '暂无可查看的计划';

  @override
  String get threadCodeReview => '代码审查';

  @override
  String get threadCommitPush => '提交与推送';

  @override
  String get threadStartFirstForTasks => '请先开始会话后再查看任务进度';

  @override
  String get threadSelectOrchestrationFirst => '请先在 Composer 设置中选择编排组合';

  @override
  String get threadLoadingCommit => '正在加载提交信息…';

  @override
  String get threadCommittedPushed => '已提交并推送到远程';

  @override
  String get threadPushed => '已推送到远程';

  @override
  String get threadCommitted => '已提交';

  @override
  String threadPullBehind(Object count) {
    return '拉取（落后 $count）';
  }

  @override
  String get threadFetch => '抓取';

  @override
  String get threadPulling => '正在拉取…';

  @override
  String get threadPullConflictDesktop => '拉取产生冲突，请在 Desktop 处理';

  @override
  String threadPullConflictFiles(Object files) {
    return '拉取冲突：$files';
  }

  @override
  String get threadPullSuccess => '拉取成功';

  @override
  String get threadAlreadySynced => '当前分支已与远程同步';

  @override
  String get threadFetching => '正在抓取…';

  @override
  String get threadFetchComplete => '抓取完成';

  @override
  String get threadTaskListEmpty => '暂无任务列表';

  @override
  String get threadTaskInProgress => '进行中';

  @override
  String get threadTaskCompleted => '已完成';

  @override
  String get threadTaskBlocked => '受阻';

  @override
  String get threadTaskStopped => '已停止';

  @override
  String get threadTaskPending => '待执行';

  @override
  String get threadDesktopDisconnected => '未连接 Desktop';

  @override
  String get threadNpmScriptsEmpty => '未找到 package.json scripts';

  @override
  String get threadNpmScriptsSearchHint => '搜索脚本';

  @override
  String get threadNpmScriptsNoMatches => '没有匹配的脚本';

  @override
  String get threadExtraArgs => '附加参数';

  @override
  String threadExtraArgsValue(Object args) {
    return '附加参数：$args';
  }

  @override
  String get threadCustomizeScript => '自定义命令';

  @override
  String get threadPrefixCommand => '前置命令';

  @override
  String get threadPrefixCommandHint =>
      '例如 nvm use 20 && export NODE_ENV=production';

  @override
  String get threadRun => '运行';

  @override
  String get threadRunStarting => '启动中';

  @override
  String get threadRunRunning => '运行中';

  @override
  String get threadRunCompleted => '已完成';

  @override
  String get threadRunFailed => '执行失败';

  @override
  String get threadRunStopped => '已停止';

  @override
  String get threadStopping => '停止中';

  @override
  String get threadStop => '停止';

  @override
  String get threadWaitingCommandOutput => '等待 Desktop 返回命令输出…';

  @override
  String get threadOutputTruncated => '输出过长，已仅保留最近内容';

  @override
  String get threadDelete => '删除会话';

  @override
  String threadDeleteConfirm(Object title) {
    return '确定删除「$title」？此操作不可撤销。';
  }

  @override
  String get threadDeleted => '会话已删除';

  @override
  String get threadEditGuidanceHint => '编辑引导消息…';

  @override
  String get feedOpening => '正在加载会话';

  @override
  String get threadProjectionLoading => '运行投影加载中…';

  @override
  String get threadProjectionUnavailable => '运行投影尚未就绪';

  @override
  String get threadNoSubagentDetails => '暂无子代理详情';

  @override
  String get threadNoToolDetails => '暂无工具详情';

  @override
  String get threadLoadMoreToolDetails => '加载更多详情';

  @override
  String get threadRequestingDetails => '正在请求详情…';

  @override
  String get threadDetailsFailed => '详情请求失败';

  @override
  String get threadNoDetailsResponse => '未收到详情响应';

  @override
  String get threadZeroDetails => '桌面端返回了 0 条详情';

  @override
  String get threadDetailsUnparseable => '移动端已发起请求，但没有拿到可解析的 detail 结果。';

  @override
  String threadDetailsComplete(Object key, Object kind) {
    return '请求已完成，kind=$kind, key=$key。';
  }

  @override
  String get threadEditingGuidance => '正在编辑引导消息';

  @override
  String get billingTitle => '计费';

  @override
  String get billingComparison => '费用对比';

  @override
  String get billingUnorchestrated => '未编排';

  @override
  String billingPlannerEstimate(Object model) {
    return '按 $model 单价估算';
  }

  @override
  String get billingMainModelEstimate => '按主模型单价估算';

  @override
  String get billingEco => '经济编程';

  @override
  String get billingEcoSubtitle => 'Eco 编排后的实际费用';

  @override
  String get billingSavings => '节省';

  @override
  String get billingTokenUsage => 'Token 用量';

  @override
  String get billingInput => '输入';

  @override
  String get billingOutput => '输出';

  @override
  String get billingCacheHitRate => '缓存命中率';

  @override
  String get billingCacheRead => '缓存读取';

  @override
  String get billingCacheWrite => '缓存写入';

  @override
  String get billingByModel => '按模型';

  @override
  String get billingContext => '上下文';

  @override
  String get billingComposition => '构成';

  @override
  String get billingVsUnorchestrated => '相对未编排估算';

  @override
  String get billingNoComposition => '暂无构成明细';

  @override
  String get usageNoSavings => '暂无节省';

  @override
  String usageSavings(Object cost, Object percent) {
    return '节省 $cost$percent';
  }

  @override
  String get usageFull => '100% 已满';

  @override
  String usageNearLimit(Object percent) {
    return '$percent% 接近上限';
  }

  @override
  String usageAlmostFull(Object percent) {
    return '$percent% 即将触顶';
  }

  @override
  String usageUsed(Object percent) {
    return '$percent% 已用';
  }

  @override
  String get usageAccumulating => '费用累计中…';

  @override
  String get usagePlanHint => '计划阶段已产生的 token 与费用将显示在此处。';

  @override
  String get usageNoRecords => '暂无累计 token 或费用记录。';

  @override
  String get usageCostPlaceholder => '费用 — 有模型请求后显示';

  @override
  String get usageUpdatesPerResponse => '用量随每轮模型响应更新';

  @override
  String get usagePlanUpdates => '计划阶段用量将随模型响应更新';

  @override
  String get usageNoContext => '暂无上下文数据';

  @override
  String get usageContextPlaceholder => '上下文 — 有模型请求后显示';

  @override
  String get diffNoChanges => '工作区暂无未提交变更';

  @override
  String get diffTruncated => 'Diff 内容过长，部分文件可能未完整显示';

  @override
  String diffFilesChanged(Object count) {
    return '$count 个文件已更改';
  }

  @override
  String get diffNoContent => '暂无 diff 内容';

  @override
  String get diffChange => '变更';

  @override
  String diffLine(int start) {
    return '第 $start 行';
  }

  @override
  String diffLineRange(int from, int to) {
    return '第 $from-$to 行';
  }

  @override
  String commitPushFailed(Object error) {
    return '提交已完成，但推送失败：$error';
  }

  @override
  String get commitDestination => '提交到';

  @override
  String get commitNewBranch => '新分支';

  @override
  String get commitCreateBranch => '新建分支';

  @override
  String get commitBranchName => '分支名称';

  @override
  String get commonCreate => '创建';

  @override
  String get commitSelectModel => '选择生成模型';

  @override
  String get commitChanges => '提交变更';

  @override
  String commitFilesSummary(int count, int additions, int deletions) {
    return '$count 个文件 · +$additions -$deletions';
  }

  @override
  String get commitLoadingModels => '加载模型…';

  @override
  String get commitNoModel => '未配置模型';

  @override
  String get commitMessageHint => '提交信息（留空则 AI 生成）';

  @override
  String get commitGenerateMessage => 'AI 生成提交信息';

  @override
  String get commitIncludeUnstaged => '包含未暂存的更改';

  @override
  String get commitCommitting => '提交中…';

  @override
  String get commitPushing => '推送中…';

  @override
  String get commitAndPush => '提交并推送';

  @override
  String commitPushOnlyAhead(Object count) {
    return '仅推送（领先 $count）';
  }

  @override
  String get composerReasoningOff => '关闭';

  @override
  String get composerReasoningLow => '低';

  @override
  String get composerReasoningMedium => '中';

  @override
  String get composerReasoningHigh => '高';

  @override
  String get composerReasoningExtraHigh => '极高';

  @override
  String get composerReasoningMaximum => '最高';

  @override
  String get composerNoSubagents => '当前方案未配置子代理';

  @override
  String get composerOrchestrationNotConfigured => '编排未配置';

  @override
  String get composerModel => '模型';

  @override
  String get composerAcpModelHint => '模型来自 Cursor Agent CLI';

  @override
  String get composerAcpModelDefault => 'Cursor 默认';

  @override
  String get composerAcpModelDefaultHint => '与 Cursor CLI 当前配置保持一致';

  @override
  String get composerAcpModelCurrent => '当前';

  @override
  String get composerAcpModelLoadFailed => '无法从 Cursor Agent CLI 加载模型';

  @override
  String get composerAuxiliaryModel => '辅助模型';

  @override
  String get composerAuxiliaryModelHint => '用于标题生成、Git 提交信息';

  @override
  String get composerAuxiliaryModelManualFallback => '仍可发送；标题不会自动生成，审查将使用手动模式';

  @override
  String get composerAuxiliaryModelNeedsMainAgent => '请先配置主 Agent，再选择辅助模型';

  @override
  String get composerVisionModel => '视觉模型';

  @override
  String get composerVisionModelHint => '用于 image_view 工具；未配置时使用主模型';

  @override
  String get composerVisionModelFollowMain => '未配置时使用当前主模型看图';

  @override
  String get composerVisionModelNeedsMainAgent => '请先配置主 Agent，再选择视觉模型';

  @override
  String get composerAuxiliaryModelHintAcp => '用于标题生成、命令自动审批';

  @override
  String get composerVisionModelHintAcp => '用于看图；未配置时使用 Cursor 模型';

  @override
  String get composerCoreKind => '运行核心';

  @override
  String get auxiliaryModelRequiredForAutoReview => '尚未配置审批模型，无法启用自动审查';

  @override
  String get auxiliaryModelAutoReviewFallback => '尚未配置审批模型，已切换为手动审查并继续发送';

  @override
  String get composerReasoning => '推理';

  @override
  String get composerReasoningIntensity => '推理';

  @override
  String get composerAdvanced => '高级';

  @override
  String get composerAux => '辅助';

  @override
  String get composerVision => '视觉';

  @override
  String get composerNone => '无';

  @override
  String get composerOrchestration => '编排';

  @override
  String get composerSubagents => '子代理';

  @override
  String get composerOrchestrationComponents => '编排组件';

  @override
  String get composerSessionOnly => '配置仅作用于当前会话';

  @override
  String get composerRuntimeCore => '运行核心';

  @override
  String get composerRuntimeCoreLocked => '当前会话的运行核心已锁定';

  @override
  String get composerOrchestrationLocked => '当前会话不可编辑编排';

  @override
  String get composerMainAgent => '配置';

  @override
  String get composerMainAgentPrompt => '提示词';

  @override
  String get composerBuiltinMainAgentPrompt => '跟随 Agent 内置提示词';

  @override
  String get composerNoSubagentOrchestration => '不使用子代理';

  @override
  String composerAgentsCount(int count) {
    return '$count 个代理';
  }

  @override
  String get composerAlwaysEnabled => '始终启用';

  @override
  String get composerMcpDisabledHint => '关闭后当前会话不再调用该服务器工具';

  @override
  String get composerNoSwitchableAgent => '当前会话未提供可切换的 Agent';

  @override
  String get composerNoSwitchableModel => '当前方案未配置可切换模型';

  @override
  String get composerNoReasoningOptions => '当前方案未配置推理强度';

  @override
  String get composerNoOrchestrationResources => '暂无可用编排资源';

  @override
  String get composerNoMcpServers => '未配置 MCP 服务器';

  @override
  String get composerNoSkills => '当前项目没有可用 Skills';

  @override
  String get composerSkillsHint => '按需启用当前项目可用的 Skills';

  @override
  String composerProjectSkill(Object layout) {
    return '项目 · $layout';
  }

  @override
  String composerUserSkill(Object layout) {
    return '用户 · $layout';
  }

  @override
  String get composerNotEnabled => '未启用';

  @override
  String get composerModelCandidatesHint => '仅显示当前方案 Provider 的候选模型';

  @override
  String get composerModelLocked => '当前会话不可切换模型';

  @override
  String get composerModelLoadFailed => '候选模型加载失败';

  @override
  String get composerReasoningUnsupported => '当前模型不支持推理';

  @override
  String get composerSessionReasoningOnly => '仅影响当前会话';

  @override
  String get composerSelectOrchestration => '选择编排';

  @override
  String get composerSelectOrchestrationSelection => '选择编排组合';

  @override
  String composerOrchestrationSummary(Object summary) {
    return '编排 $summary';
  }

  @override
  String get composerSubagentOrchestration => '子代理';

  @override
  String get composerSubagentOrchestrationSubtitle => '控制当前会话可调用的子代理';

  @override
  String get composerAgents => '代理';

  @override
  String get composerContext => '上下文';

  @override
  String get followUpReorder => '拖动调整消息顺序';

  @override
  String get followUpGuide => '引导';

  @override
  String get followUpEdit => '修改';

  @override
  String get followUpEditing => '正在编辑';

  @override
  String get followUpQueuePaused => '排队已暂停';

  @override
  String get followUpQueuePausedEditing => '排队已暂停，完成编辑后继续发送';

  @override
  String followUpQueueActive(Object count) {
    return '$count条消息正在排队';
  }

  @override
  String get followUpQueuePause => '暂停';

  @override
  String get followUpQueueResume => '继续';

  @override
  String get followUpDeleting => '删除中…';

  @override
  String get followUpQueuedGuidance => '已排队的引导消息';

  @override
  String followUpImages(Object count) {
    return '$count 张图片';
  }

  @override
  String get followUpEmptyGuidance => '空引导消息';

  @override
  String subagentElapsed(Object duration) {
    return '用时 $duration';
  }

  @override
  String get bashApprovalRememberPrefix => '是，且对于以后续内容开头的命令不再询问 ';

  @override
  String get mcpApprovalRememberTool => '允许此工具，下次不再询问（此电脑所有会话） ';

  @override
  String get bashApprovalDenyAdjust => '否，请告知 Eco 如何调整';

  @override
  String projectMoreThreads(Object count) {
    return '还有 $count 条';
  }

  @override
  String get projectAwaitingApproval => '待批准';

  @override
  String get activityThinkingLabel => '思考';

  @override
  String get activitySubagentFallback => '子代理';

  @override
  String get threadNpmScripts => 'npm scripts';

  @override
  String get composerAgent => '运行核心';

  @override
  String get composerMcp => 'MCP';

  @override
  String get composerIntegrations => '集成';

  @override
  String get composerIntegrationsHint => '在 Desktop 完成全局配置后，可为当前会话开启集成';

  @override
  String get composerIntegrationsLoadFailed => '无法从 Desktop 加载集成';

  @override
  String get composerNoIntegrations => 'Desktop 没有可用的集成';

  @override
  String get composerBrowser => '浏览器';

  @override
  String get composerImageGeneration => '创意绘画';

  @override
  String get composerComputerUse => '电脑操控';

  @override
  String get composerSkills => 'Skills';

  @override
  String get composerPlanMode => 'Plan Mode';

  @override
  String get composerBashReview => 'Bash Review';

  @override
  String get errorInvalidServerScheme => 'Supabase 地址必须使用 HTTP 或 HTTPS。';

  @override
  String get errorDeviceCredentialsRequired => '缺少设备凭据。';

  @override
  String get errorQuickPairQrOutdated =>
      '二维码缺少项目地址或授权信息，请使用最新版 Desktop 生成新的二维码。';

  @override
  String get errorServerUnreachable => '无法访问服务器，请检查地址与网络。';

  @override
  String get errorWebSocketDisconnected => 'Realtime 通道尚未连接。';

  @override
  String get errorRpcTimeout => 'Desktop 请求超时。';

  @override
  String get errorServerUrlRequired => '请先配置 Supabase 项目 URL。';

  @override
  String get errorAnonKeyRequired => '请填写 Supabase anon key。';

  @override
  String get errorBindingRequired => '请先与 Desktop 配对后再打开 Realtime 通道。';

  @override
  String get errorConnectionAborted => '连接已取消。';

  @override
  String get errorWebSocketTimeout => 'Realtime 连接超时。';

  @override
  String get errorRpcFailed => 'Desktop 请求失败。';

  @override
  String get errorDeviceCredentialsMissing => '缺少设备凭据。';

  @override
  String get errorServerOutdated =>
      '无法完成扫码绑定：云端未部署 pairing-join，或二维码已过期。请部署 Edge Functions 后，在 Desktop 重新生成二维码。';

  @override
  String errorHttpRequestFailed(Object status) {
    return '请求失败，HTTP $status。';
  }

  @override
  String get errorNetworkRequestFailed => '网络请求失败。';

  @override
  String get errorInvalidPairQr => '无效的配对二维码。';

  @override
  String get authNetwork => '无法连接服务端，请检查网络后重试。';

  @override
  String get authDeviceInactive => '设备已在服务端注销或禁用，请重新配置连接。';

  @override
  String get authAccountUnusable => '账号已停用，请联系管理员。';

  @override
  String get authRelogin => '登录已失效，请重新登录。';

  @override
  String get authUnknown => '连接失败，请稍后重试。';

  @override
  String signOutCleanupFailed(Object message) {
    return '本地已退出，但服务端注销未完成：$message';
  }

  @override
  String get speechPermissionDenied => '需要麦克风权限才能使用云端语音识别';

  @override
  String get speechUnavailable => '当前设备无法使用云端语音识别';

  @override
  String get speechBusy => '上一段云端语音识别仍在进行';

  @override
  String get speechNetworkUnavailable => '云端语音识别服务暂时不可用';

  @override
  String get speechRecognitionFailed => '云端语音识别失败';

  @override
  String get asrDesktopOffline => '连接的 Desktop 当前离线';

  @override
  String get asrNotConfigured => '请先在 Desktop 配置云端语音识别 API 密钥';

  @override
  String get asrCancelled => '语音识别已取消';

  @override
  String get asrTimeout => '云端语音识别请求超时';

  @override
  String get asrAudioTooLarge => '录音超过 10 MB 限制';

  @override
  String get asrMissingConfig => '缺少云端语音识别配置';

  @override
  String get asrAuthFailed => '云端语音识别鉴权失败';

  @override
  String get asrRateLimited => '云端语音识别请求过于频繁';

  @override
  String get asrInvalidResponse => '云端语音识别返回格式无效';

  @override
  String get asrNetwork => '云端语音识别请求失败';

  @override
  String get landingOpenProject => '打开一个项目开始编码';

  @override
  String get landingHomePrompt => '你在忙什么？';

  @override
  String landingProjectPrompt(Object name) {
    return '我们应该在 $name 中构建什么？';
  }

  @override
  String get composerLandingPlaceholder => '尽管问';

  @override
  String get composerDraftRecoveryPending => '上次请求未启动，待恢复的内容尚未填入输入框。';

  @override
  String get composerDraftRecoveryLoadFailed => '无法检查上次未启动请求的待恢复内容。';

  @override
  String get threadFollowUpRefreshFailed => '无法刷新排队中的后续消息。';

  @override
  String get composerRestoreDraft => '恢复内容';

  @override
  String get threadProjectionNoPcSelected => '未选择 PC，无法请求投影详情';

  @override
  String get threadEarlierHistoryLoadFailed => '加载更早的会话记录失败，请在顶部再次下拉重试';

  @override
  String get modelCascadeSearchHint => '搜索服务商或模型…';

  @override
  String get modelCascadeNoMatch => '没有匹配的模型';

  @override
  String get modelCascadeEmpty => '暂无可用模型';

  @override
  String get modelCascadeVendorOther => '其他';

  @override
  String get markdownMermaidRenderError => 'Mermaid 图表渲染失败';

  @override
  String get markdownMermaidExpand => '放大查看';

  @override
  String get markdownMermaidClosePreview => '关闭预览';

  @override
  String get markdownMermaidOpenPreview => '显示预览';

  @override
  String get markdownHtmlCardTitle => 'HTML 页面';

  @override
  String markdownHtmlLineCount(int count) {
    return '$count 行';
  }

  @override
  String get markdownHtmlOpenPreview => '打开 HTML 预览';

  @override
  String get markdownHtmlPreviewTitle => 'HTML 预览';

  @override
  String get markdownTableExpand => '放大查看';

  @override
  String get markdownTableLabel => 'table';

  @override
  String get markdownTableRotateLandscape => '横向查看';

  @override
  String get markdownTableRotatePortrait => '竖向查看';

  @override
  String get composerApprovalModel => '审批模型';

  @override
  String get composerApprovalModelHint => '用于工具自动审批，支持普通模型及 SystemOne（Jev）决策模型';

  @override
  String get composerApprovalModelManualFallback => '未配置时无法启用自动审批';

  @override
  String get composerApprovalModelNeedsMainAgent => '请先配置主 Agent，再选择审批模型';

  @override
  String get composerApprovalModelHintAcp =>
      '用于工具自动审批，支持普通模型及 SystemOne（Jev）决策模型';
}
