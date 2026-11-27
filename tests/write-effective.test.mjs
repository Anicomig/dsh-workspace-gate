import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 「写进去的东西是否真的生效」必须当场可见。
 *
 * 背景：`mode` 是唯一决定行为的字段，`hidden` 只是数据。给一个 `mode='all'` 的目录写清单，
 * 会得到 `ok:true` 但零生效——这正是本插件最危险的失败形态（配好了、没生效、还回成功）。
 * 让写接口一并返回 `effective`，调用方不必再查一次 state() 就能发现。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCtx() {
  const services = new Map();
  const handlers = new Map();
  return {
    ctx: {
      provide(n, v) { services.set(n, v); },
      get(n) {
        if (services.has(n)) return services.get(n);
        if (n === 'pluginManager') return { async listPlugins() { return []; }, async listBundles() { return []; } };
        if (n === 'tools') return { schemas: () => [] };
        if (n === 'agentPresets') return { list: async () => [], acquireScope: async () => ({}) };
        return undefined;
      },
      logger: { warn: () => {} },
      tools: { register: () => () => {} },
      on(e, h) { const l = handlers.get(e) ?? []; l.push(h); handlers.set(e, l); },
      effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
      inject() {},
    },
    services,
  };
}

function call(handle, path, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method: body === undefined ? 'GET' : 'POST',
      url: `/workspace-gate${path}`,
      on(e, cb) { if (e === 'data' && payload) cb(Buffer.from(payload)); if (e === 'end') cb(); return req; },
    };
    const chunks = [];
    const res = {
      writeHead(c) { res.statusCode = c; return res; },
      end(t) { chunks.push(t); resolve({ status: res.statusCode, body: JSON.parse(chunks.join('') || '{}') }); },
    };
    handle(req, res).catch((e) => resolve({ status: 500, body: { error: String(e) } }));
  });
}

async function boot(storeJson) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gate-eff-'));
  process.env.DSH_PROFILE_DIR = root;
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'workspace-gate.json'), JSON.stringify(storeJson), 'utf8');
  const { apply } = await import('../index.js');
  const harness = makeCtx();
  apply(harness.ctx);
  await sleep(5);
  return harness.services.get('workspaceGate');
}

test('POST /apply 返回该目录的 effective', async () => {
  const api = await boot({ version: 2, workspaces: {}, assignments: {} });
  const res = await call(api.handle, '/apply', { dir: 'D:\\A', hidden: ['plugin:x'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.effective, 1, '新目录写 hidden 后 effective 应为 1');
});

test('POST /apply 对 mode=all 的目录写 hidden：effective 必须是 0（未生效）', async () => {
  const api = await boot({
    version: 2,
    workspaces: { 'd:/a': { mode: 'all', hidden: [] } },
    assignments: {},
  });
  const res = await call(api.handle, '/apply', { dir: 'D:/A', hidden: ['plugin:x'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.effective, 0, '数据写进去了但 mode=all，实际零生效');
  assert.deepEqual(res.body.workspaces['d:/a'].hidden, ['plugin:x'], 'hidden 仍要保留');
});

test('POST /mode 返回该目录的 effective', async () => {
  const api = await boot({
    version: 2,
    workspaces: { 'd:/a': { mode: 'all', hidden: ['plugin:x'] } },
    assignments: {},
  });
  const res = await call(api.handle, '/mode', { dir: 'D:/A', mode: 'custom' });
  assert.equal(res.status, 200);
  assert.equal(res.body.effective, 1, '切成 custom 后那 1 条立即生效');
});

test('POST /global 返回全局的 effective', async () => {
  const api = await boot({ version: 2, workspaces: {}, assignments: {} });
  const res = await call(api.handle, '/global', { mode: 'custom', hidden: ['plugin:g', 'tool:t'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.effective, 2);
});
