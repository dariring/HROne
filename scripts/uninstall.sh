#!/usr/bin/env bash
# HROne 제거. 기본은 데이터(/var/lib/hrone: 앱 코드, DB, 백업)를 남긴다. --purge 면 전부 삭제.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || exec sudo "$0" "$@"
# shellcheck disable=SC1091
. /etc/hrone.env
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

echo "HROne 패널과 모든 앱/DB 서비스를 중지하고 제거합니다."
[ "$PURGE" = 1 ] && echo -e "\033[1;31m--purge: $HRONE_DATA (앱 코드, DB 데이터, 백업) 도 전부 삭제됩니다!\033[0m"
read -r -p "계속하려면 '삭제' 를 입력하세요: " ans </dev/tty
[ "$ans" = "삭제" ] || { echo "취소했습니다."; exit 1; }

for u in $(systemctl list-unit-files --no-legend 'hrone-app-*' 'hrone-db-*' | awk '{print $1}'); do
  systemctl disable --now "$u" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$u"
done
systemctl disable --now hrone >/dev/null 2>&1 || true
rm -f /etc/systemd/system/hrone.service /etc/systemd/system/hrone.slice /etc/systemd/system/hrone-apps.slice /etc/systemd/system/hrone-dbs.slice
systemctl daemon-reload
for u in $(getent passwd | cut -d: -f1 | grep '^hr-' || true); do userdel "$u" >/dev/null 2>&1 || true; done
rm -f /usr/local/bin/hrone /etc/profile.d/hrone.sh /etc/systemd/journald.conf.d/hrone.conf /etc/sysctl.d/90-hrone.conf
rm -rf "$HRONE_DIR"
if [ "$PURGE" = 1 ]; then
  rm -rf "$HRONE_DATA"
  echo "데이터까지 모두 삭제했습니다."
else
  echo "데이터는 $HRONE_DATA 에 남겨 두었습니다. 다시 설치하면 그대로 이어서 씁니다."
fi
rm -f /etc/hrone.env
echo "제거 완료."
