# PunctFlow

[中文版本](./README.zh.md)

**PunctFlow** is an Obsidian plugin that intelligently converts Chinese punctuation to the corresponding English Markdown punctuation while you type under a Chinese input method — most importantly `·` (interpunct) → `` ` `` (backtick) — reducing the cost of switching between Chinese and English input methods. Core design principles: **smart, controllable, and never harmful**.

It is an upgraded, generalized version of the [dot-to-backtick](https://github.com/) plugin (which replaces the Chinese interpunct `·` with a backtick `` ` ``), extended into a universal smart converter for Chinese punctuation.

## ✨ Features

| Feature | Description |
| --- | --- |
| 🔧 Configurable mapping table | Default `·` → `` ` ``; add, edit, or remove any mapping in the settings (empty target = delete the character) |
| 🧠 Context awareness | No conversion inside code blocks, inline code, math formulas, URLs, link text, or frontmatter; Chinese personal-name interpuncts (卡尔·马克思) are never converted |
| ⚡ Backtick auto-pairing | Typing `·` inserts a pair of backticks and places the cursor between them; typing `·` again skips past the closing backtick so duplicates never appear |
| 🖥 Batch conversion commands | Convert selection / current line / whole document (selection falls back to the current line when nothing is selected) |
| 🎛 Three working modes | Realtime mode (default) / manual mode / paste conversion |
| 🚫 Exclusion rules | Exclude files by folder path or file extension; frontmatter is not converted by default |
| ↩️ Undo merging | Each conversion produces a single transaction, so one `Ctrl+Z` undoes it |

## 📦 Installation

1. Build the plugin (requires [Node.js](https://nodejs.org/) ≥ 18):
   ```bash
   npm install
   npm run build
   ```
2. Copy the project folder into `<your-vault>/.obsidian/plugins/punctflow/` (make sure it contains `main.js`, `manifest.json`, and `styles.css`).
3. In Obsidian, open **Settings → Community plugins**, and enable **PunctFlow**.

> Plugin ID: `punctflow`.

## ⚙️ Configuration

Open **Settings → PunctFlow settings**:

1. **Punctuation mapping table**: each entry is a "source character → target string". Leaving the target empty deletes the character. Rules are matched from top to bottom (the first hit wins). Use **+ Add mapping** to add, the trash icon to delete, or **Reset mappings** to restore `·` → `` ` ``.
2. **Auto-pair backticks**: when enabled, typing `·` inserts a pair of backticks with the cursor centered; typing `·` again skips past an existing closing backtick.
3. **Working mode**:
   - **Realtime (default)**: converts immediately as you type a mapped character;
   - **Manual**: never auto-converts; conversion happens only through commands;
   - **Paste conversion**: converts pasted content automatically after a paste.
4. **Excluded folders**: one path per line (relative to the vault root, e.g. `journal`); files inside these folders are not converted.
5. **Excluded file extensions**: one per line without the dot (e.g. `txt`); files with these extensions are not converted.

## 🎮 Usage

- **Realtime input**: with a Chinese input method active, type `·` (usually the backtick key) and the plugin turns it into `` ` `` with auto-pairing; mapped characters such as `。` or `，` behave the same way (depending on your mapping table).
- **Command palette** (Ctrl/Cmd + P):
  - `PunctFlow: Convert selection` (falls back to the current line when nothing is selected)
  - `PunctFlow: Convert current line`
  - `PunctFlow: Convert whole document`
- **Paste conversion**: switch the working mode to "Paste conversion", then pasted content is converted automatically.

### Typical flow (backtick auto-pairing)

1. Type `·` at the cursor → `` `` `` is inserted and the cursor is placed between the backticks;
2. Type your code → `` `code` ``;
3. Type `·` once more → the cursor skips past the closing backtick, no duplicate backticks.

### Scenarios that are never converted (auto-detected)

```md
```js
// The · inside code blocks is not converted
const a = '卡尔·马克思';   // Chinese personal-name interpuncts are not converted
```

`The · inside inline code is not converted`, `$The · inside math is not converted$`, [link text · not converted](https://example.com).

```yaml
---
title: The · inside frontmatter is not converted
---
```

## 🧠 How it works

### 1. Context awareness

Before converting, three levels of checks run (by priority):

1. **Line scanning**: scans from the start of the file to determine whether the current line is inside frontmatter (`---`…`---`) or a fenced code block (```` ``` ```` / `~~~`);
2. **CodeMirror 6 syntax tree**: the plugin reads the editor's internal CM6 state through a minimal structured interface and resolves the node at the cursor position with `tree.resolveInner(offset)`, then walks up the parent chain. If the node name matches `code / math / url / link / image / html / comment / frontmatter` and similar, conversion is skipped (special case: if the character right after the cursor is a backtick — the user is closing an inline code span — conversion is allowed);
3. **Inline heuristics** (fallback when the syntax tree is unavailable):
   - Both sides of the cursor are Chinese characters with an even number of backticks on the line → Chinese personal-name interpunct (`卡尔·马克思`), not converted;
   - Odd numbers of backticks both before and after the cursor → inside inline code, not converted;
   - Odd number of `$` before the cursor → inside inline math, not converted;
   - `https://...` immediately before the cursor → inside a URL, not converted.

When the syntax tree is unavailable, the plugin automatically falls back to the heuristics — no configuration needed.

### 2. Backtick auto-pairing

When a character mapped to a backtick (`·`) is typed and conversion should happen:

- **No backtick after the cursor**: insert a pair `` `` ``, placing the cursor between them (opening inline code);
- **A backtick already follows the cursor** (e.g. the closing backtick produced by auto-pairing): delete the just-typed character and move the cursor past the existing backtick — this both "closes" the span and avoids duplicates like `` `code`` ``;
- **Odd number of backticks on the line** (the opening backtick was typed in English mode, e.g. `` `code ``): insert a single closing backtick.

### 3. Undo merging

- **Realtime conversion**: `cm.dispatch({ changes, selection })` performs the replacement and the cursor move in a **single CodeMirror transaction**, undoable with one `Ctrl+Z`;
- **Batch conversion**: the whole range is replaced with a single `editor.replaceRange()`, also producing a single undo record;
- The `isApplying` guard flag prevents the plugin's own edits from triggering `editor-change` and causing infinite loops.

## 🛠 Development

```bash
npm install      # install dependencies
npm run dev      # watch mode build (main.js)
npm run build    # production build (tsc type check + esbuild)
npm test         # run the simulation test suite
```

### Project structure

```
├── main.ts              # plugin core logic (including the settings tab)
├── manifest.json        # plugin manifest
├── styles.css           # settings panel styles
├── esbuild.config.mjs   # esbuild build configuration
├── tsconfig.json        # TypeScript configuration
├── package.json         # dependencies and scripts
├── versions.json        # version compatibility manifest
└── .github/workflows/release.yml   # release workflow with artifact attestations
```

## 📄 License

[MIT](./LICENSE)
