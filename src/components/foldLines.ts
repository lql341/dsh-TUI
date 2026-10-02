/**
 * 长正文折叠的纯函数面（issue #1212）。
 *
 * 全屏模式下根帧高度写死为终端行数（AlternateScreen），alt-screen 没有
 * scrollback：审批条的命令/理由、问卷的问题正文/detail 都是模型给的弹性
 * 正文，一旦超过帧高，就会把决策行（问题、两个选项、提示）整段挤出屏幕——
 * 用户看不到自己在批准什么，也看不到「允许/拒绝」，盲按 Enter 即放行。
 *
 * 规则：决策行优先，弹性正文折成「前导行 + 一行计数标记」。折行用渲染器
 * 同一条依赖（wrap-ansi，trim:false / hard:true），保证每行显示宽度都 ≤
 * 宽度上限，渲染器不会再折出预算之外的行。
 */

import wrapAnsi from 'wrap-ansi'

/**
 * `text` 按 `width` 显示列硬折行后的显示行。
 *
 * 设置必须与 `ink/wrap-text.ts` 的 `wrap` 分支一致（trim:false、hard:true，
 * wordWrap 默认开），否则预折行的结果与渲染器再折一次的结果会差一行。
 *
 * @param text - 原始文本（可含换行）。
 * @param width - 内容显示宽度（列）。
 * @returns 每个元素显示宽度 ≤ width 的行数组（至少一行）。
 */
export function wrapText(text: string, width: number): string[] {
  return wrapAnsi(text, Math.max(1, width), { hard: true, trim: false }).split('\n')
}

/** 折叠结果：渲染的前导行、是否渲染标记行、标记行之后隐藏的行数。 */
export type FoldedLines = {
  readonly shown: readonly string[]
  /** 被标记行取代的正文行数（0 → 未折叠）。 */
  readonly folded: number
  /** 是否需要渲染「… 共 N 行」标记行。 */
  readonly marker: boolean
}

/**
 * 把 `lines` 折进 `budget` 个渲染行。
 *
 * - 装得下：原样返回，无标记。
 * - 预算 ≥ 2：前 `budget - 1` 行 + 一行计数标记。
 * - 预算 1：只渲染标记行——正文全折，但用户仍知道「下面还有内容」。
 * - 预算 ≤ 0：什么都不渲染。决策行已占满空间，一行空标记只会再把它们挤出去。
 *
 * @param lines - 已按显示列折好的正文行。
 * @param budget - 正文可用的渲染行数（含标记行）。
 */
export function foldLines(lines: readonly string[], budget: number): FoldedLines {
  if (lines.length <= Math.max(budget, 0)) return { shown: lines, folded: 0, marker: false }
  if (budget <= 0) return { shown: [], folded: lines.length, marker: false }
  if (budget === 1) return { shown: [], folded: lines.length, marker: true }
  const shown = lines.slice(0, budget - 1)
  return { shown, folded: lines.length - shown.length, marker: true }
}

/** 折叠块实际占用的渲染行数（标记行计入预算）。 */
export function foldedRows(view: FoldedLines): number {
  return view.shown.length + (view.marker ? 1 : 0)
}
