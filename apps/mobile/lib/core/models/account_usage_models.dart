class AccountUsageTotals {
  const AccountUsageTotals({
    required this.inputTokens,
    required this.outputTokens,
    required this.cacheReadTokens,
    required this.cacheCreationTokens,
    required this.reasoningTokens,
    required this.totalTokens,
    required this.records,
    required this.estimatedCostUsd,
    required this.unpricedRecords,
  });
  factory AccountUsageTotals.fromJson(Map<String, dynamic> json) =>
      AccountUsageTotals(
        inputTokens: (json['inputTokens'] as num).toInt(),
        outputTokens: (json['outputTokens'] as num).toInt(),
        cacheReadTokens: (json['cacheReadTokens'] as num).toInt(),
        cacheCreationTokens: (json['cacheCreationTokens'] as num).toInt(),
        reasoningTokens: (json['reasoningTokens'] as num).toInt(),
        totalTokens: (json['totalTokens'] as num).toInt(),
        records: (json['records'] as num).toInt(),
        estimatedCostUsd: (json['estimatedCostUsd'] as num).toDouble(),
        unpricedRecords: (json['unpricedRecords'] as num).toInt(),
      );
  final int inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      reasoningTokens,
      totalTokens,
      records,
      unpricedRecords;
  final double estimatedCostUsd;
}

class UsageOverviewRow {
  UsageOverviewRow.fromJson(Map<String, dynamic> json)
    : providerKey = json['providerKey'] as String,
      providerName = json['providerName'] as String,
      modelId = json['modelId'] as String,
      totals = AccountUsageTotals.fromJson(json);
  final String providerKey, providerName, modelId;
  final AccountUsageTotals totals;
}

class UsageDimension {
  UsageDimension.fromJson(Map<String, dynamic> json)
    : providerKey = json['providerKey'] as String,
      providerName = json['providerName'] as String,
      modelId = json['modelId'] as String;
  final String providerKey, providerName, modelId;
}

class UsageOverview {
  UsageOverview.fromJson(Map<String, dynamic> json)
    : dimensions = (json['dimensions'] as List)
          .map(
            (d) => UsageDimension.fromJson(Map<String, dynamic>.from(d as Map)),
          )
          .toList(),
      totals = AccountUsageTotals.fromJson(
        Map<String, dynamic>.from(json['totals'] as Map),
      ),
      rows = (json['rows'] as List)
          .map(
            (row) => UsageOverviewRow.fromJson(
              Map<String, dynamic>.from(row as Map),
            ),
          )
          .toList(),
      trackingStartedAt = (json['trackingStartedAt'] as num).toInt(),
      startAt = (json['startAt'] as num?)?.toInt(),
      endAt = (json['endAt'] as num?)?.toInt(),
      timeZone = json['timeZone'] as String,
      recordingFailures = (json['recordingFailures'] as num).toInt();
  final AccountUsageTotals totals;
  final List<UsageOverviewRow> rows;
  final List<UsageDimension> dimensions;
  final int trackingStartedAt, recordingFailures;
  final int? startAt, endAt;
  final String timeZone;
}

class AccountUsageBucket {
  AccountUsageBucket.fromJson(Map<String, dynamic> json)
    : startAt = (json['startAt'] as num).toInt(),
      endAt = (json['endAt'] as num).toInt(),
      totals = AccountUsageTotals.fromJson(json);
  final int startAt, endAt;
  final AccountUsageTotals totals;
}

class AccountUsageHistory {
  AccountUsageHistory.fromJson(Map<String, dynamic> json)
    : totals = AccountUsageTotals.fromJson(
        Map<String, dynamic>.from(json['totals'] as Map),
      ),
      buckets = (json['buckets'] as List)
          .map(
            (row) => AccountUsageBucket.fromJson(
              Map<String, dynamic>.from(row as Map),
            ),
          )
          .toList(),
      nextBefore = (json['nextBefore'] as num?)?.toInt(),
      timeZone = json['timeZone'] as String,
      trackingStartedAt = (json['trackingStartedAt'] as num).toInt(),
      firstUsageAt = (json['firstUsageAt'] as num?)?.toInt(),
      recordingFailure = json['recordingFailure'] == null
          ? null
          : Map<String, dynamic>.from(json['recordingFailure'] as Map);
  final AccountUsageTotals totals;
  final List<AccountUsageBucket> buckets;
  final int? nextBefore, firstUsageAt;
  final int trackingStartedAt;
  final String timeZone;
  final Map<String, dynamic>? recordingFailure;
}
