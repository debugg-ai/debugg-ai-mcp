/**
 * Shared pagination helpers for list_* tools. Every list tool must expose
 * {page?, pageSize?} inputs and return a consistent pageInfo object so
 * callers never silently get truncated results.
 */

export interface PaginationInput {
  page?: number;
  pageSize?: number;
}

export interface PageInfo {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasMore: boolean;
}

export interface PaginatedResult<T> {
  pageInfo: PageInfo;
  items: T[];
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 200;

/**
 * Translate caller inputs into safe backend query params.
 * Defaults page=1, pageSize=20. Clamps pageSize to [1, MAX_PAGE_SIZE=200].
 * Returns snake_case keys matching the backend's `?page=&page_size=` convention.
 */
export function toPaginationParams(input: PaginationInput): { page: number; pageSize: number } {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(input.pageSize ?? DEFAULT_PAGE_SIZE)));
  return { page, pageSize };
}

/**
 * Build the pageInfo block for the MCP response from the backend's
 * DRF-style list envelope (count + next + previous).
 */
export function makePageInfo(
  page: number,
  pageSize: number,
  count: number,
  next: string | null | undefined,
): PageInfo {
  const totalCount = count ?? 0;
  const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / pageSize);
  return {
    page,
    pageSize,
    totalCount,
    totalPages,
    hasMore: !!next,
  };
}
