const fs = require("fs");
const path = require("path");
const os = require("os");
const csv = require("csv-parser");
const crypto = require("crypto");
const readline = require("readline/promises");

const BATCH_SIZE = 20; // Number of videos per batch request

function saveState(filePath, csvFilename, data) {
  let allStates = {};

  if (fs.existsSync(filePath)) {
    try {
      const rawData = fs.readFileSync(filePath, "utf8");
      allStates = JSON.parse(rawData);

      if (allStates.csvFile && typeof allStates.csvFile === "string") {
        const oldFilename = allStates.csvFile;
        delete allStates.csvFile;
        allStates = { [oldFilename]: allStates };
      }
    } catch (e) {
      allStates = {};
    }
  }

  allStates[csvFilename] = data;

  fs.writeFileSync(filePath, JSON.stringify(allStates, null, 2), "utf8");
}

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
    return rawCookie;
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
        return rawCookie;
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

  if (csvFiles.length === 0) {
    throw new Error(
      `No .csv files found in the current directory (${currentDir}).`,
    );
  }

  if (csvFiles.length === 1) {
    console.log(
      `\n📄 Found exactly one CSV file. Auto-selecting: ${csvFiles[0]}`,
    );
    return { path: path.join(currentDir, csvFiles[0]), filename: csvFiles[0] };
  }

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

    const csvDirectory = path.dirname(csvPath);
    const stateFilePath = path.join(csvDirectory, "restore_state.json");

    console.log("🍪 Extracting YouTube Music session cookies...");
    const USER_COOKIE = await extractYouTubeCookies(getCookies, toCookieHeader);

    if (!USER_COOKIE) {
      throw new Error(
        "Could not find an active YouTube Music session with SAPISID cookie. " +
          "Make sure you are logged into https://music.youtube.com in your browser (or youtube.com if music won't work in the script). (and keep the browser closed while running this script)",
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
    console.log(
      `\n📂 Found ${total} tracks. Initializing playlist creation...`,
    );

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

    const updatedTitle = `Restored Library Backup - ${playlistId}`;
    console.log(`✏️ Updating playlist title to: "${updatedTitle}"...`);
    await fetch("https://music.youtube.com/youtubei/v1/browse/edit_playlist", {
      method: "POST",
      headers,
      body: JSON.stringify({
        context: baseContext,
        playlistId,
        actions: [
          {
            action: "ACTION_SET_PLAYLIST_NAME",
            playlistName: updatedTitle,
          },
        ],
      }),
    });

    let tracksAdded = Math.min(BATCH_SIZE, total);
    saveState(stateFilePath, selectedCsv.filename, {
      playlistId: playlistId,
      tracksAdded: tracksAdded,
      totalTracks: total,
      completed: tracksAdded === total,
      lastUpdated: new Date().toISOString(),
    });

    console.log(`\n🚀 Initial batch added [${tracksAdded}/${total}].`);

    for (let i = BATCH_SIZE; i < total; i += BATCH_SIZE) {
      const chunk = videoIds.slice(i, i + BATCH_SIZE);
      const actions = chunk.map((id) => ({
        action: "ACTION_ADD_VIDEO",
        addedVideoId: id,
      }));

      await fetch(
        "https://music.youtube.com/youtubei/v1/browse/edit_playlist",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ context: baseContext, playlistId, actions }),
        },
      );

      tracksAdded = Math.min(i + BATCH_SIZE, total);

      saveState(stateFilePath, selectedCsv.filename, {
        playlistId: playlistId,
        tracksAdded: tracksAdded,
        totalTracks: total,
        completed: tracksAdded === total,
        lastUpdated: new Date().toISOString(),
      });

      console.log(`🚀 Progress: [${tracksAdded}/${total}] added.`);

      if (tracksAdded < total) {
        const randomDelay = Math.floor(
          Math.random() * (30000 - 5000 + 1) + 5000,
        );
        console.log(`⏱️ Waiting ${randomDelay / 1000}s before next batch...`);
        await new Promise((r) => setTimeout(r, randomDelay));
      }
    }

    console.log("\n🎊 Playlist restoration complete from 0 to 100%!");
  } catch (err) {
    console.error("\n❌ Script Interrupted:", err.message);
    console.log(
      "💡 You can safely resume this progress later by running 'node src/resumer.js'",
    );
  }
}

restorePlaylist();
