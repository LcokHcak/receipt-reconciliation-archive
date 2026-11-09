-- Sign Workbench Database Schema
-- Version: 2.0
-- Date: 2026-05-07
-- Description: SQLite as primary storage, JSON as backup

-- ============================================
-- Core Tables
-- ============================================

-- Batches table
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  metadata TEXT, -- JSON field for flexible data
  UNIQUE(name)
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  doc_type TEXT,
  doc_type_auto TEXT,
  doc_type_final TEXT,
  doc_type_confidence REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  process_result TEXT,
  confidence REAL,
  needs_review INTEGER DEFAULT 0,
  review_reasons TEXT, -- JSON array
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fields TEXT, -- JSON field: passport/receipt fields
  ocr_result TEXT, -- JSON field: raw OCR result
  classification TEXT, -- JSON field: classification details
  signature TEXT, -- JSON field: signature data
  metadata TEXT, -- JSON field: other metadata
  PRIMARY KEY (batch_id, id),
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
);

-- ============================================
-- Customer Library Tables
-- ============================================

-- Customers table
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'intake_ready',
  agent_name TEXT,
  metadata TEXT, -- JSON field
  UNIQUE(workspace_key, name)
);

-- Customer images table
CREATE TABLE IF NOT EXISTS customer_images (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision TEXT, -- pass, exclude, needs_retake, etc.
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT, -- JSON field: detection results, etc.
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- ============================================
-- Authentication & Authorization Tables
-- ============================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'reviewer',
  display_name TEXT,
  email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  is_active INTEGER DEFAULT 1
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================
-- Audit & Logging Tables
-- ============================================

-- Audit logs table
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  details TEXT, -- JSON field
  ip_address TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ============================================
-- Indexes for Performance
-- ============================================

-- Batch indexes
CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status);
CREATE INDEX IF NOT EXISTS idx_batches_created_at ON batches(created_at);

-- Task indexes
CREATE INDEX IF NOT EXISTS idx_tasks_batch_id ON tasks(batch_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_doc_type ON tasks(doc_type);
CREATE INDEX IF NOT EXISTS idx_tasks_needs_review ON tasks(needs_review);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);

-- Customer indexes
CREATE INDEX IF NOT EXISTS idx_customers_workspace_key ON customers(workspace_key);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers(created_at);

-- Customer image indexes
CREATE INDEX IF NOT EXISTS idx_customer_images_customer_id ON customer_images(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_images_status ON customer_images(status);

-- User indexes
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Session indexes
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Audit log indexes
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_type ON audit_logs(resource_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_id ON audit_logs(resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

-- ============================================
-- Views for Common Queries
-- ============================================

-- Batch summary view
CREATE VIEW IF NOT EXISTS batch_summary AS
SELECT
  b.id,
  b.name,
  b.status,
  b.created_at,
  b.updated_at,
  COUNT(t.id) as total_tasks,
  SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) as completed_tasks,
  SUM(CASE WHEN t.needs_review = 1 THEN 1 ELSE 0 END) as needs_review_tasks,
  SUM(CASE WHEN t.doc_type = 'passport' THEN 1 ELSE 0 END) as passport_count,
  SUM(CASE WHEN t.doc_type = 'receipt' THEN 1 ELSE 0 END) as receipt_count
FROM batches b
LEFT JOIN tasks t ON b.id = t.batch_id
GROUP BY b.id;

-- Customer summary view
CREATE VIEW IF NOT EXISTS customer_summary AS
SELECT
  c.id,
  c.name,
  c.workspace_key,
  c.status,
  c.created_at,
  c.updated_at,
  COUNT(ci.id) as total_images,
  SUM(CASE WHEN ci.status = 'confirmed' THEN 1 ELSE 0 END) as confirmed_images,
  SUM(CASE WHEN ci.decision = 'pass' THEN 1 ELSE 0 END) as passed_images
FROM customers c
LEFT JOIN customer_images ci ON c.id = ci.customer_id
GROUP BY c.id;

-- ============================================
-- Initial Data
-- ============================================

-- Create default admin user (password: admin123, should be changed immediately)
-- Password hash generated with bcrypt, rounds=10
INSERT OR IGNORE INTO users (username, password_hash, role, display_name, created_at, updated_at)
VALUES (
  'admin',
  '$2b$10$rBV2kHYW5nF5xhN8Ym3zXeqKp7LqYZQJ8vXGJ5nF5xhN8Ym3zXeqK',
  'admin',
  'Administrator',
  datetime('now'),
  datetime('now')
);
