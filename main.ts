import {
  App,
  Editor,
  EditorPosition,
  Plugin,
  PluginSettingTab,
  Setting,
  type SettingDefinitionItem,
} from 'obsidian';

/* ============================================================
 * PunctFlow — 标点流：中文 Markdown 智能标点转换
 * ------------------------------------------------------------
 * 在中文输入法下，把常用的中文标点自动转换为对应的英文
 * Markdown 标点（核心是 · → ` 反引号），减少中英文输入法
 * 切换成本。核心设计原则：智能、可控、不误伤。
 *
 * 主要能力：
 *  1. 可配置的标点映射表（设置面板中增删改）
 *  2. 上下文感知转换（代码块 / 行内代码 / 公式 / URL / frontmatter / 中文人名间隔号）
 *  3. 反引号自动配对（输入 · 自动插入一对 `，再输入一次跳过闭合，避免重复）
 *  4. 批量转换命令（转换选区 / 转换当前行 / 转换全文）
 *  5. 三种工作模式（实时 / 手动 / 粘贴转换）
 *  6. 排除规则（文件夹 / 扩展名）
 *  7. 撤销合并（每次输入只产生一个事务，一次 Ctrl+Z 即可撤销）
 * ============================================================ */

// -------------------- 类型与默认值 --------------------

interface PunctFlowMapping {
  /** 源字符（可多字符；实时模式只匹配单字符输入） */
  from: string;
  /** 目标字符串（可为空字符串，表示删除） */
  to: string;
}

type PunctFlowMode = 'realtime' | 'manual' | 'paste';

interface PunctFlowSettings {
  /** 映射表：按从上到下顺序匹配 */
  mappings: PunctFlowMapping[];
  /** 是否自动配对反引号 */
  autoPairBacktick: boolean;
  /** 工作模式：realtime 实时 / manual 手动 / paste 粘贴转换 */
  mode: PunctFlowMode;
  /** 排除的文件夹路径（多行，每行一个，相对仓库根目录） */
  excludedFolders: string;
  /** 排除的文件扩展名（多行，每行一个，不带点） */
  excludedExtensions: string;
}

const DEFAULT_SETTINGS: PunctFlowSettings = {
  mappings: [
    // 默认规则：中文间隔号 → 反引号（即原 dot-to-backtick 插件的能力）
    { from: '·', to: '`' },
    // 可在设置面板中继续添加，例如：
    // { from: '。', to: '. ' },  // 句号 → 英文句点 + 空格
    // { from: '，', to: ', ' },  // 逗号 → 英文逗号 + 空格
    // { from: '【', to: '[' },   // 左方括号
    // { from: '】', to: ']' },   // 右方括号
    // { from: '“', to: '"' },    // 左双引号
    // { from: '”', to: '"' },    // 右双引号
  ],
  autoPairBacktick: true,
  mode: 'realtime',
  excludedFolders: '',
  excludedExtensions: '',
};

/**
 * 语法树中被视为「排除上下文」的节点类型（按名称模糊匹配）。
 * 覆盖：FencedCode / CodeBlock / CodeText(InlineCode) / Math / URL /
 *      Autolink / Link / Image / HTMLBlock / Comment / Frontmatter(YAML) 等。
 */
const EXCLUDED_NODE_TYPES = /code|math|url|autolink|link|image|html|comment|frontmatter|yaml/i;

// -------------------- 编辑器运行时结构（最小化结构化访问） --------------------
//
// Obsidian 的 editor-change 事件与 Editor 内部持有的 CodeMirror 6 视图均未公开
// 完整类型，不同版本形态不一。这里只声明实际访问到的成员，避免使用 any。

/** editor-change 事件携带的变更对象（兼容 Obsidian EditorChange / CM6 Transaction / ViewUpdate 等形态） */
interface EditorChangeLike {
  /** Obsidian EditorChange 形态：text 字段 */
  text?: string | string[];
  /** CM6 TransactionSpec 风格：insert 字段 */
  insert?: string | string[];
  /** CM6 ViewUpdate 形态：changes.iterChanges 遍历器 */
  changes?: { iterChanges?: (cb: IterChangesCallback) => void };
  /** 位置对（可能是 EditorPosition 或数字偏移） */
  from?: EditorPosition | number;
  to?: EditorPosition | number;
}

/** CM6 ChangeSet.iterChanges 的回调签名（inserted 为 CodeMirror Text 的最小接口） */
type IterChangesCallback = (
  fromA: number,
  toA: number,
  fromB: number,
  toB: number,
  inserted: { toString(): string; length: number }
) => void;

/** Obsidian Editor 内部持有的 CodeMirror 6 EditorView 的最小结构化接口 */
interface CM6ViewLike {
  state?: CM6StateLike;
  inputState?: { composition?: unknown };
  dispatch?: (spec: CM6DispatchSpec) => void;
}

/** CM6 EditorState 的最小结构化接口 */
interface CM6StateLike {
  doc?: { length: number };
  tree?: SyntaxTree;
  fields?: unknown[];
  field?: (field: unknown, require: boolean) => unknown;
}

/** CM6 单事务分发参数（changes + selection 一次完成，保证单次撤销） */
interface CM6DispatchSpec {
  changes: { from: number; to: number; insert: string };
  selection: { anchor: number };
}

/** lezer 语法树节点的最小结构化接口（用于 iterate 回调） */
interface SyntaxTreeNodeRef {
  type: { name: string };
  from: number;
  to: number;
}

/** lezer 语法树节点（resolveInner 返回，含父节点链） */
interface SyntaxTreeNode extends SyntaxTreeNodeRef {
  parent: SyntaxTreeNode | null;
}

/** lezer 语法树的最小结构化接口 */
interface SyntaxTree {
  resolveInner(pos: number, side?: number): SyntaxTreeNode;
  iterate(spec: { from: number; to: number; enter: (node: SyntaxTreeNodeRef) => boolean | void }): void;
}

// -------------------- 纯工具函数 --------------------

/** 判断是否为中文字符（用于中文人名间隔号保护） */
function isChineseChar(ch: string): boolean {
  return /[\u4e00-\u9fff]/.test(ch);
}

/** 判断是否为 ASCII 字母或数字（用于误输入保护） */
function isAsciiAlnum(ch: string): boolean {
  return /[a-zA-Z0-9]/.test(ch);
}

/** 统计文本中某个字符的出现次数 */
function countChar(text: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === ch) n++;
  return n;
}

// -------------------- 主插件类 --------------------

export default class PunctFlowPlugin extends Plugin {
  settings: PunctFlowSettings;

  /** 防止自身修改触发 editor-change 造成死循环的守卫标记 */
  private isApplying = false;

  /** 上一次 editor-change 时文档长度（用于兜底检测插入/删除） */
  private lastDocLength = -1;

  async onload() {
    await this.loadSettings();

    // ---------- 实时模式：监听编辑器变化 ----------
    this.registerEvent(
      // 说明：Obsidian 官方类型把该事件第二参数标为 MarkdownView/MarkdownFileInfo，
      // 但运行时实际传入的是变更对象（EditorChange/CM6 事务/ViewUpdate 等形态）。
      // 这里用 unknown 承接后再按 EditorChangeLike 结构化访问，避免 any。
      this.app.workspace.on('editor-change', (editor: Editor, change: unknown) => {
        if (this.settings.mode !== 'realtime') return;
        this.handleRealtimeChange(editor, change as EditorChangeLike | null);
      })
    );

    // ---------- 粘贴转换：监听粘贴事件 ----------
    this.registerEvent(
      this.app.workspace.on('editor-paste', (evt: ClipboardEvent, editor: Editor) => {
        // 事件规范：事件已被其他处理器接管时立即返回，避免重复处理
        if (evt.defaultPrevented) return;
        if (this.settings.mode !== 'paste') return;
        // 处理粘贴逻辑；若已执行转换，则阻止默认粘贴（防止事件冒泡冲突）
        if (this.handlePaste(evt, editor)) {
          evt.preventDefault();
        }
      })
    );

    // ---------- 批量转换命令 ----------
    this.addCommand({
      id: 'convert-selection',
      name: '转换选区',
      editorCallback: (editor) => this.convertSelection(editor),
    });
    this.addCommand({
      id: 'convert-line',
      name: '转换当前行',
      editorCallback: (editor) => this.convertCurrentLine(editor),
    });
    this.addCommand({
      id: 'convert-all',
      name: '转换全文',
      editorCallback: (editor) => this.convertAll(editor),
    });

    // ---------- 设置面板 ----------
    this.addSettingTab(new PunctFlowSettingTab(this.app, this));
  }

  onunload() {
    // 无需额外清理：registerEvent 已自动注销
  }

  // ==================== 设置读写 ====================

  async loadSettings() {
    // 注意：Obsidian 的 loadData() 官方类型为 Promise<any>。
    // 先经 unknown + 类型守卫收窄，避免 no-unsafe-assignment。
    const data: unknown = await this.loadData();
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      data !== null && typeof data === 'object' ? (data as Partial<PunctFlowSettings>) : {}
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ==================== 实时转换 ====================

  /**
   * 处理实时输入：把映射字符替换为目标字符串。
   * 只处理「单字符插入」这一类变化；删除、粘贴、多行修改一律忽略。
   */
  private handleRealtimeChange(editor: Editor, change: EditorChangeLike | null): void {
    // 工作模式守卫：仅实时模式自动转换（事件包装器与这里双重检查，纵深防御）
    if (this.settings.mode !== 'realtime') return;

    // 记录本次修改后的文档长度（供下一次兜底检测判断插入/删除）
    const cm = this.getCM6View(editor);
    const docLen = cm?.state?.doc?.length ?? editor.getValue().length;

    // 自身修改触发的事件：只同步长度后返回，防止死循环
    if (this.isApplying) {
      this.lastDocLength = docLen;
      return;
    }

    // IME（输入法）组合输入过程中不处理，避免打断中文输入。
    // 注意：CM6 的组合状态在 view.inputState.composition（不是 state.composition）。
    if (cm?.inputState?.composition) {
      this.lastDocLength = docLen;
      return;
    }

    try {
      // 只处理「单字符插入」。优先从 change 对象取；取不到时用兜底检测。
      const inserted = this.getInsertedText(editor, change);
      if (inserted.length !== 1) return;

      const mapping = this.settings.mappings.find((m) => m.from === inserted);
      if (!mapping || mapping.from === mapping.to) return;

      // 文件级排除（文件夹 / 扩展名）
      if (!this.isFileEligible()) return;

      const cursor = editor.getCursor(); // 插入后光标位于该字符之后
      const typedPos: EditorPosition = { line: cursor.line, ch: cursor.ch - 1 }; // 被输入字符的位置

      // 上下文感知：代码块 / 行内代码 / 公式 / URL / frontmatter 中不转换
      if (this.isInExcludedContext(editor, typedPos)) return;

      // 中文人名间隔号保护：前后都是中文字符且行内反引号为偶数 →
      // 判定为「卡尔·马克思」这类中文人名间隔号，不转换
      const before = this.getCharBefore(editor, typedPos);
      const after = this.getCharAfter(editor, typedPos);
      if (
        mapping.from === '·' &&
        isChineseChar(before) &&
        isChineseChar(after) &&
        this.countBackticksBefore(editor, typedPos) % 2 === 0
      ) {
        return;
      }

      const target = mapping.to;

      // ---- 反引号自动配对 ----
      if (target === '`' && this.settings.autoPairBacktick) {
        // 误输入保护：前后都是字母/数字（如 ab·cd）→ 视为误输入，不转换
        if (isAsciiAlnum(before) && isAsciiAlnum(after)) return;

        const backticksBefore = this.countBackticksBefore(editor, typedPos);

        if (after === '`') {
          // 光标后已有反引号 → 正在闭合自动配对的反引号（`code·` 场景）：
          // 删除刚输入的字符并让光标跳过后面的反引号，避免出现重复反引号
          this.applySingleCharConversion(editor, typedPos, '', 1);
        } else if (backticksBefore % 2 === 1) {
          // 行内反引号为奇数 → 正在闭合行内代码（开始反引号是英文输入的）→ 只插入一个反引号
          this.applySingleCharConversion(editor, typedPos, '`', 1);
        } else {
          // 行内反引号为偶数 → 正在开启行内代码 → 插入一对反引号，光标置于中间
          this.applySingleCharConversion(editor, typedPos, '``', 1);
        }
        return;
      }

      // ---- 普通映射替换（目标为空字符串 = 删除该字符）----
      this.applySingleCharConversion(editor, typedPos, target, target.length);
    } finally {
      this.lastDocLength = docLen;
    }
  }

  /**
   * 从 editor-change 的 change 对象中提取「插入的文本」。
   * 不同 Obsidian / CM6 版本传入的 change 结构并不一致，这里兼容多种形态：
   *   1. { text: string | string[] }                 —— Obsidian EditorChange
   *   2. { insert: string | string[] }               —— CM6 事务风格
   *   3. CM6 ViewUpdate（change.changes.iterChanges）
   *   4. { from, to } 位置对 → 通过 editor.getRange 反查
   *   5. 兜底：光标前一字符 + 文档长度校验（确认是单字符插入而非删除）
   */
  private getInsertedText(editor: Editor, change: EditorChangeLike | null): string {
    if (change) {
      // 1) text 字段（Obsidian EditorChange 的标准形态）
      if (typeof change.text === 'string') return change.text;
      if (Array.isArray(change.text)) return change.text.join('');

      // 2) insert 字段（CM6 TransactionSpec 风格）
      if (typeof change.insert === 'string') return change.insert;
      if (Array.isArray(change.insert)) return change.insert.join('');

      // 3) CM6 ViewUpdate / ChangeSet：遍历变更片段，取单字符插入
      if (change.changes && typeof change.changes.iterChanges === 'function') {
        let found = '';
        try {
          change.changes.iterChanges(
            (_fromA: number, _toA: number, fromB: number, toB: number, inserted) => {
              if (!found && inserted && inserted.length === 1 && toB - fromB === 1) {
                found = inserted.toString();
              }
            }
          );
        } catch {
          /* ignore */
        }
        if (found) return found;
      }

      // 4) from/to 位置对：反查被替换区间的内容（from/to 可能是位置或偏移）
      if (change.from !== undefined && change.to !== undefined) {
        try {
          const fromPos = typeof change.from === 'number' ? editor.offsetToPos(change.from) : change.from;
          const toPos = typeof change.to === 'number' ? editor.offsetToPos(change.to) : change.to;
          const rangeText = editor.getRange(fromPos, toPos);
          if (rangeText.length === 1) return rangeText;
        } catch {
          /* ignore */
        }
      }
    }

    // 5) 兜底：change 结构完全无法识别时，检查光标前一字符是否命中映射，
    //    并用「文档长度 +1」确认是单字符插入（排除删除等场景）
    const cursor = editor.getCursor();
    if (cursor.ch > 0) {
      const prevChar = this.getCharBefore(editor, cursor);
      if (prevChar && this.settings.mappings.some((m) => m.from === prevChar)) {
        const docLen = this.getCM6View(editor)?.state?.doc?.length ?? editor.getValue().length;
        if (this.lastDocLength !== -1 && docLen === this.lastDocLength + 1) {
          return prevChar;
        }
      }
    }
    return '';
  }

  /**
   * 在单个 CodeMirror 6 事务中完成「替换 + 光标移动」，保证一次撤销。
   * cursorDelta：新光标相对替换起点（被输入字符位置）的偏移。
   */
  private applySingleCharConversion(
    editor: Editor,
    typedPos: EditorPosition,
    replacement: string,
    cursorDelta: number
  ): void {
    const cm = this.getCM6View(editor);
    const offset = editor.posToOffset(typedPos);
    this.isApplying = true;
    try {
      if (cm && typeof cm.dispatch === 'function') {
        // 首选：CM6 单一事务（changes + selection），一次 Ctrl+Z 即可撤销
        cm.dispatch({
          changes: { from: offset, to: offset + 1, insert: replacement },
          selection: { anchor: offset + cursorDelta },
        });
      } else {
        // 兜底：Obsidian Editor API（分两步；光标移动一般不产生额外撤销记录）
        editor.replaceRange(replacement, typedPos, { line: typedPos.line, ch: typedPos.ch + 1 });
        editor.setCursor({ line: typedPos.line, ch: typedPos.ch + cursorDelta });
      }
    } finally {
      this.isApplying = false;
    }
  }

  // ==================== 粘贴转换 ====================

  /**
   * 粘贴模式下：对粘贴内容执行映射转换（粘贴位置位于排除上下文时原样粘贴）。
   * @returns 是否执行了转换（true 时调用方应 evt.preventDefault() 阻止默认粘贴）
   */
  private handlePaste(evt: ClipboardEvent, editor: Editor): boolean {
    // 事件规范：事件已被其他处理器接管（defaultPrevented）时立即返回，避免重复处理
    if (evt.defaultPrevented) return false;
    if (this.isApplying) return false;
    const text = evt.clipboardData ? evt.clipboardData.getData('text') : '';
    if (!text) return false;
    if (!this.isFileEligible()) return false;

    // 粘贴目标位于代码块 / 公式 / frontmatter 等排除上下文 → 原样粘贴
    const cursor = editor.getCursor();
    if (this.isInExcludedContext(editor, cursor)) return false;

    const converted = this.convertText(text);
    if (converted === text) return false;

    // 改为插入转换后的文本（一次事务 = 一次撤销）
    this.isApplying = true;
    try {
      editor.replaceSelection(converted);
    } finally {
      this.isApplying = false;
    }
    return true;
  }

  // ==================== 批量转换命令 ====================

  /** 转换选区；未选中文本时自动降级为转换当前行 */
  private convertSelection(editor: Editor): void {
    const selection = editor.getSelection();
    if (selection) {
      const from = editor.getCursor('from');
      const to = editor.getCursor('to');
      this.convertRange(editor, from, to);
    } else {
      // 未选中 → 降级为当前行
      this.convertCurrentLine(editor);
    }
  }

  /** 转换当前行 */
  private convertCurrentLine(editor: Editor): void {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    this.convertRange(editor, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
  }

  /** 转换全文 */
  private convertAll(editor: Editor): void {
    const lastLine = editor.lineCount() - 1;
    const end: EditorPosition = { line: lastLine, ch: editor.getLine(lastLine).length };
    this.convertRange(editor, { line: 0, ch: 0 }, end);
  }

  /**
   * 批量转换区间 [from, to)。
   * 默认不转换 frontmatter；若语法树可用，还用语法树找出代码块 / 公式 / 链接等
   * 排除区间，只转换区间外的文本。整个替换用一次 replaceRange 完成 → 单次撤销记录。
   */
  private convertRange(editor: Editor, from: EditorPosition, to: EditorPosition): void {
    const startOffset = editor.posToOffset(from);
    const endOffset = editor.posToOffset(to);
    if (endOffset <= startOffset) return;

    const doc = editor.getValue();
    const excluded: { from: number; to: number }[] = [];

    // frontmatter（文件开头 --- 到闭合 ---）默认不转换
    if (startOffset === 0 && doc.startsWith('---\n')) {
      const closeNewline = doc.indexOf('\n---', 3);
      if (closeNewline !== -1) {
        const closeStart = closeNewline + 1; // '---' 起始位置
        const lineEnd = doc.indexOf('\n', closeStart);
        const closeEnd = lineEnd === -1 ? doc.length : lineEnd;
        excluded.push({ from: 0, to: Math.min(closeEnd, endOffset) });
      }
    }

    // 语法树排除区间（代码块 / 行内代码 / 公式 / URL / 链接文本等）
    const tree = this.getSyntaxTree(editor);
    if (tree) {
      excluded.push(...this.getExcludedRangesFromTree(tree, startOffset, endOffset));
    }

    // 合并重叠区间
    excluded.sort((a, b) => a.from - b.from);
    const merged: { from: number; to: number }[] = [];
    for (const r of excluded) {
      const last = merged[merged.length - 1];
      if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
      else merged.push({ ...r });
    }

    // 只转换排除区间之外的文本
    let result = '';
    let cursor = startOffset;
    for (const r of merged) {
      if (r.from > cursor) {
        result += this.convertText(
          doc.slice(cursor, r.from),
          cursor > 0 ? doc[cursor - 1] : '',
          r.from < doc.length ? doc[r.from] : ''
        );
      }
      result += doc.slice(Math.max(r.from, cursor), Math.min(r.to, endOffset)); // 排除区间原样保留
      cursor = Math.min(r.to, endOffset);
    }
    if (cursor < endOffset) {
      result += this.convertText(
        doc.slice(cursor, endOffset),
        cursor > 0 ? doc[cursor - 1] : '',
        endOffset < doc.length ? doc[endOffset] : ''
      );
    }

    // 一次 replaceRange 完成替换（单次撤销记录）
    const original = doc.slice(startOffset, endOffset);
    if (result !== original) {
      this.isApplying = true;
      try {
        editor.replaceRange(result, from, to);
      } finally {
        this.isApplying = false;
      }
    }
  }

  // ==================== 上下文感知 ====================

  /**
   * 判断位置 pos 是否处于「不应转换」的上下文中。
   * 优先级：行扫描（frontmatter / 围栏代码块）→ 语法树 → 行内启发式。
   */
  private isInExcludedContext(editor: Editor, pos: EditorPosition): boolean {
    // 0) 行扫描：frontmatter 与围栏代码块（语法树不一定建模 frontmatter，始终执行）
    if (this.isInsideFenceOrFrontmatter(editor, pos.line)) return true;

    // 1) 语法树（CodeMirror 6）：检查光标所在 token 类型
    const tree = this.getSyntaxTree(editor);
    if (tree) {
      try {
        const offset = editor.posToOffset(pos);
        // 取「被输入字符之后」的位置（offset + 1）做节点解析：
        // 若被输入字符紧跟在某个行内代码/链接之后（如 `code`· 想再开一个代码），
        // 用 -1 边会误落到左侧节点的结束边界上，导致被误伤；取 offset+1 更准确。
        let node: SyntaxTreeNode | null = tree.resolveInner(offset + 1, -1);
        while (node) {
          const name = node.type.name;
          if (EXCLUDED_NODE_TYPES.test(name)) {
            // 特例：正在闭合行内代码（光标后紧跟反引号）→ 允许转换
            if (/code/i.test(name) && this.getCharAfter(editor, pos) === '`') return false;
            return true;
          }
          node = node.parent;
        }
      } catch {
        // 语法树解析异常 → 交给行内启发式
      }
    }

    // 2) 行内启发式：行内代码 / 行内公式 / URL
    return this.isInInlineExcluded(editor, pos);
  }

  /** 行内启发式排除判断（用于语法树不可用时的兜底） */
  private isInInlineExcluded(editor: Editor, pos: EditorPosition): boolean {
    const line = editor.getLine(pos.line);
    const beforeText = line.slice(0, pos.ch);
    const afterText = line.slice(pos.ch + 1);

    // a) 行内代码：光标前后反引号都为奇数 → 正处于某对行内代码中间（不转换）。
    //    但光标后紧跟反引号时（闭合自动配对的反引号）→ 允许，交给上层配对逻辑处理
    const backticksBefore = countChar(beforeText, '`');
    const backticksAfter = countChar(afterText, '`');
    if (backticksBefore % 2 === 1 && backticksAfter % 2 === 1) {
      return this.getCharAfter(editor, pos) !== '`';
    }

    // b) 行内公式：光标前 $ 为奇数 → 处于 $...$ 内部
    if (countChar(beforeText, '$') % 2 === 1) return true;

    // c) URL：光标前紧邻一段形如 https://... 的文本 → 处于 URL 内部
    if (/https?:\/\/\S*$/i.test(beforeText)) return true;

    return false;
  }

  /**
   * 从文件开头扫描到 lineNo，判断该行是否位于 frontmatter 或围栏代码块内。
   * （缩进代码块不在此列，由语法树路径覆盖。）
   */
  private isInsideFenceOrFrontmatter(editor: Editor, lineNo: number): boolean {
    const lineCount = editor.lineCount();
    let inFrontmatter = false;
    let fence: string | null = null;

    for (let i = 0; i <= lineNo && i < lineCount; i++) {
      const text = editor.getLine(i).trim();

      if (i === 0 && text === '---') {
        // 文件开头的 --- 视为 frontmatter 开始
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        if (text === '---') inFrontmatter = false;
        continue;
      }
      if (fence) {
        if (text.startsWith(fence)) fence = null;
        continue;
      }
      if (text.startsWith('```') || text.startsWith('~~~')) {
        fence = text.startsWith('```') ? '```' : '~~~';
      }
    }

    return inFrontmatter || fence !== null;
  }

  // ==================== 语法树辅助 ====================

  /**
   * 尝试获取 CodeMirror 6 语法树；不可用时返回 null（回退启发式）。
   * 说明：不同 Obsidian 版本的编辑器状态结构略有差异，这里做了两级探测；
   * 若未来语法树访问方式变化，只需修改本方法（扩展点）。
   */
  /**
   * 尝试获取 CodeMirror 6 语法树；不可用时返回 null（回退启发式）。
   * 说明：不同 Obsidian 版本的编辑器状态结构略有差异，这里做了两级探测；
   * 若未来语法树访问方式变化，只需修改本方法（扩展点）。
   */
  private getSyntaxTree(editor: Editor): SyntaxTree | null {
    const cm = this.getCM6View(editor);
    if (!cm?.state) return null;

    // 方式一：直接访问 state.tree
    if (cm.state.tree) return cm.state.tree;

    // 方式二：遍历 state 字段，寻找持有 lezer Tree（有 iterate / resolveInner）的字段
    // （@codemirror/language 的 Language state field 内部持有语法树）
    try {
      const fields: unknown[] = cm.state.fields ?? [];
      for (const f of fields) {
        const val: unknown = cm.state.field ? cm.state.field(f, false) : undefined;
        if (
          val &&
          typeof (val as SyntaxTree).iterate === 'function' &&
          typeof (val as SyntaxTree).resolveInner === 'function'
        ) {
          return val as SyntaxTree;
        }
      }
    } catch {
      /* ignore */
    }

    return null;
  }

  /** 获取 Obsidian Editor 内部持有的 CodeMirror 6 视图（未公开 API，做最小化结构化访问） */
  private getCM6View(editor: Editor): CM6ViewLike | null {
    return (editor as unknown as { cm?: CM6ViewLike }).cm ?? null;
  }

  /** 遍历语法树，收集 [from, to) 区间内的排除区间（调用方负责合并重叠） */
  private getExcludedRangesFromTree(
    tree: SyntaxTree,
    from: number,
    to: number
  ): { from: number; to: number }[] {
    const ranges: { from: number; to: number }[] = [];
    try {
      tree.iterate({
        from,
        to,
        enter: (node) => {
          if (EXCLUDED_NODE_TYPES.test(node.type.name)) {
            ranges.push({ from: Math.max(node.from, from), to: Math.min(node.to, to) });
            return false; // 不深入子节点
          }
          return true;
        },
      });
    } catch {
      /* ignore */
    }
    return ranges;
  }

  // ==================== 文本转换（状态机） ====================

  /**
   * 对一段文本应用映射规则（状态机扫描）。
   * 自动跳过：围栏代码块、行内代码、$ 公式（行内与 $$ 块）、URL。
   * 中文人名间隔号保护：`·` 前后都是中文字符时不转换。
   * prevChar / nextChar：片段边界外的相邻字符，用于边界处的间隔号判断。
   */
  private convertText(text: string, prevChar: string = '', nextChar: string = ''): string {
    if (!text) return '';
    const lines = text.split('\n');
    const out: string[] = [];

    let fence: string | null = null; // 围栏代码块标记（跨行状态）
    let mathBlock = false; // $$ 数学块（跨行状态）
    let prev = prevChar; // 前一个字符（用于中文间隔号判断）

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const trimmed = line.trim();

      // ---- 围栏代码块：整行原样保留 ----
      if (fence) {
        if (trimmed.startsWith(fence)) fence = null;
        out.push(line);
        prev = line.length ? line[line.length - 1] : prev;
        continue;
      }
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        fence = trimmed.startsWith('```') ? '```' : '~~~';
        out.push(line);
        prev = line.length ? line[line.length - 1] : prev;
        continue;
      }

      // ---- 行内处理（逐字符状态机）----
      let outLine = '';
      let inlineCode = false; // 行内代码 `...`
      let inlineMath = false; // 行内公式 $...$

      for (let i = 0; i < line.length; i++) {
        const c = line[i];

        // 行内代码内部：只认闭合反引号，其余原样输出
        if (inlineCode) {
          if (c === '`') {
            inlineCode = false;
            outLine += '`';
            prev = '`';
          } else {
            outLine += c;
            prev = c;
          }
          continue;
        }

        // 公式内部（行内 $ 或块级 $$）：只认 $ 结束，其余原样输出
        if (inlineMath || mathBlock) {
          if (c === '$' && i + 1 < line.length && line[i + 1] === '$') {
            mathBlock = !mathBlock;
            outLine += '$$';
            i++; // 跳过第二个 $
            prev = '$';
          } else if (c === '$') {
            inlineMath = !inlineMath;
            outLine += '$';
            prev = '$';
          } else {
            outLine += c;
            prev = c;
          }
          continue;
        }

        // 普通状态：反引号开启行内代码
        if (c === '`') {
          inlineCode = true;
          outLine += '`';
          prev = '`';
          continue;
        }

        // 普通状态：$ 开/关公式
        if (c === '$' && i + 1 < line.length && line[i + 1] === '$') {
          mathBlock = !mathBlock;
          outLine += '$$';
          i++;
          prev = '$';
          continue;
        }
        if (c === '$') {
          inlineMath = true;
          outLine += '$';
          prev = '$';
          continue;
        }

        // URL：原样跳过（不含中文标点，保证紧随 URL 的中文标点仍可转换）
        const urlMatch = /^(https?|ftp):\/\/[^\s<>()，。！？；：、“”‘’]*/.exec(line.slice(i));
        if (urlMatch) {
          outLine += urlMatch[0];
          prev = urlMatch[0][urlMatch[0].length - 1];
          i += urlMatch[0].length - 1;
          continue;
        }

        // 映射匹配（按设置中的顺序，第一条命中生效）
        const mapping = this.matchMappingAt(line, i);
        if (mapping) {
          // 中文人名间隔号保护：· 前后都是中文字符 → 不转换
          if (
            mapping.from === '·' &&
            isChineseChar(prev) &&
            isChineseChar(this.peekNext(lines, li, i, mapping.from.length, nextChar))
          ) {
            outLine += mapping.from;
            prev = mapping.from[mapping.from.length - 1];
            i += mapping.from.length - 1;
            continue;
          }
          outLine += mapping.to;
          prev = mapping.to.length ? mapping.to[mapping.to.length - 1] : prev;
          i += mapping.from.length - 1;
          continue;
        }

        // 普通字符
        outLine += c;
        prev = c;
      }

      out.push(outLine);
    }

    return out.join('\n');
  }

  /** 在 line 的位置 i 处查找命中的映射（按设置顺序，第一条命中生效） */
  private matchMappingAt(line: string, i: number): PunctFlowMapping | null {
    for (const m of this.settings.mappings) {
      if (m.from && m.from !== m.to && line.startsWith(m.from, i)) return m;
    }
    return null;
  }

  /** 取 line[li] 中位置 i 之后（跨过 len 个字符后）的下一个字符；行尾则看下一行/边界字符 */
  private peekNext(lines: string[], li: number, i: number, len: number, nextChar: string): string {
    const pos = i + len;
    if (pos < lines[li].length) return lines[li][pos];
    if (li + 1 < lines.length) return lines[li + 1][0] || '';
    return nextChar;
  }

  // ==================== 文件级排除 ====================

  /** 当前文件是否允许转换（排除文件夹 / 扩展名） */
  private isFileEligible(): boolean {
    const file = this.app.workspace.getActiveFile();
    if (!file) return true;

    const path = file.path;
    for (const folder of this.getExcludedFolders()) {
      if (path === folder || path.startsWith(folder + '/')) return false;
    }

    const ext = file.extension.toLowerCase();
    for (const e of this.getExcludedExtensions()) {
      if (ext === e.toLowerCase()) return false;
    }
    return true;
  }

  private getExcludedFolders(): string[] {
    return this.settings.excludedFolders
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private getExcludedExtensions(): string[] {
    return this.settings.excludedExtensions
      .split('\n')
      .map((s) => s.trim().replace(/^\./, ''))
      .filter((s) => s.length > 0);
  }

  // ==================== 小工具 ====================

  private getCharBefore(editor: Editor, pos: EditorPosition): string {
    if (pos.ch <= 0) return '';
    return editor.getRange({ line: pos.line, ch: pos.ch - 1 }, pos);
  }

  /** 位置 pos 之后的一个字符（即 pos.ch + 1 处的字符；pos 是刚输入字符的位置） */
  private getCharAfter(editor: Editor, pos: EditorPosition): string {
    const line = editor.getLine(pos.line);
    if (pos.ch + 1 >= line.length) return '';
    return editor.getRange({ line: pos.line, ch: pos.ch + 1 }, { line: pos.line, ch: pos.ch + 2 });
  }

  /** 当前行光标位置之前反引号的数量 */
  private countBackticksBefore(editor: Editor, pos: EditorPosition): number {
    const line = editor.getLine(pos.line);
    return countChar(line.slice(0, pos.ch), '`');
  }
}

// -------------------- 设置面板 --------------------

class PunctFlowSettingTab extends PluginSettingTab {
  plugin: PunctFlowPlugin;

  constructor(app: App, plugin: PunctFlowPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Obsidian ≥ 1.13.0：声明式设置定义。
   * 返回非空数组时，框架以声明式渲染设置面板并支持「设置」全局搜索
   * （已弃用的 display() 不再实现）。
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    return [
      // ---------- 1. 标点映射表 ----------
      {
        name: '输入字符 → 输出字符串（目标可为空，表示删除）。规则按从上到下顺序匹配；实时模式只对单字符输入生效。',
      },
      {
        type: 'list',
        heading: '标点映射表',
        cls: 'punctflow-mapping-list',
        emptyState: '暂无映射规则，点击「添加映射」新增。',
        items: s.mappings.map((m, idx) => ({
          name: `映射规则 ${idx + 1}`,
          desc: '输入字符 → 输出字符串（目标可为空 = 删除）',
          render: (setting: Setting) => {
            setting
              .addText((t) =>
                t
                  .setPlaceholder('源字符，如 ·')
                  .setValue(m.from)
                  .onChange(async (v) => {
                    m.from = v;
                    await this.plugin.saveSettings();
                  })
              )
              .addText((t) =>
                t
                  .setPlaceholder('目标，如 `')
                  .setValue(m.to)
                  .onChange(async (v) => {
                    m.to = v;
                    await this.plugin.saveSettings();
                  })
              );
          },
        })),
        addItem: {
          name: '添加映射',
          action: () => {
            void (async () => {
              s.mappings.push({ from: '', to: '' });
              await this.plugin.saveSettings();
              this.rerender();
            })();
          },
        },
        onDelete: (index: number) => {
          void (async () => {
            s.mappings.splice(index, 1);
            await this.plugin.saveSettings();
            this.rerender();
          })();
        },
      },
      // ---------- 2. 自动配对反引号 ----------
      {
        name: '自动配对反引号',
        desc: '输入 · 转换后自动插入一对反引号并将光标置于中间；再次输入 · 时自动跳过已存在的闭合反引号，避免重复。',
        control: { type: 'toggle', key: 'autoPairBacktick', defaultValue: true },
      },
      // ---------- 3. 工作模式 ----------
      {
        name: '工作模式',
        desc: '实时模式：输入时立即转换；手动模式：仅通过命令转换；粘贴模式：粘贴文本后自动转换粘贴内容。',
        control: {
          type: 'dropdown',
          key: 'mode',
          defaultValue: 'realtime',
          options: {
            realtime: '实时模式（默认）',
            manual: '手动模式',
            paste: '粘贴转换',
          },
        },
      },
      // ---------- 4. 排除文件夹 ----------
      {
        name: '排除文件夹',
        desc: '在这些文件夹中的文件不进行转换，每行一个路径（相对仓库根目录），如：日记',
        control: { type: 'textarea', key: 'excludedFolders', placeholder: '日记\n模板', defaultValue: '' },
      },
      // ---------- 5. 排除文件扩展名 ----------
      {
        name: '排除文件扩展名',
        desc: '这些扩展名的文件不转换，每行一个，不带点，如：txt',
        control: { type: 'textarea', key: 'excludedExtensions', placeholder: 'txt\nlog', defaultValue: '' },
      },
      // ---------- 6. 恢复默认映射 ----------
      {
        name: '恢复默认映射',
        desc: '将映射表恢复为默认（· → `），其余设置保持不变。',
        action: () => {
          void (async () => {
            s.mappings = DEFAULT_SETTINGS.mappings.map((m) => ({ ...m }));
            await this.plugin.saveSettings();
            this.rerender();
          })();
        },
      },
    ];
  }

  /** 重新渲染设置面板（Obsidian ≥ 1.13.0 声明式框架） */
  private rerender(): void {
    this.update();
  }
}
