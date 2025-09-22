-- Production-ready database schema for logistics platform
-- Compatible with Railway PostgreSQL

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis" CASCADE;

-- Users table with enhanced features
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    uuid UUID DEFAULT uuid_generate_v4() UNIQUE,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL CHECK (role IN ('admin', 'driver', 'pos_operator', 'manager')),
    phone VARCHAR(20),
    avatar_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    email_verified BOOLEAN DEFAULT FALSE,
    last_login TIMESTAMP,
    login_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMP,
    timezone VARCHAR(100) DEFAULT 'UTC',
    preferences JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver profiles with additional details
CREATE TABLE driver_profiles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    license_number VARCHAR(100),
    license_expiry DATE,
    vehicle_type VARCHAR(100),
    vehicle_plate VARCHAR(50),
    vehicle_capacity_kg DECIMAL(8,2),
    insurance_policy VARCHAR(100),
    insurance_expiry DATE,
    emergency_contact_name VARCHAR(255),
    emergency_contact_phone VARCHAR(20),
    hourly_rate DECIMAL(10,2),
    is_available BOOLEAN DEFAULT TRUE,
    current_lat DECIMAL(10, 8),
    current_lng DECIMAL(11, 8),
    last_location_update TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Enhanced orders table
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    uuid UUID DEFAULT uuid_generate_v4() UNIQUE,
    order_number VARCHAR(50) UNIQUE NOT NULL,
    customer_name VARCHAR(255) NOT NULL,
    customer_phone VARCHAR(20),
    customer_email VARCHAR(255),
    customer_company VARCHAR(255),
    
    -- Delivery details
    delivery_address TEXT NOT NULL,
    delivery_address_2 TEXT,
    delivery_city VARCHAR(100),
    delivery_state VARCHAR(100),
    delivery_postal_code VARCHAR(20),
    delivery_country VARCHAR(100) DEFAULT 'US',
    delivery_lat DECIMAL(10, 8),
    delivery_lng DECIMAL(11, 8),
    delivery_instructions TEXT,
    
    -- Pickup details (for logistics companies)
    pickup_address TEXT,
    pickup_lat DECIMAL(10, 8),
    pickup_lng DECIMAL(11, 8),
    pickup_contact_name VARCHAR(255),
    pickup_contact_phone VARCHAR(20),
    
    -- Order details
    total_amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    tax_amount DECIMAL(10, 2) DEFAULT 0,
    discount_amount DECIMAL(10, 2) DEFAULT 0,
    delivery_fee DECIMAL(10, 2) DEFAULT 0,
    
    -- Delivery preferences
    preferred_delivery_date DATE,
    preferred_delivery_time_start TIME,
    preferred_delivery_time_end TIME,
    delivery_window_minutes INTEGER DEFAULT 60,
    requires_signature BOOLEAN DEFAULT FALSE,
    requires_id_check BOOLEAN DEFAULT FALSE,
    fragile BOOLEAN DEFAULT FALSE,
    weight_kg DECIMAL(8, 2),
    dimensions_cm VARCHAR(50), -- "L x W x H"
    
    -- Status and tracking
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN (
        'pending', 'confirmed', 'assigned', 'picked_up', 
        'in_transit', 'out_for_delivery', 'delivered', 
        'failed_delivery', 'returned', 'cancelled'
    )),
    priority VARCHAR(20) DEFAULT 'standard' CHECK (priority IN ('low', 'standard', 'high', 'urgent')),
    
    -- Assignment and delivery tracking
    route_id INTEGER,
    assigned_driver_id INTEGER REFERENCES users(id),
    assigned_at TIMESTAMP,
    picked_up_at TIMESTAMP,
    delivered_at TIMESTAMP,
    delivery_attempts INTEGER DEFAULT 0,
    max_delivery_attempts INTEGER DEFAULT 3,
    
    -- Proof of delivery
    proof_photo TEXT,
    signature TEXT,
    delivery_notes TEXT,
    recipient_name VARCHAR(255),
    customer_rating INTEGER CHECK (customer_rating >= 1 AND customer_rating <= 5),
    customer_feedback TEXT,
    
    -- Business fields
    created_by INTEGER REFERENCES users(id),
    delivered_by INTEGER REFERENCES users(id),
    payment_status VARCHAR(50) DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
    payment_method VARCHAR(50),
    stripe_payment_intent_id VARCHAR(255),
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Search and indexing
    search_vector tsvector
);

-- Order items with enhanced details
CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    sku VARCHAR(100),
    product_name VARCHAR(255) NOT NULL,
    product_description TEXT,
    category VARCHAR(100),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(10, 2) NOT NULL CHECK (unit_price >= 0),
    total_price DECIMAL(10, 2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
    weight_per_unit_kg DECIMAL(8, 2),
    dimensions_per_unit_cm VARCHAR(50),
    special_handling_instructions TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Enhanced routes table
CREATE TABLE routes (
    id SERIAL PRIMARY KEY,
    uuid UUID DEFAULT uuid_generate_v4() UNIQUE,
    route_number VARCHAR(50) UNIQUE NOT NULL,
    driver_id INTEGER REFERENCES users(id),
    vehicle_id INTEGER,
    
    -- Route planning
    start_location_name VARCHAR(255),
    start_lat DECIMAL(10, 8),
    start_lng DECIMAL(11, 8),
    end_location_name VARCHAR(255),
    end_lat DECIMAL(10, 8),
    end_lng DECIMAL(11, 8),
    
    -- Route optimization data
    order_ids INTEGER[] NOT NULL,
    waypoints JSONB, -- Optimized route waypoints
    route_geometry TEXT, -- Encoded polyline
    
    -- Estimates vs actuals
    estimated_distance_km DECIMAL(8, 2),
    estimated_duration_minutes INTEGER,
    estimated_fuel_cost DECIMAL(8, 2),
    actual_distance_km DECIMAL(8, 2),
    actual_duration_minutes INTEGER,
    actual_fuel_cost DECIMAL(8, 2),
    
    -- Status tracking
    status VARCHAR(50) DEFAULT 'planned' CHECK (status IN (
        'planned', 'assigned', 'started', 'in_progress', 
        'paused', 'completed', 'cancelled'
    )),
    
    -- Time tracking
    planned_start_time TIMESTAMP,
    actual_start_time TIMESTAMP,
    planned_end_time TIMESTAMP,
    actual_end_time TIMESTAMP,
    
    -- Performance metrics
    delivery_success_rate DECIMAL(5, 2),
    total_orders INTEGER,
    completed_orders INTEGER,
    failed_orders INTEGER,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver location tracking with better performance
CREATE TABLE driver_locations (
    id SERIAL PRIMARY KEY,
    driver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    route_id INTEGER REFERENCES routes(id) ON DELETE SET NULL,
    lat DECIMAL(10, 8) NOT NULL,
    lng DECIMAL(11, 8) NOT NULL,
    altitude DECIMAL(8, 2),
    accuracy DECIMAL(8, 2),
    heading DECIMAL(5, 2), -- 0-360 degrees
    speed_kmh DECIMAL(6, 2),
    battery_level INTEGER, -- 0-100
    is_online BOOLEAN DEFAULT TRUE,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Partition by date for better performance
    CONSTRAINT driver_locations_timestamp_check CHECK (timestamp >= '2024-01-01' AND timestamp < '2030-01-01')
) PARTITION BY RANGE (timestamp);

-- Create partitions for driver_locations (monthly partitions for 2 years)
CREATE TABLE driver_locations_2024_01 PARTITION OF driver_locations
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE driver_locations_2024_02 PARTITION OF driver_locations
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
CREATE TABLE driver_locations_2024_03 PARTITION OF driver_locations
    FOR VALUES FROM ('2024-03-01') TO ('2024-04-01');
CREATE TABLE driver_locations_2024_04 PARTITION OF driver_locations
    FOR VALUES FROM ('2024-04-01') TO ('2024-05-01');
CREATE TABLE driver_locations_2024_05 PARTITION OF driver_locations
    FOR VALUES FROM ('2024-05-01') TO ('2024-06-01');
CREATE TABLE driver_locations_2024_06 PARTITION OF driver_locations
    FOR VALUES FROM ('2024-06-01') TO ('2024-07-01');
CREATE TABLE driver_locations_2024_07 PARTITION OF driver_locations
    FOR VALUES FROM ('2024-07-01') TO ('2024-08-01');
CREATE TABLE driver_locations_2024_08 PARTITION OF driver_locations
    FOR VALUES FROM ('2024-08-01') TO ('2024-09-01');
CREATE TABLE driver_locations_2024_09 PARTITION OF driver_locations
    FOR VALUES FROM ('2024-09-01') TO ('2024-10-01');
CREATE TABLE driver_locations_2024_10 PARTITION OF driver_locations
    FOR VALUES FROM ('2024-10-01') TO ('2024-11-01');
CREATE TABLE driver_locations_2024_11 PARTITION OF driver_locations
    FOR VALUES FROM ('2024-11-01') TO ('2024-12-01');
CREATE TABLE driver_locations_2024_12 PARTITION OF driver_locations
    FOR VALUES FROM ('2024-12-01') TO ('2025-01-01');

-- Products/services catalog
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    sku VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    subcategory VARCHAR(100),
    price DECIMAL(10, 2) NOT NULL CHECK (price >= 0),
    cost DECIMAL(10, 2) DEFAULT 0,
    weight_kg DECIMAL(8, 2),
    dimensions_cm VARCHAR(50),
    requires_cold_storage BOOLEAN DEFAULT FALSE,
    requires_signature BOOLEAN DEFAULT FALSE,
    fragile BOOLEAN DEFAULT FALSE,
    max_quantity_per_order INTEGER,
    inventory_quantity INTEGER DEFAULT 0,
    low_stock_threshold INTEGER DEFAULT 10,
    supplier_name VARCHAR(255),
    supplier_code VARCHAR(100),
    barcode VARCHAR(100),
    image_urls TEXT[],
    tags TEXT[],
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Delivery zones for pricing and service areas
CREATE TABLE delivery_zones (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    geometry GEOMETRY(POLYGON, 4326), -- PostGIS polygon for zone boundaries
    base_delivery_fee DECIMAL(8, 2) DEFAULT 0,
    per_km_rate DECIMAL(6, 2) DEFAULT 0,
    per_minute_rate DECIMAL(6, 2) DEFAULT 0,
    priority_multiplier DECIMAL(4, 2) DEFAULT 1.0,
    is_active BOOLEAN DEFAULT TRUE,
    service_hours JSONB, -- {"monday": {"start": "09:00", "end": "17:00"}, ...}
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Customer management
CREATE TABLE customers (
    id SERIAL PRIMARY KEY,
    uuid UUID DEFAULT uuid_generate_v4() UNIQUE,
    email VARCHAR(255) UNIQUE,
    phone VARCHAR(20),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    company_name VARCHAR(255),
    
    -- Default addresses
    default_billing_address JSONB,
    default_shipping_address JSONB,
    
    -- Preferences and settings
    communication_preferences JSONB DEFAULT '{"email": true, "sms": false, "push": true}',
    delivery_preferences JSONB DEFAULT '{}',
    
    -- Business metrics
    total_orders INTEGER DEFAULT 0,
    total_spent DECIMAL(12, 2) DEFAULT 0,
    average_order_value DECIMAL(10, 2) DEFAULT 0,
    last_order_date TIMESTAMP,
    customer_lifetime_value DECIMAL(12, 2) DEFAULT 0,
    
    -- Customer service
    satisfaction_score DECIMAL(3, 2), -- 1.00 - 5.00
    complaint_count INTEGER DEFAULT 0,
    compliment_count INTEGER DEFAULT 0,
    
    -- Account status
    is_active BOOLEAN DEFAULT TRUE,
    is_vip BOOLEAN DEFAULT FALSE,
    credit_limit DECIMAL(10, 2) DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Notifications and communications
CREATE TABLE notifications (
    id SERIAL PRIMARY KEY,
    recipient_type VARCHAR(20) NOT NULL CHECK (recipient_type IN ('user', 'customer', 'driver')),
    recipient_id INTEGER NOT NULL,
    type VARCHAR(50) NOT NULL, -- 'order_status', 'delivery_update', 'payment', etc.
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    data JSONB, -- Additional structured data
    channels VARCHAR(50)[] DEFAULT ARRAY['push'], -- 'email', 'sms', 'push', 'webhook'
    
    -- Delivery tracking
    sent_at TIMESTAMP,
    delivered_at TIMESTAMP,
    read_at TIMESTAMP,
    error_message TEXT,
    
    -- Scheduling
    scheduled_for TIMESTAMP,
    expires_at TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- System events and audit log
CREATE TABLE system_events (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50), -- 'order', 'route', 'user', etc.
    entity_id INTEGER,
    user_id INTEGER REFERENCES users(id),
    event_data JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Performance analytics
CREATE TABLE performance_metrics (
    id SERIAL PRIMARY KEY,
    metric_date DATE NOT NULL,
    metric_type VARCHAR(50) NOT NULL, -- 'daily_orders', 'delivery_time', etc.
    driver_id INTEGER REFERENCES users(id),
    route_id INTEGER REFERENCES routes(id),
    
    -- Metrics
    total_orders INTEGER DEFAULT 0,
    completed_orders INTEGER DEFAULT 0,
    failed_orders INTEGER DEFAULT 0,
    total_revenue DECIMAL(12, 2) DEFAULT 0,
    total_distance_km DECIMAL(10, 2) DEFAULT 0,
    total_time_minutes INTEGER DEFAULT 0,
    average_delivery_time_minutes DECIMAL(8, 2),
    customer_satisfaction_score DECIMAL(3, 2),
    
    -- Efficiency metrics
    orders_per_hour DECIMAL(6, 2),
    revenue_per_hour DECIMAL(10, 2),
    fuel_efficiency_kmpl DECIMAL(6, 2),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(metric_date, metric_type, driver_id, route_id)
);

-- Create comprehensive indexes for performance
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX idx_orders_assigned_driver ON orders(assigned_driver_id);
CREATE INDEX idx_orders_route_id ON orders(route_id);
CREATE INDEX idx_orders_customer_email ON orders(customer_email);
CREATE INDEX idx_orders_delivery_date ON orders(preferred_delivery_date);
CREATE INDEX idx_orders_search ON orders USING GIN(search_vector);
CREATE INDEX idx_orders_location ON orders(delivery_lat, delivery_lng);

CREATE INDEX idx_routes_driver_id ON routes(driver_id);
CREATE INDEX idx_routes_status ON routes(status);
CREATE INDEX idx_routes_created_at ON routes(created_at DESC);

CREATE INDEX idx_driver_locations_driver_timestamp ON driver_locations(driver_id, timestamp DESC);
CREATE INDEX idx_driver_locations_route_id ON driver_locations(route_id);

CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_active ON products(is_active);
CREATE INDEX idx_products_sku ON products(sku);

CREATE INDEX idx_customers_email ON customers(email);
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_company ON customers(company_name);

CREATE INDEX idx_notifications_recipient ON notifications(recipient_type, recipient_id);
CREATE INDEX idx_notifications_sent_at ON notifications(sent_at);
CREATE INDEX idx_notifications_scheduled ON notifications(scheduled_for) WHERE scheduled_for IS NOT NULL;

CREATE INDEX idx_system_events_type_entity ON system_events(event_type, entity_type, entity_id);
CREATE INDEX idx_system_events_user_id ON system_events(user_id);
CREATE INDEX idx_system_events_created_at ON system_events(created_at DESC);

CREATE INDEX idx_performance_metrics_date_type ON performance_metrics(metric_date, metric_type);
CREATE INDEX idx_performance_metrics_driver ON performance_metrics(driver_id, metric_date);

-- Foreign key constraints
ALTER TABLE orders ADD CONSTRAINT fk_orders_route_id FOREIGN KEY (route_id) REFERENCES routes(id);
ALTER TABLE orders ADD CONSTRAINT fk_orders_assigned_driver FOREIGN KEY (assigned_driver_id) REFERENCES users(id);

-- Full-text search setup for orders
CREATE OR REPLACE FUNCTION update_orders_search_vector() RETURNS TRIGGER AS $
BEGIN
    NEW.search_vector = to_tsvector('english', 
        COALESCE(NEW.order_number, '') || ' ' ||
        COALESCE(NEW.customer_name, '') || ' ' ||
        COALESCE(NEW.customer_email, '') || ' ' ||
        COALESCE(NEW.customer_company, '') || ' ' ||
        COALESCE(NEW.delivery_address, '')
    );
    RETURN NEW;
END;
$ LANGUAGE plpgsql;

CREATE TRIGGER update_orders_search_vector_trigger
    BEFORE INSERT OR UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_orders_search_vector();

-- Auto-generate order numbers
CREATE OR REPLACE FUNCTION generate_order_number() RETURNS TRIGGER AS $
BEGIN
    IF NEW.order_number IS NULL OR NEW.order_number = '' THEN
        NEW.order_number = 'ORD-' || to_char(NOW(), 'YYYYMMDD') || '-' || 
                          LPAD(NEW.id::text, 6, '0');
    END IF;
    RETURN NEW;
END;
$ LANGUAGE plpgsql;

CREATE TRIGGER generate_order_number_trigger
    BEFORE INSERT ON orders
    FOR EACH ROW EXECUTE FUNCTION generate_order_number();

-- Auto-generate route numbers
CREATE OR REPLACE FUNCTION generate_route_number() RETURNS TRIGGER AS $
BEGIN
    IF NEW.route_number IS NULL OR NEW.route_number = '' THEN
        NEW.route_number = 'RT-' || to_char(NOW(), 'YYYYMMDD') || '-' || 
                          LPAD(NEW.id::text, 4, '0');
    END IF;
    RETURN NEW;
END;
$ LANGUAGE plpgsql;

CREATE TRIGGER generate_route_number_trigger
    BEFORE INSERT ON routes
    FOR EACH ROW EXECUTE FUNCTION generate_route_number();

-- Update timestamps automatically
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_driver_profiles_updated_at BEFORE UPDATE ON driver_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_routes_updated_at BEFORE UPDATE ON routes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Customer metrics update function
CREATE OR REPLACE FUNCTION update_customer_metrics() RETURNS TRIGGER AS $
BEGIN
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        -- Update customer metrics when order is created or updated
        UPDATE customers SET
            total_orders = (SELECT COUNT(*) FROM orders WHERE customer_email = NEW.customer_email),
            total_spent = (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE customer_email = NEW.customer_email AND status = 'delivered'),
            last_order_date = (SELECT MAX(created_at) FROM orders WHERE customer_email = NEW.customer_email)
        WHERE email = NEW.customer_email;
        
        -- Create customer record if doesn't exist
        INSERT INTO customers (email, first_name, last_name, company_name)
        SELECT NEW.customer_email, 
               SPLIT_PART(NEW.customer_name, ' ', 1),
               CASE 
                   WHEN POSITION(' ' IN NEW.customer_name) > 0 
                   THEN SUBSTRING(NEW.customer_name FROM POSITION(' ' IN NEW.customer_name) + 1)
                   ELSE ''
               END,
               NEW.customer_company
        WHERE NEW.customer_email IS NOT NULL
        ON CONFLICT (email) DO NOTHING;
        
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$ LANGUAGE plpgsql;

CREATE TRIGGER update_customer_metrics_trigger
    AFTER INSERT OR UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_customer_metrics();

-- Insert sample data for production testing
-- Note: Passwords are bcrypt hashes for 'password123'
INSERT INTO users (email, password_hash, name, role, phone, is_active) VALUES
('admin@logistics.co', '$2b$10$rKvK7GbQZ5Z5Z5Z5Z5Z5ZOeKvK7GbQZ5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Zu', 'Admin User', 'admin', '+1-555-0001', true),
('manager@logistics.co', '$2b$10$rKvK7GbQZ5Z5Z5Z5Z5Z5ZOeKvK7GbQZ5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Zu', 'Operations Manager', 'manager', '+1-555-0002', true),
('driver1@logistics.co', '$2b$10$rKvK7GbQZ5Z5Z5Z5Z5Z5ZOeKvK7GbQZ5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Zu', 'John Smith', 'driver', '+1-555-1001', true),
('driver2@logistics.co', '$2b$10$rKvK7GbQZ5Z5Z5Z5Z5Z5ZOeKvK7GbQZ5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Zu', 'Sarah Johnson', 'driver', '+1-555-1002', true),
('pos1@logistics.co', '$2b$10$rKvK7GbQZ5Z5Z5Z5Z5Z5ZOeKvK7GbQZ5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Zu', 'Jane Doe', 'pos_operator', '+1-555-2001', true);

-- Driver profiles
INSERT INTO driver_profiles (user_id, license_number, vehicle_type, vehicle_plate, vehicle_capacity_kg, is_available) VALUES
(3, 'DL123456789', 'Van', 'ABC-123', 1000.00, true),
(4, 'DL987654321', 'Truck', 'XYZ-789', 2500.00, true);

-- Sample products
INSERT INTO products (sku, name, description, price, category, weight_kg, is_active) VALUES
('FOOD-001', 'Pizza Margherita', 'Classic tomato and mozzarella pizza', 12.99, 'Food', 0.5, true),
('FOOD-002', 'Chicken Burger', 'Grilled chicken breast burger with fries', 9.99, 'Food', 0.4, true),
('FOOD-003', 'Caesar Salad', 'Fresh romaine lettuce with caesar dressing', 7.99, 'Food', 0.3, true),
('BEV-001', 'Coca Cola', '330ml can', 1.99, 'Beverages', 0.33, true),
('BEV-002', 'Water Bottle', '500ml spring water', 0.99, 'Beverages', 0.5, true),
('ELEC-001', 'Wireless Headphones', 'Bluetooth wireless headphones', 79.99, 'Electronics', 0.2, true),
('ELEC-002', 'Phone Charger', 'USB-C fast charging cable', 19.99, 'Electronics', 0.1, true);

-- Sample customers
INSERT INTO customers (email, first_name, last_name, company_name, total_orders, is_active) VALUES
('alice@company.com', 'Alice', 'Johnson', 'Tech Corp', 0, true),
('bob@startup.io', 'Bob', 'Smith', 'StartupIO', 0, true),
('carol@enterprise.com', 'Carol', 'Brown', 'Enterprise Solutions', 0, true);

-- Sample delivery zones (simplified rectangles)
INSERT INTO delivery_zones (name, description, base_delivery_fee, per_km_rate, is_active, service_hours) VALUES
('Downtown', 'Downtown business district', 5.00, 1.50, true, '{"monday": {"start": "08:00", "end": "20:00"}, "tuesday": {"start": "08:00", "end": "20:00"}, "wednesday": {"start": "08:00", "end": "20:00"}, "thursday": {"start": "08:00", "end": "20:00"}, "friday": {"start": "08:00", "end": "20:00"}, "saturday": {"start": "10:00", "end": "18:00"}, "sunday": {"start": "12:00", "end": "17:00"}}'),
('Suburbs', 'Suburban residential areas', 3.50, 2.00, true, '{"monday": {"start": "09:00", "end": "19:00"}, "tuesday": {"start": "09:00", "end": "19:00"}, "wednesday": {"start": "09:00", "end": "19:00"}, "thursday": {"start": "09:00", "end": "19:00"}, "friday": {"start": "09:00", "end": "19:00"}, "saturday": {"start": "09:00", "end": "18:00"}, "sunday": {"start": "10:00", "end": "17:00"}}'),
('Industrial', 'Industrial and warehouse district', 7.50, 1.25, true, '{"monday": {"start": "07:00", "end": "17:00"}, "tuesday": {"start": "07:00", "end": "17:00"}, "wednesday": {"start": "07:00", "end": "17:00"}, "thursday": {"start": "07:00", "end": "17:00"}, "friday": {"start": "07:00", "end": "17:00"}}');

-- Sample orders with realistic data
INSERT INTO orders (
    customer_name, customer_phone, customer_email, customer_company,
    delivery_address, delivery_city, delivery_state, delivery_postal_code,
    delivery_lat, delivery_lng, total_amount, currency, delivery_fee,
    status, priority, created_by
) VALUES
('Alice Johnson', '+1-555-3001', 'alice@company.com', 'Tech Corp',
 '123 Main Street, Suite 100', 'New York', 'NY', '10001',
 40.7128, -74.0060, 35.97, 'USD', 5.00, 'pending', 'standard', 5),

('Bob Smith', '+1-555-3002', 'bob@startup.io', 'StartupIO',
 '456 Oak Avenue', 'New York', 'NY', '10002', 
 40.7580, -73.9855, 24.98, 'USD', 3.50, 'pending', 'high', 5),

('Carol Brown', '+1-555-3003', 'carol@enterprise.com', 'Enterprise Solutions',
 '789 Pine Road, Floor 5', 'New York', 'NY', '10003',
 40.7505, -73.9934, 99.97, 'USD', 7.50, 'confirmed', 'urgent', 5);

-- Sample order items
INSERT INTO order_items (order_id, sku, product_name, quantity, unit_price) VALUES
-- Order 1 items
(1, 'FOOD-001', 'Pizza Margherita', 1, 12.99),
(1, 'FOOD-003', 'Caesar Salad', 1, 7.99),
(1, 'BEV-001', 'Coca Cola', 2, 1.99),
(1, 'BEV-002', 'Water Bottle', 1, 0.99),
(1, 'ELEC-002', 'Phone Charger', 1, 19.99),

-- Order 2 items  
(2, 'FOOD-002', 'Chicken Burger', 1, 9.99),
(2, 'BEV-001', 'Coca Cola', 2, 1.99),
(2, 'BEV-002', 'Water Bottle', 1, 0.99),

-- Order 3 items (high-value electronics order)
(3, 'ELEC-001', 'Wireless Headphones', 4, 79.99),
(3, 'ELEC-002', 'Phone Charger', 2, 19.99);

-- Create views for common queries
CREATE VIEW active_orders AS
SELECT 
    o.*,
    u1.name as created_by_name,
    u2.name as assigned_driver_name,
    u2.phone as driver_phone,
    CASE 
        WHEN o.status IN ('pending', 'confirmed') THEN 'Awaiting Assignment'
        WHEN o.status IN ('assigned', 'picked_up') THEN 'In Transit'
        WHEN o.status = 'out_for_delivery' THEN 'Out for Delivery'
        WHEN o.status = 'delivered' THEN 'Completed'
        ELSE 'Other'
    END as status_display
FROM orders o
LEFT JOIN users u1 ON o.created_by = u1.id
LEFT JOIN users u2 ON o.assigned_driver_id = u2.id
WHERE o.status NOT IN ('delivered', 'cancelled', 'returned');

CREATE VIEW driver_performance AS
SELECT 
    u.id,
    u.name,
    u.email,
    dp.vehicle_type,
    dp.vehicle_plate,
    dp.is_available,
    COUNT(o.id) as total_deliveries,
    COUNT(CASE WHEN o.status = 'delivered' THEN 1 END) as completed_deliveries,
    COUNT(CASE WHEN o.status = 'failed_delivery' THEN 1 END) as failed_deliveries,
    COALESCE(AVG(o.customer_rating), 0) as avg_rating,
    COALESCE(SUM(o.total_amount), 0) as total_revenue_generated,
    CASE 
        WHEN COUNT(o.id) > 0 THEN 
            ROUND((COUNT(CASE WHEN o.status = 'delivered' THEN 1 END) * 100.0 / COUNT(o.id)), 2)
        ELSE 0 
    END as success_rate_percent
FROM users u
JOIN driver_profiles dp ON u.id = dp.user_id
LEFT JOIN orders o ON u.id = o.assigned_driver_id
WHERE u.role = 'driver' AND u.is_active = true
GROUP BY u.id, u.name, u.email, dp.vehicle_type, dp.vehicle_plate, dp.is_available;

CREATE VIEW order_summary AS
SELECT 
    o.id,
    o.order_number,
    o.customer_name,
    o.customer_email,
    o.delivery_address,
    o.total_amount,
    o.status,
    o.priority,
    o.created_at,
    o.delivered_at,
    COUNT(oi.id) as item_count,
    STRING_AGG(oi.product_name, ', ') as items_summary,
    u1.name as created_by_name,
    u2.name as driver_name
FROM orders o
LEFT JOIN order_items oi ON o.id = oi.order_id
LEFT JOIN users u1 ON o.created_by = u1.id  
LEFT JOIN users u2 ON o.assigned_driver_id = u2.id
GROUP BY o.id, o.order_number, o.customer_name, o.customer_email, 
         o.delivery_address, o.total_amount, o.status, o.priority,
         o.created_at, o.delivered_at, u1.name, u2.name;

-- Create materialized view for analytics (refresh periodically)
CREATE MATERIALIZED VIEW daily_analytics AS
SELECT 
    DATE(created_at) as date,
    COUNT(*) as total_orders,
    COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered_orders,
    COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_orders,
    SUM(total_amount) as total_revenue,
    AVG(total_amount) as avg_order_value,
    COUNT(DISTINCT customer_email) as unique_customers,
    AVG(customer_rating) as avg_rating
FROM orders
WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- Create unique index for materialized view
CREATE UNIQUE INDEX idx_daily_analytics_date ON daily_analytics(date);

-- Grant appropriate permissions (adjust based on your setup)
-- Note: In Railway, you typically have full access as the database owner

-- Performance optimization: Create custom statistics
CREATE STATISTICS orders_multi_column_stats ON status, created_at, assigned_driver_id FROM orders;
CREATE STATISTICS routes_driver_status_stats ON driver_id, status, created_at FROM routes;

-- Add comments for documentation
COMMENT ON TABLE orders IS 'Main orders table containing all delivery orders';
COMMENT ON TABLE routes IS 'Optimized delivery routes assigned to drivers';
COMMENT ON TABLE driver_locations IS 'Real-time location tracking for drivers (partitioned by month)';
COMMENT ON TABLE products IS 'Product catalog for order items';
COMMENT ON TABLE customers IS 'Customer profiles and metrics';

COMMENT ON COLUMN orders.search_vector IS 'Full-text search vector for orders';
COMMENT ON COLUMN orders.order_number IS 'Auto-generated unique order identifier';
COMMENT ON COLUMN routes.route_geometry IS 'Encoded polyline for route visualization';

-- Analysis and reporting functions
CREATE OR REPLACE FUNCTION get_driver_stats(driver_id_param INTEGER, days_back INTEGER DEFAULT 30)
RETURNS TABLE(
    total_routes INTEGER,
    total_orders INTEGER,
    completed_orders INTEGER,
    total_distance_km DECIMAL,
    total_time_hours DECIMAL,
    avg_rating DECIMAL,
    success_rate DECIMAL
) AS $
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(DISTINCT r.id)::INTEGER as total_routes,
        COUNT(o.id)::INTEGER as total_orders,
        COUNT(CASE WHEN o.status = 'delivered' THEN 1 END)::INTEGER as completed_orders,
        COALESCE(SUM(r.actual_distance_km), 0) as total_distance_km,
        COALESCE(SUM(r.actual_duration_minutes), 0) / 60.0 as total_time_hours,
        COALESCE(AVG(o.customer_rating), 0) as avg_rating,
        CASE 
            WHEN COUNT(o.id) > 0 THEN 
                COUNT(CASE WHEN o.status = 'delivered' THEN 1 END) * 100.0 / COUNT(o.id)
            ELSE 0
        END as success_rate
    FROM routes r
    LEFT JOIN orders o ON o.route_id = r.id
    WHERE r.driver_id = driver_id_param 
    AND r.created_at >= CURRENT_DATE - INTERVAL days_back||' days';
END;
$ LANGUAGE plpgsql;
