# xpad-webusb-update

Update Xbox controller firmware from a Chromium browser over WebUSB, and copy
official GuliKit KK3 Max/Pro firmware to the controller's update drive. Static
site, no runtime server.

## Firmware feeds

Microsoft's CDN does not send CORS headers, so a browser cannot read the feed or
the `.bin` files cross-origin. GuliKit's site is the same. `npm run feed`
downloads the current Xbox feed and the official KK3 Max/Pro package into
`data/`; `npm run build` copies that to `dist/data/`. The page reads the
snapshots same-origin and verifies each file against its SHA-256.

If the Xbox snapshot is missing, the page falls back to the public allorigins
proxy and then to a local `.bin`. If GuliKit's site rate-limits the feed build,
the script keeps the previous `data/gulikit/` snapshot and the page offers the
official download plus a local `.bin` fallback. `data/` is generated and ignored
by git.

GuliKit's own download endpoint sits behind an image captcha. The feed script
tries it first and, if it gets the verification page, downloads the same
official package from GBAtemp's mirror. The page always links GuliKit's official
firmware page, and every bundled file is verified by SHA-256 before it is used.

GuliKit's update mode is a small FAT volume named `GuliKit`, not a WebUSB
interface. The page writes the verified `.bin` with the File System Access API
when the browser supports it; otherwise it downloads the file for a manual copy
to the drive root.

## Local development

```bash
npm install
npm run feed    # network; refresh data/ from Microsoft and GuliKit
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
