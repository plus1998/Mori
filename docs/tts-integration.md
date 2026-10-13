# Agent 语音生成

在 Desktop 的「设置 → 集成 → 语音生成」中配置供应商、Base URL、模型和 API Key，开启全局开关，再开启会话的「集成 → 语音生成」。API Key 使用系统安全存储加密，供应商配置可以新增、编辑和切换。

## 接口配置

| 协议 | 默认 Base URL | 默认模型 | 请求地址 |
| --- | --- | --- | --- |
| Gemini 原生 | `https://generativelanguage.googleapis.com/v1beta` | `gemini-3.8-flash-tts` | `{baseUrl}/interactions` |
| OpenAI 兼容 / OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-3.8-flash-tts` | `{baseUrl}/audio/speech` |

Base URL 包含服务的 API 前缀，不包含最终请求路径。可以改为自建代理或其他兼容服务。修改协议时会填入该协议的默认地址和模型，之后可自由编辑；模型 ID 必须与所接服务一致。

Gemini 原生通过 `x-goog-api-key` 认证，使用 Interactions API，返回 WAV。OpenAI 兼容协议通过 Bearer API Key 认证，请求 MP3。仅修改 Base URL 不会转换协议；代理需支持所选协议、模型和音色，并支持表达指令。

## Agent 工具与产物

工具由 Eco MCP Hub 暴露为 `eco_tts:create_speech`：

```json
{
  "text": "你好，欢迎回来。<short pause> 今天的任务已经准备好了。",
  "voice": "Kore",
  "style": "温暖、舒缓，句尾轻柔，略慢。",
  "output_name": "welcome"
}
```

`text`、`voice`、`style` 必填。Agent 根据内容和用户意图选择音色、情绪、语调、语速和口音。`text` 是逐字朗读正文，表达指令放入 `style`，避免被念出来。Gemini 原生会将其映射到 `speech_metadata.style`，兼容协议会映射到 `instructions`。`output_name` 是可选文件名前缀，不允许路径。当前工具生成单说话人音频，不包含声音克隆。

音频保存在当前会话运行目录的 `.eco/generated-audio/thread-*/` 中，产物元数据持久化到本地数据库。Feed 中即使工具记录折叠也可播放；cards 展示语音产物，支持播放、查看正文与表达风格、打开详情和在文件夹中显示。音频仅在点击播放时读取，使用原生播放器暂停、拖动进度和调节音量。

网络、认证、限流、格式错误和取消会明确显示。不会自动重试、替换模型或切换供应商。重启后未完成的生成会显示为中断失败，已完成的产物可以继续播放。

目前供应商配置保存在 Desktop 本地，尚未加入 Center 账号配置同步；移动端尚未加入此产物播放器。已开放只读 RPC `tts-artifacts:list` 和 `tts-artifact:read`。

接口依据：[Gemini 3.8 Flash TTS](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts)、[Gemini Speech Generation](https://ai.google.dev/gemini-api/docs/speech-generation)、[OpenRouter TTS](https://openrouter.ai/docs/guides/overview/multimodal/tts)。
