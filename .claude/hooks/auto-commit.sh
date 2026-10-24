#!/bin/bash
# Auto-commit vault changes after Write/Edit operations

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path') or d.get('tool_input',{}).get('filePath') or '')")

# Exit if no file path
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Get relative path from vault root
VAULT_ROOT="$CLAUDE_PROJECT_DIR"
REL_PATH="${FILE_PATH#$VAULT_ROOT/}"

# Only auto-commit vault content directories
case "$REL_PATH" in
  tasks/*|projects/*|people/*|ideas/*|daily/*|weekly/*)
    ;;
  *)
    exit 0
    ;;
esac

# Extract type and filename
FOLDER=$(echo "$REL_PATH" | cut -d'/' -f1)
FILENAME=$(basename "$REL_PATH" .md)

# Convert plural folder to singular for commit message
case "$FOLDER" in
  tasks) TYPE="task" ;;
  projects) TYPE="project" ;;
  people) TYPE="person" ;;
  ideas) TYPE="idea" ;;
  daily) TYPE="daily plan" ;;
  weekly) TYPE="weekly summary" ;;
  *) TYPE="$FOLDER" ;;
esac

cd "$VAULT_ROOT" || exit 0

# Check if file has changes
if git diff --quiet "$FILE_PATH" 2>/dev/null && git diff --cached --quiet "$FILE_PATH" 2>/dev/null; then
  # Check if it's a new untracked file
  if ! git ls-files --error-unmatch "$FILE_PATH" 2>/dev/null; then
    git add "$FILE_PATH"
    git commit -m "cos: new $TYPE - $FILENAME"
  fi
else
  git add "$FILE_PATH"
  git commit -m "cos: update $TYPE - $FILENAME"
fi

exit 0
