/** Transport configuration is part of the operating environment, not provider authentication. */
const PROXY_NAMES = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy"] as const;

/** Keep both spellings: clients differ in which proxy variables they honor. */
export function proxyEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PROXY_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function decoded(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Diagnostics can echo a proxy URL, its userinfo, or decoded credentials separately. */
export function proxySecrets(): string[] {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(proxyEnvironment())) {
    if (name.toLowerCase() === "no_proxy" || value === "") continue;
    try {
      const url = new URL(value.includes("://") ? value : `http://${value}`);
      if (url.username === "" && url.password === "") continue;
      secrets.add(value);
      secrets.add(url.href);
      for (const credential of [url.username, url.password]) {
        if (credential !== "") { secrets.add(credential); secrets.add(decoded(credential)); }
      }
      const userinfo = `${decoded(url.username)}:${decoded(url.password)}`;
      secrets.add(userinfo);
      secrets.add(Buffer.from(userinfo).toString("base64"));
    } catch {
      // Invalid proxy settings must still be forwarded for native diagnostics,
      // but an echoed credential-bearing value must never reach a record.
      if (value.includes("@")) secrets.add(value);
    }
  }
  return [...secrets].sort((left, right) => right.length - left.length);
}
