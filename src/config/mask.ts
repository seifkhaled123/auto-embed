export function maskKey(key: string | undefined): string {
  if (!key) return "(unset)";
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function maskUrl(url: string | undefined): string {
  if (!url) return "(unset)";
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    if (u.username && u.username.length > 4) u.username = u.username.slice(0, 2) + "…";
    return u.toString();
  } catch {
    return url.length > 8 ? `${url.slice(0, 4)}…${url.slice(-4)}` : "***";
  }
}
