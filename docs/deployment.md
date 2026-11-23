# Docker deployment

The deployment has three containers: the Bun API, the static Manager app, and the static Field PWA. `compose.yml` is the standard Compose file. The frontend containers serve the built React apps and reverse-proxy `/api/` to the API over the private Compose network. MongoDB remains an external cloud service; no MongoDB container or local database volume is created.

## Host configuration

1. Install Docker Engine and the Docker Compose plugin on the host.
2. Copy `.env.production.example` to `.env.production` and fill in the cloud MongoDB URI, provider credentials, S3 bucket/region, and the public Manager HTTPS origin.
3. Use the VM's TLS setup to terminate HTTPS and reverse-proxy the Manager to `127.0.0.1:4007` and the Field PWA to `127.0.0.1:4008`. The API is available to the VM at `127.0.0.1:4009`. The apps use same-origin `/api` requests through their own Bun server.
4. Run `./deploy.sh` from the checked-out `main` branch. The script rejects dirty trees and missing configuration, fast-forward pulls `origin/main`, validates Compose, builds the images, and starts the services.

Certbot obtains/renews certificates; it does not itself serve the apps or proxy requests. The VM's HTTPS server must route the two public app origins to the ports above. The Field PWA requires HTTPS for microphone capture and its service worker; direct HTTP access to the VM IP will not support recording.

Only the API receives MongoDB, OpenAI, Modal, and S3 configuration. `MONGODB_DATABASE` defaults to `itc_field_source`, so the cloud provider only needs to supply `MONGODB_URI` unless a different database name is required. Audio objects remain in S3; the named API volume is only for resumable upload staging.
