#!/bin/bash
set -euo pipefail

# Mechanical helper for the sync-matt-pocock-skills skill.
#
# Usage:
#   sync-upstream-skills.sh                  # review mode: fetch upstream,
#                                            # write SUMMARY.md + diffs/, touch nothing
#   sync-upstream-skills.sh --apply          # mirror ALL upstream skills into
#                                            # skills/matt-pocock/ (incl. removing
#                                            # skills upstream dropped)
#   sync-upstream-skills.sh --apply s1 s2    # mirror only the named skills
#
# Never stages anything. The caller reviews `git status` and commits.
# Layout mapping lives here, not in SKILL.md: upstream
# skills/<engineering|productivity>/<skill> <-> local skills/matt-pocock/<skill>.

REPO=$(git rev-parse --show-toplevel)
cd "$REPO"

REMOTE=skills-upstream
URL=https://github.com/mattpocock/skills.git
TARGET=skills/matt-pocock
OUT=.scratch/skills-sync

APPLY=0
SELECTED=()
if [ "${1:-}" = "--apply" ]; then
  APPLY=1
  shift
  SELECTED=("$@")
fi

# --- Fetch -------------------------------------------------------------------
# Guard: the review compares committed trees (HEAD vs upstream), and --apply
# overwrites working files. Uncommitted changes under the mirror make both lie.
if [ -n "$(git status --porcelain -- "$TARGET")" ]; then
  echo "ERROR: uncommitted changes under $TARGET — commit or stash them first." >&2
  exit 1
fi

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  git remote add "$REMOTE" "$URL"
fi
git fetch "$REMOTE" main --no-tags --quiet
REV=$(git rev-parse --short "$REMOTE/main")

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git archive "$REMOTE/main" skills | tar -x -C "$TMP"
UP="$TMP"

# Upstream skill name -> category dir (first match wins)
category_for() {
  for cat in engineering productivity; do
    [ -d "$UP/skills/$cat/$1" ] && { echo "$cat"; return; }
  done
  return 1
}

mapfile -t UPSTREAM_SKILLS < <(
  { ls "$UP/skills/engineering" 2>/dev/null; ls "$UP/skills/productivity" 2>/dev/null; } \
    | grep -v '^README.md$' | sort -u
)

mapfile -t LOCAL_SKILLS < <(
  { [ -d "$TARGET" ] && ls "$TARGET"; } 2>/dev/null | sort -u
)

# --- Apply mode --------------------------------------------------------------
if [ "$APPLY" = 1 ]; then
  if [ "${#SELECTED[@]}" -gt 0 ] && [ -n "${SELECTED[0]:-}" ]; then
    todo=("${SELECTED[@]}")
  else
    todo=("${UPSTREAM_SKILLS[@]}")
  fi

  for s in "${todo[@]}"; do
    cat=$(category_for "$s") || { echo "skip $s: not found upstream" >&2; continue; }
    rm -rf "$TARGET/$s"
    mkdir -p "$TARGET/$s"
    rsync -a --delete "$UP/skills/$cat/$s/" "$TARGET/$s/"
    echo "applied $s (from skills/$cat/$s)"
  done

  # Full mirror: drop local skills that no longer exist upstream.
  if [ "${#SELECTED[@]}" -eq 0 ]; then
    for s in "${LOCAL_SKILLS[@]}"; do
      if ! category_for "$s" >/dev/null; then
        echo "removed $TARGET/$s (dropped upstream)"
        rm -rf "$TARGET/$s"
      fi
    done
  fi

  echo
  echo "Done at upstream $REV. Review with git status, then commit."
  exit 0
fi

# --- Review mode -------------------------------------------------------------
rm -rf "$OUT"
mkdir -p "$OUT/diffs"

summary="$OUT/SUMMARY.md"
{
  echo "# Upstream sync review — mattpocock/skills@$REV"
  echo
  echo "Upstream commit: \`$REV\`. Diffs are local (HEAD) vs upstream, \`agents/\` metadata excluded."
} > "$summary"

changed=0; added_new=0; same=0

echo "## Changed" >> "$summary"
for s in "${UPSTREAM_SKILLS[@]}"; do
  cat=$(category_for "$s")
  if ! git cat-file -e "HEAD:$TARGET/$s/SKILL.md" 2>/dev/null; then
    echo "- **$s** (upstream \`skills/$cat/$s\`) — NEW, not in local repo" >> "$summary"
    cp "$UP/skills/$cat/$s/SKILL.md" "$OUT/diffs/$s.new.md" 2>/dev/null || true
    added_new=$((added_new + 1))
    continue
  fi
  stat=$(git diff "HEAD:$TARGET/$s" "$REMOTE/main:skills/$cat/$s" -- . ':(exclude)agents' \
    | grep -c '^[+-][^+-]') || stat=0
  if [ "$stat" -eq 0 ]; then
    same=$((same + 1))
    continue
  fi
  changed=$((changed + 1))
  nums=$(git diff "HEAD:$TARGET/$s" "$REMOTE/main:skills/$cat/$s" --numstat -- . ':(exclude)agents' \
    | awk '{a+=$1; d+=$2; f++} END {print f" file(s), +"a+0" -"d+0}')
  echo "- **$s** ($cat): $nums → diffs/$s.diff" >> "$summary"
  git diff "HEAD:$TARGET/$s" "$REMOTE/main:skills/$cat/$s" -- . ':(exclude)agents' \
    > "$OUT/diffs/$s.diff"
done

if [ "$added_new" -eq 0 ]; then echo "- (none)" >> "$summary"; fi

echo >> "$summary"
echo "## Local-only (no upstream counterpart — leave alone unless the user says otherwise)" >> "$summary"
local_only=0
for s in "${LOCAL_SKILLS[@]}"; do
  if ! category_for "$s" >/dev/null; then
    echo "- $s" >> "$summary"
    local_only=$((local_only + 1))
  fi
done
[ "$local_only" -eq 0 ] && echo "- (none)" >> "$summary"

echo >> "$summary"
echo "## Up to date" >> "$summary"
[ "$same" -eq 0 ] && echo "- (none)" >> "$summary"
for s in "${UPSTREAM_SKILLS[@]}"; do
  cat=$(category_for "$s")
  if git cat-file -e "HEAD:$TARGET/$s/SKILL.md" 2>/dev/null; then
    n=$(git diff "HEAD:$TARGET/$s" "$REMOTE/main:skills/$cat/$s" -- . ':(exclude)agents' \
      | grep -c '^[+-][^+-]') || n=0
    [ "$n" -eq 0 ] && echo "- $s" >> "$summary"
  fi
done

echo "Review material written to $OUT"
echo "  SUMMARY.md + diffs/ ($(ls "$OUT/diffs" 2>/dev/null | wc -l | tr -d ' ') files)"
