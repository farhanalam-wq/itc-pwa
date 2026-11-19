# Single administrator setup

The manager app supports one administrator account for this deployment. There is no tenant model, public signup, or additional user role.

## API environment

Set these values in `apps/api/.env` (keep the file out of Git):

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=itc_field_source
ADMIN_SETUP_TOKEN=<long-random-one-time-token>
MANAGER_ORIGIN=http://localhost:5180
```

For production, use the managed MongoDB URI, replace `MANAGER_ORIGIN` with the HTTPS manager origin, and route manager/API traffic through that same origin. Do not put `ADMIN_SETUP_TOKEN`, MongoDB credentials, or session values in a `VITE_` variable.

## Create the first administrator

1. Start MongoDB and the API with `MONGODB_URI` and `MONGODB_DATABASE` configured.
2. Open the manager app. It will show setup while the primary admin record does not exist.
3. Enter the `ADMIN_SETUP_TOKEN`, the administrator’s email, display name, and a password of at least 12 characters.
4. The API creates the fixed `primary` account and signs it in. A second bootstrap attempt receives a conflict response.

The password is hashed with Bun’s password API. Session cookies are HttpOnly, SameSite=Lax, and Secure when `NODE_ENV=production`. MongoDB stores only a SHA-256 hash of each random session token and expires sessions after 12 hours.

After setup, remove `ADMIN_SETUP_TOKEN` from the API environment and restart the API. The account remains usable for login; first-run setup stays closed. If the admin account must be reset, use an operator-controlled database maintenance procedure rather than exposing a public reset or signup endpoint.

The API protects manager recording/report, transcript, and audio playback endpoints. Field capture metadata registration and recording sync endpoints stay available to the PWA without an administrator session. The manager must be served from `MANAGER_ORIGIN`; development uses the Vite `/api` proxy on port 5180.
