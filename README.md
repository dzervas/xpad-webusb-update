# xpad-webusb-update

Update Xbox controller firmware from a Chromium browser over WebUSB. Static site,
no runtime server.

## Firmware feed

Microsoft's CDN does not send CORS headers, so a browser cannot read the feed or
the `.bin` files cross-origin. `npm run feed` downloads the current feed and every
firmware file it lists into `data/`; `npm run build` copies that to `dist/data/`.
The page reads the snapshot same-origin and verifies each file against the
SHA-256 embedded in its name.

If the snapshot is missing, the page falls back to the public allorigins proxy.
If the proxy is also down, use **Direct download** and then **Choose a local
`.bin`**. `data/` is generated and ignored by git.

## Local development

```bash
npm install
npm run feed    # network; refresh data/ from Microsoft
npm run build
python3 -m http.server 8123 -d dist
```

`npm run check` type-checks without writing `dist/`.

## Deploy

Push this directory as its own repository, then set **Settings → Pages → Source**
to **GitHub Actions**. `.github/workflows/pages.yml` builds on every push, on a
daily schedule, and on manual dispatch. It runs `npm run feed` before the build,
so the deployed feed and firmware stay current even when the page source does
not change.

## Linux note

Chromium does not detach kernel drivers. The page's **Setup & safety** section
has the exact `uaccess` rule and the `xpad` unbind commands; the permission rule
and the driver release are separate steps. On NixOS, install the rule as a
`70-*` file through `services.udev.packages`; `services.udev.extraRules` is too
late for the `uaccess` builtin.
