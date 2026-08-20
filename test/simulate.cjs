/*
 * test/simulate.cjs — 模拟 Obsidian Editor + CM6，验证 PunctFlow 核心流程
 * 运行：node test/simulate.cjs
 */
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'obsidian') {
    return {
      Plugin: class {
        constructor(app, manifest) {
          this.app = app;
          this.manifest = manifest;
        }
        async loadData() { return null; }
        async saveData() {}
        registerEvent() {}
        addCommand() {}
        addSettingTab() {}
      },
      PluginSettingTab: class {},
      Setting: class {
        addText() { return this; } addTextArea() { return this; } addDropdown() { return this; }
        addToggle() { return this; } addButton() { return this; } addExtraButton() { return this; }
      },
      App: class {},
    };
  }
  return origLoad.apply(this, arguments);
};

const { default: PunctFlowPlugin } = require('../main.js');

// ---------- 模拟编辑器 ----------
function makeEditor(initialText, cursorOffset) {
  const editor = {
    _doc: initialText,
    _cursor: cursorOffset,
  };
  const lines = () => editor._doc.split('\n');
  const posToOffset = (pos) => {
    const ls = lines();
    let off = 0;
    for (let i = 0; i < pos.line; i++) off += ls[i].length + 1;
    return off + pos.ch;
  };
  const offsetToPos = (off) => {
    let line = 0, col = 0;
    for (let i = 0; i < off; i++) {
      if (editor._doc[i] === '\n') { line++; col = 0; } else col++;
    }
    return { line, ch: col };
  };
  editor.posToOffset = posToOffset;
  editor.offsetToPos = offsetToPos;
  editor.getCursor = () => offsetToPos(editor._cursor);
  editor.getLine = (line) => lines()[line] ?? '';
  editor.lineCount = () => lines().length;
  editor.getRange = (from, to) => {
    const a = posToOffset(from), b = posToOffset(to);
    return editor._doc.slice(Math.min(a, b), Math.max(a, b));
  };
  editor.getValue = () => editor._doc;
  editor.replaceRange = (repl, from, to) => {
    const a = posToOffset(from), b = posToOffset(to);
    editor._doc = editor._doc.slice(0, a) + repl + editor._doc.slice(b);
    editor._cursor = a + repl.length;
  };
  editor.setCursor = (pos) => { editor._cursor = posToOffset(pos); };
  editor.getSelection = () => '';
  editor.getCursorSide = (side) => offsetToPos(editor._cursor);
  editor.cm = {
    state: { doc: { get length() { return editor._doc.length; } } },
    inputState: { composition: null },
    dispatch: (spec) => {
      const ins = typeof spec.changes.insert === 'string'
        ? spec.changes.insert
        : spec.changes.insert.join('');
      editor._doc = editor._doc.slice(0, spec.changes.from) + ins + editor._doc.slice(spec.changes.to);
      editor._cursor = spec.selection.anchor;
    },
  };
  return editor;
}

// ---------- 断言工具 ----------
let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${detail ? '— ' + detail : ''}`); }
}

// ---------- 构造插件实例 ----------
const app = { workspace: { getActiveFile: () => ({ path: 'notes/test.md', extension: 'md' }) } };
const plugin = new PunctFlowPlugin(app, { id: 'obsidian-punctflow' });
plugin.loadSettings().then(() => {
  main();
});

function main() {
  // ============ 场景 1：标准 EditorChange 形态（text: string[]）============
  console.log('\n[1] 标准形态 change = {from, to, text: string[]}（Obsidian EditorChange）');
  {
    const ed = makeEditor('hello ', 6);
    const cursor = ed.getCursor();
    ed._doc = 'hello ·'; ed._cursor = 7; // 模拟输入 · 之后
    const change = { from: cursor, to: { line: 0, ch: 7 }, text: ['·'] };
    plugin.handleRealtimeChange(ed, change);
    assert('开启行内代码：插入一对反引号', ed._doc === 'hello ``', `实际: ${JSON.stringify(ed._doc)}`);
    assert('光标位于两个反引号之间', ed._cursor === 7, `实际 offset: ${ed._cursor}`);
  }

  // ============ 场景 2：text: string 形态 ============
  console.log('\n[2] change.text 为字符串');
  {
    const ed = makeEditor('foo', 3);
    const cursor = ed.getCursor();
    ed._doc = 'foo·'; ed._cursor = 4;
    const change = { from: cursor, to: { line: 0, ch: 4 }, text: '·' };
    plugin.handleRealtimeChange(ed, change);
    assert('插入一对反引号', ed._doc === 'foo``', `实际: ${JSON.stringify(ed._doc)}`);
  }

  // ============ 场景 3：ViewUpdate 形态（change.changes.iterChanges）============
  console.log('\n[3] change 为 CM6 ViewUpdate 形态');
  {
    const ed = makeEditor('bar', 3);
    ed._doc = 'bar·'; ed._cursor = 4;
    const change = {
      changes: {
        iterChanges: (cb) => cb(3, 3, 3, 4, { length: 1, toString: () => '·' }),
      },
    };
    plugin.handleRealtimeChange(ed, change);
    assert('插入一对反引号', ed._doc === 'bar``', `实际: ${JSON.stringify(ed._doc)}`);
  }

  // ============ 场景 4：无法识别的 change（兜底检测 + 文档长度校验）============
  console.log('\n[4] change 结构未知 → 兜底检测');
  {
    const ed = makeEditor('a·', 2); // 已输入 ·，光标在其后
    plugin.lastDocLength = 1; // 模拟上一次修改后长度为 1
    plugin.handleRealtimeChange(ed, {}); // change 是空对象
    assert('兜底检测到 · 并转换', ed._doc === 'a``', `实际: ${JSON.stringify(ed._doc)}`);
  }

  // ============ 场景 5：删除操作不应被兜底误判 ============
  console.log('\n[5] 删除操作（长度-1）不被兜底误判');
  {
    const ed = makeEditor('a', 1); // 删除了某个字符后，光标在 1，前一字符是 a
    ed._doc = 'a·'; // hmm 需要构造：前一字符命中映射但长度变化是 -1
    // 构造：用户删除了 · 之后的字符，前一字符仍是 ·，但文档变短
    const ed2 = makeEditor('a', 1);
    ed2._doc = 'a'; ed2._cursor = 1;
    plugin.lastDocLength = 2; // 修改前长度为 2（含 ·）
    plugin.handleRealtimeChange(ed2, {});
    // 前一字符是 a，不命中映射 → 无论如何不转换
    assert('前一字符非映射源，不转换', ed2._doc === 'a');
    // 直接命中映射源但长度-1 的情况：前一字符为 ·（删除的是 · 后面的字符）
    const ed3 = makeEditor('·', 1);
    ed3._doc = '·'; ed3._cursor = 1; // 光标在 · 之后，但这是「删除后」状态
    plugin.lastDocLength = 3; // 修改前长度 3 → 现在 1 → 变化 -2，不是 +1
    plugin.handleRealtimeChange(ed3, {});
    assert('长度 -2 不被误判为插入', ed3._doc === '·', `实际: ${JSON.stringify(ed3._doc)}`);
  }

  // ============ 场景 6：中文人名间隔号保护 ============
  console.log('\n[6] 中文人名间隔号保护（卡尔·马克思）');
  {
    const ed = makeEditor('卡尔马克思', 2);
    ed._doc = '卡尔·马克思'; ed._cursor = 3; // 输入 · 之后
    const change = { from: { line: 0, ch: 2 }, to: { line: 0, ch: 3 }, text: ['·'] };
    plugin.handleRealtimeChange(ed, change);
    assert('人名间隔号不转换', ed._doc === '卡尔·马克思', `实际: ${JSON.stringify(ed._doc)}`);
  }

  // ============ 场景 7：自动配对闭合（`code·` → 光标跳过）============
  console.log('\n[7] 自动配对闭合：`code·` 输入 · 后应删除并跳过闭合反引号');
  {
    const ed = makeEditor('`code`', 5); // 光标在闭合反引号前
    ed._doc = '`code·`'; ed._cursor = 6; // 输入 · 之后
    const change = { from: { line: 0, ch: 5 }, to: { line: 0, ch: 6 }, text: ['·'] };
    plugin.handleRealtimeChange(ed, change);
    assert('闭合后文本为 `code`（无重复反引号）', ed._doc === '`code`', `实际: ${JSON.stringify(ed._doc)}`);
    assert('光标越过闭合反引号', ed._cursor === 6, `实际 offset: ${ed._cursor}`);
  }

  // ============ 场景 8：英文开引号 + · 闭合（`code· → `code`）============
  console.log('\n[8] 英文开引号后输入 · 闭合：`code· → `code`');
  {
    const ed = makeEditor('`code', 5);
    ed._doc = '`code·'; ed._cursor = 6;
    const change = { from: { line: 0, ch: 5 }, to: { line: 0, ch: 6 }, text: ['·'] };
    plugin.handleRealtimeChange(ed, change);
    assert('只插入一个闭合反引号', ed._doc === '`code`', `实际: ${JSON.stringify(ed._doc)}`);
    assert('光标在闭合反引号后', ed._cursor === 6, `实际 offset: ${ed._cursor}`);
  }

  // ============ 场景 9：代码块内不转换 ============
  console.log('\n[9] 代码块内不转换');
  {
    const ed = makeEditor('```js\nconst x = 1;\n```', 8); // 光标在代码块内容行
    ed._doc = '```js\nconst x· = 1;\n```'; ed._cursor = 9;
    const change = { from: { line: 1, ch: 8 }, to: { line: 1, ch: 9 }, text: ['·'] };
    plugin.handleRealtimeChange(ed, change);
    assert('代码块内 · 保留', ed._doc === '```js\nconst x· = 1;\n```', `实际: ${JSON.stringify(ed._doc)}`);
  }

  // ============ 场景 10：普通映射（。→ . ）============
  console.log('\n[10] 普通映射：。→ . ');
  {
    plugin.settings.mappings.push({ from: '。', to: '. ' });
    const ed = makeEditor('你好', 2);
    ed._doc = '你好。'; ed._cursor = 3;
    const change = { from: { line: 0, ch: 2 }, to: { line: 0, ch: 3 }, text: ['。'] };
    plugin.handleRealtimeChange(ed, change);
    assert('。转换为 . ', ed._doc === '你好. ', `实际: ${JSON.stringify(ed._doc)}`);
    plugin.settings.mappings.pop();
  }

  // ============ 场景 11：手动模式下不转换 ============
  console.log('\n[11] 手动模式不自动转换');
  {
    plugin.settings.mode = 'manual';
    const ed = makeEditor('x', 1);
    ed._doc = 'x·'; ed._cursor = 2;
    const change = { from: { line: 0, ch: 1 }, to: { line: 0, ch: 2 }, text: ['·'] };
    plugin.handleRealtimeChange(ed, change);
    assert('手动模式保留 ·', ed._doc === 'x·');
    plugin.settings.mode = 'realtime';
  }

  // ============ 场景 12：排除文件夹不转换 ============
  console.log('\n[12] 排除文件夹不转换');
  {
    plugin.settings.excludedFolders = 'notes';
    const ed = makeEditor('x', 1);
    ed._doc = 'x·'; ed._cursor = 2;
    const change = { from: { line: 0, ch: 1 }, to: { line: 0, ch: 2 }, text: ['·'] };
    plugin.handleRealtimeChange(ed, change);
    assert('排除文件夹内保留 ·', ed._doc === 'x·');
    plugin.settings.excludedFolders = '';
  }

  // ============ 汇总 ============
  console.log(`\n========== 结果：${passed} 通过，${failed} 失败 ==========`);
  process.exit(failed ? 1 : 0);
}
