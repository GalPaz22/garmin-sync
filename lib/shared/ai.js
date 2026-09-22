/**
 * Shared AI utilities used across all processing modules.
 * Consolidates OpenAI embeddings and Gemini helper functions.
 */
import { OpenAIEmbeddings } from "@langchain/openai";
import { GoogleGenAI } from '@google/genai';

const { OPENAI_API_KEY, GOOGLE_AI_API_KEY } = process.env;

/** Shared OpenAI embeddings instance */
const embeddings = new OpenAIEmbeddings({
  model: "text-embedding-3-large",
  apiKey: OPENAI_API_KEY
});

/** Shared Google AI instance (null if no API key) */
export const ai = GOOGLE_AI_API_KEY && GOOGLE_AI_API_KEY !== "YOUR_GOOGLE_AI_KEY"
  ? new GoogleGenAI({ apiKey: GOOGLE_AI_API_KEY })
  : null;

/**
 * Generate OpenAI embedding for text.
 * @param {string} text 
 * @returns {Promise<number[] | null>}
 */
export async function embed(text) {
  try {
    return await embeddings.embedQuery(text);
  } catch (e) {
    console.warn("Embedding failed:", e.message || e);
    return null;
  }
}

/**
 * Call Gemini AI and extract the text result.
 * Handles both response structure variants from the Google AI SDK.
 * @param {object} options
 * @param {string} [options.model="gemini-2.5-flash"] - Model name
 * @param {Array} options.contents - Message contents array
 * @param {string} [options.responseMimeType] - Expected response format
 * @param {number} [options.thinkingBudget] - Thinking budget (0 = no thinking). Omit for model default.
 * @returns {Promise<string|null>}
 */
export async function callGemini({ model = "gemini-2.5-flash", contents, responseMimeType, thinkingBudget }) {
  if (!ai) return null;
  
  const config = {};
  if (thinkingBudget !== undefined) config.thinkingConfig = { thinkingBudget };
  if (responseMimeType) config.responseMimeType = responseMimeType;

  const response = await ai.models.generateContent({
    model,
    contents,
    config
  });

  // Handle both response structure variants
  if (response.candidates?.[0]?.content?.parts?.[0]?.text) {
    return response.candidates[0].content.parts[0].text;
  }
  if (response.response?.candidates?.[0]?.content?.parts?.[0]?.text) {
    return response.response.candidates[0].content.parts[0].text;
  }
  return null;
}

/**
 * Summarize product metadata into a concise, keyword-rich string.
 * @param {object|Array} metadata 
 * @returns {Promise<string>}
 */
export async function summarizeMetadata(metadata) {
  if (!metadata || !ai) return '';
  const metadataString = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
  
  try {
    const result = await callGemini({
      contents: [{
        role: 'user',
        parts: [{ text: `Summarize the following product metadata into a concise, keyword-rich description. Only include details relevant for product search. Return ONLY the values:\n\n${metadataString}` }]
      }],
      thinkingBudget: 0
    });
    return result?.trim() || '';
  } catch (error) {
    console.warn("Metadata summarization error:", error.message);
    return '';
  }
}

