import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 「生效数」的界面化计算必须与服务端 resolvePolicy 一致。
 *
 * 背景：`state()` 给出的 `dir.effective` 已经是按三态解析过的**真实生效条数**，
 * 客户端不该再按 mode 二次归零——`follow` 模式下它没有拿到全局条数，
 * 归零会让「跟随全局 · 已关 0 组」与实际生效的条数对不上，
 * 并且把「继承自全局：已关 N 组」这条提示一并压制掉。
 *
 * 这组测试覆盖 lib/client-view.mjs（client.js 的判定副本）。
 */

import { clientPolicyView, displayCounts } from '../lib/client-view.mjs';

const GLOBAL = '__global__';

const mk = (overrides = {}) => ({
  global: { mode: 'custom', hidden: ['plugin:g1', 'plugin:g2'] },
  workspaces: {},
  groups: new Array(10).fill({}),
  ...overrides,
});

test('follow + 全局 custom：生效数必须是全局条数，不能归零', () => {
  const dir = { key: 'd:/f', mode: 'follow', hidden: [], effective: 2, source: 'global' };
  const view = clientPolicyView(mk({ workspaces: { 'd:/f': dir } }), 'd:/f', dir);
  assert.equal(view.effectiveCount, 2, 'follow 时必须报真实生效数');
  assert.equal(view.inherited, 2, '继承提示也要保留');
});

test('follow + 全局 all：生效数为 0', () => {
  const snapshot = mk({ global: { mode: 'all', hidden: [] } });
  const dir = { key: 'd:/f', mode: 'follow', hidden: [], effective: 0, source: 'none' };
  const view = clientPolicyView(snapshot, 'd:/f', dir);
  assert.equal(view.effectiveCount, 0);
});

test('工作区 all：生效数为 0（即使清单还留着）', () => {
  const dir = { key: 'd:/a', mode: 'all', hidden: ['plugin:x'], effective: 0, source: 'workspace' };
  const view = clientPolicyView(mk({ workspaces: { 'd:/a': dir } }), 'd:/a');
  assert.equal(view.effectiveCount, 0);
});

test('工作区 custom：生效数等于清单长度', () => {
  const dir = { key: 'd:/c', mode: 'custom', hidden: ['plugin:x', 'tool:t'], effective: 2, source: 'workspace' };
  const view = clientPolicyView(mk({ workspaces: { 'd:/c': dir } }), 'd:/c', dir);
  assert.equal(view.effectiveCount, 2);
});

test('全局面板 custom：生效数等于 global.hidden 长度', () => {
  const view = clientPolicyView(mk(), GLOBAL);
  assert.equal(view.effectiveCount, 2);
});

test('全局面板 all：生效数为 0', () => {
  const view = clientPolicyView(mk({ global: { mode: 'all', hidden: ['plugin:g1'] } }), GLOBAL);
  assert.equal(view.effectiveCount, 0);
});

test('displayCounts：组口径只数 plugin: 条目，与「共 N 组」同单位', () => {
  // 19 条清单里只有 1 条 plugin:，显示「已关 19 组 · 共 29 组」是错的
  const hidden = ['plugin:mnemon', ...new Array(18).fill('tool:x')];
  const counts = displayCounts({ hidden, mode: 'custom', totalGroups: 29 });
  assert.equal(counts.off, 1, '「已关 N 组」只能数 plugin: 条目');
  assert.equal(counts.total, 29);
});

test('displayCounts：mode 不是 custom 时 off 为 0', () => {
  const counts = displayCounts({ hidden: ['plugin:a', 'plugin:b'], mode: 'all', totalGroups: 10 });
  assert.equal(counts.off, 0);
});

test('displayCounts：follow 时按继承来源算 plugin: 条数', () => {
  const counts = displayCounts({
    hidden: [],
    mode: 'follow',
    inheritedHidden: ['plugin:g1', 'plugin:g2', 'tool:t'],
    totalGroups: 10,
  });
  assert.equal(counts.off, 2);
});
