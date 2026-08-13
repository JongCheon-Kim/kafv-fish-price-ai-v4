/*
============================================================
KAFV 수산물 가격정보 AI
Cloudflare Worker API Gateway v0.6
============================================================

역할
1. GitHub Pages/PWA -> aT 공공데이터 API 안전 중계
2. 실제 API Key는 Cloudflare Secret에만 저장
3. 기존 19개 API Route 유지
4. /api/search : 품목은 고정하고 세부조건을 단계적으로 완화하는 검색확장 Endpoint
5. /api/item-overview : 품목코드 하나로 8개 가격 Endpoint를 자동 탐색
6. 검색확장 여부와 완화조건을 메타데이터로 반환

중요 원칙
- ctgry_cd(수산물 600), item_cd(품목)는 자동완화하지 않음
- 어기/비어기는 Worker의 검색차단 조건으로 사용하지 않음
- API 원자료를 임의 생성/추정하지 않음
- Secret 값은 어떤 응답에도 출력하지 않음
============================================================
*/

const BASE = "https://apis.data.go.kr/B552845";
const WORKER_VERSION = "0.6";
const DEFAULT_ALLOWED_ORIGINS = ["https://jongcheon-kim.github.io"];

const ROUTES = {
  "/api/goods":       { path: "/katCode/goods",            key: "AT_KATCODE_KEY" },
  "/api/units":       { path: "/katCode/units",            key: "AT_KATCODE_KEY" },
  "/api/sizes":       { path: "/katCode/sizes",            key: "AT_KATCODE_KEY" },
  "/api/markets":     { path: "/katCode/wholesaleMarkets", key: "AT_KATCODE_KEY" },
  "/api/corps":       { path: "/katCode/corps",            key: "AT_KATCODE_KEY" },
  "/api/origins":     { path: "/katCode/placeOrigins",     key: "AT_KATCODE_KEY" },
  "/api/packagings":  { path: "/katCode/packagings",       key: "AT_KATCODE_KEY" },
  "/api/grades":      { path: "/katCode/grades",           key: "AT_KATCODE_KEY" },
  "/api/recent":      { path: "/recent/price",             key: "AT_RECENT_KEY" },
  "/api/daily":       { path: "/perDay/price",             key: "AT_DAILY_KEY" },
  "/api/trend":       { path: "/priceSequel/info",         key: "AT_TREND_KEY" },
  "/api/change":      { path: "/risesAndFalls/info",       key: "AT_CHANGE_KEY" },
  "/api/region":      { path: "/perRegion/price",          key: "AT_REGION_KEY" },
  "/api/retail":      { path: "/periodRetail/price",       key: "AT_RETAIL_KEY" },
  "/api/wholesale":   { path: "/periodWholesale/price",    key: "AT_WHOLESALE_KEY" },
  "/api/yearmonth":   { path: "/perYearMonth/price",       key: "AT_YEARMONTH_KEY" },
  "/api/auction":     { path: "/katRealTime2/trades2",     key: "AT_AUCTION_KEY" },
  "/api/online":      { path: "/katOnline/trades",         key: "AT_ONLINE_KEY" },
  "/api/shipment":    { path: "/shipmentSequel/info",      key: "AT_SHIPMENT_KEY" }
};

// 스마트 검색은 가격계열만 허용한다. 경매/온라인은 서로 다른 코드체계이므로 자동완화하지 않는다.
const SMART_TARGETS = {
  recent: ROUTES["/api/recent"],
  daily: ROUTES["/api/daily"],
  trend: ROUTES["/api/trend"],
  change: ROUTES["/api/change"],
  region: ROUTES["/api/region"],
  retail: ROUTES["/api/retail"],
  wholesale: ROUTES["/api/wholesale"],
  yearmonth: ROUTES["/api/yearmonth"]
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function allowedOrigins(env) {
  const extra = String(env.ALLOWED_ORIGIN || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_ORIGINS.map(normalizeOrigin), ...extra])];
}

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function isAllowedOrigin(request, env) {
  const origin = normalizeOrigin(request.headers.get("Origin") || "");
  if (!origin) return true; // 주소창/Preview/curl
  return allowedOrigins(env).includes(origin);
}

function getCorsHeaders(request, env) {
  const origin = normalizeOrigin(request.headers.get("Origin") || "");
  return origin && isAllowedOrigin(request, env) ? cors(origin) : {};
}

function configured(env, name) {
  return Boolean(env[name]);
}

function normalizeServiceKey(serviceKey) {
  if (!serviceKey) return "";
  try { return decodeURIComponent(serviceKey); }
  catch { return serviceKey; }
}

function serviceKeyFor(route, env) {
  return normalizeServiceKey(env[route.key] || env.DATA_GO_KR_API_KEY || "");
}

function setDefaultQuery(params) {
  if (!params.has("pageNo")) params.set("pageNo", "1");
  if (!params.has("numOfRows")) params.set("numOfRows", "100");
  if (!params.has("returnType")) params.set("returnType", "json");
}

function passParams(sourceUrl, targetUrl, blockedExtra = []) {
  const blocked = new Set(["serviceKey", ...blockedExtra]);
  for (const [key, value] of sourceUrl.searchParams.entries()) {
    if (!blocked.has(key)) targetUrl.searchParams.append(key, value);
  }
  setDefaultQuery(targetUrl.searchParams);
}

async function fetchUpstream(route, params, serviceKey) {
  const upstream = new URL(BASE + route.path);
  for (const [key, value] of params.entries()) {
    if (key !== "serviceKey") upstream.searchParams.append(key, value);
  }
  setDefaultQuery(upstream.searchParams);
  upstream.searchParams.set("serviceKey", serviceKey);

  const response = await fetch(upstream.toString(), {
    method: "GET",
    headers: { "Accept": "application/json" }
  });
  const text = await response.text();
  let data = text;
  try { data = JSON.parse(text); } catch {}
  return { response, text, data };
}

function normalizedBody(raw) {
  let x = raw;
  if (typeof x === "string") {
    try { x = JSON.parse(x); } catch { return x; }
  }
  let b = x?.response?.body ?? x?.body ?? x;
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch {}
  }
  return b;
}

function itemsOf(raw) {
  const body = normalizedBody(raw);
  let items = body?.items?.item ?? body?.item ?? body?.items ?? [];
  if (items && !Array.isArray(items) && typeof items === "object") items = [items];
  return Array.isArray(items) ? items : [];
}

function cloneParams(params) {
  return new URLSearchParams(params.toString());
}

function canonicalCondKey(name, op = "EQ") {
  return `cond[${name}::${op}]`;
}

function deleteCond(params, name) {
  const prefix = `cond[${name}::`;
  for (const key of [...params.keys()]) {
    if (key.startsWith(prefix)) params.delete(key);
  }
}

function addDays(yyyymmdd, delta) {
  if (!/^\d{8}$/.test(String(yyyymmdd || ""))) return String(yyyymmdd || "");
  const s = String(yyyymmdd);
  const d = new Date(Date.UTC(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8)));
  if (Number.isNaN(d.getTime())) return s;
  d.setUTCDate(d.getUTCDate() + delta);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,"0")}${String(d.getUTCDate()).padStart(2,"0")}`;
}

function addMonths(yyyymm, delta) {
  if (!/^\d{6}$/.test(String(yyyymm || ""))) return String(yyyymm || "");
  const s = String(yyyymm);
  const d = new Date(Date.UTC(+s.slice(0,4), +s.slice(4,6)-1, 1));
  if (Number.isNaN(d.getTime())) return s;
  d.setUTCMonth(d.getUTCMonth() + delta);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,"0")}`;
}

function sanitizeFilterSnapshot(params) {
  const out = {};
  for (const [k,v] of params.entries()) {
    if (k === "serviceKey" || k === "returnType" || k === "pageNo" || k === "numOfRows") continue;
    out[k] = v;
  }
  return out;
}

function attemptSignature(params) {
  return [...params.entries()].sort((a,b)=>a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])).map(([k,v])=>`${k}=${v}`).join("&");
}

function buildSearchAttempts(original, widenDate = true) {
  const attempts = [];
  const seen = new Set();
  const push = (params, relaxed = [], dateAdjustment = "") => {
    setDefaultQuery(params);
    const sig = attemptSignature(params);
    if (seen.has(sig)) return;
    seen.add(sig);
    attempts.push({ params, relaxed: [...relaxed], dateAdjustment });
  };

  // 0. 사용자가 요청한 정확조건
  const exact = cloneParams(original);
  push(exact, [], "");

  // 품목/수산분류는 유지하고 과도하게 좁혀질 가능성이 큰 세부조건부터 완화
  let p = cloneParams(exact);
  const relaxed = [];
  for (const field of ["grd_cd", "vrty_cd", "se_cd"]) {
    const before = attemptSignature(p);
    deleteCond(p, field);
    if (attemptSignature(p) !== before) relaxed.push(field);
    push(cloneParams(p), relaxed, "");
  }

  // 거래일 공백/주말/비거래일에 대비. 날짜는 검색 차단이 아니라 확장 대상으로 처리.
  // 공간조건까지 완화해야 할 때는 가장 넓어진 날짜범위를 이어받는다.
  let spatialBase = cloneParams(p);
  if (widenDate) {
    const eqKey = canonicalCondKey("exmn_ymd", "EQ");
    const gteKey = canonicalCondKey("exmn_ymd", "GTE");
    const lteKey = canonicalCondKey("exmn_ymd", "LTE");
    const ymGteKey = canonicalCondKey("exmn_ym", "GTE");

    if (p.has(eqKey)) {
      const originalDate = p.get(eqKey);
      for (const days of [1,3,7,14,30]) {
        const q = cloneParams(p);
        q.set(eqKey, addDays(originalDate, -days));
        push(q, relaxed, `기준일 ${days}일 이전`);
        spatialBase = q;
      }
    } else if (p.has(gteKey) && p.has(lteKey)) {
      const start = p.get(gteKey);
      for (const days of [7,30]) {
        const q = cloneParams(p);
        q.set(gteKey, addDays(start, -days));
        push(q, relaxed, `시작일 ${days}일 이전으로 확대`);
        spatialBase = q;
      }
    } else if (p.has(ymGteKey)) {
      const startYm = p.get(ymGteKey);
      for (const months of [3,6]) {
        const q = cloneParams(p);
        q.set(ymGteKey, addMonths(startYm, -months));
        push(q, relaxed, `시작월 ${months}개월 이전으로 확대`);
        spatialBase = q;
      }
    }
  }

  // 마지막으로 시장·지역을 넓힌다. 품목은 끝까지 고정한다.
  p = cloneParams(spatialBase);
  for (const field of ["mrkt_cd", "sgg_cd"]) {
    const before = attemptSignature(p);
    deleteCond(p, field);
    if (attemptSignature(p) !== before) relaxed.push(field);
    push(cloneParams(p), relaxed, "");
  }

  return attempts.slice(0, 14);
}

async function handleSmartSearch(url, request, env) {
  const corsHeaders = getCorsHeaders(request, env);
  const targetName = String(url.searchParams.get("target") || "").trim();
  const route = SMART_TARGETS[targetName];
  if (!route) {
    return json({
      error: "Invalid smart-search target",
      allowedTargets: Object.keys(SMART_TARGETS)
    }, 400, corsHeaders);
  }

  const serviceKey = serviceKeyFor(route, env);
  if (!serviceKey) {
    return json({
      error: "API secret is not configured",
      requiredSecret: route.key,
      fallbackSecret: "DATA_GO_KR_API_KEY"
    }, 500, corsHeaders);
  }

  const base = new URLSearchParams();
  const blocked = new Set(["serviceKey", "target", "widenDate"]);
  for (const [k,v] of url.searchParams.entries()) {
    if (!blocked.has(k)) base.append(k,v);
  }
  setDefaultQuery(base);
  // 스마트 검색은 1회 최대 1000행으로 충분히 넓게 확인한다.
  if (+base.get("numOfRows") < 1000) base.set("numOfRows", "1000");
  base.set("pageNo", "1");
  base.set("returnType", "json");

  const widenDate = url.searchParams.get("widenDate") !== "0";
  const attempts = buildSearchAttempts(base, widenDate);
  let last = null;
  let lastMeta = null;

  for (let i=0; i<attempts.length; i++) {
    const a = attempts[i];
    let result;
    try {
      result = await fetchUpstream(route, a.params, serviceKey);
    } catch (error) {
      return json({
        error: "Upstream fetch failed",
        target: targetName,
        message: String(error?.message || error)
      }, 502, corsHeaders);
    }

    const rowCount = itemsOf(result.data).length;
    last = result;
    lastMeta = {
      target: targetName,
      exact: i === 0 && rowCount > 0,
      rowCount,
      attempt: i + 1,
      attemptCount: attempts.length,
      relaxedParams: a.relaxed,
      dateAdjustment: a.dateAdjustment,
      requestedFilters: sanitizeFilterSnapshot(base),
      matchedFilters: sanitizeFilterSnapshot(a.params)
    };

    if (!result.response.ok) {
      // API 자체 오류를 0건으로 오해해 조건을 계속 풀지 않는다.
      return json({
        error: "Upstream API error",
        upstreamStatus: result.response.status,
        kafvSearch: lastMeta,
        data: result.data
      }, 502, corsHeaders);
    }

    if (rowCount > 0) {
      return json({
        ok: true,
        kafvSearch: lastMeta,
        data: result.data
      }, 200, { ...corsHeaders, "Cache-Control": "no-store" });
    }
  }

  return json({
    ok: true,
    kafvSearch: lastMeta || {
      target: targetName,
      exact: false,
      rowCount: 0,
      attempt: 0,
      attemptCount: 0,
      relaxedParams: [],
      dateAdjustment: "",
      requestedFilters: sanitizeFilterSnapshot(base),
      matchedFilters: sanitizeFilterSnapshot(base)
    },
    data: last?.data ?? { response: { body: { totalCount: 0, items: { item: [] } } } }
  }, 200, { ...corsHeaders, "Cache-Control": "no-store" });
}


// ---------------------------------------------------------------------------
// v0.6 품목 통합조회
// 가격 API의 ctgry_cd/item_cd 코드체계 안에서 8개 가격 Endpoint를 자동 탐색한다.
// 경매/온라인은 별도 코드체계이므로 이 Worker 통합조회에 억지로 합치지 않고,
// 프론트엔드에서 공식 경매 코드표/실제 온라인 응답명칭을 이용해 별도 탐색한다.
// ---------------------------------------------------------------------------
function compactSmartResult(core, limit = 5) {
  const rows = itemsOf(core?.data);
  return {
    ok: Boolean(core?.ok),
    rowCount: rows.length,
    rows: rows.slice(0, limit),
    meta: core?.kafvSearch || null,
    error: core?.error || ""
  };
}

async function runSmartCore(targetName, inputParams, env, widenDate = true) {
  const route = SMART_TARGETS[targetName];
  if (!route) return { ok: false, error: "Invalid smart-search target", target: targetName, data: null, kafvSearch: null };

  const serviceKey = serviceKeyFor(route, env);
  if (!serviceKey) return { ok: false, error: `API secret is not configured: ${route.key}`, target: targetName, data: null, kafvSearch: null };

  const base = cloneParams(inputParams);
  setDefaultQuery(base);
  if (+base.get("numOfRows") < 1000) base.set("numOfRows", "1000");
  base.set("pageNo", "1");
  base.set("returnType", "json");

  const attempts = buildSearchAttempts(base, widenDate);
  let last = null;
  let lastMeta = null;

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    let result;
    try {
      result = await fetchUpstream(route, a.params, serviceKey);
    } catch (error) {
      return { ok: false, error: String(error?.message || error), target: targetName, data: null, kafvSearch: lastMeta };
    }

    const rowCount = itemsOf(result.data).length;
    last = result;
    lastMeta = {
      target: targetName,
      exact: i === 0 && rowCount > 0,
      rowCount,
      attempt: i + 1,
      attemptCount: attempts.length,
      relaxedParams: a.relaxed,
      dateAdjustment: a.dateAdjustment,
      requestedFilters: sanitizeFilterSnapshot(base),
      matchedFilters: sanitizeFilterSnapshot(a.params)
    };

    if (!result.response.ok) {
      return { ok: false, error: `Upstream HTTP ${result.response.status}`, target: targetName, data: result.data, kafvSearch: lastMeta };
    }
    if (rowCount > 0) return { ok: true, target: targetName, data: result.data, kafvSearch: lastMeta };
  }

  return {
    ok: true,
    target: targetName,
    data: last?.data ?? { response: { body: { totalCount: 0, items: { item: [] } } } },
    kafvSearch: lastMeta || {
      target: targetName,
      exact: false,
      rowCount: 0,
      attempt: 0,
      attemptCount: 0,
      relaxedParams: [],
      dateAdjustment: "",
      requestedFilters: sanitizeFilterSnapshot(base),
      matchedFilters: sanitizeFilterSnapshot(base)
    }
  };
}

function kstYmd() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,"0")}${String(d.getUTCDate()).padStart(2,"0")}`;
}

function latestYmdFromRows(rows) {
  return rows.map(r => String(r?.exmn_ymd || "")).filter(x => /^\d{8}$/.test(x)).sort().reverse()[0] || "";
}

function baseItemParams(categoryCd, itemCd) {
  const p = new URLSearchParams();
  p.set(canonicalCondKey("ctgry_cd", "EQ"), categoryCd);
  p.set(canonicalCondKey("item_cd", "EQ"), itemCd);
  p.set("numOfRows", "1000");
  p.set("pageNo", "1");
  p.set("returnType", "json");
  return p;
}

async function handleItemOverview(url, request, env) {
  const corsHeaders = getCorsHeaders(request, env);
  const itemCd = String(url.searchParams.get("item_cd") || "").trim();
  const itemNm = String(url.searchParams.get("item_nm") || "").trim();
  const categoryCd = String(url.searchParams.get("ctgry_cd") || "600").trim() || "600";

  if (!itemCd) return json({ error: "item_cd is required" }, 400, corsHeaders);

  const results = {};
  const base = baseItemParams(categoryCd, itemCd);

  // 1) 최근가격을 먼저 찾아 실제 최신 조사일을 기준일로 잡는다.
  const recent = await runSmartCore("recent", base, env, false);
  results.recent = compactSmartResult(recent, 5);
  const recentRows = itemsOf(recent?.data);
  const referenceDate = latestYmdFromRows(recentRows) || addDays(kstYmd(), -1);

  // 2) 같은 품목코드로 나머지 가격 Endpoint를 넓게 탐색한다.
  const datedEq = baseItemParams(categoryCd, itemCd);
  datedEq.set(canonicalCondKey("exmn_ymd", "EQ"), referenceDate);

  const datedRange = baseItemParams(categoryCd, itemCd);
  datedRange.set(canonicalCondKey("exmn_ymd", "GTE"), referenceDate);
  datedRange.set(canonicalCondKey("exmn_ymd", "LTE"), referenceDate);

  const periodRange = baseItemParams(categoryCd, itemCd);
  periodRange.set(canonicalCondKey("exmn_ymd", "GTE"), addDays(referenceDate, -30));
  periodRange.set(canonicalCondKey("exmn_ymd", "LTE"), referenceDate);

  const refYm = referenceDate.slice(0, 6);
  const ymRange = baseItemParams(categoryCd, itemCd);
  ymRange.set(canonicalCondKey("exmn_ym", "GTE"), addMonths(refYm, -6));
  ymRange.set(canonicalCondKey("exmn_ym", "LTE"), refYm);

  const plan = [
    ["trend", datedEq, true],
    ["change", datedEq, true],
    ["daily", datedRange, true],
    ["region", datedRange, true],
    ["wholesale", periodRange, true],
    ["retail", periodRange, true],
    ["yearmonth", ymRange, true]
  ];

  for (const [target, params, widen] of plan) {
    const core = await runSmartCore(target, params, env, widen);
    results[target] = compactSmartResult(core, 5);
  }

  const entries = Object.entries(results);
  const availableCount = entries.filter(([,v]) => v.rowCount > 0).length;
  const errorCount = entries.filter(([,v]) => !v.ok).length;

  return json({
    ok: true,
    version: WORKER_VERSION,
    mode: "item-overview",
    item: { categoryCd, itemCd, itemNm },
    referenceDate,
    availableCount,
    endpointCount: entries.length,
    errorCount,
    results,
    notes: [
      "품목코드는 모든 가격 Endpoint에서 고정합니다.",
      "어기·비어기는 검색 차단조건으로 사용하지 않습니다.",
      "단위·규격은 실제 API 응답값으로만 표시합니다.",
      "경매·온라인은 가격 API와 코드체계가 달라 프론트엔드에서 별도 자동탐색합니다."
    ]
  }, 200, { ...corsHeaders, "Cache-Control": "no-store" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(request, env)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: getCorsHeaders(request, env) });
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, getCorsHeaders(request, env));
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "KAFV Fish Price API Gateway",
        version: WORKER_VERSION,
        searchMode: "item-overview+wide-first-fallback",
        allowedOrigins: allowedOrigins(env),
        fallbackKeyConfigured: configured(env, "DATA_GO_KR_API_KEY"),
        storedOtherKeys: {
          KAMIS_API_KEY: configured(env, "KAMIS_API_KEY"),
          ATFIS_API_KEY: configured(env, "ATFIS_API_KEY")
        },
        priceKeys: {
          AT_KATCODE_KEY: configured(env, "AT_KATCODE_KEY"),
          AT_RECENT_KEY: configured(env, "AT_RECENT_KEY"),
          AT_DAILY_KEY: configured(env, "AT_DAILY_KEY"),
          AT_TREND_KEY: configured(env, "AT_TREND_KEY"),
          AT_CHANGE_KEY: configured(env, "AT_CHANGE_KEY"),
          AT_REGION_KEY: configured(env, "AT_REGION_KEY"),
          AT_RETAIL_KEY: configured(env, "AT_RETAIL_KEY"),
          AT_WHOLESALE_KEY: configured(env, "AT_WHOLESALE_KEY"),
          AT_YEARMONTH_KEY: configured(env, "AT_YEARMONTH_KEY"),
          AT_AUCTION_KEY: configured(env, "AT_AUCTION_KEY"),
          AT_ONLINE_KEY: configured(env, "AT_ONLINE_KEY"),
          AT_SHIPMENT_KEY: configured(env, "AT_SHIPMENT_KEY")
        },
        availableRoutes: [...Object.keys(ROUTES), "/api/search", "/api/item-overview"]
      }, 200, getCorsHeaders(request, env));
    }

    if (url.pathname === "/routes") {
      return json({
        ok: true,
        version: WORKER_VERSION,
        availableRoutes: [...Object.keys(ROUTES), "/api/search", "/api/item-overview"],
        smartSearchTargets: Object.keys(SMART_TARGETS)
      }, 200, getCorsHeaders(request, env));
    }

    if (!isAllowedOrigin(request, env)) {
      return json({ error: "Origin not allowed" }, 403, getCorsHeaders(request, env));
    }

    if (url.pathname === "/api/item-overview") {
      return handleItemOverview(url, request, env);
    }

    if (url.pathname === "/api/search") {
      return handleSmartSearch(url, request, env);
    }

    const route = ROUTES[url.pathname];
    if (!route) {
      return json({
        error: "Unknown route",
        availableRoutes: [...Object.keys(ROUTES), "/api/search", "/api/item-overview"]
      }, 404, getCorsHeaders(request, env));
    }

    const serviceKey = serviceKeyFor(route, env);
    if (!serviceKey) {
      return json({
        error: "API secret is not configured",
        requiredSecret: route.key,
        fallbackSecret: "DATA_GO_KR_API_KEY"
      }, 500, getCorsHeaders(request, env));
    }

    const upstream = new URL(BASE + route.path);
    passParams(url, upstream);
    upstream.searchParams.set("serviceKey", serviceKey);

    try {
      const response = await fetch(upstream.toString(), {
        method: "GET",
        headers: { "Accept": "application/json" }
      });
      const body = await response.text();
      return new Response(body, {
        status: response.status,
        headers: {
          "Content-Type": response.headers.get("Content-Type") || "application/json; charset=utf-8",
          ...getCorsHeaders(request, env),
          "Cache-Control": "no-store"
        }
      });
    } catch (error) {
      return json({
        error: "Upstream fetch failed",
        message: String(error?.message || error)
      }, 502, getCorsHeaders(request, env));
    }
  }
};
