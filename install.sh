#!/bin/sh
# kore installer.
#
#     curl -fsSL https://raw.githubusercontent.com/Tiiiktak/kore/main/install.sh | sh
#
# kore is stdlib-only, so this needs nothing but python3 (>= 3.8) and curl or wget — no
# pip, no uv, no virtualenv. It downloads a release source tarball, unpacks it under
# ~/.local/share/kore, and drops a `kore` launcher in ~/.local/bin. Then just run `kore`.
#
# Options (pass after `sh -s --`, e.g. `... | sh -s -- --version v0.3.1`):
#   --version <tag>     install a specific release tag (default: the latest release)
#   --no-modify-path    do not add the bin dir to your shell profile
#   --uninstall         remove the installed kore (keeps your state in ~/.kore)
#
# Environment overrides:
#   KORE_VERSION        same as --version
#   KORE_INSTALL_DIR    where releases are unpacked   (default ~/.local/share/kore)
#   KORE_BIN_DIR        where the `kore` launcher goes (default ~/.local/bin)
#   KORE_PYTHON         python interpreter to use      (default: python3 on PATH)
#   KORE_NO_MODIFY_PATH=1  same as --no-modify-path
#   KORE_REPO           GitHub owner/repo to install from (default Tiiiktak/kore)
#   KORE_INSTALL_FROM   install from a local source checkout instead of downloading (CI)

# Everything lives in main(), called on the last line: a download cut off half-way through
# `curl | sh` then defines a partial function and runs nothing, instead of half an install.

main() {
    set -eu

    REPO="${KORE_REPO:-Tiiiktak/kore}"
    VERSION="${KORE_VERSION:-}"
    INSTALL_DIR="${KORE_INSTALL_DIR:-$HOME/.local/share/kore}"
    BIN_DIR="${KORE_BIN_DIR:-$HOME/.local/bin}"
    MODIFY_PATH=1
    [ "${KORE_NO_MODIFY_PATH:-}" = "1" ] && MODIFY_PATH=0
    UNINSTALL=0

    while [ $# -gt 0 ]; do
        case "$1" in
            --version) [ $# -ge 2 ] || err "--version needs a tag"; VERSION="$2"; shift 2 ;;
            --version=*) VERSION="${1#--version=}"; shift ;;
            --no-modify-path) MODIFY_PATH=0; shift ;;
            --uninstall) UNINSTALL=1; shift ;;
            -h|--help) sed -n '2,24p' "$0" 2>/dev/null || true; return 0 ;;
            *) err "unknown option: $1" ;;
        esac
    done

    if [ "$UNINSTALL" = 1 ]; then
        uninstall
        return 0
    fi

    # -- prerequisites --------------------------------------------------------------
    PY="${KORE_PYTHON:-}"
    if [ -z "$PY" ]; then
        for c in python3 python; do
            if has "$c" && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 8))' 2>/dev/null; then
                PY="$(command -v "$c")"
                break
            fi
        done
    fi
    [ -n "$PY" ] || err "kore needs Python >= 3.8 (python3 not found or too old). Install it, or set KORE_PYTHON."
    "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 8))' 2>/dev/null \
        || err "$PY is older than Python 3.8"
    has tar || err "need tar"

    # -- fetch the source -----------------------------------------------------------
    TMP="$(mktemp -d 2>/dev/null || mktemp -d -t kore)"
    trap 'rm -rf "$TMP"' EXIT INT TERM

    if [ -n "${KORE_INSTALL_FROM:-}" ]; then
        [ -f "$KORE_INSTALL_FROM/kore" ] || err "KORE_INSTALL_FROM=$KORE_INSTALL_FROM is not a kore checkout"
        [ -n "$VERSION" ] || VERSION="local"
        say "installing kore ($VERSION) from local source $KORE_INSTALL_FROM"
        mkdir -p "$TMP/src"
        (cd "$KORE_INSTALL_FROM" && tar --exclude=.git --exclude=dist --exclude='__pycache__' -cf - .) \
            | (cd "$TMP/src" && tar -xf -)
        SRC="$TMP/src"
    else
        if [ -z "$VERSION" ]; then
            VERSION="$(latest_tag)" || err "could not find the latest kore release on github.com/$REPO (network or proxy?). Pin one with --version vX.Y.Z"
        fi
        say "installing kore $VERSION from github.com/$REPO"
        case "$VERSION" in
            v[0-9]*) URL="https://github.com/$REPO/archive/refs/tags/$VERSION.tar.gz" ;;
            *)       URL="https://github.com/$REPO/archive/refs/heads/$VERSION.tar.gz" ;;
        esac
        fetch "$URL" "$TMP/kore.tar.gz" || err "download failed: $URL"
        mkdir -p "$TMP/x"
        tar -xzf "$TMP/kore.tar.gz" -C "$TMP/x" || err "could not unpack $URL"
        SRC="$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
        [ -n "$SRC" ] && [ -f "$SRC/kore" ] || err "downloaded archive does not look like kore"
    fi

    # -- unpack into place ------------------------------------------------------------
    mkdir -p "$INSTALL_DIR/versions" "$BIN_DIR"
    DEST="$INSTALL_DIR/versions/$VERSION"
    rm -rf "$DEST"
    mv "$SRC" "$DEST"
    chmod +x "$DEST/kore"
    # Marker read by `kore upgrade`, so it knows to upgrade by re-running this installer.
    {
        printf 'method=script\n'
        printf 'version=%s\n' "$VERSION"
        printf 'repo=%s\n' "$REPO"
        printf 'bin_dir=%s\n' "$BIN_DIR"
    } > "$DEST/.kore-install"
    ln -sfn "$DEST" "$INSTALL_DIR/current"
    # Keep only the version we just installed.
    for d in "$INSTALL_DIR/versions"/*; do
        [ "$d" = "$DEST" ] || rm -rf "$d"
    done

    # -- the launcher -----------------------------------------------------------------
    cat > "$BIN_DIR/kore" <<EOF
#!/bin/sh
# kore launcher (written by install.sh). Reinstall/upgrade: kore upgrade
exec "$PY" "$INSTALL_DIR/current/kore" "\$@"
EOF
    chmod +x "$BIN_DIR/kore"

    INSTALLED="$("$BIN_DIR/kore" --version 2>/dev/null || echo "kore ?")"

    # -- PATH -------------------------------------------------------------------------
    PATH_NOTE=""
    case ":$PATH:" in
        *":$BIN_DIR:"*) ;;
        *)
            if [ "$MODIFY_PATH" = 1 ]; then
                add_to_path
                PATH_NOTE="added $BIN_DIR to your PATH — open a new shell, or run:
      export PATH=\"$BIN_DIR:\$PATH\""
            else
                PATH_NOTE="$BIN_DIR is not on your PATH — add it:
      export PATH=\"$BIN_DIR:\$PATH\""
            fi
            ;;
    esac

    # -- report -----------------------------------------------------------------------
    say ""
    say "✓ $INSTALLED installed  ($INSTALL_DIR/current, launcher $BIN_DIR/kore)"
    has tmux   || warn "tmux is not on PATH — kore drives Claude Code through tmux; install it."
    has claude || warn "claude (Claude Code CLI) is not on PATH — sessions will not start until it is."
    if [ -n "$PATH_NOTE" ]; then
        say ""
        say "  $PATH_NOTE"
    fi
    say ""
    say "  start it:   kore"
    say ""
}

say()  { printf '%s\n' "$*"; }
warn() { printf 'kore-install: warning: %s\n' "$*" >&2; }
err()  { printf 'kore-install: error: %s\n' "$*" >&2; exit 1; }
has()  { command -v "$1" >/dev/null 2>&1; }

fetch() {  # <url> <dest>
    if has curl; then
        curl -fsSL --retry 3 --connect-timeout 20 -o "$2" "$1"
    elif has wget; then
        wget -q -O "$2" "$1"
    else
        err "need curl or wget"
    fi
}

latest_tag() {
    # github.com/<repo>/releases/latest redirects to .../releases/tag/<tag>; read the tag
    # off the final URL. No API call (no rate limit), no JSON parsing.
    url=""
    if has curl; then
        url="$(curl -fsSLI --retry 3 --connect-timeout 20 -o /dev/null -w '%{url_effective}' \
            "https://github.com/$REPO/releases/latest")" || return 1
    elif has wget; then
        url="$(wget -q -S --spider "https://github.com/$REPO/releases/latest" 2>&1 \
            | sed -n 's/^ *[Ll]ocation: *//p' | tail -n 1 | tr -d '\r')" || return 1
    else
        return 1
    fi
    tag="${url##*/}"
    case "$tag" in
        v[0-9]*) printf '%s' "$tag" ;;
        *) return 1 ;;
    esac
}

add_to_path() {
    line="export PATH=\"$BIN_DIR:\$PATH\"  # added by kore installer"
    touched=0
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
        [ -f "$rc" ] || continue
        grep -qF "added by kore installer" "$rc" 2>/dev/null || printf '\n%s\n' "$line" >> "$rc"
        touched=1
    done
    if [ "$touched" = 0 ]; then
        printf '%s\n' "$line" >> "$HOME/.profile"
    fi
}

uninstall() {
    INSTALL_DIR="${KORE_INSTALL_DIR:-$HOME/.local/share/kore}"
    BIN_DIR="${KORE_BIN_DIR:-$HOME/.local/bin}"
    if [ -x "$BIN_DIR/kore" ]; then
        "$BIN_DIR/kore" down >/dev/null 2>&1 || true
    fi
    rm -rf "$INSTALL_DIR"
    rm -f "$BIN_DIR/kore"
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
        [ -f "$rc" ] || continue
        if grep -qF "added by kore installer" "$rc" 2>/dev/null; then
            grep -vF "added by kore installer" "$rc" > "$rc.kore-tmp" && mv "$rc.kore-tmp" "$rc"
        fi
    done
    say "kore uninstalled. Your state (tokens, logs, registry) is still in ~/.kore — remove it with: rm -rf ~/.kore"
}

main "$@"
