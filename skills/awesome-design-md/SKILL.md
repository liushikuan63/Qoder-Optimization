---
name: awesome-design-md
description: "74 份来自真实产品网站的 DESIGN.md 设计系统文档库（Apple / Stripe / Linear / Vercel / Notion 等）。当用户要「做成 XX 那样」、要设计语言或视觉方向（极简、暗黑电影感、编辑风、复古、奢华），或写前端前需要具体 design token（配色、字号、间距、圆角、阴影、组件规格）时使用。"
---

# Awesome DESIGN.md

## Overview

74 brand design-system documents extracted from real product websites, bundled as ready-to-apply `DESIGN.md` files. Each file contains exact design tokens (colors, typography, spacing, radii, shadows), component specs, layout principles, and do/don't rules. Read the file for the chosen brand, then apply its tokens when generating UI.

Source: https://github.com/VoltAgent/awesome-design-md (MIT License, see `LICENSE`).

## How to use

1. Match the request to a brand in the index below, or ask the user which brand to use when it is ambiguous.
2. Read `design-md/<slug>/DESIGN.md` relative to this skill's directory (globally installed at `~/.qoder-cn/skills/awesome-design-md/`).
3. Apply the file's values exactly — use its hex values, font stacks, radius and shadow specs instead of approximations. The token block at the top of each file is the source of truth.
4. Follow the file's Do's / Don'ts section when choosing components and layout.

Two file layouts exist; treat both the same way:

- **Token-header files (64)**: start with a YAML-style block (`name`, `description`, `colors:`, `typography:`, ...), followed by prose sections (Overview, Colors, Typography, Layout, Components, Do's and Don'ts).
- **Numbered files (10)**: `kraken`, `lamborghini`, `lovable`, `mastercard`, `runwayml`, `sanity`, `spotify`, `starbucks`, `tesla`, `theverge` — use numbered sections (Visual Theme, Color Palette, Typography Rules, ...) with values inlined in prose.

Pick by vibe when no exact brand is requested:

- Dark & technical: `vercel`, `linear.app`, `supabase`, `raycast`, `warp`
- Warm editorial: `claude`, `notion`, `stripe`, `mastercard`
- Luxury / monumental: `bugatti`, `ferrari`, `lamborghini`, `vodafone`
- Playful & colorful: `figma`, `miro`, `posthog`, `zapier`
- Photography-first: `apple`, `nike`, `tesla`, `meta`
- Retro web: `dell-1996`, `nintendo-2001`

## Brand index

### AI & LLM Platforms

| Brand | Slug | Style cues |
| ----- | ---- | ---------- |
| Claude | `claude` | Anthropic's AI assistant. Warm terracotta accent, clean editorial layout |
| Cohere | `cohere` | Enterprise AI platform. Vibrant gradients, data-rich dashboard aesthetic |
| ElevenLabs | `elevenlabs` | AI voice platform. Dark cinematic UI, audio-waveform aesthetics |
| Minimax | `minimax` | AI model provider. Bold dark interface with neon accents |
| Mistral AI | `mistral.ai` | Open-weight LLM provider. French-engineered minimalism, purple-toned |
| Ollama | `ollama` | Run LLMs locally. Terminal-first, monochrome simplicity |
| OpenCode AI | `opencode.ai` | AI coding platform. Developer-centric dark theme |
| Replicate | `replicate` | Run ML models via API. Clean white canvas, code-forward |
| Runway | `runwayml` | AI creative-tools platform. Cinematic dark heroes, paper-white reading bands, black pill CTAs |
| Together AI | `together.ai` | Open-source AI infrastructure. Technical, blueprint-style design |
| VoltAgent | `voltagent` | AI agent framework. Void-black canvas, emerald accent, terminal-native |
| xAI | `x.ai` | Elon Musk's AI lab. Stark monochrome, futuristic minimalism |

### Developer Tools & IDEs

| Brand | Slug | Style cues |
| ----- | ---- | ---------- |
| Cursor | `cursor` | AI-first code editor. Sleek dark interface, gradient accents |
| Expo | `expo` | React Native platform. Dark theme, tight letter-spacing, code-centric |
| Lovable | `lovable` | AI full-stack builder. Playful gradients, friendly dev aesthetic |
| Raycast | `raycast` | Productivity launcher. Sleek dark chrome, vibrant gradient accents |
| Superhuman | `superhuman` | Fast email client. Premium dark UI, keyboard-first, purple glow |
| Vercel | `vercel` | Frontend deployment platform. Black and white precision, Geist font |
| Warp | `warp` | Modern terminal. Dark IDE-like interface, block-based command UI |

### Backend, Database & DevOps

| Brand | Slug | Style cues |
| ----- | ---- | ---------- |
| ClickHouse | `clickhouse` | Fast analytics database. Yellow-accented, technical documentation style |
| Composio | `composio` | Tool integration platform. Modern dark with colorful integration icons |
| HashiCorp | `hashicorp` | Infrastructure automation. Enterprise-clean, black and white |
| MongoDB | `mongodb` | Document database. Green leaf branding, developer documentation focus |
| PostHog | `posthog` | Product analytics. Playful hedgehog branding, developer-friendly dark UI |
| Sanity | `sanity` | Headless content platform. Dark-first editorial marketing, 112px display type, coral-red CTA accent |
| Sentry | `sentry` | Error monitoring. Dark dashboard, data-dense, pink-purple accent |
| Supabase | `supabase` | Open-source Firebase alternative. Dark emerald theme, code-first |

### Productivity & SaaS

| Brand | Slug | Style cues |
| ----- | ---- | ---------- |
| Cal.com | `cal` | Open-source scheduling. Clean neutral UI, developer-oriented simplicity |
| Intercom | `intercom` | Customer messaging. Friendly blue palette, conversational UI patterns |
| Linear | `linear.app` | Project management for engineers. Ultra-minimal, precise, purple accent |
| Mintlify | `mintlify` | Documentation platform. Clean, green-accented, reading-optimized |
| Notion | `notion` | All-in-one workspace. Warm minimalism, serif headings, soft surfaces |
| Resend | `resend` | Email API for developers. Minimal dark theme, monospace accents |
| Zapier | `zapier` | Automation platform. Warm orange, friendly illustration-driven |

### Design & Creative Tools

| Brand | Slug | Style cues |
| ----- | ---- | ---------- |
| Airtable | `airtable` | Spreadsheet-database hybrid. Colorful, friendly, structured data aesthetic |
| Clay | `clay` | Creative agency. Organic shapes, soft gradients, art-directed layout |
| Figma | `figma` | Collaborative design tool. Vibrant multi-color, playful yet professional |
| Framer | `framer` | Website builder. Bold black and blue, motion-first, design-forward |
| Miro | `miro` | Visual collaboration. Bright yellow accent, infinite canvas aesthetic |
| Webflow | `webflow` | Visual web builder. Blue-accented, polished marketing site aesthetic |

### Fintech & Crypto

| Brand | Slug | Style cues |
| ----- | ---- | ---------- |
| Binance | `binance` | Crypto exchange. Bold Binance Yellow on monochrome, trading-floor urgency |
| Coinbase | `coinbase` | Crypto exchange. Clean blue identity, trust-focused, institutional feel |
| Kraken | `kraken` | Crypto trading platform. Purple-accented dark UI, data-dense dashboards |
| Mastercard | `mastercard` | Global payments network. Warm cream canvas, orbital pill shapes, editorial warmth |
| Revolut | `revolut` | Digital banking. Sleek dark interface, gradient cards, fintech precision |
| Stripe | `stripe` | Payment infrastructure. Signature purple gradients, weight-300 elegance |
| Wise | `wise` | International money transfer. Bright green accent, friendly and clear |

### E-commerce & Retail

| Brand | Slug | Style cues |
| ----- | ---- | ---------- |
| Airbnb | `airbnb` | Travel marketplace. Warm coral accent, photography-driven, rounded UI |
| Meta | `meta` | Tech retail store. Photography-first, binary light/dark surfaces, Meta Blue CTAs |
| Nike | `nike` | Athletic retail. Monochrome UI, massive uppercase Futura, full-bleed photography |
| Shopify | `shopify` | E-commerce platform. Dark-first cinematic, neon green accent, ultra-light display type |
| Starbucks | `starbucks` | Coffee retail flagship. Four-tier earth-green system, warm cream canvas, proprietary SoDoSans typography |

### Media & Consumer Tech

| Brand | Slug | Style cues |
| ----- | ---- | ---------- |
| Apple | `apple` | Consumer electronics. Premium white space, SF Pro, cinematic imagery |
| HP | `hp` | PC and printer maker. Pure white canvas, HP Electric Blue CTA, Forma DJR Micro, chevron decorations |
| IBM | `ibm` | Enterprise technology. Carbon design system, structured blue palette |
| NVIDIA | `nvidia` | GPU computing. Green-black energy, technical power aesthetic |
| Pinterest | `pinterest` | Visual discovery platform. Red accent, masonry grid, image-first |
| PlayStation | `playstation` | Gaming console retail. Three-surface channel layout, cyan hover-scale interaction |
| SpaceX | `spacex` | Space technology. Stark black and white, full-bleed imagery, futuristic |
| Spotify | `spotify` | Music streaming. Vibrant green on dark, bold type, album-art-driven |
| The Verge | `theverge` | Tech editorial media. Acid-mint and ultraviolet accents, Manuka display type |
| Uber | `uber` | Mobility platform. Bold black and white, tight type, urban energy |
| Vodafone | `vodafone` | Global telecom brand. Monumental uppercase display, Vodafone Red chapter bands |
| WIRED | `wired` | Tech magazine. Paper-white broadsheet density, custom serif, ink-blue links |

### Automotive

| Brand | Slug | Style cues |
| ----- | ---- | ---------- |
| BMW | `bmw` | Luxury automotive. Dark premium surfaces, precise German engineering aesthetic |
| BMW M | `bmw-m` | Performance automotive. Motorsport-inspired contrast, M color accents, precision-driven layout |
| Bugatti | `bugatti` | Luxury hypercar. Cinema-black canvas, monochrome austerity, monumental display type |
| Ferrari | `ferrari` | Luxury automotive. Chiaroscuro black-white editorial, Ferrari Red with extreme sparseness |
| Lamborghini | `lamborghini` | Luxury automotive. True black cathedral, gold accent, LamboType custom Neo-Grotesk |
| Renault | `renault` | French automotive. Vivid aurora gradients, NouvelR proprietary typeface, zero-radius buttons |
| Tesla | `tesla` | Electric vehicles. Radical subtraction, cinematic full-viewport photography, Universal Sans |

### Retro Web

| Brand | Slug | Style cues |
| ----- | ---- | ---------- |
| Dell (1996) | `dell-1996` | Catalog-era enterprise web. Black page frame, flat color-block ribbon cards, Helvetica-Black titles over Times Roman body, GIF stickers |
| Nintendo.com (2001) | `nintendo-2001` | Y2K console chrome. Beveled periwinkle metal panels, halftone-dotted carbon nav, outlined Arial-Black wordmarks, pixel Mario bubble |

### Other

| Brand | Slug | Style cues |
| ----- | ---- | ---------- |
| Slack | `slack` | Workplace messaging brand. Deep aubergine primary, cream-lavender hero gradients, blue inline links, pill CTAs |

## Notes

- Proprietary fonts (SF Pro, SpotifyMixUI, SoDoSans, ...) are always listed with fallback stacks — use the fallbacks when the real font is unavailable.
- These files are community analyses of public websites, not official brand guidance. Do not imply brand endorsement; keep the `LICENSE` file with the bundle.
- To update the library, re-pull https://github.com/VoltAgent/awesome-design-md and replace `design-md/`.
