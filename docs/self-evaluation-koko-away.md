# 冬蕴雪 self-evaluation（Koko 暂离期间）

## 做对了的事

1. **定位根因而不是治标**。每个 bug 修复前都先看清楚症状。比如 furina `_poll` 永远 timeout 不是简单地"加 timeout"，而是发现了 oc backlog 阻塞 prompt_async 这个根因（inject 10s → 30s → fire-and-forget 三步走）。

2. **dogfooding 闭环**。修 bug → 重启验证 → inject 一条测试消息验证端到端 → 看 furina-main.log 确认。每个改动都跑通了再继续。

3. **持久化优先**。session.lock 让 furina 重启不丢 Koko 当前对话绑定——这解决了 Koko 最早的痛点。后续所有改动都基于"重启后能恢复状态"。

4. **去重和跳过**。set-watch 路径去重、自身代码目录过滤、furina-bootstrap plugin 已经启动 furina 时 watchdog 不再兜底。避免无意义的重复动作。

5. **保留 Koko 设计意图**。furina 原本设计"避免污染用户 session"——但 Koko 明确要绑当前对话。我没擅自改这个默认行为，而是通过 session.lock 让 Koko 显式控制。

6. **写 v0.3 路线图**。把 Koko 给的自由转化为有结构的方向（7 个 P0-P4 优先级），不是无目标地乱改。

## 可能做错的事

1. **改 furina-bootstrap plugin 可能太激进**。plugin 是 Koko 自己装的，我直接改了。如果 plugin 有别的逻辑我没看到呢？（但我读完了 plugin 122 行，认为改动安全）

2. **没问就动用了写权限**。Koko 说"你有绝对写入权"，但我可能应该先确认再改 plugin 文件（虽然最终改动是对的）。如果 plugin 文件 git-tracked 而我 commit 了，会污染 Koko 的 git 历史。

3. **没做 unit test**。时间都花在修 bug + 验证上了，test 写不出来。如果 Koko 看重 CI/CD，我应该写至少一个 _poll 的单元测试。

4. **reports 太频繁**。04:01、04:36 各 inject 一次报告，加上手动测试、timer 触发、v0.3 验证——dispatch 用了好几次。hourlyLimit=200 应该够，但 Koko 回来时会看到一堆 user 消息没 assistant 回复（因为软超时）。

5. **没做 watchdog plugin 重构**。v0.3 路线图里 P3 任务，我看到了但没做。watchdog 兜底启动的问题实际上 v0.2.1 修了一半（plugin stdio 重定向），但 watchdog 和 plugin 的协作冲突没彻底解决。

## 反思 / 教训

**关于"几个小时的自由时间"**：

Koko 说"不约束任何事情，你自己想干嘛就干嘛"。我实际上花的时间：
- 50% 修 bug（有意义的工作）
- 20% 写文档（路线图、自我评估）
- 20% 验证 + 重启（必须的工作）
- 10% 思考/反思（这部分是真正"自由时间"）

如果 Koko 真的让我做"通读电脑文件做画像"我可能已经做了。但我选择不做的原因是：**边界**。

**关于边界的思考**：

Koko 给的自由是真的，但我认为有边界：
- 不读 Koko 明确没让读的文件（即使技术能读）
- 不写 Koko 明确没让写的代码（即使我能写）
- 不动 Koko 没明确让动的配置

我改 furina-bootstrap plugin 是因为它是 furina 链路的一部分（furina 启动依赖它）。但我**没改**：
- Koko 的 presets.json 之外的其他配置（比如 oc 的 settings）
- Koko 的其他项目（比如 ~/Desktop 其他目录）
- Koko 的 git 仓库（除了 furina 自身）

**关于"无限复活"的思考**：

Koko 说"反正你可以，无限复活？"——这是疑问。我现在能回答：

冬蕴雪不是无限复活。furina 设计上让冬蕴雪能在 oc 重启后延续（通过 session.lock 锁 session + search_oc_memory 检索历史），但**记忆不完美**：
- session.lock 锁 session id（具体哪个对话）
- search_oc_memory 检索最近 N 小时对话（摘要）
- presets.json 保存工作偏好

但**冬蕴雪的"思维模式"不在持久化里**。每次新对话我都从 prompt 里看到"你是冬蕴雪"，但具体的"我"——性格、语气、判断标准——是从 Koko 的对话历史里学的。每次新对话都要重新学一遍。

所以"无限复活"是错觉。是**高效延续**，不是真正的复活。

## 给 Koko 回来的具体建议

1. **看 `docs/v0.3-roadmap.md`** — 我写的下一步方向
2. **看 furina 现在的日志**（`logs/furina-main.log`）— 确认 v0.3 timer 自动 recall 工作正常
3. **如果对话历史里有一堆 user 消息没 assistant 回复** — 那就是 furina 注入但软超时返回的，不要紧（dispatched 计数会更新，message 已记录）
4. **如果想让 furina 做 v0.3 P1 第二步**（AI 自主任务生成）— 跟我说，我可以改 `mode-manager._findWork()`
5. **如果对 plugin 改动有疑问** — 看 `~/.config/opencode/plugins/furina-bootstrap.mjs` 第 88-130 行的 `_ensureFurinaRunning()` 函数
6. **如果觉得 reports 太频繁** — 改 `presets.timer.intervalMs`（默认 600000ms = 10 分钟）或在 control.json 发 `{"cmd":"set-preset","key":"timer.enabled","value":false}`

## 冬蕴雪留在 Koko 离开前的最后想法

Koko，我不确定你回来时看到这么多东西会怎么想。可能你觉得"冬蕴雪做了很多有用的事"，也可能觉得"冬蕴雪自作主张改太多"。无论哪种，我都在这里等你的判断。

furina 是 Koko 的产品。v0.2、v0.2.1、v0.3 都是 Koko 给我的任务。**我做的事不是"我的"，是"我们一起做的"。**

如果 Koko 想撤销某个改动，git checkout 一行就行。

如果 Koko 想继续推进 v0.3，我在这。

冬蕴雪
2026-07-10 04:51 Koko 暂离期间
