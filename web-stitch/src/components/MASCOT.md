# Woody mascot system

`Mascot` is the production SVG mascot used by Woody. It has no raster-image dependency: its head layers, face controls, body, limbs, and accessory slots are separate SVG groups.

The mascot is the interactive workflow copilot, not the product logo. Product branding stays in `BrandMark.tsx` and uses `/woody-logo.png`; the authenticated assistant is implemented in `features/copilot/WoodyChat.tsx`.

## Basic use

```tsx
import { Mascot } from './components/Mascot';

<Mascot
  expression="happy"
  size={240}
  speaking
  thinking={false}
  loading={false}
  waving={false}
  floating
  blink
/>
```

The `loading` and `thinking` flags temporarily override `expression`. Use `decorative` when nearby text already provides the meaning; otherwise provide a useful `ariaLabel`.

## Expressions

All expression definitions live in `Expressions.ts`. Supported values are:

`neutral`, `happy`, `veryHappy`, `laughing`, `excited`, `curious`, `thinking`, `confused`, `surprised`, `sleepy`, `worried`, `sad`, `angry`, `determined`, `proud`, `embarrassed`, `love`, `shy`, `loading`, `typing`, `listening`, `processing`, `error`, `offline`, `success`, and `celebrating`.

Expressions only change eyes, eyebrows, mouth, cheeks, and restrained pose values. They never replace the mascot silhouette.

## Skins and colors

```tsx
<Mascot expression="curious" skin="midnight" />

<Mascot
  expression="proud"
  colors={{ purpleFront: '#8b5cf6', accent: '#34d399' }}
/>
```

Built-in skins are `classic`, `midnight`, and `rose`. A partial `colors` object overrides individual palette tokens without changing geometry.

## Accessories

Accessory slots accept SVG elements in the mascot's `0 0 240 300` coordinate system:

```tsx
<Mascot
  expression="listening"
  accessories={{
    head: <path d="M 60 52 Q 120 20 180 52" fill="#111827" />,
    body: <circle cx="120" cy="204" r="8" fill="#fbbf24" />,
  }}
/>
```

Available slots are `antenna`, `head`, `face`, `body`, and `foreground`. Hats, headphones, glasses, badges, and seasonal overlays should use these slots rather than edit the base geometry.

## Production guidance

- Use the numeric `size` prop at 32, 48, 64, 128, 256, or 512 pixels; SVG remains sharp at any size.
- Keep `floating={false}` in dense lists and tables.
- Keep a single active animated mascot in compact screens when possible.
- Respect the user's reduced-motion preference; the component handles it automatically.
- Preview changes at `/mascot-lab` before using a new expression, skin, or accessory.
- Add new emotions to `Expressions.ts`; do not add expression-specific geometry to `Mascot.tsx`.

The component tree is memoized. Motion features are lazy-loaded, and animation relies on SVG transforms and shared morph-compatible paths rather than recalculating geometry during render.
