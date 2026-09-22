import clientPromise from '../lib/mongodb.js';

/**
 * Authenticate user by API key and attach user data to request
 * The API key is stored in users.users collection with user's credentials
 */
export async function authenticateRequest(req, res, next) {
  // Allow CORS preflight to pass without auth
  if (req.method === 'OPTIONS') {
    return next();
  }

  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  
  console.log('🔐 Auth Check:');
  console.log('   API key present:', !!apiKey);
  
  if (!apiKey) {
    console.log('   ❌ No API key provided');
    return res.status(401).json({ error: 'API key required' });
  }
  
  try {
    // Look up user by API key in MongoDB
    const client = await clientPromise;
    const usersDb = client.db('users');
    const usersCollection = usersDb.collection('users');
    
    console.log('   🔍 Looking up user with API key...');
    
    const user = await usersCollection.findOne({ apiKey: apiKey });
    
    if (!user) {
      console.log('   ❌ Invalid API key - user not found');
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    // Fallback to credentials.dbName if top-level dbName is missing
    console.log('📊 [AUTH] User found in database:');
    console.log('   email:', user.email || 'MISSING');
    console.log('   Top-level dbName:', user.dbName || 'MISSING');
    console.log('   credentials.dbName:', user.credentials?.dbName || 'MISSING');
    console.log('   Top-level platform:', user.platform || 'MISSING');
    console.log('   credentials present:', !!user.credentials);
    
    const dbName = user.dbName || user.credentials?.dbName;
    const platform = user.platform || (user.credentials?.wooUrl ? 'woocommerce' : user.credentials?.shopifyDomain ? 'shopify' : undefined);
    
    console.log('📊 [AUTH] Resolved values:');
    console.log('   ✅ User authenticated:', user.email);
    console.log('   📋 User platform:', platform || 'MISSING');
    console.log('   📋 User dbName:', dbName || 'MISSING');
    
    if (!dbName) {
      console.log('   ⚠️  Warning: User has no dbName (neither top-level nor in credentials)');
      console.log('   Full user record:', JSON.stringify(user, null, 2));
    }
    
    // Attach user data to request for use in routes
    req.user = {
      email: user.email,
      apiKey: user.apiKey,
      platform: user.platform,
      dbName: user.dbName,
      credentials: user.credentials,
      syncMode: user.syncMode,
      context: user.context,
      explain: user.explain,
      onboardingComplete: user.onboardingComplete,
      trialStatus: user.trialStatus,
      trialStartedAt: user.trialStartedAt
    };
    
    next();
    
  } catch (error) {
    console.error('   ❌ Auth error:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

