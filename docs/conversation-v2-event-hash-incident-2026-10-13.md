# 2026-10-13 Conversation V2 启动失败

生产版在 `recoverQueuedConversationV2Messages` 清理废弃的已接受消息时，通用 `append` 的深度校验发现第 60 条事件哈希不一致，导致应用启动中止。

根因是 SDK 的 `system/informational` 通知构造了 `metadata.tag: undefined`。原来的 `stableJson` 会将对象内的 `undefined` 键计入哈希，SQLite 存储时使用的 `JSON.stringify` 则会删除该键。第 60 条 `runtime.input` 回执的旧哈希为 `c1c26ace`，实际落库内容的哈希为 `e2eceb24`；补回且仅补回 `source.metadata.tag: undefined` 后可以精确复现旧哈希。

只读扫描生产库全部 3,576,681 条事件发现这一条异常，没有其他事件哈希缺口。受影响会话的 111,537 条事件及 111,537 条同步效果除该目标哈希外均通过校验。

## 写入修复

在 `normalizeEventInput` 中先取得 JSON 序列化后的独立快照，再从该快照计算哈希、生成读模型和写入事件。同步效果也使用同一份 JSON 快照计算哈希并持久化。循环引用、BigInt 和序列化后不是对象的 payload 会明确失败并回滚。

保留公共 `stableJson` / `stableHash` 的算法，避免改变既有源事件键和其他协议身份。继续执行历史事件与同步效果的完整性校验。

## 历史数据修复

先退出应用，在 `apps/desktop` 下执行只读检查：

```sh
bun run conversation:v2-repair-event-hash \
  --db /path/to/eco-coding.sqlite \
  --conversation THREAD_ID --seq 60
```

确认输出后执行修复，备份路径必须是不存在的新文件：

```sh
bun run conversation:v2-repair-event-hash \
  --db /path/to/eco-coding.sqlite \
  --conversation THREAD_ID --seq 60 \
  --apply --backup /path/to/eco-coding.before-repair.sqlite
```

脚本先以 SQLite 在线备份 API 备份已提交数据（包括 WAL），随后在写事务中检查目标事件和整个会话的事件、同步效果及连续序号。只有缺失的 SDK 通知 `level` / `tag` 字段能精确复现原哈希时才允许修复。更新仅涉及目标行的 `event_hash`，并将旧、新哈希、缺失键、原 payload SHA-256 及时间写入 `conversation_event_hash_repairs_v2`。事件正文、序号、源事件键、同步效果和会话头不变。

该工具通过 Bun 构建、Node 22.16 或更新版本执行，使用生产应用同类的 `node:sqlite` 驱动。在线备份按页复制，避免大型数据库在 `VACUUM INTO` 中重建全部索引的开销。未经解释的哈希不一致或其他损坏会直接报错，不会重新计算全部哈希来掩盖损坏。

回归测试覆盖缺少 SDK tag 的真实运行时写入、重启幂等重放、读模型重建、不可序列化输入、只读检查、备份、修复审计，以及对非该缺陷和损坏同步效果的拒绝。
