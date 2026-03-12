# Group Communities

Users can now:

1. create their own PRayerbox community group
2. join another group with an invite code
3. move their claimed devices into any group they belong to
4. record and play back daily readings only inside that group's feed

## One-time SQL step

Run:

- `supabase/group-communities-upgrade.sql`

This:

1. adds group invite codes and creators
2. creates `group_memberships`
3. backfills memberships from already-claimed devices
4. scopes `daily_reading_recordings` to `group_id`

## Functions to deploy

Deploy:

```powershell
cmd /c npx supabase functions deploy my-groups --no-verify-jwt
cmd /c npx supabase functions deploy create-group --no-verify-jwt
cmd /c npx supabase functions deploy join-group --no-verify-jwt
cmd /c npx supabase functions deploy set-device-group --no-verify-jwt
cmd /c npx supabase functions deploy daily-reading-recordings --no-verify-jwt
cmd /c npx supabase functions deploy claim-device --no-verify-jwt
```

## User flow

1. Sign in on the main portal
2. Create a group, or join one with an invite code
3. Move each claimed device into the desired group
4. Open `readings.html`
5. Choose the same group to record or listen to that community's reading

## Notes

- Device syncing still follows `devices.group_id`
- Claiming a device now also adds the claimant to that device's current group
- The readings page now requires sign-in and a selected group for community audio
