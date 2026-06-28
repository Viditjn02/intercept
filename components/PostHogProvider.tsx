"use client";

// ============================================================================
// INTERCEPT — POSTHOG PROVIDER
// Mount once in app/layout.tsx (the integrator wires this). It:
//   1. Captures a "$pageview" on mount and on every App Router path change.
//   2. Exposes a useCapture() hook so any client component can fire events.
// Everything routes through lib/posthog.capture(), which NO-OPs silently when
// NEXT_PUBLIC_POSTHOG_KEY is absent — so this is safe to mount unconditionally.
// useCapture() returns a no-op when used outside the provider, so it never
// crashes a tree that forgot to mount it.
// ============================================================================

import { createContext, useContext, useEffect, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { capture, type CaptureProps } from "@/lib/posthog";

type CaptureFn = (event: string, props?: CaptureProps) => void;

const noop: CaptureFn = () => {};
const CaptureContext = createContext<CaptureFn>(noop);

/** Fire-and-forget event capture from any client component. */
export function useCapture(): CaptureFn {
  return useContext(CaptureContext);
}

export default function PostHogProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // Pageview on mount + whenever the route path changes.
  useEffect(() => {
    void capture("$pageview", {
      path: pathname,
      $current_url:
        typeof window !== "undefined" ? window.location.href : undefined,
    });
  }, [pathname]);

  const fire: CaptureFn = (event, props) => {
    void capture(event, props);
  };

  return (
    <CaptureContext.Provider value={fire}>{children}</CaptureContext.Provider>
  );
}
