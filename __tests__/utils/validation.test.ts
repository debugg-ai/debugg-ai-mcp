import { validateInput, sanitizeFilePath, validatePort, commonSchemas } from '../../utils/validation.js';
import { z } from 'zod';
import { faker } from '@faker-js/faker';
import { MCPError } from '../../types/index.js';

describe('Input Validation and Sanitization', () => {
  const mockSchema = z.object({
    name: z.string().min(3).max(50),
    email: z.string().email(),
    age: z.number().min(18).max(120).optional()
  });

  test('validateInput handles valid input', () => {
    const validInput = {
      name: faker.person.fullName(),
      email: faker.internet.email(),
      age: faker.number.int({ min: 18, max: 120 })
    };

    const result = validateInput(mockSchema, validInput);
    
    expect(result).toEqual(validInput);
  });

  test('validateInput rejects invalid input', () => {
    const invalidInput = {
      name: 'a', // Too short
      email: 'not-an-email',
      age: 15 // Below minimum age
    };

    expect(() => {
      validateInput(mockSchema, invalidInput);
    }).toThrow(MCPError);
  });

  test('sanitizeFilePath removes dangerous patterns', () => {
    const dangerousPath = '../../../etc/passwd';
    const sanitized = sanitizeFilePath(dangerousPath);
    
    expect(sanitized).toBe('etc/passwd');
    expect(sanitized).not.toContain('..');
  });

  test('sanitizeFilePath removes invalid characters', () => {
    const invalidPath = 'file<>:"|?*.txt';
    const sanitized = sanitizeFilePath(invalidPath);
    
    expect(sanitized).toBe('file.txt');
  });

  test('validatePort accepts valid port numbers', () => {
    expect(validatePort(3000)).toBe(3000);
    expect(validatePort(8080)).toBe(8080);
    expect(validatePort(65535)).toBe(65535);
  });

  test('validatePort rejects invalid port numbers', () => {
    expect(() => validatePort(0)).toThrow(MCPError);
    expect(() => validatePort(65536)).toThrow(MCPError);
    expect(() => validatePort('invalid')).toThrow(MCPError);
  });

  test('commonSchemas provides useful validation schemas', () => {
    expect(commonSchemas.port.parse(8080)).toBe(8080);
    expect(commonSchemas.url.parse('https://example.com')).toBe('https://example.com');
    expect(commonSchemas.description.parse('Test description')).toBe('Test description');
    
    expect(() => commonSchemas.description.parse('')).toThrow();
  });
});