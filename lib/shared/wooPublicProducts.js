import { parseHtmlToPlainText, retryWithBackoff } from './utils.js';
import { productIdFilter } from './catalogUpsert.js';

const PUBLIC_WOO_PRODUCTS_LIMIT = 100;
const configuredPopularMinSales = Number.parseInt(process.env.WOO_POPULAR_MIN_SALES || '', 10);
const DEFAULT_POPULAR_MIN_SALES = Number.isFinite(configuredPopularMinSales) ? configuredPopularMinSales : 10;
const POPULARITY_LABEL_PATTERN = /(?:best[\s_-]*sell(?:er|ing)?|most[\s_-]*popular|popular|רב[\s-]*מכר|רבי[\s-]*מכר|הנמכר(?:ים|ות)?[\s-]*ביותר|פופולר(?:י|ית|יים|יות))/i;
const POPULARITY_META_KEY_PATTERN = /^(?:_?best_?seller|_?bestseller|_?popular|_?popular_product|_?is_popular|_?featured)$/i;

// A realistic desktop browser UA so the request passes simple UA/bot gates that
// reject non-browser clients (the Semantix endpoint sits behind browser protection).
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Build request headers that look like a browser, optionally carrying an
 * Authorization header to pass HTTP Basic Auth gates.
 */
function buildBrowserHeaders(authHeader) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
    'User-Agent': BROWSER_USER_AGENT
  };
  if (authHeader) headers.Authorization = authHeader;
  return headers;
}

/**
 * Extract HTTP Basic Auth credentials embedded in the input URL
 * (e.g. https://user:pass@host) and return an `Authorization` header value.
 * Returns null when no credentials are present.
 */
function basicAuthHeaderFromInput(inputUrl) {
  try {
    const url = new URL(String(inputUrl || '').trim());
    if (url.username || url.password) {
      const user = decodeURIComponent(url.username);
      const pass = decodeURIComponent(url.password);
      const token = btoa(`${user}:${pass}`);
      return `Basic ${token}`;
    }
  } catch (_) {}
  return null;
}

function stripHtmlObject(value) {
  if (typeof value === 'string') return parseHtmlToPlainText(value);
  if (typeof value?.rendered === 'string') return parseHtmlToPlainText(value.rendered);
  return '';
}

function isTruthyWooFlag(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'featured', 'popular', 'best_seller', 'bestseller'].includes(normalized);
}

function collectWooTaxonomyLabels(product) {
  const source = product?.publicProductJson || product || {};
  const values = [
    ...(Array.isArray(product?.categories) ? product.categories : []),
    ...(Array.isArray(product?.tags) ? product.tags : []),
    ...(Array.isArray(source.categories) ? source.categories : []),
    ...(Array.isArray(source.tags) ? source.tags : [])
  ];

  return values.flatMap(value => {
    if (typeof value === 'string') return [value];
    return [value?.name, value?.slug].filter(Boolean);
  });
}

function collectNestedPopularityFlags(value, path = '', depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return [];

  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = path ? `${path}.${key}` : key;
    const directMatch = (
      (POPULARITY_META_KEY_PATTERN.test(key) || POPULARITY_LABEL_PATTERN.test(key))
      && isTruthyWooFlag(child)
    ) ? [childPath] : [];

    return child && typeof child === 'object'
      ? [...directMatch, ...collectNestedPopularityFlags(child, childPath, depth + 1)]
      : directMatch;
  });
}

export function getWooPopularitySignals(product, { minSales = DEFAULT_POPULAR_MIN_SALES } = {}) {
  const source = product?.publicProductJson || product || {};
  const rawTotalSales = product?.total_sales ?? source.total_sales ?? source.totalSales ?? 0;
  const totalSales = Number.parseInt(String(rawTotalSales || 0), 10) || 0;
  const featured = [
    product?.featured,
    product?.is_featured,
    source.featured,
    source.is_featured
  ].some(isTruthyWooFlag);

  const taxonomyMatch = collectWooTaxonomyLabels(product).find(label => POPULARITY_LABEL_PATTERN.test(String(label)));
  const metadata = [
    ...(Array.isArray(product?.meta_data) ? product.meta_data : []),
    ...(Array.isArray(source.meta_data) ? source.meta_data : [])
  ];
  const metadataMatch = metadata.find(item =>
    POPULARITY_META_KEY_PATTERN.test(String(item?.key || '')) && isTruthyWooFlag(item?.value)
  );
  const extensionMatch = collectNestedPopularityFlags(source.extensions || product?.extensions)[0];

  const signals = [];
  if (featured) signals.push('featured');
  if (taxonomyMatch) signals.push(`taxonomy:${taxonomyMatch}`);
  if (metadataMatch) signals.push(`metadata:${metadataMatch.key}`);
  if (extensionMatch) signals.push(`extension:${extensionMatch}`);
  if (totalSales >= minSales) signals.push(`total_sales:${totalSales}`);

  return {
    isPopular: signals.length > 0,
    signals,
    totalSales,
    featured
  };
}

export function withWooPopularityData(product) {
  const popularity = getWooPopularitySignals(product);
  return {
    ...product,
    wooPopularity: popularity,
    isWooPopular: popularity.isPopular,
    wooPopularitySignals: popularity.signals,
    total_sales: popularity.totalSales,
    featured: popularity.featured
  };
}

export async function applyWooDefaultBoosts(collection, products, { boost = 1 } = {}) {
  const popularProducts = products
    .map(product => ({ product, popularity: getWooPopularitySignals(product) }))
    .filter(({ popularity }) => popularity.isPopular);

  if (popularProducts.length === 0) {
    return { detected: 0, boosted: 0 };
  }

  const result = await collection.bulkWrite(
    popularProducts.map(({ product, popularity }) => ({
      updateOne: {
        filter: {
          $and: [
            productIdFilter(product.id),
            { $or: [{ boost: { $exists: false } }, { boost: null }] }
          ]
        },
        update: {
          $set: {
            boost,
            boostSource: 'woocommerce-popularity',
            wooPopularity: popularity,
            autoBoostedAt: new Date()
          }
        }
      }
    })),
    { ordered: false }
  );

  return {
    detected: popularProducts.length,
    boosted: result.modifiedCount || 0
  };
}

function siteOriginFromInput(inputUrl) {
  const url = new URL(String(inputUrl || '').trim());
  return `${url.protocol}//${url.host}`;
}

export function normalizeWooStoreEndpoint(inputUrl) {
  const origin = siteOriginFromInput(inputUrl);
  const url = new URL(`${origin}/wp-json/wc/store/v1/products`);
  url.hash = '';
  return url;
}

export function normalizeWooPublicEndpoint(inputUrl) {
  const origin = siteOriginFromInput(inputUrl);
  const url = new URL(`${origin}/wp-json/wp/v2/product`);
  url.hash = '';
  return url;
}

export function normalizeWooSemantixEndpoint(inputUrl) {
  const origin = siteOriginFromInput(inputUrl);
  const url = new URL(`${origin}/wp-json/semantix/v1/public-products`);
  url.hash = '';
  return url;
}

function parseStoreApiPrices(prices) {
  if (!prices) return { price: 0, regular_price: 0, sale_price: 0 };

  const minorUnit = Number.isFinite(prices.currency_minor_unit) ? prices.currency_minor_unit : 2;
  const divisor = Math.pow(10, minorUnit);

  const parseAmount = (value) => {
    if (value === '' || value === null || value === undefined) return 0;
    const numeric = Number.parseFloat(String(value));
    if (!Number.isFinite(numeric)) return 0;
    return numeric / divisor;
  };

  const price = parseAmount(prices.price);
  const regular_price = parseAmount(prices.regular_price);
  const sale_price = parseAmount(prices.sale_price);

  return {
    price: price || regular_price || sale_price,
    regular_price: regular_price || price,
    sale_price: sale_price || 0
  };
}

/** Strict Woo stock: only explicit in-stock passes as instock. */
export function resolveWooStockStatus(product) {
  if (typeof product?.is_in_stock === 'boolean') {
    if (!product.is_in_stock) return 'outofstock';
    if (product.is_on_backorder === true) return 'onbackorder';
    return 'instock';
  }

  const status = String(product?.stock_status || '').toLowerCase().trim();
  if (status === 'instock' || status === 'outofstock' || status === 'onbackorder') {
    return status;
  }

  // wp/v2 and unknown shapes — do not assume in stock
  return 'outofstock';
}

export function normalizeStoreApiWooProduct(product) {
  const name = stripHtmlObject(product.name) || `Product ${product.id}`;
  const description = stripHtmlObject(product.description) || '';
  const shortDescription = stripHtmlObject(product.short_description) || '';
  const image = product.images?.[0]?.src || product.images?.[0]?.thumbnail || null;
  const prices = parseStoreApiPrices(product.prices);
  const stock_status = resolveWooStockStatus(product);

  return withWooPopularityData({
    id: product.id,
    name,
    title: name,
    slug: product.slug || null,
    description,
    short_description: shortDescription,
    price: prices.price,
    regular_price: prices.regular_price,
    sale_price: prices.sale_price,
    stock_status,
    stockStatus: stock_status,
    on_sale: Boolean(product.on_sale),
    categories: Array.isArray(product.categories)
      ? product.categories.map(cat => ({ id: cat.id, name: cat.name, slug: cat.slug }))
      : [],
    images: image ? [{ src: image }] : [],
    image,
    url: product.permalink || product.link || null,
    permalink: product.permalink || product.link || null,
    active: true,
    fetchedAt: new Date(),
    sourcePlatform: 'woocommerce',
    sourceType: 'public_wc_store_v1',
    publicProductJson: product
  });
}

export function normalizePublicWooProduct(product) {
  const name = stripHtmlObject(product.title) || product.name || `Product ${product.id}`;
  const description = stripHtmlObject(product.content) || product.description || '';
  const shortDescription = stripHtmlObject(product.excerpt) || product.short_description || '';
  const image = product.yoast_head_json?.og_image?.[0]?.url || product._embedded?.['wp:featuredmedia']?.[0]?.source_url || null;
  const stock_status = resolveWooStockStatus(product);

  return withWooPopularityData({
    id: product.id,
    name,
    title: name,
    slug: product.slug || null,
    description,
    short_description: shortDescription,
    price: 0,
    regular_price: 0,
    sale_price: 0,
    stock_status,
    stockStatus: stock_status,
    categories: [],
    images: image ? [{ src: image }] : [],
    image,
    url: product.link || product.guid?.rendered || null,
    permalink: product.link || product.guid?.rendered || null,
    active: product.status ? product.status === 'publish' : true,
    fetchedAt: new Date(),
    sourcePlatform: 'woocommerce',
    sourceType: 'public_wp_v2_product',
    publicProductJson: product
  });
}

/** Parse a price that may be numeric, a plain string, or HTML (e.g. "₪99.90"). */
function parsePlainPrice(value) {
  if (value === '' || value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;

  const stripped = String(value).replace(/<[^>]*>/g, '').replace(/[^0-9.,]/g, '');
  if (!stripped) return 0;

  // If only a comma is present, treat it as the decimal separator; otherwise drop commas as thousands separators.
  const normalized = stripped.includes(',') && !stripped.includes('.')
    ? stripped.replace(',', '.')
    : stripped.replace(/,/g, '');

  const numeric = Number.parseFloat(normalized);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeSemantixCategories(categories) {
  if (!Array.isArray(categories)) return [];
  return categories
    .map(cat => (typeof cat === 'string'
      ? { id: null, name: cat, slug: null }
      : { id: cat?.id ?? null, name: cat?.name ?? cat?.title ?? '', slug: cat?.slug ?? null }))
    .filter(cat => cat.name);
}

function pickSemantixImage(product) {
  // Prefer gallery_images if available and not empty
  if (Array.isArray(product.gallery_images) && product.gallery_images.length > 0) {
    const first = product.gallery_images[0];
    if (typeof first === 'string') return first;
    return first?.src || first?.url || first?.thumbnail || null;
  }
  // Fallback to existing logic
  if (typeof product.main_image === 'string' && product.main_image) return product.main_image;
  if (typeof product.image === 'string' && product.image) return product.image;
  if (product.image?.src) return product.image.src;
  if (typeof product.image_url === 'string' && product.image_url) return product.image_url;
  if (typeof product.thumbnail === 'string' && product.thumbnail) return product.thumbnail;
  if (Array.isArray(product.images) && product.images.length > 0) {
    const first = product.images[0];
    if (typeof first === 'string') return first;
    return first?.src || first?.url || first?.thumbnail || null;
  }
  return null;
}

/**
 * Normalize a product from the Semantix custom endpoint
 * (GET /wp-json/semantix/v1/public-products?page=N).
 *
 * The endpoint's exact shape can vary by plugin version, so this mapper is
 * intentionally tolerant of common field-name variants.
 */
export function normalizeSemantixWooProduct(product) {
  const id = product.id ?? product.product_id ?? product.ID;
  const name = stripHtmlObject(product.name ?? product.title ?? product.post_title) || `Product ${id}`;
  const description = stripHtmlObject(product.description ?? product.content ?? product.post_content) || '';
  const shortDescription = stripHtmlObject(product.short_description ?? product.excerpt) || '';
  const image = pickSemantixImage(product);

  const regular_price = parsePlainPrice(product.regular_price);
  const sale_price = parsePlainPrice(product.sale_price);
  const basePrice = parsePlainPrice(product.price);
  const price = basePrice || sale_price || regular_price;

  // Resolve stock from whatever signal the endpoint provides.
  // Prioritize `is_in_stock: false` if explicitly present.
  const stock_status = (typeof product.is_in_stock === 'boolean' && !product.is_in_stock)
    ? 'outofstock'
    : resolveWooStockStatus({
        is_in_stock: typeof product.is_in_stock === 'boolean'
          ? product.is_in_stock
          : (typeof product.in_stock === 'boolean' ? product.in_stock : undefined),
        is_on_backorder: product.is_on_backorder,
        stock_status: product.stock_status
      });

  const url = product.url || product.permalink || product.link || null;

  return withWooPopularityData({
    id,
    name,
    title: name,
    slug: product.slug || null,
    description,
    short_description: shortDescription,
    sku: product.sku || null,
    price,
    regular_price: regular_price || price,
    sale_price: sale_price || 0,
    stock_status,
    stockStatus: stock_status,
    on_sale: Boolean(product.on_sale) || (sale_price > 0 && regular_price > 0 && sale_price < regular_price),
    categories: normalizeSemantixCategories(product.categories),
    images: image ? [{ src: image }] : [],
    image,
    url,
    permalink: url,
    active: product.status ? product.status === 'publish' : (product.active !== false),
    fetchedAt: new Date(),
    sourcePlatform: 'woocommerce',
    sourceType: 'public_semantix_v1',
    publicProductJson: product
  });
}

async function fetchStoreApiPage(url) {
  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Semantix/1.1'
    },
    cache: 'no-store'
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Woo Store API fetch failed (${response.status}): ${body.slice(0, 200)}`);
  }

  return {
    products: await response.json(),
    totalPages: Number.parseInt(response.headers.get('x-wp-totalpages') || '', 10)
  };
}

function keepInStockProducts(products, onlyInStock) {
  if (!onlyInStock) return products;
  return products.filter(p => p.stock_status === 'instock' && p.stockStatus === 'instock');
}

async function fetchSemantixPage(url, authHeader) {
  const response = await fetch(url.toString(), {
    headers: buildBrowserHeaders(authHeader),
    redirect: 'follow',
    cache: 'no-store'
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Semantix public-products fetch failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const json = await response.json();

  let products = [];
  let totalPages = NaN;
  if (Array.isArray(json)) {
    products = json;
  } else if (json && typeof json === 'object') {
    products = json.products || json.data || json.items || json.results || [];
    totalPages = Number.parseInt(
      json.total_pages ?? json.totalPages ?? json.pages ?? json.max_num_pages ?? '',
      10
    );
  }

  if (!Number.isFinite(totalPages)) {
    const headerTotal = Number.parseInt(response.headers.get('x-wp-totalpages') || '', 10);
    if (Number.isFinite(headerTotal)) totalPages = headerTotal;
  }

  return {
    products: Array.isArray(products) ? products : [],
    totalPages
  };
}

async function fetchPublicWooProductsFromSemantix(inputUrl, { onPage, onlyInStock = true } = {}) {
  const endpoint = normalizeWooSemantixEndpoint(inputUrl);
  const authHeader = basicAuthHeaderFromInput(inputUrl);
  const allProducts = [];
  let page = 1;

  while (true) {
    const url = new URL(endpoint.toString());
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(PUBLIC_WOO_PRODUCTS_LIMIT));

    let response;
    try {
      response = await retryWithBackoff(() => fetchSemantixPage(url, authHeader), 3, 1000);
    } catch (error) {
      if (allProducts.length > 0) {
        console.warn(`[wooPublicProducts] Semantix endpoint stopped at page ${page}, keeping ${allProducts.length} products:`, error.message);
        break;
      }
      throw error;
    }

    const products = response.products;
    const normalized = products.map(normalizeSemantixWooProduct);
    const kept = keepInStockProducts(normalized, onlyInStock);
    allProducts.push(...kept);

    if (onPage) {
      await onPage({
        page,
        count: products.length,
        kept: kept.length,
        total: allProducts.length,
        url: url.toString(),
        source: 'semantix/v1'
      });
    }

    if (products.length === 0) break;
    if (Number.isFinite(response.totalPages) && page >= response.totalPages) break;
    if (page >= 1000) break; // hard safety cap
    page += 1;
  }

  return allProducts;
}

async function fetchPublicWooProductsFromStore(inputUrl, { onPage, onlyInStock = true } = {}) {
  const endpoint = normalizeWooStoreEndpoint(inputUrl);
  const allProducts = [];
  let page = 1;

  while (true) {
    const url = new URL(endpoint.toString());
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(PUBLIC_WOO_PRODUCTS_LIMIT));
    if (onlyInStock) {
      url.searchParams.set('stock_status', 'instock');
    }

    let response;
    try {
      response = await retryWithBackoff(() => fetchStoreApiPage(url), 3, 1000);
    } catch (error) {
      if (allProducts.length > 0) {
        console.warn(`[wooPublicProducts] Store API stopped at page ${page}, keeping ${allProducts.length} products:`, error.message);
        break;
      }
      throw error;
    }

    const products = Array.isArray(response.products) ? response.products : [];
    const normalized = products.map(normalizeStoreApiWooProduct);
    const kept = keepInStockProducts(normalized, onlyInStock);
    allProducts.push(...kept);

    if (onPage) {
      await onPage({
        page,
        count: products.length,
        kept: kept.length,
        total: allProducts.length,
        url: url.toString(),
        source: 'wc/store/v1'
      });
    }

    if (products.length === 0) break;

    if (Number.isFinite(response.totalPages) && page >= response.totalPages) break;
    page += 1;
  }

  return allProducts;
}

async function fetchPublicWooProductsFromWpV2(inputUrl, { onPage, onlyInStock = false } = {}) {
  const endpoint = normalizeWooPublicEndpoint(inputUrl);
  const allProducts = [];
  let page = 1;

  while (true) {
    const url = new URL(endpoint.toString());
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(PUBLIC_WOO_PRODUCTS_LIMIT));
    url.searchParams.set('_embed', '1');

    const response = await retryWithBackoff(async () => {
      const res = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Semantix/1.1'
        },
        cache: 'no-store'
      });

      if (res.status === 400 && page > 1) {
        const body = await res.text().catch(() => '');
        if (body.includes('rest_post_invalid_page_number')) {
          return { products: [], totalPages: page - 1 };
        }
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Public Woo wp/v2 fetch failed (${res.status}): ${body.slice(0, 200)}`);
      }

      return {
        products: await res.json(),
        totalPages: Number.parseInt(res.headers.get('x-wp-totalpages') || '', 10)
      };
    }, 3, 1000);

    const products = Array.isArray(response.products) ? response.products : [];
    const normalized = products.map(normalizePublicWooProduct);
    const kept = keepInStockProducts(normalized, onlyInStock);
    allProducts.push(...kept);

    if (onPage) {
      await onPage({
        page,
        count: products.length,
        kept: kept.length,
        total: allProducts.length,
        url: url.toString(),
        source: 'wp/v2/product'
      });
    }

    if (products.length === 0) break;

    if (Number.isFinite(response.totalPages) && page >= response.totalPages) break;
    page += 1;
  }

  return allProducts;
}

/**
 * Fetch Woo products, preferring the Semantix custom endpoint
 * (/wp-json/semantix/v1/public-products), then falling back to the public
 * Store API (wc/store/v1) and finally wp/v2.
 * By default returns only products with stock_status === 'instock'.
 */
export async function fetchPublicWooProducts(inputUrl, { onPage, onlyInStock = true, fetchType = 'default' } = {}) {
  // If explicitly requesting Semantix custom endpoint, do not fall back.
  if (fetchType === 'semantix-custom') {
    try {
      const semantixProducts = await fetchPublicWooProductsFromSemantix(inputUrl, { onPage, onlyInStock });
      if (semantixProducts.length > 0) {
        return semantixProducts;
      }
      throw new Error('Semantix public-products endpoint returned 0 products.');
    } catch (error) {
      throw new Error(`Semantix public-products endpoint failed: ${error.message}`);
    }
  }

  // Default behavior: prefer Semantix custom endpoint, then fall back to Woo Store API, then wp/v2.
  // 1) Preferred: Semantix custom public-products endpoint (curated, includes prices + stock).
  try {
    const semantixProducts = await fetchPublicWooProductsFromSemantix(inputUrl, { onPage, onlyInStock });
    if (semantixProducts.length > 0) {
      return semantixProducts;
    }
    console.warn('[wooPublicProducts] Semantix public-products endpoint returned 0 products — falling back to Woo Store API');
  } catch (error) {
    console.warn('[wooPublicProducts] Semantix public-products endpoint failed — falling back to Woo Store API:', error.message);
  }

  // 2) Fallback: public Woo Store API (wc/store/v1).
  let storeProducts = [];
  let storeError = null;

  try {
    storeProducts = await fetchPublicWooProductsFromStore(inputUrl, { onPage, onlyInStock });
  } catch (error) {
    storeError = error;
    console.warn('[wooPublicProducts] Store API failed:', error.message);
  }

  if (storeProducts.length > 0) {
    return storeProducts;
  }

  console.warn(
    '[wooPublicProducts] Store API returned 0 in-stock products — trying wp/v2 fallback (no prices; stock unavailable)'
  );
  const wpProducts = await fetchPublicWooProductsFromWpV2(inputUrl, {
    onPage,
    onlyInStock: false
  });

  if (wpProducts.length > 0) {
    return wpProducts;
  }

  const hint = storeError
    ? `Store API error: ${storeError.message}. `
    : 'Store API returned no in-stock products. ';
  throw new Error(
    `${hint}Use the shop homepage URL (e.g. https://yourshop.com/), not a wp-json endpoint. wp/v2 cannot provide prices or reliable stock.`
  );
}
