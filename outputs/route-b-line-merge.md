# 路线 B：冲突弹窗「逐行合并」实现说明

## 目标

把 `ConflictDiffModal` 中原来仅作视觉标记的「回滚此变更」按钮，升级为**真正参与冲突解决**的逐行选择：本地侧「接受本地」、远端侧「接受远端」，并在底部新增「应用合并」按钮，将逐行选择结果合成合并内容写回文件。

## 数据流

```
点击行内 ✓ 按钮
  → toggleChoice(rowIndex, "local" | "remote")   // 写入 lineChoices
  → render()                                      // 高亮接受侧 / 置灰拒绝侧
  → updateApplyMergeBtn()                         // 「应用合并 (n)」可用
  → 点击「应用合并」
  → assembleMerge()                               // 合成文本
  → onResolve({ action: "merge", content })
  → ConflictResolverModal.resolve(path, res)
  → runPullWithResolutions(resolutions)
  → SyncEngine.pullRemote(resolutions)
  → executePull({ conflictResolutions })
  → 写入 encodeText(res.content) 并更新基线 hash
```

## 关键约定

| 项 | 约定 |
|---|---|
| diff 映射 | `computeDiffRows(localLines, remoteLines)` → `oldText/oldLine` = **本地**，`newText/newLine` = **远端** |
| 并排布局 | 左列 = 本地（接受本地），右列 = 远端（接受远端） |
| 纵向布局 | 上面板 = 远端，下面板 = 本地 |
| 未选择行 | 回退到 `entry.preferred`（mtime 默认胜者） |
| 空侧选择 | 选择在某一侧不存在的行（如"接受本地"一条远端新增）→ 该行被丢弃 |
| 换行符 | 由 `detectEol()` 推断（CRLF 优先），避免整个文件的换行符被改写 |

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/ConflictResolver.ts` | 回调签名改为 `(resolution: ConflictResolution) => void`；`rolledBack: Set` → `lineChoices: Map<number, "local"\|"remote">`；新增 `toggleChoice` / `updateApplyMergeBtn` / `assembleMerge` / `detectEol`；footer 新增「应用合并」按钮（未选行时禁用）；`buildSideRow` 与 `buildVerticalPair` 双侧各一个 ✓ 按钮，内联在行号单元格内；修正并排表头左右标签反向的缺陷；`renderItem` 的 Notice 支持 merge 分支 |
| `src/i18n.ts` | 新增 `conflictApplyMerge` / `diffAcceptLocal` / `diffAcceptRemote` / `diffAcceptedHint` / `conflictResolvedMerge`（中英双语） |
| `styles.css` | 新增 `.gitee-sync-plus-diff-accept-btn`（hover 显形、选中态强调色）与 `.is-accepted` / `.is-rejected` 状态样式 |

## 验证

- `tsc --noEmit`：0 错误
- `npm run build`：通过（tsc + esbuild production）
- 未做 Obsidian 内手动验证；未 git commit

## 已知边界

1. 逐行合并按**行**粒度，不做行内（字符级）合并。
2. 选择结果仅在弹窗打开期间保存在内存，关闭弹窗即丢失。
3. 「保留本地」「使用远端」仍是整体覆盖，与逐行选择互斥（点整体按钮会忽略逐行选择）。
