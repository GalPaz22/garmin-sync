/**
 * Finding the Garmin store.
 *
 * Garmin is a store, not a brand: it has its own document in the `users.users`
 * collection, identified by the name "garmin". Everything this service does is
 * scoped to that one document, so resolving it is the first thing a run does
 * and the resolution is reported rather than assumed — if it ever matches the
 * wrong account, that has to be visible before a sync writes anything.
 */

import clientPromise from './mongodb.js';

/** Which store this service is for. Overridable without a code change. */
export const STORE_IDENTIFIER = (process.env.GARMIN_STORE || 'garmin').trim();

/** Fields a store can be named by, most specific first. */
const IDENTITY_FIELDS = ['dbName', 'credentials.dbName', 'name', 'companyName', 'email'];

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const readPath = (doc, path) => path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), doc);

/**
 * Which field made the document match, and with what value. Used for the
 * "matched on" line in the dashboard.
 */
export function describeMatch(user, identifier = STORE_IDENTIFIER) {
  const exact = new RegExp(`^${escapeRegExp(identifier)}$`, 'i');
  const loose = new RegExp(escapeRegExp(identifier), 'i');

  for (const test of [exact, loose]) {
    for (const field of IDENTITY_FIELDS) {
      const value = readPath(user, field);
      if (typeof value === 'string' && test.test(value)) {
        return { field, value, exact: test === exact };
      }
    }
  }
  return { field: null, value: null, exact: false };
}

/**
 * Resolve the Garmin store document.
 *
 * An exact match on any identity field wins. Only when nothing matches exactly
 * does it fall back to a partial match, and the result says which happened, so
 * a loose match is never mistaken for a confident one.
 *
 * @returns {Promise<{user: object, match: object, ambiguous: object[]}|null>}
 */
export async function resolveGarminStore(identifier = STORE_IDENTIFIER) {
  if (!identifier) throw new Error('GARMIN_STORE is empty — set it to the store name in users.users');

  const client = await clientPromise;
  const users = client.db('users').collection('users');

  const exact = new RegExp(`^${escapeRegExp(identifier)}$`, 'i');
  const loose = new RegExp(escapeRegExp(identifier), 'i');

  for (const pattern of [exact, loose]) {
    const matches = await users.find({ $or: IDENTITY_FIELDS.map(field => ({ [field]: pattern })) }).toArray();
    if (!matches.length) continue;

    return {
      user: matches[0],
      match: describeMatch(matches[0], identifier),
      // More than one account answering to the same name is worth surfacing
      // rather than silently taking the first.
      ambiguous: matches.length > 1
        ? matches.map(user => ({ email: user.email || null, dbName: user.dbName || user.credentials?.dbName || null }))
        : []
    };
  }

  return null;
}

/**
 * Pull credentials and classification config out of the store document.
 * Reads the same shapes the main processing service reads.
 */
export function resolveStoreConfig(user) {
  const credentials = user.credentials || user.onboarding?.credentials || {};
  const configuration = user.configuration || {};

  return {
    email: user.email,
    credentials,
    platform: user.platform || credentials.platform || configuration.platform,
    dbName: credentials.dbName || configuration.dbName || user.onboarding?.dbName || user.dbName,
    categories: configuration.categories?.list || credentials.categories || [],
    userTypes: configuration.types?.list || credentials.type || [],
    softCategories: configuration.softCategories?.list || credentials.softCategories || [],
    colors: configuration.colors?.list || credentials.colors || []
  };
}
