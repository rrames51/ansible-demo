function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  log(...args: unknown[]): void {
    console.log(`[${timestamp()}]`, ...args);
  },
  error(...args: unknown[]): void {
    console.error(`[${timestamp()}]`, ...args);
  },
};
