const { createLogger } = require('../src/services/logger');

describe('logger', () => {
  let output;
  let logger;

  beforeEach(() => {
    output = [];
    logger = createLogger({ write: (line) => output.push(JSON.parse(line)) });
  });

  test('outputs JSON with CDT timestamp', () => {
    logger.info('test message');
    expect(output).toHaveLength(1);
    expect(output[0].message).toBe('test message');
    expect(output[0].level).toBe('info');
    expect(output[0].timestamp).toMatch(/T\d{2}:\d{2}:\d{2}-05:00$/);
  });

  test('includes context fields', () => {
    logger.info('loading', { invoiceId: 40, platform: 'PLAY777' });
    expect(output[0].context.invoiceId).toBe(40);
    expect(output[0].context.platform).toBe('PLAY777');
  });

  test('error level includes stack', () => {
    const err = new Error('boom');
    logger.error('failed', { error: err });
    expect(output[0].level).toBe('error');
    expect(output[0].context.error).toContain('boom');
  });

  test('child logger inherits context', () => {
    const child = logger.child({ invoiceId: 42 });
    child.info('step done', { step: 'LOGIN' });
    expect(output[0].context.invoiceId).toBe(42);
    expect(output[0].context.step).toBe('LOGIN');
  });
});
