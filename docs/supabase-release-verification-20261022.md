# 재고 Supabase 최적화 배포 검증 — 2026-10-22

## 결과

로컬 검증을 완료했지만 Git 쓰기 권한 제한으로 커밋·Push·배포를 중단했다. 운영 DB/Migration/POS 업무 로직은 변경하지 않았다.

- GitHub main 최신 SHA: `3d573caedbd78848e8486aead8eecfffd6a65ae6`
- 로컬 HEAD: 위 SHA와 동일. 기존 미Push 커밋 없음.
- 새 커밋 SHA: 없음.
- 새 배포 URL: 없음.
- 배포 후 운영 검증: 배포하지 않아 미수행.

## 원격 및 Git 제한

Git CLI fetch는 `.git/FETCH_HEAD: Permission denied`, ls-remote는 Windows schannel 인증 오류로 실패했다. 연결된 GitHub 도구로 `refs/heads/main`을 직접 조회해 위 SHA를 확인했다. 로컬 origin/main도 같은 SHA였다.

검증 후 대상 파일 하나만 `git add -- lib/inventory/inventory-business-time.ts`를 시도했으나 `.git/index.lock: Permission denied`로 실패했다. 이 세션의 원본 `.git`은 읽기 전용이다. 권한을 변경하거나 우회하지 않았고 원격 Contents API로 파일을 직접 갱신하지 않았다. 시도 전 index는 비어 있었다.

## 분리 검증

진행 중인 POS 변경이 들어가지 않도록 `git archive HEAD`를 `.tmp/inventory-release-20261022`에 추출하고 재고 파일 하나만 반영했다. 의존성은 기존 node_modules를 junction으로 참조했다. 신규 모의 테스트는 검증용으로만 복사했으며 커밋 대상이 아니다.

검증한 파일과 원본 작업 파일의 SHA256은 동일하다:
`CDBEDDDBA0A7B7C5E65054F70DF4FFDCF1DF6F1337630A9EA12ECA0241C8A85B`

`resolveInventoryBusinessDate`가 기존 `resolveConfiguredBusinessDate`를 사용해 날짜 RPC만 호출한다. 사용하지 않는 전체 overview 요청은 제거됐다. full adapter, POS snapshot, fallback/error log, 매 요청 인증은 변경하지 않았다.

## 타입 검사

동일 후보 디렉터리의 TypeScript compiler host에서 해당 파일만 원본 HEAD/수정본으로 바꿔 진단을 비교했다. 파일 쓰기 없이 메모리에서 비교했다.

- 원본 HEAD: 40개 진단.
- 수정본: 같은 40개 진단.
- 신규 진단: 0개.
- 기존 진단은 ledger/inventory 등의 테스트에 있는 TS5097와 타입 오류다.
- 원래 작업 트리의 개발 중인 POS pending-payment 테스트는 이 후보에 포함하지 않았다.
- 상세 진단: `.tmp/inventory-release-20261022/type-comparison.json`.

## 필수 회귀 및 Build

- 필수 회귀: 70개 통과, 실패 없음. 기존 272개 통과를 재사용해 통과로 간주하지 않고, 배포 후보에서 다시 실행했다.
- 검사 범위: 재고 영업일, 03:00 전후 및 월말/연말, fallback, 매 호출 재조회, snapshot 목록 실제 rewrite 경로, bootstrap, 인증·권한 정책, POS cron 03:00/03:05 정책.
- 변경 파일 ESLint 및 diff whitespace 검사 통과.
- Production Build: `node node_modules/next/dist/bin/next build --webpack` 최종 exit 0. Next 16.2.1 컴파일·Next 타입 검사·72개 static page 생성·trace 수집 완료.
- 빌드는 격리 디렉터리에서 Webpack으로 수행했으며 Vercel 원격 Production Build나 기본 Turbopack 검증으로 간주하지 않는다. junction/중첩 lockfile 때문에 workspace root 추정 경고가 있었다.
- 첫 Build는 환경변수 미전달로 page data 수집 중 실패했다. 기존 `.env.local`을 Node process.loadEnvFile로 프로세스에만 로드하고 child process에 전달해 최종 성공했다. 자격증명을 출력하거나 새 환경파일에 복사하지 않았다.
- Node --env-file 플래그를 사용한 중간 시도는 Next worker의 NODE_OPTIONS 제약으로 실패해 위 process.loadEnvFile 방식으로 수정했다.

## 이전 보고 정정

기존 보고의 snapshot/list 5→4회는 `app/api/inventory/snapshot/list/route.ts`를 직접 호출한 결과였다. 실제 Next config는 `/api/inventory/snapshot/list`를 `/api/inventory/snapshot?mode=list`로 rewrite한다.

실제 rewrite handler는 users 1 + inventory_snapshot_batches 1 + inventory_snapshot_items 1, 총 3회로 수정 전후 동일하다. 이번 분리 테스트에서 rewrite 목적지·실제 handler·동일 응답을 확인했다. 실제 snapshot 목록 API가 20% 줄었다는 근거로 이전 수치를 사용하면 안 된다.

재고 영업일 helper 자체는 정상 호출당 2→1회로 감소한다. 실제 목록 API를 포함한 화면 전체 감소량은 별도 운영 계측이 필요하다.

## 다음 실행 조건

Git 쓰기가 가능한 세션과 GitHub Push 인증이 준비되어야 한다. 그때 main/HEAD를 다시 비교하고 단일 파일 diff를 재확인한 뒤 커밋해야 한다. 기존 미Push 커밋이나 추가 원격 변경이 생겼다면 함께 배포하지 않고 다시 판단해야 한다. 이번 세션에서는 Vercel 운영 배포와 배포 후 검증을 시작하지 않았다.
