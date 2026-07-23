const os = require("os");
const path = require("path");
const fs = require("fs").promises;

const OS_CONFIGS = {
  win32: {
    local:
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    roaming:
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    getBrowsers(paths) {
      return [
        {
          name: "Brave",
          root: path.join(
            paths.local,
            "BraveSoftware",
            "Brave-Browser",
            "User Data",
          ),
          hasSubProfiles: true,
        },
        {
          name: "Vivaldi",
          root: path.join(paths.local, "Vivaldi", "User Data"),
          hasSubProfiles: true,
        },
        {
          name: "Opera GX",
          root: path.join(paths.roaming, "Opera Software", "Opera GX Stable"),
          hasSubProfiles: true,
        },
        {
          name: "Opera",
          root: path.join(paths.roaming, "Opera Software", "Opera Stable"),
          hasSubProfiles: true,
        },
      ];
    },
  },
  darwin: {
    appSupport: path.join(os.homedir(), "Library", "Application Support"),
    getBrowsers(paths) {
      return [
        {
          name: "Brave",
          root: path.join(paths.appSupport, "BraveSoftware", "Brave-Browser"),
          hasSubProfiles: true,
        },
        {
          name: "Vivaldi",
          root: path.join(paths.appSupport, "Vivaldi"),
          hasSubProfiles: true,
        },
        {
          name: "Opera GX",
          root: path.join(paths.appSupport, "com.operasoftware.OperaGX"),
          hasSubProfiles: true,
        },
        {
          name: "Opera",
          root: path.join(paths.appSupport, "com.operasoftware.Opera"),
          hasSubProfiles: true,
        },
      ];
    },
  },
  linux: {
    config: path.join(os.homedir(), ".config"),
    getBrowsers(paths) {
      return [
        {
          name: "Brave",
          root: path.join(paths.config, "BraveSoftware", "Brave-Browser"),
          hasSubProfiles: true,
        },
        {
          name: "Vivaldi",
          root: path.join(paths.config, "vivaldi"),
          hasSubProfiles: true,
        },
        {
          name: "Opera GX",
          root: path.join(paths.config, "opera-gx"),
          hasSubProfiles: true,
        },
        {
          name: "Opera",
          root: path.join(paths.config, "opera"),
          hasSubProfiles: true,
        },
      ];
    },
  },
};

async function checkCookieStorage(profilePath) {
  try {
    const pathsToCheck = [
      path.join(profilePath, "Cookies"),
      path.join(profilePath, "Network", "Cookies"),
    ];

    const checks = await Promise.all(
      pathsToCheck.map((p) =>
        fs
          .access(p)
          .then(() => true)
          .catch(() => false),
      ),
    );

    return checks.includes(true);
  } catch {
    return false;
  }
}

async function getExtraChromiumProfiles() {
  const platform = process.platform;
  const config = OS_CONFIGS[platform];

  if (!config) return []; // Unsupported OS

  const browsers = config.getBrowsers(config);
  const detectedProfiles = [];

  for (const browser of browsers) {
    try {
      if (browser.hasSubProfiles) {
        const items = await fs.readdir(browser.root, { withFileTypes: true });

        for (const item of items) {
          if (
            item.isDirectory() &&
            (item.name === "Default" || /^Profile \d+$/.test(item.name))
          ) {
            const profilePath = path.join(browser.root, item.name);

            if (await checkCookieStorage(profilePath)) {
              detectedProfiles.push({
                name: `${browser.name} (${item.name})`,
                path: profilePath,
                chromiumBrowser: browser.name,
              });
            }
          }
        }
      } else {
        if (await checkCookieStorage(browser.root)) {
          detectedProfiles.push({
            name: browser.name,
            path: browser.root,
            chromiumBrowser: browser.name,
          });
        }
      }
    } catch (err) {}
  }

  return detectedProfiles;
}

module.exports = {
  getExtraChromiumProfiles,
};
