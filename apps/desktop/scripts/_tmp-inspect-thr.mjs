import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import process from "node:process";

const dbPath = path.join(process.env.APPDATA, "@eco/desktopDev/eco-coding.sqlite");
const db = new DatabaseSync(dbPath, { readOnly: true });
const tid = "thr_1788595546542";

const types = db.prepare(
  "SELECT event_type, COUNT(*) AS c FROM thread_run_events WHERE thread_id=? GROUP BY event_type ORDER BY c DESC",
).all(tid);
console.log("event_types", JSON.stringify(types, null, 2));

const tools = db
  .prepare(
    `SELECT sequence, event_type,
            substr(COALESCE(message,''),1,300) AS msg
     FROM thread_run_events
     WHERE thread_id=?
       AND (
         event_type LIKE '%tool%'
         OR event_type LIKE '%mcp%'
         OR message LIKE '%agent_browser%'
         OR message LIKE '%mcp__%'
         OR message LIKE '%mori_agent_browser%'
       )
     ORDER BY sequence
     LIMIT 50`,
  )
  .all(tid);
console.log("toolish_count", tools.length);
for (const row of tools) {
  console.log(JSON.stringify(row));
}

const thinks = db
  .prepare(
    `SELECT sequence, substr(COALESCE(message,''),1,800) AS msg
     FROM thread_run_events
     WHERE thread_id=? AND event_type='thinking.final'
     ORDER BY sequence DESC
     LIMIT 4`,
  )
  .all(tid);
console.log("\n--- recent thinking.final ---");
for (const row of thinks) {
  console.log("seq", row.sequence);
  console.log(row.msg);
  console.log("---");
}

const assistant = db
  .prepare(
    `SELECT sequence, event_type, substr(COALESCE(message,''),1,400) AS msg
     FROM thread_run_events
     WHERE thread_id=? AND event_type IN ('assistant.message','message.delta','message.final','tool.call','tool.result','agent.message')
     ORDER BY sequence
     LIMIT 30`,
  )
  .all(tid);
console.log("\n--- assistant/tool messages ---");
for (const row of assistant) console.log(JSON.stringify(row));
