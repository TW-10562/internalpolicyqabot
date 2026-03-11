#!/bin/bash

# Enterprise QA Bot - Database Migration Script
# This script sets up all required tables and initial data

set -e

# Configuration
MYSQL_HOST=${MYSQL_HOST:-localhost}
MYSQL_PORT=${MYSQL_PORT:-3306}
MYSQL_USER=${MYSQL_USER:-root}
MYSQL_PASSWORD=${MYSQL_PASSWORD:-root}
MYSQL_DATABASE=${MYSQL_DATABASE:-expoproj}

echo "================================"
echo "Enterprise QA Bot Database Setup"
echo "================================"
echo ""
echo "Configuration:"
echo "  Host: $MYSQL_HOST"
echo "  Port: $MYSQL_PORT"
echo "  User: $MYSQL_USER"
echo "  Database: $MYSQL_DATABASE"
echo ""

# Function to execute SQL
execute_sql() {
  local sql=$1
  mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" <<< "$sql"
}

# Step 1: Create database if not exists
echo "[1/7] Creating database..."
mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" <<< "CREATE DATABASE IF NOT EXISTS $MYSQL_DATABASE;"
echo "✓ Database ready"
echo ""

# Step 2: Create department table
echo "[2/7] Creating department table..."
execute_sql "
CREATE TABLE IF NOT EXISTS department (
  id INT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(50) NOT NULL UNIQUE COMMENT 'HR, GA, OTHER',
  name VARCHAR(100) NOT NULL,
  description TEXT,
  admin_group_id VARCHAR(100) COMMENT 'External admin group ID',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_code (code),
  INDEX idx_is_active (is_active)
);
"
echo "✓ Department table created"
echo ""

# Step 3: Create file_department table
echo "[3/7] Creating file_department table..."
execute_sql "
CREATE TABLE IF NOT EXISTS file_department (
  id INT PRIMARY KEY AUTO_INCREMENT,
  file_id INT NOT NULL,
  department_id INT NOT NULL,
  is_primary BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_file_dept (file_id, department_id),
  FOREIGN KEY (department_id) REFERENCES department(id) ON DELETE CASCADE,
  INDEX idx_file_id (file_id),
  INDEX idx_department_id (department_id),
  INDEX idx_primary (is_primary)
);
"
echo "✓ File department mapping table created"
echo ""

# Step 4: Create query_classification table
echo "[4/7] Creating query_classification table..."
execute_sql "
CREATE TABLE IF NOT EXISTS query_classification (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id VARCHAR(100) NOT NULL,
  query_text LONGTEXT NOT NULL,
  detected_language VARCHAR(10),
  classified_department VARCHAR(50),
  confidence INT,
  keywords JSON,
  rag_triggered BOOLEAN DEFAULT FALSE,
  rag_document_ids JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_department (classified_department),
  INDEX idx_created (created_at),
  FULLTEXT KEY ft_query (query_text)
);
"
echo "✓ Query classification table created"
echo ""

# Step 5: Create audit_log table
echo "[5/7] Creating audit_log table..."
execute_sql "
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id VARCHAR(100),
  department_id VARCHAR(50),
  action_type VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100),
  resource_id VARCHAR(100),
  status VARCHAR(50) DEFAULT 'SUCCESS',
  details JSON,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_created (user_id, created_at),
  INDEX idx_dept_created (department_id, created_at),
  INDEX idx_action_created (action_type, created_at),
  INDEX idx_created (created_at)
);
"
echo "✓ Audit log table created"
echo ""

# Step 6: Create escalation table
echo "[6/7] Creating escalation table..."
execute_sql "
CREATE TABLE IF NOT EXISTS escalation (
  id INT PRIMARY KEY AUTO_INCREMENT,
  ticket_number VARCHAR(100) NOT NULL UNIQUE,
  user_id VARCHAR(100) NOT NULL,
  department_id VARCHAR(50) NOT NULL,
  original_query LONGTEXT,
  reason TEXT,
  status VARCHAR(50) DEFAULT 'OPEN',
  assigned_admin_id VARCHAR(100),
  resolution TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP NULL,
  INDEX idx_ticket (ticket_number),
  INDEX idx_user (user_id),
  INDEX idx_department_status (department_id, status),
  INDEX idx_admin_status (assigned_admin_id, status),
  INDEX idx_created (created_at)
);
"
echo "✓ Escalation table created"
echo ""

# Step 7: Create admin_message table
echo "[7/7] Creating admin_message table..."
execute_sql "
CREATE TABLE IF NOT EXISTS admin_message (
  id INT PRIMARY KEY AUTO_INCREMENT,
  sender_id VARCHAR(100) NOT NULL,
  recipient_user_id VARCHAR(100),
  recipient_department_id VARCHAR(50),
  message_type VARCHAR(50),
  content LONGTEXT NOT NULL,
  mentions JSON,
  read_at TIMESTAMP NULL,
  pinned_at TIMESTAMP NULL,
  expires_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sender (sender_id),
  INDEX idx_recipient_user (recipient_user_id),
  INDEX idx_recipient_dept (recipient_department_id),
  INDEX idx_read_at (read_at),
  INDEX idx_created (created_at)
);
"
echo "✓ Admin message table created"
echo ""

# Step 8: Create faq_analytics table
echo "[8/8] Creating faq_analytics table..."
execute_sql "
CREATE TABLE IF NOT EXISTS faq_analytics (
  id INT PRIMARY KEY AUTO_INCREMENT,
  department_id VARCHAR(50),
  normalized_query VARCHAR(500),
  query_hash VARCHAR(64) UNIQUE,
  frequency INT DEFAULT 1,
  quality_score DECIMAL(5,2),
  is_faq_candidate BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_queried_at TIMESTAMP NULL,
  INDEX idx_hash (query_hash),
  INDEX idx_department (department_id),
  INDEX idx_frequency (frequency),
  INDEX idx_faq_candidate (is_faq_candidate)
);
"
echo "✓ FAQ analytics table created"
echo ""

# Step 9: Seed initial departments
echo "[9/9] Seeding initial departments..."
execute_sql "
INSERT IGNORE INTO department (id, code, name, description, admin_group_id, is_active) VALUES
(1, 'HR', 'Human Resources', 'Human Resources Department', 'hr-admins', TRUE),
(2, 'GA', 'General Affairs', 'General Affairs / Facilities Department', 'ga-admins', TRUE),
(3, 'OTHER', 'Other', 'General inquiries - default department', NULL, TRUE);
"
echo "✓ Initial departments seeded"
echo ""

# Summary
echo "================================"
echo "✓ Database setup complete!"
echo "================================"
echo ""
echo "Next steps:"
echo "1. Run: npm run db:seed (to add test data)"
echo "2. Run: npm test (to verify setup)"
echo "3. Deploy services with: npm run start"
echo ""
echo "Tables created:"
echo "  - department (3 initial records)"
echo "  - file_department"
echo "  - query_classification"
echo "  - audit_log"
echo "  - escalation"
echo "  - admin_message"
echo "  - faq_analytics"
echo ""
