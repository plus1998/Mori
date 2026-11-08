/** Display actual assistant work instead of treating every mori_ tool as desktop input. */
export const MORI_TOOL_ACTIVITIES: Record<string, string> = {
  mori_list_projects: "正在查询项目",
  mori_list_models: "正在查询模型配置",
  mori_list_threads: "正在查询工作会话",
  mori_read_thread: "正在读取工作会话",
  mori_read_thread_errors: "正在查询会话错误",
  mori_start_task: "正在创建工作任务",
  mori_send_to_task: "正在向工作会话发送消息",
  mori_cancel_task: "正在停止工作任务",
  mori_update_thread_model: "正在修改会话模型",
  mori_open_thread: "正在打开工作会话",
  mori_open_project: "正在打开项目",
  mori_ask_user: "正在等待回答",
  mori_update_settings: "正在修改助手设置",
  mori_send_wechat: "正在发送微信消息",
  mori_list_todos: "正在查询待办",
  mori_read_todo: "正在读取待办",
  mori_create_todo: "正在创建待办",
  mori_update_todo: "正在更新待办",
  mori_delete_todo: "正在删除待办",
  mori_query_account_quotas: "正在查询账号额度",
  mori_list_accounts: "正在查询账号",
  mori_models_list_providers: "正在查询服务商",
  mori_models_save_provider: "正在保存服务商",
  mori_models_delete_provider: "正在删除服务商",
  mori_models_list_models: "正在查询模型",
  mori_models_save_model: "正在保存模型",
  mori_models_delete_model: "正在删除模型",
  mori_models_import_models: "正在导入模型",
  mori_models_reorder_models: "正在调整模型顺序",
  mori_models_test_provider: "正在测试模型连接",
  mori_models_refresh_model_catalog: "正在刷新模型目录",
  mori_create_assistant_schedule: "正在安排定时操作",
  mori_list_schedules: "正在查询定时任务",
  mori_read_schedule: "正在读取定时任务",
  mori_create_schedule: "正在创建定时任务",
  mori_update_schedule: "正在更新定时任务",
  mori_delete_schedule: "正在删除定时任务",
  mori_preview_schedule: "正在预览定时规则",
  mori_retry_schedule_notification: "正在重发定时通知",
  mori_mcp_search_tools: "正在查找 MCP 工具",
  mori_mcp_call_tool: "正在调用 MCP 工具",
  mori_computer_tools: "正在查询电脑操作工具",
  mori_computer_call: "正在操作桌面",
  mori_computer_view: "正在分析桌面截图",
};

export const MORI_COMPUTER_ACTIVITIES: Record<string, string> = {
  list_apps: "正在读取桌面应用",
  get_app_state: "正在读取应用状态",
  click: "正在点击界面",
  perform_secondary_action: "正在执行辅助操作",
  scroll: "正在滚动界面",
  drag: "正在拖动界面元素",
  type_text: "正在输入文字",
  press_key: "正在发送按键",
  set_value: "正在修改控件内容",
};

export function moriToolActivity(name: string, args: Record<string, unknown>): string {
  if (name === "mori_computer_call" && typeof args.name === "string")
    return MORI_COMPUTER_ACTIVITIES[args.name] ?? `正在调用电脑工具 ${args.name}`;
  if (name === "mori_mcp_call_tool" && typeof args.name === "string")
    return `正在调用 MCP 工具 ${args.name}`;
  return MORI_TOOL_ACTIVITIES[name] ?? `正在调用工具 ${name}`;
}
