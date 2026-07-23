const fs = require("fs");
const path = require("path");
const os = require("os");
const csv = require("csv-parser");
const crypto = require("crypto");
const readline = require("readline/promises");

const BATCH_SIZE = 20;

function saveState(filePath, csvFilename, data) {
  let allStates = {};
  if (fs.existsSync(filePath)) {
    try {
      allStates = JSON.parse(fs.readFileSync(filePath, "utf8"));
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
  if (rawCookie.includes("SAPISID=")) return rawCookie;

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
      if (rawCookie.includes("SAPISID=")) return rawCookie;
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
      if (rawCookie.includes("SAPISID=")) return rawCookie;
    } catch (_) {}
  }

  return "";
}

async function selectStateToResume(stateFilePath) {
  if (!fs.existsSync(stateFilePath)) {
    throw new Error(
      "No restore_state.json found in the current directory. Start a new playlist first!",
    );
  }

  const allStates = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));

  const incompleteStates = Object.entries(allStates).filter(
    ([filename, data]) => !data.completed,
  );

  if (incompleteStates.length === 0) {
    console.log(
      "✨ All playlists in your state file are already marked as 100% complete!",
    );
    process.exit(0);
  }

  if (incompleteStates.length === 1) {
    const [filename, data] = incompleteStates[0];
    console.log(
      `\n📄 Found one incomplete restore: ${filename} (${data.tracksAdded}/${data.totalTracks} tracks). Auto-selecting...`,
    );
    return { filename, data };
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(
    "\n📄 Multiple incomplete playlists found. Which one do you want to resume?",
  );
  incompleteStates.forEach(([filename, data], index) => {
    console.log(
      `  [${index + 1}] ${filename} - Progress: ${data.tracksAdded}/${data.totalTracks}`,
    );
  });

  while (true) {
    const answer = await rl.question(
      `\nEnter a number (1-${incompleteStates.length}): `,
    );
    const choice = parseInt(answer.trim(), 10);

    if (!isNaN(choice) && choice >= 1 && choice <= incompleteStates.length) {
      rl.close();
      const [filename, data] = incompleteStates[choice - 1];
      console.log(`✅ Selected: ${filename}`);
      return { filename, data };
    } else {
      console.log("❌ Invalid choice. Try again.");
    }
  }
}

async function resumeRestore() {
  try {
    const currentDir = process.cwd();
    const stateFilePath = path.join(currentDir, "restore_state.json");

    const targetState = await selectStateToResume(stateFilePath);
    const { filename: csvFilename, data: stateData } = targetState;
    const csvPath = path.join(currentDir, csvFilename);

    if (!fs.existsSync(csvPath)) {
      throw new Error(
        `The CSV file '${csvFilename}' is missing from this directory!`,
      );
    }

    const { getCookies, toCookieHeader } =
      await import("@steipete/sweet-cookie");
    console.log("🍪 Extracting YouTube Music session cookies...");
    const USER_COOKIE = await extractYouTubeCookies(getCookies, toCookieHeader);

    if (!USER_COOKIE)
      throw new Error("Could not find an active YouTube Music session cookie.");
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
          if (idKey && row[idKey]) videoIds.push(row[idKey].trim());
        })
        .on("end", resolve)
        .on("error", reject);
    });

    const total = videoIds.length;
    let tracksAdded = stateData.tracksAdded;

    console.log(
      `\n♻️  Resuming '${csvFilename}' from track ${tracksAdded} of ${total}...`,
    );
    console.log(`🎯 Target Playlist: ${stateData.playlistId}\n`);

    for (let i = tracksAdded; i < total; i += BATCH_SIZE) {
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
          body: JSON.stringify({
            context: baseContext,
            playlistId: stateData.playlistId,
            actions: actions,
          }),
        },
      );

      if (!editRes.ok) {
        const errorText = await editRes.text();
        throw new Error(
          `YouTube API returned ${editRes.status}. Body: ${errorText.substring(0, 50)}`,
        );
      }

      tracksAdded = Math.min(i + BATCH_SIZE, total);

      saveState(stateFilePath, csvFilename, {
        playlistId: stateData.playlistId,
        tracksAdded: tracksAdded,
        totalTracks: total,
        completed: tracksAdded === total,
        lastUpdated: new Date().toISOString(),
      });

      console.log(`🚀 Progress: [${tracksAdded}/${total}] tracks added...`);

      if (tracksAdded < total) {
        const randomDelay = Math.floor(
          Math.random() * (30000 - 5000 + 1) + 5000,
        );
        console.log(`⏱️  Waiting ${randomDelay / 1000}s before next batch...`);
        await new Promise((r) => setTimeout(r, randomDelay));
      }
    }

    console.log(`\n🎊 Success! ${csvFilename} has been fully restored.`);
  } catch (err) {
    console.error("\n❌ Resume Error:", err.message);
  }
}

resumeRestore();
