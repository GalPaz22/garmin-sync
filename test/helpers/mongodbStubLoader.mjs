/**
 * Module loader hook that replaces lib/mongodb.js with whatever the test put on
 * globalThis.__mongoStub, so route behaviour can be exercised without a cluster.
 * Registered per test process, so it never leaks into another test file.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('mongodb.js')) {
    return { url: 'stub:mongodb', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === 'stub:mongodb') {
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export default Promise.resolve(globalThis.__mongoStub);'
    };
  }
  return nextLoad(url, context);
}
