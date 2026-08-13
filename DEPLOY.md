# v4 배포 순서

## 1. Cloudflare Worker v0.6
1. `worker.js` 전체 복사
2. 기존 Cloudflare Worker 코드에 전체 덮어쓰기
3. 기존 Secrets는 수정/삭제하지 않기
4. Deploy
5. `/health`에서 `version: 0.6` 확인
6. `availableRoutes`에서 `/api/item-overview` 확인

## 2. 새 GitHub 저장소
권장 저장소명: `kafv-fish-price-ai-v4`

업로드: `index.html`, `sw.js`, `manifest.json`, 아이콘 192/512. README는 선택입니다. `worker.js`는 Cloudflare 배포용 백업본이며 GitHub Pages 실행파일은 아닙니다.

## 3. Pages 시험
품목명만 입력해 통합조회가 시작되는지 확인합니다. 이후 전문가 메뉴의 개별 조회도 회귀시험합니다.
