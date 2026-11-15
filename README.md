# Repo 운영 현황 대시보드

GitHub Actions가 주기적으로 repo 통계를 모아 `data/dashboard.json`에 저장하고, GitHub Pages가 `index.html`로 보여 줍니다.

## 설치 (한 번만)

1. **파일 올리기**: 완료되었습니다. 이 repo(`dashboard`)에 모든 파일이 올라가 있습니다.
2. **토큰 만들기**: GitHub → Settings → Developer settings → Personal access tokens.
   - Fine-grained 토큰: Repository access는 "All repositories", Repository permissions는 **Administration: Read-only**(방문 통계), **Actions: Read-only**, **Contents: Read-only**, **Metadata: Read-only**, **Pages: Read-only**.
   - 또는 classic 토큰: `repo` 범위 하나.
3. **토큰 등록**: 이 repo → Settings → Secrets and variables → Actions → New repository secret. 이름은 `DASHBOARD_TOKEN`.
4. **Pages 켜기**: Settings → Pages → Source를 "Deploy from a branch", Branch를 `main` / `(root)`로 설정합니다.
5. **첫 수집**: Actions 탭 → "Collect repo stats" → Run workflow. 끝나면 `https://<계정>.github.io/dashboard/`에서 볼 수 있습니다.

## 설정 (`config.json`)

| 항목 | 뜻 |
|---|---|
| `owner` | 통계를 모을 계정 |
| `includePrivate` | 비공개 repo 포함 여부. `true`로 하면 비공개 repo의 이름과 통계가 공개 페이지에 노출됩니다. |
| `includeForks` | 포크한 repo 포함 여부 |
| `exclude` | 제외할 repo 이름 |
| `defaultSelected` | 처음 열었을 때 표시할 repo |
| `defaultSort` | 기본 정렬: `visitors`, `status`, `push`, `stars`, `name` |
| `staleDays` | 마지막 push 후 며칠이 지나면 "주의"로 볼지 |
| `trafficHistoryDays` | 방문 기록 보존 일수 |

## 알아둘 점

- 수집 주기는 `.github/workflows/collect.yml`의 `cron`으로 바꿉니다. 기본은 매시간입니다.
- GitHub은 방문 통계를 최근 14일치만 주므로, 그 이전 기록은 수집을 시작한 뒤부터 쌓입니다. "직전 14일 대비" 변화율은 28일치가 쌓인 뒤에 나옵니다.
- 커밋 통계는 GitHub이 처음 계산하는 동안 비어 있을 수 있고, 다음 수집 때 채워집니다.
- 방문 수는 GitHub의 repo 페이지 조회수입니다. github.io 사이트 방문자는 포함되지 않습니다.
- 60일 동안 repo에 활동이 없으면 GitHub이 예약 실행을 멈춥니다. 이 repo는 수집할 때마다 커밋하므로 보통은 해당되지 않습니다.
