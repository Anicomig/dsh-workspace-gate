/**
 * 客户端策略判定的纯逻辑。
 *
 * ⚠️ **这个模块当前没有被 `client.js` 引用。** 它是同一套判定的一份**副本**，
 * 存在的唯一目的是让 `tests/client-view.test.mjs` 能锁住语义（client.js 整体依赖
 * `window.__ModuleLoader__` 与 React，在 node 里根本加载不了）。
 *
 * 这意味着两件事，读到这里的人必须知道：
 *
 * 1. **测试全绿不等于 client.js 的判定是对的。** 那些用例证明的是「这份副本自洽」，
 *    证明不了浏览器里真正跑的那几十行。改动 client.js 的 mode / locked / inherited
 *    推导时，仍需要人工对照本文件，或者把判定搬到服务端来彻底消除双实现。
 * 2. **两边必须手工同步。** client.js 里对应位置有同一条提示注释；改一处务必改两处。
 *
 * 彻底消除双实现的方向：`state()` 已经给出 `mode` / `effective` / `source`，
 * 再补一个 `locked` 就够客户端只做渲染，那时本文件与其测试都可以删掉。
 */

/** 全局面板的伪目录键。真实目录键都经过 normalizeDir（小写、正斜杠），不会与它撞。 */
export const GLOBAL_DIR = '__global__';

export const GLOBAL_OPTIONS = [
  { value: 'all' },
  { value: 'custom' },
];

export const WORKSPACE_OPTIONS = [
  { value: 'follow' },
  { value: 'all' },
  { value: 'custom' },
];

/**
 * 由 snapshot 与当前面板算出界面状态。
 *
 * @param snapshot `state()` 的返回值（可能残缺，这里全部按可选处理）
 * @param dir 当前面板：真实目录键或 `__global__`
 * @returns {{
 *   isGlobal: boolean,
 *   mode: 'follow'|'all'|'custom',
 *   locked: boolean,
 *   options: { value: string }[],
 *   inherited: number,
 *   savedHidden: string[],
 * }}
 */
export function clientPolicyView(snapshot, dir, activeDir) {
  const isGlobal = dir === GLOBAL_DIR;
  const global = snapshot?.global ?? { mode: 'all', hidden: [] };
  const entry = snapshot?.workspaces?.[dir];

  const mode = isGlobal ? global.mode ?? 'all' : entry?.mode ?? 'follow';
  const savedHidden = isGlobal ? [...(global.hidden ?? [])] : [...(entry?.hidden ?? [])];

  // 继承条数取服务端算好的 effective，不要用 global.hidden.length：
  // 子目录挂在 custom 父目录下时实际生效的是父目录那份清单，读全局条数会报错数字。
  const effectiveCount = isGlobal
    ? (global.hidden ?? []).length
    : (activeDir?.effective ?? 0);
  // 只有「跟随全局」才谈继承；自定义模式给个数字会让人以为自己的清单被覆盖了
  const inherited = !isGlobal && mode === 'follow' ? effectiveCount : 0;

  return {
    isGlobal,
    mode,
    // 非自定义时勾选置灰：数据保留，只是不能改
    locked: mode !== 'custom',
    options: isGlobal ? GLOBAL_OPTIONS : WORKSPACE_OPTIONS,
    inherited,
    // 'workspace' 表示继承自父工作区，'global' 表示继承自全局，'none' 表示没继承
    inheritedFrom: !isGlobal && activeDir ? activeDir.source ?? 'none' : 'none',
    savedHidden,
  };
}
