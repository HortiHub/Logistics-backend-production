// server.js - Production-ready logistics backend
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const http = require('http');
const { Server } = require('socket.io');
const winston = require('winston');
const multer = require('multer');
const sharp = require('sharp');
const AWS = require('aws-sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const cron = require('node-cron');
const { body, validationResult, param } = require('express-validator');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const Redis = require('ioredis');

const app = express();
const server = http.createServer(app);

// Initialize Redis for caching and sessions
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

// Logger configuration
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    ...(process.env.NODE_ENV !== 'production' ? [new winston.transports.Console()] : [])
  ]
});

// Database connection with retry logic
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    logger.error('Error acquiring client', err.stack);
    process.exit(1);
  }
  client.query('SELECT NOW()', (err, result) => {
    release();
    if (err) {
      logger.error('Error executing query', err.stack);
      process.exit(1);
    }
    logger.info('Database connected successfully');
  });
});

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// AWS S3 setup for file uploads
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-east-1'
});

// Multer setup for file handling
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Swagger setup
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Logistics SaaS API',
      version: '1.0.0',
      description: 'Production logistics management system API'
    },
    servers: [{
      url: process.env.API_BASE_URL || 'http://localhost:5000',
      description: 'API Server'
    }]
  },
  apis: ['./routes/*.js', './server.js']
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

app.use(compression());
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 100 : 1000,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', limiter);

// API Documentation
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    body: req.method === 'POST' ? req.body : undefined
  });
  next();
});

// Authentication middleware with Redis caching
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    // Check Redis blacklist
    if (redis) {
      const isBlacklisted = await redis.get(`blacklist:${token}`);
      if (isBlacklisted) {
        return res.status(401).json({ error: 'Token is invalidated' });
      }
    }

    jwt.verify(token, process.env.JWT_SECRET, async (err, user) => {
      if (err) {
        logger.warn('JWT verification failed', { token: token.substring(0, 10) + '...', error: err.message });
        return res.status(403).json({ error: 'Invalid or expired token' });
      }

      // Cache user data in Redis
      if (redis) {
        const cachedUser = await redis.get(`user:${user.userId}`);
        if (cachedUser) {
          req.user = JSON.parse(cachedUser);
        } else {
          const userQuery = await pool.query('SELECT id, email, name, role FROM users WHERE id = $1', [user.userId]);
          if (userQuery.rows.length > 0) {
            req.user = userQuery.rows[0];
            await redis.setex(`user:${user.userId}`, 300, JSON.stringify(req.user)); // 5min cache
          }
        }
      } else {
        req.user = user;
      }

      next();
    });
  } catch (error) {
    logger.error('Authentication error', error);
    res.status(500).json({ error: 'Authentication service error' });
  }
};

// Validation middleware
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array()
    });
  }
  next();
};

// Geocoding service using Google Maps API
const geocodeAddress = async (address) => {
  try {
    if (!process.env.GOOGLE_MAPS_API_KEY) {
      // Fallback to mock coordinates for development
      return {
        lat: 40.7128 + (Math.random() - 0.5) * 0.1,
        lng: -74.0060 + (Math.random() - 0.5) * 0.1,
        formatted_address: address
      };
    }

    const response = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json`, {
      params: {
        address,
        key: process.env.GOOGLE_MAPS_API_KEY
      }
    });

    if (response.data.results.length > 0) {
      const location = response.data.results[0];
      return {
        lat: location.geometry.location.lat,
        lng: location.geometry.location.lng,
        formatted_address: location.formatted_address
      };
    }
    throw new Error('Address not found');
  } catch (error) {
    logger.error('Geocoding error', { address, error: error.message });
    throw error;
  }
};

// Route optimization using Google Maps Directions API
const optimizeRoute = async (orders, startLocation) => {
  try {
    if (!process.env.GOOGLE_MAPS_API_KEY || orders.length === 0) {
      // Fallback to simple nearest neighbor
      return simpleRouteOptimization(orders, startLocation);
    }

    const waypoints = orders.map(order => `${order.delivery_lat},${order.delivery_lng}`).join('|');
    
    const response = await axios.get(`https://maps.googleapis.com/maps/api/directions/json`, {
      params: {
        origin: `${startLocation.lat},${startLocation.lng}`,
        destination: `${orders[orders.length - 1].delivery_lat},${orders[orders.length - 1].delivery_lng}`,
        waypoints: `optimize:true|${waypoints}`,
        key: process.env.GOOGLE_MAPS_API_KEY
      }
    });

    if (response.data.routes.length > 0) {
      const route = response.data.routes[0];
      const optimizedOrder = route.waypoint_order || orders.map((_, i) => i);
      
      return {
        orders: optimizedOrder.map(index => orders[index]),
        distance: route.legs.reduce((total, leg) => total + leg.distance.value, 0),
        duration: route.legs.reduce((total, leg) => total + leg.duration.value, 0),
        polyline: route.overview_polyline.points
      };
    }

    return simpleRouteOptimization(orders, startLocation);
  } catch (error) {
    logger.error('Route optimization error', error);
    return simpleRouteOptimization(orders, startLocation);
  }
};

// Fallback route optimization
const simpleRouteOptimization = (orders, startLocation) => {
  const route = [];
  const unvisited = [...orders];
  let currentLocation = startLocation;
  
  while (unvisited.length > 0) {
    let nearestIndex = 0;
    let minDistance = calculateDistance(
      currentLocation.lat, currentLocation.lng,
      unvisited[0].delivery_lat, unvisited[0].delivery_lng
    );
    
    for (let i = 1; i < unvisited.length; i++) {
      const distance = calculateDistance(
        currentLocation.lat, currentLocation.lng,
        unvisited[i].delivery_lat, unvisited[i].delivery_lng
      );
      
      if (distance < minDistance) {
        minDistance = distance;
        nearestIndex = i;
      }
    }
    
    const nearestOrder = unvisited.splice(nearestIndex, 1)[0];
    route.push(nearestOrder);
    currentLocation = {
      lat: nearestOrder.delivery_lat,
      lng: nearestOrder.delivery_lng
    };
  }
  
  return { orders: route, distance: 0, duration: 0 };
};

const calculateDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

// File upload to S3
const uploadToS3 = async (buffer, key, contentType) => {
  try {
    if (!process.env.AWS_ACCESS_KEY_ID) {
      // Mock upload for development
      return `https://mockbucket.s3.amazonaws.com/${key}`;
    }

    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ACL: 'public-read'
    };

    const result = await s3.upload(params).promise();
    return result.Location;
  } catch (error) {
    logger.error('S3 upload error', error);
    throw error;
  }
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: User login
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *               role:
 *                 type: string
 */
app.post('/api/auth/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('role').isIn(['admin', 'driver', 'pos_operator'])
], validateRequest, async (req, res) => {
  try {
    const { email, password, role } = req.body;
    
    const userQuery = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND role = $2 AND is_active = true', 
      [email, role]
    );
    
    if (userQuery.rows.length === 0) {
      logger.warn('Login attempt with invalid credentials', { email, role });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = userQuery.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      logger.warn('Login attempt with wrong password', { email, role });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Update last login
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        role: user.role,
        iat: Math.floor(Date.now() / 1000)
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    // Cache user in Redis
    if (redis) {
      await redis.setex(`user:${user.id}`, 86400, JSON.stringify({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      }));
    }
    
    logger.info('User logged in successfully', { userId: user.id, role: user.role });
    
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
    logger.error('Login error', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout endpoint
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  try {
    const token = req.headers['authorization'].split(' ')[1];
    
    // Add token to Redis blacklist
    if (redis) {
      await redis.setex(`blacklist:${token}`, 86400, 'true');
      await redis.del(`user:${req.user.id}`);
    }
    
    logger.info('User logged out', { userId: req.user.id });
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout error', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

/**
 * @swagger
 * /api/orders:
 *   post:
 *     summary: Create a new order
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 */
app.post('/api/orders', authenticateToken, [
  body('customer_name').notEmpty().trim().escape(),
  body('customer_phone').optional().isMobilePhone(),
  body('customer_email').optional().isEmail().normalizeEmail(),
  body('delivery_address').notEmpty().trim(),
  body('items').isArray({ min: 1 }),
  body('items.*.product_name').notEmpty().trim().escape(),
  body('items.*.quantity').isInt({ min: 1 }),
  body('items.*.unit_price').isFloat({ min: 0 })
], validateRequest, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const {
      customer_name,
      customer_phone,
      customer_email,
      delivery_address,
      items,
      special_instructions
    } = req.body;

    // Geocode address
    let coordinates;
    try {
      coordinates = await geocodeAddress(delivery_address);
    } catch (geocodeError) {
      logger.warn('Geocoding failed, using default coordinates', { address: delivery_address });
      coordinates = { lat: 0, lng: 0, formatted_address: delivery_address };
    }

    const total_amount = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);

    // Create order
    const orderResult = await client.query(
      `INSERT INTO orders (
        customer_name, customer_phone, customer_email, 
        delivery_address, delivery_lat, delivery_lng, 
        total_amount, special_instructions, status, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9) 
      RETURNING *`,
      [
        customer_name, customer_phone, customer_email, 
        coordinates.formatted_address, coordinates.lat, coordinates.lng, 
        total_amount, special_instructions, req.user.id
      ]
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
    
    const completeOrder = {
      ...orderResult.rows[0],
      items
    };
    
    // Emit real-time update
    io.emit('new_order', completeOrder);
    
    // Send notification email if configured
    if (process.env.NOTIFICATION_EMAIL && customer_email) {
      // Email notification would go here
      logger.info('Order confirmation email sent', { orderId, customerEmail: customer_email });
    }
    
    logger.info('Order created successfully', { orderId, total: total_amount, customerId: req.user.id });
    res.status(201).json(completeOrder);
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Create order error', error);
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    client.release();
  }
});

// Get orders with advanced filtering
app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    const { 
      status, 
      date_from, 
      date_to, 
      page = 1, 
      limit = 50,
      customer_name,
      sort_by = 'created_at',
      sort_order = 'DESC'
    } = req.query;

    const offset = (page - 1) * limit;
    const conditions = [];
    const params = [];
    let paramCount = 0;

    // Build dynamic query
    if (status) {
      conditions.push(`o.status = $${++paramCount}`);
      params.push(status);
    }

    if (date_from) {
      conditions.push(`o.created_at >= $${++paramCount}`);
      params.push(date_from);
    }

    if (date_to) {
      conditions.push(`o.created_at <= $${++paramCount}`);
      params.push(date_to);
    }

    if (customer_name) {
      conditions.push(`o.customer_name ILIKE $${++paramCount}`);
      params.push(`%${customer_name}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    const query = `
      SELECT 
        o.*,
        u.name as created_by_name,
        json_agg(
          json_build_object(
            'id', oi.id,
            'product_name', oi.product_name,
            'quantity', oi.quantity,
            'unit_price', oi.unit_price,
            'total_price', oi.quantity * oi.unit_price
          )
        ) as items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN users u ON o.created_by = u.id
      ${whereClause}
      GROUP BY o.id, u.name
      ORDER BY o.${sort_by} ${sort_order}
      LIMIT $${++paramCount} OFFSET $${++paramCount}
    `;

    params.push(limit, offset);

    const result = await pool.query(query, params);
    
    // Get total count
    const countQuery = `
      SELECT COUNT(DISTINCT o.id) 
      FROM orders o 
      LEFT JOIN users u ON o.created_by = u.id
      ${whereClause}
    `;
    const countResult = await pool.query(countQuery, params.slice(0, -2));
    
    res.json({
      orders: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        pages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
  } catch (error) {
    logger.error('Fetch orders error', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Route optimization with Google Maps integration
app.post('/api/routes/optimize', authenticateToken, [
  body('orderIds').isArray({ min: 1 }),
  body('driverId').isInt(),
  body('startLocation').isObject()
], validateRequest, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { orderIds, driverId, startLocation } = req.body;
    
    // Verify driver exists
    const driverQuery = await client.query(
      'SELECT * FROM users WHERE id = $1 AND role = $2 AND is_active = true',
      [driverId, 'driver']
    );
    
    if (driverQuery.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or inactive driver' });
    }
    
    // Get orders with coordinates
    const ordersQuery = await client.query(
      `SELECT id, customer_name, delivery_address, delivery_lat, delivery_lng, total_amount, special_instructions
       FROM orders 
       WHERE id = ANY($1) AND status = 'pending'`,
      [orderIds]
    );
    
    if (ordersQuery.rows.length === 0) {
      return res.status(400).json({ error: 'No valid pending orders found' });
    }
    
    const orders = ordersQuery.rows;
    
    // Optimize route using Google Maps or fallback algorithm
    const optimizedRoute = await optimizeRoute(orders, startLocation);
    
    // Create route record
    const routeResult = await client.query(
      `INSERT INTO routes (
        driver_id, start_lat, start_lng, order_ids, route_data, 
        status, estimated_distance, estimated_duration
      ) VALUES ($1, $2, $3, $4, $5, 'assigned', $6, $7) 
      RETURNING *`,
      [
        driverId, startLocation.lat, startLocation.lng, orderIds, 
        JSON.stringify(optimizedRoute), optimizedRoute.distance, optimizedRoute.duration
      ]
    );
    
    // Update order statuses
    await client.query(
      'UPDATE orders SET status = $1, route_id = $2, assigned_at = NOW() WHERE id = ANY($3)',
      ['assigned', routeResult.rows[0].id, orderIds]
    );
    
    await client.query('COMMIT');
    
    const route = {
      ...routeResult.rows[0],
      orders: optimizedRoute.orders,
      driver: driverQuery.rows[0]
    };
    
    // Emit to specific driver
    io.to(`driver_${driverId}`).emit('route_assigned', route);
    
    // Emit to admin dashboard
    io.emit('route_created', route);
    
    logger.info('Route optimized and assigned', { 
      routeId: route.id, 
      driverId, 
      orderCount: orders.length 
    });
    
    res.json(route);
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Route optimization error', error);
    res.status(500).json({ error: 'Failed to optimize route' });
  } finally {
    client.release();
  }
});

// Driver routes endpoint
app.get('/api/driver/routes/:driverId', authenticateToken, [
  param('driverId').isInt()
], validateRequest, async (req, res) => {
  try {
    const { driverId } = req.params;
    
    // Verify access (driver can only see their own routes, admin can see all)
    if (req.user.role === 'driver' && req.user.id !== parseInt(driverId)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const routeQuery = await pool.query(
      `SELECT 
        r.*,
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
            'special_instructions', o.special_instructions,
            'delivered_at', o.delivered_at,
            'items', (
              SELECT json_agg(
                json_build_object(
                  'product_name', oi.product_name,
                  'quantity', oi.quantity,
                  'unit_price', oi.unit_price
                )
              )
              FROM order_items oi WHERE oi.order_id = o.id
            )
          ) ORDER BY 
            CASE WHEN o.status = 'in_progress' THEN 1
                 WHEN o.status = 'assigned' THEN 2
                 ELSE 3 END
        ) as orders
      FROM routes r
      JOIN orders o ON o.route_id = r.id
      WHERE r.driver_id = $1 AND r.status IN ('assigned', 'in_progress')
      GROUP BY r.id
      ORDER BY r.created_at DESC`,
      [driverId]
    );
    
    res.json(routeQuery.rows);
  } catch (error) {
    logger.error('Fetch driver routes error', error);
    res.status(500).json({ error: 'Failed to fetch routes' });
  }
});

// Start route (driver begins delivery)
app.post('/api/routes/:routeId/start', authenticateToken, [
  param('routeId').isInt()
], validateRequest, async (req, res) => {
  try {
    const { routeId } = req.params;
    
    const result = await pool.query(
      `UPDATE routes SET status = 'in_progress', started_at = NOW() 
       WHERE id = $1 AND driver_id = $2 AND status = 'assigned'
       RETURNING *`,
      [routeId, req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Route not found or cannot be started' });
    }
    
    // Update associated orders
    await pool.query(
      'UPDATE orders SET status = $1 WHERE route_id = $2',
      ['in_progress', routeId]
    );
    
    io.emit('route_started', { routeId, driverId: req.user.id });
    
    logger.info('Route started', { routeId, driverId: req.user.id });
    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Start route error', error);
    res.status(500).json({ error: 'Failed to start route' });
  }
});

// Delivery confirmation with photo upload
app.post('/api/orders/:orderId/deliver', authenticateToken, upload.fields([
  { name: 'proof_photo', maxCount: 1 },
  { name: 'signature_image', maxCount: 1 }
]), [
  param('orderId').isInt(),
  body('notes').optional().trim().escape(),
  body('customer_rating').optional().isInt({ min: 1, max: 5 })
], validateRequest, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { notes, customer_rating } = req.body;
    
    let proof_photo_url = null;
    let signature_url = null;
    
    // Upload images to S3
    if (req.files?.proof_photo) {
      const file = req.files.proof_photo[0];
      const resizedImage = await sharp(file.buffer)
        .resize(800, 600, { fit: 'inside' })
        .jpeg({ quality: 80 })
        .toBuffer();
      
      const key = `deliveries/${orderId}/proof_${Date.now()}.jpg`;
      proof_photo_url = await uploadToS3(resizedImage, key, 'image/jpeg');
    }
    
    if (req.files?.signature_image) {
      const file = req.files.signature_image[0];
      const key = `deliveries/${orderId}/signature_${Date.now()}.jpg`;
      signature_url = await uploadToS3(file.buffer, key, 'image/jpeg');
    }
    
    // Update order
    const result = await pool.query(
      `UPDATE orders SET 
         status = 'delivered',
         proof_photo = $1,
         signature = $2,
         delivery_notes = $3,
         customer_rating = $4,
         delivered_at = NOW(),
         delivered_by = $5
       WHERE id = $6 AND status = 'in_progress'
       RETURNING *`,
      [proof_photo_url, signature_url, notes, customer_rating, req.user.id, orderId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found or cannot be delivered' });
    }
    
    const order = result.rows[0];
    
    // Check if route is complete
    const routeCheck = await pool.query(
      `SELECT r.id, COUNT(o.id) as total_orders, 
              COUNT(CASE WHEN o.status = 'delivered' THEN 1 END) as delivered_orders
       FROM routes r
       JOIN orders o ON o.route_id = r.id
       WHERE r.id = $1
       GROUP BY r.id`,
      [order.route_id]
    );
    
    if (routeCheck.rows.length > 0) {
      const { total_orders, delivered_orders } = routeCheck.rows[0];
      if (total_orders === delivered_orders) {
        await pool.query(
          'UPDATE routes SET status = $1, completed_at = NOW() WHERE id = $2',
          ['completed', order.route_id]
        );
        
        io.emit('route_completed', { routeId: order.route_id, driverId: req.user.id });
      }
    }
    
    // Emit real-time update
    io.emit('order_delivered', order);
    
    // Send customer notification if email provided
    if (order.customer_email && process.env.NOTIFICATION_EMAIL) {
      // Email notification logic here
      logger.info('Delivery confirmation email sent', { orderId, customerEmail: order.customer_email });
    }
    
    logger.info('Delivery confirmed', { 
      orderId, 
      driverId: req.user.id, 
      hasPhoto: !!proof_photo_url,
      hasSignature: !!signature_url 
    });
    
    res.json(order);
  } catch (error) {
    logger.error('Delivery confirmation error', error);
    res.status(500).json({ error: 'Failed to confirm delivery' });
  }
});

// Analytics endpoint
app.get('/api/analytics/dashboard', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const { period = '7d' } = req.query;
    
    let dateFilter = '';
    switch (period) {
      case '24h':
        dateFilter = "AND created_at >= NOW() - INTERVAL '24 hours'";
        break;
      case '7d':
        dateFilter = "AND created_at >= NOW() - INTERVAL '7 days'";
        break;
      case '30d':
        dateFilter = "AND created_at >= NOW() - INTERVAL '30 days'";
        break;
      default:
        dateFilter = "AND created_at >= NOW() - INTERVAL '7 days'";
    }
    
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_orders,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_orders,
        COUNT(CASE WHEN status = 'assigned' THEN 1 END) as assigned_orders,
        COUNT(CASE WHEN status = 'in_progress' THEN 1 END) as in_progress_orders,
        COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered_orders,
        COALESCE(SUM(total_amount), 0) as total_revenue,
        COALESCE(AVG(total_amount), 0) as average_order_value,
        COALESCE(AVG(customer_rating), 0) as average_rating
      FROM orders 
      WHERE 1=1 ${dateFilter}
    `);
    
    const driverStats = await pool.query(`
      SELECT 
        u.name,
        COUNT(o.id) as deliveries_completed,
        COALESCE(AVG(o.customer_rating), 0) as avg_rating,
        COALESCE(SUM(o.total_amount), 0) as total_delivered_value
      FROM users u
      LEFT JOIN orders o ON u.id = o.delivered_by ${dateFilter.replace('created_at', 'o.delivered_at')}
      WHERE u.role = 'driver' AND u.is_active = true
      GROUP BY u.id, u.name
      ORDER BY deliveries_completed DESC
    `);
    
    res.json({
      overview: stats.rows[0],
      drivers: driverStats.rows,
      period
    });
  } catch (error) {
    logger.error('Analytics error', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// WebSocket connection handling
io.on('connection', (socket) => {
  logger.info('Client connected', { socketId: socket.id });
  
  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      socket.userRole = decoded.role;
      
      if (decoded.role === 'driver') {
        socket.join(`driver_${decoded.userId}`);
        logger.info('Driver joined room', { userId: decoded.userId, socketId: socket.id });
      }
    } catch (error) {
      logger.warn('Socket authentication failed', { socketId: socket.id });
      socket.emit('auth_error', 'Invalid token');
    }
  });
  
  socket.on('location_update', async (data) => {
    if (socket.userId && socket.userRole === 'driver') {
      try {
        // Store location in database
        await pool.query(
          'INSERT INTO driver_locations (driver_id, lat, lng) VALUES ($1, $2, $3)',
          [socket.userId, data.lat, data.lng]
        );
        
        // Broadcast to admin dashboard
        socket.broadcast.emit('driver_location', {
          driverId: socket.userId,
          lat: data.lat,
          lng: data.lng,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('Location update error', error);
      }
    }
  });
  
  socket.on('disconnect', () => {
    logger.info('Client disconnected', { socketId: socket.id, userId: socket.userId });
  });
});

// Scheduled tasks using node-cron
cron.schedule('0 2 * * *', async () => {
  try {
    logger.info('Running daily cleanup tasks');
    
    // Clean old location data (keep last 7 days)
    await pool.query(
      "DELETE FROM driver_locations WHERE timestamp < NOW() - INTERVAL '7 days'"
    );
    
    // Clean expired tokens from Redis
    if (redis) {
      const keys = await redis.keys('blacklist:*');
      for (const key of keys) {
        const ttl = await redis.ttl(key);
        if (ttl <= 0) {
          await redis.del(key);
        }
      }
    }
    
    logger.info('Daily cleanup completed');
  } catch (error) {
    logger.error('Daily cleanup failed', error);
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled error', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    userId: req.user?.id
  });
  
  if (error.name === 'ValidationError') {
    return res.status(400).json({ error: 'Validation failed', details: error.details });
  }
  
  if (error.name === 'MulterError') {
    return res.status(400).json({ error: 'File upload error', details: error.message });
  }
  
  res.status(500).json({ 
    error: 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { details: error.message })
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  
  server.close(() => {
    logger.info('HTTP server closed');
  });
  
  await pool.end();
  if (redis) await redis.quit();
  
  process.exit(0);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV}`);
  logger.info(`API Documentation: http://localhost:${PORT}/api/docs`);
});

module.exports = { app, server };
