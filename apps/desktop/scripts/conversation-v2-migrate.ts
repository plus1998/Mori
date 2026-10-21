import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type ConversationEventInput, ConversationV2Error, stableHash } from "@eco/shared";
import { ConversationStore } from "../src/main/conversation-store";
import { ConversationV2LegacyMigrator } from "../src/main/conversation-v2-legacy-migration";
import { type ConversationNativeFact, ConversationV2Store } from "../src/main/conversation-v2-store";
import { isPromptImageAttachmentRecord, PromptImageFileStore } from "../src/main/prompt-image-file-store";

interface Arguments {
  dbPath: string;
  conversationId?: string;
  all: boolean;
  apply: boolean;
  cutover: boolean;
  repairLegacyAttachments: boolean;
  backupPath?: string;
  attachmentsRoot?: string;
  nativeManifestPath?: string;
  verifyNativeManifestPath?: string;
  reconcileNativeManifestPath?: string;
}

interface ExistingV2Inventory {
  conversationId: string;
  migrationPhase?: string;
  streams: number;
  events: number;
  migrationEvents: number;
  legacyCompatEvents: number;
  nativeEvents: number;
  nativeEquivalentEvents: number;
  nativeCollapsedEvents: number;
  nativeModifiedEvents: number;
  nativeUnmatchedEvents: number;
  nativeReconciliationIssues: string[];
  externalEvents: number;
  effects: number;
  feedSkeletons: number;
  attachmentRefs: number;
  attachmentLegacyPayloads: number;
  attachmentInlineBytes: number;
  attachmentPathRefs: number;
  attachmentMissingFiles: number;
  attachmentParseErrors: number;
  attachmentPathContentHashes: AttachmentContentHash[];
  providerInputs: number;
  messages: number;
  toolCalls: number;
  detailItems: number;
  todos: number;
  commandReceipts: number;
  commandJobs: number;
  commandCheckpoints: number;
  hasExternalData: boolean;
}

interface CommandReceiptMaintenance {
  principalId: string;
  conversationId: string;
  clientCommandId: string;
  requestHash: string;
  resultJson: string;
  acceptedSeq: number;
  acceptedEventId: string;
}

interface CommandJobMaintenance {
  principalId: string;
  conversationId: string;
  clientCommandId: string;
  commandType: string;
  requestHash: string;
  requestJson: string;
  expectedHistoryRevision: number;
  status: string;
  resultJson: string | null;
  errorJson: string | null;
  acceptedSeq: number;
  acceptedAt: string;
  updatedAt: string;
  acceptedEventId: string;
}

interface CommandCheckpointMaintenance {
  principalId: string;
  conversationId: string;
  clientCommandId: string;
  ordinal: number;
  name: string;
  payloadHash: string;
  payloadJson: string;
  recordedAt: string;
}

interface CommandStateMaintenance {
  conversationId: string;
  historyRevision: number;
  receipts: CommandReceiptMaintenance[];
  jobs: CommandJobMaintenance[];
  checkpoints: CommandCheckpointMaintenance[];
}

const LEGACY_TABLES = [
  "thread_activity",
  "thread_coder_todos",
  "thread_pending_plans",
  "thread_run_events",
  "thread_user_messages",
  "thread_pending_followups",
  "thread_feed_skeleton",
  "thread_metrics_snapshots",
  "thread_agent_instances",
  "thread_subagent_sessions",
  "thread_subagent_metrics",
  "thread_run_attempts",
  "thread_usage_ledger_events",
] as const;
const ACTIVE_THREAD_STATUSES = ["queued", "running", "awaiting_plan"] as const;

const args = parseArguments(process.argv.slice(2));
try {
  await fs.access(args.dbPath);
} catch {
  throw new Error(`Database file does not exist: ${args.dbPath}`);
}
if (args.nativeManifestPath) await assertNativeManifestPathAvailable(args.nativeManifestPath);

try {
  if (args.repairLegacyAttachments) {
    const report = await runLegacyAttachmentRepair(args);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (args.cutover) {
    const report = await runCutover(args);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (args.all) {
    const report = await runAllMigration(args);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const report = await runSingleMigration(args);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
} catch (error) {
  if (!(error instanceof ConversationV2Error)) throw error;
  // Runtime error inspection truncates nested arrays, hiding migration blockers.
  process.stderr.write(
    `${JSON.stringify({ code: error.code, message: error.message, data: error.data }, null, 2)}\n`,
  );
  process.exitCode = 1;
}

async function runSingleMigration(args: Arguments): Promise<unknown> {
  const conversationId = args.conversationId;
  if (!conversationId) throw new Error("--conversation is required for a single-conversation migration.");
  const db = new DatabaseSync(args.dbPath, { readOnly: !args.apply });
  try {
    const store = new ConversationV2Store(db);
    const migrator = new ConversationV2LegacyMigrator(
      db,
      store,
      undefined,
      createPromptImageFileStore(args.attachmentsRoot),
    );
    // Inspection must never run schema upgrades, journal-mode changes or backfills.
    // One read transaction also prevents a mixed fingerprint if the source is active.
    if (args.apply) store.initialize();
    else db.exec("BEGIN");
    const report = args.apply ? migrator.migrate(conversationId) : migrator.inspect(conversationId);
    if (!args.apply) db.exec("COMMIT");
    return report;
  } finally {
    db.close();
  }
}

async function runAllMigration(args: Arguments): Promise<unknown> {
  const expectedNativeManifest = args.verifyNativeManifestPath
    ? await readNativeMaintenanceManifest(args.verifyNativeManifestPath)
    : undefined;
  const opened = openAllMigrationDatabase(args.dbPath, !args.apply);
  const { db, threadIds } = opened;
  try {
    const storageMode = readStorageMode(db);
    const conversationIds = storageMode === "v2_only" ? listConversationIdsIncludingV2Rows(db) : threadIds;
    const store = new ConversationV2Store(db);
    const migrator = new ConversationV2LegacyMigrator(
      db,
      store,
      undefined,
      createPromptImageFileStore(args.attachmentsRoot),
    );
    if (!args.apply) {
      db.exec("BEGIN");
      let transactionActive = true;
      try {
        // A V2-only database deliberately has no legacy source tables. The read-only
        // verification/export path must remain usable after cutover: inspect the
        // durable V2/native-facts rows directly instead of asking the legacy
        // migrator to open tables that were already retired.
        if (storageMode === "v2_only") {
          const existingV2 = inspectExistingV2Data(db, conversationIds, args.attachmentsRoot);
          const integrity = readIntegrityCheck(db);
          if (integrity !== "ok") {
            throw new Error(`SQLite integrity check failed for V2-only verification: ${integrity}`);
          }
          const nativeManifest = args.nativeManifestPath
            ? buildNativeMaintenanceManifest(
                db,
                args.dbPath,
                conversationIds,
                existingV2,
                args.attachmentsRoot,
                integrity,
              )
            : undefined;
          const nativeManifestVerification = expectedNativeManifest
            ? verifyNativeMaintenanceManifest(
                db,
                args.dbPath,
                conversationIds,
                expectedNativeManifest,
                args.verifyNativeManifestPath,
                args.attachmentsRoot,
                integrity,
              )
            : undefined;
          db.exec("COMMIT");
          transactionActive = false;
          if (nativeManifest && args.nativeManifestPath) {
            await writeNativeMaintenanceManifest(args.nativeManifestPath, nativeManifest);
          }
          return {
            phase: "v2_only",
            conversationCount: conversationIds.length,
            reports: [],
            existingV2,
            storageMode,
            integrity,
            cutoverReady: isV2OnlyAuditReady(existingV2),
            ...(nativeManifest
              ? {
                  nativeManifestPath: args.nativeManifestPath,
                  nativeManifestHash: nativeManifest.contentHash,
                  nativeManifestEventCount: nativeManifest.nativeEventCount,
                }
              : {}),
            ...(nativeManifestVerification ? { nativeManifestVerification } : {}),
          };
        }
        const reports = threadIds.map((threadId) => migrator.inspect(threadId));
        const existingV2 = inspectExistingV2Data(db, threadIds, args.attachmentsRoot);
        const integrity = readIntegrityCheck(db);
        const nativeManifest = args.nativeManifestPath
          ? buildNativeMaintenanceManifest(
              db,
              args.dbPath,
              conversationIds,
              existingV2,
              args.attachmentsRoot,
              integrity,
            )
          : undefined;
        const nativeManifestVerification = expectedNativeManifest
          ? verifyNativeMaintenanceManifest(
              db,
              args.dbPath,
              conversationIds,
              expectedNativeManifest,
              args.verifyNativeManifestPath,
              args.attachmentsRoot,
              integrity,
            )
          : undefined;
        db.exec("COMMIT");
        transactionActive = false;
        if (nativeManifest && args.nativeManifestPath) {
          await writeNativeMaintenanceManifest(args.nativeManifestPath, nativeManifest);
        }
        return {
          phase: "dry_run",
          conversationCount: reports.length,
          reports,
          existingV2,
          cutoverReady: existingV2.every((entry) => !entry.hasExternalData),
          ...(nativeManifest
            ? {
                nativeManifestPath: args.nativeManifestPath,
                nativeManifestHash: nativeManifest.contentHash,
                nativeManifestEventCount: nativeManifest.nativeEventCount,
              }
            : {}),
          ...(nativeManifestVerification ? { nativeManifestVerification } : {}),
        };
      } catch (error) {
        if (transactionActive) db.exec("ROLLBACK");
        throw error;
      }
    }

    store.initialize();
    if (store.getStorageMode() === "v2_only") {
      const activeConversationIds = listConversationIdsIncludingV2Rows(db);
      for (const threadId of activeConversationIds) store.conversationV2().validateIntegrity(threadId);
      return {
        phase: "v2_only",
        conversationCount: activeConversationIds.length,
        reports: [],
        storageMode: "v2_only",
        idempotent: true,
      };
    }
    const reports = threadIds.map((threadId) => migrator.migrate(threadId));
    return {
      phase: "completed",
      conversationCount: reports.length,
      reports,
      storageMode: "legacy_compat",
    };
  } finally {
    db.close();
  }
}

async function runCutover(args: Arguments): Promise<unknown> {
  if (!args.apply || !args.all || !args.backupPath) {
    throw new Error("--cutover requires --all --apply and --backup <path>.");
  }
  const databasePath = path.resolve(args.dbPath);
  const backupPath = path.resolve(args.backupPath);
  if (databasePath === backupPath) {
    throw new Error("Backup path must be different from the source database path.");
  }
  try {
    await fs.access(backupPath);
    throw new Error(`Backup path already exists: ${backupPath}`);
  } catch (error) {
    if (error instanceof Error && !String(error.message).includes("ENOENT")) throw error;
  }
  await fs.mkdir(path.dirname(backupPath), { recursive: true });

  // A cutover can follow a short-lived verifier or another maintenance
  // process. Reopen with a busy timeout instead of turning a transient WAL
  // lock into a false migration failure.
  const { db } = openAllMigrationDatabase(args.dbPath, false);
  try {
    assertNoActiveThreads(db);
    vacuumInto(db, backupPath);

    const promptImageFileStore = createPromptImageFileStore(args.attachmentsRoot);
    const store = new ConversationStore(db, { promptImageFileStore });
    store.initialize();
    if (promptImageFileStore) store.setPromptImageFileStore(promptImageFileStore);
    const threadIds = listThreadIds(db);
    if (store.getConversationStorageMode() === "v2_only") {
      const conversationIds = listConversationIdsIncludingV2Rows(db);
      for (const threadId of conversationIds) store.conversationV2().validateIntegrity(threadId);
      const integrity = readIntegrityCheck(db);
      if (integrity !== "ok") {
        throw new Error(`SQLite integrity check failed after V2 cutover: ${integrity}`);
      }
      const remainingLegacyTables = existingTables(db, LEGACY_TABLES);
      if (remainingLegacyTables.length > 0) {
        throw new Error(`V1 tables remain after V2 cutover: ${remainingLegacyTables.join(", ")}`);
      }
      return {
        phase: "v2_only",
        conversationCount: conversationIds.length,
        reports: [],
        backupPath,
        storageMode: "v2_only",
        integrity,
        retiredTables: LEGACY_TABLES,
        idempotent: true,
      };
    }
    const existingV2 = inspectExistingV2Data(db, threadIds, args.attachmentsRoot);
    const externalV2 = existingV2.filter((entry) => entry.hasExternalData);
    const nativeManifest = args.reconcileNativeManifestPath
      ? await readNativeMaintenanceManifest(args.reconcileNativeManifestPath)
      : undefined;
    const commandState = readCommandState(db, threadIds);
    const v2 = store.conversationV2();
    const nativeFactsByConversation = new Map(
      threadIds.map((threadId) => [
        threadId,
        readNativeFactsForMaintenance(v2, db, threadId, args.attachmentsRoot),
      ]),
    );
    const commandStateForRestore = nativeManifest
      ? selectCommandStateForMaintenance(
          nativeManifest.commandState ?? [],
          commandState,
          nativeFactsByConversation,
        )
      : commandState;
    if (nativeManifest) {
      verifyNativeFactsAgainstManifest(nativeManifest, nativeFactsByConversation, commandStateForRestore);
      assertNativeReconciliationReady(existingV2, nativeFactsByConversation, args.attachmentsRoot);
    }
    if (externalV2.length > 0 && !nativeManifest) {
      throw new Error(
        "Maintenance cutover found existing V2 data that is not owned by a resumable migration. " +
          "Export a native maintenance manifest and rerun with --reconcile-native-manifest after defining its conservation policy. " +
          JSON.stringify(externalV2),
      );
    }
    if (nativeManifest) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const threadId of threadIds) {
          for (const fact of nativeFactsByConversation.get(threadId) ?? []) {
            v2.persistNativeFactInCurrentTransaction(nativeFactToStoreFact(threadId, fact));
          }
          v2.resetConversationForMaintenanceInCurrentTransaction(threadId);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    const migrator = store.conversationV2LegacyMigrator();
    const reports = threadIds.map((threadId) => migrator.migrate(threadId));
    const restoredCommandState = nativeManifest
      ? restoreCommandStateAfterRebuild(db, v2, commandStateForRestore, nativeFactsByConversation)
      : { receipts: 0, jobs: 0, checkpoints: 0 };
    const reconciledNativeFacts = nativeManifest
      ? threadIds.reduce(
          (count, threadId) =>
            count +
            reconcileNativeFactsAfterRebuild(
              store.conversationV2(),
              threadId,
              nativeFactsByConversation.get(threadId) ?? [],
              reports.find((report) => report.conversationId === threadId)?.sourceFingerprint,
              promptImageFileStore,
            ),
          0,
        )
      : 0;
    for (const threadId of threadIds) {
      const validation = migrator.inspect(threadId);
      if (!validation.canMigrate) {
        throw new Error(`Post-migration validation failed for ${threadId}: ${JSON.stringify(validation)}`);
      }
      store.conversationV2().validateIntegrity(threadId);
    }

    store.switchToV2OnlyStorage();
    const integrity = readIntegrityCheck(db);
    if (integrity !== "ok") {
      throw new Error(`SQLite integrity check failed after V2 cutover: ${integrity}`);
    }
    const remainingLegacyTables = existingTables(db, LEGACY_TABLES);
    if (remainingLegacyTables.length > 0) {
      throw new Error(`V1 tables remain after V2 cutover: ${remainingLegacyTables.join(", ")}`);
    }
    return {
      phase: "v2_only",
      conversationCount: threadIds.length,
      reports,
      backupPath,
      storageMode: store.getConversationStorageMode(),
      integrity,
      retiredTables: LEGACY_TABLES,
      ...(nativeManifest
        ? {
            nativeFactsPreserved: [...nativeFactsByConversation.values()].reduce(
              (total, facts) => total + facts.length,
              0,
            ),
            nativeFactsReconciled: reconciledNativeFacts,
            commandReceiptsRestored: restoredCommandState.receipts,
            commandJobsRestored: restoredCommandState.jobs,
            commandCheckpointsRestored: restoredCommandState.checkpoints,
          }
        : {}),
    };
  } finally {
    db.close();
  }
}

async function assertBackupPathAvailable(backupPath: string): Promise<void> {
  try {
    await fs.access(backupPath);
    throw new Error(`Backup path already exists: ${backupPath}`);
  } catch (error) {
    if (error instanceof Error && !String(error.message).includes("ENOENT")) throw error;
  }
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
}

async function runLegacyAttachmentRepair(args: Arguments): Promise<unknown> {
  if (!args.all || !args.apply || !args.backupPath) {
    throw new Error("--repair-legacy-attachments requires --all --apply and --backup <path>.");
  }
  if (!args.attachmentsRoot) {
    throw new Error("--repair-legacy-attachments requires --attachments-root <path>.");
  }
  const databasePath = path.resolve(args.dbPath);
  const backupPath = path.resolve(args.backupPath);
  if (databasePath === backupPath) {
    throw new Error("Backup path must be different from the source database path.");
  }
  await assertBackupPathAvailable(backupPath);

  const { db } = openAllMigrationDatabase(args.dbPath, false);
  try {
    assertNoActiveThreads(db);
    const promptImageFileStore = createPromptImageFileStore(args.attachmentsRoot);
    const store = new ConversationStore(db, { promptImageFileStore });
    store.initialize();
    if (store.getConversationStorageMode() !== "v2_only") {
      throw new Error("--repair-legacy-attachments is only valid for a v2_only database.");
    }
    if (!promptImageFileStore) {
      throw new Error("A durable prompt image store is required for attachment repair.");
    }

    const conversationIds = listConversationIdsIncludingV2Rows(db);
    const before = inspectExistingV2Data(db, conversationIds, args.attachmentsRoot);
    const targets = before.filter((entry) => entry.attachmentLegacyPayloads > 0);
    if (targets.length === 0) {
      return {
        phase: "v2_only",
        storageMode: "v2_only",
        integrity: readIntegrityCheck(db),
        cutoverReady: isV2OnlyAuditReady(before),
        repairedConversations: 0,
        repairedEvents: 0,
        repairedFollowUps: 0,
        repairedAttachments: 0,
        idempotent: true,
      };
    }
    const preconditionBlockers = targets.filter(
      (entry) =>
        entry.nativeUnmatchedEvents > 0 ||
        entry.attachmentParseErrors > 0 ||
        entry.attachmentMissingFiles > 0 ||
        (entry.attachmentPathRefs > 0 &&
          entry.attachmentPathContentHashes.length !== entry.attachmentPathRefs),
    );
    if (preconditionBlockers.length > 0) {
      throw new Error(
        "Attachment repair requires readable, hash-verified canonical payloads: " +
          JSON.stringify(preconditionBlockers),
      );
    }

    await vacuumInto(db, backupPath);
    const v2 = store.conversationV2();
    let repairedEvents = 0;
    let repairedFollowUps = 0;
    let repairedAttachments = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const target of targets) {
        const result = rewriteCanonicalAttachmentPayloads(db, target.conversationId, promptImageFileStore);
        repairedEvents += result.events;
        repairedFollowUps += result.followUps;
        repairedAttachments += result.attachments;
        if (result.events > 0) v2.rebuildReadModelsInCurrentTransaction(target.conversationId);
      }
      const after = inspectExistingV2Data(db, conversationIds, args.attachmentsRoot);
      if (!isV2OnlyAuditReady(after)) {
        throw new Error(
          "Attachment repair did not produce a V2-only-ready database: " +
            JSON.stringify(after.filter((entry) => !isV2OnlyAuditReady([entry]))),
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original repair failure.
      }
      throw error;
    }

    for (const threadId of conversationIds) v2.validateIntegrity(threadId);
    const after = inspectExistingV2Data(db, conversationIds, args.attachmentsRoot);
    const integrity = readIntegrityCheck(db);
    if (integrity !== "ok")
      throw new Error(`SQLite integrity check failed after attachment repair: ${integrity}`);
    return {
      phase: "v2_only",
      storageMode: "v2_only",
      integrity,
      cutoverReady: isV2OnlyAuditReady(after),
      backupPath,
      repairedConversations: targets.length,
      repairedEvents,
      repairedFollowUps,
      repairedAttachments,
      before: summarizeAttachmentRepairInventory(before),
      after: summarizeAttachmentRepairInventory(after),
    };
  } finally {
    db.close();
  }
}

function rewriteCanonicalAttachmentPayloads(
  db: DatabaseSync,
  conversationId: string,
  promptImageFileStore: PromptImageFileStore,
): { events: number; followUps: number; attachments: number } {
  const messageRows = db
    .prepare(
      `SELECT message_id, attachments_json
       FROM conversation_messages_v2
       WHERE conversation_id = ? AND attachments_json IS NOT NULL AND length(trim(attachments_json)) > 2`,
    )
    .all(conversationId) as Array<{ message_id?: string; attachments_json?: string | null }>;
  const eventRows = db
    .prepare(
      `SELECT conversation_id, seq, event_id, type, turn_id, run_id, message_id,
              tool_call_id, agent_id, agent_instance_id, parent_agent_instance_id,
              parent_agent_id, parent_tool_call_id, occurred_at, source_event_key, payload_json
       FROM conversation_events_v2
       WHERE conversation_id = ? AND payload_json LIKE '%attachments%'
       ORDER BY seq ASC`,
    )
    .all(conversationId) as Array<StoredAttachmentEventRow>;
  const followUpRows = tableExists(db, "conversation_followups_v2")
    ? (db
        .prepare(
          `SELECT id, thread_id, attachments_json
           FROM conversation_followups_v2
           WHERE thread_id = ? AND attachments_json IS NOT NULL AND length(trim(attachments_json)) > 2
           ORDER BY id ASC`,
        )
        .all(conversationId) as Array<{
        id: string;
        thread_id: string;
        attachments_json: string | null;
      }>)
    : [];
  const eventMessageIds = new Set(
    eventRows
      .map((row) => row.message_id)
      .filter((messageId): messageId is string => typeof messageId === "string" && messageId.length > 0),
  );
  for (const row of messageRows) {
    if (!row.message_id) continue;
    const attachments = parseAttachmentJsonForRepair(row.attachments_json, `message:${row.message_id}`);
    if (attachments.some(attachmentNeedsNormalization) && !eventMessageIds.has(row.message_id)) {
      throw new Error(
        `Canonical message attachment has no replayable event: ${conversationId}/${row.message_id}`,
      );
    }
  }

  let events = 0;
  let followUps = 0;
  let attachments = 0;
  const update = db.prepare(
    `UPDATE conversation_events_v2 SET payload_json = ?, event_hash = ?
     WHERE conversation_id = ? AND seq = ?`,
  );
  for (const row of eventRows) {
    const payload = parseJsonObjectForRepair(row.payload_json, `event:${conversationId}/${row.seq}`);
    if (!Object.hasOwn(payload, "attachments")) continue;
    const current = payload.attachments;
    const currentAttachments = parseAttachmentValueForRepair(current, `event:${conversationId}/${row.seq}`);
    const sanitized = sanitizeNativeMessageAttachments(
      currentAttachments,
      promptImageFileStore,
      conversationId,
      row.event_id,
    );
    const changed = stableHash(currentAttachments) !== stableHash(sanitized);
    if (!changed) continue;
    const nextPayload = { ...payload, attachments: sanitized };
    update.run(JSON.stringify(nextPayload), eventHashForStoredRow(row, nextPayload), conversationId, row.seq);
    events += 1;
    attachments += currentAttachments.filter(attachmentNeedsNormalization).length;
  }
  const updateFollowUp = db.prepare(
    `UPDATE conversation_followups_v2 SET attachments_json = ? WHERE id = ? AND thread_id = ?`,
  );
  for (const row of followUpRows) {
    const currentAttachments = parseAttachmentJsonForRepair(
      row.attachments_json,
      `followup:${conversationId}/${row.id}`,
    );
    const sanitized = sanitizeNativeMessageAttachments(
      currentAttachments,
      promptImageFileStore,
      conversationId,
      `followup:${row.id}`,
    );
    const changed = stableHash(currentAttachments) !== stableHash(sanitized);
    if (!changed) continue;
    updateFollowUp.run(JSON.stringify(sanitized), row.id, row.thread_id);
    followUps += 1;
    attachments += currentAttachments.filter(attachmentNeedsNormalization).length;
  }
  return { events, followUps, attachments };
}

interface StoredAttachmentEventRow {
  conversation_id: string;
  seq: number;
  event_id: string;
  type: string;
  turn_id: string | null;
  run_id: string | null;
  message_id: string | null;
  tool_call_id: string | null;
  agent_id: string | null;
  agent_instance_id: string | null;
  parent_agent_instance_id: string | null;
  parent_agent_id: string | null;
  parent_tool_call_id: string | null;
  occurred_at: string;
  source_event_key: string | null;
  payload_json: string;
}

function parseJsonObjectForRepair(value: string, context: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Canonical event payload is invalid JSON: ${context}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Canonical event payload is not an object: ${context}`);
  }
  return parsed as Record<string, unknown>;
}

function parseAttachmentJsonForRepair(value: string | null | undefined, context: string): unknown[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Canonical message attachment JSON is invalid: ${context}`);
  }
  return parseAttachmentValueForRepair(parsed, context);
}

function parseAttachmentValueForRepair(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Canonical attachments are not an array: ${context}`);
  return value;
}

function attachmentNeedsNormalization(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const record = value as Record<string, unknown>;
  const hasPath = typeof record.path === "string" && record.path.trim().length > 0;
  const hasData = typeof record.data === "string" && record.data.trim().length > 0;
  const contentRef = typeof record.contentRef === "string" ? record.contentRef.trim() : "";
  return hasPath || (hasData && !/^sha256:[0-9a-f]{64}$/.test(contentRef));
}

function eventHashForStoredRow(row: StoredAttachmentEventRow, payload: Record<string, unknown>): string {
  return stableHash({
    conversationId: row.conversation_id,
    eventId: row.event_id,
    type: row.type,
    occurredAt: row.occurred_at,
    ...(row.source_event_key ? { sourceEventKey: row.source_event_key } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.agent_instance_id ? { agentInstanceId: row.agent_instance_id } : {}),
    ...(row.parent_agent_instance_id ? { parentAgentInstanceId: row.parent_agent_instance_id } : {}),
    ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
    ...(row.parent_tool_call_id ? { parentToolCallId: row.parent_tool_call_id } : {}),
    payload,
  });
}

function summarizeAttachmentRepairInventory(inventories: readonly ExistingV2Inventory[]): {
  legacyPayloads: number;
  pathRefs: number;
  inlineBytes: number;
} {
  return inventories.reduce(
    (summary, entry) => ({
      legacyPayloads: summary.legacyPayloads + entry.attachmentLegacyPayloads,
      pathRefs: summary.pathRefs + entry.attachmentPathRefs,
      inlineBytes: summary.inlineBytes + entry.attachmentInlineBytes,
    }),
    { legacyPayloads: 0, pathRefs: 0, inlineBytes: 0 },
  );
}

function assertNativeReconciliationReady(
  inventories: readonly ExistingV2Inventory[],
  factsByConversation: ReadonlyMap<string, readonly NativeEventFact[]>,
  attachmentsRoot?: string,
): void {
  const blockers: Array<Record<string, unknown>> = [];
  for (const inventory of inventories) {
    const facts = factsByConversation.get(inventory.conversationId) ?? [];
    const unmatched = facts.filter((fact) => fact.disposition === "unmatched");
    const attachmentErrors = facts.filter(
      (fact) =>
        fact.attachmentSummary.missingFiles > 0 ||
        fact.attachmentSummary.parseErrors > 0 ||
        (fact.attachmentSummary.pathRefs > 0 &&
          (!attachmentsRoot ||
            fact.attachmentSummary.pathContentHashes.length !== fact.attachmentSummary.pathRefs)),
    );
    if (unmatched.length > 0 || attachmentErrors.length > 0) {
      blockers.push({
        conversationId: inventory.conversationId,
        unmatched: unmatched.map((fact) => ({ eventId: fact.eventId, reason: fact.reconciliationReason })),
        attachmentErrors: attachmentErrors.map((fact) => ({
          eventId: fact.eventId,
          attachmentSummary: fact.attachmentSummary,
          reason:
            fact.attachmentSummary.pathRefs > 0 &&
            (!attachmentsRoot ||
              fact.attachmentSummary.pathContentHashes.length !== fact.attachmentSummary.pathRefs)
              ? "attachment_content_hash_unverified"
              : undefined,
        })),
      });
    }
  }
  if (blockers.length > 0) {
    throw new Error(
      "Native reconciliation is not lossless: every native fact must be matched and every attachment must be readable and content-hashed. " +
        JSON.stringify(blockers),
    );
  }
}

function readNativeFactsForMaintenance(
  store: ConversationV2Store,
  db: DatabaseSync,
  conversationId: string,
  attachmentsRoot?: string,
): NativeEventFact[] {
  const live = inspectNativeReconciliation(db, conversationId, attachmentsRoot).facts;
  if (live.length > 0) return live;
  // A process can die after the native-facts ledger is committed and after the
  // rebuildable V2 rows are cleared, but before migration finishes. On the next
  // invocation the event log is intentionally empty; the ledger is the durable
  // V2 recovery source and carries the exact original hashes/classification.
  return store.listNativeFacts(conversationId).map((fact) => {
    const parsed = parseJsonValue(fact.payloadJson);
    let attachmentSummary: AttachmentSummary;
    try {
      const value = JSON.parse(fact.attachmentSummaryJson) as unknown;
      attachmentSummary = normalizeAttachmentSummary(value) ?? emptyAttachmentSummary();
    } catch {
      attachmentSummary = emptyAttachmentSummary();
    }
    attachmentSummary = attachmentSummaryForStoredFact(
      attachmentSummary,
      parsed,
      fact.payloadJson,
      attachmentsRoot,
    );
    return {
      seq: fact.nativeSeq,
      eventId: fact.eventId,
      type: fact.type,
      turnId: fact.turnId ?? null,
      runId: fact.runId ?? null,
      messageId: fact.messageId ?? null,
      toolCallId: fact.toolCallId ?? null,
      agentId: fact.agentId ?? null,
      agentInstanceId: fact.agentInstanceId ?? null,
      parentAgentInstanceId: fact.parentAgentInstanceId ?? null,
      parentAgentId: fact.parentAgentId ?? null,
      parentToolCallId: fact.parentToolCallId ?? null,
      occurredAt: fact.occurredAt,
      recordedAt: fact.recordedAt,
      schemaVersion: fact.schemaVersion,
      sourceEventKey: fact.sourceEventKey ?? null,
      payloadJson: fact.payloadJson,
      payload: parsed === undefined ? null : parsed,
      payloadParseError: parsed === undefined,
      payloadHash: fact.payloadHash,
      eventHash: fact.eventHash,
      disposition: fact.disposition,
      ...(fact.matchedSourceId ? { matchedSourceId: fact.matchedSourceId } : {}),
      ...(fact.reconciliationReason ? { reconciliationReason: fact.reconciliationReason } : {}),
      attachmentSummary,
    };
  });
}

function readNativeFactsLedger(
  db: DatabaseSync,
  conversationId: string,
  attachmentsRoot?: string,
): NativeEventFact[] {
  const rows = db
    .prepare(
      `SELECT native_seq, event_id, type, turn_id, run_id, message_id, tool_call_id,
              agent_id, agent_instance_id, parent_agent_instance_id, parent_agent_id,
              parent_tool_call_id, occurred_at, recorded_at, schema_version, source_event_key,
              payload_json, payload_hash, event_hash, disposition, matched_source_id,
              reconciliation_reason, attachment_summary_json
         FROM conversation_native_facts_v2
        WHERE conversation_id = ?
        ORDER BY native_seq ASC`,
    )
    .all(conversationId) as Array<{
    native_seq: number;
    event_id: string;
    type: string;
    turn_id: string | null;
    run_id: string | null;
    message_id: string | null;
    tool_call_id: string | null;
    agent_id: string | null;
    agent_instance_id: string | null;
    parent_agent_instance_id: string | null;
    parent_agent_id: string | null;
    parent_tool_call_id: string | null;
    occurred_at: string;
    recorded_at: string;
    schema_version: number;
    source_event_key: string | null;
    payload_json: string;
    payload_hash: string;
    event_hash: string;
    disposition: NativeEventFact["disposition"];
    matched_source_id: string | null;
    reconciliation_reason: string | null;
    attachment_summary_json: string;
  }>;
  return rows.map((row) => {
    const payload = parseJsonValue(row.payload_json);
    let attachmentSummary: AttachmentSummary;
    try {
      const parsed = JSON.parse(row.attachment_summary_json) as unknown;
      attachmentSummary = normalizeAttachmentSummary(parsed) ?? emptyAttachmentSummary();
    } catch {
      attachmentSummary = emptyAttachmentSummary();
    }
    attachmentSummary = attachmentSummaryForStoredFact(
      attachmentSummary,
      payload,
      row.payload_json,
      attachmentsRoot,
    );
    return {
      seq: row.native_seq,
      eventId: row.event_id,
      type: row.type,
      turnId: row.turn_id,
      runId: row.run_id,
      messageId: row.message_id,
      toolCallId: row.tool_call_id,
      agentId: row.agent_id,
      agentInstanceId: row.agent_instance_id,
      parentAgentInstanceId: row.parent_agent_instance_id,
      parentAgentId: row.parent_agent_id,
      parentToolCallId: row.parent_tool_call_id,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      schemaVersion: row.schema_version,
      sourceEventKey: row.source_event_key,
      payloadJson: row.payload_json,
      payload: payload === undefined ? null : payload,
      payloadParseError: payload === undefined,
      payloadHash: row.payload_hash,
      eventHash: row.event_hash,
      disposition: row.disposition,
      ...(row.matched_source_id ? { matchedSourceId: row.matched_source_id } : {}),
      ...(row.reconciliation_reason ? { reconciliationReason: row.reconciliation_reason } : {}),
      attachmentSummary,
    };
  });
}

function attachmentSummaryForStoredFact(
  stored: AttachmentSummary,
  payload: unknown,
  rawPayload: string,
  attachmentsRoot?: string,
): AttachmentSummary {
  if (attachmentsRoot) {
    return attachmentSummaryForPayload(payload, rawPayload, attachmentsRoot);
  }
  // A persisted native-facts hash proves what was observed during the original
  // maintenance window, not what is currently on disk. Without the caller's
  // attachment root, discard path hashes so manifest verification cannot silently
  // trust stale file content.
  return { ...stored, pathContentHashes: [] };
}

function verifyNativeFactsAgainstManifest(
  expected: NativeMaintenanceManifest,
  factsByConversation: ReadonlyMap<string, readonly NativeEventFact[]>,
  commandState: readonly CommandStateMaintenance[],
): void {
  const currentConversations = [...factsByConversation.entries()].map(([conversationId, nativeEvents]) => ({
    conversationId,
    nativeEvents,
  }));
  const currentFacts = {
    schemaVersion: 1 as const,
    conversationCount: currentConversations.length,
    nativeEventCount: currentConversations.reduce(
      (total, conversation) => total + conversation.nativeEvents.length,
      0,
    ),
    commandState,
    conversations: currentConversations,
  };
  const expectedFacts = nativeManifestFacts(expected);
  const currentHash = stableHash(currentFacts);
  const expectedHash = stableHash(expectedFacts);
  if (expectedHash !== currentHash) {
    throw new Error(
      `Native maintenance manifest facts mismatch: expected ${expectedHash}, current ${currentHash}; ` +
        `expectedEvents=${expected.nativeEventCount}, currentEvents=${currentFacts.nativeEventCount}`,
    );
  }
  if (expected.integrity !== "ok") {
    throw new Error(
      `Native maintenance manifest was generated from an unhealthy database: ${expected.integrity}`,
    );
  }
}

function selectCommandStateForMaintenance(
  expected: readonly CommandStateMaintenance[],
  current: readonly CommandStateMaintenance[],
  factsByConversation: ReadonlyMap<string, readonly NativeEventFact[]>,
): CommandStateMaintenance[] {
  if (stableHash(current) === stableHash(expected)) return [...current];
  if (current.length > 0 || expected.length === 0) {
    throw new Error(
      `Native maintenance manifest command state mismatch: expected=${stableHash(expected)}, current=${stableHash(current)}`,
    );
  }
  // A process may die after the immutable native ledger and maintenance reset have
  // committed but before command rows are restored. In that one recovery window the
  // old command tables are empty; only accept the manifest as a source if every
  // referenced acceptance event is still present in the ledger. A newly accepted
  // command keeps a live row and therefore takes the strict mismatch path above.
  for (const state of expected) {
    const facts = new Set(
      (factsByConversation.get(state.conversationId) ?? [])
        .filter((fact) => isCommandAcceptanceFact(fact))
        .map((fact) => fact.eventId),
    );
    for (const receipt of state.receipts) {
      if (!facts.has(receipt.acceptedEventId)) {
        throw new Error(
          `Native maintenance manifest command receipt cannot be recovered: ${state.conversationId}/${receipt.clientCommandId}`,
        );
      }
    }
    for (const job of state.jobs) {
      if (!facts.has(job.acceptedEventId)) {
        throw new Error(
          `Native maintenance manifest command job cannot be recovered: ${state.conversationId}/${job.clientCommandId}`,
        );
      }
    }
  }
  return expected.map((state) => ({
    conversationId: state.conversationId,
    historyRevision: state.historyRevision,
    receipts: [...state.receipts],
    jobs: [...state.jobs],
    checkpoints: [...state.checkpoints],
  }));
}

function restoreCommandStateAfterRebuild(
  db: DatabaseSync,
  store: ConversationV2Store,
  commandState: readonly CommandStateMaintenance[],
  factsByConversation: ReadonlyMap<string, readonly NativeEventFact[]>,
): { receipts: number; jobs: number; checkpoints: number } {
  if (commandState.length === 0) {
    // Even a command event without a currently visible row is a durable V2 fact.
    // Re-append it so an interrupted maintenance run cannot silently erase the
    // acceptance audit trail.
    const orphanFacts = [...factsByConversation.values()]
      .flat()
      .filter((fact) => isCommandAcceptanceFact(fact))
      .sort((left, right) => left.seq - right.seq);
    if (orphanFacts.length === 0) return { receipts: 0, jobs: 0, checkpoints: 0 };
  }
  const eventsByConversation = new Map<string, Map<string, number>>();
  const restored = { receipts: 0, jobs: 0, checkpoints: 0 };
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [conversationId, facts] of factsByConversation.entries()) {
      const commandFacts = facts
        .filter((fact) => isCommandAcceptanceFact(fact))
        .sort((left, right) => left.seq - right.seq);
      if (commandFacts.length === 0) continue;
      const eventMap = new Map<string, number>();
      for (const fact of commandFacts) {
        const existing = db
          .prepare(
            `SELECT seq, event_hash, type, source_event_key
               FROM conversation_events_v2
              WHERE conversation_id = ? AND event_id = ?`,
          )
          .get(conversationId, fact.eventId) as
          | { seq: number; event_hash: string; type: string; source_event_key: string | null }
          | undefined;
        if (existing) {
          if (
            existing.event_hash !== fact.eventHash ||
            existing.type !== fact.type ||
            existing.source_event_key !== fact.sourceEventKey
          ) {
            throw new Error(
              `Command acceptance event changed during maintenance: ${conversationId}/${fact.eventId}`,
            );
          }
          eventMap.set(fact.eventId, existing.seq);
          continue;
        }
        const payload = asJsonObject(fact.payload);
        if (!payload) {
          throw new Error(`Command acceptance event payload is invalid: ${conversationId}/${fact.eventId}`);
        }
        const result = store.appendInCurrentTransaction({
          conversationId,
          eventId: fact.eventId,
          type: fact.type as ConversationEventInput["type"],
          occurredAt: fact.occurredAt,
          ...(fact.sourceEventKey ? { sourceEventKey: fact.sourceEventKey } : {}),
          ...(fact.turnId ? { turnId: fact.turnId } : {}),
          ...(fact.runId ? { runId: fact.runId } : {}),
          ...(fact.messageId ? { messageId: fact.messageId } : {}),
          ...(fact.toolCallId ? { toolCallId: fact.toolCallId } : {}),
          ...(fact.agentId ? { agentId: fact.agentId } : {}),
          ...(fact.agentInstanceId ? { agentInstanceId: fact.agentInstanceId } : {}),
          ...(fact.parentAgentInstanceId ? { parentAgentInstanceId: fact.parentAgentInstanceId } : {}),
          ...(fact.parentAgentId ? { parentAgentId: fact.parentAgentId } : {}),
          ...(fact.parentToolCallId ? { parentToolCallId: fact.parentToolCallId } : {}),
          payload,
        });
        if (result.event.eventHash !== fact.eventHash) {
          throw new Error(
            `Command acceptance event hash changed during maintenance: ${conversationId}/${fact.eventId}`,
          );
        }
        eventMap.set(fact.eventId, result.event.seq);
      }
      eventsByConversation.set(conversationId, eventMap);
    }

    for (const state of commandState) {
      const stream = db
        .prepare(`SELECT history_revision FROM conversation_streams_v2 WHERE conversation_id = ?`)
        .get(state.conversationId) as { history_revision?: number } | undefined;
      if (!stream || stream.history_revision !== state.historyRevision) {
        throw new Error(
          `Conversation history revision changed while restoring V2 commands: ${state.conversationId}`,
        );
      }
      const eventMap = eventsByConversation.get(state.conversationId) ?? new Map<string, number>();
      const acceptedSeqFor = (eventId: string): number => {
        const seq = eventMap.get(eventId);
        if (!seq)
          throw new Error(`Command acceptance event was not preserved: ${state.conversationId}/${eventId}`);
        return seq;
      };
      for (const receipt of state.receipts) {
        const acceptedSeq = acceptedSeqFor(receipt.acceptedEventId);
        const result = asJsonObject(parseJsonValue(receipt.resultJson));
        if (!result) throw new Error(`Command receipt result is not an object: ${state.conversationId}`);
        const resultJson = JSON.stringify({ ...result, acceptedSeq });
        db.prepare(
          `INSERT INTO conversation_command_receipts_v2
           (principal_id, conversation_id, client_command_id, request_hash, result_json, accepted_seq)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          receipt.principalId,
          receipt.conversationId,
          receipt.clientCommandId,
          receipt.requestHash,
          resultJson,
          acceptedSeq,
        );
        restored.receipts += 1;
      }
      for (const job of state.jobs) {
        const acceptedSeq = acceptedSeqFor(job.acceptedEventId);
        db.prepare(
          `INSERT INTO conversation_command_jobs_v2
           (principal_id, conversation_id, client_command_id, command_type,
            request_hash, request_json, expected_history_revision, status,
            result_json, error_json, accepted_seq, accepted_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          job.principalId,
          job.conversationId,
          job.clientCommandId,
          job.commandType,
          job.requestHash,
          job.requestJson,
          job.expectedHistoryRevision,
          job.status,
          job.resultJson,
          job.errorJson,
          acceptedSeq,
          job.acceptedAt,
          job.updatedAt,
        );
        restored.jobs += 1;
      }
      for (const checkpoint of state.checkpoints) {
        db.prepare(
          `INSERT INTO conversation_command_checkpoints_v2
           (principal_id, conversation_id, client_command_id, ordinal, name,
            payload_hash, payload_json, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          checkpoint.principalId,
          checkpoint.conversationId,
          checkpoint.clientCommandId,
          checkpoint.ordinal,
          checkpoint.name,
          checkpoint.payloadHash,
          checkpoint.payloadJson,
          checkpoint.recordedAt,
        );
        restored.checkpoints += 1;
      }
      store.validateCommandState(state.conversationId);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return restored;
}

function isCommandAcceptanceFact(fact: NativeEventFact): boolean {
  return (
    (fact.type === "message.accepted" && fact.sourceEventKey?.startsWith("command:")) ||
    (fact.type === "noop" && fact.sourceEventKey?.startsWith("command-job:"))
  );
}

function emptyAttachmentSummary(): AttachmentSummary {
  return { refs: 0, inlineBytes: 0, pathRefs: 0, missingFiles: 0, parseErrors: 0, pathContentHashes: [] };
}

function isAttachmentSummary(value: unknown): value is AttachmentSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  if (
    !["refs", "inlineBytes", "pathRefs", "missingFiles", "parseErrors"].every(
      (key) => typeof summary[key] === "number" && Number.isFinite(summary[key]),
    )
  ) {
    return false;
  }
  const hashes = summary.pathContentHashes;
  return (
    hashes === undefined ||
    (Array.isArray(hashes) &&
      hashes.every(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          typeof (entry as { path?: unknown }).path === "string" &&
          /^[a-f0-9]{64}$/.test(String((entry as { sha256?: unknown }).sha256 ?? "")),
      ))
  );
}

function normalizeAttachmentSummary(value: unknown): AttachmentSummary | undefined {
  if (!isAttachmentSummary(value)) return undefined;
  const summary = value as Partial<AttachmentSummary>;
  return {
    refs: Number(summary.refs),
    inlineBytes: Number(summary.inlineBytes),
    pathRefs: Number(summary.pathRefs),
    missingFiles: Number(summary.missingFiles),
    parseErrors: Number(summary.parseErrors),
    pathContentHashes: Array.isArray(summary.pathContentHashes)
      ? summary.pathContentHashes.map((entry) => ({
          path: entry.path,
          sha256: entry.sha256,
        }))
      : [],
  };
}

function nativeFactToStoreFact(conversationId: string, fact: NativeEventFact): ConversationNativeFact {
  return {
    conversationId,
    nativeSeq: fact.seq,
    eventId: fact.eventId,
    type: fact.type,
    turnId: fact.turnId,
    runId: fact.runId,
    messageId: fact.messageId,
    toolCallId: fact.toolCallId,
    agentId: fact.agentId,
    agentInstanceId: fact.agentInstanceId,
    parentAgentInstanceId: fact.parentAgentInstanceId,
    parentAgentId: fact.parentAgentId,
    parentToolCallId: fact.parentToolCallId,
    occurredAt: fact.occurredAt,
    recordedAt: fact.recordedAt,
    schemaVersion: fact.schemaVersion,
    sourceEventKey: fact.sourceEventKey,
    payloadJson: fact.payloadJson,
    payloadHash: fact.payloadHash,
    eventHash: fact.eventHash,
    disposition: fact.disposition,
    matchedSourceId: fact.matchedSourceId,
    reconciliationReason: fact.reconciliationReason,
    attachmentSummaryJson: JSON.stringify(fact.attachmentSummary),
  };
}

function reconcileNativeFactsAfterRebuild(
  store: ConversationV2Store,
  conversationId: string,
  facts: readonly NativeEventFact[],
  sourceFingerprint: string | undefined,
  promptImageFileStore: PromptImageFileStore | undefined,
): number {
  if (facts.length === 0) return 0;
  if (!sourceFingerprint) {
    throw new Error(`Missing migration source fingerprint for native reconciliation: ${conversationId}`);
  }
  let reconciled = 0;
  for (const fact of facts) {
    if (fact.disposition !== "modified") continue;
    const payload = asJsonObject(fact.payload);
    if (!payload) {
      throw new Error(`Native fact payload is not an object: ${conversationId}/${fact.eventId}`);
    }
    if (fact.type === "message.created" && fact.matchedSourceId) {
      const messageId = `migration_message_${stableHash(`${sourceFingerprint}:${fact.matchedSourceId}`)}`;
      const body =
        typeof payload.body === "string"
          ? payload.body
          : typeof payload.text === "string"
            ? payload.text
            : undefined;
      if (body === undefined) {
        throw new Error(`Modified native message has no body: ${conversationId}/${fact.eventId}`);
      }
      const status = payload.status === "failed" || payload.status === "cancelled" ? payload.status : "final";
      const attachments = sanitizeNativeMessageAttachments(
        payload.attachments,
        promptImageFileStore,
        conversationId,
        fact.eventId,
      );
      const result = store.append({
        conversationId,
        eventId: `maintenance_native_${stableHash(`${conversationId}:${fact.eventId}`)}`,
        sourceEventKey: `maintenance:native:${fact.eventId}`,
        type: "message.finalized",
        occurredAt: fact.occurredAt,
        messageId,
        turnId: `migration_turn_${stableHash(`${sourceFingerprint}:${fact.matchedSourceId}`)}`,
        payload: {
          authority: "maintenance",
          body,
          status,
          ...(attachments ? { attachments } : {}),
        },
      });
      if (!result.duplicate) reconciled += 1;
      continue;
    }
    if (
      (fact.type === "run.started" ||
        fact.type === "run.completed" ||
        fact.type === "run.failed" ||
        fact.type === "run.cancelled" ||
        fact.type === "run.interrupted") &&
      fact.runId
    ) {
      const result = store.append({
        conversationId,
        eventId: `maintenance_native_${stableHash(`${conversationId}:${fact.eventId}`)}`,
        sourceEventKey: `maintenance:native:${fact.eventId}`,
        type: fact.type as ConversationEventInput["type"],
        occurredAt: fact.occurredAt,
        turnId: fact.turnId ?? fact.runId,
        runId: fact.runId,
        payload: { ...payload, authority: "lifecycle" },
      });
      if (!result.duplicate) reconciled += 1;
      continue;
    }
    if (fact.type === "run.corrected" && fact.runId) {
      const result = store.append({
        conversationId,
        eventId: fact.eventId,
        ...(fact.sourceEventKey ? { sourceEventKey: fact.sourceEventKey } : {}),
        type: "run.corrected",
        occurredAt: fact.occurredAt,
        turnId: fact.turnId ?? fact.runId,
        runId: fact.runId,
        payload,
      });
      if (result.event.eventHash !== fact.eventHash) {
        throw new Error(
          `Admin run correction event hash changed during maintenance: ${conversationId}/${fact.eventId}`,
        );
      }
      if (!result.duplicate) reconciled += 1;
      continue;
    }
    throw new Error(
      `Modified native fact has no deterministic V2 patch rule: ${conversationId}/${fact.eventId}/${fact.type}`,
    );
  }
  return reconciled;
}

function sanitizeNativeMessageAttachments(
  value: unknown,
  promptImageFileStore: PromptImageFileStore | undefined,
  conversationId: string,
  eventId: string,
): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Modified native message attachments are not an array: ${conversationId}/${eventId}`);
  }
  if (value.length === 0) return [];
  if (!promptImageFileStore) {
    throw new Error(
      `Durable prompt image store is required for modified native message attachments: ${conversationId}/${eventId}`,
    );
  }
  return value.map((attachment, index) => {
    if (isPromptImageAttachmentRecord(attachment)) {
      return promptImageFileStore.persistAttachmentForMigration(attachment);
    }
    if (!isLegacyOpaqueAttachmentRecord(attachment)) {
      throw new Error(`Modified native attachment is invalid: ${conversationId}/${eventId}:${index}`);
    }
    const metadata = promptImageFileStore.validateLegacyAttachmentForMigration(attachment);
    return sanitizeLegacyOpaqueAttachment(attachment, metadata);
  });
}

function isLegacyOpaqueAttachmentRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const mediaType = typeof record.mediaType === "string" ? record.mediaType.trim() : "";
  const filePath = typeof record.path === "string" ? record.path.trim() : "";
  const data = typeof record.data === "string" ? record.data.trim() : "";
  if (record.legacyOpaque === true) return Boolean(id || mediaType);
  return Boolean((id || mediaType) && (id || filePath || data));
}

function sanitizeLegacyOpaqueAttachment(
  value: Record<string, unknown>,
  metadata: { byteLength?: number },
): Record<string, unknown> {
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const mediaType = typeof value.mediaType === "string" ? value.mediaType.trim() : "";
  const byteLength =
    Number.isSafeInteger(value.byteLength) && Number(value.byteLength) >= 0
      ? Number(value.byteLength)
      : metadata.byteLength;
  return {
    ...(id ? { id } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(byteLength !== undefined ? { byteLength } : {}),
    legacyOpaque: true,
  };
}

function listThreadIds(db: DatabaseSync): string[] {
  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'`)
    .get() as { name?: string } | undefined;
  if (!table?.name) throw new Error("The database has no threads table.");
  return (db.prepare(`SELECT id FROM threads ORDER BY id ASC`).all() as Array<{ id: string }>).map(
    (row) => row.id,
  );
}

/**
 * V2-only verification must inventory durable rows even when their public
 * thread metadata row was deleted or never created. A missing `threads` row is
 * an integrity finding, not permission to omit the stream from the audit.
 */
function listConversationIdsIncludingV2Rows(db: DatabaseSync): string[] {
  const ids = new Set(listThreadIds(db));
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'conversation_%_v2'
       ORDER BY name`,
    )
    .all() as Array<{ name?: string }>;
  for (const table of tables) {
    const tableName = typeof table.name === "string" ? table.name : "";
    if (!tableName) continue;
    const columns = db.prepare(`PRAGMA table_info("${tableName.replaceAll('"', '""')}")`).all() as Array<{
      name?: string;
    }>;
    const idColumn = columns.some((column) => column.name === "conversation_id")
      ? "conversation_id"
      : columns.some((column) => column.name === "thread_id")
        ? "thread_id"
        : undefined;
    if (!idColumn) continue;
    const quotedTable = `"${tableName.replaceAll('"', '""')}"`;
    const rows = db
      .prepare(
        `SELECT DISTINCT ${idColumn} AS conversation_id
         FROM ${quotedTable}
         WHERE ${idColumn} IS NOT NULL AND length(trim(${idColumn})) > 0`,
      )
      .all() as Array<{ conversation_id?: string | null }>;
    for (const row of rows) {
      const id = typeof row.conversation_id === "string" ? row.conversation_id.trim() : "";
      if (id) ids.add(id);
    }
  }
  return [...ids].sort();
}

function openAllMigrationDatabase(
  dbPath: string,
  readOnly: boolean,
): { db: DatabaseSync; threadIds: string[] } {
  let lastError: unknown;
  let queryOnlyFallback = false;
  // A read-only verifier may start immediately after a short-lived writer. On
  // macOS SQLite can open the database handle successfully and still return
  // SQLITE_CANTOPEN on the first sqlite_master read while the WAL shared-memory
  // file is being checkpointed. Reopen the handle for each retry; retrying a
  // poisoned read-only handle never repairs that state.
  for (let attempt = 0; attempt < 240; attempt += 1) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: readOnly && !queryOnlyFallback });
      db.exec("PRAGMA busy_timeout = 5000");
      if (readOnly) {
        // Bun/SQLite can leave a WAL shared-memory reader slot that prevents a
        // fresh read-only process from opening sqlite_master after several
        // short-lived verifiers. If that transient condition persists, keep
        // the connection write-protected even when the fallback handle must be
        // opened as writable in order to repair the WAL lock state.
        db.exec("PRAGMA query_only = ON");
      }
      return { db, threadIds: listThreadIds(db) };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("unable to open database file") && !message.includes("database is locked")) {
        try {
          db?.close();
        } catch {
          // Preserve the original maintenance error.
        }
        throw error;
      }
      try {
        db?.close();
      } catch {
        // The next attempt opens a fresh handle regardless.
      }
      if (readOnly && attempt >= 7) queryOnlyFallback = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  throw lastError;
}

function assertNoActiveThreads(db: DatabaseSync): void {
  listThreadIds(db);
  const placeholders = ACTIVE_THREAD_STATUSES.map(() => "?").join(", ");
  const active = db
    .prepare(`SELECT id, status FROM threads WHERE status IN (${placeholders}) ORDER BY id ASC`)
    .all(...ACTIVE_THREAD_STATUSES) as Array<{ id: string; status: string }>;
  if (active.length > 0) {
    throw new Error(
      `Maintenance cutover requires all active threads to be stopped: ${active
        .map((row) => `${row.id}:${row.status}`)
        .join(", ")}`,
    );
  }
}

function vacuumInto(db: DatabaseSync, backupPath: string): void {
  const escaped = backupPath.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
}

function existingTables(db: DatabaseSync, names: readonly string[]): string[] {
  const placeholders = names.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (${placeholders})
       ORDER BY name`,
    )
    .all(...names) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function inspectExistingV2Data(
  db: DatabaseSync,
  conversationIds: readonly string[],
  attachmentsRoot?: string,
): ExistingV2Inventory[] {
  if (!tableExists(db, "conversation_streams_v2")) return [];
  return conversationIds
    .map((conversationId) => {
      const migration = tableExists(db, "conversation_migrations_v2")
        ? (db
            .prepare(
              `SELECT phase, updated_at, source_fingerprint FROM conversation_migrations_v2
               WHERE migration_version = 1 AND conversation_id = ?`,
            )
            .get(conversationId) as
            | { phase?: string; updated_at?: string; source_fingerprint?: string }
            | undefined)
        : undefined;
      const streams = countRows(db, "conversation_streams_v2", conversationId);
      const events = countRows(db, "conversation_events_v2", conversationId);
      const migrationEvents = tableExists(db, "conversation_events_v2")
        ? countRowsWhere(
            db,
            "conversation_events_v2",
            conversationId,
            "source_event_key LIKE 'migration:v1:%'",
          )
        : 0;
      const legacyCompatEvents = tableExists(db, "conversation_events_v2")
        ? countRowsWhere(db, "conversation_events_v2", conversationId, "source_event_key LIKE 'legacy:%'")
        : 0;
      const liveNativeEventCount = tableExists(db, "conversation_events_v2")
        ? countRowsWhere(
            db,
            "conversation_events_v2",
            conversationId,
            "(source_event_key IS NULL OR (source_event_key NOT LIKE 'legacy:%' AND source_event_key NOT LIKE 'migration:v1:%'))",
          )
        : 0;
      // Once V1 is retired there is no source table left to compare against.
      // Reclassifying the live maintenance patch rows against an empty V1 source
      // would turn valid post-cutover facts into false `unsupported_native_type`
      // findings. The immutable native-facts ledger is the authoritative
      // conservation record after cutover; use its stored classifications for
      // inventory while retaining the source comparison for legacy_compat.
      const storageMode = readStorageMode(db);
      const { facts: _nativeFacts, ...nativeReconciliation } = (() => {
        if (storageMode !== "v2_only" || !tableExists(db, "conversation_native_facts_v2")) {
          return inspectNativeReconciliation(db, conversationId, attachmentsRoot);
        }
        const ledgerFacts = readNativeFactsLedger(db, conversationId, attachmentsRoot);
        const ledgerSummary = summarizeNativeFacts(ledgerFacts);
        // A stream created after the one-time cutover has no V1 source and is
        // therefore intentionally absent from the maintenance ledger. Require
        // the runtime's own durable receipt/lifecycle shape before treating it
        // as post-cutover data. Also inspect rows outside a non-empty ledger:
        // cutover-era facts do not authorize unrelated extra rows in that stream.
        const postCutover = classifyPostCutoverNativeEvents(db, conversationId, migration, ledgerFacts);
        if (postCutover && postCutover.unmatchedEvents === 0) {
          return {
            ...ledgerSummary,
            nativeReconciliationIssues: [
              ...postCutover.warnings,
              ...ledgerSummary.nativeReconciliationIssues,
            ].slice(0, 100),
          };
        }
        if (postCutover && postCutover.unmatchedEvents > 0) {
          return {
            ...ledgerSummary,
            nativeUnmatchedEvents: ledgerSummary.nativeUnmatchedEvents + postCutover.unmatchedEvents,
            nativeReconciliationIssues: [
              "native_fact_ledger_missing",
              ...ledgerSummary.nativeReconciliationIssues,
            ].slice(0, 100),
          };
        }
        if (ledgerFacts.length > 0 || liveNativeEventCount === 0) return ledgerSummary;
        // The table is part of the V2 schema, so table existence alone does not
        // prove that the immutable ledger preserved the live native rows. Keep the
        // source comparison for diagnostics, but force the audit to remain
        // fail-closed when live native facts have no ledger copy.
        const missingLedger = inspectNativeReconciliation(db, conversationId, attachmentsRoot);
        missingLedger.nativeUnmatchedEvents = Math.max(1, missingLedger.nativeUnmatchedEvents);
        missingLedger.nativeReconciliationIssues = [
          "native_fact_ledger_missing",
          ...missingLedger.nativeReconciliationIssues,
        ].slice(0, 100);
        return missingLedger;
      })();
      const inventory: ExistingV2Inventory = {
        conversationId,
        ...(migration?.phase ? { migrationPhase: migration.phase } : {}),
        streams,
        events,
        migrationEvents,
        legacyCompatEvents,
        nativeEvents: Math.max(0, events - migrationEvents - legacyCompatEvents),
        ...nativeReconciliation,
        externalEvents: Math.max(0, events - migrationEvents),
        effects: countRows(db, "conversation_sync_effects_v2", conversationId),
        feedSkeletons: countRows(db, "conversation_feed_skeletons_v2", conversationId),
        ...inspectAttachmentInventory(db, conversationId, attachmentsRoot),
        providerInputs: countRows(db, "conversation_provider_inputs_v2", conversationId),
        messages: countRows(db, "conversation_messages_v2", conversationId),
        toolCalls: countRows(db, "conversation_tool_calls_v2", conversationId),
        detailItems: countRows(db, "conversation_detail_items_v2", conversationId),
        todos: countRows(db, "conversation_todos_v2", conversationId),
        commandReceipts: countRows(db, "conversation_command_receipts_v2", conversationId),
        commandJobs: countRows(db, "conversation_command_jobs_v2", conversationId),
        commandCheckpoints: countRows(db, "conversation_command_checkpoints_v2", conversationId),
        hasExternalData: false,
      };
      const hasCanonicalRows = Object.entries(inventory).some(
        ([key, value]) =>
          key !== "conversationId" &&
          key !== "migrationPhase" &&
          key !== "hasExternalData" &&
          key !== "feedSkeletons" &&
          typeof value === "number" &&
          value > 0,
      );
      const isResumableMigrationOnly =
        Boolean(migration?.phase) &&
        inventory.externalEvents === 0 &&
        inventory.commandReceipts === 0 &&
        inventory.commandJobs === 0 &&
        inventory.commandCheckpoints === 0 &&
        inventory.attachmentMissingFiles === 0 &&
        inventory.attachmentParseErrors === 0 &&
        inventory.attachmentLegacyPayloads === 0;
      // Feed skeletons are a rebuildable cache imported during startup; they do not
      // carry V2-only history and therefore never authorize reusing an old stream.
      inventory.hasExternalData = hasCanonicalRows && !isResumableMigrationOnly;
      return inventory;
    })
    .filter(
      (entry) => entry.hasExternalData || entry.streams > 0 || entry.events > 0 || entry.feedSkeletons > 0,
    );
}

interface NativeReconciliationInventory {
  nativeEquivalentEvents: number;
  nativeCollapsedEvents: number;
  nativeModifiedEvents: number;
  nativeUnmatchedEvents: number;
  nativeReconciliationIssues: string[];
}

interface NativeEventRow {
  seq: number;
  event_id: string;
  type: string;
  turn_id: string | null;
  run_id: string | null;
  message_id: string | null;
  tool_call_id: string | null;
  agent_id: string | null;
  agent_instance_id: string | null;
  parent_agent_instance_id: string | null;
  parent_agent_id: string | null;
  parent_tool_call_id: string | null;
  occurred_at: string;
  recorded_at: string;
  schema_version: number;
  source_event_key: string | null;
  payload_json: string;
  event_hash: string;
}

interface LegacyUserSourceRow {
  activity_line_id: string;
  text: string;
  attachments_json: string | null;
  created_at: string;
}

interface LegacyAttemptSourceRow {
  attempt_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
}

interface AttachmentSummary {
  refs: number;
  inlineBytes: number;
  pathRefs: number;
  missingFiles: number;
  parseErrors: number;
  pathContentHashes: AttachmentContentHash[];
}

interface AttachmentContentHash {
  path: string;
  sha256: string;
}

interface NativeEventFact {
  seq: number;
  eventId: string;
  type: string;
  turnId: string | null;
  runId: string | null;
  messageId: string | null;
  toolCallId: string | null;
  agentId: string | null;
  agentInstanceId: string | null;
  parentAgentInstanceId: string | null;
  parentAgentId: string | null;
  parentToolCallId: string | null;
  occurredAt: string;
  recordedAt: string;
  schemaVersion: number;
  sourceEventKey: string | null;
  payloadJson: string;
  payload: unknown;
  payloadParseError: boolean;
  payloadHash: string;
  eventHash: string;
  disposition: NativeDisposition["kind"];
  matchedSourceId?: string;
  reconciliationReason?: string;
  attachmentSummary: AttachmentSummary;
}

interface NativeReconciliationResult extends NativeReconciliationInventory {
  facts: NativeEventFact[];
}

interface NativeMaintenanceManifest {
  schemaVersion: 1;
  generatedAt: string;
  databasePath: string;
  integrity: string;
  storageMode?: string;
  conversationCount: number;
  nativeEventCount: number;
  commandState: CommandStateMaintenance[];
  conversations: Array<{
    conversationId: string;
    inventory: ExistingV2Inventory | null;
    attachmentSummary: AttachmentSummary;
    nativeEvents: NativeEventFact[];
  }>;
  contentHash: string;
}

/**
 * Classify existing native V2 facts against the V1 source before a maintenance
 * reimport. The report is deliberately descriptive: it does not authorize a
 * cutover. A later conservation policy can explicitly allow equivalent and
 * collapsed facts, while modified/unmatched facts remain fail-closed.
 */
function inspectNativeReconciliation(
  db: DatabaseSync,
  conversationId: string,
  attachmentsRoot?: string,
): NativeReconciliationResult {
  const empty: NativeReconciliationResult = {
    nativeEquivalentEvents: 0,
    nativeCollapsedEvents: 0,
    nativeModifiedEvents: 0,
    nativeUnmatchedEvents: 0,
    nativeReconciliationIssues: [],
    facts: [],
  };
  if (!tableExists(db, "conversation_events_v2")) return empty;
  const nativeEvents = db
    .prepare(
      `SELECT seq, event_id, type, turn_id, run_id, message_id, tool_call_id,
              agent_id, agent_instance_id, parent_agent_instance_id, parent_agent_id, parent_tool_call_id,
              occurred_at, recorded_at,
              schema_version, source_event_key, payload_json, event_hash
       FROM conversation_events_v2
       WHERE conversation_id = ?
         AND (source_event_key IS NULL
           OR (source_event_key NOT LIKE 'legacy:%'
             AND source_event_key NOT LIKE 'migration:v1:%'))
       ORDER BY seq ASC`,
    )
    .all(conversationId) as unknown as NativeEventRow[];
  if (nativeEvents.length === 0) return empty;

  const users = tableExists(db, "thread_user_messages")
    ? (db
        .prepare(
          `SELECT activity_line_id, text, attachments_json, created_at
           FROM thread_user_messages WHERE thread_id = ?
           ORDER BY created_at ASC, activity_line_id ASC`,
        )
        .all(conversationId) as unknown as LegacyUserSourceRow[])
    : [];
  const attempts = tableExists(db, "thread_run_attempts")
    ? (db
        .prepare(
          `SELECT attempt_id, status, started_at, ended_at
           FROM thread_run_attempts WHERE thread_id = ?
           ORDER BY started_at ASC, attempt_id ASC`,
        )
        .all(conversationId) as unknown as LegacyAttemptSourceRow[])
    : [];
  const usedUserIds = new Set<string>();
  for (const event of nativeEvents) {
    const parsedPayload = parseJsonValue(event.payload_json);
    const payload = asJsonObject(parsedPayload);
    const disposition = classifyNativeEvent(event, payload, users, attempts, usedUserIds);
    if (disposition.kind === "equivalent") empty.nativeEquivalentEvents += 1;
    else if (disposition.kind === "collapsed") empty.nativeCollapsedEvents += 1;
    else if (disposition.kind === "modified") empty.nativeModifiedEvents += 1;
    else empty.nativeUnmatchedEvents += 1;
    if (disposition.reason && empty.nativeReconciliationIssues.length < 100) {
      empty.nativeReconciliationIssues.push(`${event.event_id}:${disposition.reason}`);
    }
    empty.facts.push({
      seq: event.seq,
      eventId: event.event_id,
      type: event.type,
      turnId: event.turn_id,
      runId: event.run_id,
      messageId: event.message_id,
      toolCallId: event.tool_call_id,
      agentId: event.agent_id,
      agentInstanceId: event.agent_instance_id,
      parentAgentInstanceId: event.parent_agent_instance_id,
      parentAgentId: event.parent_agent_id,
      parentToolCallId: event.parent_tool_call_id,
      occurredAt: event.occurred_at,
      recordedAt: event.recorded_at,
      schemaVersion: event.schema_version,
      sourceEventKey: event.source_event_key,
      payloadJson: event.payload_json,
      payload: parsedPayload === undefined ? null : parsedPayload,
      payloadParseError: parsedPayload === undefined,
      payloadHash: stableHash(parsedPayload === undefined ? event.payload_json : parsedPayload),
      eventHash: event.event_hash,
      disposition: disposition.kind,
      ...(disposition.sourceId ? { matchedSourceId: disposition.sourceId } : {}),
      ...(disposition.reason ? { reconciliationReason: disposition.reason } : {}),
      attachmentSummary: attachmentSummaryForPayload(parsedPayload, event.payload_json, attachmentsRoot),
    });
  }
  return empty;
}

function summarizeNativeFacts(facts: readonly NativeEventFact[]): NativeReconciliationResult {
  const summary: NativeReconciliationResult = {
    nativeEquivalentEvents: 0,
    nativeCollapsedEvents: 0,
    nativeModifiedEvents: 0,
    nativeUnmatchedEvents: 0,
    nativeReconciliationIssues: [],
    facts: [...facts],
  };
  for (const fact of facts) {
    if (fact.disposition === "equivalent") summary.nativeEquivalentEvents += 1;
    else if (fact.disposition === "collapsed") summary.nativeCollapsedEvents += 1;
    else if (fact.disposition === "modified") summary.nativeModifiedEvents += 1;
    else summary.nativeUnmatchedEvents += 1;
    if (fact.reconciliationReason && summary.nativeReconciliationIssues.length < 100) {
      summary.nativeReconciliationIssues.push(`${fact.eventId}:${fact.reconciliationReason}`);
    }
  }
  return summary;
}

interface PostCutoverMigrationMarker {
  phase?: string;
  updated_at?: string;
  source_fingerprint?: string;
}

interface PostCutoverNativeClassification {
  warnings: string[];
  unmatchedEvents: number;
}

interface PostCutoverNativeEventRow {
  seq: number;
  event_id: string;
  type: string;
  source_event_key: string | null;
  payload_json: string;
  recorded_at: string;
  run_id: string | null;
  tool_call_id: string | null;
  message_id: string | null;
}

function classifyPostCutoverNativeEvents(
  db: DatabaseSync,
  conversationId: string,
  migration: PostCutoverMigrationMarker | undefined,
  ledgerFacts: readonly NativeEventFact[] = [],
): PostCutoverNativeClassification | undefined {
  if (!tableExists(db, "conversation_events_v2")) return undefined;
  const ledgerEventIds = new Set(ledgerFacts.map((fact) => fact.eventId));
  const rows = (
    db
      .prepare(
        `SELECT seq, event_id, type, source_event_key, payload_json, recorded_at, run_id, tool_call_id, message_id
         FROM conversation_events_v2
        WHERE conversation_id = ?
          AND (source_event_key IS NULL
            OR (source_event_key NOT LIKE 'legacy:%'
              AND source_event_key NOT LIKE 'migration:v1:%'))
        ORDER BY seq ASC`,
      )
      .all(conversationId) as PostCutoverNativeEventRow[]
  ).filter((row) => !ledgerEventIds.has(row.event_id));
  if (rows.length === 0) return undefined;

  // Maintenance replay rows are derived from modified ledger facts, so their
  // provenance is the referenced immutable fact rather than wall-clock order.
  const maintenanceRows = rows.filter((row) =>
    (row.source_event_key ?? "").startsWith("maintenance:native:"),
  );
  const maintenanceVerified = maintenanceRows.every((row) =>
    isVerifiedMaintenanceEvent(row, conversationId, migration, ledgerFacts),
  );
  if (!maintenanceVerified) return { warnings: [], unmatchedEvents: rows.length };
  const runtimeRows = rows.filter((row) => !(row.source_event_key ?? "").startsWith("maintenance:native:"));
  const warnings = maintenanceRows.length > 0 ? ["maintenance_native_fact_replay"] : [];
  if (runtimeRows.length === 0) return { warnings, unmatchedEvents: 0 };

  // A completed migration row remains as durable provenance forever. Every event
  // attributed to a later V2 runtime write must therefore have been recorded at or
  // after that marker; an old unmatched row in the same stream keeps the audit closed.
  if (migration?.phase && migration.phase !== "completed") {
    return { warnings: [], unmatchedEvents: runtimeRows.length };
  }
  if (migration?.phase === "completed") {
    const migrationTime = Date.parse(migration.updated_at ?? "");
    if (!Number.isFinite(migrationTime)) return { warnings: [], unmatchedEvents: runtimeRows.length };
    if (
      runtimeRows.some(
        (row) => !Number.isFinite(Date.parse(row.recorded_at)) || Date.parse(row.recorded_at) < migrationTime,
      )
    ) {
      return { warnings: [], unmatchedEvents: runtimeRows.length };
    }
  }

  if (runtimeRows.every((row) => isVerifiedRecoveryToolEvent(db, conversationId, row))) {
    return migration?.phase === "completed"
      ? { warnings: [...warnings, "post_cutover_recovery_without_native_ledger"], unmatchedEvents: 0 }
      : { warnings: [], unmatchedEvents: runtimeRows.length };
  }

  let hasUserReceipt = false;
  let hasRuntimeInput = false;
  let hasLifecycle = false;
  let hasRecoveryEvent = false;
  const eventBySourceKey = new Map(runtimeRows.map((row) => [row.source_event_key ?? "", row]));
  const allEventsHaveRuntimeSource = runtimeRows.every((row) => {
    const payload = asJsonObject(parseJsonValue(row.payload_json));

    if (isDesktopUserEvent(row, conversationId, payload)) {
      hasUserReceipt ||= row.type === "message.created" && payload?.role === "user";
      return true;
    }
    if (isCommandReceiptEvent(db, conversationId, row, payload)) {
      hasUserReceipt ||= row.type === "message.accepted" && payload?.role === "user";
      return true;
    }
    if (isCommandJobEvent(db, conversationId, row, payload)) return true;
    if (isRuntimeInputReceipt(row, conversationId, payload)) {
      hasRuntimeInput = true;
      return true;
    }
    if (isVerifiedRecoveryToolEvent(db, conversationId, row)) {
      hasRecoveryEvent = true;
      return true;
    }
    if (isProviderPatchEvent(row, conversationId, payload, eventBySourceKey)) return true;
    if (isHistoryRepairEvent(row, conversationId, payload)) return true;
    if (isProviderRuntimeEvent(row, conversationId)) return true;
    if (isRunLifecycleEvent(row, conversationId, payload)) {
      hasLifecycle = true;
      return true;
    }
    return isAgentLifecycleEvent(row, conversationId);
  });

  if (!allEventsHaveRuntimeSource || !hasUserReceipt || !hasRuntimeInput || !hasLifecycle) {
    return { warnings: [], unmatchedEvents: runtimeRows.length };
  }
  warnings.push("post_cutover_runtime_without_native_ledger");
  if (hasRecoveryEvent) warnings.push("post_cutover_recovery_without_native_ledger");
  return { warnings, unmatchedEvents: 0 };
}

/** Accept an exact derived ID and the deterministic suffix used for hash collisions. */
function matchesDerivedEventId(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const collisionPrefix = `${expected}_collision_`;
  return actual.startsWith(collisionPrefix) && /^[0-9a-f]{64}$/.test(actual.slice(collisionPrefix.length));
}

function isVerifiedMaintenanceEvent(
  row: PostCutoverNativeEventRow,
  conversationId: string,
  migration: PostCutoverMigrationMarker | undefined,
  ledgerFacts: readonly NativeEventFact[],
): boolean {
  const sourcePrefix = "maintenance:native:";
  const source = row.source_event_key ?? "";
  if (!source.startsWith(sourcePrefix) || !migration?.source_fingerprint) return false;
  const factId = source.slice(sourcePrefix.length);
  const fact = ledgerFacts.find((candidate) => candidate.eventId === factId);
  if (fact?.disposition !== "modified" || !fact.matchedSourceId) return false;
  if (
    !matchesDerivedEventId(
      row.event_id,
      `maintenance_native_${stableHash(`${conversationId}:${fact.eventId}`)}`,
    )
  )
    return false;
  const factPayload = asJsonObject(fact.payload);
  const payload = asJsonObject(parseJsonValue(row.payload_json));
  if (!factPayload || !payload || payload.authority !== "maintenance") return false;

  if (fact.type === "message.created") {
    const body = typeof factPayload.body === "string" ? factPayload.body : factPayload.text;
    const status =
      factPayload.status === "failed" || factPayload.status === "cancelled" ? factPayload.status : "final";
    const expectedMessageId = `migration_message_${stableHash(
      `${migration.source_fingerprint}:${fact.matchedSourceId}`,
    )}`;
    return (
      typeof body === "string" &&
      row.type === "message.finalized" &&
      row.message_id === expectedMessageId &&
      payload.body === body &&
      payload.status === status
    );
  }

  return (
    ["run.started", "run.completed", "run.failed", "run.cancelled", "run.interrupted"].includes(fact.type) &&
    row.type === fact.type &&
    row.run_id === fact.runId &&
    payload.authority === "lifecycle"
  );
}

function isDesktopUserEvent(
  row: PostCutoverNativeEventRow,
  conversationId: string,
  payload: Record<string, unknown> | undefined,
): boolean {
  const source = row.source_event_key ?? "";
  if (row.type === "message.created" && source.startsWith(`desktop:user:${conversationId}:`)) {
    return (
      matchesDerivedEventId(row.event_id, `desktop_v2_user_${stableHash(source)}`) && payload?.role === "user"
    );
  }
  if (row.type === "message.finalized" && source.startsWith(`desktop:user:accepted:${conversationId}:`)) {
    return matchesDerivedEventId(row.event_id, `desktop_v2_user_finalize_${stableHash(source)}`);
  }
  if (
    row.type === "message.finalized" &&
    source.startsWith(`desktop:user:accepted-failed:${conversationId}:`)
  ) {
    return matchesDerivedEventId(row.event_id, `desktop_v2_user_failed_${stableHash(source)}`);
  }
  if (
    row.type === "message.history_targeted" &&
    source.startsWith(`desktop:user:history-target:${conversationId}:`)
  ) {
    return matchesDerivedEventId(row.event_id, `desktop_v2_user_history_target_${stableHash(source)}`);
  }
  return false;
}

function isCommandReceiptEvent(
  db: DatabaseSync,
  conversationId: string,
  row: PostCutoverNativeEventRow,
  payload: Record<string, unknown> | undefined,
): boolean {
  const source = row.source_event_key ?? "";
  if (row.type !== "message.accepted" || !source.startsWith("command:") || payload?.role !== "user")
    return false;
  if (!tableExists(db, "conversation_command_receipts_v2")) return false;
  const receipt = db
    .prepare(
      `SELECT principal_id, client_command_id
         FROM conversation_command_receipts_v2
        WHERE conversation_id = ? AND accepted_seq = ?`,
    )
    .get(conversationId, row.seq) as { principal_id: string; client_command_id: string } | undefined;
  return receipt !== undefined && source === `command:${receipt.principal_id}:${receipt.client_command_id}`;
}

function isCommandJobEvent(
  db: DatabaseSync,
  conversationId: string,
  row: PostCutoverNativeEventRow,
  payload: Record<string, unknown> | undefined,
): boolean {
  const source = row.source_event_key ?? "";
  if (row.type !== "noop" || !source.startsWith("command-job:") || payload?.reason !== "command.accepted") {
    return false;
  }
  if (!tableExists(db, "conversation_command_jobs_v2")) return false;
  const job = db
    .prepare(
      `SELECT principal_id, client_command_id
         FROM conversation_command_jobs_v2
        WHERE conversation_id = ? AND accepted_seq = ?`,
    )
    .get(conversationId, row.seq) as { principal_id: string; client_command_id: string } | undefined;
  return job !== undefined && source === `command-job:${job.principal_id}:${job.client_command_id}`;
}

function isRuntimeInputReceipt(
  row: PostCutoverNativeEventRow,
  conversationId: string,
  payload: Record<string, unknown> | undefined,
): boolean {
  if (row.type !== "noop" || payload?.reason !== "runtime.input" || typeof payload.inputHash !== "string") {
    return false;
  }
  const source = asJsonObject(payload.source);
  const sourceId = typeof source?.id === "string" ? source.id.trim() : "";
  return (
    source?.threadId === conversationId &&
    sourceId.length > 0 &&
    (row.source_event_key ?? "").startsWith(
      `runtime-input:${conversationId}:${sourceId}:${payload.inputHash}`,
    ) &&
    matchesDerivedEventId(row.event_id, `runtime_input_${stableHash(row.source_event_key ?? "")}`)
  );
}

function isProviderRuntimeEvent(row: PostCutoverNativeEventRow, conversationId: string): boolean {
  return (
    (row.source_event_key ?? "").startsWith(`provider:${conversationId}:`) &&
    matchesDerivedEventId(row.event_id, `legacy_v2_${stableHash(row.source_event_key ?? "")}`)
  );
}

function isProviderPatchEvent(
  row: PostCutoverNativeEventRow,
  conversationId: string,
  payload: Record<string, unknown> | undefined,
  eventBySourceKey: ReadonlyMap<string, PostCutoverNativeEventRow>,
): boolean {
  if (!payload || typeof row.source_event_key !== "string") return false;
  const source = row.source_event_key;
  if (row.type === "noop" && payload.reason === "provider.patch") {
    const digest = providerPatchDigest(conversationId, payload);
    return (
      digest !== undefined &&
      source === `provider:patch:${digest}` &&
      matchesDerivedEventId(row.event_id, `provider_patch_${digest}`)
    );
  }
  if (row.type !== "message.history_targeted" || !row.message_id) return false;
  const suffix = `:history-target:${row.message_id}`;
  if (!source.endsWith(suffix)) return false;
  const baseSource = source.slice(0, -suffix.length);
  const base = eventBySourceKey.get(baseSource);
  if (base?.type !== "noop") return false;
  const basePayload = asJsonObject(parseJsonValue(base.payload_json));
  const digest = basePayload ? providerPatchDigest(conversationId, basePayload) : undefined;
  return (
    digest !== undefined &&
    baseSource === `provider:patch:${digest}` &&
    matchesDerivedEventId(base.event_id, `provider_patch_${digest}`) &&
    matchesDerivedEventId(
      row.event_id,
      `provider_history_target_${stableHash(`${baseSource}:${row.message_id}`)}`,
    )
  );
}

function providerPatchDigest(conversationId: string, payload: Record<string, unknown>): string | undefined {
  if (payload.reason !== "provider.patch" || typeof payload.patchReason !== "string") return undefined;
  if (!Array.isArray(payload.inputIds) || payload.inputIds.length === 0) return undefined;
  const inputIds = payload.inputIds.filter(
    (id): id is string => typeof id === "string" && id.trim().length > 0,
  );
  if (inputIds.length !== payload.inputIds.length || new Set(inputIds).size !== inputIds.length)
    return undefined;
  const sorted = [...inputIds].sort();
  if (inputIds.some((id, index) => id !== sorted[index])) return undefined;
  return stableHash(`${conversationId}:${payload.patchReason}:${inputIds.join(",")}`);
}

function isHistoryRepairEvent(
  row: PostCutoverNativeEventRow,
  conversationId: string,
  payload: Record<string, unknown> | undefined,
): boolean {
  if (!payload || typeof row.source_event_key !== "string") return false;
  const source = row.source_event_key;
  const codexRepairPrefix = `desktop:codex-user-duplicate-repair:${conversationId}:`;
  if (source.startsWith(codexRepairPrefix)) {
    const bindSuffix = ":bind";
    const deleteSuffix = ":delete";
    if (row.type === "message.history_targeted" && source.endsWith(bindSuffix)) {
      const base = source.slice(0, -bindSuffix.length);
      return (
        asJsonObject(payload.historyTarget) !== undefined &&
        matchesDerivedEventId(row.event_id, `codex_user_duplicate_bind_${stableHash(base)}`)
      );
    }
    if (row.type === "history.deleted" && source.endsWith(deleteSuffix)) {
      const base = source.slice(0, -deleteSuffix.length);
      return (
        payload.reason === "codex-user-item-echo" &&
        Array.isArray(payload.affectedMessageIds) &&
        matchesDerivedEventId(row.event_id, `codex_user_duplicate_delete_${stableHash(base)}`)
      );
    }
    return false;
  }
  const acceptedRepairPrefix = `desktop:accepted-prompt-duplicate-repair:${conversationId}:`;
  if (
    row.type !== "history.deleted" ||
    !source.startsWith(acceptedRepairPrefix) ||
    !source.endsWith(":delete")
  ) {
    return false;
  }
  const base = source.slice(0, -":delete".length);
  return (
    payload.reason === "accepted-prompt-duplicate" &&
    Array.isArray(payload.affectedMessageIds) &&
    matchesDerivedEventId(row.event_id, `accepted_prompt_duplicate_delete_${stableHash(base)}`)
  );
}

function isRunLifecycleEvent(
  row: PostCutoverNativeEventRow,
  conversationId: string,
  payload: Record<string, unknown> | undefined,
): boolean {
  const statusByType: Record<string, string> = {
    "run.started": "running",
    "run.completed": "completed",
    "run.failed": "failed",
    "run.cancelled": "cancelled",
    "run.interrupted": "interrupted",
  };
  const source = row.source_event_key ?? "";
  return (
    statusByType[row.type] !== undefined &&
    (source.startsWith(`desktop:run:${conversationId}:`) ||
      source.startsWith(`desktop:run-reconciled:${conversationId}:`)) &&
    matchesDerivedEventId(row.event_id, `desktop_v2_run_${stableHash(source)}`) &&
    payload?.authority === "lifecycle" &&
    payload.status === statusByType[row.type]
  );
}

function isAgentLifecycleEvent(row: PostCutoverNativeEventRow, conversationId: string): boolean {
  return (
    ["agent.created", "agent.started", "agent.interrupted", "agent.completed"].includes(row.type) &&
    (row.source_event_key ?? "").startsWith(`desktop:agent:${conversationId}:`) &&
    matchesDerivedEventId(row.event_id, `desktop_v2_agent_${stableHash(row.source_event_key ?? "")}`)
  );
}

function isVerifiedRecoveryToolEvent(
  db: DatabaseSync,
  conversationId: string,
  row: PostCutoverNativeEventRow,
): boolean {
  const source = row.source_event_key ?? "";
  if (
    row.type !== "tool.failed" ||
    !row.run_id ||
    !row.tool_call_id ||
    source !== `recovery:terminal-run-tool:${conversationId}:${row.run_id}:${row.tool_call_id}` ||
    !matchesDerivedEventId(row.event_id, `recovery_terminal_tool_failed_${stableHash(source)}`)
  ) {
    return false;
  }
  const payload = asJsonObject(parseJsonValue(row.payload_json));
  if (
    payload?.status !== "failed" ||
    typeof payload.recoveryReason !== "string" ||
    !payload.recoveryReason.includes("side-effect outcome is unknown")
  ) {
    return false;
  }
  const state = db
    .prepare(
      `SELECT runs.status AS run_status, tools.status AS tool_status
         FROM conversation_runs_v2 AS runs
         JOIN conversation_tool_calls_v2 AS tools
           ON tools.conversation_id = runs.conversation_id
          AND tools.run_id = runs.run_id
        WHERE runs.conversation_id = ? AND runs.run_id = ? AND tools.tool_call_id = ?`,
    )
    .get(conversationId, row.run_id, row.tool_call_id) as
    | { run_status: string; tool_status: string }
    | undefined;
  return state?.tool_status === "failed" && ["failed", "cancelled"].includes(state.run_status);
}

function isV2OnlyAuditReady(inventories: readonly ExistingV2Inventory[]): boolean {
  return inventories.every((entry) => {
    const pathAttachmentsVerified =
      entry.attachmentPathRefs === 0 ||
      (entry.attachmentMissingFiles === 0 &&
        entry.attachmentPathContentHashes.length === entry.attachmentPathRefs);
    return (
      entry.nativeUnmatchedEvents === 0 &&
      entry.attachmentParseErrors === 0 &&
      entry.attachmentLegacyPayloads === 0 &&
      pathAttachmentsVerified
    );
  });
}

type NativeDisposition =
  | { kind: "equivalent"; sourceId?: string }
  | { kind: "collapsed"; reason: string; sourceId?: string }
  | { kind: "modified"; reason: string; sourceId?: string }
  | { kind: "unmatched"; reason: string };

function classifyNativeEvent(
  event: NativeEventRow,
  payload: Record<string, unknown> | undefined,
  users: readonly LegacyUserSourceRow[],
  attempts: readonly LegacyAttemptSourceRow[],
  usedUserIds: Set<string>,
): NativeDisposition {
  if (!payload) return { kind: "unmatched", reason: "invalid_payload_json" };
  // Command acceptance is a V2-only fact with no V1 source equivalent. It is
  // intentionally carried through the maintenance manifest so receipts/jobs can
  // be restored after the rebuild. Treat only the two durable command event forms
  // as equivalent; any other unsupported native event remains fail-closed.
  if (event.type === "message.accepted" && event.source_event_key?.startsWith("command:")) {
    const body = typeof payload.body === "string" ? payload.body : undefined;
    return body === undefined
      ? { kind: "unmatched", reason: "command_message_body_missing" }
      : { kind: "equivalent", sourceId: event.source_event_key };
  }
  if (event.type === "noop" && event.source_event_key?.startsWith("command-job:")) {
    return payload.reason === "command.accepted"
      ? { kind: "equivalent", sourceId: event.source_event_key }
      : { kind: "unmatched", reason: "command_job_acceptance_payload_invalid" };
  }
  if (event.type === "message.created") {
    const body = typeof payload.body === "string" ? payload.body : undefined;
    if (body === undefined) return { kind: "unmatched", reason: "message_body_missing" };
    const candidates = users
      .filter((row) => !usedUserIds.has(row.activity_line_id))
      .map((row) => ({
        row,
        keyMatch: sourceUserId(event.source_event_key) === userId(row.activity_line_id),
        distance: timestampDistance(row.created_at, event.occurred_at),
      }))
      .filter((candidate) => Number.isFinite(candidate.distance) && candidate.distance <= 5_000)
      .sort(
        (left, right) =>
          Number(right.keyMatch) - Number(left.keyMatch) ||
          Number(left.row.text !== body) - Number(right.row.text !== body) ||
          left.distance - right.distance ||
          left.row.activity_line_id.localeCompare(right.row.activity_line_id),
      );
    const exact = candidates.find((candidate) => candidate.row.text === body);
    const normalized = candidates.find(
      (candidate) => normalizeMessageBody(candidate.row.text) === normalizeMessageBody(body),
    );
    const keyMatched = candidates.filter((candidate) => candidate.keyMatch);
    const matched = exact ?? normalized ?? (keyMatched.length === 1 ? keyMatched[0] : undefined);
    if (!matched) return { kind: "unmatched", reason: "message_source_not_found" };
    usedUserIds.add(matched.row.activity_line_id);
    const attachmentDiff = !attachmentsEquivalent(payload.attachments, matched.row.attachments_json);
    if (matched.row.text !== body || attachmentDiff) {
      const reasons = [
        ...(matched.row.text !== body ? ["message_body_diff"] : []),
        ...(attachmentDiff ? ["message_attachments_diff"] : []),
      ];
      return { kind: "modified", reason: reasons.join(","), sourceId: matched.row.activity_line_id };
    }
    return { kind: "equivalent", sourceId: matched.row.activity_line_id };
  }

  if (event.type === "run.corrected") {
    const attemptId = event.run_id ?? sourceAttemptId(event.source_event_key);
    const attempt = attempts.find((row) => row.attempt_id === attemptId);
    return attempt
      ? {
          kind: "modified",
          reason: "admin_run_correction_requires_native_replay",
          sourceId: attempt.attempt_id,
        }
      : { kind: "unmatched", reason: "run_attempt_not_found" };
  }

  if (
    event.type !== "run.started" &&
    event.type !== "run.completed" &&
    event.type !== "run.failed" &&
    event.type !== "run.cancelled"
  ) {
    return { kind: "unmatched", reason: `unsupported_native_type:${event.type}` };
  }
  const attemptId = event.run_id ?? sourceAttemptId(event.source_event_key);
  const attempt = attempts.find((row) => row.attempt_id === attemptId);
  if (!attempt) return { kind: "unmatched", reason: "run_attempt_not_found" };
  const startedAt = typeof payload.startedAt === "string" ? payload.startedAt : event.occurred_at;
  if (event.type === "run.started") {
    return timestampDistance(attempt.started_at, startedAt) <= 5_000
      ? { kind: "collapsed", reason: "run_started_collapses_into_attempt", sourceId: attempt.attempt_id }
      : { kind: "modified", reason: "run_started_time_diff", sourceId: attempt.attempt_id };
  }
  const expectedStatus = event.type.slice("run.".length);
  const endedAt = typeof payload.endedAt === "string" ? payload.endedAt : event.occurred_at;
  const statusMatches = attempt.status === expectedStatus;
  const startMatches = timestampDistance(attempt.started_at, startedAt) <= 5_000;
  const endMatches = attempt.ended_at === null || timestampDistance(attempt.ended_at, endedAt) <= 5_000;
  if (statusMatches && startMatches && endMatches) {
    return { kind: "equivalent", sourceId: attempt.attempt_id };
  }
  return { kind: "modified", reason: "run_attempt_fact_diff", sourceId: attempt.attempt_id };
}

function asJsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function sourceUserId(sourceEventKey: string | null): string | undefined {
  const match = sourceEventKey?.match(/:user:([^:]+)$/);
  return match?.[1];
}

function userId(activityLineId: string): string | undefined {
  const match = activityLineId.match(/^user:(.+)$/);
  return match?.[1];
}

function sourceAttemptId(sourceEventKey: string | null): string | undefined {
  const match = sourceEventKey?.match(/:attempt_(.+?):(?:running|completed|failed|cancelled):/);
  return match?.[1];
}

function timestampDistance(left: string, right: string): number {
  if (left === right) return 0;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs)
    ? Math.abs(leftMs - rightMs)
    : Number.POSITIVE_INFINITY;
}

function normalizeMessageBody(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function attachmentsEquivalent(nativeValue: unknown, legacyJson: string | null): boolean {
  const legacyValue = legacyJson ? parseJsonValue(legacyJson) : undefined;
  const native = Array.isArray(nativeValue) ? nativeValue : [];
  const legacy = Array.isArray(legacyValue) ? legacyValue : [];
  return JSON.stringify(native) === JSON.stringify(legacy);
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    (
      db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as
        | { present?: number }
        | undefined
    )?.present,
  );
}

function countRows(db: DatabaseSync, table: string, conversationId: string): number {
  if (!tableExists(db, table)) return 0;
  return countRowsWhere(db, table, conversationId, "1 = 1");
}

function countRowsWhere(db: DatabaseSync, table: string, conversationId: string, predicate: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE conversation_id = ? AND ${predicate}`)
    .get(conversationId) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function inspectAttachmentInventory(
  db: DatabaseSync,
  conversationId: string,
  attachmentsRoot?: string,
): Pick<
  ExistingV2Inventory,
  | "attachmentRefs"
  | "attachmentLegacyPayloads"
  | "attachmentInlineBytes"
  | "attachmentPathRefs"
  | "attachmentMissingFiles"
  | "attachmentParseErrors"
  | "attachmentPathContentHashes"
> {
  const inventory = {
    attachmentRefs: 0,
    attachmentLegacyPayloads: 0,
    attachmentInlineBytes: 0,
    attachmentPathRefs: 0,
    attachmentMissingFiles: 0,
    attachmentParseErrors: 0,
    attachmentPathContentHashes: [] as AttachmentContentHash[],
  };
  if (tableExists(db, "conversation_messages_v2")) {
    const rows = db
      .prepare(
        `SELECT attachments_json FROM conversation_messages_v2
         WHERE conversation_id = ? AND attachments_json IS NOT NULL AND length(trim(attachments_json)) > 2`,
      )
      .all(conversationId) as Array<{ attachments_json?: string | null }>;
    for (const row of rows) addAttachmentJson(inventory, row.attachments_json, attachmentsRoot);
  }
  if (tableExists(db, "conversation_followups_v2")) {
    const rows = db
      .prepare(
        `SELECT attachments_json FROM conversation_followups_v2
         WHERE thread_id = ? AND attachments_json IS NOT NULL AND length(trim(attachments_json)) > 2`,
      )
      .all(conversationId) as Array<{ attachments_json?: string | null }>;
    for (const row of rows) addAttachmentJson(inventory, row.attachments_json, attachmentsRoot);
  }
  if (tableExists(db, "conversation_events_v2")) {
    const rows = db
      .prepare(
        `SELECT payload_json FROM conversation_events_v2
         WHERE conversation_id = ? AND payload_json LIKE '%attachments%'`,
      )
      .all(conversationId) as Array<{ payload_json?: string | null }>;
    for (const row of rows) {
      if (!row.payload_json) continue;
      try {
        const payload = JSON.parse(row.payload_json) as unknown;
        const attachments =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as { attachments?: unknown }).attachments
            : undefined;
        if (attachments !== undefined) addAttachments(inventory, attachments, attachmentsRoot);
      } catch {
        inventory.attachmentParseErrors += 1;
      }
    }
  }
  return inventory;
}

function addAttachmentJson(
  inventory: {
    attachmentRefs: number;
    attachmentLegacyPayloads: number;
    attachmentInlineBytes: number;
    attachmentPathRefs: number;
    attachmentMissingFiles: number;
    attachmentParseErrors: number;
    attachmentPathContentHashes: AttachmentContentHash[];
  },
  value: string | null | undefined,
  attachmentsRoot?: string,
): void {
  if (!value) return;
  try {
    addAttachments(inventory, JSON.parse(value) as unknown, attachmentsRoot);
  } catch {
    inventory.attachmentParseErrors += 1;
  }
}

function addAttachments(
  inventory: {
    attachmentRefs: number;
    attachmentLegacyPayloads: number;
    attachmentInlineBytes: number;
    attachmentPathRefs: number;
    attachmentMissingFiles: number;
    attachmentParseErrors: number;
    attachmentPathContentHashes: AttachmentContentHash[];
  },
  value: unknown,
  attachmentsRoot?: string,
): void {
  if (!Array.isArray(value)) {
    inventory.attachmentParseErrors += 1;
    return;
  }
  for (const attachment of value) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      inventory.attachmentParseErrors += 1;
      continue;
    }
    inventory.attachmentRefs += 1;
    const data = (attachment as { data?: unknown }).data;
    const path = (attachment as { path?: unknown }).path;
    const contentRef = (attachment as { contentRef?: unknown }).contentRef;
    const hasDurableContentRef =
      typeof contentRef === "string" && /^sha256:[0-9a-f]{64}$/.test(contentRef.trim());
    const hasPath = typeof path === "string" && path.trim().length > 0;
    const hasInlineData = typeof data === "string" && data.trim().length > 0;
    if (hasPath || (hasInlineData && !hasDurableContentRef)) {
      inventory.attachmentLegacyPayloads += 1;
    }
    if (typeof data === "string" && data.trim()) {
      inventory.attachmentInlineBytes += approximateBase64Bytes(data);
    }
    if (typeof path === "string" && path.trim()) {
      inventory.attachmentPathRefs += 1;
      const sha256 = attachmentsRoot ? attachmentFileSha256(path, attachmentsRoot) : undefined;
      if (attachmentsRoot && !sha256) {
        inventory.attachmentMissingFiles += 1;
      } else if (sha256) {
        inventory.attachmentPathContentHashes.push({ path, sha256 });
      }
    }
  }
}

function attachmentFileSha256(rawPath: string, attachmentsRoot: string): string | undefined {
  const root = path.resolve(attachmentsRoot);
  const candidate = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(root, rawPath));
  if (!isPathWithinRoot(root, candidate)) return undefined;
  try {
    const realRoot = fsSync.realpathSync(root);
    const realCandidate = fsSync.realpathSync(candidate);
    if (!isPathWithinRoot(realRoot, realCandidate)) return undefined;
    if (!fsSync.statSync(realCandidate).isFile()) return undefined;
    return createHash("sha256").update(fsSync.readFileSync(realCandidate)).digest("hex");
  } catch {
    return undefined;
  }
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function approximateBase64Bytes(value: string): number {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized) return 0;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function attachmentSummaryForPayload(
  parsedPayload: unknown,
  rawPayload: string,
  attachmentsRoot?: string,
): AttachmentSummary {
  const summary: AttachmentSummary = {
    refs: 0,
    inlineBytes: 0,
    pathRefs: 0,
    missingFiles: 0,
    parseErrors: 0,
    pathContentHashes: [],
  };
  if (parsedPayload === undefined) {
    if (rawPayload.includes("attachments")) summary.parseErrors += 1;
    return summary;
  }
  const payload = asJsonObject(parsedPayload);
  if (!payload || !Object.hasOwn(payload, "attachments") || payload.attachments === undefined) return summary;
  if (!Array.isArray(payload.attachments)) {
    summary.parseErrors += 1;
    return summary;
  }
  for (const attachment of payload.attachments) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      summary.parseErrors += 1;
      continue;
    }
    summary.refs += 1;
    const data = (attachment as { data?: unknown }).data;
    const attachmentPath = (attachment as { path?: unknown }).path;
    if (typeof data === "string" && data.trim()) summary.inlineBytes += approximateBase64Bytes(data);
    if (typeof attachmentPath === "string" && attachmentPath.trim()) {
      summary.pathRefs += 1;
      const sha256 = attachmentsRoot ? attachmentFileSha256(attachmentPath, attachmentsRoot) : undefined;
      if (attachmentsRoot && !sha256) {
        summary.missingFiles += 1;
      } else if (sha256) {
        summary.pathContentHashes.push({ path: attachmentPath, sha256 });
      }
    }
  }
  return summary;
}

function buildNativeMaintenanceManifest(
  db: DatabaseSync,
  dbPath: string,
  conversationIds: readonly string[],
  inventories: readonly ExistingV2Inventory[],
  attachmentsRoot: string | undefined,
  integrity: string,
): NativeMaintenanceManifest {
  const inventoryByConversation = new Map(inventories.map((entry) => [entry.conversationId, entry]));
  const storageMode = readStorageMode(db);
  const conversations = conversationIds.map((conversationId) => ({
    conversationId,
    inventory: inventoryByConversation.get(conversationId) ?? null,
    attachmentSummary: attachmentSummaryFromInventory(inventoryByConversation.get(conversationId)),
    // After cutover the V1 source tables are intentionally gone. The immutable
    // native-facts ledger is the conservation source; inspecting the remaining V2
    // event log would only see maintenance patches and would make a valid manifest
    // appear to lose the original native facts.
    nativeEvents:
      storageMode === "v2_only" && tableExists(db, "conversation_native_facts_v2")
        ? readNativeFactsLedger(db, conversationId, attachmentsRoot)
        : inspectNativeReconciliation(db, conversationId, attachmentsRoot).facts,
  }));
  const commandState = readCommandState(db, conversationIds);
  const base = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    databasePath: path.resolve(dbPath),
    integrity,
    ...(readStorageMode(db) ? { storageMode: readStorageMode(db) } : {}),
    conversationCount: conversations.length,
    nativeEventCount: conversations.reduce(
      (total, conversation) => total + conversation.nativeEvents.length,
      0,
    ),
    commandState,
    conversations,
  };
  return { ...base, contentHash: stableHash(base) };
}

function readStorageMode(db: DatabaseSync): string | undefined {
  if (!tableExists(db, "conversation_store_meta_v2")) return undefined;
  const row = db
    .prepare(`SELECT value FROM conversation_store_meta_v2 WHERE key = 'conversation_v2_storage_mode'`)
    .get() as { value?: string } | undefined;
  return row?.value;
}

function attachmentSummaryFromInventory(inventory: ExistingV2Inventory | undefined): AttachmentSummary {
  return {
    refs: inventory?.attachmentRefs ?? 0,
    inlineBytes: inventory?.attachmentInlineBytes ?? 0,
    pathRefs: inventory?.attachmentPathRefs ?? 0,
    missingFiles: inventory?.attachmentMissingFiles ?? 0,
    parseErrors: inventory?.attachmentParseErrors ?? 0,
    pathContentHashes: inventory?.attachmentPathContentHashes ?? [],
  };
}

function readCommandState(db: DatabaseSync, conversationIds: readonly string[]): CommandStateMaintenance[] {
  const hasReceipts = tableExists(db, "conversation_command_receipts_v2");
  const hasJobs = tableExists(db, "conversation_command_jobs_v2");
  const hasCheckpoints = tableExists(db, "conversation_command_checkpoints_v2");
  if (!hasReceipts && !hasJobs && !hasCheckpoints) return [];
  const states: CommandStateMaintenance[] = [];
  for (const conversationId of conversationIds) {
    const stream = tableExists(db, "conversation_streams_v2")
      ? (db
          .prepare(`SELECT history_revision FROM conversation_streams_v2 WHERE conversation_id = ?`)
          .get(conversationId) as { history_revision?: number } | undefined)
      : undefined;
    const receipts = hasReceipts
      ? (db
          .prepare(
            `SELECT principal_id, conversation_id, client_command_id, request_hash,
                    result_json, accepted_seq
               FROM conversation_command_receipts_v2
              WHERE conversation_id = ?
              ORDER BY principal_id, client_command_id`,
          )
          .all(conversationId) as Array<{
          principal_id: string;
          conversation_id: string;
          client_command_id: string;
          request_hash: string;
          result_json: string;
          accepted_seq: number;
        }>)
      : [];
    const jobs = hasJobs
      ? (db
          .prepare(
            `SELECT principal_id, conversation_id, client_command_id, command_type,
                    request_hash, request_json, expected_history_revision, status,
                    result_json, error_json, accepted_seq, accepted_at, updated_at
               FROM conversation_command_jobs_v2
              WHERE conversation_id = ?
              ORDER BY principal_id, client_command_id`,
          )
          .all(conversationId) as Array<{
          principal_id: string;
          conversation_id: string;
          client_command_id: string;
          command_type: string;
          request_hash: string;
          request_json: string;
          expected_history_revision: number;
          status: string;
          result_json: string | null;
          error_json: string | null;
          accepted_seq: number;
          accepted_at: string;
          updated_at: string;
        }>)
      : [];
    const checkpoints = hasCheckpoints
      ? (db
          .prepare(
            `SELECT principal_id, conversation_id, client_command_id, ordinal,
                    name, payload_hash, payload_json, recorded_at
               FROM conversation_command_checkpoints_v2
              WHERE conversation_id = ?
              ORDER BY principal_id, client_command_id, ordinal`,
          )
          .all(conversationId) as Array<{
          principal_id: string;
          conversation_id: string;
          client_command_id: string;
          ordinal: number;
          name: string;
          payload_hash: string;
          payload_json: string;
          recorded_at: string;
        }>)
      : [];
    if (receipts.length === 0 && jobs.length === 0 && checkpoints.length === 0) continue;
    if (!stream || !Number.isSafeInteger(stream.history_revision) || stream.history_revision < 0) {
      throw new Error(`V2 command state has no valid conversation stream: ${conversationId}`);
    }
    const eventRows = db
      .prepare(
        `SELECT seq, event_id, type, source_event_key, payload_json
           FROM conversation_events_v2
          WHERE conversation_id = ?`,
      )
      .all(conversationId) as Array<{
      seq: number;
      event_id: string;
      type: string;
      source_event_key: string | null;
      payload_json: string;
    }>;
    const eventBySeq = new Map(eventRows.map((row) => [row.seq, row]));
    const acceptedEvent = (seq: number, expectedType: string, expectedSource: string) => {
      if (!Number.isSafeInteger(seq) || seq < 1) {
        throw new Error(`V2 command state has an invalid accepted_seq: ${conversationId}/${seq}`);
      }
      const event = eventBySeq.get(seq);
      if (!event || event.type !== expectedType || event.source_event_key !== expectedSource) {
        throw new Error(
          `V2 command state accepted event is missing or mismatched: ${conversationId}/${expectedSource}/${seq}`,
        );
      }
      const payload = parseJsonValue(event.payload_json);
      if (!asJsonObject(payload)) {
        throw new Error(`V2 command state accepted event payload is invalid: ${conversationId}/${seq}`);
      }
      return event;
    };
    const commandReceipts: CommandReceiptMaintenance[] = receipts.map((row) => {
      const event = acceptedEvent(
        row.accepted_seq,
        "message.accepted",
        `command:${row.principal_id}:${row.client_command_id}`,
      );
      const result = asJsonObject(parseJsonValue(row.result_json));
      if (!result || result.acceptedSeq !== row.accepted_seq) {
        throw new Error(`V2 command receipt result does not match accepted_seq: ${conversationId}`);
      }
      return {
        principalId: row.principal_id,
        conversationId: row.conversation_id,
        clientCommandId: row.client_command_id,
        requestHash: row.request_hash,
        resultJson: row.result_json,
        acceptedSeq: row.accepted_seq,
        acceptedEventId: event.event_id,
      };
    });
    const commandJobs: CommandJobMaintenance[] = jobs.map((row) => {
      const event = acceptedEvent(
        row.accepted_seq,
        "noop",
        `command-job:${row.principal_id}:${row.client_command_id}`,
      );
      const request = asJsonObject(parseJsonValue(row.request_json));
      if (
        !request ||
        row.request_hash !==
          stableHash({
            commandType: row.command_type,
            request,
            expectedHistoryRevision: row.expected_history_revision,
          })
      ) {
        throw new Error(`V2 command job request hash is invalid: ${conversationId}/${row.client_command_id}`);
      }
      const payload = asJsonObject(parseJsonValue(event.payload_json));
      if (
        payload?.reason !== "command.accepted" ||
        payload?.principalId !== row.principal_id ||
        payload?.clientCommandId !== row.client_command_id ||
        payload?.commandType !== row.command_type ||
        payload?.requestHash !== row.request_hash ||
        payload?.expectedHistoryRevision !== row.expected_history_revision
      ) {
        throw new Error(
          `V2 command job accepted event does not match row: ${conversationId}/${row.client_command_id}`,
        );
      }
      return {
        principalId: row.principal_id,
        conversationId: row.conversation_id,
        clientCommandId: row.client_command_id,
        commandType: row.command_type,
        requestHash: row.request_hash,
        requestJson: row.request_json,
        expectedHistoryRevision: row.expected_history_revision,
        status: row.status,
        resultJson: row.result_json,
        errorJson: row.error_json,
        acceptedSeq: row.accepted_seq,
        acceptedAt: row.accepted_at,
        updatedAt: row.updated_at,
        acceptedEventId: event.event_id,
      };
    });
    const commandCheckpoints: CommandCheckpointMaintenance[] = checkpoints.map((row) => {
      const payload = asJsonObject(parseJsonValue(row.payload_json));
      if (!payload || row.payload_hash !== stableHash(payload)) {
        throw new Error(
          `V2 command checkpoint payload hash is invalid: ${conversationId}/${row.client_command_id}/${row.ordinal}`,
        );
      }
      return {
        principalId: row.principal_id,
        conversationId: row.conversation_id,
        clientCommandId: row.client_command_id,
        ordinal: row.ordinal,
        name: row.name,
        payloadHash: row.payload_hash,
        payloadJson: row.payload_json,
        recordedAt: row.recorded_at,
      };
    });
    states.push({
      conversationId,
      historyRevision: stream.history_revision,
      receipts: commandReceipts,
      jobs: commandJobs,
      checkpoints: commandCheckpoints,
    });
  }
  return states;
}

async function readNativeMaintenanceManifest(pathname: string): Promise<NativeMaintenanceManifest> {
  const target = path.resolve(pathname);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (error) {
    throw new Error(`Unable to read native maintenance manifest ${target}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Native maintenance manifest is not valid JSON: ${target}: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Native maintenance manifest must be a JSON object: ${target}`);
  }
  const manifest = parsed as Partial<NativeMaintenanceManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.contentHash !== "string" ||
    typeof manifest.generatedAt !== "string" ||
    typeof manifest.databasePath !== "string" ||
    typeof manifest.integrity !== "string" ||
    typeof manifest.conversationCount !== "number" ||
    typeof manifest.nativeEventCount !== "number"
  ) {
    throw new Error(`Native maintenance manifest schema is unsupported: ${target}`);
  }
  const { contentHash, ...body } = manifest as NativeMaintenanceManifest;
  if (contentHash !== stableHash(body)) {
    throw new Error(`Native maintenance manifest contentHash mismatch: ${target}`);
  }
  if (!Array.isArray(manifest.conversations)) {
    throw new Error(`Native maintenance manifest has no conversations array: ${target}`);
  }
  if (manifest.commandState !== undefined && !Array.isArray(manifest.commandState)) {
    throw new Error(`Native maintenance manifest has an invalid commandState array: ${target}`);
  }
  for (const conversation of manifest.conversations) {
    if (
      !conversation ||
      typeof conversation !== "object" ||
      typeof conversation.conversationId !== "string" ||
      !Array.isArray(conversation.nativeEvents)
    ) {
      throw new Error(`Native maintenance manifest has an invalid conversation entry: ${target}`);
    }
    for (const event of conversation.nativeEvents) {
      if (!event || typeof event !== "object") {
        throw new Error(`Native maintenance manifest has an invalid native event: ${target}`);
      }
      const attachmentSummary = normalizeAttachmentSummary(
        (event as { attachmentSummary?: unknown }).attachmentSummary,
      );
      if (!attachmentSummary) {
        throw new Error(`Native maintenance manifest has an invalid attachment summary: ${target}`);
      }
      (event as { attachmentSummary: AttachmentSummary }).attachmentSummary = attachmentSummary;
    }
  }
  return manifest as NativeMaintenanceManifest;
}

function verifyNativeMaintenanceManifest(
  db: DatabaseSync,
  dbPath: string,
  conversationIds: readonly string[],
  expected: NativeMaintenanceManifest,
  manifestPath: string | undefined,
  attachmentsRoot: string | undefined,
  integrity: string,
): {
  status: "passed";
  path: string;
  nativeEventCount: number;
  conversationCount: number;
  factsHash: string;
} {
  const hasPathAttachments = expected.conversations.some((conversation) =>
    conversation.nativeEvents.some((event) => event.attachmentSummary.pathRefs > 0),
  );
  if (hasPathAttachments && !attachmentsRoot) {
    throw new Error(
      "Native maintenance manifest contains path attachments; --attachments-root is required to verify file content.",
    );
  }
  const current = buildNativeMaintenanceManifest(db, dbPath, conversationIds, [], attachmentsRoot, integrity);
  const expectedFacts = nativeManifestFacts(expected);
  const currentFacts = nativeManifestFacts(current);
  const expectedHash = stableHash(expectedFacts);
  const currentHash = stableHash(currentFacts);
  if (expectedHash !== currentHash) {
    throw new Error(
      `Native maintenance manifest facts mismatch: expected ${expectedHash}, current ${currentHash}; ` +
        `expectedEvents=${expected.nativeEventCount}, currentEvents=${current.nativeEventCount}`,
    );
  }
  return {
    status: "passed",
    path: path.resolve(manifestPath ?? expected.databasePath),
    nativeEventCount: current.nativeEventCount,
    conversationCount: current.conversationCount,
    factsHash: currentHash,
  };
}

function nativeManifestFacts(manifest: NativeMaintenanceManifest): unknown {
  return {
    schemaVersion: manifest.schemaVersion,
    conversationCount: manifest.conversationCount,
    nativeEventCount: manifest.nativeEventCount,
    commandState: manifest.commandState ?? [],
    conversations: manifest.conversations.map(({ conversationId, nativeEvents }) => ({
      conversationId,
      nativeEvents,
    })),
  };
}

async function writeNativeMaintenanceManifest(
  pathname: string,
  manifest: NativeMaintenanceManifest,
): Promise<void> {
  const target = await assertNativeManifestPathAvailable(pathname);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function assertNativeManifestPathAvailable(pathname: string): Promise<string> {
  const target = path.resolve(pathname);
  let targetExists = false;
  try {
    await fs.access(target);
    targetExists = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  if (targetExists) throw new Error(`Native maintenance manifest already exists: ${target}`);
  return target;
}

function createPromptImageFileStore(attachmentsRoot: string | undefined): PromptImageFileStore | undefined {
  if (!attachmentsRoot?.trim()) return undefined;
  const rootDir = path.resolve(attachmentsRoot);
  return new PromptImageFileStore(path.dirname(rootDir), { rootDir });
}

function readIntegrityCheck(db: DatabaseSync): string {
  const row = db.prepare(`PRAGMA integrity_check`).get() as { integrity_check?: string } | undefined;
  return row?.integrity_check ?? "unknown";
}

function parseArguments(values: string[]): Arguments {
  let dbPath = "";
  let conversationId: string | undefined;
  let all = false;
  let apply = false;
  let cutover = false;
  let repairLegacyAttachments = false;
  let backupPath: string | undefined;
  let attachmentsRoot: string | undefined;
  let nativeManifestPath: string | undefined;
  let verifyNativeManifestPath: string | undefined;
  let reconcileNativeManifestPath: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--db") {
      dbPath = values[++index] ?? "";
    } else if (value === "--conversation") {
      conversationId = values[++index] ?? "";
    } else if (value === "--all") {
      all = true;
    } else if (value === "--apply") {
      apply = true;
    } else if (value === "--cutover") {
      cutover = true;
    } else if (value === "--repair-legacy-attachments") {
      repairLegacyAttachments = true;
    } else if (value === "--backup") {
      backupPath = values[++index] ?? "";
    } else if (value === "--attachments-root") {
      attachmentsRoot = values[++index] ?? "";
    } else if (value === "--native-manifest") {
      nativeManifestPath = values[++index] ?? "";
    } else if (value === "--verify-native-manifest") {
      verifyNativeManifestPath = values[++index] ?? "";
    } else if (value === "--reconcile-native-manifest") {
      reconcileNativeManifestPath = values[++index] ?? "";
    } else if (value === "--help" || value === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!dbPath.trim()) {
    printUsage();
    throw new Error("--db is required.");
  }
  if (all === Boolean(conversationId?.trim())) {
    printUsage();
    throw new Error("Choose exactly one of --conversation <id> or --all.");
  }
  if (cutover && (!all || !apply || !backupPath?.trim())) {
    printUsage();
    throw new Error("--cutover requires --all --apply and --backup <path>.");
  }
  if (repairLegacyAttachments && (cutover || !all || !apply || !backupPath?.trim())) {
    printUsage();
    throw new Error("--repair-legacy-attachments requires --all --apply --backup and cannot use --cutover.");
  }
  if (backupPath && !cutover && !repairLegacyAttachments) {
    throw new Error("--backup is only valid with --cutover.");
  }
  if (nativeManifestPath !== undefined && !nativeManifestPath.trim()) {
    throw new Error("--native-manifest requires a file path.");
  }
  if (verifyNativeManifestPath !== undefined && !verifyNativeManifestPath.trim()) {
    throw new Error("--verify-native-manifest requires a file path.");
  }
  if (reconcileNativeManifestPath !== undefined && !reconcileNativeManifestPath.trim()) {
    throw new Error("--reconcile-native-manifest requires a file path.");
  }
  if (nativeManifestPath && verifyNativeManifestPath) {
    throw new Error("Choose one of --native-manifest or --verify-native-manifest.");
  }
  if (nativeManifestPath && (!all || apply || cutover)) {
    throw new Error("--native-manifest is only valid with a read-only --all dry-run.");
  }
  if (verifyNativeManifestPath && (!all || apply || cutover)) {
    throw new Error("--verify-native-manifest is only valid with a read-only --all dry-run.");
  }
  if (reconcileNativeManifestPath && (!all || !apply || !cutover)) {
    throw new Error(
      "--reconcile-native-manifest is only valid with --all --apply --cutover and authorizes native fact reconciliation.",
    );
  }
  if (reconcileNativeManifestPath && (nativeManifestPath || verifyNativeManifestPath)) {
    throw new Error("Choose one of native manifest export/verify or --reconcile-native-manifest.");
  }
  if (
    repairLegacyAttachments &&
    (nativeManifestPath || verifyNativeManifestPath || reconcileNativeManifestPath)
  ) {
    throw new Error("--repair-legacy-attachments cannot be combined with a native manifest option.");
  }
  return {
    dbPath,
    conversationId,
    all,
    apply,
    cutover,
    repairLegacyAttachments,
    ...(backupPath ? { backupPath } : {}),
    ...(attachmentsRoot?.trim() ? { attachmentsRoot: path.resolve(attachmentsRoot) } : {}),
    ...(nativeManifestPath?.trim() ? { nativeManifestPath: path.resolve(nativeManifestPath) } : {}),
    ...(verifyNativeManifestPath?.trim()
      ? { verifyNativeManifestPath: path.resolve(verifyNativeManifestPath) }
      : {}),
    ...(reconcileNativeManifestPath?.trim()
      ? { reconcileNativeManifestPath: path.resolve(reconcileNativeManifestPath) }
      : {}),
  };
}

function printUsage(): void {
  process.stderr.write(
    "Usage: bun scripts/conversation-v2-migrate.ts --db /path/eco-coding.sqlite --conversation THREAD_ID [--apply]\n" +
      "       bun scripts/conversation-v2-migrate.ts --db /path/eco-coding.sqlite --all [--attachments-root /path/prompt-images] [--native-manifest /path/native-manifest.json | --verify-native-manifest /path/native-manifest.json]\n" +
      "       bun scripts/conversation-v2-migrate.ts --db /path/eco-coding.sqlite --all --apply --cutover --backup /path/backup.sqlite [--attachments-root /path/prompt-images] [--reconcile-native-manifest /path/native-manifest.json]\n" +
      "       bun scripts/conversation-v2-migrate.ts --db /path/eco-coding.sqlite --all --apply --repair-legacy-attachments --backup /path/backup.sqlite --attachments-root /path/prompt-images\n",
  );
}
