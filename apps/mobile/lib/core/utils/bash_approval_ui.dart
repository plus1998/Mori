import '../../l10n/generated/app_localizations.dart';

String formatBashApprovalRememberPrefix(String command, {int maxLength = 48}) {
  final trimmed = command.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return '${trimmed.substring(0, maxLength - 1)}…';
}

String buildBashApprovalRememberPrefixLabel(
  String command,
  AppLocalizations l10n,
) {
  return '${l10n.bashApprovalRememberPrefix}'
      '${formatBashApprovalRememberPrefix(command)}';
}

String bashApprovalDenyOptionLabel(AppLocalizations l10n) =>
    l10n.bashApprovalDenyAdjust;

enum BashApprovalChoice {
  approve,
  approveRememberPrefix,
  approveRememberMcpTool,
  deny,
}

String bashApprovalDecisionValue(BashApprovalChoice choice) {
  return switch (choice) {
    BashApprovalChoice.approve => 'approved',
    BashApprovalChoice.approveRememberPrefix => 'approved_remember_prefix',
    BashApprovalChoice.approveRememberMcpTool => 'approved_remember_mcp_tool',
    BashApprovalChoice.deny => 'denied',
  };
}
