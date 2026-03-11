/**
 * Production-grade Input Validation Utilities
 * Implements validation, sanitization, and data consistency checks
 */

// Validation result type
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  sanitized?: any;
}

// Validation rules
export interface ValidationRule {
  required?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'email';
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: RegExp;
  custom?: (value: any) => boolean | string;
}

export interface ValidationSchema {
  [key: string]: ValidationRule;
}

/**
 * Sanitize string input - prevent XSS
 */
export function sanitizeString(input: string): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
    .trim();
}

/**
 * Sanitize object recursively
 */
export function sanitizeObject(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  
  if (typeof obj === 'string') {
    return sanitizeString(obj);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }
  
  if (typeof obj === 'object') {
    const sanitized: any = {};
    for (const key of Object.keys(obj)) {
      sanitized[sanitizeString(key)] = sanitizeObject(obj[key]);
    }
    return sanitized;
  }
  
  return obj;
}

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate input against schema
 */
export function validateInput(data: any, schema: ValidationSchema): ValidationResult {
  const errors: string[] = [];
  const sanitized: any = {};

  for (const [field, rules] of Object.entries(schema)) {
    const value = data[field];

    // Required check
    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field} is required`);
      continue;
    }

    // Skip validation if not required and empty
    if (!rules.required && (value === undefined || value === null || value === '')) {
      continue;
    }

    // Type check
    if (rules.type) {
      let typeValid = false;
      switch (rules.type) {
        case 'string':
          typeValid = typeof value === 'string';
          break;
        case 'number':
          typeValid = typeof value === 'number' || !isNaN(Number(value));
          break;
        case 'boolean':
          typeValid = typeof value === 'boolean' || value === 'true' || value === 'false';
          break;
        case 'array':
          typeValid = Array.isArray(value);
          break;
        case 'object':
          typeValid = typeof value === 'object' && !Array.isArray(value);
          break;
        case 'email':
          typeValid = typeof value === 'string' && isValidEmail(value);
          break;
      }
      if (!typeValid) {
        errors.push(`${field} must be of type ${rules.type}`);
        continue;
      }
    }

    // String length checks
    if (typeof value === 'string') {
      if (rules.minLength && value.length < rules.minLength) {
        errors.push(`${field} must be at least ${rules.minLength} characters`);
      }
      if (rules.maxLength && value.length > rules.maxLength) {
        errors.push(`${field} must be at most ${rules.maxLength} characters`);
      }
    }

    // Number range checks
    if (typeof value === 'number' || !isNaN(Number(value))) {
      const numValue = Number(value);
      if (rules.min !== undefined && numValue < rules.min) {
        errors.push(`${field} must be at least ${rules.min}`);
      }
      if (rules.max !== undefined && numValue > rules.max) {
        errors.push(`${field} must be at most ${rules.max}`);
      }
    }

    // Pattern check
    if (rules.pattern && typeof value === 'string') {
      if (!rules.pattern.test(value)) {
        errors.push(`${field} has invalid format`);
      }
    }

    // Custom validation
    if (rules.custom) {
      const customResult = rules.custom(value);
      if (customResult !== true) {
        errors.push(typeof customResult === 'string' ? customResult : `${field} is invalid`);
      }
    }

    // Sanitize and add to result
    sanitized[field] = typeof value === 'string' ? sanitizeString(value) : value;
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitized
  };
}

/**
 * Pagination validation
 */
export function validatePagination(pageNum: any, pageSize: any): { pageNum: number; pageSize: number } {
  const validPageNum = Math.max(1, parseInt(pageNum) || 1);
  const validPageSize = Math.min(100, Math.max(1, parseInt(pageSize) || 10));
  return { pageNum: validPageNum, pageSize: validPageSize };
}

/**
 * ID validation - check for valid format
 */
export function isValidId(id: any): boolean {
  if (typeof id === 'number') return id > 0;
  if (typeof id === 'string') {
    // Allow alphanumeric IDs with dashes and underscores
    return /^[a-zA-Z0-9_-]+$/.test(id) && id.length > 0 && id.length <= 50;
  }
  return false;
}

/**
 * Validate and sanitize chat message
 */
export function validateChatMessage(message: string): ValidationResult {
  const errors: string[] = [];
  
  if (!message || typeof message !== 'string') {
    errors.push('Message is required');
    return { valid: false, errors };
  }
  
  const trimmed = message.trim();
  
  if (trimmed.length === 0) {
    errors.push('Message cannot be empty');
    return { valid: false, errors };
  }
  
  if (trimmed.length > 10000) {
    errors.push('Message is too long (max 10000 characters)');
    return { valid: false, errors };
  }
  
  return {
    valid: true,
    errors: [],
    sanitized: sanitizeString(trimmed)
  };
}

/**
 * Rate limit tracking (in-memory for simplicity)
 */
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

export function checkRateLimit(
  key: string, 
  maxRequests: number = 100, 
  windowMs: number = 60000
): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  const record = rateLimitStore.get(key);
  
  if (!record || now > record.resetTime) {
    rateLimitStore.set(key, { count: 1, resetTime: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, resetIn: windowMs };
  }
  
  if (record.count >= maxRequests) {
    return { 
      allowed: false, 
      remaining: 0, 
      resetIn: record.resetTime - now 
    };
  }
  
  record.count++;
  return { 
    allowed: true, 
    remaining: maxRequests - record.count, 
    resetIn: record.resetTime - now 
  };
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitStore.entries()) {
    if (now > record.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 60000);
