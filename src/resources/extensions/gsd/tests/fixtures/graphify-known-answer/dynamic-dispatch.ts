type Handler = (value: string) => string;

const registry: Record<string, Handler> = {};

export function invokeByName(name: string, value: string): string | null {
  const handler = registry[name];
  return handler ? handler(value) : null;
}
