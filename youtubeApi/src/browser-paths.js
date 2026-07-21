const os = require("os");
const path = require("path");
const fs = require("fs");

function getExtraChromiumProfiles() {
  const home = os.homedir();
  const platform = process.platform;
  const candidates = [];

  if (platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const appData =
      process.env.APPDATA || path.join(home, "AppData", "Roaming");

    const braveRoot = path.join(
      localAppData,
      "BraveSoftware",
      "Brave-Browser",
      "User Data",
    );
    const vivaldiRoot = path.join(localAppData, "Vivaldi", "User Data");

    candidates.push(
      { name: "Brave (Default)", path: path.join(braveRoot, "Default") },
      { name: "Brave (Profile 1)", path: path.join(braveRoot, "Profile 1") },
      {
        name: "Opera GX",
        path: path.join(appData, "Opera Software", "Opera GX Stable"),
      },
      {
        name: "Opera",
        path: path.join(appData, "Opera Software", "Opera Stable"),
      },
      { name: "Vivaldi (Default)", path: path.join(vivaldiRoot, "Default") },
    );
  } else if (platform === "darwin") {
    const appSupport = path.join(home, "Library", "Application Support");

    const braveRoot = path.join(appSupport, "BraveSoftware", "Brave-Browser");
    const vivaldiRoot = path.join(appSupport, "Vivaldi");

    candidates.push(
      { name: "Brave (Default)", path: path.join(braveRoot, "Default") },
      { name: "Brave (Profile 1)", path: path.join(braveRoot, "Profile 1") },
      {
        name: "Opera GX",
        path: path.join(appSupport, "com.operasoftware.OperaGX"),
      },
      { name: "Opera", path: path.join(appSupport, "com.operasoftware.Opera") },
      { name: "Vivaldi (Default)", path: path.join(vivaldiRoot, "Default") },
    );
  } else if (platform === "linux") {
    const config = path.join(home, ".config");

    const braveRoot = path.join(config, "BraveSoftware", "Brave-Browser");
    const vivaldiRoot = path.join(config, "vivaldi");

    candidates.push(
      { name: "Brave (Default)", path: path.join(braveRoot, "Default") },
      { name: "Brave (Profile 1)", path: path.join(braveRoot, "Profile 1") },
      { name: "Opera GX", path: path.join(config, "opera-gx") },
      { name: "Opera", path: path.join(config, "opera") },
      { name: "Vivaldi (Default)", path: path.join(vivaldiRoot, "Default") },
    );
  }

  // Filter paths that have Cookies
  return candidates.filter((item) => {
    const hasCookiesRoot = fs.existsSync(path.join(item.path, "Cookies"));
    const hasCookiesNetwork = fs.existsSync(
      path.join(item.path, "Network", "Cookies"),
    );
    return hasCookiesRoot || hasCookiesNetwork;
  });
}

module.exports = {
  getExtraChromiumProfiles,
};
