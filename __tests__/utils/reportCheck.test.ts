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
    expect(checkReportQuotes('{"pageHeading":"Library","ok":true}', page)).toBeUndefined();   // short values are flags, nothing to check
    expect(checkReportQuotes('It says "Library".', undefined)).toBeUndefined();
  });
});

describe('checkReportQuotes: JSON reports', () => {
  const page = 'Pattern sections\nR1 6 sc in a magic ring Change to leaf green.\nInstructions';
  test('string values of 12+ chars are checked; an invented or paraphrased value is flagged', () => {
    const r = checkReportQuotes(JSON.stringify({ h1: 'ok', instructionsHeadingExists: false, count: 18, firstRow: 'Round 1: 6 sc in a magic ring (6)', sections: ['Pattern sections'] }), page)!;
    expect(r.quotesFound).toEqual(['Pattern sections']);
    expect(r.quotesNotFound).toEqual(['Round 1: 6 sc in a magic ring (6)']);
  });
  test('a JSON report with no long string values, or invalid JSON, has nothing to check', () => {
    expect(checkReportQuotes('{"a":1,"b":"ok"}', page)).toBeUndefined();
    expect(checkReportQuotes('{not json', page)).toBeUndefined();
  });
});
