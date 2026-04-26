import { createLogger } from '@archon/paths';

export function createLazyLogger(moduleName: string): () => ReturnType<typeof createLogger> {
  let cachedLog: ReturnType<typeof createLogger> | undefined;
  return () => {
    if (!cachedLog) cachedLog = createLogger(moduleName);
    return cachedLog;
  };
}
