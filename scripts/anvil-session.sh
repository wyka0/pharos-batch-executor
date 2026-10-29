#!/usr/bin/env bash
set -eu
pid_file="$1"
shift
# Used only to stop this exact disposable process; never contains a secret.
printf '%s\n' "$$" > "$pid_file"
if [ "$1" = "__default_anvil__" ]; then
  shift
  exec "$HOME/.foundry/bin/anvil" "$@"
fi
exec "$@"
