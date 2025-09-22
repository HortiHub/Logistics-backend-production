// Bulletproof server.js - No AWS, minimal dependencies, maximum reliability
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();

// Environment variables with safe fallbacks
const PORT = process.env.PORT || 5000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';

console.log('🚀 Starting Logistics Backend...');
console.log('Port:', PORT);
console.log('Database URL exists:', !!DATABASE_URL);
console.log('Environment:', process.env.NODE_ENV || 'development');

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

// Middleware
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Simple request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

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
        client.query('SELECT NOW()')
          .then(() => {
            console.log('✅ Database query test passed');
            client.release();
          })
          .catch(err => {
            console.error('❌ Database query test failed:', err.message);
            client.release();
          });
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
  try {
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
  } catch (error) {
    console.error('Auth middleware error:', error.message);
    res.status(500).json({ error: 'Authentication error' });
  }
};

// Health check endpoint
app.get('/health', (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    database: pool ? 'connected' : 'not configured',
    port: PORT
  };
  res.json(health);
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Logistics Backend API',
    status: 'running',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Login endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    console.log('Login attempt:', { email: req.body.email, role: req.body.role });
    
    const { email, password, role } = req.body;
    
    // Validate input
    if (!email || !password || !role) {
      return res.status(400).json({ 
        error: 'Email, password, and role are required'
      });
    }
    
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }
    
    // Query database
    const userQuery = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND role = $2', 
      [email, role]
    );
    
    if (userQuery.rows.length === 0) {
      console.log('User not found:', { email, role });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = userQuery.rows[0];
    
    // Check password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      console.log('Invalid password for user:', email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Generate token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        role: user.role 
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    console.log('Login successful:', { email, role });
    
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
    console.error('Login error:', error.message);
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
    
    const {
      customer_name,
      customer_phone,
      customer_email,
      delivery_address,
      items,
      special_instructions
    } = req.body;

    // Validate input
    if (!customer_name || !delivery_address || !items || items.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Calculate total
    const total_amount = items.reduce((sum, item) => {
      return sum + (parseFloat(item.quantity) * parseFloat(item.unit_price));
    }, 0);

    // Mock coordinates (in production, use real geocoding)
    const delivery_lat = 40.7128 + (Math.random() - 0.5) * 0.1;
    const delivery_lng = -74.0060 + (Math.random() - 0.5) * 0.1;

    // Database transaction
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Insert order
      const orderResult = await client.query(
        `INSERT INTO orders (
          customer_name, customer_phone, customer_email, 
          delivery_address, delivery_lat, delivery_lng, 
          total_amount, special_instructions, status, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9) 
        RETURNING *`,
        [customer_name, customer_phone, customer_email, delivery_address, 
         delivery_lat, delivery_lng, total_amount, special_instructions, req.user.userId]
      );
      
      const orderId = orderResult.rows[0].id;
      
      // Insert order items
      for (const item of items) {
        await client.query(
          'INSERT INTO order_items (order_id, product_name, quantity, unit_price) VALUES ($1, $2, $3, $4)',
          [orderId, item.product_name, parseInt(item.quantity), parseFloat(item.unit_price)]
        );
      }
      
      await client.query('COMMIT');
      
      const completeOrder = {
        ...orderResult.rows[0],
        items
      };
      
      console.log('Order created:', orderId);
      res.status(201).json(completeOrder);
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Create order error:', error.message);
    res.status(500).json({ 
      error: 'Failed to create order',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal error'
    });
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
             COALESCE(
               json_agg(
                 json_build_object(
                   'product_name', oi.product_name,
                   'quantity', oi.quantity,
                   'unit_price', oi.unit_price
                 )
               ) FILTER (WHERE oi.id IS NOT NULL),
               '[]'::json
             ) as items
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
    console.error('Fetch orders error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch orders',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal error'
    });
  }
});

// Route optimization endpoint
app.post('/api/routes/optimize', authenticateToken, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }
    
    const { orderIds, driverId, startLocation } = req.body;
    
    if (!orderIds || !driverId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Get orders
    const ordersQuery = await pool.query(
      'SELECT id, delivery_lat, delivery_lng, delivery_address, customer_name FROM orders WHERE id = ANY($1)',
      [orderIds]
    );
    
    const orders = ordersQuery.rows;
    
    if (orders.length === 0) {
      return res.status(400).json({ error: 'No valid orders found' });
    }
    
    // Simple route data
    const routeData = {
      orders: orders,
      distance: orders.length * 5, // Mock 5km per order
      duration: orders.length * 15  // Mock 15 minutes per order
    };
    
    // Create route record
    const routeResult = await pool.query(
      `INSERT INTO routes (driver_id, start_lat, start_lng, route_data, status, estimated_distance, estimated_duration)
       VALUES ($1, $2, $3, $4, 'assigned', $5, $6) RETURNING *`,
      [driverId, 
       startLocation?.lat || 40.7128, 
       startLocation?.lng || -74.0060, 
       JSON.stringify(routeData),
       routeData.distance,
       routeData.duration]
    );
    
    // Update order statuses
    await pool.query(
      'UPDATE orders SET status = $1, route_id = $2 WHERE id = ANY($3)',
      ['assigned', routeResult.rows[0].id, orderIds]
    );
    
    console.log('Route optimized:', routeResult.rows[0].id);
    res.json({
      route: routeResult.rows[0],
      orders: orders,
      message: 'Route optimized successfully'
    });
  } catch (error) {
    console.error('Route optimization error:', error.message);
    res.status(500).json({ 
      error: 'Failed to optimize route',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal error'
    });
  }
});

// Driver routes endpoint
app.get('/api/driver/routes/:driverId', authenticateToken, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }
    
    const { driverId } = req.params;
    
    const routeQuery = await pool.query(
      `SELECT r.*, 
              json_agg(
                json_build_object(
                  'id', o.id,
                  'customer_name', o.customer_name,
                  'customer_phone', o.customer_phone,
                  'delivery_address', o.delivery_address,
                  'delivery_lat', o.delivery_lat,
                  'delivery_lng', o.delivery_lng,
                  'status', o.status,
                  'total_amount', o.total_amount,
                  'special_instructions', o.special_instructions
                )
              ) as orders
       FROM routes r
       LEFT JOIN orders o ON o.route_id = r.id
       WHERE r.driver_id = $1 AND r.status IN ('assigned', 'in_progress')
       GROUP BY r.id
       ORDER BY r.created_at DESC`,
      [driverId]
    );
    
    res.json(routeQuery.rows);
  } catch (error) {
    console.error('Fetch driver routes error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch routes',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal error'
    });
  }
});

// Delivery confirmation endpoint
app.post('/api/orders/:orderId/deliver', authenticateToken, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }
    
    const { orderId } = req.params;
    const { notes, customer_rating } = req.body;
    
    const result = await pool.query(
      `UPDATE orders SET 
         status = 'delivered',
         delivery_notes = $1,
         delivered_at = NOW(),
         delivered_by = $2
       WHERE id = $3 RETURNING *`,
      [notes || 'Delivered successfully', req.user.userId, orderId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    console.log('Order delivered:', orderId);
    res.json({
      order: result.rows[0],
      message: 'Delivery confirmed successfully'
    });
  } catch (error) {
    console.error('Delivery confirmation error:', error.message);
    res.status(500).json({ 
      error: 'Failed to confirm delivery',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal error'
    });
  }
});

// Analytics endpoint
app.get('/api/analytics/dashboard', authenticateToken, async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }
    
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_orders,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_orders,
        COUNT(CASE WHEN status = 'assigned' THEN 1 END) as assigned_orders,
        COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered_orders,
        COALESCE(SUM(total_amount), 0) as total_revenue,
        COALESCE(AVG(total_amount), 0) as average_order_value
      FROM orders 
      WHERE created_at >= NOW() - INTERVAL '7 days'
    `);
    
    res.json({
      overview: stats.rows[0],
      period: '7 days'
    });
  } catch (error) {
    console.error('Analytics error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch analytics',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal error'
    });
  }
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Global error:', error.message);
  res.status(500).json({ 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method,
    available_endpoints: [
      'GET /',
      'GET /health',
      'POST /api/auth/login',
      'GET /api/orders',
      'POST /api/orders',
      'POST /api/routes/optimize',
      'GET /api/driver/routes/:driverId',
      'POST /api/orders/:orderId/deliver',
      'GET /api/analytics/dashboard'
    ]
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🎉 Logistics Backend running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 Available endpoints: http://localhost:${PORT}/`);
});

module.exports = app;
