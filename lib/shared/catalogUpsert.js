/**
 * Shared MongoDB upsert helpers for catalog imports/sync refreshes.
 * Updates all catalog fields on every run; preserves AI enrichment fields on existing docs.
 */

const ENRICHMENT_DEFAULTS = {
  embedding: null,
  category: [],
  type: [],
  softCategory: [],
  colors: [],
  description1: null,
  processedAt: null
};

export function productIdFilter(id) {
  if (id === null || id === undefined) return { id };
  const asString = String(id);
  const asNumber = Number(id);
  if (Number.isFinite(asNumber) && asString === String(asNumber)) {
    return { $or: [{ id }, { id: asNumber }, { id: asString }] };
  }
  return { id };
}

export function buildCatalogUpsertOp(product, platform, catalogSet = null) {
  const setPayload = {
    ...(catalogSet || product),
    sourcePlatform: platform,
    fetchedAt: new Date()
  };

  return {
    updateOne: {
      filter: productIdFilter(product.id),
      update: {
        $set: setPayload,
        $setOnInsert: { ...ENRICHMENT_DEFAULTS }
      },
      upsert: true
    }
  };
}

export async function bulkUpsertCatalogProducts(collection, products, platform, {
  mapCatalogSet,
  chunkSize = 250,
  onChunk
} = {}) {
  let processed = 0;
  let inserted = 0;
  let modified = 0;
  let matched = 0;

  for (let i = 0; i < products.length; i += chunkSize) {
    const chunk = products.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;

    const result = await collection.bulkWrite(
      chunk.map(product => {
        const catalogSet = mapCatalogSet ? mapCatalogSet(product) : null;
        return buildCatalogUpsertOp(product, platform, catalogSet);
      }),
      { ordered: false }
    );

    processed += chunk.length;
    inserted += result.upsertedCount || 0;
    modified += result.modifiedCount || 0;
    matched += result.matchedCount || 0;

    if (onChunk) {
      await onChunk({ processed, total: products.length, inserted, modified, matched });
    }
  }

  return { processed, inserted, modified, matched, upserted: inserted + modified };
}
