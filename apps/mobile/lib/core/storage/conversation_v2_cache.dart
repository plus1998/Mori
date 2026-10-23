import 'dart:convert';

import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

import '../models/conversation_v2_models.dart';
import '../utils/conversation_v2_hash.dart';

class ConversationV2EntityRepairError extends StateError {
  ConversationV2EntityRepairError(super.message);
}

/// A presentation read uses one epoch and one SQLite transaction, so a push or
/// bootstrap cannot interleave a different cursor with the displayed entities.
typedef ConversationV2PresentationSnapshot = ({
  ConversationV2CacheState? cacheState,
  List<ConversationV2Message> messages,
  List<ConversationV2Run> runs,
  List<ConversationV2Tool> tools,
  List<ConversationV2Agent> agents,
  List<ConversationV2Todo> todos,
});

abstract interface class ConversationV2CachePort {
  Future<ConversationV2CacheState?> state(String conversationId);

  Future<String?> effectHash(String conversationId, int seq);

  Future<List<ConversationV2Message>> messages(String conversationId);

  Future<List<ConversationV2Tool>> tools(
    String conversationId, [
    String? runId,
  ]);

  Future<List<ConversationV2Agent>> agents(String conversationId);

  Future<List<ConversationV2Todo>> todos(String conversationId);

  Future<void> installBootstrap(ConversationV2Bootstrap bootstrap);

  /// Persist the live state after a bootstrap that already reaches the
  /// authoritative head and therefore has no sync page to apply.
  Future<void> markLive(String conversationId);

  Future<void> applySyncPage(ConversationV2SyncPage page);

  Future<void> repairMessage(ConversationV2Message message);

  Future<void> applyMessagePage(ConversationV2MessagePage page);

  Future<void> applyDetailsPage(
    ConversationV2DetailPage page,
    String runId, {
    String? agentId,
    String? toolCallId,
  });

  Future<void> applyToolsPage(ConversationV2ToolsPage page);
}

class ConversationV2PendingThreadDelete {
  const ConversationV2PendingThreadDelete({
    required this.principalId,
    required this.threadId,
    required this.clientCommandId,
    required this.expectedHistoryRevision,
    required this.createdAt,
  });

  final String principalId;
  final String threadId;
  final String clientCommandId;
  final int expectedHistoryRevision;
  final String createdAt;
}

abstract interface class ConversationV2ThreadDeleteCommandStore {
  Future<ConversationV2PendingThreadDelete?> pendingThreadDelete(
    String threadId,
  );

  Future<void> putPendingThreadDelete(
    ConversationV2PendingThreadDelete command,
  );

  Future<void> removePendingThreadDelete(
    String threadId,
    String clientCommandId,
  );
}

class ConversationV2Cache
    implements ConversationV2CachePort, ConversationV2ThreadDeleteCommandStore {
  ConversationV2Cache({
    required this.accountId,
    required this.desktopDeviceId,
    DatabaseFactory? databaseFactory,
    String? databasePath,
  }) : _databaseFactoryOverride = databaseFactory,
       _databasePathOverride = databasePath;

  final String accountId;
  final String desktopDeviceId;
  final DatabaseFactory? _databaseFactoryOverride;
  final String? _databasePathOverride;
  Database? _database;
  Future<void>? _openFuture;

  @override
  Future<String?> effectHash(String conversationId, int seq) async {
    final current = await state(conversationId);
    if (current == null) return null;
    final rows = await (await _db()).query(
      'conversation_v2_effects',
      columns: ['effect_hash'],
      where: '${_scopeWhere(current.storeEpoch)} AND seq = ?',
      whereArgs: [..._scopeArgs(current.storeEpoch, conversationId), seq],
      limit: 1,
    );
    return rows.isEmpty ? null : rows.single['effect_hash'] as String;
  }

  Future<void> open() async {
    if (_database != null) return;
    final pending = _openFuture;
    if (pending != null) {
      await pending;
      return;
    }
    final opening = _openInternal();
    _openFuture = opening;
    try {
      await opening;
    } finally {
      if (identical(_openFuture, opening)) _openFuture = null;
    }
  }

  Future<void> _openInternal() async {
    final factory = _databaseFactoryOverride ?? databaseFactory;
    final path =
        _databasePathOverride ??
        p.join(await factory.getDatabasesPath(), 'eco-conversation-v2.sqlite');
    _database = await factory.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: 11,
        onCreate: (db, _) async {
          await db.execute('''
          CREATE TABLE conversation_v2_state (
            account_id TEXT NOT NULL,
            desktop_device_id TEXT NOT NULL,
            store_epoch TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            applied_seq INTEGER NOT NULL DEFAULT 0,
            snapshot_seq INTEGER NOT NULL DEFAULT 0,
            history_revision INTEGER NOT NULL DEFAULT 0,
            history_cursor TEXT,
            has_older INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL,
            error TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (account_id, desktop_device_id, store_epoch, conversation_id)
          )
        ''');
          await db.execute('''
          CREATE TABLE conversation_v2_messages (
            account_id TEXT NOT NULL,
            desktop_device_id TEXT NOT NULL,
            store_epoch TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            run_id TEXT,
            role TEXT NOT NULL,
            channel TEXT NOT NULL,
            created_seq INTEGER NOT NULL,
            version_seq INTEGER NOT NULL,
            content_version INTEGER NOT NULL,
            body TEXT NOT NULL,
            attachments_json TEXT,
            status TEXT NOT NULL,
            is_deleted INTEGER NOT NULL,
            occurred_at TEXT,
            provider_role TEXT,
            agent_id TEXT,
            agent_instance_id TEXT,
            history_activity_line_id TEXT,
            history_user_message_id TEXT,
            PRIMARY KEY (account_id, desktop_device_id, store_epoch, conversation_id, message_id)
          )
        ''');
          await db.execute('''
          CREATE INDEX conversation_v2_messages_position
          ON conversation_v2_messages(account_id, desktop_device_id, store_epoch, conversation_id, created_seq, message_id)
        ''');
          await db.execute('''
          CREATE TABLE conversation_v2_runs (
            account_id TEXT NOT NULL,
            desktop_device_id TEXT NOT NULL,
            store_epoch TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            status TEXT NOT NULL,
            version_seq INTEGER NOT NULL,
            started_at TEXT,
            ended_at TEXT,
            timing_quality TEXT NOT NULL,
            retry_of_run_id TEXT,
            regeneration_of_run_id TEXT,
            PRIMARY KEY (account_id, desktop_device_id, store_epoch, conversation_id, run_id)
          )
        ''');
          await _createToolTables(db);
          await _createAgentTable(db);
          await _createTodoTable(db);
          await db.execute('''
          CREATE TABLE conversation_v2_effects (
            account_id TEXT NOT NULL,
            desktop_device_id TEXT NOT NULL,
            store_epoch TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            effect_hash TEXT NOT NULL,
            PRIMARY KEY (account_id, desktop_device_id, store_epoch, conversation_id, seq)
          )
        ''');
          await db.execute('''
          CREATE TABLE conversation_v2_pending_commands (
            account_id TEXT NOT NULL,
            desktop_device_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            client_command_id TEXT NOT NULL,
          text TEXT NOT NULL,
          attachments_json TEXT,
          created_at TEXT NOT NULL,
            PRIMARY KEY (account_id, desktop_device_id, conversation_id, client_command_id)
          )
        ''');
          await _createPendingThreadDeleteTable(db);
          await _createDetailTables(db);
        },
        onUpgrade: (db, oldVersion, _) async {
          if (oldVersion < 2) await _createDetailTables(db);
          if (oldVersion < 8) await _upgradeToV8(db);
          if (oldVersion < 9) await _createPendingThreadDeleteTable(db);
          if (oldVersion < 10) await _createTodoTable(db);
          if (oldVersion < 11) await _upgradeToV11(db);
          if (oldVersion < 3) {
            await _addColumnIfMissing(
              db,
              'conversation_v2_pending_commands',
              'attachments_json',
              'TEXT',
            );
          }
          if (oldVersion < 4) {
            await _addColumnIfMissing(
              db,
              'conversation_v2_state',
              'snapshot_seq',
              'INTEGER NOT NULL DEFAULT 0',
            );
          }
          if (oldVersion < 5) {
            await _addColumnIfMissing(
              db,
              'conversation_v2_details',
              'agent_instance_id',
              'TEXT',
            );
            await _addColumnIfMissing(
              db,
              'conversation_v2_details',
              'parent_agent_instance_id',
              'TEXT',
            );
            await _addColumnIfMissing(
              db,
              'conversation_v2_details',
              'parent_agent_id',
              'TEXT',
            );
            await _addColumnIfMissing(
              db,
              'conversation_v2_details',
              'parent_tool_call_id',
              'TEXT',
            );
          }
          if (oldVersion < 6) {
            await _addColumnIfMissing(
              db,
              'conversation_v2_runs',
              'retry_of_run_id',
              'TEXT',
            );
            await _addColumnIfMissing(
              db,
              'conversation_v2_runs',
              'regeneration_of_run_id',
              'TEXT',
            );
            await _createToolTables(db);
          }
          if (oldVersion < 7) {
            await _addColumnIfMissing(
              db,
              'conversation_v2_messages',
              'attachments_json',
              'TEXT',
            );
          }
        },
      ),
    );
  }

  @override
  Future<ConversationV2CacheState?> state(String conversationId) async {
    return _readState(await _db(), conversationId);
  }

  Future<ConversationV2CacheState?> _readState(
    DatabaseExecutor db,
    String conversationId,
  ) async {
    final rows = await db.query(
      'conversation_v2_state',
      where: 'account_id = ? AND desktop_device_id = ? AND conversation_id = ?',
      whereArgs: [accountId, desktopDeviceId, conversationId],
      // updated_at is informational and may move backwards with a device
      // clock correction. rowid reflects the replace/insert order of the
      // current state row and is the only safe tie-breaker across epochs.
      orderBy: 'rowid DESC',
      limit: 1,
    );
    return rows.isEmpty ? null : ConversationV2CacheState.fromRow(rows.first);
  }

  /// Read the five presentation collections with a single state lookup instead
  /// of resolving the same epoch again for each collection.
  Future<ConversationV2PresentationSnapshot> presentationSnapshot(
    String conversationId,
  ) async {
    final db = await _db();
    return db.transaction((txn) async {
      final current = await _readState(txn, conversationId);
      if (current == null) {
        return (
          cacheState: null,
          messages: <ConversationV2Message>[],
          runs: <ConversationV2Run>[],
          tools: <ConversationV2Tool>[],
          agents: <ConversationV2Agent>[],
          todos: <ConversationV2Todo>[],
        );
      }
      return (
        cacheState: current,
        messages: await _readMessages(txn, current),
        runs: await _readRuns(txn, current),
        tools: await _readTools(txn, current),
        agents: await _readAgents(txn, current),
        todos: await _readTodos(txn, current),
      );
    }, exclusive: false);
  }

  @override
  Future<List<ConversationV2Message>> messages(String conversationId) async {
    final current = await state(conversationId);
    if (current == null) return const [];
    return _readMessages(await _db(), current);
  }

  Future<List<ConversationV2Message>> _readMessages(
    DatabaseExecutor db,
    ConversationV2CacheState current,
  ) async {
    final rows = await db.query(
      'conversation_v2_messages',
      where: _scopeWhere(current.storeEpoch),
      whereArgs: _scopeArgs(current.storeEpoch, current.conversationId),
      orderBy: 'created_seq ASC, message_id ASC',
    );
    return rows.map(_messageFromRow).toList(growable: false);
  }

  Future<List<ConversationV2Run>> runs(String conversationId) async {
    final current = await state(conversationId);
    if (current == null) return const [];
    return _readRuns(await _db(), current);
  }

  Future<List<ConversationV2Run>> _readRuns(
    DatabaseExecutor db,
    ConversationV2CacheState current,
  ) async {
    final rows = await db.query(
      'conversation_v2_runs',
      where: _scopeWhere(current.storeEpoch),
      whereArgs: _scopeArgs(current.storeEpoch, current.conversationId),
      orderBy: 'version_seq DESC, run_id DESC',
    );
    return rows.map(_runFromRow).toList(growable: false);
  }

  @override
  Future<List<ConversationV2Tool>> tools(
    String conversationId, [
    String? runId,
  ]) async {
    final current = await state(conversationId);
    if (current == null) return const [];
    return _readTools(await _db(), current, runId);
  }

  Future<List<ConversationV2Tool>> _readTools(
    DatabaseExecutor db,
    ConversationV2CacheState current, [
    String? runId,
  ]) async {
    final normalizedRunId = runId?.trim();
    final filterByRun = normalizedRunId != null && normalizedRunId.isNotEmpty;
    final rows = await db.query(
      'conversation_v2_tools',
      where: filterByRun
          ? '${_scopeWhere(current.storeEpoch)} AND run_id = ?'
          : _scopeWhere(current.storeEpoch),
      whereArgs: filterByRun
          ? [
              ..._scopeArgs(current.storeEpoch, current.conversationId),
              normalizedRunId,
            ]
          : _scopeArgs(current.storeEpoch, current.conversationId),
      orderBy: 'created_seq ASC, tool_call_id ASC',
    );
    return rows.map(_toolFromRow).toList(growable: false);
  }

  @override
  Future<List<ConversationV2Agent>> agents(String conversationId) async {
    final current = await state(conversationId);
    if (current == null) return const [];
    return _readAgents(await _db(), current);
  }

  Future<List<ConversationV2Agent>> _readAgents(
    DatabaseExecutor db,
    ConversationV2CacheState current,
  ) async {
    final rows = await db.query(
      'conversation_v2_agents',
      where: _scopeWhere(current.storeEpoch),
      whereArgs: _scopeArgs(current.storeEpoch, current.conversationId),
      orderBy: 'version_seq ASC, agent_id ASC',
    );
    return rows.map(_agentFromRow).toList(growable: false);
  }

  @override
  Future<List<ConversationV2Todo>> todos(String conversationId) async {
    final current = await state(conversationId);
    if (current == null) return const [];
    return _readTodos(await _db(), current);
  }

  Future<List<ConversationV2Todo>> _readTodos(
    DatabaseExecutor db,
    ConversationV2CacheState current,
  ) async {
    final rows = await db.query(
      'conversation_v2_todos',
      where: _scopeWhere(current.storeEpoch),
      whereArgs: _scopeArgs(current.storeEpoch, current.conversationId),
      orderBy: 'position ASC, todo_id ASC',
    );
    return rows.map(_todoFromRow).toList(growable: false);
  }

  Future<List<ConversationV2Detail>> details(
    String conversationId,
    String runId,
  ) async {
    final current = await state(conversationId);
    if (current == null) return const [];
    final rows = await (await _db()).query(
      'conversation_v2_details',
      where: '${_scopeWhere(current.storeEpoch)} AND run_id = ?',
      whereArgs: [..._scopeArgs(current.storeEpoch, conversationId), runId],
      orderBy: 'created_seq ASC, item_id ASC',
    );
    return rows.map(_detailFromRow).toList(growable: false);
  }

  /// Recent compaction lifecycle rows plus each owner's latest state.
  ///
  /// Context compaction is represented as V2 detail rows rather than tool
  /// summaries. The Feed needs them even when the user never opens a detail
  /// panel, so read a bounded projection view instead of hydrating every
  /// detail owned by the conversation.
  Future<List<ConversationV2Detail>> compactionDetails(
    String conversationId,
  ) async {
    final current = await state(conversationId);
    if (current == null) return const [];
    final placeholders = List.filled(
      conversationV2ContextCompactionTypes.length,
      '?',
    ).join(', ');
    final rows = await (await _db()).rawQuery(
      '''
      WITH compaction AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(agent_instance_id, agent_id, '')
            ORDER BY created_seq DESC, item_id DESC
          ) AS owner_rank,
          ROW_NUMBER() OVER (
            ORDER BY created_seq DESC, item_id DESC
          ) AS recent_rank
        FROM conversation_v2_details
        WHERE ${_scopeWhere(current.storeEpoch)}
          AND type IN ($placeholders)
      )
      SELECT * FROM compaction
      WHERE owner_rank = 1 OR recent_rank <= 100
      ORDER BY created_seq ASC, item_id ASC
      ''',
      [
        ..._scopeArgs(current.storeEpoch, conversationId),
        ...conversationV2ContextCompactionTypes,
      ],
    );
    return rows.map(_detailFromRow).toList(growable: false);
  }

  @override
  Future<void> installBootstrap(ConversationV2Bootstrap bootstrap) async {
    _validateBootstrap(bootstrap);
    final db = await _db();
    await db.transaction((txn) async {
      final currentRows = await txn.query(
        'conversation_v2_state',
        where:
            'account_id = ? AND desktop_device_id = ? AND conversation_id = ?',
        whereArgs: [accountId, desktopDeviceId, bootstrap.conversationId],
        orderBy: 'rowid DESC',
        limit: 1,
      );
      final current = currentRows.isEmpty
          ? null
          : ConversationV2CacheState.fromRow(currentRows.first);
      final sameEpoch = current?.storeEpoch == bootstrap.storeEpoch;
      final appliedSeq = sameEpoch
          ? (current!.appliedSeq > bootstrap.snapshotSeq
                ? current.appliedSeq
                : bootstrap.snapshotSeq)
          : bootstrap.snapshotSeq;
      final snapshotSeq = sameEpoch
          ? (current!.snapshotSeq > bootstrap.snapshotSeq
                ? current.snapshotSeq
                : bootstrap.snapshotSeq)
          : bootstrap.snapshotSeq;
      final keepNewerHistory =
          sameEpoch &&
          (current!.historyRevision > bootstrap.historyRevision ||
              (current.historyRevision == bootstrap.historyRevision &&
                  (current.historyCursor != null || current.hasOlder)));
      final historyRevision = keepNewerHistory
          ? current.historyRevision
          : bootstrap.historyRevision;
      for (final message in bootstrap.messages) {
        await _upsertMessage(txn, bootstrap.storeEpoch, message);
      }
      for (final run in bootstrap.runs) {
        await _upsertRun(txn, bootstrap.storeEpoch, run);
      }
      for (final tool in bootstrap.tools) {
        await _upsertTool(txn, bootstrap.storeEpoch, tool);
      }
      for (final agent in bootstrap.agents) {
        await _upsertAgent(txn, bootstrap.storeEpoch, agent);
      }
      for (final detail in bootstrap.details) {
        await _upsertDetail(txn, bootstrap.storeEpoch, detail);
      }
      if (!sameEpoch || current!.appliedSeq <= bootstrap.snapshotSeq) {
        await txn.delete(
          'conversation_v2_todos',
          where: _scopeWhere(bootstrap.storeEpoch),
          whereArgs: _scopeArgs(bootstrap.storeEpoch, bootstrap.conversationId),
        );
        for (final todo in bootstrap.todos) {
          await _insertTodo(txn, bootstrap.storeEpoch, todo);
        }
      }
      await _upsertState(
        txn,
        ConversationV2CacheState(
          accountId: accountId,
          desktopDeviceId: desktopDeviceId,
          storeEpoch: bootstrap.storeEpoch,
          conversationId: bootstrap.conversationId,
          appliedSeq: appliedSeq,
          snapshotSeq: snapshotSeq,
          historyRevision: historyRevision,
          historyCursor: keepNewerHistory
              ? current.historyCursor
              : bootstrap.olderCursor,
          hasOlder: keepNewerHistory ? current.hasOlder : bootstrap.hasOlder,
          state: ConversationV2SyncState.catchingUp,
          error: null,
          updatedAt: DateTime.now().toUtc().toIso8601String(),
        ),
      );
    });
  }

  @override
  Future<void> markLive(String conversationId) async {
    final db = await _db();
    await db.transaction((txn) async {
      final rows = await txn.query(
        'conversation_v2_state',
        where: _identityWhere(conversationId),
        whereArgs: [accountId, desktopDeviceId, conversationId],
        orderBy: 'rowid DESC',
        limit: 1,
      );
      if (rows.isEmpty) {
        throw StateError(
          'Conversation V2 bootstrap is required before live state.',
        );
      }
      final current = ConversationV2CacheState.fromRow(rows.first);
      await _upsertState(
        txn,
        current.copyWith(
          state: ConversationV2SyncState.live,
          error: null,
          updatedAt: DateTime.now().toUtc().toIso8601String(),
        ),
      );
    });
  }

  @override
  Future<void> applySyncPage(ConversationV2SyncPage page) async {
    final db = await _db();
    await db.transaction((txn) async {
      if (page.protocolVersion != 2 || page.conversationId.trim().isEmpty) {
        throw StateError(
          'Conversation V2 sync page protocol version is unsupported.',
        );
      }
      final currentRows = await txn.query(
        'conversation_v2_state',
        where: _identityWhere(page.conversationId),
        whereArgs: [accountId, desktopDeviceId, page.conversationId],
        orderBy: 'rowid DESC',
        limit: 1,
      );
      if (currentRows.isEmpty) {
        throw StateError('Conversation V2 bootstrap is required before sync.');
      }
      var current = ConversationV2CacheState.fromRow(currentRows.first);
      if (current.storeEpoch != page.storeEpoch) {
        throw StateError('Conversation V2 store epoch changed.');
      }
      if (page.fromSeq != current.appliedSeq + 1 ||
          page.fromSeq < 1 ||
          page.throughSeq < 0 ||
          page.headSeq < 0 ||
          page.headSeq < current.appliedSeq ||
          page.throughSeq < current.appliedSeq ||
          page.throughSeq > page.headSeq ||
          page.fromSeq > page.throughSeq + 1) {
        throw StateError('Conversation V2 sync page range is invalid.');
      }
      if (!page.hasMore && page.throughSeq < page.headSeq) {
        throw StateError(
          'Conversation V2 sync page stopped before its advertised head.',
        );
      }
      if (page.hasMore && page.throughSeq >= page.headSeq) {
        throw StateError(
          'Conversation V2 sync page advertises more data at the head.',
        );
      }
      for (final effect in page.effects) {
        if (effect.seq <= 0 ||
            effect.seq > page.headSeq ||
            effect.effectHash.trim().isEmpty ||
            effect.type.trim().isEmpty ||
            !conversationV2SupportedEffectTypes.contains(effect.type)) {
          if (effect.type.trim().isNotEmpty &&
              !conversationV2SupportedEffectTypes.contains(effect.type)) {
            throw StateError(
              'Conversation V2 effect ${effect.type} is unsupported.',
            );
          }
          throw StateError('Conversation V2 effect sequence is invalid.');
        }
        if (effect.effectHash != conversationV2StableHash(effect.payload)) {
          throw StateError('Conversation V2 effect hash is invalid.');
        }
        if (effect.effectVersion != 1) {
          throw StateError(
            'Conversation V2 effect version ${effect.effectVersion} is unsupported.',
          );
        }
        if (effect.seq <= current.appliedSeq) {
          final existing = await txn.query(
            'conversation_v2_effects',
            columns: ['effect_hash'],
            where: '${_scopeWhere(page.storeEpoch)} AND seq = ?',
            whereArgs: [
              ..._scopeArgs(page.storeEpoch, page.conversationId),
              effect.seq,
            ],
            limit: 1,
          );
          if (existing.isEmpty && effect.seq <= current.snapshotSeq) {
            // Bootstrap is an authoritative snapshot, but it does not carry
            // hashes for every effect up to snapshotSeq. A delayed push from
            // that already-installed prefix is therefore safely ignored;
            // hashes are enforced for all effects applied after the snapshot.
            continue;
          }
          if (existing.isEmpty ||
              existing.first['effect_hash'] != effect.effectHash) {
            throw StateError(
              'Conversation V2 duplicate sequence has a different effect.',
            );
          }
          continue;
        }
        if (effect.seq != current.appliedSeq + 1) {
          throw StateError('Conversation V2 sync range has a gap.');
        }
        if (effect.type == 'history.invalidation') {
          final revision = effect.payload['historyRevision'];
          if (revision is! int || revision < current.historyRevision) {
            throw StateError('History invalidation regressed the revision.');
          }
        }
        await txn.insert('conversation_v2_effects', {
          'account_id': accountId,
          'desktop_device_id': desktopDeviceId,
          'store_epoch': page.storeEpoch,
          'conversation_id': page.conversationId,
          'seq': effect.seq,
          'effect_hash': effect.effectHash,
        });
        await _applyEffect(txn, page.storeEpoch, page.conversationId, effect);
        if (effect.type == 'history.invalidation') {
          final revision = effect.payload['historyRevision'] as int;
          current = current.copyWith(
            historyRevision: revision,
            clearHistoryCursor: true,
            hasOlder: false,
          );
        }
        current = current.copyWith(appliedSeq: effect.seq);
      }
      if (page.effects.isEmpty && page.headSeq > current.appliedSeq) {
        throw StateError('Conversation V2 empty sync page makes no progress.');
      }
      if (page.effects.isEmpty && page.throughSeq != current.appliedSeq) {
        throw StateError('Conversation V2 empty sync page advances the range.');
      }
      if (page.effects.isNotEmpty && page.throughSeq != current.appliedSeq) {
        throw StateError(
          'Conversation V2 sync page throughSeq does not match effects.',
        );
      }
      await _upsertState(
        txn,
        current.copyWith(
          state: page.hasMore
              ? ConversationV2SyncState.catchingUp
              : ConversationV2SyncState.live,
          error: null,
          updatedAt: DateTime.now().toUtc().toIso8601String(),
        ),
      );
    });
  }

  @override
  Future<void> repairMessage(ConversationV2Message message) async {
    final db = await _db();
    await db.transaction((txn) async {
      final currentRows = await txn.query(
        'conversation_v2_state',
        where: _identityWhere(message.conversationId),
        whereArgs: [accountId, desktopDeviceId, message.conversationId],
        orderBy: 'rowid DESC',
        limit: 1,
      );
      if (currentRows.isEmpty) {
        throw StateError(
          'Conversation V2 bootstrap is required before entity repair.',
        );
      }
      final current = ConversationV2CacheState.fromRow(currentRows.first);
      await _upsertMessage(txn, current.storeEpoch, message);
    });
  }

  @override
  Future<void> applyMessagePage(ConversationV2MessagePage page) async {
    final db = await _db();
    await db.transaction((txn) async {
      if (page.protocolVersion != 2 || page.conversationId.trim().isEmpty) {
        throw StateError(
          'Conversation V2 history page protocol version is unsupported.',
        );
      }
      final currentRows = await txn.query(
        'conversation_v2_state',
        where: _identityWhere(page.conversationId),
        whereArgs: [accountId, desktopDeviceId, page.conversationId],
        orderBy: 'rowid DESC',
        limit: 1,
      );
      if (currentRows.isEmpty) {
        throw StateError(
          'Conversation V2 bootstrap is required before history paging.',
        );
      }
      final current = ConversationV2CacheState.fromRow(currentRows.first);
      if (current.storeEpoch != page.storeEpoch) {
        throw StateError(
          'Conversation V2 history page belongs to another epoch.',
        );
      }
      if (page.historyRevision < current.historyRevision) {
        throw StateError('Conversation V2 history page is stale.');
      }
      if (page.readSeq < 0 ||
          page.hasMore && page.nextCursor == null ||
          !page.hasMore && page.nextCursor != null) {
        throw StateError('Conversation V2 history page metadata is invalid.');
      }
      for (final run in page.runs) {
        if (run.conversationId != page.conversationId) {
          throw StateError('Conversation V2 history run belongs elsewhere.');
        }
        await _upsertRun(txn, page.storeEpoch, run);
      }
      for (final tool in page.tools) {
        if (tool.conversationId != page.conversationId) {
          throw StateError('Conversation V2 history tool belongs elsewhere.');
        }
        await _upsertTool(txn, page.storeEpoch, tool);
      }
      for (final agent in page.agents) {
        if (agent.conversationId != page.conversationId) {
          throw StateError('Conversation V2 history agent belongs elsewhere.');
        }
        await _upsertAgent(txn, page.storeEpoch, agent);
      }
      for (final message in page.messages) {
        if (message.conversationId != page.conversationId) {
          throw StateError(
            'Conversation V2 history message belongs elsewhere.',
          );
        }
        await _upsertMessage(txn, page.storeEpoch, message);
      }
      await _upsertState(
        txn,
        current.copyWith(
          historyRevision: page.historyRevision,
          historyCursor: page.nextCursor,
          hasOlder: page.hasMore,
          error: null,
          updatedAt: DateTime.now().toUtc().toIso8601String(),
        ),
      );
    });
  }

  @override
  Future<void> applyDetailsPage(
    ConversationV2DetailPage page,
    String runId, {
    String? agentId,
    String? toolCallId,
  }) async {
    final db = await _db();
    await db.transaction((txn) async {
      if (page.protocolVersion != 2 || page.conversationId.trim().isEmpty) {
        throw StateError(
          'Conversation V2 detail page protocol version is unsupported.',
        );
      }
      final currentRows = await txn.query(
        'conversation_v2_state',
        where: _identityWhere(page.conversationId),
        whereArgs: [accountId, desktopDeviceId, page.conversationId],
        orderBy: 'rowid DESC',
        limit: 1,
      );
      if (currentRows.isEmpty) {
        throw StateError(
          'Conversation V2 bootstrap is required before detail paging.',
        );
      }
      final current = ConversationV2CacheState.fromRow(currentRows.first);
      if (current.storeEpoch != page.storeEpoch) {
        throw StateError(
          'Conversation V2 detail page belongs to another epoch.',
        );
      }
      if (page.historyRevision < current.historyRevision) {
        throw StateError('Conversation V2 detail page is stale.');
      }
      if (page.readSeq < 0 ||
          page.hasMore && page.nextCursor == null ||
          !page.hasMore && page.nextCursor != null) {
        throw StateError('Conversation V2 detail page metadata is invalid.');
      }
      if (page.hasMore && page.nextCursor == null) {
        throw StateError(
          'Conversation V2 detail page has no continuation cursor.',
        );
      }
      for (final detail in page.items) {
        if (detail.conversationId != page.conversationId ||
            detail.runId != runId) {
          throw StateError('Conversation V2 detail belongs to another run.');
        }
        await _upsertDetail(txn, page.storeEpoch, detail);
      }
      await txn.insert('conversation_v2_detail_cursors', {
        'account_id': accountId,
        'desktop_device_id': desktopDeviceId,
        'store_epoch': page.storeEpoch,
        'conversation_id': page.conversationId,
        'run_id': runId,
        'agent_id': agentId ?? '',
        'tool_call_id': toolCallId ?? '',
        'cursor': page.nextCursor,
        'has_more': page.hasMore ? 1 : 0,
        'read_seq': page.readSeq,
        'history_revision': page.historyRevision,
      }, conflictAlgorithm: ConflictAlgorithm.replace);
      final nextState = page.historyRevision > current.historyRevision
          ? current.copyWith(
              historyRevision: page.historyRevision,
              clearHistoryCursor: true,
              hasOlder: false,
            )
          : current;
      await _upsertState(
        txn,
        nextState.copyWith(
          error: null,
          updatedAt: DateTime.now().toUtc().toIso8601String(),
        ),
      );
    });
  }

  @override
  Future<void> applyToolsPage(ConversationV2ToolsPage page) async {
    final db = await _db();
    await db.transaction((txn) async {
      if (page.protocolVersion != 2 || page.conversationId.trim().isEmpty) {
        throw StateError(
          'Conversation V2 tool page protocol version is unsupported.',
        );
      }
      final currentRows = await txn.query(
        'conversation_v2_state',
        where: _identityWhere(page.conversationId),
        whereArgs: [accountId, desktopDeviceId, page.conversationId],
        orderBy: 'rowid DESC',
        limit: 1,
      );
      if (currentRows.isEmpty) {
        throw StateError(
          'Conversation V2 bootstrap is required before tool paging.',
        );
      }
      final current = ConversationV2CacheState.fromRow(currentRows.first);
      if (current.storeEpoch != page.storeEpoch) {
        throw StateError('Conversation V2 tool page belongs to another epoch.');
      }
      if (page.readSeq < 0 || page.readSeq > current.appliedSeq) {
        throw StateError(
          'Conversation V2 tool page is ahead of the durable effect cursor.',
        );
      }
      if (page.historyRevision != current.historyRevision) {
        throw StateError(
          'Conversation V2 tool page history revision does not match the cache.',
        );
      }
      if (page.readSeq < 0 ||
          page.totalCount < page.tools.length ||
          page.hasMore && page.nextCursor == null ||
          !page.hasMore && page.nextCursor != null) {
        throw StateError('Conversation V2 tool page metadata is invalid.');
      }
      for (final tool in page.tools) {
        if (tool.conversationId != page.conversationId ||
            tool.runId != page.runId) {
          throw StateError('Conversation V2 tool belongs to another run.');
        }
        await _upsertTool(txn, page.storeEpoch, tool);
      }
      final nextState = page.historyRevision > current.historyRevision
          ? current.copyWith(
              historyRevision: page.historyRevision,
              clearHistoryCursor: true,
              hasOlder: false,
            )
          : current;
      await _upsertState(
        txn,
        nextState.copyWith(
          error: null,
          updatedAt: DateTime.now().toUtc().toIso8601String(),
        ),
      );
    });
  }

  Future<void> addPendingCommand(ConversationV2PendingCommand command) async {
    await (await _db()).insert('conversation_v2_pending_commands', {
      'account_id': accountId,
      'desktop_device_id': desktopDeviceId,
      'conversation_id': command.conversationId,
      'client_command_id': command.clientCommandId,
      'text': command.text,
      'attachments_json': command.attachments == null
          ? null
          : jsonEncode(command.attachments),
      'created_at': command.createdAt,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<List<ConversationV2PendingCommand>> pendingCommands(
    String conversationId,
  ) async {
    final rows = await (await _db()).query(
      'conversation_v2_pending_commands',
      where: 'account_id = ? AND desktop_device_id = ? AND conversation_id = ?',
      whereArgs: [accountId, desktopDeviceId, conversationId],
      orderBy: 'created_at ASC',
    );
    return rows.map(_pendingCommandFromRow).toList(growable: false);
  }

  Future<void> removePendingCommand(
    String conversationId,
    String clientCommandId,
  ) async {
    await (await _db()).delete(
      'conversation_v2_pending_commands',
      where:
          'account_id = ? AND desktop_device_id = ? AND conversation_id = ? AND client_command_id = ?',
      whereArgs: [accountId, desktopDeviceId, conversationId, clientCommandId],
    );
  }

  @override
  Future<ConversationV2PendingThreadDelete?> pendingThreadDelete(
    String threadId,
  ) async {
    final rows = await (await _db()).query(
      'conversation_v2_pending_thread_deletes',
      where: 'account_id = ? AND desktop_device_id = ? AND thread_id = ?',
      whereArgs: [accountId, desktopDeviceId, threadId.trim()],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    final row = rows.first;
    return ConversationV2PendingThreadDelete(
      principalId: _rowRequiredString(row, 'principal_id'),
      threadId: _rowRequiredString(row, 'thread_id'),
      clientCommandId: _rowRequiredString(row, 'client_command_id'),
      expectedHistoryRevision: _rowNonNegativeInteger(
        row,
        'expected_history_revision',
      ),
      createdAt: _rowRequiredString(row, 'created_at'),
    );
  }

  @override
  Future<void> putPendingThreadDelete(
    ConversationV2PendingThreadDelete command,
  ) async {
    await (await _db()).insert('conversation_v2_pending_thread_deletes', {
      'account_id': accountId,
      'desktop_device_id': desktopDeviceId,
      'principal_id': command.principalId,
      'thread_id': command.threadId,
      'client_command_id': command.clientCommandId,
      'expected_history_revision': command.expectedHistoryRevision,
      'created_at': command.createdAt,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  @override
  Future<void> removePendingThreadDelete(
    String threadId,
    String clientCommandId,
  ) async {
    await (await _db()).delete(
      'conversation_v2_pending_thread_deletes',
      where:
          'account_id = ? AND desktop_device_id = ? AND thread_id = ? AND client_command_id = ?',
      whereArgs: [
        accountId,
        desktopDeviceId,
        threadId.trim(),
        clientCommandId.trim(),
      ],
    );
  }

  Future<void> close() async {
    final db = _database;
    _database = null;
    await db?.close();
  }

  Future<Database> _db() async {
    await open();
    return _database!;
  }

  String _identityWhere(String conversationId) =>
      'account_id = ? AND desktop_device_id = ? AND conversation_id = ?';

  String _scopeWhere(String epoch) =>
      'account_id = ? AND desktop_device_id = ? AND store_epoch = ? AND conversation_id = ?';

  List<Object?> _scopeArgs(String epoch, String conversationId) => [
    accountId,
    desktopDeviceId,
    epoch,
    conversationId,
  ];

  void _validateBootstrap(ConversationV2Bootstrap bootstrap) {
    if (bootstrap.protocolVersion != 2 ||
        bootstrap.storeEpoch.trim().isEmpty ||
        bootstrap.conversationId.trim().isEmpty ||
        bootstrap.snapshotSeq < 0 ||
        bootstrap.historyRevision < 0 ||
        bootstrap.hasOlder && bootstrap.olderCursor == null ||
        !bootstrap.hasOlder && bootstrap.olderCursor != null) {
      throw StateError('Conversation V2 bootstrap metadata is invalid.');
    }
    final messageIds = <String>{};
    for (final message in bootstrap.messages) {
      if (message.conversationId != bootstrap.conversationId ||
          !messageIds.add(message.messageId) ||
          message.createdSeq < 1 ||
          message.contentVersion < 0 ||
          message.versionSeq < message.createdSeq ||
          message.versionSeq > bootstrap.snapshotSeq) {
        throw StateError('Conversation V2 bootstrap message is invalid.');
      }
    }
    final runIds = <String>{};
    for (final run in bootstrap.runs) {
      if (run.conversationId != bootstrap.conversationId ||
          !runIds.add(run.runId) ||
          run.versionSeq < 1 ||
          run.versionSeq > bootstrap.snapshotSeq) {
        throw StateError('Conversation V2 bootstrap run is invalid.');
      }
    }
    final toolIds = <String>{};
    for (final tool in bootstrap.tools) {
      if (tool.conversationId != bootstrap.conversationId ||
          !toolIds.add(tool.toolCallId) ||
          tool.createdSeq < 1 ||
          tool.versionSeq < tool.createdSeq ||
          tool.versionSeq > bootstrap.snapshotSeq) {
        throw StateError('Conversation V2 bootstrap tool is invalid.');
      }
    }
    _validateTodos(
      bootstrap.todos,
      bootstrap.conversationId,
      bootstrap.snapshotSeq,
    );
  }

  void _validateTodos(
    List<ConversationV2Todo> todos,
    String conversationId,
    int maximumSeq,
  ) {
    final ids = <String>{};
    final positions = <int>{};
    for (final todo in todos) {
      if (todo.conversationId != conversationId ||
          todo.todoId.trim().isEmpty ||
          todo.updatedAt.trim().isEmpty ||
          todo.position < 0 ||
          todo.versionSeq < 1 ||
          todo.versionSeq > maximumSeq ||
          !ids.add(todo.todoId) ||
          !positions.add(todo.position)) {
        throw StateError('Conversation V2 todo list is invalid.');
      }
    }
  }

  Future<void> _applyEffect(
    Transaction txn,
    String epoch,
    String conversationId,
    ConversationV2Effect effect,
  ) async {
    if (effect.seq < 1 ||
        effect.effectVersion != 1 ||
        effect.type.trim().isEmpty) {
      throw StateError('Conversation V2 effect metadata is invalid.');
    }
    final payload = effect.payload;
    switch (effect.type) {
      case 'message.create':
        final message = ConversationV2Message.fromJson(payload['message']);
        if (message.conversationId != conversationId ||
            message.createdSeq < 1 ||
            message.versionSeq < message.createdSeq ||
            message.contentVersion < 0 ||
            message.createdSeq > effect.seq ||
            message.versionSeq > effect.seq) {
          throw StateError('Conversation V2 message create belongs elsewhere.');
        }
        await _upsertMessage(txn, epoch, message);
      case 'message.append':
        final messageId = _requiredEffectText(
          payload['messageId'],
          'message.append.messageId',
        );
        final message = await _findMessage(
          txn,
          epoch,
          conversationId,
          messageId,
        );
        if (message == null) {
          throw ConversationV2EntityRepairError(
            'Message delta target is not cached.',
          );
        }
        final base = _requiredNonNegativeSafeInteger(
          payload['baseContentVersion'],
          'message.append.baseContentVersion',
        );
        final delta = payload['delta'];
        final next = _requiredNonNegativeSafeInteger(
          payload['nextContentVersion'],
          'message.append.nextContentVersion',
        );
        if (delta is! String || next != base + 1) {
          throw StateError('Message delta effect is invalid.');
        }
        if (message.versionSeq >= effect.seq) return;
        if (_isTerminalMessageStatus(message.status)) return;
        if (base != message.contentVersion) {
          throw ConversationV2EntityRepairError(
            'Message content version mismatch.',
          );
        }
        await _upsertMessage(
          txn,
          epoch,
          message.copyWith(
            body: message.body + delta,
            versionSeq: effect.seq,
            contentVersion: next,
            status: _isTerminalMessageStatus(message.status)
                ? message.status
                : ConversationV2MessageStatus.streaming,
          ),
        );
      case 'message.replace':
        final messageId = _requiredEffectText(
          payload['messageId'],
          'message.replace.messageId',
        );
        final message = await _findMessage(
          txn,
          epoch,
          conversationId,
          messageId,
        );
        if (message == null) {
          throw ConversationV2EntityRepairError(
            'Message replace target is not cached.',
          );
        }
        final base = _requiredNonNegativeSafeInteger(
          payload['baseContentVersion'],
          'message.replace.baseContentVersion',
        );
        final next = _requiredNonNegativeSafeInteger(
          payload['nextContentVersion'],
          'message.replace.nextContentVersion',
        );
        final body = payload['body'];
        if (body is! String || next <= base) {
          throw StateError('Message replace effect is invalid.');
        }
        final attachments = payload.containsKey('attachments')
            ? _requiredEffectList(
                payload['attachments'],
                'message.replace.attachments',
              )
            : null;
        if (message.versionSeq >= effect.seq) return;
        if (_isTerminalMessageStatus(message.status)) return;
        if (base != message.contentVersion) {
          throw ConversationV2EntityRepairError(
            'Message content version mismatch.',
          );
        }
        await _upsertMessage(
          txn,
          epoch,
          message.copyWith(
            body: body,
            versionSeq: effect.seq,
            contentVersion: next,
            attachments: attachments,
          ),
        );
      case 'message.finalize':
        final messageId = _requiredEffectText(
          payload['messageId'],
          'message.finalize.messageId',
        );
        final message = await _findMessage(
          txn,
          epoch,
          conversationId,
          messageId,
        );
        if (message == null) {
          throw ConversationV2EntityRepairError(
            'Message finalize target is not cached.',
          );
        }
        final contentVersion = _requiredNonNegativeSafeInteger(
          payload['contentVersion'],
          'message.finalize.contentVersion',
        );
        if (contentVersion < message.contentVersion) {
          throw StateError('Message final content version regressed.');
        }
        final status = _finalMessageStatus(payload['status']);
        final occurredAt = payload['occurredAt'] is String
            ? payload['occurredAt'] as String
            : null;
        if (message.versionSeq >= effect.seq) return;
        if (_isTerminalMessageStatus(message.status)) return;
        final hasAttachments = payload.containsKey('attachments');
        final attachments = hasAttachments
            ? _requiredEffectList(
                payload['attachments'],
                'message.finalize.attachments',
              )
            : null;
        await _upsertMessage(
          txn,
          epoch,
          message.copyWith(
            versionSeq: effect.seq,
            contentVersion: contentVersion,
            status: status,
            occurredAt: occurredAt,
            attachments: attachments,
            clearAttachments: hasAttachments && attachments!.isEmpty,
          ),
        );
      case 'message.tombstone':
        final messageId = _requiredEffectText(
          payload['messageId'],
          'message.tombstone.messageId',
        );
        final message = await _findMessage(
          txn,
          epoch,
          conversationId,
          messageId,
        );
        if (message == null) {
          throw ConversationV2EntityRepairError(
            'Message tombstone target is not cached.',
          );
        }
        if (message.versionSeq >= effect.seq) return;
        await _upsertMessage(
          txn,
          epoch,
          message.copyWith(
            versionSeq: effect.seq,
            status: ConversationV2MessageStatus.deleted,
            isDeleted: true,
          ),
        );
      case 'message.history_target':
        final messageId = _requiredEffectText(
          payload['messageId'],
          'message.history_target.messageId',
        );
        final message = await _findMessage(
          txn,
          epoch,
          conversationId,
          messageId,
        );
        if (message == null) {
          throw ConversationV2EntityRepairError(
            'Message history target is not cached.',
          );
        }
        if (message.role != 'user') {
          throw StateError(
            'Conversation V2 history target must belong to a user message.',
          );
        }
        final target = ConversationV2HistoryTarget.fromJson(
          payload['historyTarget'],
        );
        if (message.historyTarget != null &&
            (message.historyTarget!.activityLineId != target.activityLineId ||
                (message.historyTarget!.userMessageId != null &&
                    target.userMessageId != null &&
                    message.historyTarget!.userMessageId !=
                        target.userMessageId))) {
          throw StateError('Conversation V2 message history identity changed.');
        }
        if (message.versionSeq >= effect.seq) return;
        await _upsertMessage(
          txn,
          epoch,
          message.copyWith(versionSeq: effect.seq, historyTarget: target),
        );
      case 'run.upsert':
        final run = ConversationV2Run.fromJson(payload['run']);
        if (run.conversationId != conversationId ||
            run.versionSeq < 1 ||
            run.versionSeq > effect.seq) {
          throw StateError('Conversation V2 run belongs elsewhere.');
        }
        await _upsertRun(txn, epoch, run);
      case 'detail.upsert':
        final detail = ConversationV2Detail.fromJson(payload['detail']);
        if (detail.conversationId != conversationId ||
            detail.createdSeq < 1 ||
            detail.versionSeq < detail.createdSeq ||
            detail.versionSeq > effect.seq) {
          throw StateError('Conversation V2 detail belongs elsewhere.');
        }
        await _upsertDetail(txn, epoch, detail);
      case 'agent.upsert':
        final agent = ConversationV2Agent.fromJson(payload['agent']);
        if (agent.conversationId != conversationId ||
            agent.versionSeq < 1 ||
            agent.versionSeq > effect.seq ||
            agent.agentId == agent.parentAgentInstanceId) {
          throw StateError('Conversation V2 agent effect metadata is invalid.');
        }
        await _upsertAgent(txn, epoch, agent, strictEffect: true);
      case 'tool.summary.upsert':
        final tool = ConversationV2Tool.fromJson(payload['toolCall']);
        if (tool.conversationId != conversationId ||
            tool.createdSeq < 1 ||
            tool.versionSeq < tool.createdSeq ||
            tool.versionSeq > effect.seq) {
          throw StateError('Conversation V2 tool belongs elsewhere.');
        }
        await _upsertTool(txn, epoch, tool);
      case 'todo.list.replace':
        final rawTodos = _requiredEffectList(
          payload['todos'],
          'todo.list.replace.todos',
        );
        final todos = rawTodos
            .map(ConversationV2Todo.fromJson)
            .toList(growable: false);
        _validateTodos(todos, conversationId, effect.seq);
        await txn.delete(
          'conversation_v2_todos',
          where: _scopeWhere(epoch),
          whereArgs: _scopeArgs(epoch, conversationId),
        );
        for (final todo in todos) {
          await _insertTodo(txn, epoch, todo);
        }
      case 'history.invalidation':
        final revision = _requiredNonNegativeSafeInteger(
          payload['historyRevision'],
          'history.invalidation.historyRevision',
        );
        final currentRows = await txn.query(
          'conversation_v2_state',
          columns: ['history_revision'],
          where: _scopeWhere(epoch),
          whereArgs: _scopeArgs(epoch, conversationId),
          limit: 1,
        );
        if (currentRows.isEmpty ||
            currentRows.first['history_revision'] is! int) {
          throw StateError('Conversation V2 history state is missing.');
        }
        final currentRevision = currentRows.first['history_revision'] as int;
        if (revision < currentRevision) {
          throw StateError('History invalidation regressed the revision.');
        }
        await txn.update(
          'conversation_v2_state',
          {
            'history_revision': revision,
            'history_cursor': null,
            'has_older': 0,
          },
          where: _scopeWhere(epoch),
          whereArgs: _scopeArgs(epoch, conversationId),
        );
      case 'detail.invalidation' || 'noop':
        // Detail invalidations only affect the independent detail coverage.
        // The durable effect row and sync cursor still advance in this transaction.
        break;
      default:
        throw StateError('Unsupported Conversation V2 effect: ${effect.type}');
    }
  }

  Future<void> _upsertState(
    Transaction txn,
    ConversationV2CacheState state,
  ) async {
    await txn.insert(
      'conversation_v2_state',
      state.toRow(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<void> _upsertMessage(
    Transaction txn,
    String epoch,
    ConversationV2Message message,
  ) async {
    _validateMessageMetadata(message);
    final existing = await _findMessage(
      txn,
      epoch,
      message.conversationId,
      message.messageId,
    );
    if (existing != null &&
        (existing.turnId != message.turnId ||
            existing.runId != message.runId ||
            existing.role != message.role ||
            existing.channel != message.channel ||
            existing.createdSeq != message.createdSeq)) {
      throw StateError(
        'Conversation V2 message ${message.messageId} changed immutable identity.',
      );
    }
    if (existing != null && existing.versionSeq > message.versionSeq) return;
    if (existing != null && message.contentVersion < existing.contentVersion) {
      throw StateError('Conversation V2 message content version regressed.');
    }
    if (existing != null && existing.versionSeq == message.versionSeq) {
      final same =
          existing.messageId == message.messageId &&
          existing.conversationId == message.conversationId &&
          existing.turnId == message.turnId &&
          existing.runId == message.runId &&
          existing.role == message.role &&
          existing.channel == message.channel &&
          existing.createdSeq == message.createdSeq &&
          existing.contentVersion == message.contentVersion &&
          existing.body == message.body &&
          _sameJson(existing.attachments, message.attachments) &&
          existing.status == message.status &&
          existing.isDeleted == message.isDeleted;
      if (same) {
        final incomingTarget = message.historyTarget;
        final existingTarget = existing.historyTarget;
        if (incomingTarget != null) {
          if (existingTarget != null &&
              (existingTarget.activityLineId != incomingTarget.activityLineId ||
                  (existingTarget.userMessageId != null &&
                      incomingTarget.userMessageId != null &&
                      existingTarget.userMessageId !=
                          incomingTarget.userMessageId))) {
            throw StateError(
              'Conversation V2 message ${message.messageId} history identity changed.',
            );
          }
          if (existingTarget == null ||
              (existingTarget.userMessageId == null &&
                  incomingTarget.userMessageId != null)) {
            await txn.update(
              'conversation_v2_messages',
              {
                'history_activity_line_id': incomingTarget.activityLineId,
                if (incomingTarget.userMessageId != null)
                  'history_user_message_id': incomingTarget.userMessageId,
              },
              where: '${_scopeWhere(epoch)} AND message_id = ?',
              whereArgs: [
                ..._scopeArgs(epoch, message.conversationId),
                message.messageId,
              ],
            );
          }
        }
        return;
      }
      throw StateError(
        'Conversation V2 message version ${message.messageId}/${message.versionSeq} conflicts.',
      );
    }
    if (existing != null && _isTerminalMessageStatus(existing.status)) {
      if (!_isTerminalMessageStatus(message.status)) return;
      if (existing.status != message.status &&
          message.status != ConversationV2MessageStatus.deleted) {
        throw StateError(
          'Conversation V2 message has conflicting terminal statuses.',
        );
      }
    }
    final effective =
        existing != null &&
            message.status == ConversationV2MessageStatus.deleted
        ? message.copyWith(
            body: existing.body,
            contentVersion: existing.contentVersion,
            status: ConversationV2MessageStatus.deleted,
            isDeleted: true,
          )
        : message;
    await txn.insert('conversation_v2_messages', {
      'account_id': accountId,
      'desktop_device_id': desktopDeviceId,
      'store_epoch': epoch,
      'conversation_id': effective.conversationId,
      'message_id': effective.messageId,
      'turn_id': effective.turnId,
      'run_id': effective.runId,
      'role': effective.role,
      'channel': effective.channel,
      'created_seq': effective.createdSeq,
      'version_seq': effective.versionSeq,
      'content_version': effective.contentVersion,
      'body': effective.body,
      'attachments_json': effective.attachments == null
          ? null
          : jsonEncode(effective.attachments),
      'status': effective.status.name == 'finalised'
          ? 'final'
          : effective.status.name,
      'is_deleted': effective.isDeleted ? 1 : 0,
      // Row facts, not row identity: the runtime backfills these for rows that were written
      // before they existed (the Feed's own time, the provider's role, the owning agent), so a
      // re-delivered snapshot carrying more of them at an unchanged version is an enrichment,
      // not the conflict the identity check above is about.
      'occurred_at': effective.occurredAt,
      'provider_role': effective.providerRole,
      'agent_id': effective.agentId,
      'agent_instance_id': effective.agentInstanceId,
      'history_activity_line_id': effective.historyTarget?.activityLineId,
      'history_user_message_id': effective.historyTarget?.userMessageId,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<void> _upsertAgent(
    Transaction txn,
    String epoch,
    ConversationV2Agent agent, {
    bool strictEffect = false,
  }) async {
    _validateAgentMetadata(agent);
    final existing = await txn.query(
      'conversation_v2_agents',
      where: '${_scopeWhere(epoch)} AND agent_id = ?',
      whereArgs: [..._scopeArgs(epoch, agent.conversationId), agent.agentId],
      limit: 1,
    );
    final existingAgent = existing.isEmpty
        ? null
        : _agentFromRow(existing.first);
    if (strictEffect && existingAgent != null) {
      if (agent.versionSeq < existingAgent.versionSeq ||
          (agent.versionSeq == existingAgent.versionSeq &&
              conversationV2StableJson(agent.toJson()) !=
                  conversationV2StableJson(existingAgent.toJson())) ||
          (existingAgent.runId != null && existingAgent.runId != agent.runId) ||
          (existingAgent.parentAgentInstanceId != null &&
              existingAgent.parentAgentInstanceId !=
                  agent.parentAgentInstanceId) ||
          (existingAgent.parentToolCallId != null &&
              existingAgent.parentToolCallId != agent.parentToolCallId)) {
        throw StateError(
          'Conversation V2 agent effect changed version or ownership.',
        );
      }
    }
    if (existingAgent != null && existingAgent.versionSeq > agent.versionSeq) {
      return;
    }
    // Identity is the agent id and its role: the kind decides whether the client draws a
    // card for its rows, so a row that changes kind would move content across the Feed.
    if (existingAgent != null &&
        (existingAgent.role != agent.role ||
            existingAgent.kind != agent.kind)) {
      throw StateError(
        'Conversation V2 agent ${agent.agentId} changed role or kind.',
      );
    }
    // Everything else is an enrichment of the same row: status advances, mission and task
    // text arrive with the event that started the agent, and later deliveries carry more of
    // them than the row that was stored first.
    final effective = ConversationV2Agent(
      agentId: agent.agentId,
      conversationId: agent.conversationId,
      role: agent.role,
      kind: agent.kind,
      status: agent.status,
      versionSeq: agent.versionSeq,
      runId: agent.runId ?? existingAgent?.runId,
      parentAgentInstanceId:
          agent.parentAgentInstanceId ?? existingAgent?.parentAgentInstanceId,
      parentToolCallId:
          agent.parentToolCallId ?? existingAgent?.parentToolCallId,
      startedAt: agent.startedAt ?? existingAgent?.startedAt,
      endedAt: agent.endedAt ?? existingAgent?.endedAt,
      mission: agent.mission ?? existingAgent?.mission,
      taskName: agent.taskName ?? existingAgent?.taskName,
      delegationSummary:
          agent.delegationSummary ?? existingAgent?.delegationSummary,
      delegationPrompt:
          agent.delegationPrompt ?? existingAgent?.delegationPrompt,
      todoId: agent.todoId ?? existingAgent?.todoId,
    );
    await txn.insert('conversation_v2_agents', {
      'account_id': accountId,
      'desktop_device_id': desktopDeviceId,
      'store_epoch': epoch,
      'conversation_id': effective.conversationId,
      'agent_id': effective.agentId,
      'role': effective.role,
      'kind': effective.kind,
      'status': effective.status,
      'version_seq': effective.versionSeq,
      'run_id': effective.runId,
      'parent_agent_instance_id': effective.parentAgentInstanceId,
      'parent_tool_call_id': effective.parentToolCallId,
      'started_at': effective.startedAt,
      'ended_at': effective.endedAt,
      'mission': effective.mission,
      'task_name': effective.taskName,
      'delegation_summary': effective.delegationSummary,
      'delegation_prompt': effective.delegationPrompt,
      'todo_id': effective.todoId,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<void> _insertTodo(
    Transaction txn,
    String epoch,
    ConversationV2Todo todo,
  ) async {
    await txn.insert('conversation_v2_todos', {
      'account_id': accountId,
      'desktop_device_id': desktopDeviceId,
      'store_epoch': epoch,
      'conversation_id': todo.conversationId,
      'todo_id': todo.todoId,
      'title': todo.title,
      'detail': todo.detail,
      'status': todo.status,
      'position': todo.position,
      'updated_at': todo.updatedAt,
      'version_seq': todo.versionSeq,
    }, conflictAlgorithm: ConflictAlgorithm.abort);
  }

  Future<void> _upsertRun(
    Transaction txn,
    String epoch,
    ConversationV2Run run,
  ) async {
    _validateRunMetadata(run);
    final existing = await txn.query(
      'conversation_v2_runs',
      columns: [
        'run_id',
        'conversation_id',
        'turn_id',
        'status',
        'version_seq',
        'started_at',
        'ended_at',
        'timing_quality',
        'retry_of_run_id',
        'regeneration_of_run_id',
      ],
      where: '${_scopeWhere(epoch)} AND run_id = ?',
      whereArgs: [..._scopeArgs(epoch, run.conversationId), run.runId],
      limit: 1,
    );
    final existingRun = existing.isEmpty ? null : _runFromRow(existing.first);
    if (existingRun != null && existingRun.turnId != run.turnId) {
      throw StateError('Conversation V2 run changed turns.');
    }
    _assertStableOptional(
      'retry lineage',
      existingRun?.retryOfRunId,
      run.retryOfRunId,
    );
    _assertStableOptional(
      'regeneration lineage',
      existingRun?.regenerationOfRunId,
      run.regenerationOfRunId,
    );
    if (existingRun != null && existingRun.versionSeq > run.versionSeq) {
      return;
    }
    if (existingRun != null && existingRun.versionSeq == run.versionSeq) {
      if (_sameRun(existingRun, run)) return;
      throw StateError(
        'Conversation V2 run version ${run.runId}/${run.versionSeq} conflicts.',
      );
    }
    if (existingRun != null &&
        _isTerminalRunStatus(existingRun.status) &&
        _isTerminalRunStatus(run.status) &&
        existingRun.status != run.status) {
      throw StateError(
        'Conversation V2 run has conflicting terminal statuses.',
      );
    }
    if (existingRun != null &&
        _isTerminalRunStatus(existingRun.status) &&
        !_isTerminalRunStatus(run.status)) {
      return;
    }
    final effectiveRun =
        existingRun != null && _isTerminalRunStatus(existingRun.status)
        ? ConversationV2Run(
            runId: run.runId,
            conversationId: run.conversationId,
            turnId: run.turnId,
            status: existingRun.status,
            versionSeq: run.versionSeq,
            timingQuality: run.timingQuality,
            startedAt: run.startedAt ?? existingRun.startedAt,
            endedAt: run.endedAt ?? existingRun.endedAt,
            retryOfRunId: run.retryOfRunId ?? existingRun.retryOfRunId,
            regenerationOfRunId:
                run.regenerationOfRunId ?? existingRun.regenerationOfRunId,
          )
        : run;
    await txn.insert('conversation_v2_runs', {
      'account_id': accountId,
      'desktop_device_id': desktopDeviceId,
      'store_epoch': epoch,
      'conversation_id': effectiveRun.conversationId,
      'run_id': effectiveRun.runId,
      'turn_id': effectiveRun.turnId,
      'status': effectiveRun.status,
      'version_seq': effectiveRun.versionSeq,
      'started_at': effectiveRun.startedAt,
      'ended_at': effectiveRun.endedAt,
      'timing_quality': effectiveRun.timingQuality,
      'retry_of_run_id': effectiveRun.retryOfRunId,
      'regeneration_of_run_id': effectiveRun.regenerationOfRunId,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<void> _upsertDetail(
    Transaction txn,
    String epoch,
    ConversationV2Detail detail,
  ) async {
    _validateDetailMetadata(detail);
    final rows = await txn.query(
      'conversation_v2_details',
      columns: [
        'item_id',
        'conversation_id',
        'run_id',
        'agent_id',
        'agent_instance_id',
        'parent_agent_instance_id',
        'parent_agent_id',
        'parent_tool_call_id',
        'tool_call_id',
        'type',
        'created_seq',
        'version_seq',
        'content',
        'ref',
      ],
      where: '${_scopeWhere(epoch)} AND item_id = ?',
      whereArgs: [..._scopeArgs(epoch, detail.conversationId), detail.itemId],
      limit: 1,
    );
    final existing = rows.isEmpty ? null : _detailFromRow(rows.first);
    if (existing != null && existing.runId != detail.runId) {
      throw StateError('Conversation V2 detail changed runs.');
    }
    if (existing != null && existing.createdSeq != detail.createdSeq) {
      throw StateError('Conversation V2 detail changed position.');
    }
    _assertStableOptional(
      'detail agent ownership',
      existing?.agentId,
      detail.agentId,
    );
    _assertStableOptional(
      'detail agent instance ownership',
      existing?.agentInstanceId,
      detail.agentInstanceId,
    );
    _assertStableOptional(
      'detail parent agent instance ownership',
      existing?.parentAgentInstanceId,
      detail.parentAgentInstanceId,
    );
    _assertStableOptional(
      'detail parent agent ownership',
      existing?.parentAgentId,
      detail.parentAgentId,
    );
    _assertStableOptional(
      'detail parent tool ownership',
      existing?.parentToolCallId,
      detail.parentToolCallId,
    );
    _assertStableOptional(
      'detail tool ownership',
      existing?.toolCallId,
      detail.toolCallId,
    );
    if (existing != null && existing.type != detail.type) {
      throw StateError('Conversation V2 detail changed type.');
    }
    if (existing != null && existing.versionSeq > detail.versionSeq) {
      return;
    }
    final effective = existing == null
        ? detail
        : ConversationV2Detail(
            itemId: detail.itemId,
            conversationId: detail.conversationId,
            runId: detail.runId,
            agentId: detail.agentId ?? existing.agentId,
            agentInstanceId: detail.agentInstanceId ?? existing.agentInstanceId,
            parentAgentInstanceId:
                detail.parentAgentInstanceId ?? existing.parentAgentInstanceId,
            parentAgentId: detail.parentAgentId ?? existing.parentAgentId,
            parentToolCallId:
                detail.parentToolCallId ?? existing.parentToolCallId,
            toolCallId: detail.toolCallId ?? existing.toolCallId,
            type: detail.type,
            createdSeq: existing.createdSeq,
            versionSeq: detail.versionSeq,
            content: detail.content ?? existing.content,
            ref: detail.ref ?? existing.ref,
          );
    if (existing != null && existing.versionSeq == detail.versionSeq) {
      if (_sameDetail(existing, effective)) return;
      throw StateError(
        'Conversation V2 detail version ${detail.itemId}/${detail.versionSeq} conflicts.',
      );
    }
    await txn.insert('conversation_v2_details', {
      'account_id': accountId,
      'desktop_device_id': desktopDeviceId,
      'store_epoch': epoch,
      'conversation_id': effective.conversationId,
      'item_id': effective.itemId,
      'run_id': effective.runId,
      'agent_id': effective.agentId,
      'agent_instance_id': effective.agentInstanceId,
      'parent_agent_instance_id': effective.parentAgentInstanceId,
      'parent_agent_id': effective.parentAgentId,
      'parent_tool_call_id': effective.parentToolCallId,
      'tool_call_id': effective.toolCallId,
      'type': effective.type,
      'created_seq': effective.createdSeq,
      'version_seq': effective.versionSeq,
      'content': effective.content,
      'ref': effective.ref,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<void> _upsertTool(
    Transaction txn,
    String epoch,
    ConversationV2Tool tool,
  ) async {
    _validateToolMetadata(tool);
    final rows = await txn.query(
      'conversation_v2_tools',
      columns: [
        'tool_call_id',
        'conversation_id',
        'run_id',
        'agent_id',
        'agent_instance_id',
        'parent_agent_instance_id',
        'parent_tool_call_id',
        'name',
        'status',
        'created_seq',
        'version_seq',
        'input_json',
        'output_json',
      ],
      where: '${_scopeWhere(epoch)} AND tool_call_id = ?',
      whereArgs: [..._scopeArgs(epoch, tool.conversationId), tool.toolCallId],
      limit: 1,
    );
    final existing = rows.isEmpty ? null : _toolFromRow(rows.first);
    if (existing != null && existing.runId != tool.runId) {
      throw StateError('Conversation V2 tool changed runs.');
    }
    if (existing != null && existing.createdSeq != tool.createdSeq) {
      throw StateError('Conversation V2 tool changed position.');
    }
    if (existing != null && existing.name != tool.name) {
      throw StateError('Conversation V2 tool changed names.');
    }
    _assertStableOptional(
      'tool agent ownership',
      existing?.agentId,
      tool.agentId,
    );
    _assertStableOptional(
      'tool agent instance ownership',
      existing?.agentInstanceId,
      tool.agentInstanceId,
    );
    _assertStableOptional(
      'tool parent agent instance ownership',
      existing?.parentAgentInstanceId,
      tool.parentAgentInstanceId,
    );
    _assertStableOptional(
      'tool parent tool ownership',
      existing?.parentToolCallId,
      tool.parentToolCallId,
    );
    if (existing != null && existing.versionSeq > tool.versionSeq) return;
    if (existing != null && existing.versionSeq == tool.versionSeq) {
      if (_sameTool(existing, tool)) return;
      throw StateError(
        'Conversation V2 tool version ${tool.toolCallId}/${tool.versionSeq} conflicts.',
      );
    }
    if (existing != null &&
        _isTerminalToolStatus(existing.status) &&
        _isTerminalToolStatus(tool.status) &&
        existing.status != tool.status) {
      throw StateError(
        'Conversation V2 tool has conflicting terminal statuses.',
      );
    }
    if (existing != null &&
        _isTerminalToolStatus(existing.status) &&
        !_isTerminalToolStatus(tool.status)) {
      return;
    }
    final effective = existing == null
        ? tool
        : ConversationV2Tool(
            toolCallId: tool.toolCallId,
            conversationId: tool.conversationId,
            runId: tool.runId,
            agentId: tool.agentId ?? existing.agentId,
            agentInstanceId: tool.agentInstanceId ?? existing.agentInstanceId,
            parentAgentInstanceId:
                tool.parentAgentInstanceId ?? existing.parentAgentInstanceId,
            parentToolCallId:
                tool.parentToolCallId ?? existing.parentToolCallId,
            name: tool.name,
            status: _isTerminalToolStatus(existing.status)
                ? existing.status
                : tool.status,
            createdSeq: existing.createdSeq,
            versionSeq: tool.versionSeq,
            // The provider's label for this call is whatever the newest event said; the
            // call's own time is a fact of the row.
            occurredAt: tool.occurredAt ?? existing.occurredAt,
            providerRole: tool.providerRole ?? existing.providerRole,
            input: tool.input ?? existing.input,
            output: tool.output ?? existing.output,
          );
    await txn.insert('conversation_v2_tools', {
      'account_id': accountId,
      'desktop_device_id': desktopDeviceId,
      'store_epoch': epoch,
      'conversation_id': effective.conversationId,
      'tool_call_id': effective.toolCallId,
      'run_id': effective.runId,
      'agent_id': effective.agentId,
      'agent_instance_id': effective.agentInstanceId,
      'parent_agent_instance_id': effective.parentAgentInstanceId,
      'parent_tool_call_id': effective.parentToolCallId,
      'name': effective.name,
      'status': effective.status,
      'created_seq': effective.createdSeq,
      'version_seq': effective.versionSeq,
      'occurred_at': effective.occurredAt,
      'provider_role': effective.providerRole,
      'input_json': effective.input == null
          ? null
          : jsonEncode(effective.input),
      'output_json': effective.output == null
          ? null
          : jsonEncode(effective.output),
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<ConversationV2Message?> _findMessage(
    DatabaseExecutor executor,
    String epoch,
    String conversationId,
    dynamic messageId,
  ) async {
    if (messageId is! String || messageId.isEmpty) return null;
    final rows = await executor.query(
      'conversation_v2_messages',
      where: '${_scopeWhere(epoch)} AND message_id = ?',
      whereArgs: [..._scopeArgs(epoch, conversationId), messageId],
      limit: 1,
    );
    return rows.isEmpty ? null : _messageFromRow(rows.first);
  }
}

Future<void> _createDetailTables(DatabaseExecutor db) async {
  await db.execute('''
    CREATE TABLE IF NOT EXISTS conversation_v2_details (
      account_id TEXT NOT NULL,
      desktop_device_id TEXT NOT NULL,
      store_epoch TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_id TEXT,
      agent_instance_id TEXT,
      parent_agent_instance_id TEXT,
      parent_agent_id TEXT,
      parent_tool_call_id TEXT,
      tool_call_id TEXT,
      type TEXT NOT NULL,
      created_seq INTEGER NOT NULL,
      version_seq INTEGER NOT NULL,
      content TEXT,
      ref TEXT,
      PRIMARY KEY (account_id, desktop_device_id, store_epoch, conversation_id, item_id)
    )
  ''');
  await db.execute('''
    CREATE INDEX IF NOT EXISTS conversation_v2_details_position
    ON conversation_v2_details(account_id, desktop_device_id, store_epoch, conversation_id, run_id, created_seq, item_id)
  ''');
  await db.execute('''
    CREATE TABLE IF NOT EXISTS conversation_v2_detail_cursors (
      account_id TEXT NOT NULL,
      desktop_device_id TEXT NOT NULL,
      store_epoch TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      tool_call_id TEXT NOT NULL DEFAULT '',
      cursor TEXT,
      has_more INTEGER NOT NULL DEFAULT 0,
      read_seq INTEGER NOT NULL DEFAULT 0,
      history_revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, desktop_device_id, store_epoch, conversation_id, run_id, agent_id, tool_call_id)
    )
  ''');
}

Future<void> _createToolTables(DatabaseExecutor db) async {
  await db.execute('''
    CREATE TABLE IF NOT EXISTS conversation_v2_tools (
      account_id TEXT NOT NULL,
      desktop_device_id TEXT NOT NULL,
      store_epoch TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_id TEXT,
      agent_instance_id TEXT,
      parent_agent_instance_id TEXT,
      parent_tool_call_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_seq INTEGER NOT NULL,
      version_seq INTEGER NOT NULL,
      occurred_at TEXT,
      provider_role TEXT,
      input_json TEXT,
      output_json TEXT,
      PRIMARY KEY (account_id, desktop_device_id, store_epoch, conversation_id, tool_call_id)
    )
  ''');
  await db.execute('''
    CREATE INDEX IF NOT EXISTS conversation_v2_tools_position
    ON conversation_v2_tools(account_id, desktop_device_id, store_epoch, conversation_id, run_id, created_seq, tool_call_id)
  ''');
}

/// The agents of a conversation, as the desktop registry records them.
///
/// Without this table a client can only infer agent identity from a tool row's owner: it
/// loses the role, the mission text and the parent link, and cannot tell an agent whose
/// narration never called a tool from a row of the main agent — which is how a subagent's
/// narration ended up in the main Feed on mobile.
Future<void> _createAgentTable(DatabaseExecutor db) async {
  await db.execute('''
    CREATE TABLE IF NOT EXISTS conversation_v2_agents (
      account_id TEXT NOT NULL,
      desktop_device_id TEXT NOT NULL,
      store_epoch TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      version_seq INTEGER NOT NULL,
      run_id TEXT,
      parent_agent_instance_id TEXT,
      parent_tool_call_id TEXT,
      started_at TEXT,
      ended_at TEXT,
      mission TEXT,
      task_name TEXT,
      delegation_summary TEXT,
      delegation_prompt TEXT,
      todo_id TEXT,
      PRIMARY KEY (account_id, desktop_device_id, store_epoch, conversation_id, agent_id)
    )
  ''');
}

Future<void> _createTodoTable(DatabaseExecutor db) async {
  await db.execute('''
    CREATE TABLE IF NOT EXISTS conversation_v2_todos (
      account_id TEXT NOT NULL,
      desktop_device_id TEXT NOT NULL,
      store_epoch TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      todo_id TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT NOT NULL,
      position INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      version_seq INTEGER NOT NULL,
      PRIMARY KEY (account_id, desktop_device_id, store_epoch, conversation_id, todo_id)
    )
  ''');
  await db.execute('''
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_v2_todos_position
    ON conversation_v2_todos(account_id, desktop_device_id, store_epoch, conversation_id, position)
  ''');
}

Future<void> _createPendingThreadDeleteTable(DatabaseExecutor db) async {
  await db.execute('''
    CREATE TABLE IF NOT EXISTS conversation_v2_pending_thread_deletes (
      account_id TEXT NOT NULL,
      desktop_device_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      client_command_id TEXT NOT NULL,
      expected_history_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (account_id, desktop_device_id, thread_id)
    )
  ''');
}

/// V8 adds the agent registry and the row facts the Feed renders (its own time, the
/// provider's role, the owning agent). Existing rows keep rendering — the added columns are
/// filled the next time the row is delivered — and the registry arrives with the next
/// bootstrap/page, which this schema makes storable.
Future<void> _upgradeToV8(DatabaseExecutor db) async {
  await _createAgentTable(db);
  await _addColumnIfMissing(
    db,
    'conversation_v2_messages',
    'occurred_at',
    'TEXT',
  );
  await _addColumnIfMissing(
    db,
    'conversation_v2_messages',
    'provider_role',
    'TEXT',
  );
  await _addColumnIfMissing(db, 'conversation_v2_messages', 'agent_id', 'TEXT');
  await _addColumnIfMissing(
    db,
    'conversation_v2_messages',
    'agent_instance_id',
    'TEXT',
  );
  await _addColumnIfMissing(db, 'conversation_v2_tools', 'occurred_at', 'TEXT');
  await _addColumnIfMissing(
    db,
    'conversation_v2_tools',
    'provider_role',
    'TEXT',
  );
}

/// V11 stores the immutable Eco/provider identity needed to expose safe
/// history rewrites on mobile. A prompt without the provider id remains
/// readable, but the client must not turn it into a destructive retry target.
Future<void> _upgradeToV11(DatabaseExecutor db) async {
  await _addColumnIfMissing(
    db,
    'conversation_v2_messages',
    'history_activity_line_id',
    'TEXT',
  );
  await _addColumnIfMissing(
    db,
    'conversation_v2_messages',
    'history_user_message_id',
    'TEXT',
  );
}

Future<void> _addColumnIfMissing(
  DatabaseExecutor db,
  String table,
  String column,
  String definition,
) async {
  final columns = await db.rawQuery('PRAGMA table_info($table)');
  if (columns.any((row) => row['name'] == column)) return;
  await db.execute('ALTER TABLE $table ADD COLUMN $column $definition');
}

class ConversationV2CacheState {
  const ConversationV2CacheState({
    required this.accountId,
    required this.desktopDeviceId,
    required this.storeEpoch,
    required this.conversationId,
    required this.appliedSeq,
    required this.snapshotSeq,
    required this.historyRevision,
    required this.historyCursor,
    required this.hasOlder,
    required this.state,
    required this.error,
    required this.updatedAt,
  });

  final String accountId;
  final String desktopDeviceId;
  final String storeEpoch;
  final String conversationId;
  final int appliedSeq;
  final int snapshotSeq;
  final int historyRevision;
  final String? historyCursor;
  final bool hasOlder;
  final ConversationV2SyncState state;
  final String? error;
  final String updatedAt;

  ConversationV2CacheState copyWith({
    int? appliedSeq,
    int? snapshotSeq,
    int? historyRevision,
    String? historyCursor,
    bool? hasOlder,
    ConversationV2SyncState? state,
    String? error,
    String? updatedAt,
    bool clearHistoryCursor = false,
  }) => ConversationV2CacheState(
    accountId: accountId,
    desktopDeviceId: desktopDeviceId,
    storeEpoch: storeEpoch,
    conversationId: conversationId,
    appliedSeq: appliedSeq ?? this.appliedSeq,
    snapshotSeq: snapshotSeq ?? this.snapshotSeq,
    historyRevision: historyRevision ?? this.historyRevision,
    historyCursor: clearHistoryCursor
        ? null
        : (historyCursor ?? this.historyCursor),
    hasOlder: hasOlder ?? this.hasOlder,
    state: state ?? this.state,
    error: error,
    updatedAt: updatedAt ?? this.updatedAt,
  );

  factory ConversationV2CacheState.fromRow(Map<String, dynamic> row) {
    return ConversationV2CacheState(
      accountId: _rowRequiredString(row, 'account_id'),
      desktopDeviceId: _rowRequiredString(row, 'desktop_device_id'),
      storeEpoch: _rowRequiredString(row, 'store_epoch'),
      conversationId: _rowRequiredString(row, 'conversation_id'),
      appliedSeq: _rowNonNegativeInteger(row, 'applied_seq'),
      snapshotSeq: row['snapshot_seq'] == null
          ? 0
          : _rowNonNegativeInteger(row, 'snapshot_seq'),
      historyRevision: _rowNonNegativeInteger(row, 'history_revision'),
      historyCursor: _rowOptionalString(row, 'history_cursor'),
      hasOlder: _rowBoolean(row, 'has_older'),
      state: _syncStateFromRow(row['state']),
      error: _rowOptionalString(row, 'error'),
      updatedAt: _rowRequiredString(row, 'updated_at'),
    );
  }

  Map<String, Object?> toRow() => {
    'account_id': accountId,
    'desktop_device_id': desktopDeviceId,
    'store_epoch': storeEpoch,
    'conversation_id': conversationId,
    'applied_seq': appliedSeq,
    'snapshot_seq': snapshotSeq,
    'history_revision': historyRevision,
    'history_cursor': historyCursor,
    'has_older': hasOlder ? 1 : 0,
    'state': state.name,
    'error': error,
    'updated_at': updatedAt,
  };
}

ConversationV2Message _messageFromRow(Map<String, Object?> row) {
  final message = ConversationV2Message(
    messageId: _rowRequiredString(row, 'message_id'),
    conversationId: _rowRequiredString(row, 'conversation_id'),
    turnId: _rowRequiredString(row, 'turn_id'),
    runId: _rowOptionalString(row, 'run_id'),
    role: _rowRequiredString(row, 'role'),
    channel: _rowRequiredString(row, 'channel'),
    createdSeq: _rowNonNegativeInteger(row, 'created_seq'),
    versionSeq: _rowNonNegativeInteger(row, 'version_seq'),
    contentVersion: _rowNonNegativeInteger(row, 'content_version'),
    body: _rowRequiredStringAllowEmpty(row, 'body'),
    attachments: _decodeJsonList(_rowOptionalString(row, 'attachments_json')),
    status: _messageStatusFromWire(row['status']),
    isDeleted: _rowBoolean(row, 'is_deleted'),
    occurredAt: _rowOptionalString(row, 'occurred_at'),
    providerRole: _rowOptionalString(row, 'provider_role'),
    agentId: _rowOptionalString(row, 'agent_id'),
    agentInstanceId: _rowOptionalString(row, 'agent_instance_id'),
    historyTarget: _historyTargetFromRow(row),
  );
  _validateMessageMetadata(message);
  return message;
}

ConversationV2HistoryTarget? _historyTargetFromRow(Map<String, Object?> row) {
  final activityLineId = _rowOptionalString(row, 'history_activity_line_id');
  if (activityLineId == null) return null;
  return ConversationV2HistoryTarget(
    activityLineId: activityLineId,
    userMessageId: _rowOptionalString(row, 'history_user_message_id'),
  );
}

ConversationV2Run _runFromRow(Map<String, Object?> row) {
  final run = ConversationV2Run(
    runId: _rowRequiredString(row, 'run_id'),
    conversationId: _rowRequiredString(row, 'conversation_id'),
    turnId: _rowRequiredString(row, 'turn_id'),
    status: _rowRequiredString(row, 'status'),
    versionSeq: _rowNonNegativeInteger(row, 'version_seq'),
    timingQuality: _rowRequiredString(row, 'timing_quality'),
    startedAt: _rowOptionalString(row, 'started_at'),
    endedAt: _rowOptionalString(row, 'ended_at'),
    retryOfRunId: _rowOptionalString(row, 'retry_of_run_id'),
    regenerationOfRunId: _rowOptionalString(row, 'regeneration_of_run_id'),
  );
  _validateRunMetadata(run);
  return run;
}

ConversationV2Tool _toolFromRow(Map<String, Object?> row) {
  final tool = ConversationV2Tool(
    toolCallId: _rowRequiredString(row, 'tool_call_id'),
    conversationId: _rowRequiredString(row, 'conversation_id'),
    runId: _rowRequiredString(row, 'run_id'),
    agentId: _rowOptionalString(row, 'agent_id'),
    agentInstanceId: _rowOptionalString(row, 'agent_instance_id'),
    parentAgentInstanceId: _rowOptionalString(row, 'parent_agent_instance_id'),
    parentToolCallId: _rowOptionalString(row, 'parent_tool_call_id'),
    name: _rowRequiredString(row, 'name'),
    status: _rowRequiredString(row, 'status'),
    createdSeq: _rowNonNegativeInteger(row, 'created_seq'),
    versionSeq: _rowNonNegativeInteger(row, 'version_seq'),
    occurredAt: _rowOptionalString(row, 'occurred_at'),
    providerRole: _rowOptionalString(row, 'provider_role'),
    input: _decodeJson(_rowOptionalString(row, 'input_json')),
    output: _decodeJson(_rowOptionalString(row, 'output_json')),
  );
  _validateToolMetadata(tool);
  return tool;
}

ConversationV2Agent _agentFromRow(Map<String, Object?> row) {
  final agent = ConversationV2Agent(
    agentId: _rowRequiredString(row, 'agent_id'),
    conversationId: _rowRequiredString(row, 'conversation_id'),
    role: _rowRequiredString(row, 'role'),
    kind: _rowRequiredString(row, 'kind'),
    status: _rowRequiredString(row, 'status'),
    versionSeq: _rowNonNegativeInteger(row, 'version_seq'),
    runId: _rowOptionalString(row, 'run_id'),
    parentAgentInstanceId: _rowOptionalString(row, 'parent_agent_instance_id'),
    parentToolCallId: _rowOptionalString(row, 'parent_tool_call_id'),
    startedAt: _rowOptionalString(row, 'started_at'),
    endedAt: _rowOptionalString(row, 'ended_at'),
    mission: _rowOptionalString(row, 'mission'),
    taskName: _rowOptionalString(row, 'task_name'),
    delegationSummary: _rowOptionalString(row, 'delegation_summary'),
    delegationPrompt: _rowOptionalString(row, 'delegation_prompt'),
    todoId: _rowOptionalString(row, 'todo_id'),
  );
  _validateAgentMetadata(agent);
  return agent;
}

ConversationV2Todo _todoFromRow(Map<String, Object?> row) {
  return ConversationV2Todo.fromJson({
    'todoId': _rowRequiredString(row, 'todo_id'),
    'conversationId': _rowRequiredString(row, 'conversation_id'),
    'title': _rowRequiredStringAllowEmpty(row, 'title'),
    'detail': _rowRequiredStringAllowEmpty(row, 'detail'),
    'status': _rowRequiredString(row, 'status'),
    'position': _rowNonNegativeInteger(row, 'position'),
    'updatedAt': _rowRequiredString(row, 'updated_at'),
    'versionSeq': _rowNonNegativeInteger(row, 'version_seq'),
  });
}

void _validateAgentMetadata(ConversationV2Agent agent) {
  if (agent.agentId.trim().isEmpty ||
      agent.conversationId.trim().isEmpty ||
      agent.role.trim().isEmpty ||
      agent.kind.trim().isEmpty ||
      agent.status.trim().isEmpty ||
      !_isSafeInteger(agent.versionSeq) ||
      agent.versionSeq < 1) {
    throw StateError('Conversation V2 agent metadata is invalid.');
  }
}

ConversationV2Detail _detailFromRow(Map<String, Object?> row) {
  final detail = ConversationV2Detail(
    itemId: _rowRequiredString(row, 'item_id'),
    conversationId: _rowRequiredString(row, 'conversation_id'),
    runId: _rowRequiredString(row, 'run_id'),
    agentId: _rowOptionalString(row, 'agent_id'),
    agentInstanceId: _rowOptionalString(row, 'agent_instance_id'),
    parentAgentInstanceId: _rowOptionalString(row, 'parent_agent_instance_id'),
    parentAgentId: _rowOptionalString(row, 'parent_agent_id'),
    parentToolCallId: _rowOptionalString(row, 'parent_tool_call_id'),
    toolCallId: _rowOptionalString(row, 'tool_call_id'),
    type: _rowRequiredString(row, 'type'),
    createdSeq: _rowNonNegativeInteger(row, 'created_seq'),
    versionSeq: _rowNonNegativeInteger(row, 'version_seq'),
    content: _rowOptionalString(row, 'content'),
    ref: _rowOptionalString(row, 'ref'),
  );
  _validateDetailMetadata(detail);
  return detail;
}

dynamic _decodeJson(String? value) => value == null ? null : jsonDecode(value);

List<dynamic>? _decodeJsonList(String? value) {
  if (value == null) return null;
  final decoded = _decodeJson(value);
  if (decoded is! List) {
    throw StateError('Conversation V2 cached message attachments are invalid.');
  }
  return List<dynamic>.from(decoded);
}

bool _sameJson(dynamic left, dynamic right) {
  if (left == null && right == null) return true;
  try {
    return jsonEncode(left) == jsonEncode(right);
  } on Object {
    return false;
  }
}

ConversationV2PendingCommand _pendingCommandFromRow(Map<String, Object?> row) {
  final attachmentsJson = _rowOptionalString(row, 'attachments_json');
  List<dynamic>? attachments;
  if (attachmentsJson != null) {
    final decoded = _decodeJson(attachmentsJson);
    if (decoded is! List) {
      throw StateError('Conversation V2 pending attachments are invalid.');
    }
    attachments = List<dynamic>.from(decoded);
  }
  return ConversationV2PendingCommand(
    clientCommandId: _rowRequiredString(row, 'client_command_id'),
    conversationId: _rowRequiredString(row, 'conversation_id'),
    text: _rowRequiredStringAllowEmpty(row, 'text'),
    createdAt: _rowRequiredString(row, 'created_at'),
    attachments: attachments,
  );
}

String _rowRequiredString(Map<String, Object?> row, String field) {
  final value = row[field];
  if (value is String && value.trim().isNotEmpty) return value;
  throw StateError('Conversation V2 cached $field is invalid.');
}

String _rowRequiredStringAllowEmpty(Map<String, Object?> row, String field) {
  final value = row[field];
  if (value is String) return value;
  throw StateError('Conversation V2 cached $field is invalid.');
}

String? _rowOptionalString(Map<String, Object?> row, String field) {
  final value = row[field];
  if (value == null) return null;
  if (value is String) return value;
  throw StateError('Conversation V2 cached $field is invalid.');
}

int _rowNonNegativeInteger(Map<String, Object?> row, String field) {
  final value = row[field];
  if (value is int && _isSafeInteger(value) && value >= 0) return value;
  throw StateError('Conversation V2 cached $field is invalid.');
}

bool _rowBoolean(Map<String, Object?> row, String field) {
  final value = row[field];
  if (value == 0) return false;
  if (value == 1) return true;
  throw StateError('Conversation V2 cached $field is invalid.');
}

ConversationV2SyncState _syncStateFromRow(dynamic value) {
  for (final state in ConversationV2SyncState.values) {
    if (state.name == value) return state;
  }
  throw StateError('Conversation V2 cached state is invalid.');
}

void _validateMessageMetadata(ConversationV2Message message) {
  if (message.messageId.trim().isEmpty ||
      message.conversationId.trim().isEmpty ||
      message.turnId.trim().isEmpty ||
      message.role.trim().isEmpty ||
      message.channel.trim().isEmpty ||
      !_knownMessageRoles.contains(message.role) ||
      !_knownMessageChannels.contains(message.channel) ||
      !_isSafeInteger(message.createdSeq) ||
      message.createdSeq < 1 ||
      !_isSafeInteger(message.versionSeq) ||
      message.versionSeq < message.createdSeq ||
      !_isSafeInteger(message.contentVersion) ||
      message.contentVersion < 0 ||
      message.historyTarget?.activityLineId.trim().isEmpty == true ||
      message.historyTarget?.userMessageId?.trim().isEmpty == true ||
      (message.status == ConversationV2MessageStatus.deleted) !=
          message.isDeleted) {
    throw StateError('Conversation V2 message metadata is invalid.');
  }
}

void _validateRunMetadata(ConversationV2Run run) {
  if (run.runId.trim().isEmpty ||
      run.conversationId.trim().isEmpty ||
      run.turnId.trim().isEmpty ||
      !_isSafeInteger(run.versionSeq) ||
      run.versionSeq < 1 ||
      !_knownRunStatuses.contains(run.status) ||
      !_knownTimingQualities.contains(run.timingQuality)) {
    throw StateError('Conversation V2 run metadata is invalid.');
  }
  if (run.retryOfRunId == run.runId || run.regenerationOfRunId == run.runId) {
    throw StateError('Conversation V2 run lineage points to itself.');
  }
}

void _validateDetailMetadata(ConversationV2Detail detail) {
  if (detail.itemId.trim().isEmpty ||
      detail.conversationId.trim().isEmpty ||
      detail.runId.trim().isEmpty ||
      detail.type.trim().isEmpty ||
      !_isSafeInteger(detail.createdSeq) ||
      detail.createdSeq < 1 ||
      !_isSafeInteger(detail.versionSeq) ||
      detail.versionSeq < detail.createdSeq) {
    throw StateError('Conversation V2 detail metadata is invalid.');
  }
}

void _validateToolMetadata(ConversationV2Tool tool) {
  if (tool.toolCallId.trim().isEmpty ||
      tool.conversationId.trim().isEmpty ||
      tool.runId.trim().isEmpty ||
      tool.name.trim().isEmpty ||
      !_isSafeInteger(tool.createdSeq) ||
      tool.createdSeq < 1 ||
      !_isSafeInteger(tool.versionSeq) ||
      tool.versionSeq < tool.createdSeq ||
      !_knownToolStatuses.contains(tool.status)) {
    throw StateError('Conversation V2 tool metadata is invalid.');
  }
}

void _assertStableOptional(String label, String? existing, String? incoming) {
  if (existing != null && incoming != null && existing != incoming) {
    throw StateError('Conversation V2 $label changed.');
  }
}

bool _sameRun(ConversationV2Run left, ConversationV2Run right) =>
    left.runId == right.runId &&
    left.conversationId == right.conversationId &&
    left.turnId == right.turnId &&
    left.status == right.status &&
    left.versionSeq == right.versionSeq &&
    left.timingQuality == right.timingQuality &&
    left.startedAt == right.startedAt &&
    left.endedAt == right.endedAt &&
    left.retryOfRunId == right.retryOfRunId &&
    left.regenerationOfRunId == right.regenerationOfRunId;

bool _sameDetail(ConversationV2Detail left, ConversationV2Detail right) =>
    left.itemId == right.itemId &&
    left.conversationId == right.conversationId &&
    left.runId == right.runId &&
    left.agentId == right.agentId &&
    left.agentInstanceId == right.agentInstanceId &&
    left.parentAgentInstanceId == right.parentAgentInstanceId &&
    left.parentAgentId == right.parentAgentId &&
    left.parentToolCallId == right.parentToolCallId &&
    left.toolCallId == right.toolCallId &&
    left.type == right.type &&
    left.createdSeq == right.createdSeq &&
    left.versionSeq == right.versionSeq &&
    left.content == right.content &&
    left.ref == right.ref;

bool _sameTool(ConversationV2Tool left, ConversationV2Tool right) =>
    left.toolCallId == right.toolCallId &&
    left.conversationId == right.conversationId &&
    left.runId == right.runId &&
    left.agentId == right.agentId &&
    left.agentInstanceId == right.agentInstanceId &&
    left.parentAgentInstanceId == right.parentAgentInstanceId &&
    left.parentToolCallId == right.parentToolCallId &&
    left.name == right.name &&
    left.status == right.status &&
    left.createdSeq == right.createdSeq &&
    left.versionSeq == right.versionSeq &&
    _jsonEqual(left.input, right.input) &&
    _jsonEqual(left.output, right.output);

bool _jsonEqual(dynamic left, dynamic right) =>
    jsonEncode(_canonicalJson(left)) == jsonEncode(_canonicalJson(right));

dynamic _canonicalJson(dynamic value) {
  if (value is Map) {
    final entries = value.entries.toList()
      ..sort((a, b) => a.key.toString().compareTo(b.key.toString()));
    return <String, dynamic>{
      for (final entry in entries)
        entry.key.toString(): _canonicalJson(entry.value),
    };
  }
  if (value is Iterable) {
    return value.map(_canonicalJson).toList(growable: false);
  }
  return value;
}

bool _isTerminalRunStatus(String status) =>
    status == 'completed' ||
    status == 'failed' ||
    status == 'cancelled' ||
    status == 'interrupted';

bool _isTerminalToolStatus(String status) =>
    status == 'completed' || status == 'failed' || status == 'cancelled';

const _knownRunStatuses = <String>{
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'unknown',
};

const _knownMessageRoles = <String>{'user', 'assistant', 'system', 'tool'};

const _knownMessageChannels = <String>{
  'answer',
  'commentary',
  'thinking',
  'system',
  'tool',
};

const _knownTimingQualities = <String>{'recorded', 'unknown', 'estimated'};

const _maxSafeInteger = 9007199254740991;

bool _isSafeInteger(int value) => value.abs() <= _maxSafeInteger;

const _knownToolStatuses = <String>{
  'started',
  'running',
  'completed',
  'failed',
  'cancelled',
};

bool _isTerminalMessageStatus(ConversationV2MessageStatus status) =>
    status == ConversationV2MessageStatus.finalised ||
    status == ConversationV2MessageStatus.failed ||
    status == ConversationV2MessageStatus.cancelled ||
    status == ConversationV2MessageStatus.deleted;

String _requiredEffectText(dynamic value, String field) {
  if (value is String && value.trim().isNotEmpty) return value;
  throw StateError('Conversation V2 $field is invalid.');
}

List<dynamic> _requiredEffectList(dynamic value, String field) {
  if (value is List) return List<dynamic>.of(value);
  throw StateError('Conversation V2 $field is invalid.');
}

int _requiredNonNegativeSafeInteger(dynamic value, String field) {
  if (value is int && _isSafeInteger(value) && value >= 0) return value;
  throw StateError('Conversation V2 $field is invalid.');
}

ConversationV2MessageStatus _messageStatusFromWire(dynamic value) {
  switch (value) {
    case 'final':
      return ConversationV2MessageStatus.finalised;
    case 'failed':
      return ConversationV2MessageStatus.failed;
    case 'cancelled':
      return ConversationV2MessageStatus.cancelled;
    case 'deleted':
      return ConversationV2MessageStatus.deleted;
    case 'queued':
      return ConversationV2MessageStatus.queued;
    case 'streaming':
      return ConversationV2MessageStatus.streaming;
    default:
      throw StateError('Conversation V2 message status is invalid.');
  }
}

ConversationV2MessageStatus _finalMessageStatus(dynamic value) {
  final status = _messageStatusFromWire(value);
  if (status == ConversationV2MessageStatus.finalised ||
      status == ConversationV2MessageStatus.failed ||
      status == ConversationV2MessageStatus.cancelled) {
    return status;
  }
  throw StateError('Conversation V2 message finalize status is invalid.');
}
