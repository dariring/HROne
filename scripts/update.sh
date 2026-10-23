#!/usr/bin/env bash
# HROne 패널 업데이트: 최신 코드를 받고 install.sh --update 실행.
# 패널 UI 에서 누르면 systemd-run (hrone-update 유닛) 으로 실행되므로 패널이 재시작돼도 끝까지 돈다.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"
# shellcheck disable=SC1091
. /etc/hrone.env
echo "==> $(date '+%F %T') 업데이트 시작"
git -C "$HRONE_DIR" fetch --quiet origin "$HRONE_BRANCH"
git -C "$HRONE_DIR" reset --quiet --hard "origin/$HRONE_BRANCH"
# 실행 중 파일이 바뀌지 않도록 복사본으로 실행
TMP="$(mktemp)"
cp "$HRONE_DIR/install.sh" "$TMP"
trap 'rm -f "$TMP"' EXIT
bash "$TMP" --update
