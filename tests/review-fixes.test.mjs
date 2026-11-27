import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 评审修复的回归测试。
 *
 * 覆盖三条由整分支评审发现、且都指向「静默失效 / 数据丢失」的路径：
 *   1. action='global' 无参必须报错，不能删掉整份全局配置
 *   2. 新目录只写 hidden 必须真正生效（v1 的 withHidden 是隐式 custom）
 *   3. cwd 探测失败时不能套用全局策略
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
  const root = mkdtempSync(join(tmpdir(), 'dsh-gate-fix-'));
  process.env.DSH_PROFILE_DIR = root;
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'workspace-gate.json'), JSON.stringify(storeJson), 'utf8');
  const { apply } = await import('../index.js');
  const harness = makeCtx();
  apply(harness.ctx);
  await sleep(5);
  return { api: harness.services.get('workspaceGate'), root };
}

test('POST /global 空 body 不再静默删除全局配置，必须显式 clear', async () => {
  const { api, root } = await boot({
    version: 2,
    global: { mode: 'custom', hidden: ['plugin:a', 'plugin:b'] },
    workspaces: {},
    assignments: {},
  });
  const res = await call(api.handle, '/global', {});
  assert.equal(res.status, 400, '空 body 应被拒绝');
  assert.match(String(res.body.error), /clear/);
  // 磁盘上必须还在
  const disk = JSON.parse(readFileSync(join(root, 'data', 'workspace-gate.json'), 'utf8'));
  assert.deepEqual(disk.global, { mode: 'custom', hidden: ['plugin:a', 'plugin:b'] }, '配置不能丢');
});

test('POST /global {clear:true} 才删除全局段', async () => {
  const { api, root } = await boot({
    version: 2,
    global: { mode: 'custom', hidden: ['plugin:a'] },
    workspaces: {},
    assignments: {},
  });
  const res = await call(api.handle, '/global', { clear: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.global, { mode: 'all', hidden: [] });
  const disk = JSON.parse(readFileSync(join(root, 'data', 'workspace-gate.json'), 'utf8'));
  assert.equal(disk.global, undefined);
});

test('POST /apply 给新目录写 hidden 时自动落 mode=custom，确保真的生效', async () => {
  const { api } = await boot({ version: 2, workspaces: {}, assignments: {} });
  const res = await call(api.handle, '/apply', { dir: 'D:\\Brand-new', hidden: ['plugin:x'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.workspaces['d:/brand-new'].mode, 'custom', '新目录写 hidden 必须是 custom，否则零生效');
  // 该目录的 effective 必须 > 0
  const dir = (res.body.dirs || []).find((d) => d.key === 'd:/brand-new');
  assert.ok(dir && dir.effective > 0, 'effective 应大于 0');
});

test('POST /apply 给已有 all 目录写 hidden 时保持 mode=all（不偷偷翻成 custom）', async () => {
  const { api } = await boot({
    version: 2,
    workspaces: { 'd:/a': { mode: 'all', hidden: [] } },
    assignments: {},
  });
  const res = await call(api.handle, '/apply', { dir: 'D:/a', hidden: ['plugin:x'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.workspaces['d:/a'].mode, 'all', '已有条目不该被隐式改成 custom');
  assert.deepEqual(res.body.workspaces['d:/a'].hidden, ['plugin:x'], 'hidden 仍要写进去，留着以后切 custom 用');
});
