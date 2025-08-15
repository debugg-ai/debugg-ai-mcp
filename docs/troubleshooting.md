# Troubleshooting Guide

## Overview

This comprehensive troubleshooting guide covers common issues with the DebuggAI MCP Server, including URL intelligence, MCP parameter injection, live sessions, and E2E testing functionality.

## Quick Diagnostics

### Health Check Commands
```bash
# Check server status
npm test

# Verify build and TypeScript compilation
npm run build

# Check configuration
node -e "console.log(require('./dist/config/index.js'))"

# Test URL resolution
npm test -- __tests__/utils/urlResolver.test.ts

# Test MCP parameter injection
npm test -- __tests__/utils/axiosTransport.test.ts
```

### Environment Validation
```bash
# Check required environment variables
echo $DEBUGGAI_API_KEY
echo $DEBUGGAI_LOCAL_PORT
echo $DEBUGGAI_URL_INTELLIGENCE

# Validate URL intelligence configuration
node -e "
try {
  const patterns = JSON.parse(process.env.DEBUGGAI_URL_PATTERNS || '{}');
  console.log('URL Patterns:', patterns);
} catch(e) {
  console.error('Invalid URL patterns JSON:', e.message);
}
"
```

## URL Intelligence Issues

### Issue: URL Not Resolving Correctly

#### Symptoms
- Natural language descriptions resolve to "/" instead of expected URL
- Error messages about unknown page types
- URLs resolving to incorrect paths

#### Common Causes & Solutions

##### 1. URL Intelligence Disabled
```bash
# Check if URL intelligence is enabled
echo $DEBUGGAI_URL_INTELLIGENCE

# Solution: Enable URL intelligence
export DEBUGGAI_URL_INTELLIGENCE=true
```

##### 2. Keywords Don't Match Patterns
```javascript
// Problem: Description doesn't match known patterns
"Test the billing section" // No billing pattern exists

// Solution: Add custom patterns
export DEBUGGAI_URL_PATTERNS='{"billing":["/billing/","/payments/"]}'
export DEBUGGAI_URL_KEYWORDS='{"billing":["billing","payment","subscription"]}'
```

##### 3. Invalid JSON Configuration
```bash
# Problem: Syntax error in JSON
export DEBUGGAI_URL_PATTERNS='{"billing": ["/billing/"]}'  # Missing closing brace

# Solution: Fix JSON syntax  
export DEBUGGAI_URL_PATTERNS='{"billing":["/billing/"]}'
```

##### 4. Case Sensitivity Issues
```javascript
// Problem: Case mismatch
"Test the Dashboard" vs "dashboard" keyword

// Solution: URL intelligence is case-insensitive, but verify keyword lists
// Add variations if needed
export DEBUGGAI_URL_KEYWORDS='{"dashboard":["dashboard","Dashboard","DASHBOARD"]}'
```

#### Debugging Steps
```bash
# 1. Enable debug logging
export LOG_LEVEL=debug

# 2. Test URL resolution directly  
node -e "
const { resolveUrlFromDescription } = require('./dist/utils/urlResolver.js');
const result = resolveUrlFromDescription('your test description');
console.log(JSON.stringify(result, null, 2));
"

# 3. Check pattern loading
npm test -- __tests__/utils/urlResolver.test.ts --verbose

# 4. Verify configuration parsing
node -e "
const config = require('./dist/config/index.js');
console.log('URL patterns:', config.urlPatterns);
"
```

### Issue: Custom Patterns Not Working

#### Symptoms
- Custom URL patterns not being recognized
- Descriptions still resolving to default patterns
- Configuration appears correct but not taking effect

#### Solutions

##### 1. Restart Required
```bash
# Problem: Configuration changes not loaded
# Solution: Restart the MCP server after configuration changes
pkill -f "debugg-ai-mcp"
npm start
```

##### 2. JSON Format Issues
```bash
# Problem: Invalid JSON structure
# Check JSON validity
node -e "JSON.parse(process.env.DEBUGGAI_URL_PATTERNS)"

# Solution: Use proper JSON format
export DEBUGGAI_URL_PATTERNS='{"custom":["/custom-page/","/special/"]}'
```

##### 3. Environment Variable Issues
```bash
# Problem: Environment variables not exported
# Solution: Ensure proper export
export DEBUGGAI_URL_PATTERNS='{"billing":["/billing/"]}'

# Verify it's set
env | grep DEBUGGAI_URL_PATTERNS
```

## MCP Parameter Injection Issues

### Issue: Backend Not Receiving MCP Parameters

#### Symptoms
- Backend doesn't detect MCP requests
- `mcp_request` parameter missing from requests
- Rate limiting or MCP-specific features not working

#### Common Causes & Solutions

##### 1. Backend Checking Wrong Location
```python
# Problem: Only checking one location
mcp_param = request.GET.get('mcp_request')  # Only checks query params

# Solution: Check both locations
mcp_param = (
    request.GET.get('mcp_request') or 
    request.POST.get('mcp_request') or
    getattr(request, 'data', {}).get('mcp_request')
)
```

##### 2. Request Bypassing Transport Layer
```typescript
// Problem: Using direct HTTP client instead of service
import axios from 'axios';
axios.post('/api/tests', testData); // No MCP parameter

// Solution: Use service layer
const e2eService = new E2esService(transport);
e2eService.createTest(testData); // Automatic MCP parameter
```

##### 3. Parameter Type Validation
```python
# Problem: Backend expecting string, getting boolean
if request.GET.get('mcp_request') == 'true':  # String comparison

# Solution: Handle both string and boolean
mcp_param = request.GET.get('mcp_request')
is_mcp = str(mcp_param).lower() == 'true' if mcp_param else False
```

#### Debugging Steps
```bash
# 1. Verify parameter injection in tests
npm test -- __tests__/utils/axiosTransport.test.ts

# 2. Enable request logging
export LOG_LEVEL=debug
npm test -- __tests__/integration/

# 3. Check network requests (if available)
# Look for mcp_request parameter in requests

# 4. Test with simple request
node -e "
const { AxiosTransport } = require('./dist/utils/axiosTransport.js');
const transport = new AxiosTransport({
  baseURL: 'https://httpbin.org',
  apiKey: 'test'
});
transport.get('/get').then(response => {
  console.log('Query params:', response.data.args);
}).catch(console.error);
"
```

## Live Session Issues

### Issue: Session Won't Start

#### Symptoms
- "Failed to start session" errors
- Session status stuck in "pending"  
- Timeout errors when starting sessions

#### Common Causes & Solutions

##### 1. API Key Issues
```bash
# Problem: Invalid or missing API key
export DEBUGGAI_API_KEY=""

# Solution: Set valid API key
export DEBUGGAI_API_KEY="your_actual_api_key"

# Verify API key format
echo $DEBUGGAI_API_KEY | wc -c  # Should be reasonable length
```

##### 2. Network Connectivity
```bash
# Problem: Cannot reach DebuggAI API
# Solution: Test network connectivity
curl -H "Authorization: Bearer $DEBUGGAI_API_KEY" \
     "https://api.debugg.ai/health"

# Check proxy/firewall settings if needed
```

##### 3. Invalid URL Format
```javascript
// Problem: Malformed URL
await startLiveSession({
  url: "invalid-url-format",
  sessionName: "Test"
});

// Solution: Use proper URL format
await startLiveSession({
  url: "http://localhost:3000/dashboard",
  sessionName: "Test"
});

// Or use natural language with URL intelligence
await startLiveSession({
  url: "the dashboard page",
  localPort: 3000,
  sessionName: "Test"
});
```

##### 4. Port/Service Unavailable
```bash
# Problem: Target application not running
# Solution: Start your application
npm start  # or appropriate command for your app

# Verify port is accessible
curl http://localhost:3000  # Replace with your port
```

#### Debugging Steps
```bash
# 1. Test session creation manually
npm test -- __tests__/integration/browser-sessions.integration.test.ts

# 2. Check API connectivity
node -e "
const { BrowserSessionsService } = require('./dist/services/browserSessions.js');
const { AxiosTransport } = require('./dist/utils/axiosTransport.js');
const config = require('./dist/config/index.js');

const transport = new AxiosTransport(config.api);
const service = new BrowserSessionsService(transport);

service.startSession({
  url: 'http://localhost:3000',
  session_name: 'Debug Test'
}).then(response => {
  console.log('Session started:', response);
}).catch(error => {
  console.error('Session failed:', error.message);
});
"

# 3. Enable debug logging
export LOG_LEVEL=debug
```

### Issue: Natural Language Navigation Not Working

#### Symptoms
- Navigation commands fail in live sessions
- URLs not resolving correctly during navigation
- "Session not found" errors during navigation

#### Solutions

##### 1. Session Must Be Active
```javascript
// Problem: Navigating inactive session
await navigateSession({ target: "user profile" }); // No active session

// Solution: Start session first
await startLiveSession({ url: "dashboard", localPort: 3000 });
await navigateSession({ target: "user profile" });
```

##### 2. URL Resolution Issues
```javascript
// Problem: URL not resolving
await navigateSession({ target: "unknown page type" });

// Solution: Use explicit URL or add custom pattern
await navigateSession({ target: "/custom/route" });
```

##### 3. Base URL Preservation
```javascript
// Problem: Navigation breaking current domain
await navigateSession({
  target: "user profile",
  preserveBaseUrl: false  // Loses current domain
});

// Solution: Preserve base URL
await navigateSession({
  target: "user profile", 
  preserveBaseUrl: true   // Keeps current domain
});
```

## E2E Testing Issues

### Issue: Tests Failing to Execute

#### Symptoms
- Tests timeout before completion
- "Test creation failed" errors
- Empty or incomplete test results

#### Common Causes & Solutions

##### 1. Target Application Issues
```bash
# Problem: Application not accessible
# Solution: Verify application is running and accessible
curl http://localhost:3000  # Test connectivity
curl http://localhost:3000/login  # Test specific pages
```

##### 2. Test Description Issues
```javascript
// Problem: Vague test description
await testPageChanges({
  description: "test stuff"
});

// Solution: Specific, actionable descriptions
await testPageChanges({
  description: "Test user login with valid credentials and verify dashboard loads"
});
```

##### 3. URL Intelligence Issues
```javascript
// Problem: URL not resolving correctly
await testPageChanges({
  description: "test the billing page"  // No billing pattern
});

// Solution: Add custom pattern or use explicit URL
export DEBUGGAI_URL_PATTERNS='{"billing":["/billing/"]}'
// OR
await testPageChanges({
  description: "test the billing functionality",
  targetUrl: "/billing/"
});
```

##### 4. API Rate Limiting
```bash
# Problem: Too many requests too quickly
# Solution: Add delays between tests or check rate limits
# Monitor API response for rate limit headers
```

#### Debugging Steps
```bash
# 1. Test individual components
npm test -- __tests__/handlers/testPageChangesHandler.test.ts

# 2. Run integration tests
npm run test:integration

# 3. Test URL resolution for your description
node -e "
const { resolveUrlFromDescription } = require('./dist/utils/urlResolver.js');
console.log(resolveUrlFromDescription('your test description'));
"

# 4. Manual API test
node -e "
const { E2esService } = require('./dist/services/e2es.js');
const { AxiosTransport } = require('./dist/utils/axiosTransport.js');
const config = require('./dist/config/index.js');

const transport = new AxiosTransport(config.api);
const service = new E2esService(transport);

service.createTest({
  description: 'Test login functionality',
  target_url: 'http://localhost:3000/login'
}).then(console.log).catch(console.error);
"
```

## Configuration Issues

### Issue: Environment Variables Not Loading

#### Symptoms
- Default values being used instead of configured values
- "Configuration validation failed" errors
- Features not working as configured

#### Solutions

##### 1. Variable Export Issues
```bash
# Problem: Variables not exported in current shell
DEBUGGAI_API_KEY=your_key  # Not exported

# Solution: Export variables
export DEBUGGAI_API_KEY=your_key

# Verify export
env | grep DEBUGGAI
```

##### 2. Variable Scope Issues
```bash
# Problem: Variables only set in one terminal
# Solution: Add to shell profile
echo 'export DEBUGGAI_API_KEY=your_key' >> ~/.bashrc
source ~/.bashrc
```

##### 3. JSON Configuration Issues
```bash
# Problem: Invalid JSON in environment variables
export DEBUGGAI_URL_PATTERNS='{billing: ["/billing/"]}'  # Invalid JSON

# Solution: Valid JSON format
export DEBUGGAI_URL_PATTERNS='{"billing":["/billing/"]}'

# Validate JSON
echo $DEBUGGAI_URL_PATTERNS | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')))"
```

#### Debugging Steps
```bash
# 1. Check all environment variables
env | grep DEBUGGAI

# 2. Test configuration loading
node -e "
const config = require('./dist/config/index.js');
console.log(JSON.stringify(config, null, 2));
"

# 3. Validate configuration schema
npm test -- __tests__/config/config.test.ts
```

## Performance Issues

### Issue: Slow Response Times

#### Symptoms
- Long delays in test execution
- Timeouts during API calls
- High memory or CPU usage

#### Common Causes & Solutions

##### 1. Network Latency
```bash
# Problem: Slow network to API
# Solution: Check network connectivity
ping api.debugg.ai
curl -w "%{time_total}" https://api.debugg.ai/health

# Consider using closer API endpoint if available
```

##### 2. Large Test Descriptions
```javascript
// Problem: Overly complex test descriptions
await testPageChanges({
  description: "Test every single feature on the page including..." // Very long
});

// Solution: Break into smaller, focused tests
await testPageChanges({
  description: "Test user login with valid credentials"
});
```

##### 3. Resource Constraints
```bash
# Problem: Insufficient system resources
# Solution: Monitor resource usage
top -p $(pgrep node)
free -h
df -h

# Increase available resources if needed
```

##### 4. Debug Logging Overhead
```bash
# Problem: Debug logging slowing performance
export LOG_LEVEL=debug  # Can slow performance

# Solution: Use appropriate log level for production
export LOG_LEVEL=info
```

#### Performance Optimization
```bash
# 1. Enable request caching (automatic in transport layer)
# 2. Use appropriate batch sizes for multiple tests
# 3. Monitor memory usage during long test runs
# 4. Consider implementing request queuing for high-volume scenarios
```

## Build and Deployment Issues

### Issue: TypeScript Compilation Errors

#### Symptoms
- Build fails with TypeScript errors
- Type checking failures
- Module resolution issues

#### Solutions

##### 1. Update Dependencies
```bash
# Problem: Outdated dependencies
# Solution: Update packages
npm update
npm audit fix
```

##### 2. Type Definition Issues
```bash
# Problem: Missing type definitions
# Solution: Install missing types
npm install --save-dev @types/node @types/jest
```

##### 3. Module Resolution Issues
```typescript
// Problem: Incorrect import paths
import { utils } from './utils';  // Missing .js extension

// Solution: Use proper ESM imports
import { utils } from './utils/index.js';
```

#### Debugging Steps
```bash
# 1. Clean build
rm -rf dist node_modules package-lock.json
npm install
npm run build

# 2. Check TypeScript configuration
npx tsc --noEmit --listFiles

# 3. Verify module resolution
node --experimental-modules -e "console.log(require.resolve('./dist/index.js'))"
```

## Docker Issues

### Issue: Docker Container Not Starting

#### Symptoms
- Container exits immediately
- Environment variables not passed correctly
- Port binding issues

#### Solutions

##### 1. Environment Variable Issues
```bash
# Problem: Environment variables not passed to container
docker run quinnosha/debugg-ai-mcp

# Solution: Pass environment variables
docker run -e DEBUGGAI_API_KEY=your_key quinnosha/debugg-ai-mcp
```

##### 2. Port Binding Issues
```bash
# Problem: Port conflicts
docker run -p 3000:3000 quinnosha/debugg-ai-mcp

# Solution: Use different host port
docker run -p 8080:3000 quinnosha/debugg-ai-mcp
```

##### 3. Volume Mounting Issues
```bash
# Problem: Configuration files not accessible
# Solution: Mount configuration directory
docker run -v $(pwd)/config:/app/config quinnosha/debugg-ai-mcp
```

## Getting Additional Help

### Debug Information Collection
When reporting issues, include this debug information:

```bash
# System information
node --version
npm --version
echo $DEBUGGAI_API_KEY | cut -c1-10  # First 10 chars only
env | grep DEBUGGAI

# Configuration
npm run build
node -e "
const config = require('./dist/config/index.js');
console.log('Config loaded:', !!config);
console.log('URL intelligence enabled:', config.urlPatterns?.enabled);
"

# Test results
npm test 2>&1 | head -50
```

### Support Channels

#### GitHub Issues
For bug reports and feature requests:
- **URL**: https://github.com/debugg-ai/debugg-ai-mcp/issues
- **Template**: Use issue template for consistent reporting
- **Include**: Debug information, error messages, steps to reproduce

#### Discord Community
For community support and discussions:
- **URL**: https://debugg.ai/discord  
- **Best for**: Configuration help, usage questions, community solutions

#### Documentation
Complete documentation and guides:
- **URL**: https://debugg.ai/docs
- **Includes**: Setup guides, API reference, examples

### Escalation Path

#### For Critical Issues
1. **Check existing issues** on GitHub
2. **Try troubleshooting steps** in this guide
3. **Collect debug information** using commands above
4. **Create GitHub issue** with complete information
5. **Join Discord** for real-time community support

#### For Feature Requests
1. **Check roadmap** in project documentation
2. **Search existing issues** for similar requests
3. **Create feature request** with clear use case and benefits
4. **Engage with community** for feedback and discussion

---

*This troubleshooting guide is continuously updated based on user feedback and common issues. Please contribute improvements and additional scenarios as you encounter them.*