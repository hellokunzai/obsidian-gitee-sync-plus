# 概览 — 差异弹窗 UI 优化（图标按钮 + 行级回滚）

## 完成内容

对 `ConflictDiffModal`（冲突文件内嵌差异对比弹窗）做了 3 项 UI 优化，参考用户提供的 Obsidian 原生 Diff 截图风格。

### 改动清单

| # | 改动 | 文件 |
|---|------|------|
| 1 | **并排/统一 → 图标按钮**（⇅ / ☰），位于头部右侧 | `src/ConflictResolver.ts` + `styles.css` |
| 2 | **折叠/展开 → 移到头部 + 图标**（▼ / ▶），紧跟布局切换后 | `src/ConflictResolver.ts` + `styles.css` |
| 3 | **冲突行 → 左侧回滚按钮**（↦ 圆形），点击切换接受/拒绝，已回滚行半透明 | `src/ConflictResolver.ts` + `styles.css` + `src/i18n.ts` |

### 技术细节

- 头部图标按钮：28×28px 方形，Unicode 字符渲染（无需字体依赖）
- 回滚按钮：22×22px 圆形，hover 时放大至 1.15x + 边框高亮
- 已回滚状态：`opacity: 0.4` + 回滚按钮变为强调色
- 并排/统一两种视图均已适配回滚列（含折叠占位行的对齐 td）

### 验证
- ✅ `npm run build` 通过（tsc + esbuild 0 报错）
- ⏳ 未做 Obsidian 内手动验证
- ⏳ 未 git commit

### 产物
- `main.js` — 已重构建
- `styles.css` — 含新增样式
