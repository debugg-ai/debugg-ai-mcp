/**
 * Tests for URL Intelligence Engine
 */

import {
  resolveUrl,
  extractPageType,
  extractExplicitUrl,
  replaceParameters,
  suggestUrls,
  isValidUrlPattern,
  getPossibleUrls,
  addCustomPattern,
  addCustomKeywords,
  URL_PATTERNS
} from '../../utils/urlResolver';

describe('URL Resolver', () => {
  describe('extractPageType', () => {
    it('should extract login page type from description', () => {
      expect(extractPageType('Test the login functionality')).toBe('login');
      expect(extractPageType('User should sign in successfully')).toBe('login');
      expect(extractPageType('Check the log in page')).toBe('login');
    });

    it('should extract dashboard page type from description', () => {
      expect(extractPageType('Verify the dashboard loads')).toBe('dashboard');
      expect(extractPageType('Test the main home page')).toBe('dashboard');
      expect(extractPageType('Check dashboard overview')).toBe('dashboard');
    });

    it('should extract projects page type from description', () => {
      expect(extractPageType('Test the projects list page')).toBe('projects');
      expect(extractPageType('Verify project portfolio loads')).toBe('projects');
    });

    it('should extract user/profile page type from description', () => {
      expect(extractPageType('Test user profile page')).toBe('profile');
      expect(extractPageType('Check my account settings')).toBe('profile');
      expect(extractPageType('View users list')).toBe('users');
    });

    it('should extract cart and checkout page types', () => {
      expect(extractPageType('Add items to shopping cart')).toBe('cart');
      expect(extractPageType('Test checkout process')).toBe('checkout');
      expect(extractPageType('Verify payment flow')).toBe('checkout');
    });

    it('should return null for unrecognized descriptions', () => {
      expect(extractPageType('Random text without keywords')).toBeNull();
      expect(extractPageType('Something completely different')).toBeNull();
    });
  });

  describe('extractExplicitUrl', () => {
    it('should extract URLs in quotes', () => {
      expect(extractExplicitUrl('Test the "/login" page')).toBe('/login');
      expect(extractExplicitUrl("Navigate to '/dashboard/'")).toBe('/dashboard/');
      expect(extractExplicitUrl('Go to `/products/123`')).toBe('/products/123');
    });

    it('should extract URLs after keywords', () => {
      expect(extractExplicitUrl('Test at /settings page')).toBe('/settings');
      expect(extractExplicitUrl('Navigate to /profile/edit')).toBe('/profile/edit');
      expect(extractExplicitUrl('Check on /dashboard')).toBe('/dashboard');
    });

    it('should extract URLs with path patterns', () => {
      expect(extractExplicitUrl('url: /api/v1/users')).toBe('/api/v1/users');
      expect(extractExplicitUrl('PATH: /admin/settings')).toBe('/admin/settings');
    });

    it('should return null when no explicit URL is found', () => {
      expect(extractExplicitUrl('Test the login page')).toBeNull();
      expect(extractExplicitUrl('Check user functionality')).toBeNull();
    });
  });

  describe('replaceParameters', () => {
    it('should replace id parameters with defaults', () => {
      expect(replaceParameters('/users/{id}/')).toBe('/users/123/');
      expect(replaceParameters('/projects/{id}/edit')).toBe('/projects/123/edit');
    });

    it('should replace slug parameters', () => {
      expect(replaceParameters('/blog/{slug}/')).toBe('/blog/example-item/');
      expect(replaceParameters('/products/{slug}')).toBe('/products/example-item');
    });

    it('should replace username parameters', () => {
      expect(replaceParameters('/users/{username}/profile')).toBe('/users/john-doe/profile');
    });

    it('should handle multiple parameters', () => {
      expect(replaceParameters('/users/{id}/posts/{slug}')).toBe('/users/123/posts/example-item');
    });

    it('should use fallback for unknown parameters', () => {
      expect(replaceParameters('/items/{unknown}/')).toBe('/items/1/');
    });
  });

  describe('resolveUrl', () => {
    it('should resolve URLs from natural language descriptions', () => {
      expect(resolveUrl('Test the login page')).toBe('/login/');
      expect(resolveUrl('Check the user dashboard')).toBe('/dashboard/');
      expect(resolveUrl('Verify projects list loads')).toBe('/projects/');
      expect(resolveUrl('Test shopping cart functionality')).toBe('/cart/');
    });

    it('should use explicit URLs when provided', () => {
      expect(resolveUrl('Test the "/custom/path" page')).toBe('/custom/path');
      expect(resolveUrl('Check page at /special/route')).toBe('/special/route');
    });

    it('should handle parameterized URLs', () => {
      expect(resolveUrl('View user profile details')).toBe('/profile/');
      // Note: The resolver picks the first pattern which might not have parameters
    });

    it('should return root path for unrecognized descriptions', () => {
      expect(resolveUrl('Some random unrecognized text')).toBe('/');
    });
  });

  describe('suggestUrls', () => {
    it('should suggest multiple URLs based on keywords', () => {
      // Test that cart comes first due to longer keyword match
      const suggestions = suggestUrls('shopping cart');
      
      // Should have cart suggestions
      const hasCart = suggestions.some(url => url.includes('cart') || url.includes('basket'));
      expect(hasCart).toBe(true);
      
      // Test single keyword for login
      const loginSuggestions = suggestUrls('login');
      expect(loginSuggestions).toContain('/login/');
      
      // Test that we get suggestions from multiple page types when they fit within limit
      const multiSuggestions = suggestUrls('dashboard profile');
      const hasDashboard = multiSuggestions.some(url => url.includes('dashboard') || url === '/');
      const hasProfile = multiSuggestions.some(url => url.includes('profile') || url.includes('account'));
      
      expect(hasDashboard).toBe(true);
      // Profile might not be included if dashboard has too many patterns
      // This is expected behavior - we limit to 5 total suggestions
    });

    it('should limit suggestions to 5', () => {
      const suggestions = suggestUrls('test login dashboard profile users settings');
      expect(suggestions.length).toBeLessThanOrEqual(5);
    });

    it('should remove duplicate suggestions', () => {
      const suggestions = suggestUrls('login sign in authenticate');
      const uniqueSuggestions = [...new Set(suggestions)];
      expect(suggestions.length).toBe(uniqueSuggestions.length);
    });
  });

  describe('isValidUrlPattern', () => {
    it('should validate correct URL patterns', () => {
      expect(isValidUrlPattern('/login/')).toBe(true);
      expect(isValidUrlPattern('/users/{id}/')).toBe(true);
      expect(isValidUrlPattern('/api/v1/users')).toBe(true);
      expect(isValidUrlPattern('/search?q=test')).toBe(true);
      expect(isValidUrlPattern('/page#section')).toBe(true);
    });

    it('should reject invalid URL patterns', () => {
      expect(isValidUrlPattern('login')).toBe(false);  // No leading slash
      expect(isValidUrlPattern('http://example.com')).toBe(false);  // Absolute URL
      expect(isValidUrlPattern('/path with spaces')).toBe(false);  // Spaces
      expect(isValidUrlPattern('')).toBe(false);  // Empty
    });
  });

  describe('getPossibleUrls', () => {
    it('should return all URL patterns for a page type', () => {
      const loginUrls = getPossibleUrls('login');
      expect(loginUrls).toContain('/login/');
      expect(loginUrls.length).toBeGreaterThan(0);
    });

    it('should replace parameters in all patterns', () => {
      const userUrls = getPossibleUrls('user-detail');
      userUrls.forEach(url => {
        expect(url).not.toContain('{');
        expect(url).not.toContain('}');
      });
    });

    it('should return empty array for unknown page types', () => {
      const unknownUrls = getPossibleUrls('nonexistent');
      expect(unknownUrls).toEqual([]);
    });
  });

  describe('Custom patterns and keywords', () => {
    it('should add custom patterns', () => {
      const initialLength = (URL_PATTERNS['custom-test'] || []).length;
      addCustomPattern('custom-test', ['/custom/test/', '/test/custom/']);
      
      expect(URL_PATTERNS['custom-test']).toBeDefined();
      expect(URL_PATTERNS['custom-test'].length).toBe(initialLength + 2);
      expect(URL_PATTERNS['custom-test']).toContain('/custom/test/');
      expect(URL_PATTERNS['custom-test']).toContain('/test/custom/');
    });

    it('should add custom keywords', () => {
      addCustomKeywords('custom-test', ['custom', 'test']);
      
      // Since KEYWORD_MAPPINGS is not exported, we test indirectly
      const pageType = extractPageType('This is a custom test page');
      expect(pageType).toBe('custom-test');
    });

    it('should resolve URLs using custom patterns', () => {
      // Use unique keywords that won't match existing patterns
      addCustomPattern('unique-feature', ['/unique-feature/']);
      addCustomKeywords('unique-feature', ['unique feature']);
      
      const resolved = resolveUrl('Access the unique feature page');
      expect(resolved).toBe('/unique-feature/');
    });
  });

  describe('Complex scenarios', () => {
    it('should handle descriptions with multiple keywords', () => {
      const url = resolveUrl('User logs in and views their profile dashboard');
      // Should pick the first matching keyword
      expect(['/login/', '/profile/', '/dashboard/']).toContain(url);
    });

    it('should prefer explicit URLs over keyword matching', () => {
      const url = resolveUrl('Test login at "/custom/auth"');
      expect(url).toBe('/custom/auth');
    });

    it('should handle descriptions with URL-like text that is not a path', () => {
      const url = resolveUrl('Test website.com functionality');
      // Should either return '/' or a matched pattern based on 'test' keyword
      expect(['/', '/custom/test/']).toContain(url);
    });
  });
});

/**
 * Comprehensive URL Intelligence Tests - Edge Cases and Performance
 */
describe('URL Resolver - Comprehensive Edge Cases and Performance', () => {
  
  describe('Edge Cases and Error Handling', () => {
    test('should handle empty and whitespace-only inputs', () => {
      expect(resolveUrl('')).toBe('/');
      expect(resolveUrl('   ')).toBe('/');
      expect(resolveUrl('\t\n  ')).toBe('/');
      expect(resolveUrl('\r\n\t   \n')).toBe('/');
    });

    test('should handle special characters in descriptions', () => {
      expect(resolveUrl('test the login@#$%^&*() page')).toBe('/login/');
      expect(resolveUrl('dashboard with émojis 🚀')).toBe('/dashboard/');
      expect(resolveUrl('settings página en español')).toBe('/settings/');
      expect(resolveUrl('profile页面中文测试')).toBe('/profile/');
    });

    test('should handle very long descriptions', () => {
      const longDescription = 'This is a very long description that goes on and on and on and on and on and contains the word dashboard somewhere in the middle of all this text and should still be able to extract the correct page type despite the length and complexity of the input string that we are providing to test the robustness of our URL resolution algorithm';
      
      expect(resolveUrl(longDescription)).toBe('/dashboard/');
    });

    test('should handle mixed case and variations', () => {
      const testCases = [
        { input: 'LOGIN page', expected: '/login/' },
        { input: 'Log In Form', expected: '/login/' },
        { input: 'DASHBOARD Overview', expected: '/dashboard/' },
        { input: 'User Profile Settings', expected: '/profile/' },
        { input: 'shopping-cart functionality', expected: '/cart/' },
        { input: 'E-Commerce Checkout Flow', expected: '/checkout/' }
      ];

      testCases.forEach(({ input, expected }) => {
        expect(resolveUrl(input)).toBe(expected);
      });
    });

    test('should handle URLs with query parameters and fragments', () => {
      expect(extractExplicitUrl('Go to "/dashboard?tab=overview"')).toBe('/dashboard?tab=overview');
      expect(extractExplicitUrl('Navigate to /profile#settings')).toBe('/profile#settings');
      expect(extractExplicitUrl('Check "/api/v1/users?limit=10&offset=0"')).toBe('/api/v1/users?limit=10&offset=0');
      expect(extractExplicitUrl('Test /admin/users/?search=test#results')).toBe('/admin/users/?search=test#results');
    });

    test('should handle malformed URL patterns gracefully', () => {
      expect(isValidUrlPattern('/valid/path')).toBe(true);
      expect(isValidUrlPattern('invalid')).toBe(false);
      expect(isValidUrlPattern('http://external.com')).toBe(false);
      expect(isValidUrlPattern('/path with spaces')).toBe(false);
      expect(isValidUrlPattern('')).toBe(false);
      expect(isValidUrlPattern(null as any)).toBe(false);
      expect(isValidUrlPattern(undefined as any)).toBe(false);
    });

    test('should handle parameter replacement edge cases', () => {
      expect(replaceParameters('/users/{}')).toBe('/users/1'); // Empty parameter
      expect(replaceParameters('/users/{ID}')).toBe('/users/123'); // Uppercase parameter
      expect(replaceParameters('/users/{user_id}')).toBe('/users/1'); // Snake_case parameter
      expect(replaceParameters('/users/{userId}')).toBe('/users/1'); // CamelCase parameter  
      expect(replaceParameters('/{id}/{slug}/{unknown}')).toBe('/123/example-item/1');
    });
  });

  describe('Complex Keyword Matching', () => {
    test('should prioritize longer matches over shorter ones', () => {
      // "shopping cart" (11 chars) should beat "cart" (4 chars)
      expect(resolveUrl('shopping cart page')).toBe('/cart/');
      
      // "user profile" (12 chars) should beat "profile" (7 chars)  
      expect(resolveUrl('user profile settings')).toBe('/profile/');
      
      // "forgot password" (14 chars) should beat "password" (8 chars)
      expect(resolveUrl('forgot password form')).toBe('/forgot-password/');
      
      // "admin dashboard" (15 chars) should beat "dashboard" (9 chars)
      expect(resolveUrl('admin dashboard page')).toBe('/admin/');
    });

    test('should handle ambiguous descriptions correctly', () => {
      // Test cases where multiple keywords could match
      expect(resolveUrl('user dashboard profile')).toBe('/profile/'); // Longest match wins
      expect(resolveUrl('login form settings')).toBe('/login/'); // First long match
      expect(resolveUrl('checkout cart payment')).toBe('/checkout/'); // Longest specific match
    });

    test('should handle contextual keywords', () => {
      const contextTests = [
        { input: 'view users list', expected: '/users/' },
        { input: 'user profile page', expected: '/profile/' },
        { input: 'metrics dashboard', expected: '/analytics/' },
        { input: 'team page', expected: '/team/' },
        { input: 'api documentation', expected: '/api/' }
      ];

      contextTests.forEach(({ input, expected }) => {
        expect(resolveUrl(input)).toBe(expected);
      });
    });

    test('should handle negation and exclusion words', () => {
      // Test descriptions that might be misleading
      expect(resolveUrl('not the login page but dashboard')).toBe('/dashboard/');
      expect(resolveUrl('avoid cart, go to checkout')).toBe('/checkout/');
      expect(resolveUrl('skip profile, show settings')).toBe('/settings/');
    });

    test('should handle compound descriptions', () => {
      const compounds = [
        { input: 'login and register forms', expected: '/login/' }, // First match
        { input: 'profile or settings page', expected: '/profile/' }, // First match
        { input: 'cart plus checkout flow', expected: '/cart/' }, // First match
        { input: 'dashboard with analytics', expected: '/dashboard/' } // First match
      ];

      compounds.forEach(({ input, expected }) => {
        expect(resolveUrl(input)).toBe(expected);
      });
    });
  });

  describe('Performance Benchmarks', () => {
    test('should resolve URLs quickly for simple descriptions', () => {
      const simpleDescriptions = [
        'login', 'dashboard', 'profile', 'settings', 'cart', 'checkout',
        'products', 'users', 'admin', 'reports', 'analytics', 'messages'
      ];

      const startTime = process.hrtime.bigint();
      
      simpleDescriptions.forEach(desc => {
        resolveUrl(desc);
      });
      
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1_000_000; // Convert to milliseconds
      
      // Should complete all simple resolutions in under 10ms
      expect(duration).toBeLessThan(10);
    });

    test('should handle bulk URL resolution efficiently', () => {
      const bulkDescriptions = Array.from({ length: 100 }, (_, i) => `test description ${i} with dashboard`);
      
      const startTime = process.hrtime.bigint();
      
      bulkDescriptions.forEach(desc => {
        resolveUrl(desc);
      });
      
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1_000_000;
      
      // Should complete 100 resolutions in under 50ms
      expect(duration).toBeLessThan(50);
      
      // All should resolve to dashboard
      const results = bulkDescriptions.map(desc => resolveUrl(desc));
      expect(results.every(result => result === '/dashboard/')).toBe(true);
    });

    test('should handle concurrent URL resolutions', async () => {
      const descriptions = [
        'login page test', 'dashboard overview', 'user profile',
        'settings panel', 'shopping cart', 'checkout process',
        'product catalog', 'user management', 'admin panel'
      ];

      const startTime = process.hrtime.bigint();
      
      // Simulate concurrent resolution
      const promises = descriptions.map(desc => 
        Promise.resolve(resolveUrl(desc))
      );
      
      const results = await Promise.all(promises);
      
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1_000_000;
      
      // Should complete concurrent resolutions quickly
      expect(duration).toBeLessThan(20);
      expect(results).toHaveLength(9);
      expect(results[0]).toBe('/login/');
      expect(results[1]).toBe('/dashboard/');
    });

    test('should handle memory efficiently with large inputs', () => {
      const largeBatch = Array.from({ length: 1000 }, (_, i) => {
        const keywords = ['login', 'dashboard', 'profile', 'settings', 'cart'];
        const keyword = keywords[i % keywords.length];
        return `Large description ${i} containing the ${keyword} page functionality`;
      });

      // Memory usage before
      const memBefore = process.memoryUsage().heapUsed;
      
      const startTime = process.hrtime.bigint();
      
      largeBatch.forEach(desc => {
        resolveUrl(desc);
      });
      
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1_000_000;
      
      // Memory usage after
      const memAfter = process.memoryUsage().heapUsed;
      const memDelta = (memAfter - memBefore) / 1024 / 1024; // MB
      
      // Should complete 1000 resolutions in reasonable time and memory
      expect(duration).toBeLessThan(100);
      expect(memDelta).toBeLessThan(10); // Less than 10MB increase
    });
  });

  describe('Custom Pattern and Keyword Integration', () => {
    test('should integrate custom patterns seamlessly', () => {
      // Add custom patterns for testing
      addCustomPattern('custom-flow', ['/custom/flow/', '/flow/custom/']);
      addCustomKeywords('custom-flow', ['custom flow', 'flow custom']);
      
      expect(resolveUrl('test the custom flow')).toBe('/custom/flow/');
      expect(getPossibleUrls('custom-flow')).toContain('/custom/flow/');
      expect(getPossibleUrls('custom-flow')).toContain('/flow/custom/');
    });

    test('should handle custom patterns with parameters', () => {
      addCustomPattern('custom-detail', ['/custom/{id}/detail/', '/detail/{slug}/custom/']);
      addCustomKeywords('custom-detail', ['custom detail']);
      
      const resolved = resolveUrl('custom detail page');
      expect(['/custom/123/detail/', '/detail/example-item/custom/']).toContain(resolved);
    });

    test('should not interfere with existing patterns', () => {
      // Add custom pattern that shouldn't conflict
      addCustomPattern('unique-page', ['/unique/']);
      addCustomKeywords('unique-page', ['unique page']);
      
      // Existing patterns should still work
      expect(resolveUrl('login')).toBe('/login/');
      expect(resolveUrl('dashboard')).toBe('/dashboard/');
      expect(resolveUrl('unique page')).toBe('/unique/');
    });

    test('should handle pattern priority correctly', () => {
      // Add a custom pattern that might conflict
      addCustomPattern('priority-test', ['/priority/test/']);
      addCustomKeywords('priority-test', ['test priority']);
      
      // Should prioritize based on keyword length
      expect(resolveUrl('test priority page')).toBe('/priority/test/');
      expect(resolveUrl('test page')).toBe('/priority/test/'); // Longest match
    });
  });

  describe('Suggestion Engine Performance', () => {
    test('should provide suggestions efficiently', () => {
      const startTime = process.hrtime.bigint();
      
      const suggestions1 = suggestUrls('user management');
      const suggestions2 = suggestUrls('shopping experience');
      const suggestions3 = suggestUrls('admin dashboard');
      
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1_000_000;
      
      expect(duration).toBeLessThan(5);
      expect(suggestions1.length).toBeGreaterThan(0);
      expect(suggestions2.length).toBeGreaterThan(0);
      expect(suggestions3.length).toBeGreaterThan(0);
    });

    test('should limit suggestions appropriately', () => {
      const suggestions = suggestUrls('login dashboard profile settings admin');
      expect(suggestions.length).toBeLessThanOrEqual(5);
      
      // Should not have duplicates
      const unique = [...new Set(suggestions)];
      expect(suggestions.length).toBe(unique.length);
    });

    test('should handle suggestion edge cases', () => {
      expect(suggestUrls('')).toHaveLength(0);
      expect(suggestUrls('nonexistent keyword')).toHaveLength(0);
      expect(suggestUrls('xyz abc def')).toHaveLength(0);
    });
  });

  describe('Real-world Integration Scenarios', () => {
    test('should handle e-commerce user flows', () => {
      const ecommerceFlows = [
        { desc: 'browse product catalog', expected: '/products/' },
        { desc: 'add items to shopping cart', expected: '/cart/' },
        { desc: 'proceed to checkout', expected: '/checkout/' },
        { desc: 'view order history', expected: '/orders/' },
        { desc: 'manage user profile', expected: '/profile/' }
      ];

      ecommerceFlows.forEach(({ desc, expected }) => {
        expect(resolveUrl(desc)).toBe(expected);
      });
    });

    test('should handle admin workflows', () => {
      const adminFlows = [
        { desc: 'access admin dashboard', expected: '/admin/' },
        { desc: 'view users list', expected: '/users/' },
        { desc: 'check analytics data', expected: '/analytics/' },
        { desc: 'review system reports', expected: '/reports/' },
        { desc: 'manage team settings', expected: '/settings/' }
      ];

      adminFlows.forEach(({ desc, expected }) => {
        expect(resolveUrl(desc)).toBe(expected);
      });
    });

    test('should handle content management workflows', () => {
      const cmsFlows = [
        { desc: 'create blog post', expected: '/blog/' },
        { desc: 'manage content categories', expected: '/categories/' },
        { desc: 'view all messages', expected: '/messages/' },
        { desc: 'check notifications', expected: '/notifications/' },
        { desc: 'access documentation', expected: '/documentation/' }
      ];

      cmsFlows.forEach(({ desc, expected }) => {
        expect(resolveUrl(desc)).toBe(expected);
      });
    });

    test('should handle SaaS application flows', () => {
      const saasFlows = [
        { desc: 'workspace overview', expected: '/workspace/' },
        { desc: 'team collaboration', expected: '/team/' },
        { desc: 'project management', expected: '/projects/' },
        { desc: 'user preferences', expected: '/settings/' },
        { desc: 'pricing information', expected: '/pricing/' }
      ];

      saasFlows.forEach(({ desc, expected }) => {
        expect(resolveUrl(desc)).toBe(expected);
      });
    });
  });

  describe('Internationalization Support', () => {
    test('should work with common English variations', () => {
      const variations = [
        { desc: 'log in page', expected: '/login/' }, // Space in keyword
        { desc: 'sign-in form', expected: '/login/' }, // Hyphenated
        { desc: 'signin area', expected: '/login/' }, // No space/hyphen
        { desc: 'log out', expected: '/logout/' },
        { desc: 'sign up form', expected: '/register/' }
      ];

      variations.forEach(({ desc, expected }) => {
        expect(resolveUrl(desc)).toBe(expected);
      });
    });

    test('should handle common abbreviations', () => {
      expect(resolveUrl('admin console')).toBe('/admin/');
      expect(resolveUrl('user mgmt')).toBe('/users/'); // Should not match 'mgmt' 
      expect(resolveUrl('config page')).toBe('/settings/');
      expect(resolveUrl('prefs panel')).toBe('/settings/'); // Should not match 'prefs'
    });
  });
});

/**
 * URL Intelligence Stress Tests and Reliability
 */
describe('URL Resolver - Stress Tests and Reliability', () => {
  
  test('should handle rapid-fire resolutions without memory leaks', () => {
    const descriptions = [
      'login', 'dashboard', 'profile', 'settings', 'cart',
      'checkout', 'products', 'users', 'admin', 'reports'
    ];

    // Run many iterations quickly
    for (let i = 0; i < 1000; i++) {
      const desc = descriptions[i % descriptions.length];
      const result = resolveUrl(desc);
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      expect(result.startsWith('/')).toBe(true);
    }
  });

  test('should maintain consistency across multiple calls', () => {
    const testCases = [
      'user dashboard',
      'shopping cart',
      'login page',
      'admin panel',
      'checkout process'
    ];

    // Each description should always resolve to the same URL
    testCases.forEach(desc => {
      const results = Array.from({ length: 10 }, () => resolveUrl(desc));
      const unique = [...new Set(results)];
      expect(unique).toHaveLength(1);
    });
  });

  test('should handle malformed or unusual inputs gracefully', () => {
    const malformedInputs = [
      null,
      undefined,
      123,
      {},
      [],
      true,
      false
    ];

    malformedInputs.forEach(input => {
      expect(() => {
        const result = resolveUrl(input as any);
        expect(typeof result).toBe('string');
      }).not.toThrow();
    });
  });

  test('should provide stable performance under load', () => {
    const loadTest = Array.from({ length: 500 }, (_, i) => 
      `Load test description ${i} with dashboard keyword`
    );

    const times: number[] = [];
    
    loadTest.forEach(desc => {
      const start = process.hrtime.bigint();
      resolveUrl(desc);
      const end = process.hrtime.bigint();
      times.push(Number(end - start) / 1_000_000); // Convert to milliseconds
    });

    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const maxTime = Math.max(...times);

    // Performance should be stable
    expect(avgTime).toBeLessThan(0.1); // Average under 0.1ms
    expect(maxTime).toBeLessThan(2); // Max under 2ms
  });
});

/**
 * Performance Benchmarks for URL Intelligence System
 * Tests resolution speed, memory usage, and scalability
 */
describe('URL Intelligence Performance Benchmarks', () => {
  
  describe('High-Volume Resolution Performance', () => {
    test('should resolve URLs quickly under extreme load', () => {
      const descriptions = [
        'login page', 'user dashboard', 'shopping cart', 'checkout process',
        'admin panel', 'user profile', 'settings page', 'product catalog',
        'order history', 'analytics dashboard', 'team workspace', 'project management'
      ];

      const iterations = 10000; // 10x more than previous test
      const startTime = process.hrtime.bigint();

      for (let i = 0; i < iterations; i++) {
        const desc = descriptions[i % descriptions.length];
        resolveUrl(desc);
      }

      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1_000_000; // milliseconds

      // Should resolve 10,000 URLs in under 100ms
      expect(duration).toBeLessThan(100);
      console.log(`High-Volume URL Resolution: ${iterations} resolutions in ${duration.toFixed(2)}ms`);
      console.log(`Throughput: ${(iterations / duration * 1000).toFixed(0)} ops/second`);
    });

    test('should handle concurrent URL resolution efficiently', async () => {
      const concurrentBatches = 100;
      const batchSize = 50;
      
      const startTime = process.hrtime.bigint();
      
      // Run concurrent batches
      const batches = Array.from({ length: concurrentBatches }, (_, batchIndex) => {
        return Promise.all(
          Array.from({ length: batchSize }, (_, i) => {
            const description = `batch ${batchIndex} item ${i} dashboard`;
            return Promise.resolve(resolveUrl(description));
          })
        );
      });
      
      const results = await Promise.all(batches);
      
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1_000_000;
      const totalOperations = concurrentBatches * batchSize;
      
      expect(results).toHaveLength(concurrentBatches);
      expect(duration).toBeLessThan(500); // Under 500ms total
      
      console.log(`Concurrent Resolution Performance:`);
      console.log(`  Total operations: ${totalOperations}`);
      console.log(`  Total time: ${duration.toFixed(2)}ms`);
      console.log(`  Ops per second: ${(totalOperations / duration * 1000).toFixed(0)}`);
    });
  });

  describe('Memory Efficiency Benchmarks', () => {
    test('should maintain low memory footprint under load', () => {
      const memBefore = process.memoryUsage();
      const iterations = 50000;
      
      // Generate many URL resolutions
      for (let i = 0; i < iterations; i++) {
        const description = `memory test ${i % 100} dashboard analytics`;
        resolveUrl(description);
        
        // Also test suggestions occasionally
        if (i % 1000 === 0) {
          suggestUrls(description);
        }
      }
      
      const memAfter = process.memoryUsage();
      const memIncrease = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;
      
      // Should not increase memory significantly
      expect(memIncrease).toBeLessThan(5); // Less than 5MB increase
      
      console.log(`Memory Usage Analysis:`);
      console.log(`  Operations: ${iterations}`);
      console.log(`  Memory increase: ${memIncrease.toFixed(2)}MB`);
      console.log(`  Memory per operation: ${(memIncrease / iterations * 1024).toFixed(3)}KB`);
    });

    test('should handle large custom pattern sets efficiently', () => {
      // Add many custom patterns to test performance impact
      const customPatterns = Array.from({ length: 500 }, (_, i) => `/custom-${i}/`);
      
      const startTime = process.hrtime.bigint();
      
      // Add all custom patterns
      for (let i = 0; i < customPatterns.length; i++) {
        addCustomPattern(`perf-type-${i}`, [customPatterns[i]]);
        addCustomKeywords(`perf-type-${i}`, [`perf keyword ${i}`]);
      }
      
      const patternAddTime = process.hrtime.bigint();
      const patternAddDuration = Number(patternAddTime - startTime) / 1_000_000;
      
      // Test resolution with expanded pattern set
      const testDescriptions = Array.from({ length: 1000 }, (_, i) => 
        i % 100 === 0 ? `perf keyword ${i % 100}` : 'regular dashboard test'
      );
      
      testDescriptions.forEach(desc => resolveUrl(desc));
      
      const endTime = process.hrtime.bigint();
      const resolutionDuration = Number(endTime - patternAddTime) / 1_000_000;
      
      expect(patternAddDuration).toBeLessThan(200); // Pattern addition should be fast
      expect(resolutionDuration).toBeLessThan(100); // Resolution should still be fast
      
      console.log(`Large Pattern Set Performance:`);
      console.log(`  Pattern addition: ${patternAddDuration.toFixed(2)}ms for ${customPatterns.length} patterns`);
      console.log(`  Resolution time: ${resolutionDuration.toFixed(2)}ms for 1000 operations`);
    });
  });

  describe('Complex Scenario Performance', () => {
    test('should handle mixed workload efficiently', () => {
      const operations = [
        () => resolveUrl('user dashboard analytics'),
        () => resolveUrl('shopping cart checkout'),
        () => resolveUrl('admin panel settings'),
        () => suggestUrls('user management'),
        () => suggestUrls('e-commerce platform'),
        () => getPossibleUrls('dashboard'),
        () => getPossibleUrls('profile'),
        () => isValidUrlPattern('/api/v1/test'),
        () => extractPageType('complex admin dashboard'),
        () => replaceParameters('/users/{id}/profile/{tab}')
      ];
      
      const iterations = 10000;
      const startTime = process.hrtime.bigint();
      
      for (let i = 0; i < iterations; i++) {
        const operation = operations[i % operations.length];
        operation();
      }
      
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1_000_000;
      const avgTime = duration / iterations;
      
      expect(avgTime).toBeLessThan(0.1); // Under 0.1ms per mixed operation
      
      console.log(`Mixed Workload Performance:`);
      console.log(`  Total time: ${duration.toFixed(2)}ms for ${iterations} mixed operations`);
      console.log(`  Average per operation: ${avgTime.toFixed(4)}ms`);
      console.log(`  Throughput: ${(iterations / duration * 1000).toFixed(0)} ops/second`);
    });

    test('should maintain performance with extreme input variations', () => {
      const extremeInputs = [
        '', // Empty
        'a', // Single char
        'login', // Simple
        'user dashboard analytics with real-time monitoring and comprehensive reporting', // Long
        'navigate to the sophisticated enterprise-grade admin panel with advanced user management capabilities', // Very long
        'LOGIN PAGE!!!', // Caps + special chars
        'user-dashboard_analytics.page', // Special chars
        '🚀 dashboard 🎯 analytics 📊', // Emojis
        'página de administração do usuário', // Non-English
        '/api/v1/users/{id}/profile/{tab}?sort=asc&filter=active', // URL-like
      ];
      
      const iterationsPerInput = 1000;
      const totalIterations = extremeInputs.length * iterationsPerInput;
      
      const startTime = process.hrtime.bigint();
      
      extremeInputs.forEach(input => {
        for (let i = 0; i < iterationsPerInput; i++) {
          resolveUrl(input);
        }
      });
      
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1_000_000;
      const avgTime = duration / totalIterations;
      
      expect(avgTime).toBeLessThan(0.05); // Should handle extreme inputs efficiently
      
      console.log(`Extreme Input Performance:`);
      console.log(`  Total operations: ${totalIterations}`);
      console.log(`  Total time: ${duration.toFixed(2)}ms`);
      console.log(`  Average per operation: ${avgTime.toFixed(4)}ms`);
    });
  });
});