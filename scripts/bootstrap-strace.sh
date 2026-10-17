#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "$0")/.." && pwd)"
if [[ -x "$project_dir/.tools/bin/strace" ]]; then
  "$project_dir/.tools/bin/strace" -V
  exit 0
fi
for dependency in curl sha256sum tar make cc; do
  command -v "$dependency" >/dev/null || { echo "Missing build dependency: $dependency" >&2; exit 1; }
done
mkdir -p "$project_dir/.tools/src"
build_dir="$(mktemp -d "$project_dir/.tools/src/strace-build.XXXXXXXX")"
trap 'rm -rf "$build_dir"' EXIT
curl --proto '=https' --tlsv1.2 --fail --location \
  https://github.com/strace/strace/releases/download/v7.2/strace-7.2.tar.xz \
  --output "$build_dir/strace.tar.xz"
(cd "$build_dir" && echo '4bde6246926890dcee824f6e6ac42a06752f47d77e5097d86e3c0d6d4b709fe5  strace.tar.xz' | sha256sum --check)
tar -xJf "$build_dir/strace.tar.xz" -C "$build_dir"
cd "$build_dir/strace-7.2"
./configure --prefix="$project_dir/.tools" --enable-mpers=no
make -j4
make install
"$project_dir/.tools/bin/strace" -V
