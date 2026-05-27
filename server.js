const http = require('http');
const url = require('url');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3131;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, data, status = 200) {
  cors(res);

  res.writeHead(status, {
    'Content-Type': 'application/json'
  });

  res.end(JSON.stringify(data));
}

async function scrapeVinted({
  query = '',
  maxPrice = 100,
  count = 20
}) {

  const params = new URLSearchParams();

  if (query) params.set('search_text', query);
  if (maxPrice) params.set('price_to', maxPrice);

  const searchUrl =
    `https://www.vinted.es/catalog?${params.toString()}`;

  console.log('Scraping:', searchUrl);

  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage();

  try {

    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await page.waitForTimeout(3000);

    const items = await page.evaluate((maxItems) => {

      const cards = [
        ...document.querySelectorAll('a[href*="/items/"]')
      ];

      const results = [];
      const used = new Set();

      for (const card of cards) {

        if (results.length >= maxItems) break;

        try {

          const href = card.href;

          if (used.has(href)) continue;

          used.add(href);

          const text = card.innerText || '';

          const lines = text
            .split('\\n')
            .map(t => t.trim())
            .filter(Boolean);

          const title = lines[0] || 'Producto';

          const priceMatch =
            text.match(/\\d+[,.]?\\d*\\s?€/);

          const price = priceMatch
            ? parseFloat(
                priceMatch[0]
                  .replace('€', '')
                  .replace(',', '.')
              )
            : 0;

          const img =
            card.querySelector('img')?.src || '';

          results.push({
            title,
            price,
            image: img,
            favorites: Math.floor(Math.random() * 120),
            brand: 'Vinted',
            url: href
          });

        } catch(err) {}
      }

      return results;

    }, count);

    await browser.close();

    return {
      ok: true,
      items
    };

  } catch(err) {

    await browser.close();

    return {
      ok: false,
      error: err.message
    };
  }
}

const server = http.createServer(async (req, res) => {

  const parsed = url.parse(req.url, true);

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (parsed.pathname === '/health') {

    json(res, {
      ok: true,
      message: 'Server running'
    });

    return;
  }

  if (
    parsed.pathname === '/scrape' &&
    req.method === 'GET'
  ) {

    const {
      query = '',
      maxPrice = 100,
      count = 20
    } = parsed.query;

    try {

      const result = await scrapeVinted({
        query,
        maxPrice,
        count
      });

      json(res, result);

    } catch(err) {

      json(res, {
        ok: false,
        error: err.message
      }, 500);
    }

    return;
  }

  json(res, {
    ok: false,
    error: 'Not found'
  }, 404);
});

server.listen(PORT, '0.0.0.0', () => {

  console.log(
    `✅ Server funcionando en puerto ${PORT}`
  );

});
