import { MongoClient } from "mongodb";
import pLimit from "p-limit";
import { appendLogs } from './syncStatus-esm.js';
import { embed, callGemini } from './shared/ai.js';
import { parsePrice, gidToNumeric } from './shared/utils.js';
import { fetchShopifyProducts, normalizeShopifyStorefrontDomain } from './shared/shopifyPublicProducts.js';

const { MONGODB_URI, IMG_CONCURRENCY = "8" } = process.env;

/**
 * Single Gemini call that translates the description to English AND classifies
 * the product — saving one full AI round-trip per product compared to the old
 * two-call approach.
 */
async function translateAndClassify(description, productName, categories, types, softCategories, colors) {
  const categoriesArray = Array.isArray(categories) ? categories : [];
  const typesArray = Array.isArray(types) ? types : [];
  const softCategoriesArray = Array.isArray(softCategories) ? softCategories : [];
  const colorsArray = Array.isArray(colors) ? colors : [];

  const colorsField = colorsArray.length > 0
    ? `\n- "colors": pick ALL matching values from [${colorsArray.join(', ')}]`
    : '';
  const colorsExample = colorsArray.length > 0 ? ', "colors": []' : '';

  const prompt = `You are an expert e-commerce product analyst. Given the product below, return a single JSON object that:

1. "description" — a comprehensive English product description (100-200 words).
   Translate from any language if needed. Natural flowing prose, preserve all info,
   no price/brand/category metadata, factual and keyword-rich.

2. Classification fields — use ONLY values from the provided lists, return [] if no match:
   - "category": from [${categoriesArray.join(', ')}]
   - "type": from [${typesArray.join(', ')}]
   - "softCategory": from [${softCategoriesArray.join(', ')}]${colorsField}

Product Name: ${productName}
Description: ${description}

Return ONLY valid JSON: {"description": "...", "category": [], "type": [], "softCategory": []${colorsExample}}`;

  try {
    const result = await callGemini({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      responseMimeType: "application/json",
      thinkingBudget: 0
    });
    if (!result) throw new Error("No response from Gemini");

    let jsonString = result.trim();
    const codeBlockMatch = jsonString.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) jsonString = codeBlockMatch[1].trim();
    const jsonMatch = jsonString.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonString = jsonMatch[0];

    const out = JSON.parse(jsonString);
    out.description = typeof out.description === 'string' ? out.description.trim() : null;
    out.category = Array.isArray(out.category) ? out.category.filter(c => categoriesArray.includes(c)) : [];
    out.type = Array.isArray(out.type) ? out.type.filter(t => typesArray.includes(t)) : [];
    out.softCategory = Array.isArray(out.softCategory) ? out.softCategory.filter(s => softCategoriesArray.includes(s)) : [];
    out.colors = Array.isArray(out.colors) ? out.colors.filter(c => colorsArray.includes(c)) : [];
    return out;
  } catch (e) {
    console.warn("Gemini translateAndClassify failed:", e.message);
    return { description: null, category: [], type: [], softCategory: [], colors: [] };
  }
}

function toPlainMoney(x) { try { return x != null ? parseFloat(x) : null; } catch { return null; } }

/**
 * @param {string} [options.statusCollectionName] - Collection the run reports
 *   progress to. Defaults to the shared "sync_status" used by the general sync;
 *   a scoped run passes its own so it never overwrites that status.
 */
export default async function processShopifyDescriptions({ shopifyDomain, shopifyToken, shopifyClientId, shopifyClientSecret, dbName, categories, type: userTypes, softCategories, colors, statusCollectionName = 'sync_status' }) {
  const logs = [];
  const log = async (message) => {
    console.log(message);
    logs.push(message);
    await appendLogs(dbName, [message], statusCollectionName);
  };

  await log(`🚀 Starting Shopify processing for database: ${dbName}`);

  const validUserTypes = Array.isArray(userTypes) ? userTypes : [];
  await log(`🏷️ User types: ${validUserTypes.length > 0 ? validUserTypes.join(', ') : 'none'}`);

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(dbName);
  const productsCol = db.collection("products");
  const statusCol = db.collection(statusCollectionName);

  await statusCol.updateOne(
    { dbName },
    { $set: { state: "running", startedAt: new Date(), done: 0, total: 0 } },
    { upsert: true }
  );

  const fullDomain = normalizeShopifyStorefrontDomain(shopifyDomain);
  const hasAdminCredentials = Boolean(shopifyToken || (shopifyClientId && shopifyClientSecret));
  await log(`🔗 Shopify fetch mode: ${hasAdminCredentials ? 'Admin API' : 'public products.json fallback'}`);
  const allProducts = await fetchShopifyProducts({
    shopifyDomain,
    shopifyToken,
    shopifyClientId,
    shopifyClientSecret,
    imageCount: 5,
    onPage: ({ page, count, total }) => {
      console.log(`📦 Shopify page ${page}: ${count} products (total so far: ${total})`);
    }
  });

  const products = allProducts.filter(prod => {
    if (prod.status !== 'ACTIVE') return false;
    const hasAvailableVariant = (prod.variants?.edges || []).some(({ node }) => {
      if (node.availableForSale) return true;
      if (typeof node.inventoryQuantity === 'number' && node.inventoryQuantity > 0) return true;
      return false;
    });
    if (hasAvailableVariant || (typeof prod.totalInventory === 'number' && prod.totalInventory > 0)) return true;
    if (prod.tracksInventory === false) return true;
    return false;
  });

  await log(`🏪 Found ${allProducts.length} total products. ${products.length} active/in-stock.`);

  // Skip products that already have embeddings — avoids re-processing on re-runs
  const productIds = products.map(p => p.id);
  const existingProducts = await productsCol.find(
    { id: { $in: productIds }, embedding: { $exists: true, $ne: null } },
    { projection: { id: 1 } }
  ).toArray();
  const existingIds = new Set(existingProducts.map(p => p.id));
  const productsToProcess = products.filter(p => !existingIds.has(p.id));

  await log(`✅ ${existingIds.size} already enriched (skipping). 🔄 ${productsToProcess.length} need processing.`);

  if (productsToProcess.length === 0) {
    await log(`✨ All products already enriched — nothing to do!`);
    await statusCol.updateOne({ dbName }, { $set: { state: "done", finishedAt: new Date(), done: products.length, total: products.length } });
    await client.close();
    return;
  }

  await statusCol.updateOne({ dbName }, { $set: { total: productsToProcess.length } });

  const limit = pLimit(Number(IMG_CONCURRENCY));
  let done = 0;

  await Promise.all(productsToProcess.map(prod => limit(async () => {
    const cleanedDescription = (prod.description || "").trim();
    const validColors = Array.isArray(colors) ? colors : [];

    // Single AI call: translate + classify together
    const aiResult = await translateAndClassify(cleanedDescription, prod.title, categories, validUserTypes, softCategories, validColors);

    if (!aiResult.description) {
      await log(`⚠️ Skipping ${prod.title} — AI processing failed`);
      done += 1;
      await statusCol.updateOne({ dbName }, { $set: { done } });
      return;
    }

    // Append structured metadata to the translated description for embedding quality
    let metadataAppend = '';
    if (prod.productType) metadataAppend += `\nProduct Type: ${prod.productType}`;
    if (prod.vendor) metadataAppend += `\nBrand: ${prod.vendor}`;

    const variantEdgesForMetadata = prod.variants?.edges || [];
    if (variantEdgesForMetadata.length > 0) {
      const variantColors = new Set();
      const variantSizes = new Set();
      variantEdgesForMetadata.forEach(({ node }) => {
        (node.selectedOptions || []).forEach(opt => {
          const name = opt.name?.toLowerCase();
          if (name === 'color' || name === 'colour' || name === 'צבע') variantColors.add(opt.value);
          else if (name === 'size' || name === 'מידה') variantSizes.add(opt.value);
        });
      });
      if (variantColors.size > 0) metadataAppend += `\nAvailable Colors: ${Array.from(variantColors).join(', ')}`;
      if (variantSizes.size > 0) metadataAppend += `\nAvailable Sizes: ${Array.from(variantSizes).join(', ')}`;
    }

    if (prod.tags?.length > 0) metadataAppend += `\nTags: ${prod.tags.slice(0, 5).join(', ')}`;

    const enrichedDescription = `${aiResult.description}${metadataAppend}`.trim();
    const embedding = await embed(enrichedDescription);

    await log(`✅ ${prod.title}: Cat: ${aiResult.category.join(', ') || 'None'} | Types: ${aiResult.type.join(', ') || 'None'} | Soft: ${aiResult.softCategory.join(', ') || 'None'} | Colors: ${aiResult.colors.join(', ') || 'None'}`);

    const price = prod.priceRange?.minVariantPrice?.amount || 0;
    const baseUrl = prod.onlineStoreUrl || `https://${fullDomain}/products/${prod.handle}`;
    const mainImage = prod.images?.edges?.[0]?.node?.src || null;

    const variantEdges = prod.variants?.edges || [];
    const variants = variantEdges.map(({ node }) => {
      const numericId = gidToNumeric(node.id);
      const url = numericId ? `${baseUrl}?variant=${numericId}` : baseUrl;
      const optMap = Object.fromEntries((node.selectedOptions || []).map(o => [o.name?.toLowerCase(), o.value]));
      const size = optMap['size'] || optMap['eu size'] || optMap['us size'] || null;
      const color = optMap['color'] || optMap['colour'] || null;
      return {
        id: node.id,
        numericId,
        title: node.title,
        sku: node.sku || null,
        price: toPlainMoney(node.price),
        compareAtPrice: toPlainMoney(node.compareAtPrice),
        image: node.image?.src || null,
        url,
        size,
        color,
        options: node.selectedOptions || []
      };
    });

    const sizesSet = new Set(variants.map(v => v.size).filter(Boolean));
    const sizes = Array.from(sizesSet).sort((a, b) => {
      const na = parseFloat(a); const nb = parseFloat(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });

    let stockStatus = 'outofstock';
    const hasAvailableVariant = variantEdges.some(({ node }) => {
      if (node.availableForSale) return true;
      if (typeof node.inventoryQuantity === 'number' && node.inventoryQuantity > 0) return true;
      return false;
    });
    if (hasAvailableVariant || (typeof prod.totalInventory === 'number' && prod.totalInventory > 0)) stockStatus = 'instock';
    if (prod.tracksInventory === false) stockStatus = 'instock';

    const updateData = {
      ...prod,
      name: prod.title,
      description1: enrichedDescription,
      embedding,
      category: aiResult.category,
      type: aiResult.type,
      softCategory: aiResult.softCategory,
      colors: aiResult.colors,
      price: parsePrice(price, false),
      url: baseUrl,
      image: mainImage,
      images: (prod.images?.edges || []).map(e => e.node?.src).filter(Boolean),
      variants,
      sizes,
      stockStatus,
      fetchedAt: new Date(),
      processedAt: new Date(),
      active: true
    };

    await productsCol.updateOne(
      { id: prod.id },
      { $set: updateData },
      { upsert: true }
    );

    done += 1;
    await statusCol.updateOne({ dbName }, { $set: { done } });
  })));

  await log(`🏁 Shopify sync completed for database: ${dbName}`);
  await statusCol.updateOne(
    { dbName },
    { $set: { state: "done", finishedAt: new Date(), done: productsToProcess.length } }
  );

  await client.close();
}
