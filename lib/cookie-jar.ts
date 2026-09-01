export class CookieJar {
  private readonly cookies = new Map<string, string>();

  set(name: string, value: string) {
    this.cookies.set(name, value);
  }

  async fetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set(
        "cookie",
        [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    this.capture(response.headers);
    return response;
  }

  private capture(headers: Headers) {
    const headerWithSetCookie = headers as Headers & { getSetCookie?: () => string[] };
    const values = typeof headerWithSetCookie.getSetCookie === "function"
      ? headerWithSetCookie.getSetCookie()
      : splitSetCookie(headers.get("set-cookie"));
    for (const header of values) {
      const firstPart = header.split(";", 1)[0];
      const separator = firstPart.indexOf("=");
      if (separator <= 0) continue;
      const name = firstPart.slice(0, separator).trim();
      const value = firstPart.slice(separator + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }
}

function splitSetCookie(header: string | null): string[] {
  if (!header) return [];
  return header.split(/,(?=[^;,]+=)/g);
}
