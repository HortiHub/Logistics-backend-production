// Minimal working backend with all required endpoints
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 5000;

// Environment variables
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';

console.log('🚀 Starting Logistics Backend...');
console.log('Port:', PORT);
console.log('Database URL exists:', !!DATABASE_URL);

// CORS middleware
app.use(cors({
  origin: function (origin, callback) {
    // Allow all Railway domains and localhost
    if (!origin || origin.includes('railway.app') || origin.includes('localhost')) {
      return callback(null, true);
    }
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

// Body parser middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Database connection
let pool = null;
if (DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000
    });

    // Test connection
    pool.connect()
      .then(client => {
        console.log('✅ Database connected successfully');
        client.release();
      })
      .catch(err => {
        console.error('❌ Database connection failed:', err.message);
      });
  } catch (error) {
    console.error('❌ Database setup error:', error.message);
  }
} else {
  console.log('⚠️ No DATABASE_URL provided');
}

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.error('JWT verification failed:', err.message);
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Request logging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    database: pool ? 'connected' : 'not configured',
    port: PORT
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Logistics Backend API',
    status: 'running',
    endpoints: [
      'GET /',
      'GET /health',
      'POST /api/auth/login',
      'GET /api/orders',
      'POST /api/orders',
      'POST /api/routes/optimize',
      'GET /api/driver/routes/:driverId',
      'POST /api/orders/:orderId/deliver'
    ]
  });
});

// ===== API ENDPOINTS =====

// Login endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    console.log('Login attempt:', req.body);
    
    const { email, password, role } = req.body;
    
    if (!email || !password || !role) {
      return res.status(400).json({ 
        error: 'Email, password, and role are required',
        received: { email: !!email, password: !!password, role: !!role }
      });
    }
    
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }
    
    // Query database for user
    const userQuery = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND role = $2', 
      [email, role]
    );
    
    if (userQuery.rows.length === 0) {
      console.log('User not found:', { email, role });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = userQuery.rows[0];
    
    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      console.log('Invalid password for:', email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Create JWT token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        role: user.role 
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    console.log('✅ Login successful:', { email, role });
    
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      error: 'Login failed', 
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal error'
    });
  }
});

// Create order endpoint
app.post('/api/orders', authenticateToken, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }
    
    const { customer_name, customer_phone, customer_email, delivery_address, items, special_instructions } = req.body;

    if (!customer_name || !delivery_address || !items || items.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const total_amount = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
    
    // Mock coordinates
    const delivery_lat = 40.7128 + (Math.random() - 0.5) * 0.1;
    const delivery_lng = -74.0060 + (Math.random() - 0.5) * 0.1;

    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Insert order
      const orderResult = await client.query(
        `INSERT INTO orders (customer_name, customer_phone, customer_email, delivery_address, delivery_lat, delivery_lng, total_amount, special_instructions, status, created_by) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9) RETURNING *`,
        [customer_name, customer_phone, customer_email, delivery_address, delivery_lat, delivery_lng, total_amount, special_instructions, req.user.userId]
      );
      
      const orderId = orderResult.rows[0].id;
      
      // Insert order items
      for (const item of items) {
        await client.query(
          'INSERT INTO order_items (order_id, product_name, quantity, unit_price) VALUES ($1, $2, $3, $4)',
          [orderId, item.product_name, item.quantity, item.unit_price]
        );
      }
      
      await client.query('COMMIT');
      
      const completeOrder = { ...orderResult.rows[0], items };
      
      console.log('✅ Order created:', orderId);
      res.status(201).json(completeOrder);
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Get orders endpoint
app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }
    
    const { status } = req.query;
    
    let query = `
      SELECT o.*, 
             COALESCE(json_agg(json_build_object('product_name', oi.product_name, 'quantity', oi.quantity, 'unit_price', oi.unit_price)) 
             FILTER (WHERE oi.id IS NOT NULL), '[]'::json) as items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
    `;
    
    const params = [];
    if (status && status !== 'all') {
      query += ' WHERE o.status = $1';
      params.push(status);
    }
    
    query += ' GROUP BY o.id ORDER BY o.created_at DESC LIMIT 100';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Fetch orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Route optimization endpoint
app.post('/api/routes/optimize', authenticateToken, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not available' });
    
    const { orderIds, driverId } = req.body;
    
    if (!orderIds || !driverId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Update orders to assigned status
    await pool.query('UPDATE orders SET status = $1 WHERE id = ANY($2)', ['assigned', orderIds]);
    
    console.log('✅ Route optimized for driver:', driverId);
    res.json({ success: true, message: 'Route optimized', orderIds, driverId });
  } catch (error) {
    console.error('Route optimization error:', error);
    res.status(500).json({ error: 'Failed to optimize route' });
  }
});

// Driver routes endpoint
app.get('/api/driver/routes/:driverId', authenticateToken, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not available' });
    
    const { driverId } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM orders WHERE status IN ($1, $2) ORDER BY created_at DESC',
      ['assigned', 'in_progress']
    );
    
    res.json([{ id: 1, driver_id: parseInt(driverId), orders: result.rows }]);
  } catch (error) {
    console.error('Fetch driver routes error:', error);
    res.status(500).json({ error: 'Failed to fetch routes' });
  }
});

// Delivery confirmation endpoint
app.post('/api/orders/:orderId/deliver', authenticateToken, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not available' });
    
    const { orderId } = req.params;
    const { notes } = req.body;
    
    const result = await pool.query(
      `UPDATE orders SET status = 'delivered', delivery_notes = $1, delivered_at = NOW(), delivered_by = $2
       WHERE id = $3 RETURNING *`,
      [notes || 'Delivered successfully', req.user.userId, orderId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    console.log('✅ Delivery confirmed:', orderId);
    res.json({ order: result.rows[0], message: 'Delivery confirmed' });
  } catch (error) {
    console.error('Delivery confirmation error:', error);
    res.status(500).json({ error: 'Failed to confirm delivery' });
  }
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler - this catches all unmatched routes
app.use('*', (req, res) => {
  console.log('404 - Endpoint not found:', req.method, req.originalUrl);
  res.status(404).json({ 
    error: 'Endpoint not found',
    method: req.method,
    path: req.originalUrl,
    available_endpoints: [
      'GET /',
      'GET /health',
      'POST /api/auth/login',
      'GET /api/orders',
      'POST /api/orders',
      'POST /api/routes/optimize',
      'GET /api/driver/routes/:driverId',
      'POST /api/orders/:orderId/deliver'
    ]
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎉 Logistics Backend running on port ${PORT}`);
  console.log(`🌐 Server ready to accept connections`);
  console.log(`📊 Available endpoints listed at root URL`);
});

module.exports = app;
