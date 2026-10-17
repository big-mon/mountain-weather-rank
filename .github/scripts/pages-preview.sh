#!/usr/bin/env bash
# Publish one pull request to gh-pages/pr-<number>/. Asset URLs stay relative.
set -euo pipefail

: "${GITHUB_TOKEN:?}"
: "${GITHUB_REPOSITORY:?}"
: "${PR_NUMBER:?}"
: "${PR_ACTION:?}"

SOURCE_DIR=${SOURCE_DIR:-.}
SITE_URL="https://big-mon.github.io/${GITHUB_REPOSITORY#*/}/pr-${PR_NUMBER}/"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
site="$WORKDIR/site"
basic=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w 0)
echo "::add-mask::${basic}"
auth=( -c "http.extraheader=AUTHORIZATION: basic ${basic}" )

if [[ "${PAGES_PREVIEW_DRY_RUN:-}" != "1" ]]; then
  clone_log=$(mktemp)
  if ! git "${auth[@]}" clone --depth 1 --branch gh-pages "https://github.com/${GITHUB_REPOSITORY}.git" "$site" 2>"$clone_log"; then
    cat "$clone_log" >&2
    if ! grep -q 'not found' "$clone_log"; then
      exit 1
    fi
    rm -rf "$site"
    mkdir -p "$site"
    git -C "$site" init -b gh-pages
    git -C "$site" remote add origin "https://github.com/${GITHUB_REPOSITORY}.git"
  fi
else
  mkdir -p "$site"
  git -C "$site" init -b gh-pages
fi

preview="$site/pr-${PR_NUMBER}"
rm -rf "$preview"
if [[ "$PR_ACTION" != "closed" ]]; then
  mkdir -p "$preview/src"
  cp "$SOURCE_DIR/index.html" "$SOURCE_DIR/styles.css" "$SOURCE_DIR/favicon.svg" "$preview/"
  cp -R "$SOURCE_DIR/src/." "$preview/src/"
  python3 - "$preview/index.html" << 'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
if 'name="robots"' not in text:
    path.write_text(text.replace("<head>", '<head>\n    <meta name="robots" content="noindex">', 1))
PY
  touch "$preview/.nojekyll"
fi

python3 - "$site" << 'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
names = sorted(path.name for path in root.iterdir() if path.is_dir() and path.name.startswith("pr-"))
items = "\n".join(f'<li><a href="./{name}/">{name}</a></li>' for name in names)
root.joinpath("index.html").write_text(
    "<!doctype html>\n"
    '<meta name="robots" content="noindex">\n'
    "<title>previews</title>\n"
    f"<ul>\n{items}\n</ul>\n"
)
root.joinpath(".nojekyll").touch()
PY

if [[ "${PAGES_PREVIEW_DRY_RUN:-}" == "1" ]]; then
  cp -R "$site" "${PAGES_PREVIEW_OUT:?}"
  printf '%s\n' "$SITE_URL"
  exit 0
fi

git -C "$site" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git -C "$site" config user.name "github-actions[bot]"
git -C "$site" add -A
if git -C "$site" rev-parse --verify HEAD >/dev/null 2>&1 && git -C "$site" diff --cached --quiet; then
  echo "No preview changes"
else
  git -C "$site" commit -m "Update GitHub Pages preview for PR ${PR_NUMBER}"
  git -C "$site" "${auth[@]}" push origin HEAD:gh-pages
fi

python3 - "$GITHUB_TOKEN" "$GITHUB_REPOSITORY" "$PR_NUMBER" "$PR_ACTION" "$SITE_URL" << 'PY'
import json, os, sys, urllib.request
token, repo, number, action, url = sys.argv[1:]
marker = "<!-- pages-preview -->"
if action == "closed":
    body = f"{marker}\nPR #{number} の GitHub Pages プレビューは閉じたので削除しました。"
else:
    body = (
        f"{marker}\n"
        f"プレビュー: {url}\n\n"
        "`gh-pages` は GitHub Pages が配信する静的ファイル用のブランチで、アプリの開発ブランチではありません。"
        f"同じリポジトリの各PRは `pr-{number}/` に置きます。末尾の `/` 付きで開いてください。"
        "このURLは、Settings → Pages の Source が "
        "`gh-pages` ブランチの `/` (root) のときに有効です。"
        "GitHub 公式の PR preview（`deploy-pages` の `preview`）はまだ一般公開されていません。"
    )
request = urllib.request.Request(
    f"https://api.github.com/repos/{repo}/issues/{number}/comments?per_page=100",
    headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
)
with urllib.request.urlopen(request) as response:
    comments = json.load(response)
existing = next((comment["id"] for comment in comments if marker in (comment.get("body") or "")), None)
payload = json.dumps({"body": body}).encode()
if existing:
    update = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/issues/comments/{existing}",
        data=payload,
        method="PATCH",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "Content-Type": "application/json"},
    )
else:
    update = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/issues/{number}/comments",
        data=payload,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "Content-Type": "application/json"},
    )
with urllib.request.urlopen(update):
    pass
PY
