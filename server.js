// server.js with Socket.IO support
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Environment variables
const PORT = process.env.PORT || 5000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';

console.log('🚀 Starting Logistics Backend with Socket.IO...');

// CORS configuration
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      FRONTEND_URL,
      'http://localhost:3000'
    ].filter(Boolean);
    
    if (allowedOrigins.some(allowed => origin.startsWith(allowed.replace(/\/$/, '')))) {
      return callback(null, true);
    }
    
    if (origin && origin.includes('railway.app')) {
      return callback(null, true);
    }
    
    callback(null, true); // Permissive for now
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (origin && origin.includes('railway.app')) {
        return callback(null, true);
      }
      callback(null, true); // Permissive CORS for Socket.IO
    },
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

app.use(express.json({ limit: '10mb' }));

// Database connection
let pool = null;
if (DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 5,
      connectionTimeoutMillis: 10000
    });

    pool.connect()
      .then(client => {
        console.log('✅ Database connected');
        client.release();
      })
      .catch(err => console.error('❌ Database connection failed:', err.message));
  } catch (error) {
    console.error('❌ Database setup error:', error.message);
  }
}

// Auth middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    socketio: 'enabled',
    database: pool ? 'connected' : 'not configured'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Logistics Backend API with Socket.IO',
    status: 'running',
    socketio: 'enabled',
    endpoints: [
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

// Login endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, role } = req.body;
    
    if (!email || !password || !role) {
      return res.status(400).json({ error: 'Email, password, and role are required' });
    }
    
    if (!pool) {
      return res.status(500).json({ error: 'Database not available' });
    }
    
    const userQuery = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND role = $2', 
      [email, role]
    );
    
    if (userQuery.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = userQuery.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
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
    res.status(500).json({ error: 'Login failed' });
  }
});

// Create order
app.post('/api/orders', authenticateToken, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not available' });
    
    const { customer_name, customer_phone, customer_email, delivery_address, items, special_instructions } = req.body;

    if (!customer_name || !delivery_address || !items || items.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const total_amount = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
    const delivery_lat = 40.7128 + (Math.random() - 0.5) * 0.1;
    const delivery_lng = -74.0060 + (Math.random() - 0.5) * 0.1;

    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const orderResult = await client.query(
        `INSERT INTO orders (customer_name, customer_phone, customer_email, delivery_address, delivery_lat, delivery_lng, total_amount, special_instructions, status, created_by) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9) RETURNING *`,
        [customer_name, customer_phone, customer_email, delivery_address, delivery_lat, delivery_lng, total_amount, special_instructions, req.user.userId]
      );
      
      const orderId = orderResult.rows[0].id;
      
      for (const item of items) {
        await client.query(
          'INSERT INTO order_items (order_id, product_name, quantity, unit_price) VALUES ($1, $2, $3, $4)',
          [orderId, item.product_name, item.quantity, item.unit_price]
        );
      }
      
      await client.query('COMMIT');
      
      const completeOrder = { ...orderResult.rows[0], items };
      
      // Emit real-time update
      io.emit('new_order', completeOrder);
      
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

// Get orders
app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not available' });
    
    const result = await pool.query(`
      SELECT o.*, 
             COALESCE(json_agg(json_build_object('product_name', oi.product_name, 'quantity', oi.quantity, 'unit_price', oi.unit_price)) 
             FILTER (WHERE oi.id IS NOT NULL), '[]'::json) as items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      GROUP BY o.id ORDER BY o.created_at DESC LIMIT 100
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Fetch orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Route optimization
app.post('/api/routes/optimize', authenticateToken, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not available' });
    
    const { orderIds, driverId } = req.body;
    
    if (!orderIds || !driverId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    await pool.query('UPDATE orders SET status = $1 WHERE id = ANY($2)', ['assigned', orderIds]);
    
    // Emit real-time update
    io.emit('route_created', { orderIds, driverId });
    
    res.json({ success: true, message: 'Route optimized', orderIds, driverId });
  } catch (error) {
    console.error('Route optimization error:', error);
    res.status(500).json({ error: 'Failed to optimize route' });
  }
});

// Driver routes
app.get('/api/driver/routes/:driverId', authenticateToken, async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'Database not available' });
    
    const result = await pool.query(
      'SELECT * FROM orders WHERE status IN ($1, $2) ORDER BY created_at DESC',
      ['assigned', 'in_progress']
    );
    
    res.json([{ id: 1, driver_id: parseInt(req.params.driverId), orders: result.rows }]);
  } catch (error) {
    console.error('Fetch driver routes error:', error);
    res.status(500).json({ error: 'Failed to fetch routes' });
  }
});

// Delivery confirmation
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
    
    // Emit real-time update
    io.emit('order_delivered', result.rows[0]);
    
    res.json({ order: result.rows[0], message: 'Delivery confirmed' });
  } catch (error) {
    console.error('Delivery confirmation error:', error);
    res.status(500).json({ error: 'Failed to confirm delivery' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('join_driver_room', (driverId) => {
    socket.join(`driver_${driverId}`);
    console.log(`Driver ${driverId} joined room`);
  });
  
  socket.on('location_update', (data) => {
    socket.broadcast.emit('driver_location', data);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Error handlers
app.use((error, req, res, next) => {
  console.error('Global error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎉 Server running on port ${PORT} with Socket.IO`);
  console.log(`🔌 Socket.IO enabled for real-time updates`);
});

module.exports = { app, server };
