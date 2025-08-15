# Developer Setup Guide

## Overview

This comprehensive guide will help you set up a complete development environment for the DebuggAI MCP Server, including all new features like URL intelligence, MCP parameter injection, and comprehensive testing capabilities.

## Prerequisites

### System Requirements
- **Node.js**: Version 18.0.0 or higher
- **npm**: Version 8.0.0 or higher  
- **TypeScript**: Version 4.9.0 or higher
- **Git**: Version 2.0.0 or higher

### API Access
- **DebuggAI Account**: Sign up at [debugg.ai](https://debugg.ai)
- **API Key**: Generate from your dashboard

## Quick Start

### 1. Clone and Install
```bash
# Clone the repository
git clone https://github.com/debugg-ai/debugg-ai-mcp.git
cd debugg-ai-mcp

# Install dependencies
npm install

# Build the project
npm run build

# Verify installation
npm test
```

### 2. Environment Configuration
```bash
# Copy example configuration
cp test-config-example.json test-config.json

# Set required environment variables
export DEBUGGAI_API_KEY="your_api_key_here"
export DEBUGGAI_LOCAL_PORT=3000
export LOG_LEVEL=debug

# Optional: URL Intelligence configuration
export DEBUGGAI_URL_INTELLIGENCE=true
export DEBUGGAI_URL_PATTERNS='{"custom":["/custom-page/"]}'
export DEBUGGAI_URL_KEYWORDS='{"custom":["custom page","special"]}'
```

### 3. Verify Setup
```bash
# Run all tests
npm test

# Run integration tests
npm run test:integration

# Start in development mode
npm run watch
```

## Development Environment Setup

### IDE Configuration

#### Visual Studio Code
Install recommended extensions:
```json
{
  "recommendations": [
    "ms-vscode.vscode-typescript-next",
    "bradlc.vscode-tailwindcss",
    "esbenp.prettier-vscode",
    "ms-vscode.vscode-json",
    "redhat.vscode-yaml"
  ]
}
```

#### VS Code Settings
```json
{
  "typescript.preferences.includePackageJsonAutoImports": "auto",
  "typescript.suggest.autoImports": true,
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "typescript.preferences.importModuleSpecifier": "relative"
}
```

### TypeScript Configuration
The project uses strict TypeScript settings. Key configurations:

```json
{
  "compilerOptions": {
    "strict": true,
    "module": "Node16",
    "moduleResolution": "Node16", 
    "target": "ES2022",
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true
  }
}
```

### Environment Variables

#### Development Configuration
Create a `.env` file in the project root:
```bash
# Core Configuration
DEBUGGAI_API_KEY=your_development_api_key
DEBUGGAI_LOCAL_PORT=3000
DEBUGGAI_LOCAL_REPO_NAME=your-org/your-repo
DEBUGGAI_LOCAL_REPO_PATH=/path/to/your/project

# Logging
LOG_LEVEL=debug

# URL Intelligence
DEBUGGAI_URL_INTELLIGENCE=true
DEBUGGAI_URL_PATTERNS='{
  "admin": ["/admin/", "/admin/dashboard/"],
  "billing": ["/billing/", "/payments/", "/subscription/"],
  "docs": ["/documentation/", "/help/", "/guides/"],
  "api": ["/api/v1/", "/api/v2/", "/swagger/"]
}'
DEBUGGAI_URL_KEYWORDS='{
  "admin": ["admin", "dashboard", "management", "admin panel"],
  "billing": ["billing", "payment", "subscription", "invoice"],
  "docs": ["help", "documentation", "guide", "manual"],
  "api": ["api", "swagger", "endpoint", "rest"]
}'
```

#### Load Environment Variables
```bash
# Option 1: Source from file
source .env

# Option 2: Use dotenv (install first)
npm install --save-dev dotenv
node -r dotenv/config your_script.js

# Option 3: Export manually
export $(cat .env | xargs)
```

## Feature Development

### URL Intelligence Development

#### Adding New URL Patterns
```typescript
// 1. Add pattern to urlResolver.ts
const URL_PATTERNS = {
  // Existing patterns...
  newCategory: ['/new-page/', '/alternative-path/']
};

const URL_KEYWORDS = {
  // Existing keywords...
  newCategory: ['new page', 'alternative', 'custom section']
};

// 2. Write tests
describe('New URL Pattern', () => {
  test('should resolve new category descriptions', () => {
    const result = resolveUrlFromDescription('test new page functionality');
    expect(result.resolvedUrl).toBe('/new-page/');
    expect(result.matchedPattern).toBe('newCategory');
  });
});

// 3. Update documentation
// Add to docs/url-intelligence.md
```

#### Testing URL Patterns
```bash
# Test specific patterns
npm test -- __tests__/utils/urlResolver.test.ts

# Test with specific description
node -e "
const { resolveUrlFromDescription } = require('./dist/utils/urlResolver.js');
console.log(resolveUrlFromDescription('your test description'));
"

# Run with debug logging
LOG_LEVEL=debug npm test -- __tests__/utils/urlResolver.test.ts
```

### MCP Parameter Development

#### Adding New Parameters
```typescript
// In utils/axiosTransport.ts
axios.interceptors.request.use((config) => {
  // Existing MCP parameter injection...
  
  // Add new MCP-specific parameters
  const mcpParams = {
    mcp_request: true,
    mcp_version: '1.0.0',        // New parameter
    mcp_client: 'debugg-ai-mcp'  // New parameter
  };

  if (method === "GET" || method === "DELETE") {
    config.params = { ...config.params, ...mcpParams };
  } else {
    config.data = { ...config.data, ...mcpParams };
  }
  
  return config;
});
```

#### Testing Parameter Injection
```bash
# Test parameter injection
npm test -- __tests__/utils/axiosTransport.test.ts

# Test with real request
node -e "
const { AxiosTransport } = require('./dist/utils/axiosTransport.js');
const transport = new AxiosTransport({
  baseURL: 'https://httpbin.org',
  apiKey: 'test'
});
transport.get('/get').then(r => console.log(r.data.args));
"
```

### Service Development

#### Adding New Service Methods
```typescript
// Example: Adding new E2E service method
export class E2esService {
  // Existing methods...
  
  async createAdvancedTest(testData: AdvancedTestInput): Promise<AdvancedTestResponse> {
    const response = await this.transport.post<AdvancedTestResponse>(
      '/api/advanced-tests',
      testData
    );
    return response.data;
  }
}

// Add corresponding types
export interface AdvancedTestInput {
  description: string;
  targetUrl?: string;
  browser?: string;
  viewport?: { width: number; height: number };
}

export interface AdvancedTestResponse {
  testId: string;
  status: 'created' | 'running' | 'completed';
  result?: TestResult;
}
```

#### Service Testing
```typescript
// Unit test with mocks
import { E2esService } from '../services/e2es.js';
import { MockAxiosTransport } from './mocks/transportMock.js';

describe('E2esService', () => {
  let service: E2esService;
  let mockTransport: MockAxiosTransport;

  beforeEach(() => {
    mockTransport = new MockAxiosTransport();
    service = new E2esService(mockTransport);
  });

  test('should create advanced test', async () => {
    mockTransport.post.mockResolvedValue({
      data: { testId: '123', status: 'created' }
    });

    const result = await service.createAdvancedTest({
      description: 'Advanced test',
      browser: 'chrome'
    });

    expect(result.testId).toBe('123');
  });
});
```

## Testing Framework

### Test Structure
```
__tests__/
├── config/              # Configuration tests
├── handlers/            # Handler unit tests
├── services/           # Service unit tests
├── utils/              # Utility function tests
├── integration/        # API integration tests
├── mocks/              # Test mocks and fixtures
└── setup.ts            # Jest setup configuration
```

### Running Tests

#### Unit Tests
```bash
# Run all unit tests
npm test

# Run specific test file
npm test -- __tests__/utils/urlResolver.test.ts

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

#### Integration Tests
```bash
# Run all integration tests (requires API key)
npm run test:integration

# Run specific integration test
npm test -- __tests__/integration/url-intelligence-sessions.test.ts

# Run integration tests in watch mode
npm run test:integration:watch
```

#### Test Configuration
```javascript
// jest.config.js - Unit tests
export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['**/__tests__/integration/**'],
  coveragePathIgnorePatterns: ['**/__tests__/**', '**/node_modules/**']
};

// jest.integration.config.js - Integration tests
export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  testMatch: ['**/__tests__/integration/**/*.test.ts'],
  testTimeout: 90000  // Longer timeout for API calls
};
```

### Writing Tests

#### URL Intelligence Tests
```typescript
import { resolveUrlFromDescription, addCustomPattern } from '../utils/urlResolver.js';

describe('URL Intelligence', () => {
  test('should resolve dashboard descriptions', () => {
    const result = resolveUrlFromDescription('test the dashboard page');
    expect(result.resolvedUrl).toBe('/dashboard/');
    expect(result.matchedPattern).toBe('dashboard');
    expect(result.confidence).toBe(1.0);
  });

  test('should handle custom patterns', () => {
    addCustomPattern('billing', ['/billing/', '/payments/']);
    const result = resolveUrlFromDescription('check billing page');
    expect(result.resolvedUrl).toBe('/billing/');
  });

  test('should preserve explicit URLs', () => {
    const result = resolveUrlFromDescription('test the page at /custom/route');
    expect(result.resolvedUrl).toBe('/custom/route');
    expect(result.isExplicitUrl).toBe(true);
  });
});
```

#### Service Integration Tests
```typescript
import { E2esService } from '../services/e2es.js';
import { AxiosTransport } from '../utils/axiosTransport.js';
import config from '../config/index.js';

describe('E2E Service Integration', () => {
  let service: E2esService;

  beforeAll(() => {
    const transport = new AxiosTransport(config.api);
    service = new E2esService(transport);
  });

  test('should create and run test', async () => {
    const testData = {
      description: 'Test login functionality',
      targetUrl: 'http://localhost:3000/login'
    };

    const test = await service.createTest(testData);
    expect(test.testId).toBeDefined();

    const result = await service.runTest({ testId: test.testId });
    expect(result.status).toBe('running');
  }, 30000);
});
```

## Debugging and Development Tools

### Debug Logging
```bash
# Enable debug logging
export LOG_LEVEL=debug

# View logs in real-time
npm run watch | grep "DEBUG"

# Log specific components
LOG_LEVEL=debug npm test -- --verbose
```

### Development Scripts
```json
{
  "scripts": {
    "dev": "LOG_LEVEL=debug npm run watch",
    "test:debug": "LOG_LEVEL=debug npm test -- --verbose",
    "test:url": "npm test -- __tests__/utils/urlResolver.test.ts",
    "test:transport": "npm test -- __tests__/utils/axiosTransport.test.ts",
    "build:watch": "tsc --watch",
    "lint": "eslint src/**/*.ts",
    "format": "prettier --write src/**/*.ts"
  }
}
```

### Debugging Tools

#### URL Resolution Debugging
```typescript
// Create debug script: scripts/debug-url.ts
import { resolveUrlFromDescription } from '../utils/urlResolver.js';

const testDescriptions = [
  'test the login page',
  'check user dashboard', 
  'verify shopping cart',
  'test the page at /custom/route'
];

testDescriptions.forEach(description => {
  const result = resolveUrlFromDescription(description);
  console.log(`"${description}" → ${result.resolvedUrl} (confidence: ${result.confidence})`);
});
```

#### Service Debugging
```typescript
// Create debug script: scripts/debug-service.ts
import { E2esService } from '../services/e2es.js';
import { AxiosTransport } from '../utils/axiosTransport.js';
import config from '../config/index.js';

const transport = new AxiosTransport(config.api);
const service = new E2esService(transport);

// Test service methods
async function debugService() {
  try {
    const tests = await service.listTests({ page: 1, limit: 5 });
    console.log('Recent tests:', tests);
  } catch (error) {
    console.error('Service error:', error);
  }
}

debugService();
```

## Production Deployment

### Build for Production
```bash
# Clean build
rm -rf dist
npm run build

# Verify build
node dist/index.js --version

# Check bundle size
du -sh dist/
```

### Docker Development
```bash
# Build development image
docker build -t debugg-ai-mcp:dev .

# Run with development environment
docker run -it --rm \
  -e DEBUGGAI_API_KEY=$DEBUGGAI_API_KEY \
  -e LOG_LEVEL=debug \
  -v $(pwd):/app \
  debugg-ai-mcp:dev npm run dev

# Run tests in container
docker run --rm \
  -e DEBUGGAI_API_KEY=$DEBUGGAI_API_KEY \
  debugg-ai-mcp:dev npm test
```

### Environment-Specific Configuration

#### Development
```bash
export NODE_ENV=development
export LOG_LEVEL=debug
export DEBUGGAI_URL_INTELLIGENCE=true
```

#### Staging
```bash
export NODE_ENV=staging
export LOG_LEVEL=info
export DEBUGGAI_API_BASE_URL=https://staging-api.debugg.ai
```

#### Production
```bash
export NODE_ENV=production
export LOG_LEVEL=error
export DEBUGGAI_API_BASE_URL=https://api.debugg.ai
```

## Code Quality and Standards

### Code Formatting
```bash
# Install Prettier
npm install --save-dev prettier

# Format all files
npx prettier --write "**/*.{ts,js,json,md}"

# Check formatting
npx prettier --check "**/*.{ts,js,json,md}"
```

### Linting
```bash
# Install ESLint
npm install --save-dev eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin

# Run linter
npx eslint "**/*.ts"

# Fix auto-fixable issues
npx eslint "**/*.ts" --fix
```

### Pre-commit Hooks
```bash
# Install husky
npm install --save-dev husky

# Setup pre-commit hook
npx husky add .husky/pre-commit "npm run lint && npm test"
```

## Contributing Guidelines

### Development Workflow
1. **Create Feature Branch**: `git checkout -b feature/your-feature-name`
2. **Develop with Tests**: Write tests alongside feature development
3. **Run Test Suite**: Ensure all tests pass
4. **Update Documentation**: Add/update relevant documentation
5. **Create Pull Request**: Follow PR template

### Code Review Checklist
- [ ] Tests cover new functionality
- [ ] Documentation updated
- [ ] TypeScript compilation successful
- [ ] No lint errors
- [ ] URL intelligence patterns tested (if applicable)
- [ ] MCP parameter injection verified (if applicable)
- [ ] Integration tests pass

### Testing Requirements
- **Unit Test Coverage**: >90% for new code
- **Integration Tests**: Required for API interactions
- **URL Intelligence Tests**: Required for pattern changes
- **Performance Tests**: For optimization changes

## Troubleshooting Development Issues

### Common Development Problems

#### TypeScript Errors
```bash
# Clear TypeScript cache
rm -rf node_modules/.cache

# Rebuild
npm run build

# Check for version conflicts
npm ls typescript
```

#### Test Failures
```bash
# Run specific failing test with debug output
LOG_LEVEL=debug npm test -- __tests__/specific.test.ts --verbose

# Check environment variables
env | grep DEBUGGAI

# Verify API connectivity
curl -H "Authorization: Bearer $DEBUGGAI_API_KEY" https://api.debugg.ai/health
```

#### Module Resolution Issues
```bash
# Clear module cache
rm -rf node_modules package-lock.json
npm install

# Check import paths (should use .js extensions for ESM)
grep -r "from '.*'" --include="*.ts" src/
```

## Advanced Development

### Custom MCP Tools

#### Creating New Tools
```typescript
// 1. Define tool schema
export const customToolSchema = z.object({
  name: z.literal('debugg_ai_custom_tool'),
  description: z.string(),
  inputSchema: z.object({
    customParam: z.string(),
    optionalParam: z.string().optional()
  })
});

// 2. Implement handler
export async function handleCustomTool(
  input: z.infer<typeof customToolSchema>['inputSchema']
): Promise<ToolResult> {
  try {
    // Tool logic here
    const result = await performCustomOperation(input);
    
    return {
      success: true,
      data: result,
      message: 'Custom operation completed successfully'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      message: 'Custom operation failed'
    };
  }
}

// 3. Register tool
export const customTool: Tool = {
  name: 'debugg_ai_custom_tool',
  description: 'Performs custom operation',
  inputSchema: customToolSchema.shape.inputSchema,
  handler: handleCustomTool
};
```

#### Testing Custom Tools
```typescript
import { handleCustomTool } from '../tools/customTool.js';

describe('Custom Tool', () => {
  test('should perform custom operation', async () => {
    const result = await handleCustomTool({
      customParam: 'test value'
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });

  test('should handle errors gracefully', async () => {
    const result = await handleCustomTool({
      customParam: 'invalid value'
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid value');
  });
});
```

### Performance Optimization

#### Profiling
```typescript
// Add performance monitoring
import { performance } from 'perf_hooks';

export async function profiledFunction<T>(
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    const duration = performance.now() - start;
    console.log(`${name} took ${duration.toFixed(2)}ms`);
    return result;
  } catch (error) {
    const duration = performance.now() - start;
    console.log(`${name} failed after ${duration.toFixed(2)}ms`);
    throw error;
  }
}
```

#### Memory Monitoring
```typescript
// Monitor memory usage
function logMemoryUsage(label: string) {
  const used = process.memoryUsage();
  console.log(`${label} - Memory usage:`);
  for (let key in used) {
    console.log(`${key}: ${Math.round(used[key] / 1024 / 1024 * 100) / 100} MB`);
  }
}
```

## Documentation Standards

### Code Documentation
```typescript
/**
 * Resolves natural language descriptions to URL paths
 * 
 * @param description - Natural language description of the page
 * @param options - Optional configuration for resolution
 * @returns Promise resolving to URL resolution result
 * 
 * @example
 * ```typescript
 * const result = await resolveUrlFromDescription('test the login page');
 * console.log(result.resolvedUrl); // '/login/'
 * ```
 */
export async function resolveUrlFromDescription(
  description: string,
  options?: UrlResolutionOptions
): Promise<UrlResolutionResult> {
  // Implementation...
}
```

### README Updates
When adding new features, update documentation:
- Feature description in README.md
- Usage examples
- Configuration options
- API reference if applicable

---

*This developer setup guide provides a complete foundation for contributing to the DebuggAI MCP Server. For additional help, join our Discord community or check the troubleshooting guide.*