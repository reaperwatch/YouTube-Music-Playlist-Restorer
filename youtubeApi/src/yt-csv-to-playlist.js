const fs = require("fs");
const path = require("path");
const os = require("os");
const csv = require("csv-parser");
const crypto = require("crypto");
const readline = require("readline/promises");
const { Innertube } = require("youtubei.js");
const {
  pickBestSong,
  expectedSecondsFromRow,
  formatMissingReport,
  summarizeSong,
  MATCHER_VERSION,
} = require("./track-matcher");

const BATCH_SIZE = 20; // Number of videos per batch request

let innertubeInstance = null;

async function getInnertube() {
  if (!innertubeInstance) {
    innertubeInstance = await Innertube.create();
  }
  return innertubeInstance;
}

// A cached "no match" from an older version of the matcher is re-checked, not trusted.
function isStaleMiss(v) {
  return v === null || (typeof v === "object" && v.v !== MATCHER_VERSION);
}

const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

const isrcHits = new Map();

async function searchVideoId(query, expected) {
  let searches = 0;
  const isrcLeads = [];
  try {
    const yt = await getInnertube();

    if (expected.isrc && ISRC_PATTERN.test(expected.isrc)) {
      try {
        const res = await yt.music.search(expected.isrc, { type: "song" });
        searches++;
        const songs = res.songs?.contents ?? [];
        const junkIds = new Set(
          [...isrcHits]
            .filter(([, set]) => [...set].some((i) => i !== expected.isrc))
            .map(([id]) => id),
        );
        for (const song of songs.slice(0, 3)) {
          if (!song?.id) continue;
          if (!isrcHits.has(song.id)) isrcHits.set(song.id, new Set());
          isrcHits.get(song.id).add(expected.isrc);
        }
        const pick = pickBestSong(songs, expected, { viaIsrc: true, junkIds });
        if (pick.id)
          return { ...pick, reason: `ISRC search: ${pick.reason}`, searches };
        for (const song of songs.slice(0, 2)) {
          if (song?.id)
            isrcLeads.push({ ...summarizeSong(song), viaIsrc: true });
        }
      } catch (_) {
        searches++; // ISRC search failed: just use the normal search below
      }
      await sleep(Math.floor(Math.random() * 700) + 900);
    }

    const res = await yt.music.search(query, { type: "song" });
    searches++;
    const result = pickBestSong(res.songs?.contents ?? [], expected);

    if (!result.id && isrcLeads.length) {
      const miss = result.miss || {
        kind: "none",
        expectedSeconds: expected.seconds || null,
        candidates: [],
      };
      const known = new Set(isrcLeads.map((c) => c.id));
      miss.candidates = [
        ...isrcLeads,
        ...(miss.candidates || []).filter((c) => !known.has(c.id)),
      ];
      if (miss.kind === "none") miss.kind = "other";
      result.miss = miss;
      if (result.note === "search returned no songs")
        result.note = "only the ISRC search returned songs";
    }
    return { ...result, searches };
  } catch (err) {
    return {
      id: null,
      note: `search error: ${err.message}`,
      error: true,
      searches,
      miss: {
        kind: "error",
        expectedSeconds: expected.seconds || null,
        candidates: [],
      },
    };
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
        headers: getHeaders(), // fresh SAPISIDHASH each attempt
        body: JSON.stringify({ context: baseContext, playlistId, actions }),
      });

      if (res.status === 404) {
        return {
          ok: false,
          fatal: true,
          notFound: true,
          reason: "playlist not found (404)",
        };
      }
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

function describeRow(row, index) {
  const artistKey = Object.keys(row).find((k) =>
    /artist|channel|creator/i.test(k),
  );
  const titleKey = Object.keys(row).find(
    (k) => /title|track name|song name/i.test(k) && !/uri/i.test(k),
  );
  const artist =
    artistKey && row[artistKey]
      ? row[artistKey].trim().replace(/;/g, ", ")
      : "";
  const title = titleKey && row[titleKey] ? row[titleKey].trim() : "";
  return [artist, title].filter(Boolean).join(" - ") || `Row ${index + 1}`;
}

async function askKeepRepeats({
  totalRows,
  uniqueCount,
  repeatedIds,
  labelById,
}) {
  const extra = totalRows - uniqueCount;
  console.log("\n🔁 Repeated videos found");
  console.log(
    `   ${extra} entr${extra === 1 ? "y" : "ies"} in this list ${extra === 1 ? "points" : "point"} to a video that is already in the list`,
  );
  console.log(
    `   (${uniqueCount} different videos out of ${totalRows} total). This is about the`,
  );
  console.log(
    "   exact same YouTube video appearing more than once, NOT about songs with the",
  );
  console.log(
    "   same title. A re-upload or live version is a different video and is never affected.",
  );
  console.log("\n   Examples:");
  for (const [id, count] of repeatedIds.slice(0, 3)) {
    console.log(`     • ${labelById.get(id) || id}  (appears ${count}x)`);
  }
  if (repeatedIds.length > 3)
    console.log(`     ...and ${repeatedIds.length - 3} more`);
  console.log(
    "\n  [1] Remove repeats (recommended) - every video is added once",
  );
  console.log(`      Playlist will have ${uniqueCount} tracks.`);
  console.log(
    "  [2] Keep repeats - add the same video again (repeats go at the END of the playlist)",
  );
  console.log(
    `      Playlist would have up to ${totalRows} tracks. YouTube may reject or skip repeats;`,
  );
  console.log(
    "      if so, only the repeats are lost and they are listed in the failed IDs file.",
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (true) {
      const answer = await rl.question("\nEnter 1 or 2: ");
      const choice = answer.trim();
      if (choice === "1") return false;
      if (choice === "2") return true;
      console.log("❌ Invalid choice. Please enter 1 or 2.");
    }
  } finally {
    rl.close();
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
    let lastCooldownAt = 0;
    const videoIds = [];
    const labelById = new Map();
    const missingEntries = [];
    const weakAccepts = [];
    const writeMissingReport = () =>
      fs.writeFileSync(
        missingTracksPath,
        formatMissingReport(missingEntries, selectedCsv.filename, rows.length),
        "utf8",
      );

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const idKey = Object.keys(row).find(
        (key) => key.includes("ID") && !key.toLowerCase().includes("uri"),
      );

      let videoId = idKey && row[idKey] ? row[idKey].trim() : null;

      if (videoId) {
        videoIds.push(videoId);
        if (!labelById.has(videoId))
          labelById.set(videoId, describeRow(row, i));
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
      const albumKey = Object.keys(row).find((k) =>
        /^album(\s*name)?$/i.test(k.trim()),
      );
      const isrcKey = Object.keys(row).find((k) => /^isrc$/i.test(k.trim()));

      const expected = {
        title: titleKey && row[titleKey] ? row[titleKey].trim() : "",
        artists:
          artistKey && row[artistKey]
            ? row[artistKey]
                .split(/[;,]/)
                .map((x) => x.trim())
                .filter(Boolean)
            : [],
        seconds: expectedSecondsFromRow(row),
        album: albumKey && row[albumKey] ? row[albumKey].trim() : "",
        isrc: isrcKey && row[isrcKey] ? row[isrcKey].trim().toUpperCase() : "",
      };
      const cacheKey = expected.seconds
        ? `${searchQuery} [${Math.round(expected.seconds)}s]`
        : searchQuery;
      let missNote = null;
      let missInfo = null;

      if (!searchQuery) {
        missingEntries.push({
          label: `Row ${i + 1}`,
          note: "no title/artist fields found in the CSV for this row",
        });
        writeMissingReport();
        continue;
      }

      if (
        Object.prototype.hasOwnProperty.call(searchCache, cacheKey) &&
        !isStaleMiss(searchCache[cacheKey])
      ) {
        const cached = searchCache[cacheKey];
        if (cached && typeof cached === "object" && cached.id) {
          videoId = cached.id;
          if (cached.weak)
            weakAccepts.push({ label: searchQuery, id: videoId });
          console.log(
            `⚡ [${i + 1}/${rows.length}] Cached: "${searchQuery}" -> ${videoId}`,
          );
        } else if (typeof cached === "string") {
          videoId = cached;
          console.log(
            `⚡ [${i + 1}/${rows.length}] Cached: "${searchQuery}" -> ${videoId}`,
          );
        } else {
          videoId = null;
          missNote = (cached && cached.none) || "no verified match (cached)";
          missInfo = (cached && cached.miss) || null;
        }
      } else {
        console.log(
          `🔍 [${i + 1}/${rows.length}] Searching YT Music for: "${searchQuery}"...`,
        );
        const result = await searchVideoId(searchQuery, expected);
        videoId = result.id;

        if (videoId) {
          console.log(`   ✅ Resolved: ${videoId} (${result.reason})`);
          searchCache[cacheKey] = result.weak
            ? { id: videoId, weak: true, v: MATCHER_VERSION }
            : videoId;
          if (result.weak) {
            weakAccepts.push({ label: searchQuery, id: videoId });
            console.log(
              "   ⚠️ Accepted on weaker evidence (see the summary at the end).",
            );
          }
        } else {
          console.log(
            `   ⚠️ No verified match for: "${searchQuery}" - ${result.note}`,
          );
          missNote = result.note;
          missInfo = result.miss || null;
          if (!result.error) {
            searchCache[cacheKey] = {
              none: result.note,
              miss: result.miss,
              v: MATCHER_VERSION,
            };
          }
        }

        fs.writeFileSync(
          cachePath,
          JSON.stringify(searchCache, null, 2),
          "utf8",
        );
        liveSearchCount += Math.max(1, result.searches || 1);

        const jitter = Math.floor(Math.random() * 1500) + 1500;
        await new Promise((r) => setTimeout(r, jitter));

        if (liveSearchCount - lastCooldownAt >= 25) {
          lastCooldownAt = liveSearchCount;
          console.log(
            "⏱️ Taking a 15-second cooldown pause to respect rate limits...",
          );
          await new Promise((r) => setTimeout(r, 15000));
        }
      }

      if (videoId) {
        videoIds.push(videoId);
        if (!labelById.has(videoId))
          labelById.set(videoId, describeRow(row, i));
      } else {
        missingEntries.push({
          label: searchQuery,
          note: missNote,
          miss: missInfo,
        });
        writeMissingReport();
      }
    }

    if (weakAccepts.length > 0) {
      console.log(
        `\n⚠️ ${weakAccepts.length} track(s) were added on weaker evidence: first ISRC result, length within 1s,\n   but the title/artist are in a different writing system so they couldn't be compared. Worth a quick listen:`,
      );
      for (const w of weakAccepts) {
        console.log(
          `   • ${w.label}\n     https://music.youtube.com/watch?v=${w.id}`,
        );
      }
    }

    if (missingEntries.length > 0) {
      console.log(
        `\n⚠️ Summary: ${missingEntries.length} track(s) could not be found on YouTube Music.`,
      );
      console.log(
        `📄 A readable list has been saved to: ${missingTracksPath}\nLook for the missing tracks in this file and add them manually.`,
      );
    } else {
      if (fs.existsSync(missingTracksPath)) {
        fs.unlinkSync(missingTracksPath);
      }
    }

    const idCounts = new Map();
    for (const id of videoIds) idCounts.set(id, (idCounts.get(id) || 0) + 1);
    const repeatedIds = [...idCounts].filter(([, c]) => c > 1);
    let repeatStart = videoIds.length;

    if (repeatedIds.length > 0) {
      const keepRepeats = await askKeepRepeats({
        totalRows: videoIds.length,
        uniqueCount: idCounts.size,
        repeatedIds,
        labelById,
      });

      if (keepRepeats) {
        const seen = new Set();
        const firstPass = [];
        const repeatPass = [];
        for (const id of videoIds) {
          if (seen.has(id)) repeatPass.push(id);
          else {
            seen.add(id);
            firstPass.push(id);
          }
        }
        videoIds.length = 0;
        videoIds.push(...firstPass, ...repeatPass);
        repeatStart = firstPass.length;
        console.log(
          `🔁 Keeping repeats: ${firstPass.length} unique tracks first, then ${repeatPass.length} repeat(s) at the end.`,
        );
      } else {
        const removed = videoIds.length - idCounts.size;
        const uniqueIds = [...idCounts.keys()];
        videoIds.length = 0;
        videoIds.push(...uniqueIds);
        repeatStart = videoIds.length;
        console.log(
          `🧹 Removed ${removed} repeated entr${removed === 1 ? "y" : "ies"}. Sending ${uniqueIds.length} unique tracks.`,
        );
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
    const failedPath = path.join(
      csvDirectory,
      `failed_ids_${selectedCsv.filename}.json`,
    );
    const editUrl =
      "https://music.youtube.com/youtubei/v1/browse/edit_playlist";

    let i = 0;
    while (i < total) {
      let end = Math.min(i + BATCH_SIZE, total);
      if (i < repeatStart && end > repeatStart) end = repeatStart;
      const chunk = videoIds.slice(i, end);

      const result = await addBatchChecked(
        editUrl,
        getHeaders,
        baseContext,
        playlistId,
        chunk,
      );

      if (!result.ok && result.fatal) {
        throw new Error(
          `Aborting: ${result.reason}. Log in again, then run 'node src/resumer.js'.`,
        );
      }

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
      }

      tracksAdded = end;

      saveState(stateFilePath, selectedCsv.filename, {
        playlistId: playlistId,
        tracksAdded: tracksAdded,
        confirmedAdded: confirmedAdded,
        failedVideoIds: failedVideoIds,
        repeatStart: repeatStart,
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

      i = end;
    }

    if (failedVideoIds.length > 0) {
      console.log(
        `\n⚠️ ${failedVideoIds.length} track(s) were NOT added. IDs saved to ${failedPath}\n💡 Run 'node src/resumer.js' to retry them.`,
      );
    }

    if (failedVideoIds.length === 0) {
      console.log("\n🎊 Playlist restoration complete! Check your account.");
    } else {
      console.log(
        "\n⚠️ Finished with failures (see above). Playlist is incomplete.",
      );
    }
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
