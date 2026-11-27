import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 客户端策略判定的纯逻辑测试。
 *
 * `client.js` 整体依赖 `window.__ModuleLoader__` 和 React，没法在 node 里直接加载。
 * 但它里面那几个「策略 → 界面状态」的判定是纯函数，抽到 lib 层之后可以单测，
 * 这样 UI 的关键分支就不会只靠手测。
 */

import { clientPolicyView } from '../lib/client-view.mjs';

const GLOBAL = '__global__';

test('clientPolicyView：全局面板没有 follow 选项', () => {
  const view = clientPolicyView({ global: { mode: 'all', hidden: [] } }, GLOBAL);
  assert.deepEqual(view.options.map((o) => o.value), ['all', 'custom']);
  assert.equal(view.mode, 'all');
  assert.equal(view.locked, true);
});

test('clientPolicyView：工作区有三态选项，默认 follow', () => {
  const view = clientPolicyView({ workspaces: {} }, 'd:/a');
  assert.deepEqual(view.options.map((o) => o.value), ['follow', 'all', 'custom']);
  assert.equal(view.mode, 'follow');
  assert.equal(view.locked, true, 'follow 时勾选应置灰');
});

test('clientPolicyView：mode=custom 时才解锁', () => {
  const view = clientPolicyView({ workspaces: { 'd:/a': { mode: 'custom', hidden: ['tool:x'] } } }, 'd:/a');
  assert.equal(view.mode, 'custom');
  assert.equal(view.locked, false);
});

test('clientPolicyView：follow 且全局有 hidden 时给出继承条数', () => {
  const view = clientPolicyView(
    { global: { mode: 'custom', hidden: ['plugin:a', 'plugin:b'] }, workspaces: { 'd:/a': { mode: 'follow' } } },
    'd:/a',
  );
  assert.equal(view.inherited, 2);
});

test('clientPolicyView：自定义模式不给继承提示（避免误导）', () => {
  const view = clientPolicyView(
    { global: { mode: 'custom', hidden: ['plugin:a'] }, workspaces: { 'd:/a': { mode: 'custom', hidden: [] } } },
    'd:/a',
  );
  assert.equal(view.inherited, 0);
});

test('clientPolicyView：savedHidden 读全局面板时取 global.hidden', () => {
  const view = clientPolicyView({ global: { mode: 'custom', hidden: ['plugin:g'] }, workspaces: {} }, GLOBAL);
  assert.deepEqual(view.savedHidden, ['plugin:g']);
});

test('clientPolicyView：savedHidden 读工作区时取该目录 hidden', () => {
  const view = clientPolicyView({ workspaces: { 'd:/a': { mode: 'custom', hidden: ['tool:y'] } } }, 'd:/a');
  assert.deepEqual(view.savedHidden, ['tool:y']);
});

test('clientPolicyView：没有配置的目录 savedHidden 为空数组', () => {
  const view = clientPolicyView({ workspaces: {} }, 'd:/nope');
  assert.deepEqual(view.savedHidden, []);
});
