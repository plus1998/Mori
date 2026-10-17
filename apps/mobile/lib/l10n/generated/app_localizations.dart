import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_en.dart';
import 'app_localizations_zh.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'generated/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations)!;
  }

  static const LocalizationsDelegate<AppLocalizations> delegate =
      _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('en'),
    Locale('zh'),
  ];

  /// No description provided for @appTitle.
  ///
  /// In en, this message translates to:
  /// **'Eco'**
  String get appTitle;

  /// No description provided for @navSessions.
  ///
  /// In en, this message translates to:
  /// **'Sessions'**
  String get navSessions;

  /// No description provided for @navSettings.
  ///
  /// In en, this message translates to:
  /// **'Settings'**
  String get navSettings;

  /// No description provided for @connectionReconnecting.
  ///
  /// In en, this message translates to:
  /// **'Connecting to Center Server...'**
  String get connectionReconnecting;

  /// No description provided for @connectionConnected.
  ///
  /// In en, this message translates to:
  /// **'Connected'**
  String get connectionConnected;

  /// No description provided for @connectionLostReconnecting.
  ///
  /// In en, this message translates to:
  /// **'Connection lost. Connecting...'**
  String get connectionLostReconnecting;

  /// No description provided for @connectionLiveChannelDisconnected.
  ///
  /// In en, this message translates to:
  /// **'Live connection disconnected'**
  String get connectionLiveChannelDisconnected;

  /// No description provided for @connectionStillUnreachable.
  ///
  /// In en, this message translates to:
  /// **'Still unable to reach Center Server. Check your network and try again.'**
  String get connectionStillUnreachable;

  /// No description provided for @connectionReconnectBanner.
  ///
  /// In en, this message translates to:
  /// **'Connecting…'**
  String get connectionReconnectBanner;

  /// No description provided for @connectionLostBanner.
  ///
  /// In en, this message translates to:
  /// **'Connection lost'**
  String get connectionLostBanner;

  /// No description provided for @settingsTitle.
  ///
  /// In en, this message translates to:
  /// **'Settings'**
  String get settingsTitle;

  /// No description provided for @settingsNotSignedIn.
  ///
  /// In en, this message translates to:
  /// **'Not signed in'**
  String get settingsNotSignedIn;

  /// No description provided for @settingsConnectPcFirst.
  ///
  /// In en, this message translates to:
  /// **'Connect a PC first'**
  String get settingsConnectPcFirst;

  /// No description provided for @settingsAppearance.
  ///
  /// In en, this message translates to:
  /// **'Appearance'**
  String get settingsAppearance;

  /// No description provided for @settingsTheme.
  ///
  /// In en, this message translates to:
  /// **'Theme'**
  String get settingsTheme;

  /// No description provided for @settingsLanguage.
  ///
  /// In en, this message translates to:
  /// **'Language'**
  String get settingsLanguage;

  /// No description provided for @settingsLanguageSystem.
  ///
  /// In en, this message translates to:
  /// **'System'**
  String get settingsLanguageSystem;

  /// No description provided for @settingsLanguageChinese.
  ///
  /// In en, this message translates to:
  /// **'Chinese'**
  String get settingsLanguageChinese;

  /// No description provided for @settingsLanguageEnglish.
  ///
  /// In en, this message translates to:
  /// **'English'**
  String get settingsLanguageEnglish;

  /// No description provided for @settingsShowBilling.
  ///
  /// In en, this message translates to:
  /// **'Show billing'**
  String get settingsShowBilling;

  /// No description provided for @settingsShowBillingSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Show cumulative usage and cost in Composer.'**
  String get settingsShowBillingSubtitle;

  /// No description provided for @settingsThinkingContent.
  ///
  /// In en, this message translates to:
  /// **'Thinking content'**
  String get settingsThinkingContent;

  /// No description provided for @settingsThinkingContentEphemeral.
  ///
  /// In en, this message translates to:
  /// **'Ephemeral'**
  String get settingsThinkingContentEphemeral;

  /// No description provided for @settingsThinkingContentEphemeralHint.
  ///
  /// In en, this message translates to:
  /// **'Shown while generating, then auto-hides.'**
  String get settingsThinkingContentEphemeralHint;

  /// No description provided for @settingsThinkingContentCollapsed.
  ///
  /// In en, this message translates to:
  /// **'Collapsed'**
  String get settingsThinkingContentCollapsed;

  /// No description provided for @settingsThinkingContentCollapsedHint.
  ///
  /// In en, this message translates to:
  /// **'Collapsed when done; expand anytime.'**
  String get settingsThinkingContentCollapsedHint;

  /// No description provided for @settingsThinkingContentExpanded.
  ///
  /// In en, this message translates to:
  /// **'Expanded'**
  String get settingsThinkingContentExpanded;

  /// No description provided for @settingsThinkingContentExpandedHint.
  ///
  /// In en, this message translates to:
  /// **'Expanded when done; collapse anytime.'**
  String get settingsThinkingContentExpandedHint;

  /// No description provided for @settingsThemeSystem.
  ///
  /// In en, this message translates to:
  /// **'System'**
  String get settingsThemeSystem;

  /// No description provided for @settingsThemeDark.
  ///
  /// In en, this message translates to:
  /// **'Dark'**
  String get settingsThemeDark;

  /// No description provided for @settingsThemeLight.
  ///
  /// In en, this message translates to:
  /// **'Light'**
  String get settingsThemeLight;

  /// No description provided for @settingsDefaultMode.
  ///
  /// In en, this message translates to:
  /// **'Default mode'**
  String get settingsDefaultMode;

  /// No description provided for @settingsDefaultModeCaption.
  ///
  /// In en, this message translates to:
  /// **'Composer mode for new sessions'**
  String get settingsDefaultModeCaption;

  /// No description provided for @settingsDefaultBashReviewMode.
  ///
  /// In en, this message translates to:
  /// **'Default approval mode'**
  String get settingsDefaultBashReviewMode;

  /// No description provided for @settingsDefaultBashReviewModeCaption.
  ///
  /// In en, this message translates to:
  /// **'Execution approval mode used by Composer for new sessions'**
  String get settingsDefaultBashReviewModeCaption;

  /// No description provided for @settingsContextWindow.
  ///
  /// In en, this message translates to:
  /// **'Context'**
  String get settingsContextWindow;

  /// No description provided for @settingsContextWindowCaption.
  ///
  /// In en, this message translates to:
  /// **'Global limit for every session; smaller model windows still apply'**
  String get settingsContextWindowCaption;

  /// No description provided for @settingsContextWindowTokens.
  ///
  /// In en, this message translates to:
  /// **'{tokens} tokens'**
  String settingsContextWindowTokens(int tokens);

  /// No description provided for @settingsMaxOutputDynamic.
  ///
  /// In en, this message translates to:
  /// **'Dynamic'**
  String get settingsMaxOutputDynamic;

  /// No description provided for @settingsMaxOutputDynamicCaption.
  ///
  /// In en, this message translates to:
  /// **'Each request uses the effective window − current full input tokens − 1, capped by the model output limit. Input counting follows provider settings; local estimates are not exact.'**
  String get settingsMaxOutputDynamicCaption;

  /// No description provided for @settingsMaxOutput.
  ///
  /// In en, this message translates to:
  /// **'Max output'**
  String get settingsMaxOutput;

  /// No description provided for @settingsMaxOutputCaption.
  ///
  /// In en, this message translates to:
  /// **'Hard ceiling: request max_tokens is min(model config, this limit). Unset models use this default, never above context − 1'**
  String get settingsMaxOutputCaption;

  /// No description provided for @settingsMaxOutputTokens.
  ///
  /// In en, this message translates to:
  /// **'{tokens} tokens'**
  String settingsMaxOutputTokens(int tokens);

  /// No description provided for @settingsSessionDefaults.
  ///
  /// In en, this message translates to:
  /// **'Session defaults'**
  String get settingsSessionDefaults;

  /// No description provided for @settingsRuntimeConfig.
  ///
  /// In en, this message translates to:
  /// **'Runtime config'**
  String get settingsRuntimeConfig;

  /// No description provided for @settingsModels.
  ///
  /// In en, this message translates to:
  /// **'More models'**
  String get settingsModels;

  /// No description provided for @settingsModelsCaption.
  ///
  /// In en, this message translates to:
  /// **'Default auxiliary, approval, and vision models for new threads'**
  String get settingsModelsCaption;

  /// No description provided for @settingsAccount.
  ///
  /// In en, this message translates to:
  /// **'Account'**
  String get settingsAccount;

  /// No description provided for @settingsSwitchPc.
  ///
  /// In en, this message translates to:
  /// **'Switch PC'**
  String get settingsSwitchPc;

  /// No description provided for @settingsSwitchPcSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Select or pair another Desktop device'**
  String get settingsSwitchPcSubtitle;

  /// No description provided for @setupUnpairPc.
  ///
  /// In en, this message translates to:
  /// **'Remove PC'**
  String get setupUnpairPc;

  /// No description provided for @setupUnpairPcTitle.
  ///
  /// In en, this message translates to:
  /// **'Remove {name} from your account?'**
  String setupUnpairPcTitle(String name);

  /// No description provided for @setupUnpairPcMessage.
  ///
  /// In en, this message translates to:
  /// **'This disconnects the PC from the cloud so phones can no longer control it. You can also remove lost or unreachable computers here.'**
  String get setupUnpairPcMessage;

  /// No description provided for @setupUnpairPcPasswordHint.
  ///
  /// In en, this message translates to:
  /// **'Enter the same account password as Desktop'**
  String get setupUnpairPcPasswordHint;

  /// No description provided for @setupUnpairPcWrongPassword.
  ///
  /// In en, this message translates to:
  /// **'Incorrect password. Try again.'**
  String get setupUnpairPcWrongPassword;

  /// No description provided for @setupUnpairPcPasswordRequired.
  ///
  /// In en, this message translates to:
  /// **'Enter your password.'**
  String get setupUnpairPcPasswordRequired;

  /// No description provided for @setupUnpairPcDone.
  ///
  /// In en, this message translates to:
  /// **'Removed {name} from your account'**
  String setupUnpairPcDone(String name);

  /// No description provided for @authInvalidCredentials.
  ///
  /// In en, this message translates to:
  /// **'Incorrect email or password.'**
  String get authInvalidCredentials;

  /// No description provided for @settingsSignOut.
  ///
  /// In en, this message translates to:
  /// **'Sign out'**
  String get settingsSignOut;

  /// No description provided for @settingsSignedOut.
  ///
  /// In en, this message translates to:
  /// **'Signed out'**
  String get settingsSignedOut;

  /// No description provided for @settingsRealtimeStatus.
  ///
  /// In en, this message translates to:
  /// **'Realtime'**
  String get settingsRealtimeStatus;

  /// No description provided for @settingsRealtimeConnected.
  ///
  /// In en, this message translates to:
  /// **'Connected'**
  String get settingsRealtimeConnected;

  /// No description provided for @settingsRealtimeConnecting.
  ///
  /// In en, this message translates to:
  /// **'Connecting…'**
  String get settingsRealtimeConnecting;

  /// No description provided for @settingsRealtimeDisconnected.
  ///
  /// In en, this message translates to:
  /// **'Disconnected'**
  String get settingsRealtimeDisconnected;

  /// No description provided for @settingsRealtimeError.
  ///
  /// In en, this message translates to:
  /// **'Error'**
  String get settingsRealtimeError;

  /// No description provided for @sessionModeAgentDescription.
  ///
  /// In en, this message translates to:
  /// **'Handle tasks directly and call enabled subagents when needed.'**
  String get sessionModeAgentDescription;

  /// No description provided for @sessionModePlanDescription.
  ///
  /// In en, this message translates to:
  /// **'Create a plan and wait for approval before executing it.'**
  String get sessionModePlanDescription;

  /// No description provided for @sessionModeAskDescription.
  ///
  /// In en, this message translates to:
  /// **'Answer and explore code without changing files or running commands.'**
  String get sessionModeAskDescription;

  /// No description provided for @composerSessionModePrompt.
  ///
  /// In en, this message translates to:
  /// **'How do you want to work?'**
  String get composerSessionModePrompt;

  /// No description provided for @composerSessionModeLocked.
  ///
  /// In en, this message translates to:
  /// **'This conversation is running, so the work mode can\'t be changed.'**
  String get composerSessionModeLocked;

  /// No description provided for @relativeTimeJustNow.
  ///
  /// In en, this message translates to:
  /// **'Just now'**
  String get relativeTimeJustNow;

  /// No description provided for @relativeTimeMinutes.
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =1{1 minute} other{{count} minutes}}'**
  String relativeTimeMinutes(int count);

  /// No description provided for @relativeTimeHours.
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =1{1 hour} other{{count} hours}}'**
  String relativeTimeHours(int count);

  /// No description provided for @relativeTimeDays.
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =1{1 day} other{{count} days}}'**
  String relativeTimeDays(int count);

  /// No description provided for @relativeTimeWeeks.
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =1{1 week} other{{count} weeks}}'**
  String relativeTimeWeeks(int count);

  /// No description provided for @relativeTimeMonths.
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =1{1 month} other{{count} months}}'**
  String relativeTimeMonths(int count);

  /// No description provided for @relativeTimeYears.
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =1{1 year} other{{count} years}}'**
  String relativeTimeYears(int count);

  /// No description provided for @commonCancel.
  ///
  /// In en, this message translates to:
  /// **'Cancel'**
  String get commonCancel;

  /// No description provided for @commonSave.
  ///
  /// In en, this message translates to:
  /// **'Save'**
  String get commonSave;

  /// No description provided for @commonClose.
  ///
  /// In en, this message translates to:
  /// **'Close'**
  String get commonClose;

  /// No description provided for @commonRetry.
  ///
  /// In en, this message translates to:
  /// **'Retry'**
  String get commonRetry;

  /// No description provided for @commonSubmit.
  ///
  /// In en, this message translates to:
  /// **'Submit'**
  String get commonSubmit;

  /// No description provided for @commonProcessing.
  ///
  /// In en, this message translates to:
  /// **'Processing...'**
  String get commonProcessing;

  /// No description provided for @commonExpand.
  ///
  /// In en, this message translates to:
  /// **'Expand'**
  String get commonExpand;

  /// No description provided for @commonCollapse.
  ///
  /// In en, this message translates to:
  /// **'Collapse'**
  String get commonCollapse;

  /// No description provided for @commonBack.
  ///
  /// In en, this message translates to:
  /// **'Back'**
  String get commonBack;

  /// No description provided for @commonRefresh.
  ///
  /// In en, this message translates to:
  /// **'Refresh status'**
  String get commonRefresh;

  /// No description provided for @commonDelete.
  ///
  /// In en, this message translates to:
  /// **'Delete'**
  String get commonDelete;

  /// No description provided for @commonEnable.
  ///
  /// In en, this message translates to:
  /// **'Enable'**
  String get commonEnable;

  /// No description provided for @commonEnabled.
  ///
  /// In en, this message translates to:
  /// **'Enabled'**
  String get commonEnabled;

  /// No description provided for @commonDisabled.
  ///
  /// In en, this message translates to:
  /// **'Disabled'**
  String get commonDisabled;

  /// No description provided for @commonNotConfigured.
  ///
  /// In en, this message translates to:
  /// **'Not configured'**
  String get commonNotConfigured;

  /// No description provided for @commonUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Unavailable'**
  String get commonUnavailable;

  /// No description provided for @commonLoading.
  ///
  /// In en, this message translates to:
  /// **'Loading...'**
  String get commonLoading;

  /// No description provided for @commonOnline.
  ///
  /// In en, this message translates to:
  /// **'Online'**
  String get commonOnline;

  /// No description provided for @commonOffline.
  ///
  /// In en, this message translates to:
  /// **'Offline'**
  String get commonOffline;

  /// No description provided for @commonChecking.
  ///
  /// In en, this message translates to:
  /// **'Checking'**
  String get commonChecking;

  /// No description provided for @commonNotSelected.
  ///
  /// In en, this message translates to:
  /// **'Not selected'**
  String get commonNotSelected;

  /// No description provided for @toolbarSearch.
  ///
  /// In en, this message translates to:
  /// **'Search sessions and projects'**
  String get toolbarSearch;

  /// No description provided for @toolbarOpenProject.
  ///
  /// In en, this message translates to:
  /// **'Open project'**
  String get toolbarOpenProject;

  /// No description provided for @toolbarSwitchPc.
  ///
  /// In en, this message translates to:
  /// **'Switch PC'**
  String get toolbarSwitchPc;

  /// No description provided for @threadsTitle.
  ///
  /// In en, this message translates to:
  /// **'Sessions'**
  String get threadsTitle;

  /// No description provided for @threadNew.
  ///
  /// In en, this message translates to:
  /// **'New session'**
  String get threadNew;

  /// No description provided for @threadTitleGenerating.
  ///
  /// In en, this message translates to:
  /// **'Generating title…'**
  String get threadTitleGenerating;

  /// No description provided for @threadMore.
  ///
  /// In en, this message translates to:
  /// **'More'**
  String get threadMore;

  /// No description provided for @threadAttentionTitle.
  ///
  /// In en, this message translates to:
  /// **'Needs attention'**
  String get threadAttentionTitle;

  /// No description provided for @threadAttentionEmpty.
  ///
  /// In en, this message translates to:
  /// **'No sessions need action'**
  String get threadAttentionEmpty;

  /// No description provided for @threadAttentionPlan.
  ///
  /// In en, this message translates to:
  /// **'Plan approval'**
  String get threadAttentionPlan;

  /// No description provided for @threadAttentionBash.
  ///
  /// In en, this message translates to:
  /// **'Action approval'**
  String get threadAttentionBash;

  /// No description provided for @threadBackToBottom.
  ///
  /// In en, this message translates to:
  /// **'Back to bottom'**
  String get threadBackToBottom;

  /// No description provided for @threadWorkspaceCopied.
  ///
  /// In en, this message translates to:
  /// **'Working directory copied'**
  String get threadWorkspaceCopied;

  /// No description provided for @threadNoSessions.
  ///
  /// In en, this message translates to:
  /// **'No sessions'**
  String get threadNoSessions;

  /// No description provided for @threadsLoadFailedTitle.
  ///
  /// In en, this message translates to:
  /// **'Couldn\'t load sessions'**
  String get threadsLoadFailedTitle;

  /// No description provided for @threadSearchHint.
  ///
  /// In en, this message translates to:
  /// **'Search session titles or projects'**
  String get threadSearchHint;

  /// No description provided for @threadSearchClear.
  ///
  /// In en, this message translates to:
  /// **'Clear'**
  String get threadSearchClear;

  /// No description provided for @threadSearchRunning.
  ///
  /// In en, this message translates to:
  /// **'Running'**
  String get threadSearchRunning;

  /// No description provided for @threadSearchSessions.
  ///
  /// In en, this message translates to:
  /// **'Sessions'**
  String get threadSearchSessions;

  /// No description provided for @threadSearchProjects.
  ///
  /// In en, this message translates to:
  /// **'Projects'**
  String get threadSearchProjects;

  /// No description provided for @threadSearchNoResults.
  ///
  /// In en, this message translates to:
  /// **'No matching sessions or projects'**
  String get threadSearchNoResults;

  /// No description provided for @projectFallbackName.
  ///
  /// In en, this message translates to:
  /// **'Project'**
  String get projectFallbackName;

  /// No description provided for @projectNoProjects.
  ///
  /// In en, this message translates to:
  /// **'No projects yet'**
  String get projectNoProjects;

  /// No description provided for @projectNoProjectsHint.
  ///
  /// In en, this message translates to:
  /// **'Open a project from the top right and enter a path on Desktop to begin.'**
  String get projectNoProjectsHint;

  /// No description provided for @projectOpen.
  ///
  /// In en, this message translates to:
  /// **'Open project'**
  String get projectOpen;

  /// No description provided for @projectOpening.
  ///
  /// In en, this message translates to:
  /// **'Reading Desktop folders...'**
  String get projectOpening;

  /// No description provided for @projectOpenCurrentFolder.
  ///
  /// In en, this message translates to:
  /// **'Open current folder'**
  String get projectOpenCurrentFolder;

  /// No description provided for @projectNoSubfolders.
  ///
  /// In en, this message translates to:
  /// **'This folder has no subfolders'**
  String get projectNoSubfolders;

  /// No description provided for @projectParentFolder.
  ///
  /// In en, this message translates to:
  /// **'Parent folder'**
  String get projectParentFolder;

  /// No description provided for @projectOpened.
  ///
  /// In en, this message translates to:
  /// **'Project opened'**
  String get projectOpened;

  /// No description provided for @projectPin.
  ///
  /// In en, this message translates to:
  /// **'Pin'**
  String get projectPin;

  /// No description provided for @projectUnpin.
  ///
  /// In en, this message translates to:
  /// **'Unpin'**
  String get projectUnpin;

  /// No description provided for @projectRemove.
  ///
  /// In en, this message translates to:
  /// **'Remove project'**
  String get projectRemove;

  /// No description provided for @projectNoPcSelected.
  ///
  /// In en, this message translates to:
  /// **'No PC selected'**
  String get projectNoPcSelected;

  /// No description provided for @approvalReject.
  ///
  /// In en, this message translates to:
  /// **'Reject'**
  String get approvalReject;

  /// No description provided for @approvalApprove.
  ///
  /// In en, this message translates to:
  /// **'Approve'**
  String get approvalApprove;

  /// No description provided for @approvalApproveExecution.
  ///
  /// In en, this message translates to:
  /// **'Approve execution'**
  String get approvalApproveExecution;

  /// No description provided for @approvalPlanTitle.
  ///
  /// In en, this message translates to:
  /// **'Plan approval'**
  String get approvalPlanTitle;

  /// No description provided for @approvalUserRequest.
  ///
  /// In en, this message translates to:
  /// **'User request'**
  String get approvalUserRequest;

  /// No description provided for @approvalAnalysis.
  ///
  /// In en, this message translates to:
  /// **'Analysis'**
  String get approvalAnalysis;

  /// No description provided for @approvalPlan.
  ///
  /// In en, this message translates to:
  /// **'Plan'**
  String get approvalPlan;

  /// No description provided for @approvalToolReadTitle.
  ///
  /// In en, this message translates to:
  /// **'Tool read approval'**
  String get approvalToolReadTitle;

  /// No description provided for @approvalBashTitle.
  ///
  /// In en, this message translates to:
  /// **'Bash execution approval'**
  String get approvalBashTitle;

  /// No description provided for @approvalNeedsClarification.
  ///
  /// In en, this message translates to:
  /// **'Clarification needed'**
  String get approvalNeedsClarification;

  /// No description provided for @approvalClarificationPrevious.
  ///
  /// In en, this message translates to:
  /// **'Previous question'**
  String get approvalClarificationPrevious;

  /// No description provided for @approvalClarificationNext.
  ///
  /// In en, this message translates to:
  /// **'Next question'**
  String get approvalClarificationNext;

  /// No description provided for @approvalClarificationRecommended.
  ///
  /// In en, this message translates to:
  /// **'Recommended'**
  String get approvalClarificationRecommended;

  /// No description provided for @approvalClarificationCompleteSelection.
  ///
  /// In en, this message translates to:
  /// **'Complete selection'**
  String get approvalClarificationCompleteSelection;

  /// No description provided for @approvalSeverityCritical.
  ///
  /// In en, this message translates to:
  /// **'Critical'**
  String get approvalSeverityCritical;

  /// No description provided for @approvalSeverityHigh.
  ///
  /// In en, this message translates to:
  /// **'High'**
  String get approvalSeverityHigh;

  /// No description provided for @approvalSeverityMedium.
  ///
  /// In en, this message translates to:
  /// **'Medium'**
  String get approvalSeverityMedium;

  /// No description provided for @approvalSeverityLow.
  ///
  /// In en, this message translates to:
  /// **'Low'**
  String get approvalSeverityLow;

  /// No description provided for @approvalSkip.
  ///
  /// In en, this message translates to:
  /// **'Skip'**
  String get approvalSkip;

  /// No description provided for @approvalYes.
  ///
  /// In en, this message translates to:
  /// **'Yes'**
  String get approvalYes;

  /// No description provided for @approvalImplementPlan.
  ///
  /// In en, this message translates to:
  /// **'Implementation plan'**
  String get approvalImplementPlan;

  /// No description provided for @approvalPlanExpand.
  ///
  /// In en, this message translates to:
  /// **'Expand plan'**
  String get approvalPlanExpand;

  /// No description provided for @approvalPlanCollapse.
  ///
  /// In en, this message translates to:
  /// **'Collapse plan'**
  String get approvalPlanCollapse;

  /// No description provided for @approvalLastRunFailed.
  ///
  /// In en, this message translates to:
  /// **'Last run failed'**
  String get approvalLastRunFailed;

  /// No description provided for @approvalIgnore.
  ///
  /// In en, this message translates to:
  /// **'Ignore'**
  String get approvalIgnore;

  /// No description provided for @approvalExecutePlan.
  ///
  /// In en, this message translates to:
  /// **'Execute plan ↵'**
  String get approvalExecutePlan;

  /// No description provided for @approvalSubmitEnter.
  ///
  /// In en, this message translates to:
  /// **'Submit ↵'**
  String get approvalSubmitEnter;

  /// No description provided for @approvalAutoReviewFailedTitle.
  ///
  /// In en, this message translates to:
  /// **'Automatic approval declined'**
  String get approvalAutoReviewFailedTitle;

  /// No description provided for @approvalAutoReviewFailedHint.
  ///
  /// In en, this message translates to:
  /// **'Read the reviewer’s risk explanation before approving.'**
  String get approvalAutoReviewFailedHint;

  /// No description provided for @approvalAutoReviewErrorTitle.
  ///
  /// In en, this message translates to:
  /// **'Automatic approval request failed'**
  String get approvalAutoReviewErrorTitle;

  /// No description provided for @approvalAutoReviewErrorHint.
  ///
  /// In en, this message translates to:
  /// **'The reviewer did not return a valid result; escalated to a human. Raw error below.'**
  String get approvalAutoReviewErrorHint;

  /// No description provided for @composerAddImage.
  ///
  /// In en, this message translates to:
  /// **'Add image'**
  String get composerAddImage;

  /// No description provided for @composerImage.
  ///
  /// In en, this message translates to:
  /// **'Image'**
  String get composerImage;

  /// No description provided for @composerPlusMenu.
  ///
  /// In en, this message translates to:
  /// **'More'**
  String get composerPlusMenu;

  /// No description provided for @composerExitSessionMode.
  ///
  /// In en, this message translates to:
  /// **'Exit {mode}'**
  String composerExitSessionMode(String mode);

  /// No description provided for @composerMcpServers.
  ///
  /// In en, this message translates to:
  /// **'MCP Servers'**
  String get composerMcpServers;

  /// No description provided for @composerVoiceInput.
  ///
  /// In en, this message translates to:
  /// **'Voice input'**
  String get composerVoiceInput;

  /// No description provided for @composerVoiceInputFailed.
  ///
  /// In en, this message translates to:
  /// **'Voice recognition failed'**
  String get composerVoiceInputFailed;

  /// No description provided for @composerStopVoiceInput.
  ///
  /// In en, this message translates to:
  /// **'Stop voice input'**
  String get composerStopVoiceInput;

  /// No description provided for @composerNoSpeech.
  ///
  /// In en, this message translates to:
  /// **'No speech recognized'**
  String get composerNoSpeech;

  /// No description provided for @composerSendHint.
  ///
  /// In en, this message translates to:
  /// **'Send a message...'**
  String get composerSendHint;

  /// No description provided for @composerFollowUp.
  ///
  /// In en, this message translates to:
  /// **'Follow up'**
  String get composerFollowUp;

  /// No description provided for @composerRequestChanges.
  ///
  /// In en, this message translates to:
  /// **'Request changes'**
  String get composerRequestChanges;

  /// No description provided for @composerPendingImage.
  ///
  /// In en, this message translates to:
  /// **'Pending image {index}'**
  String composerPendingImage(int index);

  /// No description provided for @composerRemoveImage.
  ///
  /// In en, this message translates to:
  /// **'Remove image {index}'**
  String composerRemoveImage(int index);

  /// No description provided for @voiceListening.
  ///
  /// In en, this message translates to:
  /// **'Listening'**
  String get voiceListening;

  /// No description provided for @voiceTapToStop.
  ///
  /// In en, this message translates to:
  /// **'Tap anywhere when you are done'**
  String get voiceTapToStop;

  /// No description provided for @voiceStop.
  ///
  /// In en, this message translates to:
  /// **'Stop'**
  String get voiceStop;

  /// No description provided for @setupConnectPc.
  ///
  /// In en, this message translates to:
  /// **'Connection'**
  String get setupConnectPc;

  /// No description provided for @setupPrevious.
  ///
  /// In en, this message translates to:
  /// **'Previous'**
  String get setupPrevious;

  /// No description provided for @setupNext.
  ///
  /// In en, this message translates to:
  /// **'Next'**
  String get setupNext;

  /// No description provided for @setupEnterApp.
  ///
  /// In en, this message translates to:
  /// **'Enter app'**
  String get setupEnterApp;

  /// No description provided for @setupTestConnection.
  ///
  /// In en, this message translates to:
  /// **'Test connection'**
  String get setupTestConnection;

  /// No description provided for @setupRetestConnection.
  ///
  /// In en, this message translates to:
  /// **'Test again'**
  String get setupRetestConnection;

  /// No description provided for @setupConnectionError.
  ///
  /// In en, this message translates to:
  /// **'Connection error'**
  String get setupConnectionError;

  /// No description provided for @setupRetryConnection.
  ///
  /// In en, this message translates to:
  /// **'Retry connection'**
  String get setupRetryConnection;

  /// No description provided for @setupCompleteServerFirst.
  ///
  /// In en, this message translates to:
  /// **'Configure the server first'**
  String get setupCompleteServerFirst;

  /// No description provided for @setupLogin.
  ///
  /// In en, this message translates to:
  /// **'Sign in'**
  String get setupLogin;

  /// No description provided for @setupRegister.
  ///
  /// In en, this message translates to:
  /// **'Register'**
  String get setupRegister;

  /// No description provided for @setupEmail.
  ///
  /// In en, this message translates to:
  /// **'Email'**
  String get setupEmail;

  /// No description provided for @setupPassword.
  ///
  /// In en, this message translates to:
  /// **'Password'**
  String get setupPassword;

  /// No description provided for @setupRegisterAndLogin.
  ///
  /// In en, this message translates to:
  /// **'Register and sign in'**
  String get setupRegisterAndLogin;

  /// No description provided for @setupPairingCode.
  ///
  /// In en, this message translates to:
  /// **'Pairing code'**
  String get setupPairingCode;

  /// No description provided for @setupPairingCodeHint.
  ///
  /// In en, this message translates to:
  /// **'8 characters'**
  String get setupPairingCodeHint;

  /// No description provided for @setupScan.
  ///
  /// In en, this message translates to:
  /// **'Scan'**
  String get setupScan;

  /// No description provided for @setupBind.
  ///
  /// In en, this message translates to:
  /// **'Pair'**
  String get setupBind;

  /// No description provided for @setupCompleteLoginFirst.
  ///
  /// In en, this message translates to:
  /// **'Sign in first'**
  String get setupCompleteLoginFirst;

  /// No description provided for @setupBindPcFirst.
  ///
  /// In en, this message translates to:
  /// **'Sign in first'**
  String get setupBindPcFirst;

  /// No description provided for @setupNoBoundDevices.
  ///
  /// In en, this message translates to:
  /// **'No registered PCs'**
  String get setupNoBoundDevices;

  /// No description provided for @setupNoRegisteredPcs.
  ///
  /// In en, this message translates to:
  /// **'No PCs have signed in on this account yet. Sign in on Desktop with the same account first.'**
  String get setupNoRegisteredPcs;

  /// No description provided for @setupScanPcCode.
  ///
  /// In en, this message translates to:
  /// **'Scan server QR'**
  String get setupScanPcCode;

  /// No description provided for @setupScanPcCodeHint.
  ///
  /// In en, this message translates to:
  /// **'Scan the QR from Connect on Desktop to connect. Account password login is still required.'**
  String get setupScanPcCodeHint;

  /// No description provided for @setupManualConfiguration.
  ///
  /// In en, this message translates to:
  /// **'Manual setup'**
  String get setupManualConfiguration;

  /// No description provided for @setupSelectPc.
  ///
  /// In en, this message translates to:
  /// **'Select PC'**
  String get setupSelectPc;

  /// No description provided for @setupSelectPcHint.
  ///
  /// In en, this message translates to:
  /// **'Select a signed-in Desktop to enter the app. Scanning only connects the server.'**
  String get setupSelectPcHint;

  /// No description provided for @setupCurrent.
  ///
  /// In en, this message translates to:
  /// **'Current'**
  String get setupCurrent;

  /// No description provided for @setupBound.
  ///
  /// In en, this message translates to:
  /// **'Connected'**
  String get setupBound;

  /// No description provided for @setupSelectOnlinePcFirst.
  ///
  /// In en, this message translates to:
  /// **'Select an online PC before entering the app'**
  String get setupSelectOnlinePcFirst;

  /// No description provided for @setupBindNewPc.
  ///
  /// In en, this message translates to:
  /// **'Scan to connect'**
  String get setupBindNewPc;

  /// No description provided for @pairingScanTitle.
  ///
  /// In en, this message translates to:
  /// **'Scan connect code'**
  String get pairingScanTitle;

  /// No description provided for @pairingScanHint.
  ///
  /// In en, this message translates to:
  /// **'Place the QR code from Connect on Desktop inside the frame'**
  String get pairingScanHint;

  /// No description provided for @pairingTorchOn.
  ///
  /// In en, this message translates to:
  /// **'Turn flashlight on'**
  String get pairingTorchOn;

  /// No description provided for @pairingTorchOff.
  ///
  /// In en, this message translates to:
  /// **'Turn flashlight off'**
  String get pairingTorchOff;

  /// No description provided for @setupWizardServerTitle.
  ///
  /// In en, this message translates to:
  /// **'Configure Supabase'**
  String get setupWizardServerTitle;

  /// No description provided for @setupWizardLoginTitle.
  ///
  /// In en, this message translates to:
  /// **'Register / Sign in'**
  String get setupWizardLoginTitle;

  /// No description provided for @setupWizardBindTitle.
  ///
  /// In en, this message translates to:
  /// **'Discover PC'**
  String get setupWizardBindTitle;

  /// No description provided for @setupWizardSelectTitle.
  ///
  /// In en, this message translates to:
  /// **'Select PC'**
  String get setupWizardSelectTitle;

  /// No description provided for @setupWizardServerSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Enter your Supabase project URL and anon key'**
  String get setupWizardServerSubtitle;

  /// No description provided for @setupWizardLoginSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Sign in and register this phone as a mobile device'**
  String get setupWizardLoginSubtitle;

  /// No description provided for @setupWizardBindSubtitle.
  ///
  /// In en, this message translates to:
  /// **'After sign-in, PCs on the same account appear automatically'**
  String get setupWizardBindSubtitle;

  /// No description provided for @setupWizardSelectSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Select the PC you want to control remotely'**
  String get setupWizardSelectSubtitle;

  /// No description provided for @setupWizardServerShort.
  ///
  /// In en, this message translates to:
  /// **'Supabase'**
  String get setupWizardServerShort;

  /// No description provided for @setupWizardAccountShort.
  ///
  /// In en, this message translates to:
  /// **'Account'**
  String get setupWizardAccountShort;

  /// No description provided for @setupWizardPairShort.
  ///
  /// In en, this message translates to:
  /// **'Discover'**
  String get setupWizardPairShort;

  /// No description provided for @setupStatusServerReachable.
  ///
  /// In en, this message translates to:
  /// **'Supabase reachable'**
  String get setupStatusServerReachable;

  /// No description provided for @setupStatusServerHelp.
  ///
  /// In en, this message translates to:
  /// **'Check the project URL, anon key, and network'**
  String get setupStatusServerHelp;

  /// No description provided for @setupStatusAccountDevice.
  ///
  /// In en, this message translates to:
  /// **'Account and mobile device'**
  String get setupStatusAccountDevice;

  /// No description provided for @setupStatusRegisteringDevice.
  ///
  /// In en, this message translates to:
  /// **'Registering this device...'**
  String get setupStatusRegisteringDevice;

  /// No description provided for @setupStatusLiveChannel.
  ///
  /// In en, this message translates to:
  /// **'Live channel (Realtime)'**
  String get setupStatusLiveChannel;

  /// No description provided for @setupStatusCenterConnected.
  ///
  /// In en, this message translates to:
  /// **'Connected to Supabase'**
  String get setupStatusCenterConnected;

  /// No description provided for @setupSupabaseUrlLabel.
  ///
  /// In en, this message translates to:
  /// **'Supabase URL'**
  String get setupSupabaseUrlLabel;

  /// No description provided for @setupSupabaseUrlHint.
  ///
  /// In en, this message translates to:
  /// **'https://xxxx.supabase.co'**
  String get setupSupabaseUrlHint;

  /// No description provided for @setupAnonKeyLabel.
  ///
  /// In en, this message translates to:
  /// **'Anon key'**
  String get setupAnonKeyLabel;

  /// No description provided for @setupAnonKeyHint.
  ///
  /// In en, this message translates to:
  /// **'Public anon key (not service_role)'**
  String get setupAnonKeyHint;

  /// No description provided for @setupAnonKeyKeep.
  ///
  /// In en, this message translates to:
  /// **'Leave blank to keep the saved anon key'**
  String get setupAnonKeyKeep;

  /// No description provided for @setupStatusConnecting.
  ///
  /// In en, this message translates to:
  /// **'Connecting...'**
  String get setupStatusConnecting;

  /// No description provided for @setupStatusPairPc.
  ///
  /// In en, this message translates to:
  /// **'Discover PC'**
  String get setupStatusPairPc;

  /// No description provided for @setupStatusBoundCount.
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =1{1 paired PC} other{{count} paired PCs}}'**
  String setupStatusBoundCount(int count);

  /// No description provided for @setupStatusPairHint.
  ///
  /// In en, this message translates to:
  /// **'After sign-in, PCs on the same account appear automatically'**
  String get setupStatusPairHint;

  /// No description provided for @setupStatusSelectControlledPc.
  ///
  /// In en, this message translates to:
  /// **'Select PC to control'**
  String get setupStatusSelectControlledPc;

  /// No description provided for @setupStatusCheckingDevice.
  ///
  /// In en, this message translates to:
  /// **'{name} · Checking...'**
  String setupStatusCheckingDevice(Object name);

  /// No description provided for @setupStatusDeviceOnline.
  ///
  /// In en, this message translates to:
  /// **'{name} · Online'**
  String setupStatusDeviceOnline(Object name);

  /// No description provided for @setupStatusDeviceOffline.
  ///
  /// In en, this message translates to:
  /// **'{name} · Offline'**
  String setupStatusDeviceOffline(Object name);

  /// No description provided for @setupStatusDesktopOfflineHelp.
  ///
  /// In en, this message translates to:
  /// **'Desktop is offline. Confirm it is connected to the same Server.'**
  String get setupStatusDesktopOfflineHelp;

  /// No description provided for @setupStatusWebSocketDisconnected.
  ///
  /// In en, this message translates to:
  /// **'WebSocket is disconnected. Sign in again or pull to refresh.'**
  String get setupStatusWebSocketDisconnected;

  /// No description provided for @setupProgressTitle.
  ///
  /// In en, this message translates to:
  /// **'Connection progress'**
  String get setupProgressTitle;

  /// No description provided for @setupConnectedReady.
  ///
  /// In en, this message translates to:
  /// **'Connected. Select a PC to continue.'**
  String get setupConnectedReady;

  /// No description provided for @setupOpenedDevice.
  ///
  /// In en, this message translates to:
  /// **'Opened {name}'**
  String setupOpenedDevice(Object name);

  /// No description provided for @setupBoundDevice.
  ///
  /// In en, this message translates to:
  /// **'Connected {name}'**
  String setupBoundDevice(Object name);

  /// No description provided for @setupSelectedDevice.
  ///
  /// In en, this message translates to:
  /// **'Selected {name}'**
  String setupSelectedDevice(Object name);

  /// No description provided for @setupSelectedDeviceOffline.
  ///
  /// In en, this message translates to:
  /// **'{name} was selected but is currently offline'**
  String setupSelectedDeviceOffline(Object name);

  /// No description provided for @setupDeviceOfflineServerHelp.
  ///
  /// In en, this message translates to:
  /// **'{name} is offline. Confirm Desktop is connected to Server.'**
  String setupDeviceOfflineServerHelp(Object name);

  /// No description provided for @setupBoundDeviceOffline.
  ///
  /// In en, this message translates to:
  /// **'{name} was connected but is currently offline'**
  String setupBoundDeviceOffline(Object name);

  /// No description provided for @setupScanNeedsLogin.
  ///
  /// In en, this message translates to:
  /// **'Server details applied. Sign in with the same account password as Desktop, then select a PC.'**
  String get setupScanNeedsLogin;

  /// No description provided for @setupScanServerConfigured.
  ///
  /// In en, this message translates to:
  /// **'Server configured. Select a PC to control.'**
  String get setupScanServerConfigured;

  /// No description provided for @setupLegacyQr.
  ///
  /// In en, this message translates to:
  /// **'QR is missing server details. Enter the Supabase URL and anon key manually, then sign in.'**
  String get setupLegacyQr;

  /// No description provided for @setupServerReachable.
  ///
  /// In en, this message translates to:
  /// **'Server is reachable'**
  String get setupServerReachable;

  /// No description provided for @setupServerUnreachable.
  ///
  /// In en, this message translates to:
  /// **'Cannot reach the server. Check the address and network.'**
  String get setupServerUnreachable;

  /// No description provided for @setupServerRequired.
  ///
  /// In en, this message translates to:
  /// **'Configure the server first'**
  String get setupServerRequired;

  /// No description provided for @setupLoginSuccess.
  ///
  /// In en, this message translates to:
  /// **'Signed in. Select a PC to control.'**
  String get setupLoginSuccess;

  /// No description provided for @setupReconnectAttempted.
  ///
  /// In en, this message translates to:
  /// **'Tried reconnecting WebSocket'**
  String get setupReconnectAttempted;

  /// No description provided for @setupBoundPcFallback.
  ///
  /// In en, this message translates to:
  /// **'Connected PC'**
  String get setupBoundPcFallback;

  /// No description provided for @composerWorkMode.
  ///
  /// In en, this message translates to:
  /// **'Work mode'**
  String get composerWorkMode;

  /// No description provided for @composerWorkModeSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Choose how this session runs'**
  String get composerWorkModeSubtitle;

  /// No description provided for @composerMode.
  ///
  /// In en, this message translates to:
  /// **'Mode'**
  String get composerMode;

  /// No description provided for @composerBashApproval.
  ///
  /// In en, this message translates to:
  /// **'Bash approval'**
  String get composerBashApproval;

  /// No description provided for @composerBashApprovalSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Control confirmation before commands run'**
  String get composerBashApprovalSubtitle;

  /// No description provided for @bashReviewAlways.
  ///
  /// In en, this message translates to:
  /// **'Request approval'**
  String get bashReviewAlways;

  /// No description provided for @bashReviewAlwaysDescription.
  ///
  /// In en, this message translates to:
  /// **'Always ask before editing files outside the workspace or accessing the internet'**
  String get bashReviewAlwaysDescription;

  /// No description provided for @bashReviewAuto.
  ///
  /// In en, this message translates to:
  /// **'Approve for me'**
  String get bashReviewAuto;

  /// No description provided for @bashReviewAutoDescription.
  ///
  /// In en, this message translates to:
  /// **'Use the approval model; ask you when risk is detected or review fails'**
  String get bashReviewAutoDescription;

  /// No description provided for @bashReviewAllowAll.
  ///
  /// In en, this message translates to:
  /// **'Full access'**
  String get bashReviewAllowAll;

  /// No description provided for @bashReviewAllowAllDescription.
  ///
  /// In en, this message translates to:
  /// **'Unrestricted access to the internet and any file on your computer'**
  String get bashReviewAllowAllDescription;

  /// No description provided for @bashReviewAllowAllConfirm.
  ///
  /// In en, this message translates to:
  /// **'Full access auto-allows internet and local-file actions without asking you each time. Continue?'**
  String get bashReviewAllowAllConfirm;

  /// No description provided for @composerSettings.
  ///
  /// In en, this message translates to:
  /// **'Composer settings'**
  String get composerSettings;

  /// No description provided for @composerUnsupportedImage.
  ///
  /// In en, this message translates to:
  /// **'Only JPEG, PNG, GIF, and WebP images are supported'**
  String get composerUnsupportedImage;

  /// No description provided for @composerImageTooLarge.
  ///
  /// In en, this message translates to:
  /// **'Images must be 20 MB or smaller'**
  String get composerImageTooLarge;

  /// No description provided for @composerOrchestrationSelection.
  ///
  /// In en, this message translates to:
  /// **'Orchestration'**
  String get composerOrchestrationSelection;

  /// No description provided for @activityToolIncomplete.
  ///
  /// In en, this message translates to:
  /// **'Tool incomplete · {text}'**
  String activityToolIncomplete(Object text);

  /// No description provided for @activityReadFiles.
  ///
  /// In en, this message translates to:
  /// **'Read {count} files'**
  String activityReadFiles(Object count);

  /// No description provided for @activityWroteFiles.
  ///
  /// In en, this message translates to:
  /// **'Wrote {count} files'**
  String activityWroteFiles(Object count);

  /// No description provided for @activityEditedFiles.
  ///
  /// In en, this message translates to:
  /// **'Edited {count} files'**
  String activityEditedFiles(Object count);

  /// No description provided for @activitySearchedCode.
  ///
  /// In en, this message translates to:
  /// **'Searched code'**
  String get activitySearchedCode;

  /// No description provided for @activitySearchedCodeTimes.
  ///
  /// In en, this message translates to:
  /// **'Searched code {count} times'**
  String activitySearchedCodeTimes(Object count);

  /// No description provided for @activityRanCommands.
  ///
  /// In en, this message translates to:
  /// **'Ran {count} commands'**
  String activityRanCommands(Object count);

  /// No description provided for @activityCalledSubagents.
  ///
  /// In en, this message translates to:
  /// **'Called {count} subagents'**
  String activityCalledSubagents(Object count);

  /// No description provided for @activityRanTools.
  ///
  /// In en, this message translates to:
  /// **'Ran {count} tools'**
  String activityRanTools(Object count);

  /// No description provided for @activityDetailCreateTask.
  ///
  /// In en, this message translates to:
  /// **'Created task{suffix}'**
  String activityDetailCreateTask(Object suffix);

  /// No description provided for @activityDetailUpdateTask.
  ///
  /// In en, this message translates to:
  /// **'Updated task{suffix}'**
  String activityDetailUpdateTask(Object suffix);

  /// No description provided for @activityDetailWrite.
  ///
  /// In en, this message translates to:
  /// **'Wrote{suffix}'**
  String activityDetailWrite(Object suffix);

  /// No description provided for @activityDetailEdit.
  ///
  /// In en, this message translates to:
  /// **'Edited{suffix}'**
  String activityDetailEdit(Object suffix);

  /// No description provided for @activityDetailRead.
  ///
  /// In en, this message translates to:
  /// **'Read{suffix}'**
  String activityDetailRead(Object suffix);

  /// No description provided for @activityDetailSearch.
  ///
  /// In en, this message translates to:
  /// **'Searched{suffix}'**
  String activityDetailSearch(Object suffix);

  /// No description provided for @activityDetailWebSearch.
  ///
  /// In en, this message translates to:
  /// **'Web search{suffix}'**
  String activityDetailWebSearch(Object suffix);

  /// No description provided for @activityDetailAgent.
  ///
  /// In en, this message translates to:
  /// **'Called subagent{suffix}'**
  String activityDetailAgent(Object suffix);

  /// No description provided for @activityDetailTool.
  ///
  /// In en, this message translates to:
  /// **'Executed{suffix}'**
  String activityDetailTool(Object suffix);

  /// No description provided for @activityWebSearches.
  ///
  /// In en, this message translates to:
  /// **'Searched the web {count} times'**
  String activityWebSearches(Object count);

  /// No description provided for @activitySummaryWeb.
  ///
  /// In en, this message translates to:
  /// **'Used the web {count} times'**
  String activitySummaryWeb(Object count);

  /// No description provided for @activitySummaryCreatedTasks.
  ///
  /// In en, this message translates to:
  /// **'Created {count} tasks'**
  String activitySummaryCreatedTasks(Object count);

  /// No description provided for @activitySummaryUpdatedTasks.
  ///
  /// In en, this message translates to:
  /// **'Updated tasks {count} times'**
  String activitySummaryUpdatedTasks(Object count);

  /// No description provided for @activitySummarySkills.
  ///
  /// In en, this message translates to:
  /// **'Read {count} skills'**
  String activitySummarySkills(Object count);

  /// No description provided for @activitySummaryMcpTools.
  ///
  /// In en, this message translates to:
  /// **'Called {count} MCP tools'**
  String activitySummaryMcpTools(Object count);

  /// No description provided for @activitySummaryImages.
  ///
  /// In en, this message translates to:
  /// **'Processed {count} images'**
  String activitySummaryImages(Object count);

  /// No description provided for @activitySummaryBrowser.
  ///
  /// In en, this message translates to:
  /// **'Used the browser {count} times'**
  String activitySummaryBrowser(Object count);

  /// No description provided for @activitySummaryComputerUse.
  ///
  /// In en, this message translates to:
  /// **'Used computer use {count} times'**
  String activitySummaryComputerUse(Object count);

  /// No description provided for @activityRunningRead.
  ///
  /// In en, this message translates to:
  /// **'Reading{suffix}'**
  String activityRunningRead(Object suffix);

  /// No description provided for @activityRunningWrite.
  ///
  /// In en, this message translates to:
  /// **'Writing{suffix}'**
  String activityRunningWrite(Object suffix);

  /// No description provided for @activityRunningEdit.
  ///
  /// In en, this message translates to:
  /// **'Editing{suffix}'**
  String activityRunningEdit(Object suffix);

  /// No description provided for @activityRunningSearch.
  ///
  /// In en, this message translates to:
  /// **'Searching{suffix}'**
  String activityRunningSearch(Object suffix);

  /// No description provided for @activityRunningWebSearch.
  ///
  /// In en, this message translates to:
  /// **'Searching the web{suffix}'**
  String activityRunningWebSearch(Object suffix);

  /// No description provided for @activityRunningWebFetch.
  ///
  /// In en, this message translates to:
  /// **'Fetching{suffix}'**
  String activityRunningWebFetch(Object suffix);

  /// No description provided for @activityRunningCommand.
  ///
  /// In en, this message translates to:
  /// **'Running{suffix}'**
  String activityRunningCommand(Object suffix);

  /// No description provided for @activityRunningAgent.
  ///
  /// In en, this message translates to:
  /// **'Calling subagent{suffix}'**
  String activityRunningAgent(Object suffix);

  /// No description provided for @activityRunningTool.
  ///
  /// In en, this message translates to:
  /// **'Executing{suffix}'**
  String activityRunningTool(Object suffix);

  /// No description provided for @activityRunningSkill.
  ///
  /// In en, this message translates to:
  /// **'Reading skill{suffix}'**
  String activityRunningSkill(Object suffix);

  /// No description provided for @activityRunningMcp.
  ///
  /// In en, this message translates to:
  /// **'Calling MCP{suffix}'**
  String activityRunningMcp(Object suffix);

  /// No description provided for @activityRunningMcpSearch.
  ///
  /// In en, this message translates to:
  /// **'Searching MCP tools'**
  String get activityRunningMcpSearch;

  /// No description provided for @activityRunningImageCreate.
  ///
  /// In en, this message translates to:
  /// **'Generating image'**
  String get activityRunningImageCreate;

  /// No description provided for @activityRunningComputerUse.
  ///
  /// In en, this message translates to:
  /// **'Controlling computer'**
  String get activityRunningComputerUse;

  /// No description provided for @activityRunningBrowserOpen.
  ///
  /// In en, this message translates to:
  /// **'Opening{suffix}'**
  String activityRunningBrowserOpen(Object suffix);

  /// No description provided for @activityRunningTaskCreate.
  ///
  /// In en, this message translates to:
  /// **'Creating task{suffix}'**
  String activityRunningTaskCreate(Object suffix);

  /// No description provided for @activityRunningTaskUpdate.
  ///
  /// In en, this message translates to:
  /// **'Updating task{suffix}'**
  String activityRunningTaskUpdate(Object suffix);

  /// No description provided for @activityDoneRead.
  ///
  /// In en, this message translates to:
  /// **'Read{suffix}'**
  String activityDoneRead(Object suffix);

  /// No description provided for @activityDoneReadFallback.
  ///
  /// In en, this message translates to:
  /// **'Read a file'**
  String get activityDoneReadFallback;

  /// No description provided for @activityDoneWrite.
  ///
  /// In en, this message translates to:
  /// **'Wrote{suffix}'**
  String activityDoneWrite(Object suffix);

  /// No description provided for @activityDoneWriteFallback.
  ///
  /// In en, this message translates to:
  /// **'Wrote a file'**
  String get activityDoneWriteFallback;

  /// No description provided for @activityDoneEdit.
  ///
  /// In en, this message translates to:
  /// **'Edited{suffix}'**
  String activityDoneEdit(Object suffix);

  /// No description provided for @activityDoneEditFallback.
  ///
  /// In en, this message translates to:
  /// **'Edited a file'**
  String get activityDoneEditFallback;

  /// No description provided for @activityDoneSearch.
  ///
  /// In en, this message translates to:
  /// **'Searched{suffix}'**
  String activityDoneSearch(Object suffix);

  /// No description provided for @activityDoneSearchFallback.
  ///
  /// In en, this message translates to:
  /// **'Searched code'**
  String get activityDoneSearchFallback;

  /// No description provided for @activityDoneWebSearch.
  ///
  /// In en, this message translates to:
  /// **'Searched the web{suffix}'**
  String activityDoneWebSearch(Object suffix);

  /// No description provided for @activityDoneWebSearchFallback.
  ///
  /// In en, this message translates to:
  /// **'Searched the web'**
  String get activityDoneWebSearchFallback;

  /// No description provided for @activityDoneWebFetch.
  ///
  /// In en, this message translates to:
  /// **'Fetched{suffix}'**
  String activityDoneWebFetch(Object suffix);

  /// No description provided for @activityDoneWebFetchFallback.
  ///
  /// In en, this message translates to:
  /// **'Fetched a page'**
  String get activityDoneWebFetchFallback;

  /// No description provided for @activityDoneCommand.
  ///
  /// In en, this message translates to:
  /// **'Ran{suffix}'**
  String activityDoneCommand(Object suffix);

  /// No description provided for @activityDoneCommandFallback.
  ///
  /// In en, this message translates to:
  /// **'Ran a command'**
  String get activityDoneCommandFallback;

  /// No description provided for @activityDoneAgent.
  ///
  /// In en, this message translates to:
  /// **'Called subagent{suffix}'**
  String activityDoneAgent(Object suffix);

  /// No description provided for @activityDoneAgentFallback.
  ///
  /// In en, this message translates to:
  /// **'Called a subagent'**
  String get activityDoneAgentFallback;

  /// No description provided for @activityDoneTaskCreate.
  ///
  /// In en, this message translates to:
  /// **'Created task{suffix}'**
  String activityDoneTaskCreate(Object suffix);

  /// No description provided for @activityDoneTaskCreateFallback.
  ///
  /// In en, this message translates to:
  /// **'Created a task'**
  String get activityDoneTaskCreateFallback;

  /// No description provided for @activityDoneTaskUpdate.
  ///
  /// In en, this message translates to:
  /// **'Updated task{suffix}'**
  String activityDoneTaskUpdate(Object suffix);

  /// No description provided for @activityDoneTaskUpdateFallback.
  ///
  /// In en, this message translates to:
  /// **'Updated a task'**
  String get activityDoneTaskUpdateFallback;

  /// No description provided for @activityDoneSkill.
  ///
  /// In en, this message translates to:
  /// **'Read skill{suffix}'**
  String activityDoneSkill(Object suffix);

  /// No description provided for @activityDoneSkillFallback.
  ///
  /// In en, this message translates to:
  /// **'Read a skill'**
  String get activityDoneSkillFallback;

  /// No description provided for @activityDoneMcp.
  ///
  /// In en, this message translates to:
  /// **'Called MCP{suffix}'**
  String activityDoneMcp(Object suffix);

  /// No description provided for @activityDoneMcpFallback.
  ///
  /// In en, this message translates to:
  /// **'Called an MCP tool'**
  String get activityDoneMcpFallback;

  /// No description provided for @activityDoneMcpSearch.
  ///
  /// In en, this message translates to:
  /// **'Searched MCP tools'**
  String get activityDoneMcpSearch;

  /// No description provided for @activityDoneTool.
  ///
  /// In en, this message translates to:
  /// **'Executed{suffix}'**
  String activityDoneTool(Object suffix);

  /// No description provided for @activityDoneToolFallback.
  ///
  /// In en, this message translates to:
  /// **'Executed a tool'**
  String get activityDoneToolFallback;

  /// No description provided for @activityDoneImageCreate.
  ///
  /// In en, this message translates to:
  /// **'Generated an image'**
  String get activityDoneImageCreate;

  /// No description provided for @activityDoneComputerUse.
  ///
  /// In en, this message translates to:
  /// **'Controlled the computer'**
  String get activityDoneComputerUse;

  /// No description provided for @activityDoneBrowserOpen.
  ///
  /// In en, this message translates to:
  /// **'Opened{suffix}'**
  String activityDoneBrowserOpen(Object suffix);

  /// No description provided for @activityNamedFinalizePlan.
  ///
  /// In en, this message translates to:
  /// **'Submit plan'**
  String get activityNamedFinalizePlan;

  /// No description provided for @activityNamedCreateImage.
  ///
  /// In en, this message translates to:
  /// **'Generate image'**
  String get activityNamedCreateImage;

  /// No description provided for @activityNamedComputerUse.
  ///
  /// In en, this message translates to:
  /// **'Computer use'**
  String get activityNamedComputerUse;

  /// No description provided for @activityNamedViewImage.
  ///
  /// In en, this message translates to:
  /// **'View image'**
  String get activityNamedViewImage;

  /// No description provided for @activityNamedDisplayImage.
  ///
  /// In en, this message translates to:
  /// **'Display image'**
  String get activityNamedDisplayImage;

  /// No description provided for @activityNamedPublishHtml.
  ///
  /// In en, this message translates to:
  /// **'Publish HTML page'**
  String get activityNamedPublishHtml;

  /// No description provided for @activityNamedAgentBrowserOpen.
  ///
  /// In en, this message translates to:
  /// **'Open page'**
  String get activityNamedAgentBrowserOpen;

  /// No description provided for @activityNamedAgentBrowserSnapshot.
  ///
  /// In en, this message translates to:
  /// **'Snapshot'**
  String get activityNamedAgentBrowserSnapshot;

  /// No description provided for @activityNamedAgentBrowserClick.
  ///
  /// In en, this message translates to:
  /// **'Browser click'**
  String get activityNamedAgentBrowserClick;

  /// No description provided for @activityNamedAgentBrowserFill.
  ///
  /// In en, this message translates to:
  /// **'Fill form'**
  String get activityNamedAgentBrowserFill;

  /// No description provided for @activityNamedAgentBrowserScreenshot.
  ///
  /// In en, this message translates to:
  /// **'Screenshot'**
  String get activityNamedAgentBrowserScreenshot;

  /// No description provided for @activityNamedAgentBrowserGetUrl.
  ///
  /// In en, this message translates to:
  /// **'Read URL'**
  String get activityNamedAgentBrowserGetUrl;

  /// No description provided for @activityNamedAgentBrowserTabList.
  ///
  /// In en, this message translates to:
  /// **'List tabs'**
  String get activityNamedAgentBrowserTabList;

  /// No description provided for @activityNamedAgentBrowserTabNew.
  ///
  /// In en, this message translates to:
  /// **'New tab'**
  String get activityNamedAgentBrowserTabNew;

  /// No description provided for @activityNamedAgentBrowserTabSwitch.
  ///
  /// In en, this message translates to:
  /// **'Switch tab'**
  String get activityNamedAgentBrowserTabSwitch;

  /// No description provided for @activityNamedBrowser.
  ///
  /// In en, this message translates to:
  /// **'Browser action'**
  String get activityNamedBrowser;

  /// No description provided for @activityNamedWebSearch.
  ///
  /// In en, this message translates to:
  /// **'Web search'**
  String get activityNamedWebSearch;

  /// No description provided for @activityNamedWebFetch.
  ///
  /// In en, this message translates to:
  /// **'Fetch page'**
  String get activityNamedWebFetch;

  /// No description provided for @activityCreatingTask.
  ///
  /// In en, this message translates to:
  /// **'Creating task'**
  String get activityCreatingTask;

  /// No description provided for @activityCreatedTask.
  ///
  /// In en, this message translates to:
  /// **'Created task'**
  String get activityCreatedTask;

  /// No description provided for @activityUpdatingTask.
  ///
  /// In en, this message translates to:
  /// **'Updating task'**
  String get activityUpdatingTask;

  /// No description provided for @activityUpdatedTask.
  ///
  /// In en, this message translates to:
  /// **'Updated task'**
  String get activityUpdatedTask;

  /// No description provided for @activityWriting.
  ///
  /// In en, this message translates to:
  /// **'Writing'**
  String get activityWriting;

  /// No description provided for @activityWrote.
  ///
  /// In en, this message translates to:
  /// **'Wrote'**
  String get activityWrote;

  /// No description provided for @activityEditing.
  ///
  /// In en, this message translates to:
  /// **'Editing'**
  String get activityEditing;

  /// No description provided for @activityEdited.
  ///
  /// In en, this message translates to:
  /// **'Edited'**
  String get activityEdited;

  /// No description provided for @activityEditedFile.
  ///
  /// In en, this message translates to:
  /// **'Edited a file'**
  String get activityEditedFile;

  /// No description provided for @activityReading.
  ///
  /// In en, this message translates to:
  /// **'Reading'**
  String get activityReading;

  /// No description provided for @activityRead.
  ///
  /// In en, this message translates to:
  /// **'Read'**
  String get activityRead;

  /// No description provided for @activitySearching.
  ///
  /// In en, this message translates to:
  /// **'Searching'**
  String get activitySearching;

  /// No description provided for @activitySearched.
  ///
  /// In en, this message translates to:
  /// **'Searched'**
  String get activitySearched;

  /// No description provided for @activityRunning.
  ///
  /// In en, this message translates to:
  /// **'Running'**
  String get activityRunning;

  /// No description provided for @activityRan.
  ///
  /// In en, this message translates to:
  /// **'Ran'**
  String get activityRan;

  /// No description provided for @activityRanCommand.
  ///
  /// In en, this message translates to:
  /// **'Ran a command'**
  String get activityRanCommand;

  /// No description provided for @activityViewImages.
  ///
  /// In en, this message translates to:
  /// **'View {count} images'**
  String activityViewImages(Object count);

  /// No description provided for @activityImageViewViewing.
  ///
  /// In en, this message translates to:
  /// **'Viewing 1 image'**
  String get activityImageViewViewing;

  /// No description provided for @activityImageViewViewed.
  ///
  /// In en, this message translates to:
  /// **'Viewed 1 image'**
  String get activityImageViewViewed;

  /// No description provided for @activityImageDisplayViewing.
  ///
  /// In en, this message translates to:
  /// **'Displaying 1 image'**
  String get activityImageDisplayViewing;

  /// No description provided for @activityImageDisplayViewed.
  ///
  /// In en, this message translates to:
  /// **'Displayed 1 image'**
  String get activityImageDisplayViewed;

  /// No description provided for @activityImageDisplayErrorReadFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to load the displayed image.'**
  String get activityImageDisplayErrorReadFailed;

  /// No description provided for @activityImageDisplayTapToRetry.
  ///
  /// In en, this message translates to:
  /// **'Tap to retry'**
  String get activityImageDisplayTapToRetry;

  /// No description provided for @activityImageDisplayLoadingPercent.
  ///
  /// In en, this message translates to:
  /// **'{percent}%'**
  String activityImageDisplayLoadingPercent(int percent);

  /// No description provided for @taskImageDisplayHistory.
  ///
  /// In en, this message translates to:
  /// **'Displayed images'**
  String get taskImageDisplayHistory;

  /// No description provided for @taskImageGenerationHistory.
  ///
  /// In en, this message translates to:
  /// **'Drawing tasks'**
  String get taskImageGenerationHistory;

  /// No description provided for @taskHtmlHostHistory.
  ///
  /// In en, this message translates to:
  /// **'HTML pages'**
  String get taskHtmlHostHistory;

  /// No description provided for @taskImageGenerationEmpty.
  ///
  /// In en, this message translates to:
  /// **'No drawing tasks yet'**
  String get taskImageGenerationEmpty;

  /// No description provided for @taskHtmlHostEmpty.
  ///
  /// In en, this message translates to:
  /// **'No HTML pages yet'**
  String get taskHtmlHostEmpty;

  /// No description provided for @taskHtmlHostOpenFailed.
  ///
  /// In en, this message translates to:
  /// **'Could not open the page'**
  String get taskHtmlHostOpenFailed;

  /// No description provided for @taskImageGenerationStatusRunning.
  ///
  /// In en, this message translates to:
  /// **'In progress'**
  String get taskImageGenerationStatusRunning;

  /// No description provided for @taskImageGenerationStatusCompleted.
  ///
  /// In en, this message translates to:
  /// **'Completed'**
  String get taskImageGenerationStatusCompleted;

  /// No description provided for @taskImageGenerationStatusFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed'**
  String get taskImageGenerationStatusFailed;

  /// No description provided for @taskHtmlHostStatusCompleted.
  ///
  /// In en, this message translates to:
  /// **'Completed'**
  String get taskHtmlHostStatusCompleted;

  /// No description provided for @taskHtmlHostStatusFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed'**
  String get taskHtmlHostStatusFailed;

  /// No description provided for @activityHtmlHostPublishing.
  ///
  /// In en, this message translates to:
  /// **'Publishing HTML page'**
  String get activityHtmlHostPublishing;

  /// No description provided for @activityHtmlHostPublished.
  ///
  /// In en, this message translates to:
  /// **'Published HTML page'**
  String get activityHtmlHostPublished;

  /// No description provided for @activityImageViewLoading.
  ///
  /// In en, this message translates to:
  /// **'Reading local image…'**
  String get activityImageViewLoading;

  /// No description provided for @activityImageViewLocalPath.
  ///
  /// In en, this message translates to:
  /// **'Local path'**
  String get activityImageViewLocalPath;

  /// No description provided for @activityImageViewPreviewAlt.
  ///
  /// In en, this message translates to:
  /// **'Viewed image: {name}'**
  String activityImageViewPreviewAlt(String name);

  /// No description provided for @activityImageViewOpen.
  ///
  /// In en, this message translates to:
  /// **'Enlarge {name}'**
  String activityImageViewOpen(String name);

  /// No description provided for @activityImageViewErrorInvalidPath.
  ///
  /// In en, this message translates to:
  /// **'The image path is not a valid absolute path.'**
  String get activityImageViewErrorInvalidPath;

  /// No description provided for @activityImageViewErrorNotFound.
  ///
  /// In en, this message translates to:
  /// **'The file does not exist, or the path belongs to a remote execution environment that Desktop cannot read directly.'**
  String get activityImageViewErrorNotFound;

  /// No description provided for @activityImageViewErrorSymbolicLink.
  ///
  /// In en, this message translates to:
  /// **'Image previews do not follow symbolic links because the target would be ambiguous.'**
  String get activityImageViewErrorSymbolicLink;

  /// No description provided for @activityImageViewErrorNotFile.
  ///
  /// In en, this message translates to:
  /// **'The path does not point to a regular file.'**
  String get activityImageViewErrorNotFile;

  /// No description provided for @activityImageViewErrorTooLarge.
  ///
  /// In en, this message translates to:
  /// **'The image exceeds the 20 MB Feed preview limit.'**
  String get activityImageViewErrorTooLarge;

  /// No description provided for @activityImageViewErrorUnsupportedType.
  ///
  /// In en, this message translates to:
  /// **'The file content is not a supported PNG, JPEG, GIF, or WebP image.'**
  String get activityImageViewErrorUnsupportedType;

  /// No description provided for @activityImageViewErrorBridgeUnavailable.
  ///
  /// In en, this message translates to:
  /// **'The Desktop image reader is unavailable.'**
  String get activityImageViewErrorBridgeUnavailable;

  /// No description provided for @activityImageViewErrorReadFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to read the image.'**
  String get activityImageViewErrorReadFailed;

  /// No description provided for @activityCallingSubagent.
  ///
  /// In en, this message translates to:
  /// **'Calling subagent'**
  String get activityCallingSubagent;

  /// No description provided for @activityCalledSubagent.
  ///
  /// In en, this message translates to:
  /// **'Called subagent'**
  String get activityCalledSubagent;

  /// No description provided for @activityExecuting.
  ///
  /// In en, this message translates to:
  /// **'Executing'**
  String get activityExecuting;

  /// No description provided for @activityExecuted.
  ///
  /// In en, this message translates to:
  /// **'Executed'**
  String get activityExecuted;

  /// No description provided for @activityListPair.
  ///
  /// In en, this message translates to:
  /// **'{first} and {second}'**
  String activityListPair(Object first, Object second);

  /// No description provided for @activityListEnd.
  ///
  /// In en, this message translates to:
  /// **'{head}, and {last}'**
  String activityListEnd(Object head, Object last);

  /// No description provided for @activityJoinSeparator.
  ///
  /// In en, this message translates to:
  /// **', '**
  String get activityJoinSeparator;

  /// No description provided for @activityProcessing.
  ///
  /// In en, this message translates to:
  /// **'Processing'**
  String get activityProcessing;

  /// No description provided for @activityProcessed.
  ///
  /// In en, this message translates to:
  /// **'Processed'**
  String get activityProcessed;

  /// No description provided for @activityStoppedByYou.
  ///
  /// In en, this message translates to:
  /// **'You stopped it'**
  String get activityStoppedByYou;

  /// No description provided for @activityStoppedByYouAfter.
  ///
  /// In en, this message translates to:
  /// **'You stopped it after {duration}'**
  String activityStoppedByYouAfter(String duration);

  /// No description provided for @activityStoppedUnexpectedly.
  ///
  /// In en, this message translates to:
  /// **'Run stopped'**
  String get activityStoppedUnexpectedly;

  /// No description provided for @activityStoppedUnexpectedlyAfter.
  ///
  /// In en, this message translates to:
  /// **'Run stopped after {duration}'**
  String activityStoppedUnexpectedlyAfter(String duration);

  /// No description provided for @activityExecutionProcess.
  ///
  /// In en, this message translates to:
  /// **'Execution process'**
  String get activityExecutionProcess;

  /// No description provided for @activityExecutionResult.
  ///
  /// In en, this message translates to:
  /// **'Execution result'**
  String get activityExecutionResult;

  /// No description provided for @activityFinalOutput.
  ///
  /// In en, this message translates to:
  /// **'Final output'**
  String get activityFinalOutput;

  /// No description provided for @activityExpandFull.
  ///
  /// In en, this message translates to:
  /// **'Show all'**
  String get activityExpandFull;

  /// No description provided for @activityCopyMessage.
  ///
  /// In en, this message translates to:
  /// **'Copy message'**
  String get activityCopyMessage;

  /// No description provided for @activitySpeakMessage.
  ///
  /// In en, this message translates to:
  /// **'Read aloud'**
  String get activitySpeakMessage;

  /// No description provided for @activityStopSpeaking.
  ///
  /// In en, this message translates to:
  /// **'Stop reading'**
  String get activityStopSpeaking;

  /// No description provided for @ttsUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Text-to-speech is unavailable on this device'**
  String get ttsUnavailable;

  /// No description provided for @activityMessageCopied.
  ///
  /// In en, this message translates to:
  /// **'Message copied'**
  String get activityMessageCopied;

  /// No description provided for @activityClarificationAnswer.
  ///
  /// In en, this message translates to:
  /// **'Question responses'**
  String get activityClarificationAnswer;

  /// No description provided for @activityNoneSelected.
  ///
  /// In en, this message translates to:
  /// **'(Not selected)'**
  String get activityNoneSelected;

  /// No description provided for @activityThinking.
  ///
  /// In en, this message translates to:
  /// **'Thinking'**
  String get activityThinking;

  /// No description provided for @activityDeepThinkingDone.
  ///
  /// In en, this message translates to:
  /// **'Thought'**
  String get activityDeepThinkingDone;

  /// No description provided for @activityRunFailed.
  ///
  /// In en, this message translates to:
  /// **'Run failed{suffix}'**
  String activityRunFailed(Object suffix);

  /// No description provided for @activityRunningSuffix.
  ///
  /// In en, this message translates to:
  /// **'Running{suffix}'**
  String activityRunningSuffix(Object suffix);

  /// No description provided for @activityRanSuffix.
  ///
  /// In en, this message translates to:
  /// **'Ran{suffix}'**
  String activityRanSuffix(Object suffix);

  /// No description provided for @activityFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed'**
  String get activityFailed;

  /// No description provided for @activitySubagentTask.
  ///
  /// In en, this message translates to:
  /// **'{title} subagent task'**
  String activitySubagentTask(Object title);

  /// No description provided for @activityTaskGoal.
  ///
  /// In en, this message translates to:
  /// **'Task goal'**
  String get activityTaskGoal;

  /// No description provided for @activityWaitingMission.
  ///
  /// In en, this message translates to:
  /// **'Waiting for task instructions...'**
  String get activityWaitingMission;

  /// No description provided for @activityWaitingEvents.
  ///
  /// In en, this message translates to:
  /// **'Waiting for execution events...'**
  String get activityWaitingEvents;

  /// No description provided for @activityWorking.
  ///
  /// In en, this message translates to:
  /// **'Working'**
  String get activityWorking;

  /// No description provided for @activityCompressingContext.
  ///
  /// In en, this message translates to:
  /// **'Compressing context automatically'**
  String get activityCompressingContext;

  /// No description provided for @activityContextCompressed.
  ///
  /// In en, this message translates to:
  /// **'Context compressed automatically'**
  String get activityContextCompressed;

  /// No description provided for @activityContextCompressionFailed.
  ///
  /// In en, this message translates to:
  /// **'Context compression failed'**
  String get activityContextCompressionFailed;

  /// No description provided for @activityContextCompressionPaused.
  ///
  /// In en, this message translates to:
  /// **'Automatic context compression paused'**
  String get activityContextCompressionPaused;

  /// No description provided for @activityWebSearch.
  ///
  /// In en, this message translates to:
  /// **'Web search'**
  String get activityWebSearch;

  /// No description provided for @activityWebSearchFetch.
  ///
  /// In en, this message translates to:
  /// **'Fetch page'**
  String get activityWebSearchFetch;

  /// No description provided for @activityWebSearchSearching.
  ///
  /// In en, this message translates to:
  /// **'Searching…'**
  String get activityWebSearchSearching;

  /// No description provided for @activityWebSearchFetching.
  ///
  /// In en, this message translates to:
  /// **'Fetching…'**
  String get activityWebSearchFetching;

  /// No description provided for @activityWebSearchFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed'**
  String get activityWebSearchFailed;

  /// No description provided for @activityWebSearchCompleted.
  ///
  /// In en, this message translates to:
  /// **'Completed'**
  String get activityWebSearchCompleted;

  /// No description provided for @activityWebSearchQuery.
  ///
  /// In en, this message translates to:
  /// **'Query'**
  String get activityWebSearchQuery;

  /// No description provided for @activityWebSearchStatus.
  ///
  /// In en, this message translates to:
  /// **'Status'**
  String get activityWebSearchStatus;

  /// No description provided for @activityWebSearchAction.
  ///
  /// In en, this message translates to:
  /// **'Action'**
  String get activityWebSearchAction;

  /// No description provided for @activityWebSearchPattern.
  ///
  /// In en, this message translates to:
  /// **'Pattern'**
  String get activityWebSearchPattern;

  /// No description provided for @activityWebSearchQueries.
  ///
  /// In en, this message translates to:
  /// **'Queries'**
  String get activityWebSearchQueries;

  /// No description provided for @activityWebSearchDuration.
  ///
  /// In en, this message translates to:
  /// **'Duration'**
  String get activityWebSearchDuration;

  /// No description provided for @activityWebSearchOpenPage.
  ///
  /// In en, this message translates to:
  /// **'Open page'**
  String get activityWebSearchOpenPage;

  /// No description provided for @activityWebSearchFindInPage.
  ///
  /// In en, this message translates to:
  /// **'Find in page'**
  String get activityWebSearchFindInPage;

  /// No description provided for @activityPromptCacheDrop.
  ///
  /// In en, this message translates to:
  /// **'Prompt cache hit rate dropped significantly'**
  String get activityPromptCacheDrop;

  /// No description provided for @activityPreparingRetry.
  ///
  /// In en, this message translates to:
  /// **'Preparing to retry'**
  String get activityPreparingRetry;

  /// No description provided for @activityRunDiagnostics.
  ///
  /// In en, this message translates to:
  /// **'Run diagnostics'**
  String get activityRunDiagnostics;

  /// No description provided for @activityAllowOutsideWorkspace.
  ///
  /// In en, this message translates to:
  /// **'Allow {tool} outside the workspace?'**
  String activityAllowOutsideWorkspace(Object tool);

  /// No description provided for @activityToolPermissionRequired.
  ///
  /// In en, this message translates to:
  /// **'Tool permission required'**
  String get activityToolPermissionRequired;

  /// No description provided for @activityReadSkill.
  ///
  /// In en, this message translates to:
  /// **'Read skill'**
  String get activityReadSkill;

  /// No description provided for @activityStartSubagent.
  ///
  /// In en, this message translates to:
  /// **'Start subagent'**
  String get activityStartSubagent;

  /// No description provided for @activityConnectionFailed.
  ///
  /// In en, this message translates to:
  /// **'Connection failed'**
  String get activityConnectionFailed;

  /// No description provided for @activityConnectionFailedHttp.
  ///
  /// In en, this message translates to:
  /// **'Connection failed · HTTP {status}'**
  String activityConnectionFailedHttp(Object status);

  /// No description provided for @activityReconnectAttempt.
  ///
  /// In en, this message translates to:
  /// **'Reconnect {attempt}/{max}'**
  String activityReconnectAttempt(Object attempt, Object max);

  /// No description provided for @roleVision.
  ///
  /// In en, this message translates to:
  /// **'Vision'**
  String get roleVision;

  /// No description provided for @roleExplore.
  ///
  /// In en, this message translates to:
  /// **'Explore'**
  String get roleExplore;

  /// No description provided for @roleArchitect.
  ///
  /// In en, this message translates to:
  /// **'Architect'**
  String get roleArchitect;

  /// No description provided for @roleCoder.
  ///
  /// In en, this message translates to:
  /// **'Coder'**
  String get roleCoder;

  /// No description provided for @roleReviewer.
  ///
  /// In en, this message translates to:
  /// **'Reviewer'**
  String get roleReviewer;

  /// No description provided for @roleTester.
  ///
  /// In en, this message translates to:
  /// **'Tester'**
  String get roleTester;

  /// No description provided for @toolRead.
  ///
  /// In en, this message translates to:
  /// **'Read'**
  String get toolRead;

  /// No description provided for @toolWrite.
  ///
  /// In en, this message translates to:
  /// **'Write'**
  String get toolWrite;

  /// No description provided for @toolEdit.
  ///
  /// In en, this message translates to:
  /// **'Edit'**
  String get toolEdit;

  /// No description provided for @toolSearch.
  ///
  /// In en, this message translates to:
  /// **'Search'**
  String get toolSearch;

  /// No description provided for @toolFind.
  ///
  /// In en, this message translates to:
  /// **'Find'**
  String get toolFind;

  /// No description provided for @toolRunCommand.
  ///
  /// In en, this message translates to:
  /// **'Run command'**
  String get toolRunCommand;

  /// No description provided for @toolCall.
  ///
  /// In en, this message translates to:
  /// **'Call'**
  String get toolCall;

  /// No description provided for @toolUpdateTasks.
  ///
  /// In en, this message translates to:
  /// **'Update tasks'**
  String get toolUpdateTasks;

  /// No description provided for @toolCreateTask.
  ///
  /// In en, this message translates to:
  /// **'Create task'**
  String get toolCreateTask;

  /// No description provided for @toolListTasks.
  ///
  /// In en, this message translates to:
  /// **'List tasks'**
  String get toolListTasks;

  /// No description provided for @toolReadTaskOutput.
  ///
  /// In en, this message translates to:
  /// **'Read task output'**
  String get toolReadTaskOutput;

  /// No description provided for @toolClarify.
  ///
  /// In en, this message translates to:
  /// **'Clarify'**
  String get toolClarify;

  /// No description provided for @toolWebSearch.
  ///
  /// In en, this message translates to:
  /// **'Search the web'**
  String get toolWebSearch;

  /// No description provided for @toolWebFetch.
  ///
  /// In en, this message translates to:
  /// **'Fetch web page'**
  String get toolWebFetch;

  /// No description provided for @threadTasks.
  ///
  /// In en, this message translates to:
  /// **'Task progress'**
  String get threadTasks;

  /// No description provided for @threadAutoRead.
  ///
  /// In en, this message translates to:
  /// **'Auto read-aloud'**
  String get threadAutoRead;

  /// No description provided for @threadPlan.
  ///
  /// In en, this message translates to:
  /// **'Plan'**
  String get threadPlan;

  /// No description provided for @threadPlanEmpty.
  ///
  /// In en, this message translates to:
  /// **'No plan is available'**
  String get threadPlanEmpty;

  /// No description provided for @threadCodeReview.
  ///
  /// In en, this message translates to:
  /// **'Code review'**
  String get threadCodeReview;

  /// No description provided for @threadCommitPush.
  ///
  /// In en, this message translates to:
  /// **'Commit and push'**
  String get threadCommitPush;

  /// No description provided for @threadStartFirstForTasks.
  ///
  /// In en, this message translates to:
  /// **'Start the session before viewing task progress'**
  String get threadStartFirstForTasks;

  /// No description provided for @threadSelectOrchestrationFirst.
  ///
  /// In en, this message translates to:
  /// **'Select an orchestration in Composer settings first'**
  String get threadSelectOrchestrationFirst;

  /// No description provided for @threadLoadingCommit.
  ///
  /// In en, this message translates to:
  /// **'Loading commit information...'**
  String get threadLoadingCommit;

  /// No description provided for @threadCommittedPushed.
  ///
  /// In en, this message translates to:
  /// **'Committed and pushed to remote'**
  String get threadCommittedPushed;

  /// No description provided for @threadPushed.
  ///
  /// In en, this message translates to:
  /// **'Pushed to remote'**
  String get threadPushed;

  /// No description provided for @threadCommitted.
  ///
  /// In en, this message translates to:
  /// **'Committed'**
  String get threadCommitted;

  /// No description provided for @threadPullBehind.
  ///
  /// In en, this message translates to:
  /// **'Pull ({count} behind)'**
  String threadPullBehind(Object count);

  /// No description provided for @threadFetch.
  ///
  /// In en, this message translates to:
  /// **'Fetch'**
  String get threadFetch;

  /// No description provided for @threadPulling.
  ///
  /// In en, this message translates to:
  /// **'Pulling...'**
  String get threadPulling;

  /// No description provided for @threadPullConflictDesktop.
  ///
  /// In en, this message translates to:
  /// **'Pull conflict. Resolve it on Desktop.'**
  String get threadPullConflictDesktop;

  /// No description provided for @threadPullConflictFiles.
  ///
  /// In en, this message translates to:
  /// **'Pull conflicts: {files}'**
  String threadPullConflictFiles(Object files);

  /// No description provided for @threadPullSuccess.
  ///
  /// In en, this message translates to:
  /// **'Pulled successfully'**
  String get threadPullSuccess;

  /// No description provided for @threadAlreadySynced.
  ///
  /// In en, this message translates to:
  /// **'The current branch is up to date'**
  String get threadAlreadySynced;

  /// No description provided for @threadFetching.
  ///
  /// In en, this message translates to:
  /// **'Fetching...'**
  String get threadFetching;

  /// No description provided for @threadFetchComplete.
  ///
  /// In en, this message translates to:
  /// **'Fetch complete'**
  String get threadFetchComplete;

  /// No description provided for @threadTaskListEmpty.
  ///
  /// In en, this message translates to:
  /// **'No task list'**
  String get threadTaskListEmpty;

  /// No description provided for @threadTaskInProgress.
  ///
  /// In en, this message translates to:
  /// **'In progress'**
  String get threadTaskInProgress;

  /// No description provided for @threadTaskCompleted.
  ///
  /// In en, this message translates to:
  /// **'Completed'**
  String get threadTaskCompleted;

  /// No description provided for @threadTaskBlocked.
  ///
  /// In en, this message translates to:
  /// **'Blocked'**
  String get threadTaskBlocked;

  /// No description provided for @threadTaskStopped.
  ///
  /// In en, this message translates to:
  /// **'Stopped'**
  String get threadTaskStopped;

  /// No description provided for @threadTaskPending.
  ///
  /// In en, this message translates to:
  /// **'Pending'**
  String get threadTaskPending;

  /// No description provided for @threadDesktopDisconnected.
  ///
  /// In en, this message translates to:
  /// **'Desktop is not connected'**
  String get threadDesktopDisconnected;

  /// No description provided for @threadNpmScriptsEmpty.
  ///
  /// In en, this message translates to:
  /// **'No package.json scripts found'**
  String get threadNpmScriptsEmpty;

  /// No description provided for @threadNpmScriptsSearchHint.
  ///
  /// In en, this message translates to:
  /// **'Search scripts'**
  String get threadNpmScriptsSearchHint;

  /// No description provided for @threadNpmScriptsNoMatches.
  ///
  /// In en, this message translates to:
  /// **'No matching scripts'**
  String get threadNpmScriptsNoMatches;

  /// No description provided for @threadExtraArgs.
  ///
  /// In en, this message translates to:
  /// **'Extra arguments'**
  String get threadExtraArgs;

  /// No description provided for @threadExtraArgsValue.
  ///
  /// In en, this message translates to:
  /// **'Extra arguments: {args}'**
  String threadExtraArgsValue(Object args);

  /// No description provided for @threadCustomizeScript.
  ///
  /// In en, this message translates to:
  /// **'Customize command'**
  String get threadCustomizeScript;

  /// No description provided for @threadPrefixCommand.
  ///
  /// In en, this message translates to:
  /// **'Leading command'**
  String get threadPrefixCommand;

  /// No description provided for @threadPrefixCommandHint.
  ///
  /// In en, this message translates to:
  /// **'e.g. nvm use 20 && export NODE_ENV=production'**
  String get threadPrefixCommandHint;

  /// No description provided for @threadRun.
  ///
  /// In en, this message translates to:
  /// **'Run'**
  String get threadRun;

  /// No description provided for @threadRunStarting.
  ///
  /// In en, this message translates to:
  /// **'Starting'**
  String get threadRunStarting;

  /// No description provided for @threadRunRunning.
  ///
  /// In en, this message translates to:
  /// **'Running'**
  String get threadRunRunning;

  /// No description provided for @threadRunCompleted.
  ///
  /// In en, this message translates to:
  /// **'Completed'**
  String get threadRunCompleted;

  /// No description provided for @threadRunFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed'**
  String get threadRunFailed;

  /// No description provided for @threadRunStopped.
  ///
  /// In en, this message translates to:
  /// **'Stopped'**
  String get threadRunStopped;

  /// No description provided for @threadStopping.
  ///
  /// In en, this message translates to:
  /// **'Stopping'**
  String get threadStopping;

  /// No description provided for @threadStop.
  ///
  /// In en, this message translates to:
  /// **'Stop'**
  String get threadStop;

  /// No description provided for @threadWaitingCommandOutput.
  ///
  /// In en, this message translates to:
  /// **'Waiting for command output from Desktop...'**
  String get threadWaitingCommandOutput;

  /// No description provided for @threadOutputTruncated.
  ///
  /// In en, this message translates to:
  /// **'Output is too long. Only the latest content is shown.'**
  String get threadOutputTruncated;

  /// No description provided for @threadDelete.
  ///
  /// In en, this message translates to:
  /// **'Delete session'**
  String get threadDelete;

  /// No description provided for @threadDeleteConfirm.
  ///
  /// In en, this message translates to:
  /// **'Delete “{title}”? This cannot be undone.'**
  String threadDeleteConfirm(Object title);

  /// No description provided for @threadDeleted.
  ///
  /// In en, this message translates to:
  /// **'Session deleted'**
  String get threadDeleted;

  /// No description provided for @threadEditGuidanceHint.
  ///
  /// In en, this message translates to:
  /// **'Edit guidance message...'**
  String get threadEditGuidanceHint;

  /// No description provided for @feedOpening.
  ///
  /// In en, this message translates to:
  /// **'Loading conversation'**
  String get feedOpening;

  /// No description provided for @threadProjectionLoading.
  ///
  /// In en, this message translates to:
  /// **'Loading run projection...'**
  String get threadProjectionLoading;

  /// No description provided for @threadProjectionUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Run projection is not ready'**
  String get threadProjectionUnavailable;

  /// No description provided for @threadNoSubagentDetails.
  ///
  /// In en, this message translates to:
  /// **'No subagent details'**
  String get threadNoSubagentDetails;

  /// No description provided for @threadNoToolDetails.
  ///
  /// In en, this message translates to:
  /// **'No tool details'**
  String get threadNoToolDetails;

  /// No description provided for @threadLoadMoreToolDetails.
  ///
  /// In en, this message translates to:
  /// **'Load more details'**
  String get threadLoadMoreToolDetails;

  /// No description provided for @threadRequestingDetails.
  ///
  /// In en, this message translates to:
  /// **'Requesting details...'**
  String get threadRequestingDetails;

  /// No description provided for @threadDetailsFailed.
  ///
  /// In en, this message translates to:
  /// **'Details request failed'**
  String get threadDetailsFailed;

  /// No description provided for @threadNoDetailsResponse.
  ///
  /// In en, this message translates to:
  /// **'No details response received'**
  String get threadNoDetailsResponse;

  /// No description provided for @threadZeroDetails.
  ///
  /// In en, this message translates to:
  /// **'Desktop returned 0 detail records'**
  String get threadZeroDetails;

  /// No description provided for @threadDetailsUnparseable.
  ///
  /// In en, this message translates to:
  /// **'The request was sent, but no parseable detail result was received.'**
  String get threadDetailsUnparseable;

  /// No description provided for @threadDetailsComplete.
  ///
  /// In en, this message translates to:
  /// **'Request completed, kind={kind}, key={key}.'**
  String threadDetailsComplete(Object key, Object kind);

  /// No description provided for @threadEditingGuidance.
  ///
  /// In en, this message translates to:
  /// **'Editing guidance message'**
  String get threadEditingGuidance;

  /// No description provided for @billingTitle.
  ///
  /// In en, this message translates to:
  /// **'Billing'**
  String get billingTitle;

  /// No description provided for @billingComparison.
  ///
  /// In en, this message translates to:
  /// **'Cost comparison'**
  String get billingComparison;

  /// No description provided for @billingUnorchestrated.
  ///
  /// In en, this message translates to:
  /// **'Unorchestrated'**
  String get billingUnorchestrated;

  /// No description provided for @billingPlannerEstimate.
  ///
  /// In en, this message translates to:
  /// **'Estimated at {model} rates'**
  String billingPlannerEstimate(Object model);

  /// No description provided for @billingMainModelEstimate.
  ///
  /// In en, this message translates to:
  /// **'Estimated at main model rates'**
  String get billingMainModelEstimate;

  /// No description provided for @billingEco.
  ///
  /// In en, this message translates to:
  /// **'Eco coding'**
  String get billingEco;

  /// No description provided for @billingEcoSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Actual cost after Eco orchestration'**
  String get billingEcoSubtitle;

  /// No description provided for @billingSavings.
  ///
  /// In en, this message translates to:
  /// **'Savings'**
  String get billingSavings;

  /// No description provided for @billingTokenUsage.
  ///
  /// In en, this message translates to:
  /// **'Token usage'**
  String get billingTokenUsage;

  /// No description provided for @billingInput.
  ///
  /// In en, this message translates to:
  /// **'Input'**
  String get billingInput;

  /// No description provided for @billingOutput.
  ///
  /// In en, this message translates to:
  /// **'Output'**
  String get billingOutput;

  /// No description provided for @billingCacheHitRate.
  ///
  /// In en, this message translates to:
  /// **'Cache hit rate'**
  String get billingCacheHitRate;

  /// No description provided for @billingCacheRead.
  ///
  /// In en, this message translates to:
  /// **'Cache read'**
  String get billingCacheRead;

  /// No description provided for @billingCacheWrite.
  ///
  /// In en, this message translates to:
  /// **'Cache write'**
  String get billingCacheWrite;

  /// No description provided for @billingByModel.
  ///
  /// In en, this message translates to:
  /// **'By model'**
  String get billingByModel;

  /// No description provided for @billingContext.
  ///
  /// In en, this message translates to:
  /// **'Context'**
  String get billingContext;

  /// No description provided for @billingComposition.
  ///
  /// In en, this message translates to:
  /// **'Composition'**
  String get billingComposition;

  /// No description provided for @billingVsUnorchestrated.
  ///
  /// In en, this message translates to:
  /// **'vs. unorchestrated estimate'**
  String get billingVsUnorchestrated;

  /// No description provided for @billingNoComposition.
  ///
  /// In en, this message translates to:
  /// **'No composition details'**
  String get billingNoComposition;

  /// No description provided for @usageNoSavings.
  ///
  /// In en, this message translates to:
  /// **'No savings yet'**
  String get usageNoSavings;

  /// No description provided for @usageSavings.
  ///
  /// In en, this message translates to:
  /// **'Saved {cost}{percent}'**
  String usageSavings(Object cost, Object percent);

  /// No description provided for @usageFull.
  ///
  /// In en, this message translates to:
  /// **'100% full'**
  String get usageFull;

  /// No description provided for @usageNearLimit.
  ///
  /// In en, this message translates to:
  /// **'{percent}% near limit'**
  String usageNearLimit(Object percent);

  /// No description provided for @usageAlmostFull.
  ///
  /// In en, this message translates to:
  /// **'{percent}% almost full'**
  String usageAlmostFull(Object percent);

  /// No description provided for @usageUsed.
  ///
  /// In en, this message translates to:
  /// **'{percent}% used'**
  String usageUsed(Object percent);

  /// No description provided for @usageAccumulating.
  ///
  /// In en, this message translates to:
  /// **'Cost is accumulating...'**
  String get usageAccumulating;

  /// No description provided for @usagePlanHint.
  ///
  /// In en, this message translates to:
  /// **'Tokens and cost from planning will appear here.'**
  String get usagePlanHint;

  /// No description provided for @usageNoRecords.
  ///
  /// In en, this message translates to:
  /// **'No accumulated token or cost records.'**
  String get usageNoRecords;

  /// No description provided for @usageCostPlaceholder.
  ///
  /// In en, this message translates to:
  /// **'Cost — shown after the first model request'**
  String get usageCostPlaceholder;

  /// No description provided for @usageUpdatesPerResponse.
  ///
  /// In en, this message translates to:
  /// **'Usage updates after each model response'**
  String get usageUpdatesPerResponse;

  /// No description provided for @usagePlanUpdates.
  ///
  /// In en, this message translates to:
  /// **'Planning usage updates with model responses'**
  String get usagePlanUpdates;

  /// No description provided for @usageNoContext.
  ///
  /// In en, this message translates to:
  /// **'No context data'**
  String get usageNoContext;

  /// No description provided for @usageContextPlaceholder.
  ///
  /// In en, this message translates to:
  /// **'Context — shown after the first model request'**
  String get usageContextPlaceholder;

  /// No description provided for @diffNoChanges.
  ///
  /// In en, this message translates to:
  /// **'No uncommitted workspace changes'**
  String get diffNoChanges;

  /// No description provided for @diffTruncated.
  ///
  /// In en, this message translates to:
  /// **'The diff is long; some files may not be shown completely'**
  String get diffTruncated;

  /// No description provided for @diffFilesChanged.
  ///
  /// In en, this message translates to:
  /// **'{count} files changed'**
  String diffFilesChanged(Object count);

  /// No description provided for @diffNoContent.
  ///
  /// In en, this message translates to:
  /// **'No diff content'**
  String get diffNoContent;

  /// No description provided for @diffChange.
  ///
  /// In en, this message translates to:
  /// **'Change'**
  String get diffChange;

  /// No description provided for @diffLine.
  ///
  /// In en, this message translates to:
  /// **'Line {start}'**
  String diffLine(int start);

  /// No description provided for @diffLineRange.
  ///
  /// In en, this message translates to:
  /// **'Lines {from}-{to}'**
  String diffLineRange(int from, int to);

  /// No description provided for @commitPushFailed.
  ///
  /// In en, this message translates to:
  /// **'Commit completed, but push failed: {error}'**
  String commitPushFailed(Object error);

  /// No description provided for @commitDestination.
  ///
  /// In en, this message translates to:
  /// **'Commit to'**
  String get commitDestination;

  /// No description provided for @commitNewBranch.
  ///
  /// In en, this message translates to:
  /// **'New branch'**
  String get commitNewBranch;

  /// No description provided for @commitCreateBranch.
  ///
  /// In en, this message translates to:
  /// **'Create branch'**
  String get commitCreateBranch;

  /// No description provided for @commitBranchName.
  ///
  /// In en, this message translates to:
  /// **'Branch name'**
  String get commitBranchName;

  /// No description provided for @commonCreate.
  ///
  /// In en, this message translates to:
  /// **'Create'**
  String get commonCreate;

  /// No description provided for @commitSelectModel.
  ///
  /// In en, this message translates to:
  /// **'Select generation model'**
  String get commitSelectModel;

  /// No description provided for @commitChanges.
  ///
  /// In en, this message translates to:
  /// **'Commit changes'**
  String get commitChanges;

  /// No description provided for @commitFilesSummary.
  ///
  /// In en, this message translates to:
  /// **'{count} files · +{additions} -{deletions}'**
  String commitFilesSummary(int count, int additions, int deletions);

  /// No description provided for @commitLoadingModels.
  ///
  /// In en, this message translates to:
  /// **'Loading models...'**
  String get commitLoadingModels;

  /// No description provided for @commitNoModel.
  ///
  /// In en, this message translates to:
  /// **'No model configured'**
  String get commitNoModel;

  /// No description provided for @commitMessageHint.
  ///
  /// In en, this message translates to:
  /// **'Commit message (leave blank to generate with AI)'**
  String get commitMessageHint;

  /// No description provided for @commitGenerateMessage.
  ///
  /// In en, this message translates to:
  /// **'Generate commit message with AI'**
  String get commitGenerateMessage;

  /// No description provided for @commitIncludeUnstaged.
  ///
  /// In en, this message translates to:
  /// **'Include unstaged changes'**
  String get commitIncludeUnstaged;

  /// No description provided for @commitCommitting.
  ///
  /// In en, this message translates to:
  /// **'Committing...'**
  String get commitCommitting;

  /// No description provided for @commitPushing.
  ///
  /// In en, this message translates to:
  /// **'Pushing...'**
  String get commitPushing;

  /// No description provided for @commitAndPush.
  ///
  /// In en, this message translates to:
  /// **'Commit and push'**
  String get commitAndPush;

  /// No description provided for @commitPushOnlyAhead.
  ///
  /// In en, this message translates to:
  /// **'Push only ({count} ahead)'**
  String commitPushOnlyAhead(Object count);

  /// No description provided for @composerReasoningOff.
  ///
  /// In en, this message translates to:
  /// **'Off'**
  String get composerReasoningOff;

  /// No description provided for @composerReasoningLow.
  ///
  /// In en, this message translates to:
  /// **'Low'**
  String get composerReasoningLow;

  /// No description provided for @composerReasoningMedium.
  ///
  /// In en, this message translates to:
  /// **'Medium'**
  String get composerReasoningMedium;

  /// No description provided for @composerReasoningHigh.
  ///
  /// In en, this message translates to:
  /// **'High'**
  String get composerReasoningHigh;

  /// No description provided for @composerReasoningExtraHigh.
  ///
  /// In en, this message translates to:
  /// **'Extra high'**
  String get composerReasoningExtraHigh;

  /// No description provided for @composerReasoningMaximum.
  ///
  /// In en, this message translates to:
  /// **'Max'**
  String get composerReasoningMaximum;

  /// No description provided for @composerNoSubagents.
  ///
  /// In en, this message translates to:
  /// **'The current orchestration has no subagents'**
  String get composerNoSubagents;

  /// No description provided for @composerOrchestrationNotConfigured.
  ///
  /// In en, this message translates to:
  /// **'Orchestration not configured'**
  String get composerOrchestrationNotConfigured;

  /// No description provided for @composerModel.
  ///
  /// In en, this message translates to:
  /// **'Model'**
  String get composerModel;

  /// No description provided for @composerAcpModelHint.
  ///
  /// In en, this message translates to:
  /// **'Models come from Cursor Agent CLI'**
  String get composerAcpModelHint;

  /// No description provided for @composerAcpModelDefault.
  ///
  /// In en, this message translates to:
  /// **'Cursor default'**
  String get composerAcpModelDefault;

  /// No description provided for @composerAcpModelDefaultHint.
  ///
  /// In en, this message translates to:
  /// **'Same as Cursor CLI\'s current configuration'**
  String get composerAcpModelDefaultHint;

  /// No description provided for @composerAcpModelCurrent.
  ///
  /// In en, this message translates to:
  /// **'Current'**
  String get composerAcpModelCurrent;

  /// No description provided for @composerAcpModelLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Could not load models from Cursor Agent CLI'**
  String get composerAcpModelLoadFailed;

  /// No description provided for @composerAuxiliaryModel.
  ///
  /// In en, this message translates to:
  /// **'Auxiliary model'**
  String get composerAuxiliaryModel;

  /// No description provided for @composerAuxiliaryModelHint.
  ///
  /// In en, this message translates to:
  /// **'Used for titles and Git commit messages'**
  String get composerAuxiliaryModelHint;

  /// No description provided for @composerAuxiliaryModelManualFallback.
  ///
  /// In en, this message translates to:
  /// **'Sending remains available; titles are not generated and reviews use manual mode'**
  String get composerAuxiliaryModelManualFallback;

  /// No description provided for @composerAuxiliaryModelNeedsMainAgent.
  ///
  /// In en, this message translates to:
  /// **'Configure the main Agent before selecting an auxiliary model'**
  String get composerAuxiliaryModelNeedsMainAgent;

  /// No description provided for @composerVisionModel.
  ///
  /// In en, this message translates to:
  /// **'Vision model'**
  String get composerVisionModel;

  /// No description provided for @composerVisionModelHint.
  ///
  /// In en, this message translates to:
  /// **'Used by the image_view tool; falls back to the main model when unset'**
  String get composerVisionModelHint;

  /// No description provided for @composerVisionModelFollowMain.
  ///
  /// In en, this message translates to:
  /// **'Uses the current main model for vision when unset'**
  String get composerVisionModelFollowMain;

  /// No description provided for @composerVisionModelNeedsMainAgent.
  ///
  /// In en, this message translates to:
  /// **'Configure the main Agent before selecting a vision model'**
  String get composerVisionModelNeedsMainAgent;

  /// No description provided for @composerAuxiliaryModelHintAcp.
  ///
  /// In en, this message translates to:
  /// **'Used for title generation and automatic command approval'**
  String get composerAuxiliaryModelHintAcp;

  /// No description provided for @composerVisionModelHintAcp.
  ///
  /// In en, this message translates to:
  /// **'Used by the image_view tool; falls back to the Cursor model when unset'**
  String get composerVisionModelHintAcp;

  /// No description provided for @composerCoreKind.
  ///
  /// In en, this message translates to:
  /// **'Runtime core'**
  String get composerCoreKind;

  /// No description provided for @auxiliaryModelRequiredForAutoReview.
  ///
  /// In en, this message translates to:
  /// **'Configure an approval model before enabling automatic reviews'**
  String get auxiliaryModelRequiredForAutoReview;

  /// No description provided for @auxiliaryModelAutoReviewFallback.
  ///
  /// In en, this message translates to:
  /// **'No approval model is configured. Switched to manual review and continued sending'**
  String get auxiliaryModelAutoReviewFallback;

  /// No description provided for @composerReasoning.
  ///
  /// In en, this message translates to:
  /// **'Reasoning'**
  String get composerReasoning;

  /// No description provided for @composerReasoningIntensity.
  ///
  /// In en, this message translates to:
  /// **'Reasoning'**
  String get composerReasoningIntensity;

  /// No description provided for @composerAdvanced.
  ///
  /// In en, this message translates to:
  /// **'Advanced'**
  String get composerAdvanced;

  /// No description provided for @composerAux.
  ///
  /// In en, this message translates to:
  /// **'Aux'**
  String get composerAux;

  /// No description provided for @composerVision.
  ///
  /// In en, this message translates to:
  /// **'Vision'**
  String get composerVision;

  /// No description provided for @composerNone.
  ///
  /// In en, this message translates to:
  /// **'None'**
  String get composerNone;

  /// No description provided for @composerOrchestration.
  ///
  /// In en, this message translates to:
  /// **'Orchestration'**
  String get composerOrchestration;

  /// No description provided for @composerSubagents.
  ///
  /// In en, this message translates to:
  /// **'Subagents'**
  String get composerSubagents;

  /// No description provided for @composerOrchestrationComponents.
  ///
  /// In en, this message translates to:
  /// **'Orchestration components'**
  String get composerOrchestrationComponents;

  /// No description provided for @composerSessionOnly.
  ///
  /// In en, this message translates to:
  /// **'Settings apply only to this session'**
  String get composerSessionOnly;

  /// No description provided for @composerRuntimeCore.
  ///
  /// In en, this message translates to:
  /// **'Runtime core'**
  String get composerRuntimeCore;

  /// No description provided for @composerRuntimeCoreLocked.
  ///
  /// In en, this message translates to:
  /// **'The runtime core is locked for this session'**
  String get composerRuntimeCoreLocked;

  /// No description provided for @composerOrchestrationLocked.
  ///
  /// In en, this message translates to:
  /// **'Orchestration cannot be edited for this session'**
  String get composerOrchestrationLocked;

  /// No description provided for @composerMainAgent.
  ///
  /// In en, this message translates to:
  /// **'Profile'**
  String get composerMainAgent;

  /// No description provided for @composerMainAgentPrompt.
  ///
  /// In en, this message translates to:
  /// **'Prompt'**
  String get composerMainAgentPrompt;

  /// No description provided for @composerBuiltinMainAgentPrompt.
  ///
  /// In en, this message translates to:
  /// **'Follow built-in agent prompt'**
  String get composerBuiltinMainAgentPrompt;

  /// No description provided for @composerNoSubagentOrchestration.
  ///
  /// In en, this message translates to:
  /// **'No subagents'**
  String get composerNoSubagentOrchestration;

  /// No description provided for @composerAgentsCount.
  ///
  /// In en, this message translates to:
  /// **'{count} agents'**
  String composerAgentsCount(int count);

  /// No description provided for @composerAlwaysEnabled.
  ///
  /// In en, this message translates to:
  /// **'Always enabled'**
  String get composerAlwaysEnabled;

  /// No description provided for @composerMcpDisabledHint.
  ///
  /// In en, this message translates to:
  /// **'When disabled, this session will not call tools from this server'**
  String get composerMcpDisabledHint;

  /// No description provided for @composerNoSwitchableAgent.
  ///
  /// In en, this message translates to:
  /// **'No switchable Agent is available for this session'**
  String get composerNoSwitchableAgent;

  /// No description provided for @composerNoSwitchableModel.
  ///
  /// In en, this message translates to:
  /// **'The current orchestration has no switchable models'**
  String get composerNoSwitchableModel;

  /// No description provided for @composerNoReasoningOptions.
  ///
  /// In en, this message translates to:
  /// **'The current orchestration has no reasoning options'**
  String get composerNoReasoningOptions;

  /// No description provided for @composerNoOrchestrationResources.
  ///
  /// In en, this message translates to:
  /// **'No orchestration resources available'**
  String get composerNoOrchestrationResources;

  /// No description provided for @composerNoMcpServers.
  ///
  /// In en, this message translates to:
  /// **'No MCP servers configured'**
  String get composerNoMcpServers;

  /// No description provided for @composerNoSkills.
  ///
  /// In en, this message translates to:
  /// **'No Skills available for this project'**
  String get composerNoSkills;

  /// No description provided for @composerSkillsHint.
  ///
  /// In en, this message translates to:
  /// **'Enable available project Skills as needed'**
  String get composerSkillsHint;

  /// No description provided for @composerProjectSkill.
  ///
  /// In en, this message translates to:
  /// **'Project · {layout}'**
  String composerProjectSkill(Object layout);

  /// No description provided for @composerUserSkill.
  ///
  /// In en, this message translates to:
  /// **'User · {layout}'**
  String composerUserSkill(Object layout);

  /// No description provided for @composerNotEnabled.
  ///
  /// In en, this message translates to:
  /// **'Not enabled'**
  String get composerNotEnabled;

  /// No description provided for @composerModelCandidatesHint.
  ///
  /// In en, this message translates to:
  /// **'Only models from the selected main-agent provider are shown'**
  String get composerModelCandidatesHint;

  /// No description provided for @composerModelLocked.
  ///
  /// In en, this message translates to:
  /// **'Models cannot be switched for this session'**
  String get composerModelLocked;

  /// No description provided for @composerModelLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to load candidate models'**
  String get composerModelLoadFailed;

  /// No description provided for @composerReasoningUnsupported.
  ///
  /// In en, this message translates to:
  /// **'The current model does not support reasoning'**
  String get composerReasoningUnsupported;

  /// No description provided for @composerSessionReasoningOnly.
  ///
  /// In en, this message translates to:
  /// **'Affects only this session'**
  String get composerSessionReasoningOnly;

  /// No description provided for @composerSelectOrchestration.
  ///
  /// In en, this message translates to:
  /// **'Select orchestration'**
  String get composerSelectOrchestration;

  /// No description provided for @composerSelectOrchestrationSelection.
  ///
  /// In en, this message translates to:
  /// **'Select orchestration'**
  String get composerSelectOrchestrationSelection;

  /// No description provided for @composerOrchestrationSummary.
  ///
  /// In en, this message translates to:
  /// **'Orchestration {summary}'**
  String composerOrchestrationSummary(Object summary);

  /// No description provided for @composerSubagentOrchestration.
  ///
  /// In en, this message translates to:
  /// **'Subagents'**
  String get composerSubagentOrchestration;

  /// No description provided for @composerSubagentOrchestrationSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Control which subagents this session can call'**
  String get composerSubagentOrchestrationSubtitle;

  /// No description provided for @composerAgents.
  ///
  /// In en, this message translates to:
  /// **'Agents'**
  String get composerAgents;

  /// No description provided for @composerContext.
  ///
  /// In en, this message translates to:
  /// **'Context'**
  String get composerContext;

  /// No description provided for @followUpReorder.
  ///
  /// In en, this message translates to:
  /// **'Drag to reorder messages'**
  String get followUpReorder;

  /// No description provided for @followUpGuide.
  ///
  /// In en, this message translates to:
  /// **'Guide'**
  String get followUpGuide;

  /// No description provided for @followUpEdit.
  ///
  /// In en, this message translates to:
  /// **'Edit'**
  String get followUpEdit;

  /// No description provided for @followUpEditing.
  ///
  /// In en, this message translates to:
  /// **'Editing'**
  String get followUpEditing;

  /// No description provided for @followUpQueuePaused.
  ///
  /// In en, this message translates to:
  /// **'Queue paused'**
  String get followUpQueuePaused;

  /// No description provided for @followUpQueuePausedEditing.
  ///
  /// In en, this message translates to:
  /// **'Queue paused until you finish editing'**
  String get followUpQueuePausedEditing;

  /// No description provided for @followUpQueueActive.
  ///
  /// In en, this message translates to:
  /// **'{count} messages are queued'**
  String followUpQueueActive(Object count);

  /// No description provided for @followUpQueuePause.
  ///
  /// In en, this message translates to:
  /// **'Pause'**
  String get followUpQueuePause;

  /// No description provided for @followUpQueueResume.
  ///
  /// In en, this message translates to:
  /// **'Resume'**
  String get followUpQueueResume;

  /// No description provided for @followUpDeleting.
  ///
  /// In en, this message translates to:
  /// **'Deleting...'**
  String get followUpDeleting;

  /// No description provided for @followUpQueuedGuidance.
  ///
  /// In en, this message translates to:
  /// **'Queued guidance messages'**
  String get followUpQueuedGuidance;

  /// No description provided for @followUpImages.
  ///
  /// In en, this message translates to:
  /// **'{count} images'**
  String followUpImages(Object count);

  /// No description provided for @followUpEmptyGuidance.
  ///
  /// In en, this message translates to:
  /// **'Empty guidance message'**
  String get followUpEmptyGuidance;

  /// No description provided for @subagentElapsed.
  ///
  /// In en, this message translates to:
  /// **'Elapsed {duration}'**
  String subagentElapsed(Object duration);

  /// No description provided for @bashApprovalRememberPrefix.
  ///
  /// In en, this message translates to:
  /// **'Yes, and don\'t ask again for commands beginning with '**
  String get bashApprovalRememberPrefix;

  /// No description provided for @mcpApprovalRememberTool.
  ///
  /// In en, this message translates to:
  /// **'Allow this tool without asking again (all conversations on this computer) '**
  String get mcpApprovalRememberTool;

  /// No description provided for @bashApprovalDenyAdjust.
  ///
  /// In en, this message translates to:
  /// **'No, tell Eco how to adjust'**
  String get bashApprovalDenyAdjust;

  /// No description provided for @projectMoreThreads.
  ///
  /// In en, this message translates to:
  /// **'{count} more'**
  String projectMoreThreads(Object count);

  /// No description provided for @projectAwaitingApproval.
  ///
  /// In en, this message translates to:
  /// **'Awaiting approval'**
  String get projectAwaitingApproval;

  /// No description provided for @activityThinkingLabel.
  ///
  /// In en, this message translates to:
  /// **'Thinking'**
  String get activityThinkingLabel;

  /// No description provided for @activitySubagentFallback.
  ///
  /// In en, this message translates to:
  /// **'Subagent'**
  String get activitySubagentFallback;

  /// No description provided for @threadNpmScripts.
  ///
  /// In en, this message translates to:
  /// **'npm scripts'**
  String get threadNpmScripts;

  /// No description provided for @composerAgent.
  ///
  /// In en, this message translates to:
  /// **'Runtime'**
  String get composerAgent;

  /// No description provided for @composerMcp.
  ///
  /// In en, this message translates to:
  /// **'MCP'**
  String get composerMcp;

  /// No description provided for @composerIntegrations.
  ///
  /// In en, this message translates to:
  /// **'Integrations'**
  String get composerIntegrations;

  /// No description provided for @composerIntegrationsHint.
  ///
  /// In en, this message translates to:
  /// **'Configure integrations globally on Desktop, then enable them for this session'**
  String get composerIntegrationsHint;

  /// No description provided for @composerIntegrationsLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to load integrations from Desktop'**
  String get composerIntegrationsLoadFailed;

  /// No description provided for @composerNoIntegrations.
  ///
  /// In en, this message translates to:
  /// **'No integrations are available from Desktop'**
  String get composerNoIntegrations;

  /// No description provided for @composerBrowser.
  ///
  /// In en, this message translates to:
  /// **'Browser'**
  String get composerBrowser;

  /// No description provided for @composerImageGeneration.
  ///
  /// In en, this message translates to:
  /// **'Creative Drawing'**
  String get composerImageGeneration;

  /// No description provided for @composerComputerUse.
  ///
  /// In en, this message translates to:
  /// **'Computer Use'**
  String get composerComputerUse;

  /// No description provided for @composerSkills.
  ///
  /// In en, this message translates to:
  /// **'Skills'**
  String get composerSkills;

  /// No description provided for @composerPlanMode.
  ///
  /// In en, this message translates to:
  /// **'Plan Mode'**
  String get composerPlanMode;

  /// No description provided for @composerBashReview.
  ///
  /// In en, this message translates to:
  /// **'Bash Review'**
  String get composerBashReview;

  /// No description provided for @errorInvalidServerScheme.
  ///
  /// In en, this message translates to:
  /// **'Supabase URL must use HTTP or HTTPS.'**
  String get errorInvalidServerScheme;

  /// No description provided for @errorDeviceCredentialsRequired.
  ///
  /// In en, this message translates to:
  /// **'Device credentials are required.'**
  String get errorDeviceCredentialsRequired;

  /// No description provided for @errorQuickPairQrOutdated.
  ///
  /// In en, this message translates to:
  /// **'The QR code is missing project or authorization information. Generate a new code from the latest Desktop app.'**
  String get errorQuickPairQrOutdated;

  /// No description provided for @errorServerUnreachable.
  ///
  /// In en, this message translates to:
  /// **'Cannot reach the server. Check the address and network.'**
  String get errorServerUnreachable;

  /// No description provided for @errorWebSocketDisconnected.
  ///
  /// In en, this message translates to:
  /// **'Realtime channel is not connected.'**
  String get errorWebSocketDisconnected;

  /// No description provided for @errorRpcTimeout.
  ///
  /// In en, this message translates to:
  /// **'The Desktop request timed out.'**
  String get errorRpcTimeout;

  /// No description provided for @errorServerUrlRequired.
  ///
  /// In en, this message translates to:
  /// **'Supabase project URL is required.'**
  String get errorServerUrlRequired;

  /// No description provided for @errorAnonKeyRequired.
  ///
  /// In en, this message translates to:
  /// **'Supabase anon key is required.'**
  String get errorAnonKeyRequired;

  /// No description provided for @errorBindingRequired.
  ///
  /// In en, this message translates to:
  /// **'Pair with a Desktop first to open the Realtime channel.'**
  String get errorBindingRequired;

  /// No description provided for @errorConnectionAborted.
  ///
  /// In en, this message translates to:
  /// **'Connection was cancelled.'**
  String get errorConnectionAborted;

  /// No description provided for @errorWebSocketTimeout.
  ///
  /// In en, this message translates to:
  /// **'Realtime connection timed out.'**
  String get errorWebSocketTimeout;

  /// No description provided for @errorRpcFailed.
  ///
  /// In en, this message translates to:
  /// **'The Desktop request failed.'**
  String get errorRpcFailed;

  /// No description provided for @errorDeviceCredentialsMissing.
  ///
  /// In en, this message translates to:
  /// **'Device credentials are missing.'**
  String get errorDeviceCredentialsMissing;

  /// No description provided for @errorServerOutdated.
  ///
  /// In en, this message translates to:
  /// **'Cannot finish QR pairing: pairing-join is not deployed, or the code expired. Deploy Edge Functions, then generate a new QR from Desktop.'**
  String get errorServerOutdated;

  /// No description provided for @errorHttpRequestFailed.
  ///
  /// In en, this message translates to:
  /// **'Request failed with HTTP {status}.'**
  String errorHttpRequestFailed(Object status);

  /// No description provided for @errorNetworkRequestFailed.
  ///
  /// In en, this message translates to:
  /// **'Network request failed.'**
  String get errorNetworkRequestFailed;

  /// No description provided for @errorInvalidPairQr.
  ///
  /// In en, this message translates to:
  /// **'Invalid pairing QR code.'**
  String get errorInvalidPairQr;

  /// No description provided for @authNetwork.
  ///
  /// In en, this message translates to:
  /// **'Cannot connect to the server. Check your network and try again.'**
  String get authNetwork;

  /// No description provided for @authDeviceInactive.
  ///
  /// In en, this message translates to:
  /// **'This device was removed or disabled on the server. Configure the connection again.'**
  String get authDeviceInactive;

  /// No description provided for @authAccountUnusable.
  ///
  /// In en, this message translates to:
  /// **'This account is disabled. Contact an administrator.'**
  String get authAccountUnusable;

  /// No description provided for @authRelogin.
  ///
  /// In en, this message translates to:
  /// **'Your session expired. Sign in again.'**
  String get authRelogin;

  /// No description provided for @authUnknown.
  ///
  /// In en, this message translates to:
  /// **'Connection failed. Try again later.'**
  String get authUnknown;

  /// No description provided for @signOutCleanupFailed.
  ///
  /// In en, this message translates to:
  /// **'Signed out locally, but server cleanup did not complete: {message}'**
  String signOutCleanupFailed(Object message);

  /// No description provided for @speechPermissionDenied.
  ///
  /// In en, this message translates to:
  /// **'Microphone permission is required for cloud speech recognition'**
  String get speechPermissionDenied;

  /// No description provided for @speechUnavailable.
  ///
  /// In en, this message translates to:
  /// **'Cloud speech recognition is unavailable on this device'**
  String get speechUnavailable;

  /// No description provided for @speechBusy.
  ///
  /// In en, this message translates to:
  /// **'The previous cloud speech recognition request is still running'**
  String get speechBusy;

  /// No description provided for @speechNetworkUnavailable.
  ///
  /// In en, this message translates to:
  /// **'The cloud speech recognition service is temporarily unavailable'**
  String get speechNetworkUnavailable;

  /// No description provided for @speechRecognitionFailed.
  ///
  /// In en, this message translates to:
  /// **'Cloud speech recognition failed'**
  String get speechRecognitionFailed;

  /// No description provided for @asrDesktopOffline.
  ///
  /// In en, this message translates to:
  /// **'The connected Desktop is offline'**
  String get asrDesktopOffline;

  /// No description provided for @asrNotConfigured.
  ///
  /// In en, this message translates to:
  /// **'Configure a cloud speech recognition API key on Desktop first'**
  String get asrNotConfigured;

  /// No description provided for @asrCancelled.
  ///
  /// In en, this message translates to:
  /// **'Speech recognition was cancelled'**
  String get asrCancelled;

  /// No description provided for @asrTimeout.
  ///
  /// In en, this message translates to:
  /// **'The cloud speech recognition request timed out'**
  String get asrTimeout;

  /// No description provided for @asrAudioTooLarge.
  ///
  /// In en, this message translates to:
  /// **'The recording is larger than the 10 MB limit'**
  String get asrAudioTooLarge;

  /// No description provided for @asrMissingConfig.
  ///
  /// In en, this message translates to:
  /// **'Cloud speech recognition configuration is missing'**
  String get asrMissingConfig;

  /// No description provided for @asrAuthFailed.
  ///
  /// In en, this message translates to:
  /// **'Cloud speech recognition authentication failed'**
  String get asrAuthFailed;

  /// No description provided for @asrRateLimited.
  ///
  /// In en, this message translates to:
  /// **'Cloud speech recognition is receiving too many requests'**
  String get asrRateLimited;

  /// No description provided for @asrInvalidResponse.
  ///
  /// In en, this message translates to:
  /// **'Cloud speech recognition returned an invalid response'**
  String get asrInvalidResponse;

  /// No description provided for @asrNetwork.
  ///
  /// In en, this message translates to:
  /// **'The cloud speech recognition request failed'**
  String get asrNetwork;

  /// No description provided for @landingOpenProject.
  ///
  /// In en, this message translates to:
  /// **'Open a project to start coding'**
  String get landingOpenProject;

  /// No description provided for @landingHomePrompt.
  ///
  /// In en, this message translates to:
  /// **'What are you working on?'**
  String get landingHomePrompt;

  /// No description provided for @landingProjectPrompt.
  ///
  /// In en, this message translates to:
  /// **'What should we build in {name}?'**
  String landingProjectPrompt(Object name);

  /// No description provided for @composerLandingPlaceholder.
  ///
  /// In en, this message translates to:
  /// **'Ask anything'**
  String get composerLandingPlaceholder;

  /// No description provided for @composerDraftRecoveryPending.
  ///
  /// In en, this message translates to:
  /// **'The previous request did not start. Its content is waiting to be restored.'**
  String get composerDraftRecoveryPending;

  /// No description provided for @composerDraftRecoveryLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Could not check for content from a request that failed to start.'**
  String get composerDraftRecoveryLoadFailed;

  /// No description provided for @threadFollowUpRefreshFailed.
  ///
  /// In en, this message translates to:
  /// **'Could not refresh queued follow-ups.'**
  String get threadFollowUpRefreshFailed;

  /// No description provided for @composerRestoreDraft.
  ///
  /// In en, this message translates to:
  /// **'Restore'**
  String get composerRestoreDraft;

  /// No description provided for @threadProjectionNoPcSelected.
  ///
  /// In en, this message translates to:
  /// **'Select a PC before requesting projection details'**
  String get threadProjectionNoPcSelected;

  /// No description provided for @threadEarlierHistoryLoadFailed.
  ///
  /// In en, this message translates to:
  /// **'Failed to load earlier conversation history. Pull down at the top to retry.'**
  String get threadEarlierHistoryLoadFailed;

  /// No description provided for @modelCascadeSearchHint.
  ///
  /// In en, this message translates to:
  /// **'Search provider or model…'**
  String get modelCascadeSearchHint;

  /// No description provided for @modelCascadeNoMatch.
  ///
  /// In en, this message translates to:
  /// **'No matching models'**
  String get modelCascadeNoMatch;

  /// No description provided for @modelCascadeEmpty.
  ///
  /// In en, this message translates to:
  /// **'No models available'**
  String get modelCascadeEmpty;

  /// No description provided for @modelCascadeVendorOther.
  ///
  /// In en, this message translates to:
  /// **'Other'**
  String get modelCascadeVendorOther;

  /// No description provided for @markdownMermaidRenderError.
  ///
  /// In en, this message translates to:
  /// **'Failed to render Mermaid diagram'**
  String get markdownMermaidRenderError;

  /// No description provided for @markdownMermaidExpand.
  ///
  /// In en, this message translates to:
  /// **'Expand diagram'**
  String get markdownMermaidExpand;

  /// No description provided for @markdownMermaidClosePreview.
  ///
  /// In en, this message translates to:
  /// **'Hide preview'**
  String get markdownMermaidClosePreview;

  /// No description provided for @markdownMermaidOpenPreview.
  ///
  /// In en, this message translates to:
  /// **'Show preview'**
  String get markdownMermaidOpenPreview;

  /// No description provided for @markdownHtmlCardTitle.
  ///
  /// In en, this message translates to:
  /// **'HTML page'**
  String get markdownHtmlCardTitle;

  /// No description provided for @markdownHtmlLineCount.
  ///
  /// In en, this message translates to:
  /// **'{count} lines'**
  String markdownHtmlLineCount(int count);

  /// No description provided for @markdownHtmlOpenPreview.
  ///
  /// In en, this message translates to:
  /// **'Open HTML preview'**
  String get markdownHtmlOpenPreview;

  /// No description provided for @markdownHtmlPreviewTitle.
  ///
  /// In en, this message translates to:
  /// **'HTML preview'**
  String get markdownHtmlPreviewTitle;

  /// No description provided for @markdownTableExpand.
  ///
  /// In en, this message translates to:
  /// **'Expand table'**
  String get markdownTableExpand;

  /// No description provided for @markdownTableLabel.
  ///
  /// In en, this message translates to:
  /// **'table'**
  String get markdownTableLabel;

  /// No description provided for @markdownTableRotateLandscape.
  ///
  /// In en, this message translates to:
  /// **'Landscape view'**
  String get markdownTableRotateLandscape;

  /// No description provided for @markdownTableRotatePortrait.
  ///
  /// In en, this message translates to:
  /// **'Portrait view'**
  String get markdownTableRotatePortrait;

  /// No description provided for @composerApprovalModel.
  ///
  /// In en, this message translates to:
  /// **'Approval model'**
  String get composerApprovalModel;

  /// No description provided for @composerApprovalModelHint.
  ///
  /// In en, this message translates to:
  /// **'Used for automatic tool reviews; supports chat models and SystemOne (Jev)'**
  String get composerApprovalModelHint;

  /// No description provided for @composerApprovalModelManualFallback.
  ///
  /// In en, this message translates to:
  /// **'Configure an approval model to enable automatic reviews'**
  String get composerApprovalModelManualFallback;

  /// No description provided for @composerApprovalModelNeedsMainAgent.
  ///
  /// In en, this message translates to:
  /// **'Configure the main Agent before selecting an approval model'**
  String get composerApprovalModelNeedsMainAgent;

  /// No description provided for @composerApprovalModelHintAcp.
  ///
  /// In en, this message translates to:
  /// **'Used for automatic tool reviews; supports chat models and SystemOne (Jev)'**
  String get composerApprovalModelHintAcp;
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['en', 'zh'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'en':
      return AppLocalizationsEn();
    case 'zh':
      return AppLocalizationsZh();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
