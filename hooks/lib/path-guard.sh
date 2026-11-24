# Paths that must never be committed or pushed: secrets, and build output that
# `git add -A` would sweep in whole. Sourced by pre-commit (what is staged) and
# pre-push (what is about to leave the machine). Not a hook itself: git runs only
# files named after a hook, so nothing in lib/ runs on its own.
#
# The check runs twice on purpose. A secret committed with --no-verify, or
# inherited on a branch from another clone, reaches the remote through push, so
# the second look is the last one.
#
# Patterns use shell `case` matching, where `*` also matches `/`.

# Sets $kind to the kind of forbidden path $1 is: "secret", "bulk", "log", or empty.
# A variable, not output, so a staged node_modules costs no subshell per path.
path_guard_kind() {
  kind=""
  case $1 in
    # Templates carry names, not values: a committed .env.example is the point.
    *.example | *.sample | *.template) ;;
    .env | .env.* | */.env | */.env.* | *serviceAccount*.json | *service-account*.json | *adminsdk*.json | \
      *.pem | id_rsa* | */id_rsa* | *credentials.json | *.key)
      kind=secret
      return
      ;;
  esac
  # Build output is judged by the top-level directory only, so src/build/ stays source.
  case ${1%%/*} in
    .next* | node_modules | dist | build | coverage | .turbo)
      kind=bulk
      return
      ;;
  esac
  # A log is never source, so like a secret it is refused at any depth.
  case $1 in
    *.log) kind=log ;;
  esac
}

# Reads repo-relative paths on stdin. When any is forbidden, prints a refusal
# naming each one and the override to stderr and returns 1; otherwise returns 0.
# $1 names what is refused ("Commit", "Push"), $2 how to take the paths out, and
# $3 the command the override goes on.
path_guard_check() {
  if [ "${GUARDRAILS_ALLOW_PATHS:-}" = "1" ]; then
    cat >/dev/null
    return 0
  fi
  hits=$(
    while IFS= read -r p; do
      path_guard_kind "$p"
      case $kind/$p in
        secret/*) printf '    %-36s secret\n' "$p" ;;
        # One line per build directory: node_modules alone can be thousands of paths.
        bulk/*/*) printf '    %-36s build output\n' "${p%%/*}/" ;;
        bulk/*) printf '    %-36s build output\n' "$p" ;;
        log/*) printf '    %-36s log\n' "$p" ;;
      esac
    done | sort -u
  )
  [ -z "$hits" ] && return 0
  printf '\n  ✗ %s refused: these paths must never be committed or pushed.\n\n%s\n\n' "$1" "$hits" >&2
  printf '  %s, and add them to .gitignore.\n' "$2" >&2
  printf '  Templates (*.example, *.sample, *.template) are allowed.\n' >&2
  printf '  Meant it? Override once:  GUARDRAILS_ALLOW_PATHS=1 %s\n\n' "$3" >&2
  return 1
}
