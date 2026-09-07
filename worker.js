/*
============================================================
KAFV 수산물 가격정보 AI
Cloudflare Worker API Gateway v0.7.2
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
const WORKER_VERSION = "0.7.2";
const DEFAULT_ALLOWED_ORIGINS = ["https://jongcheon-kim.github.io"];

// v0.7.2 안정화 정책: v0.7.1의 재시도/timeout을 유지하고,
// item-overview의 탐색 예산을 Endpoint별로 배분해 희소 품목에서도 전체 상태를 끝까지 판정한다.
const UPSTREAM_TIMEOUT_MS = 8000;
const UPSTREAM_MAX_ATTEMPTS = 2;
const TRANSIENT_UPSTREAM_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const ITEM_OVERVIEW_SUBREQUEST_BUDGET = 40;
const ITEM_OVERVIEW_DAY_EQ_PROBE_LIMIT = 10;

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function diagnosticId() {
  try { return crypto.randomUUID(); }
  catch { return `kafv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
}

function retryableStatus(status) {
  return TRANSIENT_UPSTREAM_STATUS.has(Number(status));
}

function retryDelayMs(status, attempt) {
  if (Number(status) === 429) return 700 * attempt;
  return 250 * attempt;
}

function createSubrequestBudget(max = ITEM_OVERVIEW_SUBREQUEST_BUDGET) {
  return { used: 0, max };
}

function reserveSubrequest(budget) {
  if (!budget) return;
  if (budget.used >= budget.max) {
    const error = new Error(`Item overview subrequest budget exceeded (${budget.used}/${budget.max})`);
    error.code = "KAFV_SUBREQUEST_BUDGET";
    error.subrequestsUsed = budget.used;
    throw error;
  }
  budget.used += 1;
}

async function fetchUpstream(route, params, serviceKey, budget = null) {
  const upstream = new URL(BASE + route.path);
  for (const [key, value] of params.entries()) {
    if (key !== "serviceKey") upstream.searchParams.append(key, value);
  }
  setDefaultQuery(upstream.searchParams);
  upstream.searchParams.set("serviceKey", serviceKey);

  const diagId = diagnosticId();
  let lastError = null;

  for (let attempt = 1; attempt <= UPSTREAM_MAX_ATTEMPTS; attempt++) {
    reserveSubrequest(budget);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const started = Date.now();
    try {
      const response = await fetch(upstream.toString(), {
        method: "GET",
        headers: { "Accept": "application/json" },
        signal: controller.signal
      });
      const text = await response.text();
      let data = text;
      try { data = JSON.parse(text); } catch {}

      const meta = {
        diagnosticId: diagId,
        attempts: attempt,
        elapsedMs: Date.now() - started,
        upstreamStatus: response.status
      };

      if (response.ok || !retryableStatus(response.status) || attempt >= UPSTREAM_MAX_ATTEMPTS) {
        return { response, text, data, meta };
      }

      console.warn("KAFV upstream transient response", JSON.stringify({
        diagnosticId: diagId,
        route: route.path,
        status: response.status,
        attempt,
        elapsedMs: meta.elapsedMs
      }));
      await sleep(retryDelayMs(response.status, attempt));
    } catch (error) {
      lastError = error;
      if (error?.code === "KAFV_SUBREQUEST_BUDGET") throw error;
      const isAbort = error?.name === "AbortError" || String(error?.message || error).toLowerCase().includes("abort");
      console.warn("KAFV upstream fetch exception", JSON.stringify({
        diagnosticId: diagId,
        route: route.path,
        attempt,
        type: isAbort ? "timeout" : "network",
        message: String(error?.message || error).slice(0, 160)
      }));
      if (attempt >= UPSTREAM_MAX_ATTEMPTS) {
        const e = new Error(isAbort
          ? `Upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`
          : `Upstream network failure: ${String(error?.message || error)}`);
        e.diagnosticId = diagId;
        e.attempts = attempt;
        e.transient = true;
        throw e;
      }
      await sleep(retryDelayMs(0, attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  const e = new Error(`Upstream fetch failed: ${String(lastError?.message || lastError || "unknown")}`);
  e.diagnosticId = diagId;
  e.attempts = UPSTREAM_MAX_ATTEMPTS;
  e.transient = true;
  throw e;
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
        userMessage: "공공 API가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주십시오.",
        target: targetName,
        message: String(error?.message || error),
        diagnosticId: error?.diagnosticId || "",
        attempts: error?.attempts || 0
      }, 503, corsHeaders);
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
        data: result.data,
        diagnosticId: result.meta?.diagnosticId || "",
        upstreamAttempts: result.meta?.attempts || 1,
        userMessage: retryableStatus(result.response.status)
          ? "공공 API가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주십시오."
          : "공공 API 응답을 처리하지 못했습니다. 잠시 후 다시 시도해 주십시오."
      }, retryableStatus(result.response.status) ? 503 : 502, corsHeaders);
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
// v0.7 품목 통합조회
// 핵심: /recent 날짜 하나를 공통 referenceDate로 사용하지 않는다.
// 각 가격 Endpoint가 자기 자료의 최신 실제 날짜/월을 독립적으로 탐색한다.
// ---------------------------------------------------------------------------

const LATEST_CONFIG = {
  recent:    { strategy: "self",        dateField: "exmn_ymd" },
  trend:     { strategy: "day-eq",      dateField: "exmn_ymd", maxLookbackDays: 30 },
  change:    { strategy: "day-eq",      dateField: "exmn_ymd", maxLookbackDays: 30 },
  daily:     { strategy: "day-range",   dateField: "exmn_ymd", windows: [7, 14, 30] },
  region:    { strategy: "day-range",   dateField: "exmn_ymd", windows: [7, 14, 30] },
  wholesale: { strategy: "day-range",   dateField: "exmn_ymd", windows: [7, 14, 30] },
  retail:    { strategy: "day-range",   dateField: "exmn_ymd", windows: [7, 14, 30] },
  yearmonth: { strategy: "month-range", dateField: "exmn_ym",  windows: [3, 6, 12] }
};

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
      return {
        ok: false, error: String(error?.message || error), target: targetName, data: null, kafvSearch: lastMeta,
        transient: error?.code !== "KAFV_SUBREQUEST_BUDGET",
        budgetExceeded: error?.code === "KAFV_SUBREQUEST_BUDGET",
        diagnosticId: error?.diagnosticId || "", upstreamAttempts: error?.attempts || 0
      };
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
      return {
        ok: false, error: `Upstream HTTP ${result.response.status}`, target: targetName, data: result.data, kafvSearch: lastMeta,
        transient: retryableStatus(result.response.status),
        upstreamStatus: result.response.status,
        diagnosticId: result.meta?.diagnosticId || "", upstreamAttempts: result.meta?.attempts || 1
      };
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

function kstYm() {
  return kstYmd().slice(0, 6);
}

function latestFieldFromRows(rows, field, pattern) {
  return rows
    .map(r => String(r?.[field] || ""))
    .filter(x => pattern.test(x))
    .sort()
    .reverse()[0] || "";
}

function latestYmdFromRows(rows) {
  return latestFieldFromRows(rows, "exmn_ymd", /^\d{8}$/);
}

function latestYmFromRows(rows) {
  return latestFieldFromRows(rows, "exmn_ym", /^\d{6}$/);
}

function sortRowsNewest(rows, field) {
  return [...rows].sort((a, b) => String(b?.[field] || "").localeCompare(String(a?.[field] || "")));
}

function rowsAtLatest(rows, field, latestValue) {
  if (!latestValue) return rows;
  const hit = rows.filter(r => String(r?.[field] || "") === latestValue);
  return hit.length ? hit : rows;
}

function upstreamLogicalError(raw) {
  let x = raw;
  if (typeof x === "string") {
    try { x = JSON.parse(x); } catch { return null; }
  }
  const header = x?.response?.header ?? x?.header ?? x?.response?.body?.header ?? null;
  const code = String(header?.resultCode ?? header?.result_code ?? "").trim();
  if (!code || /^0+$/.test(code)) return null;
  return {
    code,
    message: String(header?.resultMsg ?? header?.resultMessage ?? header?.result_msg ?? "Upstream API logical error")
  };
}

async function fetchTargetRows(targetName, inputParams, env, budget = null) {
  const route = SMART_TARGETS[targetName];
  if (!route) return { ok: false, error: "Invalid smart-search target", rows: [], data: null, status: 400 };

  const serviceKey = serviceKeyFor(route, env);
  if (!serviceKey) return { ok: false, error: `API secret is not configured: ${route.key}`, rows: [], data: null, status: 500 };

  const params = cloneParams(inputParams);
  setDefaultQuery(params);
  if (+params.get("numOfRows") < 1000) params.set("numOfRows", "1000");
  params.set("pageNo", "1");
  params.set("returnType", "json");

  let result;
  try {
    result = await fetchUpstream(route, params, serviceKey, budget);
  } catch (error) {
    return {
      ok: false, error: String(error?.message || error), rows: [], data: null, status: 502, params,
      transient: error?.code !== "KAFV_SUBREQUEST_BUDGET",
      budgetExceeded: error?.code === "KAFV_SUBREQUEST_BUDGET",
      diagnosticId: error?.diagnosticId || "", upstreamAttempts: error?.attempts || 0
    };
  }

  if (!result.response.ok) {
    return {
      ok: false, error: `Upstream HTTP ${result.response.status}`, rows: [], data: result.data, status: result.response.status, params,
      transient: retryableStatus(result.response.status),
      diagnosticId: result.meta?.diagnosticId || "", upstreamAttempts: result.meta?.attempts || 1
    };
  }

  const logicalError = upstreamLogicalError(result.data);
  if (logicalError) {
    return {
      ok: false,
      error: `Upstream API ${logicalError.code}: ${logicalError.message}`,
      rows: [],
      data: result.data,
      status: 502,
      params
    };
  }

  return { ok: true, error: "", rows: itemsOf(result.data), data: result.data, status: 200, params };
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

function latestCoreResult(targetName, ok, rows, latestDate, meta, error = "", extra = {}) {
  return {
    ok,
    target: targetName,
    rows,
    latestDate,
    meta,
    error,
    ...extra
  };
}

async function runEndpointLatest(targetName, inputParams, env, budget = null, options = {}) {
  const cfg = LATEST_CONFIG[targetName];
  if (!cfg) return latestCoreResult(targetName, false, [], "", null, "Latest strategy is not configured");

  const base = cloneParams(inputParams);
  setDefaultQuery(base);
  if (+base.get("numOfRows") < 1000) base.set("numOfRows", "1000");
  base.set("pageNo", "1");
  base.set("returnType", "json");

  const requestedFilters = sanitizeFilterSnapshot(base);
  let probeCount = 0;
  const requestedMaxProbes = Number(options?.maxProbes || 0);

  if (cfg.strategy === "self") {
    probeCount++;
    const one = await fetchTargetRows(targetName, base, env, budget);
    if (!one.ok) {
      return latestCoreResult(targetName, false, [], "", {
        target: targetName,
        strategy: cfg.strategy,
        probeCount,
        requestedFilters,
        matchedFilters: sanitizeFilterSnapshot(one.params || base)
      }, one.error, { transient: one.transient, budgetExceeded: one.budgetExceeded, diagnosticId: one.diagnosticId || "", upstreamAttempts: one.upstreamAttempts || 0, upstreamStatus: one.status || 0 });
    }
    const latestDate = latestYmdFromRows(one.rows);
    const rows = rowsAtLatest(sortRowsNewest(one.rows, cfg.dateField), cfg.dateField, latestDate);
    return latestCoreResult(targetName, true, rows, latestDate, {
      target: targetName,
      strategy: cfg.strategy,
      probeCount,
      latestDate,
      requestedFilters,
      matchedFilters: sanitizeFilterSnapshot(one.params || base)
    });
  }

  if (cfg.strategy === "day-eq") {
    const today = kstYmd();
    const maxOffset = requestedMaxProbes > 0
      ? Math.min(cfg.maxLookbackDays, Math.max(0, requestedMaxProbes - 1))
      : cfg.maxLookbackDays;
    for (let offset = 0; offset <= maxOffset; offset++) {
      const date = addDays(today, -offset);
      const p = cloneParams(base);
      deleteCond(p, "exmn_ymd");
      p.set(canonicalCondKey("exmn_ymd", "EQ"), date);
      probeCount++;
      const one = await fetchTargetRows(targetName, p, env, budget);
      if (!one.ok) {
        return latestCoreResult(targetName, false, [], "", {
          target: targetName,
          strategy: cfg.strategy,
          probeCount,
          latestProbeDate: date,
          requestedFilters,
          matchedFilters: sanitizeFilterSnapshot(one.params || p)
        }, one.error, { transient: one.transient, budgetExceeded: one.budgetExceeded, diagnosticId: one.diagnosticId || "", upstreamAttempts: one.upstreamAttempts || 0, upstreamStatus: one.status || 0 });
      }
      if (one.rows.length) {
        const latestDate = latestYmdFromRows(one.rows) || date;
        const rows = rowsAtLatest(sortRowsNewest(one.rows, cfg.dateField), cfg.dateField, latestDate);
        return latestCoreResult(targetName, true, rows, latestDate, {
          target: targetName,
          strategy: cfg.strategy,
          probeCount,
          latestDate,
          lookbackDays: offset,
          requestedFilters,
          matchedFilters: sanitizeFilterSnapshot(one.params || p)
        });
      }
    }
    const searchComplete = maxOffset >= cfg.maxLookbackDays;
    return latestCoreResult(targetName, true, [], "", {
      target: targetName,
      strategy: cfg.strategy,
      probeCount,
      latestDate: "",
      searchedFrom: addDays(kstYmd(), -maxOffset),
      searchedTo: kstYmd(),
      fullLookbackDays: cfg.maxLookbackDays,
      requestedFilters,
      matchedFilters: requestedFilters
    }, "", {
      searchComplete,
      unconfirmed: !searchComplete,
      unconfirmedReason: searchComplete ? "" : `overview-probe-cap:${probeCount}/${cfg.maxLookbackDays + 1}`
    });
  }

  if (cfg.strategy === "day-range") {
    const today = kstYmd();
    for (const days of cfg.windows) {
      const p = cloneParams(base);
      deleteCond(p, "exmn_ymd");
      p.set(canonicalCondKey("exmn_ymd", "GTE"), addDays(today, -(days - 1)));
      p.set(canonicalCondKey("exmn_ymd", "LTE"), today);
      probeCount++;
      const one = await fetchTargetRows(targetName, p, env, budget);
      if (!one.ok) {
        return latestCoreResult(targetName, false, [], "", {
          target: targetName,
          strategy: cfg.strategy,
          probeCount,
          windowDays: days,
          requestedFilters,
          matchedFilters: sanitizeFilterSnapshot(one.params || p)
        }, one.error, { transient: one.transient, budgetExceeded: one.budgetExceeded, diagnosticId: one.diagnosticId || "", upstreamAttempts: one.upstreamAttempts || 0, upstreamStatus: one.status || 0 });
      }
      if (one.rows.length) {
        const latestDate = latestYmdFromRows(one.rows);
        const rows = rowsAtLatest(sortRowsNewest(one.rows, cfg.dateField), cfg.dateField, latestDate);
        return latestCoreResult(targetName, true, rows, latestDate, {
          target: targetName,
          strategy: cfg.strategy,
          probeCount,
          windowDays: days,
          latestDate,
          requestedFilters,
          matchedFilters: sanitizeFilterSnapshot(one.params || p)
        });
      }
    }
    return latestCoreResult(targetName, true, [], "", {
      target: targetName,
      strategy: cfg.strategy,
      probeCount,
      latestDate: "",
      searchedFrom: addDays(kstYmd(), -(cfg.windows[cfg.windows.length - 1] - 1)),
      searchedTo: kstYmd(),
      requestedFilters,
      matchedFilters: requestedFilters
    });
  }

  if (cfg.strategy === "month-range") {
    const thisYm = kstYm();
    for (const months of cfg.windows) {
      const p = cloneParams(base);
      deleteCond(p, "exmn_ym");
      p.set(canonicalCondKey("exmn_ym", "GTE"), addMonths(thisYm, -(months - 1)));
      p.set(canonicalCondKey("exmn_ym", "LTE"), thisYm);
      probeCount++;
      const one = await fetchTargetRows(targetName, p, env, budget);
      if (!one.ok) {
        return latestCoreResult(targetName, false, [], "", {
          target: targetName,
          strategy: cfg.strategy,
          probeCount,
          windowMonths: months,
          requestedFilters,
          matchedFilters: sanitizeFilterSnapshot(one.params || p)
        }, one.error, { transient: one.transient, budgetExceeded: one.budgetExceeded, diagnosticId: one.diagnosticId || "", upstreamAttempts: one.upstreamAttempts || 0, upstreamStatus: one.status || 0 });
      }
      if (one.rows.length) {
        const latestDate = latestYmFromRows(one.rows);
        const rows = rowsAtLatest(sortRowsNewest(one.rows, cfg.dateField), cfg.dateField, latestDate);
        return latestCoreResult(targetName, true, rows, latestDate, {
          target: targetName,
          strategy: cfg.strategy,
          probeCount,
          windowMonths: months,
          latestDate,
          requestedFilters,
          matchedFilters: sanitizeFilterSnapshot(one.params || p)
        });
      }
    }
    return latestCoreResult(targetName, true, [], "", {
      target: targetName,
      strategy: cfg.strategy,
      probeCount,
      latestDate: "",
      searchedFrom: addMonths(kstYm(), -(cfg.windows[cfg.windows.length - 1] - 1)),
      searchedTo: kstYm(),
      requestedFilters,
      matchedFilters: requestedFilters
    });
  }

  return latestCoreResult(targetName, false, [], "", null, `Unknown latest strategy: ${cfg.strategy}`);
}

function compactLatestResult(core, limit = 5) {
  const rowCount = Array.isArray(core?.rows) ? core.rows.length : 0;
  let status = "empty";
  if (rowCount > 0) status = "available";
  else if (core?.budgetExceeded || core?.unconfirmed || core?.searchComplete === false) status = "unconfirmed";
  else if (!core?.ok) status = "error";
  return {
    ok: Boolean(core?.ok),
    status,
    rowCount,
    rows: Array.isArray(core?.rows) ? core.rows.slice(0, limit) : [],
    latestDate: String(core?.latestDate || ""),
    meta: core?.meta || null,
    error: core?.error || "",
    searchComplete: core?.searchComplete !== false && !core?.unconfirmed && !core?.budgetExceeded,
    unconfirmedReason: core?.unconfirmedReason || (core?.budgetExceeded ? "item-overview-subrequest-budget" : ""),
    budgetExceeded: Boolean(core?.budgetExceeded)
  };
}

async function handleItemOverview(url, request, env) {
  const corsHeaders = getCorsHeaders(request, env);
  const itemCd = String(url.searchParams.get("item_cd") || "").trim();
  const itemNm = String(url.searchParams.get("item_nm") || "").trim();
  const categoryCd = String(url.searchParams.get("ctgry_cd") || "600").trim() || "600";

  if (!itemCd) return json({ error: "item_cd is required" }, 400, corsHeaders);

  const base = baseItemParams(categoryCd, itemCd);
  // 비용이 적은 Endpoint를 먼저 확인하고, 일자 단건탐색(trend/change)은 뒤에서 제한적으로 탐색한다.
  const order = ["recent", "daily", "region", "wholesale", "retail", "yearmonth", "trend", "change"];
  const results = {};
  const budget = createSubrequestBudget();
  let budgetStopped = false;

  // 각 Endpoint가 오늘/현재월부터 독립적으로 최신 실제 자료를 찾는다.
  // /recent 결과의 날짜는 다른 Endpoint에 전달하지 않는다.
  for (const target of order) {
    if (budgetStopped) {
      results[target] = compactLatestResult({
        ok: false,
        rows: [],
        latestDate: "",
        meta: { target, strategy: LATEST_CONFIG[target]?.strategy || "", skippedAfterBudget: true },
        error: `Item overview subrequest budget reached (${budget.used}/${budget.max})`,
        budgetExceeded: true,
        unconfirmed: true,
        searchComplete: false,
        unconfirmedReason: "item-overview-subrequest-budget"
      }, 5);
      continue;
    }

    const options = (target === "trend" || target === "change")
      ? { maxProbes: ITEM_OVERVIEW_DAY_EQ_PROBE_LIMIT }
      : {};
    const core = await runEndpointLatest(target, base, env, budget, options);
    results[target] = compactLatestResult(core, 5);

    if (core?.budgetExceeded) {
      budgetStopped = true;
      continue;
    }

    // v0.7.1의 fail-fast 원칙은 유지: 실제 upstream 일시 장애가 재시도 후에도 지속될 때만 503.
    if (!core.ok && core.transient) {
      return json({
        ok: false,
        version: WORKER_VERSION,
        error: core.error,
        userMessage: "공공 API가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주십시오.",
        mode: "item-overview-endpoint-independent-latest",
        item: { categoryCd, itemCd, itemNm },
        diagnosticId: core.diagnosticId || "",
        upstreamStatus: core.upstreamStatus || 0,
        upstreamAttempts: core.upstreamAttempts || 0,
        subrequestsUsed: budget.used,
        subrequestBudget: budget.max,
        partialResults: results
      }, 503, { ...corsHeaders, "Cache-Control": "no-store" });
    }
  }

  const entries = Object.entries(results);
  const availableCount = entries.filter(([,v]) => v.status === "available").length;
  const emptyCount = entries.filter(([,v]) => v.status === "empty").length;
  const unconfirmedCount = entries.filter(([,v]) => v.status === "unconfirmed").length;
  const errorCount = entries.filter(([,v]) => v.status === "error").length;
  const latestDates = Object.fromEntries(entries.map(([k,v]) => [k, v.latestDate || ""]));

  return json({
    ok: true,
    version: WORKER_VERSION,
    mode: "item-overview-endpoint-independent-latest",
    item: { categoryCd, itemCd, itemNm },
    latestDates,
    // 구형 프론트 호환용. 다른 Endpoint의 조회 기준으로는 절대 사용하지 않는다.
    referenceDate: results.recent?.latestDate || "",
    referenceDateScope: "recent-only-backward-compatibility",
    availableCount,
    emptyCount,
    unconfirmedCount,
    errorCount,
    endpointCount: entries.length,
    subrequestsUsed: budget.used,
    subrequestBudget: budget.max,
    itemOverviewDayEqProbeLimit: ITEM_OVERVIEW_DAY_EQ_PROBE_LIMIT,
    results,
    notes: [
      "각 가격 Endpoint는 자기 자료의 최신 실제 날짜/월을 독립적으로 탐색합니다.",
      "/recent의 날짜는 다른 Endpoint의 공통 기준일로 사용하지 않습니다.",
      "품목코드는 모든 가격 Endpoint에서 고정합니다.",
      "자료 있음·확정 0건·미확인·API 오류를 서로 구분합니다.",
      "통합조회에서 trend/change는 Endpoint당 탐색량을 제한하며, 제한 내에서 자료를 못 찾으면 0건이 아니라 미확인으로 표시합니다.",
      "어기·비어기는 검색 차단조건으로 사용하지 않습니다.",
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
        searchMode: "endpoint-independent-latest-date + item-overview + wide-first-fallback",
        resilience: {
          upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
          upstreamMaxAttempts: UPSTREAM_MAX_ATTEMPTS,
          transientStatuses: [...TRANSIENT_UPSTREAM_STATUS],
          itemOverviewSubrequestBudget: ITEM_OVERVIEW_SUBREQUEST_BUDGET,
          itemOverviewDayEqProbeLimit: ITEM_OVERVIEW_DAY_EQ_PROBE_LIMIT
        },
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

    const params = new URLSearchParams();
    for (const [key, value] of url.searchParams.entries()) {
      if (key !== "serviceKey") params.append(key, value);
    }

    try {
      const result = await fetchUpstream(route, params, serviceKey);
      const response = result.response;
      if (!response.ok && retryableStatus(response.status)) {
        return json({
          error: "Upstream API temporarily unavailable",
          userMessage: "공공 API가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주십시오.",
          upstreamStatus: response.status,
          diagnosticId: result.meta?.diagnosticId || "",
          upstreamAttempts: result.meta?.attempts || 1
        }, 503, {
          ...getCorsHeaders(request, env),
          "Cache-Control": "no-store",
          "X-KAFV-Worker-Version": WORKER_VERSION
        });
      }
      return new Response(result.text, {
        status: response.status,
        headers: {
          "Content-Type": response.headers.get("Content-Type") || "application/json; charset=utf-8",
          ...getCorsHeaders(request, env),
          "Cache-Control": "no-store",
          "X-KAFV-Worker-Version": WORKER_VERSION,
          "X-KAFV-Upstream-Attempts": String(result.meta?.attempts || 1),
          "X-KAFV-Diagnostic-Id": result.meta?.diagnosticId || ""
        }
      });
    } catch (error) {
      return json({
        error: "Upstream fetch failed",
        userMessage: "공공 API가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주십시오.",
        message: String(error?.message || error),
        diagnosticId: error?.diagnosticId || "",
        attempts: error?.attempts || 0
      }, 503, getCorsHeaders(request, env));
    }
  }
};
