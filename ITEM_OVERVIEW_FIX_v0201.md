# KAFV Fish Price AI v0201 - Item Overview Status Fix

기준: PlayFinal v019 UI를 유지하면서 품목 통합조회 상태표시만 보완.

## 변경
- `0건/확인` 통합 표기를 제거.
- 상단 4분류: `자료 있음 / 0건 / 미확인 / API 오류`.
- `미확인`은 탐색 한도·budget 등으로 최종 0건 판정을 내릴 수 없는 상태.
- Endpoint별 badge도 `0건`, `미확인`, `API 오류`를 구분.
- 최근가격 기준일은 요약 카드에서 별도 안내문으로 이동.
- Service Worker cache를 `v0201-item-overview-fix`로 갱신.
- GitHub 보관용 `worker.js`를 Cloudflare Worker v0.7.2와 동기화.

## 배포 순서
1. Cloudflare Worker v0.7.2 먼저 배포 및 `/health` 확인.
2. 이 GitHub 패키지의 파일을 `kafv-fish-price-ai-v4` main 루트에 업로드/덮어쓰기.
3. GitHub Pages 새로고침 후 꽃게 통합조회 QA.

Android TWA는 라이브 GitHub Pages를 사용하므로 이 웹/Worker 변경만으로 APK/AAB 재빌드는 필요 없음.
