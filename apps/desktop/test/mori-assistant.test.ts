import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConversationStore } from "../src/main/conversation-store";
import { MoriAssistantService } from "../src/main/mori-assistant-service";
import { MoriAssistantStore, parseAssistantSettings } from "../src/main/mori-assistant-store";
import { parseWechatJson, validateWechatBaseUrl } from "../src/main/mori-assistant-wechat";
import type { OpenAIAccountService } from "../src/main/openai-account-service";
import { DEFAULT_MORI_ASSISTANT_SETTINGS } from "../src/shared/mori-assistant";
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
let thread='native-assistant-'+epoch, turn=0, text='', computer;
const callComputer=async(name,args)=>{
 const headers={...computer.http_headers,'Content-Type':'application/json','Accept':'application/json, text/event-stream'};
 const init=await fetch(computer.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:'init',method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}})});
 const session=init.headers.get('mcp-session-id');if(session)headers['Mcp-Session-Id']=session;
 await fetch(computer.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
 const response=await fetch(computer.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:'call',method:'tools/call',params:{name,arguments:args}})});
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
  require('node:fs').appendFileSync(${JSON.stringify(path.join(root, "runtime-workspaces.jsonl"))},JSON.stringify({cwd:process.cwd(),threadCwd:m.params.cwd})+'\\n');
  result={thread:{id:thread}};
 }
 if(m.method==='turn/start'){
  turn++;text=m.params.input[0].text;
  result={turn:{id:'turn-'+turn}};
  send({id:m.id,result});
  if(text.startsWith('computer-')){
   const name=text==='computer-catalog'?'mori_computer_tools':'mori_computer_call';
   const args=text==='computer-catalog'?{}:{name:text==='computer-read'?'list_apps':'click',arguments:text==='computer-read'?{}:{app:'test',index:1}};
   callComputer(name,args).catch(error=>send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-'+turn,status:'failed',error:{message:String(error)}}}}));
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
    invoke: async () => ({}),
    defaultRuntimeConfig: () => {
      throw new Error("not used");
    },
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
    expect(probes).toEqual([
      { cwd: workspace, threadCwd: workspace },
      { cwd: workspace, threadCwd: workspace },
    ]);
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
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(approval.title);
    expect(replies[0]).toContain('"index": 1');
    expect(replies[0]).toContain("请回复「允许」或「拒绝」");
    expect(computerCalls).toEqual([]);
    await service.respond(approval.id, "允许", "wechat");
    await waiting;
    expect(computerCalls).toEqual(["click"]);
    const snapshot = await service.snapshot();
    expect(snapshot.sourceByMessage[`mori-question-answer-${approval.id}`]).toBe("wechat");
  } finally {
    await service.close();
    db.close();
  }
});
