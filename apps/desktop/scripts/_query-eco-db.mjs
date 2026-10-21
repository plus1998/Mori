import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("usage: node _query-eco-db.mjs <sqlite-path>");
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((row) => row.name);
console.log("tables:", tables.join(", "));

for (const table of ["provider_configs", "providers", "candidate_models", "route_profiles", "threads"]) {
  if (!tables.includes(table)) continue;
  const rows = db.prepare(`SELECT * FROM ${table} LIMIT 5`).all();
  console.log(`\n${table}:`, JSON.stringify(rows, null, 2));
}

if (tables.includes("provider_configs")) {
  const mycodex = db
    .prepare("SELECT id, name, enabled, api_compat, base_url, default_model FROM provider_configs WHERE id LIKE '%codex%' OR name LIKE '%codex%' OR name LIKE '%Codex%'")
    .all();
  console.log("\nmycodex providers:", JSON.stringify(mycodex, null, 2));
}

if (tables.includes("role_routes")) {
  const routes = db.prepare("SELECT role, provider_id, model_id, api_compat, thinking_effort FROM role_routes WHERE role='main' LIMIT 10").all();
  console.log("\nplanner routes:", JSON.stringify(routes, null, 2));
}

if (tables.includes("workflow_settings")) {
  const wf = db.prepare("SELECT key, value_json FROM workflow_settings LIMIT 5").all();
  console.log("\nworkflow_settings sample:", JSON.stringify(wf, null, 2));
}
