#!/usr/bin/env bash
# HROne 설치 / 업데이트 스크립트
#
#   curl -fsSL https://raw.githubusercontent.com/dariring/HROne/main/install.sh | sudo bash
#
# 다시 실행하면 업데이트(복구)로 동작하고, 데이터(/var/lib/hrone)는 건드리지 않습니다.
# 환경변수로 바꿀 수 있는 값: HRONE_REPO, HRONE_BRANCH, HRONE_DIR, HRONE_DATA, HRONE_PORT
set -euo pipefail

main() {
  # 우선순위: 실행할 때 준 환경변수 > 기존 설치 값(/etc/hrone.env) > 기본값
  saved() { [ -f /etc/hrone.env ] && grep -E "^$1=" /etc/hrone.env | head -1 | cut -d= -f2- || true; }
  local HRONE_REPO="${HRONE_REPO:-$(saved HRONE_REPO)}"
  local HRONE_BRANCH="${HRONE_BRANCH:-$(saved HRONE_BRANCH)}"
  local HRONE_DIR="${HRONE_DIR:-$(saved HRONE_DIR)}"
  local HRONE_DATA="${HRONE_DATA:-$(saved HRONE_DATA)}"
  HRONE_REPO="${HRONE_REPO:-https://github.com/dariring/HROne.git}"
  HRONE_BRANCH="${HRONE_BRANCH:-main}"
  HRONE_DIR="${HRONE_DIR:-/opt/hrone}"
  HRONE_DATA="${HRONE_DATA:-/var/lib/hrone}"
  local HRONE_PORT="${HRONE_PORT:-}"
  local NODE_MAJOR=24
  local MODE="install"
  [ "${1:-}" = "--update" ] && MODE="update"

  step() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
  info() { printf '    %s\n' "$*"; }
  die() {
    printf '\n\033[1;31m오류:\033[0m %s\n' "$*" >&2
    exit 1
  }

  [ "$(id -u)" -eq 0 ] || die "root 권한이 필요합니다:  curl -fsSL ... | sudo bash"
  [ -d /run/systemd/system ] || die "systemd 로 부팅된 시스템이 필요합니다 (LXC 는 systemd 가 PID 1 이어야 함)"
  [ -f /etc/os-release ] || die "/etc/os-release 가 없습니다"
  # shellcheck disable=SC1091
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in
    *" debian "* | *" ubuntu "*) ;;
    *) die "Debian / Ubuntu 계열만 지원합니다 (현재: ${PRETTY_NAME:-unknown})" ;;
  esac
  local NARCH
  case "$(uname -m)" in
    x86_64 | amd64) NARCH=x64 ;;
    aarch64 | arm64) NARCH=arm64 ;;
    *) die "지원하지 않는 CPU: $(uname -m)" ;;
  esac
  local VIRT
  VIRT="$(systemd-detect-virt 2>/dev/null || true)"

  if [ "$MODE" = "install" ]; then
    printf '\033[1;35m'
    cat <<'BANNER'
  _   _ ____   ___
 | | | |  _ \ / _ \ _ __   ___
 | |_| | |_) | | | | '_ \ / _ \
 |  _  |  _ <| |_| | | | |  __/
 |_| |_|_| \_\\___/|_| |_|\___|
BANNER
    printf '\033[0m'
    info "${PRETTY_NAME} · ${NARCH} · 가상화: ${VIRT:-none}"
  fi

  # ---------- 1. 패키지 ----------
  step "기본 패키지 설치"
  local PKGS=(git curl ca-certificates xz-utils tar gzip build-essential python3 iproute2 procps openssh-client util-linux)
  local MISSING=()
  for p in "${PKGS[@]}"; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed" || MISSING+=("$p")
  done
  if [ ${#MISSING[@]} -gt 0 ]; then
    export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
    info "설치: ${MISSING[*]}"
    local LOG=/var/log/hrone-install.log
    if ! { apt-get update -q && apt-get install -y -q --no-install-recommends "${MISSING[@]}"; } >>"$LOG" 2>&1; then
      tail -20 "$LOG" >&2
      die "패키지 설치 실패 (전체 로그: $LOG)"
    fi
  else
    info "이미 설치됨"
  fi

  mkdir -p "$HRONE_DATA"/{runtimes/node,runtimes/bin,apps,appdata,databases,backups,logs/deploys,tmp}
  chmod 711 "$HRONE_DATA"
  chmod 700 "$HRONE_DATA/backups"

  # ---------- 2. Node.js ----------
  step "Node.js ${NODE_MAJOR} (패널용) 준비"
  local SUMS FILE VER
  SUMS="$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt")" || die "nodejs.org 에 접속할 수 없습니다"
  FILE="$(printf '%s\n' "$SUMS" | awk '{print $2}' | grep -E "^node-v[0-9.]+-linux-${NARCH}\.tar\.xz$" | head -1)"
  [ -n "$FILE" ] || die "Node.js 다운로드 파일을 찾지 못했습니다"
  VER="$(printf '%s' "$FILE" | sed -E 's/^node-(v[0-9.]+)-.*/\1/')"
  local NODE_HOME="$HRONE_DATA/runtimes/node/$VER"
  if [ ! -x "$NODE_HOME/bin/node" ]; then
    local TMPD
    TMPD="$(mktemp -d)"
    info "내려받는 중: $FILE"
    curl -fsSL -o "$TMPD/$FILE" "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$FILE"
    (cd "$TMPD" && printf '%s\n' "$SUMS" | grep " $FILE\$" | sha256sum -c --quiet -) || die "Node.js 체크섬 불일치"
    mkdir -p "$NODE_HOME.partial"
    tar -xJf "$TMPD/$FILE" -C "$NODE_HOME.partial" --strip-components=1 --no-same-owner
    rm -rf "$NODE_HOME" && mv "$NODE_HOME.partial" "$NODE_HOME"
    chmod -R a+rX "$NODE_HOME"
    rm -rf "$TMPD"
  fi
  ln -sfn "$NODE_HOME" "$HRONE_DATA/runtimes/node-panel"
  "$NODE_HOME/bin/corepack" enable >/dev/null 2>&1 || true
  info "$("$NODE_HOME/bin/node" -v)"
  export PATH="$NODE_HOME/bin:$PATH"

  # ---------- 3. uv (Python) ----------
  if [ ! -x "$HRONE_DATA/runtimes/bin/uv" ]; then
    step "uv (Python 패키지/버전 관리자) 설치"
    local UVT
    [ "$NARCH" = "arm64" ] && UVT=aarch64-unknown-linux-gnu || UVT=x86_64-unknown-linux-gnu
    local TMPU
    TMPU="$(mktemp -d)"
    if curl -fsSL -o "$TMPU/uv.tar.gz" "https://github.com/astral-sh/uv/releases/latest/download/uv-${UVT}.tar.gz"; then
      tar -xzf "$TMPU/uv.tar.gz" -C "$TMPU" --strip-components=1 --no-same-owner
      install -m 755 "$TMPU/uv" "$HRONE_DATA/runtimes/bin/uv"
      [ -f "$TMPU/uvx" ] && install -m 755 "$TMPU/uvx" "$HRONE_DATA/runtimes/bin/uvx"
      info "$("$HRONE_DATA/runtimes/bin/uv" --version)"
    else
      info "uv 다운로드 실패 — Python 앱을 처음 배포할 때 다시 시도합니다"
    fi
    rm -rf "$TMPU"
  fi

  # ---------- 4. 소스 ----------
  step "HROne 내려받기 → $HRONE_DIR"
  if [ -d "$HRONE_DIR/.git" ]; then
    git -C "$HRONE_DIR" remote set-url origin "$HRONE_REPO"
    git -C "$HRONE_DIR" fetch --quiet origin "$HRONE_BRANCH"
    git -C "$HRONE_DIR" reset --quiet --hard "origin/$HRONE_BRANCH"
  else
    rm -rf "$HRONE_DIR"
    git clone --quiet --branch "$HRONE_BRANCH" "$HRONE_REPO" "$HRONE_DIR"
  fi
  info "$(git -C "$HRONE_DIR" log -1 --format='%h %s')"

  # ---------- 5. 빌드 ----------
  step "의존성 설치 + 웹 UI 빌드"
  cd "$HRONE_DIR"
  export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
  npm ci --include=dev --loglevel=error
  # 다른 폴더에 다 빌드한 뒤 바꿔치기 (빌드가 실패해도 지금 화면은 그대로 남는다)
  rm -rf web/dist.new
  npm run build --silent -- --outDir dist.new
  [ -f web/dist.new/index.html ] || die "웹 UI 빌드 결과가 없습니다"
  rm -rf web/dist
  mv web/dist.new web/dist
  npm prune --omit=dev --loglevel=error

  # ---------- 6. systemd ----------
  step "systemd 서비스 등록"
  cat >/etc/hrone.env <<EOF
HRONE_REPO=$HRONE_REPO
HRONE_BRANCH=$HRONE_BRANCH
HRONE_DIR=$HRONE_DIR
HRONE_DATA=$HRONE_DATA
EOF
  cat >/etc/systemd/system/hrone.service <<EOF
# HROne 웹 패널 (install.sh 가 생성)
[Unit]
Description=HROne 웹 패널
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HRONE_DATA=$HRONE_DATA
Environment=NODE_ENV=production
WorkingDirectory=$HRONE_DIR
ExecStart=$HRONE_DATA/runtimes/node-panel/bin/node --disable-warning=ExperimentalWarning $HRONE_DIR/server/main.ts
Restart=always
RestartSec=3
LimitNOFILE=65536
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
  # 앱 로그(콘솔)는 journald 에 저장 → 재부팅해도 남도록 영구 저장
  mkdir -p /etc/systemd/journald.conf.d /var/log/journal
  if [ ! -f /etc/systemd/journald.conf.d/hrone.conf ]; then
    cat >/etc/systemd/journald.conf.d/hrone.conf <<'EOF'
# HROne: 앱 콘솔 로그 보관
[Journal]
Storage=persistent
SystemMaxUse=2G
EOF
    systemctl restart systemd-journald || true
  fi
  ln -sfn "$HRONE_DIR/scripts/hrone" /usr/local/bin/hrone
  chmod +x "$HRONE_DIR/scripts/hrone" "$HRONE_DIR/scripts/"*.sh
  cat >/etc/profile.d/hrone.sh <<EOF
# HROne 이 설치한 node / uv 를 셸에서도 쓸 수 있게 (기존 PATH 가 우선)
export PATH="\$PATH:$HRONE_DATA/runtimes/node-panel/bin:$HRONE_DATA/runtimes/bin"
EOF

  local CLI=("$NODE_HOME/bin/node" --disable-warning=ExperimentalWarning "$HRONE_DIR/server/cli.ts")
  export HRONE_DATA
  [ -n "$HRONE_PORT" ] && "${CLI[@]}" set-port "$HRONE_PORT" >/dev/null
  local CREDS
  CREDS="$("${CLI[@]}" ensure-admin)"

  systemctl daemon-reload
  systemctl enable hrone >/dev/null 2>&1
  systemctl restart hrone

  step "패널 시작 확인"
  local PORT
  PORT="$("${CLI[@]}" info | grep -oE '127\.0\.0\.1:[0-9]+' | head -1 | cut -d: -f2)"
  local ok=0
  for _ in $(seq 1 40); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/api/auth/state" 2>/dev/null; then
      ok=1
      break
    fi
    sleep 0.5
  done
  [ "$ok" = 1 ] || die "패널이 응답하지 않습니다:  journalctl -u hrone -n 50"
  info "실행 중 (포트 $PORT)"

  if [ "$MODE" = "update" ]; then
    printf '\n\033[1;32m업데이트 완료\033[0m (%s)\n' "$(git -C "$HRONE_DIR" log -1 --format='%h %s')"
    return
  fi

  printf '\n\033[1;32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m\n'
  printf '\033[1;32m HROne 설치 완료\033[0m\n\n'
  printf ' 접속 주소:\n'
  "${CLI[@]}" info | sed '1d'
  if printf '%s' "$CREDS" | grep -q '^NEW '; then
    local PW
    PW="$(printf '%s' "$CREDS" | awk '{print $3}')"
    printf '\n 관리자 계정:  \033[1madmin\033[0m / \033[1;33m%s\033[0m\n' "$PW"
    printf ' (로그인하면 홈 화면의 "시작하기" 목록이 다음 할 일을 알려 줍니다)\n'
  fi
  printf '\n 다음 단계:\n'
  # 이미 설치된 것은 빼고 번호를 매긴다
  local n=0
  if ! command -v tailscale >/dev/null 2>&1; then
    n=$((n + 1))
    printf '   %d) Tailscale:   curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up\n' "$n"
  fi
  if ! command -v cloudflared >/dev/null 2>&1; then
    n=$((n + 1))
    printf '   %d) cloudflared: 앱 포트(127.0.0.1:PORT)를 터널 public hostname 에 연결\n' "$n"
  fi
  printf '   관리 명령:      hrone help\n'
  printf '\033[1;32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m\n'
}

# 함수 전체를 먼저 읽은 뒤 실행하므로, 실행 중에 이 파일이 git 으로 바뀌어도 안전
main "$@"
