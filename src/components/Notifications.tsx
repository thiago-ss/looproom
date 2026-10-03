import { needsHumanReview } from "../lib/autonomy";
import { useEffect, useState } from "react";
import {
  Bell,
  BellRing,
  Volume2,
  ShieldAlert,
  ExternalLink,
} from "lucide-react";
import { createChimeGate, groupEscalationNotices, recordGateSnapshot } from "../lib/escalations";
import { useToastStack } from "./arc/toast-stack/toast-stack";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
const key = "looproom.notifications.v1",
  seenKey = "looproom.gates.seen.v1";
type Preferences = { sound: boolean; desktop: boolean };
const defaults: Preferences = { sound: true, desktop: false };
function preferences(): Preferences {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(key) ?? "{}") };
  } catch {
    return defaults;
  }
}
let audio: AudioContext | undefined;
const canAutomaticChime = createChimeGate(3000);
export async function chime() {
  if (!("AudioContext" in window))
    throw new Error("Sound is unavailable in this browser.");
  audio ??= new AudioContext();
  await audio.resume();
  if (audio.state !== "running")
    throw new Error("Click Test sound to enable audio in this browser.");
  const start = audio.currentTime;
  [523.25, 659.25].forEach((frequency, index) => {
    const tone = audio!.createOscillator(),
      gain = audio!.createGain();
    tone.type = "sine";
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start + index * 0.13);
    gain.gain.linearRampToValueAtTime(0.055, start + index * 0.13 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + index * 0.13 + 0.38);
    tone.connect(gain);
    gain.connect(audio!.destination);
    tone.start(start + index * 0.13);
    tone.stop(start + index * 0.13 + 0.4);
  });
}
function seen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(seenKey) ?? "[]"));
  } catch {
    return new Set();
  }
}
function writeSeen(ids: Set<string>) {
  localStorage.setItem(seenKey, JSON.stringify([...ids].slice(-2000)));
}
export function useEscalations(
  gates: any[] | undefined,
  projects: any[] | undefined,
  open: (projectId: string) => void,
) {
  const { toast } = useToastStack();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    function unlock() {
      if (preferences().sound && "AudioContext" in window) {
        audio ??= new AudioContext();
        void audio.resume().catch(() => {});
      }
    }
    document.addEventListener("pointerdown", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, []);
  useEffect(() => {
    if (!gates) return;
    if (!ready) {
      const ids = seen();
      recordGateSnapshot(gates, ids, true);
      writeSeen(ids);
      setReady(true);
      return;
    }
    async function deliver() {
      const ids = seen();
      const previousSize = ids.size;
      const fresh = recordGateSnapshot(gates!, ids);
      if (ids.size !== previousSize) writeSeen(ids);
      const notices = groupEscalationNotices(gates!, fresh, projects);
      if (!notices.length) return;
      const prefs = preferences();
      if (prefs.sound && canAutomaticChime(Date.now())) {
        void chime().catch(() => {});
      }
      for (const notice of notices) {
        toast({
          id: "escalations:" + notice.projectId,
          type: "warning",
          title: notice.title,
          description: notice.projectName + " · " + notice.type,
          duration: 12000,
          action: { label: "Review", onClick: () => open(notice.projectId) },
        });
        if (
          prefs.desktop &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          try {
            const notification = new Notification("Looproom · " + notice.projectName, {
              body: notice.title,
              tag: "escalations:" + notice.projectId,
              icon: "/brand/looproom-mark.svg",
              silent: true,
            });
            notification.onclick = () => {
              window.focus();
              open(notice.projectId);
              notification.close();
            };
          } catch {
            /* The in-app inbox remains available when the browser has no notification backend. */
          }
        }
      }
    }
    if (navigator.locks)
      void navigator.locks.request("looproom-escalations", deliver);
    else void deliver();
  }, [gates, projects, ready, open, toast]);
}
export function NotificationCenter({ gates, projects, onOpen }: any) {
  const open = gates.filter((gate: any) =>
    needsHumanReview(
      gate,
      projects?.find((p: any) => p.id === gate.projectId) ?? {},
    ),
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="notification-trigger"
          aria-label={`Notifications, ${open.length} open decisions`}
        >
          <Bell size={17} />
          {open.length ? <span>{open.length}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="notification-inbox">
        <div className="notification-heading">
          <strong>Decisions</strong>
          <span>{open.length} open</span>
        </div>
        {open.length ? (
          open.map((gate: any) => (
            <Button
              variant="ghost"
              className="notification-item"
              key={gate.id}
              onClick={() => onOpen(gate.projectId)}
            >
              <ShieldAlert size={17} />
              <span>
                <strong>{gate.title}</strong>
                <small>
                  {projects.find((p: any) => p.id === gate.projectId)?.name} ·{" "}
                  {gate.type}
                </small>
              </span>
              <ExternalLink size={13} />
            </Button>
          ))
        ) : (
          <div className="notification-empty">
            <BellRing size={22} />
            <p>All clear for now.</p>
            <small>New escalations will appear here.</small>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
export function NotificationSettings() {
  const [prefs, setPrefs] = useState(preferences),
    [permission, setPermission] = useState(() =>
      "Notification" in window ? Notification.permission : "unsupported",
    ),
    [message, setMessage] = useState("");
  function save(patch: Partial<Preferences>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    localStorage.setItem(key, JSON.stringify(next));
  }
  async function desktop(enabled: boolean) {
    if (!enabled) {
      save({ desktop: false });
      return;
    }
    if (!("Notification" in window)) {
      setMessage(
        "This browser does not support desktop notifications. The decision inbox and sound still work.",
      );
      return;
    }
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      save({ desktop: result === "granted" });
      if (result !== "granted")
        setMessage(
          "Allow notifications in your browser settings to receive alerts outside Looproom.",
        );
    } catch {
      setMessage(
        "Desktop alerts are unavailable in this browser. Use the inbox or open Looproom in Safari or Chrome.",
      );
    }
  }
  return (
    <section className="setting-section">
      <h2>Notifications</h2>
      <p>
        Only new decisions need your attention. Routine agent activity stays
        quiet.
      </p>
      <div className="notification-setting">
        <div>
          <label htmlFor="gate-sound">Escalation sound</label>
          <p>A soft two-note chime when a new gate opens.</p>
        </div>
        <Switch
          id="gate-sound"
          checked={prefs.sound}
          onCheckedChange={(sound) => {
            save({ sound });
            if (sound) void chime().catch((e) => setMessage(e.message));
          }}
        />
      </div>
      <div className="notification-setting">
        <div>
          <label htmlFor="gate-desktop">Desktop notifications</label>
          <p>
            {permission === "unsupported"
              ? "Unavailable in this browser"
              : permission === "denied"
                ? "Blocked by your browser"
                : "See decisions while working elsewhere."}
          </p>
        </div>
        <Switch
          id="gate-desktop"
          disabled={permission === "unsupported" || permission === "denied"}
          checked={prefs.desktop && permission === "granted"}
          onCheckedChange={desktop}
        />
      </div>
      <Button
        variant="outline"
        onClick={() => {
          void chime()
            .then(() => setMessage("Test sound played."))
            .catch((e) => setMessage(e.message));
        }}
      >
        <Volume2 size={15} />
        Test sound
      </Button>
      {message ? (
        <p role="status" className="field-help">
          {message}
        </p>
      ) : null}
      <p className="field-help">
        Preferences are saved for this browser. Keep Looproom open to receive
        alerts.
      </p>
    </section>
  );
}
