const fs = require("fs");
const path = require("path");

function writeNetscapeCookiesFile(cookies, outputPath) {
  const lines = ["# Netscape HTTP Cookie File"];

  for (const cookie of cookies || []) {
    const domain = cookie.domain || "";
    const flag =
      cookie.domain && cookie.domain.startsWith(".") ? "TRUE" : "FALSE";
    const cookiePath = cookie.path || "/";
    const secure = cookie.secure ? "TRUE" : "FALSE";
    const expiry = typeof cookie.expires === "number" ? cookie.expires : 0;
    const name = cookie.name || "";
    const value = cookie.value || "";

    lines.push(
      `${domain}\t${flag}\t${cookiePath}\t${secure}\t${expiry}\t${name}\t${value}`,
    );
  }

  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

(async () => {
  const { getCookies, toCookieHeader } = await import("@steipete/sweet-cookie");

  const { getExtraChromiumProfiles } = require("./browser-paths");

  console.log(
    "🔍 Scanning default browsers (Chrome, Edge, Firefox, Safari)...",
  );
  let result = await getCookies({
    url:
      "https://music.youtube.com" &&
      "https://youtube.com" &&
      "https://www.youtube.com",
    browsers: ["chrome", "edge", "firefox", "safari"],
  });

  let rawCookie = result.cookies ? toCookieHeader(result.cookies) : "";
  if (rawCookie.includes("SAPISID=")) {
    console.log("✅ Authenticated YouTube session found in default browser.");
  }

  if (process.platform === "darwin") {
    console.log("🔍 Scanning macOS Brave/Arc installations...");
    for (const bg of ["brave", "arc"]) {
      result = await getCookies({
        url:
          "https://music.youtube.com" &&
          "https://youtube.com" &&
          "https://www.youtube.com",
        browsers: ["chrome"],
        chromiumBrowser: bg,
      });
      rawCookie = result.cookies ? toCookieHeader(result.cookies) : "";
      if (rawCookie.includes("SAPISID=")) {
        console.log(`✅ Authenticated YouTube session found in macOS ${bg}.`);
      }
    }
  }

  const extraProfiles = await getExtraChromiumProfiles();

  for (const item of extraProfiles) {
    console.log(`🔍 Checking profile: ${item.name} in ${item.path}...`);
    try {
      result = await getCookies({
        url:
          "https://music.youtube.com" &&
          "https://youtube.com" &&
          "https://www.youtube.com",
        browsers: ["chrome"],
        chromeProfile: item.path,
        chromiumBrowser: item.chromiumBrowser,
      });
      rawCookie = result.cookies ? toCookieHeader(result.cookies) : "";
      if (rawCookie.includes("SAPISID=")) {
        console.log(`✅ Authenticated YouTube session found in ${item.name}!`);
      }
    } catch (_) {}
  }

  const outputPath = path.join(process.cwd(), "cookies.txt");
  writeNetscapeCookiesFile(result.cookies || [], outputPath);
  console.log(`🍪 Wrote cookies to ${outputPath}`);
})();
