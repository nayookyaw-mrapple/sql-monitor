#!/usr/bin/env bash
# Writes a Markdown summary of a range of commits: who, when, message and the files each one changed.
# Usage: commit-summary.sh <from> <to>     (<from> may be empty: then only <to> itself is summarised)
# Used by .github/workflows/commit-summary.yml, and can be run locally: .github/scripts/commit-summary.sh main HEAD
set -euo pipefail

FROM="${1:-}"
TO="${2:-HEAD}"
MAX_FILES=200 # per commit; longer lists are cut so the summary stays under GitHub's size limit

EMPTY_TREE=$(git hash-object -t tree /dev/null)

if [ -n "$FROM" ]; then
  mapfile -t COMMITS < <(git rev-list --reverse "$FROM..$TO")
  DIFF_FROM="$FROM"
else
  COMMITS=("$(git rev-parse "$TO")")
  DIFF_FROM=$(git rev-parse -q --verify "$TO~1" || echo "$EMPTY_TREE")
fi

# Make text safe inside a Markdown table cell.
cell() { sed -e 's/\\/\\\\/g' -e 's/|/\\|/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

status_word() {
  case "$1" in
    A) echo "Added" ;;
    M) echo "Modified" ;;
    D) echo "Deleted" ;;
    T) echo "Type changed" ;;
    *) echo "$1" ;;
  esac
}

echo "## Commit summary"
echo

if [ "${#COMMITS[@]}" -eq 0 ]; then
  echo "No new commits in this range."
  exit 0
fi

read -r FILES_CHANGED ADDED REMOVED < <(
  git diff --numstat --no-renames "$DIFF_FROM" "$TO" | awk '{ f++; if ($1 != "-") { a += $1; r += $2 } } END { print f + 0, a + 0, r + 0 }'
)
AUTHORS=$(for c in "${COMMITS[@]}"; do git show -s --format='%an' "$c"; done | sort -u | paste -sd ',' - | sed 's/,/, /g' | cell)

echo "**${#COMMITS[@]}** commit(s) by **${AUTHORS}** · **${FILES_CHANGED}** file(s) changed · **+${ADDED}** / **-${REMOVED}** lines"
echo
echo "| Commit | Who | When | Message |"
echo "| --- | --- | --- | --- |"
for c in "${COMMITS[@]}"; do
  short=$(git show -s --format='%h' "$c")
  who=$(git show -s --format='%an' "$c" | cell)
  when=$(git show -s --format='%ad' --date=iso "$c")
  subject=$(git show -s --format='%s' "$c" | cell)
  echo "| \`${short}\` | ${who} | ${when} | ${subject} |"
done
echo

for c in "${COMMITS[@]}"; do
  short=$(git show -s --format='%h' "$c")
  subject=$(git show -s --format='%s' "$c" | cell)
  who=$(git show -s --format='%an' "$c" | cell)
  when=$(git show -s --format='%ad' --date=iso "$c")
  # -m --first-parent: a merge commit is shown as what it brought into the branch.
  numstat=$(git show -m --first-parent --format= --numstat --no-renames "$c")
  namestatus=$(git show -m --first-parent --format= --name-status --no-renames "$c")
  count=$(printf '%s\n' "$numstat" | grep -c . || true)

  echo "<details>"
  echo "<summary><code>${short}</code> ${subject} — ${who}, ${when} — ${count} file(s)</summary>"
  echo
  # Shown as-is inside a code block, so no escaping (a line of tildes would end the block early, so those are dropped).
  body=$(git show -s --format='%b' "$c" | grep -v '^~~~' || true)
  if [ -n "$body" ]; then
    echo '~~~~text'
    printf '%s\n' "$body"
    echo '~~~~'
    echo
  fi
  if [ "$count" -eq 0 ]; then
    echo "No file changes."
  else
    echo "| Change | File | Added | Removed |"
    echo "| --- | --- | ---: | ---: |"
    paste <(printf '%s\n' "$namestatus" | cut -f1) <(printf '%s\n' "$numstat") | head -n "$MAX_FILES" |
      while IFS=$'\t' read -r st add del path; do
        [ -n "$path" ] || continue
        if [ "$add" = "-" ]; then add="binary"; del=""; fi
        echo "| $(status_word "$st") | \`$(printf '%s' "$path" | cell)\` | ${add} | ${del} |"
      done
    if [ "$count" -gt "$MAX_FILES" ]; then
      echo
      echo "…and $((count - MAX_FILES)) more file(s)."
    fi
  fi
  echo
  echo "</details>"
  echo
done
