const allowed = new Set([
  "/",
  "/library",
  "/practice",
  "/voice",
  "/history",
  "/settings",
]);
export function safeReturnPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020]/.test(value)
  )
    return "/";
  try {
    const url = new URL(value, "https://study.invalid");
    if (url.origin !== "https://study.invalid") return "/";
    if (
      !allowed.has(url.pathname) &&
      !/^\/(study|recap)\/[a-zA-Z0-9-]+$/.test(url.pathname)
    )
      return "/";
    return url.pathname;
  } catch {
    return "/";
  }
}
