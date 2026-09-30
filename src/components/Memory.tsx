import { useMemo, useRef, useState, type FormEvent } from "react";
import Markdown from "react-markdown";
import {
  Search,
  FileText,
  ArrowUpRight,
  Link2,
  BookOpen,
  Network,
  X,
  Copy,
  Check,
  ChevronRight,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { api } from "../lib/api";
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
    !/^(orchestrator|implementation|review|research) outcome$/i.test(page.title)
  )
    return page.title;
  const sentence = excerpt(page.content).split(/(?<=[.!?])\s/)[0];
  return sentence.length > 90
    ? sentence.slice(0, 86).replace(/\s+\S*$/, "") + "…"
    : sentence;
}
function teaser(page: any) {
  const rest = /^(orchestrator|implementation|review|research) outcome$/i.test(
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
    [results, setResults] = useState<any[] | null>(null),
    [selected, setSelected] = useState(""),
    [view, setView] = useState("library"),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [copied, setCopied] = useState(false),
    [sourceFilter, setSourceFilter] = useState("");
  const request = useRef(0);
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
  const visible = (results ?? all).filter(
    (page) =>
      !sourceFilter ||
      page.sources?.some(
        (source: string) => sourceTarget(source) === sourceFilter,
      ),
  );
  const page = visible.find((page) => page.id === selected) ?? visible[0];
  async function search(event: FormEvent) {
    event.preventDefault();
    const version = ++request.current;
    if (!query.trim()) {
      setResults(null);
      setError("");
      return;
    }
    setPending(true);
    setSourceFilter("");
    try {
      const next = await api(
        "/projects/" + project.id + "/memory?q=" + encodeURIComponent(query),
      );
      if (version === request.current) {
        setResults(next);
        setSelected("");
        setError("");
      }
    } catch (e) {
      if (version === request.current) setError((e as Error).message);
    } finally {
      if (version === request.current) setPending(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(page.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copy is unavailable in this browser.");
    }
  }
  return (
    <section className="page memory-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">The project archive</p>
          <h1>Memory</h1>
          <p>What we found. What we tried. What comes next.</p>
        </div>
        <span className="memory-durability">
          <span />
          <span>Saved on your Mac</span>
        </span>
      </div>
      <div className="memory-toolbar">
        <form onSubmit={search} className="memory-search-field">
          <Search size={17} />
          <Input
            aria-label="Search project memory"
            placeholder="Find a decision, source, or outcome…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value) {
                ++request.current;
                setResults(null);
                setPending(false);
              }
            }}
          />
          {query ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Clear search"
              onClick={() => {
                ++request.current;
                setQuery("");
                setResults(null);
                setPending(false);
              }}
            >
              <X size={14} />
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            type="submit"
            disabled={pending}
          >
            {pending ? "Searching…" : "Search"}
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
      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
      <div className="memory-summary">
        <span>
          <strong>{all.length}</strong> recorded outcomes
        </span>
        <span>
          <strong>{sourceGroups.length}</strong> cited sources
        </span>
        <span className="mono">SQLite FTS5 / LLM wiki</span>
      </div>
      {view === "connections" ? (
        <div className="source-atlas">
          <div className="source-atlas-intro">
            <Link2 size={26} />
            <h2>Follow the evidence</h2>
            <p>
              Explore the sources connecting your project’s recorded outcomes.
            </p>
          </div>
          {sourceGroups.map(([source, records]) => (
            <Button
              key={source}
              variant="ghost"
              className="source-atlas-card"
              onClick={() => {
                setSourceFilter(source);
                setResults(null);
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
          {visible.length ? (
            <div
              className={`memory-library ${selected ? "has-selection" : ""}`}
            >
              <div className="memory-shelf" aria-label="Recorded outcomes">
                <div className="shelf-heading">
                  <span>
                    {results
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
                      setCopied(false);
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
                  <Badge variant="outline">
                    <FileText size={12} />
                    Agent-reported outcome
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={copied ? "Copied" : "Copy memory"}
                    onClick={copy}
                  >
                    {copied ? <Check size={15} /> : <Copy size={15} />}
                  </Button>
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
                <div className="memory-evidence-note">
                  <span className="evidence-bracket">[ ]</span>
                  <p>
                    Agent reports preserve findings. Check results and human
                    approvals remain separate evidence in Work and Review.
                  </p>
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
            <div className="memory-empty">
              <div className="archive-illustration" aria-hidden="true">
                <span />
                <span />
                <span />
                <BookOpen size={30} />
              </div>
              <h2>
                {results
                  ? "No matches yet"
                  : "A library that grows with the work"}
              </h2>
              <p>
                {results
                  ? "Try a different term, or clear your search to browse all outcomes."
                  : "Completed agent runs become source-linked outcomes here. Your project’s knowledge survives the next restart."}
              </p>
              {results ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setResults(null);
                    setQuery("");
                  }}
                >
                  Browse all memory
                </Button>
              ) : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}
