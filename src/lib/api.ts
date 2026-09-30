export async function api<T = any>(path: string, body?: any): Promise<T> {
  const response = await fetch("/api" + path, {
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Looproom-Client": "ui",
          },
          body: JSON.stringify(body),
        }),
  });
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      "The local coordinator is unavailable. Restart Looproom and try again.",
    );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed.");
  return data;
}
export type Data = {
  projects: any[];
  tasks: any[];
  gates: any[];
  messages: any[];
  runs: any[];
  memory: any[];
  events: any[];
  settings: any;
  runtime: any;
};
