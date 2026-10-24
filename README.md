# HROne

GitHub에 푸시하면 Node.js / Python 앱을 알아서 배포해 주는 셀프 호스팅 웹 패널입니다.
MariaDB·Redis 인스턴스를 같이 돌리고, VM이든 LXC든 똑같이 동작합니다.

```bash
curl -fsSL https://raw.githubusercontent.com/dariring/HROne/main/install.sh | sudo bash
```

설치가 끝나면 접속 주소와 관리자 비밀번호가 출력됩니다. 그다음 Tailscale과 cloudflared를 설치하면 바로 쓸 수 있습니다.

---

## 무엇을 하나요

| 기능 | 설명 |
| --- | --- |
| **푸시 자동 배포** | 폴링(기본 60초) 또는 GitHub 웹후크로 새 커밋을 감지합니다. 앱마다 **즉시 / N초·분 뒤 / 검토 후 승인** 중 하나를 고릅니다. 지연 중에 또 푸시가 오면 타이머가 다시 시작됩니다. |
| **git pull처럼, 데이터는 안전하게** | `git clean` 없이 해당 커밋으로 맞추기만 하므로 SQLite·업로드처럼 저장소에 없는 파일은 건드리지 않습니다. 보존 경로(`*.db`, `/data/`, `.env` 등)는 저장소에 같은 파일이 생겨도 서버 쪽 파일을 유지합니다. 덮어써질 파일은 배포 직전에 자동으로 백업합니다. |
| **실패하면 자동 롤백** | 새 버전이 시작에 실패하거나 헬스체크를 통과하지 못하면 이전 커밋으로 되돌리고 디스코드로 알립니다. |
| **앱 제어** | 시작 / 재시작 / 정지 / 강제 종료(SIGKILL) / **삭제(Terminate)**. 삭제는 2단계로 확인합니다(앱 ID 직접 입력 + 비밀번호·OTP 재확인). 지우기 전에 최종 백업을 남깁니다. |
| **실시간 콘솔** | journald 기반이라 재부팅해도 로그가 남습니다. 검색, 일시정지, ANSI 색, 내려받기를 지원합니다. |
| **환경변수** | 표 또는 `.env` 텍스트로 편집합니다. 연결한 DB의 접속 정보(`DATABASE_URL`, `REDIS_URL` …)는 자동으로 들어갑니다. |
| **MariaDB / Redis** | DB마다 독립 인스턴스를 띄웁니다(포트, 데이터 폴더, 계정, 자동 시작이 각각 따로). 연결 제한은 **버튼 하나로 해제**할 수 있고(재시작 없이 적용) 차단된 호스트는 `FLUSH HOSTS`로 풉니다. SQL / redis-cli 콘솔이 있고, 예약 백업·복원(기본 매일 04:00, 7개 보관)도 됩니다. |
| **리소스 제한** | systemd cgroup으로 앱·DB마다 CPU, 메모리, 스왑, 프로세스 수를 제한합니다. 전체(앱+DB), 앱 묶음, DB 묶음의 상한도 따로 정할 수 있습니다. |
| **재부팅 자동 시작** | 앱과 DB마다 켜고 끕니다. 패널을 업데이트하거나 재시작해도 앱은 멈추지 않습니다(각자 별도 서비스). |
| **알림** | 디스코드 웹후크로 새 푸시, 승인 대기, 배포 성공·실패, 크래시, 디스크·메모리 경고를 보냅니다. 전역 설정과 앱별 설정이 따로 있습니다. |
| **보안** | 기본으로 Tailscale(100.64/10)·사설망·localhost에서만 접속됩니다. OTP 2단계 인증, 로그인 시도 제한, 활동 기록이 있고, 앱마다 전용 리눅스 계정(`hr-<앱ID>`)으로 실행합니다. 비밀값은 AES-256-GCM으로 암호화해 저장합니다. |
| **런타임** | Node.js 버전은 앱마다 자동으로 설치합니다(nodejs.org 공식 바이너리, 체크섬 검증). Python은 `uv`로 버전 설치·가상환경·의존성까지 처리합니다. |
| **시스템** | CPU/메모리/디스크/네트워크 실시간 그래프, 커널 튜닝(somaxconn 등), 스왑, 시간대, Tailscale·cloudflared 상태, 패널 원클릭 업데이트. |

## 요구 사항

- Debian 11+ / Ubuntu 20.04+ (x86_64, arm64)
- systemd가 PID 1이어야 합니다. Proxmox LXC는 기본 템플릿 그대로 됩니다.
- 메모리 1GB 이상 권장(설치할 때 웹 UI를 빌드합니다)

## 처음 설정 순서

1. **설치**: 맨 위의 한 줄 명령을 실행합니다. 같은 명령을 다시 실행하면 업데이트(복구)로 동작하고 데이터는 그대로입니다.
2. **Tailscale**: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up` 후 `http://<tailscale-ip>:7700` 으로 접속합니다.
   - LXC라면 Proxmox에서 TUN 장치를 넘겨 주세요(`/etc/pve/lxc/<id>.conf`).
     ```
     lxc.cgroup2.devices.allow: c 10:200 rwm
     lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
     ```
   - Tailscale을 쓰지 않는다면 내 PC에서 `ssh -L 7700:127.0.0.1:7700 <계정>@<서버>` 로 터널을 연 뒤 `http://localhost:7700` 으로 접속해도 됩니다.
3. **로그인**하면 홈 화면의 "시작하기" 목록이 남은 일을 순서대로 알려 줍니다.
   - 설정 → 내 계정에서 비밀번호를 바꾸고 OTP를 켭니다.
   - (비공개 저장소라면) 설정 → GitHub · 알림에 토큰을 넣습니다. Fine-grained token은 `Contents: Read-only` 권한이면 됩니다.
   - (선택) 같은 곳에 디스코드 웹후크를 넣습니다.
4. **앱 추가**: 저장소 주소만 넣고 "확인" → "배포하기". 런타임과 설치·시작 명령은 자동으로 찾고, 나머지 옵션은 "고급 설정"에 접혀 있습니다.
5. **cloudflared**: 터널의 Public Hostname 서비스를 `http://127.0.0.1:<앱 포트>` 로 지정합니다(앱 개요의 "접속" 카드에 복사용 주소가 있습니다). Nginx는 필요 없습니다.

## 앱 작성 규칙

- 패널이 넣어 주는 `PORT`, `HOST`(=`127.0.0.1`) 환경변수로 listen 하세요. 외부(0.0.0.0)에 열리면 패널이 경고합니다.
  ```js
  app.listen(process.env.PORT, process.env.HOST);
  ```
  ```python
  uvicorn.run(app, host=os.environ["HOST"], port=int(os.environ["PORT"]))
  ```
- 디스코드 봇처럼 포트가 필요 없는 앱도 됩니다. 이 경우 헬스체크는 "5초 동안 살아 있는지"만 봅니다.
- Python은 출력이 바로 콘솔에 보이도록 `PYTHONUNBUFFERED=1` 이 기본으로 켜져 있습니다.
- 데이터 파일은 저장소 밖(gitignore)에 두는 게 가장 안전합니다. 저장소에 커밋된 파일이라도 보존 경로에 넣으면 서버의 것이 유지됩니다.

### 배포 단계

`소스 가져오기 → 코드 반영(로컬 데이터 보존) → 런타임 준비 → 의존성 설치(바뀐 경우만) → 빌드 → 릴리스 명령 → 재시작 + 헬스체크`

| 자동 감지 | 설치 명령 |
| --- | --- |
| `package-lock.json` | `npm ci --include=dev` |
| `pnpm-lock.yaml` / `yarn.lock` | corepack의 pnpm / yarn |
| `requirements.txt` | `uv pip install -r requirements.txt` |
| `uv.lock` | `uv sync --frozen --no-dev` |

## GitHub 웹후크 (선택)

폴링만으로도 동작하지만, 푸시를 바로 감지하려면 앱 → 설정 → GitHub 웹후크에 나오는 URL과 Secret을 저장소 Settings → Webhooks에 넣으세요. Content type은 `application/json` 입니다.
패널을 공개하지 않았다면 cloudflared로 `/api/hooks/*` 경로만 공개해도 됩니다. 웹후크는 IP 제한과 상관없이 HMAC 서명으로만 확인합니다.

## 서버 명령

```
sudo hrone status              패널 상태 + 접속 주소
sudo hrone update              최신 버전으로 업데이트 (앱/DB 는 계속 실행)
sudo hrone logs                패널 로그
sudo hrone list                앱/DB 서비스 목록
sudo hrone app-logs <앱ID>     앱 콘솔
sudo hrone reset-password      관리자 비밀번호 재설정
sudo hrone disable-2fa admin   OTP 해제 (휴대폰 분실 시)
sudo hrone allow-all-ips       IP 제한 해제 (잠겼을 때)
sudo hrone set-port 8800       패널 포트 변경
sudo hrone uninstall [--purge] 제거 (기본은 데이터 보존)
```

## 폴더 구조

```
/opt/hrone                     패널 코드 (git)
/var/lib/hrone/                모든 데이터 — 이 폴더만 백업하면 됩니다
  hrone.db, secret.key         패널 설정 (비밀값은 secret.key 로 암호화)
  apps/<앱ID>/                 앱 코드 (git 작업 폴더)
  appdata/<앱ID>/              환경변수 파일, venv, 배포 키, 홈
  databases/<DB ID>/           MariaDB/Redis 데이터 + 설정
  backups/                     DB 덤프, 앱 데이터 백업, 배포 전 자동 백업
  runtimes/                    Node.js 버전들, uv, Python 버전들
/etc/systemd/system/hrone*.service|slice
```

앱은 `hrone-app-<ID>.service`, DB는 `hrone-db-<ID>.service` 이고, 모두 `hrone.slice` 아래에 있습니다.

## 개발

```bash
npm install
npm run typecheck && npm test
npm run build                     # web/dist
sudo HRONE_DATA=/tmp/hrone npm start   # Linux + systemd 필요
npm run dev:web                   # UI 개발 서버 (HRONE_DEV_API 로 패널 주소 지정)
```

백엔드는 Node.js 24의 TypeScript 타입 제거 기능으로 빌드 없이 실행합니다(Fastify, `node:sqlite`). 프런트엔드는 React + Vite + Tailwind 입니다.
