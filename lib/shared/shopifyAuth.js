/**
 * Shopify authentication helpers — 2026 client credentials grant
 * @see https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 *
 * Tokens expire after 24 h (86399 s). Cached per-process with a 60 s
 * pre-expiry refresh buffer so long-running syncs never hit an expired token.
 */

const _tokenCache = new Map(); // shop → { token: string, expiresAt: number }

/**
 * Exchange client_id + client_secret for a short-lived Shopify access token.
 * The token is cached and auto-refreshed before expiry.
 */
export async function getClientCredentialsToken(shop, clientId, clientSecret) {
  const cached = _tokenCache.get(shop);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.token;
  }

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Shopify token exchange failed (${res.status}): ${body}`);
  }

  const { access_token, expires_in } = await res.json();
  _tokenCache.set(shop, {
    token: access_token,
    expiresAt: Date.now() + expires_in * 1000,
  });
  console.log(`🔑 Shopify token obtained for ${shop}, expires in ${expires_in}s`);
  return access_token;
}

/**
 * Resolve a Shopify access token from either auth method:
 *   - 2026 client credentials: shopifyClientId + shopifyClientSecret
 *   - Legacy static token:     shopifyToken  (shpat_... / shpua_...)
 */
export async function resolveShopifyToken(fullDomain, shopifyToken, shopifyClientId, shopifyClientSecret) {
  if (shopifyClientId && shopifyClientSecret) {
    return getClientCredentialsToken(fullDomain, shopifyClientId, shopifyClientSecret);
  }
  if (shopifyToken) {
    return shopifyToken;
  }
  throw new Error(
    "Either shopifyToken OR (shopifyClientId + shopifyClientSecret) must be provided"
  );
}
