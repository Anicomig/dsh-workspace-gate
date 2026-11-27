/**
 * 客户端策略判定的纯逻辑。
 *
 * 从 `client.js` 里抽出来的原因：client.js 整体依赖 `window.__ModuleLoader__` 与 React，
 * 没法在 node 里加载，于是「策略 → 界面状态」这几个分支只能靠手测。
 * 抽成纯函数后它们就有单测了；client.js 仍然保留同样的判定，两边必须一致。
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
