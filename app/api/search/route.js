/**
 * app/api/search/route.js  (live endpoint: /api/cerca)
 *
 * Multi-provider product search endpoint.
 *
 * Highlights this file demonstrates:
 *  - A provider fallback cascade (Serper -> SearchAPI -> Zenserp, plus a marketplace
 *    integration) so a single provider outage never takes search down.
 *  - A 24h Redis response cache to cut paid API calls on repeated queries.
 *  - Per-IP rate limiting (per-minute + per-day) backed by Redis counters.
 *  - Heuristic condition classification (new vs. used) from listing title + source.
 *  - Fire-and-forget price-history persistence that never blocks the response.
 *
 * Notes for readers:
 *  - All credentials are read from environment variables; none are embedded.
 *  - Identifiers, comments and messages were translated from Italian for this showcase.
 *  - The keyword/domain lists below are intentionally left in Italian: they match
 *    Italian-language queries and listings for the Italian e-commerce market.
 *  - Rate-limit thresholds are environment-driven; the fallbacks here are illustrative
 *    and do not reflect the live configuration.
 */

import { NextResponse } from 'next/server';

// --- Language-specific matching data (Italian market) -----------------------

// When the user filters by "used", append a marketplace-appropriate qualifier
// based on the product type detected in the query.
const USED_QUERY_QUALIFIERS = {
  'libri': 'usato seconda mano', 'libro': 'usato seconda mano',
  'moda': 'usato seconda mano', 'abbigliamento': 'usato seconda mano',
  'vestiti': 'usato seconda mano', 'scarpe': 'usato seconda mano',
  'borsa': 'usato seconda mano', 'borse': 'usato seconda mano',
  'giacca': 'usato seconda mano', 'jeans': 'usato seconda mano',
  'manga': 'usato seconda mano', 'fumetti': 'usato seconda mano',
  'vinile': 'usato seconda mano', 'vinili': 'usato seconda mano',
  'cd': 'usato', 'dvd': 'usato',
};

// Domains that overwhelmingly sell used / refurbished goods.
const USED_MARKETPLACES = [
  'subito.it', 'bakeca.it', 'kijiji.it',
  'vinted.it', 'vinted.com', 'depop.com', 'vestiairecollective.com', 'vestiaire.com',
  'wallapop.com', 'milanuncios.com', 'leboncoin.fr',
  'backmarket.it', 'backmarket.com', 'back-market.it',
  'swappie.com', 'swappie.it',
  'refurbed.it', 'refurbed.com',
  'rebuy.it', 'rebuy.de', 'rebuy.com',
  'trendevice.com', 'trendevice.it',
  'ricondizionato.it',
  'certideal.it', 'certideal.com',
  'smartgeneration.it',
  'phonecheck.com',
  'decluttr.com',
  'musicmagpie.co.uk',
  'gazelle.com',
  'swappa.com',
  'itechstore.it',
  'facebook.com/marketplace',
];

// Domains that overwhelmingly sell new goods.
const NEW_RETAILERS = [
  'mediaworld.it', 'mediamarkt.it',
  'euronics.it', 'unieuro.it',
  'expert.it', 'trony.it',
  'eprice.it', 'monclick.it',
  'comet.it', 'bennet.it',
  'carrefour.it',
  'apple.com', 'samsung.com', 'samsung.it',
  'huawei.com', 'xiaomi.com',
  'sony.it', 'sony.com',
  'lg.com', 'lg.it',
  'dyson.it', 'dyson.com',
  'microsoft.com', 'microsoft.it',
  'lenovo.com', 'lenovo.it',
  'hp.com', 'hp.it',
  'dell.com', 'dell.it',
  'asus.com', 'asus.it',
  'acer.com', 'acer.it',
  'ibs.it', 'feltrinelli.it', 'lafeltrinelli.it',
  'zalando.it', 'zalando.com',
  'mango.com', 'zara.com', 'hm.com',
  'nike.com', 'adidas.it', 'adidas.com',
  'decathlon.it', 'decathlon.com',
  'ikea.it', 'ikea.com',
  'lego.com',
  'pandora.net',
  'farmacia.it', 'pharmalife.it',
  'esselunga.it', 'conad.it', 'coop.it',
];

// Domains that sell both new and used, so the source alone is not decisive.
const AMBIGUOUS_MARKETPLACES = [
  'ebay.it', 'ebay.com', 'ebay.co.uk', 'ebay.de', 'ebay.fr', 'ebay.es',
  'amazon.it', 'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr',
  'aliexpress.com', 'aliexpress.it',
  'alibaba.com',
  'wish.com',
  'cdiscount.com',
  'fnac.it', 'fnac.com',
  'mediamarkt.de',
];

// Terms in a listing title that indicate a used / refurbished item.
const USED_CONDITION_TERMS = [
  'usato', 'seconda mano', 'second hand', 'used',
  'ricondizionato', 'refurbished', 'rigenerato', 'ricondizionata',
  'come nuovo', 'come nuova',
  'ottime condizioni', 'buone condizioni', 'discrete condizioni', 'buono stato',
  'grado a', 'grado b', 'grado c', 'grade a', 'grade b', 'grade c',
  'ex demo', 'open box', 'occasione', 'seminuovo', 'seminuova',
  'rigenerato', 'rigenerata', 'revisionato',
  'renewed', 'warehouse', 'outlet',
  '2nd hand', 'pre-owned', 'preowned',
];

// Terms in a listing title that indicate a brand-new item.
const NEW_CONDITION_TERMS = [
  'nuovo', 'nuova', 'nuovi', 'nuove',
  'new', 'brand new',
  'sigillato', 'sigillata', 'sealed',
  'mai aperto', 'mai usato', 'mai usata',
  'nuovissimo', 'nuovissima',
  'imballo originale', 'scatola originale',
];

// --- Rate-limit configuration ------------------------------------------------
// Thresholds are set via environment variables in production. The fallback values
// below are illustrative only and do not reflect the live configuration.
const MAX_SEARCHES_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE) || 10;
const MAX_SEARCHES_PER_DAY = Number(process.env.RATE_LIMIT_PER_DAY) || 100;

// --- Condition classification ------------------------------------------------

// Decide whether a result is New or Used from the API-provided condition,
// the listing title, then the source domain. Returns null for ambiguous
// marketplaces so the caller can keep the item under "all conditions".
function classifyCondition(title, source, apiCondition) {
  if (apiCondition === 'Used') return 'Used';
  const titleLower = (title || '').toLowerCase();
  const sourceLower = (source || '').toLowerCase();
  for (const term of USED_CONDITION_TERMS) { if (titleLower.includes(term)) return 'Used'; }
  for (const term of NEW_CONDITION_TERMS) { if (titleLower.includes(term)) return 'New'; }
  for (const domain of USED_MARKETPLACES) { if (sourceLower.includes(domain)) return 'Used'; }
  for (const domain of NEW_RETAILERS) { if (sourceLower.includes(domain)) return 'New'; }
  for (const domain of AMBIGUOUS_MARKETPLACES) { if (sourceLower.includes(domain)) return null; }
  return 'New';
}

// Append a "used" qualifier to the raw query when the user filters by used items.
function buildQuery(query, condition) {
  if (condition !== 'used') return query;
  const queryLower = query.toLowerCase();
  for (const [keyword, suffix] of Object.entries(USED_QUERY_QUALIFIERS)) {
    if (queryLower.includes(keyword)) return `${query} ${suffix}`;
  }
  return `${query} usato seconda mano`;
}

// --- Redis cache + usage counters -------------------------------------------

async function getCached(key) {
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return null;
    const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.result) return JSON.parse(data.result);
    return null;
  } catch (e) { return null; }
}

async function setCached(key, value) {
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return;
    // Cache the payload for 24h to avoid re-hitting paid providers on repeat queries.
    await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}/ex/86400`, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {}
}

// Cumulative per-provider call counter (never auto-reset) for usage monitoring.
async function incrementUsageCounter(provider) {
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return;
    const key = `api_calls:${provider}`;
    await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {}
}

// Per-IP rate limiting using two Redis counters (per-minute and per-day).
// The counter is created with INCR and given a TTL on first hit.
async function checkRateLimit(ip) {
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return { blocked: false };

    // Per-minute bucket.
    const minuteKey = `rate:${ip}:${Math.floor(Date.now() / 60000)}`;
    const minuteRes = await fetch(`${url}/incr/${encodeURIComponent(minuteKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const minuteCount = (await minuteRes.json()).result || 0;
    if (minuteCount === 1) {
      await fetch(`${url}/expire/${encodeURIComponent(minuteKey)}/120`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    if (minuteCount > MAX_SEARCHES_PER_MINUTE) return { blocked: true, reason: 'minute' };

    // Per-day bucket.
    const todayUtc = new Date().toISOString().slice(0, 10);
    const dayKey = `rate_day:${ip}:${todayUtc}`;
    const dayRes = await fetch(`${url}/incr/${encodeURIComponent(dayKey)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const dayCount = (await dayRes.json()).result || 0;
    if (dayCount === 1) {
      await fetch(`${url}/expire/${encodeURIComponent(dayKey)}/90000`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    if (dayCount > MAX_SEARCHES_PER_DAY) return { blocked: true, reason: 'day' };

    return { blocked: false };
  } catch (e) {
    return { blocked: false };
  }
}

// --- Search providers --------------------------------------------------------
// Each provider normalizes its response to a common product shape:
// { title, price, source, link, image, condition, provider }.

async function searchSerpApi(query) {
  try {
    const key = process.env.SERPAPI_KEY;
    if (!key) return [];
    const res = await fetch(`https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(query)}&gl=it&hl=it&api_key=${key}`);
    const data = await res.json();
    if (data.error) return [];
    await incrementUsageCounter('serpapi');
    return (data.shopping_results || []).map(item => ({
      title: item.title, price: item.price, source: item.source,
      link: item.product_link || item.link, image: item.thumbnail,
      condition: item.second_hand_condition ? 'Used' : item.condition || 'New',
      provider: 'serpapi',
    }));
  } catch (e) { return []; }
}

async function searchSerper(query) {
  try {
    const key = process.env.SERPER_API_KEY;
    if (!key) return [];
    const res = await fetch('https://google.serper.dev/shopping', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'it', hl: 'it', num: 20 }),
    });
    const data = await res.json();
    if (!data.shopping) return [];
    await incrementUsageCounter('serper');
    return data.shopping.map(item => ({
      title: item.title, price: item.price, source: item.source,
      link: item.link, image: item.imageUrl, condition: 'New', provider: 'serper',
    }));
  } catch (e) { return []; }
}

async function searchSearchApi(query) {
  try {
    const key = process.env.SEARCHAPI_KEY;
    if (!key) return [];
    const res = await fetch(`https://www.searchapi.io/api/v1/search?engine=google_shopping&q=${encodeURIComponent(query)}&gl=it&hl=it&api_key=${key}`);
    const data = await res.json();
    if (data.error) return [];
    await incrementUsageCounter('searchapi');
    return (data.shopping_results || []).map(item => ({
      title: item.title, price: item.price, source: item.source,
      link: item.link, image: item.thumbnail, condition: 'New', provider: 'searchapi',
    }));
  } catch (e) { return []; }
}

async function searchZenserp(query) {
  try {
    const key = process.env.ZENSERP_API_KEY;
    if (!key) return [];
    const res = await fetch(`https://app.zenserp.com/api/v2/search?apikey=${key}&q=${encodeURIComponent(query)}&tbm=shop&gl=it&hl=it`);
    const data = await res.json();
    if (data.error) return [];
    await incrementUsageCounter('zenserp');
    return (data.shopping_results || []).map(item => ({
      title: item.title, price: item.price, source: item.domain || item.merchant,
      link: item.url || item.link, image: item.image, condition: 'New', provider: 'zenserp',
    }));
  } catch (e) { return []; }
}

// --- Marketplace integration (OAuth client-credentials example) --------------

async function getMarketplaceToken() {
  try {
    const clientId = process.env.EBAY_CLIENT_ID;
    const clientSecret = process.env.EBAY_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
    });
    const data = await res.json();
    return data.access_token || null;
  } catch (e) { return null; }
}

async function searchMarketplace(query, condition) {
  try {
    const token = await getMarketplaceToken();
    if (!token) return [];
    let conditionFilter = '';
    if (condition === 'new') conditionFilter = '&filter=conditions:{NEW}';
    if (condition === 'used') conditionFilter = '&filter=conditions:{USED}';
    const res = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=10&market=EBAY_IT${conditionFilter}`,
      { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_IT' } }
    );
    const data = await res.json();
    if (!data.itemSummaries?.length) return [];
    await incrementUsageCounter('ebay');
    return data.itemSummaries
      .filter(item => item.price && item.itemWebUrl)
      .map(item => ({
        title: item.title,
        price: `${parseFloat(item.price.value).toFixed(2)} €`,
        source: 'eBay', link: item.itemWebUrl,
        image: item.image?.imageUrl || null,
        condition: item.condition === 'New' ? 'New' : 'Used',
        provider: 'ebay',
      }));
  } catch (e) { return []; }
}

// --- Fallback cascade --------------------------------------------------------
// Providers are tried in order until one returns results; the marketplace
// integration is always merged in on top.
async function searchWithCascade(finalQuery, rawQuery, condition) {
  let results = [];
  if (condition === 'used') {
    results = await searchSerpApi(finalQuery);
    if (results.length === 0) results = await searchSearchApi(finalQuery);
    if (results.length === 0) results = await searchSerper(finalQuery);
    if (results.length === 0) results = await searchZenserp(finalQuery);
  } else {
    results = await searchSerper(finalQuery);
    if (results.length === 0) results = await searchSearchApi(finalQuery);
    if (results.length === 0) results = await searchZenserp(finalQuery);
  }
  const marketplaceResults = await searchMarketplace(rawQuery, condition);
  return [...results, ...marketplaceResults];
}

// --- Route handler -----------------------------------------------------------

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const condition = searchParams.get('condizione') || 'all';
  const userId = searchParams.get('userId') || null;

  if (!query) return NextResponse.json({ error: 'Please enter a product to search for' }, { status: 400 });

  // Lightweight liveness hook used by uptime monitoring.
  if (searchParams.get('monitor') === 'true') {
    return NextResponse.json({ products: [], monitor: true });
  }

  const ip = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';

  const { blocked, reason } = await checkRateLimit(ip);
  if (blocked) {
    const message = reason === 'day'
      ? 'You have reached your daily search limit. Please try again tomorrow.'
      : 'Too many searches. Please wait a moment.';
    return NextResponse.json({ error: message }, { status: 429 });
  }

  try {
    const finalQuery = buildQuery(query, condition);
    const cacheKey = `search:${finalQuery.toLowerCase().trim()}:${condition}`;

    const cached = await getCached(cacheKey);
    if (cached) {
      savePriceHistory(cached, query, userId).catch(() => {});
      return NextResponse.json({ products: cached, fromCache: true });
    }

    const allProducts = await searchWithCascade(finalQuery, query, condition);

    const classifiedProducts = allProducts.map(p => ({
      ...p, condition: classifyCondition(p.title, p.source, p.condition),
    }));

    let filteredByCondition = classifiedProducts;
    if (condition === 'new') filteredByCondition = classifiedProducts.filter(p => p.condition === 'New');
    else if (condition === 'used') filteredByCondition = classifiedProducts.filter(p => p.condition === 'Used');

    const validProducts = filteredByCondition.filter(p => p.price && p.link && p.title);

    await setCached(cacheKey, validProducts);
    savePriceHistory(validProducts, query, userId).catch(() => {});

    return NextResponse.json({ products: validProducts });
  } catch (error) {
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}

// --- Price-history persistence (fire-and-forget) -----------------------------
// Stores a few representative rows per search so price trends can be charted
// later. Runs detached from the response so it never adds latency.
async function savePriceHistory(products, query, userId) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey || !supabaseUrl.startsWith('https://')) return;
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseKey);
    const rows = products.slice(0, 5)
      .filter(p => p.price && p.link)
      .map(p => ({
        product_link: p.link,
        title: p.title,
        price: p.price,
        price_numeric: parseFloat((p.price || '0').replace(/[^0-9,.]/g, '').replace(',', '.')) || null,
        source: p.source,
        image: p.image || null,
        query: query,
        user_id: userId || null,
      }));
    if (rows.length > 0) await supabase.from('price_history').insert(rows);
  } catch (e) {}
}
