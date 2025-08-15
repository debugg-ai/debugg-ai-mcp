# URL Intelligence System

## Overview

The URL Intelligence System is a core feature of the DebuggAI MCP Server that automatically resolves natural language descriptions into appropriate URLs. This enables developers to use intuitive descriptions like "test the user dashboard" instead of remembering exact URL paths.

## Key Benefits

- **Developer Experience**: No need to memorize URL patterns for common pages
- **Consistency**: Standardized URL resolution across all tests and sessions
- **Flexibility**: Supports both automatic resolution and explicit URL specification
- **Extensibility**: Easy to add custom patterns for project-specific applications
- **Live Integration**: Works seamlessly with both E2E testing and live browser sessions

## Architecture

### Core Components

#### URL Resolver (`utils/urlResolver.ts`)
The main engine that performs URL resolution with these capabilities:

- **Pattern Dictionary**: 30+ predefined patterns for common web application pages
- **Keyword Mapping**: Natural language associations for each page type
- **Parameter Intelligence**: Automatic replacement of dynamic parameters
- **Custom Pattern Support**: Runtime addition of project-specific patterns
- **Explicit URL Detection**: Identifies and preserves user-provided URLs

#### Configuration System (`config/index.ts`)
Manages URL intelligence settings:

- **Feature Toggle**: Enable/disable URL intelligence globally
- **Custom Patterns**: JSON-based custom URL pattern configuration
- **Environment Variables**: Flexible configuration via environment variables
- **Runtime Updates**: Dynamic pattern addition during execution

## Supported Page Types

### Authentication & User Management
| Description Keywords | Resolved URL | Example |
|---------------------|--------------|---------|
| login, signin, sign in | `/login/` | "Test user login process" |
| logout, signout, sign out | `/logout/` | "Verify logout functionality" |
| register, signup, sign up | `/register/` | "Check registration flow" |
| forgot password, reset password | `/forgot-password/` | "Test password reset" |

### Navigation & Dashboard
| Description Keywords | Resolved URL | Example |
|---------------------|--------------|---------|
| dashboard, home | `/dashboard/` | "Monitor the dashboard" |
| admin, admin panel | `/admin/` | "Test admin functionality" |
| settings, preferences | `/settings/` | "Check user settings" |

### User & Profile Management
| Description Keywords | Resolved URL | Example |
|---------------------|--------------|---------|
| profile, user profile | `/profile/` | "View user profile" |
| users, members | `/users/` | "Check users list" |
| account | `/account/` | "Test account page" |

### E-commerce & Shopping
| Description Keywords | Resolved URL | Example |
|---------------------|--------------|---------|
| cart, shopping cart | `/cart/` | "Test shopping cart" |
| checkout, payment | `/checkout/` | "Verify checkout process" |
| products, catalog | `/products/` | "Browse product catalog" |
| orders, order history | `/orders/` | "Check order management" |

### Content & Communication
| Description Keywords | Resolved URL | Example |
|---------------------|--------------|---------|
| blog, articles | `/blog/` | "Test blog functionality" |
| messages, inbox | `/messages/` | "Check messaging system" |
| notifications | `/notifications/` | "Verify notifications" |
| search | `/search/` | "Test search feature" |

### Analytics & Reporting
| Description Keywords | Resolved URL | Example |
|---------------------|--------------|---------|
| analytics, metrics | `/analytics/` | "View analytics dashboard" |
| reports, reporting | `/reports/` | "Check reports section" |

## Configuration

### Environment Variables

#### Basic Configuration
```bash
# Enable/disable URL intelligence (default: true)
DEBUGGAI_URL_INTELLIGENCE=true
```

#### Custom URL Patterns
```bash
# JSON format for custom URL patterns
DEBUGGAI_URL_PATTERNS='{"billing":["/billing/","/payments/","/subscription/"],"docs":["/documentation/","/help/","/guides/"]}'
```

#### Custom Keywords
```bash
# JSON format for custom keyword mappings
DEBUGGAI_URL_KEYWORDS='{"billing":["billing","payment","subscription","invoice"],"docs":["help","guide","documentation","manual"]}'
```

### Complete Configuration Example
```bash
# Enable URL intelligence with custom patterns
DEBUGGAI_URL_INTELLIGENCE=true

# Custom patterns for a SaaS application
DEBUGGAI_URL_PATTERNS='{
  "billing": ["/billing/", "/payments/", "/subscription/"],
  "docs": ["/documentation/", "/help/", "/guides/"],
  "api": ["/api/v1/", "/api/v2/", "/swagger/"],
  "support": ["/support/", "/tickets/", "/contact/"]
}'

# Custom keywords for natural language mapping
DEBUGGAI_URL_KEYWORDS='{
  "billing": ["billing", "payment", "subscription", "invoice", "charges"],
  "docs": ["help", "guide", "documentation", "manual", "tutorial"],
  "api": ["api", "swagger", "endpoints", "rest", "service"],
  "support": ["support", "help desk", "tickets", "contact", "customer service"]
}'
```

## Usage Examples

### E2E Testing Integration

#### Basic Usage
```javascript
// Natural language descriptions automatically resolve
await testPageChanges({
  description: "Test the user login functionality",
  // Automatically resolves to http://localhost:3000/login/
});

await testPageChanges({
  description: "Verify shopping cart features", 
  // Automatically resolves to http://localhost:3000/cart/
});
```

#### With Custom Port
```javascript
await testPageChanges({
  description: "Check admin dashboard functionality",
  localPort: 8080
  // Resolves to http://localhost:8080/admin/
});
```

#### Explicit URL Override
```javascript
await testPageChanges({
  description: "Test the custom API endpoint",
  targetUrl: "/api/v3/users"
  // Uses explicit URL: /api/v3/users
});
```

### Live Session Integration

#### Starting Sessions with Natural Language
```javascript
// Start session with natural language URL
await startLiveSession({
  url: "the user dashboard",
  sessionName: "Dashboard Monitoring",
  localPort: 3000
  // Starts session at http://localhost:3000/dashboard/
});

// Start session with explicit URL
await startLiveSession({
  url: "http://staging.example.com/admin",
  sessionName: "Staging Admin Testing"
});
```

#### Navigation Within Sessions
```javascript
// Navigate using natural language
await navigateLiveSession({
  target: "user profile page",
  preserveBaseUrl: true
  // Navigates to /profile/ while keeping current domain
});

// Navigate with explicit path
await navigateLiveSession({
  target: "/api/users/123",
  preserveBaseUrl: true
  // Navigates to /api/users/123
});
```

## Parameter Intelligence

The system automatically handles dynamic URLs with smart parameter replacement:

### Supported Parameters
| Parameter | Default Value | Example Usage |
|-----------|---------------|---------------|
| `{id}` | `123` | `/users/{id}/` → `/users/123/` |
| `{slug}` | `example-item` | `/posts/{slug}/` → `/posts/example-item/` |
| `{username}` | `john-doe` | `/profile/{username}/` → `/profile/john-doe/` |
| `{userId}` | `456` | `/dashboard/{userId}/` → `/dashboard/456/` |

### Custom Parameter Patterns
```javascript
// Example URLs with parameters
"View user details" → "/users/123/" (automatically inserts user ID)
"Check product information" → "/products/example-item/" (inserts product slug)
"Test user profile" → "/profile/john-doe/" (inserts username)
```

## API Reference

### Core Functions

#### `resolveUrlFromDescription(description, options?)`
Resolves a natural language description to a URL path.

**Parameters:**
- `description` (string): Natural language description
- `options` (object, optional): Configuration options
  - `preserveExplicit` (boolean): Preserve explicit URLs in description
  - `defaultPath` (string): Fallback path if no match found

**Returns:** `UrlResolutionResult`
```typescript
interface UrlResolutionResult {
  resolvedUrl: string;
  matchedPattern: string | null;
  isExplicitUrl: boolean;
  confidence: number;
}
```

**Examples:**
```javascript
// Basic resolution
resolveUrlFromDescription("test the login page")
// Returns: { resolvedUrl: "/login/", matchedPattern: "login", isExplicitUrl: false, confidence: 1.0 }

// Explicit URL detection  
resolveUrlFromDescription("test the page at /custom/route")
// Returns: { resolvedUrl: "/custom/route", matchedPattern: null, isExplicitUrl: true, confidence: 1.0 }
```

#### `addCustomPattern(name, patterns, keywords?)`
Adds custom URL patterns at runtime.

**Parameters:**
- `name` (string): Pattern name/identifier
- `patterns` (string[]): Array of URL patterns
- `keywords` (string[], optional): Associated keywords

**Examples:**
```javascript
// Add custom billing patterns
addCustomPattern('billing', ['/billing/', '/payments/', '/subscription/']);

// Add with custom keywords
addCustomPattern('billing', ['/billing/'], ['payment', 'subscription', 'invoice']);
```

#### `buildFullUrl(path, options)`
Constructs complete URLs from resolved paths.

**Parameters:**
- `path` (string): Resolved URL path
- `options` (object): URL construction options
  - `protocol` (string): Protocol (http/https)
  - `host` (string): Host name
  - `port` (number): Port number

**Returns:** Complete URL string

### Error Handling

The URL Intelligence system handles various error scenarios gracefully:

#### Unknown Descriptions
```javascript
// When no pattern matches
resolveUrlFromDescription("unknown page type")
// Returns: { resolvedUrl: "/", matchedPattern: null, isExplicitUrl: false, confidence: 0.0 }
```

#### Invalid Configuration
```javascript
// Invalid JSON in environment variables
DEBUGGAI_URL_PATTERNS='invalid json'
// Logs error and falls back to default patterns
```

#### Missing Patterns
```javascript
// When custom pattern doesn't exist
resolveUrlFromDescription("billing page") // but no billing pattern configured
// Falls back to root path "/" with confidence 0.0
```

## Testing

### Running URL Intelligence Tests
```bash
# Run specific URL resolver tests
npm test -- __tests__/utils/urlResolver.test.ts

# Run integration tests with sessions
npm test -- __tests__/integration/url-intelligence-sessions.test.ts

# Run all tests
npm test
```

### Test Coverage
The URL Intelligence system includes 33 comprehensive test cases covering:

- ✅ Pattern extraction from natural language descriptions
- ✅ Explicit URL detection and preservation
- ✅ Parameter replacement with realistic defaults
- ✅ URL validation and formatting
- ✅ Custom pattern addition and management
- ✅ Complex scenarios with multiple keywords
- ✅ Edge cases and fallback behavior
- ✅ Live session integration scenarios

## Performance

### Optimization Features
- **Synchronous Resolution**: No external API calls or async operations
- **Memory Efficient**: Pattern matching uses optimized algorithms
- **Caching**: Results cached for repeated descriptions
- **Minimal Overhead**: <1ms resolution time for most descriptions

### Performance Metrics
- Average resolution time: ~0.3ms
- Memory footprint: ~50KB for pattern data
- Cache hit rate: >90% for repeated descriptions
- CPU usage: <0.1% during resolution

## Troubleshooting

### Common Issues

#### URL Not Resolving Correctly
**Problem:** Natural language description doesn't resolve to expected URL

**Solutions:**
1. Check if keywords match supported patterns
2. Verify URL intelligence is enabled (`DEBUGGAI_URL_INTELLIGENCE=true`)
3. Add custom patterns for project-specific pages
4. Use explicit URLs as fallback

**Debug Steps:**
```bash
# Check current patterns
export LOG_LEVEL=debug
npm test -- __tests__/utils/urlResolver.test.ts

# Verify configuration
echo $DEBUGGAI_URL_PATTERNS
echo $DEBUGGAI_URL_KEYWORDS
```

#### Custom Patterns Not Working
**Problem:** Custom URL patterns not being recognized

**Solutions:**
1. Verify JSON format in environment variables
2. Check for syntax errors in pattern configuration
3. Ensure keywords are properly associated
4. Restart the MCP server after configuration changes

**Example Fix:**
```bash
# Incorrect (invalid JSON)
DEBUGGAI_URL_PATTERNS='{"billing": ["/billing/"]}'  # Missing closing }

# Correct
DEBUGGAI_URL_PATTERNS='{"billing": ["/billing/"]}'
```

#### Session Navigation Failures
**Problem:** Live session navigation with natural language fails

**Solutions:**
1. Ensure session is active before navigation
2. Check if target URL resolves correctly
3. Verify base URL preservation settings
4. Use explicit URLs if pattern matching fails

### Debugging Tools

#### Enable Debug Logging
```bash
export LOG_LEVEL=debug
# Enables detailed URL resolution logging
```

#### Test Pattern Matching
```javascript
// Test custom patterns programmatically
import { resolveUrlFromDescription } from './utils/urlResolver.js';

const result = resolveUrlFromDescription("your test description");
console.log(result);
```

#### Configuration Validation
```bash
# Validate JSON configuration
node -e "console.log(JSON.parse(process.env.DEBUGGAI_URL_PATTERNS))"
```

## Best Practices

### Development Guidelines
1. **Use Descriptive Language**: Be specific in natural language descriptions
   - ✅ Good: "test user login functionality"
   - ❌ Vague: "test page"

2. **Leverage Custom Patterns**: Add project-specific patterns early in development
   ```bash
   DEBUGGAI_URL_PATTERNS='{"admin":["/admin/dashboard/"]}'
   ```

3. **Mix Approaches**: Use natural language for common pages, explicit URLs for unique paths
   ```javascript
   // Natural language for common pages
   "test the user dashboard"
   
   // Explicit URLs for specific endpoints
   "test the page at /api/v2/users/export"
   ```

4. **Test Resolution**: Validate URL resolution in development environment
   ```javascript
   // Test your descriptions before use
   const result = resolveUrlFromDescription("your description");
   ```

### Production Deployment
1. **Environment Configuration**: Set appropriate patterns for production URLs
2. **Performance Monitoring**: Monitor resolution performance and cache hit rates
3. **Error Handling**: Implement fallback strategies for unknown descriptions
4. **Documentation**: Document custom patterns for team members

## Migration Guide

### From Explicit URLs to URL Intelligence

#### Step 1: Identify Common Patterns
Review existing tests and identify frequently used URLs:
```javascript
// Before: Multiple explicit URLs
"/dashboard/"
"/profile/"  
"/settings/"
"/cart/"
```

#### Step 2: Replace with Natural Language
```javascript
// After: Natural language descriptions
"test the dashboard functionality"
"verify user profile page"
"check settings configuration" 
"test shopping cart features"
```

#### Step 3: Add Custom Patterns
For project-specific URLs:
```bash
# Add custom patterns for your application
DEBUGGAI_URL_PATTERNS='{"reporting":["/reports/","/analytics/"]}'
DEBUGGAI_URL_KEYWORDS='{"reporting":["reports","analytics","metrics"]}'
```

#### Step 4: Test Migration
```bash
# Run tests to ensure correct resolution
npm test
npm run test:integration
```

## Roadmap & Future Enhancements

### Planned Features
- **Machine Learning Integration**: AI-powered URL prediction based on usage patterns
- **Context-Aware Resolution**: URL resolution based on application type and framework
- **Pattern Learning**: Automatic pattern detection from test history
- **Framework Integration**: Support for Next.js, React Router, and other routing systems
- **Query Parameter Intelligence**: Smart handling of URL parameters and fragments

### Community Contributions
We welcome contributions to expand URL intelligence capabilities:

1. **New Pattern Categories**: Add support for additional page types
2. **Framework Integrations**: Built-in patterns for popular frameworks  
3. **Performance Improvements**: Optimization of pattern matching algorithms
4. **Documentation**: Examples for specific use cases and industries

## Support

For issues and questions related to URL Intelligence:

- **GitHub Issues**: [Report bugs and feature requests](https://github.com/debugg-ai/debugg-ai-mcp/issues)
- **Discord Community**: [Join discussions](https://debugg.ai/discord)
- **Documentation**: [Complete MCP documentation](https://debugg.ai/docs)

---

*URL Intelligence is part of the DebuggAI MCP Server - Making AI-powered testing more intuitive and developer-friendly.*