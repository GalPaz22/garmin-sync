import { GraphQLClient, gql } from 'graphql-request';
import { parseHtmlToPlainText, retryWithBackoff } from './utils.js';
import { resolveShopifyToken } from './shopifyAuth.js';

const PUBLIC_PRODUCTS_LIMIT = 250;
const PUBLIC_PRODUCTS_PAGE_DELAY_MS = 750;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function normalizeShopifyStorefrontDomain(shopifyDomain) {
  const cleanDomain = String(shopifyDomain || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase();

  if (!cleanDomain) {
    throw new Error('Shopify domain is required');
  }

  return cleanDomain.includes('.') ? cleanDomain : `${cleanDomain}.myshopify.com`;
}

function toShopifyGid(type, id) {
  if (!id) return null;
  const value = String(id);
  return value.startsWith('gid://') ? value : `gid://shopify/${type}/${value}`;
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.filter(Boolean);
  if (typeof tags === 'string') {
    return tags.split(',').map(tag => tag.trim()).filter(Boolean);
  }
  return [];
}

function getSelectedOptions(productOptions, variant) {
  return [variant.option1, variant.option2, variant.option3]
    .map((value, index) => {
      if (!value) return null;
      return {
        name: productOptions[index]?.name || `Option ${index + 1}`,
        value
      };
    })
    .filter(Boolean);
}

function getVariantImage(variant, images) {
  if (variant.featured_image?.src) return variant.featured_image;
  return images.find(image => Array.isArray(image.variant_ids) && image.variant_ids.includes(variant.id)) || null;
}

function isPublicVariantInStock(variant) {
  // Shopify's public products.json exposes this as the saleability flag.
  return variant.available === true;
}

function normalizePublicVariant(product, variant, images) {
  const image = getVariantImage(variant, images);
  const inStock = isPublicVariantInStock(variant);

  return {
    id: toShopifyGid('ProductVariant', variant.id),
    sku: variant.sku || null,
    title: variant.title || null,
    price: variant.price ?? null,
    compareAtPrice: variant.compare_at_price ?? null,
    inventoryQuantity: typeof variant.inventory_quantity === 'number' ? variant.inventory_quantity : null,
    inventoryPolicy: variant.inventory_policy || null,
    availableForSale: inStock,
    stockStatus: inStock ? 'instock' : 'outofstock',
    taxable: Boolean(variant.taxable),
    barcode: variant.barcode || null,
    createdAt: variant.created_at || null,
    updatedAt: variant.updated_at || null,
    selectedOptions: getSelectedOptions(product.options || [], variant),
    image: image
      ? {
          id: toShopifyGid('ProductImage', image.id),
          src: image.src,
          altText: image.alt || null
        }
      : null
  };
}

export function normalizePublicShopifyProduct(product, storefrontDomain) {
  const images = Array.isArray(product.images) ? product.images : [];
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const variantEdges = variants.map(variant => ({
    node: normalizePublicVariant(product, variant, images)
  }));
  const imageEdges = images.map(image => ({
    node: {
      id: toShopifyGid('ProductImage', image.id),
      src: image.src,
      altText: image.alt || null,
      width: image.width || null,
      height: image.height || null
    }
  }));

  const prices = variants
    .map(variant => Number.parseFloat(variant.price))
    .filter(price => Number.isFinite(price));
  const minPrice = prices.length ? Math.min(...prices) : 0;
  const maxPrice = prices.length ? Math.max(...prices) : minPrice;
  const hasAvailableVariant = variants.some(isPublicVariantInStock);
  const knownInventory = variants
    .map(variant => variant.inventory_quantity)
    .filter(quantity => typeof quantity === 'number');
  const totalInventory = knownInventory.length > 0
    ? knownInventory.reduce((sum, quantity) => sum + Math.max(quantity, 0), 0)
    : (hasAvailableVariant ? 1 : 0);
  const stockStatus = totalInventory > 0 ? 'instock' : 'outofstock';

  return {
    id: toShopifyGid('Product', product.id),
    numericId: product.id ? String(product.id) : null,
    title: product.title,
    handle: product.handle,
    vendor: product.vendor || null,
    productType: product.product_type || null,
    tags: normalizeTags(product.tags),
    onlineStoreUrl: product.handle ? `https://${storefrontDomain}/products/${product.handle}` : null,
    status: product.published_at ? 'ACTIVE' : 'DRAFT',
    description: parseHtmlToPlainText(product.body_html || ''),
    bodyHtml: product.body_html || '',
    publishedAt: product.published_at || null,
    createdAt: product.created_at || null,
    updatedAt: product.updated_at || null,
    totalInventory,
    tracksInventory: true,
    stockStatus,
    images: { edges: imageEdges },
    variants: { edges: variantEdges },
    priceRange: {
      minVariantPrice: { amount: String(minPrice) },
      maxVariantPrice: { amount: String(maxPrice) }
    },
    publicProductJson: product
  };
}

export async function fetchPublicShopifyProducts(shopifyDomain, { onPage, pageDelayMs = PUBLIC_PRODUCTS_PAGE_DELAY_MS } = {}) {
  const storefrontDomain = normalizeShopifyStorefrontDomain(shopifyDomain);
  const allProducts = [];
  let page = 1;

  while (true) {
    const url = new URL(`https://${storefrontDomain}/products.json`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', String(PUBLIC_PRODUCTS_LIMIT));

    const data = await retryWithBackoff(async () => {
      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json,text/plain,*/*',
          'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
          Referer: `https://${storefrontDomain}/`,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin'
        },
        cache: 'no-store'
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Public Shopify products fetch failed (${response.status}): ${body.slice(0, 200)}`);
      }

      return response.json();
    }, 3, 1000);

    const products = Array.isArray(data.products) ? data.products : [];
    if (onPage) await onPage({ page, count: products.length, total: allProducts.length + products.length, url: url.toString() });

    if (products.length === 0) break;

    allProducts.push(...products.map(product => normalizePublicShopifyProduct(product, storefrontDomain)));
    page += 1;

    if (pageDelayMs > 0) {
      await sleep(pageDelayMs);
    }
  }

  return allProducts;
}

export async function fetchAdminShopifyProducts({
  shopifyDomain,
  shopifyToken,
  shopifyClientId,
  shopifyClientSecret,
  onPage,
  batchSize = 100,
  imageCount = 10,
  apiVersion = '2025-01'
}) {
  const fullDomain = normalizeShopifyStorefrontDomain(shopifyDomain);
  const accessToken = await resolveShopifyToken(fullDomain, shopifyToken, shopifyClientId, shopifyClientSecret);
  const graphQLClient = new GraphQLClient(`https://${fullDomain}/admin/api/${apiVersion}/graphql.json`, {
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
      'User-Agent': 'Semantix/1.1'
    },
    timeout: 30000
  });

  const query = gql`
    query getProducts($first: Int!, $after: String, $imageCount: Int!) {
      products(first: $first, after: $after) {
        edges {
          node {
            id
            title
            handle
            vendor
            productType
            tags
            onlineStoreUrl
            status
            description
            totalInventory
            tracksInventory
            images(first: $imageCount) {
              edges { node { id src: url altText } }
            }
            variants(first: 50) {
              edges {
                node {
                  id
                  sku
                  title
                  price
                  compareAtPrice
                  inventoryQuantity
                  inventoryPolicy
                  availableForSale
                  taxable
                  barcode
                  createdAt
                  updatedAt
                  image { id src: url altText }
                  selectedOptions { name value }
                }
              }
            }
            priceRange {
              minVariantPrice { amount }
              maxVariantPrice { amount }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const allProducts = [];
  let page = 1;
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const variables = { first: batchSize, after: cursor, imageCount };
    const data = await retryWithBackoff(() => graphQLClient.request(query, variables), 3, 2000);
    const productsBatch = data.products.edges.map(edge => edge.node);
    allProducts.push(...productsBatch);

    if (onPage) await onPage({ page, count: productsBatch.length, total: allProducts.length });

    hasNextPage = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
    page += 1;
  }

  return allProducts;
}

export async function fetchShopifyProducts({
  shopifyDomain,
  shopifyToken,
  shopifyClientId,
  shopifyClientSecret,
  onPage,
  batchSize,
  imageCount
}) {
  const hasAdminCredentials = Boolean(shopifyToken || (shopifyClientId && shopifyClientSecret));

  if (hasAdminCredentials) {
    return fetchAdminShopifyProducts({
      shopifyDomain,
      shopifyToken,
      shopifyClientId,
      shopifyClientSecret,
      onPage,
      batchSize,
      imageCount
    });
  }

  return fetchPublicShopifyProducts(shopifyDomain, { onPage });
}
