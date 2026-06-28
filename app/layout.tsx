import type { Metadata, Viewport } from "next";
import "./globals.css";
import { figmaSans, figmaMono } from "./fonts";
import ConvexClientProvider from "@/components/ConvexClientProvider";
import PostHogProvider from "@/components/PostHogProvider";
import { ThemeProvider } from "@/components/ThemeProvider";

export const metadata: Metadata = {
  title: "INTERCEPT — the AI-native GTM chat",
  description:
    "One chat. Paste anything — a company, a competitor, an idea. A router decides what to do and does it: finds the live threads where your buyers are asking, sources decision-makers with verified emails, drafts and sends signal-grounded outreach, scouts competitor ads, and makes the creative — live, on a canvas beside you.",
};

export const viewport: Viewport = {
  // Browser chrome matches the canvas per scheme: white (light) · neutral
  // charcoal #0B0C0E (dark — the retuned Linear/Attio-grade night ground).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0B0C0E" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${figmaSans.variable} ${figmaMono.variable}`}
      suppressHydrationWarning // theme class is set pre-paint by the script below
    >
      <head>
        {/* Benign-rejection guard — FIRST node in <head> so its window listeners
            are registered at HTML-parse time, BEFORE any Next.js / React-refresh
            dev chunk (loaded later, in <body>) attaches its own error-overlay
            handlers. Capture phase + first-registration means we run first;
            preventDefault() stops the console spew and stopImmediatePropagation()
            stops the overlay's listener from ever seeing the event.

            SUPPRESSES (and only this) the recurring BENIGN rejections that would
            otherwise pop Next's full-screen dev overlay over a perfectly healthy
            app:
              • null / empty reason — Promise.reject() with no arg, opaque events.
              • DOMException Timeout/Abort, plus aborted/timed-out fetches — exactly
                the in-flight requests Convex's client drops every time `convex dev`
                hot-reloads and its WebSocket reconnects (the client recovers on its
                own; nothing is lost).
              • benign network noise: "Load failed" / "Failed to fetch" /
                "NetworkError when attempting to fetch" / "network connection lost".
              • injected browser-EXTENSION scripts — their frames surface under a
                masked / opaque source (webkit-masked-url, a *-extension:// URL, or
                a cross-origin "Script error.") with NO frame from our own origin.
                That rejection is not our bug and is not fixable in our code.
              • a rejection with NO usable stack and nothing actionable.

            DELIBERATELY LETS THROUGH every real, traceable bug: a TypeError, a
            thrown render error, a missing-Convex-function error — anything whose
            stack points at OUR code (this origin / localhost / _next / *.convex.*)
            still surfaces, so it gets fixed at the source. We never blanket-hide. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                try {
                  var ORIGIN = "";
                  try { ORIGIN = String((location && location.origin) || "").toLowerCase(); } catch (e) {}

                  var BENIGN_NAMES = ["timeouterror", "aborterror"];
                  var BENIGN_MSG = [
                    "timeouterror",
                    "aborterror",
                    "operation timed out",
                    "operation was aborted",
                    "the operation was aborted",
                    "the user aborted a request",
                    "request aborted",
                    "fetch aborted",
                    "load failed",
                    "failed to fetch",
                    "network request failed",
                    "networkerror when attempting to fetch",
                    "the network connection was lost",
                    "script error"
                  ];
                  // Masked / browser-extension source markers. Extension-injected
                  // scripts and opaque cross-origin frames surface under these.
                  var MASKED = [
                    "webkit-masked-url",
                    "safari-extension://",
                    "safari-web-extension://",
                    "chrome-extension://",
                    "moz-extension://",
                    "ms-browser-extension://",
                    "extension://",
                    "extensions::"
                  ];

                  function lower(s) {
                    try { return String(s == null ? "" : s).toLowerCase(); } catch (e) { return ""; }
                  }
                  function has(hay, list) {
                    for (var i = 0; i < list.length; i++) {
                      if (hay.indexOf(list[i]) !== -1) return true;
                    }
                    return false;
                  }
                  function nameOf(r) {
                    try { return lower(r && (r.name || (r.constructor && r.constructor.name))); }
                    catch (e) { return ""; }
                  }
                  function msgOf(r) {
                    try {
                      if (r == null) return "";
                      if (typeof r === "string") return lower(r);
                      return lower(r.message != null ? r.message : r);
                    } catch (e) { return ""; }
                  }
                  function stackOf(r) {
                    try { return lower(r && r.stack); } catch (e) { return ""; }
                  }
                  // A stack that points at OUR code — the signature of a real,
                  // fixable error (as opposed to an injected/extension frame).
                  function ownFrame(stack) {
                    if (!stack) return false;
                    if (ORIGIN && stack.indexOf(ORIGIN) !== -1) return true;
                    return (
                      stack.indexOf("localhost") !== -1 ||
                      stack.indexOf("127.0.0.1") !== -1 ||
                      stack.indexOf("_next") !== -1 ||
                      stack.indexOf(".convex.") !== -1
                    );
                  }

                  function isBenign(reason, source) {
                    // 1) null / empty reason.
                    if (reason == null) return true;
                    if (typeof reason === "string" && reason.trim() === "") return true;

                    var name = nameOf(reason);
                    var msg = msgOf(reason);
                    var stack = stackOf(reason);
                    var src = lower(source);

                    // 2) DOMException Timeout / Abort (by name or numeric code).
                    if (has(name, BENIGN_NAMES)) return true;
                    try {
                      if (typeof DOMException !== "undefined" && reason instanceof DOMException) {
                        if (reason.code === 20 /* ABORT_ERR */ || reason.code === 23 /* TIMEOUT_ERR */) return true;
                      }
                    } catch (e) {}

                    // 3) Known benign network noise (incl. Convex dev WS reconnect drops).
                    if (has(msg, BENIGN_MSG)) return true;

                    // 4) Masked / browser-extension source with NO frame from our code.
                    if (has(src, MASKED)) return true;
                    if (has(stack, MASKED) && !ownFrame(stack)) return true;

                    // 5) No usable stack and nothing actionable -> can't trace to us.
                    var isErrorLike = name !== "" && name !== "object";
                    if (!stack && msg.trim() === "" && !isErrorLike) return true;

                    // Otherwise a real, traceable app error -> let the overlay show it.
                    return false;
                  }

                  function swallow(e) {
                    try {
                      if (e && typeof e.preventDefault === "function") e.preventDefault();
                      if (e && typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
                      if (e && typeof e.stopPropagation === "function") e.stopPropagation();
                    } catch (err) {}
                  }

                  window.addEventListener(
                    "unhandledrejection",
                    function (e) {
                      try { if (isBenign(e && e.reason, "")) swallow(e); } catch (err) {}
                    },
                    true
                  );
                  window.addEventListener(
                    "error",
                    function (e) {
                      try {
                        var reason = e && (e.error != null ? e.error : e.message);
                        if (isBenign(reason, e && e.filename)) swallow(e);
                      } catch (err) {}
                    },
                    true
                  );
                } catch (e) {}
              })();
            `,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                try {
                  var t = localStorage.getItem('intercept-theme') || 'light';
                  var root = document.documentElement;
                  root.setAttribute('data-theme', t);
                  root.classList.toggle('dark', t === 'dark');
                  root.style.colorScheme = t === 'dark' ? 'dark' : 'light';
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <ConvexClientProvider>
            <PostHogProvider>{children}</PostHogProvider>
          </ConvexClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
