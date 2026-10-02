/**
 * verify-selection-drag-scroll — 全屏下按住鼠标拖选到转录视口边缘时，视图必须
 * 持续跟随滚动（原生终端语义：拖到屏幕边缘自动滚动，选区沿文本增长）。
 *
 * 现场报告：拖选复制超过一屏的内容时，指针拖到屏幕底部后视图不动，只能选中
 * 当前可见的那一屏。根因不是选区模型——转录的 follow 机制
 * （captureScrolledRows + shiftSelectionForFollow）早就就位，缺的是「指针停在
 * 边缘时驱动 ScrollBox 滚动」的驱动器：handleSelectionDrag 过去只更新选区终点。
 *
 * 本脚本在真实 Chat + xterm-headless 上驱动：60 轮长转录（初始贴底），
 *   A. PgUp 让出下方空间 → 从顶部按下、拖到屏幕底边并按住：scrollTop 必须
 *      持续增长，直到贴底；松手后必须停止（不再滚动）。
 *   B. 从底部按下、拖到顶边并按住：scrollTop 必须持续减小。
 *   C. 拖选全程留在视口内部：scrollTop 必须不动（不误触发）。
 *
 * Run: node --import tsx/esm scripts/verify-selection-drag-scroll.tsx
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

import './lib/default-lang-zh.mjs'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { ApprovalStore }, { settle, settled, sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('./lib/term-test.mjs'),
])
const { default: instances } = await import('../src/ink/instances.js')

const COLS = 80
const ROWS = 24

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

/** 60 轮对话：转录远超一屏，内容可滚动。 */
function makeChannel() {
  const rows: unknown[] = []
  for (let i = 0; i < 60; i++) {
    rows.push({ id: i * 2, kind: 'user', text: `第 ${i} 轮：请检查模块 ${i}，这里补一些文字凑行数。` })
    rows.push({ id: i * 2 + 1, kind: 'assistant', text: `回复 ${i}：分析结果与建议。`.repeat(6), time: 1_700_000_000_000 + i * 2000 })
  }
  return {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'drag-scroll-probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    tokens: { input: 1, output: 1 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() {},
    turnStart: 0,
    lastUserText: '第 59 轮',
    pending: [],
    commandList: [],
    notifications: [],
    subscribe: () => () => {},
    submit: () => {},
    cancel: () => {},
    clear: () => {},
    notify: () => {},
    listModels: () => Promise.resolve([]),
    commandCompletions: () => [],
    pushLocal: () => {},
    settingsHost: () => undefined,
    settingsSections: () => [],
    subscribeSettingsSections: () => () => {},
    runExternalCommand: () => Promise.resolve(undefined),
    listSessions: () => [],
    setResumeTarget: () => {},
    loadOlder: () => {},
  } as never
}

type ScrollNode = {
  scrollTop?: number
  scrollHeight?: number
  scrollViewportHeight?: number
  scrollViewportTop?: number
  childNodes?: ScrollNode[]
}

/** 转录 ScrollBox：滚动内容最高的那个 overflow 节点。 */
function transcriptNode(root: ScrollNode): ScrollNode | undefined {
  let best: ScrollNode | undefined
  const walk = (node: ScrollNode): void => {
    if ((node.scrollHeight ?? 0) > (node.scrollViewportHeight ?? 0)
      && (best === undefined || (node.scrollHeight ?? 0) > (best.scrollHeight ?? 0))) {
      best = node
    }
    for (const child of node.childNodes ?? []) walk(child)
  }
  walk(root)
  return best
}

const CHAT = React.createElement(Chat, {
  channel: makeChannel(),
  questionStore: new QuestionStore(),
  approvalStore: new ApprovalStore(),
  fullscreen: true,
})

type Rig = {
  node: ScrollNode
  stdin: FakeStdin
  press: (col: number, row: number) => void
  drag: (col: number, row: number) => void
  release: (col: number, row: number) => void
  /** True while the mouse drag is live — guards the "no scroll" assertions
   *  from passing vacuously on an inert rig. */
  selectionDragging: () => boolean
  unmount: () => Promise<void>
}

async function mount(): Promise<Rig> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { term.write(String(chunk), cb) }
  }
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const instance = await render(
    React.createElement(AlternateScreen, null, CHAT),
    { stdout: stdout as never, stdin: stdin as never, stderr: new FakeStderr() as never, exitOnCtrlC: false, patchConsole: false },
  )
  const ink = instances.get(stdout as never) ?? instances.values().next().value
  // AlternateScreen resolves the instance through process.stdout; alias the
  // key BEFORE a later mount can grab a stale entry, and activate explicitly
  // so this rig's alt-screen/selection state is live regardless of how many
  // earlier rigs are still in the map.
  if (ink) {
    instances.set(process.stdout, ink)
    ink.setAltScreenActive(true, true)
  }
  await settle(() => transcriptNode(ink?.rootNode as ScrollNode) !== undefined, { timeoutMs: 8000 })
  const node = transcriptNode(ink?.rootNode as ScrollNode)!
  return {
    node,
    stdin,
    press: (col, row) => stdin.write(`\x1b[<0;${col + 1};${row + 1}M`),
    drag: (col, row) => stdin.write(`\x1b[<32;${col + 1};${row + 1}M`),
    release: (col, row) => stdin.write(`\x1b[<0;${col + 1};${row + 1}m`),
    selectionDragging: () => (ink as { selection?: { isDragging?: boolean } })?.selection?.isDragging === true,
    unmount: async () => {
      await instance.unmount()
      instances.delete(stdout as never)
      if (ink) instances.delete(process.stdout)
    },
  }
}

const scrollTop = (rig: Rig): number => rig.node.scrollTop ?? 0
const maxScroll = (rig: Rig): number => Math.max(0, (rig.node.scrollHeight ?? 0) - (rig.node.scrollViewportHeight ?? 0))
/** 转录视口的屏幕行范围（PgUp 出现 pinned header 后会发生移动）。 */
const viewportBottom = (rig: Rig): number =>
  (rig.node.scrollViewportTop ?? 0) + Math.max(1, rig.node.scrollViewportHeight ?? 1) - 1

// ── A. 拖到底边：持续滚动，松手即停 ────────────────────────────────────
{
  const rig = await mount()
  // 初始贴底：PgUp 让出下方空间，拖选才有可滚的余量。
  rig.stdin.write('\x1b[5~')
  const roomAbove = await settled(() => scrollTop(rig) < maxScroll(rig) - 5, { timeoutMs: 4000 })
  check('A 前置：PgUp 后视口离开底部', roomAbove, `top=${scrollTop(rig)} max=${maxScroll(rig)}`)
  const before = scrollTop(rig)
  // 从转录顶部按下（第 2 行），拖到屏幕最后一行并按住。
  rig.press(4, 2)
  await sleep(60)
  rig.drag(4, ROWS - 1)
  await settle(() => rig.selectionDragging(), { timeoutMs: 2000 })
  check('A 拖选手势已建立', rig.selectionDragging())
  const scrolled = await settled(() => scrollTop(rig) > before, { timeoutMs: 3000 })
  check('A 拖到底边：视图跟随滚动', scrolled, `${before} -> ${scrollTop(rig)}`)
  const reachedBottom = await settled(() => scrollTop(rig) >= maxScroll(rig), { timeoutMs: 4000 })
  check('A 持续滚动直到贴底', reachedBottom, `top=${scrollTop(rig)} max=${maxScroll(rig)}`)
  // 松手：驱动器必须在释放后停止。
  rig.release(4, ROWS - 1)
  await sleep(150)
  const settledTop = scrollTop(rig)
  // 固定窗:探针 松手后断言“不再滚动”的不变量，无单一可轮询完成条件。
  await sleep(400)
  check('A 松手后停止滚动', scrollTop(rig) === settledTop, `${settledTop} -> ${scrollTop(rig)}`)
  await rig.unmount()
}

// ── B. 拖到顶边：反向持续滚动 ──────────────────────────────────────────
{
  const rig = await mount()
  // 贴底起步，向上拖选需要先离开底部；把指针放在顶边即向上滚。
  rig.stdin.write('\x1b[5~')
  await settled(() => scrollTop(rig) < maxScroll(rig) - 20, { timeoutMs: 4000 })
  const before = scrollTop(rig)
  // 必须按在转录视口内部（PgUp 后 pinned header 会让出顶部、composer 占底部）。
  rig.press(4, Math.max(1, viewportBottom(rig) - 2))
  await sleep(60)
  rig.drag(4, 0)
  await settle(() => rig.selectionDragging(), { timeoutMs: 2000 })
  check('B 拖选手势已建立', rig.selectionDragging())
  const scrolledUp = await settled(() => scrollTop(rig) < before, { timeoutMs: 3000 })
  check('B 拖到顶边：视图向上滚动', scrolledUp, `${before} -> ${scrollTop(rig)}`)
  rig.release(4, 0)
  await rig.unmount()
}

// ── C. 视口内部拖选：不得误触发滚动 ────────────────────────────────────
{
  const rig = await mount()
  rig.stdin.write('\x1b[5~')
  await settled(() => scrollTop(rig) < maxScroll(rig) - 20, { timeoutMs: 4000 })
  const before = scrollTop(rig)
  rig.press(4, 4)
  await sleep(60)
  rig.drag(10, 8)
  await settle(() => rig.selectionDragging(), { timeoutMs: 2000 })
  check('C 拖选手势已建立（内部拖选）', rig.selectionDragging())
  // 固定窗:探针 断言“内部拖选不滚动”的不变量。
  await sleep(500)
  check('C 视口内部拖选不滚动', scrollTop(rig) === before, `${before} -> ${scrollTop(rig)}`)
  rig.release(10, 8)
  await rig.unmount()
}

if (failures > 0) {
  console.error(`\nverify-selection-drag-scroll: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nverify-selection-drag-scroll: all checks passed')
process.exit(0)
