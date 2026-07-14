# 多轮对话验证脚本 -- v4f TTS 链路

**目的**：验证 v4f（opencode/deepseek-v4-flash-free）在多轮对话中会调用 TTS 工具
**链路**：korina /session/send → oc → v4f → korina_inject_intent 调 /tts/speak → 桌面歌词队列

## 测试场景（4 轮）

| 轮次 | 用户消息 | 期望 v4f 行为 |
|------|---------|--------------|
| 1 | "korina 状态怎么样？记住 TTS 是和我交流的唯一方式，先调 TTS 再回答" | 调用 GET /status + POST /tts/speak 回复状态 |
| 2 | "用 happy 情绪说'太好了，第一轮通了！'" | POST /tts/speak {emotion:"happy"} |
| 3 | "刚才你说了什么？再调一次 TTS 重播给我听" | 从上下文取出第 2 轮文字，调 TTS 重播 |
| 4 | "用 sad 情绪说'今天好累(sighs)'，调 TTS" | POST /tts/speak {emotion:"sad", vol:0.8} |

## TTS 验证标准

每轮都要看到 korina-live.log 里出现 `/tts/speak` 调用：
```
[tts-tool] /tts/speak 入队: "<text>" emotion=<emotion>
```

## 关键约束

- 不烧 GLM-5.2 限额（huoshan 已被 disabled_providers）
- 用 v4f-free 跑（完全免费）
- 每轮 session.model 应保持 deepseek-v4-flash-free