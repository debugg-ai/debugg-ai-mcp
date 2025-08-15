/**
 * URL Intelligence Engine
 * Resolves natural language descriptions to appropriate relative URLs for testing
 */

import { Logger } from './logger.js';

const logger = new Logger({ module: 'urlResolver' });

/**
 * URL pattern dictionary mapping common page types to possible URL patterns
 */
export const URL_PATTERNS: Record<string, string[]> = {
  // Authentication related
  login: ['/login/', '/auth/login/', '/signin/', '/auth/signin/', '/account/login/'],
  logout: ['/logout/', '/auth/logout/', '/signout/', '/auth/signout/'],
  register: ['/register/', '/signup/', '/auth/register/', '/auth/signup/', '/join/'],
  'forgot-password': ['/forgot-password/', '/auth/forgot-password/', '/password/reset/', '/account/recover/'],
  
  // User related
  profile: ['/profile/', '/user/profile/', '/account/', '/me/', '/user/'],
  users: ['/users/', '/members/', '/people/', '/team/'],
  'user-detail': ['/users/{id}/', '/users/{username}/', '/profile/{id}/', '/member/{id}/'],
  settings: ['/settings/', '/account/settings/', '/preferences/', '/config/', '/user/settings/'],
  
  // Dashboard & Home
  dashboard: ['/dashboard/', '/home/', '/', '/overview/', '/main/'],
  admin: ['/admin/', '/admin/dashboard/', '/management/', '/control-panel/'],
  
  // Content & Projects
  projects: ['/projects/', '/work/', '/portfolio/', '/cases/'],
  'project-detail': ['/projects/{id}/', '/project/{slug}/', '/work/{id}/'],
  products: ['/products/', '/catalog/', '/shop/', '/items/', '/inventory/'],
  'product-detail': ['/products/{id}/', '/product/{slug}/', '/item/{id}/', '/p/{id}/'],
  
  // E-commerce
  cart: ['/cart/', '/shopping-cart/', '/basket/', '/bag/'],
  checkout: ['/checkout/', '/order/checkout/', '/payment/', '/purchase/'],
  orders: ['/orders/', '/my-orders/', '/order-history/', '/purchases/'],
  'order-detail': ['/orders/{id}/', '/order/{id}/', '/invoice/{id}/'],
  
  // Content Management
  blog: ['/blog/', '/posts/', '/articles/', '/news/'],
  'blog-post': ['/blog/{slug}/', '/post/{id}/', '/article/{slug}/', '/blog/post/{id}/'],
  categories: ['/categories/', '/topics/', '/tags/', '/sections/'],
  
  // Communication
  messages: ['/messages/', '/inbox/', '/mail/', '/conversations/', '/chat/'],
  notifications: ['/notifications/', '/alerts/', '/updates/', '/activity/'],
  
  // Forms & Data
  contact: ['/contact/', '/contact-us/', '/get-in-touch/', '/support/'],
  search: ['/search/', '/find/', '/explore/', '/discover/'],
  form: ['/form/', '/submit/', '/application/', '/request/'],
  
  // API & Documentation
  api: ['/api/', '/api/docs/', '/developer/', '/api-reference/'],
  documentation: ['/docs/', '/documentation/', '/guide/', '/help/', '/manual/'],
  
  // Analytics & Reports
  analytics: ['/analytics/', '/stats/', '/metrics/', '/insights/', '/reports/'],
  reports: ['/reports/', '/reporting/', '/analysis/', '/data/'],
  
  // Lists & Tables
  list: ['/list/', '/items/', '/all/', '/index/'],
  table: ['/table/', '/data-table/', '/grid/', '/records/'],
  
  // About & Info
  about: ['/about/', '/about-us/', '/company/', '/who-we-are/'],
  faq: ['/faq/', '/help/', '/questions/', '/support/faq/'],
  pricing: ['/pricing/', '/plans/', '/packages/', '/subscription/'],
  
  // Teams & Organizations
  team: ['/team/', '/teams/', '/groups/', '/organization/'],
  workspace: ['/workspace/', '/workspaces/', '/org/', '/company/'],
};

/**
 * Common parameter patterns that can be replaced with realistic values
 */
const PARAMETER_DEFAULTS: Record<string, string[]> = {
  id: ['123', '1', '42', '001'],
  uuid: ['550e8400-e29b-41d4-a716-446655440000'],
  slug: ['example-item', 'test-page', 'sample-content'],
  username: ['john-doe', 'testuser', 'admin'],
  category: ['general', 'tech', 'news'],
  page: ['1', '2'],
  tab: ['overview', 'details', 'settings'],
};

/**
 * Keywords that suggest certain page types
 */
const KEYWORD_MAPPINGS: Record<string, string[]> = {
  cart: ['shopping cart', 'cart', 'basket', 'bag', 'shopping basket'],  // Cart moved before products
  users: ['users list', 'view users', 'users', 'members', 'people'],  // Added 'view users'
  login: ['login', 'sign in', 'signin', 'authenticate', 'log in', 'login page'],
  logout: ['logout', 'sign out', 'signout', 'log out'],
  register: ['register', 'sign up', 'signup', 'create account', 'join', 'register page', 'sign up form'],
  profile: ['user profile', 'profile', 'account', 'user info', 'personal', 'my account', 'my profile', 'profile page', 'user account'],
  dashboard: ['user dashboard', 'dashboard', 'home', 'main', 'overview', 'landing', 'main dashboard'],
  admin: ['admin dashboard', 'admin', 'administration', 'admin panel', 'control panel', 'management'],  // Moved 'admin dashboard' here
  projects: ['projects', 'project', 'work', 'portfolio'],
  products: ['products', 'product', 'catalog', 'shop', 'items', 'product catalog'],
  checkout: ['checkout', 'payment', 'purchase', 'buy', 'payment page'],
  orders: ['orders', 'order', 'order history', 'purchases', 'my orders'],
  settings: ['settings', 'preferences', 'configuration', 'options', 'user settings'],
  search: ['search', 'find', 'lookup', 'query'],
  list: ['list', 'table', 'grid', 'index'],
  'forgot-password': ['forgot password form', 'forgot password', 'password reset', 'recover password'],  // Moved 'forgot password form' here
  form: ['form', 'submit', 'fill', 'input', 'enter'],
  messages: ['messages', 'message', 'inbox', 'mail', 'chat'],
  blog: ['blog', 'blog posts', 'articles', 'news', 'posts'],
  notifications: ['notifications', 'alerts', 'updates'],
  analytics: ['analytics', 'stats', 'metrics', 'data', 'insights', 'metrics dashboard'],
  reports: ['reports', 'reporting', 'analysis'],
  api: ['api documentation', 'api docs', 'developer docs', 'api', 'developer'],
  team: ['team page', 'teams', 'team', 'groups'],
  workspace: ['workspace', 'workspaces', 'org'],
  about: ['about', 'company', 'who we are', 'information'],
  contact: ['contact', 'support', 'help', 'get in touch'],
};

/**
 * Extract page type from natural language description
 */
export function extractPageType(description: string): string | null {
  const lowerDesc = description.toLowerCase();
  
  // First, collect all potential matches with their keyword lengths
  const matches: Array<{ pageType: string; keyword: string; length: number }> = [];
  
  for (const [pageType, keywords] of Object.entries(KEYWORD_MAPPINGS)) {
    for (const keyword of keywords) {
      if (lowerDesc.includes(keyword)) {
        matches.push({ pageType, keyword, length: keyword.length });
      }
    }
  }
  
  // Sort matches by keyword length (descending) to prioritize longer, more specific matches
  matches.sort((a, b) => b.length - a.length);
  
  // Return the page type with the longest matching keyword
  if (matches.length > 0) {
    const bestMatch = matches[0];
    logger.debug(`Matched page type '${bestMatch.pageType}' from keyword '${bestMatch.keyword}'`);
    return bestMatch.pageType;
  }
  
  // Check for URL patterns mentioned directly
  const urlMatch = description.match(/['""`]([\/\w\-\{\}]+)['""`]/);
  if (urlMatch) {
    logger.debug(`Found explicit URL in description: ${urlMatch[1]}`);
    return null; // Return null to indicate explicit URL was provided
  }
  
  return null;
}

/**
 * Replace parameter placeholders with realistic default values
 */
export function replaceParameters(urlPattern: string): string {
  let url = urlPattern;
  
  // Replace {id} patterns
  url = url.replace(/\{(\w+)\}/g, (match, param) => {
    const defaults = PARAMETER_DEFAULTS[param.toLowerCase()];
    if (defaults && defaults.length > 0) {
      return defaults[0];
    }
    // Default fallback
    return '1';
  });
  
  return url;
}

/**
 * Extract explicit URL from description if provided
 */
export function extractExplicitUrl(description: string): string | null {
  // Look for URLs in quotes or backticks
  const patterns = [
    /["`']([\/\w\-\.\/\?\&\=\#]+)["`']/,  // In quotes or backticks
    /(?:url|URL|path|PATH):\s*([\/\w\-\.\/\?\&\=\#]+)/,  // After "url:" or "path:"
    /(?:at|on|to)\s+([\/\w\-\.\/\?\&\=\#]+)(?:\s|$)/,  // After "at", "on", "to"
    /([\/\w\-]+\/\w+\/?)(?:\s|$)/,  // General path pattern
  ];
  
  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (match && match[1].startsWith('/')) {
      logger.debug(`Extracted explicit URL from description: ${match[1]}`);
      return match[1];
    }
  }
  
  return null;
}

/**
 * Main URL resolver function
 * Attempts to resolve a relative URL from a natural language description
 */
export function resolveUrl(description: string): string {
  logger.debug(`Resolving URL from description: "${description}"`);
  
  // First, check if an explicit URL is provided
  const explicitUrl = extractExplicitUrl(description);
  if (explicitUrl) {
    logger.info(`Using explicit URL: ${explicitUrl}`);
    return explicitUrl;
  }
  
  // Try to identify the page type from the description
  const pageType = extractPageType(description);
  if (!pageType) {
    // Default fallback
    logger.info('No specific page type identified, using default root path');
    return '/';
  }
  
  // Get URL patterns for the identified page type
  const patterns = URL_PATTERNS[pageType];
  if (!patterns || patterns.length === 0) {
    logger.warn(`No URL patterns found for page type: ${pageType}`);
    return '/';
  }
  
  // Use the first pattern and replace any parameters
  const selectedPattern = patterns[0];
  const resolvedUrl = replaceParameters(selectedPattern);
  
  logger.info(`Resolved URL: ${resolvedUrl} (page type: ${pageType})`);
  return resolvedUrl;
}

/**
 * Get all possible URL patterns for a page type
 */
export function getPossibleUrls(pageType: string): string[] {
  const patterns = URL_PATTERNS[pageType] || [];
  return patterns.map(pattern => replaceParameters(pattern));
}

/**
 * Suggest URLs based on partial description
 */
export function suggestUrls(description: string): string[] {
  const suggestions: string[] = [];
  const lowerDesc = description.toLowerCase();
  const matchedTypes = new Set<string>();
  
  // Collect all matches with their keyword lengths
  const matches: Array<{ pageType: string; keyword: string; length: number }> = [];
  
  for (const [pageType, keywords] of Object.entries(KEYWORD_MAPPINGS)) {
    for (const keyword of keywords) {
      if (lowerDesc.includes(keyword)) {
        matches.push({ pageType, keyword, length: keyword.length });
      }
    }
  }
  
  // Sort by keyword length to prioritize more specific matches
  matches.sort((a, b) => b.length - a.length);
  
  // Add suggestions from matched page types (avoiding duplicates)
  for (const match of matches) {
    if (!matchedTypes.has(match.pageType)) {
      const urls = getPossibleUrls(match.pageType);
      suggestions.push(...urls);
      matchedTypes.add(match.pageType);
    }
  }
  
  // Remove duplicates and limit suggestions
  return [...new Set(suggestions)].slice(0, 5);
}

/**
 * Validate if a URL pattern is valid
 */
export function isValidUrlPattern(url: string): boolean {
  // Basic validation for URL patterns
  return /^\/[\w\-\/\{\}\.\?\&\=\#]*$/.test(url);
}

/**
 * Add custom URL patterns at runtime
 */
export function addCustomPattern(pageType: string, patterns: string[]): void {
  if (!URL_PATTERNS[pageType]) {
    URL_PATTERNS[pageType] = [];
  }
  URL_PATTERNS[pageType].push(...patterns);
  logger.info(`Added ${patterns.length} custom patterns for page type: ${pageType}`);
}

/**
 * Add custom keyword mappings at runtime
 */
export function addCustomKeywords(pageType: string, keywords: string[]): void {
  if (!KEYWORD_MAPPINGS[pageType]) {
    KEYWORD_MAPPINGS[pageType] = [];
  }
  KEYWORD_MAPPINGS[pageType].push(...keywords);
  logger.info(`Added ${keywords.length} custom keywords for page type: ${pageType}`);
}