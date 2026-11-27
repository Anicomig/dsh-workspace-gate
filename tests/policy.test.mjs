import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAssignments,
  attribute,
  emptyStore,
  estimateChars,
  isAncestor,
  normalizeDir,
  normalizeStore,
  pickDir,
  resolvePolicy,
  resolveHidden,
  sectionOwner,
  tokensOf,
  withAssignments,
  withGlobal,
  withHidden,
  withWorkspace,
} from '../lib/policy.mjs';

test('normalizeDir 统一分隔符、去尾斜杠、转小写', () => {
  assert.equal(normalizeDir('D:\\Projects\\Api\\'), 'd:/projects/api');
  assert.equal(normalizeDir('d:/projects//api//'), 'd:/projects/api');
  assert.equal(normalizeDir('  C:\\  '), 'c:');
  assert.equal(normalizeDir(''), '');
  assert.equal(normalizeDir(null), '');
});

test('isAncestor 认自己、认真子目录、不认同前缀的兄弟目录', () => {
  assert.equal(isAncestor('D:\\Projects', 'D:\\Projects'), true);
  assert.equal(isAncestor('D:\\Projects', 'D:\\Projects\\api\\src'), true);
  assert.equal(isAncestor('D:\\Projects', 'D:\\ProjectsApi'), false);
  assert.equal(isAncestor('D:\\Other', 'D:\\Projects\\api'), false);
});

test('pickDir 取命中最深的祖先', () => {
  const keys = ['D:\\', 'D:\\Projects', 'D:\\Projects\\api', 'C:\\Work'];
  assert.equal(pickDir('D:\\Projects\\api\\src\\index.ts', keys), 'd:/projects/api');
  assert.equal(pickDir('D:\\Projects\\web', keys), 'd:/projects');
  assert.equal(pickDir('D:\\Music', keys), 'd:');
  assert.equal(pickDir('E:\\Somewhere', keys), '');
  assert.equal(pickDir('', keys), '');
});

test('tokensOf 去 scoped 前缀与 dsh- 前缀', () => {
  assert.deepEqual(tokensOf('@deepseek-ai/dsh-tool-bash'), ['tool', 'bash']);
  assert.deepEqual(tokensOf('r18_novel_info'), ['r18', 'novel', 'info']);
  assert.deepEqual(tokensOf('prompt-toggle:main'), ['prompt', 'toggle', 'main']);
  assert.deepEqual(tokensOf('include:dsh-free-search'), ['free', 'search']);
  assert.deepEqual(tokensOf(''), []);
});

test('sectionOwner 取冒号前的命名空间', () => {
  assert.equal(sectionOwner('r18-novel:protocol'), 'r18-novel');
  assert.equal(sectionOwner('prompt-toggle:main'), 'prompt-toggle');
  assert.equal(sectionOwner('deployment:persona-prefix'), 'deployment');
  assert.equal(sectionOwner('noseparator'), '');
});

test('attribute：段按命名空间归属，工具按前导 token 归属，认不出的进未归属', () => {
  const plan = attribute({
    tools: ['r18_novel_info', 'r18_novel_next', 'prompt_toggle_status', 'read', 'write'],
    sections: ['r18-novel:protocol', 'prompt-toggle:main'],
    plugins: [{ id: 'r18-novel' }, { id: 'prompt-toggle' }, { id: 'ui-chat' }],
  });

  const byId = new Map(plan.groups.map((g) => [g.id, g]));
  assert.deepEqual(byId.get('r18-novel').tools, ['r18_novel_info', 'r18_novel_next']);
  assert.deepEqual(byId.get('r18-novel').sections, ['r18-novel:protocol']);
  assert.deepEqual(byId.get('prompt-toggle').tools, ['prompt_toggle_status']);
  assert.deepEqual(byId.get('prompt-toggle').sections, ['prompt-toggle:main']);

  // 没有任何工具或段落在可见面上的插件不出现
  assert.equal(byId.has('ui-chat'), false);

  assert.deepEqual(plan.unassigned.tools, ['read', 'write']);
});

test('attribute：别名参与匹配（patchId 与包名不一致时）', () => {
  const plan = attribute({
    tools: ['free_search_test', 'platform_search'],
    sections: ['free-search:engines'],
    plugins: [{ id: 'web-search-free', aliases: ['dsh-free-search'] }],
  });
  const byId = new Map(plan.groups.map((g) => [g.id, g]));
  assert.deepEqual([...byId.keys()], ['web-search-free']);
  assert.deepEqual(byId.get('web-search-free').tools, ['free_search_test']);
  // 段的命名空间 free-search 与别名 dsh-free-search 归一到同一 slug，也能归属
  assert.deepEqual(byId.get('web-search-free').sections, ['free-search:engines']);
  assert.deepEqual(plan.unassigned.tools, ['platform_search']);
});

test('attribute：段命名空间不是插件时进未归属，不伪造插件组', () => {
  const plan = attribute({
    tools: ['read'],
    sections: ['harness:identity', 'deployment:persona-prefix', 'tool:read', 'r18-novel:protocol'],
    plugins: [{ id: 'r18-novel' }],
  });
  const byId = new Map(plan.groups.map((g) => [g.id, g]));
  assert.deepEqual([...byId.keys()], ['r18-novel']);
  assert.deepEqual(byId.get('r18-novel').sections, ['r18-novel:protocol']);
  assert.deepEqual(plan.unassigned.sections, ['deployment:persona-prefix', 'harness:identity', 'tool:read']);
  assert.deepEqual(plan.unassigned.tools, ['read']);
});

test('attribute：只有段、没有工具的插件也会出现', () => {
  const plan = attribute({
    tools: [],
    sections: ['prompt-toggle:main'],
    plugins: [{ id: 'prompt-toggle' }],
  });
  assert.equal(plan.groups.length, 1);
  assert.deepEqual(plan.groups[0].sections, ['prompt-toggle:main']);
});

test('attribute：共享 token 更长的插件胜出', () => {
  const plan = attribute({
    tools: ['free_search_web', 'free_search_news'],
    sections: [],
    plugins: [{ id: 'dsh-free-search' }, { id: 'dsh-free-search-plus' }],
  });
  // 两个插件首 token 都是 free/search；-plus 多一个 token 但不匹配，仍归给前者
  const byId = new Map(plan.groups.map((g) => [g.id, g]));
  assert.deepEqual(byId.get('dsh-free-search').tools, ['free_search_news', 'free_search_web']);
});

test('resolveHidden：plugin: 展开成它的全部名字', () => {
  const plan = {
    groups: [{ id: 'r18-novel', tools: ['r18_novel_info'], sections: ['r18-novel:protocol'] }],
    unassigned: { tools: [] },
  };
  const hidden = resolveHidden(['plugin:r18-novel'], plan);
  assert.deepEqual(hidden.tools, ['r18_novel_info']);
  assert.deepEqual(hidden.sections, ['r18-novel:protocol']);
});

test('resolveHidden：单个名字精确生效，未知名字被忽略', () => {
  const plan = { groups: [], unassigned: { tools: [] } };
  const hidden = resolveHidden(
    ['tool:read', 'section:prompt-toggle:main', 'plugin:gone', 'tool:', 'nonsense'],
    plan,
  );
  assert.deepEqual(hidden.tools, ['read']);
  assert.deepEqual(hidden.sections, ['prompt-toggle:main']);
});

test('resolveHidden：结果去重且排序稳定', () => {
  const plan = { groups: [], unassigned: { tools: [] } };
  const hidden = resolveHidden(['tool:write', 'tool:read', 'tool:write'], plan);
  assert.deepEqual(hidden.tools, ['read', 'write']);
});

test('normalizeStore：坏文件退化为空存储，绝不抛', () => {
  assert.deepEqual(normalizeStore(null), emptyStore());
  assert.deepEqual(normalizeStore('nope'), emptyStore());
  assert.deepEqual(normalizeStore({ version: 1 }), emptyStore());
  assert.deepEqual(normalizeStore({ overrides: [] }), emptyStore());
});

test('normalizeStore：逐条清洗、去重、排序、归一化键', () => {
  const store = normalizeStore({
    version: 99,
    overrides: {
      'D:\\Projects\\Api': ['tool:b', 'tool:a', 'tool:a', '   '],
      '': ['tool:x'],
      'C:\\Work': [],
      'C:\\Bad': 'not-an-array',
    },
  });
  assert.equal(store.version, 2);
  // 空数组 → 保留条目；'C:\Bad'（非数组）与 ''（空键）两条被丢弃
  assert.deepEqual(store.workspaces, {
    'c:/work': { mode: 'custom', hidden: [] },
    'd:/projects/api': { mode: 'custom', hidden: ['tool:a', 'tool:b'] },
  });
});

test('withHidden：写入、覆盖、清空', () => {
  const first = withHidden(emptyStore(), 'D:\\Projects', ['tool:a']);
  assert.deepEqual(first.workspaces, { 'd:/projects': { mode: 'custom', hidden: ['tool:a'] } });

  const second = withHidden(first, 'd:/projects', ['tool:b', 'tool:a']);
  assert.deepEqual(second.workspaces, { 'd:/projects': { mode: 'custom', hidden: ['tool:a', 'tool:b'] } });

  // 空数组保留条目（mode=custom + hidden=[]）——这是「切走自定义不清空配置」的基础
  const third = withHidden(second, 'D:\\Projects', []);
  assert.deepEqual(third.workspaces['d:/projects'], { mode: 'custom', hidden: [] });

  // 不修改入参
  assert.deepEqual(second.workspaces, { 'd:/projects': { mode: 'custom', hidden: ['tool:a', 'tool:b'] } });
});

test('withHidden：空目录键不写入任何东西', () => {
  const store = withHidden(emptyStore(), '', ['tool:a']);
  assert.deepEqual(store.workspaces, {});
});

test('estimateChars 只数真正隐藏掉的东西', () => {
  const plan = {
    toolChars: new Map([['read', 400], ['write', 300]]),
    sectionText: new Map([['prompt-toggle:main', 4000]]),
  };
  const chars = estimateChars({ tools: ['read'], sections: ['prompt-toggle:main'] }, plan);
  assert.equal(chars, 4400);
  assert.equal(estimateChars({ tools: ['ghost'], sections: [] }, plan), 0);
});

test('normalizeStore：assignments 只收合法 spec，withHidden 不会把它弄丢', () => {
  const store = normalizeStore({
    overrides: { 'D:\\A': ['tool:x'] },
    assignments: {
      'tool:read': 'tool-fs',
      'section:foo:bar': 'foo',
      'bogus:thing': 'y',
      'tool:empty': '   ',
      'tool:write': 42,
    },
  });
  assert.deepEqual(store.assignments, {
    'tool:read': 'tool-fs',
    'section:foo:bar': 'foo',
    'tool:write': '42',
  });

  const next = withHidden(store, 'D:\\B', ['tool:y']);
  assert.deepEqual(next.assignments, store.assignments);
});

test('withAssignments：设置与撤销，且不动 workspaces', () => {
  const base = withHidden(emptyStore(), 'D:\\A', ['tool:x']);
  const withOne = withAssignments(base, [{ spec: 'tool:read', group: 'tool-fs' }]);
  assert.deepEqual(withOne.assignments, { 'tool:read': 'tool-fs' });
  assert.deepEqual(withOne.workspaces, { 'd:/a': { mode: 'custom', hidden: ['tool:x'] } });

  const cleared = withAssignments(withOne, [{ spec: 'tool:read', group: '' }]);
  assert.deepEqual(cleared.assignments, {});

  // 非法 spec 被忽略
  const bad = withAssignments(withOne, [{ spec: 'nonsense', group: 'x' }]);
  assert.deepEqual(bad.assignments, { 'tool:read': 'tool-fs' });
});

test('applyAssignments：把未归属的工具手工收进新分组', () => {
  const plan = {
    groups: [{ id: 'web-search-free', tools: ['free_search_test'], sections: [] }],
    unassigned: { tools: ['read', 'write'], sections: ['tool:read'] },
  };
  const moved = applyAssignments(plan, {
    'tool:read': 'tool-fs',
    'tool:write': 'tool-fs',
    'section:tool:read': 'tool-fs',
  });
  const byId = new Map(moved.groups.map((g) => [g.id, g]));
  assert.deepEqual(byId.get('web-search-free').tools, ['free_search_test']);
  assert.deepEqual(byId.get('tool-fs').tools, ['read', 'write']);
  assert.deepEqual(byId.get('tool-fs').sections, ['tool:read']);
  assert.deepEqual(moved.unassigned, { tools: [], sections: [] });
});

test('applyAssignments：也能把已在某组的名字挪到另一组', () => {
  const plan = {
    groups: [{ id: 'a', tools: ['x'], sections: [] }, { id: 'b', tools: [], sections: [] }],
    unassigned: { tools: [], sections: [] },
  };
  const moved = applyAssignments(plan, { 'tool:x': 'b' });
  const byId = new Map(moved.groups.map((g) => [g.id, g]));
  assert.deepEqual(byId.get('b').tools, ['x']);
  // a 被搬空后不再出现
  assert.equal(byId.has('a'), false);
  assert.deepEqual([...byId.keys()], ['b']);
});

test('applyAssignments：名字已不存在时不产生幽灵条目', () => {
  const plan = { groups: [], unassigned: { tools: [], sections: [] } };
  const moved = applyAssignments(plan, { 'tool:ghost': 'x' });
  assert.deepEqual(moved.groups, []);
  assert.deepEqual(moved.unassigned, { tools: [], sections: [] });
});

test('applyAssignments：没有 assignments 时原样返回', () => {
  const plan = { groups: [], unassigned: { tools: ['a'], sections: [] } };
  assert.equal(applyAssignments(plan, {}), plan);
  assert.equal(applyAssignments(plan, undefined), plan);
});

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

test('normalizeStore：hidden 类型错误只丢该字段，不抛异常', () => {
  // 回归测试：v1 有 Array.isArray 守卫，丢了会让 loadStore 落到 emptyStore 丢掉全部配置
  const store = normalizeStore({
    global: { mode: 'custom', hidden: 'oops' },
    workspaces: { 'D:\\A': { mode: 'custom', hidden: 42 } },
  });
  assert.deepEqual(store.global, { mode: 'custom', hidden: [] });
  assert.deepEqual(store.workspaces['d:/a'], { mode: 'custom', hidden: [] });
});


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

test('withWorkspace：非法 mode 被忽略，保持原值', () => {
  const base = normalizeStore({ workspaces: { 'D:\\A': { mode: 'all', hidden: [] } } });
  const next = withWorkspace(base, 'D:\\A', { mode: 'bogus' });
  assert.equal(next.workspaces['d:/a'].mode, 'all');
});

test('withGlobal：设置与删除', () => {
  const withCustom = withGlobal(emptyStore(), { mode: 'custom', hidden: ['plugin:a'] });
  assert.deepEqual(withCustom.global, { mode: 'custom', hidden: ['plugin:a'] });
  const cleared = withGlobal(withCustom, {});
  assert.equal(cleared.global, undefined);
});

test('withGlobal：只给 hidden 新建时默认 custom', () => {
  const next = withGlobal(emptyStore(), { hidden: ['plugin:a'] });
  assert.deepEqual(next.global, { mode: 'custom', hidden: ['plugin:a'] });
});

test('withAssignments：透传 global 与 workspaces', () => {
  const base = withGlobal(normalizeStore({ workspaces: { 'D:\\A': { mode: 'all', hidden: [] } } }), { mode: 'custom', hidden: ['tool:x'] });
  const next = withAssignments(base, [{ spec: 'tool:read', group: 'fs' }]);
  assert.deepEqual(next.global, base.global);
  assert.deepEqual(next.workspaces, base.workspaces);
  assert.deepEqual(next.assignments, { 'tool:read': 'fs' });
});


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
