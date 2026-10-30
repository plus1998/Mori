class ApprovalFeedback {
  const ApprovalFeedback({required this.toolLabel, required this.feedback});

  final String toolLabel;
  final String feedback;
}

// Match the complete envelope emitted by Desktop's injectCodexApprovalFeedback.
// The original text remains stored and sent to the model unchanged.
final _approvalFeedbackEnvelope = RegExp(
  r'^The user rejected the preceding ([^\r\n]+) approval\.\r?\nUser feedback: ([\s\S]+)\r?\nDo not retry the rejected request unless the user explicitly asks for it again\.$',
);

ApprovalFeedback? parseApprovalFeedback(String text) {
  final match = _approvalFeedbackEnvelope.firstMatch(text.trim());
  if (match == null) return null;
  final feedback = match.group(2)!.trim();
  if (feedback.isEmpty) return null;
  return ApprovalFeedback(toolLabel: match.group(1)!, feedback: feedback);
}
