type ConsoleMethod = 'log' | 'error' | 'warn' | 'info';

export function mockConsoleOutput(methods: ConsoleMethod[] = ['log', 'error', 'warn', 'info']) {
  const originalMethods: Partial<Console> = {};

  beforeAll(() => {
    methods.forEach(method => {
      originalMethods[method] = console[method];
      console[method] = jest.fn();
    });
  });

  afterAll(() => {
    methods.forEach(method => {
      console[method] = originalMethods[method] as Console[ConsoleMethod];
    });
  });
}