/** Yields to the event loop so long scans never starve the extension host. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
