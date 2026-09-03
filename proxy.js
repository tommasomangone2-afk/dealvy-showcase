/**
 * proxy.js  (project root — Next.js 16 request proxy, formerly "middleware")
 *
 * Runs at the edge on every request, before it reaches a route. Two jobs:
 *
 *   1. Anti-abuse: a fast first line of defence on the search API. It rejects
 *      requests with no User-Agent and obvious non-browser clients before they
 *      reach the (paid) search providers. This is intentionally only the cheap
 *      outer layer — the primary bot defence is a Cloudflare WAF managed-challenge
 *      rule in front of the app, with per-IP rate limiting inside the search route.
 *
 *   2. Locale detection: picks the UI language from an explicit cookie first, then
 *      the browser's Accept-Language, defaulting to Italian, and persists the
 *      choice in a cookie for subsequent requests. Six locales are supported.
 *
 * Notes for readers:
 *   - The User-Agent blocklist below is trimmed to a representative sample; the
 *     live list and the exact match strategy are deliberately not published, since
 *     an attacker could use them to shape a request that slips past this layer.
 *   - Identifiers and comments were translated from Italian for this showcase.
 */

import { NextResponse } from 'next/server';

const LOCALES = ['it', 'en', 'es', 'fr', 'de', 'pt'];
const DEFAULT_LOCALE = 'it';
const LANG_COOKIE = 'dealvy_lang';

// Representative sample of non-browser User-Agents rejected on the search API.
// (Trimmed for the showcase — the production list is longer and not published.)
const BOT_UA_PATTERNS = [
  'python-requests', 'curl/', 'wget/', 'scrapy', 'go-http-client',
  'headless', 'selenium', 'puppeteer', 'playwright',
  // ...additional patterns omitted...
];

function denied(message) {
  return new NextResponse(
    JSON.stringify({ error: message }),
    { status: 403, headers: { 'Content-Type': 'application/json' } }
  );
}

export function proxy(request) {
  const { pathname } = request.nextUrl;

  // --- 1. Anti-abuse on the search API ---------------------------------------
  if (pathname.startsWith('/api/search')) {
    const userAgent = (request.headers.get('user-agent') || '').toLowerCase();

    // No User-Agent at all is a strong non-browser signal.
    if (!userAgent.trim()) return denied('Invalid request');

    // Known non-browser clients.
    if (BOT_UA_PATTERNS.some(pattern => userAgent.includes(pattern))) {
      return denied('Access denied');
    }

    return NextResponse.next();
  }

  // --- 2. Locale detection (pages only; skip APIs, assets, files) -------------
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/sw.js') ||
    pathname.startsWith('/manifest.json') ||
    pathname.startsWith('/icon-') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  // An explicit user choice (cookie) always wins.
  const cookieLang = request.cookies.get(LANG_COOKIE)?.value;
  if (cookieLang && LOCALES.includes(cookieLang)) {
    return NextResponse.next();
  }

  // Otherwise infer from the browser, defaulting to Italian.
  const acceptLang = request.headers.get('accept-language') || '';
  const browserLang = acceptLang.split(',')[0].split('-')[0].toLowerCase();
  const locale = LOCALES.includes(browserLang) ? browserLang : DEFAULT_LOCALE;

  // Persist the resolved locale for subsequent requests (1 year).
  const response = NextResponse.next();
  response.cookies.set(LANG_COOKIE, locale, {
    maxAge: 60 * 60 * 24 * 365,
    path: '/',
    sameSite: 'lax',
  });
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
