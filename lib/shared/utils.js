/**
 * Shared utility functions used across all processing modules.
 * Eliminates duplication of identical functions in 6+ files.
 */
import { parse } from "node-html-parser";

/**
 * Parse price value from various formats to a clean number.
 * Handles strings with currency symbols, nulls, and edge cases.
 * @param {*} priceValue - The price value to parse
 * @param {boolean} convertCents - If true, divides by 100 (Shopify format). Default true.
 * @returns {number}
 */
export function parsePrice(priceValue, convertCents = true) {
  if (priceValue === null || priceValue === undefined || priceValue === '') return 0;
  if (typeof priceValue === 'number') {
    if (isNaN(priceValue)) return 0;
    return convertCents ? priceValue / 100 : priceValue;
  }
  let cleanPrice = String(priceValue)
    .replace(/[$₪€£¥,\s]/g, '')
    .replace(/[^\d.-]/g, '');
  if (cleanPrice === '' || cleanPrice === '-' || cleanPrice === '.') return 0;
  const numericPrice = parseFloat(cleanPrice);
  if (isNaN(numericPrice) || numericPrice < 0) return 0;
  return convertCents ? numericPrice / 100 : numericPrice;
}

/**
 * Parse HTML string to plain text using node-html-parser.
 * @param {string} html 
 * @returns {string}
 */
export function parseHtmlToPlainText(html) {
  if (!html) return "";
  try {
    const root = parse(html);
    const text = root.text || root.textContent || "";
    return text.replace(/\s+/g, " ").trim();
  } catch (error) {
    console.warn("Error parsing HTML:", error.message);
    return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  }
}

/**
 * Validate that a string is a valid image URL with a recognized extension.
 * @param {string} url 
 * @returns {boolean}
 */
export function isValidImageUrl(url) {
  if (typeof url !== "string") return false;
  try { new URL(url); } catch { return false; }
  return /\.(jpe?g|png|gif|webp)/i.test(url);
}

/**
 * Parse a Gemini JSON classification result string into a structured object.
 * @param {string} result - Raw text from Gemini
 * @returns {{ category: string[], type: string[], softCategory: string[] }}
 */
export function parseGeminiResult(result) {
  if (!result) return { category: [], type: [], softCategory: [] };
  let jsonString = result.trim();
  const codeBlockMatch = jsonString.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) jsonString = codeBlockMatch[1].trim();
  const jsonMatch = jsonString.match(/\{[\s\S]*\}/);
  if (jsonMatch) jsonString = jsonMatch[0];
  try {
    const parsed = JSON.parse(jsonString);
    return {
      category: Array.isArray(parsed.category) ? parsed.category : (parsed.category ? [parsed.category] : []),
      type: Array.isArray(parsed.type) ? parsed.type : (parsed.type ? [parsed.type] : []),
      softCategory: Array.isArray(parsed.softCategory) ? parsed.softCategory : (parsed.softCategory ? [parsed.softCategory] : [])
    };
  } catch (e) {
    console.warn("Failed to parse Gemini result:", e.message);
    return { category: [], type: [], softCategory: [] };
  }
}

/**
 * Retry a function with exponential backoff for transient network errors.
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of attempts
 * @param {number} initialDelay - Initial delay in ms
 */
export async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      const isRetryableError = 
        error.code === 'ECONNRESET' || 
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        error.message?.includes('fetch failed') ||
        error.message?.includes('socket hang up');

      if (isLastAttempt || !isRetryableError) throw error;

      const delay = initialDelay * Math.pow(2, attempt - 1);
      console.warn(`⚠️ Request failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Convert Shopify GID to numeric ID.
 * e.g. "gid://shopify/ProductVariant/123456789" -> "123456789"
 * @param {string} gid 
 * @returns {string|null}
 */
export function gidToNumeric(gid) {
  if (!gid) return null;
  const parts = String(gid).split('/');
  return parts[parts.length - 1] || null;
}

