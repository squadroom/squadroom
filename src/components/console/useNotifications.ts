import { useEffect, useRef, useState } from "react";
import { claimNotices, needNotices, nextNotices, type NeedsLike, type Notice } from "@/lib/console/notify";
import { recall, remember } from "./api";

/** This device's choice to be notified. */
const NOTIFY_KEY = "console-notify";
/** What this device's Console pages have shown. */
const NOTIFIED_KEY = "console-notified";

/** Browser notifications: one per new Needs you item while the
 * Console is in the background, once the owner turned them on here. */
export function useNotifications(needs: NeedsLike, loaded: boolean) {
  const [state, setState] = useState<"unsupported" | "off" | "on" | "blocked">("off");
  const seen = useRef<Set<string> | null>(null);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  // A service worker that failed to register is not waited for: the page
  // shows them itself, and if the browser refuses that too they are shown
  // as unavailable rather than left silently off.
  const [workerFailed, setWorkerFailed] = useState(false);
  const workers = typeof navigator !== "undefined" && "serviceWorker" in navigator && !workerFailed;
  useEffect(() => {
    const first = setTimeout(() => {
      if (typeof Notification === "undefined") return setState("unsupported");
      if (Notification.permission === "denied") return setState("blocked");
      setState(Notification.permission === "granted" && recall(NOTIFY_KEY) === "on" ? "on" : "off");
    }, 0);
    // Turned on or off in another Console page on this device.
    const changed = (e: StorageEvent) => {
      if (e.key !== NOTIFY_KEY || typeof Notification === "undefined" || Notification.permission === "denied") return;
      setState(e.newValue === "on" && Notification.permission === "granted" ? "on" : "off");
    };
    window.addEventListener("storage", changed);
    return () => {
      clearTimeout(first);
      window.removeEventListener("storage", changed);
    };
  }, []);
  useEffect(() => {
    // Phones show notifications only through a service worker.
    if (state !== "on" || registration || !workers) return;
    navigator.serviceWorker
      .register("/console/sw.js", { scope: "/console/" })
      .then(setRegistration)
      .catch(() => setWorkerFailed(true));
  }, [state, registration, workers]);
  useEffect(() => {
    // Tracked whether or not they are on, so turning them on never floods.
    if (!loaded) return;
    // Until the service worker is ready nothing counts as shown: phones
    // show notifications only through it.
    if (state === "on" && workers && !registration && seen.current !== null) return;
    // In front, the Needs you button already shows them.
    const deliver = state === "on" && (document.hidden || !document.hasFocus());
    const { show: wanted, seen: next } = nextNotices(seen.current, needs, deliver);
    seen.current = next;
    // Another Console page on this device may have shown it already.
    const { claimed, record } = claimNotices(
      recall(NOTIFIED_KEY),
      needNotices(needs).map((n) => n.key),
      wanted.map((n) => n.key),
    );
    remember(NOTIFIED_KEY, record);
    const show = wanted.filter((n) => claimed.includes(n.key));
    const notify = (n: Notice) => {
      // A returning item reuses its tag; renotify alerts again.
      const options = { body: n.body, tag: n.key, renotify: true } as NotificationOptions;
      if (registration) return void registration.showNotification(n.title, options).catch(() => {});
      try {
        new Notification(n.title, options);
      } catch {
        // A browser that shows them only through a service worker, which
        // did not register.
        if (workerFailed) setState("unsupported");
      }
    };
    show.forEach(notify);
  }, [needs, loaded, state, registration, workers, workerFailed]);
  const toggle = () => {
    if (state === "on") {
      remember(NOTIFY_KEY, "off");
      return setState("off");
    }
    if (state !== "off") return;
    void Notification.requestPermission().then((p) => {
      if (p === "granted") {
        remember(NOTIFY_KEY, "on");
        setState("on");
      } else if (p === "denied") setState("blocked");
    });
  };
  return { state, toggle };
}
