export async function aiRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.message ?? "This request could not finish. Please try again.",
    );
  return data;
}
export async function generate(
  path: string,
  content: string,
  key: string,
  delta: (text: string) => void,
) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, requestKey: key }),
  });
  if (!response.ok)
    throw new Error((await response.json()).message ?? "Generation failed.");
  if (response.headers.get("content-type")?.includes("application/json"))
    return;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneEvent = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const event = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (event.type === "delta") delta(event.content);
        if (event.type === "done") doneEvent = true;
        if (event.type === "error") throw new Error(event.message);
      }
    }
    if (!doneEvent)
      throw new Error(
        "Connection interrupted. Check for the saved result before sending again.",
      );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
