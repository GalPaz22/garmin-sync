/**
 * The WooCommerce REST client, resolved for ESM.
 *
 * `@woocommerce/woocommerce-rest-api` ships a Babel-built CommonJS entry whose
 * module.exports is `{ __esModule: true, default: WooCommerceRestApi,
 * OptionsException }`. Node's ESM↔CJS interop hands a default import the whole
 * module.exports object and does not honour the `__esModule` marker, so in a
 * `"type": "module"` package `import Woo from "…"` is that object, not the
 * class — and `new Woo(...)` throws "WooCommerceRestApi is not a constructor".
 *
 * Unwrapping happens here, once, and accepts either shape so a future ESM build
 * of the package keeps working unchanged.
 */

import wooModule from "@woocommerce/woocommerce-rest-api";

/** The constructor, whichever shape the package exported. */
export function resolveWooApiConstructor(candidate = wooModule) {
  const resolved = typeof candidate === "function" ? candidate : candidate?.default;

  if (typeof resolved !== "function") {
    throw new Error(
      "@woocommerce/woocommerce-rest-api did not export a constructor — the installed version exports " +
      `${typeof candidate}. Check the dependency version.`
    );
  }

  return resolved;
}

/** A configured WooCommerce REST client. */
export function createWooApi(options) {
  const WooCommerceRestApi = resolveWooApiConstructor();
  return new WooCommerceRestApi(options);
}
