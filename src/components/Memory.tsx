import { EmptyState } from "./arc/empty-state/empty-state";
import { Alert } from "./arc/alert/alert";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import Markdown from "react-markdown";
import {
  Search,
  FileText,
  ArrowUpRight,
  Link2,
  BookOpen,
  Network,
  X,
  ChevronRight,
  CircleHelp,
} from "lucide-react";
import { Button } from "./ui/button";
import { SearchField } from "./arc/search-field/search-field";
import { CopyButton } from "./arc/copy-button/copy-button";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip } from "./ui/tooltip";
import { api } from "../lib/api";
import { MemorySearchSession } from "../lib/memory-search";
import { DotmSquare3 } from "./ui/dotm-square-3";
function excerpt(content: string) {
  return content
    .replace(/[#*`>[\]]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 160);
}
function sourceTarget(source: string) {
  return source.match(/\]\((.+)\)$/)?.[1] ?? source;
}
function sourceName(source: string) {
  const target = sourceTarget(source);
  try {
    return new URL(target).hostname;
  } catch {
    return target.split("/").filter(Boolean).at(-1) ?? target;
  }
}
function headline(page: any) {
  if (
    !/^(orchestrator|implementation|review|research|judge) outcome$/i.test(
      page.title,
    )
  )
    return page.title;
  const sentence = excerpt(page.content).split(/(?<=[.!?])\s/)[0];
  return sentence.length > 90
    ? sentence.slice(0, 86).replace(/\s+\S*$/, "") + "…"
    : sentence;
}
function teaser(page: any) {
  const rest =
    /^(orchestrator|implementation|review|research|judge) outcome$/i.test(
      page.title,
    )
      ? page.content
          .split(/(?<=[.!?])\s/)
          .slice(1)
          .join(" ")
      : page.content;
  return rest.length > 160
    ? excerpt(rest).replace(/\s+\S*$/, "") + "…"
    : excerpt(rest);
}
function date(value: string) {
  return new Date(value).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}
export default function Memory({ project, pages }: any) {
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState(""),
    [view, setView] = useState("library"),
    [sourceFilter, setSourceFilter] = useState("");
  const [searchSession] = useState(() => new MemorySearchSession<any>(project.id));
  const [storedSearch, setStoredSearch] = useState(searchSession.state);
  const search = storedSearch.projectId === project.id
    ? storedSearch
    : { projectId: project.id, status: "idle" as const };
  useEffect(() => {
    searchSession.switchProject(project.id);
    if (searchSession.state.projectId === project.id) setStoredSearch(searchSession.state);
    return () => searchSession.dispose();
  }, [project.id, searchSession]);
  const all = useMemo(
    () => [...pages].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [pages],
  );
  const sourceGroups = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const page of all)
      for (const source of new Set<string>(
        (page.sources ?? []).map(sourceTarget),
      )) {
        const group = groups.get(source) ?? [];
        group.push(page);
        groups.set(source, group);
      }
    return [...groups].sort((a, b) => b[1].length - a[1].length);
  }, [all]);
  const results = search.status === "success" ? search.results : null;
  const visible = (search.status === "idle" ? all : results ?? []).filter(
    (page) =>
      !sourceFilter ||
      page.sources?.some(
        (source: string) => sourceTarget(source) === sourceFilter,
      ),
  );
  const page = visible.find((page) => page.id === selected) ?? visible[0];
  function runSearch() {
    if (!query.trim()) {
      setStoredSearch(searchSession.clear());
      return;
    }
    setSourceFilter("");
    setSelected("");
    void searchSession.search(
      project.id,
      query.trim(),
      (projectId, term) => api(
        "/projects/" + projectId + "/memory?q=" + encodeURIComponent(term),
      ),
      setStoredSearch,
    );
  }
  function submitSearch(event: FormEvent) {
    event.preventDefault();
    runSearch();
  }
  return (
    <section className="page memory-page">
      <h1 className="sr-only">Memory</h1>

      <div className="memory-toolbar">
        <form onSubmit={submitSearch} className="memory-search-field" aria-busy={search.status === "pending"}>
          <SearchField
            label="Search project memory"
            placeholder="Find a decision, source, or outcome…"
            value={query}
            onValueChange={(value) => {
              setQuery(value);
              if (value !== query) {
                setStoredSearch(searchSession.clear());
              }
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            type="submit"
          >
            {search.status === "pending" ? "Searching…" : "Search"}
          </Button>
        </form>
        <Tabs value={view} onValueChange={setView}>
          <TabsList>
            <TabsTrigger value="library">
              <BookOpen size={14} />
              Library
            </TabsTrigger>
            <TabsTrigger value="connections">
              <Network size={14} />
              Sources
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {search.status === "pending" ? (
        <p className="pending" role="status">
          <DotmSquare3 size={18} dotSize={3} color="var(--lr-signal)" />
          <span>Searching {project.name} memory…</span>
        </p>
      ) : null}
      {search.status === "error" ? (
        <div className="memory-search-error" role="alert">
          <p>Search failed: {search.message}</p>
          <Button variant="outline" onClick={runSearch}>Retry search</Button>
        </div>
      ) : null}
      <div className="memory-summary">
        <span>
          <strong>{all.length}</strong> recorded outcomes
        </span>
        <span>
          <strong>{sourceGroups.length}</strong> cited sources
        </span>
      </div>
      {view === "connections" ? (
        <div className="source-atlas">
          <div className="source-atlas-intro">
            <Link2 size={26} />
          </div>
          {sourceGroups.map(([source, records]) => (
            <Button
              key={source}
              variant="ghost"
              className="source-atlas-card"
              onClick={() => {
                setSourceFilter(source);
                setStoredSearch(searchSession.clear());
                setQuery("");
                setView("library");
                setSelected(records[0].id);
              }}
            >
              <span className="source-tile">
                <Link2 size={17} />
              </span>
              <span>
                <strong>{sourceName(source)}</strong>
                <small>
                  {records.length}{" "}
                  {records.length === 1 ? "outcome cites" : "outcomes cite"}{" "}
                  this source
                </small>
                <span className="source-original mono">{source}</span>
              </span>
              <ChevronRight size={17} />
            </Button>
          ))}
          {!sourceGroups.length ? (
            <p className="muted">
              No sources have been cited yet. They will appear after a completed
              run.
            </p>
          ) : null}
        </div>
      ) : (
        <>
          {sourceFilter ? (
            <div className="memory-filter">
              <Link2 size={14} />
              <span>{sourceName(sourceFilter)}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Clear source filter"
                onClick={() => setSourceFilter("")}
              >
                <X size={13} />
              </Button>
            </div>
          ) : null}
          {search.status === "pending" || search.status === "error" ? null : visible.length ? (
            <div
              className={`memory-library ${selected ? "has-selection" : ""}`}
            >
              <div className="memory-shelf" aria-label="Recorded outcomes">
                <div className="shelf-heading">
                  <span>
                    {search.status === "success"
                      ? "Search results"
                      : sourceFilter
                        ? "Related outcomes"
                        : "Latest knowledge"}
                  </span>
                  <span>{visible.length}</span>
                </div>
                {visible.map((record: any, i: number) => (
                  <Button
                    key={record.id}
                    variant="ghost"
                    className={`memory-card ${page?.id === record.id ? "is-selected" : ""}`}
                    aria-pressed={page?.id === record.id}
                    onClick={() => {
                      setSelected(record.id);
                    }}
                  >
                    <span className="memory-card-top">
                      <span className="mono">
                        {String(i + 1).padStart(2, "0")} / Outcome
                      </span>
                      <time dateTime={record.createdAt}>
                        {date(record.createdAt)}
                      </time>
                    </span>
                    <strong>{headline(record)}</strong>
                    <p>{teaser(record)}</p>
                    <span className="memory-card-footer">
                      <span>
                        <Link2 size={12} />
                        {record.sources?.length ?? 0} sources
                      </span>
                      <ArrowUpRight size={14} />
                    </span>
                  </Button>
                ))}
              </div>
              <article className="memory-reader" aria-label="Selected memory">
                <div className="reader-top">
                  <Tooltip
                    content={
                      <>
                        Agent report. Verified checks and approvals are recorded
                        in Work and Review.
                      </>
                    }
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      className="outcome-provenance"
                    >
                      <FileText size={12} /> Agent outcome{" "}
                      <CircleHelp size={13} />
                    </Button>
                  </Tooltip>
                  <CopyButton
                    key={page.id}
                    value={page.content}
                    label="Copy memory"
                    iconOnly
                    variant="plain"
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="reader-back"
                    aria-label="Back to memory library"
                    onClick={() => setSelected("")}
                  >
                    <X size={15} />
                  </Button>
                </div>
                <h2>{headline(page)}</h2>
                <div className="reader-metadata">
                  <time dateTime={page.createdAt}>
                    {new Date(page.createdAt).toLocaleDateString([], {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </time>
                  <span>·</span>
                  <span>{project.name}</span>
                </div>
                <div className="memory-prose">
                  <Markdown
                    components={{
                      a: ({ href, children }) =>
                        /^https?:\/\//.test(href ?? "") ? (
                          <a href={href} target="_blank" rel="noreferrer">
                            {children}
                          </a>
                        ) : (
                          <span title={href}>{children}</span>
                        ),
                    }}
                  >
                    {page.content}
                  </Markdown>
                </div>

                <div className="reader-sources">
                  <h3>
                    Cited sources <span>{page.sources?.length ?? 0}</span>
                  </h3>
                  {page.sources?.length ? (
                    page.sources.map((source: string, i: number) => (
                      <div key={i} className="reader-source">
                        <span className="mono">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        {/^https?:\/\//.test(sourceTarget(source)) ? (
                          <a
                            href={sourceTarget(source)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {sourceName(source)}
                            <ArrowUpRight size={13} />
                            <small>{source}</small>
                          </a>
                        ) : (
                          <span>
                            <strong>{sourceName(source)}</strong>
                            <small className="mono">{source}</small>
                          </span>
                        )}
                      </div>
                    ))
                  ) : (
                    <p className="muted">
                      No external sources cited in this outcome.
                    </p>
                  )}
                </div>
              </article>
            </div>
          ) : (
            <EmptyState
              className="memory-empty"
              title={
                search.status === "success"
                  ? "No matches yet"
                  : "A library that grows with the work"
              }
              description={
                search.status === "success"
                  ? "Try a different term, or browse all outcomes."
                  : "Agent outcomes and their sources will appear here."
              }
              icon={<BookOpen size={30} />}
              action={
                search.status === "success" ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setStoredSearch(searchSession.clear());
                      setQuery("");
                    }}
                  >
                    Browse all memory
                  </Button>
                ) : undefined
              }
            />
          )}
        </>
      )}
    </section>
  );
}
