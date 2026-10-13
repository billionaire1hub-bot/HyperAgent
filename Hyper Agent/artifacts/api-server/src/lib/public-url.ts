/** Public https origin of this deployment (Railway injects RAILWAY_PUBLIC_DOMAIN). */
export function getPublicBaseUrl(): string | null {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  const candidate = configured || (railway ? `https://${railway}` : "");
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}
