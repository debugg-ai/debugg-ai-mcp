import { describe, test, expect } from '@jest/globals';
import { extractQuotes, checkReportQuotes } from '../../utils/reportCheck.js';

describe('extractQuotes', () => {
  test('straight and curly quotes, de-duplicated, short ones ignored', () => {
    expect(extractQuotes('The text reads "Today" and “Next steps” and "Next steps" and "ab".')).toEqual(['Today', 'Next steps']);
  });
});

describe('checkReportQuotes', () => {
  const page = 'Library\nEverything Tandem has pulled in.\n  Summary ’s\nAsks';
  test('splits quotes into found and not found (case, spacing and curly apostrophes normalised)', () => {
    const r = checkReportQuotes('It shows "everything  tandem has pulled in." and "Next steps" and "N to-dos are in Plan".', page)!;
    expect(r.quotesFound).toEqual(['everything  tandem has pulled in.']);
    expect(r.quotesNotFound).toEqual(['Next steps', 'N to-dos are in Plan']);
  });
  test('nothing to check: no report, no quotes, a JSON report, or no page text', () => {
    expect(checkReportQuotes(undefined, page)).toBeUndefined();
    expect(checkReportQuotes('No quotes here.', page)).toBeUndefined();
    expect(checkReportQuotes('{"pageHeading":"Library"}', page)).toBeUndefined();
    expect(checkReportQuotes('It says "Library".', undefined)).toBeUndefined();
  });
});
