import { MongoClient } from "mongodb";
import { createWooApi } from './shared/wooApi.js';
import pLimit from "p-limit";
import { embed, callGemini } from './shared/ai.js';
import { parsePrice, parseHtmlToPlainText, parseGeminiResult } from './shared/utils.js';
import {
  applyWooDefaultBoosts,
  fetchPublicWooProducts,
  HIDDEN_BREADCRUMB_TERMS,
  isWooDraft,
  matchHiddenBreadcrumbTerm,
  resolveWooProductStatus,
  resolveWooStockStatus,
  withWooPopularityData
} from './shared/wooPublicProducts.js';
import { bulkUpsertCatalogProducts } from './shared/catalogUpsert.js';

const MONGO_URI = process.env.MONGODB_URI;
const PROCESS_CONCURRENCY = parseInt(process.env.PROCESS_CONCURRENCY || "6", 10);
const VARIATION_CONCURRENCY = parseInt(process.env.VARIATION_CONCURRENCY || "10", 10);
const FILTER_CLASSIFICATION_MODEL = "gemini-2.5-flash";
// Flash accepts a 0 thinking budget (cheap + fast). Accuracy is driven by the
// structured critical-fields context and stricter prompt rules, not "thinking".
const FILTER_CLASSIFICATION_THINKING_BUDGET = 0;
// How many real catalog products to scan and turn into a dynamic field reference.
const FIELD_REFERENCE_SAMPLE_SIZE = 2;

/**
 * Build the structured "critical fields" block used both for classification
 * input and for the dynamic reference. Surfaces the strongest signals first.
 */
function buildWooClassificationFields(product, variantData) {
  const cleanedDescription = parseHtmlToPlainText(product.description || '').trim();
  const metadataText = extractMetadataText(product.meta_data);
  const categoryNames = product.categories?.map(c => c?.name).filter(Boolean).join(', ') || '';
  const tagNames = Array.isArray(product.tags)
    ? product.tags.map(t => (typeof t === 'string' ? t : t?.name)).filter(Boolean).join(', ')
    : '';
  const variantColors = Array.isArray(variantData?.colors) ? variantData.colors.filter(Boolean).join(', ') : '';
  const variantSizes = Array.isArray(variantData?.sizes) ? variantData.sizes.filter(Boolean).join(', ') : '';
  return [
    categoryNames ? `Store Categories: ${categoryNames}` : '',
    product.type ? `Product Type: ${product.type}` : '',
    product.sku ? `SKU: ${product.sku}` : '',
    tagNames ? `Tags: ${tagNames}` : '',
    variantColors ? `Available Colors: ${variantColors}` : '',
    variantSizes ? `Available Sizes: ${variantSizes}` : '',
    metadataText ? `Attributes: ${metadataText}` : '',
    cleanedDescription ? `Description: ${cleanedDescription}` : ''
  ].filter(Boolean).join('\n');
}

/**
 * Build a DYNAMIC reference from the first real products in this catalog, so the
 * model learns which fields THIS store populates and prioritizes — no hardcoded
 * fictional example, no invented values.
 */
function buildWooFieldReference(products, sampleSize = FIELD_REFERENCE_SAMPLE_SIZE) {
  const blocks = [];
  for (const product of products || []) {
    if (blocks.length >= sampleSize) break;
    if (!product.description || product.description.trim() === '') continue;
    const variantData = processWooCommerceVariants(product);
    const fields = buildWooClassificationFields(product, variantData);
    if (!fields) continue;
    const nameLine = product.name ? `Product Name: ${product.name}\n` : '';
    blocks.push(`--- Reference product ${blocks.length + 1} (real, from THIS catalog) ---\n${nameLine}${fields}`);
  }

  if (blocks.length === 0) return '';

  return `Below ${blocks.length === 1 ? 'is' : 'are'} ${blocks.length} real product${blocks.length === 1 ? '' : 's'} from THIS catalog, shown so you can see which fields this store populates and which carry the strongest signal. Use them ONLY to learn WHICH fields to focus on — do NOT copy their content onto other products.

${blocks.join('\n\n')}

For every product, prioritize the store's own fields (Store Categories and Product Type first, then Product Name and Tags), and assign a filter value only when a field DIRECTLY supports it — otherwise return [].`;
}

/**
 * Single Gemini call: translate the description to English AND classify
 * the product — replaces the previous 3-call chain (summarizeMetadata +
 * translateDescription + classifyCategoryAndTypeWithGemini).
 */
async function translateAndClassify(description, productName, userCategories, userTypes, softCategories, colors, variants = [], fieldGuide = '') {
  const categoriesArray = Array.isArray(userCategories) ? userCategories : [];
  const typesArray = Array.isArray(userTypes) ? userTypes : [];
  const softCategoriesArray = Array.isArray(softCategories) ? softCategories : [];
  const colorsArray = Array.isArray(colors) ? colors : [];

  const colorsField = colorsArray.length > 0
    ? `\n- "colors": pick ALL matching values from [${colorsArray.join(', ')}]`
    : '';
  const colorsExample = colorsArray.length > 0 ? ', "colors": []' : '';

  let variantInfo = '';
  if (variants.length > 0) {
    const lines = variants.slice(0, 20).map(v => {
      const parts = [];
      if (v.size) parts.push(`Size: ${v.size}`);
      if (v.color) parts.push(`Color: ${v.color}`);
      if (v.attributes?.length) parts.push(v.attributes.map(a => `${a.name}: ${a.option}`).join(', '));
      return parts.join(', ');
    }).filter(Boolean);
    if (lines.length) variantInfo = `\nVariants: ${lines.join(' | ')}`;
  }

  const prompt = `You are an expert e-commerce product analyst. Given the PRODUCT DATA below, return a single JSON object that:

1. "description" — a comprehensive English product description (100-200 words).
   Translate from any language if needed. Natural flowing prose, preserve all info,
   no price/brand/category metadata, factual and keyword-rich.

2. Classification fields — use ONLY values from the provided lists, return [] if no match:
   - "category": from [${categoriesArray.join(', ')}]
   - "type": from [${typesArray.join(', ')}]
   - "softCategory": from [${softCategoriesArray.join(', ')}]${colorsField}

Evidence hierarchy for classification (strongest first):
- "Store Categories" and "Product Type" are the store's own taxonomy — the strongest signal.
- "Product Name" / "Brand" — reliable for model line / product family.
- "Tags", "Variants", "Description" — supporting evidence.

Strict classification rules:
- Assign a filter value ONLY when the product data gives DIRECT evidence that it applies. If a value is not clearly supported by the fields above, return [] for that field. Never guess to "fill" a field.
- Do NOT infer a value from indirect, correlated, or stereotypical signals — an unrelated feature, a brand, a price, a color, or a single sub-feature does not by itself prove a value. When the evidence is only implied or ambiguous, leave it out.
${fieldGuide ? `\n${fieldGuide}\n\nNow handle the ACTUAL product below, using its own allowed lists (above) and returning [] for any field the data does not directly support.\n` : ''}
Product Name: ${productName}

=== PRODUCT DATA ===
${description}${variantInfo}
=== END PRODUCT DATA ===

Return ONLY valid JSON: {"description": "...", "category": [], "type": [], "softCategory": []${colorsExample}}`;

  try {
    const resultText = await callGemini({
      model: FILTER_CLASSIFICATION_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      responseMimeType: "application/json",
      thinkingBudget: FILTER_CLASSIFICATION_THINKING_BUDGET
    });
    if (!resultText) throw new Error("empty Gemini response (no candidates/text — likely a blocked or truncated generation)");

    // Parse the JSON directly. We must NOT use parseGeminiResult here: that
    // helper only returns category/type/softCategory and silently drops the
    // "description" and "colors" fields, which would make every product fail
    // the `!aiResult.description` check downstream.
    let out;
    try {
      out = JSON.parse(resultText);
    } catch {
      const jsonMatch = resultText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error(`Gemini returned non-JSON output: ${resultText.slice(0, 200)}`);
      out = JSON.parse(jsonMatch[0]);
    }

    const description = typeof out.description === 'string' ? out.description.trim() : null;
    return {
      description: description || null,
      category: Array.isArray(out.category) ? out.category.filter(c => categoriesArray.includes(c)) : [],
      type: Array.isArray(out.type) ? out.type.filter(t => typesArray.includes(t)) : [],
      softCategory: Array.isArray(out.softCategory) ? out.softCategory.filter(s => softCategoriesArray.includes(s)) : [],
      colors: Array.isArray(out.colors) ? out.colors.filter(c => colorsArray.includes(c)) : [],
      error: description ? null : "model response had no usable 'description' field"
    };
  } catch (error) {
    console.error(`❌ Gemini translateAndClassify failed for "${productName}":`, error.message);
    return { description: null, category: [], type: [], softCategory: [], colors: [], error: error.message };
  }
}

/** Fallback Gemini classification with simplified prompt (kept for export compatibility) */
async function classifyCategoryAndTypeWithGemini(enrichedText, productName, userCategories, userTypes, softCategories, colors, variants = []) {
  return translateAndClassify(enrichedText, productName, userCategories, userTypes, softCategories, colors, variants);
}

/** Fallback Gemini classification with simplified prompt */
async function classifyCategoryUsingGeminiSimple(translatedDescription, productName, userCategories) {
  try {
    const result = await callGemini({
      model: FILTER_CLASSIFICATION_MODEL,
      contents: [{ role: 'user', parts: [{ text: `From the following list: [${userCategories.join(', ')}], pick the most suitable category for "${productName}".\nDescription: ${translatedDescription}\nReturn ONLY: {"category": ["The Category"]}` }] }],
      responseMimeType: "application/json",
      thinkingBudget: FILTER_CLASSIFICATION_THINKING_BUDGET
    });
    const parsed = parseGeminiResult(result || "");
    return { category: parsed.category || [], type: [] };
  } catch (error) {
    console.error(`❌ Fallback classification failed for "${productName}":`, error.message);
    return { category: [], type: [] };
  }
}

/** Extract useful text from WooCommerce meta_data without an AI call */
function extractMetadataText(metadata) {
  if (!Array.isArray(metadata)) return '';
  return metadata
    .filter(m => m.key && !m.key.startsWith('_') && m.value && typeof m.value === 'string' && m.value.length < 200)
    .slice(0, 10)
    .map(m => `${m.key}: ${m.value}`)
    .join('\n');
}

const parsePriceWoo = (val) => parsePrice(val, false);

/** Process and normalize variants for WooCommerce products */
function processWooCommerceVariants(product) {
  if (product.variations && Array.isArray(product.variations)) {
    const variants = product.variations.map(variation => ({
      id: variation.id,
      title: variation.description || `${product.name} - Variation`,
      sku: variation.sku || null,
      price: parsePriceWoo(variation.price),
      regular_price: parsePriceWoo(variation.regular_price),
      sale_price: parsePriceWoo(variation.sale_price),
      image: variation.image?.src || null,
      attributes: variation.attributes || [],
      stock_status: variation.stock_status || 'instock',
      stock_quantity: variation.stock_quantity || 0,
      manage_stock: variation.manage_stock || false
    }));

    const allAttributes = variants.flatMap(v => v.attributes || []);
    const sizes = [...new Set(allAttributes.filter(attr =>
      attr.name?.toLowerCase().includes('size')).map(attr => attr.option))].filter(Boolean);
    const colors = [...new Set(allAttributes.filter(attr =>
      attr.name?.toLowerCase().includes('color') || attr.name?.toLowerCase().includes('colour')).map(attr => attr.option))].filter(Boolean);

    return { variants, sizes, colors };
  }
  return { variants: [], sizes: [], colors: [] };
}

/** Helper function to create basic product data */
function createBasicProductData(product) {
  const variantData = processWooCommerceVariants(product);
  const resolvedStockStatus = resolveWooStockStatus(product);
  const publicationStatus = resolveWooProductStatus(product);
  const isDraft = publicationStatus === 'draft';
  const breadcrumbTerm = matchHiddenBreadcrumbTerm(product);
  // Woo's `type` ("simple"/"variable") and variant `colors` collide with
  // enrichment fields `type` (classification[]) and `colors` (filter[]).
  const { type: wooProductType, ...productFields } = product;

  return withWooPopularityData({
    ...productFields,
    productType: wooProductType || null,
    id: product.id,
    name: product.name,
    sku: product.sku || null,
    description: product.description,
    short_description: product.short_description,
    price: parsePriceWoo(product.price),
    regular_price: parsePriceWoo(product.regular_price),
    sale_price: parsePriceWoo(product.sale_price),
    stock_status: resolvedStockStatus,
    categories: product.categories,
    images: product.images,
    metadata: product.meta_data,
    url: product.permalink || product.link || null,
    image: product.images?.length > 0 ? product.images[0].src : null,
    stockStatus: resolvedStockStatus,
    status: publicationStatus,
    // Hidden products are imported like anything else, but flagged so the
    // consumer can keep them out of results: drafts, and anything whose
    // category breadcrumb carries one of HIDDEN_BREADCRUMB_TERMS. Written on
    // every product, not only on the hidden ones: a flag that is only ever set
    // would stick after a product is published or recategorised and hide it
    // for good.
    hidden: isDraft || breadcrumbTerm !== null,
    // Which rule hid it, so the flag can be explained without re-deriving it.
    hiddenReason: isDraft ? 'draft' : (breadcrumbTerm ? `breadcrumb:${breadcrumbTerm}` : null),
    fetchedAt: new Date(),
    onSale: product.on_sale || false,
    variants: variantData.variants,
    sizes: variantData.sizes,
    variantColors: variantData.colors,
  });
}

/** Local category detection */
function updateLocalCategoryTypes(categories, description, userTypes) {
  const validUserTypes = Array.isArray(userTypes) ? userTypes : [];
  if (!Array.isArray(categories)) return [];
  const typeMarkers = [];

  for (const cat of categories) {
    if (!cat?.name) continue;
    const name = cat.name;
    const isNotKosher = /לא\s*כשר|Not\s*Kosher/.test(name);
    if (!isNotKosher && /\bכשר\b|\bKosher\b/.test(name) && validUserTypes.includes("כשר")) typeMarkers.push("כשר");
    if (/2 יינות ב|3 יינות ב|2 Wines B|3 Wines B/.test(name) && validUserTypes.includes("מבצע")) typeMarkers.push("מבצע");
  }

  if (description && /\bכשר\b/.test(description) && !/לא\s*כשר/.test(description) && validUserTypes.includes("כשר")) {
    typeMarkers.push("כשר");
  }
  return [...new Set(typeMarkers)];
}

/**
 * Fetch and process WooCommerce products with enrichment.
 *
 * @param {string} [options.statusCollectionName] - Collection the run reports
 *   progress to. Defaults to the shared "sync_status" used by the general sync;
 *   a scoped run passes its own so it never overwrites that status.
 */
async function processWooProducts({ wooUrl, wooKey, wooSecret, userEmail, categories, userTypes, softCategories, colors, dbName, statusCollectionName = 'sync_status' }) {
  const logs = [];
  let statusCol;

  const addLog = async (message) => {
    logs.push(message);
    console.log(message);
    if (statusCol) {
      try {
        await statusCol.updateOne({ dbName }, { $push: { logs: message } }, { upsert: true });
      } catch (err) {
        console.error("Failed to write log to DB:", err);
      }
    }
  };

  await addLog(`🚀 Starting WooCommerce processing for: ${userEmail || 'System Admin'} (DB: ${dbName})`);
  await addLog(`🔗 WooCommerce URL: ${wooUrl}`);

  const validUserTypes = Array.isArray(userTypes) ? userTypes : [];
  await addLog(`🏷️ User types: ${validUserTypes.length > 0 ? validUserTypes.join(', ') : 'none'}`);

  const client = new MongoClient(MONGO_URI, { connectTimeoutMS: 30000, serverSelectionTimeoutMS: 30000 });

  try {
    await client.connect();
    await addLog("✅ Connected to MongoDB");

    const db = client.db(dbName);
    const collection = db.collection("products");
    statusCol = db.collection(statusCollectionName);

    await statusCol.updateOne(
      { dbName },
      { $set: { dbName, state: "processing", progress: 0, startedAt: new Date(), logs: [] } },
      { upsert: true }
    );

    await addLog("🛍️ Fetching all products from WooCommerce...");
    let allProducts = [];

    if (wooKey && wooSecret) {
      const api = createWooApi({ url: wooUrl, consumerKey: wooKey, consumerSecret: wooSecret, version: "wc/v3" });
      let page = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        try {
          // Retry each page so a transient error (timeout / rate limit / 5xx)
          // doesn't silently truncate the rest of the catalog.
          let response;
          let lastErr;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              response = await api.get("products", { per_page: 100, page, _embed: true });
              break;
            } catch (err) {
              lastErr = err;
              await addLog(`⚠️ Page ${page} fetch attempt ${attempt}/3 failed: ${err.message}`);
              if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000));
            }
          }
          if (!response) throw lastErr;

          const products = response.data || [];

          if (products.length === 0) {
            hasMorePages = false;
            break;
          }

          // Fetch variations for all variable products in parallel
          const variationLimit = pLimit(VARIATION_CONCURRENCY);
          await Promise.all(products.map(product => variationLimit(async () => {
            if (product.type === 'variable' && product.variations?.length > 0) {
              try {
                const variationsResponse = await api.get(`products/${product.id}/variations`, { per_page: 100 });
                product.variations = variationsResponse.data || [];
              } catch (err) {
                await addLog(`⚠️ Could not fetch variations for ${product.name}: ${err.message}`);
                product.variations = [];
              }
            } else {
              product.variations = [];
            }
          })));

          allProducts = allProducts.concat(products);

          // Don't trust the header alone — caching/security plugins and CDNs
          // often strip x-wp-totalpages. Keep paging while we receive full
          // pages; use totalPages only as an additional cap when present.
          const totalPages = parseInt(response.headers['x-wp-totalpages'] || '0', 10);
          await addLog(`📄 Page ${page}/${totalPages || '?'}: ${products.length} products (total: ${allProducts.length})`);
          hasMorePages = products.length === 100 && (!totalPages || page < totalPages);
          page++;
        } catch (error) {
          await addLog(`❌ Error fetching page ${page}: ${error.message}`);
          hasMorePages = false;
        }
      }
    } else {
      await addLog("🔗 WooCommerce fetch mode: public /wp-json/wp/v2/product fallback");
      allProducts = await fetchPublicWooProducts(wooUrl, {
        onPage: async ({ page, count, total }) => {
          await addLog(`📄 Public Woo page ${page}: ${count} products (total: ${total})`);
        }
      });
    }

    // Ingest all fetched products (no in-stock / publish filtering).
    const inStockProducts = allProducts;
    await addLog(`📦 ${allProducts.length} total products (no stock/status filtering)`);

    const draftCount = allProducts.filter(isWooDraft).length;
    const breadcrumbHidden = allProducts.filter(prod => !isWooDraft(prod) && matchHiddenBreadcrumbTerm(prod)).length;
    await addLog(`🙈 ${draftCount} draft product(s) marked hidden: true`);
    await addLog(`🙈 ${breadcrumbHidden} product(s) hidden by breadcrumb (${HIDDEN_BREADCRUMB_TERMS.join(', ')})`);

    // Skip products that already have embeddings
    const productIds = inStockProducts.map(prod => prod.id);
    const existingProducts = await collection.find(
      { id: { $in: productIds }, embedding: { $exists: true, $ne: null } },
      { projection: { id: 1 } }
    ).toArray();
    const existingProductIds = new Set(existingProducts.map(prod => prod.id));
    const productsToProcess = inStockProducts.filter(prod => !existingProductIds.has(prod.id));

    await addLog(`✅ ${existingProductIds.size} already have embeddings (skipping)`);
    await addLog(`🔄 ${productsToProcess.length} products need enrichment`);

    // Upsert full catalog fields for all in-stock products (updates existing rows)
    await addLog(`💾 Upserting catalog data for ${inStockProducts.length} in-stock products...`);
    const catalogStats = await bulkUpsertCatalogProducts(collection, inStockProducts, 'woocommerce', {
      mapCatalogSet: (product) => createBasicProductData(product)
    });
    await addLog(`💾 Catalog upsert done: ${catalogStats.processed} processed — ${catalogStats.modified} updated, ${catalogStats.inserted} inserted`);
    const popularityStats = await applyWooDefaultBoosts(collection, inStockProducts);
    await addLog(`⭐ Woo popularity: ${popularityStats.detected} detected, ${popularityStats.boosted} received default boost level 1`);

    if (productsToProcess.length === 0) {
      await addLog(`✨ All products already have embeddings — no AI enrichment needed!`);
      await statusCol.updateOne({ dbName }, { $set: { state: "done", finishedAt: new Date(), progress: 100 } });
      await addLog(`✅ WooCommerce sync complete. Catalog refreshed for ${catalogStats.processed} products (${catalogStats.modified} updated, ${catalogStats.inserted} new).`);
      await client.close();
      return logs;
    }

    // Build a dynamic classification reference from the first real products of
    // this catalog, then reuse it for every product in the run.
    const fieldGuide = buildWooFieldReference(productsToProcess);
    if (fieldGuide) {
      await addLog(`🧭 Built dynamic field reference from up to ${FIELD_REFERENCE_SAMPLE_SIZE} sample product(s) in this catalog`);
    }

    // Enrich products in parallel
    await addLog(`🔄 Enriching ${productsToProcess.length} products with AI (concurrency: ${PROCESS_CONCURRENCY})...`);
    const processLimit = pLimit(PROCESS_CONCURRENCY);
    let enriched = 0;

    await Promise.all(productsToProcess.map(product => processLimit(async () => {
      try {
        const { name, description } = product;

        if (!description || description.trim() === "") {
          await addLog(`⚠️ Skipping ${name} — no description`);
          return;
        }

        // Single AI call: translate + classify.
        // Build a structured "critical fields" block so the model anchors on the
        // strongest signals (store categories, product type, brand) rather than
        // guessing from loose prose.
        const variantData = processWooCommerceVariants(product);
        const validColors = Array.isArray(colors) ? colors : [];
        const inputText = buildWooClassificationFields(product, variantData);
        const aiResult = await translateAndClassify(inputText, name, categories, validUserTypes, softCategories, validColors, variantData.variants, fieldGuide);

        if (!aiResult.description) {
          await addLog(`⚠️ Skipping ${name} — AI processing failed: ${aiResult.error || 'unknown reason'}`);
          return;
        }

        const finalType = Array.isArray(aiResult.type) ? aiResult.type : [];
        const finalSoftCategory = Array.isArray(aiResult.softCategory) ? aiResult.softCategory : [];
        const finalColors = Array.isArray(aiResult.colors) ? aiResult.colors : [];

        await addLog(`✅ ${name}: Cat: ${aiResult.category?.join(', ') || 'None'} | Types: ${finalType.join(', ') || 'None'} | Soft: ${finalSoftCategory.join(', ') || 'None'} | Colors: ${finalColors.join(', ') || 'None'}`);

        const embedding = await embed(aiResult.description);
        if (!embedding) await addLog(`⚠️ Embedding generation failed for ${name}`);

        const updateDoc = {
          ...createBasicProductData(product),
          description1: aiResult.description,
          embedding,
          category: aiResult.category || [],
          type: finalType,
          softCategory: finalSoftCategory,
          colors: finalColors,
          processedAt: new Date()
        };

        await collection.updateOne({ id: product.id }, { $set: updateDoc }, { upsert: true });
        enriched += 1;

      } catch (error) {
        await addLog(`❌ Error processing ${product.name}: ${error.message}`);
        console.error("Full error:", error);
      }
    })));

    await statusCol.updateOne({ dbName }, { $set: { state: "done", finishedAt: new Date(), progress: 100 } });

    await addLog(`✅ WooCommerce processing complete for: ${userEmail || 'System Admin'} (DB: ${dbName})`);
    await addLog(`📊 In-stock products saved: ${inStockProducts.length} | AI enriched: ${enriched}`);

    await client.close();
    return logs;

  } catch (err) {
    // Everything from the Mongo connect onwards lands here, so the message has
    // to name what actually failed. Reporting every failure as a MongoDB
    // connection error sent people looking at the database for a storefront
    // problem.
    await addLog(`❌ WooCommerce processing failed: ${err.message}`);

    try {
      await client.close();
    } catch {
      // Already closed or never opened — nothing to report.
    }

    // Rethrow: swallowing this returned the logs as though the run succeeded,
    // and the caller then marked a run that fetched nothing as "done".
    throw err;
  }
}

export {
  processWooProducts,
  classifyCategoryAndTypeWithGemini,
  extractMetadataText as summarizeMetadata
};

/** Internals exposed for tests only — not part of the pipeline's interface. */
export const __test__ = { createBasicProductData };
