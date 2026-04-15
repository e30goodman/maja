<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/8e8bab62-92b2-4c73-af02-6d5f32c56d91

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Deploy into Maja (`/konnakol/adi-talam/`)

`vite.config.ts` uses `base: '/konnakol/adi-talam/'`. After changes to this app:

1. `npm run build`
2. Copy everything from `dist/` into [`../maja/public/konnakol/adi-talam/`](../maja/public/konnakol/adi-talam/) (replace `index.html` and `assets/`).
