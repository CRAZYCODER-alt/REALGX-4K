# REALGX 4K

Static wallpaper gallery with a Supabase-backed admin dashboard and a protected Supabase Edge Function for ImgBB uploads.

## Live project configuration

The gallery and admin dashboard are connected to the Supabase project configured in their browser scripts. The Supabase publishable key is intentionally public; database Row Level Security protects write operations.

## Secure image upload

The admin dashboard calls:

`https://dhrbmkwijciwpzkwexzq.supabase.co/functions/v1/imgbb-upload`

The Edge Function:
- Requires a valid Supabase access token.
- Verifies the token against Supabase Auth.
- Requires `app_metadata.role === "admin"`.
- Reads `IMGBB_API_KEY` only from server-side Edge Function secrets.
- Rejects non-image uploads and files over 3 MB.
- Never sends the ImgBB key to the browser.

### Required one-time secret setup

In the Supabase Dashboard, open **Project Settings → Edge Functions → Secrets** (or the Edge Function secrets settings) and add:

- Name: `IMGBB_API_KEY`
- Value: your ImgBB API key

Do not paste this key into `admin.html`, GitHub, or a public client script. The ZIP that was supplied had a placeholder rather than an actual ImgBB key, so the function is deployed but image uploads will return a configuration error until you add the secret.

## Admin account

Set the intended Supabase Auth user's `app_metadata.role` to `admin` using a trusted server-side/admin process. Do not put the Supabase service-role key in browser code.

## Database

The SQL setup is in `supabase-setup.sql`. The existing project table and admin-only RLS policies were checked and the policies were applied.
