# REALGX 4K

A responsive wallpaper gallery for desktop and mobile, with a Supabase-backed catalogue, a protected admin upload dashboard, and a shared wallpaper Studio.

**Live website:** https://realgx.vercel.app  
**GitHub:** https://github.com/vaishnav-biju/REALGX-4K

## What the project includes

- Responsive wallpaper gallery for desktop and mobile browsers.
- Wallpaper catalogue loaded from Supabase.
- Search and browsing controls for the wallpaper collection.
- Wallpaper details, preview and Studio mockup views.
- Per-view image adjustments such as zoom, position, rotation and visual tuning.
- Favorites and a save-for-later list stored in the visitor's browser.
- Separate admin dashboard at [`/admin`](https://realgx.vercel.app/admin).
- Admin publishing flow with multiple-image import and image review.
- ImgBB image hosting through a Supabase Edge Function; the ImgBB API key stays server-side.

## Technology

- HTML, CSS and vanilla JavaScript.
- Tailwind CSS 3.4.17 via CDN.
- Supabase JavaScript client v2 via CDN.
- Supabase Database and Row Level Security (RLS).
- Supabase Edge Functions (Deno).
- ImgBB for hosted image files.
- Vercel for static-site hosting and the `/admin` rewrite.

This repository does not use a frontend build framework or bundler.

## Repository layout

```text
.
├── index.html
├── admin.html
├── vercel.json
├── supabase-setup.sql
└── supabase/
    └── functions/
        └── imgbb-upload/
            └── index.ts
```

## Supabase setup

1. Create a Supabase project.
2. Open the SQL Editor and run [`supabase-setup.sql`](./supabase-setup.sql).
3. Confirm that the `wallpapers` and `wallpaper_layouts` tables exist and that RLS is enabled on both.
4. Configure the Supabase project URL and publishable key in the browser configuration in `index.html` and `admin.html`. A publishable key is designed for browser use; never put a service-role or secret key in either file.
5. Create the intended admin Auth user. Assign `app_metadata.role = "admin"` using a trusted server-side/admin process. Do not rely on user-editable metadata for authorization.
6. Deploy the Edge Function and configure its secret as described below.

### Database access model

- `wallpapers`: visitors can read published wallpaper records. Insert, update and delete operations are restricted by RLS to authenticated users whose trusted `app_metadata.role` is exactly `admin`.
- `wallpaper_layouts`: visitors can read and write shared layout adjustments. This is intentional in the current product so visitors can contribute adjustments without signing in.

**Public editing trade-off:** because shared layout writes are open, any visitor can overwrite a saved layout for a wallpaper. If that is no longer desired, change these policies to admin-only or add an authenticated moderation workflow before relying on shared layouts.

The setup SQL is intended for a fresh project and is safe to re-run for the objects and policies it defines. It does not migrate or delete existing wallpaper records.

## ImgBB upload function

The admin dashboard calls the Supabase function:

```text
https://dhrbmkwijciwpzkwexzq.supabase.co/functions/v1/imgbb-upload
```

The function:

- Requires a valid Supabase access token (JWT verification is enabled).
- Verifies the user with Supabase Auth.
- Checks the trusted `app_metadata.role` for the `admin` role.
- Reads `IMGBB_API_KEY` from Edge Function secrets.
- Accepts image content only and enforces a 3 MB maximum per image.
- Returns preview and full-image URLs without exposing the ImgBB key.

### Configure the ImgBB secret

In the Supabase Dashboard, open **Edge Functions → Secrets** and add:

- **Name:** `IMGBB_API_KEY`
- **Value:** your ImgBB API key

Never commit the key or paste it into frontend code, this README, or GitHub issues.

### Deploy the function

With the Supabase CLI installed and linked to your project:

```bash
supabase functions deploy imgbb-upload
```

The function source is in [`supabase/functions/imgbb-upload/index.ts`](./supabase/functions/imgbb-upload/index.ts).

## Run locally

Because the frontend is static, you can serve the repository with any simple local HTTP server. For example, with Python installed:

```bash
python -m http.server 8000
```

Then open:

- Gallery: http://localhost:8000
- Admin: http://localhost:8000/admin.html

The Supabase project, database policies, admin account and ImgBB secret must be configured for cloud-backed features to work.

## Deploy on Vercel

1. Import this GitHub repository into Vercel.
2. Keep the project as a static site; no build command is required.
3. Use the repository root as the output directory.
4. Deploy. The included `vercel.json` rewrites `/admin` to `/admin.html`.

## Important notes

- The Supabase publishable key in browser code is not a secret. Security depends on correct RLS policies and server-side checks.
- Never expose the Supabase service-role key or ImgBB API key in browser code.
- The upload endpoint currently accepts files up to 3 MB each. The limit is enforced by the Edge Function.
- Deleting a wallpaper record from the admin dashboard does not delete its image from ImgBB.
- Browser-stored favorites and save-for-later items are local to that browser/device.
- The project uses Tailwind's CDN build for convenience; for a larger production deployment, review the Tailwind recommendation to compile CSS instead of relying on the CDN.
- This repository documents the current implementation. Features should be tested in the live site before being described as fully verified.

## Project status

REALGX 4K is deployed and connected to Supabase. The codebase and setup documentation are being maintained alongside the live project.
