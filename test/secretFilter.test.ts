import { describe, expect, test } from 'bun:test';
import { containsSecret, filterSensitiveData } from '../src/utils/secretFilter';

describe('secretFilter', () => {
  describe('filterSensitiveData', () => {
    test('removes export PASSWORD= lines', () => {
      const input = 'export DB_PASSWORD=supersecret\nsome normal text';
      const result = filterSensitiveData(input);
      expect(result).not.toContain('supersecret');
      expect(result).toContain('some normal text');
    });

    test('removes export TOKEN= lines', () => {
      const input = 'export API_TOKEN=abc123xyz\nfoo';
      expect(filterSensitiveData(input)).not.toContain('abc123xyz');
    });

    test('removes bearer tokens', () => {
      const input = 'Authorization: bearer eyJhbGciOiJIUzI1NiJ9';
      expect(filterSensitiveData(input)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    });

    test('removes Slack tokens', () => {
      const input = 'token: xoxb-12345-67890-abcdef';
      expect(filterSensitiveData(input)).not.toContain('xoxb-12345-67890-abcdef');
    });

    test('removes GitHub tokens', () => {
      const input = 'ghp_ABCdefGHIjklMNOpqrSTUvwxYZ123456';
      expect(filterSensitiveData(input)).not.toContain('ghp_ABCdefGHIjklMNOpqrSTUvwxYZ123456');
    });

    test('removes lines containing password keyword', () => {
      const input = 'db_password = mypassword\nnormal line';
      const result = filterSensitiveData(input);
      expect(result).not.toContain('mypassword');
      expect(result).toContain('normal line');
    });

    test('removes lines containing secret_key keyword', () => {
      const input = 'secret_key = abc\nother';
      expect(filterSensitiveData(input)).not.toContain('abc');
    });

    test('removes lines containing auth_token keyword', () => {
      const input = 'auth_token = xyz\nother';
      expect(filterSensitiveData(input)).not.toContain('xyz');
    });

    test('removes PEM private key header', () => {
      const input = '-----BEGIN PRIVATE KEY-----\nMIIEv...';
      expect(filterSensitiveData(input)).not.toContain('BEGIN PRIVATE KEY');
    });

    test('preserves normal content', () => {
      const input = 'Hello, world!\nThis is normal text with no secrets.';
      expect(filterSensitiveData(input)).toBe(input);
    });
  });

  describe('containsSecret', () => {
    test('detects bearer token', () => {
      expect(containsSecret('Authorization: bearer abc123')).toBe(true);
    });

    test('detects password assignment', () => {
      expect(containsSecret('password: hunter2')).toBe(true);
    });

    test('returns false for normal line', () => {
      expect(containsSecret('This is a normal sentence.')).toBe(false);
    });
  });
});
