# URL Intelligence for Live Browser Sessions

## Overview

The URL Intelligence system has been integrated with live browser sessions, allowing you to start and navigate sessions using natural language descriptions instead of explicit URLs. This makes it easier to monitor and test your applications without remembering exact URL paths.

## Features

### 1. Natural Language Session Start

Start a live browser session using descriptions like:
- "Monitor the user dashboard"
- "Watch the shopping cart page"
- "Track the checkout process"

The system automatically resolves these to appropriate URLs like `/dashboard/`, `/cart/`, or `/checkout/`.

### 2. Intelligent Navigation

Navigate within active sessions using natural language:
- "Go to the user profile"
- "Navigate to settings"
- "Open the product catalog"

### 3. Backward Compatibility

- Explicit URLs still work as before
- Mix natural language and explicit paths as needed
- Full URL support (http://example.com/path)

## Usage Examples

### Starting a Session with Natural Language

```javascript
// Instead of this:
await startLiveSession({
  url: "http://localhost:3000/dashboard/",
  sessionName: "Dashboard Testing"
});

// You can now use:
await startLiveSession({
  url: "the user dashboard",
  localPort: 3000,
  sessionName: "Dashboard Testing"
});
```

### Navigating with Natural Language

```javascript
// Navigate to user profile
await navigateLiveSession({
  target: "user profile page",
  preserveBaseUrl: true  // Keeps the current domain
});

// Navigate to checkout
await navigateLiveSession({
  target: "checkout process",
  preserveBaseUrl: true
});
```

### Mixed Usage

```javascript
// Start with natural language
await startLiveSession({
  url: "admin dashboard",
  localPort: 8080
});

// Navigate with explicit path
await navigateLiveSession({
  target: "/api/users/123",
  preserveBaseUrl: true
});

// Navigate with natural language again
await navigateLiveSession({
  target: "user settings",
  preserveBaseUrl: true
});
```

## Supported Page Types

The URL Intelligence system recognizes common page types:

### Authentication
- login, signin → `/login/`
- logout, signout → `/logout/`
- register, signup → `/register/`
- forgot password → `/forgot-password/`

### User Areas
- profile, user profile → `/profile/`
- settings, preferences → `/settings/`
- users, members → `/users/`

### Navigation
- dashboard, home → `/dashboard/`
- admin, admin panel → `/admin/`

### E-commerce
- cart, shopping cart → `/cart/`
- checkout, payment → `/checkout/`
- products, catalog → `/products/`
- orders, order history → `/orders/`

### Content
- blog, articles → `/blog/`
- messages, inbox → `/messages/`
- notifications → `/notifications/`

### Analytics & Data
- analytics, metrics → `/analytics/`
- reports, reporting → `/reports/`

## Configuration

### Local Port Handling

When starting a session with natural language:

1. **With explicit port**: Uses the specified port
   ```javascript
   url: "dashboard", localPort: 8080 → http://localhost:8080/dashboard/
   ```

2. **Without port**: Defaults to port 3000
   ```javascript
   url: "dashboard" → http://localhost:3000/dashboard/
   ```

3. **With full URL**: Ignores port parameter
   ```javascript
   url: "http://example.com/dashboard" → http://example.com/dashboard
   ```

### Base URL Preservation

When navigating within a session:

1. **preserveBaseUrl: true** (default): Keeps current domain
   ```javascript
   Current: http://localhost:3000/dashboard/
   Navigate to: "user profile"
   Result: http://localhost:3000/profile/
   ```

2. **preserveBaseUrl: false**: Uses resolved path only
   ```javascript
   Navigate to: "user profile"
   Result: /profile/
   ```

## Response Format

### Session Start Response

```json
{
  "success": true,
  "session": {
    "sessionId": "session-123",
    "url": "http://localhost:3000/dashboard/",
    "status": "active"
  },
  "urlResolution": {
    "originalInput": "the dashboard",
    "resolvedUrl": "http://localhost:3000/dashboard/",
    "note": "(resolved from \"the dashboard\" to path \"/dashboard/\")"
  }
}
```

### Navigation Response

```json
{
  "success": true,
  "session": {
    "sessionId": "session-123",
    "previousUrl": "http://localhost:3000/dashboard/",
    "currentUrl": "http://localhost:3000/profile/"
  },
  "urlResolution": {
    "originalInput": "user profile",
    "resolvedUrl": "http://localhost:3000/profile/",
    "note": "(resolved from \"user profile\" to path \"/profile/\", using base http://localhost:3000)"
  }
}
```

## Best Practices

1. **Be descriptive**: Use clear descriptions like "user dashboard" instead of just "dashboard"
2. **Use explicit paths for APIs**: For API endpoints, use explicit paths like "/api/users"
3. **Leverage base URL preservation**: Keep `preserveBaseUrl: true` for navigating within the same app
4. **Mix approaches**: Use natural language for common pages, explicit URLs for custom paths

## Error Handling

The system handles various error cases:

- **No active session**: When navigating without an active session
- **Session not active**: When trying to navigate a stopped session
- **Unknown page type**: Falls back to root path "/" when description doesn't match
- **Invalid URL**: Validation ensures proper URL format

## Testing

The URL Intelligence integration includes comprehensive tests:

```bash
# Run integration tests
npm test -- __tests__/integration/url-intelligence-sessions.test.ts

# Run all URL resolver tests
npm test -- __tests__/utils/urlResolver.test.ts
```

## Extending the System

### Adding Custom Page Types

You can extend the URL patterns at runtime:

```javascript
import { addCustomPattern, addCustomKeywords } from './utils/urlResolver.js';

// Add custom URL pattern
addCustomPattern('billing', ['/billing/', '/payments/', '/subscription/']);

// Add custom keywords
addCustomKeywords('billing', ['billing page', 'payment info', 'subscription']);
```

## Migration Guide

Existing code continues to work without changes. To adopt URL Intelligence:

1. **Identify common navigation patterns** in your tests
2. **Replace explicit URLs** with natural language where it makes sense
3. **Keep explicit URLs** for custom or dynamic paths
4. **Test thoroughly** to ensure correct resolution

## Troubleshooting

### URL not resolving correctly

1. Check if the description matches known keywords
2. Verify the page type is supported
3. Use explicit URLs as fallback

### Session navigation fails

1. Ensure session is active
2. Check if target URL is valid
3. Verify base URL preservation settings

### Performance considerations

- URL resolution is synchronous and fast
- No external API calls for resolution
- Minimal overhead added to session operations