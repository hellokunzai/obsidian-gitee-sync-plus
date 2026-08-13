#!/usr/bin/env bash
# 发布 Gitee Sync 插件新版本:bump 版本 → 构建 → 提交推送 → GitHub Release。
# 社区市场和 BRAT 都从 Release 拉取更新,本脚本跑完即发布完成。
#
# 用法: scripts/release.sh <version> [release notes]
#   version        新版本号,x.y.z 格式,不带 v 前缀(必须大于当前版本)
#   release notes  可选,Release 说明,默认 "Release <version>"
#
# 前置条件: git 工作区干净(功能改动先自行提交);gh CLI 已登录。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=${1:?用法: scripts/release.sh <version> [release notes]}
NOTES=${2:-"Release $VERSION"}

[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "错误: 版本号必须是 x.y.z 格式(不带 v 前缀),Obsidian 要求 Release 标签与 manifest 版本完全一致"; exit 1; }

if [[ -n $(git status --porcelain) ]]; then
  echo "错误: 工作区有未提交的改动,请先把功能改动单独提交,再运行发布脚本:"
  git status --short
  exit 1
fi

CURRENT=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
NEWER=$(python3 -c "
cur = tuple(map(int, '$CURRENT'.split('.')))
new = tuple(map(int, '$VERSION'.split('.')))
print('yes' if new > cur else 'no')")
[[ $NEWER == yes ]] || { echo "错误: 新版本 $VERSION 必须大于当前版本 $CURRENT"; exit 1; }

if gh release view "$VERSION" >/dev/null 2>&1; then
  echo "错误: Release $VERSION 已存在"; exit 1
fi

# manifest.json 的 version 与 versions.json 的映射必须同步更新;
# minAppVersion 沿用 manifest 当前值。
python3 - "$VERSION" <<'EOF'
import json, sys
version = sys.argv[1]
m = json.load(open('manifest.json'))
m['version'] = version
json.dump(m, open('manifest.json', 'w'), indent='\t', ensure_ascii=False)
open('manifest.json', 'a').write('\n')
v = json.load(open('versions.json'))
v[version] = m['minAppVersion']
json.dump(v, open('versions.json', 'w'), indent='\t', ensure_ascii=False)
open('versions.json', 'a').write('\n')
print(f"manifest.json -> {version} (minAppVersion {m['minAppVersion']})")
EOF

npm run build

git add manifest.json versions.json
git commit -m "Release $VERSION"
git push github

# 标签必须与 manifest 版本完全一致;main.js / manifest.json / styles.css 是
# Obsidian 安装时实际下载的文件,必须作为附件上传。
# 注意:推送到 github 远端(hellokunzai fork),不要推到 origin(ericquan8 上游)。
gh release create "$VERSION" main.js manifest.json styles.css \
	--title "$VERSION" --notes "$NOTES" \
	--repo "hellokunzai/obsidian-gitee-sync-plus"

echo ""
echo "✅ $VERSION 发布完成。社区市场约 30 分钟内可见更新;BRAT 用户执行 'Check for updates' 即可获取。"
echo "   提示: 本机 vault 如需立即更新,把 main.js manifest.json 拷入 .obsidian/plugins/gitee-sync-plus/"
