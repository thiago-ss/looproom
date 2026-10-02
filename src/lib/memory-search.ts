export type MemorySearchState<T> =
  | { projectId: string; status: "idle" }
  | { projectId: string; status: "pending" }
  | { projectId: string; status: "success"; results: T[] }
  | { projectId: string; status: "error"; message: string };

export class MemorySearchSession<T> {
  state: MemorySearchState<T>;
  private version = 0;

  constructor(projectId: string) {
    this.state = { projectId, status: "idle" };
  }

  switchProject(projectId: string) {
    if (this.state.projectId === projectId) return;
    this.version++;
    this.state = { projectId, status: "idle" };
  }

  clear() {
    this.version++;
    this.state = { projectId: this.state.projectId, status: "idle" };
    return this.state;
  }

  dispose() {
    this.version++;
  }

  async search(
    projectId: string,
    query: string,
    fetchResults: (projectId: string, query: string) => Promise<T[]>,
    update: (state: MemorySearchState<T>) => void,
  ) {
    this.switchProject(projectId);
    const version = ++this.version;
    update((this.state = { projectId, status: "pending" }));
    try {
      const results = await fetchResults(projectId, query);
      if (version === this.version && this.state.projectId === projectId)
        update((this.state = { projectId, status: "success", results }));
    } catch (error) {
      if (version === this.version && this.state.projectId === projectId)
        update((this.state = {
          projectId,
          status: "error",
          message: error instanceof Error ? error.message : "Search failed.",
        }));
    }
  }
}
