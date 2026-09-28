export class ServiceCOriginError extends Error {}

/** Only configured or Vercel-provided domains may become authentication audiences. */
export function serviceCOrigin(environment: NodeJS.ProcessEnv, requestHost?: string): string {
  const production = environment.VERCEL_ENV === "production" ? environment.VERCEL_PROJECT_PRODUCTION_URL : undefined;
  const values = [environment.SERVICE_C_ORIGIN, production ? `https://${production}` : undefined,
    environment.VERCEL_URL ? `https://${environment.VERCEL_URL}` : undefined].filter((value): value is string => !!value);
  if (!values.length && !environment.VERCEL) values.push("http://127.0.0.1:8807");
  if (!values.length) throw new Error("Configure SERVICE_C_ORIGIN");
  const origins = values.map(value => {
    const origin = new URL(value);
    const local = !environment.VERCEL && origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname);
    if ((!local && origin.protocol !== "https:") || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/")
      throw new Error("SERVICE_C_ORIGIN must be a canonical HTTPS origin (loopback HTTP only for local runs)");
    return origin.origin;
  });
  if (!requestHost) return origins[0];
  const origin = origins.find(value => new URL(value).host === requestHost);
  if (!origin) throw new ServiceCOriginError("Use the configured Service C origin");
  return origin;
}
