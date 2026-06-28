import type { Config } from "tailwindcss";

// ============================================================================
// INTERCEPT — Figma editorial token theme (DESIGN.md foundation).
// All colours resolve through CSS variables (rgb(var(--x) / <alpha-value>)) so
// ONE token set drives BOTH the default light (Figma) theme and the night theme.
// Variable values live in app/globals.css (:root light + .dark night blocks).
// ============================================================================

const config: Config = {
  // Toggle adds `.dark` on <html>; globals.css ALSO targets [data-theme="dark"].
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── Monochrome chrome (theme-flipping: black-on-white ⇄ white-on-navy) ──
        canvas: "rgb(var(--canvas) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        primary: "rgb(var(--primary) / <alpha-value>)",
        "on-primary": "rgb(var(--on-primary) / <alpha-value>)",
        "inverse-canvas": "rgb(var(--inverse-canvas) / <alpha-value>)",
        "inverse-ink": "rgb(var(--inverse-ink) / <alpha-value>)",
        "on-inverse-soft": "rgb(var(--on-inverse-soft) / <alpha-value>)", // use /15 on dark blocks

        // ── Surfaces & hairlines (theme-flipping) ──
        "surface-soft": "rgb(var(--surface-soft) / <alpha-value>)",
        hairline: "rgb(var(--hairline) / <alpha-value>)",
        "hairline-soft": "rgb(var(--hairline-soft) / <alpha-value>)",

        // ── Pastel color-blocks (brand-constant across BOTH themes — the "sticky notes") ──
        "block-lime": "rgb(var(--block-lime) / <alpha-value>)",
        "block-lilac": "rgb(var(--block-lilac) / <alpha-value>)",
        "block-cream": "rgb(var(--block-cream) / <alpha-value>)",
        "block-pink": "rgb(var(--block-pink) / <alpha-value>)",
        "block-mint": "rgb(var(--block-mint) / <alpha-value>)",
        "block-coral": "rgb(var(--block-coral) / <alpha-value>)",
        "block-navy": "rgb(var(--block-navy) / <alpha-value>)",

        // ── Accent + semantic (brand-constant, used scarcely) ──
        "accent-magenta": "rgb(var(--accent-magenta) / <alpha-value>)", // ONE promo CTA per page
        success: "rgb(var(--success) / <alpha-value>)", // glyph fill only
        scrim: "rgb(var(--scrim) / <alpha-value>)", // use /60 behind modals
      },

      fontFamily: {
        // figmaSans → Inter (variable), figmaMono → JetBrains Mono. See app/fonts.ts.
        sans: ["var(--font-figma-sans)", "SF Pro Display", "system-ui", "Helvetica", "Arial", "sans-serif"],
        mono: ["var(--font-figma-mono)", "SF Mono", "Menlo", "monospace"],
      },

      // figmaSans variable-weight scale (320,330,340,480,540,700). Inter interpolates these.
      // Prefer these named weights; intermediate weights outside the set are a DESIGN don't.
      fontWeight: {
        "fig-body": "320", // {typography.body}
        "fig-bodysm": "330", // {typography.body-sm} / body-lg
        "fig-display": "340", // {typography.display-*}, subhead
        "fig-link": "480", // {typography.link} / button
        "fig-headline": "540", // {typography.headline}
        "fig-card": "700", // {typography.card-title}
      },

      // Type roles as single utilities. Each carries size + (Inter-trimmed) line-height +
      // letter-spacing + weight, so `text-display-xl`, `text-eyebrow`, etc. are one-class roles.
      fontSize: {
        "display-xl": ["86px", { lineHeight: "0.98", letterSpacing: "-1.72px", fontWeight: "340" }],
        "display-lg": ["64px", { lineHeight: "1.08", letterSpacing: "-0.96px", fontWeight: "340" }],
        headline: ["26px", { lineHeight: "1.33", letterSpacing: "-0.26px", fontWeight: "540" }],
        subhead: ["26px", { lineHeight: "1.33", letterSpacing: "-0.26px", fontWeight: "340" }],
        "card-title": ["24px", { lineHeight: "1.43", letterSpacing: "0", fontWeight: "700" }],
        "body-lg": ["20px", { lineHeight: "1.38", letterSpacing: "-0.14px", fontWeight: "330" }],
        body: ["18px", { lineHeight: "1.43", letterSpacing: "-0.26px", fontWeight: "320" }],
        "body-sm": ["16px", { lineHeight: "1.43", letterSpacing: "-0.14px", fontWeight: "330" }],
        link: ["20px", { lineHeight: "1.38", letterSpacing: "-0.10px", fontWeight: "480" }],
        button: ["20px", { lineHeight: "1.38", letterSpacing: "-0.10px", fontWeight: "480" }],
        // figmaMono — eyebrows + captions ONLY (pair with `font-mono uppercase`)
        eyebrow: ["18px", { lineHeight: "1.28", letterSpacing: "0.54px", fontWeight: "400" }],
        caption: ["12px", { lineHeight: "1.00", letterSpacing: "0.60px", fontWeight: "400" }],
      },

      letterSpacing: {
        "fig-display-xl": "-1.72px",
        "fig-display-lg": "-0.96px",
        "fig-tight": "-0.26px",
        "fig-snug": "-0.14px",
        "fig-link": "-0.10px",
        "fig-eyebrow": "0.54px",
        "fig-caption": "0.60px",
      },

      // NOTE: this OVERRIDES Tailwind's default rounded-sm/md/lg/xl scale on purpose (fidelity).
      // Driven by vars so the radius scale is editable in one place.
      borderRadius: {
        xs: "var(--radius-xs)", // 2px  — anchor/link decoration
        sm: "var(--radius-sm)", // 6px  — chips, sub-nav tabs
        md: "var(--radius-md)", // 8px  — inputs, list items, image frames
        lg: "var(--radius-lg)", // 24px — cards, color-block sections
        xl: "var(--radius-xl)", // 32px — hero feature panels
        pill: "var(--radius-pill)", // 50px — ALL text CTAs
        full: "var(--radius-full)", // 9999 — icon buttons, glyphs
      },

      // 8px base unit. Adds named steps (p-xs, gap-lg, py-section, etc.) alongside Tailwind's
      // numeric scale. Does not touch maxWidth's own xs/sm/... keys.
      spacing: {
        hair: "var(--space-hair)", // 1px
        xxs: "var(--space-xxs)", // 4px
        xs: "var(--space-xs)", // 8px
        sm: "var(--space-sm)", // 12px
        md: "var(--space-md)", // 16px
        lg: "var(--space-lg)", // 24px
        xl: "var(--space-xl)", // 32px
        xxl: "var(--space-xxl)", // 48px  — color-block interior padding
        section: "var(--space-section)", // 96px  — vertical gap between sections
      },

      maxWidth: { content: "1280px" }, // DESIGN max content width

      // The only shadows in the system. Elevation 0/1 use NO shadow (color/hairline is the depth).
      boxShadow: {
        soft: "0 4px 16px rgba(0,0,0,0.06)", // Elevation 2 — floating tiles, dropdowns, tooltips
        modal: "0 24px 64px rgba(0,0,0,0.30)", // Elevation 3 — lightbox / modal (pair with bg-scrim/60)
        // Glass elevation shadows (mirror the --glass-shadow-* vars for utility use).
        "glass-1": "0 4px 16px rgb(0 0 0 / 0.07)",
        "glass-2": "0 8px 32px rgb(0 0 0 / 0.10)",
      },

      // Glass tier blur radii (mirror --glass-N-blur). Use `backdrop-blur-glass-N`
      // ONLY paired with backdrop-saturate-glass; prefer the .glass-1/2/3 classes.
      backdropBlur: {
        "glass-1": "12px",
        "glass-2": "16px",
        "glass-3": "20px",
      },

      // Motion durations (mirror --dur-*). For transform/opacity transitions only.
      transitionDuration: {
        instant: "100ms",
        quick: "200ms",
        standard: "280ms",
        enter: "400ms",
      },

      // Shared easings (mirror --ease-spring / --ease-out).
      transitionTimingFunction: {
        spring: "cubic-bezier(0.22, 1, 0.36, 1)",
        "ease-out-soft": "cubic-bezier(0, 0, 0.2, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
