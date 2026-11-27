# 工作区门控策略（mode）设计

日期：2026-11-27
状态：待批准

## 意图与为什么

现在每个工作区只有一种表达：`overrides[dir]` 里放了要隐藏的清单。这带来两个问题：

1. **「没配置」和「配了但一个都不隐藏」在磁盘上无法区分**——`withHidden` 遇到空数组会 `delete` 掉整个键（`lib/policy.mjs:265`），所以「全部启用」这个状态根本存不下来。
2. **没有全局默认**。新目录一律放行，用户想让「默认就关掉某批插件」只能逐个目录重复配置。

要引入的是**三态策略**：一个工作区要么跟随全局、要么全部启用、要么用自己那份清单。
切走自定义时**保留**已配清单，只是不生效——这样用户来回切换不会丢工作。

## 目标

- 全局配置与每个工作区各有一个 `mode` 字段
- 全局：`all`（全部启用）| `custom`（自定义）；全局段缺失 = `all`
- 工作区：`follow`（跟随全局）| `all`（全部启用）| `custom`（自定义）
- 执行优先级：工作区 `custom` > 工作区 `all` > 跟随全局（全局再分 `custom`/`all`）
- 切走 `custom` 不清空 `hidden`，UI 把勾选控件置灰

## 非目标

- 不做配置导入导出
- 不做多套配置模板
- 不改 `assignments`（工具→分组的手工归属）语义
- 不做跨 profile 同步

## 反目标（即使能跑也算失败）

- 旧 `workspace-gate.json` 读进来丢配置
- 切换策略时静默清空用户的 `hidden`
- 新增字段被 `normalizeStore` 白名单丢弃

## 存储结构

```json
{
  "version": 2,
  "global": { "mode": "custom", "hidden": ["plugin:mnemon"] },
  "workspaces": {
    "c:/users/anicomig/workspace": { "mode": "custom", "hidden": ["plugin:soul-md"] },
    "f:/users/anicomig/documents/projectfordp": { "mode": "all" }
  },
  "assignments": { "tool:read": "DSH 文件读写与检索" }
}
```

### 字段语义（逐条对应你的要求）

| 场景 | 磁盘形态 | 生效结果 |
|---|---|---|
| 文件不存在（刚装插件） | 无文件 | 全局 = `all`，一切放行 |
| 文件存在但没有 `global` 字段 | 无 `global` | 全局 = `all` |
| 全局设了自定义内容 | `global: { mode:"custom", hidden:[...] }` | 按 `hidden` 隐藏 |
| 全局有 `hidden` 但 `mode` 是 `all` | `global: { mode:"all", hidden:[...] }` | **按 all 执行，`hidden` 保留不动** |

最后一条是关键：`mode` 是唯一决定行为的字段，`hidden` 只是数据。这样「切到全部启用」和「删掉配置」彻底分开。

### 工作区条目

| `mode` | `hidden` | 生效结果 |
|---|---|---|
| 缺省 / `follow` | 任意（保留） | 套用全局策略 |
| `all` | 任意（保留） | 本工作区不隐藏任何东西 |
| `custom` | 数组（可为空） | 按该数组隐藏 |

## 执行优先级

```
1. cwd 在 workspaces 里做最长祖先前缀匹配
2. 命中且 mode === 'custom'  → 用它的 hidden
3. 命中且 mode === 'all'     → 隐藏 0 项
4. 命中且 mode === 'follow' 或未命中 → 看全局
     全局 mode === 'custom'  → 用 global.hidden
     否则（缺省/all）        → 隐藏 0 项
```

**父子目录**：取最深匹配（与现有 `pickDir` 语义一致）。父目录 `custom`、子目录显式 `all` 时，子目录生效——子目录的显式选择优先，不能让父目录压过去。

## 兼容（v1 → v2）

`normalizeStore` 本来就是读取时的规整入口，在那里做一次性转换：

- 读到 v1 的 `overrides[dir] = [specs]` → 转成 `workspaces[dir] = { mode: "custom", hidden: specs }`
- 读到 v1 的 `assignments` → 原样保留
- 没有 `global` → 不写 `global`（等价 `all`）

**不写独立迁移脚本。** 旧文件读进来在内存里转好，下次任意保存操作自然落盘成 v2。

## 要改的地方

### `lib/policy.mjs`

1. `STORE_VERSION` 1 → 2
2. `emptyStore()` → `{ version: 2, workspaces: {}, assignments: {} }`（**不写 `global`**，缺失即 all）
3. `normalizeStore()` → 解析 `global`（校验 `mode` ∈ {all, custom}，`hidden` 只收非空数组）、解析 `workspaces`（校验 `mode` ∈ {follow, all, custom}），并兼容读 v1 `overrides`
4. `withHidden` / `withAssignments` → 透传 `global` 和 `workspaces`（否则任何一次保存都会抹掉新字段）
5. 新增纯函数 `resolvePolicy(store, cwd)` → 返回 `{ source: 'workspace'|'global'|'none', mode, hidden }`，供 `bind()` 与 `state()` 共用
6. 新增 `withMode(store, dir, mode)`、`withGlobal(store, { mode, hidden })`

### `index.js`

1. `bind()`（:598-612）改用 `resolvePolicy()`，删掉 `if (!key) return` 的早退
2. `state()`（:755-759）→ 遍历 `workspaces` 而非 `overrides`；返回值加 `global`、每个 dir 加 `mode`
3. 新增 `POST /mode`（`{ dir, mode }`）、`POST /global`（`{ mode, hidden }`）
4. `workspace_gate` 工具加 `action=mode` / `action=global`

### `client.js`

1. `dirChips` 最前面插一个【全局配置】chip（`dir === '__global__'` 或独立 state）
2. chip 行与插件列表之间插策略行：三个单选（全局时两个）
3. `mode !== 'custom'` 时，所有 `Switch` 传 `disabled: true`（现有 `Switch` 已支持 `disabled`）
4. 策略行下方加只读灰字：跟随全局时显示「继承自全局：已关 N 组」
5. `save()` 改成同时提交 `mode` 与 `hidden`（走 `/apply` 扩展或新路由）

## 已定决策

| 项 | 决定 | 谁定的 |
|---|---|---|
| 字段结构 | `global` + `workspaces`，`overrides` 废弃并迁移 | 用户（选 A） |
| 跟随全局时可见性 | 显示只读的「继承自全局：已关 N 组」 | 用户确认 |
| 全局初始形态 | 不写 `global` 字段 = all | 用户 |
| mode 为 all 时 hidden 去留 | 保留不删 | 用户 |
| 父子目录冲突 | 取最深匹配 | 我方（按现有 pickDir 语义） |
| 是否写迁移脚本 | 不写，在 normalizeStore 内转换 | 我方 |

## 留给实现者

- 策略行的具体控件样式（复用现有 `S.ghost` / `S.input` 风格）
- 「全局配置」chip 是否加图标或角标
- `resolvePolicy` 的返回值形状可以微调，只要 `bind()` 和 `state()` 共用
- 单测覆盖优先级矩阵即可，不需要覆盖 UI
