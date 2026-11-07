interface ModelBindingClient {
  setModel(provider: string, modelId: string): Promise<unknown>;
  getState(): Promise<{ model?: { provider: string; id: string } }>;
}

/** Bind qualified overrides before execution; unqualified IDs retain legacy CLI resolution. */
export async function verifyQualifiedModelBinding(client: ModelBindingClient, model?: string, timeoutMs = 30_000): Promise<void> {
  if (!model?.includes('/')) return;
  const slash = model.indexOf('/');
  const provider = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  if (!provider || !modelId) throw new Error('Expected provider/model for a qualified model override');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await client.setModel(provider, modelId);
        const selected = await client.getState();
        if (selected.model?.provider !== provider || selected.model?.id !== modelId) {
          throw new Error('Explicit provider/model was not selected; refusing to start execution');
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Explicit model binding timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
