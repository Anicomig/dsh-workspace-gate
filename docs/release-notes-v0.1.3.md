修复门控静默失效。

**变更**
- `bind()` 在 `buildPlan()` 前自行等待插件清单（仅在清单为空或已过期时刷新）
- 插件清单读取失败时不再推进 `pluginFetchedAt`，失败后立即重试
- 并发的 `bind()` 共用同一次清单读取
- 配了隐藏却一条未命中时告警，区分「清单为空 / 插件不存在 / 名字不在可见面」
- `npm test` 改为执行 `tests/*.test.mjs`（此前只跑 `policy.test.mjs`）
- 版本号 `0.1.2 → 0.1.3`

**行为差异**
- `apply()` 末尾的 `refreshPlugins(true)` 是 fire-and-forget，而 `agent/created` 几乎紧接着
  触发 `bind()`。此前 `bind()` 拿到的是空清单，`resolveHidden()` 按 id 查不到组就静默跳过，
  最终 `deny = []` —— **配了隐藏却什么也没隐藏**，且没有任何报错。
  `state()` 路由自己 `await` 清单，所以手动打开界面时一切正常，正好掩盖了问题。
- 读取失败原先也会推进时间戳，把一次瞬时错误放大成 15 秒静默失效；现在失败后立刻重试。
- 修复后若仍一条都隐藏不掉，会输出告警并指明原因，不再静默。

**安装**
```bash
# GitHub（任何机器）
dsh plugin --profile <your-profile> add github:Anicomig/dsh-workspace-gate#v0.1.3
```
装完仍需在插件页启用 bundle。

**上游**
本修复已向上游提交 PR：M1r0er/dsh-workspace-gate#3
