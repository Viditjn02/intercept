"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import {
  designEmail,
  type BrandInfo,
  type EmailLayout,
  type EmailTone,
} from "@/lib/brew";
import {
  listEmailTemplatesRef,
  saveEmailTemplateRef,
  sendDesignedEmailRef,
  sendPlainEmailRef,
  type EmailTemplateDoc,
} from "./chatApi";

// ============================================================================
// EmailDesigner — the global EMAIL STUDIO drawer.
// ----------------------------------------------------------------------------
// Mounted ONCE at the app root; it self-opens when the outreach queue dispatches
//   window.dispatchEvent(new CustomEvent("intercept:open-email-designer", {
//     detail: { to, subject, body, emailId?, runId?, brand?, drafts? } }))
//
// This is a real DESIGN surface, not a text→preview. The human picks:
//   • a LAYOUT variant (minimal / branded / announcement),
//   • a brand ACCENT colour + LOGO URL + company / from-name / website,
//   • a CTA button (text + url) and a writing TONE,
// and the live PREVIEW re-renders through Brew (or, on the client where no key is
// present, the clean default branded template) on every change — so it *feels*
// like designing: change the accent → the preview updates.
//
// A draft switcher lets the human jump between open drafts or start blank.
//
// Actions (contract preserved): Save as template · Send designed · Send plain.
// Backend: convex/emailDesign.ts, bound by name via ./chatApi typed refs.
//
// Graceful by contract: BREW_API_KEY is server-only, so the client preview is the
// default template (which still honours accent/logo/CTA/layout) with a small
// "preview · Brew renders on send" note. Every async path is guarded.
// ============================================================================

interface DraftOption {
  emailId?: Id<"emails">;
  to?: string;
  subject?: string;
  body?: string;
  label?: string;
}

interface OpenEmailDesignerDetail {
  to?: string;
  subject?: string;
  body?: string;
  emailId?: Id<"emails">;
  runId?: Id<"runs">;
  brand?: BrandInfo;
  drafts?: DraftOption[];
}

type Mode = "design" | "plain";
type Busy = null | "save" | "designed" | "plain";

interface DraftState {
  to: string;
  subject: string;
  body: string;
}

// The full set of brand/design controls that feed Brew + the live preview.
interface DesignState {
  layout: EmailLayout;
  tone: EmailTone;
  accentHex: string;
  logoUrl: string;
  company: string;
  fromName: string;
  websiteUrl: string;
  footerNote: string;
  ctaLabel: string;
  ctaUrl: string;
}

const EMPTY_DRAFT: DraftState = { to: "", subject: "", body: "" };

const DEFAULT_ACCENT = "#c8e6cd"; // Figma block-mint

const DEFAULT_DESIGN: DesignState = {
  layout: "branded",
  tone: "friendly",
  accentHex: DEFAULT_ACCENT,
  logoUrl: "",
  company: "",
  fromName: "",
  websiteUrl: "",
  footerNote: "",
  ctaLabel: "",
  ctaUrl: "",
};

const LAYOUTS: { value: EmailLayout; label: string; hint: string }[] = [
  { value: "minimal", label: "Minimal", hint: "Clean letter" },
  { value: "branded", label: "Branded", hint: "Accent + logo card" },
  { value: "announcement", label: "Announce", hint: "Bold header band" },
];

const TONES: EmailTone[] = ["friendly", "direct", "formal", "playful"];

/** A safe #rrggbb for the native colour input (which rejects anything else). */
function normalizeHex(hex: string): string {
  const v = hex.trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : DEFAULT_ACCENT;
}

export default function EmailDesigner() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [emailId, setEmailId] = useState<Id<"emails"> | undefined>(undefined);
  const [runId, setRunId] = useState<Id<"runs"> | undefined>(undefined);

  const [drafts, setDrafts] = useState<DraftOption[]>([]);
  const [activeDraft, setActiveDraft] = useState<string>("blank");
  const [design, setDesign] = useState<DesignState>(DEFAULT_DESIGN);

  const [mode, setMode] = useState<Mode>("design");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  const [previewHtml, setPreviewHtml] = useState<string>("");
  const [designing, setDesigning] = useState(false);
  const [degraded, setDegraded] = useState(false);

  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");

  // Backend bindings (resolve at runtime once convex/emailDesign.ts deploys).
  const templates = useQuery(listEmailTemplatesRef, {}) as EmailTemplateDoc[] | undefined;
  const saveTemplate = useMutation(saveEmailTemplateRef);
  const sendDesigned = useAction(sendDesignedEmailRef);
  const sendPlain = useAction(sendPlainEmailRef);

  const close = useCallback(() => {
    if (busy) return;
    setOpen(false);
  }, [busy]);

  // ── Self-open on the outreach-queue event ──────────────────────────────────
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenEmailDesignerDetail>).detail ?? {};
      setDraft({
        to: detail.to ?? "",
        subject: detail.subject ?? "",
        body: detail.body ?? "",
      });
      setEmailId(detail.emailId);
      setRunId(detail.runId);
      setDrafts(detail.drafts ?? []);
      setActiveDraft(detail.emailId ? String(detail.emailId) : "blank");

      const b = detail.brand;
      setDesign({
        ...DEFAULT_DESIGN,
        accentHex: (b?.accentHex && b.accentHex.trim()) || DEFAULT_ACCENT,
        logoUrl: b?.logoUrl ?? "",
        company: b?.company ?? "",
        fromName: b?.fromName ?? "",
        websiteUrl: b?.websiteUrl ?? "",
        footerNote: b?.footerNote ?? "",
      });

      setMode("design");
      setSelectedTemplateId(null);
      setNote(null);
      setSent(false);
      setSavingTemplate(false);
      setTemplateName("");
      setPreviewHtml("");
      setOpen(true);
    };
    window.addEventListener("intercept:open-email-designer", onOpen as EventListener);
    return () =>
      window.removeEventListener("intercept:open-email-designer", onOpen as EventListener);
  }, []);

  // ── Esc to close + lock scroll while open ──────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, close]);

  const selectedTemplate = useMemo(
    () => templates?.find((t) => t._id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  );

  // The 6-field BrandInfo the save contract + Brew expect, derived from controls.
  const brandInfo = useMemo<BrandInfo>(
    () => ({
      company: design.company.trim() || undefined,
      logoUrl: design.logoUrl.trim() || undefined,
      accentHex: design.accentHex.trim() || undefined,
      fromName: design.fromName.trim() || undefined,
      websiteUrl: design.websiteUrl.trim() || undefined,
      footerNote: design.footerNote.trim() || undefined,
    }),
    [design],
  );

  // ── Build the live preview (design mode). A selected template shows its saved
  //    HTML instantly; otherwise we ask Brew (which on the client returns the
  //    clean default template built from the live controls). Never throws. ─────
  useEffect(() => {
    if (!open || mode !== "design") return;

    if (selectedTemplate?.html) {
      setPreviewHtml(selectedTemplate.html);
      setDegraded(false);
      setDesigning(false);
      return;
    }

    let cancelled = false;
    setDesigning(true);
    designEmail({
      subject: draft.subject,
      body: draft.body,
      brand: brandInfo,
      layout: design.layout,
      tone: design.tone,
      ctaLabel: design.ctaLabel.trim() || undefined,
      ctaUrl: design.ctaUrl.trim() || undefined,
    })
      .then((res) => {
        if (cancelled) return;
        setPreviewHtml(res.html);
        setDegraded(res.degraded);
      })
      .catch(() => {
        if (!cancelled) setPreviewHtml("");
      })
      .finally(() => {
        if (!cancelled) setDesigning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    open,
    mode,
    draft.subject,
    draft.body,
    brandInfo,
    design.layout,
    design.tone,
    design.ctaLabel,
    design.ctaUrl,
    selectedTemplate,
  ]);

  const setField = useCallback(
    (field: keyof DraftState) => (value: string) =>
      setDraft((d) => ({ ...d, [field]: value })),
    [],
  );

  // Any control edit takes over from a selected template so the live design wins.
  const updateDesign = useCallback((patch: Partial<DesignState>) => {
    setDesign((d) => ({ ...d, ...patch }));
    setSelectedTemplateId(null);
  }, []);

  const selectDraft = useCallback(
    (key: string) => {
      setActiveDraft(key);
      setNote(null);
      setSelectedTemplateId(null);
      if (key === "blank") {
        setDraft(EMPTY_DRAFT);
        setEmailId(undefined);
        return;
      }
      const opt = drafts.find((d) => String(d.emailId) === key);
      if (opt) {
        setDraft({ to: opt.to ?? "", subject: opt.subject ?? "", body: opt.body ?? "" });
        setEmailId(opt.emailId);
      }
    },
    [drafts],
  );

  const canSend = draft.subject.trim().length > 0 && draft.body.trim().length > 0;

  // ── Actions ────────────────────────────────────────────────────────────────
  const onSaveTemplate = useCallback(async () => {
    const name = templateName.trim();
    if (!name) {
      setNote("Give the template a name first.");
      return;
    }
    if (!previewHtml) {
      setNote("Nothing to save yet.");
      return;
    }
    setBusy("save");
    setNote(null);
    try {
      await saveTemplate({
        name,
        subject: draft.subject.trim() || undefined,
        html: previewHtml,
        body: draft.body.trim() || undefined,
        brand: {
          company: brandInfo.company,
          logoUrl: brandInfo.logoUrl,
          accentHex: brandInfo.accentHex,
          fromName: brandInfo.fromName,
          websiteUrl: brandInfo.websiteUrl,
          footerNote: brandInfo.footerNote,
        },
      });
      setSavingTemplate(false);
      setTemplateName("");
      setNote("Template saved.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't save the template.");
    } finally {
      setBusy(null);
    }
  }, [templateName, previewHtml, draft.subject, draft.body, brandInfo, saveTemplate]);

  const onSendDesigned = useCallback(async () => {
    if (!canSend) {
      setNote("A subject and body are required to send.");
      return;
    }
    setBusy("designed");
    setNote(null);
    try {
      const res = await sendDesigned({
        to: draft.to.trim() || undefined,
        subject: draft.subject.trim(),
        body: draft.body,
        html: previewHtml || undefined,
        templateId: selectedTemplate?._id,
        emailId,
        runId,
      });
      if (res?.sent) {
        setSent(true);
        setNote(null);
      } else {
        setNote(res?.reason ?? "Send didn't complete — check email settings.");
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setBusy(null);
    }
  }, [canSend, draft, previewHtml, selectedTemplate, emailId, runId, sendDesigned]);

  const onSendPlain = useCallback(async () => {
    if (!canSend) {
      setNote("A subject and body are required to send.");
      return;
    }
    setBusy("plain");
    setNote(null);
    try {
      const res = await sendPlain({
        to: draft.to.trim() || undefined,
        subject: draft.subject.trim(),
        body: draft.body,
        emailId,
        runId,
      });
      if (res?.sent) {
        setSent(true);
        setNote(null);
      } else {
        setNote(res?.reason ?? "Send didn't complete — check email settings.");
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setBusy(null);
    }
  }, [canSend, draft, emailId, runId, sendPlain]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-scrim/60"
      role="dialog"
      aria-modal="true"
      aria-label="Email Studio"
      onClick={close}
    >
      <div
        className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-hairline bg-canvas shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-6 py-4">
          <div className="min-w-0">
            <p className="caption font-mono uppercase tracking-wide text-ink/50">
              Email Studio · Brew
            </p>
            <h2 className="mt-1 truncate text-lg font-fig-headline text-ink">
              {draft.subject.trim() || "Untitled email"}
            </h2>
            <p className="mt-0.5 truncate text-[12px] text-ink/55">
              {draft.to.trim() ? `to ${draft.to.trim()}` : "recipient resolved at send"}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={!!busy}
            className="shrink-0 rounded-full p-1.5 text-ink/50 transition-colors hover:bg-surface-soft hover:text-ink disabled:opacity-40"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </header>

        {/* Mode tabs */}
        <div className="flex items-center gap-1 border-b border-hairline px-6 py-2.5">
          {(["design", "plain"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setNote(null);
              }}
              className={cn(
                "rounded-pill px-4 py-1.5 text-[12.5px] font-fig-link transition-colors",
                mode === m
                  ? "bg-ink text-on-primary"
                  : "border border-hairline bg-canvas text-ink hover:bg-surface-soft",
              )}
            >
              {m === "design" ? "Branded design" : "Plain cold email"}
            </button>
          ))}
          {mode === "design" && degraded && (
            <span className="ml-auto caption rounded-full bg-block-cream px-2.5 py-1 text-ink/70">
              preview · Brew renders on send
            </span>
          )}
        </div>

        {sent ? (
          <SentState onClose={() => setOpen(false)} mode={mode} />
        ) : (
          <>
            {/* Body */}
            <div className="flex min-h-0 flex-1">
              {/* Left — draft fields + design controls + templates */}
              <div className="w-2/5 shrink-0 space-y-4 overflow-y-auto border-r border-hairline px-6 py-5">
                {drafts.length > 0 && (
                  <Field label="Draft">
                    <select
                      value={activeDraft}
                      onChange={(e) => selectDraft(e.target.value)}
                      className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-ink/40"
                    >
                      <option value="blank">Start blank</option>
                      {drafts.map((d) => (
                        <option key={String(d.emailId)} value={String(d.emailId)}>
                          {d.label || d.subject || "Untitled draft"}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}

                <Field label="To">
                  <input
                    type="email"
                    value={draft.to}
                    onChange={(e) => setField("to")(e.target.value)}
                    placeholder="name@company.com"
                    className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-ink/35 focus:border-ink/40"
                  />
                </Field>
                <Field label="Subject">
                  <input
                    type="text"
                    value={draft.subject}
                    onChange={(e) => setField("subject")(e.target.value)}
                    placeholder="A short, specific subject"
                    className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-ink/35 focus:border-ink/40"
                  />
                </Field>
                <Field label="Body">
                  <textarea
                    value={draft.body}
                    onChange={(e) => setField("body")(e.target.value)}
                    rows={8}
                    placeholder="Write the cold email…"
                    className="w-full resize-none rounded-md border border-hairline bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink/35 focus:border-ink/40"
                  />
                </Field>

                {mode === "design" && (
                  <>
                    <DesignControls design={design} onChange={updateDesign} />

                    <div className="space-y-2">
                      <p className="caption font-mono uppercase text-ink/45">Saved templates</p>
                      <TemplatePicker
                        templates={templates}
                        selectedId={selectedTemplateId}
                        onSelect={(id) =>
                          setSelectedTemplateId((cur) => (cur === id ? null : id))
                        }
                      />
                    </div>
                  </>
                )}
              </div>

              {/* Right — preview */}
              <div className="flex min-w-0 flex-1 flex-col bg-surface-soft">
                <div className="flex items-center justify-between border-b border-hairline px-5 py-2.5">
                  <span className="caption font-mono uppercase text-ink/45">
                    {mode === "design" ? "Live preview" : "Plain text"}
                  </span>
                  {mode === "design" && (
                    <span className="caption text-ink/40">
                      {designing ? "rendering…" : `${design.layout} layout`}
                    </span>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-hidden p-4">
                  {mode === "design" ? (
                    previewHtml ? (
                      <iframe
                        title="Email preview"
                        srcDoc={previewHtml}
                        sandbox=""
                        className="h-full w-full rounded-md border border-hairline bg-white"
                      />
                    ) : (
                      <div className="grid h-full place-items-center rounded-md border border-dashed border-hairline bg-canvas text-center text-[13px] text-ink/50">
                        {designing
                          ? "Designing your email…"
                          : "Add a subject and body to preview the design."}
                      </div>
                    )
                  ) : (
                    <div className="h-full overflow-y-auto rounded-md border border-hairline bg-canvas p-4">
                      <p className="text-[13px] font-fig-headline text-ink">
                        {draft.subject.trim() || "(no subject)"}
                      </p>
                      <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-ink/75">
                        {draft.body.trim() || "Write the cold email on the left…"}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Footer actions */}
            <footer className="flex flex-wrap items-center gap-3 border-t border-hairline px-6 py-4">
              {mode === "design" && (
                <div className="mr-auto flex items-center gap-2">
                  {savingTemplate ? (
                    <>
                      <input
                        type="text"
                        autoFocus
                        value={templateName}
                        onChange={(e) => setTemplateName(e.target.value)}
                        placeholder="Template name"
                        className="w-44 rounded-pill border border-hairline bg-canvas px-3.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink/35 focus:border-ink/40"
                      />
                      <button
                        type="button"
                        onClick={onSaveTemplate}
                        disabled={!!busy || !templateName.trim() || !previewHtml}
                        className="rounded-pill bg-block-mint px-4 py-1.5 text-[12.5px] font-fig-link text-ink transition-colors hover:bg-block-mint/80 disabled:opacity-50"
                      >
                        {busy === "save" ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSavingTemplate(false)}
                        disabled={!!busy}
                        className="text-[12.5px] text-ink/50 hover:text-ink"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setSavingTemplate(true);
                        setNote(null);
                      }}
                      disabled={!!busy || !previewHtml}
                      className="rounded-pill border border-hairline bg-canvas px-4 py-2 text-[12.5px] font-fig-link text-ink transition-colors hover:bg-surface-soft disabled:opacity-50"
                    >
                      Save as template
                    </button>
                  )}
                </div>
              )}

              {note && (
                <span className={cn("text-[12px]", mode === "plain" && "mr-auto", "text-ink/55")}>
                  {note}
                </span>
              )}

              <button
                type="button"
                onClick={onSendPlain}
                disabled={!!busy || !canSend}
                className="rounded-pill border border-hairline bg-canvas px-5 py-2 text-[12.5px] font-fig-link text-ink transition-colors hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "plain" ? "Sending…" : "Send plain"}
              </button>

              {mode === "design" && (
                <button
                  type="button"
                  onClick={onSendDesigned}
                  disabled={!!busy || !canSend}
                  className="inline-flex items-center gap-2 rounded-pill bg-primary px-6 py-2 text-[12.5px] font-fig-link text-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden>
                    <path d="m22 2-7 20-4-9-9-4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                    <path d="M22 2 11 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  {busy === "designed" ? "Sending…" : "Send designed"}
                </button>
              )}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DesignControls — the brand/design panel that feeds Brew + the live preview.
// ---------------------------------------------------------------------------

function DesignControls({
  design,
  onChange,
}: {
  design: DesignState;
  onChange: (patch: Partial<DesignState>) => void;
}) {
  return (
    <div className="space-y-3.5 rounded-lg border border-hairline bg-surface-soft/60 p-3.5">
      <p className="caption font-mono uppercase tracking-wide text-ink/55">Design</p>

      {/* Layout variant */}
      <div>
        <span className="caption font-mono uppercase text-ink/45">Layout</span>
        <div className="mt-1.5 grid grid-cols-3 gap-1.5">
          {LAYOUTS.map((l) => (
            <button
              key={l.value}
              type="button"
              onClick={() => onChange({ layout: l.value })}
              title={l.hint}
              className={cn(
                "rounded-md border px-2 py-1.5 text-[11.5px] font-fig-link transition-colors",
                design.layout === l.value
                  ? "border-ink/40 bg-ink text-on-primary"
                  : "border-hairline bg-canvas text-ink/80 hover:bg-surface-soft",
              )}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {/* Accent + tone */}
      <div className="flex gap-3">
        <div className="flex-1">
          <span className="caption font-mono uppercase text-ink/45">Accent</span>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              type="color"
              value={normalizeHex(design.accentHex)}
              onChange={(e) => onChange({ accentHex: e.target.value })}
              aria-label="Accent colour"
              className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-hairline bg-canvas p-0.5"
            />
            <input
              type="text"
              value={design.accentHex}
              onChange={(e) => onChange({ accentHex: e.target.value })}
              placeholder="#c8e6cd"
              className="w-full rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-[12px] text-ink outline-none transition-colors placeholder:text-ink/35 focus:border-ink/40"
            />
          </div>
        </div>
        <div className="w-[38%]">
          <span className="caption font-mono uppercase text-ink/45">Tone</span>
          <select
            value={design.tone}
            onChange={(e) => onChange({ tone: e.target.value as EmailTone })}
            className="mt-1.5 w-full rounded-md border border-hairline bg-canvas px-2 py-1.5 text-[12px] capitalize text-ink outline-none transition-colors focus:border-ink/40"
          >
            {TONES.map((t) => (
              <option key={t} value={t} className="capitalize">
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      <ControlInput
        label="Logo URL"
        value={design.logoUrl}
        onChange={(v) => onChange({ logoUrl: v })}
        placeholder="https://…/logo.png"
      />

      <div className="flex gap-3">
        <div className="flex-1">
          <ControlInput
            label="Company"
            value={design.company}
            onChange={(v) => onChange({ company: v })}
            placeholder="Acme"
          />
        </div>
        <div className="flex-1">
          <ControlInput
            label="From name"
            value={design.fromName}
            onChange={(v) => onChange({ fromName: v })}
            placeholder="Jordan"
          />
        </div>
      </div>

      <ControlInput
        label="Website URL"
        value={design.websiteUrl}
        onChange={(v) => onChange({ websiteUrl: v })}
        placeholder="https://acme.com"
      />

      {/* Call to action */}
      <div>
        <span className="caption font-mono uppercase text-ink/45">Call to action</span>
        <div className="mt-1.5 flex gap-2">
          <input
            type="text"
            value={design.ctaLabel}
            onChange={(e) => onChange({ ctaLabel: e.target.value })}
            placeholder="Button text"
            className="w-2/5 rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-[12px] text-ink outline-none transition-colors placeholder:text-ink/35 focus:border-ink/40"
          />
          <input
            type="text"
            value={design.ctaUrl}
            onChange={(e) => onChange({ ctaUrl: e.target.value })}
            placeholder="https://…"
            className="flex-1 rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-[12px] text-ink outline-none transition-colors placeholder:text-ink/35 focus:border-ink/40"
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small presentational pieces.
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="caption font-mono uppercase text-ink/45">{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function ControlInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="caption font-mono uppercase text-ink/45">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1.5 w-full rounded-md border border-hairline bg-canvas px-2.5 py-1.5 text-[12px] text-ink outline-none transition-colors placeholder:text-ink/35 focus:border-ink/40"
      />
    </label>
  );
}

function TemplatePicker({
  templates,
  selectedId,
  onSelect,
}: {
  templates: EmailTemplateDoc[] | undefined;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (templates === undefined) {
    return (
      <div className="space-y-1.5">
        {[0, 1].map((i) => (
          <div key={i} className="h-9 animate-pulse rounded-md border border-hairline bg-surface-soft" />
        ))}
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-hairline bg-surface-soft px-3 py-2.5 text-[12px] text-ink/50">
        No saved templates yet. Design one and hit “Save as template”.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      {templates.map((t) => (
        <button
          key={t._id}
          type="button"
          onClick={() => onSelect(t._id)}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-[12.5px] transition-colors",
            selectedId === t._id
              ? "border-ink/40 bg-block-mint text-ink"
              : "border-hairline bg-canvas text-ink/80 hover:bg-surface-soft",
          )}
        >
          <span className="truncate">{t.name}</span>
          {selectedId === t._id && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )}
        </button>
      ))}
    </div>
  );
}

function SentState({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-full bg-block-mint">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-success" aria-hidden>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </div>
      <div>
        <h3 className="text-base font-fig-headline text-ink">
          {mode === "design" ? "Designed email sent" : "Plain email sent"}
        </h3>
        <p className="mt-1 text-[13px] text-ink/55">It went out via AgentMail.</p>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="rounded-pill bg-ink px-6 py-2 text-[12.5px] font-fig-link text-on-primary transition-opacity hover:opacity-90"
      >
        Done
      </button>
    </div>
  );
}
