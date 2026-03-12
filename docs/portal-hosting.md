# Portal Hosting

Use the `portal/` folder as a plain static site. Since you already have Netlify, use that first.

## 1. Prepare the portal config

Edit:

- `portal/config.js`

Set:

```js
window.PRAYERBOX_PORTAL_CONFIG = {
  projectUrl: "https://YOUR_PROJECT_REF.supabase.co",
  anonKey: "YOUR_PUBLISHABLE_KEY",
};
```

Only use the publishable key here, never the service role key.

## 2. Restrict browser origin on Supabase functions

Set the portal origin secret to your hosted domain:

```powershell
cmd /c npx supabase secrets set PRAYERBOX_PORTAL_ORIGIN=https://portal.yourdomain.com
```

Then redeploy:

```powershell
cmd /c npx supabase functions deploy claim-device --no-verify-jwt
cmd /c npx supabase functions deploy my-devices --no-verify-jwt
cmd /c npx supabase functions deploy firmware-releases --no-verify-jwt
cmd /c npx supabase functions deploy provision-device --no-verify-jwt
```

## 3. Deploy to Netlify

This repo now includes:

- `netlify.toml`
- `portal/_headers`

So Netlify can use the repo defaults without extra manual path setup.

In Netlify:

1. create a new site from this repo
2. leave the defaults from `netlify.toml`
3. deploy

The site should publish the `portal/` folder automatically.

If Netlify asks anyway, use:

- base directory: `portal`
- build command: leave empty
- publish directory: `.`

## 4. Post-deploy check

After deploy:

1. open the hosted Netlify URL
2. sign in with a normal user
3. verify `My Devices` loads
4. sign in with an admin user
5. verify `Create Release` works
6. verify `Provision Device` returns a claim code and a device API key
7. copy the final Netlify URL
8. set `PRAYERBOX_PORTAL_ORIGIN` to that exact URL and redeploy the portal-facing functions

## 5. Recommended next step

Once the hosted portal is stable:

1. attach a custom domain
2. enable HTTPS-only redirects
3. move from manual `config.js` editing to CI/CD environment substitution if you want cleaner deployments
