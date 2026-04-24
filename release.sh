#!/bin/bash
# =============================================================================
# Release Script -- Build, tag, publish to npm, create GitHub release
# =============================================================================
# Usage:
#   ./release.sh <new-version>    # e.g. ./release.sh 1.2.0
#
# If interrupted, re-run with the same version -- each step is idempotent.
#
# Prerequisites:
#   - Node.js 18+ and npm installed
#   - npm authenticated (`npm whoami`) -- run `npm login --auth-type=web` first
#   - gh CLI authenticated (`gh auth status`)
# =============================================================================

set -euo pipefail
trap 'echo -e "\n\033[0;31m  ✗ Release failed at line $LINENO (exit code $?)\033[0m"' ERR

# ---- Helpers ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

TOTAL_STEPS=7

# ---- Resolve version ----
VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: ./release.sh <version>"
  echo "  e.g. ./release.sh 1.2.0"
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version format: $VERSION (expected X.Y.Z)"
fi

# ---- Pre-flight checks ----
echo -e "${CYAN}Pre-flight checks...${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null || fail "node not installed"
command -v npm >/dev/null  || fail "npm not installed"

CURRENT_VERSION=$(node -p "require('./package.json').version")
RESUMING=false

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  RESUMING=true
  info "Already at v${VERSION} -- resuming"
else
  if [ -n "$(git status --porcelain)" ]; then
    fail "Working directory not clean. Commit or stash changes first."
  fi
  info "Current: v${CURRENT_VERSION} -> v${VERSION}"
fi

if [ "$RESUMING" != "true" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  echo "  1. Run lint + tests"
  echo "  2. Build"
  echo "  3. Bump version in package.json"
  echo "  4. Commit, tag, and push"
  echo "  5. Publish to npm"
  echo "  6. Create GitHub release"
  echo "  7. Verify"
  echo ""
  read -p "Continue? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# =============================================================================
# Step 1: Lint
# =============================================================================
step 1 "Lint"

npm run lint || fail "Lint failed"
info "Lint passed"

# =============================================================================
# Step 2: Test
# =============================================================================
step 2 "Test"

npm run build || fail "Build failed"
npm test || fail "Tests failed"
info "All tests passed"

# =============================================================================
# Step 3: Bump version
# =============================================================================
step 3 "Bump version to $VERSION"

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "Already at v${VERSION} -- skipping"
else
  npm version "$VERSION" --no-git-tag-version
  info "Version bumped"
fi

# =============================================================================
# Step 4: Commit, tag, and push
# =============================================================================
step 4 "Commit, tag, and push"

if [ -n "$(git status --porcelain package.json package-lock.json 2>/dev/null)" ]; then
  git add package.json package-lock.json
  git commit -m "v${VERSION}"
  info "Committed version bump"
else
  info "Nothing to commit"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "Tag v${VERSION} already exists"
else
  git tag "v${VERSION}"
  info "Tag v${VERSION} created"
fi

# Push main + the tag. --follow-tags only pushes annotated tags, so push the
# tag explicitly to cover lightweight tags too.
git push origin main
git push origin "v${VERSION}"
info "Pushed to origin"

# =============================================================================
# Step 5: Publish to npm
# =============================================================================
step 5 "Publish to npm"

PUBLISHED_VERSION=$(npm view @yawlabs/electron-mcp version 2>/dev/null || echo "")

if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
  info "v${VERSION} already published on npm -- skipping"
else
  npm publish --access public
  info "Published @yawlabs/electron-mcp@${VERSION} to npm"
fi

# =============================================================================
# Step 6: Create GitHub release
# =============================================================================
step 6 "Create GitHub release"

if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release v${VERSION} already exists -- skipping"
else
  PREV_TAG=$(git tag --sort=-v:refname | grep -A1 "^v${VERSION}$" | tail -1)
  if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "v${VERSION}" ]; then
    CHANGELOG=$(git log --oneline "${PREV_TAG}..v${VERSION}" --no-decorate | sed 's/^[a-f0-9]* /- /')
  else
    CHANGELOG="Initial release"
  fi

  gh release create "v${VERSION}" \
    --title "v${VERSION}" \
    --notes "$CHANGELOG"
  info "GitHub release created"
fi

# =============================================================================
# Step 7: Verify
# =============================================================================
step 7 "Verify"

sleep 3

NPM_VERSION=$(npm view @yawlabs/electron-mcp version 2>/dev/null || echo "")
if [ "$NPM_VERSION" = "$VERSION" ]; then
  info "npm: @yawlabs/electron-mcp@${NPM_VERSION}"
else
  warn "npm shows ${NPM_VERSION:-nothing} (expected $VERSION -- may still be propagating)"
fi

PKG_VERSION=$(node -p "require('./package.json').version")
if [ "$PKG_VERSION" = "$VERSION" ]; then
  info "package.json: ${PKG_VERSION}"
else
  warn "package.json shows ${PKG_VERSION} (expected $VERSION)"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "git tag: v${VERSION}"
else
  warn "git tag v${VERSION} not found"
fi

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${GREEN}  v${VERSION} released successfully!${NC}"
echo ""
echo -e "  npm: https://www.npmjs.com/package/@yawlabs/electron-mcp"
echo -e "  git: https://github.com/YawLabs/electron-mcp/releases/tag/v${VERSION}"
echo ""
