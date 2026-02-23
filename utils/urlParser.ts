/**
 * URL Parser Utilities
 * Helper functions for parsing and validating URLs, specifically for detecting localhost URLs
 */

/**
 * Represents a parsed URL with localhost detection
 */
export interface ParsedUrl {
  originalUrl: string;
  isLocalhost: boolean;
  hostname: string;
  port?: number;
  protocol: string;
  pathname: string;
  search: string;
  hash: string;
}

/**
 * Check if a hostname represents localhost
 */
function isLocalhostHostname(hostname: string): boolean {
  const lowercaseHostname = hostname.toLowerCase();
  return (
    lowercaseHostname === 'localhost' ||
    lowercaseHostname === '127.0.0.1' ||
    lowercaseHostname === '::1' ||
    lowercaseHostname.startsWith('192.168.') ||
    lowercaseHostname.startsWith('10.') ||
    (lowercaseHostname.startsWith('172.') && 
     parseInt(lowercaseHostname.split('.')[1], 10) >= 16 && 
     parseInt(lowercaseHostname.split('.')[1], 10) <= 31)
  );
}

/**
 * Parse a URL and determine if it's a localhost URL
 */
export function parseUrl(urlString: string): ParsedUrl {
  try {
    const url = new URL(urlString);
    const isLocalhost = isLocalhostHostname(url.hostname);
    const port = url.port ? parseInt(url.port, 10) : undefined;

    return {
      originalUrl: urlString,
      isLocalhost,
      hostname: url.hostname,
      port,
      protocol: url.protocol,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash
    };
  } catch (error) {
    throw new Error(`Invalid URL format: ${urlString}`);
  }
}

/**
 * Extract port from localhost URL
 * Returns the port number if it's a localhost URL, otherwise returns undefined
 */
export function extractLocalhostPort(urlString: string): number | undefined {
  try {
    const parsed = parseUrl(urlString);
    if (parsed.isLocalhost) {
      return parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check if a URL is a localhost URL (shorthand function)
 */
export function isLocalhostUrl(urlString: string): boolean {
  try {
    const parsed = parseUrl(urlString);
    return parsed.isLocalhost;
  } catch {
    return false;
  }
}

/**
 * Replace ngrok tunnel URLs with the original localhost origin in any string/object.
 * Used to sanitize backend responses that contain internal tunnel URLs before
 * returning them to callers who only know the original localhost address.
 */
export function replaceTunnelUrls(value: unknown, localhostOrigin: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/https?:\/\/[^\s/"]+\.ngrok\.debugg\.ai/g, localhostOrigin.replace(/\/$/, ''));
  }
  if (Array.isArray(value)) {
    return value.map(item => replaceTunnelUrls(item, localhostOrigin));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = replaceTunnelUrls(v, localhostOrigin);
    }
    return result;
  }
  return value;
}

/**
 * Generate a tunneled URL for a localhost URL
 */
export function generateTunnelUrl(originalUrl: string, tunnelId: string, tunnelDomain: string = 'ngrok.debugg.ai'): string {
  try {
    const parsed = parseUrl(originalUrl);
    if (!parsed.isLocalhost) {
      return originalUrl; // Return original URL if not localhost
    }

    // Create the tunneled URL maintaining the path, search, and hash
    const tunnelUrl = `https://${tunnelId}.${tunnelDomain}${parsed.pathname}${parsed.search}${parsed.hash}`;
    return tunnelUrl;
  } catch {
    return originalUrl; // Return original URL if parsing fails
  }
}