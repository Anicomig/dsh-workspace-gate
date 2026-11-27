import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * HTTP 路由测试。
 *
 * 直接调 `apply()` 暴露出来的 `handle(req, res)`，用最小的假 req/res 收 JSON。
 * 这一层测的是「写路径的校验与落盘」，纯函数层（policy.mjs）已在 policy.test.mjs 覆盖。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeCtx() {
  const handlers = new Map();
  const services = new Map();
  return {
    ctx: {
      provide(name, value) {
        services.set(name, value);
      },
      get(name) {
        if (services.has(name)) return services.get(name);
        if (name === 'pluginManager') {
          return { async listPlugins() { return []; }, async listBundles() { return []; } };
        }
        if (name === 'tools') return { schemas: () => [] };
        if (name === 'agentPresets') return { list: async () => [], acquireScope: async () => ({}) };
        return undefined;
      },
      logger: { warn: () => {} },
      tools: { register: () => () => {} },
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      effect(fn) {
        const disposer = fn();
        return () => {
          if (typeof disposer === 'function') disposer();
        };
      },
      inject() {},
    },
    services,
  };
}

/** 调一次 handle，返回 { status, body }。 */
function call(handle, path, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method: body === undefined ? 'GET' : 'POST',
      url: `/workspace-gate${path}`,
      on(event, cb) {
        if (event === 'data' && payload) cb(Buffer.from(payload, 'utf8'));
        if (event === 'end') cb();
        return req;
      },
    };
    const chunks = [];
    const res = {
      writeHead(code) {
        res.statusCode = code;
        return res;
      },
      end(text) {
        chunks.push(text);
        resolve({ status: res.statusCode, body: JSON.parse(chunks.join('') || '{}') });
      },
    };
    handle(req, res).catch((error) => resolve({ status: 500, body: { error: String(error) } }));
  });
}

async function boot(storeJson) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gate-route-'));
  process.env.DSH_PROFILE_DIR = root;
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'workspace-gate.json'), JSON.stringify(storeJson), 'utf8');
  const { apply } = await import('../index.js');
  const harness = makeCtx();
  apply(harness.ctx);
  await sleep(5);
  return harness.services.get('workspaceGate');
}

test('POST /apply 拒绝非法 mode', async () => {
  const api = await boot({ version: 2, workspaces: {}, assignments: {} });
  const res = await call(api.handle, '/apply', { dir: 'D:\\A', mode: 'bogus' });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /mode 必须是/);
});

test('POST /apply 只传 mode 时保留已存 hidden', async () => {
  const api = await boot({
    version: 2,
    workspaces: { 'd:\\a': { mode: 'custom', hidden: ['plugin:x'] } },
    assignments: {},
  });
  const res = await call(api.handle, '/apply', { dir: 'D:\\A', mode: 'all' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.workspaces['d:/a'], { mode: 'all', hidden: ['plugin:x'] });
});

test('POST /mode 改 mode 不动 hidden', async () => {
  const api = await boot({
    version: 2,
    workspaces: { 'd:\\a': { mode: 'custom', hidden: ['plugin:x'] } },
    assignments: {},
  });
  const res = await call(api.handle, '/mode', { dir: 'D:\\A', mode: 'follow' });
  assert.equal(res.status, 200);
  assert.equal(res.body.workspaces['d:/a'].mode, 'follow');
  assert.deepEqual(res.body.workspaces['d:/a'].hidden, ['plugin:x']);
});

test('POST /mode 拒绝非法 mode', async () => {
  const api = await boot({ version: 2, workspaces: {}, assignments: {} });
  const res = await call(api.handle, '/mode', { dir: 'D:\\A', mode: 'nope' });
  assert.equal(res.status, 400);
});

test('POST /global 写全局 hidden，mode 默认 custom', async () => {
  const api = await boot({ version: 2, workspaces: {}, assignments: {} });
  const res = await call(api.handle, '/global', { hidden: ['plugin:g'] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.global, { mode: 'custom', hidden: ['plugin:g'] });
});

test('POST /global 空 body 删除全局段', async () => {
  const api = await boot({
    version: 2,
    global: { mode: 'custom', hidden: ['plugin:g'] },
    workspaces: {},
    assignments: {},
  });
  const res = await call(api.handle, '/global', {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.global, { mode: 'all', hidden: [] });
});

test('POST /global 拒绝非法 mode', async () => {
  const api = await boot({ version: 2, workspaces: {}, assignments: {} });
  const res = await call(api.handle, '/global', { mode: 'follow' });
  assert.equal(res.status, 400);
});
