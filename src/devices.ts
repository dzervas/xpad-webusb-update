export type Support = "tested" | "untested" | "legacy" | "unsupported";

export interface KnownDevice {
  vendorId: number;
  productId: number;
  name: string;
  codename: string;
  support: Support;
  note?: string;
}

/**
 * Controllers listed by xboxctl (https://github.com/bb441db/xboxctl).
 * "tested" means the updater has been verified on that model.
 */
export const KNOWN_DEVICES: KnownDevice[] = [
  {
    vendorId: 0x045e,
    productId: 0x0b12,
    name: "Xbox Wireless Controller (Series X|S)",
    codename: "MERL",
    support: "tested",
  },
  {
    vendorId: 0x045e,
    productId: 0x02ea,
    name: "Xbox Wireless Controller (One S)",
    codename: "CRET",
    support: "tested",
  },
  {
    vendorId: 0x045e,
    productId: 0x0b00,
    name: "Xbox Elite Wireless Controller Series 2",
    codename: "DELP",
    support: "untested",
  },
  {
    vendorId: 0x045e,
    productId: 0x0b0a,
    name: "Xbox Adaptive Controller",
    codename: "ZEPH",
    support: "untested",
  },
  {
    vendorId: 0x045e,
    productId: 0x0b1a,
    name: "Xbox Adaptive Joystick",
    codename: "DURA",
    support: "untested",
  },
  {
    vendorId: 0x045e,
    productId: 0x0b1c,
    name: "Xbox Adaptive Joystick",
    codename: "DURA",
    support: "untested",
  },
  {
    vendorId: 0x045e,
    productId: 0x02e3,
    name: "Xbox Elite Wireless Controller (Series 1)",
    codename: "TROY",
    support: "untested",
  },
  {
    vendorId: 0x045e,
    productId: 0x02dd,
    name: "Xbox Wireless Controller (2015)",
    codename: "LANG",
    support: "untested",
  },
  {
    vendorId: 0x045e,
    productId: 0x02d1,
    name: "Xbox Wireless Controller (2013)",
    codename: "ARGO",
    support: "legacy",
    note: "Uses the legacy UFU protocol 1, which is not supported.",
  },
  {
    vendorId: 0x045e,
    productId: 0x02d2,
    name: "Xbox Wireless Controller (2013)",
    codename: "ARGD",
    support: "legacy",
    note: "Uses the legacy UFU protocol 1, which is not supported.",
  },
  {
    vendorId: 0x2e95,
    productId: 0x0504,
    name: "SCUF Instinct Pro",
    codename: "SCUF/MERL",
    support: "unsupported",
    note: "Microsoft ships MERL firmware for it, but the package's USB IDs do not match the controller.",
  },
];

export function lookupDevice(vendorId: number, productId: number): KnownDevice | undefined {
  return KNOWN_DEVICES.find(
    (device) => device.vendorId === vendorId && device.productId === productId,
  );
}

export function supportLabel(support: Support): string {
  switch (support) {
    case "tested":
      return "tested";
    case "untested":
      return "untested model";
    case "legacy":
      return "legacy, unsupported";
    case "unsupported":
      return "unsupported";
  }
}

export type Platform = "linux" | "windows" | "macos" | "chromeos" | "android" | "other";

export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/CrOS/i.test(ua)) return "chromeos";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  if (/Linux/i.test(ua)) return "linux";
  return "other";
}

export interface ReleaseStep {
  text: string;
  code?: string;
}

export interface ReleaseInstructions {
  title: string;
  intro: string;
  steps: ReleaseStep[];
  note?: string;
}

export function releaseInstructions(platform: Platform): ReleaseInstructions {
  switch (platform) {
    case "linux":
      return {
        title: "Open the controller and release it from xpad (Linux)",
        intro:
          "Two separate things: the udev rule lets your user open /dev/bus/usb/…, and the unbind releases interface 0 from xpad. Chromium-based browsers will not detach the driver for you.",
        steps: [
          {
            text: "Allow your user to open the controller's USB device node, then replug the controller. This rule lives in /run until reboot, so it also works on NixOS and systems with a read-only /etc:",
            code:
              'sudo install -d /run/udev/rules.d\necho \'SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{bDeviceClass}=="ff", ATTR{bDeviceSubClass}=="47", ATTR{bDeviceProtocol}=="d0", TAG+="uaccess"\' \\\n  | sudo tee /run/udev/rules.d/70-xbox-webusb.rules\nsudo udevadm control --reload-rules\nsudo udevadm trigger --action=add --subsystem-match=usb',
          },
          {
            text: "Find the interface that xpad owns, then unbind that one interface:",
            code:
              "ls -l /sys/bus/usb/drivers/xpad/\n# e.g. 5-3:1.0\necho -n '5-3:1.0' | sudo tee /sys/bus/usb/drivers/xpad/unbind",
          },
          {
            text: "After the update, replug the controller, or bind the interface back:",
            code: "echo -n '5-3:1.0' | sudo tee /sys/bus/usb/drivers/xpad/bind",
          },
        ],
        note: "NixOS: do not use services.udev.extraRules for this. It becomes 99-local.rules, which is too late for the uaccess builtin; install the same rule with services.udev.packages and destination = \"/etc/udev/rules.d/70-xbox-webusb.rules\". The /run rule above works without a rebuild. If the controller is bound to another driver (for example xpadneo), use that driver's directory under /sys/bus/usb/drivers/ instead.",
      };
    case "windows":
      return {
        title: "Bind WinUSB to the controller (Windows)",
        intro:
          "WebUSB cannot use the stock Xbox driver. Replace it with WinUSB for the duration of the update.",
        steps: [
          {
            text: "Install WinUSB with Zadig: Options → List All Devices, select “Controller” (USB ID 045E:0B12), choose WinUSB, then Replace Driver.",
            code: "https://zadig.akeo.ie/",
          },
          {
            text: "The controller will stop working as a gamepad while WinUSB is bound. To restore it afterwards: Device Manager → the controller → Uninstall device (tick “Delete the driver software”), then replug.",
          },
          {
            text: "The Xbox Accessories app cannot update the controller while WinUSB is bound, so use this page (or restore the stock driver first).",
          },
        ],
      };
    case "macos":
      return {
        title: "macOS is not supported for WebUSB updates",
        intro:
          "Apple's XboxUSBDevice driver holds the controller exclusively and there is no supported way for a browser to take it over.",
        steps: [
          {
            text: "Use the native tool instead; it runs as root and can claim the device:",
            code: "sudo xboxctl update --latest",
          },
          {
            text: "Install it from https://github.com/bb441db/xboxctl if you do not have it.",
          },
        ],
      };
    case "chromeos":
      return {
        title: "No driver to release (ChromeOS)",
        intro: "ChromeOS does not bind xpad. Connect the controller with a data cable and press Connect.",
        steps: [],
      };
    case "android":
      return {
        title: "No driver to release (Android)",
        intro:
          "Connect the controller through USB-OTG and allow the device when Chrome asks. A desktop browser is still the better-tested path.",
        steps: [],
      };
    default:
      return {
        title: "Release the controller from its driver",
        intro:
          "Another driver probably owns the controller's vendor interface. Find the driver for interface 0 and unbind it, or use Linux/Windows/ChromeOS.",
        steps: [],
      };
  }
}

export function hex4(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}
