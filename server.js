/**
 * Vinted Scraper Server — powered by Playwright
 * 
 * Uso:
 *   npm install
 *   node server.js
 * 
 * Expone en http://localhost:3131/scrape?query=nike&maxPrice=100&count=50&market=es
 */

const http = require('http');
const url = require('url');
const { chromium } = require('playwright');

const PORT = 3131;

// ── helpers ──────────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Domain per market
const DOMAINS = {
  es: 'www.vinted.es',
  fr: 'www.vinted.fr',
  de: 'www.vinted.de',
  it: 'www.vinted.it',
  uk: 'www.vinted.co.uk',
  pl: 'www.vinted.pl',
  be: 'www.vinted.be',
  nl: 'www.vinted.nl',
};

// ── scraper ───────────────────────────────────────────────────────────────────

async function scrapeVinted({ query = '', maxPrice = 200, count = 50, market = 'es', category = '' }) {
  const domain = DOMAINS[market] || DOMAINS.es;

  // Build search URL
  const params = new URLSearchParams();
  if (query)    params.set('search_text', query);
  if (maxPrice) params.set('price_to', maxPrice);
  if (category) params.set('catalog[]', category);
  params.set('order', 'relevance');

  const searchUrl = `https://${domain}/catalog?${params.toString()}`;
  console.log(`[scraper] Fetching: ${searchUrl}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: market === 'uk' ? 'en-GB' : market === 'fr' ? 'fr-FR' : market === 'de' ? 'de-DE' : market === 'it' ? 'it-IT' : 'es-ES',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  // Block heavy assets to speed things up
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,mp4,mp3}', r => r.abort());

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Accept cookies if banner appears
    try {
      await page.click('[data-testid="cookie-banner-accept-all"], #onetrust-accept-btn-handler, button[id*="accept"]', { timeout: 4000 });
      await page.waitForTimeout(800);
    } catch (_) { /* no cookie banner */ }

    // Wait for item grid
    await page.waitForSelector('[data-testid="catalog-items-list"], .feed-grid, .ItemBox_overlay__nkZGd', { timeout: 15000 });

    // Scroll to load more items (up to ~200)
    const targetItems = Math.min(parseInt(count) || 50, 200);
    let prev = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      const current = await page.$$eval(
        '[data-testid="catalog-items-list"] > *, .feed-grid__item, .ItemBox_overlay__nkZGd',
        els => els.length
      ).catch(() => 0);
      if (current >= targetItems) break;
      if (current === prev && attempt > 2) break;
      prev = current;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
    }

    // Extract item data
    const items = await page.evaluate((targetCount) => {
      const results = [];

      // Try multiple possible selectors across Vinted versions
      const cards = [
        ...document.querySelectorAll('[data-testid="catalog-items-list"] > *'),
        ...document.querySelectorAll('.feed-grid__item'),
      ].filter(el => el.querySelector('a[href*="/items/"]'));

      const seen = new Set();

      for (const card of cards) {
        if (results.length >= targetCount) break;

        try {
          const link = card.querySelector('a[href*="/items/"]');
          if (!link) continue;
          const href = link.href;
          if (seen.has(href)) continue;
          seen.add(href);

          // Title
          const titleEl = card.querySelector('[data-testid="catalog-item-title"], .ItemBox_title__HGDqK, .ItemBox__title, [class*="title"]');
          const title = titleEl?.textContent?.trim() || link.title || '';
          if (!title) continue;

          // Price
          const priceEl = card.querySelector('[data-testid="catalog-item-price"], .ItemBox_price__e7nzX, [class*="price"]');
          const priceText = priceEl?.textContent?.replace(/[^\d.,]/g, '').replace(',', '.') || '0';
          const price = parseFloat(priceText) || 0;

          // Brand (often in subtitle)
          const brandEl = card.querySelector('[data-testid="catalog-item-brand"], .ItemBox_brand, [class*="brand"], [class*="subtitle"]');
          const brand = brandEl?.textContent?.trim() || '';

          // Favorites
          const favEl = card.querySelector('[data-testid="catalog-item-like-count"], [class*="like"], [class*="fav"]');
          const favText = favEl?.textContent?.replace(/[^\d]/g, '') || '0';
          const favorites = parseInt(favText) || 0;

          // Condition
          const condEl = card.querySelector('[data-testid="catalog-item-condition"], [class*="condition"], [class*="status"]');
          const condition = condEl?.textContent?.trim() || '';

          // Image
          const imgEl = card.querySelector('img');
          const image = imgEl?.src || imgEl?.dataset?.src || '';

          // Size
          const sizeEl = card.querySelector('[data-testid="catalog-item-size"], [class*="size"]');
          const size = sizeEl?.textContent?.trim() || '';

          results.push({ title, brand, price, favorites, condition, size, image, url: href });
        } catch (_) { /* skip malformed card */ }
      }

      return results;
    }, targetItems);

    await browser.close();

    console.log(`[scraper] Extracted ${items.length} items`);
    return { ok: true, items, source: searchUrl, count: items.length };

  } catch (err) {
    await browser.close();
    console.error('[scraper] Error:', err.message);
    return { ok: false, error: err.message, items: [] };
  }
}

// ── HTTP server ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (parsed.pathname === '/scrape' && req.method === 'GET') {
    const { query = '', maxPrice = 200, count = 50, market = 'es', category = '' } = parsed.query;
    console.log(`[server] /scrape query="${query}" market=${market} maxPrice=${maxPrice} count=${count}`);

    try {
      const result = await scrapeVinted({ query, maxPrice, count, market, category });
      json(res, result);
    } catch (err) {
      json(res, { ok: false, error: err.message, items: [] }, 500);
    }
    return;
  }

  if (parsed.pathname === '/health') {
    json(res, { ok: true, message: 'Vinted scraper server running', port: PORT });
    return;
  }

  json(res, { ok: false, error: 'Not found' }, 404);
});

server.listen(PORT, () => {
  console.log(`\n✅ Vinted Scraper Server corriendo en http://localhost:${PORT}`);
  console.log(`   GET /scrape?query=nike&market=es&maxPrice=100&count=50`);
  console.log(`   GET /health\n`);
});
