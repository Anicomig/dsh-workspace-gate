import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 保存后的提示必须反映「这次到底生效没有」。
 *
 * 触发路径：用户在一个目录里勾选了若干插件 → 把策略切成「全部启用」→ 点保存。
 * 落盘的是 `{mode:'all', hidden:[...]}`：清单保留，但一条都不生效。
 * 原来 `save()` 无条件提示「已保存，对新会话生效」，用户以为配好了。
 *
 * 这正是本插件反复栽的那个坑（配好了、没生效、还回成功），所以提示必须诚实地说明。
 */

import { saveFeedback } from '../lib/client-view.mjs';

test('保存后生效：提示已保存', () => {
  const fb = saveFeedback({ effective: 3, checked: true });
  assert.equal(fb.level, 'ok');
  assert.equal(fb.key, 'ok');
});

test('保存了但零生效（勾过东西）：必须警告，不能报成功', () => {
  const fb = saveFeedback({ effective: 0, checked: true });
  assert.equal(fb.level, 'warn');
  assert.equal(fb.key, 'savedButInactive');
});

test('本就没勾任何东西：零生效是正常的，不警告', () => {
  const fb = saveFeedback({ effective: 0, checked: false });
  assert.equal(fb.level, 'ok');
  assert.equal(fb.key, 'ok');
});

test('切换策略时本就没传 hidden：不算「勾了但没生效」', () => {
  const fb = saveFeedback({ effective: 0, checked: false });
  assert.equal(fb.level, 'ok');
});

test('effective 缺失（旧服务端）：退回普通成功提示，不误报', () => {
  const fb = saveFeedback({ effective: undefined, checked: true });
  assert.equal(fb.level, 'ok');
  assert.equal(fb.key, 'ok');
});
