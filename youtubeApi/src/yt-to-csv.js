const fs = require("fs");
const readline = require("readline/promises");
const { getExtraChromiumProfiles } = require("./browser-paths");
const { Innertube, Log } = require("youtubei.js");

Log.setLevel(Log.Level.NONE);

function escapeCsv(text) {
  if (!text) return '""';
  const safeText = text.toString().replace(/"/g, '""');
  return `"${safeText}"`;
}

async function extractYouTubeCookies() {
  const { getCookies, toCookieHeader } = await import("@steipete/sweet-cookie");

  console.log(
    "🔍 Scanning default browsers (Chrome, Edge, Firefox, Safari)...",
  );
  let result = await getCookies({
    url: "https://music.youtube.com",
    origins: ["https://music.youtube.com", "https://youtube.com"],
    browsers: ["chrome", "edge", "firefox", "safari"],
  });

  let rawCookie = result.cookies ? toCookieHeader(result.cookies) : "";
  if (rawCookie.includes("SAPISID=")) {
    console.log("✅ Authenticated YouTube session found in default browser.");
    return rawCookie;
  }

  if (process.platform === "darwin") {
    console.log("🔍 Scanning macOS Brave/Arc installations...");
    for (const bg of ["brave", "arc"]) {
      result = await getCookies({
        url: "https://music.youtube.com",
        origins: ["https://music.youtube.com", "https://youtube.com"],
        browsers: ["chrome"],
        chromiumBrowser: bg,
      });
      rawCookie = result.cookies ? toCookieHeader(result.cookies) : "";
      if (rawCookie.includes("SAPISID=")) {
        console.log(`✅ Authenticated YouTube session found in macOS ${bg}.`);
        return rawCookie;
      }
    }
  }

  const extraProfiles = await getExtraChromiumProfiles();

  for (const item of extraProfiles) {
    console.log(`🔍 Checking profile: ${item.name} in ${item.path}...`);
    try {
      result = await getCookies({
        url: "https://music.youtube.com",
        origins: ["https://music.youtube.com", "https://youtube.com"],
        browsers: ["chrome"],
        chromeProfile: item.path,
        chromiumBrowser: item.chromiumBrowser,
      });
      rawCookie = result.cookies ? toCookieHeader(result.cookies) : "";
      if (rawCookie.includes("SAPISID=")) {
        console.log(`✅ Authenticated YouTube session found in ${item.name}!`);
        return rawCookie;
      }
    } catch (_) {}
  }

  return "";
}

async function exportPlaylist() {
  try {
    console.log("🍪 Extracting YouTube Music session cookies...");
    const USER_COOKIE = await extractYouTubeCookies();

    if (!USER_COOKIE) {
      throw new Error(
        "Could not find a logged-in YouTube session. Keep your browser closed and try again.",
      );
    }

    const yt = await Innertube.create({ cookie: USER_COOKIE });

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const rawInput = await rl.question(
      "\nEnter YouTube Music Playlist URL or ID: ",
    );
    rl.close();

    let playlistId =
      rawInput.match(/[?&]list=([a-zA-Z0-9_-]+)/)?.[1] || rawInput.trim();
    if (!playlistId.startsWith("VL") && playlistId !== "LM") {
      playlistId = "VL" + playlistId;
    }

    console.log(
      `\n🔍 Fetching internal playlist data for ID: ${playlistId}...`,
    );

    const playlist = await yt.getPlaylist(playlistId);

    const allTracks = [];

    const processItems = (items) => {
      if (!items) return;
      for (const song of items) {
        if (song.id) {
          allTracks.push({
            title: song.title || "Unknown Title",
            artist:
              song.artists?.map((a) => a.name).join(", ") || "Unknown Artist",
            videoId: song.id,
            url: `https://youtube.com/watch?v=${song.id}`,
          });
        }
      }
    };

    processItems(playlist.items);
    let pageCount = 1;
    console.log(
      `🔎 Scraped page ${pageCount} (Total tracks so far: ${allTracks.length})`,
    );

    let page = playlist;
    while (page.has_continuation) {
      page = await page.getContinuation();
      processItems(page.items);
      pageCount++;
      console.log(
        `🔎 Scraped page ${pageCount} (Total tracks so far: ${allTracks.length})`,
      );
    }

    if (allTracks.length === 0) {
      console.log(
        "⚠️ No tracks found. Check if the playlist is empty or the ID is correct.",
      );
      return;
    }

    const cleanId = playlistId.replace("VL", "");
    const filename = `Internal_Export_${cleanId}.csv`;
    const csvLines = ["Title,Artist,URL,VideoID"];

    for (const track of allTracks) {
      csvLines.push(
        `${escapeCsv(track.title)},${escapeCsv(track.artist)},${escapeCsv(track.url)},${escapeCsv(track.videoId)}`,
      );
    }

    fs.writeFileSync(filename, csvLines.join("\n"), "utf8");
    console.log(
      `\n✅ Success! Exported ${allTracks.length} tracks to ${filename}`,
    );
  } catch (err) {
    console.error("\n❌ Error:", err.message);
  }
}

exportPlaylist();
