#!/bin/bash
# =============================================================================
# Release Script -- Build, tag, publish to npm, create GitHub release
# =============================================================================
# Usage:
#   ./release.sh <new-version>    -- full release from local machine
#   ./release.sh                  -- CI mode (derives version from git tag)
#
# If interrupted, re-run with the same version -- each step is idempotent.
#
# Prerequisites:
#   - Node.js 18+ and npm installed
#   - npm authenticated (npm whoami) or NODE_AUTH_TOKEN set
#   - gh CLI authenticated (or GITHUB_TOKEN set)
# =============================================================================

set -euo pipefail
trap 'echo -e "\n\033[0;31m  x Release failed at line $LINENO (exit code $?)\033[0m"' ERR

# ---- Helpers ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  + $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
fail() { echo -e "${RED}  x $1${NC}"; exit 1; }

TOTAL_STEPS=7

# ---- Resolve version ----
VERSION="${1:-}"
IS_CI="${CI:-false}"

if [ -z "$VERSION" ]; then
  if [ "$IS_CI" = "true" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
    VERSION="${GITHUB_REF_NAME#v}"
    info "CI mode -- version $VERSION from tag $GITHUB_REF_NAME"
  else
    echo "Usage: ./release.sh <version>"
    echo "  e.g. ./release.sh 1.2.0"
    exit 1
  fi
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

# Verify the npm session exists BEFORE any mutating step. Without this,
# the script happily lints, builds, bumps, commits, tags, and pushes --
# then errors at step 5 with E404 from the registry, leaving a tag on
# origin and a half-shipped release. In CI we authenticate via
# NODE_AUTH_TOKEN (set by the workflow), so the check only matters for
# local runs. Observed on the v1.2.9 release (2026-05-19).
if [ "$IS_CI" != "true" ]; then
  if ! NPM_USER=$(npm whoami 2>/dev/null); then
    fail "no npm session -- run 'npm login --auth-type=web' first, or push a tag and let CI publish via release.yml"
  fi
  info "npm session: ${NPM_USER}"
fi

CURRENT_VERSION=$(node -p "require('./package.json').version")
RESUMING=false

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  RESUMING=true
  info "Already at v${VERSION} -- resuming"
else
  if [ "$IS_CI" != "true" ]; then
    if [ -n "$(git status --porcelain)" ]; then
      fail "Working directory not clean. Commit or stash changes first."
    fi
  fi
  info "Current: v${CURRENT_VERSION} -> v${VERSION}"
fi

if [ "$IS_CI" != "true" ] && [ "$RESUMING" != "true" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  echo "  1. Run lint"
  echo "  2. Build + tests"
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

# In CI, ci.yml ran lint as a workflow_call gate before this job started, so
# repeating it here just burns runner minutes. Local runs still lint -- it's
# the only place a developer's pre-publish gate lives.
if [ "$IS_CI" = "true" ]; then
  info "CI mode -- lint already ran in ci.yml gate, skipping"
else
  npm run lint || fail "Lint failed"
  info "Lint passed"
fi

# =============================================================================
# Step 2: Build & test
# =============================================================================
step 2 "Build & test"

# Same logic as step 1: ci.yml's matrix already built and tested on every
# supported Node version. npm publish below also triggers prepublishOnly,
# which builds + tests again, so the artifact is still verified before it
# reaches the registry.
if [ "$IS_CI" = "true" ]; then
  info "CI mode -- build+tests covered by ci.yml gate and prepublishOnly, skipping"
else
  npm run build || fail "Build failed"
  npm test || fail "Tests failed"
  info "Build + tests passed"
fi

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

if [ "$IS_CI" = "true" ]; then
  info "CI mode -- skipping commit/tag/push (already tagged)"
else
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
    # Annotated (-a) so the tag carries metadata (tagger, date, message)
    # and is signing-ready, not because the push relies on it -- the push
    # below is an explicit `git push origin "v${VERSION}"`, so lightweight
    # vs annotated doesn't change whether the tag lands on origin.
    git tag -a "v${VERSION}" -m "v${VERSION}"
    info "Tag v${VERSION} created"
  fi

  # Two pushes, not `git push --follow-tags`: --follow-tags only ships
  # annotated tags reachable from refs that are *actually being updated*,
  # so on a resumed run where main is already on origin (publish failed
  # last time, retry today) the no-op main push wouldn't carry the tag
  # along. The explicit tag push always lands the tag, first run or
  # resume. Annotated-vs-lightweight is a separate concern handled at
  # tag-creation above; here we just need both refs on origin.
  git push origin main
  git push origin "v${VERSION}"
  info "Pushed to origin"
fi

# =============================================================================
# Step 5: Publish to npm
# =============================================================================
step 5 "Publish to npm"

PUBLISHED_VERSION=$(npm view "@yawlabs/electron-mcp@${VERSION}" version 2>/dev/null || echo "")

if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
  info "v${VERSION} already published on npm -- skipping"
else
  if [ "$IS_CI" = "true" ]; then
    npm publish --access public --provenance
  else
    npm publish --access public
  fi
  info "Published @yawlabs/electron-mcp@${VERSION} to npm"
fi

# =============================================================================
# Step 6: Create GitHub release
# =============================================================================
step 6 "Create GitHub release"

if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release v${VERSION} already exists -- skipping"
else
  # Most recent tag reachable from v${VERSION}'s parent. Using git's own
  # ancestry beats sort+grep+tail on tag names: a stray future tag (e.g.
  # someone pre-tagging v2.0.0 ahead of an actual v1.x release) sorts above
  # the current one and corrupts a name-based "previous" lookup. Ancestry
  # walks the commit graph instead. If there's no prior tag (initial
  # release), git describe exits non-zero and PREV_TAG stays empty.
  PREV_TAG=$(git describe --tags --abbrev=0 "v${VERSION}^" 2>/dev/null || echo "")
  if [ -n "$PREV_TAG" ]; then
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

NPM_VERSION=$(npm view "@yawlabs/electron-mcp@${VERSION}" version 2>/dev/null || echo "")
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

# Provenance attestation check — npm attaches sigstore attestations when
# `npm publish --provenance` runs inside GitHub Actions (which is our CI path).
# A missing attestation is not fatal for local runs (we publish without
# --provenance there), but in CI it means something regressed.
if [ "$IS_CI" = "true" ]; then
  ATTEST=$(npm view "@yawlabs/electron-mcp@${VERSION}" dist.attestations.provenance.predicateType 2>/dev/null || echo "")
  if [ -n "$ATTEST" ]; then
    info "provenance attestation: $ATTEST"
  else
    warn "no provenance attestation found on v${VERSION} (expected in CI publish)"
  fi
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
