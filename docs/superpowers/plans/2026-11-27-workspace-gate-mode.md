# 工作区门控策略（mode）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给全局配置和每个工作区各加一个三态策略字段，让「跟随全局 / 全部启用 / 自定义」成为显式状态，且切走自定义时保留已配清单。

**Architecture:** 存储从 `overrides` 改为 `global` + `workspaces`（v1 在 `normalizeStore` 内一次性迁移，不写独立脚本）。`mode` 是唯一决定行为的字段，`hidden` 只是数据。纯函数 `resolvePolicy(store, cwd)` 统一回答「这个目录该隐藏什么」，`bind()` 与 `state()` 共用它。

**Tech Stack:** Node.js ESM、`node:test`、Cordis 插件（host + client 双端）、原生 HTTP 路由。

**Spec:** `docs/superpowers/specs/2026-11-27-workspace-gate-mode-design.md`

## Global Constraints

- `STORE_VERSION` 必须从 `1` 改为 `2`
- 全局 `mode` 合法值：`'all'` | `'custom'`；工作区 `mode` 合法值：`'follow'` | `'all'` | `'custom'`
- `emptyStore()` 返回 `{ version: 2, workspaces: {}, assignments: {} }` —— **不含 `global` 字段**（缺失即 `all`）
- `mode` 不是 `'custom'` 时，`hidden` 必须原样保留，不得删除
- 非法 `mode` 值一律退回默认（全局 `all`、工作区 `follow`），不抛异常
- 所有新增/修改的纯函数放在 `lib/policy.mjs`，不得引入 `node:fs` 或时钟
- 测试命令：`npm test`（已配置为 `node --test "tests/*.test.mjs"`）
- 语法检查：`npm run check`

## Review Focus

1. **v1 旧文件读入**（`{version:1, overrides:{...}}`）：必须迁移成 `workspaces[dir].mode='custom'`，一条 hidden 都不能丢。
2. **工作区 `mode='all'` 但 `hidden` 有值**：执行时不隐藏任何东西，但切回 `custom` 后那份清单必须还在。
3. **`mode='custom'` 且 `hidden=[]`**：必须与「跟随全局」区分开——前者是显式空清单，后者套用全局。
4. **父子目录**：父 `custom`、子 `all` 时子目录生效（取最深匹配），父目录不能压过子目录的显式选择。
5. **没有 `global` 字段的文件**：一切放行，且 `state()` 必须返回 `{mode:'all', hidden:[]}` 而不是 `undefined`，否则 client 读 `.hidden` 会崩。

---

### Task 1: 存储结构与 v1 迁移

**Files:**
- Modify: `lib/policy.mjs:13`（`STORE_VERSION`）、`lib/policy.mjs:216-251`（`emptyStore`、`normalizeStore`）
- Test: `tests/policy.test.mjs`

**Interfaces:**
- Produces:
  - `STORE_VERSION = 2`
  - `emptyStore() => { version: 2, workspaces: {}, assignments: {} }`
  - `normalizeStore(raw) => { version: 2, global?: { mode: 'all'|'custom', hidden: string[] }, workspaces: Record<string, { mode: 'follow'|'all'|'custom', hidden: string[] }>, assignments: Record<string,string> }`

- [ ] **Step 1: 写失败的测试**

在 `tests/policy.test.mjs` 末尾追加：

```js
test('normalizeStore：v1 overrides 迁移为 workspaces[dir].mode=custom', () => {
  const store = normalizeStore({
    version: 1,
    overrides: { 'D:\\Projects': ['tool:b', 'tool:a'] },
    assignments: { 'tool:read': 'fs' },
  });
  assert.equal(store.version, 2);
  assert.deepEqual(store.workspaces['d:/projects'], { mode: 'custom', hidden: ['tool:a', 'tool:b'] });
  assert.deepEqual(store.assignments, { 'tool:read': 'fs' });
  assert.equal(store.overrides, undefined, 'overrides 不应残留');
});

test('normalizeStore：没有 global 字段时不写 global（缺失即 all）', () => {
  const store = normalizeStore({ version: 2, workspaces: {}, assignments: {} });
  assert.equal(store.global, undefined);
});

test('normalizeStore：global.mode 非法值退回 all，hidden 仍保留', () => {
  const store = normalizeStore({ global: { mode: 'nonsense', hidden: ['plugin:x'] } });
  assert.deepEqual(store.global, { mode: 'all', hidden: ['plugin:x'] });
});

test('normalizeStore：工作区 mode 非法值退回 follow', () => {
  const store = normalizeStore({ workspaces: { 'D:\\A': { mode: 'bogus', hidden: ['tool:x'] } } });
  assert.deepEqual(store.workspaces['d:/a'], { mode: 'follow', hidden: ['tool:x'] });
});

test('normalizeStore：mode=custom 且 hidden 为空数组时条目必须保留', () => {
  const store = normalizeStore({ workspaces: { 'D:\\A': { mode: 'custom', hidden: [] } } });
  assert.deepEqual(store.workspaces['d:/a'], { mode: 'custom', hidden: [] });
});

test('normalizeStore：global 坏数据丢弃但不影响 workspaces', () => {
  const store = normalizeStore({ global: 'nope', workspaces: { 'D:\\A': { mode: 'all' } } });
  assert.equal(store.global, undefined);
  assert.deepEqual(store.workspaces['d:/a'], { mode: 'all', hidden: [] });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/policy.test.mjs`
Expected: FAIL —— `store.workspaces` 为 `undefined`（旧实现只产出 `overrides`）

- [ ] **Step 3: 改 `lib/policy.mjs`**

`STORE_VERSION` 改为 `2`。

`emptyStore()` 改为：

```js
export function emptyStore() {
  return { version: STORE_VERSION, workspaces: {}, assignments: {} };
}
```

在模块顶层新增（`STORE_VERSION` 附近，供 Task 3 的 `resolvePolicy` 共用）：

```js
export const GLOBAL_MODES = new Set(['all', 'custom']);
export const WORKSPACE_MODES = new Set(['follow', 'all', 'custom']);
const specList = (value) => [...new Set((value ?? []).map((v) => String(v ?? '').trim()).filter(Boolean))].sort();
```

`normalizeStore` 解析顺序：先 `global`，再 `workspaces`，再**兼容读 v1 `overrides`**，最后 `assignments`。

- `global`：不是对象就跳过；`mode` 不在 `GLOBAL_MODES` 里退回 `'all'`；`hidden` 用 `specList`。**只要 `raw.global` 是合法对象就写出 `out.global`**（即使 mode 是 all 也写，因为用户显式设过）。
- `workspaces`：键过 `normalizeDir`；`mode` 不在 `WORKSPACE_MODES` 里退回 `'follow'`；`hidden` 用 `specList`。**条目一律保留**（即使 hidden 为空）。
- v1 `overrides`：仅当 `raw.workspaces` 不存在时处理，每条转成 `{ mode: 'custom', hidden: specList(value) }`；空数组也保留条目。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/policy.test.mjs`
Expected: PASS（含原有的 normalizeStore 用例）

**原有 7 处 `.overrides` 断言必须同步改写**（`tests/policy.test.mjs` 第 170、175、178、181、184、189、227 行），否则旧断言会失败。改写规则：

- `store.overrides` 里 `['tool:a','tool:b']` 这样的数组 → 变成 `store.workspaces['d:/projects'] = { mode: 'custom', hidden: ['tool:a','tool:b'] }`
- 断言「空」的（第 181、189 行）→ `deepEqual(store.workspaces, {})`（`normalizeStore` 对空数组仍不建条目）
- 第 227 行 `withOne.overrides` → `withOne.workspaces`，值同样包成 `{ mode: 'custom', hidden: [...] }`

- [ ] **Step 5: 提交**

```bash
git add lib/policy.mjs tests/policy.test.mjs
git commit -m "feat(policy): 存储改为 global + workspaces，v1 overrides 就地迁移"
```

---

### Task 2: 写入函数（withWorkspace / withGlobal）

**Files:**
- Modify: `lib/policy.mjs:253-288`（`withHidden`、`withAssignments`）
- Test: `tests/policy.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `emptyStore` / `normalizeStore`
- Produces:
  - `withWorkspace(store, dir, patch) => store`，`patch = { mode?: 'follow'|'all'|'custom', hidden?: string[] }`；只合并传了的字段
  - `withGlobal(store, patch) => store`，`patch = { mode?: 'all'|'custom', hidden?: string[] }`；`patch` 为空对象时删除 `global`
  - `withHidden(store, dir, specs) => store`，等价于 `withWorkspace(store, dir, { mode: 'custom', hidden: specs })`
  - `withAssignments(store, entries) => store`，必须透传 `global` 与 `workspaces`

- [ ] **Step 1: 写失败的测试**

```js
test('withWorkspace：只改 mode 时保留 hidden', () => {
  const base = normalizeStore({ workspaces: { 'D:\\A': { mode: 'custom', hidden: ['tool:x'] } } });
  const next = withWorkspace(base, 'D:\\A', { mode: 'all' });
  assert.deepEqual(next.workspaces['d:/a'], { mode: 'all', hidden: ['tool:x'] });
});

test('withWorkspace：只改 hidden 时保留 mode', () => {
  const base = normalizeStore({ workspaces: { 'D:\\A': { mode: 'follow', hidden: [] } } });
  const next = withWorkspace(base, 'D:\\A', { hidden: ['tool:y'] });
  assert.deepEqual(next.workspaces['d:/a'], { mode: 'follow', hidden: ['tool:y'] });
});

test('withWorkspace：新建条目默认 follow', () => {
  const next = withWorkspace(emptyStore(), 'D:\\New', {});
  assert.deepEqual(next.workspaces['d:/new'], { mode: 'follow', hidden: [] });
});

test('withGlobal：设置与删除', () => {
  const withCustom = withGlobal(emptyStore(), { mode: 'custom', hidden: ['plugin:a'] });
  assert.deepEqual(withCustom.global, { mode: 'custom', hidden: ['plugin:a'] });
  const cleared = withGlobal(withCustom, {});
  assert.equal(cleared.global, undefined);
});

test('withAssignments：透传 global 与 workspaces', () => {
  const base = withGlobal(normalizeStore({ workspaces: { 'D:\\A': { mode: 'all', hidden: [] } } }), { mode: 'custom', hidden: ['tool:x'] });
  const next = withAssignments(base, [{ spec: 'tool:read', group: 'fs' }]);
  assert.deepEqual(next.global, base.global);
  assert.deepEqual(next.workspaces, base.workspaces);
  assert.deepEqual(next.assignments, { 'tool:read': 'fs' });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/policy.test.mjs`
Expected: FAIL —— `withWorkspace is not a function`

- [ ] **Step 3: 实现**

三个函数都从 `normalizeStore(store)` 拿基线，返回新对象（不修改入参）。`withWorkspace` 的 `hidden` 用 `specList` 规整；`patch` 里没有的键不动。`withGlobal` 在 `patch` 既无 `mode` 也无 `hidden` 时 `delete next.global`。

`withHidden` 保留导出，实现改为调用 `withWorkspace(store, dir, { mode: 'custom', hidden: specs })`。

`withAssignments` 的返回对象加上 `...(base.global ? { global: { ...base.global } } : {})` 与 `workspaces: { ...base.workspaces }`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/policy.test.mjs`
Expected: PASS。原有 `withHidden` 三个用例（第 173-185 行）断言的是 `store.overrides`，需同步改成 `store.workspaces`。**语义有一处变化**：`withHidden(second, 'D:\Projects', [])` 现在**保留** `{ mode: 'custom', hidden: [] }` 而不是删除条目——这正是「切走自定义不清空配置」的基础。第 181 行断言改为：

```js
assert.deepEqual(third.workspaces['d:/projects'], { mode: 'custom', hidden: [] });
```

- [ ] **Step 5: 提交**

```bash
git add lib/policy.mjs tests/policy.test.mjs
git commit -m "feat(policy): 新增 withWorkspace / withGlobal，withHidden 改为写 workspaces"
```

---

### Task 3: resolvePolicy 优先级解析

**Files:**
- Modify: `lib/policy.mjs`（新增导出，放在 `pickDir` 之后）
- Test: `tests/policy.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 store 形状、现有 `pickDir`
- Produces: `resolvePolicy(store, cwd) => { source: 'workspace'|'global'|'none', mode: 'follow'|'all'|'custom', hidden: string[], key: string }`
  - `source='workspace'` 时 `key` 是命中的目录键
  - `source='global'` 或 `'none'` 时 `key` 为 `''`
  - **`hidden` 永远是数组**（`all`/`none` 时为空数组）

- [ ] **Step 1: 写失败的测试（优先级矩阵）**

```js
const wsStore = (global, workspaces) => normalizeStore(global ? { global, workspaces } : { workspaces });

test('resolvePolicy：未配置任何东西 → none，不隐藏', () => {
  assert.deepEqual(resolvePolicy(emptyStore(), 'D:\\Any'), { source: 'none', mode: 'all', hidden: [], key: '' });
});

test('resolvePolicy：工作区 custom 优先于全局 custom', () => {
  const store = wsStore({ mode: 'custom', hidden: ['plugin:g'] }, { 'D:\\A': { mode: 'custom', hidden: ['plugin:w'] } });
  const r = resolvePolicy(store, 'D:\\A\\sub');
  assert.equal(r.source, 'workspace');
  assert.deepEqual(r.hidden, ['plugin:w']);
});

test('resolvePolicy：工作区 all 覆盖全局 custom', () => {
  const store = wsStore({ mode: 'custom', hidden: ['plugin:g'] }, { 'D:\\A': { mode: 'all', hidden: ['plugin:old'] } });
  assert.deepEqual(resolvePolicy(store, 'D:\\A').hidden, []);
  assert.equal(resolvePolicy(store, 'D:\\A').source, 'workspace');
});

test('resolvePolicy：工作区 follow 时套用全局', () => {
  const store = wsStore({ mode: 'custom', hidden: ['plugin:g'] }, { 'D:\\A': { mode: 'follow', hidden: ['plugin:stale'] } });
  const r = resolvePolicy(store, 'D:\\A');
  assert.equal(r.source, 'global');
  assert.deepEqual(r.hidden, ['plugin:g']);
});

test('resolvePolicy：父子目录取最深匹配，子目录 all 压过父目录 custom', () => {
  const store = wsStore(undefined, {
    'D:\\Proj': { mode: 'custom', hidden: ['plugin:p'] },
    'D:\\Proj\\api': { mode: 'all', hidden: [] },
  });
  assert.deepEqual(resolvePolicy(store, 'D:\\Proj\\api\\src').hidden, []);
  assert.deepEqual(resolvePolicy(store, 'D:\\Proj\\web').hidden, ['plugin:p']);
});

test('resolvePolicy：mode=custom 且 hidden 为空 → source=workspace，不回落全局', () => {
  const store = wsStore({ mode: 'custom', hidden: ['plugin:g'] }, { 'D:\\A': { mode: 'custom', hidden: [] } });
  const r = resolvePolicy(store, 'D:\\A');
  assert.equal(r.source, 'workspace');
  assert.deepEqual(r.hidden, []);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/policy.test.mjs`
Expected: FAIL —— `resolvePolicy is not a function`

- [ ] **Step 3: 实现**

```js
export function resolvePolicy(store, cwd) {
  const workspaces = store?.workspaces ?? {};
  const key = pickDir(cwd, Object.keys(workspaces));
  if (key) {
    const entry = workspaces[key] ?? {};
    const mode = WORKSPACE_MODES.has(entry.mode) ? entry.mode : 'follow';
    if (mode === 'custom') return { source: 'workspace', mode, hidden: [...(entry.hidden ?? [])], key };
    if (mode === 'all') return { source: 'workspace', mode, hidden: [], key };
  }
  const g = store?.global;
  if (g && g.mode === 'custom') return { source: 'global', mode: 'custom', hidden: [...(g.hidden ?? [])], key: '' };
  return { source: 'none', mode: 'all', hidden: [], key: '' };
}
```

把 Task 1 里的 `WORKSPACE_MODES` 提到模块顶层（已在 Task 1 完成，此处直接引用即可，不要重复声明）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test tests/policy.test.mjs`
Expected: PASS（6 个新用例 + 原有全部）

- [ ] **Step 5: 提交**

```bash
git add lib/policy.mjs tests/policy.test.mjs
git commit -m "feat(policy): 新增 resolvePolicy，按 工作区custom > 工作区all > 全局 解析"
```

---

### Task 4: bind() 改用 resolvePolicy

**Files:**
- Modify: `index.js:592-632`（`bind` 函数开头到 `deny`/`sections` 计算）
- Test: `tests/gate-bind.test.mjs`

**Interfaces:**
- Consumes: Task 3 的 `resolvePolicy`
- Produces: 无新导出；`bind()` 行为改为按策略解析

- [ ] **Step 1: 写失败的测试**

在 `tests/gate-bind.test.mjs` 追加（复用现有 `makeCtx` / `makeAgent` 辅助）：

```js
test('bind：全局 custom 时，未单独配置的目录也按全局隐藏', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gate-'));
  process.env.DSH_PROFILE_DIR = root;
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(
    join(root, 'data', 'workspace-gate.json'),
    JSON.stringify({ version: 2, global: { mode: 'custom', hidden: ['plugin:soul-md'] }, workspaces: {}, assignments: {} }),
    'utf8',
  );
  const { apply } = await import('../index.js');
  const harness = makeCtx({ delayMs: 5 });
  apply(harness.ctx);
  const restricted = [];
  await harness.emit('agent/created', { agent: makeAgent('a1', 'D:\\Other', restricted) });
  assert.deepEqual(restricted, ['soul_md_status']);
});

test('bind：工作区 all 覆盖全局 custom', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gate-'));
  process.env.DSH_PROFILE_DIR = root;
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(
    join(root, 'data', 'workspace-gate.json'),
    JSON.stringify({
      version: 2,
      global: { mode: 'custom', hidden: ['plugin:soul-md'] },
      workspaces: { 'd:\\open': { mode: 'all', hidden: ['plugin:soul-md'] } },
      assignments: {},
    }),
    'utf8',
  );
  const { apply } = await import('../index.js');
  const harness = makeCtx({ delayMs: 5 });
  apply(harness.ctx);
  const restricted = [];
  await harness.emit('agent/created', { agent: makeAgent('a1', 'D:\\Open', restricted) });
  assert.deepEqual(restricted, [], 'mode=all 时不应隐藏任何东西');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/gate-bind.test.mjs`
Expected: FAIL —— 两条都拿到空数组（旧 `bind()` 只读 `store.overrides`，`workspaces` 里没有东西）

- [ ] **Step 3: 实现**

`bind()` 开头替换为：

```js
const policy = resolvePolicy(store, agentCwd(ctx, agent));
const cwd = agentCwd(ctx, agent);
if (!policy.hidden.length) return;   // 没有任何要隐藏的：不建计划，省掉 inventory
```

注意：`agentCwd` 只调一次，赋给 `cwd` 后再传给 `resolvePolicy`。删掉原来的 `const key = pickDir(...)` 与 `if (!key) return`。

后续 `const hidden = resolveHidden(policy.hidden, plan);` 取代 `resolveHidden(store.overrides[key] ?? [], plan)`；`bound.set(...)` 里的 `key` 用 `policy.key`；「一条都没命中」告警里的 `specs` 用 `policy.hidden`。

`import` 行加上 `resolvePolicy`。

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS（新 2 条 + 原有 28 条）

- [ ] **Step 5: 提交**

```bash
git add index.js tests/gate-bind.test.mjs
git commit -m "feat: bind() 按 resolvePolicy 决定隐藏清单，支持全局默认策略"
```

---

### Task 5: state() 返回 global / workspaces / mode

**Files:**
- Modify: `index.js:733-800`（`state` 函数）
- Test: `tests/gate-bind.test.mjs`（通过 HTTP 路由间接验证，或用新增的纯函数断言）

**Interfaces:**
- Produces: `state()` 返回值新增 `global: { mode, hidden }`；`dirs[]` 每项新增 `mode` 与 `hidden`（`hidden` 恒为数组）

- [ ] **Step 1: 写失败的测试**

在 `tests/gate-bind.test.mjs` 追加：

```js
test('state：没有 global 时返回 {mode:"all",hidden:[]}', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gate-'));
  process.env.DSH_PROFILE_DIR = root;
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'workspace-gate.json'), JSON.stringify({ version: 2, workspaces: {}, assignments: {} }), 'utf8');
  const { apply } = await import('../index.js');
  const harness = makeCtx({ delayMs: 5 });
  const api = apply(harness.ctx);
  const snapshot = await api.state();
  assert.deepEqual(snapshot.global, { mode: 'all', hidden: [] });
  assert.deepEqual(snapshot.workspaces, {});
});
```

> 注意：`apply()` 当前**不返回任何值**（`index.js` 末尾是 `void refreshPlugins(true);` 后直接 `}`）。Step 3 要在末尾补 `return { state };`——测试需要这个出口。Cordis 不读取 `apply` 的返回值，所以对生产行为无影响。

- [ ] **Step 2: 运行确认失败**

Run: `node --test tests/gate-bind.test.mjs`
Expected: FAIL —— `api.state` 不是函数，或 `snapshot.global` 为 `undefined`

- [ ] **Step 3: 实现**

`state()` 里把遍历 `store.overrides` 改为遍历 `store.workspaces`，写入 `entry.mode` 与 `entry.hidden`；遍历结束后给所有没有 `mode` 的目录补 `'follow'`、没有 `hidden` 的补 `[]`。

返回值里 `overrides: store.overrides` 换成：

```js
global: { mode: store.global?.mode ?? 'all', hidden: store.global?.hidden ?? [] },
workspaces: store.workspaces,
```

`apply()` 末尾加 `return { state };`（保持原有 `void refreshPlugins(true)` 不变）。

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add index.js tests/gate-bind.test.mjs
git commit -m "feat: state() 返回 global 与每个工作区的 mode/hidden"
```

---

### Task 6: HTTP 路由与工具动作

**Files:**
- Modify: `index.js:800-830`（`handle` 里的 `/apply`）、新增 `/mode` 与 `/global`；`index.js:880-940`（`workspace_gate` 工具）
- Test: 手动验证（无自动化路由测试）

**Interfaces:**
- Consumes: Task 2 的 `withWorkspace` / `withGlobal`
- Produces:
  - `POST /apply` 接受 `{ dir, mode?, hidden? }`
  - `POST /mode` 接受 `{ dir, mode }`
  - `POST /global` 接受 `{ mode?, hidden? }`（空对象 = 删除全局配置）
  - 工具新增 `action: 'mode'`（`dir` + `mode`）与 `action: 'global'`（`mode` + `hide`/`show`）

- [ ] **Step 1: 改 `/apply`**

```js
if (tail === 'apply') {
  const body = JSON.parse((await readBody(req)) || '{}');
  const dir = String(body?.dir ?? '').trim();
  if (!dir) return json(res, 400, { error: 'dir 不能为空' });
  const patch = {};
  if (typeof body?.mode === 'string') patch.mode = body.mode;
  if (Array.isArray(body?.hidden)) patch.hidden = body.hidden;
  store = withWorkspace(store, dir, patch);
  saveStore(store);
  return json(res, 200, { ok: true, ...(await state(false)) });
}
```

- [ ] **Step 2: 新增 `/mode` 与 `/global`**

放在 `/apply` 之后。`/mode` 只接受 `follow|all|custom`，非法值返回 400。`/global` 在 `mode` 与 `hidden` 都没传时表示删除全局段。

- [ ] **Step 3: 工具动作**

`enum` 加 `'mode'`、`'global'`；`properties` 加 `mode`（string）与 `hide`/`show` 已存在可复用给全局 hidden。实现里 `action === 'mode'` 调 `withWorkspace`，`action === 'global'` 调 `withGlobal`。

- [ ] **Step 4: 验证**

Run: `npm run check`
Expected: 无语法错误

手动验证（在最终装进 profile 后做）：切换 mode 后 `GET /workspace-gate/state` 里对应条目的 `mode` 变化，且 `hidden` 未被清空。

- [ ] **Step 5: 提交**

```bash
git add index.js
git commit -m "feat: 新增 /mode 与 /global 路由，/apply 支持 mode"
```

---

### Task 7: 设置页 UI

**Files:**
- Modify: `client.js:22-71`（`zh` 文案）、`client.js:446-487`（dirChips）、`client.js:932-982`（策略行插入位置）、`client.js:582-600`（`groupRow` 的开关 disabled）、`client.js:397-408`（`save`）
- Test: `node --check client.js` + 浏览器手测

**Interfaces:**
- Consumes: Task 5 的 `snapshot.global` / `dir.mode` / `dir.hidden`
- Produces: 无导出变化

- [ ] **Step 1: 加文案**

`zh` 与 `en` 各加：`globalConfig`（全局配置 / Global）、`policy`（策略 / Policy）、`modeFollow`（跟随全局 / Follow global）、`modeAll`（全部启用 / All enabled）、`modeCustom`（自定义 / Custom）、`inherited`（继承自全局：已关 N 组 / Inherited from global: N groups off）、`modeHint`（切换策略不会清空已保存的勾选 / Switching policy keeps your saved selections）

- [ ] **Step 2: 全局 chip**

`dirChips` 数组前插一个：`label = t('globalConfig')`，`selected = dir === '__global__'`，`onClick: () => setDir('__global__')`。

`useEffect`（`client.js:307`）改为：`dir === '__global__'` 时 `setHidden(snapshot.global?.hidden ?? [])`，否则读 `snapshot.workspaces?.[dir]?.hidden ?? []`。

初始选中逻辑（`client.js:300-305`）保持选第一个真实目录，不要默认选中全局。

- [ ] **Step 3: 策略行**

在 chips 行与 `listhead` 之间插入一个三选一控件行。`dir === '__global__'` 时只渲染「全部启用 / 自定义」两个。

当前 mode 取值：全局 `snapshot.global?.mode ?? 'all'`；工作区 `snapshot.workspaces?.[dir]?.mode ?? 'follow'`。

点击即调 `post('/mode', { dir, mode })`（全局用 `post('/global', { mode })`），成功后 `setSnapshot(data)`。

- [ ] **Step 4: 置灰**

`mode !== 'custom'` 时，所有 `Switch` 与 `nameRow` 的勾选传 `disabled: true`。`Switch` 已支持 `disabled`（`client.js:221`）。

策略行下方加只读灰字：工作区 mode 为 `follow` 且全局 `hidden` 非空时，显示 `t('inherited', 全局隐藏的组数)`。

- [ ] **Step 5: 保存逻辑**

`save()` 改为 `post('/apply', { dir, mode, hidden })`；`mode !== 'custom'` 时只发 `{ dir, mode }`，不带 `hidden`（保护已存清单）。

- [ ] **Step 6: 验证**

Run: `npm run check`
Expected: 无语法错误

浏览器手测（装进 profile 后）：① 切到全部启用，勾选变灰；② 切回自定义，原来的勾选还在；③ 点全局配置，只有两个选项；④ 工作区选跟随全局时显示继承提示。

- [ ] **Step 7: 提交**

```bash
git add client.js
git commit -m "feat(ui): 新增全局配置入口与三态策略选择，非自定义时置灰"
```

---

### Task 8: 文档

**Files:**
- Modify: `README.md`、`README.en.md`
- Test: 无

- [ ] **Step 1: 补一节说明**

在 README 里加「策略（mode）」小节：解释全局 `all/custom` 与工作区 `follow/all/custom`、执行优先级、以及「切换策略不清空已保存的勾选」。

- [ ] **Step 2: 提交**

```bash
git add README.md README.en.md
git commit -m "docs: 说明工作区策略（mode）的三种状态与优先级"
```

---

## 收尾

全部任务完成后：

1. `npm run check && npm test` 必须全绿
2. 用 `git log --oneline main..HEAD` 核对提交粒度
3. 整体 diff 复核：确认没有把 `overrides` 残留写回磁盘
4. 装进 `web` profile 做一次真实手测（`dsh plugin --profile web add link:<worktree>` 或复制），验证优先级矩阵在真实会话里成立
