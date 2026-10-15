# offhook.welldun.ai

The Offhook website: an Astro static site built on the welldun design system.

    pnpm install
    pnpm dev          # http://localhost:4321
    pnpm build        # static site in dist/

Design tokens live in `src/design/tokens.json` (copied from the welldun design system). After copying a new version, run `pnpm tokens` to regenerate `src/design/tokens.css`. Component styles are `src/design/welldun.css`; fonts are in `public/fonts/`.
