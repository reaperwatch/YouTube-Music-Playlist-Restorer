const fs = require("fs");
const path = require("path");
const os = require("os");
const csv = require("csv-parser");
const crypto = require("crypto");
const readline = require("readline/promises");
const { Innertube } = require("youtubei.js");

const BATCH_SIZE = 20; // Number of videos per batch request

let innertubeInstance = null;

async function getInnertube() {
  if (!innertubeInstance) {
    innertubeInstance = await Innertube.create();
  }
  return innertubeInstance;
}

async function searchVideoId(query) {
  try {
    const yt = await getInnertube();
    const searchResults = await yt.music.search(query, { type: "song" });
    const topSong = searchResults.songs?.contents?.[0];

    if (topSong?.id) {
      return topSong.id;
    }

    return null;
  } catch (err) {
    return null;
  }
}

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
  const match = cookieStr.match(
    /(?:__Secure-3PAPISID|__Secure-1PAPISID|SAPISID)=([^;]+)/,
  );
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
    url: "https://music.youtube.com",
    origins: ["https://music.youtube.com", "https://youtube.com"],
    browsers: ["chrome", "edge", "firefox", "safari"],
  });

  let rawCookie = result.cookies ? toCookieHeader(result.cookies) : "";
  if (rawCookie.includes("SAPISID=") || rawCookie.includes("PAPISID=")) {
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
      if (rawCookie.includes("SAPISID=") || rawCookie.includes("PAPISID=")) {
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
      if (rawCookie.includes("SAPISID=") || rawCookie.includes("PAPISID=")) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function addBatchChecked(
  url,
  getHeaders,
  baseContext,
  playlistId,
  chunk,
) {
  const actions = chunk.map((id) => ({
    action: "ACTION_ADD_VIDEO",
    addedVideoId: id,
    dedupeOption: "DEDUPE_OPTION_SKIP",
  }));

  const MAX_ATTEMPTS = 5;
  let reason = "unknown";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ context: baseContext, playlistId, actions }),
      });

      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          fatal: true,
          reason: `HTTP ${res.status} (session/cookies rejected)`,
        };
      }

      let data = null;
      try {
        data = await res.json();
      } catch (_) {}

      if (res.ok && data && data.status === "STATUS_SUCCEEDED") {
        return { ok: true };
      }

      reason = `HTTP ${res.status}, status=${data?.status ?? "n/a"}`;
      console.log(
        `   ⚠️ Batch rejected (${reason}). Attempt ${attempt}/${MAX_ATTEMPTS}`,
      );
      if (data && !data.status) {
        console.log("   Response:", JSON.stringify(data).slice(0, 300));
      }
    } catch (err) {
      reason = `network error: ${err.message}`;
      console.log(`   ⚠️ ${reason}. Attempt ${attempt}/${MAX_ATTEMPTS}`);
    }

    if (attempt < MAX_ATTEMPTS) {
      const wait = 30000 * 2 ** (attempt - 1); // 30s, 60s, 120s, 240s
      console.log(`   ⏱️ Retrying in ${wait / 1000}s...`);
      await sleep(wait);
    }
  }
  return { ok: false, fatal: false, reason };
}

async function restorePlaylist() {
  try {
    const { getCookies, toCookieHeader } =
      await import("@steipete/sweet-cookie");

    const selectedCsv = await selectCsvFile();
    const csvPath = selectedCsv.path;

    const csvDirectory = path.dirname(csvPath);
    const stateFilePath = path.join(csvDirectory, "restore_state.json");
    const cachePath = path.join(csvDirectory, "search_cache.json");
    const missingTracksPath = path.join(csvDirectory, "missing_tracks.txt");

    const rows = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(csvPath)
        .pipe(csv())
        .on("data", (row) => rows.push(row))
        .on("end", resolve)
        .on("error", reject);
    });

    console.log(
      `\n📂 Parsed ${rows.length} rows from CSV. Processing tracks...`,
    );

    let searchCache = {};
    if (fs.existsSync(cachePath)) {
      try {
        searchCache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      } catch (_) {
        searchCache = {};
      }
    }

    let liveSearchCount = 0;
    const videoIds = [];
    const missingTracks = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const idKey = Object.keys(row).find(
        (key) => key.includes("ID") && !key.toLowerCase().includes("uri"),
      );

      let videoId = idKey && row[idKey] ? row[idKey].trim() : null;

      if (videoId) {
        videoIds.push(videoId);
        continue;
      }

      const searchTerms = [];
      const artistKey = Object.keys(row).find((k) =>
        /artist|channel|creator/i.test(k),
      );
      if (artistKey && row[artistKey] && row[artistKey].trim()) {
        const cleanArtist = row[artistKey].trim().replace(/;/g, ", ");
        searchTerms.push(cleanArtist);
      }

      const titleKey = Object.keys(row).find(
        (k) => /title|track name|song name/i.test(k) && !/uri/i.test(k),
      );
      if (titleKey && row[titleKey] && row[titleKey].trim()) {
        searchTerms.push(row[titleKey].trim());
      }

      const searchQuery = searchTerms.join(" - ");

      if (!searchQuery) {
        const missingEntry = `Row ${i + 1}: (Missing searchable title/artist fields)`;
        missingTracks.push(missingEntry);
        fs.writeFileSync(
          missingTracksPath,
          missingTracks.join("\n") + "\n",
          "utf8",
        );
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(searchCache, searchQuery)) {
        videoId = searchCache[searchQuery];
        if (videoId) {
          console.log(
            `⚡ [${i + 1}/${rows.length}] Cached: "${searchQuery}" -> ${videoId}`,
          );
        }
      } else {
        console.log(
          `🔍 [${i + 1}/${rows.length}] Searching YT Music for: "${searchQuery}"...`,
        );
        videoId = await searchVideoId(searchQuery);

        if (videoId) {
          console.log(`   ✅ Resolved: ${videoId}`);
          searchCache[searchQuery] = videoId;
        } else {
          console.log(`   ⚠️ No match found for: "${searchQuery}"`);
          searchCache[searchQuery] = null;
        }

        fs.writeFileSync(
          cachePath,
          JSON.stringify(searchCache, null, 2),
          "utf8",
        );
        liveSearchCount++;

        const jitter = Math.floor(Math.random() * 1500) + 1500;
        await new Promise((r) => setTimeout(r, jitter));

        if (liveSearchCount % 25 === 0) {
          console.log(
            "⏱️ Taking a 15-second cooldown pause to respect rate limits...",
          );
          await new Promise((r) => setTimeout(r, 15000));
        }
      }

      if (videoId) {
        videoIds.push(videoId);
      } else {
        missingTracks.push(searchQuery);
        fs.writeFileSync(
          missingTracksPath,
          missingTracks.join("\n") + "\n",
          "utf8",
        );
      }
    }

    if (missingTracks.length > 0) {
      console.log(
        `\n⚠️ Summary: ${missingTracks.length} track(s) could not be found on YouTube Music.`,
      );
      console.log(
        `📄 A readable list has been saved to: ${missingTracksPath}\nLook for the missing tracks in this file and add them manually.`,
      );
    } else {
      if (fs.existsSync(missingTracksPath)) {
        fs.unlinkSync(missingTracksPath);
      }
    }

    const total = videoIds.length;
    if (total === 0) {
      throw new Error("No valid video IDs found or resolved.");
    }

    console.log("\n🍪 Extracting fresh YouTube Music session cookies...");
    const USER_COOKIE = await extractYouTubeCookies(getCookies, toCookieHeader);

    if (!USER_COOKIE) {
      throw new Error(
        "Could not find an active YouTube Music session. Make sure you are logged into https://music.youtube.com in your browser.",
      );
    }

    if (!getAuthHeader(USER_COOKIE)) {
      throw new Error("Could not find SAPISID in cookie string.");
    }

    const getHeaders = () => ({
      accept: "*/*",
      "content-type": "application/json",
      cookie: USER_COOKIE,
      origin: "https://music.youtube.com",
      authorization: getAuthHeader(USER_COOKIE),
      "x-goog-authuser": "0",
      "x-youtube-client-name": "67",
      "x-youtube-client-version": "1.20260318.00.00",
    });

    const baseContext = {
      client: { clientName: "WEB_REMIX", clientVersion: "1.20260318.00.00" },
    };

    console.log(
      `📂 Found ${total} valid tracks. Initializing playlist creation...`,
    );

    const createRes = await fetch(
      "https://music.youtube.com/youtubei/v1/playlist/create",
      {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          context: baseContext,
          title: "Restored Library Backup",
          privacyStatus: "PRIVATE",
          videoIds: [],
        }),
      },
    );

    const createData = await createRes.json();

    if (!createData.playlistId) {
      console.error(
        "\n❌ YouTube API Creation Error Payload:",
        JSON.stringify(createData, null, 2),
      );
      throw new Error("Failed to create playlist.");
    }

    const playlistId = createData.playlistId;
    console.log(`✨ Playlist Created! (ID: ${playlistId})`);

    const updatedTitle = `Restored Library Backup - ${playlistId}`;
    console.log(`✏️ Updating playlist title to: "${updatedTitle}"...`);
    await fetch("https://music.youtube.com/youtubei/v1/browse/edit_playlist", {
      method: "POST",
      headers: getHeaders(),
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

    let tracksAdded = 0;
    let confirmedAdded = 0;
    const failedVideoIds = [];
    const failedPath = path.join(csvDirectory, "failed_ids.json");
    const editUrl =
      "https://music.youtube.com/youtubei/v1/browse/edit_playlist";

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const chunk = videoIds.slice(i, i + BATCH_SIZE);

      const result = await addBatchChecked(
        editUrl,
        getHeaders,
        baseContext,
        playlistId,
        chunk,
      );

      if (result.ok) {
        confirmedAdded += chunk.length;
      } else {
        failedVideoIds.push(...chunk);
        fs.writeFileSync(
          failedPath,
          JSON.stringify(failedVideoIds, null, 2),
          "utf8",
        );
        console.log(
          `❌ Batch at [${i + 1}-${i + chunk.length}] FAILED: ${result.reason}`,
        );
        if (result.fatal) {
          throw new Error(
            `Aborting: ${result.reason}. Log in again and re-run.`,
          );
        }
      }

      tracksAdded = Math.min(i + BATCH_SIZE, total);

      saveState(stateFilePath, selectedCsv.filename, {
        playlistId: playlistId,
        tracksAdded: tracksAdded,
        confirmedAdded: confirmedAdded,
        failedVideoIds: failedVideoIds,
        totalTracks: total,
        completed: tracksAdded === total && failedVideoIds.length === 0,
        lastUpdated: new Date().toISOString(),
        resolvedVideoIds: videoIds,
      });

      console.log(
        `🚀 Progress: [${tracksAdded}/${total}] processed, ${confirmedAdded} confirmed by YouTube.`,
      );

      if (tracksAdded < total) {
        const randomDelay = Math.floor(
          Math.random() * (30000 - 5000 + 1) + 5000,
        );
        console.log(`⏱️ Waiting ${randomDelay / 1000}s before next batch...`);
        await sleep(randomDelay);
      }
    }

    if (failedVideoIds.length > 0) {
      console.log(
        `\n⚠️ ${failedVideoIds.length} track(s) were NOT added. IDs saved to ${failedPath}`,
      );
    }

    console.log("\n🎊 Playlist restoration complete! Check your account.");
  } catch (err) {
    console.error("\n❌ Script Interrupted:", err.message);
    if (err.message.includes("Failed to create playlist")) {
      console.log(
        "💡 Your search progress is safely cached! Run the main script again ('node .') to retry creating the playlist. Do NOT use resumer.js yet.",
      );
    } else {
      console.log(
        "💡 You can safely resume this progress later by running 'node src/resumer.js'",
      );
    }
  }
}

restorePlaylist();
