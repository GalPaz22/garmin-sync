import express from 'express';
import clientPromise from '../lib/mongodb.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    // Check MongoDB connection
    const client = await clientPromise;
    await client.db('admin').command({ ping: 1 });
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        mongodb: 'connected',
        openai: process.env.OPENAI_API_KEY ? 'configured' : 'missing'
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

export default router;

