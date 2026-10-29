import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildCodexGatewayModelAlias, buildCodexModelProviderSlug } from "@eco/runtime/codex-config-sync";
import { defaultSubagentAvailability } from "@eco/runtime/subagent-availability";
import { ConversationStore } from "../src/main/conversation-store";
import { ProviderStore } from "../src/main/provider-store";
import { ModelManagementService } from "../src/main/model-management-service";
import { MoriAssistantService } from "../src/main/mori-assistant-service";
import { MoriAssistantStore, parseAssistantSettings } from "../src/main/mori-assistant-store";
import { SchedulingService } from "../src/main/scheduling-service";
import { SchedulingStore } from "../src/main/scheduling-store";
import { previewSchedule } from "../src/main/schedule-time";
import { MORI_SCHEDULING_TOOLS, MoriAssistantScheduling } from "../src/main/mori-assistant-scheduling";
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
const scheduleStores: SchedulingStore[] = [];
afterEach(async () => {
  for (const store of scheduleStores.splice(0)) store.close();
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

test("custom assistant settings do not require ChatGPT; old settings keep their login source", () => {
  const { modelSource: _source, providerId: _provider, ...legacy } = DEFAULT_MORI_ASSISTANT_SETTINGS;
  expect(parseAssistantSettings(legacy).modelSource).toBe("chatgpt");
  expect(
    parseAssistantSettings({ ...legacy, enabled: true, modelSource: "custom", providerId: "custom" })
      .accountIds,
  ).toEqual([]);
  expect(() => parseAssistantSettings({ ...legacy, enabled: true, modelSource: "custom" })).toThrow("服务商");
  expect(() => parseAssistantSettings({ ...legacy, modelSource: "other" })).toThrow("来源");
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

async function fixture(options: { custom?: boolean } = {}) {
  const root = await fs.realpath(await temp());
  const executable = path.join(root, "fake-codex");
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
const readline=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const epoch=require('node:crypto').randomUUID();
let thread='native-assistant-'+epoch, turn=0, text='', computer, tasks, models, scheduling;
const callMcp=async(server,name,args)=>{
 const headers={...server.http_headers,'Content-Type':'application/json','Accept':'application/json, text/event-stream'};
 const init=await fetch(server.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:'init',method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}})});
 const session=init.headers.get('mcp-session-id');if(session)headers['Mcp-Session-Id']=session;
 await fetch(server.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
 const response=await fetch(server.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:'call',method:'tools/call',params:{name,arguments:args}})});
 if(!response.ok)throw new Error('MCP HTTP '+response.status);
 const result=await response.json();if(result.error)throw new Error(result.error.message);
 require('node:fs').appendFileSync(${JSON.stringify(path.join(root, "runtime-tool-results.jsonl"))},JSON.stringify({name,result:result.result})+'\\n');
 complete();
};
const complete=()=>{
 const answer=text.startsWith('工作会话 ')?'任务已完成，已修复 loading 图标旋转。':'收到：'+text;
 send({method:'item/agentMessage/delta',params:{threadId:thread,itemId:'answer-'+epoch+'-'+thread+'-'+turn,delta:answer}});
 send({method:'item/completed',params:{threadId:thread,item:{id:'answer-'+epoch+'-'+thread+'-'+turn,type:'agentMessage',text:answer}}});
 send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-'+turn,status:'completed'}}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(!m.method){complete();return;}
 if(m.method==='initialized')return;
 require('node:fs').appendFileSync(${JSON.stringify(path.join(root, "runtime-requests.jsonl"))},JSON.stringify({method:m.method,model:m.params?.model,modelProvider:m.params?.modelProvider,home:process.env.CODEX_HOME})+'\\n');
 let result={};
 if(m.method==='account/login/start'){
  if(m.params.type!=='chatgptAuthTokens'||JSON.stringify(m.params).includes('refresh_token')){send({id:m.id,error:{code:-1,message:'full credentials leaked'}});return;}
 }
 if(m.method==='model/list')result={data:[{model:'gpt-6-luna'}]};
 if(m.method==='thread/start'||m.method==='thread/resume'){
  if(m.method==='thread/resume')thread=m.params.threadId;
  computer=m.params.config?.mcp_servers?.mori_computer;
  tasks=m.params.config?.mcp_servers?.mori_tasks;
  models=m.params.config?.mcp_servers?.mori_models;
  scheduling=m.params.config?.mcp_servers?.mori_scheduling;
  require('node:fs').appendFileSync(${JSON.stringify(path.join(root, "runtime-workspaces.jsonl"))},JSON.stringify({cwd:process.cwd(),threadCwd:m.params.cwd,method:m.method,taskTools:tasks?.enabled_tools,modelTools:models?.enabled_tools,schedulingTools:scheduling?.enabled_tools,model:m.params.model,modelProvider:m.params.modelProvider})+'\\n');
  result={thread:{id:thread}};
 }
 if(m.method==='turn/start'){
  turn++;text=m.params.input[0].text;
  require('node:fs').appendFileSync(${JSON.stringify(path.join(root, "runtime-inputs.jsonl"))},JSON.stringify({text})+'\\n');
  result={turn:{id:'turn-'+turn}};
  send({id:m.id,result});
  if(text.startsWith('computer-')){
   const name=text==='computer-catalog'?'mori_computer_tools':'mori_computer_call';
   const args=text==='computer-catalog'?{}:{name:text==='computer-read'?'list_apps':'click',arguments:text==='computer-read'?{}:{app:'test',index:1}};
   callMcp(computer,name,args).catch(error=>send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-'+turn,status:'failed',error:{message:String(error)}}}}));
  }
  else if(text.startsWith('mcp-tool:')){
   const request=JSON.parse(text.slice('mcp-tool:'.length));
   callMcp(scheduling?.enabled_tools.includes(request.name)?scheduling:request.name.startsWith('mori_models_')?models:tasks,request.name,request.args).catch(error=>send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-'+turn,status:'failed',error:{message:String(error)}}}}));
  }
  else if(text==='tool')send({id:'tool-request',method:'item/tool/call',params:{threadId:thread,callId:'call-'+turn,tool:'mori_list_projects',arguments:{}}});
  else if(text==='private-task')send({id:'tool-request',method:'item/tool/call',params:{threadId:thread,callId:'call-'+turn,tool:'mori_start_task',arguments:{projectPath:process.cwd(),prompt:'must not start'}}});
  else if(text==='quota-failure')send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-'+turn,status:'failed',error:{message:'usage_limit_reached'}}}});
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
  const providers = new ProviderStore(db);
  providers.initialize();
  providers.saveProvider({ id: "custom", name: "Custom", baseUrl: "https://example.test", enabled: true, defaultModel: "", apiKey: "existing-model-key", apiCompat: "openai_chat_completions" });
  const modelManagement = new ModelManagementService({
    listProviders: () => providers.listProviders(), modelSource: () => "provider",
    saveProvider: async input => providers.saveProvider(input),
    deleteProvider: async id => { providers.deleteProvider(id); return { ok: true }; },
    listModels: async id => providers.listCandidateModels(id),
    listUpstreamModels: async () => ({ ok: false, error: "test upstream offline" }),
    saveModel: async input => providers.saveCandidateModel(input),
    deleteModel: async id => providers.deleteCandidateModel(id),
    importModels: (id, ids) => providers.bulkImportCandidateModels(id, ids),
    reorderModels: (id, ids) => providers.reorderCandidateModels(id, ids),
    testProvider: async () => ({ ok: false, error: "test upstream offline" }),
    saveCatalogModel: async () => { throw new Error("No account catalog in fixture"); },
    deleteCatalogModel: async () => { throw new Error("No account catalog in fixture"); },
    refreshCatalog: async () => { throw new Error("No account catalog in fixture"); },
  });
  const schedulingStore = new SchedulingStore(":memory:");
  scheduleStores.push(schedulingStore);
  const scheduleProfile = () => ({
    coreKind: "pi" as const,
    runtimeConfig: { subagentEnabled: defaultSubagentAvailability(), sessionMode: "agent" as const, bashReviewMode: "auto" as const },
  });
  const scheduling = new SchedulingService(schedulingStore, {
    inheritProfile: () => { throw new Error("Unexpected agent inheritance"); },
    validateProfile: profile => { if (!profile?.runtimeConfig) throw new Error("Missing profile"); },
    assertThread: id => { if (!conversations.getThread(id)) throw new Error("Missing thread"); },
    canDispatch: () => false,
    dispatch: async () => { throw new Error("No dispatch in fixture"); },
    inspect: () => ({ status: "running" }),
    onChanged: () => {}, onError: error => { throw error; },
  });
  const commands: Array<{ channel: string; args: unknown[] }> = [];
  const accountCalls: string[] = [];
  const accounts = {
    listAccounts: async () =>
      options.custom
        ? []
        : [{ id: "a", name: "Test", authState: "configured", isLoggedIn: true, proxyMode: "direct" }],
    setQuotaUsage: () => {
      accountCalls.push("quota");
    },
    getAccountProxyConfig: async () => {
      accountCalls.push("proxy");
      return { mode: "direct" };
    },
    getExternalChatGptTokens: async () => {
      accountCalls.push("tokens");
      return { accessToken: "access-only", chatgptAccountId: "chatgpt-a" };
    },
  } as unknown as OpenAIAccountService;
  let currentProject = "/test/project";
  let computerMode: "always_ask" | "always_allow" = "always_ask";
  const computerCalls: string[] = [];
  let providerEnabled = true;
  const preparedProviders: string[] = [];
  const service = new MoriAssistantService({
    dataDir: root,
    conversations,
    accounts: async () => accounts,
    executable: () => executable,
    resolveSystemProxy: async () => "DIRECT",
    invoke: async (channel, args) => {
      commands.push({ channel, args });
      if (channel === IPC_CHANNELS.schedulingList) return schedulingStore.snapshot();
      if (channel === IPC_CHANNELS.schedulingCreate) return scheduling.create(args[0] as Parameters<typeof scheduling.create>[0]);
      if (channel === IPC_CHANNELS.schedulingUpdate) return scheduling.update(args[0] as Parameters<typeof scheduling.update>[0]);
      if (channel === IPC_CHANNELS.schedulingDelete) return scheduling.remove(String(args[0]), { source: "user" }, args[1] as number | undefined);
      if (channel === IPC_CHANNELS.schedulingPreview) return previewSchedule(args[0] as Parameters<typeof previewSchedule>[0]);
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
    defaultScheduleProfile: scheduleProfile,
    modelSettings: () => ({}),
    manageModels: (name, args) => modelManagement.invoke(name, args),
    customProviders: () =>
      providerEnabled
        ? [{ id: "custom", name: "Custom", models: [{ id: "custom-model", label: "Custom Model" }] }]
        : [],
    prepareCustomProvider: async (providerId) => {
      preparedProviders.push(providerId);
      return {
        providerId,
        apiCompat: "openai_chat_completions",
        gatewayBaseUrl: "http://127.0.0.1:18765/v1",
      };
    },
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
  await service.saveSettings({
    ...DEFAULT_MORI_ASSISTANT_SETTINGS,
    enabled: true,
    ...(options.custom
      ? { modelSource: "custom", providerId: "custom", model: "custom-model" }
      : { accountIds: ["a"] }),
  });
  return {
    service,
    db,
    conversations,
    todos,
    scheduling,
    schedulingStore,
    scheduleProfile,
    providers,
    commands,
    root,
    computerCalls,
    accountCalls,
    preparedProviders,
    setProviderEnabled: (enabled: boolean) => {
      providerEnabled = enabled;
    },
    setComputerMode: (mode: "always_ask" | "always_allow") => {
      computerMode = mode;
    },
    setCurrentProject: (project: string) => {
      currentProject = project;
    },
  };
}

test("resumed Mori conversation manages providers and models via its own MCP endpoint without persisting keys", async () => {
  const f = await fixture();
  try {
    await f.service.send("prepare existing Mori conversation", "desktop", "models-prepare");
    await f.service.saveSettings({ ...f.service.settings, name: "Mori 模型管理" });
    const invoke = async (name: string, args: Record<string, unknown>, id: string) => {
      return assistantTool(f, `mori_models_${name}`, args, id);
    };
    const tool = await invoke("save_provider", { id: "custom", name: "Renamed", apiKey: "write-only-key" }, "models-save");
    expect(f.providers.getProviderWithSecret("custom")).toMatchObject({ name: "Renamed", apiKey: "write-only-key", apiCompat: "openai_chat_completions", enabled: true });
    expect(tool?.status).toBe("completed");
    expect(tool?.input).toMatchObject({ apiKey: "[redacted]" });
    expect(JSON.stringify(tool)).not.toContain("write-only-key");
    await invoke("import_models", { providerId: "custom", modelIds: ["a", "b"] }, "models-import");
    await invoke("save_model", { providerId: "custom", modelId: "a", manualSpec: { contextTokens: 32000, inputPerM: 0 } }, "models-spec");
    expect(f.providers.listCandidateModels("custom")[0]?.manualSpec).toMatchObject({ contextTokens: 32000, inputPerM: 0 });
    await invoke("reorder_models", { providerId: "custom", modelIds: ["b", "a"] }, "models-order");
    expect(f.providers.listProviders()[0]?.defaultModel).toBe("b");
    const failed = await invoke("test_provider", { providerId: "custom", modelId: "b" }, "models-test-failure");
    expect(failed.status).toBe("failed");
    expect(f.commands).toHaveLength(0);
    const requests = (await fs.readFile(path.join(f.root, "runtime-workspaces.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.at(-1)).toMatchObject({ method: "thread/resume" });
    expect(requests.at(-1).modelTools).toContain("mori_models_save_provider");
  } finally {
    await f.service.close();
    f.db.close();
  }
});

test("custom assistant runs tools and WeChat without ChatGPT credentials or catalog checks", async () => {
  const f = await fixture({ custom: true });
  try {
    await f.service.send("tool", "wechat", "custom-tool");
    let snapshot = await f.service.snapshot();
    const threadId = snapshot.currentThreadId;
    if (!threadId) throw new Error("Missing custom assistant conversation");
    expect(snapshot.accounts).toEqual([]);
    expect(snapshot.accountId).toBeUndefined();
    expect(snapshot.models).toEqual([{ id: "custom-model", label: "Custom Model" }]);
    expect(snapshot.messages.at(-1)?.body).toBe("收到：tool");
    expect(f.conversations.conversationV2().findTool(threadId, "call-1")?.status).toBe("completed");
    const nativeId = f.conversations.getThreadCoreSession(threadId)?.externalSessionId;
    if (!nativeId) throw new Error("Missing custom assistant native session");
    // A free-form upstream id must not be rejected by Codex's official model catalog.
    await f.service.saveSettings({ ...f.service.settings, model: "another-custom-model" });
    await f.service.send("hello", "desktop", "custom-resume");
    snapshot = await f.service.snapshot();
    expect(snapshot.currentThreadId).toBe(threadId);
    expect(f.conversations.getThreadCoreSession(threadId)?.externalSessionId).toBe(nativeId);
    const requests = (await fs.readFile(path.join(f.root, "runtime-requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      requests.some((request) => request.method === "model/list" || request.method === "account/login/start"),
    ).toBe(false);
    const modelRequests = requests.filter((request) =>
      ["thread/start", "thread/resume", "turn/start"].includes(request.method),
    );
    expect(modelRequests.map((request) => request.model)).toEqual(
      ["custom-model", "custom-model", "another-custom-model", "another-custom-model"].map((model) =>
        buildCodexGatewayModelAlias("custom", model, "openai_chat_completions"),
      ),
    );
    for (const request of modelRequests) {
      expect(request.home).toBe(path.join(f.root, "mori-assistant", "codex"));
      if (request.method !== "turn/start")
        expect(request.modelProvider).toBe(buildCodexModelProviderSlug("custom"));
    }
    expect(f.preparedProviders).toEqual(["custom", "custom"]);
    expect(f.accountCalls).toEqual([]);
    const config = await fs.readFile(path.join(f.root, "mori-assistant", "codex", "config.toml"), "utf8");
    expect(config).toContain("[model_providers.eco_custom]");
    expect(config).toContain('base_url = "http://127.0.0.1:18765/v1"');
    expect(config).not.toContain("access-only");
  } finally {
    await f.service.close();
    f.db.close();
  }
});

test("switching between custom models and ChatGPT resumes the isolated assistant session", async () => {
  const f = await fixture();
  try {
    await f.service.send("chatgpt", "desktop", "source-chatgpt");
    const threadId = f.service.store.state.currentThreadId;
    if (!threadId) throw new Error("Missing assistant conversation");
    const nativeId = f.conversations.getThreadCoreSession(threadId)?.externalSessionId;
    if (!nativeId) throw new Error("Missing assistant native session");
    await f.service.saveSettings({
      ...f.service.settings,
      modelSource: "custom",
      providerId: "custom",
      model: "custom-model",
      autoSwitchAccounts: true,
    });
    expect((await f.service.snapshot()).accountId).toBeUndefined();
    f.accountCalls.length = 0;
    await f.service.send("custom", "desktop", "source-custom");
    expect(f.accountCalls).toEqual([]);
    await f.service.saveSettings({ ...f.service.settings, modelSource: "chatgpt", model: "gpt-6-luna" });
    await f.service.send("chatgpt again", "desktop", "source-back");
    expect((await f.service.snapshot()).accountId).toBe("a");
    expect(f.conversations.getThreadCoreSession(threadId)?.externalSessionId).toBe(nativeId);
    expect((await f.service.snapshot()).messages).toHaveLength(6);
  } finally {
    await f.service.close();
    f.db.close();
  }
});

test("a disabled custom provider fails explicitly without falling back, and the assistant can be disabled", async () => {
  const f = await fixture({ custom: true });
  try {
    await f.service.send("first", "desktop", "custom-first");
    f.setProviderEnabled(false);
    await expect(f.service.send("do not fall back", "desktop", "custom-disabled")).rejects.toThrow(
      "服务商已删除、禁用",
    );
    expect(f.preparedProviders).toEqual(["custom"]);
    expect(f.accountCalls).toEqual([]);
    await expect(f.service.saveSettings({ ...f.service.settings })).rejects.toThrow("服务商已删除、禁用");
    await f.service.saveSettings({ ...f.service.settings, enabled: false });
    expect(f.service.settings.enabled).toBe(false);
  } finally {
    await f.service.close();
    f.db.close();
  }
});

test("custom provider quota errors never rotate retained ChatGPT account selections", async () => {
  const f = await fixture({ custom: true });
  try {
    await f.service.saveSettings({ ...f.service.settings, accountIds: ["a", "b"], autoSwitchAccounts: true });
    await expect(f.service.send("quota-failure", "desktop", "custom-quota")).rejects.toThrow(
      "usage_limit_reached",
    );
    expect(f.preparedProviders).toEqual(["custom"]);
    expect(f.accountCalls).toEqual([]);
    expect((await f.service.snapshot()).error).toBe("usage_limit_reached");
  } finally {
    await f.service.close();
    f.db.close();
  }
});

test("assistant thread tools expose saved errors even with only a user transcript", async () => {
  const { service, db, conversations } = await fixture();
  try {
    conversations.saveThread({
      id: "blocked-work",
      title: "blocked",
      prompt: "work",
      workspacePath: "/test/project",
      coreKind: "codex",
      status: "blocked",
      message: "fetch failed ECONNREFUSED https://user:PRIVATE_PASSWORD@private.example/v1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const v2 = conversations.conversationV2();
    v2.appendRuntime({
      conversationId: "blocked-work",
      eventId: "user-only",
      messageId: "user-only",
      turnId: "turn",
      type: "message.created",
      occurredAt: new Date().toISOString(),
      payload: { role: "user", body: "work", status: "final" },
    });
    const call = (name: string, args: Record<string, unknown> = {}) =>
      service["callTool"](name, args, randomUUID(), new AbortController().signal);
    const listed = (await call("mori_list_threads")) as Array<{
      id: string;
      currentError: { category: string; message: string };
    }>;
    expect(listed.find((thread) => thread.id === "blocked-work")?.currentError.category).toBe(
      "model_connection",
    );
    const read = (await call("mori_read_thread", { threadId: "blocked-work" })) as {
      messages: Array<{ role: string }>;
      diagnostics: { currentError: { category: string } };
    };
    expect(read.messages.map((message) => message.role)).toEqual(["user"]);
    expect(read.diagnostics.currentError.category).toBe("model_connection");
    expect(await call("mori_read_thread_errors", { threadId: "blocked-work" })).toEqual(read.diagnostics);
    expect(JSON.stringify([listed, read])).not.toMatch(/PRIVATE_PASSWORD|private\.example/);
    conversations.updateThread("blocked-work", { status: "completed", message: "" });
    expect(await call("mori_read_thread_errors", { threadId: "blocked-work" })).toMatchObject({
      status: "completed",
      currentError: null,
      currentErrorMissing: false,
    });
    conversations.updateThread("blocked-work", { status: "failed", message: "" });
    expect(await call("mori_read_thread_errors", { threadId: "blocked-work" })).toMatchObject({
      status: "failed",
      currentError: null,
      currentErrorMissing: true,
    });
  } finally {
    await service.close();
    db.close();
  }
});

test("assistant error queries reject self, missing threads, extra parameters and cancelled calls", async () => {
  const { service, db } = await fixture();
  try {
    await service.send("prepare", "desktop", "diagnostic-boundary");
    const assistantId = (await service.snapshot()).currentThreadId;
    expect(assistantId).toBeTruthy();
    await service.newSession();
    await service.send("prepare another session", "desktop", "diagnostic-boundary-another");
    const currentAssistantId = (await service.snapshot()).currentThreadId;
    for (const name of ["mori_read_thread", "mori_read_thread_errors"]) {
      const call = (args: Record<string, unknown>, signal = new AbortController().signal) =>
        service["callTool"](name, args, randomUUID(), signal);
      await expect(call({ threadId: assistantId })).rejects.toThrow("工作会话不存在");
      await expect(call({ threadId: currentAssistantId })).rejects.toThrow("工作会话不存在");
      await expect(call({ threadId: "missing" })).rejects.toThrow("工作会话不存在");
      await expect(call({ threadId: "missing", includeSecrets: true })).rejects.toThrow("不允许");
      await expect(call({ threadId: "missing" }, AbortSignal.abort())).rejects.toThrow();
    }
    const listed = (await service["callTool"](
      "mori_list_threads",
      {},
      randomUUID(),
      new AbortController().signal,
    )) as Array<{ id: string }>;
    expect(listed.some((thread) => thread.id === assistantId)).toBe(false);
    expect(listed.some((thread) => thread.id === currentAssistantId)).toBe(false);
  } finally {
    await service.close();
    db.close();
  }
});

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

test("resumed Mori manages global schedules through MCP with revision checks and durable idempotency", async () => {
  const f = await fixture();
  try {
    const trigger = { type: "cron" as const, expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" };
    const external = f.scheduling.create({
      kind: "scheduled_task",
      requestId: "settings-created",
      name: "设置页的任务",
      prompt: "检查项目并总结",
      workspacePath: "/test/project",
      executionProfile: f.scheduleProfile(),
      trigger,
    });
    await f.service.send("prepare schedule session", "desktop", "schedule-prepare");
    const native = f.conversations.getThreadCoreSession(f.service.store.state.currentThreadId!)!;
    await f.service.saveSettings({ ...f.service.settings, name: "Mori 定时管理" });
    const listed = await assistantTool(f, "mori_list_schedules", { projectPath: "/test/project" });
    expect(listed).toMatchObject({
      status: "completed",
      output: { total: 1, items: [{ id: external.id, revision: 1 }] },
    });
    const probes = (await fs.readFile(path.join(f.root, "runtime-workspaces.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(probes.at(-1)).toMatchObject({
      method: "thread/resume",
      schedulingTools: MORI_SCHEDULING_TOOLS.map((tool) => tool.name),
    });
    expect(
      f.conversations.getThreadCoreSession(f.service.store.state.currentThreadId!)?.externalSessionId,
    ).toBe(native.externalSessionId);

    expect((await assistantTool(f, "mori_preview_schedule", { trigger })).output).toMatchObject({
      nextRuns: expect.any(Array),
    });
    const createArgs = {
      requestId: "daily-review",
      name: "每日审查",
      prompt: "检查 /test/project 的最新改动，输出摘要。",
      projectPath: "/test/project",
      trigger,
    };
    const created = await assistantTool(f, "mori_create_schedule", createArgs);
    expect(created).toMatchObject({
      status: "completed",
      output: { scheduled: true, schedule: { kind: "scheduled_task", coreKind: "pi" } },
    });
    const createdId = (created.output as { schedule: { id: string } }).schedule.id;
    expect((await assistantTool(f, "mori_create_schedule", createArgs)).output).toMatchObject({
      schedule: { id: createdId },
    });
    expect(f.schedulingStore.list()).toHaveLength(2);
    expect(
      (await assistantTool(f, "mori_create_schedule", { ...createArgs, prompt: "different" })).status,
    ).toBe("failed");
    const read = await assistantTool(f, "mori_read_schedule", { id: ` ${createdId} ` });
    expect(read.output).toMatchObject({ schedule: { revision: 1, executionProfile: { coreKind: "pi" } } });
    const toolResponses = (await fs.readFile(path.join(f.root, "runtime-tool-results.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const readResponse = toolResponses.findLast((response) => response.name === "mori_read_schedule");
    expect(JSON.parse(readResponse.result.content[0].text)).toMatchObject({
      schedule: { executionProfile: f.scheduleProfile() },
    });
    expect((read.output as { schedule: object }).schedule).not.toHaveProperty("creationSignature");

    expect(
      (
        await assistantTool(f, "mori_update_schedule", {
          id: external.id,
          expectedRevision: 1,
          name: "暂停检查",
          enabled: false,
        })
      ).status,
    ).toBe("completed");
    expect(f.schedulingStore.get(external.id)).toMatchObject({
      revision: 2,
      enabled: false,
      prompt: external.prompt,
      trigger,
      executionProfile: external.executionProfile,
    });
    expect(
      (
        await assistantTool(f, "mori_update_schedule", {
          id: external.id,
          expectedRevision: 1,
          prompt: "stale",
        })
      ).status,
    ).toBe("failed");
    expect(
      (await assistantTool(f, "mori_delete_schedule", { id: external.id, expectedRevision: 1 })).status,
    ).toBe("failed");
    expect(f.schedulingStore.get(external.id)?.revision).toBe(2);
    expect(
      (
        await assistantTool(f, "mori_update_schedule", {
          id: external.id,
          expectedRevision: 2,
          enabled: true,
        })
      ).status,
    ).toBe("completed");
    expect(
      (await assistantTool(f, "mori_delete_schedule", { id: external.id, expectedRevision: 3 })).output,
    ).toMatchObject({ deleted: true, runningOccurrencesContinue: true });
    expect(f.schedulingStore.get(external.id)).toBeUndefined();
    expect(f.commands.some((command) => command.channel === IPC_CHANNELS.threadStart)).toBe(false);
  } finally {
    await f.service.close();
    f.db.close();
  }
});

test("Mori schedule creation requires explicit work context and validates nested fields before mutations", async () => {
  const f = await fixture();
  try {
    const sourceProfile = {
      ...f.scheduleProfile(),
      coreKind: "codex" as const,
      runtimeConfig: {
        ...f.scheduleProfile().runtimeConfig,
        orchestrationSelection: {
          mainAgentConfigId: "old",
          mainPrompt: { mode: "builtin" as const },
          subagents: { mode: "none" as const },
        },
        mainAgentModelOverride: { providerId: "custom", modelId: "old-model" },
      },
    };
    const now = new Date().toISOString();
    f.conversations.saveThread({
      id: "source-work",
      title: "已有工作",
      prompt: "work",
      workspacePath: "/source/project",
      ...sourceProfile,
      status: "completed",
      message: "",
      createdAt: now,
      updatedAt: now,
    });
    const args = {
      requestId: "source",
      name: "跟进工作",
      prompt: "查看运行结果并总结",
      trigger: { type: "at", at: "2099-01-01T01:00:00+08:00" },
    };
    const inherited = await assistantTool(f, "mori_create_schedule", {
      ...args,
      sourceThreadId: "source-work",
    });
    const inheritedId = (inherited.output as { schedule: { id: string } }).schedule.id;
    expect(f.schedulingStore.get(inheritedId)).toMatchObject({
      workspacePath: "/source/project",
      executionProfile: sourceProfile,
    });
    expect(
      (
        await assistantTool(f, "mori_update_schedule", {
          id: inheritedId,
          expectedRevision: 1,
          coreKind: "pi",
          providerId: "custom",
          modelId: "selected",
        })
      ).status,
    ).toBe("completed");
    expect(f.schedulingStore.get(inheritedId)?.executionProfile).toMatchObject({
      coreKind: "pi",
      runtimeConfig: { mainAgentModelOverride: { providerId: "custom", modelId: "selected" } },
    });
    const message = await assistantTool(f, "mori_create_schedule", {
      ...args,
      requestId: "message",
      kind: "session_message",
      threadId: "source-work",
    });
    expect(message).toMatchObject({
      status: "completed",
      output: { schedule: { kind: "session_message", threadId: "source-work" } },
    });
    const messageId = (message.output as { schedule: { id: string } }).schedule.id;
    for (const invalid of [
      { ...args },
      { ...args, projectPath: f.service.workspacePath },
      { ...args, projectPath: "relative/project" },
      { ...args, sourceThreadId: "unknown-thread" },
      { ...args, projectPath: "/test/project", providerId: "custom" },
      { ...args, projectPath: "/test/project", trigger: { type: "at", at: "2099-01-01T09:00:00" } },
      {
        ...args,
        projectPath: "/test/project",
        trigger: { type: "cron", expression: "0 9 * * *", timezone: "Invalid/Timezone" },
      },
      {
        ...args,
        projectPath: "/test/project",
        trigger: { type: "interval", everySeconds: 30, anchorAt: args.trigger.at },
      },
      { ...args, projectPath: "/test/project", hidden: "unknown" },
      { ...args, kind: "session_message", threadId: f.service.store.state.currentThreadId },
      { ...args, kind: "session_message", threadId: "source-work", projectPath: "/test/project" },
    ])
      expect((await assistantTool(f, "mori_create_schedule", invalid)).status).toBe("failed");
    expect(
      (
        await assistantTool(f, "mori_update_schedule", {
          id: messageId,
          expectedRevision: 1,
          projectPath: "/elsewhere",
        })
      ).status,
    ).toBe("failed");
    expect(
      (await assistantTool(f, "mori_update_schedule", { id: inheritedId, expectedRevision: 2 })).status,
    ).toBe("failed");
    expect(
      (await assistantTool(f, "mori_delete_schedule", { id: inheritedId, expectedRevision: "2" })).status,
    ).toBe("failed");
    expect(f.schedulingStore.list()).toHaveLength(2);
    expect(f.schedulingStore.get(inheritedId)?.revision).toBe(2);
    expect(
      (
        await assistantTool(f, "mori_update_schedule", {
          id: inheritedId,
          expectedRevision: 2,
          mainAgentConfigId: "new-agent",
        })
      ).status,
    ).toBe("completed");
    expect(
      f.schedulingStore.get(inheritedId)?.executionProfile?.runtimeConfig.orchestrationSelection
        ?.mainAgentConfigId,
    ).toBe("new-agent");
    expect(
      f.schedulingStore.get(inheritedId)?.executionProfile?.runtimeConfig.mainAgentModelOverride,
    ).toBeUndefined();
  } finally {
    await f.service.close();
    f.db.close();
  }
});

test("Mori schedule reads page Unicode and preserve image metadata; cancellation and delete races cannot write", async () => {
  const f = await fixture();
  try {
    const created = f.scheduling.create({
      kind: "scheduled_task",
      requestId: "pages",
      name: "分页任务",
      prompt: "😀甲乙丙丁",
      workspacePath: "/test/project",
      executionProfile: f.scheduleProfile(),
      trigger: { type: "at", at: "2099-01-01T00:00:00Z" },
    });
    const controller = new AbortController();
    let mode = "normal";
    const management = new MoriAssistantScheduling({
      defaultProfile: f.scheduleProfile,
      projectPath: (value) => value,
      workThread: (id) => f.conversations.getThread(id),
      invoke: async (channel, args) => {
        if (channel === IPC_CHANNELS.schedulingList) {
          const snapshot = f.schedulingStore.snapshot();
          if (mode === "abort") controller.abort(new Error("用户停止"));
          if (mode === "race") f.scheduling.update({ id: created.id, expectedRevision: 1, name: "并发编辑" });
          return snapshot;
        }
        if (channel === IPC_CHANNELS.schedulingDelete)
          return f.scheduling.remove(String(args[0]), { source: "user" }, args[1] as number);
        throw new Error(`Unexpected mutation: ${channel}`);
      },
    });
    const signal = new AbortController().signal;
    expect(
      await management.call("mori_read_schedule", { id: created.id, offset: 0, limit: 2 }, signal),
    ).toMatchObject({ schedule: { prompt: "😀甲", totalCharacters: 5, nextOffset: 2 } });
    expect(
      await management.call(
        "mori_list_schedules",
        { enabled: true, kind: "scheduled_task", search: "分页", limit: 1 },
        signal,
      ),
    ).toMatchObject({ total: 1, items: [{ id: created.id }], nextOffset: null });
    expect(await management.call("mori_list_schedules", { offset: 1 }, signal)).toMatchObject({
      total: 1,
      items: [],
      nextOffset: null,
    });
    const now = new Date().toISOString();
    f.conversations.saveThread({
      id: "image-work",
      title: "图片工作",
      prompt: "work",
      workspacePath: "/test/project",
      ...f.scheduleProfile(),
      status: "completed",
      message: "",
      createdAt: now,
      updatedAt: now,
    });
    const withImage = f.scheduling.create({
      kind: "session_message",
      requestId: "image",
      name: "图片消息",
      prompt: "查看图片",
      threadId: "image-work",
      trigger: created.trigger,
      attachments: [{ mediaType: "image/png", contentRef: `sha256:${"a".repeat(64)}`, byteLength: 100 }],
    });
    const imageRead = await management.call("mori_read_schedule", { id: withImage.id }, signal);
    expect(imageRead).toMatchObject({
      schedule: { attachments: [{ mediaType: "image/png", byteLength: 100 }] },
    });
    expect(JSON.stringify(imageRead)).not.toContain("sha256:");
    expect(
      await management.call("mori_list_schedules", { projectPath: "/test/project", limit: 1 }, signal),
    ).toMatchObject({ total: 2, nextOffset: 1 });
    mode = "race";
    await expect(
      management.call("mori_delete_schedule", { id: created.id, expectedRevision: 1 }, signal),
    ).rejects.toThrow("修改");
    expect(f.schedulingStore.get(created.id)).toMatchObject({ name: "并发编辑", revision: 2 });
    mode = "abort";
    await expect(
      management.call(
        "mori_update_schedule",
        { id: created.id, expectedRevision: 2, enabled: false },
        controller.signal,
      ),
    ).rejects.toThrow("用户停止");
    expect(f.schedulingStore.get(created.id)).toMatchObject({ revision: 2, enabled: true });
  } finally {
    await f.service.close();
    f.db.close();
  }
});

test("resumed assistant reads error details through MCP and enforces the work-thread boundary", async () => {
  const f = await fixture();
  try {
    f.conversations.saveThread({
      id: "blocked-work",
      title: "blocked",
      prompt: "work",
      workspacePath: "/test/project",
      coreKind: "codex",
      status: "blocked",
      message: "【连接失败】HTTP 503：上游模型连接中断",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await f.service.send("prepare", "desktop", "error-resume-prepare");
    const assistantId = f.service.store.state.currentThreadId!;
    const nativeId = f.conversations.getThreadCoreSession(assistantId)?.externalSessionId;
    await f.service.saveSettings({ ...f.service.settings, name: "Mori error probe" });
    const result = await assistantTool(f, "mori_read_thread_errors", { threadId: "blocked-work" });
    expect(result.status).toBe("completed");
    expect(result.output).toMatchObject({
      threadId: "blocked-work",
      status: "blocked",
      currentError: { category: "model_connection", httpStatus: 503 },
    });
    expect(f.conversations.getThreadCoreSession(assistantId)?.externalSessionId).toBe(nativeId);
    expect((await assistantTool(f, "mori_read_thread_errors", { threadId: assistantId })).status).toBe(
      "failed",
    );
    expect((await assistantTool(f, "mori_read_thread_errors", { threadId: "missing" })).status).toBe(
      "failed",
    );
    const probes = (await fs.readFile(path.join(f.root, "runtime-workspaces.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(probes.at(-1)).toMatchObject({
      method: "thread/resume",
      taskTools: expect.arrayContaining(["mori_read_thread_errors"]),
    });
  } finally {
    await f.service.close();
    f.db.close();
  }
});

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

test("task completion keeps internal instructions in model context and shows only the result", async () => {
  const f = await fixture();
  try {
    await f.service.send(
      `mcp-tool:${JSON.stringify({ name: "mori_start_task", args: { projectPath: "/test/project", prompt: "修复 loading" } })}`,
      "wechat",
      "start-task-from-wechat",
    );
    const taskId = f.service.store.state.taskIds[0];
    if (!taskId) throw new Error("Missing work task");
    const v2 = f.conversations.conversationV2();
    v2.appendRuntime({
      conversationId: taskId,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      type: "message.created",
      messageId: "task-result",
      payload: { role: "assistant", channel: "answer", status: "final", body: "旋转问题已修复，检查通过。" },
    });
    f.conversations.updateThread(taskId, { status: "completed", message: "" });
    // A task may finish after the user has opened a new, empty assistant session.
    await f.service.newSession();
    const notifications: Array<{ text: string; messageId: string | undefined; id: string }> = [];
    f.service.onWechatReply = async (text, messageId, id) => {
      notifications.push({ text, messageId, id });
    };
    await f.service.taskChanged(taskId);
    const snapshot = await f.service.snapshot();
    const commandId = `task-complete-${taskId}-${f.conversations.getThread(taskId)?.updatedAt}`;
    const triggerId = `mori-user-${commandId}`;
    const threadId = snapshot.currentThreadId;
    if (!threadId) throw new Error("Missing assistant conversation");
    expect(snapshot.messages.map((message) => [message.role, message.body])).toEqual([
      ["assistant", "任务已完成，已修复 loading 图标旋转。"],
    ]);
    expect(snapshot.sessions[0]?.title).toBe("任务结果");
    expect(snapshot.sourceByMessage[triggerId]).toBe("task");
    const internalPrompt = v2.getMessage(threadId, triggerId)?.body;
    expect(internalPrompt).toContain("请向用户简要说明结果，不要再次执行任务");
    expect(internalPrompt).toContain("旋转问题已修复，检查通过。");
    const inputs = (await fs.readFile(path.join(f.root, "runtime-inputs.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { text: string });
    expect(inputs.at(-1)?.text).toBe(internalPrompt);
    expect(notifications).toEqual([
      { text: "任务已完成，已修复 loading 图标旋转。", messageId: "start-task-from-wechat", id: commandId },
    ]);
    const head = v2.head(threadId).lastSeq;
    await f.service.taskChanged(taskId);
    expect(v2.head(threadId).lastSeq).toBe(head);
    expect(notifications).toHaveLength(1);
    // Returning to durable history must not bring the hidden user bubble back.
    await f.service.newSession();
    await f.service.store.load();
    await f.service.selectSession(threadId);
    expect((await f.service.snapshot()).messages.map((message) => message.body)).toEqual(
      snapshot.messages.map((message) => message.body),
    );
    expect(v2.validateIntegrity(threadId).headSeq).toBe(head);
  } finally {
    await f.service.close();
    f.db.close();
  }
});

test("existing task prompts stay hidden across history pages without hiding user quotes or answers", async () => {
  const f = await fixture();
  try {
    const quote = "请解释这段指令：请向用户简要说明结果，不要再次执行任务";
    await f.service.send(quote, "desktop", "quoted-instruction");
    const threadId = f.service.store.state.currentThreadId;
    if (!threadId) throw new Error("Missing assistant conversation");
    const v2 = f.conversations.conversationV2();
    // Seed durable history in the exact format written by versions before this fix.
    for (let i = 0; i < 125; i++) {
      const messageId = `mori-user-legacy-task-${i}`;
      v2.sendMessage({
        principalId: "mori-assistant",
        conversationId: threadId,
        clientCommandId: `legacy-task-${i}`,
        messageId,
        text: `内部任务指令 ${i}：原始 JSON`,
      });
      f.service.store.state.sourceByMessage[messageId] = "task";
    }
    v2.appendRuntime({
      conversationId: threadId,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      type: "message.created",
      messageId: "mori-question-answer-legacy",
      payload: { role: "user", channel: "answer", status: "final", body: "允许" },
    });
    f.service.store.state.sourceByMessage["mori-question-answer-legacy"] = "wechat";
    await f.service.store.save();
    await f.service.newSession();
    await f.service.store.load();
    await f.service.selectSession(threadId);
    const visible: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let emptyPages = 0;
    do {
      const snapshot = await f.service.snapshot(cursor);
      visible.unshift(...snapshot.messages.map((message) => message.body));
      if (!snapshot.messages.length) emptyPages++;
      expect(snapshot.hasMoreMessages).toBe(Boolean(snapshot.messageCursor));
      expect(snapshot.messages.some((message) => message.body.startsWith("内部任务指令"))).toBe(false);
      expect(snapshot.messageCursor).not.toBe(cursor);
      cursor = snapshot.messageCursor;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(emptyPages).toBeGreaterThan(0);
    expect(visible).toEqual([quote, `收到：${quote}`, "允许"]);
    expect(v2.getMessage(threadId, "mori-user-legacy-task-0")?.body).toContain("原始 JSON");
    v2.validateIntegrity(threadId);
  } finally {
    await f.service.close();
    f.db.close();
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
