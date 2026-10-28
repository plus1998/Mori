import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultSubagentAvailability } from "@eco/runtime/subagent-availability";
import { ConversationStore } from "../src/main/conversation-store";
import { MoriAssistantService } from "../src/main/mori-assistant-service";
import { MoriAssistantStore, parseAssistantSettings } from "../src/main/mori-assistant-store";
import { MoriAssistantTodos } from "../src/main/mori-assistant-todos";
import { parseWechatJson, validateWechatBaseUrl } from "../src/main/mori-assistant-wechat";
import type { OpenAIAccountService } from "../src/main/openai-account-service";
import { ProjectTodoAgentService } from "../src/main/project-todo-agent-service";
import { ProjectTodoStore } from "../src/main/project-todo-store";
import { composerReferences } from "../src/shared/composer-references";
import { IPC_CHANNELS, type ThreadStartRequest } from "../src/shared/ipc";
import { DEFAULT_MORI_ASSISTANT_SETTINGS, moriPetSize } from "../src/shared/mori-assistant";
import { removeTempDirectory } from "./helpers/temp-directory";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempDirectory));
});
async function temp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mori-assistant-test-"));
  roots.push(dir);
  return dir;
}

test("assistant settings require an account, reject malformed values and exclude secrets", () => {
  expect(() => parseAssistantSettings({ ...DEFAULT_MORI_ASSISTANT_SETTINGS, enabled: true })).toThrow("账号");
  expect(() =>
    parseAssistantSettings({ ...DEFAULT_MORI_ASSISTANT_SETTINGS, reasoningEffort: "invalid" }),
  ).toThrow("思考强度");
  const settings = parseAssistantSettings({
    ...DEFAULT_MORI_ASSISTANT_SETTINGS,
    accountIds: ["a", "a"],
    token: "must-not-save",
  });
  expect(settings.accountIds).toEqual(["a"]);
  expect(settings).not.toHaveProperty("token");
});

test("pet sizes migrate with a default and remain separate per selected pet", () => {
  const { petSizes: _omitted, ...oldSettings } = DEFAULT_MORI_ASSISTANT_SETTINGS;
  const migrated = parseAssistantSettings(oldSettings);
  expect(moriPetSize(migrated)).toBe(64);
  const settings = parseAssistantSettings({
    ...migrated,
    petSizes: { "builtin:mori": 96, "codex:doro": 144 },
  });
  expect(moriPetSize(settings)).toBe(96);
  expect(moriPetSize({ ...settings, petKey: "codex:doro" })).toBe(144);
  expect(moriPetSize({ ...settings, petKey: "mori:new" })).toBe(64);
  expect(() => parseAssistantSettings({ ...migrated, petSizes: { "builtin:mori": 500 } })).toThrow(
    "宠物大小",
  );
});

test("assistant state survives concurrent atomic writes and malformed files remain explicit errors", async () => {
  const file = path.join(await temp(), "assistant.json");
  const store = new MoriAssistantStore(file);
  store.state.draft = "first";
  const first = store.save();
  store.state.draft = "second";
  await Promise.all([first, store.save()]);
  const restored = new MoriAssistantStore(file);
  await restored.load();
  expect(restored.state.draft).toBe("second");
  await fs.writeFile(file, "broken");
  await expect(restored.load()).rejects.toThrow();
  expect(await fs.readFile(file, "utf8")).toBe("broken");
});

test("legacy task project preferences are removed from assistant settings on load", async () => {
  const file = path.join(await temp(), "assistant.json");
  const store = new MoriAssistantStore(file);
  await fs.writeFile(
    file,
    JSON.stringify({
      ...store.state,
      settings: { ...store.state.settings, defaultProject: "/legacy/user-project" },
    }),
  );
  await store.load();
  expect(store.state.settings).not.toHaveProperty("defaultProject");
  expect(JSON.parse(await fs.readFile(file, "utf8")).settings).not.toHaveProperty("defaultProject");
});

test("WeChat keeps opaque message IDs lossless and rejects untrusted credential destinations", () => {
  expect(parseWechatJson('{"message_id":18446744073709551615,"ret":0}').message_id).toBe(
    "18446744073709551615",
  );
  expect(validateWechatBaseUrl("https://ilinkai.weixin.qq.com/path")).toBe("https://ilinkai.weixin.qq.com");
  expect(() => validateWechatBaseUrl("https://weixin.qq.com.attacker.example")).toThrow("不受信任");
  expect(() => validateWechatBaseUrl("http://ilinkai.weixin.qq.com")).toThrow("不受信任");
  expect(() => validateWechatBaseUrl("https://a@ilinkai.weixin.qq.com")).toThrow("不受信任");
});

async function fixture() {
  const root = await fs.realpath(await temp());
  const executable = path.join(root, "fake-codex");
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
const readline=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const epoch=require('node:crypto').randomUUID();
let thread='native-assistant-'+epoch, turn=0, text='', computer, tasks;
const callMcp=async(server,name,args)=>{
 const headers={...server.http_headers,'Content-Type':'application/json','Accept':'application/json, text/event-stream'};
 const init=await fetch(server.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:'init',method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}})});
 const session=init.headers.get('mcp-session-id');if(session)headers['Mcp-Session-Id']=session;
 await fetch(server.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
 const response=await fetch(server.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:'call',method:'tools/call',params:{name,arguments:args}})});
 if(!response.ok)throw new Error('MCP HTTP '+response.status);
 const result=await response.json();if(result.error)throw new Error(result.error.message);
 complete();
};
const complete=()=>{
 send({method:'item/agentMessage/delta',params:{threadId:thread,itemId:'answer-'+epoch+'-'+thread+'-'+turn,delta:'收到：'+text}});
 send({method:'item/completed',params:{threadId:thread,item:{id:'answer-'+epoch+'-'+thread+'-'+turn,type:'agentMessage',text:'收到：'+text}}});
 send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-'+turn,status:'completed'}}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(!m.method){complete();return;}
 if(m.method==='initialized')return;
 let result={};
 if(m.method==='account/login/start'){
  if(m.params.type!=='chatgptAuthTokens'||JSON.stringify(m.params).includes('refresh_token')){send({id:m.id,error:{code:-1,message:'full credentials leaked'}});return;}
 }
 if(m.method==='model/list')result={data:[{model:'gpt-6-luna'}]};
 if(m.method==='thread/start'||m.method==='thread/resume'){
  if(m.method==='thread/resume')thread=m.params.threadId;
  computer=m.params.config?.mcp_servers?.mori_computer;
  tasks=m.params.config?.mcp_servers?.mori_tasks;
  require('node:fs').appendFileSync(${JSON.stringify(path.join(root, "runtime-workspaces.jsonl"))},JSON.stringify({cwd:process.cwd(),threadCwd:m.params.cwd,method:m.method,taskTools:tasks?.enabled_tools})+'\\n');
  result={thread:{id:thread}};
 }
 if(m.method==='turn/start'){
  turn++;text=m.params.input[0].text;
  result={turn:{id:'turn-'+turn}};
  send({id:m.id,result});
  if(text.startsWith('computer-')){
   const name=text==='computer-catalog'?'mori_computer_tools':'mori_computer_call';
   const args=text==='computer-catalog'?{}:{name:text==='computer-read'?'list_apps':'click',arguments:text==='computer-read'?{}:{app:'test',index:1}};
   callMcp(computer,name,args).catch(error=>send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-'+turn,status:'failed',error:{message:String(error)}}}}));
  }
  else if(text.startsWith('mcp-tool:')){
   const request=JSON.parse(text.slice('mcp-tool:'.length));
   callMcp(tasks,request.name,request.args).catch(error=>send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-'+turn,status:'failed',error:{message:String(error)}}}}));
  }
  else if(text==='tool')send({id:'tool-request',method:'item/tool/call',params:{threadId:thread,callId:'call-'+turn,tool:'mori_list_projects',arguments:{}}});
  else if(text==='private-task')send({id:'tool-request',method:'item/tool/call',params:{threadId:thread,callId:'call-'+turn,tool:'mori_start_task',arguments:{projectPath:process.cwd(),prompt:'must not start'}}});
  else if(text!=='wait')setTimeout(complete,5);
  return;
 }
 send({id:m.id,result});
});
`,
    { mode: 0o755 },
  );
  const db = new DatabaseSync(":memory:");
  const conversations = new ConversationStore(db);
  conversations.initialize();
  const todos = new ProjectTodoStore(db, (bytes) => `data:image/png;base64,${bytes.toString("base64")}`);
  const commands: Array<{ channel: string; args: unknown[] }> = [];
  const accounts = {
    listAccounts: async () => [
      { id: "a", name: "Test", authState: "configured", isLoggedIn: true, proxyMode: "direct" },
    ],
    setQuotaUsage: () => {},
    getAccountProxyConfig: async () => ({ mode: "direct" }),
    getExternalChatGptTokens: async () => ({ accessToken: "access-only", chatgptAccountId: "chatgpt-a" }),
  } as unknown as OpenAIAccountService;
  let currentProject = "/test/project";
  let computerMode: "always_ask" | "always_allow" = "always_ask";
  const computerCalls: string[] = [];
  const service = new MoriAssistantService({
    dataDir: root,
    conversations,
    accounts: async () => accounts,
    executable: () => executable,
    resolveSystemProxy: async () => "DIRECT",
    invoke: async (channel, args) => {
      commands.push({ channel, args });
      if (channel === IPC_CHANNELS.projectTodoQuery)
        return todos.query(args[0] as Parameters<typeof todos.query>[0]);
      if (channel === IPC_CHANNELS.projectTodoGet) return todos.get(String(args[0]), args[1] as boolean);
      if (channel === IPC_CHANNELS.projectTodoSave)
        return todos.save(args[0] as Parameters<typeof todos.save>[0]);
      if (channel === IPC_CHANNELS.projectTodoTrash)
        return todos.trash(args[0] as Parameters<typeof todos.trash>[0]);
      if (channel === IPC_CHANNELS.threadStart) {
        const input = args[0] as ThreadStartRequest;
        const thread = {
          id: `work-${commands.length}`,
          title: "待办任务",
          prompt: input.prompt,
          workspacePath: input.workspacePath,
          coreKind: input.coreKind ?? "codex",
          status: "running" as const,
          message: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        conversations.saveThread(thread);
        return { thread };
      }
      if (channel === "conversation:send-message") return { accepted: true };
      throw new Error(`Unexpected command ${channel}`);
    },
    defaultRuntimeConfig: () => ({
      subagentEnabled: defaultSubagentAvailability(),
      sessionMode: "agent",
      bashReviewMode: "auto",
    }),
    modelSettings: () => ({}),
    currentProject: () => currentProject,
    computerUse: {
      status: () => ({ enabled: true, available: true, actionApprovalMode: computerMode }),
      listTools: async () => ({ tools: [{ name: "click", inputSchema: { type: "object" } }] }),
      callTool: async (_thread, name, _args, signal) => {
        signal.throwIfAborted();
        computerCalls.push(name);
        return { content: [{ type: "text", text: "done" }] };
      },
      viewScreenshot: async () => ({ content: [{ type: "text", text: "screen" }] }),
      close: () => {},
    },
    openThread: async () => {},
    changed: () => {},
    settingsChanged: async () => {},
  });
  await service.initialize();
  await service.saveSettings({ ...DEFAULT_MORI_ASSISTANT_SETTINGS, enabled: true, accountIds: ["a"] });
  return {
    service,
    db,
    conversations,
    todos,
    commands,
    root,
    computerCalls,
    setComputerMode: (mode: "always_ask" | "always_allow") => {
      computerMode = mode;
    },
    setCurrentProject: (project: string) => {
      currentProject = project;
    },
  };
}

test("floating busy state follows running conversations and clears after completion", async () => {
  const { service, db, conversations } = await fixture();
  try {
    await service.send("prepare", "desktop", "busy-state");
    const id = (await service.snapshot()).currentThreadId;
    if (!id) throw new Error("Missing conversation");
    expect((await service.snapshot()).hasRunningTasks).toBe(false);
    conversations.updateThread(id, { status: "running", message: "" });
    expect((await service.snapshot()).hasRunningTasks).toBe(true);
    conversations.updateThread(id, { status: "completed", message: "" });
    expect((await service.snapshot()).hasRunningTasks).toBe(false);
  } finally {
    await service.close();
    db.close();
  }
});

async function assistantTool(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  args: Record<string, unknown>,
  commandId = randomUUID(),
) {
  await f.service.send(`mcp-tool:${JSON.stringify({ name, args })}`, "desktop", commandId);
  const threadId = f.service.store.state.currentThreadId!;
  const tools = f.conversations.conversationV2().toolsPage(threadId, `mori-run-${commandId}`).tools;
  expect(tools).toHaveLength(1);
  expect(tools[0]?.name).toBe(name);
  return tools[0]!;
}

test("stopping Mori during a todo read prevents the following write or task dispatch", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new ProjectTodoStore(db, () => "unused");
  try {
    const todo = store.save({
      projectPath: "/test/project",
      text: "取消后不能执行",
      images: [],
      completed: false,
    });
    for (const operation of ["task", "mori_update_todo", "mori_delete_todo"]) {
      const controller = new AbortController();
      const calls: string[] = [];
      const todos = new MoriAssistantTodos(
        async (channel) => {
          calls.push(channel);
          controller.abort(new Error("已停止"));
          return store.get(todo.id, false);
        },
        (value) => value,
      );
      const result =
        operation === "task"
          ? todos.task(todo.id, "", controller.signal)
          : todos.call(operation, { todoId: todo.id, revision: 1, text: "不能写入" }, controller.signal);
      await expect(result).rejects.toThrow("已停止");
      expect(calls).toEqual([IPC_CHANNELS.projectTodoGet]);
    }
    expect(store.get(todo.id)).toMatchObject({ revision: 1, text: todo.text });
  } finally {
    db.close();
  }
});

test("Mori todo CRUD uses the original store, preserves images and rejects stale revisions", async () => {
  const f = await fixture();
  try {
    const created = await assistantTool(f, "mori_create_todo", {
      projectPath: "/test/project",
      text: "一😀二😀三",
    });
    expect(created.status).toBe("completed");
    const first = created.output as { todoId: string; revision: number };
    expect(f.todos.get(first.todoId)).toMatchObject({ revision: 1, status: "pending" });
    const data = Buffer.from("original image bytes").toString("base64");
    const withImage = f.todos.save({
      ...f.todos.get(first.todoId),
      images: [
        { id: "image-1", mediaType: "image/png", data, thumbnail: "data:image/png;base64,cHJldmlldw==" },
      ],
    });
    const read = await assistantTool(f, "mori_read_todo", { todoId: first.todoId, limit: 2 });
    expect(read.output).toMatchObject({ text: "一😀", nextOffset: 2, imageCount: 1, revision: 2 });
    expect(JSON.stringify(read.output)).not.toContain(data);
    expect(JSON.stringify(read.output)).not.toContain("thumbnail");
    const tail = await assistantTool(f, "mori_read_todo", { todoId: first.todoId, offset: 2 });
    expect(tail.output).toMatchObject({ text: "二😀三", textTruncated: false });
    const updated = await assistantTool(f, "mori_update_todo", {
      todoId: first.todoId,
      revision: withImage.revision,
      text: "更新要求",
      status: "in_progress",
    });
    expect(updated.status).toBe("completed");
    expect(f.todos.get(first.todoId)).toMatchObject({ text: "更新要求", status: "in_progress", revision: 3 });
    expect(f.todos.get(first.todoId).images[0]?.data).toBe(data);
    for (const name of ["mori_update_todo", "mori_delete_todo"]) {
      const conflict = await assistantTool(f, name, {
        todoId: first.todoId,
        revision: 2,
        ...(name === "mori_update_todo" ? { text: "旧要求" } : {}),
      });
      expect(conflict.status).toBe("failed");
      expect(conflict.output).toMatchObject({ error: expect.stringContaining("待办已修改") });
    }
    expect(f.todos.get(first.todoId).text).toBe("更新要求");
    const deleted = await assistantTool(f, "mori_delete_todo", { todoId: first.todoId, revision: 3 });
    expect(deleted.output).toEqual({ todoId: first.todoId, revision: 4, deleted: true });
    expect(() => f.todos.get(first.todoId)).toThrow("no longer exists");
    const missing = await assistantTool(f, "mori_read_todo", { todoId: first.todoId });
    expect(missing.status).toBe("failed");
  } finally {
    await f.service.close();
    f.db.close();
  }
});

test("Mori todo queries filter projects and completion, page results and bound tool output", async () => {
  const f = await fixture();
  try {
    const input = {
      projectPath: "/test/project",
      text: "待办 " + "很长".repeat(500),
      images: [],
      completed: false,
    };
    const a = f.todos.save(input),
      b = f.todos.save(input);
    f.todos.save({ ...input, projectPath: "/other/project" });
    const done = f.todos.save({ ...input, text: "已完成", completed: true });
    const page = await assistantTool(f, "mori_list_todos", {
      projectPath: input.projectPath,
      search: "待办",
      limit: 1,
    });
    expect(page.status).toBe("completed");
    const result = page.output as { items: Array<{ todoId: string; text: string }>; nextCursor: string };
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.text.length).toBe(500);
    const next = await assistantTool(f, "mori_list_todos", {
      projectPath: input.projectPath,
      search: "待办",
      limit: 1,
      cursor: result.nextCursor,
    });
    const second = next.output as typeof result;
    expect(new Set([result.items[0]!.todoId, second.items[0]!.todoId])).toEqual(new Set([a.id, b.id]));
    expect(second.nextCursor).toBeNull();
    const completed = await assistantTool(f, "mori_list_todos", { completed: true });
    expect(completed.output).toMatchObject({ items: [{ todoId: done.id, status: "completed" }] });
    const all = await assistantTool(f, "mori_list_todos", {});
    expect((all.output as { items: unknown[] }).items).toHaveLength(3);
    for (const args of [
      { limit: 51 },
      { limit: 1.5 },
      { cursor: "null" },
      { cursor: "bad" },
      { completed: "false" },
    ]) {
      expect((await assistantTool(f, "mori_list_todos", args)).status).toBe("failed");
    }
    expect(
      (await assistantTool(f, "mori_update_todo", { todoId: a.id, revision: "1", text: "invalid" })).status,
    ).toBe("failed");
    expect((await assistantTool(f, "mori_update_todo", { todoId: a.id, revision: 1 })).status).toBe("failed");
    expect(
      (await assistantTool(f, "mori_create_todo", { projectPath: f.service.workspacePath, text: "invalid" }))
        .status,
    ).toBe("failed");
    expect(f.todos.get(a.id).revision).toBe(1);
  } finally {
    await f.service.close();
    f.db.close();
  }
});

test("Mori starts and sends original image todos to Agents, without marking receipt as completion", async () => {
  const f = await fixture();
  try {
    const data = Buffer.from("todo image").toString("base64");
    const todo = f.todos.save({
      projectPath: "/test/project",
      text: "",
      completed: false,
      images: [
        { id: "image-1", mediaType: "image/png", data, thumbnail: "data:image/png;base64,cHJldmlldw==" },
      ],
    });
    const commandId = randomUUID();
    const started = await assistantTool(f, "mori_start_task", { todoId: todo.id }, commandId);
    expect(started.status).toBe("completed");
    const { threadId } = started.output as { threadId: string };
    const thread = f.conversations.getThread(threadId)!;
    expect(thread.workspacePath).toBe(todo.projectPath);
    expect(composerReferences(thread.prompt)).toMatchObject([{ kind: "todo", id: todo.id }]);
    expect(f.service.store.state.taskIds).toContain(threadId);
    expect(f.todos.get(todo.id)).toMatchObject({ revision: 1, status: "pending" });
    // Re-delivery of the same assistant command cannot start a second Agent.
    await assistantTool(f, "mori_start_task", { todoId: todo.id }, commandId);
    expect(f.commands.filter((c) => c.channel === IPC_CHANNELS.threadStart)).toHaveLength(1);
    const sent = await assistantTool(f, "mori_send_to_task", {
      threadId,
      todoId: todo.id,
      text: "请优先处理",
    });
    expect(sent.output).toEqual({ accepted: true });
    const send = f.commands.findLast((c) => c.channel === "conversation:send-message")!;
    const message = send.args[0] as { conversationId: string; text: string };
    expect(message.conversationId).toBe(threadId);
    expect(message.text).toContain("请优先处理");
    expect(composerReferences(message.text)[0]?.id).toBe(todo.id);
    expect(f.todos.get(todo.id).status).toBe("pending");
    // The receiving Agent can read original images and update this same todo.
    const agent = new ProjectTodoAgentService({
      store: f.todos,
      workspacePath: () => thread.workspacePath,
      changed: () => {},
    });
    agent.resolveReference(threadId, todo.id);
    expect(
      agent.invoke(threadId, "read_todo", { todoId: todo.id, includeImages: true }).content[1],
    ).toMatchObject({ type: "image", data });
    agent.invoke(threadId, "update_todo_status", { todoId: todo.id, revision: 1, status: "in_progress" });
    agent.invoke(threadId, "update_todo_status", { todoId: todo.id, revision: 2, status: "completed" });
    expect(f.todos.get(todo.id).status).toBe("completed");
    f.conversations.saveThread({ ...thread, id: "other-agent", workspacePath: "/other/project" });
    expect(
      (await assistantTool(f, "mori_send_to_task", { threadId: "other-agent", todoId: todo.id })).status,
    ).toBe("failed");
    expect(
      (await assistantTool(f, "mori_start_task", { todoId: todo.id, projectPath: "/other/project" })).status,
    ).toBe("failed");
    expect((await assistantTool(f, "mori_start_task", {})).status).toBe("failed");
    expect((await assistantTool(f, "mori_send_to_task", { threadId })).status).toBe("failed");
    f.todos.trash({ id: todo.id, revision: 3, deleted: true });
    expect((await assistantTool(f, "mori_start_task", { todoId: todo.id })).status).toBe("failed");
    expect(f.commands.filter((c) => c.channel === IPC_CHANNELS.threadStart)).toHaveLength(1);
    expect(f.commands.filter((c) => c.channel === "conversation:send-message")).toHaveLength(1);
  } finally {
    await f.service.close();
    f.db.close();
  }
});

test("resuming an existing Mori session refreshes todo tools through MCP", async () => {
  const f = await fixture();
  try {
    await f.service.send("prepare existing session", "desktop", "prepare-resume");
    const native = f.conversations.getThreadCoreSession(f.service.store.state.currentThreadId!)!;
    await f.service.saveSettings({ ...f.service.settings, name: "Mori 新名称" });
    expect(
      (await assistantTool(f, "mori_create_todo", { projectPath: "/test/project", text: "旧会话新增待办" }))
        .status,
    ).toBe("completed");
    expect(
      f.conversations.getThreadCoreSession(f.service.store.state.currentThreadId!)?.externalSessionId,
    ).toBe(native.externalSessionId);
    const probes = (await fs.readFile(path.join(f.root, "runtime-workspaces.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(probes.at(-1)).toMatchObject({
      method: "thread/resume",
      taskTools: expect.arrayContaining(["mori_create_todo", "mori_start_task", "mori_send_to_task"]),
    });
    expect(f.todos.list()).toHaveLength(1);
  } finally {
    await f.service.close();
    f.db.close();
  }
});

test("assistant process and conversations stay in the managed workspace when the task project changes", async () => {
  const { service, db, conversations, root, setCurrentProject } = await fixture();
  try {
    await service.saveSettings({ ...service.settings, defaultProject: "/ignored/user-project" });
    await service.send("first project", "desktop", "workspace-1");
    setCurrentProject("/another/project");
    await service.newSession();
    await service.send("second project", "desktop", "workspace-2");
    const workspace = path.join(root, "mori-assistant", "workspace");
    const snapshot = await service.snapshot();
    expect(snapshot.settings).not.toHaveProperty("defaultProject");
    expect(snapshot.projects).toEqual(["/another/project"]);
    expect(
      snapshot.sessions.map((session) => conversations.getThread(session.threadId)?.workspacePath),
    ).toEqual([workspace, workspace]);
    const probes = (await fs.readFile(path.join(root, "runtime-workspaces.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(probes).toHaveLength(2);
    for (const probe of probes) {
      expect(probe).toMatchObject({ cwd: workspace, threadCwd: workspace, method: "thread/start" });
      expect(probe.taskTools).toContain("mori_create_todo");
    }
    await service.send("private-task", "desktop", "workspace-guard");
    if (!snapshot.currentThreadId) throw new Error("Missing assistant conversation");
    expect(conversations.conversationV2().findTool(snapshot.currentThreadId, "call-2")).toMatchObject({
      name: "mori_start_task",
      status: "failed",
      output: { error: "Mori 的独立工作区不能用作任务项目，请选择具体的工作项目。" },
    });
  } finally {
    await service.close();
    db.close();
  }
});

test("desktop and WeChat share one durable V2 conversation; redelivery does not run again", async () => {
  const { service, db, conversations } = await fixture();
  try {
    await Promise.all([
      service.send("hello", "desktop", "desktop-1"),
      service.send("微信消息", "wechat", "wechat-1"),
    ]);
    const snapshot = await service.snapshot();
    expect(snapshot.sessions).toHaveLength(1);
    if (!snapshot.currentThreadId) throw new Error("Missing assistant conversation");
    expect(snapshot.messages.map((message) => message.body)).toEqual([
      "hello",
      "收到：hello",
      "微信消息",
      "收到：微信消息",
    ]);
    expect(snapshot.sourceByMessage["mori-user-wechat-1"]).toBe("wechat");
    const head = conversations.conversationV2().head(snapshot.currentThreadId).lastSeq;
    await service.send("微信消息", "wechat", "wechat-1");
    expect(conversations.conversationV2().head(snapshot.currentThreadId).lastSeq).toBe(head);
    expect(conversations.conversationV2().validateIntegrity(snapshot.currentThreadId).headSeq).toBe(head);
  } finally {
    await service.close();
    db.close();
  }
});

test("assistant desktop tools persist input and output in the existing V2 log", async () => {
  const { service, db, conversations } = await fixture();
  try {
    await service.send("tool", "desktop", "tool-1");
    const snapshot = await service.snapshot();
    if (!snapshot.currentThreadId) throw new Error("Missing assistant conversation");
    expect(conversations.conversationV2().findTool(snapshot.currentThreadId, "call-1")).toMatchObject({
      name: "mori_list_projects",
      status: "completed",
      output: { projects: ["/test/project"] },
    });
    expect(snapshot.messages.at(-1)?.body).toBe("收到：tool");
  } finally {
    await service.close();
    db.close();
  }
});

test("queued messages are persisted before acceptance and stopping cancels queued work", async () => {
  const { service, db } = await fixture();
  try {
    const first = await service.enqueue("wait", "desktop", "waiting-1");
    for (let i = 0; i < 100; i++) {
      if ((await service.snapshot()).activity === "正在回复") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const second = await service.enqueue("do not execute", "desktop", "waiting-2");
    expect(
      (await service.snapshot()).messages.find((message) => message.messageId === "mori-user-waiting-2")
        ?.status,
    ).toBe("queued");
    await service.cancel();
    await expect(first.completion).rejects.toThrow("停止");
    await expect(second.completion).rejects.toThrow("停止");
    expect(
      (await service.snapshot()).messages.find((message) => message.messageId === "mori-user-waiting-2")
        ?.status,
    ).toBe("cancelled");
    expect((await service.snapshot()).status).toBe("idle");
    await service.send("after stop", "desktop", "after-stop");
    expect((await service.snapshot()).messages.at(-1)?.body).toBe("收到：after stop");
  } finally {
    await service.close();
    db.close();
  }
});

async function waitForApproval(service: MoriAssistantService) {
  for (let i = 0; i < 200; i++) {
    const input = (await service.snapshot()).pendingInput;
    if (input) return input;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Computer Use approval did not arrive");
}

test("computer actions wait for explicit approval, rejection never clicks, read tools do not ask", async () => {
  const { service, db, computerCalls } = await fixture();
  try {
    await service.send("computer-read", "desktop", "read");
    expect(computerCalls).toEqual(["list_apps"]);
    const rejected = service.send("computer-click", "desktop", "reject");
    const first = await waitForApproval(service);
    expect(first.kind).toBe("approval");
    expect(computerCalls).toEqual(["list_apps"]);
    await expect(service.respond(first.id, "随便")).rejects.toThrow("明确");
    expect((await service.snapshot()).pendingInput?.id).toBe(first.id);
    await service.respond(first.id, "拒绝");
    await rejected;
    expect(computerCalls).toEqual(["list_apps"]);
    const accepted = service.send("computer-click", "desktop", "approve");
    const second = await waitForApproval(service);
    await service.respond(second.id, "允许");
    await accepted;
    expect(computerCalls).toEqual(["list_apps", "click"]);
  } finally {
    await service.close();
    db.close();
  }
});

test("computer approval is cancellable and always_allow still follows the global approval policy", async () => {
  const { service, db, computerCalls, setComputerMode } = await fixture();
  try {
    const waiting = service.send("computer-click", "desktop", "cancel-computer");
    void waiting.catch(() => {});
    await waitForApproval(service);
    await service.cancel();
    await expect(waiting).rejects.toThrow("停止");
    expect(computerCalls).toEqual([]);
    expect((await service.snapshot()).pendingInput).toBeUndefined();
    setComputerMode("always_allow");
    await service.send("computer-click", "desktop", "allow-computer");
    expect(computerCalls).toEqual(["click"]);
  } finally {
    await service.close();
    db.close();
  }
});

test("computer approval from WeChat includes the action and records the explicit reply", async () => {
  const { service, db, computerCalls } = await fixture();
  const replies: string[] = [];
  service.onWechatReply = async (text) => {
    replies.push(text);
  };
  try {
    const waiting = service.send("computer-click", "wechat", "wechat-computer");
    const approval = await waitForApproval(service);
    expect(service.isWaitingForInput).toBe(true);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(approval.title);
    expect(replies[0]).toContain('"index": 1');
    expect(replies[0]).toContain("请回复「允许」或「拒绝」");
    expect(computerCalls).toEqual([]);
    await service.respond(approval.id, "允许", "wechat");
    expect(service.isWaitingForInput).toBe(false);
    await waiting;
    expect(computerCalls).toEqual(["click"]);
    const snapshot = await service.snapshot();
    expect(snapshot.sourceByMessage[`mori-question-answer-${approval.id}`]).toBe("wechat");
  } finally {
    await service.close();
    db.close();
  }
});
