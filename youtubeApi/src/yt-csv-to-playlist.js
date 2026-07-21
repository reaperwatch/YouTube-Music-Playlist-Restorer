const fs = require("fs");
const path = require("path");
const os = require("os");
const csv = require("csv-parser");
const crypto = require("crypto");
const readline = require("readline/promises");

const BATCH_SIZE = 20; // Number of videos to add in each batch request (change to your liking but keep it reasonable to avoid rate limits)

function getAuthHeader(cookieStr) {
  const match = cookieStr.match(/SAPISID=([^;]+)/);
  if (!match) return "";
  const time = Math.floor(Date.now() / 1000);
  const hash = crypto
    .createHash("sha1")
    .update(`${time} ${match[1]} https://music.youtube.com`)
    .digest("hex");
  return `SAPISIDHASH ${time}_${hash}`;
}

const { getExtraChromiumProfiles } = require("./browser-paths");

async function extractYouTubeCookies(getCookies, toCookieHeader) {
  // native backends
  console.log(
    "🔍 Scanning default browsers (Chrome, Edge, Firefox, Safari)...",
  );
  let result = await getCookies({
    url: "https://music.youtube.com",
    browsers: ["chrome", "edge", "firefox", "safari"],
  });

  let rawCookie = result.cookies ? toCookieHeader(result.cookies) : "";
  if (rawCookie.includes("SAPISID=")) {
    console.log("✅ Authenticated YouTube session found in default browser.");
    return rawCookie;
  }

  // macOS specific Brave/Arc targeting if on Darwin
  if (process.platform === "darwin") {
    console.log("🔍 Scanning macOS Brave/Arc installations...");
    for (const bg of ["brave", "arc"]) {
      result = await getCookies({
        url: "https://music.youtube.com",
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

  // specific profile paths Windows/Linux/macOS
  const extraProfiles = getExtraChromiumProfiles();

  for (const item of extraProfiles) {
    console.log(`🔍 Checking profile: ${item.name}...`);
    try {
      result = await getCookies({
        url: "https://music.youtube.com",
        browsers: ["chrome"],
        chromeProfile: item.path,
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

async function selectCsvFile() {
  const currentDir = process.cwd();
  const allFiles = fs.readdirSync(currentDir);

  const csvFiles = allFiles.filter((file) =>
    file.toLowerCase().endsWith(".csv"),
  );
  // =0
  if (csvFiles.length === 0) {
    throw new Error(
      `No .csv files found in the current directory (${currentDir}).`,
    );
  }

  // =1
  if (csvFiles.length === 1) {
    console.log(
      `\n📄 Found exactly one CSV file. Auto-selecting: ${csvFiles[0]}`,
    );
    return { path: path.join(currentDir, csvFiles[0]), filename: csvFiles[0] };
  }

  // >=2
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n📄 Multiple CSV files found. Please choose one:");
  csvFiles.forEach((file, index) => {
    console.log(`  [${index + 1}] ${file}`);
  });

  while (true) {
    const answer = await rl.question(
      `\nEnter a number (1-${csvFiles.length}): `,
    );
    const choice = parseInt(answer.trim(), 10);

    if (!isNaN(choice) && choice >= 1 && choice <= csvFiles.length) {
      rl.close();
      const selectedFile = csvFiles[choice - 1];
      console.log(`✅ Selected: ${selectedFile}`);
      return {
        path: path.join(currentDir, selectedFile),
        filename: selectedFile,
      };
    } else {
      console.log("❌ Invalid choice. Please enter one of the numbers above.");
    }
  }
}

async function restorePlaylist() {
  try {
    const { getCookies, toCookieHeader } =
      await import("@steipete/sweet-cookie");

    const selectedCsv = await selectCsvFile();
    const csvPath = selectedCsv.path;

    console.log("🍪 Extracting YouTube Music session cookies...");
    const USER_COOKIE = await extractYouTubeCookies(getCookies, toCookieHeader);

    if (!USER_COOKIE) {
      throw new Error(
        "Could not find an active YouTube Music session with SAPISID cookie. " +
          "Make sure you are logged into https://music.youtube.com in your browser. (and keep the browser closed while running this script)",
      );
    }
    const authHeader = getAuthHeader(USER_COOKIE);

    if (!authHeader) throw new Error("Could not find SAPISID in cookie.");

    const headers = {
      accept: "*/*",
      "content-type": "application/json",
      cookie: USER_COOKIE,
      origin: "https://music.youtube.com",
      authorization: authHeader,
      "x-youtube-client-name": "67",
      "x-youtube-client-version": "1.20260318.00.00",
    };

    const baseContext = {
      client: { clientName: "WEB_REMIX", clientVersion: "1.20260318.00.00" },
    };

    const videoIds = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(csvPath)
        .pipe(csv())
        .on("data", (row) => {
          const idKey = Object.keys(row).find((key) => key.includes("ID"));

          if (idKey && row[idKey]) {
            videoIds.push(row[idKey].trim());
          }
        })
        .on("end", resolve)
        .on("error", reject);
    });

    const total = videoIds.length;
    console.log(`📂 Found ${total} tracks. Initializing...`);

    // Create Playlist with first batch
    const firstBatch = videoIds.slice(0, BATCH_SIZE);
    const createRes = await fetch(
      "https://music.youtube.com/youtubei/v1/playlist/create",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          context: baseContext,
          title: "Restored Library Backup",
          privacyStatus: "PRIVATE",
          videoIds: firstBatch,
        }),
      },
    );

    const createData = await createRes.json();
    if (!createData.playlistId) throw new Error("Failed to create playlist.");

    const playlistId = createData.playlistId;
    console.log(`✨ Playlist Created! (ID: ${playlistId})`);

    // Batch add with random delays
    for (let i = BATCH_SIZE; i < total; i += BATCH_SIZE) {
      const chunk = videoIds.slice(i, i + BATCH_SIZE);
      const actions = chunk.map((id) => ({
        action: "ACTION_ADD_VIDEO",
        addedVideoId: id,
      }));

      const editRes = await fetch(
        "https://music.youtube.com/youtubei/v1/browse/edit_playlist",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ context: baseContext, playlistId, actions }),
        },
      );

      console.log(
        `🚀 Progress: [${Math.min(i + BATCH_SIZE, total)}/${total}] added.`,
      );

      // Random delay between 5 to 30 seconds to avoid rate limits
      const randomDelay = Math.floor(Math.random() * (30000 - 5000 + 1) + 5000);
      console.log(
        `⏱️ Waiting for ${randomDelay / 1000} seconds before next batch...`,
      );
      await new Promise((r) => setTimeout(r, randomDelay));
    }

    console.log("\n🎊 Restore Complete!");
  } catch (err) {
    console.error("❌ Script Error:", err.message);
  }
}

restorePlaylist();
