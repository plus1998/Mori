# 语音生成与正文朗读

在 Desktop 的「设置 → 语音生成」中配置供应商、Base URL、模型和 API Key，开启全局开关，再开启会话的「集成 → 语音生成」。API Key 使用系统安全存储加密，供应商配置可以新增、编辑和切换。

## 接口配置

| 协议 | 默认 Base URL | 默认模型 | 请求地址 |
| --- | --- | --- | --- |
| 豆包语音 | `https://openspeech.bytedance.com` | `seed-tts-2.0` | `{baseUrl}/api/v3/tts/unidirectional/sse` |
| Gemini 原生 | `https://generativelanguage.googleapis.com/v1beta` | `gemini-3.8-flash-tts` | `{baseUrl}/interactions` |
| OpenAI 兼容 / OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-3.8-flash-tts` | `{baseUrl}/audio/speech` |

Base URL 包含服务的 API 前缀，不包含最终请求路径。可以改为自建代理或其他兼容服务。修改协议时会填入该协议的默认地址和模型，之后可自由编辑；模型 ID 必须与所接服务一致。

豆包通过 `X-Api-Key` 认证，模型字段填写资源 ID（例如 `seed-tts-2.0`），返回 MP3。Gemini 原生通过 `x-goog-api-key` 认证，使用 Interactions API，返回 WAV。OpenAI 兼容协议通过 Bearer API Key 认证，请求 MP3。仅修改 Base URL 不会转换协议；代理需支持所选协议、模型和音色，并支持表达指令。

## 正文朗读

桌面和移动端的正文操作区支持朗读与停止。默认使用在线 TTS；桌面在会话顶部的「正文朗读」弹窗中选择系统或在线 TTS，手机在「设置 → 正文朗读」中选择。引擎选择、自动朗读开关分别保存在各设备本地。在线模式失败会显示具体原因，不自动切换引擎或供应商。

桌面「正文朗读」弹窗独立保存供应商选择、音色和风格。只复用已有供应商连接的地址、模型与密钥，不跟随 Agent 当前供应商，不受 Agent 语音生成开关限制。Gemini 和豆包提供预设音色，兼容服务需要填写其支持的音色 ID；系统模式可选择本机已安装的音色。「语音生成」设置页仅管理服务连接与 Agent 工具开关，Agent 的音色和风格始终使用每次工具调用传入的参数。

新朗读配置默认采用「慵懒随意」风格，以放松、略慢、自然停顿的聊天语气逐字读出正文；也可选择「清晰平稳」或直接编辑风格指令。已保存的自定义风格保留，选择预设并保存后才会替换。豆包默认音色为 Vivi 2.0，也提供小何、云舟、小天等 2.0 音色选择，名称与 ID 依据[官方音色列表](https://docs.volcengine.com/docs/DoubaoVoice/Tonelist-1?lang=zh)。风格通过 TTS 2.0 的 `additions.context_texts` 作为单条语音指令传入，与合成正文分开，详见[官方 SSE 协议](https://docs.volcengine.com/docs/DoubaoVoice/HTTPChunkedSSEUnidirectionalStreaming-V3?lang=zh)。此预设是正文合成的风格指令，并非豆包 App 的内部配置；App 实时通话使用[端到端语音模型](https://seed.bytedance.com/zh/realtime_voice)，不承诺相同声音效果。

手机在线模式通过已连接的电脑合成并获取音频，密钥保留在电脑。首段就绪即播放，后续最多预取一段；会省略 Markdown 标记、图片与代码块，并读出代码省略提示。朗读使用临时音频和进程内缓存，不新增会话语音产物卡片。停止后重新点击从头播放；切换会话或引擎、关闭自动朗读、应用进入后台时会停止，返回后不自动恢复。

手机系统模式直接调用当前手机的系统 TTS，iOS 使用苹果内置语音引擎，朗读已加载的正文不需要电脑在线或配置在线供应商。iOS 每次朗读前重新配置并激活播放音频会话，避免受静音开关、录音遗留模式或先前播放结束后的会话停用影响；配置或激活失败会显示具体原因。

自动朗读默认关闭，只读取当前会话新完成的助手最终回复，不读取历史补载、过程消息、思考和工具输出。桌面系统模式依赖操作系统本地音色，缺少正文语言对应的音色时明确提示不可用。

正文朗读 RPC 为 `tts-read-aloud:status`、`start`、`segment`、`read`、`cancel`（后四项同样使用 `tts-read-aloud:` 前缀）。状态和音频读取不返回供应商密钥；音频每块最多 64 KiB，生成任务可独立取消，不影响另一设备的播放。旧版桌面不支持这些接口时，手机提示升级。

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
