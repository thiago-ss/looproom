import { Alert } from "./arc/alert/alert";
import { useState, type DragEvent } from "react";
import { FolderOpen, ArrowDownToLine, Check, X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { api } from "../lib/api";
export default function FolderPicker({
  value,
  onChange,
  mode,
}: {
  value: string;
  onChange: (value: string) => void;
  mode: string;
}) {
  const [dragging, setDragging] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function choose() {
    setBusy(true);
    setError("");
    try {
      const result = await api("/folders/choose", { initial: value });
      if (result.path)
        onChange(
          mode === "new"
            ? result.path.replace(/\/$/, "") + "/my-app"
            : result.path,
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function drop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    setError("");
    setBusy(true);
    try {
      const files = Array.from(e.dataTransfer.files);
      const rawURI = e.dataTransfer
        .getData("text/uri-list")
        .split("\n")
        .find((line) => line && !line.startsWith("#"))
        ?.trim();
      const entries = Array.from(e.dataTransfer.items)
        .map((item) => item.webkitGetAsEntry?.())
        .filter(Boolean);
      if (entries.some((entry) => !entry!.isDirectory))
        throw new Error("Drop a folder, rather than a file.");
      const names = files.length
        ? files.map((file) => file.name)
        : entries.map((entry) => entry!.name);
      if (!names.length && rawURI)
        names.push(
          decodeURIComponent(new URL(rawURI).pathname)
            .split("/")
            .filter(Boolean)
            .at(-1)!,
        );
      const result = await api("/folders/drop", { names, uri: rawURI });
      if (result.path)
        onChange(
          mode === "new"
            ? result.path.replace(/\/$/, "") + "/my-app"
            : result.path,
        );
      else {
        setBusy(false);
        await choose();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="folder-field">
      <div
        className={`folder-drop ${dragging ? "dragging" : ""} ${value ? "has-folder" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node))
            setDragging(false);
        }}
        onDrop={drop}
      >
        <div className="folder-emblem">
          <FolderOpen size={30} />
          <span>
            {value ? <Check size={11} /> : <ArrowDownToLine size={11} />}
          </span>
        </div>
        <strong>
          {dragging
            ? "Drop it here"
            : value
              ? value.split("/").filter(Boolean).at(-1)
              : "Bring your project in"}
        </strong>
        <p>
          {busy
            ? "Opening the macOS folder picker…"
            : "Drag a folder from Finder, or choose one below."}
        </p>
        <Button variant="outline" disabled={busy} onClick={choose}>
          <FolderOpen size={15} />
          {value
            ? "Change folder"
            : mode === "new"
              ? "Choose parent folder"
              : "Choose folder"}
        </Button>
        <small>Your files stay on this Mac</small>
      </div>
      <div className="folder-path-row">
        <Input
          id="repo-path"
          label={mode === "new" ? "New project folder" : "Repository folder"}
          aria-label={
            mode === "new" ? "New project folder" : "Repository folder"
          }
          placeholder="Or enter a folder path"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {value ? (
          <Button
            size="icon"
            variant="ghost"
            aria-label="Clear folder"
            onClick={() => onChange("")}
          >
            <X size={14} />
          </Button>
        ) : null}
      </div>
      {mode === "new" ? (
        <p className="field-help">
          Choose its parent folder, then edit the new project folder name in the
          path.
        </p>
      ) : null}
      {error ? <Alert tone="danger" title={error} /> : null}
    </div>
  );
}
