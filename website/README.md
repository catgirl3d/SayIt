# SayIt Website

Standalone static landing page for the SayIt desktop application (`catgirl3d/SayIt`).

## Structure

- `index.html` — Semantic page structure with RU / UK / EN localization support
- `styles.css` — Responsive dark/light theme styling aligned with SayIt's desktop UI tokens
- `app.js` — Language switcher, theme toggle, interactive overlay pill simulator, and screenshot gallery
- `assets/` — Local copy of the SayIt icon and app screenshots so the folder can be deployed standalone

## Local Preview

Open `index.html` directly in a browser, or serve the folder over HTTP:

```bash
npx serve website
```

## Deployment

Upload the contents of `website/` directly to any static host (GitHub Pages, Cloudflare Pages, Netlify, Vercel, or Nginx) — no build step is required.
