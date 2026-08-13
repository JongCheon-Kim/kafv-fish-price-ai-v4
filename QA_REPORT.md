# KAFV 수산물 가격정보 AI v4 / v0.17 QA

## 정적·구조 검사 완료

- `index.html` 인라인 JavaScript: `node --check` 통과
- `worker.js` v0.6: `node --check` 통과
- 새 Worker route: `/api/item-overview`
- 기존 `/api/search` 및 기존 19개 route 유지
- Worker v0.5의 검색시도 배열 중복 추가 코드 제거
- 품목 통합조회: 최근·추이·등락·일별·지역·중도매·소매·연월 8개 가격 Endpoint 자동탐색
- 통합조회 중 `ctgry_cd=600`, `item_cd` 고정
- 어기·비어기를 검색 차단조건으로 사용하지 않음
- 단위·규격은 선택조건이 아니라 API 응답값으로 표시
- 경매·온라인은 가격 API와 다른 코드체계로 취급하며 프론트엔드에서 별도 자동탐색
- PWA cache: `kafv-fish-price-ai-v4-v017`
- manifest: v4/v0.17 반영

## Worker 모의 라우팅 검사

실제 공공 API를 흉내 낸 mock 응답으로 Worker v0.6의 `/api/item-overview`를 호출하여 다음을 확인했습니다.

- health version: `0.6`
- item overview mode: `item-overview`
- 가격 Endpoint 8종 모두 호출
- 통합 결과 구조와 `referenceDate` 생성 정상

이 검사는 **라우팅·응답 조립 로직 검사**이며 실제 공공데이터 API 성공을 의미하지 않습니다.

## 실제 배포 후 필수 QA

Cloudflare Worker v0.6과 GitHub Pages v4를 배포한 뒤 다음을 실제로 확인해야 합니다.

1. `/health`에서 `version: 0.6`
2. `availableRoutes`에 `/api/item-overview`
3. 검색창에 `고등어`만 입력 → 통합조회 실행
4. 갈치·명태·삼치·물오징어·굴·전복·꽃게·바지락·전어·건다시마 교차검증
5. 8개 가격 Endpoint별 자료 있음/0건/API 오류 구분
6. 경매 명칭대응이 잘못된 가공품으로 연결되지 않는지 확인
7. 온라인 도매 실제 응답명칭 필터 결과 확인
8. 기존 전문가 메뉴 회귀시험
9. PC 마우스/휠/드래그와 모바일 터치 시험
10. PWA 설치·업데이트 캐시 시험
