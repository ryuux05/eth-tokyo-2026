export function startServiceCNext(options: { port: number; rpcUrl: string }): Promise<{ baseUrl: string; close(): Promise<void> }>;
