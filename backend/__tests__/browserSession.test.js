const { serializeCookies, deserializeCookies } = require('../src/services/browserSession');

describe('browserSession', () => {
  test('serializeCookies converts cookie array to JSON string', () => {
    const cookies = [
      { name: 'session', value: 'abc123', domain: '.example.com', path: '/' },
    ];
    const result = serializeCookies(cookies);
    expect(typeof result).toBe('string');
    const parsed = JSON.parse(result);
    expect(parsed[0].name).toBe('session');
  });

  test('deserializeCookies converts JSON string back to array', () => {
    const json = JSON.stringify([{ name: 'token', value: 'xyz' }]);
    const result = deserializeCookies(json);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('token');
  });

  test('deserializeCookies returns empty array for null', () => {
    expect(deserializeCookies(null)).toEqual([]);
  });

  test('deserializeCookies returns empty array for invalid JSON', () => {
    expect(deserializeCookies('not json')).toEqual([]);
  });
});
